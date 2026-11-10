import type { ReactiveController, ReactiveControllerHost } from "lit";

/**
 * This server's name and icon as the document shows them: the tab's title and
 * icon, the name and icon a browser installs Caffold with, and Caffold's mark
 * inside the app. The server owns both. The document starts with the values in
 * the page the server sent, which a service worker may have kept from an
 * earlier visit, and takes every later value from a server answer.
 */
export const SERVER_IDENTITY_CHANGE_EVENT = "caffold:server-identity-change";

export interface ServerIdentity {
  name: string;
  icon: string;
}

// The name is read from a meta tag: the title reads back with its spaces
// collapsed.
export function serverIdentity(): ServerIdentity {
  return {
    name:
      document
        .querySelector('meta[name="application-name"]')
        ?.getAttribute("content") ?? document.title,
    icon:
      document
        .querySelector('meta[name="caffold-server-icon"]')
        ?.getAttribute("content") || "default",
  };
}

/** Shows a server answer's name and icon, and tells the app's marks. */
export function applyServerIdentity(identity: ServerIdentity) {
  const shown = serverIdentity();
  if (shown.name === identity.name && shown.icon === identity.icon) return;
  document.title = identity.name;
  for (const [name, content] of [
    ["application-name", identity.name],
    ["apple-mobile-web-app-title", identity.name],
    ["caffold-server-icon", identity.icon],
  ]) {
    document
      .querySelector(`meta[name="${name}"]`)
      ?.setAttribute("content", content);
  }
  for (const [rel, file] of [
    ["icon", "favicon-32.png"],
    ["apple-touch-icon", "apple-touch-icon.png"],
  ]) {
    document
      .querySelector(`link[rel="${rel}"]`)
      ?.setAttribute("href", serverIconUrl(identity.icon, file));
  }
  window.dispatchEvent(
    new CustomEvent(SERVER_IDENTITY_CHANGE_EVENT, { detail: identity }),
  );
}

/** Where the server draws `file` in `icon`. */
export function serverIconUrl(icon: string, file: string) {
  return `/icons/${encodeURIComponent(icon)}/${file}`;
}

/** Keeps a component's view of the server's icon current while connected. */
export class ServerIdentityController implements ReactiveController {
  identity = serverIdentity();
  private readonly host: ReactiveControllerHost;

  constructor(host: ReactiveControllerHost) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    this.identity = serverIdentity();
    window.addEventListener(SERVER_IDENTITY_CHANGE_EVENT, this.changed);
  }

  hostDisconnected() {
    window.removeEventListener(SERVER_IDENTITY_CHANGE_EVENT, this.changed);
  }

  private readonly changed = (event: CustomEvent<ServerIdentity>) => {
    this.identity = event.detail;
    this.host.requestUpdate();
  };
}

declare global {
  interface WindowEventMap {
    [SERVER_IDENTITY_CHANGE_EVENT]: CustomEvent<ServerIdentity>;
  }
}
