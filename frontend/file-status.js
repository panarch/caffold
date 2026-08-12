const EMPTY_PRESENTATION = Object.freeze({
  code: "",
  label: "",
  tone: "none",
});

const UNKNOWN_PRESENTATION = Object.freeze({
  code: "?",
  label: "Unknown",
  tone: "unknown",
});

const PRESENTATIONS = Object.freeze({
  A: Object.freeze({ code: "A", label: "Added", tone: "added" }),
  M: Object.freeze({ code: "M", label: "Modified", tone: "modified" }),
  D: Object.freeze({ code: "D", label: "Deleted", tone: "deleted" }),
  R: Object.freeze({ code: "R", label: "Renamed", tone: "renamed" }),
  C: Object.freeze({ code: "C", label: "Copied", tone: "copied" }),
  T: Object.freeze({ code: "T", label: "Type changed", tone: "type-changed" }),
  U: Object.freeze({ code: "U", label: "Unmerged", tone: "unmerged" }),
});

const PROVIDER_CODES = Object.freeze({
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

const UNMERGED_PAIRS = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

export function fileStatusPresentation(status, context = {}) {
  const code = normalizeFileStatusCode(status, context);
  if (!code) {
    return EMPTY_PRESENTATION;
  }
  return PRESENTATIONS[code] ?? UNKNOWN_PRESENTATION;
}

function normalizeFileStatusCode(status, context) {
  const category = statusCategory(context);
  if (category === "untracked" || context?.untracked === true) {
    return "A";
  }

  if (status === null || status === undefined || status === "") {
    return "";
  }

  const raw = String(status);
  const providerCode = PROVIDER_CODES[raw.trim().toLowerCase()];
  if (providerCode) {
    return providerCode;
  }

  const characters = Array.from(raw.toUpperCase());
  const pair = characters.slice(0, 2).join("");
  if (pair === "??") {
    return "A";
  }
  if (characters.length === 2 && UNMERGED_PAIRS.has(pair)) {
    return "U";
  }

  if (characters.length === 1) {
    return knownCode(characters[0]);
  }
  if (characters.length !== 2) {
    return "?";
  }

  if (category === "unstaged" || context?.unstaged === true) {
    return knownCode(characters[1]);
  }
  if (category === "staged" || context?.staged === true) {
    return knownCode(characters[0]);
  }

  const meaningful = [...new Set(characters.filter((character) => character !== " "))];
  return meaningful.length === 1 ? knownCode(meaningful[0]) : "?";
}

function statusCategory(context) {
  if (typeof context === "string") {
    return context.toLowerCase();
  }
  return `${context?.category ?? ""}`.toLowerCase();
}

function knownCode(code) {
  return PRESENTATIONS[code] ? code : "?";
}
