class CaffoldVoiceCaptureProcessor extends AudioWorkletProcessor {
  process(inputs, outputs) {
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
