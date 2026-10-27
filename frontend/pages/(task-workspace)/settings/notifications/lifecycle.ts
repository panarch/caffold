import type { PushSubscriptionPayload } from "#app/api.js";

export const PUSH_CLIENT_ID_STORAGE_KEY = "caffold:push-client-id";

export type NotificationState =
  | "unsupported"
  | "not-installed"
  | "denied"
  | "granted-not-subscribed"
  | "syncing"
  | "subscribed"
  | "disabled";

// The parts of a browser environment Web Push support depends on.
interface PushEnvironment {
  isSecureContext?: boolean;
  Notification?: unknown;
  PushManager?: unknown;
  navigator?: {
    serviceWorker?: unknown;
    userAgent?: string;
    standalone?: boolean;
  };
  matchMedia?: (query: string) => { matches: boolean } | null | undefined;
}

interface UserAgentNavigator {
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
  userAgentData?: {
    platform?: string;
    getHighEntropyValues?: (hints: string[]) => Promise<{
      fullVersionList?: Array<{ brand: string; version: string }>;
      model?: string;
      platformVersion?: string;
    }>;
  };
}

export function getOrCreatePushClientId(
  storage: Pick<Storage, "getItem" | "setItem"> = window.localStorage,
  cryptoApi: Pick<Crypto, "randomUUID"> = window.crypto,
) {
  const stored = storage.getItem(PUSH_CLIENT_ID_STORAGE_KEY);
  const normalized = typeof stored === "string" ? stored.toLowerCase() : "";
  if (isUuid(normalized)) {
    if (stored !== normalized) {
      storage.setItem(PUSH_CLIENT_ID_STORAGE_KEY, normalized);
    }
    return normalized;
  }
  const generated = cryptoApi.randomUUID();
  storage.setItem(PUSH_CLIENT_ID_STORAGE_KEY, generated);
  return generated;
}

export function pushSupport(
  environment: PushEnvironment = globalThis as PushEnvironment,
) {
  const navigatorValue = environment.navigator;
  const supported = Boolean(
    environment.isSecureContext !== false &&
      environment.Notification &&
      navigatorValue?.serviceWorker &&
      environment.PushManager,
  );
  return {
    supported,
    requiresInstallation: supported && requiresStandaloneInstall(environment),
  };
}

export function notificationState({
  supported,
  requiresInstallation,
  permission,
  hasSubscription,
  serverState,
  syncing = false,
}: {
  supported: boolean;
  requiresInstallation: boolean;
  permission: NotificationPermission | string;
  hasSubscription: boolean;
  serverState: string;
  syncing?: boolean;
}): NotificationState {
  if (!supported) {
    return "unsupported";
  }
  if (requiresInstallation) {
    return "not-installed";
  }
  if (syncing) {
    return "syncing";
  }
  if (permission === "denied") {
    return "denied";
  }
  if (serverState === "revoked") {
    return "disabled";
  }
  if (
    permission === "granted" &&
    hasSubscription &&
    serverState === "subscribed"
  ) {
    return "subscribed";
  }
  if (permission === "granted") {
    return "granted-not-subscribed";
  }
  return "disabled";
}

export function applicationServerKey(encoded: string) {
  const padding = "=".repeat((4 - (encoded.length % 4)) % 4);
  const base64 = `${encoded}${padding}`
    .replaceAll("-", "+")
    .replaceAll("_", "/");
  const raw = window.atob(base64);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

export function subscriptionPayload(
  subscription: Pick<PushSubscription, "endpoint" | "expirationTime"> & {
    toJSON(): { keys?: { p256dh?: string; auth?: string } };
  },
  installationLabel: string,
): PushSubscriptionPayload {
  const json = subscription.toJSON();
  return {
    installationLabel,
    endpoint: subscription.endpoint,
    expirationTime: subscription.expirationTime ?? null,
    keys: {
      p256dh: json.keys?.p256dh ?? "",
      auth: json.keys?.auth ?? "",
    },
  };
}

export async function installationLabel(
  navigatorValue: UserAgentNavigator = window.navigator as UserAgentNavigator,
) {
  let platform =
    navigatorValue.userAgentData?.platform || fallbackPlatform(navigatorValue);
  let browser = fallbackBrowser(navigatorValue.userAgent);
  let model = "";
  try {
    const details = await navigatorValue.userAgentData?.getHighEntropyValues?.([
      "fullVersionList",
      "model",
      "platformVersion",
    ]);
    const preferred = details?.fullVersionList?.find((item) =>
      /chrome|edge|firefox|safari/i.test(item.brand),
    );
    if (preferred) {
      browser = `${normalizeBrowserName(preferred.brand)} ${majorVersion(preferred.version)}`;
    }
    if (details?.platformVersion) {
      platform = `${platform} ${details.platformVersion}`;
    }
    model = details?.model?.trim() ?? "";
  } catch {
    // Low-entropy browser and platform labels remain useful when hints are denied.
  }
  return [...`${browser} on ${platform}${model ? ` (${model})` : ""}`]
    .slice(0, 120)
    .join("");
}

export function shortPushClientId(clientId: string | null | undefined) {
  return `${clientId ?? ""}`.slice(0, 8);
}

function requiresStandaloneInstall(environment: PushEnvironment) {
  const userAgent = environment.navigator?.userAgent ?? "";
  const ios = /iPad|iPhone|iPod/.test(userAgent);
  if (!ios) {
    return false;
  }
  const standalone =
    environment.navigator?.standalone === true ||
    environment.matchMedia?.("(display-mode: standalone)")?.matches === true;
  return !standalone;
}

function fallbackBrowser(userAgent = "") {
  const patterns: Array<[RegExp, string]> = [
    [/(?:Edg|EdgiOS)\/([0-9]+)/, "Edge"],
    [/(?:Chrome|CriOS)\/([0-9]+)/, "Chrome"],
    [/Firefox\/([0-9]+)/, "Firefox"],
    [/Version\/([0-9]+).+Safari/, "Safari"],
  ];
  for (const [pattern, name] of patterns) {
    const match = userAgent.match(pattern);
    if (match) {
      return `${name} ${match[1]}`;
    }
  }
  return "Browser";
}

function fallbackPlatform(navigatorValue: UserAgentNavigator) {
  const userAgent = navigatorValue.userAgent ?? "";
  if (
    /iPad|iPhone|iPod/.test(userAgent) ||
    (navigatorValue.platform === "MacIntel" &&
      (navigatorValue.maxTouchPoints ?? 0) > 1)
  ) {
    return "iOS";
  }
  if (/Mac OS X/.test(userAgent)) {
    const version = userAgent
      .match(/Mac OS X ([0-9_]+)/)?.[1]
      ?.replaceAll("_", ".");
    return version ? `macOS ${version}` : "macOS";
  }
  if (/Android/.test(userAgent)) {
    return "Android";
  }
  return navigatorValue.platform || "Device";
}

function normalizeBrowserName(brand: string) {
  if (/edge/i.test(brand)) return "Edge";
  if (/chrome/i.test(brand)) return "Chrome";
  if (/firefox/i.test(brand)) return "Firefox";
  if (/safari/i.test(brand)) return "Safari";
  return brand.replace(/^Not.A.Brand$/i, "Browser");
}

function majorVersion(version = "") {
  return version.split(".")[0];
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    value,
  );
}
