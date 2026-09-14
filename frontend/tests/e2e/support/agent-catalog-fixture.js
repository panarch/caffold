// Models and permission modes as the Codex, Claude, and Grok drivers answer
// them: Codex modes do not depend on the model, only some Claude models may
// decide permissions for themselves, and Grok fixes its mode when the
// conversation starts.
export const AGENT_CATALOG = {
  models: [
    {
      provider: "codex",
      model: "gpt-6-astra",
      displayName: "GPT-6-Astra",
      description: "Frontier agentic coding model.",
      isDefault: true,
      defaultEffort: "medium",
      efforts: ["low", "medium", "high", "xhigh", "max"],
      supportsFastMode: true,
      supportsAutoMode: false,
    },
    {
      provider: "codex",
      model: "gpt-5.6-sol",
      displayName: "GPT-5.6-Sol",
      description: "Latest frontier agentic coding model.",
      isDefault: false,
      defaultEffort: "low",
      efforts: ["low", "medium", "high", "xhigh"],
      supportsFastMode: true,
      supportsAutoMode: false,
    },
    {
      provider: "claude",
      model: "opus[1m]",
      displayName: "Opus 5 with 1M context",
      description: "Opus 5 with 1M context · Most capable for complex work",
      isDefault: false,
      defaultEffort: null,
      efforts: ["low", "medium", "high", "xhigh", "max"],
      supportsFastMode: false,
      supportsAutoMode: true,
    },
    {
      provider: "claude",
      model: "haiku",
      displayName: "Haiku 4.5",
      description: "Haiku 4.5 · Fastest for quick answers",
      isDefault: false,
      defaultEffort: null,
      efforts: [],
      supportsFastMode: false,
      supportsAutoMode: false,
    },
    {
      provider: "grok",
      model: "grok-4.6",
      displayName: "Grok 4.6",
      description: "Grok 4.6 (Latest)",
      isDefault: true,
      defaultEffort: "xhigh",
      efforts: ["low", "medium", "high", "xhigh"],
      supportsFastMode: false,
      supportsAutoMode: true,
    },
  ],
  unavailable: [],
};

export function agentPermissionModes(provider, model) {
  if (provider === "claude") {
    return claudePermissionModes(model);
  }
  if (provider === "grok") {
    return GROK_PERMISSION_MODES;
  }
  return CODEX_PERMISSION_MODES;
}

// Answers the model list and each permission list from the catalog. `answer`
// receives the list a request asked for, so a test can hold or refuse one list
// without restating the others.
export async function installAgentCatalog(page, { answer } = {}) {
  await page.unroute("**/api/agent/models");
  await page.route("**/api/agent/models", (route) =>
    route.fulfill({ json: AGENT_CATALOG }),
  );
  await page.unroute("**/api/agent/permissions*");
  await page.route("**/api/agent/permissions*", (route) => {
    const url = new URL(route.request().url());
    const provider = url.searchParams.get("provider") ?? "";
    const model = url.searchParams.get("model") ?? "";
    const modes = agentPermissionModes(provider, model);
    return answer
      ? answer({ provider, model, modes, route })
      : route.fulfill({ json: modes });
  });
}

const CODEX_PERMISSION_MODES = {
  defaultMode: "approveForMe",
  fixedWhenConversationStarts: false,
  options: [
    {
      mode: "askForApproval",
      label: "Ask for approval",
      description: "Work in the workspace and ask before crossing its boundary.",
      allowed: true,
      dangerous: false,
    },
    {
      mode: "approveForMe",
      label: "Approve for me",
      description: "Keep the workspace boundary and review eligible requests automatically.",
      allowed: true,
      dangerous: false,
    },
    {
      mode: "fullAccess",
      label: "Full access",
      description: "Run without sandbox restrictions or approval prompts.",
      allowed: true,
      dangerous: true,
    },
  ],
};

function claudePermissionModes(model) {
  const auto = AGENT_CATALOG.models.some(
    (option) =>
      option.provider === "claude" &&
      option.model === model &&
      option.supportsAutoMode,
  );
  return {
    defaultMode: auto ? "auto" : "default",
    fixedWhenConversationStarts: false,
    options: [
      {
        mode: "auto",
        label: "Automatic",
        description: "The model decides what needs asking about, and asks only for that.",
        allowed: auto,
        ...(auto
          ? {}
          : { unavailableReason: "This model cannot decide permissions for itself." }),
        dangerous: false,
      },
      {
        mode: "default",
        label: "Ask each time",
        description: "Stops for permission before every tool call it is not sure about.",
        allowed: true,
        dangerous: false,
      },
      {
        mode: "acceptEdits",
        label: "Accept edits",
        description: "Edits files without asking. Still stops for commands and anything reaching outside the workspace.",
        allowed: true,
        dangerous: false,
      },
      {
        mode: "plan",
        label: "Plan only",
        description: "Reads and reasons, and changes nothing until you accept a plan.",
        allowed: true,
        dangerous: false,
      },
      {
        mode: "bypassPermissions",
        label: "Full access",
        description: "Never asks. Every tool call runs, including ones that reach outside the workspace.",
        allowed: true,
        dangerous: true,
      },
    ],
  };
}

const GROK_PERMISSION_MODES = {
  defaultMode: "ask",
  fixedWhenConversationStarts: true,
  options: [
    {
      mode: "ask",
      label: "Ask first",
      description: "Grok asks before anything its own policy does not already allow.",
      allowed: true,
      dangerous: false,
    },
    {
      mode: "autoMode",
      label: "Grok decides",
      description: "Grok decides what to allow, and asks nobody.",
      allowed: true,
      dangerous: false,
    },
    {
      mode: "yoloMode",
      label: "Allow all",
      description: "Every tool call runs. Grok does not ask.",
      allowed: true,
      dangerous: true,
    },
  ],
};
