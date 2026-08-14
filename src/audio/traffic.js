import { clamp } from '../geo.js';

/**
 * The other vehicles, heard.
 *
 * There was already a whoosh at the moment of a pass — a burst of filtered
 * noise swept across the stereo field. What it could not do is the thing that
 * makes a night road feel occupied: you should hear a lorry coming for four
 * seconds before it arrives, hear its pitch drop as it goes by, and hear it
 * leave. That needs a voice that lives as long as the vehicle is near, not an
 * event fired at the closest point.
 *
 * A handful of voices are handed to whichever vehicles are nearest and taken
 * back when they leave. Each is an engine tone plus tyre roar, panned by
 * bearing, attenuated by distance, and shifted by the rate at which the
 * distance is changing — which is Doppler, done from the geometry rather than
 * approximated by a sweep.
 */

/* Speed of sound. Not a knob: the shift you hear from a lorry at closing speed
   is entirely determined by it, and any other value sounds like a synthesiser. */
const C = 340;

const KINDS = {
  /* reach is how far out a voice is worth spending. Measured on a pass: a
     closing speed of about 60 m/s means seventy metres is barely two seconds of
     approach, which arrives as a noise rather than as something coming. */
  sedan: { f0: 98, tyre: 900, tyreQ: 0.9, level: 0.55, reach: 90 },
  van: { f0: 78, tyre: 780, tyreQ: 0.8, level: 0.7, reach: 100 },
  truck: { f0: 47, tyre: 620, tyreQ: 0.6, level: 1.0, reach: 130 },
};

class Voice {
  constructor(core, out) {
    const ctx = core.ctx;
    this.core = core;
    this.car = null;
    this.prevDist = 0;

    /* Two oscillators a fifth apart make an engine rather than a tone; the
       square carries the rattle, the sine carries the weight. */
    this.osc = ctx.createOscillator();
    this.osc.type = 'sawtooth';
    /* Start where an engine lives, not at the Web Audio default of 440 Hz: the
       first frame of a new voice is otherwise a concert A sliding into place. */
    this.osc.frequency.value = 90;
    this.osc2 = ctx.createOscillator();
    this.osc2.type = 'square';
    this.osc2.frequency.value = 135;
    this.engineGain = core.gain(0);
    this.engineLp = core.filter('lowpass', 420, 1.1);
    this.osc.connect(this.engineLp);
    this.osc2.connect(this.engineLp);
    this.engineLp.connect(this.engineGain);

    /* Tyres on wet tarmac are most of what you actually hear from outside. */
    this.noise = ctx.createBufferSource();
    this.noise.buffer = core.noise;
    this.noise.loop = true;
    this.tyreBp = core.filter('bandpass', 900, 0.9);
    this.tyreGain = core.gain(0);
    this.noise.connect(this.tyreBp);
    this.tyreBp.connect(this.tyreGain);

    this.pan = ctx.createStereoPanner();
    this.engineGain.connect(this.pan);
    this.tyreGain.connect(this.pan);
    this.pan.connect(out);

    this.osc.start();
    this.osc2.start();
    this.noise.start();
  }

  silence(t) {
    this.engineGain.gain.setTargetAtTime(0, t, 0.08);
    this.tyreGain.gain.setTargetAtTime(0, t, 0.08);
    this.car = null;
  }

  /**
   * @param d       metres to the vehicle
   * @param radial  metres per second the distance is growing (negative = closing)
   * @param bearing -1 hard left, +1 hard right
   */
  update(t, kind, d, radial, bearing, dt) {
    const k = KINDS[kind] || KINDS.sedan;
    /* Doppler from the closing rate. Approaching, the wavefronts pile up and
       the pitch rises; the instant it passes, the sign flips and it drops —
       the whole effect, and it falls out of the arithmetic for free. */
    const shift = C / Math.max(60, C + radial);
    const near = 1 - clamp((d - 3) / k.reach, 0, 1);
    const level = near * near * k.level;

    this.osc.frequency.setTargetAtTime(k.f0 * shift, t, 0.03);
    this.osc2.frequency.setTargetAtTime(k.f0 * 1.5 * shift, t, 0.03);
    this.tyreBp.frequency.setTargetAtTime(k.tyre * shift, t, 0.05);
    this.tyreBp.Q.value = k.tyreQ;
    /* Distance eats the top first, so a lorry a hundred metres off is a rumble
       and the same lorry beside you is a roar. */
    this.engineLp.frequency.setTargetAtTime(260 + 900 * near, t, 0.06);

    this.engineGain.gain.setTargetAtTime(level * 0.5, t, 0.05);
    this.tyreGain.gain.setTargetAtTime(level * 0.34, t, 0.05);
    this.pan.pan.setTargetAtTime(clamp(bearing, -1, 1), t, 0.06);
    void dt;
  }
}

export class TrafficSound {
  constructor(core, voices = 4) {
    this.core = core;
    this.out = core.gain(0.9);
    this.out.connect(core.master);
    this.voices = Array.from({ length: voices }, () => new Voice(core, this.out));
  }

  /**
   * Hand the voices to the nearest vehicles. Called every frame with whatever
   * the traffic system currently has on the road.
   */
  update(dt, cars, bike) {
    const t = this.core.t;
    /* Nearest first, and only those close enough to be worth a voice — a
       lorry earns one further out than a hatchback does. */
    const near = cars
      .filter((c) => c.group.visible)
      .map((c) => {
        const along = c.s - bike.s;
        const lat = c.lat - bike.lat;
        return { car: c, d: Math.hypot(along, lat), along, lat };
      })
      .filter((x) => x.d < (KINDS[x.car.kind] || KINDS.sedan).reach)
      .sort((a, b) => a.d - b.d)
      .slice(0, this.voices.length);

    const taken = new Set();
    for (const v of this.voices) {
      const keep = near.find((x) => x.car === v.car);
      if (keep) taken.add(keep.car);
      else v.car = null;
    }
    for (const x of near) {
      if (taken.has(x.car)) continue;
      const free = this.voices.find((v) => !v.car);
      if (!free) break;
      free.car = x.car;
      free.prevDist = x.d;
      taken.add(x.car);
    }

    for (const v of this.voices) {
      if (!v.car) { v.silence(t); continue; }
      const x = near.find((n) => n.car === v.car);
      if (!x) { v.silence(t); continue; }
      /* The rate of change of distance, measured rather than derived: it stays
         correct through a lane change, a car braking, or the rider slowing. */
      const radial = dt > 0 ? (x.d - v.prevDist) / dt : 0;
      v.prevDist = x.d;
      /* Bearing: alongside is hard left or right, far ahead or behind is centre. */
      const bearing = x.d > 0.5 ? clamp(x.lat / Math.max(4, Math.abs(x.along)) * 2.2, -1, 1) : 0;
      v.update(t, x.car.kind, x.d, radial, bearing, dt);
    }
  }
}
