import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "./support/browser-defaults.js";
import { mockAgentModels } from "./support/task-fixtures.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
  await mockAgentModels(page);
});

async function installVoiceSettings(page, overrides = {}) {
  const state = {
    selected: "whisper",
    installed: false,
    loaded: false,
    downloading: false,
    downloadError: null,
    openai: false,
    gemini: false,
    grok: false,
    ...overrides,
  };
  const requests = [];
  const settings = () => ({
    selected: state.selected,
    whisper: {
      model: "large-v3-turbo",
      revision: "5359861c739e955e79d9a303bcbc70fb988958b1",
      bytes: 1_624_555_275,
      installed: state.installed,
      loaded: state.loaded,
      downloading: state.downloading,
      downloadError: state.downloadError,
    },
    openai: { model: "gpt-transcribe", keyConfigured: state.openai },
    gemini: { model: "gemini-3.5-transcribe", keyConfigured: state.gemini },
    grok: { model: "grok-voice-transcribe-2.0", keyConfigured: state.grok },
  });
  await page.route("**/api/voice/settings", (route) =>
    route.fulfill({ json: settings() }),
  );
  await page.route("**/api/voice/provider", (route) => {
    const body = route.request().postDataJSON();
    requests.push(["provider", body]);
    state.selected = body.provider;
    return route.fulfill({ json: settings() });
  });
  await page.route("**/api/voice/model/install", (route) => {
    requests.push(["download"]);
    state.downloading = true;
    return route.fulfill({ json: settings() });
  });
  await page.route("**/api/voice/model", (route) => {
    requests.push(["remove-model"]);
    state.downloading = false;
    state.installed = false;
    state.loaded = false;
    return route.fulfill({ json: settings() });
  });
  await page.route("**/api/voice/keys/*", (route) => {
    const request = route.request();
    const provider = new URL(request.url()).pathname.split("/").at(-1);
    requests.push([
      request.method(),
      provider,
      request.method() === "PUT" ? request.postDataJSON() : null,
    ]);
    state[provider] = request.method() === "PUT";
    return route.fulfill({ json: settings() });
  });
  return { state, requests };
}

function detailValue(section, key) {
  return section.locator(`caffold-settings-detail-list [data-key="${key}"] dd`);
}

test("chooses a provider and saves, replaces, and removes an API key without showing it again", { tag: "@all-viewports" }, async ({
  page,
}) => {
  const { requests } = await installVoiceSettings(page);

  await page.goto("/settings/voice");
  const voicePage = page.locator("caffold-settings-voice-page");
  await expect(
    page.getByRole("heading", { level: 1, name: "Voice Input" }),
  ).toBeVisible();
  await expect(voicePage.getByRole("radio", { name: /^Whisper/ })).toBeChecked();

  const openaiChoice = voicePage.getByRole("radio", { name: /^OpenAI/ });
  await openaiChoice.click();
  await expect(openaiChoice).toBeChecked();

  const openai = voicePage.locator('[data-provider="openai"]');
  await expect(detailValue(openai, "model")).toHaveText("gpt-transcribe");
  await expect(detailValue(openai, "api-key")).toHaveText("Not saved");
  await openai.getByLabel("API key").fill("sk-e2e-first-secret");
  await openai.getByRole("button", { name: "Save key" }).click();
  await expect(detailValue(openai, "api-key")).toHaveText("Saved");
  const replacement = openai.getByLabel("Replace API key");
  await expect(replacement).toHaveValue("");
  await expect(replacement).toHaveAttribute(
    "placeholder",
    "Enter a new key to replace the saved one",
  );

  await replacement.fill("sk-e2e-second-secret");
  await replacement.press("Enter");
  await expect(replacement).toHaveValue("");
  await expect(voicePage).not.toContainText("sk-e2e");

  await openai.getByRole("button", { name: "Remove key" }).click();
  await expect(detailValue(openai, "api-key")).toHaveText("Not saved");
  await expect(openai.getByRole("button", { name: "Remove key" })).toBeHidden();
  await expect(
    openai.getByLabel("API key", { exact: true }),
  ).toHaveAttribute("placeholder", "");
  expect(requests).toEqual([
    ["provider", { provider: "openai" }],
    ["PUT", "openai", { key: "sk-e2e-first-secret" }],
    ["PUT", "openai", { key: "sk-e2e-second-secret" }],
    ["DELETE", "openai", null],
  ]);
});

test("chooses Grok, shows its model inside the page, and keeps its key write-only", { tag: "@all-viewports" }, async ({
  page,
}) => {
  const { requests } = await installVoiceSettings(page);

  await page.goto("/settings/voice");
  const voicePage = page.locator("caffold-settings-voice-page");
  const grokChoice = voicePage.getByRole("radio", { name: /^Grok/ });
  await grokChoice.click();
  await expect(grokChoice).toBeChecked();

  const grok = voicePage.locator('[data-provider="grok"]');
  await expect(detailValue(grok, "model")).toHaveText("grok-voice-transcribe-2.0");
  const overflow = await voicePage
    .locator(".settings-content-scroll")
    .evaluate((scrollport) => scrollport.scrollWidth - scrollport.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  await grok.getByLabel("API key").fill("xai-e2e-secret");
  await grok.getByRole("button", { name: "Save key" }).click();
  await expect(detailValue(grok, "api-key")).toHaveText("Saved");
  await expect(voicePage).not.toContainText("xai-e2e");
  await grok.getByRole("button", { name: "Remove key" }).click();
  await expect(detailValue(grok, "api-key")).toHaveText("Not saved");
  expect(requests).toEqual([
    ["provider", { provider: "grok" }],
    ["PUT", "grok", { key: "xai-e2e-secret" }],
    ["DELETE", "grok", null],
  ]);
});

test("starts, cancels, and deletes the Whisper model from the server's download state", { tag: "@desktop" }, async ({
  page,
}) => {
  const { state, requests } = await installVoiceSettings(page);

  await page.goto("/settings/voice");
  const whisper = page.locator(
    'caffold-settings-voice-page [data-provider="whisper"]',
  );
  await expect(detailValue(whisper, "model")).toHaveText("large-v3-turbo");
  await expect(detailValue(whisper, "revision")).toHaveText("5359861");
  await expect(detailValue(whisper, "status")).toHaveText(
    "Not downloaded (1.5 GB)",
  );

  await whisper.getByRole("button", { name: "Download" }).click();
  await expect(detailValue(whisper, "status")).toHaveText(
    "Downloading (1.5 GB)",
  );
  await whisper.getByRole("button", { name: "Cancel download" }).click();
  await expect(whisper.getByRole("button", { name: "Download" })).toBeVisible();
  await expect(
    whisper.getByRole("button", { name: "Cancel download" }),
  ).toBeHidden();

  await whisper.getByRole("button", { name: "Download" }).click();
  await expect(
    whisper.getByRole("button", { name: "Cancel download" }),
  ).toBeVisible();
  state.downloading = false;
  state.installed = true;
  await expect(detailValue(whisper, "status")).toHaveText("Downloaded");
  await whisper.getByRole("button", { name: "Delete model" }).click();
  await expect(whisper.getByRole("button", { name: "Download" })).toBeVisible();
  expect(requests).toEqual([
    ["download"],
    ["remove-model"],
    ["download"],
    ["remove-model"],
  ]);
});

test("retries settings that could not be loaded and then shows the last download failure", { tag: "@desktop" }, async ({
  page,
}) => {
  await installVoiceSettings(page, {
    downloadError: "The model download failed checksum verification.",
  });
  let loads = 0;
  await page.route("**/api/voice/settings", (route) => {
    loads += 1;
    if (loads === 1) {
      return route.fulfill({
        status: 500,
        json: {
          error: {
            code: "voice_settings_unavailable",
            message: "Caffold could not read its voice settings.",
          },
        },
      });
    }
    return route.fallback();
  });

  await page.goto("/settings/voice");
  const voicePage = page.locator("caffold-settings-voice-page");
  const whisper = voicePage.locator('[data-provider="whisper"]');
  await expect(voicePage.getByRole("alert")).toContainText(
    "Caffold could not read its voice settings.",
  );
  await expect(voicePage.getByRole("radio", { name: /^Whisper/ })).toBeDisabled();
  await expect(detailValue(whisper, "model")).toHaveText("—");
  await expect(
    detailValue(voicePage.locator('[data-provider="openai"]'), "api-key"),
  ).toHaveText("—");

  await voicePage.getByRole("button", { name: "Retry" }).click();
  await expect(voicePage.getByRole("button", { name: "Retry" })).toBeHidden();
  await expect(voicePage.getByRole("radio", { name: /^Whisper/ })).toBeEnabled();
  await expect(detailValue(whisper, "model")).toHaveText("large-v3-turbo");
  await expect(whisper).toContainText(
    "The model download failed checksum verification.",
  );
});

test("keeps settings current after a rejected key but asks to retry after a failed provider change", { tag: "@desktop" }, async ({
  page,
}) => {
  await installVoiceSettings(page);
  await page.route("**/api/voice/keys/gemini", (route) =>
    route.fulfill({
      status: 400,
      json: {
        error: {
          code: "invalid_voice_key",
          message: "An API key can contain only visible ASCII characters.",
        },
      },
    }),
  );
  await page.route("**/api/voice/provider", (route) =>
    route.fulfill({
      status: 500,
      json: {
        error: {
          code: "voice_settings_write_failed",
          message: "Caffold's voice service encountered an internal error.",
        },
      },
    }),
  );

  await page.goto("/settings/voice");
  const voicePage = page.locator("caffold-settings-voice-page");
  await expect(voicePage.getByRole("radio", { name: /^Whisper/ })).toBeChecked();

  const gemini = voicePage.locator('[data-provider="gemini"]');
  await gemini.getByLabel("API key").fill("not a key");
  await gemini.getByRole("button", { name: "Save key" }).click();
  await expect(voicePage.getByRole("alert")).toContainText(
    "An API key can contain only visible ASCII characters.",
  );
  await expect(gemini.getByLabel("API key")).toBeEnabled();
  await expect(gemini.getByLabel("API key")).toHaveValue("not a key");
  await expect(detailValue(gemini, "api-key")).toHaveText("Not saved");
  await expect(voicePage.getByRole("button", { name: "Retry" })).toBeHidden();

  const geminiChoice = voicePage.getByRole("radio", { name: /^Gemini/ });
  await geminiChoice.click();
  await expect(voicePage.getByRole("alert")).toContainText(
    "Caffold's voice service encountered an internal error.",
  );
  await expect(voicePage.getByRole("radio", { name: /^Whisper/ })).toBeChecked();
  await expect(geminiChoice).not.toBeChecked();
  await expect(geminiChoice).toBeDisabled();
  await expect(voicePage.getByRole("button", { name: "Retry" })).toBeVisible();
});

test("wraps a long download failure inside the page on narrow screens", { tag: ["@foldable", "@phone"] }, async ({
  page,
}) => {
  const failure =
    "The model download failed: error sending request for url (https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3-turbo.bin)";
  await installVoiceSettings(page, { downloadError: failure });

  await page.goto("/settings/voice");
  const voicePage = page.locator("caffold-settings-voice-page");
  await expect(
    voicePage.locator(".settings-voice-download-error"),
  ).toHaveText(failure);
  const layout = await voicePage
    .locator(".settings-content-scroll")
    .evaluate((scrollport) => ({
      overflow: scrollport.scrollWidth - scrollport.clientWidth,
      failureRight: scrollport
        .querySelector(".settings-voice-download-error")
        .getBoundingClientRect().right,
      scrollportRight: scrollport.getBoundingClientRect().right,
    }));
  expect(layout.overflow).toBeLessThanOrEqual(0);
  expect(layout.failureRight).toBeLessThanOrEqual(layout.scrollportRight);
});
