import { html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { type ActionHintPull, ActionHints } from "#app/action-hints.js";
import { CaffoldElement } from "#app/caffold-element.js";
import { scopedStyle } from "#app/scoped-style.js";
import { type ScrollSurfacePull, ScrollSurfaces } from "#app/scroll-scope.js";

import compactIconButton from "#app/component-styles/compact-icon-button.css.js";
import "#components/loading-text.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";
import { inlineIcon, warmIcons } from "#components/icons.js";
import type { ReviewFindKind } from "../layout/route.js";

import styles from "./places.css.js";

// A place a language server answered with, as Review opens it: its Review
// file path, or null outside Caffold's root where only the file name is
// known.
export interface ReviewPlace {
  path: string | null;
  fileName: string;
  line: number;
  character: number;
  length: number | null;
  text: string | null;
}

// The places of one file, in the order the server gave them.
export interface ReviewPlaceGroup {
  key: string;
  fileName: string;
  folder: string;
  places: ReviewPlace[];
}

export type ReviewPlacesSnapshot = {
  kind: ReviewFindKind;
  name: string;
  // The place the viewer shows now.
  selected: { path: string; line: number | null } | null;
} & (
  | { status: "loading" }
  | { status: "ready"; places: ReviewPlace[] }
  | { status: "failed"; message: string }
);

export interface ReviewPlaceOpenDetail {
  path: string;
  line: number;
}

const TITLES: Record<ReviewFindKind, string> = {
  references: "References",
  definitions: "Definitions",
};

const EMPTY: Record<ReviewFindKind, string> = {
  references: "No references found.",
  definitions: "No definition found.",
};

export function reviewFindTitle(kind: ReviewFindKind) {
  return TITLES[kind];
}

// Groups places by file in the order each file first appears.
export function groupReviewPlaces(places: readonly ReviewPlace[]) {
  const groups = new Map<string, ReviewPlaceGroup>();
  for (const place of places) {
    const key = place.path ?? `\u0000${place.fileName}`;
    let group = groups.get(key);
    if (!group) {
      const slash = place.path?.lastIndexOf("/") ?? -1;
      group = {
        key,
        fileName: place.fileName,
        folder:
          place.path && slash >= 0 ? place.path.slice(0, slash) || "/" : "",
        places: [],
      };
      groups.set(key, group);
    }
    group.places.push(place);
  }
  return [...groups.values()];
}

/**
 * The places Review lists for a name in place of its navigator: where the
 * name is used, or where it is defined when that is more than one place.
 * Choosing one asks Review to open it; its close button asks Review to put
 * the navigator back.
 */
@customElement("caffold-review-places")
export class CaffoldReviewPlaces extends CaffoldElement {
  @property({ attribute: false })
  accessor snapshot: ReviewPlacesSnapshot | null = null;

  static override styles = [
    scopedStyle(compactIconButton, ".review-places-close"),
    styles,
  ];

  private readonly hints = new ActionHints(this);
  private readonly surfaces = new ScrollSurfaces(this);
  private readonly scrollport = new DrawnRef<HTMLElement>(this);
  private readonly iconsReady = () => this.requestUpdate();

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    void warmIcons();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
  }

  override render() {
    const snapshot = this.snapshot;
    if (!snapshot) {
      return nothing;
    }
    const count = snapshot.status === "ready" ? snapshot.places.length : null;
    const title = reviewFindTitle(snapshot.kind);
    const closeLabel = `Close ${title.toLowerCase()}`;
    return html`<header class="review-places-header">
        <div class="review-places-heading">
          <h2>${title}</h2>
          <span class="review-places-meta"
            ><code>${snapshot.name}</code>${count === null ? "" : ` · ${count}`}</span
          >
        </div>
        <button
          ${this.hints.button({ id: "close", label: closeLabel, role: "close" })}
          type="button"
          class="review-places-close"
          title=${closeLabel}
          @click=${this.close}
        >${inlineIcon("X", closeLabel, "review-places-close-icon")}</button>
      </header>
      <div
        ${drawn(this.scrollport)}
        ${this.surfaces.surface({
          id: "scroll",
          axes: ["vertical", "horizontal"],
          clipRoots: () => [this, this.scrollport.value],
        })}
        class="review-places-scroll"
      >${this.body(snapshot)}</div>`;
  }

  actionHintScope(pull: ActionHintPull = {}) {
    return this.hints.scope(pull);
  }

  scrollSurfaceScope(pull: ScrollSurfacePull = {}) {
    return this.surfaces.scope({ ...pull, label: pull.label ?? "Places" });
  }

  private body(snapshot: ReviewPlacesSnapshot) {
    if (snapshot.status === "loading") {
      return html`<p class="review-places-status">
        <caffold-loading-text>Asking the language server</caffold-loading-text>
      </p>`;
    }
    if (snapshot.status === "failed") {
      return html`<p class="review-places-status" role="alert">${snapshot.message}</p>`;
    }
    if (!snapshot.places.length) {
      return html`<p class="review-places-status">${EMPTY[snapshot.kind]}</p>`;
    }
    const selected = snapshot.selected;
    return html`<ol class="review-places-files">
      ${groupReviewPlaces(snapshot.places).map(
        (group) => html`<li class="review-places-file">
          <h3 class="review-places-file-heading">
            <span class="review-places-file-name">${group.fileName}</span>
            <span class="review-places-folder">${group.folder}</span>
            <span class="review-places-count">${group.places.length}</span>
          </h3>
          <ol class="review-places-lines">
            ${group.places.map((place) => {
              const current = Boolean(
                place.path &&
                  selected?.path === place.path &&
                  selected.line === place.line,
              );
              const key = encodeURIComponent(
                `${group.key}:${place.line}:${place.character}`,
              );
              return html`<li>
                <button
                  ${this.hints.button({
                    id: `place:${key}`,
                    label: `${group.fileName}, line ${place.line}`,
                    role: "place",
                    when: Boolean(place.path) && !current,
                  })}
                  type="button"
                  class="review-places-line"
                  data-path=${place.path ?? nothing}
                  data-line=${place.line}
                  aria-current=${current ? "true" : nothing}
                  ?disabled=${!place.path}
                  @click=${() => this.open(place)}
                ><code class="review-places-line-number">${place.line}</code
                ><code class="review-places-text">${lineText(place)}</code></button>
              </li>`;
            })}
          </ol>
        </li>`,
      )}
    </ol>`;
  }

  private open(place: ReviewPlace) {
    if (!place.path) {
      return;
    }
    this.dispatchEvent(
      new CustomEvent<ReviewPlaceOpenDetail>("caffold:review-place-open", {
        bubbles: true,
        composed: true,
        detail: { path: place.path, line: place.line },
      }),
    );
  }

  private readonly close = () => {
    this.dispatchEvent(
      new CustomEvent("caffold:review-places-close", {
        bubbles: true,
        composed: true,
      }),
    );
  };
}

// The line's code without its indentation, which would push the name out of
// view, and with the name in bold.
export function lineText({ text, character, length }: ReviewPlace) {
  if (text === null) {
    return "";
  }
  const indent = text.length - text.trimStart().length;
  const code = text.slice(indent);
  const start = character - indent;
  if (!length || start < 0 || start + length > code.length) {
    return code;
  }
  return html`${code.slice(0, start)}<strong
    >${code.slice(start, start + length)}</strong
  >${code.slice(start + length)}`;
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-review-places": CaffoldReviewPlaces;
  }

  interface HTMLElementEventMap {
    "caffold:review-place-open": CustomEvent<ReviewPlaceOpenDetail>;
  }
}
