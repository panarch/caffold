# Uninstall

## On a Mac

Remove the app and the `caffold` command with Homebrew:

```sh
brew uninstall --cask panarch/tap/caffold
```

This keeps Caffold's data, logs, and preferences, so reinstalling brings your
Tasks, Sections, and Notes back.

### Remove Caffold's data too

Homebrew's `--zap` option also deletes:

- `~/Library/Application Support/Caffold`, which holds your Tasks, Sections,
  Notes, settings, saved API keys, the Whisper model, and the worktrees Caffold
  prepared;
- `~/Library/Logs/Caffold`;
- Caffold Server's preferences.

Notes cannot be recovered afterward, and uncommitted changes in a Caffold
worktree are deleted with it. Commit or copy anything you need from those
worktrees first, then run:

```sh
brew uninstall --zap --cask panarch/tap/caffold
```

## On Linux

Stop the service and remove Caffold and the `caffold` command:

```sh
systemctl --user disable --now caffold
rm -f ~/.config/systemd/user/caffold.service
rm -f ~/.local/bin/caffold
rm -rf ~/.local/share/caffold
```

This keeps Caffold's data in `~/.caffold`, so reinstalling brings your Tasks,
Sections, and Notes back.

The install script also turned on lingering, so your user services keep
running after you log out, and Tailscale Serve, if Tailscale was installed. To
turn them off as well:

```sh
loginctl disable-linger
tailscale serve --https=443 off
```

### Remove Caffold's data too

`~/.caffold` holds your Tasks, Sections, Notes, settings, saved API keys, the
Whisper model, and the worktrees Caffold prepared. Notes cannot be recovered
afterward, and uncommitted changes in a Caffold worktree are deleted with it.
Commit or copy anything you need from those worktrees first, then run:

```sh
rm -rf ~/.caffold
```

## What stays

None of these commands touches your repositories outside Caffold's worktrees,
your agents, or their conversation history. Each agent keeps its own
conversations until you remove them with that agent.
