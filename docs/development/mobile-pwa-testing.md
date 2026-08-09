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
