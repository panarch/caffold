import { html, LitElement } from "lit";
import type {
  ActionHintScope,
  ActionHintScopeOptions,
  ActionHintTarget,
} from "#app/action-hint-scope.js";
import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
  textboxActionHintTarget,
} from "#app/action-hints.js";
import {
  killTerminal,
  openTerminal,
  type TaskResponseError,
  type TerminalSubject,
} from "#app/api.js";
import { compactIconButton } from "#app/component-styles.js";
import { inlineIcon } from "#components/icons.ts";
import {
  type CaffoldTerminalView,
  type TerminalSize,
  terminalInputBytes,
} from "#components/terminal-view.ts";
import {
  TASK_TRANSPORT_STATE,
  type TaskTransportState,
} from "../../runtime-state.js";
import "./components/special-keys.ts";
import type {
  CaffoldTerminalSpecialKeys,
  TerminalSpecialKeyDetail,
} from "./components/special-keys.ts";
import { TerminalConnection } from "./page/connection.ts";
import { watchKeyboardInset } from "./page/keyboard-inset.ts";
import { controlCharacter, specialKeySequence } from "./page/keys.ts";
import {
  initialTerminalState,
  TERMINAL_EFFECT,
  TERMINAL_EVENT,
  TERMINAL_MODE,
  TERMINAL_NODE,
  type TerminalEffect,
  type TerminalEvent,
  type TerminalMode,
  type TerminalNode,
  type TerminalState,
  terminalTransition,
} from "./page/model.ts";

export const TERMINAL_PAGE_STATE_EVENT = "caffold:terminal-page-state";
export const TERMINAL_PAGE_FOCUS_RELEASE_EVENT =
  "caffold:terminal-page-focus-release";
export const TERMINAL_PAGE_LEAVE_EVENT = "caffold:terminal-page-leave";
export const TERMINAL_PAGE_HEADER_EVENT = "caffold:terminal-page-header";

const SPECIAL_KEYS_STORAGE_KEY = "caffold:terminal-special-keys";
const HEADER_STORAGE_KEY = "caffold:terminal-header-hidden";
const FALLBACK_SIZE: TerminalSize = Object.freeze({ cols: 80, rows: 24 });

/**
 * The terminal of one Task or Section, shown in place of the Detail body.
 *
 * The Detail layout activates it for a subject; everything after that follows
 * the control model in `page/model.ts`, whose single transition authority is
 * `apply`. The backend owns whether a terminal exists and who sees it. The
 * Detail layout reads the screen right after each change, so it draws at once.
 */
export class CaffoldTerminalPage extends LitElement {
  private state: TerminalState = initialTerminalState();
  private subject: TerminalSubject | null = null;
  private cwd = "";
  private connection: TerminalConnection | null = null;
  private settleWaiters: Array<{
    resolve: (value: { ok: true }) => void;
    reject: (error: Error) => void;
  }> = [];
  private readonly encoder = new TextEncoder();
  private rendered = false;
  private specialKeysShown = false;
  private headerChoice = false;
  private stopKeyboardWatch: (() => void) | null = null;
  private readonly iconsReady = () => this.draw();

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.ensureRendered();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
    this.deactivate();
  }

  /** Shows the subject's terminal: `take` brings it here, `resume` only looks. */
  activate({
    subject,
    cwd = "",
    mode = TERMINAL_MODE.RESUME,
  }: {
    subject?: TerminalSubject | null;
    cwd?: string;
    mode?: TerminalMode;
  } = {}) {
    this.ensureRendered();
    if (!subject?.kind || !subject?.id) {
      this.deactivate();
      return false;
    }
    if (this.subject && !sameSubject(this.subject, subject)) {
      this.apply({ type: TERMINAL_EVENT.DEACTIVATE });
    }
    this.subject = { kind: subject.kind, id: `${subject.id}` };
    this.cwd = `${cwd}`;
    this.watchKeyboard();
    return this.apply({ type: TERMINAL_EVENT.ACTIVATE, mode });
  }

  deactivate() {
    this.unwatchKeyboard();
    this.apply({ type: TERMINAL_EVENT.DEACTIVATE });
  }

  suspendForeground() {
    this.apply({ type: TERMINAL_EVENT.HIDDEN });
  }

  /** Connects again after the page was hidden or the socket was lost. */
  recoverForeground() {
    const accepted =
      this.apply({ type: TERMINAL_EVENT.VISIBLE }) ||
      this.apply({ type: TERMINAL_EVENT.RECOVER });
    return accepted ? this.settled() : null;
  }

  get transportState(): TaskTransportState {
    switch (this.state.node) {
      case TERMINAL_NODE.CONNECTING:
        return TASK_TRANSPORT_STATE.CONNECTING;
      case TERMINAL_NODE.LIVE:
        return TASK_TRANSPORT_STATE.READY;
      case TERMINAL_NODE.DISCONNECTED:
        return TASK_TRANSPORT_STATE.UNAVAILABLE;
      default:
        return TASK_TRANSPORT_STATE.IDLE;
    }
  }

  /** Whether the person chose to give the Detail header's height to the terminal. */
  get headerHidden() {
    this.ensureRendered();
    return this.headerChoice;
  }

  ownsInput(element: Element | null | undefined) {
    return Boolean(this.terminalView?.ownsInput(element));
  }

  actionHintScope({
    scopeId = "",
    clipRoots = [],
  }: ActionHintScopeOptions = {}): ActionHintScope {
    this.performUpdate();
    if (!scopeId || this.hidden || this.state.node === TERMINAL_NODE.INACTIVE) {
      return emptyActionHintScope();
    }
    const targets: ActionHintTarget[] = [];
    const view = this.terminalView;
    const input = view?.inputControl();
    if (view && input && this.state.node === TERMINAL_NODE.LIVE) {
      targets.push(
        textboxActionHintTarget({
          invalidationOwner: this,
          id: `${scopeId}:terminal:input`,
          actionId: ACTION_HINT_ACTION.TERMINAL_FOCUS,
          label: "Focus terminal",
          control: input,
          anchor: view,
          clipRoots: [...clipRoots],
          isActionable: () =>
            this.isConnected &&
            this.state.node === TERMINAL_NODE.LIVE &&
            this.terminalView?.inputControl() === input,
        }),
      );
    }
    for (const control of this.actionButtons()) {
      const action = control.dataset.terminalAction;
      targets.push(
        buttonActionHintTarget({
          invalidationOwner: this,
          id: `${scopeId}:terminal:${action}`,
          actionId: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
          label:
            control.getAttribute("aria-label") ||
            (control.textContent ?? "").trim(),
          control,
          clipRoots: [...clipRoots],
          isActionable: () =>
            this.isConnected &&
            !control.disabled &&
            control.getClientRects().length > 0 &&
            this.actionButtons().includes(control),
        }),
      );
    }
    return {
      blocked: false,
      targets,
      mutationRoots: [this],
      scrollRoots: [],
    };
  }

  protected updated() {
    if (this.dataset.terminalNode !== this.state.node) {
      this.dataset.terminalNode = this.state.node;
    }
    if (this.hasAttribute("data-header-hidden") !== this.headerChoice) {
      this.toggleAttribute("data-header-hidden", this.headerChoice);
    }
  }

  render() {
    const { node, error } = this.state;
    const showsTerminal =
      node === TERMINAL_NODE.CONNECTING || node === TERMINAL_NODE.LIVE;
    const notice = noticeContent(node);
    const headerHidden = this.headerChoice;
    const headerLabel = headerHidden ? "Show header" : "Hide header";
    return html`
      <div class="terminal-page-bar">
        <button
          type="button"
          class="terminal-page-button"
          data-terminal-action="special-keys"
          aria-pressed=${this.specialKeysShown ? "true" : "false"}
          aria-label="Special keys"
          title="Special keys"
          @click=${this.toggleSpecialKeys}
        >${inlineIcon(
          "Keyboard",
          "Special keys",
          "terminal-page-icon",
        )}</button>
        <button
          type="button"
          class="terminal-page-button"
          data-terminal-action="kill"
          aria-label="Kill terminal"
          title="Kill terminal"
          ?disabled=${node !== TERMINAL_NODE.LIVE}
          @click=${this.killTerminal}
        >${inlineIcon("Trash2", "Kill terminal", "terminal-page-icon")}</button>
        <button
          type="button"
          class="terminal-page-button"
          data-terminal-action="header"
          aria-expanded=${headerHidden ? "false" : "true"}
          aria-label=${headerLabel}
          title=${headerLabel}
          @click=${this.toggleHeader}
        >${inlineIcon(
          headerHidden ? "Minimize2" : "Maximize2",
          headerLabel,
          "terminal-page-icon",
        )}</button>
        <button
          type="button"
          class="terminal-page-button"
          data-terminal-action="leave"
          aria-label="Leave terminal"
          title="Leave terminal"
          ?hidden=${!headerHidden}
          @click=${this.leave}
        >${inlineIcon(
          "SquareTerminal",
          "Leave terminal",
          "terminal-page-icon",
        )}</button>
      </div>
      <div class="terminal-page-body">
        <caffold-terminal-view
          ?hidden=${!showsTerminal}
          @caffold:terminal-view-input=${this.sendInput}
          @caffold:terminal-view-resize=${this.resizeTerminal}
        ></caffold-terminal-view>
        <div class="terminal-page-notice" ?hidden=${!notice}>
          <p data-terminal-notice-message>${notice?.message}</p>
          <p
            class="terminal-page-error"
            data-terminal-notice-error
            ?hidden=${!error}
          >${error}</p>
          <button
            type="button"
            class="task-secondary-button"
            data-terminal-action="open"
            ?hidden=${!notice?.action}
            @click=${this.openHere}
          >${notice?.action}</button>
        </div>
      </div>
      <caffold-terminal-special-keys
        ?hidden=${!this.specialKeysShown}
        @caffold:terminal-special-key=${this.sendSpecialKey}
      ></caffold-terminal-special-keys>
    `;
  }

  // The screen ends above an on-screen keyboard, so the prompt and the special
  // key row stay in sight while typing.
  private watchKeyboard() {
    this.stopKeyboardWatch ??= watchKeyboardInset(this, (covered) => {
      this.style.setProperty("--terminal-page-keyboard-inset", `${covered}px`);
    });
  }

  private unwatchKeyboard() {
    this.stopKeyboardWatch?.();
    this.stopKeyboardWatch = null;
    this.style.removeProperty("--terminal-page-keyboard-inset");
  }

  // The only writer of `this.state`.
  private apply(event: TerminalEvent) {
    const result = terminalTransition(this.state, event);
    if (!result) {
      return false;
    }
    this.state = result.state;
    for (const effect of result.effects) {
      this.runEffect(effect);
    }
    this.draw();
    this.settleWaiting();
    this.dispatchEvent(
      new CustomEvent<{ node: TerminalNode }>(TERMINAL_PAGE_STATE_EVENT, {
        bubbles: true,
        detail: { node: this.state.node },
      }),
    );
    return true;
  }

  private runEffect(effect: TerminalEffect) {
    switch (effect) {
      case TERMINAL_EFFECT.CONNECT:
        this.closeConnection();
        void this.connect(this.state.generation, this.state.mode);
        break;
      case TERMINAL_EFFECT.DISCONNECT:
        this.closeConnection();
        break;
      case TERMINAL_EFFECT.CLEAR:
        this.terminalView?.close();
        break;
      case TERMINAL_EFFECT.FOCUS:
        this.terminalView?.focus();
        break;
      case TERMINAL_EFFECT.RELEASE_FOCUS:
        if (this.contains(document.activeElement)) {
          this.dispatchEvent(
            new CustomEvent(TERMINAL_PAGE_FOCUS_RELEASE_EVENT, {
              bubbles: true,
            }),
          );
        }
        break;
      case TERMINAL_EFFECT.LEAVE:
        this.dispatchEvent(
          new CustomEvent(TERMINAL_PAGE_LEAVE_EVENT, { bubbles: true }),
        );
        break;
      default:
        break;
    }
  }

  private async connect(generation: number, mode: TerminalMode | null) {
    const view = this.terminalView;
    const subject = this.subject;
    if (!view || !subject) {
      return;
    }
    let size: TerminalSize;
    try {
      size = (await view.open()) ?? FALLBACK_SIZE;
    } catch {
      this.apply({ type: TERMINAL_EVENT.SOCKET_FAILED, generation });
      return;
    }
    if (generation !== this.state.generation) {
      return;
    }
    if (mode === TERMINAL_MODE.TAKE) {
      try {
        await openTerminal({ subject, cwd: this.cwd, ...size });
      } catch (error) {
        // An answer means the backend refused to start the shell; no answer
        // means it could not be reached.
        const failure = error as TaskResponseError | null;
        this.apply(
          failure?.status
            ? {
                type: TERMINAL_EVENT.START_FAILED,
                generation,
                message: failure.message,
              }
            : { type: TERMINAL_EVENT.SOCKET_FAILED, generation },
        );
        return;
      }
      if (generation !== this.state.generation) {
        return;
      }
    }
    this.connection = new TerminalConnection({
      subject,
      mode: `${mode}`,
      size,
      onMessage: (type) => this.receiveMessage(generation, type),
      onOutput: (bytes) => {
        if (generation === this.state.generation) {
          this.terminalView?.write(bytes);
        }
      },
      onFailure: () =>
        this.apply({ type: TERMINAL_EVENT.SOCKET_FAILED, generation }),
    });
  }

  private receiveMessage(generation: number, type: string) {
    if (generation !== this.state.generation) {
      return;
    }
    // `attached` and `resync` each precede the screen the terminal starts over from.
    if (type === "attached" || type === "resync") {
      this.terminalView?.reset();
    }
    if (type === "attached") {
      this.apply({ type: TERMINAL_EVENT.ATTACHED, generation });
      const size = this.terminalView?.size;
      if (size) {
        this.connection?.resize(size);
      }
      return;
    }
    const event = (
      {
        elsewhere: TERMINAL_EVENT.ELSEWHERE,
        absent: TERMINAL_EVENT.ABSENT,
        taken: TERMINAL_EVENT.TAKEN,
        ended: TERMINAL_EVENT.ENDED,
      } as Record<string, TerminalEvent["type"]>
    )[type];
    if (event) {
      this.apply({ type: event, generation });
    }
  }

  private closeConnection() {
    this.connection?.close();
    this.connection = null;
  }

  private sendInput(event: CustomEvent<{ data: string; binary: boolean }>) {
    const { data, binary } = event.detail;
    if (this.state.node !== TERMINAL_NODE.LIVE) {
      return;
    }
    const text =
      !binary && this.specialKeys?.consumeControl()
        ? controlCharacter(data)
        : data;
    this.connection?.send(
      terminalInputBytes({ data: text, binary }, this.encoder),
    );
  }

  private resizeTerminal(event: CustomEvent<TerminalSize>) {
    if (this.state.node === TERMINAL_NODE.LIVE) {
      this.connection?.resize(event.detail);
    }
  }

  private sendSpecialKey(event: CustomEvent<TerminalSpecialKeyDetail>) {
    event.stopPropagation();
    const { key, control } = event.detail;
    const sequence = specialKeySequence(key, {
      applicationCursor: this.terminalView?.applicationCursorKeys(),
      control: Boolean(control),
    });
    if (sequence && this.state.node === TERMINAL_NODE.LIVE) {
      this.terminalView?.sendInput(sequence);
    }
  }

  private toggleSpecialKeys() {
    const shown = !this.specialKeysShown;
    this.specialKeysShown = shown;
    writePreference(SPECIAL_KEYS_STORAGE_KEY, shown);
    this.draw();
  }

  private killTerminal() {
    // The backend's `ended` moves this screen on.
    if (this.state.node === TERMINAL_NODE.LIVE && this.subject) {
      void killTerminal(this.subject).catch(() => {});
    }
  }

  private openHere() {
    this.apply({ type: TERMINAL_EVENT.ACTIVATE, mode: TERMINAL_MODE.TAKE });
  }

  // Without the header the bar stands as a column on the right, and leaving
  // the terminal, which the header's button did, moves into it.
  private toggleHeader() {
    const hidden = !this.headerHidden;
    this.headerChoice = hidden;
    writePreference(HEADER_STORAGE_KEY, hidden);
    this.draw();
    this.dispatchEvent(
      new CustomEvent(TERMINAL_PAGE_HEADER_EVENT, { bubbles: true }),
    );
  }

  private leave() {
    this.dispatchEvent(
      new CustomEvent(TERMINAL_PAGE_LEAVE_EVENT, { bubbles: true }),
    );
  }

  /** Waits for the connection being made to succeed or fail. */
  private settled() {
    return new Promise<{ ok: true }>((resolve, reject) => {
      this.settleWaiters.push({ resolve, reject });
      this.settleWaiting();
    });
  }

  private settleWaiting() {
    if (this.state.node === TERMINAL_NODE.CONNECTING) {
      return;
    }
    const waiters = this.settleWaiters.splice(0);
    for (const { resolve, reject } of waiters) {
      if (this.state.node === TERMINAL_NODE.DISCONNECTED) {
        reject(new Error("The terminal connection failed."));
      } else {
        resolve({ ok: true });
      }
    }
  }

  // The first draw takes the person's earlier choices for the key row and
  // the header.
  private ensureRendered() {
    if (this.rendered) {
      return;
    }
    this.rendered = true;
    this.specialKeysShown = readSpecialKeysPreference();
    this.headerChoice = readHeaderPreference();
    this.draw();
  }

  private draw() {
    this.requestUpdate();
    this.performUpdate();
    this.terminalView?.setInputEnabled(this.state.node === TERMINAL_NODE.LIVE);
  }

  private actionButtons() {
    return [
      ...this.querySelectorAll<HTMLButtonElement>("[data-terminal-action]"),
    ].filter((button) => !button.hidden && !button.closest("[hidden]"));
  }

  private get terminalView() {
    return this.querySelector<CaffoldTerminalView>(
      ":scope > .terminal-page-body > caffold-terminal-view",
    );
  }

  private get specialKeys() {
    return this.querySelector<CaffoldTerminalSpecialKeys>(
      ":scope > caffold-terminal-special-keys",
    );
  }
}

await compactIconButton.register(
  "caffold-terminal-page",
  "> .terminal-page-bar > .terminal-page-button",
);

customElements.define("caffold-terminal-page", CaffoldTerminalPage);

function noticeContent(node: TerminalNode) {
  switch (node) {
    case TERMINAL_NODE.EMPTY:
      return {
        message: "No terminal is running here.",
        action: "Open terminal",
      };
    case TERMINAL_NODE.ELSEWHERE:
      return {
        message: "This terminal is open on another screen.",
        action: "Open here",
      };
    case TERMINAL_NODE.DISCONNECTED:
      return { message: "The terminal connection was lost.", action: "" };
    default:
      return null;
  }
}

function sameSubject(left: TerminalSubject, right: TerminalSubject) {
  return left?.kind === right?.kind && `${left?.id}` === `${right?.id}`;
}

function readSpecialKeysPreference() {
  try {
    const stored = window.localStorage.getItem(SPECIAL_KEYS_STORAGE_KEY);
    if (stored === "true" || stored === "false") {
      return stored === "true";
    }
  } catch {
    // Storage can be unavailable; the pointer decides then.
  }
  return window.matchMedia?.("(pointer: coarse)").matches ?? false;
}

function readHeaderPreference() {
  try {
    return window.localStorage.getItem(HEADER_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function writePreference(key: string, value: boolean) {
  try {
    window.localStorage.setItem(key, `${value}`);
  } catch {
    // The choice then lasts only for this page.
  }
}
