// Plays raw shared-screen sound (48 kHz stereo, interleaved) into an audio track, through a
// small buffer that absorbs uneven delivery. The Android app sends 16-bit samples
// (Int16Array buffer); the Windows app sends 32-bit float (Float32Array).
class PcmPlayer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    // how much sound to hold before playing (and after running dry): enough to ride out late
    // deliveries while the page is busy, small enough to stay roughly in step with the video
    this.cushion = Math.round(48000 * 2 * ((options && options.processorOptions && options.processorOptions.cushion) || 0.06));
    this.buf = new Float32Array(48000 * 2); // 1 second, interleaved stereo
    this.read = 0;
    this.write = 0;
    this.filled = 0;
    this.started = false;
    const take = (e) => {
      if (e.data && e.data.feed) {
        // a direct line from the Windows app: samples arrive here without touching the page
        e.data.feed.onmessage = take;
        return;
      }
      const f = e.data instanceof Float32Array ? e.data : null;
      const pcm = f || new Int16Array(e.data);
      const k = f ? 1 : 1 / 32768;
      for (let i = 0; i < pcm.length; i++) {
        this.buf[this.write] = pcm[i] * k;
        this.write = (this.write + 1) % this.buf.length;
        if (this.filled < this.buf.length) this.filled++;
        else this.read = (this.read + 1) % this.buf.length; // too far behind: drop the oldest
      }
      // delay creeping up (the two clocks drift, or a burst arrived): skip back to the cushion
      if (this.started && this.filled > this.cushion * 4) {
        const skip = (this.filled - this.cushion) & ~1;
        this.read = (this.read + skip) % this.buf.length;
        this.filled -= skip;
      }
    };
    this.port.onmessage = take;
  }
  process(_inputs, outputs) {
    const [l, r] = outputs[0];
    // wait for the cushion to fill before starting, so small hiccups don't click
    if (!this.started && this.filled < this.cushion) return true;
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
