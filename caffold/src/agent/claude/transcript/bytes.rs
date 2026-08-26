//! Bounded byte windows over an append-only Claude transcript.
//!
//! The transcript parser works in whole turns, but finding the newest turns
//! must not require decoding every turn that came before them. This module
//! stays below that parser: it walks physical lines backwards in fixed-size
//! blocks, recognizes only prompt boundaries, and reads the chosen byte range
//! forwards once.

use std::collections::VecDeque;
use std::io::{Read, Seek, SeekFrom};

use base64::Engine as _;
use serde::{Deserialize, Serialize, de::IgnoredAny};

use super::{Boundary, ReadError};

const BLOCK_SIZE: usize = 64 * 1024;
const CURSOR_PREFIX: &str = "caffold-claude-transcript.";
const CURSOR_VERSION: u8 = 1;

pub(super) struct Window {
    pub(super) contents: String,
    pub(super) older: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    version: u8,
    offset: u64,
    turn_id: String,
}

#[derive(Debug)]
struct TurnBoundary {
    offset: u64,
    turn_id: String,
}

struct PhysicalLine {
    start: u64,
    bytes: Vec<u8>,
}

/// Read one page from a stable length of an open transcript.
///
/// `snapshot_len` is captured before this starts. Bytes appended while the
/// read is in flight therefore belong to the next read, never half to this one.
pub(super) fn window<R: Read + Seek>(
    reader: &mut R,
    snapshot_len: u64,
    before: Option<&str>,
    limit: usize,
) -> Result<Window, ReadError> {
    let page_end = match before {
        Some(raw) => {
            let cursor = decode_cursor(raw)?;
            // A cursor points behind everything already returned. Appends —
            // including one currently partial at the new EOF — cannot change
            // that boundary, so an older page need not revisit the newer tail.
            validate_cursor(reader, snapshot_len, &cursor)?;
            cursor.offset
        }
        None => complete_rows_end(reader, snapshot_len)?,
    };

    if limit == 0 || page_end == 0 {
        return Ok(Window {
            contents: String::new(),
            older: None,
        });
    }

    let mut scanner = ReverseLines::new(reader, page_end);
    let mut boundaries = Vec::new();
    while let Some(line) = scanner.next_line()? {
        if let Some(turn_id) = turn_boundary(&line.bytes) {
            boundaries.push(TurnBoundary {
                offset: line.start,
                turn_id,
            });
            // One extra boundary proves that more history exists. It is not
            // part of this page and its contents are never decoded.
            if boundaries.len() > limit {
                break;
            }
        }
    }

    let selected = boundaries.len().min(limit);
    if selected == 0 {
        return Ok(Window {
            contents: String::new(),
            older: None,
        });
    }
    let oldest_selected = &boundaries[selected - 1];
    let contents = read_range(reader, oldest_selected.offset, page_end)?;
    let contents = String::from_utf8(contents).map_err(ReadError::InvalidUtf8)?;
    let older = (boundaries.len() > limit).then(|| encode_cursor(oldest_selected));
    Ok(Window { contents, older })
}

/// The end through which rows are known to be complete.
///
/// A valid final JSON row needs no newline and remains compatible with the old
/// reader. An invalid unterminated row may simply be in the middle of being
/// appended, so it is deferred instead of being called a malformed message.
fn complete_rows_end<R: Read + Seek>(reader: &mut R, snapshot_len: u64) -> Result<u64, ReadError> {
    if snapshot_len == 0 {
        return Ok(0);
    }
    let last = read_range(reader, snapshot_len - 1, snapshot_len)?;
    if last == b"\n" {
        return Ok(snapshot_len);
    }
    let mut scanner = ReverseLines::new(reader, snapshot_len);
    let Some(last) = scanner.next_line()? else {
        return Ok(0);
    };
    match serde_json::from_slice::<IgnoredAny>(&last.bytes) {
        Ok(_) => Ok(snapshot_len),
        Err(_) => Ok(last.start),
    }
}

fn turn_boundary(line: &[u8]) -> Option<String> {
    let row = serde_json::from_slice::<Boundary>(line).ok()?;
    (!row.is_sidechain && row.kind == "user" && row.prompt_source.is_some()).then_some(())?;
    row.uuid
}

fn encode_cursor(boundary: &TurnBoundary) -> String {
    let payload = Cursor {
        version: CURSOR_VERSION,
        offset: boundary.offset,
        turn_id: boundary.turn_id.clone(),
    };
    let payload = serde_json::to_vec(&payload).expect("a transcript cursor always serializes");
    format!(
        "{CURSOR_PREFIX}{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload)
    )
}

fn decode_cursor(raw: &str) -> Result<Cursor, ReadError> {
    let encoded = raw
        .strip_prefix(CURSOR_PREFIX)
        .ok_or_else(|| invalid_cursor("unknown cursor format"))?;
    let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| invalid_cursor("invalid cursor encoding"))?;
    let cursor: Cursor =
        serde_json::from_slice(&payload).map_err(|_| invalid_cursor("invalid cursor payload"))?;
    if cursor.version != CURSOR_VERSION || cursor.turn_id.is_empty() {
        return Err(invalid_cursor("unsupported cursor version or empty turn"));
    }
    Ok(cursor)
}

fn validate_cursor<R: Read + Seek>(
    reader: &mut R,
    snapshot_len: u64,
    cursor: &Cursor,
) -> Result<(), ReadError> {
    if cursor.offset >= snapshot_len {
        return Err(invalid_cursor("boundary is outside this transcript"));
    }
    if cursor.offset > 0 && read_range(reader, cursor.offset - 1, cursor.offset)? != b"\n" {
        return Err(invalid_cursor("boundary is not at the start of a row"));
    }
    let line = read_line_forward(reader, cursor.offset, snapshot_len)?;
    if turn_boundary(&line).as_deref() != Some(cursor.turn_id.as_str()) {
        return Err(invalid_cursor("boundary does not name the recorded turn"));
    }
    Ok(())
}

fn invalid_cursor(message: &str) -> ReadError {
    ReadError::InvalidCursor(message.to_string())
}

fn read_line_forward<R: Read + Seek>(
    reader: &mut R,
    start: u64,
    end: u64,
) -> Result<Vec<u8>, ReadError> {
    reader.seek(SeekFrom::Start(start))?;
    let mut at = start;
    let mut line = Vec::new();
    let mut block = vec![0; BLOCK_SIZE];
    while at < end {
        let count =
            usize::try_from((end - at).min(BLOCK_SIZE as u64)).expect("a block length fits usize");
        reader.read_exact(&mut block[..count])?;
        if let Some(newline) = block[..count].iter().position(|byte| *byte == b'\n') {
            line.extend_from_slice(&block[..newline]);
            return Ok(line);
        }
        line.extend_from_slice(&block[..count]);
        at += count as u64;
    }
    Ok(line)
}

fn read_range<R: Read + Seek>(reader: &mut R, start: u64, end: u64) -> Result<Vec<u8>, ReadError> {
    let span = end.checked_sub(start).ok_or_else(|| {
        ReadError::Io(std::io::Error::other(
            "Claude transcript byte range ends before it starts",
        ))
    })?;
    let length = usize::try_from(span).map_err(|_| {
        ReadError::Io(std::io::Error::other(
            "Claude transcript page is too large to address",
        ))
    })?;
    let mut bytes = vec![0; length];
    reader.seek(SeekFrom::Start(start))?;
    reader.read_exact(&mut bytes)?;
    Ok(bytes)
}

/// Physical lines, newest first, read without revisiting a block.
struct ReverseLines<'a, R> {
    reader: &'a mut R,
    position: u64,
    buffer_start: u64,
    buffer: VecDeque<u8>,
    known_without_newline: usize,
    first: bool,
    finished: bool,
}

impl<'a, R: Read + Seek> ReverseLines<'a, R> {
    fn new(reader: &'a mut R, end: u64) -> Self {
        Self {
            reader,
            position: end,
            buffer_start: end,
            buffer: VecDeque::new(),
            known_without_newline: 0,
            first: true,
            finished: false,
        }
    }

    fn next_line(&mut self) -> Result<Option<PhysicalLine>, ReadError> {
        if self.finished {
            return Ok(None);
        }
        loop {
            let searchable = self.buffer.len().saturating_sub(self.known_without_newline);
            if searchable > 0 {
                if let Some(newline) = self
                    .buffer
                    .iter()
                    .take(searchable)
                    .rposition(|byte| *byte == b'\n')
                {
                    let start = self.buffer_start + newline as u64 + 1;
                    let bytes: Vec<u8> = self.buffer.iter().skip(newline + 1).copied().collect();
                    self.buffer.truncate(newline);
                    self.known_without_newline = 0;
                    if self.first {
                        self.first = false;
                        // A terminating newline leaves one synthetic empty
                        // suffix. Skip only that suffix; a real blank row before
                        // it is returned on the next iteration.
                        if bytes.is_empty() {
                            continue;
                        }
                    }
                    return Ok(Some(PhysicalLine { start, bytes }));
                }
                self.known_without_newline = self.buffer.len();
            }

            if self.position == 0 {
                self.finished = true;
                if self.buffer.is_empty() {
                    return Ok(None);
                }
                let bytes = self.buffer.drain(..).collect();
                self.first = false;
                return Ok(Some(PhysicalLine { start: 0, bytes }));
            }

            let count = usize::try_from(self.position.min(BLOCK_SIZE as u64))
                .expect("a block length fits usize");
            let start = self.position - count as u64;
            self.reader.seek(SeekFrom::Start(start))?;
            let mut block = vec![0; count];
            self.reader.read_exact(&mut block)?;
            for byte in block.into_iter().rev() {
                self.buffer.push_front(byte);
            }
            self.position = start;
            self.buffer_start = start;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Cursor as IoCursor, Read, Seek, SeekFrom};

    use super::*;

    fn prompt(id: &str, text: &str) -> String {
        serde_json::json!({
            "type": "user",
            "uuid": id,
            "promptSource": "sdk",
            "message": {"role": "user", "content": text},
        })
        .to_string()
    }

    fn answer(id: &str, text: &str) -> String {
        serde_json::json!({
            "type": "assistant",
            "uuid": id,
            "message": {
                "role": "assistant",
                "content": [{"type": "text", "text": text}],
            },
        })
        .to_string()
    }

    fn two_turns() -> String {
        [
            prompt("prompt-1", "first"),
            answer("answer-1", "one"),
            prompt("prompt-2", "second"),
            answer("answer-2", "two"),
        ]
        .join("\n")
    }

    #[derive(Default)]
    struct CountingReader {
        inner: IoCursor<Vec<u8>>,
        read: usize,
    }

    impl CountingReader {
        fn new(bytes: Vec<u8>) -> Self {
            Self {
                inner: IoCursor::new(bytes),
                read: 0,
            }
        }
    }

    impl Read for CountingReader {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            let read = self.inner.read(buffer)?;
            self.read += read;
            Ok(read)
        }
    }

    impl Seek for CountingReader {
        fn seek(&mut self, position: SeekFrom) -> std::io::Result<u64> {
            self.inner.seek(position)
        }
    }

    #[test]
    fn the_latest_page_does_not_read_a_large_older_prefix() {
        let mut transcript = "{}\n".repeat(2_000_000).into_bytes();
        transcript.extend_from_slice(two_turns().as_bytes());
        let snapshot_len = transcript.len() as u64;
        let mut reader = CountingReader::new(transcript);

        let page = window(&mut reader, snapshot_len, None, 1).expect("the newest page");

        assert!(page.contents.contains("prompt-2"));
        assert!(!page.contents.contains("prompt-1"));
        assert!(page.older.is_some());
        assert!(
            reader.read < BLOCK_SIZE * 5,
            "read {} bytes to answer from the tail",
            reader.read
        );
    }

    #[test]
    fn an_older_page_does_not_revisit_a_large_newer_tail() {
        let original = two_turns().into_bytes();
        let mut first = IoCursor::new(original.clone());
        let cursor = window(&mut first, original.len() as u64, None, 1)
            .expect("the newest page")
            .older
            .expect("an older boundary");
        let mut grown = original;
        grown.extend_from_slice(b"\n");
        grown.extend_from_slice("{}\n".repeat(2_000_000).as_bytes());
        grown.extend_from_slice(prompt("prompt-3", "third").as_bytes());
        let snapshot_len = grown.len() as u64;
        let mut reader = CountingReader::new(grown);

        let page = window(&mut reader, snapshot_len, Some(&cursor), 8)
            .expect("the older page still follows its original boundary");

        assert!(page.contents.contains("prompt-1"));
        assert!(!page.contents.contains("prompt-2"));
        assert!(
            reader.read < BLOCK_SIZE * 4,
            "read {} bytes despite the cursor preceding the new tail",
            reader.read
        );
    }

    #[test]
    fn a_row_larger_than_a_read_block_remains_one_boundary() {
        let long = "x".repeat(BLOCK_SIZE * 3);
        let transcript = [prompt("prompt-long", &long), answer("answer-long", "done")].join("\n");
        let mut reader = IoCursor::new(transcript.as_bytes());

        let page = window(&mut reader, transcript.len() as u64, None, 1)
            .expect("the long turn is readable");

        assert!(page.contents.contains("prompt-long"));
        assert!(page.contents.contains(&long));
        assert_eq!(page.older, None);
    }

    #[test]
    fn a_utf8_codepoint_split_between_reverse_blocks_is_reassembled_before_decoding() {
        let prefix = "{\"type\":\"user\",\"uuid\":\"prompt-utf8\",\"promptSource\":\"sdk\",\"message\":{\"role\":\"user\",\"content\":\"";
        let closing = "\"}}";
        // The first reverse block starts one byte into the emoji. The scanner
        // must join bytes first; decoding either block on its own would fail.
        let after_emoji = "x".repeat(BLOCK_SIZE + 1 - "🧵".len() - closing.len());
        let transcript = format!("{prefix}🧵{after_emoji}{closing}");
        assert_eq!(transcript.len() - prefix.len(), BLOCK_SIZE + 1);
        let mut reader = IoCursor::new(transcript.as_bytes());

        let page = window(&mut reader, transcript.len() as u64, None, 1)
            .expect("the complete UTF-8 row is decoded after reassembly");

        assert!(page.contents.contains("🧵"));
        assert!(page.contents.contains("prompt-utf8"));
    }

    struct GrowingReader {
        inner: IoCursor<Vec<u8>>,
        appended: Option<Vec<u8>>,
    }

    impl Read for GrowingReader {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            if let Some(appended) = self.appended.take() {
                self.inner.get_mut().extend(appended);
            }
            self.inner.read(buffer)
        }
    }

    impl Seek for GrowingReader {
        fn seek(&mut self, position: SeekFrom) -> std::io::Result<u64> {
            self.inner.seek(position)
        }
    }

    #[test]
    fn bytes_appended_after_the_length_snapshot_wait_for_the_next_read() {
        let original = two_turns().into_bytes();
        let snapshot_len = original.len() as u64;
        let appended = format!(
            "\n{}\n{}",
            prompt("prompt-3", "third"),
            answer("answer-3", "three")
        )
        .into_bytes();
        let mut reader = GrowingReader {
            inner: IoCursor::new(original),
            appended: Some(appended),
        };

        let page = window(&mut reader, snapshot_len, None, 1).expect("the snapshotted page");

        assert!(page.contents.contains("prompt-2"));
        assert!(!page.contents.contains("prompt-3"));
    }

    #[test]
    fn cursor_version_encoding_offset_and_identity_are_all_verified() {
        let transcript = two_turns().into_bytes();
        let snapshot_len = transcript.len() as u64;
        let mut reader = IoCursor::new(transcript.clone());
        let issued = window(&mut reader, snapshot_len, None, 1)
            .expect("the newest page")
            .older
            .expect("an older boundary");
        let cursor = decode_cursor(&issued).expect("the issued cursor decodes");

        let unsupported = Cursor {
            version: CURSOR_VERSION + 1,
            offset: cursor.offset,
            turn_id: cursor.turn_id.clone(),
        };
        let unsupported = format!(
            "{CURSOR_PREFIX}{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(serde_json::to_vec(&unsupported).unwrap())
        );
        let cases = [
            format!("{issued}!"),
            unsupported,
            encode_cursor(&TurnBoundary {
                offset: cursor.offset + 1,
                turn_id: cursor.turn_id.clone(),
            }),
            encode_cursor(&TurnBoundary {
                offset: cursor.offset,
                turn_id: "a-different-turn".to_string(),
            }),
        ];
        for invalid in cases {
            let mut reader = IoCursor::new(transcript.clone());
            assert!(matches!(
                window(&mut reader, snapshot_len, Some(&invalid), 8),
                Err(ReadError::InvalidCursor(_))
            ));
        }

        let mut truncated = IoCursor::new(transcript[..cursor.offset as usize].to_vec());
        assert!(matches!(
            window(&mut truncated, cursor.offset, Some(&issued), 8),
            Err(ReadError::InvalidCursor(_))
        ));

        let replaced = two_turns().replace("prompt-2", "prompt-x").into_bytes();
        let mut replaced = IoCursor::new(replaced);
        assert!(matches!(
            window(&mut replaced, snapshot_len, Some(&issued), 8),
            Err(ReadError::InvalidCursor(_))
        ));
    }

    #[test]
    fn a_zero_turn_page_reads_no_turn_bytes() {
        let transcript = two_turns().into_bytes();
        let snapshot_len = transcript.len() as u64;
        let mut reader = CountingReader::new(transcript);

        let page = window(&mut reader, snapshot_len, None, 0).expect("an empty page");

        assert_eq!(page.contents, "");
        assert_eq!(page.older, None);
        assert!(reader.read <= BLOCK_SIZE + 1);
    }
}
