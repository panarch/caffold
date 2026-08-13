export const PUSH_CLIENT_ID_STORAGE_KEY = "caffold:push-client-id";

export function getOrCreatePushClientId(
  storage = window.localStorage,
  cryptoApi = window.crypto,
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

export function pushSupport(environment = globalThis) {
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
}) {
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
  if (permission === "granted" && hasSubscription && serverState === "subscribed") {
    return "subscribed";
  }
  if (permission === "granted") {
    return "granted-not-subscribed";
  }
  return "disabled";
}

export function applicationServerKey(encoded) {
  const padding = "=".repeat((4 - (encoded.length % 4)) % 4);
  const base64 = `${encoded}${padding}`.replaceAll("-", "+").replaceAll("_", "/");
  const raw = window.atob(base64);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

export function subscriptionPayload(subscription, installationLabel) {
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
  navigatorValue = window.navigator,
) {
  let platform = navigatorValue.userAgentData?.platform || fallbackPlatform(navigatorValue);
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

export function shortPushClientId(clientId) {
  return `${clientId ?? ""}`.slice(0, 8);
}

function requiresStandaloneInstall(environment) {
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
  const patterns = [
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

function fallbackPlatform(navigatorValue) {
  const userAgent = navigatorValue.userAgent ?? "";
  if (
    /iPad|iPhone|iPod/.test(userAgent) ||
    (navigatorValue.platform === "MacIntel" && navigatorValue.maxTouchPoints > 1)
  ) {
    return "iOS";
  }
  if (/Mac OS X/.test(userAgent)) {
    const version = userAgent.match(/Mac OS X ([0-9_]+)/)?.[1]?.replaceAll("_", ".");
    return version ? `macOS ${version}` : "macOS";
  }
  if (/Android/.test(userAgent)) {
    return "Android";
  }
  return navigatorValue.platform || "Device";
}

function normalizeBrowserName(brand) {
  if (/edge/i.test(brand)) return "Edge";
  if (/chrome/i.test(brand)) return "Chrome";
  if (/firefox/i.test(brand)) return "Firefox";
  if (/safari/i.test(brand)) return "Safari";
  return brand.replace(/^Not.A.Brand$/i, "Browser");
}

function majorVersion(version = "") {
  return version.split(".")[0];
}

function isUuid(value) {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}
