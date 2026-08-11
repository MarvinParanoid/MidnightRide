import { isTouchDevice } from './input.js';

/**
 * A phone will happily run this at eight frames a second and never tell you
 * why. The expensive parts at small screen sizes are pixel count, the bloom
 * chain and the rain, in that order — so those are what get cut.
 */
export function detectQuality() {
  const cores = navigator.hardwareConcurrency || 4;
  const small = Math.min(innerWidth, innerHeight) < 720;
  const low = isTouchDevice || cores <= 4 || small;
  return low
    ? { name: 'low', pixelRatio: 1.0, rainDrops: 1600, bloomScale: 0.5, samples: 0, envEvery: 14 }
    : { name: 'high', pixelRatio: 1.75, rainDrops: 5000, bloomScale: 1, samples: 2, envEvery: 6 };
}
