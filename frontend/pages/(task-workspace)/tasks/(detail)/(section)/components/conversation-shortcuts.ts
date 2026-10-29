import { html } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
} from "#app/action-hints.js";
import { getCodexReadiness } from "#app/api.js";
import {
  type CodexStatusSnapshot,
  codexBlocksTaskOperations,
  codexState,
  createCodexStatusSnapshot,
} from "#app/pages/(task-workspace)/codex-status.js";
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
 * that already exists elsewhere: today, a Codex thread.
 *
 * It shows only while active and once Codex is known to be installed, and
 * asks Codex each time it is shown.
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
  private accessor codexReadiness: CodexStatusSnapshot =
    createCodexStatusSnapshot();
  @state()
  private accessor taskStoreStatusSnapshot: TaskStoreStatusSnapshot | null =
    null;

  static override styles = styles;

  @state()
  private accessor active = false;
  // Asked for whenever the row is shown: whether Codex is installed, and why
  // it is blocked. The previous answer stays on show while the next is asked.
  private codexReadinessRequest = 0;
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
      if (this.active) {
        void this.askCodexReadiness();
      }
    }
  }

  setTransportAvailable(available: boolean) {
    const regained = Boolean(available) && !this.transportAvailable;
    this.transportAvailable = Boolean(available);
    // A question that failed while Caffold was out of reach is asked again
    // once it is back; an answer already in hand stays.
    if (regained && this.active && this.codexReadiness.phase === "failed") {
      void this.askCodexReadiness();
    }
  }

  setTaskStoreStatusSnapshot(snapshot: TaskStoreStatusSnapshot | null) {
    this.taskStoreStatusSnapshot = snapshot ?? null;
  }

  activate() {
    const shown = !this.active;
    this.active = true;
    if (shown) {
      void this.askCodexReadiness();
    }
  }

  deactivate() {
    this.active = false;
    this.codexReadinessRequest += 1;
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
    const state = codexState(this.codexReadiness);
    const installed =
      this.codexReadiness.status?.readiness?.state !== "missing";
    const hidden = !this.active || state === "pending" || !installed;
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
          label: "Fork from Codex thread ID",
          action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
        })}
        type="button"
        class="section-conversations-action"
        data-section-conversation-action="fork-codex"
        aria-describedby="section-conversations-codex-reason"
        title=${reason}
        ?disabled=${Boolean(reason)}
        @click=${this.openForkDialog}
      >
        <span class="section-conversations-action-label"
          >Fork from Codex thread ID</span
        >
        <span
          id="section-conversations-codex-reason"
          class="section-conversations-action-reason"
          ?hidden=${!reason}
        >${reason}</span>
      </button>
      <caffold-conversation-fork-dialog
        ${drawn(this.dialog)}
      ></caffold-conversation-fork-dialog>
    `;
  }

  private async askCodexReadiness() {
    const request = ++this.codexReadinessRequest;
    let answer: CodexStatusSnapshot;
    try {
      const { readiness } = await getCodexReadiness();
      answer = createCodexStatusSnapshot({
        phase: "loaded",
        status: readiness ? { readiness } : null,
      });
    } catch (error) {
      answer = createCodexStatusSnapshot({
        phase: "failed",
        error:
          error instanceof Error ? error.message : "Codex could not be asked.",
      });
    }
    if (request !== this.codexReadinessRequest) {
      return;
    }
    this.codexReadiness = answer;
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
    const status = this.codexReadiness.status;
    if (
      codexState(this.codexReadiness) !== "available" ||
      codexBlocksTaskOperations(status)
    ) {
      return (
        status?.readiness?.diagnosticMessage ||
        this.codexReadiness.error ||
        "Codex is temporarily unavailable."
      );
    }
    return "";
  }

  private openForkDialog(event: Event) {
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
