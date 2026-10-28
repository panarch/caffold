import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "./support/browser-defaults.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

test("components take shared styles as modules and request no stylesheet for them", { tag: "@viewport-independent" }, async ({ page }) => {
  const requests = [];
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.includes("/component-styles/")) requests.push(pathname);
  });
  await page.goto("/");
  await expect(page.locator("caffold-task-workspace-navigation")).toBeVisible();
  expect(requests).toContain("/assets/component-styles/compact-icon-button.css.js");
  expect(requests.filter((pathname) => !pathname.endsWith(".css.js"))).toEqual([]);
  // The workspace corner controls' compact icon button scope and the
  // foreground recovery notice's busy spin scope.
  expect(await page.evaluate(() => document.adoptedStyleSheets.length)).toBe(2);
});

test("new consumers declare their own scope, retain local overrides and reconnect without extra sheets", { tag: "@desktop" }, async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("caffold-task-workspace-navigation")).toBeVisible();
  const originalSheets = await page.evaluate(() => document.adoptedStyleSheets.length);
  await page.evaluate(async () => {
    const [{ adoptScopedStyle }, { default: compactIconButton }] = await Promise.all([
      import("/assets/scoped-style.js"),
      import("/assets/component-styles/compact-icon-button.css.js"),
    ]);
    adoptScopedStyle(compactIconButton, "caffold-style-contract", "> header > .contract-actions > .contract-button");
    customElements.define("caffold-style-contract", class extends HTMLElement {
      connectedCallback() {
        if (this.childElementCount) return;
        this.innerHTML = `<header><div class="contract-actions">
          <button class="contract-button">New consumer</button>
          <caffold-unregistered-contract><button class="contract-button">Nested control</button></caffold-unregistered-contract>
        </div></header>`;
      }
    });
    const host = document.createElement("caffold-style-contract");
    const other = document.createElement("caffold-unregistered-contract");
    other.innerHTML = `<button class="contract-button">Other owner</button>`;
    document.body.append(host, other);
  });
  const button = page.locator("caffold-style-contract > header > .contract-actions > .contract-button");
  await expect(button).toHaveCSS("display", "grid");
  const dimensions = await button.evaluate((element) => {
    const style = getComputedStyle(element);
    return { width: style.width, height: style.height, surface: getComputedStyle(element, "::before").content };
  });
  expect(dimensions.width).toBe(dimensions.height);
  expect(dimensions.surface).toBe('""');
  for (const other of [
    page.locator("caffold-style-contract caffold-unregistered-contract button"),
    page.locator("body > caffold-unregistered-contract button"),
  ]) {
    expect(await other.evaluate((element) => getComputedStyle(element, "::before").content)).toBe("none");
  }

  await button.focus();
  await expect(button).toBeFocused();
  const focusedSurface = await button.evaluate((element) => getComputedStyle(element, "::before").backgroundColor);
  await page.addStyleTag({ content: "caffold-style-contract > header > .contract-actions > .contract-button::before { background: rgb(12, 34, 56); }" });
  expect(focusedSurface).not.toBe("rgb(12, 34, 56)");
  await expect.poll(() => button.evaluate((element) => getComputedStyle(element, "::before").backgroundColor)).toBe("rgb(12, 34, 56)");
  await button.evaluate((element) => { element.disabled = true; });
  await expect(button).toHaveCSS("opacity", "0.35");
  await page.evaluate(() => {
    const host = document.querySelector("caffold-style-contract");
    host.remove();
    document.body.append(host);
    document.body.append(document.createElement("caffold-style-contract"));
  });
  await expect(page.locator("caffold-style-contract > header > .contract-actions > .contract-button")).toHaveCount(2);
  expect(await page.evaluate(() => document.adoptedStyleSheets.length)).toBe(originalSheets + 1);
});

test("a busy spin turns only its owner's busy element and stops for reduced motion", { tag: "@viewport-independent" }, async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("caffold-task-workspace-navigation")).toBeVisible();
  await page.evaluate(async () => {
    const [{ adoptScopedStyle }, { default: busySpin }] = await Promise.all([
      import("/assets/scoped-style.js"),
      import("/assets/pages/component-styles/busy-spin.css.js"),
    ]);
    adoptScopedStyle(busySpin, "caffold-spin-contract", "> .contract-button.is-busy > .contract-icon");
    customElements.define("caffold-spin-contract", class extends HTMLElement {
      connectedCallback() {
        if (this.childElementCount) return;
        this.innerHTML = `
          <button class="contract-button is-busy" data-contract="busy"><span class="contract-icon"></span></button>
          <button class="contract-button" data-contract="idle"><span class="contract-icon"></span></button>
        `;
      }
    });
    const other = document.createElement("caffold-unregistered-spin");
    other.innerHTML = `<button class="contract-button is-busy"><span class="contract-icon"></span></button>`;
    document.body.append(document.createElement("caffold-spin-contract"), other);
  });
  const busy = page.locator('caffold-spin-contract > [data-contract="busy"] > .contract-icon');
  const idle = page.locator('caffold-spin-contract > [data-contract="idle"] > .contract-icon');
  const otherOwner = page.locator("caffold-unregistered-spin .contract-icon");
  await expect(busy).toHaveCSS("animation-name", "caffold-busy-spin");
  await expect(busy).toHaveCSS("animation-duration", "0.8s");
  await expect(busy).toHaveCSS("animation-timing-function", "linear");
  await expect(busy).toHaveCSS("animation-iteration-count", "infinite");
  await expect(idle).toHaveCSS("animation-name", "none");
  await expect(otherOwner).toHaveCSS("animation-name", "none");

  // An owner's own start delay stays on top of the shared turn.
  await busy.evaluate((icon) => { icon.style.animationDelay = "-300ms"; });
  await expect(busy).toHaveCSS("animation-delay", "-0.3s");
  await expect(busy).toHaveCSS("animation-name", "caffold-busy-spin");

  await idle.evaluate((icon) => icon.parentElement.classList.add("is-busy"));
  await busy.evaluate((icon) => icon.parentElement.classList.remove("is-busy"));
  await expect(idle).toHaveCSS("animation-name", "caffold-busy-spin");
  await expect(busy).toHaveCSS("animation-name", "none");

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(idle).toHaveCSS("animation-name", "none");
});

test("pagination keeps its compact surface, disabled appearance and native activation", { tag: "@all-viewports" }, async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("caffold-task-workspace")).toBeVisible();
  await page.evaluate(() => customElements.whenDefined("caffold-pagination"));
  await page.evaluate(() => {
    const pagination = document.createElement("caffold-pagination");
    pagination.setAttribute("page", "1");
    pagination.setAttribute("total-pages", "3");
    pagination.setAttribute("has-next", "");
    pagination.addEventListener("caffold:change-page", (event) => {
      pagination.dataset.selectedPage = event.detail.page;
    });
    document.body.append(pagination);
  });
  const pagination = page.locator("caffold-pagination");
  const first = pagination.getByRole("button", { name: "First page" });
  const next = pagination.getByRole("button", { name: "Next page" });
  await expect(first).toBeDisabled();
  await expect(first).toHaveCSS("opacity", "0.55");
  await expect(first).toHaveCSS("cursor", "default");
  await expect(next).toHaveCSS("margin-top", "0px");
  const metrics = await next.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const root = getComputedStyle(document.documentElement);
    const surface = getComputedStyle(element, "::before");
    return {
      width: box.width, height: box.height,
      visual: box.height - parseFloat(surface.top) - parseFloat(surface.bottom),
      expectedVisual: parseFloat(root.fontSize) * 1.875,
      floor: parseFloat(root.getPropertyValue("--interface-target-floor")),
      border: surface.borderTopWidth,
    };
  });
  expect(metrics.width).toBeCloseTo(metrics.height, 1);
  expect(metrics.height).toBeCloseTo(Math.max(metrics.expectedVisual, metrics.floor), 1);
  expect(metrics.visual).toBeCloseTo(metrics.expectedVisual, 1);
  expect(metrics.border).toBe("1px");
  await next.focus();
  await next.press("Enter");
  await expect(pagination).toHaveAttribute("data-selected-page", "2");
});

test("pagination draws into shadow roots its styles stay inside and the document's styles do not enter", { tag: "@viewport-independent" }, async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("caffold-task-workspace")).toBeVisible();
  await page.evaluate(() => customElements.whenDefined("caffold-pagination"));
  const result = await page.evaluate(async () => {
    const pagination = document.createElement("caffold-pagination");
    pagination.setAttribute("page", "1");
    pagination.setAttribute("total-pages", "3");
    pagination.setAttribute("has-next", "");
    // Outside the pagination, the classes it styles inside.
    const outside = document.createElement("div");
    outside.innerHTML = `<nav class="pagination-panel"><button class="pagination-button">Outside</button></nav>`;
    document.body.append(pagination, outside);
    await pagination.updateComplete;
    const host = pagination.shadowRoot.querySelector('caffold-pagination-button[kind="next"]');
    await host.updateComplete;
    const next = host.shadowRoot.querySelector(".pagination-button");
    const documentRule = new CSSStyleSheet();
    documentRule.replaceSync(".pagination-button { opacity: 0.25; }");
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, documentRule];
    const outsideButton = outside.querySelector(".pagination-button");
    return {
      roots: [pagination.shadowRoot?.mode, host.shadowRoot?.mode],
      lightChildren: pagination.childElementCount + host.childElementCount,
      outsidePanel: getComputedStyle(outside.firstElementChild).display,
      outsideSurface: getComputedStyle(outsideButton, "::before").content,
      outsideOpacity: getComputedStyle(outsideButton).opacity,
      insideOpacity: getComputedStyle(next).opacity,
      insideBoxSizing: getComputedStyle(next).boxSizing,
      insideFont: getComputedStyle(next).fontFamily === getComputedStyle(document.body).fontFamily,
      hiddenLabel: getComputedStyle(next.querySelector(".sr-only")).position,
    };
  });
  expect(result).toEqual({
    roots: ["open", "open"],
    lightChildren: 0,
    outsidePanel: "block",
    outsideSurface: "none",
    outsideOpacity: "0.25",
    insideOpacity: "1",
    insideBoxSizing: "border-box",
    insideFont: true,
    hiddenLabel: "absolute",
  });
});

test("a drawn ref keeps its element out of the document and lets go once it is no longer drawn", { tag: "@viewport-independent" }, async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("caffold-task-workspace")).toBeVisible();
  const result = await page.evaluate(async () => {
    const { html, LitElement, nothing } = await import("lit");
    const { DrawnRef, DrawnRefs, drawn } = await import("/assets/components/drawn-refs.js");
    class DrawnRefProbe extends LitElement {
      static properties = { shown: { attribute: false }, keys: { attribute: false } };
      panel = new DrawnRef(this);
      rows = new DrawnRefs(this);
      constructor() {
        super();
        this.shown = true;
        this.keys = ["a", "b"];
      }
      createRenderRoot() {
        return this;
      }
      render() {
        return html`${this.shown ? html`<section ${drawn(this.panel)}></section>` : nothing}
          ${this.keys.map((key) => html`<p ${drawn(this.rows.of(key))}>${key}</p>`)}`;
      }
      draw() {
        this.performUpdate();
      }
    }
    customElements.define("caffold-drawn-ref-probe", DrawnRefProbe);
    const probe = document.createElement("caffold-drawn-ref-probe");
    probe.draw();
    const beforeAttach = [probe.panel.value?.localName, probe.rows.get("b")?.textContent];
    document.body.append(probe);
    probe.remove();
    const afterDetach = [probe.panel.value?.localName, probe.rows.get("a")?.textContent];
    document.body.append(probe);
    probe.shown = false;
    probe.keys = ["a"];
    probe.draw();
    return {
      beforeAttach,
      afterDetach,
      undrawn: [probe.panel.value ?? null, probe.rows.get("b") ?? null, probe.rows.get("a")?.textContent],
    };
  });
  expect(result).toEqual({
    beforeAttach: ["section", "b"],
    afterDetach: ["section", "a"],
    undrawn: [null, null, "a"],
  });
});

test("pagination offers its enabled page buttons as Action Hints from the page it draws", { tag: "@viewport-independent" }, async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("caffold-task-workspace")).toBeVisible();
  await page.evaluate(() => customElements.whenDefined("caffold-pagination"));
  // Each pull waits for the next frame, as keyboard navigation does, by which
  // Lit has drawn the change.
  const result = await page.evaluate(async () => {
    const pagination = document.createElement("caffold-pagination");
    pagination.setAttribute("page", "1");
    pagination.setAttribute("total-pages", "3");
    pagination.setAttribute("has-next", "");
    document.body.append(pagination);
    const clip = document.body;
    const pull = () => pagination.actionHintScope({
      scopeId: "issues:page",
      actionId: "navigation.page",
      clipRoots: [clip],
    });
    const targets = async () => {
      await new Promise(requestAnimationFrame);
      return pull().targets.map((target) => ({
        id: target.id,
        actionId: target.actionId,
        label: target.label,
        clipped: target.clipRoots.includes(clip),
      }));
    };
    const firstPage = await targets();
    // A change inside any of the shadow roots revalidates.
    const buttons = [...pagination.shadowRoot.querySelectorAll("caffold-pagination-button")];
    const watchesEveryRoot = [pagination, ...buttons].every((owner) =>
      pull().mutationRoots.includes(owner.shadowRoot));
    pagination.setAttribute("has-previous", "");
    pagination.setAttribute("page", "2");
    const secondPage = await targets();
    pagination.setAttribute("total-pages", "1");
    const onePage = await targets();
    return { firstPage, watchesEveryRoot, secondPage, onePage };
  });
  const target = (id, label) => ({ id: `issues:page:page:${id}`, actionId: "navigation.page", label, clipped: true });
  expect(result).toEqual({
    firstPage: [target("next:2", "Next page"), target("last:3", "Last page")],
    watchesEveryRoot: true,
    secondPage: [
      target("first:1", "First page"),
      target("previous:1", "Previous page"),
      target("next:3", "Next page"),
      target("last:3", "Last page"),
    ],
    onePage: [],
  });
});

test("segmented control offers the choices other than the current one as Action Hints", { tag: "@viewport-independent" }, async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("caffold-task-workspace")).toBeVisible();
  await page.evaluate(() => customElements.whenDefined("caffold-segmented-control"));
  // Each pull waits for the next frame, as keyboard navigation does.
  const result = await page.evaluate(async () => {
    const control = document.createElement("caffold-segmented-control");
    document.body.append(control);
    const choices = [
      { value: "changes", label: "Changes" },
      { value: "file path", label: "Files" },
    ];
    const targets = async () => {
      await new Promise(requestAnimationFrame);
      return control.actionHintScope({
        scopeId: "review:navigator-axis",
        actionId: "navigation.review.axis",
      }).targets.map((target) => [target.id, target.label]);
    };
    control.setSnapshot({ label: "Review navigator", selected: "changes", choices, actionVerb: "Show" });
    const onChanges = await targets();
    control.setSnapshot({ label: "Review navigator", selected: "file path", choices });
    const onFiles = await targets();
    return { onChanges, onFiles };
  });
  expect(result).toEqual({
    onChanges: [["review:navigator-axis:choice:file%20path", "Show Files"]],
    onFiles: [["review:navigator-axis:choice:changes", "Select Changes"]],
  });
});

test("segmented control keeps its button rule inside its shadow root and the document's button rules out", { tag: "@viewport-independent" }, async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("caffold-task-workspace")).toBeVisible();
  await page.evaluate(() => customElements.whenDefined("caffold-segmented-control"));
  const result = await page.evaluate(async () => {
    const control = document.createElement("caffold-segmented-control");
    // Outside the control, the element its stylesheet styles inside by name.
    const outside = document.createElement("button");
    outside.textContent = "Outside";
    document.body.append(control, outside);
    control.setSnapshot({
      label: "Review navigator",
      selected: "changes",
      choices: [{ value: "changes", label: "Changes" }, { value: "files", label: "Files" }],
    });
    await control.updateComplete;
    const inside = control.shadowRoot.querySelector("button");
    const documentRule = new CSSStyleSheet();
    documentRule.replaceSync("button { opacity: 0.25; }");
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, documentRule];
    return {
      root: control.shadowRoot?.mode,
      lightChildren: control.childElementCount,
      outside: [getComputedStyle(outside).display, getComputedStyle(outside).cursor],
      outsideOpacity: getComputedStyle(outside).opacity,
      inside: [getComputedStyle(inside).display, getComputedStyle(inside).cursor],
      insideOpacity: getComputedStyle(inside).opacity,
    };
  });
  expect(result).toEqual({
    root: "open",
    lightChildren: 0,
    outside: ["inline-block", "default"],
    outsideOpacity: "0.25",
    inside: ["grid", "pointer"],
    insideOpacity: "1",
  });
});

test("the Settings refresh button turns its icon inside its shadow root and nothing outside it", { tag: "@viewport-independent" }, async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("caffold-task-workspace-navigation")).toBeVisible();
  await page.evaluate(() => customElements.whenDefined("caffold-settings-refresh-button"));
  await page.evaluate(() => {
    const button = document.createElement("caffold-settings-refresh-button");
    button.id = "refresh-contract";
    // Outside the button's root, the markup its spin names inside it.
    const outside = document.createElement("div");
    outside.id = "refresh-outside";
    outside.innerHTML = `<button class="is-refreshing"><span><span class="settings-refresh-icon"></span></span></button>`;
    document.body.append(button, outside);
  });
  const icon = page.locator("#refresh-contract .settings-refresh-icon");
  const outside = page.locator("#refresh-outside .settings-refresh-icon");
  await expect(icon).toHaveCSS("animation-name", "none");
  await page.locator("#refresh-contract").evaluate((button) => {
    button.refreshing = true;
  });
  await expect(icon).toHaveCSS("animation-name", "caffold-busy-spin");
  await expect(outside).toHaveCSS("animation-name", "none");

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(icon).toHaveCSS("animation-name", "none");
});

test("pagination changes its page in place and leaves the same page untouched", { tag: "@viewport-independent" }, async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("caffold-task-workspace")).toBeVisible();
  await page.evaluate(() => customElements.whenDefined("caffold-pagination"));
  const result = await page.evaluate(async () => {
    const pagination = document.createElement("caffold-pagination");
    pagination.setAttribute("page", "1");
    pagination.setAttribute("total-pages", "3");
    pagination.setAttribute("has-next", "");
    document.body.append(pagination);
    const hosts = () => [...pagination.shadowRoot.querySelectorAll(
      ".pagination-panel > caffold-pagination-button",
    )];
    const rendered = async () => {
      await pagination.updateComplete;
      await Promise.all(hosts().map((host) => host.updateComplete));
    };
    await rendered();
    const buttons = () => hosts().map((host) => host.shadowRoot.querySelector(".pagination-button"));
    const indicator = () => pagination.shadowRoot.querySelector(".pagination-panel > .pagination-indicator");
    const firstButtons = buttons();
    const firstIndicator = indicator();
    const records = [];
    const observer = new MutationObserver((delivered) => records.push(...delivered));
    for (const root of [pagination, pagination.shadowRoot, ...hosts().map((host) => host.shadowRoot)]) {
      observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
    }
    const renderedChanges = () => records.splice(0).concat(observer.takeRecords())
      .filter((record) => record.target !== pagination || record.type !== "attributes");

    pagination.setAttribute("page", "1");
    await rendered();
    const samePageRecords = renderedChanges().length;
    pagination.setAttribute("has-previous", "");
    pagination.setAttribute("page", "2");
    await rendered();
    const removedElements = renderedChanges()
      .flatMap((record) => [...record.removedNodes])
      .filter((node) => node.nodeType === Node.ELEMENT_NODE).length;
    observer.disconnect();

    const [first, previous, next] = buttons();
    return {
      samePageRecords,
      removedElements,
      sameButtons: firstButtons.length === 4 && buttons().every((button, index) => button === firstButtons[index]),
      sameIndicator: indicator() === firstIndicator,
      indicator: [indicator().textContent.trim(), indicator().getAttribute("aria-label")],
      enabled: [first.disabled, previous.disabled].map((disabled) => !disabled),
      nextPage: next.dataset.page,
    };
  });
  expect(result).toEqual({
    samePageRecords: 0,
    removedElements: 0,
    sameButtons: true,
    sameIndicator: true,
    indicator: ["2 / 3", "Page 2 of 3"],
    enabled: [true, true],
    nextPage: "3",
  });
});
