import { clamp, lerp } from '../geo.js';

const GEARS = [0, 42, 68, 96, 128, 168, 220];   // km/h at the top of each gear
const IDLE_RPM = 1250;
const REDLINE = 9800;

/**
 * A big parallel twin, built out of three detuned saws, a sub and a lot of
 * filtered noise. Plus the wind, the tyres and the rain hitting your helmet.
 */
export class EngineSound {
  constructor(core) {
    const { ctx } = core;
    this.core = core;

    this.out = core.gain(0.0);
    /* And a brick wall under the whole engine, for the same reason. */
    this.rumbleCut = core.filter('highpass', 28, 0.7);
    this.out.connect(this.rumbleCut);
    this.rumbleCut.connect(core.master);

    /* ── cylinders ─────────────────────────────────────── */
    this.bus = core.gain(1);
    this.lp = core.filter('lowpass', 500, 1.6);
    this.body = core.filter('peaking', 180, 1.1);
    this.body.gain.value = 3.5;   // less low-mid honk, so the bass line has room
    this.dist = core.drive(9);

    this.bus.connect(this.lp);
    this.lp.connect(this.body);
    this.body.connect(this.dist);
    this.dist.connect(this.out);

    this.oscs = [];
    for (const [type, detune, gain] of [
      ['sawtooth', 0, 0.5],
      ['sawtooth', 11, 0.32],
      ['sawtooth', -14, 0.32],
      ['square', 1200, 0.06],     // a hint of intake honk an octave up
    ]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.detune.value = detune;
      const g = core.gain(gain);
      o.connect(g);
      g.connect(this.bus);
      o.start();
      this.oscs.push(o);
    }
    this.sub = ctx.createOscillator();
    this.sub.type = 'sine';
    this.subGain = core.gain(0.42);
    this.sub.connect(this.subGain);
    this.subGain.connect(this.bus);
    this.sub.start();

    /* combustion roughness */
    this.exNoise = core.noiseSource();
    this.exBp = core.filter('bandpass', 420, 0.9);
    this.exGain = core.gain(0.0);
    this.exNoise.connect(this.exBp);
    this.exBp.connect(this.exGain);
    this.exGain.connect(this.bus);

    /* ── wind ──────────────────────────────────────────── */
    this.windSrc = core.noiseSource();
    this.windLp = core.filter('lowpass', 700, 0.7);
    this.windHp = core.filter('highpass', 120, 0.5);
    /* Air over the top of a helmet is not flat hiss, it howls — and a narrow
       resonance is heard far better than the same energy spread across the
       spectrum, which matters here because broadband noise is what masks the
       music. Presence without loudness. */
    this.windPeak = core.filter('peaking', 1100, 1.5);
    this.windPeak.gain.value = 0;
    this.windGain = core.gain(0);
    this.windSrc.connect(this.windHp);
    this.windHp.connect(this.windLp);
    this.windLp.connect(this.windPeak);
    this.windPeak.connect(this.windGain);
    this.windGain.connect(this.out);

    /* ── tyres on wet tarmac ───────────────────────────── */
    this.tyreSrc = core.noiseSource();
    this.tyreBp = core.filter('bandpass', 900, 0.55);
    this.tyreGain = core.gain(0);
    this.tyreSrc.connect(this.tyreBp);
    this.tyreBp.connect(this.tyreGain);
    this.tyreGain.connect(this.out);

    /* ── rain on the helmet ────────────────────────────── */
    this.rainSrc = core.noiseSource();
    this.rainBp = core.filter('bandpass', 2400, 0.5);
    this.rainGain = core.gain(0);
    this.rainSrc.connect(this.rainBp);
    this.rainBp.connect(this.rainGain);
    this.rainGain.connect(this.out);

    this.out.gain.setTargetAtTime(0.45, core.t, 0.5);

    this.rpm = IDLE_RPM;
    this.gear = 1;
    this.shiftT = 0;
    this.popT = 0;
  }

  /**
   * Work out revs from road speed by picking a plausible gear.
   *
   * The first version upshifted only on reaching the top of a gear, so the
   * engine always sat wherever that gear happened to put it — measured: 9371
   * rpm at 40 km/h and 8037 at 90, against a redline of 9800. That is a bike
   * being thrashed in first, not one being ridden, and it is why slowing down
   * could *raise* the note.
   *
   * A gear is now anything the speed physically allows, and which one you are
   * in depends on the throttle: cruising takes the tallest gear it can, opening
   * it up drops down for the revs. Which is what a rider does.
   */
  updateGearing(kmh, throttle, dt) {
    const wantFrac = lerp(0.42, 0.88, clamp(throttle, 0, 1));
    let best = 1;
    let bestErr = Infinity;
    for (let g = 1; g < GEARS.length; g++) {
      const revs = REDLINE * (kmh / GEARS[g]);
      if (revs > REDLINE * 1.02 || revs < 1900) continue;      // over-revving, or lugging
      const err = Math.abs(revs / REDLINE - wantFrac);
      if (err < bestErr) { bestErr = err; best = g; }
    }
    /* Hysteresis, or the gearbox hunts on every wobble of the throttle. */
    this.shiftHold = Math.max(0, (this.shiftHold || 0) - dt);
    if (best !== this.gear && this.shiftHold <= 0) {
      this.gear = best;
      this.shiftHold = 0.45;
    }

    const target = REDLINE * (kmh / GEARS[this.gear]);
    const idleBlend = clamp(kmh / 8, 0, 1);
    const want = lerp(IDLE_RPM, clamp(target, 1400, REDLINE), idleBlend);
    // revs chase the target, but never instantly — that lag is the whole feel
    this.rpm += (want - this.rpm) * Math.min(1, dt * 6.5);
  }

  update(dt, st) {
    const { kmh, throttle, brake, rain, enclosure, offRoad, musicEnergy = 0 } = st;
    const core = this.core;
    const t = core.t;

    /* the ride makes room for the music: as the track fills out, the bike and
       the wind step back a little rather than shouting over it */
    this.out.gain.setTargetAtTime(0.45 - clamp(musicEnergy, 0, 1) * 0.16, t, 0.7);
    const prevGear = this.gear;
    this.updateGearing(kmh, throttle, dt);

    if (this.gear !== prevGear) this.shiftT = 0.11;   // brief cut on the upshift
    this.shiftT = Math.max(0, this.shiftT - dt);
    const cut = this.shiftT > 0 ? 0.25 : 1;

    const revs = clamp(this.rpm / REDLINE, 0, 1.05);
    const f = clamp(this.rpm / 60, 18, 190);          // firing frequency

    for (const o of this.oscs) o.frequency.setTargetAtTime(f, t, 0.02);
    /* Never below thirty hertz. At idle the firing frequency is twenty, so the
       sub was sitting at ten — measured as the loudest band in the whole engine
       at idle (-32 dB against -42 for everything above it) and audible to
       nobody. The same mistake the music made with an 18 Hz sub. */
    this.sub.frequency.setTargetAtTime(Math.max(30, f * 0.5), t, 0.03);

    const load = clamp(throttle * 0.85 + revs * 0.18, 0, 1);
    this.lp.frequency.setTargetAtTime(240 + load * 2900 + revs * 1500, t, 0.05);
    this.lp.Q.setTargetAtTime(1.2 + load * 3.4, t, 0.1);
    this.exBp.frequency.setTargetAtTime(300 + revs * 1400, t, 0.06);
    this.exGain.gain.setTargetAtTime((0.06 + revs * 0.3) * (0.4 + throttle * 0.6) * cut, t, 0.05);
    /* The engine steps back a little as the speed comes up, so that the wind
       has somewhere to go. Measured: the engine bus sat 20 dB above the wind at
       190 km/h, and no amount of lifting the wind could close that without the
       broadband noise swallowing the music. Shifting the balance with speed
       costs nothing and is what actually happens on a bike — past a hundred and
       fifty you stop hearing the engine and start hearing the air. */
    const fast = clamp(kmh / 190, 0, 1);
    this.bus.gain.setTargetAtTime((0.13 + load * 0.15) * cut * (1 - fast * 0.3), t, 0.04);

    /* overrun crackle: shut the throttle at high revs and it talks back */
    this.popT -= dt;
    if (throttle < 0.1 && revs > 0.45 && this.popT <= 0 && Math.random() < 0.4) {
      this.pop(0.1 + revs * 0.35);
      this.popT = 0.06 + Math.random() * 0.22;
    }

    /* Wind is broadband noise, the one thing that will happily mask an entire
       mix, so it was kept dark — and it was kept so dark that it did nothing.
       Measured against the engine: 46 dB down at 60 km/h and 28 dB down at 190,
       with the low-pass at 940 Hz flat out, which removes the hiss that is what
       makes wind sound like wind rather than like rumble. On a motorcycle at
       190 the wind is the loudest thing there is; here it was inaudible, and
       the whole sense of speed was left to the pitch of the engine.
       Opened up and lifted — still under the music, but present. */
    const v = kmh / 3.6;
    this.windGain.gain.setTargetAtTime(Math.pow(clamp(v / 50, 0, 1.35), 2) * 0.3, t, 0.15);
    this.windLp.frequency.setTargetAtTime(620 + v * 40, t, 0.2);
    // the howl climbs and sharpens with speed
    this.windPeak.frequency.setTargetAtTime(700 + v * 22, t, 0.2);
    this.windPeak.gain.setTargetAtTime(clamp(v / 45, 0, 1.2) * 11, t, 0.3);

    /* Dry tyre roar measured 44 dB under the engine — nothing. Wet was already
       fine, so only the dry floor moves. */
    const tyre = clamp(v / 40, 0, 1.3) * (0.062 + rain * 0.1) + (offRoad ? 0.18 : 0);
    this.tyreGain.gain.setTargetAtTime(tyre, t, 0.12);
    this.tyreBp.frequency.setTargetAtTime(offRoad ? 380 : 700 + v * 16, t, 0.2);
    this.tyreBp.Q.setTargetAtTime(offRoad ? 1.6 : 0.55, t, 0.2);

    this.rainGain.gain.setTargetAtTime(rain * (0.07 + v * 0.0011) * (1 - enclosure * 0.92), t, 0.4);

    if (brake > 0.4 && v > 4) {
      this.tyreGain.gain.setTargetAtTime(tyre + 0.08 * brake, t, 0.05);
    }
  }

  /** Exhaust pop. */
  pop(amp) {
    const core = this.core;
    const t = core.t;
    const s = core.ctx.createBufferSource();
    s.buffer = core.noise;
    s.playbackRate.value = 1.4;
    const bp = core.filter('bandpass', 900 + Math.random() * 1200, 2.5);
    const g = core.gain(0);
    s.connect(bp);
    bp.connect(g);
    g.connect(this.out);
    g.gain.setValueAtTime(amp, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + 0.09);
    s.start(t, Math.random() * 2);
    s.stop(t + 0.12);
  }

  /** An oncoming car goes past: doppler-ish noise sweep. */
  whoosh(intensity = 1) {
    const core = this.core;
    const t = core.t;
    const s = core.ctx.createBufferSource();
    s.buffer = core.noise;
    s.loop = true;
    const bp = core.filter('bandpass', 300, 1.2);
    const g = core.gain(0);
    const pan = core.ctx.createStereoPanner();
    s.connect(bp);
    bp.connect(g);
    g.connect(pan);
    pan.connect(this.out);

    const dur = 0.55 / clamp(intensity, 0.4, 1.6);
    bp.frequency.setValueAtTime(280, t);
    bp.frequency.exponentialRampToValueAtTime(1900, t + dur * 0.42);
    bp.frequency.exponentialRampToValueAtTime(220, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.34 * clamp(intensity, 0.3, 1.4), t + dur * 0.42);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    pan.pan.setValueAtTime(-0.75, t);
    pan.pan.linearRampToValueAtTime(0.75, t + dur);
    s.start(t);
    s.stop(t + dur + 0.05);
  }
}
