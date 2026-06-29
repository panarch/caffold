import { escapeHtml } from "./dom.js";

const LUCIDE_CDN = "https://esm.sh/lucide@1.22.0";

let lucideModule = null;
let lucidePromise = null;

const CODE_EXTENSIONS = new Set([
  "bash",
  "c",
  "cc",
  "cjs",
  "cpp",
  "css",
  "cxx",
  "go",
  "h",
  "hpp",
  "htm",
  "html",
  "java",
  "js",
  "jsx",
  "kt",
  "kts",
  "mjs",
  "py",
  "rb",
  "rs",
  "sh",
  "tsx",
  "ts",
  "zsh",
]);

const CONFIG_EXTENSIONS = new Set(["conf", "config", "env", "ini", "toml", "yaml", "yml"]);
const IMAGE_EXTENSIONS = new Set(["avif", "gif", "jpg", "jpeg", "png", "svg", "webp"]);
const ARCHIVE_EXTENSIONS = new Set(["7z", "bz2", "gz", "tar", "tgz", "xz", "zip", "zst"]);

export function warmIcons() {
  if (lucideModule) {
    return Promise.resolve(lucideModule);
  }

  if (!lucidePromise) {
    lucidePromise = import(LUCIDE_CDN)
      .then((module) => {
        lucideModule = module;
        window.dispatchEvent(new CustomEvent("codger:icons-ready"));
        return module;
      })
      .catch(() => null);
  }

  return lucidePromise;
}

export function renderEntryIcon(entry) {
  const icon = iconForEntry(entry);

  if (!lucideModule) {
    return renderIconPlaceholder(icon.label);
  }

  const iconNode = lucideModule[icon.name] ?? lucideModule.File;
  if (!iconNode || !lucideModule.createElement) {
    return renderIconPlaceholder(icon.label);
  }

  const svg = lucideModule.createElement(iconNode, {
    class: "entry-icon-svg",
    "aria-hidden": "true",
    width: "18",
    height: "18",
  });

  return `
    <span class="entry-kind entry-icon" title="${escapeHtml(icon.label)}">
      ${svg.outerHTML}
      <span class="sr-only">${escapeHtml(icon.label)}</span>
    </span>
  `;
}

function iconForEntry(entry) {
  if (!entry.supported) {
    return icon("Lock", "Blocked");
  }

  if (entry.kind === "directory") {
    if (entry.git?.isRepoRoot) {
      return icon("FolderGit2", "Git repository");
    }

    return entry.isSymlink
      ? icon("FolderSymlink", "Directory link")
      : icon("Folder", "Directory");
  }

  if (entry.kind === "symlink") {
    return icon("Link", "Symbolic link");
  }

  if (entry.kind !== "file") {
    return icon("FileQuestion", "Other file");
  }

  if (entry.isSymlink) {
    return icon("Link", "File link");
  }

  const fileName = entry.name.toLowerCase();
  const extension = fileName.includes(".") ? fileName.split(".").pop() : "";

  if (fileName === "makefile" || fileName === "dockerfile" || extension === "lock") {
    return icon("FileTerminal", "Command or lock file");
  }

  if (fileName === "license" || fileName.startsWith("readme") || extension === "md") {
    return icon("FileText", "Text document");
  }

  if (extension === "json") {
    return icon("FileJson", "JSON file");
  }

  if (extension === "sql") {
    return icon("Database", "SQL file");
  }

  if (CONFIG_EXTENSIONS.has(extension)) {
    return icon("FileCog", "Configuration file");
  }

  if (IMAGE_EXTENSIONS.has(extension)) {
    return icon("FileImage", "Image file");
  }

  if (ARCHIVE_EXTENSIONS.has(extension)) {
    return icon("FileArchive", "Archive file");
  }

  if (CODE_EXTENSIONS.has(extension)) {
    return icon("FileCode", "Source file");
  }

  return icon("File", "File");
}

function renderIconPlaceholder(label) {
  return `
    <span class="entry-kind entry-icon entry-icon-placeholder" title="${escapeHtml(label)}">
      <span class="sr-only">${escapeHtml(label)}</span>
    </span>
  `;
}

function icon(name, label) {
  return { name, label };
}
