import { killTerminal, openTerminal } from "../../../../../api.js";
import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
  textboxActionHintTarget,
} from "../../../../../action-hints.js";
import { renderInlineIcon } from "../../../../../components/icons.js";
import {
  TERMINAL_VIEW_INPUT_EVENT,
  TERMINAL_VIEW_RESIZE_EVENT,
  terminalInputBytes,
} from "../../../../../components/terminal-view.js";
import { TASK_TRANSPORT_STATE } from "../../runtime-state.js";
import { TERMINAL_SPECIAL_KEY_EVENT } from "./components/special-keys.js";
import { TerminalConnection } from "./page/connection.js";
import { watchKeyboardInset } from "./page/keyboard-inset.js";
import { controlCharacter, specialKeySequence } from "./page/keys.js";
import {
  TERMINAL_EFFECT,
  TERMINAL_EVENT,
  TERMINAL_MODE,
  TERMINAL_NODE,
  initialTerminalState,
  terminalTransition,
} from "./page/model.js";

export const TERMINAL_PAGE_STATE_EVENT = "caffold:terminal-page-state";
export const TERMINAL_PAGE_FOCUS_RELEASE_EVENT = "caffold:terminal-page-focus-release";
export const TERMINAL_PAGE_LEAVE_EVENT = "caffold:terminal-page-leave";

const SPECIAL_KEYS_STORAGE_KEY = "caffold:terminal-special-keys";
const FALLBACK_SIZE = Object.freeze({ cols: 80, rows: 24 });

/**
 * The terminal of one Task or Section, shown in place of the Detail body.
 *
 * The Detail layout activates it for a subject; everything after that follows
 * the control model in `page/model.js`, whose single transition authority is
 * `apply`. The backend owns whether a terminal exists and who sees it.
 */
class CaffoldTerminalPage extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
    window.addEventListener("caffold:icons-ready", this.boundIconsReady);
  }

  disconnectedCallback() {
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
    this.deactivate();
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }
    this.rendered = true;
    this.state = initialTerminalState();
    this.subject = null;
    this.cwd = "";
    this.connection = null;
    this.settleWaiters = [];
    this.encoder = new TextEncoder();
    this.boundIconsReady = () => this.renderIcons();
    this.innerHTML = `
      <div class="terminal-page-bar">
        <button
          type="button"
          class="terminal-page-button"
          data-terminal-action="special-keys"
          aria-pressed="false"
          aria-label="Special keys"
          title="Special keys"
        ></button>
        <button
          type="button"
          class="terminal-page-button"
          data-terminal-action="kill"
          aria-label="Kill terminal"
          title="Kill terminal"
        ></button>
      </div>
      <div class="terminal-page-body">
        <caffold-terminal-view></caffold-terminal-view>
        <div class="terminal-page-notice" hidden>
          <p data-terminal-notice-message></p>
          <p class="terminal-page-error" data-terminal-notice-error hidden></p>
          <button
            type="button"
            class="task-secondary-button"
            data-terminal-action="open"
          ></button>
        </div>
      </div>
      <caffold-terminal-special-keys></caffold-terminal-special-keys>
    `;
    this.addEventListener("click", (event) => this.handleClick(event));
    this.addEventListener(TERMINAL_SPECIAL_KEY_EVENT, (event) => {
      event.stopPropagation();
      this.sendSpecialKey(event.detail);
    });
    this.terminalView().addEventListener(TERMINAL_VIEW_INPUT_EVENT, (event) =>
      this.sendInput(event.detail)
    );
    this.terminalView().addEventListener(TERMINAL_VIEW_RESIZE_EVENT, (event) => {
      if (this.state.node === TERMINAL_NODE.LIVE) {
        this.connection?.resize(event.detail);
      }
    });
    this.setSpecialKeysShown(readSpecialKeysPreference());
    this.renderIcons();
    this.renderState();
  }

  /** Shows the subject's terminal: `take` brings it here, `resume` only looks. */
  activate({ subject, cwd = "", mode = TERMINAL_MODE.RESUME } = {}) {
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

  // The screen ends above an on-screen keyboard, so the prompt and the special
  // key row stay in sight while typing.
  watchKeyboard() {
    this.stopKeyboardWatch ??= watchKeyboardInset(this, (covered) => {
      this.style.setProperty("--terminal-page-keyboard-inset", `${covered}px`);
    });
  }

  unwatchKeyboard() {
    this.stopKeyboardWatch?.();
    this.stopKeyboardWatch = null;
    this.style.removeProperty("--terminal-page-keyboard-inset");
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

  /** Whether this screen is the one using the subject's running terminal. */
  isLive() {
    return this.state.node === TERMINAL_NODE.LIVE;
  }

  get transportState() {
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

  ownsInput(element) {
    return Boolean(this.terminalView()?.ownsInput(element));
  }

  actionHintScope({ scopeId = "", clipRoots = [] } = {}) {
    if (!scopeId || this.hidden || this.state.node === TERMINAL_NODE.INACTIVE) {
      return emptyActionHintScope();
    }
    const targets = [];
    const input = this.terminalView()?.inputControl();
    if (this.state.node === TERMINAL_NODE.LIVE && input) {
      targets.push(textboxActionHintTarget({
        invalidationOwner: this,
        id: `${scopeId}:terminal:input`,
        actionId: ACTION_HINT_ACTION.TERMINAL_FOCUS,
        label: "Focus terminal",
        control: input,
        anchor: this.terminalView(),
        clipRoots: [...clipRoots],
        isActionable: () =>
          this.isConnected &&
          this.state.node === TERMINAL_NODE.LIVE &&
          this.terminalView()?.inputControl() === input,
      }));
    }
    for (const control of this.actionButtons()) {
      const action = control.dataset.terminalAction;
      targets.push(buttonActionHintTarget({
        invalidationOwner: this,
        id: `${scopeId}:terminal:${action}`,
        actionId: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
        label: control.getAttribute("aria-label") || control.textContent.trim(),
        control,
        clipRoots: [...clipRoots],
        isActionable: () =>
          this.isConnected &&
          !control.disabled &&
          control.getClientRects().length > 0 &&
          this.actionButtons().includes(control),
      }));
    }
    return {
      blocked: false,
      targets,
      mutationRoots: [this],
      scrollRoots: [],
    };
  }

  // The only writer of `this.state`.
  apply(event) {
    const result = terminalTransition(this.state, event);
    if (!result) {
      return false;
    }
    this.state = result.state;
    for (const effect of result.effects) {
      this.runEffect(effect);
    }
    this.renderState();
    this.settleWaiting();
    this.dispatchEvent(new CustomEvent(TERMINAL_PAGE_STATE_EVENT, {
      bubbles: true,
      detail: { node: this.state.node },
    }));
    return true;
  }

  runEffect(effect) {
    switch (effect) {
      case TERMINAL_EFFECT.CONNECT:
        this.closeConnection();
        void this.connect(this.state.generation, this.state.mode);
        break;
      case TERMINAL_EFFECT.DISCONNECT:
        this.closeConnection();
        break;
      case TERMINAL_EFFECT.FOCUS:
        this.terminalView()?.focus();
        break;
      case TERMINAL_EFFECT.RELEASE_FOCUS:
        if (this.contains(document.activeElement)) {
          this.dispatchEvent(new CustomEvent(TERMINAL_PAGE_FOCUS_RELEASE_EVENT, {
            bubbles: true,
          }));
        }
        break;
      case TERMINAL_EFFECT.LEAVE:
        this.dispatchEvent(new CustomEvent(TERMINAL_PAGE_LEAVE_EVENT, {
          bubbles: true,
        }));
        break;
      default:
        break;
    }
  }

  async connect(generation, mode) {
    let size;
    try {
      size = (await this.terminalView().open()) ?? FALLBACK_SIZE;
    } catch {
      this.apply({ type: TERMINAL_EVENT.SOCKET_FAILED, generation });
      return;
    }
    if (generation !== this.state.generation) {
      return;
    }
    if (mode === TERMINAL_MODE.TAKE) {
      try {
        await openTerminal({ subject: this.subject, cwd: this.cwd, ...size });
      } catch (error) {
        // An answer means the backend refused to start the shell; no answer
        // means it could not be reached.
        this.apply(error?.status
          ? {
              type: TERMINAL_EVENT.START_FAILED,
              generation,
              message: error.message,
            }
          : { type: TERMINAL_EVENT.SOCKET_FAILED, generation });
        return;
      }
      if (generation !== this.state.generation) {
        return;
      }
    }
    this.connection = new TerminalConnection({
      subject: this.subject,
      mode,
      size,
      onMessage: (type) => this.receiveMessage(generation, type),
      onOutput: (bytes) => {
        if (generation === this.state.generation) {
          this.terminalView().write(bytes);
        }
      },
      onFailure: () =>
        this.apply({ type: TERMINAL_EVENT.SOCKET_FAILED, generation }),
    });
  }

  receiveMessage(generation, type) {
    if (generation !== this.state.generation) {
      return;
    }
    // `attached` and `resync` each precede the screen the terminal starts over from.
    if (type === "attached" || type === "resync") {
      this.terminalView().reset();
    }
    if (type === "attached") {
      this.apply({ type: TERMINAL_EVENT.ATTACHED, generation });
      const size = this.terminalView().size;
      if (size) {
        this.connection?.resize(size);
      }
      return;
    }
    const event = {
      elsewhere: TERMINAL_EVENT.ELSEWHERE,
      absent: TERMINAL_EVENT.ABSENT,
      taken: TERMINAL_EVENT.TAKEN,
      ended: TERMINAL_EVENT.ENDED,
    }[type];
    if (event) {
      this.apply({ type: event, generation });
    }
  }

  closeConnection() {
    this.connection?.close();
    this.connection = null;
  }

  sendInput({ data, binary }) {
    if (this.state.node !== TERMINAL_NODE.LIVE) {
      return;
    }
    const text = !binary && this.specialKeys()?.consumeControl()
      ? controlCharacter(data)
      : data;
    this.connection?.send(terminalInputBytes({ data: text, binary }, this.encoder));
  }

  sendSpecialKey({ key, control } = {}) {
    const sequence = specialKeySequence(key, {
      applicationCursor: this.terminalView()?.applicationCursorKeys(),
      control: Boolean(control),
    });
    if (sequence && this.state.node === TERMINAL_NODE.LIVE) {
      this.terminalView()?.sendInput(sequence);
    }
  }

  handleClick(event) {
    const button = event.target instanceof Element
      ? event.target.closest("[data-terminal-action]")
      : null;
    if (!button || !this.contains(button) || button.disabled) {
      return;
    }
    const action = button.dataset.terminalAction;
    if (action === "special-keys") {
      const shown = this.specialKeys()?.hidden ?? false;
      this.setSpecialKeysShown(shown);
      writeSpecialKeysPreference(shown);
    } else if (action === "kill" && this.state.node === TERMINAL_NODE.LIVE) {
      // The backend's `ended` moves this screen on.
      void killTerminal(this.subject).catch(() => {});
    } else if (action === "open") {
      this.apply({ type: TERMINAL_EVENT.ACTIVATE, mode: TERMINAL_MODE.TAKE });
    }
  }

  setSpecialKeysShown(shown) {
    this.specialKeys()?.toggleAttribute("hidden", !shown);
    this.querySelector('[data-terminal-action="special-keys"]')
      ?.setAttribute("aria-pressed", shown ? "true" : "false");
  }

  /** Waits for the connection being made to succeed or fail. */
  settled() {
    return new Promise((resolve, reject) => {
      this.settleWaiters.push({ resolve, reject });
      this.settleWaiting();
    });
  }

  settleWaiting() {
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

  renderState() {
    const { node, error } = this.state;
    const showsTerminal = [TERMINAL_NODE.CONNECTING, TERMINAL_NODE.LIVE].includes(node);
    this.dataset.terminalNode = node;
    this.terminalView()?.toggleAttribute("hidden", !showsTerminal);
    this.terminalView()?.setInputEnabled(node === TERMINAL_NODE.LIVE);
    const kill = this.querySelector('[data-terminal-action="kill"]');
    if (kill) {
      kill.disabled = node !== TERMINAL_NODE.LIVE;
    }
    const notice = this.querySelector(":scope .terminal-page-notice");
    const content = noticeContent(node);
    notice?.toggleAttribute("hidden", !content);
    if (!notice || !content) {
      return;
    }
    setText(notice.querySelector("[data-terminal-notice-message]"), content.message);
    const errorLine = notice.querySelector("[data-terminal-notice-error]");
    setText(errorLine, error);
    errorLine?.toggleAttribute("hidden", !error);
    const open = notice.querySelector('[data-terminal-action="open"]');
    setText(open, content.action);
    open?.toggleAttribute("hidden", !content.action);
  }

  renderIcons() {
    const icons = {
      "special-keys": renderInlineIcon("Keyboard", "Special keys", "terminal-page-icon"),
      kill: renderInlineIcon("Trash2", "Kill terminal", "terminal-page-icon"),
    };
    for (const [action, icon] of Object.entries(icons)) {
      const button = this.querySelector(`.terminal-page-bar > [data-terminal-action="${action}"]`);
      if (button && button.innerHTML.trim() !== icon.trim()) {
        button.innerHTML = icon;
      }
    }
  }

  actionButtons() {
    return [...this.querySelectorAll("[data-terminal-action]")].filter(
      (button) => !button.hidden && !button.closest("[hidden]"),
    );
  }

  terminalView() {
    return this.querySelector(":scope > .terminal-page-body > caffold-terminal-view");
  }

  specialKeys() {
    return this.querySelector(":scope > caffold-terminal-special-keys");
  }
}

if (!customElements.get("caffold-terminal-page")) {
  customElements.define("caffold-terminal-page", CaffoldTerminalPage);
}

function noticeContent(node) {
  switch (node) {
    case TERMINAL_NODE.EMPTY:
      return { message: "No terminal is running here.", action: "Open terminal" };
    case TERMINAL_NODE.ELSEWHERE:
      return { message: "This terminal is open on another screen.", action: "Open here" };
    case TERMINAL_NODE.DISCONNECTED:
      return { message: "The terminal connection was lost.", action: "" };
    default:
      return null;
  }
}

function sameSubject(left, right) {
  return left?.kind === right?.kind && `${left?.id}` === `${right?.id}`;
}

function setText(element, text) {
  if (element && element.textContent !== `${text ?? ""}`) {
    element.textContent = `${text ?? ""}`;
  }
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

function writeSpecialKeysPreference(shown) {
  try {
    window.localStorage.setItem(SPECIAL_KEYS_STORAGE_KEY, `${shown}`);
  } catch {
    // The choice then lasts only for this page.
  }
}
