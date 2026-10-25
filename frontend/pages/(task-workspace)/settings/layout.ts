import { html, LitElement } from "lit";
import {
  buttonActionHintTarget,
  emptyActionHintScope,
  hasActionHintLayoutBox,
  mergeActionHintScopes,
} from "#app/action-hint-scope.js";
import { ACTION_HINT_ACTION } from "#app/action-hints.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
} from "#app/scroll-scope.js";
import { inlineIcon, warmIcons } from "#components/icons.ts";
import type { CodexStatusSnapshot } from "../codex-status.js";
import "./about/page.ts";
import type { CaffoldUpdateSnapshot, ServerHealth } from "./about/page.ts";
import "./appearance/page.ts";
import "./claude/page.ts";
import type { CaffoldSettingsClaudePage } from "./claude/page.ts";
import "./codex/page.ts";
import type {
  CaffoldSettingsCodexPage,
  ResetCreditState,
  RuntimeRequestState,
} from "./codex/page.ts";
import type { CaffoldSettingsNavigator } from "./components/navigator.ts";
import "./files/page.ts";
import "./grok/page.ts";
import "./jev/page.ts";
import "./keyboard/page.ts";
import "./notifications/page.ts";
import "./remote-access/page.ts";
import "./voice/page.ts";

const TITLES: Readonly<Record<string, string>> = {
  appearance: "Appearance",
  keyboard: "Keyboard",
  files: "Files",
  notifications: "Notifications",
  "remote-access": "Remote Access",
  voice: "Voice Input",
  jev: "Jev Permissions",
  codex: "Codex",
  claude: "Claude",
  grok: "Grok",
  about: "About Caffold",
};
const SETTINGS_MASTER_DETAIL_MEDIA_QUERY = "(min-width: 900px)";
const PAGE_ELEMENTS: Readonly<Record<string, string>> = {
  appearance: "caffold-settings-appearance-page",
  keyboard: "caffold-settings-keyboard-page",
  files: "caffold-settings-files-page",
  notifications: "caffold-settings-notifications-page",
  "remote-access": "caffold-settings-remote-access-page",
  voice: "caffold-settings-voice-page",
  jev: "caffold-settings-jev-page",
  codex: "caffold-settings-codex-page",
  claude: "caffold-settings-claude-page",
  grok: "caffold-settings-grok-page",
  about: "caffold-settings-about-page",
};
// The pages that read while they are shown and stop when they are not.
const ACTIVE_PAGES = [
  "codex",
  "claude",
  "grok",
  "notifications",
  "remote-access",
  "voice",
  "jev",
];
// The pages that read the browser's own settings again on every route.
const ROUTED_PAGES = ["appearance", "keyboard", "files"];

interface SettingsPage extends HTMLElement {
  activate?: () => void;
  deactivate?: () => void;
  prepareRoute?: () => void;
  actionHintScope?: (options: {
    scopeId: string;
    clipRoots: Element[];
    isCurrent: () => boolean;
  }) => ReturnType<typeof emptyActionHintScope>;
  scrollSurfaceScope?: (options: {
    scopeId: string;
    label: string;
    clipRoots: Element[];
    isCurrent: () => boolean;
  }) => ReturnType<typeof emptyScrollSurfaceScope>;
}

export class CaffoldSettingsWorkspace extends LitElement {
  static properties = {
    section: { state: true },
    wide: { state: true },
    codexStatus: { state: true },
    codexRuntimeAction: { state: true },
    codexResetCredit: { state: true },
    health: { state: true },
    caffoldUpdate: { state: true },
    updateStatus: { state: true },
  };

  declare private section: string;
  // Whether the list and a section sit side by side, which opens Appearance
  // when no section is named.
  declare private wide: boolean;
  declare private codexStatus: CodexStatusSnapshot | null;
  declare private codexRuntimeAction: string;
  declare private codexResetCredit: ResetCreditState | null;
  declare private health: ServerHealth | null;
  declare private caffoldUpdate: CaffoldUpdateSnapshot | null;
  declare private updateStatus: unknown;
  private readonly masterDetailMedia = window.matchMedia(
    SETTINGS_MASTER_DETAIL_MEDIA_QUERY,
  );
  private connectedSettingsNavigator: CaffoldSettingsNavigator | null = null;
  private readonly responsiveChange = () => {
    this.wide = this.masterDetailMedia.matches;
    this.syncPresentation();
  };
  private readonly navigatorIntent = (event: Event) => {
    event.stopPropagation();
    this.requestSection(
      (event as CustomEvent<{ section?: string }>).detail?.section,
    );
  };
  private readonly iconsReady = () => this.requestUpdate();

  constructor() {
    super();
    this.section = "";
    this.wide = this.masterDetailMedia.matches;
    this.codexStatus = null;
    this.codexRuntimeAction = "idle";
    this.codexResetCredit = null;
    this.health = null;
    this.caffoldUpdate = null;
    this.updateStatus = null;
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    this.masterDetailMedia.addEventListener("change", this.responsiveChange);
    this.wide = this.masterDetailMedia.matches;
    this.syncPresentation();
    void warmIcons();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
    this.masterDetailMedia.removeEventListener("change", this.responsiveChange);
    for (const section of ACTIVE_PAGES) {
      this.page(section)?.deactivate?.();
    }
  }

  render() {
    const presented = this.presentedSection();
    const backIcon = inlineIcon(
      "ArrowLeft",
      "Back to settings",
      "settings-workspace-back-icon",
    );
    return html`
      <div class="settings-workspace-surface">
        <div
          class="settings-workspace-detail-pane"
          role="region"
          aria-labelledby="settings-workspace-title"
          tabindex="-1"
        >
          <header
            class="settings-workspace-detail-header"
            ?hidden=${!presented}
          >
            <button
              type="button"
              data-action="back-to-settings"
              title="Back to settings"
              aria-label="Back to settings"
              @click=${() => this.requestSection("")}
            >
              <span data-settings-back-icon>
                ${backIcon}
              </span>
            </button>
            <h1 id="settings-workspace-title">${
              TITLES[presented] ?? "Settings"
            }</h1>
          </header>
          <caffold-settings-appearance-page
            ?hidden=${presented !== "appearance"}
          ></caffold-settings-appearance-page>
          <caffold-settings-keyboard-page
            ?hidden=${presented !== "keyboard"}
          ></caffold-settings-keyboard-page>
          <caffold-settings-files-page
            ?hidden=${presented !== "files"}
          ></caffold-settings-files-page>
          <caffold-settings-notifications-page
            ?hidden=${presented !== "notifications"}
          ></caffold-settings-notifications-page>
          <caffold-settings-remote-access-page
            ?hidden=${presented !== "remote-access"}
          ></caffold-settings-remote-access-page>
          <caffold-settings-voice-page
            ?hidden=${presented !== "voice"}
          ></caffold-settings-voice-page>
          <caffold-settings-jev-page
            ?hidden=${presented !== "jev"}
          ></caffold-settings-jev-page>
          <caffold-settings-codex-page
            ?hidden=${presented !== "codex"}
            .snapshot=${this.codexStatus}
            .runtimeAction=${this.codexRuntimeAction}
            .resetCreditState=${this.codexResetCredit}
          ></caffold-settings-codex-page>
          <caffold-settings-claude-page
            ?hidden=${presented !== "claude"}
          ></caffold-settings-claude-page>
          <caffold-settings-grok-page
            ?hidden=${presented !== "grok"}
          ></caffold-settings-grok-page>
          <caffold-settings-about-page
            ?hidden=${presented !== "about"}
            .health=${this.health}
            .caffoldUpdate=${this.caffoldUpdate}
            .updateStatus=${this.updateStatus}
          ></caffold-settings-about-page>
        </div>
      </div>
    `;
  }

  // The navigator is not part of this element's template, so it takes the
  // presented section here.
  updated() {
    const presented = this.presentedSection();
    const view = presented ? "detail" : "list";
    if (this.dataset.settingsView !== view) {
      this.dataset.settingsView = view;
    }
    if (this.connectedSettingsNavigator) {
      this.connectedSettingsNavigator.selectedSection = presented;
    }
  }

  connectSettingsNavigator(navigator: CaffoldSettingsNavigator | null) {
    if (this.connectedSettingsNavigator === navigator) {
      return;
    }
    this.connectedSettingsNavigator?.removeEventListener(
      "caffold:settings-navigator-intent",
      this.navigatorIntent,
    );
    this.connectedSettingsNavigator = navigator ?? null;
    if (!navigator) {
      return;
    }
    navigator.addEventListener(
      "caffold:settings-navigator-intent",
      this.navigatorIntent,
    );
    navigator.selectedSection = this.presentedSection();
    navigator.updateAvailable = this.updateAvailable();
    navigator.reloadReady = this.reloadReady();
  }

  prepareRoute(route: { kind?: string; section?: string } | null | undefined) {
    this.section = route?.kind === "settings" ? (route.section ?? "") : "";
    this.syncPresentation();
  }

  actionHintScope({
    scopeId = "settings",
    clipRoots = [],
  }: {
    scopeId?: string;
    clipRoots?: Element[];
  } = {}) {
    if (this.hidden) {
      return emptyActionHintScope();
    }
    this.performUpdate();
    const presented = this.presentedSection();
    const page = this.page(presented);
    const detailPane = this.querySelector(
      ":scope > .settings-workspace-surface > .settings-workspace-detail-pane",
    );
    const header = detailPane?.querySelector<HTMLElement>(
      ":scope > .settings-workspace-detail-header",
    );
    const backSelector = ':scope > button[data-action="back-to-settings"]';
    const control = header?.querySelector<HTMLButtonElement>(backSelector);
    const ownScope =
      this.section && control && !control.disabled && !header?.hidden
        ? {
            blocked: false,
            targets: [
              buttonActionHintTarget({
                invalidationOwner: this,
                id: `${scopeId}:parent:list`,
                actionId: ACTION_HINT_ACTION.PARENT,
                label: control.getAttribute("aria-label") || "Back to settings",
                control,
                clipRoots: [...clipRoots],
                isActionable: () =>
                  this.isConnected &&
                  !this.hidden &&
                  Boolean(this.section) &&
                  !header?.hidden &&
                  header?.querySelector(backSelector) === control &&
                  !control.disabled,
              }),
            ],
            mutationRoots: [header, control].filter(
              (node): node is HTMLElement => Boolean(node),
            ),
            scrollRoots: [],
          }
        : emptyActionHintScope();
    const pageScope =
      presented && page && !page.hidden && hasActionHintLayoutBox(page)
        ? page.actionHintScope?.({
            scopeId: `${scopeId}:${presented}`,
            clipRoots: [detailPane, ...clipRoots].filter(
              (root): root is Element => Boolean(root),
            ),
            isCurrent: () =>
              this.presentedSection() === presented &&
              this.page(presented) === page &&
              !page.hidden,
          })
        : null;
    return mergeActionHintScopes(ownScope, pageScope);
  }

  scrollSurfaceScope({
    scopeId = "settings",
    clipRoots = [],
  }: {
    scopeId?: string;
    clipRoots?: Element[];
  } = {}) {
    if (this.hidden) {
      return emptyScrollSurfaceScope();
    }
    this.performUpdate();
    const presented = this.presentedSection();
    const page = this.page(presented);
    const detailPane = this.querySelector(
      ":scope > .settings-workspace-surface > .settings-workspace-detail-pane",
    );
    if (!presented || !page || page.hidden || !hasScrollLayoutBox(page)) {
      return emptyScrollSurfaceScope();
    }
    return (
      page.scrollSurfaceScope?.({
        scopeId: `${scopeId}:${presented}`,
        label: TITLES[presented] ?? "Settings",
        clipRoots: [detailPane, ...clipRoots].filter((root): root is Element =>
          Boolean(root),
        ),
        isCurrent: () =>
          this.presentedSection() === presented &&
          this.page(presented) === page &&
          !page.hidden,
      }) ?? emptyScrollSurfaceScope()
    );
  }

  setCodexStatusSnapshot(snapshot: CodexStatusSnapshot | null | undefined) {
    this.codexStatus = snapshot ?? null;
    this.performUpdate();
  }

  setCodexRestartState(state: RuntimeRequestState | null | undefined) {
    this.codexPage?.setRestartState(state);
  }

  setCodexUpdateState(state: RuntimeRequestState | null | undefined) {
    this.codexPage?.setUpdateState(state);
  }

  setCodexResetCreditState(state: ResetCreditState | null | undefined) {
    this.codexResetCredit = state ?? null;
    this.performUpdate();
  }

  setCodexRuntimeAction(action: string | null | undefined) {
    this.codexRuntimeAction = action ?? "idle";
    this.performUpdate();
  }

  setClaudeRestartState(
    state: { state?: string; message?: string } | null | undefined,
  ) {
    this.claudePage?.setRestartState(state ?? null);
  }

  setBuildStatus(health: ServerHealth | null | undefined) {
    this.health = health ?? null;
    this.performUpdate();
  }

  setUpdateStatus(status: unknown) {
    this.updateStatus = status ?? null;
    if (this.connectedSettingsNavigator) {
      this.connectedSettingsNavigator.reloadReady = this.reloadReady();
    }
    this.performUpdate();
  }

  setCaffoldUpdate(snapshot: CaffoldUpdateSnapshot | null | undefined) {
    this.caffoldUpdate = snapshot ?? null;
    if (this.connectedSettingsNavigator) {
      this.connectedSettingsNavigator.updateAvailable = this.updateAvailable();
    }
    this.performUpdate();
  }

  private presentedSection() {
    return this.section || (this.wide ? "appearance" : "");
  }

  // The shown page reads; the others stop. The pages are drawn before they
  // are told, and the workspace hears of the presentation afterwards.
  private syncPresentation() {
    this.performUpdate();
    const presented = this.presentedSection();
    for (const section of ACTIVE_PAGES) {
      const page = this.page(section);
      if (section === presented) {
        page?.activate?.();
      } else {
        page?.deactivate?.();
      }
    }
    for (const section of ROUTED_PAGES) {
      this.page(section)?.prepareRoute?.();
    }
    this.dispatchEvent(
      new CustomEvent("caffold:settings-presentation-change", {
        bubbles: true,
      }),
    );
  }

  private requestSection(section: string | null | undefined) {
    this.dispatchEvent(
      new CustomEvent("caffold:request-settings-route", {
        bubbles: true,
        detail: { route: { kind: "settings", section: section ?? "" } },
      }),
    );
  }

  private updateAvailable() {
    return this.caffoldUpdate?.status?.updateAvailable === true;
  }

  private reloadReady() {
    const status = this.updateStatus as {
      preparedUpdate?: { ready?: unknown };
    } | null;
    return status?.preparedUpdate?.ready === true;
  }

  private page(section: string) {
    const name = PAGE_ELEMENTS[section];
    return name
      ? this.querySelector<SettingsPage>(
          `:scope > .settings-workspace-surface > .settings-workspace-detail-pane > ${name}`,
        )
      : null;
  }

  private get codexPage() {
    this.performUpdate();
    return this.page("codex") as CaffoldSettingsCodexPage | null;
  }

  private get claudePage() {
    this.performUpdate();
    return this.page("claude") as CaffoldSettingsClaudePage | null;
  }
}

customElements.define("caffold-settings-workspace", CaffoldSettingsWorkspace);
