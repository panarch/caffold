import { html, LitElement } from "lit";
import type {
  ActionHintScope,
  ActionHintScopeOptions,
} from "#app/action-hint-scope.js";
import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
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
import "./conversation-shortcuts/components/fork-dialog.ts";
import type { CaffoldConversationForkDialog } from "./conversation-shortcuts/components/fork-dialog.ts";

// The Section the shortcuts start a Task in: its identity, and the path a
// fork is shown with.
export interface ConversationShortcutsContext {
  key: string;
  sectionId: string;
  path: string;
}

const FORK_BUTTON = 'button[data-section-conversation-action="fork-codex"]';

/**
 * The row beside a Section's New Task that starts a Task from a conversation
 * that already exists elsewhere: today, a Codex thread.
 *
 * It shows only while active and once Codex is known to be installed, and
 * asks Codex each time it is shown. The Section screen hands it its context
 * and reads it right after, so it draws at once wherever its state changes.
 */
export class CaffoldSectionConversationShortcuts extends LitElement {
  private active = false;
  private context: ConversationShortcutsContext = {
    key: "",
    sectionId: "",
    path: "",
  };
  private transportAvailable = true;
  // Asked for whenever the row is shown: whether Codex is installed, and why
  // it is blocked. The previous answer stays on show while the next is asked.
  private codexReadiness: CodexStatusSnapshot = createCodexStatusSnapshot();
  private codexReadinessRequest = 0;
  private taskStoreStatusSnapshot: TaskStoreStatusSnapshot | null = null;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    setAttribute(this, "role", "complementary");
    setAttribute(this, "aria-label", "Existing conversations");
    this.draw();
  }

  disconnectedCallback() {
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
    this.draw();
  }

  setTransportAvailable(available: boolean) {
    const regained = Boolean(available) && !this.transportAvailable;
    this.transportAvailable = Boolean(available);
    // A question that failed while Caffold was out of reach is asked again
    // once it is back; an answer already in hand stays.
    if (regained && this.active && this.codexReadiness.phase === "failed") {
      void this.askCodexReadiness();
    }
    this.draw();
  }

  setTaskStoreStatusSnapshot(snapshot: TaskStoreStatusSnapshot | null) {
    this.taskStoreStatusSnapshot = snapshot ?? null;
    this.draw();
  }

  activate() {
    const shown = !this.active;
    this.active = true;
    if (shown) {
      void this.askCodexReadiness();
    }
    this.draw();
  }

  deactivate() {
    this.active = false;
    this.codexReadinessRequest += 1;
    this.forkDialog()?.deactivate();
    this.draw();
  }

  actionHintScope({
    scopeId = "section",
    clipRoots = [],
  }: ActionHintScopeOptions = {}): ActionHintScope {
    this.performUpdate();
    const control = this.querySelector<HTMLButtonElement>(FORK_BUTTON);
    const contextKey = this.context.key;
    if (
      !this.active ||
      this.hidden ||
      !contextKey ||
      !control ||
      control.disabled
    ) {
      return emptyActionHintScope();
    }
    return {
      blocked: false,
      targets: [
        buttonActionHintTarget({
          invalidationOwner: this,
          id: `${scopeId}:fork-conversation`,
          actionId: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
          label:
            control.getAttribute("aria-label") ||
            control.textContent?.trim() ||
            "Fork from Codex thread ID",
          control,
          clipRoots: [this, ...clipRoots],
          isActionable: () =>
            this.isConnected &&
            this.active &&
            !this.hidden &&
            this.context.key === contextKey &&
            this.querySelector(FORK_BUTTON) === control &&
            !control.disabled,
        }),
      ],
      mutationRoots: [this],
      scrollRoots: [],
    };
  }

  keyboardNavigationContexts() {
    this.performUpdate();
    return this.active && !this.hidden
      ? (this.forkDialog()?.keyboardNavigationContexts() ?? [])
      : [];
  }

  protected updated() {
    const state = codexState(this.codexReadiness);
    const installed =
      this.codexReadiness.status?.readiness?.state !== "missing";
    const hidden = !this.active || state === "pending" || !installed;
    if (this.hidden !== hidden) {
      this.hidden = hidden;
    }
  }

  render() {
    const reason = this.disabledReason();
    return html`
      <header class="section-conversations-heading">
        <h2>Existing conversations</h2>
        <p>Create a Task here with an existing conversation's history.</p>
      </header>
      <button
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
      <caffold-conversation-fork-dialog></caffold-conversation-fork-dialog>
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
    this.draw();
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
    return this.querySelector<CaffoldConversationForkDialog>(
      ":scope > caffold-conversation-fork-dialog",
    );
  }

  private draw() {
    this.requestUpdate();
    this.performUpdate();
  }
}

customElements.define(
  "caffold-section-conversation-shortcuts",
  CaffoldSectionConversationShortcuts,
);

function setAttribute(element: Element, name: string, value: string) {
  if (element.getAttribute(name) !== value) {
    element.setAttribute(name, value);
  }
}
