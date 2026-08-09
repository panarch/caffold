# UI Surfaces

> Internal product-surface map of the current browser UI.

Caffold is a dense, review-oriented work surface for desktop, foldable, and
phone layouts. Its browser components present state owned by Codex, Git,
GitHub, the filesystem, and Caffold without replacing those sources of truth.

## Task Navigator

The Task navigator is the return-later entrypoint. It provides:

- active and Archived sections;
- repository grouping derived from each thread cwd;
- linked-worktree context within each repository;
- task title, recency, canonical availability, and unseen-completion state;
- New Task, Archive, and Restore actions where their lifecycle permits them.

Selecting a Task opens its Conversation without changing its repository or
worktree context.

## New Task

New Task provides:

- cwd selection inherited from the active Task or Files context when available;
- model and reasoning-effort selection;
- the shared prompt composer, image attachment, and voice input;
- a setup-only guide for preparing an isolated worktree.

Task creation starts a Codex thread in the selected cwd. Managed-worktree
preparation happens explicitly from the resulting Task; it is not an implicit
side effect of task creation.

## Conversation

Conversation renders the canonical Codex thread as a review timeline. It
includes:

- user prompts and agent responses;
- reasoning summaries and tool activity;
- command execution, output, and file-change records;
- approval requests and their canonical outcomes;
- interruption, failure, completion, reconnect, and unavailable states;
- follow-up Start or Steer behavior selected from canonical thread state.

The composer owns drafts, selection, attachments, and voice capture. It can
interrupt an active turn but does not synthesize Codex lifecycle state.

## Integrated Task Review

Each Task has one integrated Review workspace with independent semantic axes:

- Working Tree or Branch scope;
- Changes or Files navigator;
- Diff or Source viewer;
- one selected worktree-relative path.

Desktop and foldable layouts keep navigator and viewer visible together. Phone
layouts show one role at a time and provide a semantic Back action from the
selected file. Review selection is encoded in the URL; pane width, disclosure,
and scroll remain component-local.

## Files

The standalone Files surface provides rooted filesystem inspection:

- directory navigation and file viewing;
- filename filtering and `rg` content search;
- text, source, and supported image presentation;
- live invalidation with an explicit Refresh fallback;
- repository-aware entry into Git and GitHub review.

The configured `RootedFs` boundary rejects traversal and symlink escapes.

## Git Review

Git is read/review-oriented and contains three modes:

- Diff for the working tree;
- Compare for two refs;
- Log for bounded commit history and commit detail.

Each mode owns its navigator, selected path, viewer state, and repository
refresh. Caffold does not expose stage, commit, checkout, reset, merge, rebase,
or stash controls.

## GitHub Review

GitHub review uses the repository resolved from cwd and the authenticated
GitHub CLI. It provides:

- Issue list and detail;
- Pull Request list and detail;
- Pull Request changed files, unified diff, and source review;
- availability and error states when GitHub context cannot be resolved.

The current surface is read-only. It does not publish comments, reviews, pull
requests, or other GitHub mutations.

## Settings

The Task workspace includes:

- Appearance settings for Interface, Conversation, and Code scales;
- Codex runtime status and diagnostics;
- About Caffold application and build information.

Appearance choices are browser-local. Task model and reasoning choices are
stored with Caffold-managed Task metadata.

## Product Boundaries

The browser UI does not provide:

- a full terminal or PTY workspace;
- automatic Issue/PR preparation and continuation;
- external-worktree adoption or cleanup;
- force deletion of dirty managed worktrees;
- split diff, hunk comments, or durable review annotations;
- a Caffold-owned duplicate of the Codex transcript.

Planned additions belong in the [Roadmap](roadmap.md) and
[Product Workflows](workflows.md), not in the description of an implemented
surface.
