const TARGET_SAMPLE_RATE = 16_000;
const LEVEL_INTERVAL_MS = 100;
const LEVEL_FLOOR_DB = -60;
const LEVEL_CEILING_DB = 0;
const LEVEL_ATTACK_MS = 35;
const LEVEL_RELEASE_MS = 240;

export function normalizeVoiceLevel(rms) {
  const amplitude = Math.max(0, Number(rms) || 0);
  if (!amplitude) {
    return 0;
  }
  const decibels = 20 * Math.log10(amplitude);
  return clamp(
    (decibels - LEVEL_FLOOR_DB) / (LEVEL_CEILING_DB - LEVEL_FLOOR_DB),
    0,
    1,
  );
}

export class VoiceLevelTracker {
  constructor({
    intervalMs = LEVEL_INTERVAL_MS,
    attackMs = LEVEL_ATTACK_MS,
    releaseMs = LEVEL_RELEASE_MS,
  } = {}) {
    this.intervalMs = Math.max(1, intervalMs);
    this.attackMs = Math.max(0, attackMs);
    this.releaseMs = Math.max(0, releaseMs);
    this.reset();
  }

  reset() {
    this.sumSquares = 0;
    this.windowSamples = 0;
    this.lastDeliveryMs = null;
    this.level = 0;
  }

  capture(samples, nowMs = voiceLevelNow()) {
    if (!samples?.length) {
      return null;
    }
    for (const sample of samples) {
      this.sumSquares += sample * sample;
    }
    this.windowSamples += samples.length;

    if (this.lastDeliveryMs === null) {
      this.lastDeliveryMs = nowMs;
      return null;
    }
    const elapsedMs = nowMs - this.lastDeliveryMs;
    if (elapsedMs < this.intervalMs) {
      return null;
    }

    const rms = Math.sqrt(this.sumSquares / this.windowSamples);
    const target = normalizeVoiceLevel(rms);
    const timeConstant = target >= this.level ? this.attackMs : this.releaseMs;
    const blend = timeConstant ? 1 - Math.exp(-elapsedMs / timeConstant) : 1;
    this.level += (target - this.level) * blend;
    if (this.level < 0.001) {
      this.level = 0;
    }

    this.sumSquares = 0;
    this.windowSamples = 0;
    this.lastDeliveryMs = nowMs;
    return { level: this.level, rms };
  }
}

export function voiceCaptureSupport() {
  if (!window.isSecureContext) {
    return {
      supported: false,
      message: "Voice input requires HTTPS or localhost.",
    };
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return {
      supported: false,
      message: "This browser does not support microphone capture.",
    };
  }
  if (!(window.AudioContext || window.webkitAudioContext)) {
    return {
      supported: false,
      message: "This browser does not support Web Audio capture.",
    };
  }
  if (!window.AudioWorkletNode) {
    return {
      supported: false,
      message: "This browser does not support AudioWorklet capture.",
    };
  }
  return { supported: true, message: "" };
}

export class VoiceRecorder {
  constructor({ maxSeconds, onElapsed, onLimit, onLevel }) {
    this.maxSeconds = maxSeconds;
    this.onElapsed = onElapsed;
    this.onLimit = onLimit;
    this.onLevel = onLevel;
    this.levelTracker = new VoiceLevelTracker();
    this.chunks = [];
    this.sampleCount = 0;
    this.elapsedSeconds = 0;
    this.limitNotified = false;
    this.active = false;
  }

  async start() {
    const support = voiceCaptureSupport();
    if (!support.supported) {
      throw new Error(support.message);
    }
    if (this.active) {
      throw new Error("Voice recording is already active.");
    }
    this.chunks = [];
    this.sampleCount = 0;
    this.elapsedSeconds = 0;
    this.limitNotified = false;
    this.levelTracker.reset();

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    this.context = new AudioContextClass({ latencyHint: "interactive" });
    try {
      await this.context.resume();
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      if (!this.context.audioWorklet) {
        throw new Error("This browser does not support AudioWorklet capture.");
      }
      await this.context.audioWorklet.addModule(
        new URL("./voice-worklet.js", import.meta.url),
      );
      await this.context.resume();
      this.source = this.context.createMediaStreamSource(this.stream);
      this.capture = new AudioWorkletNode(
        this.context,
        "caffold-voice-capture",
        {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          channelCount: 1,
          channelCountMode: "explicit",
        },
      );
      this.silence = this.context.createGain();
      this.silence.gain.value = 0;
      this.capture.port.onmessage = (event) => this.captureChunk(event.data);
      this.source.connect(this.capture);
      this.capture.connect(this.silence);
      this.silence.connect(this.context.destination);
      this.active = true;
      this.limitTimer = window.setTimeout(
        () => this.notifyLimit(),
        this.maxSeconds * 1_000,
      );
    } catch (error) {
      await this.release();
      throw error;
    }
  }

  captureChunk(value, nowMs) {
    if (!this.active || !(value instanceof Float32Array)) {
      return;
    }
    const maximum = Math.ceil(this.context.sampleRate * this.maxSeconds);
    const remaining = maximum - this.sampleCount;
    if (remaining <= 0) {
      return;
    }
    const chunk = value.length > remaining ? value.slice(0, remaining) : value;
    this.chunks.push(chunk);
    this.sampleCount += chunk.length;
    const reading = this.levelTracker.capture(chunk, nowMs);
    if (reading) {
      this.onLevel?.(reading.level);
    }
    const elapsedSeconds = Math.min(
      this.maxSeconds,
      Math.floor(this.sampleCount / this.context.sampleRate),
    );
    if (elapsedSeconds !== this.elapsedSeconds) {
      this.elapsedSeconds = elapsedSeconds;
      this.onElapsed?.(elapsedSeconds);
    }
    if (this.sampleCount >= maximum) {
      this.notifyLimit();
    }
  }

  notifyLimit() {
    if (this.limitNotified) {
      return;
    }
    this.limitNotified = true;
    if (this.elapsedSeconds !== this.maxSeconds) {
      this.elapsedSeconds = this.maxSeconds;
      this.onElapsed?.(this.maxSeconds);
    }
    if (this.limitTimer) {
      window.clearTimeout(this.limitTimer);
      this.limitTimer = null;
    }
    this.onLimit?.();
  }

  async stop() {
    if (!this.active) {
      throw new Error("Voice recording is not active.");
    }
    this.active = false;
    const sampleRate = this.context.sampleRate;
    const chunks = this.chunks;
    await this.release();
    const samples = joinChunks(chunks);
    if (!samples.length) {
      throw new Error("The recording did not contain any audio.");
    }
    return encodePcmWav(
      resampleLinear(samples, sampleRate, TARGET_SAMPLE_RATE),
      TARGET_SAMPLE_RATE,
    );
  }

  async cancel() {
    this.active = false;
    await this.release();
  }

  async release() {
    this.active = false;
    this.levelTracker.reset();
    if (this.limitTimer) {
      window.clearTimeout(this.limitTimer);
      this.limitTimer = null;
    }
    this.capture?.disconnect();
    this.source?.disconnect();
    this.silence?.disconnect();
    this.capture?.port?.close();
    for (const track of this.stream?.getTracks?.() ?? []) {
      track.stop();
    }
    if (this.context && this.context.state !== "closed") {
      await this.context.close().catch(() => {});
    }
    this.capture = null;
    this.source = null;
    this.silence = null;
    this.stream = null;
    this.context = null;
  }
}

function voiceLevelNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function formatRecordingDuration(seconds) {
  const elapsed = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(elapsed / 60);
  const remainder = `${elapsed % 60}`.padStart(2, "0");
  return `${minutes}:${remainder}`;
}

export function resampleLinear(samples, sourceRate, targetRate) {
  if (sourceRate === targetRate) {
    return samples.slice();
  }
  if (sourceRate < targetRate || !sourceRate || !targetRate) {
    throw new Error("The microphone sample rate is not supported.");
  }
  const length = Math.max(1, Math.floor(samples.length * targetRate / sourceRate));
  const output = new Float32Array(length);
  const ratio = sourceRate / targetRate;
  for (let index = 0; index < length; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, samples.length - 1);
    const weight = position - left;
    output[index] = samples[left] * (1 - weight) + samples[right] * weight;
  }
  return output;
}

export function encodePcmWav(samples, sampleRate = TARGET_SAMPLE_RATE) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(
      44 + index * 2,
      sample < 0 ? sample * 0x8000 : sample * 0x7fff,
      true,
    );
  }
  return new Blob([buffer], { type: "audio/wav" });
}

function joinChunks(chunks) {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const samples = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    samples.set(chunk, offset);
    offset += chunk.length;
  }
  return samples;
}

function writeAscii(view, offset, text) {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}
