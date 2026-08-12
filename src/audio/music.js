import { mtof } from './core.js';
import { clamp, smoothstep } from '../geo.js';
import { STATIONS, chordNotes, stationFor, pickSection } from './stations.js';

const ARP = [0, 2, 1, 3, 2, 0, 3, 1];
const LEAD = [
  [12, 10, 7, 12],
  [15, 12, 10, 7],
  [12, 15, 19, 15],
  [10, 7, 5, 7],
];

const KEYS = [45, 43, 47, 40, 50];        // A, G, B, E, D — comfortable roots
const DWELL = 95;                          // seconds a station holds before it may change
const TRANSPOSE_EVERY = 420;               // and how long before the key drifts

/**
 * A generative radio rather than a loop.
 *
 * Layers still unlock with speed — pads while cruising, an arp as you pick up,
 * drums and bass past a hundred — but on top of that the *station* changes with
 * where you are, each with its own key colour, tempo, chords and instruments;
 * the arrangement thins and thickens every eight bars; and the key itself
 * drifts every few minutes. One four-chord loop in one key is fine for a play
 * session and unbearable for a five-hour stream.
 */
export class Music {
  constructor(core) {
    this.core = core;
    const ctx = core.ctx;

    this.out = core.gain(1.5);
    this.out.connect(core.master);

    this.delay = ctx.createDelay(1.5);
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

    this.key = KEYS[0];
    this.stationId = 'night';
    this.station = STATIONS.night;
    this.progression = this.station.progressions[0];
    this.section = { name: 'full', drums: 1, arp: 1, lead: 1, pad: 1 };

    this.bpm = 88;
    this.step = 0;
    this.nextTime = 0;
    this.beats = [];
    this.onBeat = null;
    this.enabled = true;
    this.energy = 0;

    this.ctxInfo = { biome: 'CITY', remote: 0, rain: 0 };
    this.sinceStation = 0;
    this.sinceKey = 0;
    this.wantStation = null;
  }

  get stationName() {
    return `${this.station.id} ${this.station.name}`;
  }

  get stationStyle() {
    return this.station.style;
  }

  get stepDur() {
    return 60 / this.bpm / 4;
  }

  /** Where the ride currently is; the radio decides what to do about it. */
  setContext(ctx) {
    this.ctxInfo = ctx;
  }

  /* ── the dial ─────────────────────────────────────────── */

  considerStation(dt) {
    this.sinceStation += dt;
    if (this.sinceStation < DWELL || this.wantStation) return;
    const pick = stationFor(this.ctxInfo);
    if (pick !== this.stationId) this.wantStation = pick;    // applied on the next bar
  }

  changeStation(id, at) {
    this.stationId = id;
    this.station = STATIONS[id];
    this.progression = this.station.progressions[
      (Math.random() * this.station.progressions.length) | 0
    ];
    this.sinceStation = 0;
    this.wantStation = null;
    this.delay.delayTime.setTargetAtTime((60 / this.bpm) * this.station.delayBeats, at, 0.3);
    this.static(at);
  }

  /** A second of tuning noise, the way a radio changes station. */
  static(at) {
    const core = this.core;
    const s = core.ctx.createBufferSource();
    s.buffer = core.noise;
    s.loop = true;
    const bp = core.filter('bandpass', 1400, 1.4);
    const g = core.gain(0);
    s.connect(bp);
    bp.connect(g);
    g.connect(this.out);

    const dur = 0.55;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(0.1, at + 0.06);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    bp.frequency.setValueAtTime(700, at);
    bp.frequency.exponentialRampToValueAtTime(3200, at + dur * 0.6);
    bp.frequency.exponentialRampToValueAtTime(900, at + dur);
    s.start(at);
    s.stop(at + dur + 0.05);

    // and duck everything else while the dial moves
    for (const g2 of Object.values(this.layers)) {
      g2.gain.setTargetAtTime(g2.gain.value * 0.25, at, 0.05);
    }
  }

  /* ── scheduling ───────────────────────────────────────── */

  tick(speed01, dt) {
    if (!this.core.started) return;
    const ctx = this.core.ctx;
    const now = ctx.currentTime;

    this.energy += (speed01 - this.energy) * Math.min(1, dt * 0.7);
    const st = this.station;
    this.bpm = st.bpm[0] + this.energy * (st.bpm[1] - st.bpm[0]);

    this.considerStation(dt);
    this.sinceKey += dt;

    const e = this.energy;
    const sec = this.section;
    const makeup = 1 + (1 - smoothstep(0.12, 0.34, e)) * 0.7;
    /* Per-station trim, so changing station is a change of mood and not a
       change of volume — an eight decibel step between two of them sounded
       like the music had dropped out. */
    const on = (this.enabled ? 1 : 0) * (st.level ?? 1);
    const target = {
      pad: on * (0.9 - smoothstep(0.35, 0.7, e) * 0.24) * makeup * sec.pad,
      arp: on * (0.12 + smoothstep(0.06, 0.24, e) * 0.68) * makeup * sec.arp,
      drums: on * smoothstep(0.14, 0.30, e) * 1.1 * sec.drums * (st.drums === 'none' ? 0 : 1),
      bass: on * smoothstep(0.10, 0.26, e) * 1.0 * st.bassMul,
      lead: on * smoothstep(0.48, 0.68, e) * 0.6 * sec.lead * (st.lead ? 1 : 0),
    };
    for (const k in target) this.layers[k].gain.setTargetAtTime(target[k], now, 0.6);

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

    while (this.beats.length && this.beats[0] <= now) {
      this.beats.shift();
      if (this.onBeat) this.onBeat();
    }
  }

  schedule(step, t) {
    const bar = Math.floor(step / 16);
    const s = step % 16;
    const st = this.station;

    /* everything structural happens on a bar line, never mid-phrase */
    if (s === 0) {
      if (this.wantStation) this.changeStation(this.wantStation, t);
      if (bar % 8 === 0) {
        this.section = pickSection();
        if (Math.random() < 0.4) {
          this.progression = st.progressions[(Math.random() * st.progressions.length) | 0];
        }
      }
      if (this.sinceKey > TRANSPOSE_EVERY && bar % 8 === 0) {
        this.sinceKey = 0;
        this.key = KEYS[(Math.random() * KEYS.length) | 0];
      }
    }

    const [deg, type] = this.progression[Math.floor(bar / 2) % this.progression.length];
    const root = this.key + deg;
    const notes = chordNotes(root, type);
    const e = this.energy;

    if (s % 4 === 0) this.beats.push(t);

    if (s === 0 && bar % 2 === 0) this.pad(notes, t, (60 / this.bpm) * 8);

    const rate = e > 0.5 ? st.arpRate / 2 : st.arpRate;
    if (this.section.arp && s % Math.max(1, rate) === 0) {
      const n = notes[ARP[(step / Math.max(1, rate)) % ARP.length] % notes.length] + st.arpOct;
      this.pluck(n, t, 0.26 + Math.random() * 0.06);
    }

    if (st.drums !== 'none' && this.section.drums) {
      const four = st.drums === 'four';
      if (s === 0 || s === 8 || (e > 0.55 && (s === 4 || s === 12))) this.kick(t);
      if (four ? (s === 4 || s === 12) : (s === 4 || s === 12 || s === 14)) this.snare(t);
      if (st.hats && s % 2 === 0) this.hat(t, s % 4 === 0 ? 0.5 : 0.32);
      if (st.hats && e > 0.6 && s === 14) this.hat(t, 0.6, true);
    }

    if (s === 0 || s === 6 || s === 8 || s === 14) {
      this.bass(root - 12, t, s === 0 ? 0.5 : 0.28);
    }

    if (s === 0 && e > 0.55 && st.lead && this.section.lead) {
      const motif = LEAD[Math.floor(bar / 2) % LEAD.length];
      motif.forEach((iv, i) => this.lead(root + 24 + iv, t + i * this.stepDur * 3, 0.42));
    }
  }

  /* ── voices ───────────────────────────────────────────── */

  pad(notes, t, dur) {
    const core = this.core;
    const ctx = core.ctx;
    const st = this.station;
    const g = core.gain(0);
    const lp = core.filter('lowpass', st.padCut[0], 1.4);
    g.connect(lp);
    lp.connect(this.layers.pad);

    lp.frequency.setValueAtTime(st.padCut[0], t);
    lp.frequency.linearRampToValueAtTime(st.padCut[0] + (st.padCut[1] - st.padCut[0]) * (0.4 + this.energy * 0.6), t + dur * 0.45);
    lp.frequency.linearRampToValueAtTime(st.padCut[0], t + dur);

    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.5, t + dur * 0.32);
    g.gain.linearRampToValueAtTime(0.0001, t + dur);

    for (const n of notes) {
      for (const [oct, det] of [[0, -7], [0, 6], [12, 3]]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = mtof(n + oct + st.padOct);
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
