import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  elementStandIn,
  installCustomElementUnitRegistry,
} from "../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
const { nextStep, readPercent, sliderPercent, sliderPosition } = await import(
  "./zoom-control.js"
);
const zoomControl = registry.element("caffold-zoom-control").prototype;
after(() => registry.restore());

// A control showing `percent`, with its slider where that percent sits, that
// keeps the intents it sends.
function control(percent, zoom = { fit: "width" }) {
  const sent = [];
  const slider = {
    value: `${sliderPosition(percent ?? 100)}`,
    get valueAsNumber() {
      return Number(this.value);
    },
  };
  const owner = elementStandIn(zoomControl, {
    snapshot: { zoom, percent },
    percent,
    holding: false,
    dragged: false,
    editing: false,
    slider: { value: slider },
    dispatchEvent: (event) => sent.push(event.detail),
  });
  return { owner, sent, slider };
}

function field(value) {
  return {
    value,
    selected: 0,
    select() {
      this.selected += 1;
    },
  };
}

test("− and + go to the nearest step past the percent shown, and stay at either end", () => {
  assert.equal(nextStep(79, 1), 90);
  assert.equal(nextStep(79, -1), 75);
  assert.equal(nextStep(100, 1), 125);
  assert.equal(nextStep(100, -1), 90);
  assert.equal(nextStep(99.7, 1), 125, "a percent shown as 100% is at 100%");
  assert.equal(nextStep(400, 1), 400);
  assert.equal(nextStep(10, -1), 10);
  assert.equal(nextStep(3, 1), 10, "a fit below the steps goes up to the first");
  assert.equal(nextStep(3, -1), 3);
});

test("the slider's middle is 100%, and each half runs by ratio to its end", () => {
  assert.equal(sliderPosition(100), 500);
  assert.equal(sliderPosition(10), 0);
  assert.equal(sliderPosition(400), 1000);
  assert.equal(sliderPosition(50), 349, "a ratio of 5 into the left half's 10");
  assert.equal(sliderPosition(200), 750, "a ratio of 2 into the right half's 4");
  assert.equal(sliderPosition(3), 0, "a percent below the steps sits at the left end");
  assert.equal(sliderPercent(0), 10);
  assert.equal(sliderPercent(500), 100);
  assert.equal(sliderPercent(1000), 400);
  for (const percent of [25, 67, 150, 300]) {
    assert.ok(Math.abs(sliderPercent(sliderPosition(percent)) - percent) < percent * 0.005, `${percent}`);
  }
});

test("reads a typed percent with or without its sign, kept within the steps' ends", () => {
  assert.equal(readPercent("150"), 150);
  assert.equal(readPercent("150%"), 150);
  assert.equal(readPercent(" 150 % "), 150);
  assert.equal(readPercent("0"), 10);
  assert.equal(readPercent("999"), 400);
  assert.equal(readPercent("abc"), null);
  assert.equal(readPercent(""), null);
});

test("a held slider sends any size while it moves, and settles once where it is let go", () => {
  const { owner, sent, slider } = control(79);

  zoomControl.hold.call(owner);
  slider.value = "620";
  zoomControl.slide.call(owner, { currentTarget: slider });
  zoomControl.letGo.call(owner);
  zoomControl.settle.call(owner);

  assert.deepEqual(sent, [
    { zoom: { percent: sliderPercent(620) }, dragging: true },
    { zoom: { percent: sliderPercent(620) }, dragging: false },
  ]);
  assert.equal(owner.holding, false);
});

test("a notch from the keyboard or a screen reader moves one step, or to an end", () => {
  for (const [moved, percent] of [
    [1, 90],
    [-1, 75],
  ]) {
    const { owner, sent, slider } = control(79);
    slider.value = `${sliderPosition(79) + moved}`;
    zoomControl.slide.call(owner, { currentTarget: slider });
    assert.deepEqual(sent, [{ zoom: { percent }, dragging: false }]);
    assert.equal(slider.value, `${sliderPosition(percent)}`, "the slider sits at the step");
  }
  for (const [position, percent] of [
    ["0", 10],
    ["1000", 400],
  ]) {
    const { owner, sent, slider } = control(150);
    slider.value = position;
    zoomControl.slide.call(owner, { currentTarget: slider });
    assert.deepEqual(sent, [{ zoom: { percent }, dragging: false }]);
  }
  const { owner, sent, slider } = control(3, { fit: "page" });
  slider.value = "1";
  zoomControl.slide.call(owner, { currentTarget: slider });
  assert.deepEqual(sent, [{ zoom: { percent: 10 }, dragging: false }]);
});

test("a second step moves from the first at once, until the preview reports a newer percent", () => {
  const zoom = { percent: 150 };
  const { owner, sent, slider } = control(150, zoom);

  slider.value = `${sliderPosition(150) - 1}`;
  zoomControl.slide.call(owner, { currentTarget: slider });
  slider.value = `${sliderPosition(125) - 1}`;
  zoomControl.slide.call(owner, { currentTarget: slider });
  assert.deepEqual(sent.map((intent) => intent.zoom.percent), [125, 100]);

  // A snapshot drawn before the preview caught up still shows 150%.
  zoomControl.willUpdate.call(owner, new Map([["snapshot", { zoom, percent: 150 }]]));
  assert.equal(owner.percent, 100);

  owner.snapshot = { zoom: { percent: 100 }, percent: 99.8 };
  zoomControl.willUpdate.call(owner, new Map([["snapshot", { zoom, percent: 150 }]]));
  assert.equal(owner.percent, 99.8);
});

test("chooses a fit or a step, and moves nothing before the preview is drawn", () => {
  const { owner, sent } = control(79);
  const event = (value) => ({ detail: { value }, stopPropagation() {} });

  zoomControl.chooseFit.call(owner, event("page"));
  zoomControl.chooseFit.call(owner, event("height"));
  zoomControl.step.call(owner, 1);

  assert.deepEqual(sent, [
    { zoom: { fit: "page" }, dragging: false },
    { zoom: { percent: 90 }, dragging: false },
  ]);

  const waiting = control(null);
  zoomControl.step.call(waiting.owner, -1);
  waiting.slider.value = "520";
  zoomControl.slide.call(waiting.owner, { currentTarget: waiting.slider });
  assert.deepEqual(waiting.sent, []);
});

test("Enter sets a typed percent, and anything not a number gives way to the percent shown", () => {
  const { owner, sent } = control(79);
  const key = (name, target, isComposing = false) => ({
    key: name,
    isComposing,
    currentTarget: target,
    preventDefault() {},
  });

  const typed = field("150");
  zoomControl.typePercent.call(owner, key("Enter", typed));
  assert.deepEqual(sent, [{ zoom: { percent: 150 }, dragging: false }]);
  assert.equal(typed.value, "150%");
  assert.equal(typed.selected, 1, "the percent stays selected to type over");

  const words = field("abc");
  zoomControl.typePercent.call(owner, key("Enter", words));
  const composing = field("1");
  zoomControl.typePercent.call(owner, key("Enter", composing, true));
  assert.equal(sent.length, 1);
  assert.equal(words.value, "150%", "the percent just entered is the one shown");
  assert.equal(composing.value, "1", "Enter that ends a composition is the composition's");
});

test("leaving the percent unentered shows the percent the preview is drawn at", () => {
  const { owner } = control(79);
  const left = field("12");
  owner.editing = true;

  zoomControl.stopEditing.call(owner, { currentTarget: left });

  assert.equal(left.value, "79%");
  assert.equal(owner.editing, false);
});
