# Operation Ledger

> Internal planning note. This describes Caffold-owned event history before the schema is implemented.

The operation ledger is a possible application-level append-only event log.

It is not part of the first thread-backed Tasks slice. It is not the database
WAL and it is not a complete replay log for all state.

## Purpose

The ledger exists for:

- optional task timeline augmentation
- audit trail
- debugging
- reconnect and recovery hints
- explaining what happened during a long-running task
- preserving important user decisions

## Source of Truth Boundary

Caffold should not try to own every original event.

Source ownership:

- Codex owns thread/session originals
- git owns file changes
- command runner owns immediate process output while running
- Caffold may own optional annotations, summaries, and operation events

Caffold can store summaries and snapshots when they make the UI more reliable,
but Codex threads remain the source of truth for task transcripts and full
transcript duplication is not the default.

## Event Types

Initial event candidates:

- task_created
- task_status_changed
- worktree_created
- worktree_attached
- codex_thread_started
- codex_thread_attached
- turn_started
- turn_completed
- turn_interrupted
- approval_requested
- approval_accepted
- approval_accepted_for_session
- approval_declined
- approval_cancelled
- prompt_sent
- command_started
- command_completed
- test_started
- test_completed
- diff_observed
- file_opened
- search_run
- task_archived
- cleanup_requested
- cleanup_completed
- cleanup_blocked

## Event Shape

Each event should be structured.

Common fields:

- event_id
- task_id
- project_id
- host_id
- timestamp
- event_type
- actor
- summary
- structured payload

The payload should be typed per event. Avoid storing important state only as free-form text.

## Snapshot Policy

Caffold can store small UI-facing snapshots such as:

- latest git status summary
- latest diff stat
- latest command exit code
- latest test summary
- latest known Codex thread status

These snapshots improve recovery UX. They do not replace git or Codex as original sources.
