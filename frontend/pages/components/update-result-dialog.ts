import { html, LitElement } from "lit";
import type { ActionHintScope } from "../../action-hint-scope.js";
import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
} from "../../action-hints.js";
import { keyboardNavigationContext } from "../../keyboard-navigation.js";
import "../../keyboard-navigation/components/presentation.js";
import type { CaffoldKeyboardNavigationPresentation } from "../../keyboard-navigation/components/presentation.js";

type UpdateAttempt = {
  outcome?: string;
  fromVersion?: string;
  reason?: string;
};

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
            <button type="submit" value="ok" autofocus>OK</button>
          </footer>
        </form>
        <caffold-keyboard-navigation-presentation
        ></caffold-keyboard-navigation-presentation>
      </dialog>
    `;
  }

  /** Shows what happened to the attempt, which must have failed. */
  open(attempt: UpdateAttempt | null | undefined) {
    const notice = updateResultNotice(attempt);
    if (!notice) {
      return;
    }
    this.notice = notice;
    this.performUpdate();
    const dialog = this.dialog;
    if (!dialog || dialog.open) {
      return;
    }
    dialog.showModal();
  }

  keyboardNavigationContexts() {
    const dialog = this.dialog;
    const hintDialog = dialog
      ?.querySelector<CaffoldKeyboardNavigationPresentation>(
        ":scope > caffold-keyboard-navigation-presentation",
      )
      ?.actionHintDialog();
    if (!dialog || !hintDialog) {
      return [];
    }
    return [
      keyboardNavigationContext({
        id: "app:update-result",
        kind: "modal",
        root: dialog,
        actionHints: {
          dialog: hintDialog,
          scope: this.actionHintScope(),
        },
      }),
    ];
  }

  actionHintScope(): ActionHintScope {
    const dialog = this.dialog;
    const control =
      dialog?.querySelector<HTMLButtonElement>('button[value="ok"]');
    if (!dialog || !control) {
      return emptyActionHintScope();
    }
    return {
      blocked: false,
      targets: [
        buttonActionHintTarget({
          invalidationOwner: this,
          id: "app:update-result:ok",
          actionId: ACTION_HINT_ACTION.DIALOG_BUTTON,
          label: control.textContent?.trim() || "OK",
          control,
          clipRoots: [dialog],
          isActionable: () =>
            this.isConnected &&
            this.dialog === dialog &&
            dialog.open &&
            dialog.querySelector('button[value="ok"]') === control &&
            !control.disabled,
        }),
      ],
      mutationRoots: [this],
      scrollRoots: [],
    };
  }

  private get dialog() {
    return this.querySelector<HTMLDialogElement>(":scope > dialog");
  }
}

/**
 * The title and sentence for an attempt that ended with Caffold not updated
 * and not running as planned. Other outcomes are told elsewhere.
 */
export function updateResultNotice(
  attempt: UpdateAttempt | null | undefined,
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
