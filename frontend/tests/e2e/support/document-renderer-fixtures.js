// Deterministic renderer boundaries for cancellation and cleanup. Real Office
// rendering stays covered by the DOCX/PPTX preview specs.
export async function installDocxRenderer(page) {
  await installLifetimeRecords(page, "ResizeObserver");
  await page.route("https://cdn.jsdelivr.net/npm/docx-preview@0.4.1/+esm", (route) => route.fulfill({
    contentType: "text/javascript",
    body: `
      const fixture = window.documentRenderer;
      export async function parseAsync(bytes) { return new TextDecoder().decode(bytes); }
      export async function renderDocument(id) {
        fixture.started.push(id);
        if (fixture.hold.delete(id)) {
          await new Promise((resolve) => fixture.pending.set(id, resolve));
        }
        if (id === "error") throw new Error("document render failed");
        const page = document.createElement("section");
        page.className = "docx";
        page.style.width = "600px";
        page.textContent = id;
        fixture.completed.push(id);
        return [page];
      }
    `,
  }));
}

export async function installPptxRenderer(page) {
  await installLifetimeRecords(page, "MutationObserver");
  await page.route("https://cdn.jsdelivr.net/npm/@aiden0z/pptx-renderer@1.3.0/dist/aiden0z-pptx-renderer.browser.es.js", (route) => route.fulfill({
    contentType: "text/javascript",
    body: `
      const fixture = window.documentRenderer;
      export const RECOMMENDED_ZIP_LIMITS = {};
      export async function parseZipLazyMedia(bytes) { return new TextDecoder().decode(bytes); }
      export function buildPresentation(id) { return { id, width: 600 }; }
      export class PptxViewer {
        constructor(container, options) {
          this.container = container;
          this.record = { destroyed: false, scrollContainer: options.scrollContainer };
          fixture.instances.push(this.record);
        }
        load(presentation) { this.record.id = presentation.id; }
        async renderList() {
          const id = this.record.id;
          fixture.started.push(id);
          if (fixture.hold.delete(id)) {
            await new Promise((resolve) => fixture.pending.set(id, resolve));
          }
          if (id === "error") throw new Error("deck render failed");
          const slide = document.createElement("div");
          slide.dataset.slideIndex = "0";
          const frame = document.createElement("div");
          frame.textContent = id;
          slide.append(frame);
          this.container.append(slide);
          fixture.completed.push(id);
        }
        destroy() { this.record.destroyed = true; this.container.replaceChildren(); }
      }
    `,
  }));
}

async function installLifetimeRecords(page, observerName) {
  await page.addInitScript((name) => {
    const fixture = window.documentRenderer = {
      started: [], completed: [], hold: new Set(), pending: new Map(),
      instances: [], observers: [],
    };
    const NativeObserver = window[name];
    window[name] = class extends NativeObserver {
      records = [];
      observe(target, options) {
        const record = { target, active: true };
        this.records.push(record);
        fixture.observers.push(record);
        return super.observe(target, options);
      }
      disconnect() {
        for (const record of this.records) record.active = false;
        return super.disconnect();
      }
    };
  }, observerName);
}
