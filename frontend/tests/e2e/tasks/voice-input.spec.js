import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import {
  installTaskApiFixture,
  taskDetailFixture,
} from "../support/task-api-fixture.js";
import { installTaskLoopFixture } from "../support/task-loop-fixture.js";
import {
  captureReviewScreenshot,
  emitTaskDetailBootstrap,
} from "../support/task-fixtures.js";

const MODEL_ID = "large-v3-turbo";
const MODEL_BYTES = 1_624_555_275;

test.use({
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  },
  permissions: ["microphone"],
});

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

test("records without focusing the prompt and inserts a host transcript at the saved selection", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  const scenario = await installTaskLoopFixture(page);
  await mockVoiceStatus(page, true);
  let transcriptionRequests = 0;
  await page.route("**/api/voice/transcribe", async (route) => {
    transcriptionRequests += 1;
    const request = route.request();
    const wav = request.postDataBuffer();
    expect(request.headers()["content-type"]).toBe("audio/wav");
    expect(wav?.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav?.subarray(8, 12).toString()).toBe("WAVE");
    expect(wav?.readUInt16LE(22)).toBe(1);
    expect(wav?.readUInt32LE(24)).toBe(16_000);
    expect(wav?.readUInt16LE(34)).toBe(16);
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        text:
          transcriptionRequests === 1 ? "로컬 음성 입력" : "두 번째 입력",
      }),
    });
  });

  await page.goto(`/tasks/new?cwd=${scenario.contextPath}`);
  const composer = page.locator(
    'caffold-task-new caffold-task-composer form[data-task-form="create"]',
  );
  const prompt = composer.locator('textarea[name="prompt"]');
  await expect(composer).toHaveAttribute("data-voice-state", "idle");
  await expect(composer.locator("caffold-voice-level-meter")).toHaveCount(0);
  await prompt.fill("앞쪽 뒤쪽");
  await prompt.evaluate((textarea) => textarea.setSelectionRange(3, 5));
  const initialViewportHeight = await page.evaluate(() => window.innerHeight);

  const startVoice = composer.getByRole("button", {
    name: "Start voice input",
  });
  const idleActionLayout = await composer.evaluate((form) => {
    const voice = form.querySelector(".task-voice-button").getBoundingClientRect();
    const send = form.querySelector(".task-primary-action-button").getBoundingClientRect();
    return {
      voiceCenter: voice.left + voice.width / 2,
      sendCenter: send.left + send.width / 2,
    };
  });
  await startVoice.evaluate((button) => {
    const textarea = button
      .closest("form")
      .querySelector("textarea[name='prompt']");
    button.addEventListener(
      "pointerup",
      () => textarea.setSelectionRange(0, 0),
      { once: true },
    );
  });
  await startVoice.click();
  await expect(composer).toHaveAttribute("data-voice-state", "recording");
  await expect(composer.locator(".task-composer-voice-status")).toHaveCount(0);
  await expect(composer.getByRole("timer")).toHaveText("0:00");
  const meter = composer.locator("caffold-voice-level-meter");
  await expect(meter).toBeVisible();
  await expect(meter).toHaveAttribute("aria-hidden", "true");
  await expect(meter.locator(":scope > .task-voice-level-segment")).toHaveCount(16);
  await expect(prompt).not.toBeFocused();
  await expect
    .poll(() =>
      composer.evaluate(
        (form) =>
          form.closest("caffold-task-composer")?.voiceRecorder?.sampleCount ?? 0,
      ),
    )
    .toBeGreaterThan(0);
  expect(await page.evaluate(() => window.innerHeight)).toBe(
    initialViewportHeight,
  );
  const levelPresentation = await composer.evaluate((form) => {
    const host = form.closest("caffold-task-composer");
    const recorder = host.voiceRecorder;
    const levelMeter = form.querySelector("caffold-voice-level-meter");
    const textarea = form.querySelector("textarea[name='prompt']");
    const meterWidth = levelMeter.getBoundingClientRect().width;
    const start = performance.now();
    const silent = new Float32Array(512);
    recorder.levelTracker.reset();
    recorder.captureChunk(silent, start);
    recorder.captureChunk(silent, start + 100);
    const silentLevel = Number(levelMeter.dataset.level);
    const quietTransforms = Array.from(levelMeter.children, (segment) =>
      segment.style.transform,
    );

    const speech = new Float32Array(512).fill(0.5);
    recorder.levelTracker.reset();
    recorder.captureChunk(speech, start + 200);
    recorder.captureChunk(speech, start + 300);
    const speechLevel = Number(levelMeter.dataset.level);
    const speechTransforms = Array.from(levelMeter.children, (segment) =>
      segment.style.transform,
    );
    levelMeter.setLevel(0.25);
    levelMeter.setLevel(0.75);
    const historyScales = Array.from(levelMeter.children, (segment) =>
      Number(segment.style.transform.match(/scaleY\(([^)]+)\)/)?.[1]),
    );
    const segmentStyle = getComputedStyle(levelMeter.firstElementChild);
    const segmentHeight = Number(segmentStyle.height.replace("px", ""));
    const transformOriginY = Number(
      segmentStyle.transformOrigin.split(" ")[1].replace("px", ""),
    );
    return {
      meterWidth,
      stableMeter: levelMeter === form.querySelector("caffold-voice-level-meter"),
      stablePrompt: textarea === form.querySelector("textarea[name='prompt']"),
      silentLevel,
      speechLevel,
      quietTransforms,
      speechTransforms,
      historyScales,
      segmentHeight,
      transformOriginY,
      transitionDuration: segmentStyle.transitionDuration,
      transitionProperty: segmentStyle.transitionProperty,
    };
  });
  expect(levelPresentation).toEqual(
    expect.objectContaining({
      stableMeter: true,
      stablePrompt: true,
      silentLevel: 0,
      transitionDuration: "0.09s, 0.09s",
      transitionProperty: "transform, opacity",
    }),
  );
  expect(levelPresentation.meterWidth).toBeGreaterThan(0);
  expect(levelPresentation.speechLevel).toBeGreaterThan(0.6);
  expect(levelPresentation.speechTransforms).not.toEqual(
    levelPresentation.quietTransforms,
  );
  expect(levelPresentation.historyScales).toHaveLength(16);
  expect(levelPresentation.historyScales.at(-1)).toBeGreaterThan(
    levelPresentation.historyScales.at(-2),
  );
  expect(levelPresentation.historyScales.at(-2)).toBeGreaterThan(
    levelPresentation.historyScales[0],
  );
  expect(levelPresentation.transformOriginY).toBeCloseTo(
    levelPresentation.segmentHeight / 2,
    1,
  );
  const toolLayout = await composer.evaluate((form) => {
    const modelName = form.querySelector(".task-model-name");
    const items = Array.from(
      form.querySelectorAll(".task-composer-tools > *"),
      (element) => element.getBoundingClientRect(),
    ).filter((rect) => rect.width > 0 && rect.height > 0);
    const actions = Array.from(
      form.querySelectorAll(".task-composer-actions > *"),
      (element) => element.getBoundingClientRect(),
    ).filter((rect) => rect.width > 0 && rect.height > 0);
    const voice = form
      .querySelector(".task-voice-button")
      .getBoundingClientRect();
    const elapsedElement = form.querySelector(".task-voice-elapsed");
    const elapsed = elapsedElement.getBoundingClientRect();
    const elapsedStyle = getComputedStyle(elapsedElement);
    const elapsedTextRange = document.createRange();
    elapsedTextRange.selectNodeContents(elapsedElement);
    const elapsedText = elapsedTextRange.getBoundingClientRect();
    const meter = form
      .querySelector("caffold-voice-level-meter")
      .getBoundingClientRect();
    const cancel = form
      .querySelector(".task-voice-cancel-button")
      .getBoundingClientRect();
    const send = form.querySelector(".task-primary-action-button").getBoundingClientRect();
    return {
      modelNameClipped: modelName.scrollWidth > modelName.clientWidth + 1,
      overlaps: items.some(
        (item, index) =>
          index > 0 && item.left < items[index - 1].right - 0.5,
      ),
      actionOverlaps: actions.some(
        (item, index) =>
          index > 0 && item.left < actions[index - 1].right - 0.5,
      ),
      meterBeforeElapsed: meter.right <= elapsed.left + 0.5,
      meterToElapsedTextGap: elapsedText.left - meter.right,
      elapsedNumericVariant: elapsedStyle.fontVariantNumeric,
      elapsedTextAlign: elapsedStyle.textAlign,
      elapsedTextBoxEdge: elapsedStyle.textBoxEdge,
      elapsedTextBoxTrim: elapsedStyle.textBoxTrim,
      elapsedBeforeCancel: elapsed.right <= cancel.left + 0.5,
      meterWidth: meter.width,
      voiceCenter: voice.left + voice.width / 2,
      sendCenter: send.left + send.width / 2,
    };
  });
  await captureReviewScreenshot(page, testInfo, "tasks-voice-recording");
  expect(toolLayout).toEqual({
    modelNameClipped: false,
    overlaps: false,
    actionOverlaps: false,
    meterBeforeElapsed: true,
    meterToElapsedTextGap: expect.any(Number),
    elapsedNumericVariant: "lining-nums tabular-nums",
    elapsedTextAlign: "left",
    elapsedTextBoxEdge: "cap alphabetic",
    elapsedTextBoxTrim: "trim-both",
    elapsedBeforeCancel: true,
    meterWidth: levelPresentation.meterWidth,
    voiceCenter: idleActionLayout.voiceCenter,
    sendCenter: idleActionLayout.sendCenter,
  });
  expect(toolLayout.meterToElapsedTextGap).toBeGreaterThanOrEqual(5);
  expect(toolLayout.meterToElapsedTextGap).toBeLessThanOrEqual(7);

  await composer.getByRole("button", { name: "Stop recording" }).click();
  await expect(composer).toHaveAttribute("data-voice-state", "transcribing");
  await expect(composer.locator("caffold-voice-level-meter")).toHaveCount(0);
  await expect(composer.locator(".task-composer-voice-status")).toHaveCount(0);
  await expect(composer).toHaveAttribute("data-voice-state", "idle");
  await expect(composer.locator("caffold-voice-level-meter")).toHaveCount(0);
  await expect(prompt).toHaveValue("앞쪽 로컬 음성 입력");
  await expect(prompt).not.toBeFocused();
  expect(transcriptionRequests).toBe(1);
  expect(scenario.createTaskRequests).toBe(0);

  await composer.getByRole("button", { name: "Start voice input" }).click();
  await expect(composer).toHaveAttribute("data-voice-state", "recording");
  await expect(composer.locator("caffold-voice-level-meter")).toBeVisible();
  await expect(composer.locator(".task-composer-voice-status")).toHaveCount(0);
  await expect(prompt).not.toBeFocused();
  await expect
    .poll(() =>
      composer.evaluate(
        (form) =>
          form.closest("caffold-task-composer")?.voiceRecorder?.sampleCount ?? 0,
      ),
    )
    .toBeGreaterThan(0);
  await composer.getByRole("button", { name: "Stop recording" }).click();
  await expect(composer).toHaveAttribute("data-voice-state", "transcribing");
  await expect(composer.locator("caffold-voice-level-meter")).toHaveCount(0);
  await expect(composer.locator(".task-composer-voice-status")).toHaveCount(0);

  await expect(composer).toHaveAttribute("data-voice-state", "idle");
  await expect(prompt).toHaveValue("앞쪽 로컬 음성 입력 두 번째 입력");
  await expect(prompt).not.toBeFocused();
  expect(transcriptionRequests).toBe(2);
  expect(scenario.createTaskRequests).toBe(0);
});

test("keeps live input feedback visible without transitions in reduced motion", { tag: "@desktop" }, async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installTaskLoopFixture(page);
  await mockVoiceStatus(page, true);
  await page.goto("/tasks/new?cwd=src");

  const composer = page.locator(
    'caffold-task-new caffold-task-composer form[data-task-form="create"]',
  );
  await composer.getByRole("button", { name: "Start voice input" }).click();
  await expect(composer).toHaveAttribute("data-voice-state", "recording");
  const meter = composer.locator("caffold-voice-level-meter");
  const reduced = await composer.evaluate((form) => {
    const host = form.closest("caffold-task-composer");
    const recorder = host.voiceRecorder;
    const levelMeter = form.querySelector("caffold-voice-level-meter");
    const start = performance.now();
    const speech = new Float32Array(512).fill(0.5);
    recorder.levelTracker.reset();
    recorder.captureChunk(speech, start);
    recorder.captureChunk(speech, start + 100);
    return {
      level: Number(levelMeter.dataset.level),
      transitionDuration: getComputedStyle(
        levelMeter.firstElementChild,
      ).transitionDuration,
    };
  });
  expect(reduced.level).toBeGreaterThan(0.6);
  expect(reduced.transitionDuration).toBe("0s");
  await expect(meter).toBeVisible();

  await composer.getByRole("button", { name: "Cancel voice input" }).click();
  await expect(composer).toHaveAttribute("data-voice-state", "idle");
  await expect(meter).toHaveCount(0);
});

test("mounts the level meter only after microphone permission resolves", { tag: "@desktop" }, async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    const originalGetUserMedia =
      navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    let releasePermission;
    const permissionGate = new Promise((resolve) => {
      releasePermission = resolve;
    });
    window.__releaseVoicePermission = () => releasePermission();
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async (...args) => {
        await permissionGate;
        return originalGetUserMedia(...args);
      },
    });
  });
  await installTaskLoopFixture(page);
  await mockVoiceStatus(page, true);
  await page.goto("/tasks/new?cwd=src");

  const composer = page.locator(
    'caffold-task-new caffold-task-composer form[data-task-form="create"]',
  );
  await composer.getByRole("button", { name: "Start voice input" }).click();
  await expect(composer).toHaveAttribute("data-voice-state", "requesting");
  await expect(composer.locator("caffold-voice-level-meter")).toHaveCount(0);

  await page.evaluate(() => window.__releaseVoicePermission());
  await expect(composer).toHaveAttribute("data-voice-state", "recording");
  await expect(composer.locator("caffold-voice-level-meter")).toBeVisible();
  await composer.getByRole("button", { name: "Cancel voice input" }).click();
  await expect(composer.locator("caffold-voice-level-meter")).toHaveCount(0);
});

test("does not render a stale meter when microphone capture is unavailable", { tag: "@desktop" }, async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "AudioWorkletNode", {
      configurable: true,
      value: undefined,
    });
  });
  await installTaskLoopFixture(page);
  await page.goto("/tasks/new?cwd=src");

  const composer = page.locator(
    'caffold-task-new caffold-task-composer form[data-task-form="create"]',
  );
  await expect(composer).toHaveAttribute("data-voice-state", "unavailable");
  await expect(composer.locator("caffold-voice-level-meter")).toHaveCount(0);
});

test("shows the elapsed duration and automatically transcribes at the recording limit", { tag: "@desktop" }, async ({
  page,
}, testInfo) => {
  await installTaskLoopFixture(page);
  await mockVoiceStatus(page, true, 1);
  let transcriptionRequests = 0;
  let markTranscriptionStarted;
  let releaseTranscription;
  const transcriptionStarted = new Promise((resolve) => {
    markTranscriptionStarted = resolve;
  });
  const transcriptionReleased = new Promise((resolve) => {
    releaseTranscription = resolve;
  });
  await page.route("**/api/voice/transcribe", async (route) => {
    transcriptionRequests += 1;
    markTranscriptionStarted();
    await transcriptionReleased;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ text: "제한 자동 전사" }),
    });
  });

  await page.goto("/tasks/new?cwd=src");
  const composer = page.locator(
    'caffold-task-new caffold-task-composer form[data-task-form="create"]',
  );
  const prompt = composer.locator('textarea[name="prompt"]');
  await composer.getByRole("button", { name: "Start voice input" }).click();
  await expect(composer).toHaveAttribute("data-voice-state", "recording");
  await expect(composer.getByRole("timer")).toHaveText("0:00");

  await transcriptionStarted;
  await expect(composer).toHaveAttribute("data-voice-state", "transcribing");
  await expect(composer.locator("caffold-voice-level-meter")).toHaveCount(0);
  await expect(composer.getByRole("timer")).toHaveText("0:01");
  await expect(composer.getByRole("timer")).toHaveClass(/is-limit/);
  await expect(composer.locator(".task-composer-voice-status")).toHaveCount(0);
  releaseTranscription();
  await expect(composer).toHaveAttribute("data-voice-state", "idle");
  await expect(prompt).toHaveValue("제한 자동 전사");
  expect(transcriptionRequests).toBe(1);
});

test("requires explicit confirmation before the one-time model install", { tag: "@desktop" }, async ({
  page,
}, testInfo) => {
  await installTaskLoopFixture(page);
  await mockVoiceStatus(page, false);
  let installRequests = 0;
  await page.route("**/api/voice/model/install", async (route) => {
    installRequests += 1;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(voiceStatus(true)),
    });
  });
  page.once("dialog", async (dialog) => {
    expect(dialog.type()).toBe("confirm");
    expect(dialog.message()).toContain("Whisper large-v3-turbo model (1.5 GB)");
    await dialog.accept();
  });

  await page.goto("/tasks/new?cwd=src");
  const composer = page.locator(
    'caffold-task-new caffold-task-composer form[data-task-form="create"]',
  );
  await composer.getByRole("button", { name: "Set up voice input" }).click();

  await expect(composer).toHaveAttribute("data-voice-state", "idle");
  await expect(
    composer.getByRole("button", { name: "Start voice input" }),
  ).toBeEnabled();
  expect(installRequests).toBe(1);
});

test("finishes transcription before sending when Send is tapped during recording", { tag: "@all-viewports" }, async ({
  page,
}) => {
  const scenario = await installTaskLoopFixture(page);
  await mockVoiceStatus(page, true);
  let releaseTranscription;
  let markTranscriptionStarted;
  const transcriptionGate = new Promise((resolve) => {
    releaseTranscription = resolve;
  });
  const transcriptionStarted = new Promise((resolve) => {
    markTranscriptionStarted = resolve;
  });
  await page.route("**/api/voice/transcribe", async (route) => {
    markTranscriptionStarted();
    await transcriptionGate;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ text: "바로 전송" }),
    });
  });

  await page.goto(`/tasks/new?cwd=${scenario.contextPath}`);
  const composer = page.locator(
    'caffold-task-new caffold-task-composer form[data-task-form="create"]',
  );
  const prompt = composer.locator('textarea[name="prompt"]');
  await composer.evaluate((form) => {
    window.__caffoldVoiceSubmissions = [];
    form.closest("caffold-task-composer").addEventListener(
      "caffold:task-composer-submit",
      (event) => {
        event.stopPropagation();
        window.__caffoldVoiceSubmissions.push(event.detail);
      },
    );
  });
  await prompt.fill("기존 초안");
  await composer.getByRole("button", { name: "Start voice input" }).click();
  await expect(composer).toHaveAttribute("data-voice-state", "recording");
  await expect
    .poll(() =>
      composer.evaluate(
        (form) =>
          form.closest("caffold-task-composer")?.voiceRecorder?.sampleCount ?? 0,
      ),
    )
    .toBeGreaterThan(0);

  const send = composer.getByRole("button", {
    name: "Finish voice input and send",
  });
  await expect(send).toBeEnabled();
  await send.click();
  await transcriptionStarted;
  await expect(composer).toHaveAttribute("data-voice-state", "transcribing");
  expect(
    await page.evaluate(() => window.__caffoldVoiceSubmissions),
  ).toHaveLength(0);

  releaseTranscription();
  await expect
    .poll(() => page.evaluate(() => window.__caffoldVoiceSubmissions))
    .toHaveLength(1);
  expect(
    await page.evaluate(() => window.__caffoldVoiceSubmissions[0].prompt),
  ).toBe("기존 초안 바로 전송");
  expect(scenario.createTaskRequests).toBe(0);
});

test("keeps recording Stop separate while voice steers an active turn", { tag: "@desktop" }, async ({
  page,
}, testInfo) => {
  await installTaskApiFixture(page);
  await mockVoiceStatus(page, true);
  const detail = taskDetailFixture({ running: true });
  await page.route("**/api/tasks/thread-1", (route) =>
    route.fulfill({ json: detail }),
  );
  let submittedBody = null;
  await page.route("**/api/tasks/thread-1/prompts", (route) => {
    submittedBody = route.request().postDataJSON();
    return route.fulfill({
      json: {
        threadId: "thread-1",
        turnId: "turn-1",
        steered: true,
      },
    });
  });
  await page.route("**/api/voice/transcribe", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ text: "음성으로 이어서 작업해" }),
    }),
  );

  await page.goto("/tasks/thread-1?cwd=src");
  await emitTaskDetailBootstrap(page, detail);
  const composer = page.locator(
    'caffold-task-detail:not([hidden]) form[data-task-form="follow-up"]',
  );
  const primaryAction = composer.locator(".task-primary-action-button");
  await expect(primaryAction).toHaveAttribute("data-primary-action", "stop");
  await composer.getByRole("button", { name: "Start voice input" }).click();
  await expect(composer).toHaveAttribute("data-voice-state", "recording");
  await expect
    .poll(() =>
      composer.evaluate(
        (form) =>
          form.closest("caffold-task-composer")?.voiceRecorder?.sampleCount ?? 0,
      ),
    )
    .toBeGreaterThan(0);

  await expect(
    composer.getByRole("button", { name: "Stop recording" }),
  ).toBeEnabled();
  await expect(primaryAction).toHaveAttribute("data-primary-action", "send");
  await expect(primaryAction).toHaveAccessibleName(
    "Finish voice input and send",
  );
  await primaryAction.click();

  await expect.poll(() => submittedBody).not.toBeNull();
  expect(submittedBody).toMatchObject({
    prompt: "음성으로 이어서 작업해",
    activeTurnId: "turn-1",
  });
  await expect(primaryAction).toHaveAttribute("data-primary-action", "stop");
  await expect(primaryAction).toHaveAccessibleName("Stop current turn");
});

test("keeps the draft unsent when send-triggered transcription fails", { tag: "@desktop" }, async ({
  page,
}, testInfo) => {
  const scenario = await installTaskLoopFixture(page);
  await mockVoiceStatus(page, true);
  await page.route("**/api/voice/transcribe", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "voice_transcription_failed",
          message: "Caffold could not transcribe this recording.",
        },
      }),
    }),
  );

  await page.goto(`/tasks/new?cwd=${scenario.contextPath}`);
  const composer = page.locator(
    'caffold-task-new caffold-task-composer form[data-task-form="create"]',
  );
  const prompt = composer.locator('textarea[name="prompt"]');
  await composer.evaluate((form) => {
    window.__caffoldVoiceSubmissions = [];
    form.closest("caffold-task-composer").addEventListener(
      "caffold:task-composer-submit",
      (event) => {
        event.stopPropagation();
        window.__caffoldVoiceSubmissions.push(event.detail);
      },
    );
  });
  await prompt.fill("보존할 초안");
  await composer.getByRole("button", { name: "Start voice input" }).click();
  await expect(composer).toHaveAttribute("data-voice-state", "recording");
  await expect
    .poll(() =>
      composer.evaluate(
        (form) =>
          form.closest("caffold-task-composer")?.voiceRecorder?.sampleCount ?? 0,
      ),
    )
    .toBeGreaterThan(0);
  await composer
    .getByRole("button", { name: "Finish voice input and send" })
    .click();

  await expect(composer).toHaveAttribute("data-voice-state", "error");
  await expect(composer.locator("caffold-voice-level-meter")).toHaveCount(0);
  await expect(prompt).toHaveValue("보존할 초안");
  expect(
    await page.evaluate(() => window.__caffoldVoiceSubmissions),
  ).toHaveLength(0);
  expect(scenario.createTaskRequests).toBe(0);
});

test("keeps a follow-up draft and releases microphone tracks when recording is cancelled", { tag: "@desktop" }, async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    window.__caffoldStoppedVoiceTracks = 0;
    if (window.MediaStreamTrack) {
      const originalStop = MediaStreamTrack.prototype.stop;
      MediaStreamTrack.prototype.stop = function stop() {
        window.__caffoldStoppedVoiceTracks += 1;
        return originalStop.call(this);
      };
    }
  });
  const scenario = await installTaskLoopFixture(page);
  await mockVoiceStatus(page, true);
  let transcriptionRequests = 0;
  await page.route("**/api/voice/transcribe", (route) => {
    transcriptionRequests += 1;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ text: "unexpected" }),
    });
  });
  await scenario.seedCompletedTask();
  await page.goto(`/tasks/${scenario.threadId}?cwd=${scenario.contextPath}`);

  const composer = page.locator(
    'caffold-task-detail:not([hidden]) form[data-task-form="follow-up"]',
  );
  const prompt = composer.locator('textarea[name="prompt"]');
  await prompt.fill("취소해도 남아야 하는 초안");
  await composer.getByRole("button", { name: "Start voice input" }).click();
  await expect(composer).toHaveAttribute("data-voice-state", "recording");
  await composer.getByRole("button", { name: "Cancel voice input" }).click();

  await expect(composer).toHaveAttribute("data-voice-state", "idle");
  await expect(composer.locator("caffold-voice-level-meter")).toHaveCount(0);
  await expect(prompt).toHaveValue("취소해도 남아야 하는 초안");
  await expect
    .poll(() => page.evaluate(() => window.__caffoldStoppedVoiceTracks))
    .toBeGreaterThan(0);
  expect(transcriptionRequests).toBe(0);
  expect(scenario.followUpRequests).toBe(0);
});

test("reports microphone permission denial without changing the draft", { tag: "@desktop" }, async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async () => {
        throw new DOMException("Permission denied", "NotAllowedError");
      },
    });
  });
  await installTaskLoopFixture(page);
  await mockVoiceStatus(page, true);
  await page.goto("/tasks/new?cwd=src");

  const composer = page.locator(
    'caffold-task-new caffold-task-composer form[data-task-form="create"]',
  );
  const prompt = composer.locator('textarea[name="prompt"]');
  await prompt.fill("보존할 초안");
  await composer.getByRole("button", { name: "Start voice input" }).click();

  await expect(composer).toHaveAttribute("data-voice-state", "error");
  await expect(composer.locator("caffold-voice-level-meter")).toHaveCount(0);
  await expect(composer.getByRole("alert")).toContainText(
    "Microphone access was denied",
  );
  await expect(prompt).toHaveValue("보존할 초안");
});

async function mockVoiceStatus(page, installed, maxRecordingSeconds = 300) {
  await page.route("**/api/voice/status", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(voiceStatus(installed, maxRecordingSeconds)),
    }),
  );
}

function voiceStatus(installed, maxRecordingSeconds = 300) {
  return {
    supported: true,
    model: {
      id: MODEL_ID,
      bytes: MODEL_BYTES,
      installed,
      loaded: false,
      downloading: false,
    },
    maxRecordingSeconds,
  };
}
