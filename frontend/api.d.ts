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
  branch?: string | null;
  dirty?: boolean;
}

export interface DirectoryEntry {
  name: string;
  path: string;
  kind: string;
  isSymlink?: boolean;
  supported: boolean;
  gitIgnored?: boolean;
  size?: number | null;
  modifiedMs?: number | null;
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
  currentRef?: string | null;
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

// A file's diff in the Working Tree, a commit, or a comparison.
export interface GitDiff {
  path?: string;
  repoRelativePath?: string;
  repository?: GitRepository | null;
  kind?: string;
  diff?: string;
  syntaxSpans?: Array<SyntaxSpan[] | null> | null;
  additions?: number;
  deletions?: number;
}

export interface GitChangedFile {
  path: string;
  repoRelativePath: string;
  status: string;
  category: "staged" | "unstaged" | "untracked";
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}

export interface GitStatus {
  repository: GitRepository;
  files: GitChangedFile[];
  additions: number;
  deletions: number;
}

export interface GitCommitSummary {
  sha: string;
  shortSha: string;
  subject: string;
  body: string;
  authorName: string;
  authorEmail: string;
  authorTimeMs: number;
}

export interface GitCommitFile {
  path: string;
  repoRelativePath: string;
  status: string;
}

export interface GitCommit {
  repository: GitRepository;
  commit: GitCommitSummary;
  files: GitCommitFile[];
  additions: number;
  deletions: number;
}

export interface GitLog {
  repository: GitRepository;
  commits: GitCommitSummary[];
  page: number;
  perPage: number;
  totalCommits: number;
  totalPages: number;
  hasPrevious: boolean;
  hasNext: boolean;
}

export interface GitFetchResult {
  repository: GitRepository;
  remote: string;
  branch: string;
  reference: string;
  ahead: number;
  behind: number;
}

export interface FileContent {
  path: string;
  name: string;
  size: number;
  modifiedMs: number | null;
  language: string;
  content: string;
  syntaxSpans: Array<SyntaxSpan[] | null> | null;
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
): Promise<GitDiff>;

export function readFile(
  path: string,
  signal?: AbortSignal,
): Promise<FileContent>;

export function getGitStatus(path?: string): Promise<GitStatus>;

export function getGitDiff(
  path: string,
  file: string,
  kind?: string,
): Promise<GitDiff>;

export function getGitLog(
  path?: string,
  page?: number,
  perPage?: number,
): Promise<GitLog>;

export function fetchGitRemote(path?: string): Promise<GitFetchResult>;

export function getGitCommit(path: string, sha: string): Promise<GitCommit>;

export function getGitCommitDiff(
  path: string,
  sha: string,
  file: string,
): Promise<GitDiff>;

export interface GitHubRepositoryInfo {
  owner: string;
  name: string;
  nameWithOwner: string;
  url: string;
}

export interface GitHubStatus {
  repository: GitRepository | null;
  github: GitHubRepositoryInfo | null;
  ghAvailable: boolean;
  authenticated: boolean;
  issuesAvailable: boolean;
  pullsAvailable: boolean;
  message: string | null;
}

export interface GitHubIssueSummary {
  number: number;
  title: string;
  state: string;
  author: string | null;
  labels: string[];
  assignees: string[];
  comments: number;
  updatedAt: string | null;
  url: string;
}

export interface GitHubIssueDetail extends GitHubIssueSummary {
  body: string;
  bodyHtml: string | null;
  createdAt: string | null;
}

export interface GitHubIssues {
  repository: GitRepository;
  github: GitHubRepositoryInfo;
  state: string;
  issues: GitHubIssueSummary[];
  page: number;
  perPage: number;
  totalIssues: number;
  totalPages: number;
  hasPrevious: boolean;
  hasNext: boolean;
}

export interface GitHubIssue {
  repository: GitRepository;
  github: GitHubRepositoryInfo;
  issue: GitHubIssueDetail;
}

export interface GitHubPullSummary {
  number: number;
  title: string;
  state: string;
  draft: boolean;
  author: string | null;
  labels: string[];
  comments: number;
  updatedAt: string | null;
  url: string;
}

export interface GitHubPullRepositoryInfo {
  nameWithOwner: string;
  url: string;
}

export interface GitHubPullComment {
  author: string | null;
  body: string;
  bodyHtml: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  url: string | null;
}

export interface GitHubPullReview {
  author: string | null;
  state: string;
  body: string;
  bodyHtml: string | null;
  submittedAt: string | null;
}

export interface GitHubPullCommit {
  sha: string;
  shortSha: string;
  subject: string;
  authorName: string | null;
  authorEmail: string | null;
  authoredAt: string | null;
  committedAt: string | null;
  url: string;
}

export interface GitHubPullDetail extends GitHubPullSummary {
  reviews: number;
  commits: number;
  additions: number;
  deletions: number;
  changedFiles: number;
  baseRefName: string;
  baseRefOid: string;
  baseRepository: GitHubPullRepositoryInfo;
  headRefName: string;
  headRefOid: string;
  headRepository: GitHubPullRepositoryInfo | null;
  body: string;
  bodyHtml: string | null;
  createdAt: string | null;
  conversationComments: GitHubPullComment[];
  reviewComments: GitHubPullReview[];
  commitSummaries: GitHubPullCommit[];
}

export interface GitHubPulls {
  repository: GitRepository;
  github: GitHubRepositoryInfo;
  state: string;
  pulls: GitHubPullSummary[];
  page: number;
  perPage: number;
  totalPulls: number;
  totalPages: number;
  hasPrevious: boolean;
  hasNext: boolean;
}

export interface GitHubPull {
  repository: GitRepository;
  github: GitHubRepositoryInfo;
  pull: GitHubPullDetail;
}

export interface GitHubPullHead {
  repository: GitRepository;
  github: GitHubRepositoryInfo;
  number: number;
  headRef: string;
  headOid: string;
}

export interface GitHubPullFile {
  path: string;
  repoRelativePath: string;
  previousPath: string | null;
  previousRepoRelativePath: string | null;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patchAvailable: boolean;
  blobUrl: string | null;
  rawUrl: string | null;
}

export interface GitHubPullFiles {
  repository: GitRepository;
  github: GitHubRepositoryInfo;
  number: number;
  files: GitHubPullFile[];
  totalFiles: number;
}

export interface GitHubPullFileDiff {
  repository: GitRepository;
  github: GitHubRepositoryInfo;
  number: number;
  path: string;
  repoRelativePath: string;
  status: string;
  kind: string;
  additions: number | null;
  deletions: number | null;
  diff: string;
  diffUnavailable: boolean;
  message: string | null;
}

export function createTask(task: Record<string, unknown>): Promise<unknown>;

export function getGitHubStatus(path?: string): Promise<GitHubStatus>;

export function getGitHubIssues(
  path?: string,
  state?: string,
  page?: number,
  perPage?: number,
): Promise<GitHubIssues>;

export function getGitHubIssue(
  path: string,
  number: number,
): Promise<GitHubIssue>;

export function getGitHubPulls(
  path?: string,
  state?: string,
  page?: number,
  perPage?: number,
): Promise<GitHubPulls>;

export function getGitHubPull(
  path: string,
  number: number,
): Promise<GitHubPull>;

export function prepareGitHubPullHead(
  path: string,
  number: number,
  headOid: string,
  baseRepository: string,
): Promise<GitHubPullHead>;

export function getGitHubPullFiles(
  path: string,
  number: number,
): Promise<GitHubPullFiles>;

export function getGitHubPullFile(
  path: string,
  number: number,
  file: string,
): Promise<GitHubPullFileDiff>;
