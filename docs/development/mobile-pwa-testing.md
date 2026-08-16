# Mobile and PWA Testing

Keep Caffold bound to the trusted host. For phone and installability testing
over Tailscale, expose the local HTTP server through tailnet-only HTTPS Serve
instead of opening a raw Tailscale IP over HTTP.

Start an isolated development server:

```sh
cargo run -- serve \
  --host 127.0.0.1 \
  --port 5177 \
  --root "$PWD" \
  --data-dir "$PWD/.caffold-dev" \
  --worktree-root "$PWD/.caffold-dev/worktrees"
```

Then configure Tailscale Serve:

```sh
cargo run -- tailscale enable --target http://127.0.0.1:5177
```

Open the HTTPS MagicDNS address from a device on the same tailnet:

```text
https://<machine-name>.<tailnet-name>.ts.net/
```

Use Caffold's adapter to inspect the mapping and disable this development
mapping when it is no longer needed:

```sh
cargo run -- tailscale status --target http://127.0.0.1:5177
cargo run -- tailscale disable --target http://127.0.0.1:5177
```

The adapter changes or disables the mapping only when this exact target is its
exclusive HTTPS handler. Another target or a shared handler set stops with a
conflict instead of being overwritten.

Important boundaries:

- Tailscale Serve is tailnet-only. Do not use Tailscale Funnel for Caffold.
- Caffold stays bound to `127.0.0.1`; the browser receives a secure HTTPS origin
  through Tailscale.
- Tailscale HTTPS requires MagicDNS and HTTPS certificates for the tailnet.
- The service is not public, but the `machine.tailnet.ts.net` certificate name
  can appear in Certificate Transparency logs. Avoid sensitive machine names.
- Use isolated development data. Do not point a test server at the installed
  application's Redb directory.

## Android installed-PWA foreground recovery smoke tests

Use an installed Android PWA connected to the isolated HTTPS origin. Keep a
second browser client available so Task state can change while the installed
PWA is backgrounded.

### Ordinary foreground return

1. Open a managed Task detail in the installed PWA. Leave a recognizable
   Composer draft, scroll the conversation away from its initial position, and
   select a review file when the Task has review content.
2. Switch to another Android application without closing Caffold. From the
   second client, rename or reorder the managed Task and advance its active
   turn so both the Caffold navigator ledger and Codex runtime projection
   change.
3. Return through the Android recent-apps screen. Without tapping Retry or any
   Caffold control, verify that readiness is current, the renamed/reordered list
   appears, and the Task status, final response, list transport, and detail
   transport reconcile.
4. Verify that the selected route, Composer draft, conversation scroll, and
   selected review state remain useful. A transient reconnecting notice must
   not clear the loaded list or detail.

### Offline and online

1. Keep the loaded Task visible and enable Android airplane mode.
2. Verify that one viewport-level **No network connection** notice appears
   without a spinner or Retry and that the loaded list, detail, and Composer
   draft remain useful. The browser may report definite offline state
   immediately or after one canonical request confirms the network failure.
3. Disable airplane mode. Without tapping Retry or another Caffold control,
   verify that one automatic recovery reconciles status, list, and detail and
   then removes the notice.

### Notification focus

1. Background an existing Task client and complete its active turn from the
   second client.
2. Tap the system notification for that same Task.
3. Verify that Android focuses the existing client, keeps or applies the
   matching Task route, and reconciles status, list, and the final response
   without another click or duplicate navigation.

### Fresh document reconstruction

When Android discards the PWA process, reopen the previous Task route and
verify that normal bootstrap reconstructs readiness, list, selected detail, and
transports. A discarded document has no callback and must not depend on the
foreground recovery state retained by the previous page.

## Android installed-PWA update handoff smoke test

1. Keep installed Caffold build A open, replace the server with build B, and
   wait for **Update ready** with **Prepared update: Ready** in About Caffold.
2. Tap **Reload to update**. Verify that About Caffold reports UI build B and
   that the update dialog closes.
3. Repeat from build A while preventing or interrupting the first navigation.
   Verify that **Reload to update** remains available in About Caffold, then tap
   it again and confirm that the document reaches build B.
4. Repeat once more, terminate the installed PWA after the failed navigation,
   and reopen it. If build A is restored, verify that update readiness is
   reconstructed and that tapping **Reload to update** reaches build B.
5. If any step stalls, copy About diagnostics before replacing the server app.
   Record the handoff node, target, controller, active and waiting build IDs,
   and navigation-attempt count with the Android and Chrome versions.

## Web Push smoke test

Use the HTTPS PWA origin above because remote browsers require a secure context
for Service Worker and Push APIs. Confirm that the host can make outbound HTTPS
requests and that notifications are enabled for the browser in the device's
system settings.

1. Use a fresh browser installation, or explicitly Disable a previous
   subscription. Open **Settings → Notifications** and verify the disabled
   state. On iOS, add Caffold to the Home Screen before continuing.
2. Select **Enable** and accept the browser permission prompt if permission has
   not already been granted. Verify that the page shows **Subscribed**, marks the
   row as **This browser**, and displays a stable short installation ID.
3. Complete, fail, or interrupt a managed task turn. Verify that the
   notification contains only the task name and terminal status. Repeat while
   Caffold is foregrounded; the notification should still appear.
4. Start another managed turn, close the PWA before the turn finishes, and keep
   the backend running. Verify that the notification still arrives and clicking
   it opens the matching `/tasks/<thread-id>` route.
5. Restart the Caffold backend, reopen Notifications, and verify that the same
   installation and subscription remain active.
6. Subscribe another browser, remove it from the first browser's installation
   list, then open Notifications on the removed browser. It should reconcile to
   Disabled and unsubscribe locally rather than silently registering again.
7. Select **Disable** on the current browser and verify that its active row is
   removed. Reopening Notifications must remain Disabled until another explicit
   Enable action.

Provider delivery is best-effort. A turn completed while the backend is stopped
is intentionally not caught up after restart.
