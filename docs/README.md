# Documentation

Caffold documentation is organized by purpose. All tracked documents are part
of the repository documentation; their directory identifies what they explain,
not who is allowed to read them.

## User manual

The user manual in `website/docs/` is the source of the Caffold website. It
owns how to install, set up, and use Caffold, starting at
[Install](../website/docs/get-started/install.md); [its README](../website/README.md)
describes how the site is built.

## Product

These documents describe the product, its current behavior, and its direction.
Only the roadmap should present unfinished product behavior as planned work.

- [Vision](product/vision.md)
- [Current Product Status](product/status.md)
- [Product Workflows](product/workflows.md)
- [UI Surfaces](product/ui-surfaces.md)
- [Roadmap](product/roadmap.md)

## Architecture

These documents define implemented system boundaries and detailed ownership
contracts.

- [Architecture Overview](architecture/overview.md)
- [Agent Runtimes](architecture/agent-runtimes.md)
- [Codex App Server](architecture/codex-app-server.md)
- [Managed Worktree Lifecycle](architecture/worktree-lifecycle.md)
- [Live Updates](architecture/live-updates.md)
- [Web Push Notifications](architecture/web-push-notifications.md)
- [Frontend Structure](architecture/frontend.md)
- [Navigation Routing](architecture/navigation.md)
- [Security and Approvals](architecture/security-and-approvals.md)

## Development

These documents define reproducible contributor setup, testing, local
application, and mobile review workflows.

- [Contributing](../CONTRIBUTING.md)
- [Testing](development/testing.md)
- [macOS Local Application Development](development/macos-local-app.md)
- [Mobile and PWA Testing](development/mobile-pwa-testing.md)

## Review

These documents define the repository review policy and its area-specific
rules.

- [Review Policy](review/policy.md)
- [Frontend Review](review/frontend.md)
- [Backend and API Review](review/backend.md)
- [Documentation Review](review/documentation.md)

## Operations

These documents define maintainer procedures for distributing and operating
supported artifacts.

- [macOS Release Process](operations/macos-release.md)
