# Application Update Testing

`caffold update` is covered by Rust tests with a stand-in for Homebrew and the
app, and the menu-bar app by `desktop/macos/test-updater`. Neither shows what
the real Homebrew, LaunchServices, and app do. Run these checks on a Mac with
Caffold installed through Homebrew when a change touches how the procedure
calls Homebrew or replaces, starts, or restores the app.

The checks replace the installed app and edit this Mac's copy of the
`panarch/tap` tap. Running Tasks keep going, as in any update; open terminals
close.

## Prepare

Homebrew installs whatever `Casks/caffold.rb` in the local tap names, so the
checks point it at locally built archives instead of a published release. The
browser offers an update only when the running app is older than the newest
GitHub release, so the app installed first carries a lower version than that
release, and the archives carry the release's version.

1. Refresh Homebrew once, so the edits below sit on the tap's newest commit.
   `caffold update` runs `brew update` before it upgrades, and Homebrew leaves
   an edited tap alone while the tap on GitHub has nothing newer, so run the
   checks while no Caffold release is being published:

   ```sh
   brew update
   ```

2. Build the working archive. Set the newest release's version, `NEXT`, in
   `caffold/Cargo.toml`, `frontend/package.json`, and the `caffold` entry of
   `Cargo.lock`, then package it and keep a copy:

   ```sh
   desktop/macos/package-app archive
   mkdir -p /tmp/caffold-update-test
   cp target/caffold-server/Caffold-Server-NEXT-macos-arm64.zip /tmp/caffold-update-test/working.zip
   ```

3. Build an archive whose server never starts, from the same app:

   ```sh
   rm -rf /tmp/caffold-update-test/broken
   ditto "target/caffold-server/Caffold Server.app" "/tmp/caffold-update-test/broken/Caffold Server.app"
   printf '#!/bin/sh\nexit 1\n' > "/tmp/caffold-update-test/broken/Caffold Server.app/Contents/Resources/caffold"
   chmod +x "/tmp/caffold-update-test/broken/Caffold Server.app/Contents/Resources/caffold"
   codesign --force --deep --sign - "/tmp/caffold-update-test/broken/Caffold Server.app"
   ditto -c -k --sequesterRsrc --keepParent "/tmp/caffold-update-test/broken/Caffold Server.app" /tmp/caffold-update-test/broken.zip
   ```

4. Set a version lower than `NEXT` in the same three files and install it as
   the current app, with every `CLAUDE*` and `CAFFOLD*` variable unset, then
   put the version files back:

   ```sh
   desktop/macos/install-local
   git checkout -- caffold/Cargo.toml frontend/package.json Cargo.lock
   ```

5. Point the tap at an archive. Each scenario names which one:

   ```sh
   tap="$(brew --repository panarch/tap)/Casks/caffold.rb"
   archive=/tmp/caffold-update-test/working.zip
   sed -i '' \
     -e "s|^  version .*|  version \"NEXT\"|" \
     -e "s|^  sha256 .*|  sha256 \"$(shasum -a 256 "$archive" | awk '{print $1}')\"|" \
     -e "s|^  url .*|  url \"file://$archive\"|" \
     "$tap"
   brew trust --cask panarch/tap/caffold
   ```

   `brew outdated --cask --verbose caffold` then names `NEXT`.

## Update from another device

Point the tap at `working.zip`. On a phone connected over Tailscale:

1. Verify that **Settings** and **About Caffold** carry the green dot and that
   **Updates** says `NEXT` is available.
2. Choose **Update Caffold**. In the dialog, choose any model with the mode
   that allows everything, **Full access** or **Allow all**, then **Start
   Update**. Verify that the Task opens in the `caffold-updates` Section and
   names itself **Update Caffold to NEXT**.
3. Wait for Caffold to come back. Verify that the Task reports the result,
   that **Updates** shows `NEXT` with **Last update** reading **Updated to
   NEXT**, that the dot is gone, and that the Mac shows no alert.
4. Verify that the new server did not inherit the agent's environment:

   ```sh
   ps eww -o command= -p "$(lsof -tiTCP:5178 -sTCP:LISTEN)" | tr ' ' '\n' | grep -E '^(CLAUDE|CAFFOLD)'
   ```

   It prints nothing.

## Roll back from the menu bar

Install the lower version again with step 4 of Prepare, and point the tap at
`broken.zip`. Homebrew now records `NEXT`, ahead of the app.

1. Choose **Update to Caffold NEXT…** in the menu-bar app and confirm.
2. Verify that the alert **Caffold update was rolled back** appears once the
   previous version is serving again, and that **Show Records** opens
   `~/Library/Application Support/Caffold/data/caffold-updates`.
3. Verify that the latest attempt's `log.txt` shows `brew reinstall`, and that
   its `failed/` holds the broken app.
4. Open Caffold in a browser. Verify that the **Caffold update was rolled back**
   dialog appears once, and not again after a reload, and that **Last update**
   reads **Rolled back to** the lower version **— NEXT could not start**.

## Clean up

```sh
git -C "$(brew --repository panarch/tap)" checkout -- Casks/caffold.rb
desktop/macos/install-local
```
