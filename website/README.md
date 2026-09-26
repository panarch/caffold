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
| `zensical.toml` | site settings and navigation |
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
