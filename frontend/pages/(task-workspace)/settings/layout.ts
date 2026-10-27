import { html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import type { ActionHintScope } from "#app/action-hint-scope.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
  mergeActionHintScopes,
} from "#app/action-hints.js";
import {
  mergeScrollSurfaceScopes,
  type ScrollSurfacePull,
  type ScrollSurfaceScope,
  ScrollSurfaces,
} from "#app/scroll-scope.js";
import { inlineIcon, warmIcons } from "#components/icons.js";
import type { CodexStatusSnapshot } from "../codex-status.js";
import "./about/page.js";
import type { Health } from "#app/api.js";
import type { CaffoldUpdateSnapshot } from "./about/page.js";
import "./appearance/page.js";
import "./claude/page.js";
import type { CaffoldSettingsClaudePage } from "./claude/page.js";
import "./codex/page.js";
import type {
  CaffoldSettingsCodexPage,
  ResetCreditState,
  RuntimeRequestState,
} from "./codex/page.js";
import type { CaffoldSettingsNavigator } from "./components/navigator.js";
import "./files/page.js";
import "./grok/page.js";
import "./jev/page.js";
import "./keyboard/page.js";
import "./notifications/page.js";
import "./remote-access/page.js";
import "./voice/page.js";
import type { ParsedRoute } from "#app/navigation-routes.js";
import { DrawnRef, DrawnRefs, drawn } from "#components/drawn-refs.js";
import type { SettingsNavigatorIntentDetail } from "./components/navigator/components/item.js";

export interface RequestSettingsRouteDetail {
  route: ParsedRoute;
}

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
  actionHintScope?: (pull: ActionHintPull) => ActionHintScope;
  scrollSurfaceScope?: (pull: ScrollSurfacePull) => ScrollSurfaceScope;
}

@customElement("caffold-settings-workspace")
export class CaffoldSettingsWorkspace extends LitElement {
  @state()
  private accessor section = "";
  // Whether the list and a section sit side by side, which opens Appearance
  // when no section is named.
  @state()
  private accessor wide: boolean;
  @state()
  private accessor codexStatus: CodexStatusSnapshot | null = null;
  @state()
  private accessor codexRuntimeAction = "idle";
  @state()
  private accessor codexResetCredit: ResetCreditState | null = null;
  @state()
  private accessor health: Health | null = null;
  @state()
  private accessor caffoldUpdate: CaffoldUpdateSnapshot | null = null;
  @state()
  private accessor updateStatus: unknown = null;

  private readonly masterDetailMedia = window.matchMedia(
    SETTINGS_MASTER_DETAIL_MEDIA_QUERY,
  );
  private connectedSettingsNavigator: CaffoldSettingsNavigator | null = null;
  private readonly responsiveChange = () => {
    this.wide = this.masterDetailMedia.matches;
    this.syncPresentation();
  };
  private readonly navigatorIntent = (
    event: CustomEvent<SettingsNavigatorIntentDetail>,
  ) => {
    event.stopPropagation();
    this.requestSection(event.detail?.section);
  };
  private readonly iconsReady = () => this.requestUpdate();
  private readonly hints = new ActionHints(this);
  private readonly surfaces = new ScrollSurfaces(this);
  private readonly detailPane = new DrawnRef<HTMLDivElement>(this);
  private readonly pages = new DrawnRefs<SettingsPage>(this);

  constructor() {
    super();
    this.wide = this.masterDetailMedia.matches;
  }

  override createRenderRoot() {
    return this;
  }

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    this.masterDetailMedia.addEventListener("change", this.responsiveChange);
    this.wide = this.masterDetailMedia.matches;
    this.syncPresentation();
    void warmIcons();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
    this.masterDetailMedia.removeEventListener("change", this.responsiveChange);
    for (const section of ACTIVE_PAGES) {
      this.page(section)?.deactivate?.();
    }
  }

  override render() {
    const presented = this.presentedSection();
    const backIcon = inlineIcon(
      "ArrowLeft",
      "Back to settings",
      "settings-workspace-back-icon",
    );
    return html`
      <div class="settings-workspace-surface">
        <div
          ${drawn(this.detailPane)}
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
              ${this.hints.button({
                id: "parent:list",
                label: "Back to settings",
                action: ACTION_HINT_ACTION.PARENT,
                when: Boolean(this.section),
              })}
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
            ${drawn(this.pages.of("appearance"))}
            ?hidden=${presented !== "appearance"}
          ></caffold-settings-appearance-page>
          <caffold-settings-keyboard-page
            ${drawn(this.pages.of("keyboard"))}
            ?hidden=${presented !== "keyboard"}
          ></caffold-settings-keyboard-page>
          <caffold-settings-files-page
            ${drawn(this.pages.of("files"))}
            ?hidden=${presented !== "files"}
          ></caffold-settings-files-page>
          <caffold-settings-notifications-page
            ${drawn(this.pages.of("notifications"))}
            ?hidden=${presented !== "notifications"}
          ></caffold-settings-notifications-page>
          <caffold-settings-remote-access-page
            ${drawn(this.pages.of("remote-access"))}
            ?hidden=${presented !== "remote-access"}
          ></caffold-settings-remote-access-page>
          <caffold-settings-voice-page
            ${drawn(this.pages.of("voice"))}
            ?hidden=${presented !== "voice"}
          ></caffold-settings-voice-page>
          <caffold-settings-jev-page
            ${drawn(this.pages.of("jev"))}
            ?hidden=${presented !== "jev"}
          ></caffold-settings-jev-page>
          <caffold-settings-codex-page
            ${drawn(this.pages.of("codex"))}
            ?hidden=${presented !== "codex"}
            .snapshot=${this.codexStatus}
            .runtimeAction=${this.codexRuntimeAction}
            .resetCreditState=${this.codexResetCredit}
          ></caffold-settings-codex-page>
          <caffold-settings-claude-page
            ${drawn(this.pages.of("claude"))}
            ?hidden=${presented !== "claude"}
          ></caffold-settings-claude-page>
          <caffold-settings-grok-page
            ${drawn(this.pages.of("grok"))}
            ?hidden=${presented !== "grok"}
          ></caffold-settings-grok-page>
          <caffold-settings-about-page
            ${drawn(this.pages.of("about"))}
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
  override updated() {
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

  // Where Escape takes focus from a field being edited in Settings.
  editingEscapeTarget() {
    return this.detailPane.value ?? null;
  }

  actionHintScope({ scopeId = "settings", ...pull }: ActionHintPull = {}) {
    const own = this.hints.scope({ ...pull, scopeId });
    const presented = this.presentedSection();
    return mergeActionHintScopes(
      own,
      this.page(presented)?.actionHintScope?.({
        scopeId: `${scopeId}:${presented}`,
        clipRoots: [
          this.detailPane.value as HTMLDivElement,
          ...(pull.clipRoots ?? []),
        ],
      }),
    );
  }

  scrollSurfaceScope({
    scopeId = "settings",
    ...pull
  }: ScrollSurfacePull = {}) {
    const own = this.surfaces.scope({ ...pull, scopeId });
    const presented = this.presentedSection();
    return mergeScrollSurfaceScopes(
      own,
      this.page(presented)?.scrollSurfaceScope?.({
        scopeId: `${scopeId}:${presented}`,
        label: TITLES[presented] ?? "Settings",
        clipRoots: [
          this.detailPane.value as HTMLDivElement,
          ...(pull.clipRoots ?? []),
        ],
      }),
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

  setBuildStatus(health: Health | null | undefined) {
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
      new CustomEvent<RequestSettingsRouteDetail>(
        "caffold:request-settings-route",
        {
          bubbles: true,
          detail: { route: { kind: "settings", section: section ?? "" } },
        },
      ),
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
    return this.pages.get(section);
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

declare global {
  interface HTMLElementTagNameMap {
    "caffold-settings-workspace": CaffoldSettingsWorkspace;
  }

  interface HTMLElementEventMap {
    "caffold:request-settings-route": CustomEvent<RequestSettingsRouteDetail>;
  }
}
