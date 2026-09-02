import { cleanLogicalPath } from "../task-format.js";
import { mergeKeyboardNavigationContexts } from "../../../../keyboard-navigation.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
  hasVerticalScrollOverflow,
} from "../../../../scroll-scope.js";
import "./components/directory-picker.js";
import "../components/task-create.js";

const AUTO_FOCUS_PROMPT_MEDIA =
  "(hover: hover) and (pointer: fine) and (min-width: 521px)";

class CaffoldTaskNew extends HTMLElement {
  connectedCallback() {
    this.ensureState();
    this.addEventListener("caffold:task-create-intent", this.boundCreateIntent);
    this.addEventListener("caffold:directory-picked", this.boundDirectoryPicked);
    this.ensureRendered();
  }

  disconnectedCallback() {
    this.removeEventListener(
      "caffold:task-create-intent",
      this.boundCreateIntent,
    );
    this.removeEventListener(
      "caffold:directory-picked",
      this.boundDirectoryPicked,
    );
    this.taskCreate()?.deactivate();
  }

  ensureState() {
    if (this.stateReady) {
      return;
    }
    this.stateReady = true;
    this.cwd = ".";
    this.transportAvailable = true;
    this.codexStatusSnapshot = null;
    this.boundCreateIntent = (event) => this.handleCreateIntent(event);
    this.boundDirectoryPicked = (event) => this.handleDirectoryPicked(event);
  }

  ensureRendered() {
    this.ensureState();
    if (this.querySelector(":scope > .task-new-workspace")) {
      return;
    }
    this.innerHTML = `
      <section class="task-new-workspace">
        <caffold-task-create></caffold-task-create>
        <section class="task-new-worktree-guide" aria-labelledby="task-new-worktree-guide-title">
          <h2 id="task-new-worktree-guide-title">Work in an isolated worktree</h2>
          <p>Start with a setup-only request when you want this task separated from your main checkout. By default, Caffold prepares a clean worktree and leaves staged, unstaged, and untracked changes in your current checkout. The same setup request also works in an existing task.</p>
          <ol>
            <li>
              <span class="task-new-worktree-label">Prepare the workspace</span>
              <code>Prepare this task in an isolated worktree. Leave my current checkout changes in place. Stop when the worktree is ready.</code>
            </li>
            <li>
              <span class="task-new-worktree-label">Continue in the worktree</span>
              <code>Now review PR #123.</code>
            </li>
          </ol>
          <p class="task-new-worktree-note">Need the current changes too? Say “Move this task and my current changes into an isolated worktree.”</p>
        </section>
      </section>
      <caffold-task-directory-picker></caffold-task-directory-picker>
    `;
    this.syncTaskCreate();
  }

  prepare({ cwd = "", defaultCwdPath = "" } = {}) {
    this.ensureState();
    this.cwd = cleanLogicalPath(cwd || defaultCwdPath || ".");
    this.ensureRendered();
    this.directoryPicker()?.dismiss();
    this.syncTaskCreate();
  }

  open() {
    this.ensureState();
    this.hidden = false;
    this.syncTaskCreate();
    this.taskCreate()?.activate({
      autofocus: window.matchMedia(AUTO_FOCUS_PROMPT_MEDIA).matches,
    });
  }

  deactivate() {
    this.taskCreate()?.deactivate();
    this.hidden = true;
    this.directoryPicker()?.dismiss();
  }

  setTransportAvailable(available) {
    this.ensureState();
    this.transportAvailable = Boolean(available);
    this.taskCreate()?.setTransportAvailable(this.transportAvailable);
  }

  setCodexStatusSnapshot(snapshot) {
    this.ensureState();
    this.codexStatusSnapshot = snapshot ?? null;
    this.taskCreate()?.setCodexStatusSnapshot(this.codexStatusSnapshot);
  }

  selectedContextPath() {
    this.ensureState();
    return cleanLogicalPath(this.cwd);
  }

  actionHintScope() {
    this.ensureRendered();
    const scrollRoot = this.querySelector(":scope > .task-new-workspace");
    const taskCreate = this.taskCreate();
    return {
      targets: taskCreate?.actionHintTargets({
        scopeId: "new",
        clipRoots: [this, scrollRoot].filter(Boolean),
      }) ?? [],
      mutationRoots: [taskCreate].filter(Boolean),
      scrollRoots: [scrollRoot].filter(Boolean),
    };
  }

  scrollSurfaceScope() {
    this.ensureRendered();
    const scrollport = this.querySelector(":scope > .task-new-workspace");
    const cwd = this.selectedContextPath();
    if (this.hidden || !scrollport) {
      return emptyScrollSurfaceScope();
    }
    return {
      blocked: false,
      surfaces: [{
        id: `new:${cwd}:scroll`,
        label: "New Task",
        scrollport,
        clipRoots: [this, scrollport],
        isEligible: () =>
          this.isConnected &&
          !this.hidden &&
          this.selectedContextPath() === cwd &&
          this.querySelector(":scope > .task-new-workspace") === scrollport &&
          hasScrollLayoutBox(this) &&
          hasScrollLayoutBox(scrollport) &&
          hasVerticalScrollOverflow(scrollport),
      }],
      mutationRoots: [this],
      resizeElements: [this, scrollport],
      scrollRoots: [scrollport],
    };
  }

  keyboardNavigationContexts() {
    this.ensureRendered();
    if (this.hidden) {
      return [];
    }
    return mergeKeyboardNavigationContexts(
      this.taskCreate()?.keyboardNavigationContexts({ scopeId: "new" }) ?? [],
      this.directoryPicker()?.keyboardNavigationContexts?.() ?? [],
    );
  }

  taskCreate() {
    return this.querySelector(
      ":scope > .task-new-workspace > caffold-task-create",
    );
  }

  directoryPicker() {
    return this.querySelector(":scope > caffold-task-directory-picker");
  }

  handleCreateIntent(event) {
    if (
      event.target !== this.taskCreate() ||
      event.detail?.type !== "browse-cwd"
    ) {
      return;
    }
    event.stopPropagation();
    this.directoryPicker()?.open(this.selectedContextPath(), {
      opener:
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null,
    });
  }

  handleDirectoryPicked(event) {
    if (event.target !== this.directoryPicker()) {
      return;
    }
    event.stopPropagation();
    this.cwd = cleanLogicalPath(event.detail?.path ?? "");
    this.syncTaskCreate();
    this.dispatchRoute({ kind: "tasks", new: true, cwd: this.cwd });
  }

  syncTaskCreate() {
    const taskCreate = this.taskCreate();
    if (!taskCreate) {
      return;
    }
    taskCreate.setContext({ cwd: this.selectedContextPath(), browseCwd: true });
    taskCreate.setTransportAvailable(this.transportAvailable);
    taskCreate.setCodexStatusSnapshot(this.codexStatusSnapshot);
  }

  dispatchRoute(route) {
    this.dispatchEvent(
      new CustomEvent("caffold:task-new-route-intent", {
        bubbles: true,
        composed: true,
        detail: { route },
      }),
    );
  }
}

if (!customElements.get("caffold-task-new")) {
  customElements.define("caffold-task-new", CaffoldTaskNew);
}
