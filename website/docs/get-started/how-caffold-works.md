# How Caffold works

Caffold runs on one computer, the *Caffold host*: the Mac or Linux machine that
has your coding agents, Git, and your repositories. You use it from a browser,
on the host or on your other devices.

```text
       browser or installed app
  (desktop, foldable, tablet, phone)
                   |
       local address or private
        Tailscale HTTPS address
                   |
       Caffold server on the host
                   |
  +----------+-----+----+----------+
  |          |          |          |
Codex   Claude Code   Grok    Antigravity
  |          |          |          |
  +----------+-----+----+----------+
                   |
      Git checkouts and worktrees
```

## One host does the work

On a Mac, **Caffold Server** is a menu-bar app that keeps the Caffold server
running; on Linux, the systemd user service `caffold.service` does. The agents
run on the host, their commands run there, and your repositories and
credentials stay there.

## Every screen is a window

The Caffold interface is a web app that the host serves:

- on the host itself, open `http://127.0.0.1:5178`;
- on another desktop, tablet, or phone, open the private HTTPS address that
  Tailscale provides. See [Use other devices](other-devices.md).

Every window shows the same Tasks, and closing one never stops the work: a turn
keeps running on the host. To use Caffold from another device, the host has to
stay awake and reachable, with Caffold running.

## A Task is one piece of work

A Task holds one agent conversation together with the directory it works in,
usually a Git repository. The model you choose when you start a Task also
chooses the agent — Codex, Claude Code, Grok, or Antigravity — and the Task stays with that
agent.

You write to the agent in the **Composer**, the prompt box at the bottom of the
Task. A **turn** is one stretch of the agent's work: it starts when you send a
prompt and ends when the agent answers.

## Ask the agent to make changes

Caffold shows you the conversation as it happens, brings you the agent's
approval requests, and keeps the files, the diff, and the Git history next to
the conversation. To change something, ask the agent in the Task, in your own
words.

| To | Say, for example |
| --- | --- |
| [Commit the changes](../review/changes.md#act-on-what-you-found) | "Commit these changes with a message that explains why." |
| [Move the Task into a worktree](../tasks/worktrees.md) | "Prepare this task in an isolated worktree." |
| [Keep something as a Note](../notes/index.md) | "Save what we decided about theme tokens as a Note." |
| [Work from a plan](../tasks/current-plan.md) | "Keep a current plan for this work." |
| [Rename the Task](../tasks/start-a-task.md#start-from-new-task) | "Rename this task to Dark theme." |

These work with every agent: Caffold gives each one tools and instructions for
worktrees, Notes, plans, and the Task's name. If the agent does not do what you
asked, ask again more specifically.

## Where to go next

- [Install Caffold](install.md) on the host.
- [Set up at least one agent](agents.md).
- [Run your first Task](first-task.md).

What Caffold does not do is listed in [Limits](../reference/limits.md).
