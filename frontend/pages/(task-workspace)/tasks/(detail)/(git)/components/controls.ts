import { html, LitElement } from "lit";
import {
  type ActionHintScopeOptions,
  type ActionHintTarget,
  buttonActionHintTarget,
  emptyActionHintScope,
  hasActionHintLayoutBox,
  selectActionHintTarget,
} from "#app/action-hint-scope.js";
import { ACTION_HINT_ACTION } from "#app/action-hints.js";
import type { GitRef } from "#app/api.ts";
import { busySpin, compactIconButton } from "#app/component-styles.ts";
import { inlineIcon, warmIcons } from "#components/icons.ts";
import type { FetchState } from "../(log)/layout.ts";

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

export class CaffoldGitReviewControls extends LitElement {
  static properties = {
    snapshot: { attribute: false },
  };

  declare snapshot: GitControlsSnapshot;
  private readonly iconsReady = () => this.requestUpdate();

  constructor() {
    super();
    this.snapshot = IDLE_CONTROLS;
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    void warmIcons();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
  }

  render() {
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
            id="caffold-compare-head-ref"
            data-compare-ref="head"
            aria-label="Head ref"
            title=${snapshot.headRef}
            @change=${this.changeRefs}
          >${options}</select>
        </div>
        <button
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
  updated() {
    const { baseRef, headRef } = this.snapshot;
    for (const [select, value] of [
      [this.baseRefSelect, baseRef],
      [this.headRefSelect, headRef],
    ] as const) {
      if (select && select.value !== value) {
        select.value = value;
      }
    }
  }

  actionHintScope({
    scopeId = "git",
    clipRoots = [],
  }: ActionHintScopeOptions = {}) {
    if (this.hidden) {
      return emptyActionHintScope();
    }
    const targetClipRoots = [this, ...clipRoots];
    const compareRefsShown = () =>
      this.compareRefs?.hidden === false &&
      this.snapshot.mode === "compare" &&
      this.snapshot.refs.length > 0;
    const targets: ActionHintTarget[] = !compareRefsShown()
      ? []
      : (
          [
            ["base", this.baseRefSelect, "Base"],
            ["head", this.headRefSelect, "Head"],
          ] as const
        ).flatMap(([kind, control, label]) => {
          if (!control || !gitRefSelectAvailable(control)) {
            return [];
          }
          const value = control.value;
          return [
            selectActionHintTarget({
              invalidationOwner: this,
              id: `${scopeId}:compare-ref:${kind}`,
              actionId: ACTION_HINT_ACTION.CONTROL_SELECT_OPEN,
              label: value
                ? `Choose ${label} ref (current ${value})`
                : `Choose ${label} ref`,
              control,
              clipRoots: targetClipRoots,
              isActionable: () =>
                this.isConnected &&
                !this.hidden &&
                compareRefsShown() &&
                (kind === "base" ? this.baseRefSelect : this.headRefSelect) ===
                  control &&
                gitRefSelectAvailable(control),
            }),
          ];
        });
    const control = this.refreshButton;
    if (control && !control.disabled) {
      targets.push(
        buttonActionHintTarget({
          invalidationOwner: this,
          id: `${scopeId}:refresh`,
          actionId: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
          label: control.getAttribute("aria-label") || "Refresh Git",
          control,
          clipRoots: targetClipRoots,
          isActionable: () =>
            this.isConnected &&
            !this.hidden &&
            this.refreshButton === control &&
            !control.disabled,
        }),
      );
    }
    return {
      blocked: false,
      targets,
      mutationRoots: [this],
      scrollRoots: [],
    };
  }

  private changeRefs() {
    this.dispatchEvent(
      new CustomEvent("caffold:change-compare-refs", {
        bubbles: true,
        detail: {
          baseRef: this.baseRefSelect?.value ?? "",
          headRef: this.headRefSelect?.value ?? "",
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

  private get compareRefs() {
    return this.querySelector<HTMLElement>(".review-compare-ref-controls");
  }

  private get baseRefSelect() {
    return this.querySelector<HTMLSelectElement>(
      'select[data-compare-ref="base"]',
    );
  }

  private get headRefSelect() {
    return this.querySelector<HTMLSelectElement>(
      'select[data-compare-ref="head"]',
    );
  }

  private get refreshButton() {
    return this.querySelector<HTMLButtonElement>(".git-review-refresh");
  }
}

await compactIconButton.register(
  "caffold-git-review-controls",
  "> .git-review-controls > .git-review-refresh",
);

await busySpin.register(
  "caffold-git-review-controls",
  "> .git-review-controls > .git-review-refresh.is-refreshing > .git-review-refresh-icon",
);

customElements.define("caffold-git-review-controls", CaffoldGitReviewControls);

function gitRefSelectAvailable(control: HTMLSelectElement) {
  return (
    !control.disabled && !control.hidden && hasActionHintLayoutBox(control)
  );
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
