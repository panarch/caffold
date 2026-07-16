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

export const CODE_SIZES = Object.freeze([
  {
    value: "compact",
    label: "Compact",
    description: "13 px text",
  },
  {
    value: "default",
    label: "Default",
    description: "15 px text",
  },
  {
    value: "large",
    label: "Large",
    description: "17 px text",
  },
]);

export const TASK_LIST_SIZES = Object.freeze([
  {
    value: "compact",
    label: "Compact",
    description: "30 px rows",
  },
  {
    value: "default",
    label: "Default",
    description: "36 px rows",
  },
  {
    value: "large",
    label: "Large",
    description: "42 px rows",
  },
]);

const DEFAULT_SETTINGS = Object.freeze({
  fileTreeSize: "auto",
  codeSize: "compact",
  taskListSize: "default",
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

  persistAndApply(settings);
  return settings;
}

export function setCodeSize(value) {
  const codeSize = validCodeSize(value) ? value : DEFAULT_SETTINGS.codeSize;
  const settings = {
    ...getSettings(),
    codeSize,
  };

  persistAndApply(settings);
  return settings;
}

export function setTaskListSize(value) {
  const taskListSize = validTaskListSize(value) ? value : DEFAULT_SETTINGS.taskListSize;
  const settings = {
    ...getSettings(),
    taskListSize,
  };

  persistAndApply(settings);
  return settings;
}

export function applySettings(settings = getSettings()) {
  if (typeof document === "undefined") {
    return;
  }

  document.documentElement.dataset.fileTreeSize = settings.fileTreeSize;
  document.documentElement.dataset.codeSize = settings.codeSize;
  document.documentElement.dataset.taskListSize = settings.taskListSize;
}

function normalizeSettings(value) {
  const fileTreeSize = value?.fileTreeSize ?? value?.fileTreeTextSize;
  return {
    fileTreeSize: validFileTreeSize(fileTreeSize) ? fileTreeSize : DEFAULT_SETTINGS.fileTreeSize,
    codeSize: validCodeSize(value?.codeSize) ? value.codeSize : DEFAULT_SETTINGS.codeSize,
    taskListSize: validTaskListSize(value?.taskListSize)
      ? value.taskListSize
      : DEFAULT_SETTINGS.taskListSize,
  };
}

function validFileTreeSize(value) {
  return FILE_TREE_SIZES.some((option) => option.value === value);
}

function validCodeSize(value) {
  return CODE_SIZES.some((option) => option.value === value);
}

function validTaskListSize(value) {
  return TASK_LIST_SIZES.some((option) => option.value === value);
}

function persistAndApply(settings) {
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
}

applySettings();
