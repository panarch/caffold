import { escapeHtml } from "../../../components/dom.js";
import { renderInlineIcon } from "../../../components/icons.js";

export function renderGroupButton({
  group,
  popoverId,
  icon,
  brandIcon = null,
  label,
  title,
  badge = "",
  state = "available",
}) {
  return `
    <button
      type="button"
      class="header-action-group-button"
      data-action-group="${escapeHtml(group)}"
      data-state="${escapeHtml(state)}"
      aria-controls="${escapeHtml(popoverId)}"
      aria-expanded="false"
      title="${escapeHtml(title)}"
      aria-label="${escapeHtml(title)}"
    >
      ${
        brandIcon
          ? renderBrandIcon(brandIcon, label)
          : renderInlineIcon(icon, label, "header-action-icon")
      }
      ${
        badge
          ? `<span class="header-action-badge" aria-hidden="true">${escapeHtml(badge)}</span>`
          : ""
      }
    </button>
  `;
}

export function renderMenuAction({ action, icon, label, title, metric = "" }) {
  const metricText = metric === null || metric === undefined ? "" : `${metric}`.trim();

  return `
    <button
      type="button"
      class="header-menu-item"
      data-action="${escapeHtml(action)}"
      title="${escapeHtml(title)}"
      aria-label="${escapeHtml(title)}"
    >
      ${renderInlineIcon(icon, title, "header-menu-icon")}
      <span class="header-menu-label">${escapeHtml(label)}</span>
      ${
        metricText
          ? `<span class="header-menu-metric">${escapeHtml(metricText)}</span>`
          : ""
      }
    </button>
  `;
}

export function renderHeaderNotice(message) {
  return `
    <div class="header-actions-notice">
      <p>${escapeHtml(message)}</p>
    </div>
  `;
}

function renderBrandIcon(icon, label) {
  return `
    <picture class="header-action-brand-picture" aria-hidden="true">
      <source
        srcset="${escapeHtml(icon.dark)}"
        media="(prefers-color-scheme: dark)"
      />
      <img
        class="header-action-icon header-action-brand-icon"
        src="${escapeHtml(icon.light)}"
        alt=""
        draggable="false"
      />
    </picture>
    <span class="sr-only">${escapeHtml(label)}</span>
  `;
}
