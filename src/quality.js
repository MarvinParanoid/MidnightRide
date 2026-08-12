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
export const TIERS = [
  { name: 'high', pixelRatio: 1.75, bloomScale: 1.0, rain: 1.0, envEvery: 6, samples: 2 },
  { name: 'mid', pixelRatio: 1.25, bloomScale: 0.7, rain: 0.6, envEvery: 9, samples: 2 },
  { name: 'low', pixelRatio: 1.0, bloomScale: 0.5, rain: 0.32, envEvery: 14, samples: 0 },
];

/** Where to start before we know anything. Phones start low; everything else high. */
export function detectQuality() {
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
