import { html, LitElement, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import {
  type ActionHintScope,
  type ActionHintScopeOptions,
  buttonActionHintTarget,
  emptyActionHintScope,
} from "../action-hint-scope.js";

export interface SegmentedChoice {
  value: string;
  label: string;
  title: string;
}

interface SegmentedSnapshot {
  label: string;
  selected: string;
  choices: SegmentedChoice[];
}

export class CaffoldSegmentedControl extends LitElement {
  static properties = {
    // An equivalent snapshot leaves the control as it is.
    snapshot: {
      state: true,
      hasChanged: (next: unknown, previous: unknown) =>
        JSON.stringify(next) !== JSON.stringify(previous),
    },
  };

  declare private snapshot: SegmentedSnapshot;

  constructor() {
    super();
    this.snapshot = { label: "Options", selected: "", choices: [] };
  }

  createRenderRoot() {
    return this;
  }

  render() {
    const { selected, choices } = this.snapshot;
    return repeat(
      choices,
      (choice) => choice.value,
      (choice) =>
        html`<button
          type="button"
          data-segmented-value=${choice.value}
          aria-pressed=${choice.value === selected ? "true" : "false"}
          title=${choice.title || nothing}
          @click=${() => this.choose(choice.value)}
        ><span>${choice.label}</span></button>`,
    );
  }

  updated() {
    this.setAttribute("role", "group");
    this.setAttribute("aria-label", this.snapshot.label);
    this.toggleAttribute("data-empty", this.snapshot.choices.length === 0);
  }

  setSnapshot(
    snapshot: {
      label?: string;
      selected?: string;
      choices?: Array<Partial<SegmentedChoice> | null | undefined>;
    } = {},
  ) {
    const seen = new Set<string>();
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
    this.snapshot = {
      label: `${snapshot.label ?? "Options"}`,
      selected: `${snapshot.selected ?? ""}`,
      choices,
    };
    this.performUpdate();
  }

  actionHintScope({
    scopeId = "",
    actionId = "",
    clipRoots = [],
    labelForChoice = (choice) => `Select ${choice.label}`,
  }: ActionHintScopeOptions & {
    labelForChoice?: (choice: SegmentedChoice) => string;
  } = {}): ActionHintScope {
    if (!scopeId || !actionId || this.hidden) {
      return emptyActionHintScope();
    }
    const targets = this.snapshot.choices.flatMap((choice) => {
      const value = choice.value;
      const control = this.querySelector<HTMLButtonElement>(
        `:scope > button[data-segmented-value="${CSS.escape(value)}"]`,
      );
      if (!control || value === this.snapshot.selected || control.disabled) {
        return [];
      }
      return [
        buttonActionHintTarget({
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
        }),
      ];
    });
    return {
      blocked: false,
      targets,
      mutationRoots: [this],
      scrollRoots: [],
    };
  }

  private choose(value: string) {
    this.dispatchEvent(
      new CustomEvent("caffold:segmented-control-intent", {
        bubbles: true,
        composed: true,
        detail: { value },
      }),
    );
  }
}

customElements.define("caffold-segmented-control", CaffoldSegmentedControl);
