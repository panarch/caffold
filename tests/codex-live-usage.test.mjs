import assert from "node:assert/strict";
import test from "node:test";

import {
  assertLiveModelPolicy,
  buildLiveUsageReport,
  collectTestUsage,
  formatLiveUsageReport,
  LIVE_MODEL_POLICY,
  mergeLiveUsageReports,
} from "./live/codex-live-usage.mjs";

function tokens(totalTokens, overrides = {}) {
  return {
    totalTokens,
    inputTokens: totalTokens - 20,
    cachedInputTokens: totalTokens - 40,
    cacheWriteInputTokens: 0,
    outputTokens: 20,
    reasoningOutputTokens: 5,
    ...overrides,
  };
}

function status({ lifetimeTokens, overallPercent, sparkPercent, threads = {} }) {
  return {
    usage: { summary: { lifetimeTokens } },
    rateLimits: {
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: overallPercent, windowDurationMins: 10080 },
      },
      rateLimitsByLimitId: {
        codex_bengalfox: {
          limitId: "codex_bengalfox",
          limitName: "GPT-5.3-Codex-Spark",
          primary: { usedPercent: sparkPercent, windowDurationMins: 10080 },
        },
      },
    },
    diagnostics: { usage: { threads } },
  };
}

test("enforces the authenticated live model policy", () => {
  for (const [scenario, model] of Object.entries(LIVE_MODEL_POLICY.models)) {
    assert.doesNotThrow(() =>
      assertLiveModelPolicy({
        scenario,
        model,
        effort: "low",
      }),
    );
  }

  assert.throws(
    () =>
      assertLiveModelPolicy({
        scenario: "fast",
        model: "gpt-5.6-sol",
        effort: "low",
      }),
    /must use gpt-5\.6-luna/,
  );
  assert.throws(
    () =>
      assertLiveModelPolicy({
        scenario: "spark",
        model: "gpt-5.3-codex-spark",
        effort: "medium",
      }),
    /must use low reasoning/,
  );
});

test("collects final cumulative usage for every tracked thread", () => {
  const usage = collectTestUsage({
    title: "live case",
    threadModels: new Map([
      ["thread-a", "spark"],
      ["thread-b", "spark"],
      ["thread-missing", "luna"],
    ]),
    status: status({
      lifetimeTokens: 1000,
      overallPercent: 10,
      sparkPercent: 2,
      threads: {
        "thread-a": {
          turnId: "turn-a",
          tokenUsage: {
            total: tokens(100),
            last: tokens(40),
            modelContextWindow: 128000,
          },
        },
        "thread-b": {
          turnId: "turn-b",
          tokenUsage: {
            total: tokens(250),
            last: tokens(90),
            modelContextWindow: 128000,
          },
        },
      },
    }),
  });

  assert.equal(usage.totals.totalTokens, 350);
  assert.equal(usage.totals.outputTokens, 40);
  assert.deepEqual(usage.missingThreadIds, ["thread-missing"]);
  assert.equal(usage.threads[1].turnId, "turn-b");
});

test("reports exact model totals beside account-wide percentage deltas", () => {
  const before = status({
    lifetimeTokens: 50_000,
    overallPercent: 61,
    sparkPercent: 17,
  });
  const after = status({
    lifetimeTokens: 51_250,
    overallPercent: 61,
    sparkPercent: 18,
  });
  const measured = {
    title: "Spark case",
    totals: tokens(1_200),
    missingThreadIds: [],
    threads: [
      {
        threadId: "thread-a",
        model: "gpt-5.3-codex-spark",
        total: tokens(1_200),
      },
    ],
  };
  const report = buildLiveUsageReport({
    runId: "run-1",
    startedAt: "2026-08-13T00:00:00.000Z",
    finishedAt: "2026-08-13T00:05:00.000Z",
    beforeStatus: before,
    afterStatus: after,
    tests: [measured],
  });

  assert.equal(report.totals.totalTokens, 1_200);
  assert.equal(report.byModel["gpt-5.3-codex-spark"].totalTokens, 1_200);
  assert.equal(report.account.delta.lifetimeTokens, 1_250);
  assert.equal(report.account.before.capturedAt, "2026-08-13T00:00:00.000Z");
  assert.equal(report.account.after.capturedAt, "2026-08-13T00:05:00.000Z");
  assert.equal(
    report.account.delta.limits.codex_bengalfox.primaryUsedPercentagePoints,
    1,
  );
  assert.match(formatLiveUsageReport(report), /Weekly GPT-5\.3-Codex-Spark: \+1pp/);
  assert.match(formatLiveUsageReport(report), /Weekly codex: \+0pp \(integer resolution\)/);
});

test("merges sequential Playwright worker reports from one live run", () => {
  const first = buildLiveUsageReport({
    runId: "run-1",
    startedAt: "2026-08-13T00:00:00.000Z",
    finishedAt: "2026-08-13T00:02:00.000Z",
    beforeStatus: status({
      lifetimeTokens: 1_000,
      overallPercent: 10,
      sparkPercent: 17,
    }),
    afterStatus: status({
      lifetimeTokens: 1_100,
      overallPercent: 10,
      sparkPercent: 18,
    }),
    tests: [{ title: "one", totals: tokens(100), threads: [], missingThreadIds: [] }],
  });
  const second = buildLiveUsageReport({
    runId: "run-1",
    startedAt: "2026-08-13T00:02:00.000Z",
    finishedAt: "2026-08-13T00:04:00.000Z",
    beforeStatus: status({
      lifetimeTokens: 1_100,
      overallPercent: 10,
      sparkPercent: 18,
    }),
    afterStatus: status({
      lifetimeTokens: 1_250,
      overallPercent: 11,
      sparkPercent: 19,
    }),
    tests: [{ title: "two", totals: tokens(150), threads: [], missingThreadIds: [] }],
  });

  const merged = mergeLiveUsageReports(first, second);
  assert.equal(merged.tests.length, 2);
  assert.equal(merged.totals.totalTokens, 250);
  assert.equal(merged.account.delta.lifetimeTokens, 250);
  assert.equal(
    merged.account.delta.limits.codex_bengalfox.primaryUsedPercentagePoints,
    2,
  );
});
