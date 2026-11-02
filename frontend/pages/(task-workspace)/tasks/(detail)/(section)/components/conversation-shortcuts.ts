import { html } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
} from "#app/action-hints.js";
import {
  type TaskStoreStatusSnapshot,
  taskStoreBlocksTaskOperations,
} from "#app/pages/(task-workspace)/task-store-status.js";
import "./conversation-shortcuts/components/fork-dialog.js";
import { CaffoldElement } from "#app/caffold-element.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";
import type { CaffoldConversationForkDialog } from "./conversation-shortcuts/components/fork-dialog.js";

import styles from "./conversation-shortcuts.css.js";

// The Section the shortcuts start a Task in: its identity, and the path a
// fork is shown with.
export interface ConversationShortcutsContext {
  key: string;
  sectionId: string;
  path: string;
}

/**
 * The row beside a Section's New Task that starts a Task from a conversation
 * that already exists elsewhere. Each provider answers its own preview;
 * availability of one provider does not hide the other choices.
 */
@customElement("caffold-section-conversation-shortcuts")
export class CaffoldSectionConversationShortcuts extends CaffoldElement {
  @state()
  private accessor context: ConversationShortcutsContext = {
    key: "",
    sectionId: "",
    path: "",
  };
  @state()
  private accessor transportAvailable = true;
  @state()
  private accessor taskStoreStatusSnapshot: TaskStoreStatusSnapshot | null =
    null;

  static override styles = styles;

  @state()
  private accessor active = false;
  private readonly hints = new ActionHints(this, {
    clipRoots: () => [this],
  });
  private readonly dialog = new DrawnRef<CaffoldConversationForkDialog>(this);

  override connectedCallback() {
    super.connectedCallback();
    setAttribute(this, "role", "complementary");
    setAttribute(this, "aria-label", "Existing conversations");
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.deactivate();
  }

  setContext({
    key = "",
    sectionId = "",
    path = "",
  }: Partial<ConversationShortcutsContext> = {}) {
    const previousKey = this.context.key;
    this.context = {
      key: `${key}`,
      sectionId: `${sectionId}`,
      path: `${path}`,
    };
    if (previousKey && previousKey !== this.context.key) {
      this.forkDialog()?.deactivate();
    }
  }

  setTransportAvailable(available: boolean) {
    this.transportAvailable = Boolean(available);
  }

  setTaskStoreStatusSnapshot(snapshot: TaskStoreStatusSnapshot | null) {
    this.taskStoreStatusSnapshot = snapshot ?? null;
  }

  activate() {
    this.active = true;
  }

  deactivate() {
    this.active = false;
    this.forkDialog()?.deactivate();
  }

  actionHintScope({ scopeId = "section", ...pull }: ActionHintPull = {}) {
    return this.hints.scope({ ...pull, scopeId });
  }

  keyboardNavigationContexts() {
    return this.active && !this.hidden
      ? (this.forkDialog()?.keyboardNavigationContexts() ?? [])
      : [];
  }

  protected override updated() {
    const hidden = !this.active;
    if (this.hidden !== hidden) {
      this.hidden = hidden;
    }
  }

  override render() {
    const reason = this.disabledReason();
    return html`
      <header class="section-conversations-heading">
        <h2>Existing conversations</h2>
        <p>Create a Task here with an existing conversation's history.</p>
      </header>
      <button
        ${this.hints.button({
          id: "fork-conversation",
          label: "Fork conversation",
          action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
        })}
        type="button"
        class="section-conversations-action"
        data-section-conversation-action="fork-conversation"
        aria-describedby="section-conversations-reason"
        title=${reason}
        ?disabled=${Boolean(reason)}
        @click=${this.openForkDialog}
      >
        <span class="section-conversations-action-label"
          >Fork conversation</span
        >
        <span
          id="section-conversations-reason"
          class="section-conversations-action-reason"
          ?hidden=${!reason}
        >${reason}</span>
      </button>
      <caffold-conversation-fork-dialog
        ${drawn(this.dialog)}
      ></caffold-conversation-fork-dialog>
    `;
  }

  private disabledReason() {
    if (!this.context.sectionId) {
      return "The target Section is unavailable.";
    }
    if (!this.transportAvailable) {
      return "Reconnect to Caffold to fork a conversation.";
    }
    const store = this.taskStoreStatusSnapshot;
    if (store && taskStoreBlocksTaskOperations(store)) {
      return (
        store.readiness?.diagnosticMessage ||
        "Tasks are temporarily unavailable."
      );
    }
    return "";
  }

  private openForkDialog(event: Event) {
    if (this.disabledReason()) return;
    this.forkDialog()?.open({
      sectionId: this.context.sectionId,
      sectionPath: this.context.path,
      opener: event.currentTarget as HTMLButtonElement,
    });
  }

  private forkDialog() {
    return this.dialog.value;
  }
}

function setAttribute(element: Element, name: string, value: string) {
  if (element.getAttribute(name) !== value) {
    element.setAttribute(name, value);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-section-conversation-shortcuts": CaffoldSectionConversationShortcuts;
  }
}
