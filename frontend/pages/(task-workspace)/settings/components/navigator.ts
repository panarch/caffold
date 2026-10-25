import { html, LitElement } from "lit";
import {
  type ActionHintScopeOptions,
  emptyActionHintScope,
  mergeActionHintScopes,
} from "#app/action-hint-scope.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
  type ScrollSurfaceScope,
  type ScrollSurfaceScopeOptions,
  scrollBackToTop,
} from "#app/scroll-scope.js";
import "../../components/workspace-brand.ts";
import "./navigator/components/item.ts";
import type {
  CaffoldSettingsNavigatorItem,
  SettingsNavigatorEntry,
} from "./navigator/components/item.ts";

// Each brand mark is published in a single color so it can be tinted, and the
// theme tints it through --brand-monochrome-filter.
const ITEMS: readonly SettingsNavigatorEntry[] = [
  { section: "appearance", label: "Appearance", icon: "Palette" },
  { section: "keyboard", label: "Keyboard", icon: "Keyboard" },
  { section: "files", label: "Files", icon: "File" },
  { section: "notifications", label: "Notifications", icon: "Bell" },
  { section: "remote-access", label: "Remote Access", icon: "Link" },
  { section: "voice", label: "Voice Input", icon: "Mic" },
  { section: "jev", label: "Jev Permissions", icon: "ShieldCheck" },
  { section: "codex", label: "Codex", brand: "codex-template@2x.png" },
  { section: "claude", label: "Claude", brand: "claude-template.png" },
  { section: "grok", label: "Grok", brand: "grok-template.png" },
  { section: "about", label: "About Caffold", icon: "Info" },
];

export class CaffoldSettingsNavigator extends LitElement {
  static properties = {
    selectedSection: { attribute: false },
    updateAvailable: { attribute: false },
    reloadReady: { attribute: false },
  };

  declare selectedSection: string;
  // Whether a newer Caffold exists, and whether this window has a new build
  // ready to load. Only the About entry shows either.
  declare updateAvailable: boolean;
  declare reloadReady: boolean;

  constructor() {
    super();
    this.selectedSection = "";
    this.updateAvailable = false;
    this.reloadReady = false;
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.performUpdate();
  }

  render() {
    const items = ITEMS.map((entry) => {
      const about = entry.section === "about";
      return html`<caffold-settings-navigator-item
        .entry=${entry}
        .selected=${entry.section === this.selectedSection}
        .updateAvailable=${about && this.updateAvailable}
        .reloadReady=${about && this.reloadReady}
      ></caffold-settings-navigator-item>`;
    });
    return html`
      <header class="settings-navigator-header">
        <caffold-workspace-brand></caffold-workspace-brand>
      </header>
      <nav
        class="settings-navigator-list"
        aria-label="Settings sections"
      >${items}</nav>
    `;
  }

  actionHintScope({
    scopeId = "settings",
    clipRoots = [],
  }: ActionHintScopeOptions = {}) {
    const scroller = this.list;
    if (this.hidden || !scroller) {
      return emptyActionHintScope();
    }
    const isCurrent = () => this.isConnected && !this.hidden;
    const items = scroller.querySelectorAll<CaffoldSettingsNavigatorItem>(
      ":scope > caffold-settings-navigator-item",
    );
    return mergeActionHintScopes(
      {
        blocked: false,
        targets: [],
        mutationRoots: [this],
        scrollRoots: [scroller],
      },
      ...[...items].map((item) =>
        item.actionHintScope({
          scopeId,
          clipRoots: [...clipRoots, scroller],
          isCurrent,
        }),
      ),
    );
  }

  scrollSurfaceScope({
    scopeId = "settings",
    label = "Settings sections",
    clipRoots = [],
    isCurrent = () => true,
  }: ScrollSurfaceScopeOptions = {}): ScrollSurfaceScope {
    const scrollport = this.list;
    if (this.hidden || !scrollport) {
      return emptyScrollSurfaceScope();
    }
    return {
      blocked: false,
      surfaces: [
        {
          id: `${scopeId}:sections:scroll`,
          label,
          scrollport,
          clipRoots: [this, scrollport, ...clipRoots].filter(Boolean),
          isEligible: () =>
            this.isConnected &&
            !this.hidden &&
            isCurrent() &&
            this.list === scrollport &&
            hasScrollLayoutBox(this) &&
            hasScrollLayoutBox(scrollport),
        },
      ],
      mutationRoots: [this],
      resizeElements: [this, scrollport],
      scrollRoots: [scrollport],
    };
  }

  scrollToTop() {
    const list = this.list;
    if (list) {
      scrollBackToTop(list);
    }
  }

  private get list() {
    return this.querySelector<HTMLElement>(":scope > .settings-navigator-list");
  }
}

customElements.define("caffold-settings-navigator", CaffoldSettingsNavigator);
