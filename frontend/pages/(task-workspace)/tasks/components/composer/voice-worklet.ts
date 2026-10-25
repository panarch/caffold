// The audio thread's half of voice capture: it mixes each block of the
// microphone to mono and posts it to the recorder.

// The audio worklet's own scope, which TypeScript's DOM types do not include.
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
}

declare function registerProcessor(
  name: string,
  processor: new () => AudioWorkletProcessor,
): void;

class CaffoldVoiceCaptureProcessor extends AudioWorkletProcessor {
  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    const input = inputs[0];
    const output = outputs[0];
    if (input?.length) {
      const frames = input[0]?.length ?? 0;
      const mono = new Float32Array(frames);
      for (const channel of input) {
        for (let index = 0; index < frames; index += 1) {
          mono[index] += channel[index] / input.length;
        }
      }
      this.port.postMessage(mono, [mono.buffer]);
    }
    for (const channel of output ?? []) {
      channel.fill(0);
    }
    return true;
  }
}

registerProcessor("caffold-voice-capture", CaffoldVoiceCaptureProcessor);

export {};
