import { renderInlineIcon, warmIcons } from "#components/icons.js";
import { eventIdentityKey } from "#tasks/task-events.js";
import { formatDate, taskEventObservedMs } from "#tasks/task-format.js";
import {
  ACTION_HINT_ACTION,
  disclosureActionHintTarget,
  emptyActionHintScope,
  mergeActionHintScopes,
} from "#app/action-hints.js";
import "./command.js";
import { commandGroupIdentity, isCommandEvent } from "../command-runs.js";
import { commandGroupPresentation } from "./command-group/model.js";

// Whether each group was left open, by group identity. A group's entry is drawn
// anew when its turn finishes and folds into work details, and when the Task is
// opened again; the group should still be open or closed as the person left it.
const disclosureStateByIdentity = new Map();

class CaffoldTaskCommandGroup extends HTMLElement {
  connectedCallback() {
    this.ensureState();
    this.attachListeners();
    if (!this.initialized) {
      this.initialized = true;
      this.render();
    } else {
      this.restoreDisclosureState();
      this.refreshChevronIcons();
    }
    warmIcons();
  }

  disconnectedCallback() {
    this.detachListeners();
  }

  ensureState() {
    if (this.stateReady) {
      return;
    }
    this.stateReady = true;
    this.snapshot = { identity: "", events: [] };
    this.presentation = commandGroupPresentation();
    this.boundClick = (event) => this.handleClick(event);
    this.boundIconsReady = () => this.refreshChevronIcons();
  }

  attachListeners() {
    if (this.listenersAttached) {
      return;
    }
    this.listenersAttached = true;
    this.addEventListener("click", this.boundClick);
    window.addEventListener("caffold:icons-ready", this.boundIconsReady);
  }

  detachListeners() {
    if (!this.listenersAttached) {
      return;
    }
    this.listenersAttached = false;
    this.removeEventListener("click", this.boundClick);
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
  }

  setSnapshot(snapshot = {}) {
    this.ensureState();
    const next = {
      identity: `${snapshot.identity ?? ""}`,
      events: [...(snapshot.events ?? [])],
    };
    if (
      next.identity === this.snapshot.identity &&
      sameEventList(next.events, this.snapshot.events)
    ) {
      return false;
    }
    this.snapshot = next;
    this.presentation = commandGroupPresentation(next.events);
    if (this.initialized) {
      this.update();
    }
    return true;
  }

  get identity() {
    this.ensureState();
    return this.snapshot.identity;
  }

  disclosureOpen() {
    return Boolean(this.disclosure()?.open);
  }

  disclosureAnchorTop() {
    return this.disclosure()
      ?.querySelector(":scope > summary")
      ?.getBoundingClientRect().top ?? null;
  }

  // Whether one of the entries folded into this group was drawn on its own
  // under this event id before the group formed.
  holdsEvent(eventId) {
    this.ensureState();
    return Boolean(eventId) &&
      this.snapshot.events.some((event) => `${event?.id ?? ""}` === eventId);
  }

  render() {
    this.innerHTML = `
      <details class="task-command-group-disclosure">
        <summary class="task-command-group-summary">
          <span class="task-command-group-label">
            <span class="task-command-group-label-text"></span>
            <span class="task-command-group-chevron" aria-hidden="true"></span>
          </span>
          <span class="task-command-group-results">
            <span class="task-command-group-failed"></span>
            <span class="task-command-group-declined"></span>
          </span>
        </summary>
        <ol class="task-command-group-list"></ol>
      </details>
    `;
    this.update();
    this.refreshChevronIcons();
  }

  update() {
    patchText(
      this.querySelector(".task-command-group-label-text"),
      this.presentation.label,
    );
    for (const [selector, text] of [
      [".task-command-group-failed", this.presentation.failed],
      [".task-command-group-declined", this.presentation.declined],
    ]) {
      const element = this.querySelector(selector);
      element.hidden = !text;
      patchText(element, text);
    }
    this.reconcileItems();
    this.restoreDisclosureState();
  }

  // Each row keeps its element while the group grows, so a row someone is
  // looking at or has focused is not drawn again under them.
  reconcileItems() {
    const list = this.querySelector(".task-command-group-list");
    const existing = new Map(
      [...list.children].map((item) => [item.dataset.itemKey, item]),
    );
    const items = this.snapshot.events.map((event) => {
      const key = eventIdentityKey(event) || `${event?.id ?? ""}`;
      const item = existing.get(key) ??
        (isCommandEvent(event) ? commandItem(key) : thinkingItem(key));
      if (isCommandEvent(event)) {
        const command = item.querySelector(":scope > caffold-task-command");
        command.setGrouped(true);
        command.setSnapshot(event);
      } else {
        const time = item.querySelector(
          ":scope > .task-command-group-thinking-row > time",
        );
        const observedMs = taskEventObservedMs(event);
        time.hidden = observedMs === null;
        patchText(time, observedMs === null ? "" : formatDate(observedMs));
      }
      return item;
    });
    const desired = new Set(items);
    for (const item of [...list.children]) {
      if (!desired.has(item)) {
        item.remove();
      }
    }
    let anchor = null;
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (item.parentElement !== list || item.nextElementSibling !== anchor) {
        list.insertBefore(item, anchor);
      }
      anchor = item;
    }
  }

  refreshChevronIcons() {
    const chevron = this.querySelector(".task-command-group-chevron");
    if (!chevron) {
      return;
    }
    chevron.innerHTML = `
      ${renderInlineIcon(
        "ChevronRight",
        "Collapsed",
        "task-command-group-chevron-icon task-command-group-chevron-collapsed",
      )}
      ${renderInlineIcon(
        "ChevronDown",
        "Expanded",
        "task-command-group-chevron-icon task-command-group-chevron-expanded",
      )}
    `;
  }

  handleClick(event) {
    const summary =
      event.target instanceof Element ? event.target.closest("summary") : null;
    const disclosure = summary?.parentElement;
    if (
      !(disclosure instanceof HTMLDetailsElement) ||
      disclosure !== this.disclosure()
    ) {
      return;
    }
    const open = !disclosure.open;
    disclosureStateByIdentity.set(this.identity, open);
    this.dispatchEvent(
      new CustomEvent("caffold:task-command-group-disclosure-intent", {
        bubbles: true,
        composed: true,
        detail: { identity: this.identity, open },
      }),
    );
  }

  disclosure() {
    return this.querySelector(":scope > details.task-command-group-disclosure");
  }

  restoreDisclosureState() {
    this.disclosure()?.toggleAttribute("open", this.rememberedOpen());
  }

  // A group that took in another keeps that group's state when it has none of
  // its own: the earlier commands of a long run can load after the run was
  // opened, which gives the run a new first command.
  rememberedOpen() {
    const own = disclosureStateByIdentity.get(this.identity);
    if (own !== undefined) {
      return own;
    }
    return this.snapshot.events.filter(isCommandEvent).some((event) =>
      disclosureStateByIdentity.get(commandGroupIdentity([event])) === true
    );
  }

  actionHintScope({ scopeId = "", clipRoots = [] } = {}) {
    this.ensureState();
    const disclosure = this.disclosure();
    const control = disclosure?.querySelector(":scope > summary");
    const anchor = control?.querySelector(
      ":scope > .task-command-group-label > .task-command-group-chevron",
    );
    const list = disclosure?.querySelector(
      ":scope > .task-command-group-list",
    );
    const identity = this.identity;
    if (
      !scopeId ||
      !disclosure ||
      !control ||
      !anchor ||
      !list ||
      !identity ||
      this.hidden
    ) {
      return emptyActionHintScope();
    }
    const ownScope = {
      blocked: false,
      targets: [disclosureActionHintTarget({
        invalidationOwner: this,
        id: `${scopeId}:disclosure:${encodeURIComponent(identity)}`,
        actionId: ACTION_HINT_ACTION.DISCLOSURE_TOGGLE,
        label: `${disclosure.open ? "Collapse" : "Expand"} ${
          this.presentation.label
        }`,
        control,
        anchor,
        clipRoots: [this, ...clipRoots].filter(Boolean),
        isActionable: () =>
          this.isConnected &&
          !this.hidden &&
          this.identity === identity &&
          this.disclosure() === disclosure &&
          disclosure.querySelector(":scope > summary") === control &&
          control.querySelector(
            ":scope > .task-command-group-label > .task-command-group-chevron",
          ) === anchor,
      })],
      mutationRoots: [this],
      scrollRoots: [],
    };
    // Rows of a folded group are not on screen, so only an open group offers
    // its commands' actions.
    const commandScopes = disclosure.open
      ? [...list.children].map((item) =>
          item.querySelector(":scope > caffold-task-command")?.actionHintScope?.({
            scopeId: `${scopeId}:command:${item.dataset.itemKey}`,
            clipRoots: [this, list, ...clipRoots].filter(Boolean),
          })
        )
      : [];
    return mergeActionHintScopes(ownScope, ...commandScopes);
  }
}

function commandItem(key) {
  const item = document.createElement("li");
  item.className = "task-command-group-item";
  item.dataset.itemKey = key;
  item.append(document.createElement("caffold-task-command"));
  return item;
}

// An empty thinking block has nothing to show but when the agent thought.
function thinkingItem(key) {
  const item = document.createElement("li");
  item.className = "task-command-group-item task-command-group-thinking";
  item.dataset.itemKey = key;
  item.innerHTML = `
    <div class="task-command-group-thinking-row">
      <span>Thinking</span>
      <time></time>
    </div>
  `;
  return item;
}

function sameEventList(left, right) {
  return (
    left.length === right.length &&
    left.every((event, index) => event === right[index])
  );
}

function patchText(element, value) {
  if (element && element.textContent !== value) {
    element.textContent = value;
  }
}

if (!customElements.get("caffold-task-command-group")) {
  customElements.define("caffold-task-command-group", CaffoldTaskCommandGroup);
}
