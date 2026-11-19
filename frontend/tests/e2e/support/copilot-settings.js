// Fictional account data for the Copilot Settings and manual scenarios.
const unlimited = {
  unit: null,
  unlimited: true,
  used: 0,
  entitlement: 0,
  remainingPercentage: 100,
  resetsAt: null,
  resetEstimated: false,
};

export const copilotSettings = {
  installation: { state: "ready", version: "1.0.114" },
  cliPath: "/usr/local/bin/copilot",
  protocolVersion: 4,
  authenticated: true,
  login: "octocat",
  usage: {
    plan: "Copilot Pro",
    quotas: [
      {
        key: "premium_interactions",
        unit: "aiCredits",
        unlimited: false,
        used: 12.5,
        entitlement: 100,
        remainingPercentage: 87.5,
        resetsAt: "2027-01-01T00:00:00Z",
        resetEstimated: false,
      },
      { ...unlimited, key: "chat" },
      { ...unlimited, key: "completions" },
    ],
    errors: [],
  },
  models: [{ model: "mai-code-2", displayName: "MAI Code 2" }],
  modelsError: null,
  error: null,
  runtime: {
    restarting: false,
    running: true,
    pid: 4201,
    version: "0.7.2",
    sessions: 2,
    idleTimeoutSecs: 600,
    error: null,
  },
};
