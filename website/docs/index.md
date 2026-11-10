---
template: home.html
title: One workspace for your coding agents, on every screen.
description: Run Codex, Claude Code, Grok, and Antigravity on your own Mac or Linux machine. Start Tasks, follow their work, and keep going from a desktop, foldable, tablet, or phone.
hide:
  - navigation
  - toc
  - path
  - footer
---

<section class="cf-hero" markdown>

<div class="cf-intro" markdown>

<p class="cf-eyebrow">Caffold · self-hosted on your Mac or Linux machine</p>

# One workspace for your coding agents, on every screen.

<p class="cf-lede">Run Codex, Claude Code, Grok, and Antigravity on your own Mac or Linux machine.
Start Tasks, follow their work, and send the next instruction from a desktop,
foldable, tablet, or phone.</p>

<div class="cf-actions" markdown>
[Get started](get-started/install.md){ .cf-button .cf-button--primary }
[GitHub](https://github.com/panarch/caffold){ .cf-button }
</div>

```sh
# macOS
brew install --cask panarch/tap/caffold
```

```sh
# Linux
curl -fsSL https://caffold.dev/install.sh | sh
```

<p class="cf-requirements">Apple silicon · macOS 14+ · Linux x86_64 and aarch64 · Apache 2.0</p>

</div>

<div class="cf-preview" markdown>

<figure markdown>
![A Task on a foldable: the agent's answer, the completed plan, and a draft asking for a live theme preview](assets/screenshots/landing-task-light-foldable.png#only-light)
![The same Task on a foldable in dark mode](assets/screenshots/landing-task-dark-foldable.png#only-dark)
</figure>

<figure markdown>
![The same Task and next instruction on a phone](assets/screenshots/landing-task-light-phone.png#only-light)
![The same Task and next instruction on a phone in dark mode](assets/screenshots/landing-task-dark-phone.png#only-dark)
</figure>

<p class="cf-caption">The same Task, ready for the next instruction. Foldable and phone.</p>

</div>

</section>

<section class="cf-experience" markdown>

## Your own machine does the work. Every screen opens it.

<div class="cf-experience-grid" markdown>

<div markdown>

### Your environment, your data

Run agents beside your repositories and credentials on your own machine.
Caffold stores its data there; each agent keeps its own history.
[Where data goes](reference/data-and-privacy.md).

</div>

<div markdown>

### Pick up where you left off

Open the same Tasks through your private [Tailscale address](get-started/other-devices.md).
Work keeps running when you close the window.

</div>

<div markdown>

### Keyboard, touch, or voice

Use the [keyboard](keyboard.md), tap the same controls, or
[dictate your next prompt](voice-input.md).

</div>

</div>

</section>

<section class="cf-showcase" aria-labelledby="cf-showcase-heading" markdown>

<h2 id="cf-showcase-heading">A closer look at your workspace</h2>

<fieldset class="cf-tour" markdown>
<legend class="cf-visually-hidden">Choose a feature to explore</legend>
<div class="cf-tour-choices">
<input class="cf-visually-hidden" type="radio" name="cf-tour" id="cf-tour-work" value="work" checked>
<label for="cf-tour-work">
<span class="cf-tour-title">Work with the agent</span>
<span class="cf-tour-hint">Follow the work. Shape the next step.</span>
</label>
<input class="cf-visually-hidden" type="radio" name="cf-tour" id="cf-tour-changes" value="changes">
<label for="cf-tour-changes">
<span class="cf-tour-title">See what changed</span>
<span class="cf-tour-hint">From the conversation to the code.</span>
</label>
<input class="cf-visually-hidden" type="radio" name="cf-tour" id="cf-tour-tasks" value="tasks">
<label for="cf-tour-tasks">
<span class="cf-tour-title">Move between Tasks</span>
<span class="cf-tour-hint">Keep several threads of work in reach.</span>
</label>
<input class="cf-visually-hidden" type="radio" name="cf-tour" id="cf-tour-notes" value="notes">
<label for="cf-tour-notes">
<span class="cf-tour-title">Carry context forward</span>
<span class="cf-tour-hint">Give decisions a place to live.</span>
</label>
</div>
<div class="cf-tour-scenes" markdown>
<figure class="cf-tour-scene" data-scene="work" aria-label="Work with the agent" markdown>
<div class="cf-tour-media">
<picture>
<source media="(max-width: 599px)" srcset="assets/screenshots/landing-work-light-phone.png" width="390" height="844">
<img src="assets/screenshots/landing-work-light-desktop.png#only-light" width="960" height="640" loading="lazy" alt="An agent fixes a checkout test while the person adds a request to test WebKit too">
</picture>
<picture>
<source media="(max-width: 599px)" srcset="assets/screenshots/landing-work-dark-phone.png" width="390" height="844">
<img src="assets/screenshots/landing-work-dark-desktop.png#only-dark" width="960" height="640" loading="lazy" alt="An agent fixes a checkout test while the person adds a request to test WebKit too, in dark mode">
</picture>
</div>
<figcaption markdown>

Follow the work as it happens. Send another instruction into a running Codex,
Claude Code, Grok, or Antigravity turn.

[Inside a Task](tasks/conversation.md)

</figcaption>
</figure>

<figure class="cf-tour-scene" data-scene="changes" aria-label="See what changed" markdown>
<div class="cf-tour-media">
<picture>
<source media="(max-width: 599px)" srcset="assets/screenshots/landing-changes-light-phone.png" width="390" height="844">
<img src="assets/screenshots/landing-changes-light-desktop.png#only-light" width="960" height="640" loading="lazy" alt="The SettingsPage diff in a Task’s Working Tree">
</picture>
<picture>
<source media="(max-width: 599px)" srcset="assets/screenshots/landing-changes-dark-phone.png" width="390" height="844">
<img src="assets/screenshots/landing-changes-dark-desktop.png#only-dark" width="960" height="640" loading="lazy" alt="The SettingsPage diff in a Task’s Working Tree in dark mode">
</picture>
</div>
<figcaption markdown>

Open the Working Tree to inspect the files your Task changed, or review the whole branch.

[Explore changes](review/changes.md)

</figcaption>
</figure>

<figure class="cf-tour-scene" data-scene="tasks" aria-label="Move between Tasks" markdown>
<div class="cf-tour-media">
<picture>
<source media="(max-width: 599px)" srcset="assets/screenshots/landing-tasks-light-phone.png" width="390" height="844">
<img src="assets/screenshots/landing-tasks-light-desktop.png#only-light" width="960" height="640" loading="lazy" alt="The Task Switcher lists work across the Lumen app, API, and launch notes">
</picture>
<picture>
<source media="(max-width: 599px)" srcset="assets/screenshots/landing-tasks-dark-phone.png" width="390" height="844">
<img src="assets/screenshots/landing-tasks-dark-desktop.png#only-dark" width="960" height="640" loading="lazy" alt="The Task Switcher lists work across the Lumen app, API, and launch notes in dark mode">
</picture>
</div>
<figcaption markdown>

Jump to another Task with its conversation and working directory intact. Press T to open the Task Switcher.

[Organize your workspace](tasks/sections.md)

</figcaption>
</figure>

<figure class="cf-tour-scene" data-scene="notes" aria-label="Carry context forward" markdown>
<div class="cf-tour-media">
<picture>
<source media="(max-width: 599px)" srcset="assets/screenshots/landing-notes-light-phone.png" width="390" height="844">
<img src="assets/screenshots/landing-notes-light-desktop.png#only-light" width="960" height="640" loading="lazy" alt="Theme decisions in Notes, with the organized folder tree alongside on a wide screen">
</picture>
<picture>
<source media="(max-width: 599px)" srcset="assets/screenshots/landing-notes-dark-phone.png" width="390" height="844">
<img src="assets/screenshots/landing-notes-dark-desktop.png#only-dark" width="960" height="640" loading="lazy" alt="Theme decisions in Notes, with the organized folder tree alongside on a wide screen in dark mode">
</picture>
</div>
<figcaption markdown>

Ask agents to organize decisions and references in Notes that other Tasks can use.
Browse the folders and open a document to read it.

[Work with Notes](notes/index.md)

</figcaption>
</figure>
</div>
</fieldset>

</section>

<section class="cf-features" markdown>

## More ways to make it yours

<div class="cf-feature-grid" markdown>

<section markdown>

### Your agents, your settings

Use your installed CLIs with their own [sign-in, models, and approval modes](get-started/agents.md).
[Continue a Task's work with another agent](tasks/worktrees.md#continue-with-another-agent)
in the same worktree.

</section>

<section markdown>

### Context for the next step

[Attach files and screenshots](tasks/start-a-task.md#attach-files) by choosing,
pasting, or dropping them. Follow progress in a [Plan and Checklist](tasks/current-plan.md).

</section>

<section markdown>

### Control as work happens

[Steer a running turn or stop it](tasks/steer-and-stop.md).
Let [Ask Jev first](tasks/ask-jev-first.md) handle routine approvals under your rules,
and [get notified](get-started/notifications.md) when attention is needed.

</section>

<section markdown>

### Git and GitHub in reach

[Compare refs and browse commits](review/git.md), read
[Issues and Pull Requests](review/github.md), or start a Task from one.

</section>

<section markdown>

### Room for parallel work

Use [worktrees](tasks/worktrees.md) for separate changes,
[fork a conversation](tasks/fork.md) to try another direction, and
[archive finished Tasks](tasks/archive-and-delete.md).

</section>

<section markdown>

### A shell in your workspace

Open a [terminal](tasks/terminal.md) for a Task or Section.
It runs on your machine and stays available from the same workspace.

</section>

</div>

</section>

<div class="cf-closing" markdown>

**Start with one Task.** [Install Caffold](get-started/install.md),
[connect your agents](get-started/agents.md), and [give it some work](get-started/first-task.md).
Or read [how Caffold works](get-started/how-caffold-works.md).

</div>
