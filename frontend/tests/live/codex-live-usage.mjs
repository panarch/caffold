export const TOKEN_FIELDS = [
  "totalTokens",
  "inputTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
];

export const LIVE_MODEL_POLICY = Object.freeze({
  reasoningEffort: "low",
  models: Object.freeze({
    spark: "gpt-5.3-codex-spark",
    fast: "gpt-5.6-luna",
    multimodal: "gpt-5.6-luna",
  }),
});

export function assertLiveModelPolicy({ scenario, model, effort }) {
  const expectedModel = LIVE_MODEL_POLICY.models[scenario];
  if (!expectedModel) {
    throw new Error(`Unknown live model policy scenario: ${scenario}`);
  }
  if (model !== expectedModel) {
    throw new Error(
      `Live ${scenario} scenario must use ${expectedModel}, received ${model}`,
    );
  }
  if (effort !== LIVE_MODEL_POLICY.reasoningEffort) {
    throw new Error(
      `Live scenarios must use ${LIVE_MODEL_POLICY.reasoningEffort} reasoning, received ${effort}`,
    );
  }
}

function emptyTokens() {
  return Object.fromEntries(TOKEN_FIELDS.map((field) => [field, 0]));
}

function tokenBreakdown(value) {
  return Object.fromEntries(
    TOKEN_FIELDS.map((field) => [field, Number(value?.[field] ?? 0)]),
  );
}

function addTokens(target, value) {
  for (const field of TOKEN_FIELDS) {
    target[field] += Number(value?.[field] ?? 0);
  }
}

export function collectTestUsage({ title, status, threadModels }) {
  const observed = status?.diagnostics?.usage?.threads ?? {};
  const threads = [];
  const missingThreadIds = [];
  const totals = emptyTokens();

  for (const [threadId, model] of threadModels) {
    const diagnostic = observed[threadId];
    if (!diagnostic?.tokenUsage?.total) {
      missingThreadIds.push(threadId);
      continue;
    }

    const total = tokenBreakdown(diagnostic.tokenUsage.total);
    addTokens(totals, total);
    threads.push({
      threadId,
      model,
      turnId: diagnostic.turnId ?? null,
      modelContextWindow: diagnostic.tokenUsage.modelContextWindow ?? null,
      total,
      last: tokenBreakdown(diagnostic.tokenUsage.last),
    });
  }

  return { title, totals, threads, missingThreadIds };
}

function rateWindow(value) {
  if (!value) {
    return null;
  }
  return {
    usedPercent: Number(value.usedPercent ?? 0),
    windowDurationMins:
      value.windowDurationMins ?? value.windowDurationMinutes ?? null,
    resetsAt: value.resetsAt ?? null,
  };
}

function rateLimit(value, fallbackId, source) {
  return {
    limitId: value?.limitId ?? fallbackId,
    limitName: value?.limitName ?? null,
    source,
    primary: rateWindow(value?.primary),
    secondary: rateWindow(value?.secondary),
  };
}

export function accountUsageSnapshot(status, capturedAt = new Date().toISOString()) {
  const rateLimits = status?.rateLimits ?? {};
  const limits = {};
  const legacy = rateLimits.rateLimits;
  if (legacy) {
    const limit = rateLimit(legacy, "overall", "rateLimits");
    limits[limit.limitId] = limit;
  }
  for (const [fallbackId, value] of Object.entries(
    rateLimits.rateLimitsByLimitId ?? {},
  )) {
    const limit = rateLimit(value, fallbackId, "rateLimitsByLimitId");
    limits[limit.limitId] = limit;
  }

  return {
    capturedAt,
    lifetimeTokens: Number(status?.usage?.summary?.lifetimeTokens ?? 0),
    limits,
  };
}

function accountDelta(before, after) {
  const limits = {};
  for (const limitId of new Set([
    ...Object.keys(before?.limits ?? {}),
    ...Object.keys(after?.limits ?? {}),
  ])) {
    const beforeLimit = before?.limits?.[limitId];
    const afterLimit = after?.limits?.[limitId];
    limits[limitId] = {
      limitName: afterLimit?.limitName ?? beforeLimit?.limitName ?? null,
      primaryUsedPercentagePoints:
        afterLimit?.primary && beforeLimit?.primary
          ? afterLimit.primary.usedPercent - beforeLimit.primary.usedPercent
          : null,
      secondaryUsedPercentagePoints:
        afterLimit?.secondary && beforeLimit?.secondary
          ? afterLimit.secondary.usedPercent - beforeLimit.secondary.usedPercent
          : null,
    };
  }
  return {
    lifetimeTokens: after.lifetimeTokens - before.lifetimeTokens,
    limits,
  };
}

function usageReport({ runId, startedAt, finishedAt, before, after, tests }) {
  const totals = emptyTokens();
  const byModel = {};
  for (const test of tests) {
    addTokens(totals, test.totals);
    for (const thread of test.threads) {
      byModel[thread.model] ??= emptyTokens();
      addTokens(byModel[thread.model], thread.total);
    }
  }

  return {
    schemaVersion: 1,
    runId,
    startedAt,
    finishedAt,
    totals,
    byModel,
    tests,
    account: {
      before,
      after,
      delta: accountDelta(before, after),
    },
    notes: [
      "Thread totals come from the final cumulative thread/tokenUsage/updated notification observed for each live test thread.",
      "Account rate-limit percentages are integer-resolution snapshots and may remain unchanged for a non-zero run.",
      "Account-wide deltas can include other Codex activity on the same subscription during the measurement window.",
    ],
  };
}

export function buildLiveUsageReport({
  runId,
  startedAt,
  finishedAt,
  beforeStatus,
  afterStatus,
  tests,
}) {
  const before = accountUsageSnapshot(beforeStatus, startedAt);
  const after = accountUsageSnapshot(afterStatus, finishedAt);
  return usageReport({
    runId,
    startedAt,
    finishedAt,
    tests,
    before,
    after,
  });
}

export function mergeLiveUsageReports(first, second) {
  if (!first || first.runId !== second.runId) {
    return second;
  }
  return usageReport({
    runId: first.runId,
    startedAt: first.startedAt,
    finishedAt: second.finishedAt,
    before: first.account.before,
    after: second.account.after,
    tests: [...first.tests, ...second.tests],
  });
}

function number(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function percentageDelta(value) {
  if (value === null) {
    return "n/a";
  }
  return `${value >= 0 ? "+" : ""}${value}pp${value === 0 ? " (integer resolution)" : ""}`;
}

export function formatLiveUsageReport(report) {
  const lines = [
    "",
    "Codex live usage",
    `  Exact observed thread tokens: ${number(report.totals.totalTokens)}`,
    `  Input: ${number(report.totals.inputTokens)} (cached ${number(report.totals.cachedInputTokens)})`,
    `  Output: ${number(report.totals.outputTokens)} (reasoning ${number(report.totals.reasoningOutputTokens)})`,
  ];
  for (const [model, tokens] of Object.entries(report.byModel)) {
    lines.push(`  ${model}: ${number(tokens.totalTokens)} tokens`);
  }
  for (const [limitId, delta] of Object.entries(report.account.delta.limits)) {
    const name = delta.limitName ?? limitId;
    lines.push(
      `  Weekly ${name}: ${percentageDelta(delta.primaryUsedPercentagePoints)}`,
    );
  }
  lines.push(
    `  Account lifetime token delta: ${number(report.account.delta.lifetimeTokens)}`,
    "  Artifact: test-results/codex-live-usage.json",
    "",
  );
  return lines.join("\n");
}
