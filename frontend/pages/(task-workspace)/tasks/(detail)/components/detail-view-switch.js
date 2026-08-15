class CaffoldDetailViewSwitch extends HTMLElement {
  connectedCallback() {
    this.ensureState();
    this.addEventListener("click", this.boundClick);
    this.render();
  }

  disconnectedCallback() {
    this.removeEventListener("click", this.boundClick);
  }

  ensureState() {
    if (this.stateReady) {
      return;
    }
    this.stateReady = true;
    this.snapshot = { label: "Detail view", selected: "", choices: [] };
    this.boundClick = (event) => this.handleClick(event);
  }

  setSnapshot(snapshot = {}) {
    this.ensureState();
    const choices = Array.isArray(snapshot.choices)
      ? snapshot.choices
          .map((choice) => ({
            id: `${choice?.id ?? ""}`,
            label: `${choice?.label ?? ""}`,
            title: `${choice?.title ?? ""}`,
          }))
          .filter((choice) => choice.id && choice.label)
      : [];
    const next = {
      label: `${snapshot.label ?? "Detail view"}`,
      selected: `${snapshot.selected ?? ""}`,
      choices,
    };
    const nextKey = JSON.stringify(next);
    if (this.snapshotKey === nextKey) {
      return;
    }
    const canPatch =
      choices.length === this.snapshot.choices.length &&
      choices.every((choice, index) => choice.id === this.snapshot.choices[index]?.id) &&
      this.querySelectorAll(":scope > button[data-detail-view]").length === choices.length;
    this.snapshot = next;
    this.snapshotKey = nextKey;
    if (canPatch) {
      this.patch();
    } else {
      this.render();
    }
  }

  handleClick(event) {
    const button = event.target instanceof Element
      ? event.target.closest("button[data-detail-view]")
      : null;
    if (!button || !this.contains(button)) {
      return;
    }
    this.dispatchEvent(
      new CustomEvent("caffold:detail-view-switch-intent", {
        bubbles: true,
        composed: true,
        detail: { view: button.dataset.detailView },
      }),
    );
  }

  render() {
    this.ensureState();
    this.setAttribute("role", "group");
    this.setAttribute("aria-label", this.snapshot.label);
    this.innerHTML = this.snapshot.choices
      .map(
        (choice) => `<button
          type="button"
          data-detail-view="${escapeAttribute(choice.id)}"
          aria-pressed="${choice.id === this.snapshot.selected}"
          ${choice.title ? `title="${escapeAttribute(choice.title)}"` : ""}
        ><span>${escapeHtml(choice.label)}</span></button>`,
      )
      .join("");
    this.toggleAttribute("hidden", this.snapshot.choices.length < 2);
  }

  patch() {
    const buttons = [...this.querySelectorAll(":scope > button[data-detail-view]")];
    this.snapshot.choices.forEach((choice, index) => {
      const button = buttons[index];
      button.setAttribute(
        "aria-pressed",
        `${choice.id === this.snapshot.selected}`,
      );
      if (choice.title) {
        button.title = choice.title;
      } else {
        button.removeAttribute("title");
      }
      const label = button.querySelector(":scope > span");
      if (label && label.textContent !== choice.label) {
        label.textContent = choice.label;
      }
    });
    this.toggleAttribute("hidden", this.snapshot.choices.length < 2);
  }
}

if (!customElements.get("caffold-detail-view-switch")) {
  customElements.define("caffold-detail-view-switch", CaffoldDetailViewSwitch);
}

function escapeHtml(value) {
  const element = document.createElement("span");
  element.textContent = `${value ?? ""}`;
  return element.innerHTML;
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll('"', "&quot;");
}
