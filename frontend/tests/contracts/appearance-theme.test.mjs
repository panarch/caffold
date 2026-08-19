import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const frontendRoot = fileURLToPath(new URL("../../", import.meta.url));

test("the pre-paint bootstrap applies stored or System theme before CSS", () => {
  const html = readFrontend("index.html");
  const bootstrap = html.indexOf("localStorage.getItem(\"caffold:settings\")");
  const stylesheet = html.indexOf('<link rel="stylesheet"');

  assert.notEqual(bootstrap, -1);
  assert.ok(bootstrap < stylesheet, "theme bootstrap must precede the stylesheet");
  assert.match(html, /let themeMode = "system"/);
  assert.match(html, /document\.documentElement\.dataset\.theme = resolvedTheme/);
  assert.match(html, /document\.documentElement\.style\.colorScheme = resolvedTheme/);
  assert.match(html, /meta\[name="theme-color"\]/);
});

test("Light and Dark palettes expose the same complete semantic roles", () => {
  const css = readFrontend("styles.css");
  const light = themeBlock(css, ':root:not([data-theme]),\n:root[data-theme="light"]');
  const dark = themeBlock(css, ':root[data-theme="dark"]');
  const lightTokens = tokenNames(light);
  const darkTokens = tokenNames(dark);

  assert.ok(lightTokens.length >= 75, "the theme boundary must cover all color roles");
  assert.deepEqual(darkTokens, lightTokens);
  assert.match(light, /--brand-git-image: url\("\/assets\/brand\/git-logomark-light\.svg"\)/);
  assert.match(dark, /--brand-git-image: url\("\/assets\/brand\/git-logomark-dark\.svg"\)/);
  assert.match(light, /--brand-monochrome-filter: none/);
  assert.match(dark, /--brand-monochrome-filter: invert\(1\)/);
});

test("representative text, feedback, syntax, and diff roles meet contrast targets", () => {
  const css = readFrontend("styles.css");
  const blocks = {
    light: themeBlock(css, ':root:not([data-theme]),\n:root[data-theme="light"]'),
    dark: themeBlock(css, ':root[data-theme="dark"]'),
  };
  const pairs = [
    ["text", "surface"],
    ["muted", "surface"],
    ["link-fg", "surface"],
    ["success", "surface"],
    ["warning", "surface"],
    ["danger", "surface"],
    ["code-text", "code-bg"],
    ["syntax-comment", "code-bg"],
    ["syntax-keyword", "code-bg"],
    ["syntax-literal", "code-bg"],
    ["syntax-string", "code-bg"],
    ["syntax-title", "code-bg"],
    ["syntax-type", "code-bg"],
    ["diff-added-text", "diff-added-bg"],
    ["diff-removed-text", "diff-removed-bg"],
  ];

  for (const [theme, block] of Object.entries(blocks)) {
    for (const [foreground, background] of pairs) {
      const ratio = contrastRatio(
        hexToken(block, foreground),
        hexToken(block, background),
      );
      assert.ok(
        ratio >= 4.5,
        `${theme} ${foreground} on ${background} contrast was ${ratio.toFixed(2)}`,
      );
    }
  }
});

test("theme-sensitive component assets follow app theme roles, not OS media", () => {
  for (const path of frontendSourcePaths()) {
    const source = readFrontend(path);
    if (path === "index.html" || path === "theme.js") {
      continue;
    }
    assert.doesNotMatch(
      source,
      /prefers-color-scheme/,
      `${path} must consume the resolved app theme instead of OS preference`,
    );
    if (path.endsWith(".js") && path !== "service-worker.js") {
      assert.doesNotMatch(
        source,
        /(?:git-logomark|github-invertocat)-(?:light|dark)\.svg/,
        `${path} must not select a theme-specific brand asset directly`,
      );
    }
  }
});

function themeBlock(css, selector) {
  const start = css.indexOf(selector);
  assert.notEqual(start, -1, `missing theme selector ${selector}`);
  const open = css.indexOf("{", start);
  const close = css.indexOf("\n}", open);
  return css.slice(open + 1, close);
}

function tokenNames(block) {
  return [...block.matchAll(/--([a-z0-9-]+):/g)]
    .map((match) => match[1])
    .sort();
}

function hexToken(block, name) {
  const match = block.match(new RegExp(`--${name}:\\s*([^;]+);`, "i"));
  assert.ok(match, `missing value for --${name}`);
  const value = match[1].trim();
  if (/^#[0-9a-f]{6}$/i.test(value)) {
    return value;
  }
  const reference = value.match(/^var\(--([a-z0-9-]+)\)$/i);
  assert.ok(reference, `--${name} must resolve to a hex color for contrast checks`);
  return hexToken(block, reference[1]);
}

function contrastRatio(first, second) {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  return (
    (Math.max(firstLuminance, secondLuminance) + 0.05) /
    (Math.min(firstLuminance, secondLuminance) + 0.05)
  );
}

function relativeLuminance(hex) {
  const channels = [1, 3, 5].map((offset) =>
    Number.parseInt(hex.slice(offset, offset + 2), 16) / 255,
  );
  const [red, green, blue] = channels.map((channel) =>
    channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function frontendSourcePaths(directory = frontendRoot) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === "tests") {
      return [];
    }
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      return frontendSourcePaths(absolute);
    }
    return [".css", ".html", ".js"].includes(extname(entry.name)) &&
      !entry.name.endsWith(".test.js")
      ? [relative(frontendRoot, absolute)]
      : [];
  });
}

function readFrontend(path) {
  return readFileSync(new URL(path, `file://${frontendRoot}/`), "utf8");
}
