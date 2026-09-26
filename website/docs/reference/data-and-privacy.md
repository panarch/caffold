# Data and privacy

Caffold runs on your Mac and keeps its data there. This page lists what
Caffold stores and everything that leaves the Mac because of Caffold.

## What stays on the Mac

Your repositories, the agents and their sign-ins, and the agents' conversations
stay on the Mac. Each agent keeps its own conversation history, and Caffold does
not keep a second copy.

Caffold's own data lives in `~/Library/Application Support/Caffold/data`:

- your Tasks and Sections, and the choices each Task was last run with;
- [Notes](../notes/index.md);
- the worktrees Caffold prepares, under `data/worktrees`;
- voice input settings, saved speech-to-text API keys, and the downloaded
  Whisper model;
- the Jev API key and rules;
- the browsers subscribed to notifications.

API keys are stored in files only your user account can read, and Caffold never
shows a saved key again.

Files you [attach to a prompt](../tasks/start-a-task.md#attach-files) are
uploaded into `.caffold/uploads/` in the Task's working directory, not into
Caffold's data.

Logs are in `~/Library/Logs/Caffold`. Appearance, Keyboard, and Files settings
are kept by each browser rather than on the Mac.

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
