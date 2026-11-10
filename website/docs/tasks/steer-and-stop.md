# Steer and stop

## Steer a running turn

Codex, Claude Code, Grok, and Antigravity accept more instructions while a turn
runs. Antigravity takes them except while a permission request is waiting:
answer it or stop the turn first.

![A running turn with a prompt sent into it, and the Stop button in the Composer](../assets/screenshots/running-turn-light-desktop.png#only-light)
![A running turn with a prompt sent into it, and the Stop button in the Composer](../assets/screenshots/running-turn-dark-desktop.png#only-dark)

## Stop a turn

While a turn runs and the Composer is empty, the send button becomes
**Stop current turn**. The next input stays disabled while stopping.
Stopping keeps everything the agent already did.

When the agent confirms that prompts were canceled before it took them in,
they return to the Composer in the order you sent them, ahead of anything you
were typing, so you can send them again or discard them. Their **Attached files**
lists still name the files already uploaded; pictures are not attached again.
