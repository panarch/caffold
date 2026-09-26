# Uninstall

Remove the app and the `caffold` command with Homebrew:

```sh
brew uninstall --cask panarch/tap/caffold
```

This keeps Caffold's data, logs, and preferences, so reinstalling brings your
Tasks, Sections, and Notes back.

## Remove Caffold's data too

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

Neither command touches your repositories outside those worktrees, your agents,
or their conversation history. Each agent keeps its own conversations until
you remove them with that agent.
