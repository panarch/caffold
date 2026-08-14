# Roadmap

This roadmap records intended product expansions, not release commitments or
implementation designs.

## Planned

### Authenticated internet-facing deployment

Support secure self-hosted deployment beyond a trusted local or private
network. Authentication, authorization, session security, and audit controls
would allow Caffold to run on an internet-reachable server without treating
every network client as trusted.

### Event-driven GitHub integration

Explore an optional event-driven GitHub integration that can keep
GitHub-derived Task context current without making GitHub a requirement for
Caffold. Candidate uses include Pull Request lifecycle presentation in the Task
navigator, CI and review signals, and separately opt-in notifications.

GitHub's request-response APIs do not provide a Codex app-server-like event
connection that a private Caffold host can maintain. Receiving GitHub webhooks
while preserving the current trusted-host and private-network boundary may
therefore require user-operated public webhook ingress that can reach the
private host without exposing the Caffold control server directly to the public
internet. This roadmap does not propose a Caffold-operated shared relay service.

Before implementation, decide:

- how self-hosted webhook ingress is configured and secured;
- how webhook deliveries are authenticated and which GitHub permissions are
  required;
- which event data may be retained and for how long;
- how the integration relates to the optional local GitHub CLI and existing Web
  Push delivery.

Until those product decisions are made, a Task navigator Pull Request lifecycle
indicator remains a candidate consumer of this integration rather than a
scheduled standalone feature.

### Richer diff review

Improve the Review panel beyond its current unified text presentation. Add a
split diff, syntax highlighting, and clearer code-aware presentation across
desktop, foldable, and mobile layouts.
