import { renderInlineIcon, warmIcons } from "../../../../../../../components/icons.js";

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
      this.dispatchEvent(
        new CustomEvent("caffold:refresh-git-review", {
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

    const refreshing = next.refreshState === "refreshing";
    const unavailable = next.refreshState === "unavailable";
    const title = unavailable
      ? "Live updates unavailable. Refresh manually."
      : `Refresh ${next.mode ?? "Git"}`;
    this.refreshButton.classList.toggle("is-refreshing", refreshing);
    this.refreshButton.classList.toggle("is-unavailable", unavailable);
    this.refreshButton.setAttribute("aria-label", title);
    this.refreshButton.setAttribute("title", title);
    this.snapshot = next;
  }

  renderRefreshIcon() {
    this.ensureRendered();
    this.refreshButton.innerHTML = renderInlineIcon(
      "RefreshCw",
      "Refresh Git review",
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
    refs: Array.isArray(snapshot?.refs) ? snapshot.refs : [],
    baseRef: snapshot?.baseRef ?? "",
    headRef: snapshot?.headRef ?? "",
    refreshState:
      snapshot?.refreshState === "refreshing" || snapshot?.refreshState === "unavailable"
        ? snapshot.refreshState
        : "idle",
  };
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
