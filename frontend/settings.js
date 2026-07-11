const STORAGE_KEY = "caffold:settings";

export const FILE_TREE_SIZES = Object.freeze([
  {
    value: "auto",
    label: "Auto",
    description: "Adapts to pointer and touch input",
  },
  {
    value: "compact",
    label: "Compact",
    description: "24 px rows",
  },
  {
    value: "default",
    label: "Default",
    description: "30 px rows",
  },
  {
    value: "large",
    label: "Large",
    description: "36 px rows",
  },
]);

const DEFAULT_SETTINGS = Object.freeze({
  fileTreeSize: "auto",
});

export function getSettings() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null");
    return normalizeSettings(stored);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function setFileTreeSize(value) {
  const fileTreeSize = validFileTreeSize(value) ? value : DEFAULT_SETTINGS.fileTreeSize;
  const settings = {
    ...getSettings(),
    fileTreeSize,
  };

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // The live setting still applies when storage is unavailable.
  }

  applySettings(settings);
  window.dispatchEvent(
    new CustomEvent("caffold:settings-change", {
      detail: { settings },
    }),
  );
  return settings;
}

export function applySettings(settings = getSettings()) {
  if (typeof document === "undefined") {
    return;
  }

  document.documentElement.dataset.fileTreeSize = settings.fileTreeSize;
}

function normalizeSettings(value) {
  const fileTreeSize = value?.fileTreeSize ?? value?.fileTreeTextSize;
  return {
    fileTreeSize: validFileTreeSize(fileTreeSize) ? fileTreeSize : DEFAULT_SETTINGS.fileTreeSize,
  };
}

function validFileTreeSize(value) {
  return FILE_TREE_SIZES.some((option) => option.value === value);
}

applySettings();
