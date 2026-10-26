import { html, LitElement } from "lit";
import {
  type ActionHintPull,
  ActionHints,
  mergeActionHintScopes,
} from "#app/action-hints.ts";
import {
  type ScrollSurfacePull,
  ScrollSurfaces,
  scrollBackToTop,
} from "#app/scroll-scope.ts";
import "../../components/workspace-brand.ts";
import "./navigator/components/item.ts";
import { DrawnRef, DrawnRefs, drawn } from "#components/drawn-refs.ts";
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
  private readonly hints = new ActionHints(this);
  private readonly surfaces = new ScrollSurfaces(this);
  private readonly list = new DrawnRef<HTMLElement>(this);
  private readonly items = new DrawnRefs<CaffoldSettingsNavigatorItem>(this);

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
        ${drawn(this.items.of(entry.section))}
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
        ${drawn(this.list)}
        ${this.surfaces.surface({
          id: "sections:scroll",
          clipRoots: () => [this, this.list.value],
        })}
        class="settings-navigator-list"
        aria-label="Settings sections"
      >${items}</nav>
    `;
  }

  actionHintScope({ scopeId = "settings", ...pull }: ActionHintPull = {}) {
    const own = this.hints.scope({ ...pull, scopeId });
    const list = this.list.value;
    return mergeActionHintScopes(
      own,
      ...ITEMS.map(({ section }) =>
        this.items.get(section)?.actionHintScope({
          ...pull,
          scopeId,
          clipRoots: [...(pull.clipRoots ?? []), ...(list ? [list] : [])],
        }),
      ),
    );
  }

  scrollSurfaceScope({
    scopeId = "settings",
    label = "Settings sections",
    ...pull
  }: ScrollSurfacePull = {}) {
    return this.surfaces.scope({ ...pull, scopeId, label });
  }

  scrollToTop() {
    const list = this.list.value;
    if (list) {
      scrollBackToTop(list);
    }
  }
}

customElements.define("caffold-settings-navigator", CaffoldSettingsNavigator);
