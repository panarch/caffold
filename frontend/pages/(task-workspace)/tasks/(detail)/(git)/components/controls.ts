import { html, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
} from "#app/action-hints.js";
import type { GitRef } from "#app/api.js";
import { busySpin, compactIconButton } from "#app/component-styles.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";
import { inlineIcon, warmIcons } from "#components/icons.js";
import type { FetchState } from "../(log)/layout.js";

export interface ChangeCompareRefsDetail {
  baseRef: string;
  headRef: string;
}

// What the Git header's controls show for the open route.
export interface GitControlsSnapshot {
  mode: "compare" | "log" | null;
  action: "fetch" | "refresh";
  fetchState: FetchState;
  refs: GitRef[];
  baseRef: string;
  headRef: string;
  refreshState: "idle" | "refreshing" | "unavailable";
}

export const IDLE_CONTROLS: GitControlsSnapshot = {
  mode: null,
  action: "refresh",
  fetchState: { status: "idle" },
  refs: [],
  baseRef: "",
  headRef: "",
  refreshState: "idle",
};

await compactIconButton.register(
  "caffold-git-review-controls",
  "> .git-review-controls > .git-review-refresh",
);
await busySpin.register(
  "caffold-git-review-controls",
  "> .git-review-controls > .git-review-refresh.is-refreshing > .git-review-refresh-icon",
);

@customElement("caffold-git-review-controls")
export class CaffoldGitReviewControls extends LitElement {
  @property({ attribute: false })
  accessor snapshot: GitControlsSnapshot = IDLE_CONTROLS;

  private readonly iconsReady = () => this.requestUpdate();
  private readonly hints = new ActionHints(this, {
    clipRoots: () => [this],
  });
  private readonly baseRefSelect = new DrawnRef<HTMLSelectElement>(this);
  private readonly headRefSelect = new DrawnRef<HTMLSelectElement>(this);

  override createRenderRoot() {
    return this;
  }

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
    const fetching =
      snapshot.action === "fetch" && snapshot.fetchState.status === "fetching";
    const refreshing =
      snapshot.action === "refresh" && snapshot.refreshState === "refreshing";
    const failed =
      snapshot.action === "fetch" && snapshot.fetchState.status === "error";
    const unavailable = snapshot.refreshState === "unavailable";
    const title = actionTitle(snapshot, unavailable);
    const buttonClass = [
      "git-review-refresh",
      fetching || refreshing ? "is-refreshing" : "",
      failed ? "is-error" : "",
      unavailable ? "is-unavailable" : "",
    ]
      .filter(Boolean)
      .join(" ");
    const iconLabel =
      snapshot.action === "fetch" ? "Fetch remote" : "Refresh Git review";
    const icon = inlineIcon("RefreshCw", iconLabel, "git-review-refresh-icon");
    const options = refGroups(snapshot.refs).map(
      (group) => html`<optgroup label=${refKindLabel(group.kind)}>
        ${group.refs.map(
          (ref) => html`<option value=${ref.name}>${ref.name}</option>`,
        )}
      </optgroup>`,
    );
    return html`
      <div class="git-review-controls">
        <div
          class="review-compare-ref-controls"
          aria-label="Compare refs"
          ?hidden=${snapshot.mode !== "compare" || snapshot.refs.length === 0}
        >
          <label for="caffold-compare-base-ref">Base</label>
          <select
            ${drawn(this.baseRefSelect)}
            ${this.hints.select({
              id: "compare-ref:base",
              label: refLabel("Base", snapshot.baseRef),
              action: ACTION_HINT_ACTION.CONTROL_SELECT_OPEN,
            })}
            id="caffold-compare-base-ref"
            data-compare-ref="base"
            aria-label="Base ref"
            title=${snapshot.baseRef}
            @change=${this.changeRefs}
          >${options}</select>
          <span
            class="review-compare-ref-separator"
            aria-hidden="true"
          >...</span>
          <label for="caffold-compare-head-ref">Head</label>
          <select
            ${drawn(this.headRefSelect)}
            ${this.hints.select({
              id: "compare-ref:head",
              label: refLabel("Head", snapshot.headRef),
              action: ACTION_HINT_ACTION.CONTROL_SELECT_OPEN,
            })}
            id="caffold-compare-head-ref"
            data-compare-ref="head"
            aria-label="Head ref"
            title=${snapshot.headRef}
            @change=${this.changeRefs}
          >${options}</select>
        </div>
        <button
          ${this.hints.button({
            id: "refresh",
            label: title,
            action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
          })}
          type="button"
          class=${buttonClass}
          aria-label=${title}
          title=${title}
          ?disabled=${fetching}
          @click=${this.requestRefresh}
        >${icon}</button>
      </div>
    `;
  }

  // A `.value` binding would land before the options it names.
  override updated() {
    const { baseRef, headRef } = this.snapshot;
    for (const [select, value] of [
      [this.baseRefSelect.value, baseRef],
      [this.headRefSelect.value, headRef],
    ] as const) {
      if (select && select.value !== value) {
        select.value = value;
      }
    }
  }

  actionHintScope({ scopeId = "git", ...pull }: ActionHintPull = {}) {
    return this.hints.scope({ ...pull, scopeId });
  }

  private changeRefs() {
    this.dispatchEvent(
      new CustomEvent<ChangeCompareRefsDetail>("caffold:change-compare-refs", {
        bubbles: true,
        detail: {
          baseRef: this.baseRefSelect.value?.value ?? "",
          headRef: this.headRefSelect.value?.value ?? "",
        },
      }),
    );
  }

  private requestRefresh() {
    this.dispatchEvent(
      new CustomEvent(
        this.snapshot.action === "fetch"
          ? "caffold:fetch-git-remote"
          : "caffold:refresh-git-review",
        { bubbles: true },
      ),
    );
  }
}

function refLabel(name: string, ref: string) {
  return ref ? `Choose ${name} ref (current ${ref})` : `Choose ${name} ref`;
}

function actionTitle(snapshot: GitControlsSnapshot, unavailable: boolean) {
  const { fetchState } = snapshot;
  if (snapshot.action !== "fetch") {
    return unavailable
      ? "Live updates unavailable. Refresh manually."
      : `Refresh ${snapshot.mode ?? "Git"}`;
  }
  if (fetchState.status === "fetching") {
    return "Fetching remote default branch";
  }
  if (fetchState.status === "error") {
    return `Fetch failed. ${fetchState.error?.message ?? "Try again."}`;
  }
  if (fetchState.status === "ready") {
    const { remote, branch } = fetchState.result;
    return remote && branch ? `Fetch ${remote}/${branch} again` : "Fetch again";
  }
  return unavailable
    ? "Fetch remote default branch. Live updates are unavailable."
    : "Fetch remote default branch";
}

// Consecutive refs of one kind share an option group.
function refGroups(refs: GitRef[]) {
  const groups: Array<{ kind: string; refs: GitRef[] }> = [];
  for (const ref of refs) {
    const kind = ref.kind ?? "local";
    const group = groups.at(-1);
    if (group?.kind === kind) {
      group.refs.push(ref);
    } else {
      groups.push({ kind, refs: [ref] });
    }
  }
  return groups;
}

function refKindLabel(kind: string) {
  if (kind === "head") {
    return "Current";
  }
  return kind === "remote" ? "Remote" : "Local";
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-git-review-controls": CaffoldGitReviewControls;
  }

  interface HTMLElementEventMap {
    "caffold:change-compare-refs": CustomEvent<ChangeCompareRefsDetail>;
  }
}
