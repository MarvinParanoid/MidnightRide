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
   metres, so a step is a step of the projected line and forty-eight of them at
   half resolution costs about what twenty did at full. Measured: reflections
   are continuous from 48 up, and 64 adds almost nothing. */
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
/* smaa is three extra full-screen passes. The low profile is the one profile
   that has no multisampling at all, so it is the one that would gain most from
   it and the one least able to pay — and it is reached by stepping down from a
   frame rate that was already poor. Edges lose. */
export const TIERS = [
  { name: 'high', pixelRatio: 1.75, bloomScale: 1.5, rain: 1.0, envEvery: 6, samples: 2, ssrSteps: 32, smaa: true, maxPixels: 3.3e6, gradeTaps: 5 },
  { name: 'mid', pixelRatio: 1.25, bloomScale: 0.7, rain: 0.6, envEvery: 9, samples: 2, ssrSteps: 22, smaa: true, maxPixels: 2.2e6, gradeTaps: 4 },
  { name: 'low', pixelRatio: 1.0, bloomScale: 0.5, rain: 0.32, envEvery: 14, samples: 0, ssrSteps: 12, smaa: false, maxPixels: 1.4e6, gradeTaps: 3 },
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
