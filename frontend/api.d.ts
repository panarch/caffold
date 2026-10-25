// What TypeScript modules use from api.js while it is still JavaScript. It
// goes when that module moves to TypeScript.

import type { CodexReadiness } from "./pages/(task-workspace)/codex-status.js";

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

// The models the agents offer, and the agents that could not be asked.
export interface AgentModels {
  models: AgentModel[];
  unavailable: Array<{ provider: string; message: string }>;
}

export interface AgentModel {
  provider: string;
  model: string;
  displayName: string;
  isDefault: boolean;
  defaultEffort: string | null;
  efforts: string[];
  supportsFastMode: boolean;
}

// The ways an agent lets a model work in a directory, as the agent offers
// them.
export interface AgentPermissionModes {
  defaultMode: string;
  options: AgentPermissionMode[];
  fixedWhenConversationStarts: boolean;
}

export interface AgentPermissionMode {
  mode: string;
  label: string;
  description: string;
  allowed: boolean;
  unavailableReason?: string;
  dangerous: boolean;
}

export function getAgentModels(): Promise<AgentModels>;

export function getAgentPermissions(
  cwd?: string,
  provider?: string,
  model?: string,
): Promise<AgentPermissionModes>;

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

// A Task as the Task API reports it, as far as TypeScript callers read it.
export interface Task {
  threadId: string;
  conversationAvailable: boolean;
  title: string;
  threadStatus: TaskThreadStatus;
  activeTurn: { id: string; startedAtMs: number | null } | null;
  cwd: string;
  cwdPath: string | null;
  relativeCwd: string;
  worktree: TaskWorktree | null;
  createdMs: number;
  updatedMs: number;
  recencyMs: number | null;
  lastCompletedMs: number | null;
  unseen: boolean;
}

// What the agent is doing for a Task. An active Task with no flags is working.
export type TaskThreadStatus =
  | { type: "notLoaded" | "idle" | "systemError" }
  | {
      type: "active";
      activeFlags: Array<"waitingOnApproval" | "waitingOnUserInput">;
    };

// The worktree a Task runs in, when it runs in one.
export interface TaskWorktree {
  rootPath: string;
  repositoryRootPath: string;
  branch: string | null;
  headSha: string;
  relativeCwd: string;
  linked: boolean;
}

// A Task as the Active list shows it. `worktree` says whether it runs in a
// worktree Caffold made for it.
export interface ActiveTask {
  threadId: string;
  title: string;
  threadStatus: TaskThreadStatus;
  unseen: boolean;
  lastCompletedMs: number | null;
  recencyMs: number | null;
  updatedMs: number;
  worktree: boolean;
}

// A listed Task that cannot sit in a Section until the person recovers it.
export interface ActiveTaskRecovery extends ActiveTask {
  recovery: {
    reason:
      | "sectionPlacementPending"
      | "codexArchived"
      | "threadMissing"
      | "temporarilyUnavailable";
    actions: Array<
      "recheck" | "restoreToActive" | "moveToArchived" | "removeFromCaffold"
    >;
  };
}

// What a Section's Tasks last ran under.
export interface ActiveTaskComposerSettings {
  model: string | null;
  effort: string | null;
  fastMode: boolean;
  permissionMode?: string;
}

export interface ActiveTaskSection {
  id: string;
  name: string;
  repository: boolean;
  composerSettings: ActiveTaskComposerSettings | null;
  tasks: ActiveTask[];
}

// Where a Task newly at the top of the Active list goes.
export interface ActiveTaskTopPlacement {
  section: { id: string; name: string; repository: boolean };
  beforeSectionId: string | null;
  beforeThreadId?: string;
}

export function getTasks(): Promise<{
  sections: ActiveTaskSection[];
  unsectioned: ActiveTaskRecovery[];
}>;

export function getArchivedTasks(
  cursor?: string | null,
): Promise<{ tasks: Task[]; nextCursor: string | null }>;

export function reorderTask(
  threadId: string,
  beforeThreadId: string | null,
): Promise<unknown>;

export function reorderSection(
  sectionId: string,
  beforeSectionId: string | null,
): Promise<unknown>;

export function restoreTask(
  threadId: string,
): Promise<{ task: ActiveTask; activeTopPlacement: ActiveTaskTopPlacement }>;

// A Task whose worktree is broken is deleted only with the worktree its
// diagnosis named.
export function deleteTask(
  threadId: string,
  confirmation?: {
    confirmBrokenWorktreeDeletion: boolean;
    expectedWorktreeId: string;
  } | null,
): Promise<unknown>;

// Why a Task cannot be opened: archived, or unknown to Caffold.
export const TASK_ABSENCE: Readonly<{
  ARCHIVED: "archived";
  NOT_FOUND: "not-found";
}>;

export type TaskAbsence = (typeof TASK_ABSENCE)[keyof typeof TASK_ABSENCE];

// The absence a failed Task request or a refused Task channel reports, or null
// for any other failure.
export function taskAbsence(error: unknown): TaskAbsence | null;

// A Task request's failure as the API reports it. A Task whose worktree is
// broken also says what may still be done with it and which worktree that is.
export interface TaskResponseError extends Error {
  code?: string;
  status?: number;
  allowedActions?: string[];
  worktreeId?: string;
  worktreePath?: string;
  worktreeMissing?: boolean;
}

// An error from a reported Task failure: an error as it is, or the API's error
// body with what it says the Task still allows.
export function taskResponseError(
  value: unknown,
  fallback?: string,
): TaskResponseError;

// A Task's current plan as the server reads it from the Task's folder; the
// Current Plan checks its shape.
export function getCurrentPlan(
  path?: string,
  signal?: AbortSignal,
): Promise<unknown>;

// What a Task's own prompts settled about what it may do, as one text.
export function getTaskPermissionInstructions(
  threadId: string,
): Promise<{ instructions?: string | null }>;

export function forgetTaskPermissionInstructions(
  threadId: string,
): Promise<{ instructions?: string | null }>;

// Where an item sits in its conversation: its turn's anchor and its place in
// that turn.
export interface TaskEventPosition {
  anchorMs: number;
  index: number;
}

// The extent of a conversation a Task detail answers for. An open end reaches
// that end of the conversation.
export interface TaskEventsRange {
  from?: TaskEventPosition | null;
  to?: TaskEventPosition | null;
}

// A Task with its conversation, as the Task API and the Task's stream report
// it: the Task, a page of its items and the extent they cover, the
// publication revision they carry, and what its next turn runs under.
export interface TaskDetail {
  threadId?: string;
  task: Task | null;
  events?: TaskEvent[];
  fileLinks?: TaskFileLink[];
  revision?: number;
  eventRevision?: number;
  eventsRange?: TaskEventsRange | null;
  eventsPage?: { nextCursor?: string | null } | null;
  historyLoading?: boolean;
  syncState?: string;
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  fastMode?: boolean;
  permissionMode?: string;
  context?: TaskContextUsage | null;
}

// How much of the model's context the conversation takes up now, and how
// much the model holds.
export interface TaskContextUsage {
  usedTokens: number;
  windowTokens: number;
}

export function getTask(
  threadId: string,
  cursor?: string | null,
  options?: { signal?: AbortSignal },
): Promise<TaskDetail>;

// A prompt for a Task's agent. The answer names the user message it became
// and says whether it steered the running turn instead of starting one.
export function sendTaskPrompt(
  threadId: string,
  prompt: string,
  options?: Record<string, unknown>,
  imagePaths?: string[],
): Promise<{ threadId: string; userMessageId: string; steered: boolean }>;

// One file a prompt carries, into that send's upload folder.
export function uploadTaskFile(
  threadId: string,
  folder: string,
  name: string,
  file: Blob,
  options?: { onProgress?: (loaded: number) => void; signal?: AbortSignal },
): Promise<unknown>;

export function discardTaskUploads(
  threadId: string,
  folder: string,
): Promise<unknown>;

// Stops the running turn. The prompts the stop cancelled before the agent
// took them in come back to be sent again.
export function interruptTask(
  threadId: string,
): Promise<TaskDetail & { cancelledPrompts: Array<{ prompt: string }> }>;

export function resolveTaskApproval(
  threadId: string,
  approvalId: string,
  decision: string,
): Promise<TaskDetail>;

export function markTaskSeen(threadId: string): Promise<Task>;

export function archiveTask(threadId: string): Promise<Task>;

// A Task just made: its detail, the Active list's listing of it, and where it
// goes at the top of that list.
export interface CreatedTask {
  detail: TaskDetail;
  activeTask: ActiveTask;
  activeTopPlacement: ActiveTaskTopPlacement;
}

// A new Task that starts from this one's conversation.
export function forkTask(threadId: string): Promise<CreatedTask>;

// An agent's conversation a new Task can start from: its name and summary,
// its status, the project it ran in, when it was last active, and its recent
// messages.
export interface TaskForkSourcePreview {
  provider: string;
  sourceId: string;
  displayName: string;
  summary: string | null;
  status: TaskThreadStatus;
  cwd: string | null;
  lastActivityMs: number | null;
  recentHistory: Array<{ role: string; text: string }>;
}

export function previewTaskForkSource(
  source: { provider: string; sourceId: string },
  signal?: AbortSignal,
): Promise<TaskForkSourcePreview>;

// A new Task in a Section that starts from another conversation of an agent.
export function createTaskFork(fork: {
  provider: string;
  sourceId: string;
  sectionId: string;
}): Promise<CreatedTask>;

// Whether a restore failed because the Task is already active.
export function taskAlreadyActive(error: unknown): boolean;

// One conversation item as a Task's detail and its stream deliver it. The
// backend gives its identity, its place in the conversation, and the time it
// was observed; `payload` carries what each kind of item says. The Task screen
// adds `fileLinks` to a message whose file references resolved.
export interface TaskEvent {
  id: string;
  threadId: string;
  type: string;
  summary: string;
  payload: TaskEventPayload | null;
  position: { anchorMs: number; index: number };
  observedMs: number | null;
  fileLinks?: TaskFileLink[];
}

// A file reference in an agent's message and the file it resolved to in the
// Task.
export interface TaskFileLink {
  target: string;
  taskRelativePath: string;
  line?: number;
  // The item it was found in, as a Task detail lists its links.
  eventId?: string;
}

export interface TaskEventPayload {
  itemId?: string;
  // A prompt this browser sent that the agent's history does not hold yet.
  optimistic?: boolean;
  submissionState?: string;
  status?: string;
  text?: string;
  prompt?: string;
  phase?: string;
  summary?: string[];
  content?: Array<string | TaskMessageContent>;
  suggestedPrompts?: Array<{ label?: string; prompt?: string } | null>;
  upload?: { lines?: TaskUploadLine[] } | null;
  name?: string;
  available?: boolean;
  paths?: string[];
  command?: string;
  cwd?: string;
  output?: string;
  exitCode?: number | null;
  durationMs?: number | null;
  approvalId?: string;
  title?: string;
  reason?: string;
  decisions?: string[];
  networkEndpoint?: string;
  grantRoot?: string;
  environment?: string;
  permissions?: Array<{
    label?: string;
    value?: string;
    verbatim?: boolean;
  } | null>;
  tool?: ApprovalTool | null;
  reviewed?: { concern?: number; model?: string } | null;
}

export interface TaskMessageContent {
  type?: string;
  text?: string;
  url?: string;
  path?: string;
  name?: string;
}

export interface TaskUploadLine {
  path: string;
  done?: boolean;
}

export interface ApprovalTool {
  serverName?: string;
  appName?: string;
  description?: string;
  arguments?: Array<{ name: string; label: string; value: unknown }>;
}

export function getGitHubStatus(path?: string): Promise<GitHubStatus>;

// A terminal belongs to one Task or one Section.
export interface TerminalSubject {
  kind: "task" | "section";
  id: string;
}

// Starts the subject's shell at the given size.
export function openTerminal(request: {
  subject: TerminalSubject;
  cwd: string;
  cols: number;
  rows: number;
}): Promise<unknown>;

export function killTerminal(subject: TerminalSubject): Promise<unknown>;

// Where a screen attaches to the subject's terminal: `take` to be its one
// screen, `resume` only if it already was; `tab` names the browser tab.
export function terminalSocketUrl(
  subject: TerminalSubject,
  options: { mode: string; tab: string; cols: number; rows: number },
): string;

// What the server last found about Codex, without a check of its own.
export function getCodexReadiness(): Promise<{
  readiness?: CodexReadiness | null;
}>;

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

export interface NoteDirectorySummary {
  id: string;
  name: string;
  updatedAtMs: number;
  directoryCount: number;
  noteCount: number;
}

export interface NoteSummary {
  id: string;
  name: string;
  updatedAtMs: number;
}

// What one directory, or the top of the Notes tree, directly holds.
export interface NotesLevel {
  directories: NoteDirectorySummary[];
  notes: NoteSummary[];
}

// The Task that wrote a Note. A Task deleted since then keeps only its id.
export type NoteTask =
  | { threadId: string; state: "active" | "archived"; displayName: string }
  | { threadId: string; state: "deleted" };

export interface Note {
  id: string;
  name: string;
  content: string;
  // The directories that hold the Note, from the top of the tree.
  location: Array<{ id: string; name: string }>;
  createdAtMs: number;
  updatedAtMs: number;
  createdBy: NoteTask;
  updatedBy: NoteTask;
}

export function getNotes(
  directoryId: string,
  signal?: AbortSignal,
): Promise<NotesLevel>;

export function getNote(noteId: string, signal?: AbortSignal): Promise<Note>;

export interface CodexMcpDiagnostics {
  available: boolean;
  processGeneration: number | null;
  appServerVersion: string | null;
  threads: Array<{
    threadId: string;
    available: boolean;
    servers?: Array<{
      name?: string;
      runtimeStatus?: string;
      authStatus?: string;
    }>;
    error?: string | null;
  }>;
  error: string | null;
}

export interface CodexUpdates {
  update: "available" | "upToDate" | "unknown";
  installedVersion?: string | null;
  runningVersion?: string | null;
  latestVersion?: string | null;
  automaticUpdates?: string | null;
  problems?: { latestVersion?: string; installation?: string } | null;
}

export function getCodexMcpDiagnostics(): Promise<CodexMcpDiagnostics>;

export function getCodexUpdates(): Promise<CodexUpdates>;

// Each source answers for itself; one that could not answer names its problem
// under `problems` instead.
export interface ClaudeStatus {
  executable?: { path?: string; version: string };
  auth?: {
    loggedIn: boolean;
    method?: string;
    email?: string;
    subscription?: string;
  };
  usage?: {
    subscriptionType?: string;
    windows: Array<{
      kind: string;
      percent: number;
      resetsAt?: string;
      model?: string;
    }>;
  };
  runner?: {
    running: boolean;
    pid?: number;
    version?: string;
    sessions?: number;
    idleTimeoutSecs?: number;
  };
  problems?: Partial<
    Record<"executable" | "auth" | "usage" | "runner", string>
  >;
}

export interface GrokStatus {
  executable?: { path: string; version: string };
  leader?: {
    socketPath: string;
    running: boolean;
    socketStale: boolean;
    pid?: number;
    version?: string;
  };
  connection: {
    state: string;
    agentVersion?: string;
    authMethods: string[];
    defaultAuthMethod?: string;
  };
  auth: {
    cachedSignIn: boolean;
    verified?: {
      authenticated: boolean;
      mode?: string;
      subscriptionTier?: string;
      email?: string;
    };
  };
  usage?: {
    percent?: number;
    period?: { type?: string; start?: string; end?: string };
    onDemand?: { used?: number; cap?: number };
    prepaid?: { balance: number };
  };
  problems?: Partial<
    Record<"executable" | "auth" | "usage" | "leader" | "connection", string>
  >;
}

export function getClaudeStatus(): Promise<ClaudeStatus>;

export function getGrokStatus(): Promise<GrokStatus>;

export interface PushInstallation {
  clientId: string;
  installationLabel: string;
  updatedAtMs?: number;
}

export interface PushSubscriptionPayload {
  installationLabel: string;
  endpoint: string;
  expirationTime: number | null;
  keys: { p256dh: string; auth: string };
}

export function getPushConfig(): Promise<{ publicKey: string }>;

export function getPushInstallations(clientId: string): Promise<{
  currentState: string;
  installations?: PushInstallation[];
}>;

export function upsertPushInstallation(
  clientId: string,
  subscription: PushSubscriptionPayload,
): Promise<PushInstallation>;

export function removePushInstallation(clientId: string): Promise<unknown>;

// The Tailscale, Voice, and Jev answers are checked by the lifecycle that
// asked for them.
export function getTailscaleStatus(): Promise<unknown>;

export function setTailscaleServe(enabled: boolean): Promise<unknown>;

// What the Composer needs to offer voice input.
export interface VoiceStatus {
  provider: string;
  ready: boolean;
  maxRecordingSeconds: number;
}

export function getVoiceStatus(): Promise<VoiceStatus>;

// What a recording said, and which provider heard it.
export interface VoiceTranscript {
  text: string;
  provider: string;
}

export function transcribeVoice(
  recording: Blob,
  signal?: AbortSignal,
): Promise<VoiceTranscript>;

export function getVoiceSettings(): Promise<unknown>;

export function selectVoiceProvider(provider: string): Promise<unknown>;

export function startVoiceModelDownload(): Promise<unknown>;

export function removeVoiceModel(): Promise<unknown>;

export function storeVoiceKey(provider: string, key: string): Promise<unknown>;

export function removeVoiceKey(provider: string): Promise<unknown>;

export function getJevSettings(): Promise<unknown>;

export function saveJevCriteria(criteria: string): Promise<unknown>;

export function storeJevKey(key: string): Promise<unknown>;

export function removeJevKey(): Promise<unknown>;
