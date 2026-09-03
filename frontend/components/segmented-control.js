import {
  buttonActionHintTarget,
  emptyActionHintScope,
} from "../action-hint-scope.js";

class CaffoldSegmentedControl extends HTMLElement {
  connectedCallback() {
    this.ensureState();
    this.addEventListener("click", this.boundClick);
    this.patch();
  }

  disconnectedCallback() {
    this.removeEventListener("click", this.boundClick);
  }

  ensureState() {
    if (this.stateReady) {
      return;
    }
    this.stateReady = true;
    this.snapshot = { label: "Options", selected: "", choices: [] };
    this.boundClick = (event) => this.handleClick(event);
  }

  setSnapshot(snapshot = {}) {
    this.ensureState();
    const seen = new Set();
    const choices = Array.isArray(snapshot.choices)
      ? snapshot.choices
          .map((choice) => ({
            value: `${choice?.value ?? ""}`,
            label: `${choice?.label ?? ""}`,
            title: `${choice?.title ?? ""}`,
          }))
          .filter((choice) => {
            if (!choice.value || !choice.label || seen.has(choice.value)) {
              return false;
            }
            seen.add(choice.value);
            return true;
          })
      : [];
    const next = {
      label: `${snapshot.label ?? "Options"}`,
      selected: `${snapshot.selected ?? ""}`,
      choices,
    };
    const nextKey = JSON.stringify(next);
    if (this.snapshotKey === nextKey) {
      return;
    }
    this.snapshot = next;
    this.snapshotKey = nextKey;
    this.patch();
  }

  actionHintScope({
    scopeId = "",
    actionId = "",
    clipRoots = [],
    labelForChoice = (choice) => `Select ${choice.label}`,
  } = {}) {
    this.ensureState();
    if (!scopeId || !actionId || this.hidden) {
      return emptyActionHintScope();
    }
    const targets = this.snapshot.choices.flatMap((choice) => {
      const value = choice.value;
      const control = this.querySelector(
        `:scope > button[data-segmented-value="${CSS.escape(value)}"]`,
      );
      if (!control || value === this.snapshot.selected || control.disabled) {
        return [];
      }
      return [buttonActionHintTarget({
        invalidationOwner: this,
        id: `${scopeId}:choice:${encodeURIComponent(value)}`,
        actionId,
        label: `${labelForChoice(choice) ?? ""}` || choice.label,
        control,
        clipRoots: [...clipRoots],
        isActionable: () =>
          this.isConnected &&
          !this.hidden &&
          this.snapshot.selected !== value &&
          this.querySelector(
            `:scope > button[data-segmented-value="${CSS.escape(value)}"]`,
          ) === control &&
          !control.disabled,
      })];
    });
    return {
      blocked: false,
      targets,
      mutationRoots: [this],
      scrollRoots: [],
    };
  }

  handleClick(event) {
    const button = event.target instanceof Element
      ? event.target.closest("button[data-segmented-value]")
      : null;
    if (!button || button.parentElement !== this || button.disabled) {
      return;
    }
    this.dispatchEvent(
      new CustomEvent("caffold:segmented-control-intent", {
        bubbles: true,
        composed: true,
        detail: { value: button.dataset.segmentedValue },
      }),
    );
  }

  patch() {
    this.ensureState();
    this.setAttribute("role", "group");
    this.setAttribute("aria-label", this.snapshot.label);

    const existing = new Map(
      [...this.querySelectorAll(":scope > button[data-segmented-value]")].map(
        (button) => [button.dataset.segmentedValue, button],
      ),
    );
    let nextSibling = this.firstElementChild;
    for (const choice of this.snapshot.choices) {
      const button = existing.get(choice.value) ?? document.createElement("button");
      existing.delete(choice.value);
      button.type = "button";
      button.dataset.segmentedValue = choice.value;
      button.setAttribute(
        "aria-pressed",
        `${choice.value === this.snapshot.selected}`,
      );
      if (choice.title) {
        button.title = choice.title;
      } else {
        button.removeAttribute("title");
      }
      let label = button.querySelector(":scope > span");
      if (!label) {
        label = document.createElement("span");
        button.replaceChildren(label);
      }
      if (label.textContent !== choice.label) {
        label.textContent = choice.label;
      }
      if (button === nextSibling) {
        nextSibling = nextSibling.nextElementSibling;
      } else {
        this.insertBefore(button, nextSibling);
      }
    }
    for (const button of existing.values()) {
      button.remove();
    }
    this.toggleAttribute("data-empty", this.snapshot.choices.length === 0);
  }
}

if (!customElements.get("caffold-segmented-control")) {
  customElements.define("caffold-segmented-control", CaffoldSegmentedControl);
}
