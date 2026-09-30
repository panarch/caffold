// One WebSocket for one attempt to attach to a terminal. The backend closes
// the socket after its last message; a close without one is a failure.

import { terminalSocketUrl } from "#app/api.js";

const LAST_MESSAGES = new Set(["elsewhere", "absent", "taken", "ended"]);
const TAB_STORAGE_KEY = "caffold:terminal-tab";

// The tab's identity when session storage is unavailable, for this page only.
let pageTab = "";

export class TerminalConnection {
  constructor({ subject, mode, size, onMessage, onOutput, onFailure }) {
    this.finished = false;
    this.socket = new WebSocket(
      terminalSocketUrl(subject, { mode, tab: browserTab(), ...size }),
    );
    this.socket.binaryType = "arraybuffer";
    this.socket.addEventListener("message", (event) => {
      if (this.finished) {
        return;
      }
      if (typeof event.data !== "string") {
        onOutput(new Uint8Array(event.data));
        return;
      }
      const type = messageType(event.data);
      if (LAST_MESSAGES.has(type)) {
        this.finished = true;
      }
      onMessage(type);
    });
    this.socket.addEventListener("close", () => {
      if (!this.finished) {
        this.finished = true;
        onFailure();
      }
    });
  }

  send(bytes) {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(bytes);
    }
  }

  resize({ cols, rows }) {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: "resize", cols, rows }));
    }
  }

  close() {
    this.finished = true;
    this.socket.close();
  }
}

// The browser tab this page runs in, kept in session storage across reloads.
// A connection the network dropped stays attached on the backend until it
// notices, and a screen from the same tab takes its place instead of finding
// the terminal open on another screen.
function browserTab() {
  try {
    const stored = window.sessionStorage.getItem(TAB_STORAGE_KEY);
    if (stored) {
      return stored;
    }
    const tab = newTab();
    window.sessionStorage.setItem(TAB_STORAGE_KEY, tab);
    return tab;
  } catch {
    pageTab ||= newTab();
    return pageTab;
  }
}

function newTab() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function messageType(text) {
  try {
    return `${JSON.parse(text)?.type ?? ""}`;
  } catch {
    return "";
  }
}
