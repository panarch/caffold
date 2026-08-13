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
tailscale serve --bg --yes --https=443 http://127.0.0.1:5177
```

Open the HTTPS MagicDNS address from a device on the same tailnet:

```text
https://<machine-name>.<tailnet-name>.ts.net/
```

Use `tailscale serve status` to inspect the mapping and disable this development
mapping when it is no longer needed:

```sh
tailscale serve --yes --https=443 off
```

Important boundaries:

- Tailscale Serve is tailnet-only. Do not use Tailscale Funnel for Caffold.
- Caffold stays bound to `127.0.0.1`; the browser receives a secure HTTPS origin
  through Tailscale.
- Tailscale HTTPS requires MagicDNS and HTTPS certificates for the tailnet.
- The service is not public, but the `machine.tailnet.ts.net` certificate name
  can appear in Certificate Transparency logs. Avoid sensitive machine names.
- Use isolated development data. Do not point a test server at the installed
  application's Redb directory.

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
