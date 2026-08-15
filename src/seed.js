/**
 * One number that decides the night.
 *
 * Most of the world was already reproducible: the centreline is a function of
 * distance, each chunk's props are keyed by its index, the biome chain and the
 * traffic run off fixed constants. What was missing was a way to say *which*
 * world, and one thing that was not reproducible at all — see events.js, where
 * every rare event was counted down in seconds and therefore happened wherever
 * the frame rate put it.
 *
 * With both fixed, `?seed=74291` is a ride you can hand to someone else: the
 * same road, the same weather coming and going, the same train at the same
 * kilometre. Their speed and their line through it are their own, which is the
 * point — there is nothing here to compare, only a night to have been on.
 *
 * The default is the calendar day, so without asking for anything everyone is
 * on tonight's road together, and tomorrow everyone is somewhere else.
 */
export const WORLD_SEED = (() => {
  try {
    const asked = new URLSearchParams(location.search).get('seed');
    if (asked !== null && /^[0-9]{1,10}$/.test(asked)) return Number(asked) >>> 0;
  } catch { /* no location: a test harness, or a worker */ }
  return Math.floor(Date.now() / 86400000) >>> 0;
})();

/**
 * A number from a name, not from a running stream.
 *
 * The events all drew from one shared generator, which quietly coupled them
 * together: skip one because you happened to be in a tunnel and every draw
 * after it shifts, so the same seed stops meaning the same ride. Keyed by what
 * is being decided instead — the seed, the kind of thing, and which one of them
 * this is — each answer stands alone, nothing has to be replayed to reach it,
 * and the order they are asked in does not matter.
 *
 * Three rounds of the finalising mix from MurmurHash3, which is more than
 * enough to decorrelate small consecutive keys.
 */
export function keyed(seed, kind, n = 0) {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  for (let i = 0; i < kind.length; i++) {
    h = Math.imul(h ^ kind.charCodeAt(i), 0x5bd1e995) >>> 0;
    h = (h ^ (h >>> 15)) >>> 0;
  }
  h = Math.imul(h ^ (n + 0x165667b1), 0x27d4eb2f) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** The same, as a fraction: `pick(seed, 'train', 4)` is always the same 0..1. */
export const pick = (seed, kind, n = 0) => keyed(seed, kind, n) / 4294967296;
