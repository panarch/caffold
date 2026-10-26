import { html, LitElement } from "lit";
import { ACTION_HINT_ACTION, ActionHints } from "../../action-hints.ts";
import type { CaffoldUpdateAttempt } from "../../api.ts";
import { DrawnRef, drawn } from "../../components/drawn-refs.ts";
import { KeyboardContexts } from "../../keyboard-navigation.ts";
import "../../keyboard-navigation/components/presentation.ts";

type UpdateResultNotice = { title: string; description: string };

/**
 * Tells this browser that an update of Caffold did not stick. It only
 * informs, so its one button closes it.
 */
export class CaffoldUpdateResultDialog extends LitElement {
  static properties = {
    notice: { state: true },
  };

  declare private notice: UpdateResultNotice | null;
  private readonly hints = new ActionHints(this, () => this.performUpdate());
  private readonly keyboard = new KeyboardContexts(this, () =>
    this.performUpdate(),
  );
  private readonly dialog = new DrawnRef<HTMLDialogElement>(this);

  constructor() {
    super();
    this.notice = null;
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.performUpdate();
  }

  render() {
    return html`
      <dialog
        ${drawn(this.dialog)}
        ${this.keyboard.modal({ id: "app:update-result" })}
        closedby="any"
        aria-labelledby="caffold-update-result-title"
        aria-describedby="caffold-update-result-description"
      >
        <form method="dialog" class="update-result-dialog-card">
          <h2 id="caffold-update-result-title">${this.notice?.title}</h2>
          <p id="caffold-update-result-description">
            ${this.notice?.description}
          </p>
          <footer>
            <button
              ${this.hints.button({
                id: "ok",
                label: "OK",
                action: ACTION_HINT_ACTION.DIALOG_BUTTON,
              })}
              type="submit"
              value="ok"
              autofocus
            >OK</button>
          </footer>
        </form>
        <caffold-keyboard-navigation-presentation
          ${this.keyboard.presentation()}
        ></caffold-keyboard-navigation-presentation>
      </dialog>
    `;
  }

  /** Shows what happened to the attempt, which must have failed. */
  open(attempt: CaffoldUpdateAttempt | null | undefined) {
    const notice = updateResultNotice(attempt);
    if (!notice) {
      return;
    }
    this.notice = notice;
    this.performUpdate();
    const dialog = this.dialog.value;
    if (!dialog || dialog.open) {
      return;
    }
    dialog.showModal();
  }

  keyboardNavigationContexts() {
    return this.keyboard.contexts({
      actionHints: (pull) => this.hints.scope(pull),
    });
  }
}

/**
 * The title and sentence for an attempt that ended with Caffold not updated
 * and not running as planned. Other outcomes are told elsewhere.
 */
export function updateResultNotice(
  attempt: CaffoldUpdateAttempt | null | undefined,
): UpdateResultNotice | null {
  const from = `${attempt?.fromVersion ?? ""}`;
  const reason = `${attempt?.reason ?? ""}`;
  const details = "See Settings → About Caffold for details.";
  if (attempt?.outcome === "rolledBack") {
    return {
      title: "Caffold update was rolled back",
      description: `${reason}, so Caffold ${from} was restored. ${details}`,
    };
  }
  if (attempt?.outcome === "restoreFailed") {
    return {
      title: "Caffold update failed",
      description: `${reason}. ${details}`,
    };
  }
  return null;
}

customElements.define(
  "caffold-update-result-dialog",
  CaffoldUpdateResultDialog,
);
