# Vision

Codger is a personal review console for developers who use coding agents actively and want to inspect agent-generated code before trusting it.

Codex remains the execution engine, while Codger provides a mobile-friendly review layer around task tracking, worktree visibility, diff review, test review, approvals, and follow-up prompts.

## Motivation

The main motivation is that mobile hardware is becoming large enough for real development review work. Foldable phones and wider mobile displays make it plausible to carry only a phone and still inspect meaningful code changes.

That matters because agent-assisted development makes review and direction a larger part of the coding loop. A developer using Codex often needs to:

- inspect the diff
- read surrounding files
- check test output
- approve or reject commands
- interrupt when the direction is wrong
- send a follow-up prompt
- recover the task later

This workflow does not require a full desktop IDE on every device. It needs a mobile-friendly review console connected to the machine where the work is actually running.

Codger's product bet is that review-first agent development can make phone-first development workflows practical without replacing the rich desktop Codex experience.

## Need

The target workflow uses a remote development host as the execution environment and a browser or PWA as the review surface. The reviewer may be at the host machine, on another desktop, or on a tablet, mobile phone, or foldable device over a trusted private network.

The core need is simple: open a lightweight review surface from a mobile or tablet device, send prompts, approve commands, inspect diffs, read related files, and decide what should happen next.

That means Codger needs to make these actions comfortable without requiring a full desktop IDE:

- send a prompt or follow-up instruction
- see which task, thread, and worktree are connected
- inspect changed files and diffs
- read related source files
- check test or command results
- approve or decline requested actions
- return later and continue the review

## Positioning

Codger is a review-centric console optimized for inspecting agent-generated code from a browser, including mobile and foldable screens.

It is for developers who:

- use Codex or another coding agent seriously
- want multiple isolated worktrees for longer tasks
- want to inspect diffs, files, tests, and task history directly
- want mobile review to be practical
- prefer a focused review surface over a full IDE

## Non-Goals

Codger is not:

- an autonomous coding agent
- an IDE
- a VS Code replacement
- a full terminal workspace
- a native Android or iOS app
- a full git mutation UI
- a reimplementation of browser use or computer use workflows

The Codex GUI remains useful as a rich interactive workspace, especially where visual context, browser use, computer use, exploratory work, or the desktop app experience itself matters. Codger is a narrower companion surface for long-running code tasks where mobile review, worktree visibility, remote approval, and recovery need to be optimized outside the desktop app.
