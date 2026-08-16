import { renderInlineIcon, warmIcons } from "../../../../../../components/icons.js";

class CaffoldGitReviewControls extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
    if (this.listeningForIcons) {
      return;
    }

    this.listeningForIcons = true;
    this.boundIconsReady ??= () => this.renderRefreshIcon();
    window.addEventListener("caffold:icons-ready", this.boundIconsReady);
    warmIcons();
  }

  disconnectedCallback() {
    if (!this.listeningForIcons) {
      return;
    }

    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
    this.listeningForIcons = false;
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }

    this.rendered = true;
    this.innerHTML = `
      <div class="git-review-controls">
        <div class="review-compare-ref-controls" aria-label="Compare refs" hidden>
          <label for="caffold-compare-base-ref">Base</label>
          <select
            id="caffold-compare-base-ref"
            data-compare-ref="base"
            aria-label="Base ref"
          ></select>
          <span class="review-compare-ref-separator" aria-hidden="true">...</span>
          <label for="caffold-compare-head-ref">Head</label>
          <select
            id="caffold-compare-head-ref"
            data-compare-ref="head"
            aria-label="Head ref"
          ></select>
        </div>
        <button
          type="button"
          class="git-review-refresh"
          aria-label="Refresh Git"
          title="Refresh Git"
        ></button>
      </div>
    `;
    this.compareRefs = this.querySelector(".review-compare-ref-controls");
    this.baseRefSelect = this.querySelector('select[data-compare-ref="base"]');
    this.headRefSelect = this.querySelector('select[data-compare-ref="head"]');
    this.refreshButton = this.querySelector(".git-review-refresh");
    this.refreshButton.addEventListener("click", () => {
      const eventName = this.snapshot?.action === "fetch"
        ? "caffold:fetch-git-remote"
        : "caffold:refresh-git-review";
      this.dispatchEvent(
        new CustomEvent(eventName, {
          bubbles: true,
        }),
      );
    });
    this.compareRefs.addEventListener("change", (event) => {
      if (!event.target.matches("select[data-compare-ref]")) {
        return;
      }

      this.dispatchEvent(
        new CustomEvent("caffold:change-compare-refs", {
          bubbles: true,
          detail: {
            baseRef: this.baseRefSelect.value,
            headRef: this.headRefSelect.value,
          },
        }),
      );
    });
    this.renderRefreshIcon();
  }

  setSnapshot(snapshot) {
    this.ensureRendered();
    const next = normalizeSnapshot(snapshot);
    const refsKey = refsFingerprint(next.refs);
    if (refsKey !== this.refsKey) {
      this.refsKey = refsKey;
      replaceRefOptions(this.baseRefSelect, next.refs);
      replaceRefOptions(this.headRefSelect, next.refs);
    }

    this.baseRefSelect.value = next.baseRef;
    this.baseRefSelect.title = next.baseRef;
    this.headRefSelect.value = next.headRef;
    this.headRefSelect.title = next.headRef;
    this.compareRefs.hidden = next.mode !== "compare" || next.refs.length === 0;

    const fetching = next.action === "fetch" && next.fetchState.status === "fetching";
    const refreshing = next.action === "refresh" && next.refreshState === "refreshing";
    const unavailable = next.refreshState === "unavailable";
    const title = actionTitle(next, unavailable);
    this.refreshButton.classList.toggle("is-refreshing", fetching || refreshing);
    this.refreshButton.classList.toggle(
      "is-error",
      next.action === "fetch" && next.fetchState.status === "error",
    );
    this.refreshButton.classList.toggle("is-unavailable", unavailable);
    this.refreshButton.disabled = fetching;
    this.refreshButton.setAttribute("aria-label", title);
    this.refreshButton.setAttribute("title", title);
    this.snapshot = next;
    this.renderRefreshIcon();
  }

  renderRefreshIcon() {
    this.ensureRendered();
    const label = this.snapshot?.action === "fetch" ? "Fetch remote" : "Refresh Git review";
    this.refreshButton.innerHTML = renderInlineIcon(
      "RefreshCw",
      label,
      "git-review-refresh-icon",
    );
  }
}

customElements.define("caffold-git-review-controls", CaffoldGitReviewControls);

function normalizeSnapshot(snapshot) {
  const mode =
    snapshot?.mode === "compare" || snapshot?.mode === "log"
      ? snapshot.mode
      : snapshot?.mode === "diff"
        ? "diff"
        : null;
  return {
    mode,
    action: snapshot?.action === "fetch" ? "fetch" : "refresh",
    fetchState: normalizeFetchState(snapshot?.fetchState),
    refs: Array.isArray(snapshot?.refs) ? snapshot.refs : [],
    baseRef: snapshot?.baseRef ?? "",
    headRef: snapshot?.headRef ?? "",
    refreshState:
      snapshot?.refreshState === "refreshing" || snapshot?.refreshState === "unavailable"
        ? snapshot.refreshState
        : "idle",
  };
}

function normalizeFetchState(state) {
  return state?.status === "fetching" || state?.status === "ready" || state?.status === "error"
    ? state
    : { status: "idle" };
}

function actionTitle(snapshot, unavailable) {
  if (snapshot.action !== "fetch") {
    return unavailable
      ? "Live updates unavailable. Refresh manually."
      : `Refresh ${snapshot.mode ?? "Git"}`;
  }
  if (snapshot.fetchState.status === "fetching") {
    return "Fetching remote default branch";
  }
  if (snapshot.fetchState.status === "error") {
    return `Fetch failed. ${snapshot.fetchState.error?.message ?? "Try again."}`;
  }
  if (snapshot.fetchState.status === "ready") {
    const remote = snapshot.fetchState.result?.remote;
    const branch = snapshot.fetchState.result?.branch;
    return remote && branch ? `Fetch ${remote}/${branch} again` : "Fetch again";
  }
  return unavailable
    ? "Fetch remote default branch. Live updates are unavailable."
    : "Fetch remote default branch";
}

function refsFingerprint(refs) {
  return refs.map((ref) => `${ref.kind ?? ""}\u0000${ref.name ?? ""}`).join("\u0001");
}

function replaceRefOptions(select, refs) {
  const groups = [];
  let group = null;
  let lastKind = null;
  for (const ref of refs) {
    const kind = ref.kind ?? "local";
    if (kind !== lastKind) {
      group = document.createElement("optgroup");
      group.label = refKindLabel(kind);
      groups.push(group);
      lastKind = kind;
    }

    const option = document.createElement("option");
    option.value = ref.name ?? "";
    option.textContent = ref.name ?? "";
    group.append(option);
  }
  select.replaceChildren(...groups);
}

function refKindLabel(kind) {
  if (kind === "head") {
    return "Current";
  }

  return kind === "remote" ? "Remote" : "Local";
}
