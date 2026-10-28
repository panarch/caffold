import assert from "node:assert/strict";
import test from "node:test";

import { CaffoldElement } from "./caffold-element.js";

test("a component's own styles follow the base rules every component takes", () => {
  const own = { cssText: ".own {}" };
  class Styled extends CaffoldElement {
    static styles = [own];
  }
  class Unstyled extends CaffoldElement {}
  // Lit settles an element's styles when it is defined, by reading this.
  void Styled.observedAttributes;
  void Unstyled.observedAttributes;

  assert.equal(Styled.elementStyles.length, 2);
  assert.match(Styled.elementStyles[0].cssText, /box-sizing: border-box/);
  assert.equal(Styled.elementStyles[1], own);
  assert.equal(Unstyled.elementStyles.length, 1);
  assert.match(Unstyled.elementStyles[0].cssText, /box-sizing: border-box/);
});
