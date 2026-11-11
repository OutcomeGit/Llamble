// Plays raw sound handed over by the Android app (the shared screen's sound: 48 kHz stereo,
// 16-bit) into an audio track, through a small buffer that absorbs uneven delivery.
class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(48000 * 2); // 1 second, interleaved stereo
    this.read = 0;
    this.write = 0;
    this.filled = 0;
    this.started = false;
    this.port.onmessage = (e) => {
      const pcm = new Int16Array(e.data);
      for (let i = 0; i < pcm.length; i++) {
        this.buf[this.write] = pcm[i] / 32768;
        this.write = (this.write + 1) % this.buf.length;
        if (this.filled < this.buf.length) this.filled++;
        else this.read = (this.read + 1) % this.buf.length; // too far behind: drop the oldest
      }
    };
  }
  process(_inputs, outputs) {
    const [l, r] = outputs[0];
    // wait for ~60 ms of sound before starting, so small hiccups don't click
    if (!this.started && this.filled < 48000 * 2 * 0.06) return true;
    this.started = true;
    for (let i = 0; i < l.length; i++) {
      if (this.filled >= 2) {
        l[i] = this.buf[this.read];
        r[i] = this.buf[(this.read + 1) % this.buf.length];
        this.read = (this.read + 2) % this.buf.length;
        this.filled -= 2;
      } else {
        l[i] = r[i] = 0;
        this.started = false; // ran dry: re-buffer
      }
    }
    return true;
  }
}
registerProcessor("pcm-player", PcmPlayer);
