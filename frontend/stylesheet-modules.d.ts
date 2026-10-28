// The module the build writes beside each stylesheet: `name.css.js` holds
// `name.css` as a constructed stylesheet.
declare module "*.css.js" {
  const sheet: CSSStyleSheet;
  export default sheet;
}
