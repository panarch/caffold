# Data and privacy

Caffold runs on your Mac. This page explains where your data is stored, which
features send data to external services, and who can access Caffold.

## Where data is stored

Caffold's data folder is `~/Library/Application Support/Caffold/data`.

| Data | Where it is stored |
| --- | --- |
| **Caffold app data** — Tasks, Sections, [Notes](../notes/index.md), Task options, voice input settings and API keys, the Whisper model, Jev's key and rules, and notification subscriptions | Caffold's data folder. |
| **Conversation history and agent sign-ins** | Each agent's own local storage on the Mac. Caffold reads conversation history from the agent and does not save a second copy. |
| **Project files and [prompt attachments](../tasks/start-a-task.md#attach-files)** | The Task's working directory. Worktrees Caffold prepares are under `worktrees/` in its data folder; attachments are under `.caffold/uploads/` in the Task's working directory. |
| **Logs and diagnostic reports** — records used to investigate problems with Caffold | Logs: `~/Library/Logs/Caffold`. Reports saved when the server stops responding: `diagnostics/stalls/` in Caffold's data folder. |
| **Browser settings** — Appearance, Keyboard, and Files | Saved separately in each browser on each device. |

API keys are stored in files only your user account can read, and Caffold never
shows a saved key again.

## What leaves the Mac

Apart from your agents talking to their own services, something leaves the Mac
only in these cases:

- **Voice input** with OpenAI, Gemini, or Grok sends each recording from the
  Mac to that provider. See [Voice input](../voice-input.md#where-recordings-go).
- **Ask Jev first** sends each approval request an agent makes, and each
  prompt you send, to TypeSafe, with your Jev rules. See
  [Ask Jev first](../tasks/ask-jev-first.md#what-jev-sees).
- **Notifications** pass through your browser vendor's push service. The
  encrypted message carries only the Task's name and its status, never what
  the agent asked or wrote. See
  [Notifications](../get-started/notifications.md).
- **GitHub** views read Issues and Pull Requests through the GitHub CLI on the
  Mac.
- **Update checks**: the menu-bar app asks GitHub for the newest Caffold
  release, and **Settings → Codex** asks OpenAI for the newest Codex release
  when you open it.

## Who can use Caffold

Caffold has no sign-in of its own. It assumes one trusted person, one trusted
Mac, and a private network, and anyone who can open its address can use it.

By default the server listens only on the Mac.
[Tailscale](../get-started/other-devices.md) makes it reachable from your own
devices on your tailnet, and nowhere else. Do not expose Caffold to the public
internet.

To remove Caffold and its data, see [Uninstall](uninstall.md).
