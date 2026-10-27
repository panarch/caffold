import { html } from "lit";
import { customElement, property } from "lit/decorators.js";
import {
  type ActionHintPull,
  ActionHints,
  mergeActionHintScopes,
} from "#app/action-hints.js";
import {
  type ScrollSurfacePull,
  ScrollSurfaces,
  scrollBackToTop,
} from "#app/scroll-scope.js";
import "../../components/workspace-brand.js";
import "./navigator/components/item.js";
import { CaffoldElement } from "#app/caffold-element.js";
import { DrawnRef, DrawnRefs, drawn } from "#components/drawn-refs.js";
import type {
  CaffoldSettingsNavigatorItem,
  SettingsNavigatorEntry,
} from "./navigator/components/item.js";

import styles from "./navigator.css.js";

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

@customElement("caffold-settings-navigator")
export class CaffoldSettingsNavigator extends CaffoldElement {
  @property({ attribute: false })
  accessor selectedSection = "";
  // Whether a newer Caffold exists, and whether this window has a new build
  // ready to load. Only the About entry shows either.
  @property({ attribute: false })
  accessor updateAvailable = false;
  @property({ attribute: false })
  accessor reloadReady = false;

  static override styles = styles;

  private readonly hints = new ActionHints(this);
  private readonly surfaces = new ScrollSurfaces(this);
  private readonly list = new DrawnRef<HTMLElement>(this);
  private readonly items = new DrawnRefs<CaffoldSettingsNavigatorItem>(this);

  override render() {
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

declare global {
  interface HTMLElementTagNameMap {
    "caffold-settings-navigator": CaffoldSettingsNavigator;
  }
}
