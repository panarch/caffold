//! Serializes a terminal's screen into VT output that draws it again.
//!
//! A terminal that is reset to the same size and then fed [`serialize`]'s
//! output shows the same scrollback, screen, cursor, modes, and colors. State
//! `alacritty_terminal` does not expose is not reproduced: the primary screen
//! behind the alternate screen, the scroll region, tab stops, character sets,
//! the saved cursor, the title, and the keyboard mode stack.

use std::fmt::Write;

use alacritty_terminal::{
    Grid,
    grid::{Dimensions, GridCell},
    index::{Column, Line},
    term::{
        Term, TermMode,
        cell::{Cell, Flags, Hyperlink},
        color::Colors,
    },
    vte::ansi::{Color, CursorShape, CursorStyle, NamedColor, Rgb},
};

/// Private modes a reset terminal has off, with the DEC number that sets each.
const PRIVATE_MODES: [(TermMode, u16); 8] = [
    (TermMode::APP_CURSOR, 1),
    (TermMode::MOUSE_REPORT_CLICK, 1000),
    (TermMode::MOUSE_DRAG, 1002),
    (TermMode::MOUSE_MOTION, 1003),
    (TermMode::FOCUS_IN_OUT, 1004),
    (TermMode::UTF8_MOUSE, 1005),
    (TermMode::SGR_MOUSE, 1006),
    (TermMode::BRACKETED_PASTE, 2004),
];

const STYLE_FLAGS: Flags = Flags::BOLD
    .union(Flags::DIM)
    .union(Flags::ITALIC)
    .union(Flags::ALL_UNDERLINES)
    .union(Flags::INVERSE)
    .union(Flags::HIDDEN)
    .union(Flags::STRIKEOUT);

pub(super) fn serialize<T>(term: &Term<T>) -> Vec<u8> {
    let mode = *term.mode();
    let grid = term.grid();
    let mut output = Output::default();
    if mode.contains(TermMode::ALT_SCREEN) {
        output.text.push_str("\x1b[?1049h");
    }
    output.lines(grid);
    output.colors(term.colors());
    // Origin mode homes the cursor, so it precedes the cursor's position.
    if mode.contains(TermMode::ORIGIN) {
        output.text.push_str("\x1b[?6h");
    }
    output.cursor(grid);
    output.modes(mode);
    output.cursor_style(term.cursor_style());
    output.set_link(grid.cursor.template.hyperlink());
    output.set_pen(Pen::of(&grid.cursor.template));
    output.text.into_bytes()
}

#[derive(Default)]
struct Output {
    text: String,
    /// The attributes the terminal gives the next character.
    pen: Pen,
    link: Option<Hyperlink>,
}

impl Output {
    /// Writes every scrollback and screen line in order, so the lines above
    /// the screen scroll into the receiving terminal's scrollback.
    fn lines(&mut self, grid: &Grid<Cell>) {
        let columns = grid.columns();
        let bottom = grid.bottommost_line();
        for line in grid.topmost_line().0..=bottom.0 {
            let row = &grid[Line(line)];
            // A wrapped line is written in full so the terminal wraps it too.
            let wrapped = row[Column(columns - 1)].flags.contains(Flags::WRAPLINE);
            let end = if wrapped {
                columns
            } else {
                (0..columns)
                    .rposition(|column| !row[Column(column)].is_empty())
                    .map_or(0, |column| column + 1)
            };
            for column in 0..end {
                let cell = &row[Column(column)];
                // The terminal places a wide character's spacers itself.
                if !cell
                    .flags
                    .intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER)
                {
                    self.cell(cell);
                }
            }
            if line != bottom.0 && !wrapped {
                // A colored pen would fill the line a scroll opens.
                self.set_pen(Pen::default());
                self.text.push_str("\r\n");
            }
        }
        self.set_pen(Pen::default());
        self.set_link(None);
    }

    fn cell(&mut self, cell: &Cell) {
        self.set_link(cell.hyperlink());
        self.set_pen(Pen::of(cell));
        // A tab keeps its character for copying, but it prints as a space.
        self.text.push(if cell.c == '\t' { ' ' } else { cell.c });
        if let Some(zerowidth) = cell.zerowidth() {
            self.text.extend(zerowidth);
        }
    }

    fn colors(&mut self, colors: &Colors) {
        for index in 0..256 {
            if let Some(rgb) = colors[index] {
                let _ = write!(self.text, "\x1b]4;{index};{}\x1b\\", color_spec(rgb));
            }
        }
        for (color, code) in [
            (NamedColor::Foreground, 10),
            (NamedColor::Background, 11),
            (NamedColor::Cursor, 12),
        ] {
            if let Some(rgb) = colors[color] {
                let _ = write!(self.text, "\x1b]{code};{}\x1b\\", color_spec(rgb));
            }
        }
    }

    fn cursor(&mut self, grid: &Grid<Cell>) {
        let cursor = &grid.cursor;
        let line = cursor.point.line.0 + 1;
        if !cursor.input_needs_wrap {
            let _ = write!(self.text, "\x1b[{line};{}H", cursor.point.column.0 + 1);
            return;
        }
        // A cursor waiting to wrap cannot be placed there; drawing the line's
        // last character again leaves the terminal waiting in the same way.
        let row = &grid[cursor.point.line];
        let mut column = cursor.point.column;
        if row[column].flags.contains(Flags::WIDE_CHAR_SPACER) {
            column = Column(column.0 - 1);
        }
        let _ = write!(self.text, "\x1b[{line};{}H", column.0 + 1);
        self.cell(&row[column]);
        self.set_pen(Pen::default());
        self.set_link(None);
    }

    fn modes(&mut self, mode: TermMode) {
        for (flag, number) in PRIVATE_MODES {
            if mode.contains(flag) {
                let _ = write!(self.text, "\x1b[?{number}h");
            }
        }
        if !mode.contains(TermMode::LINE_WRAP) {
            self.text.push_str("\x1b[?7l");
        }
        if mode.contains(TermMode::INSERT) {
            self.text.push_str("\x1b[4h");
        }
        if mode.contains(TermMode::LINE_FEED_NEW_LINE) {
            self.text.push_str("\x1b[20h");
        }
        if mode.contains(TermMode::APP_KEYPAD) {
            self.text.push_str("\x1b=");
        }
        if !mode.contains(TermMode::SHOW_CURSOR) {
            self.text.push_str("\x1b[?25l");
        }
    }

    fn cursor_style(&mut self, style: CursorStyle) {
        let number = match (style.shape, style.blinking) {
            (CursorShape::Block, true) => 1,
            (CursorShape::Underline, true) => 3,
            (CursorShape::Underline, false) => 4,
            (CursorShape::Beam, true) => 5,
            (CursorShape::Beam, false) => 6,
            // A steady block is the reset terminal's own cursor, and the other
            // shapes are the renderer's, not a program's.
            (CursorShape::Block, false) | (CursorShape::HollowBlock | CursorShape::Hidden, _) => {
                return;
            }
        };
        let _ = write!(self.text, "\x1b[{number} q");
    }

    /// Sets every attribute from a reset, so no earlier attribute lingers.
    fn set_pen(&mut self, pen: Pen) {
        if pen == self.pen {
            return;
        }
        self.text.push_str("\x1b[0");
        for (flag, parameter) in [
            (Flags::BOLD, "1"),
            (Flags::DIM, "2"),
            (Flags::ITALIC, "3"),
            (Flags::UNDERLINE, "4"),
            (Flags::DOUBLE_UNDERLINE, "4:2"),
            (Flags::UNDERCURL, "4:3"),
            (Flags::DOTTED_UNDERLINE, "4:4"),
            (Flags::DASHED_UNDERLINE, "4:5"),
            (Flags::INVERSE, "7"),
            (Flags::HIDDEN, "8"),
            (Flags::STRIKEOUT, "9"),
        ] {
            if pen.flags.contains(flag) {
                self.text.push(';');
                self.text.push_str(parameter);
            }
        }
        push_color(&mut self.text, pen.foreground, 30, 90, 38);
        push_color(&mut self.text, pen.background, 40, 100, 48);
        if let Some(color) = pen.underline {
            push_color(&mut self.text, color, 58, 58, 58);
        }
        self.text.push('m');
        self.pen = pen;
    }

    fn set_link(&mut self, link: Option<Hyperlink>) {
        if link == self.link {
            return;
        }
        match &link {
            Some(link) => {
                let _ = write!(self.text, "\x1b]8;id={};{}\x1b\\", link.id(), link.uri());
            }
            None => self.text.push_str("\x1b]8;;\x1b\\"),
        }
        self.link = link;
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Pen {
    foreground: Color,
    background: Color,
    flags: Flags,
    underline: Option<Color>,
}

impl Pen {
    fn of(cell: &Cell) -> Self {
        Self {
            foreground: cell.fg,
            background: cell.bg,
            flags: cell.flags & STYLE_FLAGS,
            underline: cell.underline_color(),
        }
    }
}

impl Default for Pen {
    fn default() -> Self {
        Self::of(&Cell::default())
    }
}

/// Appends a color parameter: `base` or `bright_base` plus the index for the
/// sixteen named colors, `extended` for the rest. The terminal's default
/// colors need no parameter after a reset.
fn push_color(text: &mut String, color: Color, base: u8, bright_base: u8, extended: u8) {
    let _ = match color {
        Color::Named(named) if (named as usize) < 8 && base != extended => {
            write!(text, ";{}", base + named as u8)
        }
        Color::Named(named) if (named as usize) < 16 && base != extended => {
            write!(text, ";{}", bright_base + named as u8 - 8)
        }
        Color::Named(named) if (named as usize) < 16 => {
            write!(text, ";{extended};5;{}", named as u8)
        }
        Color::Named(_) => Ok(()),
        Color::Indexed(index) => write!(text, ";{extended};5;{index}"),
        Color::Spec(Rgb { r, g, b }) => write!(text, ";{extended};2;{r};{g};{b}"),
    };
}

fn color_spec(Rgb { r, g, b }: Rgb) -> String {
    format!("rgb:{r:02x}/{g:02x}/{b:02x}")
}

#[cfg(test)]
mod tests {
    use alacritty_terminal::{
        event::VoidListener,
        term::{Config, test::TermSize},
        vte::ansi::Processor,
    };

    use super::*;

    const RESTORED_MODES: TermMode = TermMode::SHOW_CURSOR
        .union(TermMode::APP_CURSOR)
        .union(TermMode::APP_KEYPAD)
        .union(TermMode::MOUSE_MODE)
        .union(TermMode::BRACKETED_PASTE)
        .union(TermMode::SGR_MOUSE)
        .union(TermMode::UTF8_MOUSE)
        .union(TermMode::LINE_WRAP)
        .union(TermMode::LINE_FEED_NEW_LINE)
        .union(TermMode::ORIGIN)
        .union(TermMode::INSERT)
        .union(TermMode::FOCUS_IN_OUT)
        .union(TermMode::ALT_SCREEN);

    #[test]
    fn scrollback_and_screen_lines_come_back_in_order() {
        let mut input = String::new();
        for line in 0..30 {
            input.push_str(&format!("line {line}\r\n"));
        }
        input.push_str("$ ");

        let original = assert_round_trip(20, 10, input.as_bytes());

        assert_eq!(original.grid().history_size(), 21);
    }

    #[test]
    fn scrollback_is_kept_up_to_its_limit() {
        let mut input = String::new();
        for line in 0..150 {
            input.push_str(&format!("line {line}\r\n"));
        }

        let original = assert_round_trip(20, 10, input.as_bytes());

        assert_eq!(original.grid().history_size(), 100);
    }

    #[test]
    fn wrapped_lines_stay_wrapped() {
        let original = assert_round_trip(10, 5, b"0123456789abcdefghijklmno\r\nnext");

        assert!(
            original.grid()[Line(0)][Column(9)]
                .flags
                .contains(Flags::WRAPLINE)
        );
    }

    #[test]
    fn wide_and_combining_characters_keep_their_cells() {
        let original = assert_round_trip(5, 5, "한글\r\ne\u{301}x\r\nabcd한\r\n1234".as_bytes());

        assert!(
            original.grid()[Line(2)][Column(4)]
                .flags
                .contains(Flags::LEADING_WIDE_CHAR_SPACER)
        );
    }

    #[test]
    fn colors_attributes_and_erased_backgrounds_survive() {
        assert_round_trip(
            40,
            6,
            concat!(
                "\x1b[1;3;31mbold italic red\x1b[0m plain\r\n",
                "\x1b[2;7;9;38;5;123;48;2;1;2;3mdim inverse struck\x1b[0m\r\n",
                "\x1b[4:3;58;5;9mcurly\x1b[0m \x1b[4:2mdouble\x1b[0m \x1b[8mhidden\x1b[0m\r\n",
                "\x1b[44mblue to the end\x1b[K\x1b[0m\r\n",
                "\x1b[95;103mbright\x1b[0m",
            )
            .as_bytes(),
        );
    }

    #[test]
    fn hyperlinks_keep_their_targets() {
        assert_round_trip(
            40,
            4,
            b"\x1b]8;id=doc;https://example.com/a;b\x1b\\link\x1b]8;;\x1b\\ and \x1b]8;;https://example.com\x1b\\anonymous\x1b]8;;\x1b\\",
        );
    }

    #[test]
    fn the_cursor_keeps_its_place_shape_and_visibility() {
        assert_round_trip(20, 6, b"one\r\ntwo\r\nthree\x1b[2;2H\x1b[5 q\x1b[?25l");
    }

    #[test]
    fn every_cursor_shape_a_program_sets_comes_back() {
        for number in 0..=6 {
            assert_round_trip(20, 4, format!("shape\x1b[{number} q").as_bytes());
        }
    }

    #[test]
    fn a_cursor_waiting_to_wrap_still_wraps_the_next_character() {
        let original = assert_round_trip(10, 4, b"0123456789");
        assert!(original.grid().cursor.input_needs_wrap);

        let wide = assert_round_trip(10, 4, "01234567한".as_bytes());
        assert!(wide.grid().cursor.input_needs_wrap);
    }

    #[test]
    fn program_modes_come_back() {
        assert_round_trip(
            20,
            4,
            b"\x1b[?1h\x1b=\x1b[?1002h\x1b[?1006h\x1b[?1004h\x1b[?2004h\x1b[4h\x1b[20h\x1b[?7lmodes",
        );
    }

    #[test]
    fn origin_mode_keeps_the_cursor_position() {
        assert_round_trip(20, 6, b"top\x1b[?6h\x1b[3;4Hmid");
    }

    #[test]
    fn changed_palette_and_dynamic_colors_come_back() {
        assert_round_trip(
            20,
            4,
            b"\x1b]4;1;rgb:12/34/56\x1b\\\x1b]10;rgb:ab/cd/ef\x1b\\\x1b]11;rgb:01/02/03\x1b\\\x1b]12;rgb:ff/00/ff\x1b\\colors",
        );
    }

    #[test]
    fn the_alternate_screen_comes_back_without_the_primary_behind_it() {
        let original = assert_round_trip(
            20,
            4,
            b"shell output\r\n$ vim\x1b[?1049h\x1b[H\x1b[2Jfull screen\x1b[3;1H~",
        );

        assert!(original.mode().contains(TermMode::ALT_SCREEN));
    }

    #[test]
    fn the_pen_left_by_the_program_applies_to_the_next_output() {
        assert_round_trip(
            20,
            4,
            b"\x1b]8;;https://example.com\x1b\\\x1b[1;32;4:4mstill styled",
        );
    }

    /// Serializes a terminal fed `input` into a fresh terminal of the same
    /// size and asserts the two match wherever a snapshot restores state.
    fn assert_round_trip(columns: usize, rows: usize, input: &[u8]) -> Term<VoidListener> {
        let original = terminal(columns, rows, input);
        let restored = terminal(columns, rows, &serialize(&original));

        let (grid, restored_grid) = (original.grid(), restored.grid());
        assert_eq!(grid.history_size(), restored_grid.history_size());
        for line in grid.topmost_line().0..=grid.bottommost_line().0 {
            for column in 0..columns {
                let at = (Line(line), Column(column));
                assert_eq!(
                    visible(&grid[at.0][at.1]),
                    visible(&restored_grid[at.0][at.1]),
                    "cell at line {line}, column {column}"
                );
            }
        }
        assert_eq!(grid.cursor.point, restored_grid.cursor.point);
        assert_eq!(
            grid.cursor.input_needs_wrap,
            restored_grid.cursor.input_needs_wrap
        );
        assert_eq!(
            Pen::of(&grid.cursor.template),
            Pen::of(&restored_grid.cursor.template)
        );
        assert_eq!(
            grid.cursor.template.hyperlink(),
            restored_grid.cursor.template.hyperlink()
        );
        assert_eq!(
            *original.mode() & RESTORED_MODES,
            *restored.mode() & RESTORED_MODES
        );
        assert_eq!(original.cursor_style(), restored.cursor_style());
        for index in 0..=NamedColor::Cursor as usize {
            assert_eq!(original.colors()[index], restored.colors()[index]);
        }
        original
    }

    fn terminal(columns: usize, rows: usize, input: &[u8]) -> Term<VoidListener> {
        let config = Config {
            scrolling_history: 100,
            ..Config::default()
        };
        let mut terminal = Term::new(config, &TermSize::new(columns, rows), VoidListener);
        let mut parser: Processor = Processor::new();
        parser.advance(&mut terminal, input);
        terminal
    }

    /// A cell's character, attributes, combining characters, and link.
    type Shown = (char, Pen, Flags, Vec<char>, Option<Hyperlink>);

    /// What a cell shows. Empty cells look alike whatever attributes they
    /// carry, and a tab shows as the space it prints as.
    fn visible(cell: &Cell) -> Option<Shown> {
        (!cell.is_empty()).then(|| {
            (
                if cell.c == '\t' { ' ' } else { cell.c },
                Pen::of(cell),
                cell.flags,
                cell.zerowidth().unwrap_or_default().to_vec(),
                cell.hyperlink(),
            )
        })
    }
}
