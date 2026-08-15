import { isTouchDevice } from './input.js';

/**
 * Quality is decided by measurement, not by guesswork.
 *
 * The first version dropped to the low profile whenever a machine reported four
 * cores or a browser window shorter than 720 px — and promptly put a desktop
 * running at 76 fps into the cut-down renderer. Core counts and window sizes
 * say very little about a GPU. So now everything but a phone starts optimistic
 * and steps down only after the frame rate has actually been poor for several
 * seconds — and steps back up if it turns out it was a passing squall.
 */
/* ssrSteps is how far the reflection pass may march per pixel; zero turns it
   off. It used to be zero on the low profile, which made the guard's first
   step-down look like a bug — reflections appeared for a few seconds and then
   went out. The pass runs at half resolution now, so even the low profile can
   afford a march and the effect thins out instead of vanishing.
   With the bloom held still between frames (StableBloom) the same buffer buys
   more: 1.0x -> 0.067 per unit of light, 1.25x -> 0.060, 1.5x -> 0.0515, which
   is the floor the picture itself sets. 1.5 reaches it; nothing above is worth
   paying for.
   The counts are higher than they look: the march walks pixels rather than
   metres, so a step is a step of the projected line.
   Priced properly at last, by alternating step counts frame by frame on a real
   card (tools/test/bench.mjs --knobs): twelve steps, thirty-two and forty-eight
   all cost the same frame to within one per cent, while switching the pass off
   entirely saves sixteen. The march is not what the reflection costs — the
   half-resolution target, the temporal resolve and the full-screen composite
   are, and those are paid the moment the pass runs at all. So the step count is
   very nearly free and should be set by what it finds rather than by what it
   costs: measured on a held frame in the city, coverage climbs 2.9% at 8 steps,
   6.5% at 32, 8.2% at 48, 9.5% at 64, still rising.
   High therefore marches 48. The other two are left where they are on purpose:
   this was measured on one integrated Radeon, and "free" is a claim about a
   graphics card, not about arithmetic. */
/* bloomScale is the resolution of the bloom's own buffer, and it turned out to
   be what makes street lamps flicker. Measured over forty consecutive frames of
   the same drive, the frame-to-frame jitter of the light above the horizon:
   0.5x -> 12.5%, 1x -> 8.8%, 1.5x -> 7.5%, 2x -> 5.7%. A bright light crossing
   the texels of a coarse mip pulses on their boundaries, and the finer the grid
   the less it pulses. It costs the square of the number, so 1.5 is where the
   curve stops being worth it — and note the unhappy consequence: a machine the
   guard steps down gets *more* flicker, not less. */
/* maxPixels is an absolute ceiling on the drawing buffer, and it is the knob
   that was missing. pixelRatio only limits the density multiplier, so on a wide
   window the low profile still rendered 2226x1122 — two and a half million
   pixels, walked over by about a dozen full-screen passes. A profile meant for
   a machine that cannot keep up has to be allowed to draw fewer pixels, not
   merely fewer per CSS pixel.
   gradeTaps is how many samples the radial blur takes, and the grade pass is
   the most expensive one in the chain: each tap costs three texture reads,
   because the chromatic split needs the channels separately. Five taps is
   fifteen reads per pixel of the screen. */
/* The low profile, rebalanced against the measured price of each setting rather
   than by dropping everything at once.
   It used to have no antialiasing of any kind — no multisampling, no post pass
   — which is the profile a struggling machine is sent to and the one where the
   staircase measured worst of the three. And it had the smallest bloom buffer,
   which is the setting that makes street lamps pulse: frame-to-frame jitter of
   the light above the horizon went 0.5x -> 12.5%, 1x -> 8.8%, 1.5x -> 7.5%. So
   the cheap profile got both the worst edges and the worst flicker.
   Priced on a real card (bench.mjs --knobs), turning smaa off is worth x0.82
   and shrinking the bloom buffer to a third only x0.94 — while pixels are dead
   linear, x0.48 for half of them. So both are bought back and paid for out of
   resolution: smaa on, bloom buffer to 1.0, pixel ceiling 1.4 -> 1.05 Mpx.
   Composed, that arithmetic said x0.97. Weighed as a whole profile it came out
   x1.15 — the prediction was wrong by fifteen per cent, because ratios measured
   against the high profile at two megapixels do not carry to a profile running
   at one with no multisampling. Ratios do not compose across operating points.
   The ceiling is 0.9 Mpx instead, which measured at x0.95 against the old
   profile; a second reading at 0.82 Mpx came out at x1.05, which cannot be true
   of fewer pixels and says the whole-profile comparison is only good to about
   ten per cent — switching three structural settings frame by frame measures
   the composer reallocating its buffers as much as it measures the frame.
   All of which the resolution controller makes moot: it finds the number at
   runtime, on the machine in front of it, instead of it being guessed here. */
export const TIERS = [
  { name: 'high', pixelRatio: 1.75, bloomScale: 1.5, rain: 1.0, envEvery: 6, samples: 2, ssrSteps: 48, smaa: true, maxPixels: 3.3e6, gradeTaps: 5 },
  { name: 'mid', pixelRatio: 1.25, bloomScale: 0.7, rain: 0.6, envEvery: 9, samples: 2, ssrSteps: 22, smaa: true, maxPixels: 2.2e6, gradeTaps: 4 },
  { name: 'low', pixelRatio: 1.0, bloomScale: 1.0, rain: 0.32, envEvery: 14, samples: 0, ssrSteps: 12, smaa: true, maxPixels: 0.9e6, gradeTaps: 3 },
];

/** Where to start before we know anything. Phones start low; everything else high. */
export function detectQuality() {
  /* ?q=low pins the starting profile. The renderer is built from it — the
     multisampling of the main buffer in particular is fixed at construction —
     so stepping the guard down afterwards does not produce the same renderer a
     weak machine gets. Without this, a fault that only appears on the low
     profile cannot be reproduced anywhere but on the machine that reported it. */
  const asked = new URLSearchParams(location.search).get('q');
  const named = TIERS.findIndex((t) => t.name === asked);
  if (named >= 0) return { index: named, ...TIERS[named] };

  const weak = isTouchDevice || (navigator.hardwareConcurrency || 8) <= 2;
  const index = weak ? 2 : 0;
  return { index, ...TIERS[index] };
}

const DOWN_FPS = 45;
const DOWN_FOR = 4;      // seconds of it before we believe it
const UP_FPS = 80;
const UP_FOR = 25;       // much longer, so it cannot oscillate
const WARMUP = 3;        // shaders are still compiling; ignore the first frames


/**
 * Resolution, adjusted continuously, ahead of everything else.
 *
 * The profile ladder is three fixed presets and it waits four seconds before
 * moving between them, which makes it a blunt instrument for a load that
 * changes every few seconds — ride into a city in the rain and the frame rate
 * falls, the ladder eventually drops five settings at once, and one of the five
 * makes the lamps flicker worse than they did. Meanwhile the one setting that
 * actually scales smoothly was pinned to whatever the preset said.
 *
 * Measured on a real card (tools/test/bench.mjs --knobs), the cost of a frame
 * is very close to linear in the number of pixels in it: half the pixels came
 * out at x0.48 and a quarter at x0.24. Nothing else in the renderer is that
 * well behaved, so resolution is the right thing to spend first and the only
 * one worth spending continuously.
 *
 * Two things keep it from being a nuisance. It reads the GPU's own timer where
 * the browser has one, because wall-clock frame time on a vsynced display is
 * quantised to the refresh interval and cannot tell 9 ms from 15. And it
 * changes the buffer rarely — every change reallocates the whole post-processing
 * chain, so a controller that nudged the size every frame would spend more than
 * it saved.
 */
const SCALE_MIN = 0.55;      // below this the picture is soft enough to notice
const SCALE_MAX = 1.0;       // never more than the profile already allows
const AIM_MS = 13.5;         // comfortably inside a 60 Hz frame
const HIGH_MS = 16.0;        // over this, give ground
const LOW_MS = 9.5;          // under this, there is room to take some back
const SETTLE = 0.8;          // seconds between changes: each one costs a reallocation
const STEP_ENOUGH = 0.03;    // do not reallocate for a change nobody could see

export class ResolutionGuard {
  constructor(apply) {
    this.apply = apply;
    this.scale = 1;
    this.applied = 1;
    this.since = 0;
    this.warm = 0;
  }

  /** Called once a frame. `gpuMs` is null when the browser has no timer query. */
  update(dt, frameMs, gpuMs) {
    this.warm += dt;
    this.since += dt;
    if (this.warm < WARMUP) return;

    /* The GPU's own figure when there is one. Otherwise wall-clock, with the
       target relaxed, because a vsynced 60 Hz frame reads as 16.7 ms whether
       the work took two milliseconds or sixteen and only a frame that misses
       says anything at all. */
    const ms = gpuMs && gpuMs > 0 ? gpuMs : frameMs;
    const slack = gpuMs && gpuMs > 0 ? 1 : 1.25;

    if (ms > HIGH_MS * slack) this.scale *= 0.94;
    else if (ms < LOW_MS * slack) this.scale *= 1.02;
    else this.scale += (AIM_MS - ms) * 0.0008;     // creep towards the target

    this.scale = Math.max(SCALE_MIN, Math.min(SCALE_MAX, this.scale));

    if (this.since < SETTLE) return;
    if (Math.abs(this.scale - this.applied) < STEP_ENOUGH) return;
    this.since = 0;
    this.applied = this.scale;
    this.apply(this.applied);
  }

  /** A profile change rebuilds the buffers anyway; start it from the top. */
  reset() {
    this.scale = 1;
    this.applied = 1;
    this.since = 0;
    this.warm = 0;
  }
}

export class QualityGuard {
  constructor(index, apply) {
    this.index = index;
    this.apply = apply;
    this.badFor = 0;
    this.goodFor = 0;
    this.warm = 0;
    this.changes = 0;
    this.upgrades = 0;
    this.startName = TIERS[index].name;
  }

  update(dt, fps, busy) {
    this.warm += dt;
    if (this.warm < WARMUP || busy) return;

    if (fps < DOWN_FPS) { this.badFor += dt; this.goodFor = 0; }
    else if (fps > UP_FPS) { this.goodFor += dt; this.badFor = 0; }
    else { this.badFor = Math.max(0, this.badFor - dt); this.goodFor = 0; }

    if (this.badFor >= DOWN_FOR && this.index < TIERS.length - 1) {
      this.step(this.index + 1);
    } else if (this.goodFor >= UP_FOR && this.index > 0 && this.upgrades < 2) {
      this.upgrades++;
      this.step(this.index - 1);
    }
  }

  step(index) {
    this.index = index;
    this.changes++;
    this.badFor = 0;
    this.goodFor = 0;
    this.warm = 0;               // give the new settings time to show their worth
    this.apply(TIERS[index]);
  }

  get name() {
    return TIERS[this.index].name;
  }
}
