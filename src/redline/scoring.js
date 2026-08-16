/**
 * What a pass was worth.
 *
 * This is the arcade half of the split: `proximity.js` says how much air there
 * was beside the nearest car, and says nothing about whether that is good news.
 * Here it becomes good news.
 *
 * Nothing in this file knows about Three.js, the renderer or the road. It takes
 * numbers in and gives numbers out, which is deliberate: the question it exists
 * to answer — is threading a gap at speed satisfying enough to want another go —
 * is a question about the shape of the reward curve, and that can be argued with
 * in a second of plain Node rather than in a browser at thirty frames a second.
 *
 * Two decisions are baked in, both from the design rather than from taste:
 *
 * A pass is scored when it is *over*, not while it is happening. The number
 * that matters is the closest the two ever came, and you do not know that until
 * the car is behind you. Scoring continuously would pay out for a long slow
 * crawl alongside a lorry, which is the opposite of the intent.
 *
 * And braking is never punished directly. It costs what it costs — less speed
 * is less meter and a smaller multiplier on whatever you do next — so slowing
 * down to make a gap you would otherwise miss is a trade the player is allowed
 * to make and sometimes should. The game asks how late you dare to brake, not
 * whether you dare to at all.
 */

/**
 * Metres of air, and what each band is called. Ordered tightest first, so the
 * first match wins.
 *
 * The bands come from what the eye can actually resolve at the distance you
 * commit from: a vehicle reads as one mark out to about a hundred and sixty
 * metres, which at two hundred and fifty is a little over two seconds. Anything
 * finer than a fifth of a metre is beyond what the player can be said to have
 * aimed at, so it is one band rather than an infinite regress of them.
 */
export const BANDS = [
  { under: 0.2, name: 'NO WAY', worth: 8 },
  { under: 0.45, name: 'THREAD', worth: 4 },
  { under: 0.8, name: 'NEAR MISS', worth: 2 },
  { under: 1.2, name: 'CLOSE', worth: 1 },
];

/** The gap that stops counting as a gap. Wider than this and nothing happened. */
const NOTICED = 1.2;

/** Seconds of nothing before the combo lets go. */
const COMBO_HOLD = 4;

export class Scoring {
  constructor() {
    this.reset();
  }

  reset() {
    this.score = 0;
    this.combo = 0;
    this.meter = 0;          // 0..1 — the REDLINE meter
    this.best = Infinity;    // closest pass of the run, in metres
    this.passes = 0;
    this.sinceScore = 0;
    this.current = null;     // the car being passed right now
    this.currentMin = Infinity;
    this.events = [];        // what happened this frame, for sound and text
  }

  /**
   * @param dt      seconds
   * @param speed   metres per second
   * @param near    a reading from proximity(): { nearest, clearance, closing }
   * @returns this.events — reused, so read it before the next update
   */
  update(dt, speed, near) {
    this.events.length = 0;
    this.sinceScore += dt;

    /* Follow one car at a time: whoever is closest is the one being passed.
       When that changes — they fell behind, or someone closer arrived — the
       previous pass is finished and can be judged. */
    if (near.nearest !== this.current) {
      this.commit(speed);
      this.current = near.nearest;
      this.currentMin = Infinity;
    }
    if (this.current && near.clearance < this.currentMin) {
      this.currentMin = near.clearance;
    }

    if (this.sinceScore > COMBO_HOLD && this.combo > 0) {
      this.combo = 0;
      this.events.push({ kind: 'combo-lost' });
    }

    /* The meter. Speed alone holds it around the middle; the top has to be
       earned by passes and is lost by not taking any. */
    const fromSpeed = Math.min(0.62, Math.max(0, (speed - 14) / 62));
    /* Two forces, and the balance between them is the design. It always leaks,
       so sitting still on the meter is not something that can be done; and it is
       pulled towards what speed alone sustains, so an empty road at two hundred
       settles near half and plays half a track — not punished, not rewarded.
       Equilibrium is a tenth below the speed's own level.
       The first version wrote this as a sag towards `max(fromSpeed, meter)`,
       which is always the meter when the meter is low, so the pull was zero and
       only the leak remained: it could never rise from speed at all. */
    this.meter -= dt * 0.055;
    this.meter += (fromSpeed - this.meter) * dt * 0.5;
    this.meter = Math.min(1, Math.max(0, this.meter));

    return this.events;
  }

  /** Judge the pass that has just ended. */
  commit(speed) {
    const clear = this.currentMin;
    if (!this.current || !(clear < NOTICED)) return;

    const band = BANDS.find((b) => clear < b.under) || BANDS[BANDS.length - 1];
    /* Speed is the multiplier, not the subject. Thirty centimetres from a lorry
       at eighty is a shrug; the same thirty centimetres at two hundred and fifty
       is the whole game. */
    const fast = 0.3 + Math.max(0, speed) / 70;
    const worth = band.worth * fast;

    this.combo++;
    this.passes++;
    this.score += worth * (1 + this.combo * 0.12);
    this.best = Math.min(this.best, clear);
    this.meter = Math.min(1, this.meter + 0.035 * band.worth);
    this.sinceScore = 0;
    this.events.push({ kind: 'pass', band: band.name, clearance: clear, worth, combo: this.combo });
  }

  /** The run is over. Everything stops; the score stands. */
  crash() {
    this.commit(0);
    this.combo = 0;
    this.meter = 0;
    this.events.push({ kind: 'crash' });
  }
}
