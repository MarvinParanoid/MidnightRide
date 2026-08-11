/**
 * The whole soundtrack — engine, weather, music — is synthesised live.
 * There is not a single audio file in this project.
 */
export class AudioCore {
  constructor() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx({ latencyHint: 'interactive' });
    const ctx = this.ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0.0;

    // gentle bus compression so the mix survives full throttle + full storm
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -16;
    this.comp.knee.value = 24;
    this.comp.ratio.value = 3.2;
    this.comp.attack.value = 0.006;
    this.comp.release.value = 0.22;

    // one shared "space": nearly dry outdoors, cavernous in a tunnel
    this.verb = ctx.createConvolver();
    this.verb.buffer = this.impulse(2.6, 2.8);
    this.verbSend = ctx.createGain();
    this.verbSend.gain.value = 0.06;
    this.verbReturn = ctx.createGain();
    this.verbReturn.gain.value = 0.9;

    this.master.connect(this.comp);
    this.master.connect(this.verbSend);
    this.verbSend.connect(this.verb);
    this.verb.connect(this.verbReturn);
    this.verbReturn.connect(this.comp);
    // a brick wall at the very end: a kick landing under full throttle in the
    // rain should not clip the output
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -2.5;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.12;

    this.comp.connect(this.limiter);
    this.limiter.connect(ctx.destination);

    this.noise = this.noiseBuffer(3);
    this.started = false;
  }

  async start() {
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.started = true;
    this.master.gain.setTargetAtTime(0.55, this.ctx.currentTime, 1.4);
  }

  get t() {
    return this.ctx.currentTime;
  }

  /** Exponentially decaying noise — a serviceable reverb tail. */
  impulse(seconds, decay) {
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * (1 - t * 0.2);
      }
    }
    return buf;
  }

  noiseBuffer(seconds = 2) {
    const rate = this.ctx.sampleRate;
    const buf = this.ctx.createBuffer(1, rate * seconds, rate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < d.length; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;      // slight pink tilt
      d[i] = last * 3.2;
    }
    return buf;
  }

  /** A looping noise source, already running. */
  noiseSource() {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    s.loop = true;
    s.start(this.ctx.currentTime + Math.random() * 0.1);
    return s;
  }

  gain(v = 1) {
    const g = this.ctx.createGain();
    g.gain.value = v;
    return g;
  }

  filter(type, freq, q = 1) {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
  }

  /** Soft asymmetric clipping — gives the engine its bite. */
  drive(amount = 12) {
    const ws = this.ctx.createWaveShaper();
    const n = 1024;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = ((1 + amount) * x) / (1 + amount * Math.abs(x));
    }
    ws.curve = curve;
    ws.oversample = '2x';
    return ws;
  }

  /** How enclosed the world sounds: 0 = open road, 1 = deep tunnel. */
  setEnclosure(x) {
    const t = this.t;
    this.verbSend.gain.setTargetAtTime(0.05 + x * 0.55, t, 0.4);
    this.verbReturn.gain.setTargetAtTime(0.8 + x * 0.7, t, 0.4);
  }

  setVolume(v) {
    this.master.gain.setTargetAtTime(v, this.t, 0.1);
  }

  /** Distant thunder: noise dragged down into a long low roll. */
  thunder() {
    const t = this.t;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.35;
    const lp = this.filter('lowpass', 190, 1.1);
    const g = this.gain(0);
    src.connect(lp);
    lp.connect(g);
    g.connect(this.master);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.42, t + 0.35);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 3.6);
    lp.frequency.setValueAtTime(240, t);
    lp.frequency.exponentialRampToValueAtTime(70, t + 3.4);
    src.start(t, Math.random() * 2);
    src.stop(t + 3.8);
  }
}

export const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
