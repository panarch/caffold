// What TypeScript modules use from api.js while it is still JavaScript. It
// goes when that module moves to TypeScript.

// The server colors source text and sends each line's spans as
// `[start, length, color]` in UTF-16 units. The color numbers follow
// `SyntaxColor` in caffold/src/fs/syntax.rs.
export type SyntaxSpan = [start: number, length: number, color: number];

export interface GitRepository {
  rootPath?: string;
  root?: string;
  path?: string;
}

export interface DirectoryEntry {
  name: string;
  path: string;
  kind: string;
  isSymlink?: boolean;
  supported: boolean;
  gitIgnored?: boolean;
  git?: { isRepoRoot?: boolean } | null;
}

export interface DirectoryListing {
  path: string;
  entries: DirectoryEntry[];
  git?: { rootPath: string; branch?: string | null; dirty?: boolean } | null;
}

export interface GitRef {
  name: string;
  kind?: string;
}

export interface GitRefs {
  repository: GitRepository;
  refs: GitRef[];
  defaultBaseRef?: string | null;
  defaultHeadRef?: string | null;
}

export interface GitCompareFile {
  path: string;
  repoRelativePath: string;
  status?: string;
}

export interface GitCompare {
  repository: GitRepository;
  baseRef: string | null;
  headRef: string | null;
  files?: GitCompareFile[];
  additions?: number;
  deletions?: number;
}

export interface GitCompareDiff {
  path?: string;
  repoRelativePath?: string;
  repository?: GitRepository | null;
  kind?: string;
  diff?: string;
  syntaxSpans?: Array<SyntaxSpan[] | null> | null;
  additions?: number;
  deletions?: number;
}

export function listDirectory(path?: string): Promise<DirectoryListing>;

export function documentUrl(path: string): string;

export function downloadUrl(path: string): string;

export function imageUrl(path: string): string;

export function getGitRefs(path?: string): Promise<GitRefs>;

export function getGitCompare(
  path?: string,
  base?: string | null,
  head?: string | null,
): Promise<GitCompare>;

export function getGitCompareDiff(
  path: string,
  base: string | null,
  head: string | null,
  file: string,
): Promise<GitCompareDiff>;
