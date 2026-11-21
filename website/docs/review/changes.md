# Review changes

Next to its conversation, a Task shows the actual files and diff of the
repository it works in, so you can judge the result yourself.

![Working Tree showing a Task's changed files and the diff of one of them](../assets/screenshots/review-working-tree-light-desktop.png#only-light)
![Working Tree showing a Task's changed files and the diff of one of them](../assets/screenshots/review-working-tree-dark-desktop.png#only-dark)

## Open it

In a Task, choose **Working Tree** or **Branch** next to **Conversation**. A
[Section](../tasks/sections.md) of a repository offers the same view without a
Task.

- **Working Tree** shows the changes since the last commit: staged, unstaged,
  and untracked. A file's diff shows them together; the **Staged** and
  **Unstaged** groups say how the file is staged.
- **Branch** shows everything the current branch changes since it left a base
  branch you choose, including changes not committed yet and new files.

The view follows the files as they change, so you can keep it open while the
agent works.

## Find a file

The left side lists either:

- **Changes**, the changed files grouped by folder, each marked with its kind
  of change; or
- **Files**, the whole repository, to read any file.

**Settings → Files** chooses whether folders come before files in these trees.

On a foldable or a tablet held upright, the list folds into a strip on the left
edge; tap it to open the list over the file, and choosing a file closes it.

## Read a file

The right side shows the selected file in one of these ways, as the file
allows:

- **Diff**, the unified diff of the change;
- **Visual**, for images, the picture before and after the change: **Side by
  side** shows both with their size, and **Difference** paints the pixels that
  changed in red;
- **Source**, the whole file as text, with what Working Tree or Branch changed
  marked beside the line numbers: a green number for an added line and a red
  line where lines were removed;
- **Preview**, for Markdown, images, PDF files, Word documents (`.docx`),
  PowerPoint decks (`.pptx`), Excel workbooks (`.xlsx`, `.xlsm`), and Hangul
  documents (`.hwp`, `.hwpx`).

In **Source** and **Preview**, **Show details** at the top right of the file
has **Download**, which saves the file to your device, including a large or
binary file that Caffold cannot show.

For images and PDF, Word, PowerPoint, and Hangul documents, **Zoom** at the top
right of the file fits the preview to the width or the page, or makes it larger
or smaller.

On a phone, the file list and the file take turns on the screen; **Back**
returns from the file to the list.

## Go to a definition

Caffold can ask a language server where a name in your code is defined and
where it is used: a function, a type, a variable, or a constant. It works in
**Source** and on the new side of **Diff**, for Rust with rust-analyzer and
for TypeScript/JavaScript with typescript-language-server, using the server
already installed on the host. Names in a commit, in Compare, or in a Pull
Request can't be looked up, because a language server reads only the files
as they are now.

### Turn it on

Language servers are off until you turn them on, once for each language and
once for each repository.

First, in [**Settings → Language Servers**](../reference/settings.md#language-servers),
turn on the language.

![Settings → Language Servers with TypeScript/JavaScript on and its server running](../assets/screenshots/settings-language-servers-light-desktop.png#only-light)
![Settings → Language Servers with TypeScript/JavaScript on and its server running](../assets/screenshots/settings-language-servers-dark-desktop.png#only-dark)

Then, in a Task in that repository, open the Task's details and turn on
**Language servers**. The server first reads the whole repository; the
details show its progress, then that it is ready and how much memory it uses.

![Task details with the Language servers switch](../assets/screenshots/task-details-language-servers-light-desktop.png#only-light)
![Task details with the Language servers switch](../assets/screenshots/task-details-language-servers-dark-desktop.png#only-dark)

If a server isn't installed, the details say so: for Rust, in the toolchain
the repository uses, since each toolchain has its own rust-analyzer. **Ask an
agent to install** starts a Task in your home folder that installs it on the
host, into that toolchain, and checks that it runs; other repositories on the
same toolchain can use it too. When servers are missing for more than one
language, one button installs them all. Once the install has finished, open
the details again, or open the repository in Review: Caffold looks for the
server again and starts it. A server that is installed but could not start
shows what it printed.

![Task details saying typescript-language-server is not installed, with Ask an agent to install](../assets/screenshots/task-details-language-servers-not-installed-light-desktop.png#only-light)
![Task details saying typescript-language-server is not installed, with Ask an agent to install](../assets/screenshots/task-details-language-servers-not-installed-dark-desktop.png#only-dark)

### Look up a name

Click or tap a name to open its menu.

![The menu of a name in a diff, with Go to definition and Find references](../assets/screenshots/review-name-menu-light-desktop.png#only-light)
![The menu of a name in a diff, with Go to definition and Find references](../assets/screenshots/review-name-menu-dark-desktop.png#only-dark)

- **Go to definition** opens the file that defines the name, at that line,
  even a file outside the repository, such as one in your toolchain. A name
  with several definitions lists them the way Find references does.
- **Find references** lists where the name is declared and every place it is
  used, grouped by file, in place of the file list. Choose a line to open it;
  **×** brings the file list back.

![The references of useThemePreference in place of the file list, beside the diff](../assets/screenshots/review-references-light-desktop.png#only-light)
![The references of useThemePreference in place of the file list, beside the diff](../assets/screenshots/review-references-dark-desktop.png#only-dark)

Hold <kbd>⌘</kbd> or <kbd>Ctrl</kbd> as you click a name to go straight to its
definition. From the keyboard, press <kbd>G</kbd> to put codes on the names in
view; see [Keyboard navigation](../keyboard.md#go-to-a-definition-g).

While the server is still reading the code, the menu says **Getting ready**
and waits.

### While you are away

rust-analyzer builds in the repository's `target/rust-analyzer`, apart from
your own builds. Two hours after you last viewed a repository, its servers
sleep to free memory; they start again when you open it. **Settings →
Language Servers** lists the servers that are running, with their memory, and
turns one off.

## Act on what you found

Go back to **Conversation** and tell the agent what comes next: a fix for what
you found, or a commit. For example:

```{ .text .cf-prompt }
Commit these changes with a message that explains why.
```

To compare any two refs or read the commit history, see [Git](git.md).
