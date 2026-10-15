/** Runs on the audio thread: batches 16 kHz mono samples into 512-sample frames. */

declare const sampleRate: number;
declare class AudioWorkletProcessor { readonly port: MessagePort; }
declare function registerProcessor(name: string, ctor: unknown): void;

class EmberFrames extends AudioWorkletProcessor {
  private buf = new Float32Array(512);
  private n = 0;

  process(inputs: Float32Array[][]): boolean {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === 512) {
        this.port.postMessage(this.buf.buffer, [this.buf.buffer]);
        this.buf = new Float32Array(512);
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor("ember-frames", EmberFrames);
void sampleRate;
