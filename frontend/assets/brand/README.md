# Brand Assets

These assets are copied from the official brand/logo sources for the controls
that name each project.

- `git-logomark-light.svg`: Git black logomark for light backgrounds, from
  <https://git-scm.com/community/logos>.
- `git-logomark-dark.svg`: Git white logomark for dark backgrounds, from
  <https://git-scm.com/community/logos>.
- `github-invertocat-light.svg`: GitHub Invertocat black mark, from
  <https://brand.github.com/foundations/logo>.
- `github-invertocat-dark.svg`: GitHub Invertocat white mark, from
  <https://brand.github.com/foundations/logo>.
- `codex-template.png`, `codex-template@2x.png`: Codex app icon mark, drawn in
  a single color as a template image.
- `claude-template.png`: Claude tray mark, drawn in a single color, from the
  Claude desktop application at `Claude.app/Contents/Resources/TrayIconLinux.png`.
  Its menu-bar siblings carry padding that would render the mark smaller than
  the icons beside it.
- `grok-template.png`: Grok mark, from the monochrome icon grok.com publishes
  for platforms to tint — `https://grok.com/images/android-chrome-monochrome-512x512.png`,
  listed in `https://grok.com/manifest.webmanifest` with `purpose: "monochrome"`
  (retrieved 2026-09-12). That file carries the Android safe-zone margin around
  the mark and is white on transparent; here the transparent margin is
  trimmed to the mark plus 4% and the mask is stored black on transparent,
  with its alpha untouched, so the theme tints it like the marks beside it.
  SpaceXAI's logo kit at `https://data.x.ai/logos/SpaceXAI_Grok_Assets.zip`,
  linked from `https://x.ai/legal/brand-guidelines`, sits behind a Cloudflare
  challenge that refuses every non-interactive download; it was not used.

Use each mark as its owner published it. A mark published as one file per
background switches between those files when the theme changes. A template mark
is published in a single color to be tinted, so it follows the theme through
`--brand-monochrome-filter`; inverting `claude-template.png` reproduces
`TrayIconLinux-Dark.png` from the same application exactly. Do not otherwise
recolor or redraw a mark in CSS.
