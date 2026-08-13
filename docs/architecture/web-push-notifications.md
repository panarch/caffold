# Web Push Notifications

Caffold can send a best-effort system notification when a managed task's
canonical active turn becomes `completed`, `failed`, or `interrupted`.
Notifications are disabled by default. The browser asks for permission only in
response to the user's explicit **Enable** action in **Settings →
Notifications**.

## Subscription lifecycle

Each browser installation generates a random UUID and stores it in
`localStorage` under `caffold:push-client-id`. The ID is not a credential. It
lets the backend idempotently replace that installation's endpoint and lets the
Settings page distinguish otherwise similar browsers with a short ID fragment.

Opening the Notifications setting reconciles the current browser
`PushSubscription` with the backend:

- an unknown installation with a live browser subscription is registered;
- an active server registration with no browser subscription is revoked;
- a server-side revocation tombstone causes any surviving browser subscription
  to be unsubscribed and is never silently cleared;
- only a later explicit Enable action creates a subscription and clears the
  tombstone.

The page represents unsupported, install-required on platforms where Web Push
requires an installed PWA, denied, permission-granted-but-not-subscribed,
syncing, subscribed, and disabled states. It also lists every active browser
installation. Removing an installation remotely writes the same revocation
tombstone as Disable.

## Persisted state

The existing `caffold.redb` database owns the Web Push state. Schema v4 adds:

- `push_installations`, containing the client ID, generated installation label,
  endpoint, `p256dh`, `auth`, optional expiration, timestamps, and either active
  subscription material or a revocation timestamp;
- `push_vapid_keys`, containing the server's singleton VAPID private key and
  creation time.

The VAPID keypair is generated once. The backend derives and exposes the public
application-server key through `GET /api/push/config`; the private key is never
placed in repository assets, frontend assets, API responses, or application
logs. Installation-list responses omit the endpoint and key material, and
delivery diagnostics never log endpoints or subscription keys.

Subscription mutation endpoints accept bounded JSON and require an `Origin`
that matches the request `Host`. Endpoints must be credential-free HTTPS URLs,
client IDs must be UUIDs, labels and endpoints are length-bounded, and the
decoded Push keys are structurally validated. This remains within Caffold's
trusted-host deployment boundary; it is not a general account or authorization
system.

## Delivery path

The Codex notification bridge observes the existing canonical
`turn/completed` notification. While applying that notification under the
session lock, the session reports whether it is the first terminal transition
for the current in-progress turn. A canonical resume response establishes the
initial terminal-transition candidate; replayed lifecycle notifications received
before that baseline cannot create one. A live turn start replaces the candidate,
and an early idle status clears the UI-facing active turn while retaining the
candidate until its completion arrives. Terminal turn projections cannot regress
to in-progress. Keeping these rules in the canonical session makes the bridge
independent of notification ordering details. Known terminal replays, stale
app-server generations, non-terminal updates, and completions for an older turn
while a newer turn is active are rejected. The bridge then verifies that the
thread is still an active Caffold-managed task in Redb and maps only the three
terminal statuses.

One bounded in-memory job is attempted per active subscription. Task and SSE
processing never waits for queue capacity or a provider response. The current
delivery bounds are four concurrent provider calls, a five-second connect
timeout, a fifteen-second overall timeout, no redirects, normal urgency, and a
24-hour TTL.

The deterministic Push `Topic` and notification `tag` are derived from thread
ID, turn ID, and terminal status. A bounded in-process recent-delivery set
suppresses common replays. HTTP 404 and 410 delete the subscription only when
the stored client ID and endpoint still match the attempted job; a replacement
subscription cannot be deleted by an older in-flight response. Other provider,
network, encoding, queue-capacity, and shutdown failures are sanitized,
reported, and dropped without changing canonical task state.

On graceful shutdown the sender closes and the current dispatcher drain bound is
three seconds, staying within the macOS wrapper's five-second termination
window.

## Notification privacy and navigation

The encrypted payload contains only:

- thread and turn IDs;
- terminal status;
- the current canonical task name, truncated at a Unicode boundary;
- the deterministic notification tag.

It never contains prompts, generated content, repository paths, or working
directories. If a task name is unavailable, the service worker uses Caffold and
status-only fallback copy. Notifications are shown even when a foreground
Caffold client is open.

Click handling accepts only a same-origin `/tasks/<thread-id>` route. It first
focuses a window already showing that task, otherwise navigates an existing
Caffold window, and finally opens a new task window. Cross-origin, malformed,
query-bearing, and non-task routes are ignored.

## Accepted reliability limits

Delivery is deliberately best-effort:

- a terminal turn can be missed while the Caffold backend is stopped;
- a transient provider or network failure is not retried;
- there is no durable queue, outbox, dead-letter state, startup catch-up, or
  persistent per-turn delivery history;
- an unexpected replay that cannot be matched to retained canonical turn history
  can produce a duplicate because recent-delivery suppression is process-local,
  despite the deterministic provider/browser identifiers;
- VAPID rotation and reliable background subscription renewal are not
  implemented. Opening Notifications remains the explicit reconciliation path.

These limits keep Push delivery isolated from canonical task processing and
preserve the existing foreground SSE lifecycle.
