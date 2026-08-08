import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import { installTaskLoopFixture } from "../support/task-loop-fixture.js";
import { captureReviewScreenshot } from "../support/task-fixtures.js";

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

test("records without focusing the prompt and inserts a host transcript at the saved selection", async ({
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
  await prompt.fill("앞쪽 뒤쪽");
  await prompt.evaluate((textarea) => textarea.setSelectionRange(3, 5));
  const initialViewportHeight = await page.evaluate(() => window.innerHeight);

  const startVoice = composer.getByRole("button", {
    name: "Start voice input",
  });
  const idleActionLayout = await composer.evaluate((form) => {
    const voice = form.querySelector(".task-voice-button").getBoundingClientRect();
    const send = form.querySelector(".task-send-button").getBoundingClientRect();
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
    const elapsed = form
      .querySelector(".task-voice-elapsed")
      .getBoundingClientRect();
    const cancel = form
      .querySelector(".task-voice-cancel-button")
      .getBoundingClientRect();
    const send = form.querySelector(".task-send-button").getBoundingClientRect();
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
      elapsedBeforeCancel: elapsed.right <= cancel.left + 0.5,
      voiceCenter: voice.left + voice.width / 2,
      sendCenter: send.left + send.width / 2,
    };
  });
  await captureReviewScreenshot(page, testInfo, "tasks-voice-recording");
  expect(toolLayout).toEqual({
    modelNameClipped: false,
    overlaps: false,
    actionOverlaps: false,
    elapsedBeforeCancel: true,
    voiceCenter: idleActionLayout.voiceCenter,
    sendCenter: idleActionLayout.sendCenter,
  });

  await composer.getByRole("button", { name: "Stop recording" }).click();
  await expect(composer).toHaveAttribute("data-voice-state", "transcribing");
  await expect(composer.locator(".task-composer-voice-status")).toHaveCount(0);
  await expect(composer).toHaveAttribute("data-voice-state", "idle");
  await expect(prompt).toHaveValue("앞쪽 로컬 음성 입력");
  await expect(prompt).not.toBeFocused();
  expect(transcriptionRequests).toBe(1);
  expect(scenario.createTaskRequests).toBe(0);

  await composer.getByRole("button", { name: "Start voice input" }).click();
  await expect(composer).toHaveAttribute("data-voice-state", "recording");
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
  await expect(composer.locator(".task-composer-voice-status")).toHaveCount(0);

  await expect(composer).toHaveAttribute("data-voice-state", "idle");
  await expect(prompt).toHaveValue("앞쪽 로컬 음성 입력 두 번째 입력");
  await expect(prompt).not.toBeFocused();
  expect(transcriptionRequests).toBe(2);
  expect(scenario.createTaskRequests).toBe(0);
});

test("shows the elapsed duration and automatically transcribes at the recording limit", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop",
    "Timer limit behavior is viewport-independent",
  );
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
  await expect(composer.getByRole("timer")).toHaveText("0:01");
  await expect(composer.getByRole("timer")).toHaveClass(/is-limit/);
  await expect(composer.locator(".task-composer-voice-status")).toHaveCount(0);
  releaseTranscription();
  await expect(composer).toHaveAttribute("data-voice-state", "idle");
  await expect(prompt).toHaveValue("제한 자동 전사");
  expect(transcriptionRequests).toBe(1);
});

test("requires explicit confirmation before the one-time model install", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Model setup behavior is viewport-independent");
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

test("finishes transcription before sending when Send is tapped during recording", async ({
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

test("keeps the draft unsent when send-triggered transcription fails", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Failure behavior is viewport-independent");
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
  await expect(prompt).toHaveValue("보존할 초안");
  expect(
    await page.evaluate(() => window.__caffoldVoiceSubmissions),
  ).toHaveLength(0);
  expect(scenario.createTaskRequests).toBe(0);
});

test("keeps a follow-up draft and releases microphone tracks when recording is cancelled", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Cancellation behavior is viewport-independent");
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
  await expect(prompt).toHaveValue("취소해도 남아야 하는 초안");
  await expect
    .poll(() => page.evaluate(() => window.__caffoldStoppedVoiceTracks))
    .toBeGreaterThan(0);
  expect(transcriptionRequests).toBe(0);
  expect(scenario.followUpRequests).toBe(0);
});

test("reports microphone permission denial without changing the draft", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Permission behavior is viewport-independent");
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
