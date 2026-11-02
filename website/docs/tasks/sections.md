# Sections

The Task list groups your Tasks into Sections. A Section is a directory: the
first Task you start in a directory creates its Section, and later Tasks there
join it. A Section is listed for as long as it has active Tasks.

A Section whose directory is a Git repository shows a repository icon. Tasks
that move into a [worktree](worktrees.md) stay in their repository's Section,
marked with a branch icon.

## Open a Section

Select a Section's name to open it. An open Section offers, for its directory:

- **New Task**, which starts a Task there with the model, reasoning level,
  speed, and approval mode of the last turn started in that Section.
- For a repository, **Working Tree**, **Branch**, **Git**, and **GitHub**, which
  show the repository itself without opening a Task. See
  [Review changes](../review/changes.md).
- A [terminal](terminal.md) in the Section's directory, from the last button
  in the header.
- **Existing conversations**, which forks a Codex, Claude, or Grok conversation into the
  Section. See [Fork a conversation](fork.md).

![A Section opened: New Task in its directory, existing conversations, and its GitHub repository](../assets/screenshots/section-detail-desktop.png)

## Pin a Task

Open a Task's details from the button beside its title and choose **Pin task**.
The Task moves to **Pinned** at the top of the Task list and to the top of the
[Task Switcher](../keyboard.md#switch-tasks-t). Choose **Unpin task** to return
it to the top of its Section. Archiving a Task unpins it.

A Section whose Tasks are all pinned stays in the list, so you can still open
it.

## Reorder

Choose the reorder button at the top of the Task list, then choose whether to
move Tasks within their Sections or move whole Sections. Drag the rows into the
order you want; press <kbd>Esc</kbd> or choose the button again to finish.
Pinned Tasks move among themselves, and Pinned stays at the top. The order is
kept on the Mac, so every screen shows the same list.

The [Task Switcher](../keyboard.md#switch-tasks-t) lists the same
Tasks, pinned ones first, by when they last finished instead, without changing
this order.
