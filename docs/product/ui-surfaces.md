# UI Surfaces

This document maps the implemented browser surfaces and their product
boundaries. The Tasks workspace selects either a Task or a managed Section as
the stable context for local work.

## Task workspace

The Task workspace is the only routed application workspace. It contains the
Task navigator, Global New, Task/Section Detail, Notes, and Settings. The
workspace navigation at the bottom of the navigation pane switches among Tasks,
Notes, and Settings. Each returns to the screen it last showed, and browser Back
leaves the current one for the previous one at its own depth.

Desktop reading surfaces may keep the Task navigator visible. Code surfaces
use the available detail width. Foldable and phone layouts use the same
master-detail system and show one contextual Back appropriate to the deepest
visible route.

Split panes remember the width the user last chose in this browser, one width
for each kind of pane: the navigation pane shared by Tasks, Notes, and Settings,
Integrated Review for every Task and Section, Git Compare, Git Log commits, and
GitHub Pull Request files. A window too narrow for that width narrows the pane,
and the chosen width returns when the window widens again.

## Task Navigator

The Task navigator provides:

- active and Archived sections;
- repository grouping derived from canonical Task cwd/worktree state;
- task title, recency, availability, and unseen-completion state;
- exclusive Task and Section reorder modes for the persistent Active order;
- Task Switcher, New Task, Archive, Restore, and eligible delete actions.

Managed Section headers are selectable and open Section Detail. Recovery group
headings remain labels only. The selected Section is represented by local id;
its managed logical path supplies the fixed cwd and its repository capability
controls which shared review surfaces are available.

Task reorder mode moves Tasks within their current Section. Section reorder
mode presents the managed Section headers without their Task rows and moves the
Sections as units. Only one mode is active at a time; recovery and Archived
content are not reorderable.

Selecting a Task opens its Conversation. Direct Task URLs load by `threadId`
without requiring the Task to appear in the currently loaded navigator page.

## Task Switcher

The Task Switcher is a modal list of the active Tasks ordered by when each one
last finished a turn, newest first. That is also the time a row shows when it
has nothing else to report, so the column reads in order. Merely opening a Task
does not carry it up the list. It is offered on the Tasks surface, which is
where the active Task list is held.

`T` opens it from the keyboard, and a Switch task button opens it by pointer.
That button stands with whatever holds the Task list's place: the Task
navigator header while the list is on screen, and the compact Back when a
Task, Section, or New Task has replaced the list, so no screen shows two. Wide
code surfaces show neither the navigator nor that Back, and compact file and
domain screens show a deeper Back instead, so there the Task Switcher opens
with `T` or from the Conversation. The X in its header closes it, as do Escape
and a click or tap outside it.

It takes that order from the first loaded Task list and keeps it until it
closes, so a Task that finishes while the list is open does not move the row
being aimed at. Rows keep showing current title, the Section the Task sits in,
availability, and unseen-completion state, and a Task that leaves the active
list leaves the list. The navigator shows that Section as a heading its rows
sit under; a flat list has to say it per row. Choosing a row opens that Task's
Conversation.

Its order is independent of the Task navigator's persistent Active order and
does not change it. Archived Tasks are not listed. An empty active list is
stated rather than left blank, and a list that has not loaded is reported as
unloaded rather than as empty.

## New Task

Global New owns:

- its selected cwd and route representation;
- model and agent selection, reasoning or effort, speed, and approval choices;
- the prompt draft, attachments, and voice input;
- its scoped Directory Picker;
- the setup-only isolated-worktree guide.

A New Task intent from an existing Task starts at that Task's repository root,
not its managed worktree root. The bootstrap initial path and `.` are later
fallbacks. The current New Task owns directory selection and its route value.

Codex readiness gates only Codex surfaces. A blocking canonical Codex
readiness state shows the install, update, sign-in, restart, or recovery
guidance card beside the New Task surface — never over an open Task. A
Codex Task stays readable and its composer usable; a Codex-run submit is
refused by the server with the blocking cause, shown in the composer. Claude
and Grok Tasks, and their creation, never consult Codex readiness. A
stale runtime exposes the same explicit restart confirmation available from
Codex Settings; Retry rechecks the backend diagnosis and Settings stays
available throughout setup. On compact viewports whose home shows the Task
list, the workspace navigation's Codex attention state carries the signal and
the card is read from the New Task surface.

Only the Task store — shared by every agent — takes the Tasks surface over
while its migration blocks operations, with its own retry lifecycle.

Each offered model identifies its agent. Task creation starts a conversation
with that agent in the selected cwd and binds the Task to it; later turns can
choose only models from the same agent. Codex and Claude follow-up composers
can still change permission mode between turns. Every agent's list also offers
**Ask Jev first**, which runs that agent under whichever of its own modes asks
about the most and has Jev hold back only what an automatic mode would stop for,
plus whatever the extra rules in Settings name. A Grok session fixes its mode when the conversation starts, so choosing
it there changes who answers rather than what Grok asks about. A Grok Task's follow-up
composer shows the session's approval mode and does not let it change,
including on an empty Task. New Task reports that the task is starting until
the empty Task is durably created, and the answer opens the Task without
waiting for a turn. The retained New Task submission then moves into
that Task's Composer and is sent through the ordinary prompt flow.
Managed-worktree preparation happens explicitly from the resulting Task; it
is not an implicit side effect of task creation.

Global New and Section New provide the same Composer, turn options, and error
behavior. Section New fixes cwd to the Section's managed logical path, omits
directory browsing and setup guidance, and preserves its draft across
same-Section surface switches.

Section New also presents an **Existing conversations** card after Codex
capability is known. Its Codex row opens a native dialog that accepts a Thread
ID or a copied `codex://threads/<id>` link only after an explicit **Preview
thread** action. The preview reads the provider-owned name, summary, status,
last activity, source cwd, and recent messages without resuming the thread or
adding it to managed Tasks. Editing the ID invalidates that preview. Idle and
not-loaded previews enable **Fork task**; the latter displays **Live status
unavailable** rather than being presented as idle. Active, system-error, and
unrecognized statuses keep the action disabled.

Forking uses Codex's native conversation fork and creates the managed child at
the selected Section's project root. The source cwd is display-only. Files,
uncommitted changes, branches, and worktrees are not copied or created. A
temporarily unavailable Codex runtime leaves the row visible but disabled with
the reason; Claude and Grok are not offered by this surface.

## Detail

Detail provides Summary actions, the subject-aware view switch, Integrated
Review, Git, and GitHub. A Task adds Conversation; a Section adds fixed-context
New Task. Switching Task or Section context reloads repository data, while safe
local state may survive surface switches within one context. If a Section loses
repository capability, it returns to New Task.

## Task Detail

Task Detail presents the selected conversation, command requests,
follow-up Composer, and Task actions. Integrated Review, Git, and GitHub remain
shared repository surfaces.

Task actions open from the Task details control. A Task whose next turn runs
under Ask Jev first also offers **What your prompts settled** there, which
opens a dialog holding those messages oldest first, each under the time it was
sent in the reader's own time zone, and a **Forget these** action. The record
is read when that dialog opens, and the dialog says so while the Task has kept
nothing yet.

An idle Codex Task exposes **Fork task** in Task actions. It performs the same
native fork without an ID lookup, places the child at the source Task's Section
project root, and opens the distinct managed child. Active Codex Tasks, Claude
Tasks, and Grok Tasks keep the action disabled with an explicit reason. Forking
remains separate from worktree isolation.

### Conversation

Conversation renders the canonical agent conversation as a review timeline:

- prompts and agent responses;
- reasoning summaries and tool activity;
- commands, output, and file-change records;
- approvals and canonical outcomes;
- interruption, failure, reconnect, completion, and unavailable states;
- follow-up Start or Steer behavior derived from canonical conversation state.

A prompt reads as the characters typed into the Composer, so Markdown syntax in
it stays literal. Agent responses and reasoning summaries render as Markdown.

Every agent response carries a **Copy** action beside its time: the answer of
a finished turn, a message shown inline while a turn is in progress, and a
message folded into a finished turn's work details. Copy places the response's
Markdown source on the clipboard exactly as the conversation holds it and shows
the outcome beside the action for a moment. Prompts and reasoning summaries have
no Copy action.

A Task opened straight from creation is a valid zero-turn conversation. It
shows the retained initial submission optimistically while the ordinary prompt
request is in flight, and only the adapter's exact accepted-message identity
hands that entry to canonical conversation history. The Composer prevents a
second submission during that handoff. A definitive rejection leaves the Task
open and restores its text, attachments, and selected options for retry; an
outcome-unknown transport failure keeps the unconfirmed entry visible without
automatic replay.

The Composer owns its draft, attachments, selection, and voice capture. A stop
that cancels messages sent into the turn before the agent took them in returns
them to the Composer with their attachments, in the order they were sent and
ahead of the current draft; the conversation no longer shows them. When
the selected voice provider is not ready, its voice action opens
**Settings → Voice Input** instead of recording. Task child switching does
not interrupt the selected Task's stream.

When the selected Task's effective working directory contains the valid
[current plan document pair](workflows.md#current-plan-documents), a compact
read-only control floats directly above the follow-up Composer without moving
it. Its padded left segment shows the optional Plan title and opens the Plan;
its adjacent completed/total segment opens the Checklist. The visible segments
use the normal control hit height while the title truncates inside its own
segment. Both actions use one shared Markdown dialog; task-list checkboxes
remain disabled, and a document path inside the Task project root is displayed
relative to that root while its original Files path remains the read target.
Conversation always retains enough bottom scroll space for the floating
control. The strip stays available while a turn is active. Unless the latest
successful read found the pair or a problem with it, the strip occupies no
layout space, even while plan updates are paused or reads fail. Status stays on
the same single row: a partial or unreadable pair replaces the Plan and
Checklist segments with one warning segment such as `CHECKLIST.md missing` or
`Plan files unreadable` instead of guessed progress, and paused updates or a
failed reread keep the last readable plan with an added warning icon. Either
warning opens a non-blocking popover above the strip that lists each issue with
its original error. Paused updates and failed reads also offer Refresh, which
rereads the plan documents; the paused-updates warning remains until live
updates resume. Other plan or history files remain available through Files
without a dedicated resolved-plan surface.

### Integrated Review

Integrated Review is the product surface for Working Tree and current Task
Branch review. It combines:

- Working Tree or Branch scope;
- Changes or Files navigator;
- Diff plus file-capability-aware Source or Preview representations;
- one selected task-root-relative path.

This is also the product path for general file/source inspection through the
reusable file navigator, source viewer, text viewer, supported image viewer, and
PDF viewer.

### Git

The shared Git child contains only behavior not duplicated by Integrated
Review:

- arbitrary-ref Compare, where both base and head may differ from the Task's
  current branch;
- bounded Log, commit detail, changed files, diff, and source inspection.

Git is non-authoring. Log exposes an explicit Fetch action that updates the
selected repository's remote-tracking default branch and reports its
relationship to the current checkout; it never fetches automatically. Git does
not expose stage, commit, checkout, reset, merge, rebase, stash, or publication
controls. Its active repository watch reacts to ref-derived invalidation only;
it does not own Working Tree status or the Integrated Review selected path.

### GitHub

The shared GitHub child derives its repository from the active Task or Section
context and the authenticated GitHub CLI. It provides:

- Issue list and detail;
- Pull Request list and detail;
- Pull Request changed files, unified diff, and source inspection;
- scoped availability, loading, error, and Retry states.

GitHub refreshes remote state when the user enters or retries a surface. It does
not publish comments, reviews, Pull Requests, or other GitHub mutations.

Issue and Pull Request detail expose the same Start Task action. For an Issue,
the user chooses a base ref. For a Pull Request, the canonical base/head is
read-only and an arbitrary base cannot be selected. Both create a setup-only
Task. The complete sequence and safety boundary are defined in
[Product Workflows](workflows.md).

### Surface state

Switching among Integrated Review, Git, and GitHub may preserve selection,
disclosure, and scroll within the same Task or Section. Returning to a surface
reconciles current source state. Changing Task, Section, or repository context
discards retained external context. The implementation contract is defined in
[Frontend Architecture](../architecture/frontend.md).

## Notes

Notes are Markdown documents that agents keep for the person across Tasks.
Every Task's agent reaches the same Notes; they do not belong to a Task,
Section, or repository. Agents create, read, rename, move, rewrite, and delete
Notes and their directories through Caffold's Notes tools when the person asks.
The Notes surface only reads them.

- The navigation pane shows the Notes tree in the shared File Tree:
  directories before Notes, each ordered by name, independent of the Files
  ordering setting. Directories start closed, and opening one reads what it
  holds; a directory that fails to load says so and is read again when it is
  opened again. The directories that hold the open Note open so the Note stays
  in view.
- Choosing a Note opens it beside the tree on desktop and foldable layouts and
  in place of the tree on a phone, where Back returns to the tree.
- The Note header shows its name on one line and an Info button at its end.
  Below the header are the directories that hold the Note, when it is not at
  the top of the tree. The Info button opens when the Note last changed and
  was created, the Task that created it, and, when a different Task changed it
  last, that Task. An active Task links to its Conversation. A Task archived
  since then shows its name marked archived, and a Task deleted since then is
  named as deleted; neither has a link.
- The content renders as Markdown. An empty Note and a Note that no longer
  exists each say so, and a failed read offers Retry.
- With no Notes, the tree explains that an agent in a Task can save one.
- Entering Notes, or returning the app to the foreground while Notes is shown,
  reads the top of the tree, every directory already opened, and the open Note
  again, and choosing a Note reads that Note again. Nothing updates on its own
  while Notes stays open.

## Settings

Settings includes:

- Appearance controls for System/Light/Dark theme, the Interface and Code
  typefaces, Interface scale, Conversation text, and Code text;
- Notifications controls for the current browser's permission and subscription,
  plus the active browser-installation count, labels, short IDs, and removal;
- Remote Access status and constrained Tailscale Serve controls, with the ready
  private Tailnet URL, copy/open actions, QR handoff, and same-tailnet guidance;
- Voice provider choice among host-local Whisper, OpenAI, Gemini, and Grok, with
  the model each provider uses, Whisper's pinned revision, model download,
  cancellation, and deletion, and API keys that can be saved, replaced, or
  removed but never shown again;
- Jev Permissions, where an API key is saved, replaced, or removed but never
  shown again, and optional extra rules are written. Jev judges to the standard
  of a coding agent's automatic permission mode on its own, holding back only
  what such a mode would stop for; the extra rules only add to that standard or
  take away from it. The page shows the pinned model
  version, whether a key is saved, and what checking that key found when it was
  saved. Without a key, **Ask Jev first** stays in every composer's
  approval-mode list and says what is missing rather than disappearing;
- Codex plan usage as Codex reports it, installation readiness and repair
  guidance, runtime status with an explicit confirmed runtime restart
  available while the canonical runtime is ready or requires restart (the
  ready-state action is neutral, while a required restart retains attention
  styling), Updates with the newest Codex release, whether Codex's own
  automatic updates are on, and an explicit confirmed **Update Codex…**
  action, and diagnostics, with a **Refresh** action;
- Claude installation status, shown and never gated on: the plan's usage
  windows as the agent itself reports them, the binary's version and path, the
  signed-in account and plan, and the runner's process state, with a
  **Refresh** action; plus an explicit, confirmed restart that stops the runner
  and every Claude session it holds, starts a fresh runner on the installed
  binary, and lets conversations resume when their Tasks are opened;
- Grok installation status, shown and never gated on: plan usage as the
  leader reports it, the executable's version and path, the signed-in account
  as the leader confirms it, the leader on Caffold's socket with its own
  build, and the state of Caffold's connection, with a **Refresh** action;
  opening the page starts no leader, session, or turn;
- About Caffold application and build information, including shared
  checking/ready/settled update status and a **Reload to update** action while
  a prepared PWA generation remains ready. Copied diagnostics also include the
  private handoff node, target and observed worker builds, and navigation-attempt
  count for stalled-update investigation.

Normal update checking and readiness are distinct from the viewport-fixed red
build-mismatch alert. That exceptional alert appears only after update checking
has settled without a prepared replacement for a differing server build.

Appearance choices are persisted in browser-local settings rather than Task or
server state.

Notifications reconcile a browser-owned `PushSubscription` and local
installation ID with server-owned registration or revocation state. Permission
is requested only by the explicit **Enable** action. Removing another browser
revokes that installation; opening Notifications there applies the revocation
locally instead of silently subscribing again.

Remote Access projects the backend-owned Tailscale state and Caffold Serve
operation. Localhost may enable, disable, or retry only Caffold's HTTPS port 443
mapping. Tailnet-origin browsers are read-only, still receive the same ready
address, and render the server-produced QR SVG for that exact canonical URL.
Browser request progress and transport errors remain separate from that
canonical status, so a failed refresh retains the last server-reported state
for context but disables Serve controls until a later status response
revalidates them. The surface does not administer accounts, tailnet membership,
ACLs, arbitrary targets, or Funnel.

Codex, Claude, and Grok Settings each open with plan usage, directly below the
page header. The header holds the page description, a **Service status** link,
and **Refresh**. **Service status** opens that provider's status page in a new
tab: Claude at <https://status.claude.com>, Codex at <https://status.openai.com>,
and Grok at <https://status.x.ai>. On a narrow settings pane the description and
link stay together and **Refresh** moves below them. While Codex readiness
reports a state other than `ready`, its repair guidance sits above usage.

Tasks and Codex Settings present the same backend readiness and restart
outcome. Codex Settings keeps manual restart available for `ready` and
`restartRequired`, confirms the interruption boundary, and refreshes canonical
readiness after success. Refreshed readiness releases the Codex surfaces it
holds. The browser is the complete settings surface, while the macOS menu may
expose a compact control when both surfaces use the same server state and
action.

Codex Settings checks for a newer Codex only when the page opens, on Refresh,
and after a restart or update. **Update Codex…** runs Codex's own updater once.
It is available under the same readiness as restart unless the check found
Codex current, asks for its own confirmation, and reports what Codex says it
did, including whether the runtime restarted. A restart and an update never run
together: while one runs, the other is unavailable, including **Restart Codex**
in Task setup.
[Codex App Server](../architecture/codex-app-server.md#explicit-update) owns
the update contract.

## Product boundaries

The browser UI does not provide:

- a full terminal or PTY workspace;
- automatic Task creation from Issue/PR context without an explicit user
  action;
- automatic continuation after the setup turn;
- external-worktree adoption or force cleanup;
- force deletion of dirty managed worktrees;
- split diff, hunk comments, or durable review annotations;
- a Caffold-owned duplicate of either agent's transcript;
- editing, checklist mutation, or archive controls for current plan documents;
- creating, editing, renaming, moving, or deleting Notes by hand, or Note
  history and restore;
- native agent Plan-mode selection or structured clarification forms;
- switching an existing Task between agents.

Planned additions belong in the [Roadmap](roadmap.md), not in this description
of implemented surfaces.
