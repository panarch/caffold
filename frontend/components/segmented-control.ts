import { html, LitElement, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { type ActionHintPull, ActionHints } from "../action-hints.js";

export interface SegmentedChoice {
  value: string;
  label: string;
  title: string;
}

interface SegmentedSnapshot {
  label: string;
  selected: string;
  choices: SegmentedChoice[];
  // What an Action Hint for a choice says before its label.
  actionVerb: string;
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

  private readonly hints = new ActionHints(this);

  constructor() {
    super();
    this.snapshot = {
      label: "Options",
      selected: "",
      choices: [],
      actionVerb: "Select",
    };
  }

  createRenderRoot() {
    return this;
  }

  render() {
    const { selected, choices, actionVerb } = this.snapshot;
    return repeat(
      choices,
      (choice) => choice.value,
      (choice) =>
        html`<button
          ${this.hints.button({
            id: `choice:${encodeURIComponent(choice.value)}`,
            label: `${actionVerb} ${choice.label}`,
            when: choice.value !== selected,
          })}
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
      actionVerb?: string;
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
      actionVerb: `${snapshot.actionVerb ?? "Select"}`,
    };
  }

  actionHintScope(pull: ActionHintPull = {}) {
    return this.hints.scope(pull);
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
