// Unit tests run from the tsc output in tests/unit-build/, which holds only
// JavaScript; the CSS, fonts, and TypeScript sources they read stay in
// frontend/.
const buildRoot = new URL("../../", import.meta.url).href;
const frontendRoot = new URL("../../../../", import.meta.url);

export function sourceUrl(url) {
  return url.href.startsWith(buildRoot)
    ? new URL(url.href.slice(buildRoot.length), frontendRoot)
    : url;
}
