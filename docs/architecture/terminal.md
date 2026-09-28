# Terminals

Each Task and each Section can have one shell terminal. The backend runs the
shell on a pseudo-terminal (PTY) and keeps its screen, so a browser can leave
the terminal and later come back to the same shell and screen, from the same
device or another one. The browser draws the terminal in the Detail body.

## Ownership

- `caffold/src/app/terminal.rs` owns the HTTP and WebSocket routes. Its private
  registry, shell, and screen-restore modules live in
  `caffold/src/app/terminal/`.
- The registry keeps terminals in backend memory only, keyed by a Task thread ID
  or a Managed Section ID. Nothing about a terminal is stored in the Task store,
  and every terminal ends when the backend exits or restarts.
- A terminal is one shell process. Caffold runs no multiplexer; a person who
  wants several shells in one Task runs one, such as tmux, inside the terminal.
- The shell is `$SHELL -l`, or `/bin/sh -l` when `SHELL` is unset, started
  directly rather than through macOS `login`. It starts in the Task's working
  directory — the managed worktree once the Task has one — or in the Section's
  directory, and it receives `TERM=xterm-256color`, `COLORTERM=truecolor`, and,
  when none of `LANG`, `LC_ALL`, and `LC_CTYPE` is set, a UTF-8 `LC_CTYPE`.
- The backend's screen state for a terminal is an `alacritty_terminal` screen
  with 5,000 lines of scrollback, fed by a reader thread per terminal. The
  browser's xterm.js buffer is only a view of the output it was sent.

| State | Owner | Writers | Persisted |
| --- | --- | --- | --- |
| Which subjects have a terminal | Registry | Open and Kill requests, shell exit, Task isolation and Archive, eviction, backend shutdown | No |
| Shell process and PTY | Operating system; the registry holds the PTY | The shell; the registry for size and stopping | No |
| Screen and scrollback | The terminal's `alacritty_terminal` screen | The reader thread, resizes | No |
| Attached viewer | Registry, one per terminal | WebSocket attach and detach, terminal end | No |
| Last viewed order | Registry | Open, attach, detach | No |
| Whether a command is running | The PTY's foreground process group | Read when needed, never stored | No |

## Lifetime

A terminal ends only when:

1. someone kills it (`DELETE /api/terminal`);
2. its shell exits, for example after `exit` or Ctrl+D;
3. its Task moves into a new managed worktree: a successful
   `isolate_current_task` that creates the worktree closes the Task's terminal,
   because the shell was started in the old directory. A Task already in its
   worktree and a failed isolation keep the terminal, and so does a Section
   terminal in the same directory;
4. its Task leaves the Active list through Archive, recovery Archive, or
   recovery removal. The terminal closes after the request's checks pass and
   before any managed worktree is removed; a refused request leaves it running.
   Permanent delete accepts only archived Tasks, which have none;
5. the backend exits; or
6. the cap below evicts it.

Closing a terminal tells its viewer the terminal ended and sends the shell a
hangup. A shell still running after three seconds is killed. The reader thread
keeps draining output while it waits, because an exiting shell on macOS waits
until its terminal output has been read. A shell that exits on its own may
leave output unread on Linux, so the reader reads what is waiting before it
reports the end. The shell's exit is observed without
reaping it (`waitid` with `WNOWAIT`), so its pid cannot be reused while Caffold
may still signal it.

Nothing announces why a terminal ended. A screen that was using it goes back to
the surface the subject showed before the terminal, as the toggle does.

## Cap

The backend keeps at most 10 terminals. Opening another one first closes one:

1. a terminal a viewer is attached to is never chosen;
2. a terminal whose shell holds the PTY's foreground — no command running — is
   chosen before a busy one;
3. among those, the least recently opened, attached, or detached goes first.

If every terminal is attached, the new one opens anyway and the backend holds
more than 10 until some end. A job started with `&` does not hold the
foreground, so its terminal counts as idle.

## Viewing

At most one viewer is attached to a terminal. A viewer names the browser tab it
comes from, an identifier the page keeps in session storage so it survives a
reload, and attaches with one of two modes:

- `take`: the person asked for the terminal on this screen. A viewer already
  attached elsewhere is told `taken` and detached.
- `resume`: the terminal screen appeared on its own — a reload, a link, Back or
  Forward, or a page becoming visible again. If a viewer from another tab is
  attached, this one is told `elsewhere` and attaches nothing. A viewer from the
  same tab is that tab's earlier connection, which the network may have dropped
  before the backend noticed, so it is replaced as with `take`. A duplicated tab
  carries the same identifier and replaces its original the same way.

A terminal starts with the size in its open request, takes each attached
viewer's size, and keeps the last one while no viewer is attached. A program
that changes the PTY's size gets that size back with its next output:
`stty cols` does not stick, and a resize survives a readline shell such as
bash, which writes back the size it read whenever it starts a line.
Only the attached viewer's input reaches the shell. Program queries such as a
cursor-position request are answered by the viewer's xterm.js; the backend's
screen drops the answers it would produce, so the program receives exactly one.

On attach the backend sets the viewer's size, sends a snapshot of the screen,
and then sends live output. The snapshot is VT output that redraws, in a reset
terminal of the same size, the scrollback and screen cells with their colors,
attributes, wide and combining characters, links, and wrapped lines, followed
by the cursor position, shape, and visibility, the program's input and mouse
modes, and changed palette colors. It does not carry what `alacritty_terminal`
does not expose: the primary screen behind the alternate screen, the scroll
region, tab stops, character sets, the saved cursor, the title, and the
keyboard mode stack. A viewer attaching while a program such as vim holds the
alternate screen therefore sees an empty primary screen once that program
exits.

When the attach did not change the size, a program in the foreground receives
`SIGWINCH` so it draws again what the snapshot could not carry. A shell at its
prompt is left alone: the snapshot already shows its prompt, and a redraw there
can repeat the line being typed.

A viewer that cannot keep up does not slow the shell. Output waiting for one
viewer is capped at 1 MiB; beyond that the waiting output is dropped and the
viewer receives `resync` and a new snapshot.

## HTTP and WebSocket

A request names its subject with exactly one of `task=<thread ID>` or
`section=<Managed Section ID>`.

| Request | Behavior |
| --- | --- |
| `POST /api/terminal` with `{ "task" or "section", "cwd", "cols", "rows" }` | Opens the subject's terminal unless it has one, and answers `204`. `cwd` is the logical path of the directory the shell starts in, resolved like every other browsing-root path. |
| `DELETE /api/terminal?task=…` or `?section=…` | Kills the subject's terminal if it has one, and answers `204`. |
| `GET /api/terminal/socket?…&mode=take\|resume&tab=…&cols=…&rows=…` | Upgrades to the WebSocket that attaches one viewer from browser tab `tab`. |

Sizes are 2 to 1,000 columns and 1 to 500 rows, and a tab is named in 1 to 64
bytes. Errors are JSON: `invalid_terminal_subject`, `invalid_terminal_size`,
`invalid_terminal_tab`, the browsing-root path errors, `terminal_start_failed`
(503) when the shell cannot start, and `same_origin_terminal_required` (403).
All three requests require an `Origin` that matches the request's `Host`;
[Security and Approvals](security-and-approvals.md#terminals) explains why.

On the socket, text messages are JSON objects with a `type`:

- from the backend: `attached` and `resync`, each followed by one binary message
  holding the snapshot the browser redraws from after a reset; `elsewhere`,
  `absent`, `taken`, and `ended`, each followed by the backend closing the
  socket;
- from the browser: `{ "type": "resize", "cols": …, "rows": … }`.

All other binary messages are output from the backend and input from the
browser. A socket that closes without one of the closing messages has failed.

## Browser

The Detail layout owns the terminal surface for its subject, the header
terminal button, and the toggle behind that button, `⌘J`, and `` Ctrl+` ``. A
screen using the subject's live terminal returns to the surface it came from —
or to the Task's Conversation or the Section's New Task when it was entered
directly — and any other screen enters the terminal with `take`. Entering by any other
path uses `resume`. [Navigation Routing](navigation.md#task-detail-routes) owns
the routes and [Frontend Architecture](frontend.md#terminal) the component
boundaries.

The terminal screen follows one control model per activation:

- nodes: `inactive`, `connecting(take|resume)`, `live`, `elsewhere`, `empty`,
  `suspended`, `disconnected`;
- `take` creates the terminal if needed before attaching; `absent` and a
  refused creation lead to `empty`, the latter with the backend's message;
- `ended` and `taken` leave `live` and move keyboard focus out of the terminal
  screen to the Detail pane. `ended` also asks the Detail layout to go back to
  the surface the subject showed before, so `empty` is only seen by a screen
  that arrives where no terminal runs. `elsewhere` and `empty` offer to take the
  terminal here;
- a hidden page suspends the socket and resumes it when the page returns;
- a failed socket, or xterm.js failing to load, is `disconnected`. The Detail
  layout then reports its transport as unavailable, so the App Shell's recovery
  notice appears, and foreground recovery loads xterm.js again if it failed and
  reattaches with `resume`. The screen has no Retry of its own.

The browser loads xterm.js 6.0.0 and its fit addon 0.11.0 from pinned jsDelivr
URLs the first time a terminal opens and does not ship them as assets. The
terminal fills the Detail body, which Task Workspace gives the full width as it
does for the code surfaces, recomputing rows and columns when that space
changes, draws in the Code typeface and size, and takes its background,
foreground, cursor, and selection colors from the theme. While a phone's or
tablet's on-screen keyboard is open, the terminal screen ends above it, so the
shell has fewer rows until the keyboard closes.
