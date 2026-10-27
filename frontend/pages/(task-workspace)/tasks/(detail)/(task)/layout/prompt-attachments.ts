// Where a prompt's files go when it is sent, and the words that name them.
//
// Each send uploads into its own folder under the agent's working directory,
// and the prompt ends with the list of what it carries. That list is part of
// the message the person sent: the agent reads it, and the conversation shows
// it as written.

const MAX_NAME_BYTES = 255;
const FOLDER_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** `YYYYMMDD-HHMMSS-xxxx`: when it was sent, and four characters that keep
 * two sends in the same second apart. */
export function uploadFolderName(date = new Date(), random = Math.random) {
  const two = (value: number) => `${value}`.padStart(2, "0");
  const stamp =
    `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}` +
    `-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
  const suffix = Array.from(
    { length: 4 },
    () => FOLDER_ALPHABET[Math.floor(random() * FOLDER_ALPHABET.length)],
  ).join("");
  return `${stamp}-${suffix}`;
}

/** Names the upload folder accepts, one per file and none repeated: a name
 * that repeats is numbered before its extension, as `log.txt`, `log-2.txt`. */
export function uploadFileNames(names: Array<string | null | undefined>) {
  const taken = new Set<string>();
  return names.map((name) => {
    const clean = acceptableName(name);
    let candidate = clean;
    for (let number = 2; taken.has(sameFileKey(candidate)); number += 1) {
      candidate = numberedName(clean, number);
    }
    taken.add(sameFileKey(candidate));
    return candidate;
  });
}

export function uploadPath(folder: string, name: string) {
  return `.caffold/uploads/${folder}/${name}`;
}

export function promptWithAttachedFiles(prompt: string, paths: string[]) {
  const list = ["Attached files:", ...paths.map((path) => `- ${path}`)].join(
    "\n",
  );
  return prompt ? `${prompt}\n\n${list}` : list;
}

// Separators and control characters cannot be part of one file's name.
function acceptableName(name: string | null | undefined) {
  const replaced = `${name ?? ""}`.replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it replaces.
    /[/\\\u0000-\u001f\u007f-\u009f]/g,
    "_",
  );
  const usable =
    replaced === "." || replaced === ".." || !replaced ? "file" : replaced;
  const { stem, extension } = splitName(usable);
  return fittedName(stem, extension);
}

function numberedName(name: string, number: number) {
  const { stem, extension } = splitName(name);
  return fittedName(stem, `-${number}${extension}`);
}

// Shortens the stem, never what follows it, to fit a file name's byte limit.
function fittedName(stem: string, ending: string) {
  const encoder = new TextEncoder();
  const characters = Array.from(stem);
  while (
    characters.length > 1 &&
    encoder.encode(characters.join("") + ending).length > MAX_NAME_BYTES
  ) {
    characters.pop();
  }
  return characters.join("") + ending;
}

function splitName(name: string) {
  const dot = name.lastIndexOf(".");
  return dot > 0
    ? { stem: name.slice(0, dot), extension: name.slice(dot) }
    : { stem: name, extension: "" };
}

// Folders on a Mac tell names apart by neither case nor Unicode form.
function sameFileKey(name: string) {
  return name.normalize("NFC").toLowerCase();
}
