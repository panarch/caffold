# Caffold Website

This directory builds the Caffold website, its homepage and user manual, with
[Zensical](https://zensical.org/). The pages are the user manual that
[Documentation Review](../docs/review/documentation.md) covers; this README is
only about building them.

| Path | Holds |
| --- | --- |
| `docs/` | the pages, in Markdown, and their assets |
| `docs/index.md` | the homepage, rendered with `overrides/home.html` |
| `docs/assets/screenshots/` | images from the [user manual scenarios](../docs/development/testing.md#user-manual-scenarios) |
| `docs/assets/fonts/` | the app's Geist fonts and their licenses |
| `docs/stylesheets/extra.css` | the site's typefaces, colors, and homepage layout |
| `overrides/main.html` | link preview tags, and the banner that marks every copy outside `caffold.dev` as the next release's manual |
| `og-card.html`, `docs/assets/brand/og.png` | the link preview image and the page it is rendered from |
| `docs/robots.txt` | lets search engines crawl the site and points them to its sitemap |
| `zensical.toml` | site settings and navigation |
| `wrangler.jsonc` | the Cloudflare Worker that serves the built site |
| `pyproject.toml`, `uv.lock` | the Zensical dependency and its locked release |

## Build and preview

The build needs [uv](https://docs.astral.sh/uv/), which also installs the
Python version Zensical requires. From this directory:

```sh
uv run zensical serve
```

serves the site at `http://localhost:8000` and rebuilds it on every change.

```sh
uv run zensical build --strict
```

writes the site to `site/` and fails on any warning.

## Link preview image

Shared links to any page show `docs/assets/brand/og.png`, rendered from
`og-card.html` with two of the manual's screenshots. When either screenshot
changes, render the image again from the `frontend/` directory:

```sh
npx playwright screenshot --viewport-size="1200,630" --wait-for-timeout=500 \
  "file://$PWD/../website/og-card.html" ../website/docs/assets/brand/og.png
```

## Deployment

Cloudflare Workers Builds deploys the site from this directory with the
Worker settings in `wrangler.jsonc`. The Worker's build settings in the
Cloudflare dashboard are:

| Setting | Value |
| --- | --- |
| Path | `/website` |
| Build command | `pip install uv && uv run --locked zensical build --strict` |
| Deploy command | `npx wrangler deploy` |
| Preview command | `npx wrangler preview` |
| Production branch | `site` |
| Build watch paths | `website/*` |

- **`https://caffold.dev`** serves the `site` branch, the manual of the latest
  release. The release workflow moves that branch to each release commit; see
  [macOS Release Process](../docs/operations/macos-release.md).
- **Every other branch** is a Preview at `<branch>-caffold.<subdomain>.workers.dev`,
  where `<subdomain>` is the Cloudflare account's workers.dev subdomain. The
  Preview of `main` is the manual of the next release. Every copy outside
  `caffold.dev`, including a local `zensical serve`, shows a banner that says
  so and links to the same page on `caffold.dev`.

To undo a bad production deployment, roll the Worker back to an earlier
deployment in the Cloudflare dashboard; the next release moves `site` forward
again.

## Writing pages

- Link pages to each other with relative `.md` paths. The
  [documentation contracts](../docs/tests/development-documentation.test.mjs)
  check every local link in tracked Markdown as a file path.
- Pages that GitHub readers reach from the repository README, such as
  `get-started/install.md`, use only Markdown that GitHub also renders.
- Write UI labels exactly as the app shows them, in bold.

## Update Zensical

```sh
uv lock --upgrade-package zensical
uv run zensical build --strict
```

Review the built site before keeping the new lock file.
