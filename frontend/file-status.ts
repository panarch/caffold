export type FileStatusTone =
  | "none"
  | "unknown"
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "type-changed"
  | "unmerged";

export interface FileStatusPresentation {
  code: string;
  label: string;
  tone: FileStatusTone;
}

const EMPTY_PRESENTATION: FileStatusPresentation = Object.freeze({
  code: "",
  label: "",
  tone: "none",
});

const UNKNOWN_PRESENTATION: FileStatusPresentation = Object.freeze({
  code: "?",
  label: "Unknown",
  tone: "unknown",
});

const PRESENTATIONS: Readonly<Record<string, FileStatusPresentation>> =
  Object.freeze({
    A: Object.freeze({ code: "A", label: "Added", tone: "added" }),
    M: Object.freeze({ code: "M", label: "Modified", tone: "modified" }),
    D: Object.freeze({ code: "D", label: "Deleted", tone: "deleted" }),
    R: Object.freeze({ code: "R", label: "Renamed", tone: "renamed" }),
    C: Object.freeze({ code: "C", label: "Copied", tone: "copied" }),
    T: Object.freeze({
      code: "T",
      label: "Type changed",
      tone: "type-changed",
    }),
    U: Object.freeze({ code: "U", label: "Unmerged", tone: "unmerged" }),
  });

const PROVIDER_CODES: Readonly<Record<string, string>> = Object.freeze({
  added: "A",
  changed: "M",
  copied: "C",
  deleted: "D",
  modified: "M",
  removed: "D",
  renamed: "R",
  "type-changed": "T",
  type_changed: "T",
  unmerged: "U",
});

// A status is one of git's change letters, or a word a provider such as
// GitHub uses for it.
export function fileStatusPresentation(
  status: string | null | undefined,
): FileStatusPresentation {
  const code = normalizeFileStatusCode(status);
  if (!code) {
    return EMPTY_PRESENTATION;
  }
  return PRESENTATIONS[code] ?? UNKNOWN_PRESENTATION;
}

function normalizeFileStatusCode(status: string | null | undefined) {
  if (status === null || status === undefined || status === "") {
    return "";
  }

  const raw = String(status);
  const providerCode = PROVIDER_CODES[raw.trim().toLowerCase()];
  if (providerCode) {
    return providerCode;
  }

  const characters = Array.from(raw.toUpperCase());
  return characters.length === 1 ? knownCode(characters[0]) : "?";
}

function knownCode(code: string | undefined) {
  return code && PRESENTATIONS[code] ? code : "?";
}
