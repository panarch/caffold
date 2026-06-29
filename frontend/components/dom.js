const HTML_ESCAPE = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

const LANGUAGE_LABELS = {
  bash: "Shell",
  c: "C",
  cpp: "C++",
  css: "CSS",
  diff: "Diff",
  go: "Go",
  java: "Java",
  javascript: "JavaScript",
  json: "JSON",
  kotlin: "Kotlin",
  markdown: "Markdown",
  python: "Python",
  ruby: "Ruby",
  rust: "Rust",
  sql: "SQL",
  toml: "TOML",
  typescript: "TypeScript",
  xml: "XML",
  yaml: "YAML",
};

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => HTML_ESCAPE[character]);
}

export function formatBytes(size) {
  if (size === null || size === undefined) {
    return "";
  }

  if (size < 1024) {
    return `${size} B`;
  }

  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }

  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatModified(modifiedMs) {
  if (!modifiedMs) {
    return "";
  }

  const date = new Date(modifiedMs);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function languageLabel(language) {
  return LANGUAGE_LABELS[language] ?? "Text";
}

export function entryKindLabel(entry) {
  if (!entry.supported) {
    return "blocked";
  }

  if (entry.kind === "directory") {
    return entry.isSymlink ? "dir link" : "dir";
  }

  if (entry.kind === "file") {
    return entry.isSymlink ? "file link" : "file";
  }

  if (entry.kind === "symlink") {
    return "link";
  }

  return "other";
}
