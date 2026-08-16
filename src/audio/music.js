import { mtof } from './core.js';
import { clamp, smoothstep } from '../geo.js';
import {
  STATIONS, chordNotes, stationFor, pickSection, makeLead, voice, Deck,
  signature, varyArp, varyBass, varyDrums,
} from './stations.js';

const KEYS = [45, 43, 47, 40, 50];        // A, G, B, E, D — comfortable roots
const DWELL = 95;                          // seconds a station holds before it may change
const TRANSPOSE_EVERY = 420;               // and how long before the key drifts
/* How often a section restates the station's own figure rather than playing a
   variation of it. At zero the radio has no identity — measured: across two
   hundred sections, not one figure recurred, which is what "обезличено" was.
   Too high and the hook wears out. */
const RESTATE = 0.42;

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
    /* Everything below the lowest note anyone can hear is energy that only
       eats headroom and turns the low mids to mud. The sub oscillator was
       reaching 18 Hz on the lower keys. */
    this.hp = core.filter('highpass', 36, 0.7);
    this.tilt = core.filter('highshelf', 3600, 0.7);
    this.tilt.gain.value = -4;          // takes the edge off without dulling it
    this.out.connect(this.hp);
    this.hp.connect(this.tilt);
    this.tilt.connect(core.master);

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
    this.sig = signature(this.stationId);
    this.arpPattern = this.sig.arp;
    this.leadPhrase = makeLead();
    this.bassFigure = this.sig.bass;
    this.drumPattern = this.sig.drums;
    /* Multi-bar figures are counted from where they were dealt, not from the
       absolute step, or a three-bar bass starts halfway through itself. */
    this.patternOrigin = 0;
    this.progDeck = new Deck(this.station.progressions);

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

  /**
   * Stop dead, rather than fade out.
   *
   * Switching the radio off eases every layer down over the best part of a
   * second, which is right when a rider turns the music off and quite wrong
   * when they hit a lorry: the sound carrying on after the impact takes the
   * impact with it. This cuts the layers to nothing on the sample, and the
   * silence that follows is a large part of what the crash is.
   */
  cut() {
    const t = this.core.t;
    for (const k in this.layers) {
      const g = this.layers[k].gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(0, t);
    }
    this.enabled = false;
  }

  /**
   * The audio time of the next step boundary at or after `t`.
   *
   * For anything outside the sequencer that wants to put a sound *in* the
   * track rather than over it. The arcade game's near misses are the reason it
   * exists: a hit fired the instant a lorry goes past lands wherever it lands
   * in the bar and reads as a sound effect, while the same hit nudged onto the
   * grid reads as part of the music — which is the difference between traffic
   * that is scored and traffic that is played.
   *
   * Sixteenths by default, which at a hundred beats a minute is a hundred and
   * fifty milliseconds. Quantising to anything coarser would make a reaction
   * sound late, which is worse than making it sound loose.
   *
   * @param every  grid in steps: 1 sixteenths, 2 eighths, 4 on the beat
   */
  gridTime(t, every = 1) {
    const d = this.stepDur;
    if (!this.nextTime || !(d > 0)) return t;
    let time = this.nextTime;
    let step = this.step;
    while (time - d >= t) { time -= d; step--; }
    while (time < t || (((step % every) + every) % every) !== 0) { time += d; step++; }
    return time;
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
    this.progDeck = new Deck(this.station.progressions);
    /* A new station announces itself with its own figure — that is the whole
       point of turning the dial. Variations come later. */
    this.sig = signature(id);
    this.progression = this.sig.progression;
    this.arpPattern = this.sig.arp;
    this.drumPattern = this.sig.drums;
    this.bassFigure = this.sig.bass;
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
    const makeup = 1 + (1 - smoothstep(0.08, 0.40, e)) * 0.7;
    /* Per-station trim, so changing station is a change of mood and not a
       change of volume — an eight decibel step between two of them sounded
       like the music had dropped out. */
    const on = (this.enabled ? 1 : 0) * (st.level ?? 1);
    /* The gates are spread across the band the rider is actually in, so that
       every layer is doing something on the way from town speed to open road:
       bass first, then drums, the arp through the middle, the lead last. */
    const target = {
      pad: on * (0.92 - smoothstep(0.25, 0.85, e) * 0.34) * makeup * sec.pad,
      arp: on * (0.08 + smoothstep(0.18, 0.58, e) * 0.6) * makeup * sec.arp * (st.arpLevel ?? 1),
      drums: on * smoothstep(0.16, 0.62, e) * 1.1 * sec.drums * (st.drums === 'none' ? 0 : 1),
      bass: on * smoothstep(0.03, 0.22, e) * 1.0 * st.bassMul,
      lead: on * smoothstep(0.55, 0.88, e) * 0.65 * sec.lead * (st.lead ? 1 : 0),
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
        /* Statement, then variation, then statement. Rather than a fresh figure
           every eight bars — which is what made an hour of this sound like
           nothing in particular — most sections restate the station's own
           figure and the rest play something derived from it. */
        const sig = this.sig;
        const restate = Math.random() < RESTATE;
        this.arpPattern = restate ? sig.arp : varyArp(sig.arp);
        this.bassFigure = restate ? sig.bass : varyBass(sig.bass);
        this.drumPattern = restate ? sig.drums : varyDrums(sig.drums, st.drums);
        this.patternOrigin = step;
        if (Math.random() < 0.5) this.leadPhrase = makeLead();
        // and the harmony comes home more often than it wanders
        if (Math.random() < 0.45) this.progression = restate ? sig.progression : this.progDeck.draw();
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

    /* position inside a figure that may be longer than a bar */
    const pos = (bars) => (((step - this.patternOrigin) % (bars * 16)) + bars * 16) % (bars * 16);

    if (s === 0 && bar % 2 === 0) this.pad(voice(notes), t, (60 / this.bpm) * 8);

    // never faster than eighths: sixteenths for an hour is relentless
    const rate = Math.max(2, e > 0.5 ? st.arpRate / 2 : st.arpRate);
    if (this.section.arp && s % rate === 0) {
      const cell = this.arpPattern[((step / rate) | 0) % this.arpPattern.length];
      if (cell) {
        // climb into the next octave past the top of the chord instead of
        // folding back onto a note that is already sounding
        const li = notes.length;
        const n = notes[cell.rung % li] + 12 * Math.floor(cell.rung / li) + st.arpOct;
        this.pluck(n, t, 0.26 + Math.random() * 0.06, cell.vel);
      }
    }

    if (st.drums !== 'none' && this.section.drums) {
      const d = this.drumPattern;
      const dp = pos(d.bars);                   // where we are inside the figure
      const fill = bar % 8 === 7;               // last bar of the section
      // the pattern is the section's; the extra weight on 2 and 4 is the speed
      if (d.kick.includes(dp) || (e > 0.55 && (s === 4 || s === 12))) {
        if (!(fill && s === 8 && Math.random() < 0.5)) this.kick(t);
      }
      if (d.snare.includes(dp)) this.snare(t);
      // a fill rolls out of the section instead of the pattern simply repeating
      if (fill && s >= 12 && s % 2 === 0 && Math.random() < 0.7) this.snare(t + this.stepDur * 0.5);
      if (st.hats && d.hat.includes(dp)) this.hat(t, s % 4 === 0 ? 0.5 : 0.26 + Math.random() * 0.16);
      if (st.hats && e > 0.6 && s === 14) this.hat(t, 0.6, true);
    }

    const bp = pos(this.bassFigure.bars);
    const bn = this.bassFigure.notes.find((x) => x.s === bp);
    if (bn) this.bass(root - 12 + bn.off, t, bn.dur);

    if (s === 0 && e > 0.55 && st.lead && this.section.lead) {
      for (const note of this.leadPhrase) {
        const n = notes[note.deg % notes.length] + 12 + note.oct;
        this.lead(n, t + note.at * this.stepDur, 0.34 + Math.random() * 0.2);
      }
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

  pluck(note, t, dur, vel = 1) {
    const core = this.core;
    const o = core.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = mtof(note);
    /* The cutoff has to follow the note. Parked at 2.6 kHz with a Q of 2.2 it
       put a resonant peak in the band the ear is most sensitive to and left it
       there for every note, so the higher the note the more of it sat right in
       that peak — which is most of what "shrill" was. Tracking the fundamental
       gives every note the same shape instead of the same emphasis. */
    const f0 = mtof(note);
    /* The multiplier has to be small enough that the clamp does not swallow it.
       At 5.5x the ceiling caught every note above 470 Hz, which is most of what
       the arp plays, so the "tracking" filter sat at a fixed 2.6 kHz exactly as
       before and changed nothing. At 3.2x a note at C5 opens to 1.7 kHz and its
       fourth harmonic — the one that lands in the band the ear is sharpest in —
       is gone, while a low note still opens wide enough to have an edge. */
    const open = clamp(f0 * 3.2, 700, 2200);
    const close = clamp(f0 * 1.4, 220, 800);
    const lp = core.filter('lowpass', open, 1.3);
    const g = core.gain(0);
    o.connect(lp);
    lp.connect(g);
    g.connect(this.layers.arp);

    lp.frequency.setValueAtTime(open, t);
    lp.frequency.exponentialRampToValueAtTime(close, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    /* 8 ms was a click, and a click repeated on every eighth note for an hour
       is what "harsh" actually sounds like — the notes were never the problem. */
    g.gain.linearRampToValueAtTime(0.2 * vel, t + 0.022);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  bass(note, t, dur) {
    const core = this.core;
    const ctx = core.ctx;
    while (note < 28) note += 12;      // keep it on the instrument, not under it
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
    const g2 = core.gain(0.45);
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
    g.gain.linearRampToValueAtTime(0.72, t + 0.006);
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
