import assert from "node:assert/strict";
import test from "node:test";

import {
  encodePcmWav,
  formatRecordingDuration,
  normalizeVoiceLevel,
  resampleLinear,
  VoiceLevelTracker,
  VoiceRecorder,
} from "./voice-recorder.js";

test("formats recording durations without an unnecessary leading hour digit", () => {
  assert.equal(formatRecordingDuration(0), "0:00");
  assert.equal(formatRecordingDuration(9), "0:09");
  assert.equal(formatRecordingDuration(60), "1:00");
  assert.equal(formatRecordingDuration(300), "5:00");
});

test("reports captured seconds and stops accepting samples at the limit", () => {
  const elapsed = [];
  let limitCalls = 0;
  const recorder = new VoiceRecorder({
    maxSeconds: 2,
    onElapsed: (seconds) => elapsed.push(seconds),
    onLimit: () => {
      limitCalls += 1;
    },
  });
  recorder.active = true;
  recorder.context = { sampleRate: 4 };

  recorder.captureChunk(Float32Array.from([0, 0, 0, 0, 0]));
  recorder.captureChunk(Float32Array.from([0, 0, 0, 0, 0]));

  assert.deepEqual(elapsed, [1, 2]);
  assert.equal(recorder.sampleCount, 8);
  assert.equal(limitCalls, 1);
});

test("maps RMS amplitude through a bounded logarithmic display range", () => {
  assert.equal(normalizeVoiceLevel(0), 0);
  assert.equal(normalizeVoiceLevel(0.001), 0);
  assert.equal(normalizeVoiceLevel(1), 1);
  assert.equal(normalizeVoiceLevel(2), 1);
  assert.ok(Math.abs(normalizeVoiceLevel(0.1) - 2 / 3) < 0.000_001);
});

test("aggregates PCM windows and bounds level delivery to 10 Hz", () => {
  const tracker = new VoiceLevelTracker({ attackMs: 0, releaseMs: 0 });

  assert.equal(tracker.capture(Float32Array.from([0, 0]), 0), null);
  assert.equal(tracker.capture(Float32Array.from([1, 1]), 30), null);
  assert.equal(tracker.capture(Float32Array.from([1, 1]), 99), null);
  const first = tracker.capture(Float32Array.from([1, 1]), 100);
  assert.ok(first);
  assert.ok(Math.abs(first.rms - Math.sqrt(0.75)) < 0.000_001);
  assert.equal(tracker.capture(Float32Array.from([0.5]), 199), null);
  assert.ok(tracker.capture(Float32Array.from([0.5]), 200));
});

test("uses fast attack and slower release while silence settles to baseline", () => {
  const tracker = new VoiceLevelTracker();
  const loud = Float32Array.from([1, 1, 1, 1]);
  const silent = Float32Array.from([0, 0, 0, 0]);

  tracker.capture(loud, 0);
  const attack = tracker.capture(loud, 100);
  const release = tracker.capture(silent, 200);
  const settled = tracker.capture(silent, 1_200);

  assert.ok(attack.level > 0.8);
  assert.ok(release.level < attack.level);
  assert.ok(release.level > attack.level * 0.6);
  assert.ok(settled.level < 0.01);
});

test("resets level aggregation without retaining a stale visual value", () => {
  const tracker = new VoiceLevelTracker({ attackMs: 0, releaseMs: 0 });
  tracker.capture(Float32Array.from([1]), 0);
  assert.equal(tracker.capture(Float32Array.from([1]), 100).level, 1);

  tracker.reset();
  assert.equal(tracker.capture(Float32Array.from([0]), 200), null);
  assert.deepEqual(tracker.capture(Float32Array.from([0]), 300), {
    level: 0,
    rms: 0,
  });
});

test("delivers levels without modifying retained recording samples", async () => {
  const levels = [];
  const recorder = new VoiceRecorder({
    maxSeconds: 2,
    onLevel: (level) => levels.push(level),
  });
  const source = Float32Array.from([0.25, -0.25, 0.5, -0.5]);
  recorder.active = true;
  recorder.context = { sampleRate: 16_000 };

  recorder.captureChunk(source, 0);
  recorder.captureChunk(source, 100);

  assert.equal(levels.length, 1);
  assert.ok(levels[0] > 0);
  assert.strictEqual(recorder.chunks[0], source);
  assert.deepEqual(Array.from(source), [0.25, -0.25, 0.5, -0.5]);

  recorder.context = null;
  await recorder.cancel();
  assert.equal(recorder.levelTracker.level, 0);
});

test("resamples microphone PCM to 16 kHz without mutating the source", () => {
  const source = Float32Array.from([0, 0.25, 0.5, 0.75, 1, 0.75]);

  const resampled = resampleLinear(source, 48_000, 16_000);

  assert.deepEqual(Array.from(resampled), [0, 0.75]);
  assert.deepEqual(Array.from(source), [0, 0.25, 0.5, 0.75, 1, 0.75]);
});

test("encodes mono 16-bit PCM with an exact WAV header", async () => {
  const wav = encodePcmWav(Float32Array.from([-1, 0, 1]), 16_000);
  const bytes = new Uint8Array(await wav.arrayBuffer());
  const view = new DataView(bytes.buffer);

  assert.equal(wav.type, "audio/wav");
  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), "RIFF");
  assert.equal(new TextDecoder().decode(bytes.slice(8, 12)), "WAVE");
  assert.equal(view.getUint32(4, true), 42);
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16_000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 6);
  assert.equal(view.getInt16(44, true), -32_768);
  assert.equal(view.getInt16(46, true), 0);
  assert.equal(view.getInt16(48, true), 32_767);
});

test("rejects upsampling because capture must provide enough source samples", () => {
  assert.throws(
    () => resampleLinear(new Float32Array([0, 1]), 8_000, 16_000),
    /sample rate is not supported/,
  );
});
