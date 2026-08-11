import { mtof } from './core.js';
import { clamp, smoothstep } from '../geo.js';

/* i – VI – III – VII in A minor: the synthwave home key. */
const PROGRESSION = [
  { root: 45, notes: [45, 48, 52, 55] },  // Am7
  { root: 41, notes: [41, 45, 48, 52] },  // Fmaj7
  { root: 48, notes: [48, 52, 55, 59] },  // Cmaj7
  { root: 43, notes: [43, 47, 50, 54] },  // G
];
const ARP = [0, 2, 1, 3, 2, 0, 3, 1];
const LEAD = [
  [12, 10, 7, 12],
  [15, 12, 10, 7],
  [12, 15, 19, 15],
  [10, 7, 5, 7],
];

/**
 * A generative synthwave engine. Layers unlock with speed: ambient pads while
 * you cruise, an arp as you pick up, drums and bass past 110, a lead when you
 * are really going. Tempo drifts up with the speedometer.
 */
export class Music {
  constructor(core) {
    this.core = core;
    const ctx = core.ctx;

    this.out = core.gain(1.5);
    this.out.connect(core.master);

    // ping-pong-ish delay, mostly for the arp and lead
    this.delay = ctx.createDelay(1.0);
    this.delay.delayTime.value = 0.34;
    this.fb = core.gain(0.4);
    this.delayFilter = core.filter('lowpass', 2600, 0.7);
    this.delaySend = core.gain(1);
    this.delaySend.connect(this.delay);
    this.delay.connect(this.delayFilter);
    this.delayFilter.connect(this.fb);
    this.fb.connect(this.delay);
    this.delayFilter.connect(this.out);

    this.layers = {};
    for (const [name, v] of [['pad', 0.9], ['arp', 0], ['drums', 0], ['bass', 0], ['lead', 0]]) {
      const g = core.gain(v);
      g.connect(this.out);
      this.layers[name] = g;
    }
    this.layers.arp.connect(this.delaySend);
    this.layers.lead.connect(this.delaySend);

    this.bpm = 84;
    this.step = 0;
    this.nextTime = 0;
    this.beats = [];
    this.onBeat = null;
    this.enabled = true;
    this.energy = 0;
  }

  get stepDur() {
    return 60 / this.bpm / 4;
  }

  /** Call every frame. Schedules a little ahead of the audio clock. */
  tick(speed01, dt) {
    if (!this.core.started) return;
    const ctx = this.core.ctx;
    const now = ctx.currentTime;

    this.energy += (speed01 - this.energy) * Math.min(1, dt * 0.7);
    this.bpm = 82 + this.energy * 20;

    /* layers arrive earlier and louder than they used to: at speed the engine
       and the wind fill a lot of room, and the music has to hold its own */
    const e = this.energy;
    /* Layers should change the *density* of the music, not its loudness. While
       the drums are still missing, what is playing gets a makeup gain, so the
       track never disappears in the gap between "cruising" and "moving". */
    const makeup = 1 + (1 - smoothstep(0.12, 0.34, e)) * 0.7;
    const target = {
      pad: this.enabled ? (0.9 - smoothstep(0.35, 0.7, e) * 0.24) * makeup : 0,
      arp: this.enabled ? (0.12 + smoothstep(0.06, 0.24, e) * 0.68) * makeup : 0,
      drums: this.enabled ? smoothstep(0.14, 0.30, e) * 1.1 : 0,
      bass: this.enabled ? smoothstep(0.10, 0.26, e) * 1.0 : 0,
      lead: this.enabled ? smoothstep(0.48, 0.68, e) * 0.6 : 0,
    };
    for (const k in target) {
      this.layers[k].gain.setTargetAtTime(target[k], now, 0.6);
    }
    this.delay.delayTime.setTargetAtTime((60 / this.bpm) * 0.75, now, 0.8);

    /* after a hitch, skip forward in whole steps so the grid never shifts;
       after a long stall (backgrounded tab) just restart cleanly on a bar */
    if (this.nextTime === 0 || now - this.nextTime > 2) {
      this.nextTime = now + 0.06;
      this.step = Math.ceil(this.step / 16) * 16;
      this.beats.length = 0;
    }
    while (this.nextTime < now) {
      this.nextTime += this.stepDur;
      this.step++;
    }
    while (this.nextTime < now + 0.18) {
      this.schedule(this.step, this.nextTime);
      this.nextTime += this.stepDur;
      this.step++;
    }

    // fire visual beats when the audio clock actually reaches them
    while (this.beats.length && this.beats[0] <= now) {
      this.beats.shift();
      if (this.onBeat) this.onBeat();
    }
  }

  schedule(step, t) {
    const bar = Math.floor(step / 16);
    const s = step % 16;
    const chord = PROGRESSION[Math.floor(bar / 2) % PROGRESSION.length];
    const e = this.energy;

    if (s % 4 === 0) this.beats.push(t);

    /* pad — one long swell per chord */
    if (s === 0 && bar % 2 === 0) this.pad(chord, t, (60 / this.bpm) * 8);

    /* arp */
    const arpRate = e > 0.5 ? 1 : 2;               // 16ths when moving, 8ths when cruising
    if (s % arpRate === 0) {
      const n = chord.notes[ARP[(step / arpRate) % ARP.length] % chord.notes.length] + 24;
      this.pluck(n, t, 0.26 + Math.random() * 0.06);
    }

    /* drums */
    if (s === 0 || s === 8 || (e > 0.55 && (s === 4 || s === 12))) this.kick(t);
    if (s === 4 || s === 12) this.snare(t);
    if (s % 2 === 0) this.hat(t, s % 4 === 0 ? 0.5 : 0.32);
    if (e > 0.6 && s === 14) this.hat(t, 0.6, true);

    /* bass */
    if (s === 0 || s === 6 || s === 8 || s === 14) {
      this.bass(chord.root, t, s === 0 ? 0.5 : 0.28);
    }

    /* lead motif, once per bar, only at speed */
    if (s === 0 && e > 0.55) {
      const motif = LEAD[Math.floor(bar / 2) % LEAD.length];
      motif.forEach((iv, i) => {
        this.lead(chord.root + 24 + iv, t + i * this.stepDur * 3, 0.42);
      });
    }
  }

  /* ── voices ───────────────────────────────────────────── */

  pad(chord, t, dur) {
    const core = this.core;
    const ctx = core.ctx;
    const g = core.gain(0);
    const lp = core.filter('lowpass', 420, 1.4);
    g.connect(lp);
    lp.connect(this.layers.pad);

    lp.frequency.setValueAtTime(360, t);
    lp.frequency.linearRampToValueAtTime(900 + this.energy * 1400, t + dur * 0.45);
    lp.frequency.linearRampToValueAtTime(420, t + dur);

    /* twelve detuned saws through a slow filter sweep: quiet per voice, but
       they cancel each other enough that the bus level has to be generous */
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.5, t + dur * 0.32);
    g.gain.linearRampToValueAtTime(0.0001, t + dur);

    for (const n of chord.notes) {
      for (const [oct, det] of [[0, -7], [0, 6], [12, 3]]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = mtof(n + oct + 12);
        o.detune.value = det;
        const vg = core.gain(0.2);
        o.connect(vg);
        vg.connect(g);
        o.start(t);
        o.stop(t + dur + 0.1);
      }
    }
  }

  pluck(note, t, dur) {
    const core = this.core;
    const o = core.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = mtof(note);
    const lp = core.filter('lowpass', 3200, 6);
    const g = core.gain(0);
    o.connect(lp);
    lp.connect(g);
    g.connect(this.layers.arp);

    lp.frequency.setValueAtTime(3600, t);
    lp.frequency.exponentialRampToValueAtTime(520, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.24, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  bass(note, t, dur) {
    const core = this.core;
    const ctx = core.ctx;
    const g = core.gain(0);
    const lp = core.filter('lowpass', 380, 3);
    g.connect(lp);
    lp.connect(this.layers.bass);

    const o1 = ctx.createOscillator();
    o1.type = 'sawtooth';
    o1.frequency.value = mtof(note);
    const o2 = ctx.createOscillator();
    o2.type = 'sine';
    o2.frequency.value = mtof(note - 12);
    const g2 = core.gain(0.7);
    o1.connect(g);
    o2.connect(g2);
    g2.connect(g);

    lp.frequency.setValueAtTime(900, t);
    lp.frequency.exponentialRampToValueAtTime(200, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.4, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o1.start(t); o2.start(t);
    o1.stop(t + dur + 0.02); o2.stop(t + dur + 0.02);
  }

  lead(note, t, dur) {
    const core = this.core;
    const o = core.ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(mtof(note), t);
    const g = core.gain(0);
    o.connect(g);
    g.connect(this.layers.lead);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.3, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  kick(t) {
    const core = this.core;
    const o = core.ctx.createOscillator();
    o.type = 'sine';
    const g = core.gain(0);
    o.connect(g);
    g.connect(this.layers.drums);
    o.frequency.setValueAtTime(132, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.11);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.9, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    o.start(t);
    o.stop(t + 0.34);
  }

  snare(t) {
    const core = this.core;
    const s = core.ctx.createBufferSource();
    s.buffer = core.noise;
    const bp = core.filter('bandpass', 1900, 0.9);
    const g = core.gain(0);
    s.connect(bp);
    bp.connect(g);
    g.connect(this.layers.drums);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.34, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.19);
    s.start(t, Math.random() * 2);
    s.stop(t + 0.22);
  }

  hat(t, amp, open = false) {
    const core = this.core;
    const s = core.ctx.createBufferSource();
    s.buffer = core.noise;
    s.playbackRate.value = 1.8;
    const hp = core.filter('highpass', 7800, 0.8);
    const g = core.gain(0);
    s.connect(hp);
    hp.connect(g);
    g.connect(this.layers.drums);
    const dur = open ? 0.22 : 0.045;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.12 * amp, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.start(t, Math.random() * 2);
    s.stop(t + dur + 0.02);
  }

  toggle() {
    this.enabled = !this.enabled;
    return this.enabled;
  }
}
