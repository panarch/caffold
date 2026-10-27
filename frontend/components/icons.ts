import { html } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";

const LUCIDE_CDN = "https://esm.sh/lucide@1.22.0";

type LucideModule = Record<string, unknown> & {
  createElement?: (
    icon: unknown,
    attributes: Record<string, string>,
  ) => Element;
};

// What an entry's icon is chosen by.
export interface IconEntry {
  name: string;
  path?: string;
  kind?: string;
  isSymlink?: boolean;
  supported?: boolean;
  git?: { isRepoRoot?: boolean } | null;
  expanded?: boolean;
}

let lucideModule: LucideModule | null = null;
let lucidePromise: Promise<LucideModule | null> | null = null;

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

const CONFIG_EXTENSIONS = new Set([
  "conf",
  "config",
  "env",
  "ini",
  "toml",
  "yaml",
  "yml",
]);
const IMAGE_EXTENSIONS = new Set([
  "avif",
  "gif",
  "jpg",
  "jpeg",
  "png",
  "svg",
  "webp",
]);
const ARCHIVE_EXTENSIONS = new Set([
  "7z",
  "bz2",
  "gz",
  "tar",
  "tgz",
  "xz",
  "zip",
  "zst",
]);

export function warmIcons() {
  if (lucideModule) {
    return Promise.resolve(lucideModule);
  }

  lucidePromise ??= import(LUCIDE_CDN)
    .then((module: LucideModule) => {
      lucideModule = module;
      window.dispatchEvent(new CustomEvent("caffold:icons-ready"));
      return module;
    })
    .catch(() => null);

  return lucidePromise;
}

// The same icon renders the same markup, so drawing it again leaves its SVG
// in place.
export function entryIcon(entry: IconEntry) {
  const { name, label } = iconForEntry(entry);
  const svg =
    iconSvg(name, "entry-icon-svg") || iconSvg("File", "entry-icon-svg");
  return svg
    ? html`
        <span class="entry-kind entry-icon" title=${label}>
          ${unsafeHTML(svg)}
          <span class="sr-only">${label}</span>
        </span>
      `
    : html`
        <span
          class="entry-kind entry-icon entry-icon-placeholder"
          title=${label}
        >
          <span class="sr-only">${label}</span>
        </span>
      `;
}

export function inlineIcon(
  name: string,
  label: string,
  className = "inline-icon-svg",
) {
  const svg = unsafeHTML(iconSvg(name, className));
  return html`${svg}<span class="sr-only">${label}</span>`;
}

function iconForEntry(entry: IconEntry) {
  if (!entry.supported) {
    return icon("Lock", "Blocked");
  }

  if (entry.kind === "directory") {
    if (entry.expanded) {
      return icon("FolderOpen", "Open directory");
    }

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
  const extension = fileName.includes(".")
    ? (fileName.split(".").pop() ?? "")
    : "";

  if (
    fileName === "makefile" ||
    fileName === "dockerfile" ||
    extension === "lock"
  ) {
    return icon("FileTerminal", "Command or lock file");
  }

  if (
    fileName === "license" ||
    fileName.startsWith("readme") ||
    extension === "md"
  ) {
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

function iconSvg(name: string, className: string) {
  const iconNode = lucideModule?.[name];
  if (!iconNode || !lucideModule?.createElement) {
    return "";
  }

  return lucideModule.createElement(iconNode, {
    class: className,
    "aria-hidden": "true",
    width: "18",
    height: "18",
  }).outerHTML;
}

function icon(name: string, label: string) {
  return { name, label };
}
