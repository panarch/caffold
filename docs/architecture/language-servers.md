# Language Servers

Integrated Review's Source and Diff can ask a language server where a name is
defined and where it is used. Caffold finds a server already installed on the
host, runs one per repository and language the person turned on, and asks it
over the Language Server Protocol. It never downloads, installs, or updates a
server; Task details offers to hand the install to an agent in a new Task on
the host.

Everything is off until the person turns it on, twice: a language in Settings,
then language servers for a repository in Task details. A repository is a Git
repository's root, or a folder outside Git.

## Languages

`caffold/src/language_servers/languages.rs` holds, for each language, its
server, the files that mark its projects, the commands that install it and
check that it runs, the configuration it starts with, and how it shows it is
ready. One table there
maps each source file extension to its language and its LSP language id; the
repository status sends each server's extensions, so the browser decides which
files have pressable names from the same table.

| Language | Server | Projects | Ready when |
| --- | --- | --- | --- |
| Rust | `rust-analyzer` | `Cargo.toml` | `experimental/serverStatus` reports `quiescent` |
| TypeScript/JavaScript | `typescript-language-server --stdio` | `tsconfig.json`, `jsconfig.json`, `package.json` | `initialize` answers |

rust-analyzer starts with `cargo.targetDir: true`, so it builds in its own
`target/rust-analyzer` instead of contending with the agent's builds,
`checkOnSave: false`, and `files.watcher: "server"`, so it watches the files
itself.

## Finding a server

A repository's projects are its root and its direct child folders that hold a
project file. Caffold runs the server's `--version` in each project folder:
rust-analyzer from `PATH`, which rustup resolves to the project's toolchain;
typescript-language-server from the project's `node_modules/.bin`, then
`PATH`. A server that does not run fails by which check failed, never by what
a tool printed, which is only passed on:

| Check that failed | Failure |
| --- | --- |
| No program found, or for Rust, `rustup which rust-analyzer` exits non-zero after `--version` failed | `notInstalled`, with the toolchain for Rust |
| `--version` otherwise, or starting the server | `couldNotStart`, with what it printed |
| The running server exited | `stopped`; its output is not kept |

The toolchain is the first word of `rustup show active-toolchain` in the
project folder. A `notInstalled` failure carries the commands that install the
server and check that it runs. For Rust they name the toolchain, `rustup
component add rust-analyzer rust-src --toolchain <toolchain>` and `rustup run
<toolchain> rust-analyzer --version`, so they reach the repository's toolchain
from any folder; for TypeScript they are `npm install --global
typescript-language-server typescript` and `typescript-language-server
--version`. Settings finds nothing: it only turns languages on and off.

## Lifetime

`caffold/src/language_servers/supervisor.rs` owns every server's node and is
the only place one changes; its module comment lists the nodes and edges. A
server that is off has no entry. Each started process carries a generation,
and an event from an older process is refused.

- Turning a repository on starts its servers, and a server is ready only after
  it finished indexing.
- A repository counts as shown while a [Filesystem Watch](live-updates.md#filesystem-watch)
  scope at or beneath its folder is open. Two hours after the last such scope
  closes, its servers sleep: their processes end. Opening one again starts
  them.
- Turning a repository or its language off ends its servers at once. When a
  repository's folder is gone once its scopes close, as after archiving the
  Task that owned a managed worktree, its servers end and the repository leaves
  the settings. A repository several Tasks share sleeps like any other.
- Caffold's restart leaves every turned-on server asleep; showing the
  repository wakes it.
- A failed server stays failed until a screen showing the repository asks
  `POST /api/language-servers/repository/check`: Task details as its popover
  opens, and Integrated Review as it shows the repository. Caffold looks for
  each failed server again outside the supervisor and answers only once that
  is known: a server found starts, so one installed meanwhile gets ready, and
  one still missing stays failed with what the finding said, never shown
  starting for a moment. A server started so while no screen shows the
  repository sleeps after the usual two hours.
- There is no cap on how many run.

The turned-on languages and repositories are in the data directory's
`language-servers/settings.json`, written to a temporary file and renamed.
Running state lives only in backend memory.

## Asking

The browser sends a file's logical path, its one-based line, and the name's
zero-based UTF-16 offset, LSP's own unit. Caffold opens the file as it is on
disk in the server, since the viewer shows the working tree, and asks
`textDocument/definition`, or `textDocument/references` with the declaration
included, so the list shows where the name is made too. Each answer place comes
back with its logical path, line, offset, the name's length when it ends on its
line, and the line's text, at most 400 characters. A place outside the
browsing root carries only its file name.

Memory is the resident size of the server's own process: `ps -o rss=` on
macOS, `VmRSS` in `/proc/<pid>/status` on Linux.

## HTTP routes

| Route | Use |
| --- | --- |
| `GET /api/language-servers` | Each language: its server's name, and on or off |
| `PATCH /api/language-servers/settings` | The full set of languages turned on |
| `GET /api/language-servers/running` | Every server that has an entry, with its memory, and the total |
| `GET /api/language-servers/repository?path=` | One repository: on or off, and each of its servers |
| `PUT /api/language-servers/repository` | Turn a repository on or off |
| `POST /api/language-servers/repository/check` | Look for a repository's failed servers again, then answer it as `GET` does |
| `POST /api/language-servers/definition`, `/references` | The places for a name |

`PATCH`, `PUT`, and the check start or end processes, so they require an
`Origin` that matches the request's `Host`. The browser announces a successful change with a
`caffold:language-servers-changed` window event, which Integrated Review
answers by reading its repository's status again.

## Browser

[Frontend Architecture](frontend.md#names-in-code) owns the name menu, the
places list, and `G`. Task details reads its repository once before its
popover opens, so its row and switch are there for a keyboard session
that opens it, then again as it opens, looking again for failed servers, and
every second while a server is starting. Its section has one line per language, which says which check
failed and, below it, what a server that could not start printed. One button
hands every `notInstalled` server to an agent: the install dialog lists each
with the toolchain it goes into and its install command, and starts a Task in
the home folder the way Start Task would, whichever repository asked, so it
never shares that repository's worktree. **Settings → Language Servers** reads
the languages when it is shown and the running servers every three seconds
while it is shown.
