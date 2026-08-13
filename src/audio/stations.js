/**
 * Four stations, each with its own harmony, tempo and instrumentation.
 *
 * The old engine had one key, one four-chord loop and one drum pattern. That
 * holds for half an hour and not for five, which is the length that matters now
 * the game is also a channel. Chords are written as semitone offsets from
 * whatever the current key is, so the whole thing transposes for free.
 */
const CH = {
  min: [0, 3, 7],
  maj: [0, 4, 7],
  min7: [0, 3, 7, 10],
  maj7: [0, 4, 7, 11],
  min9: [0, 3, 7, 10, 14],
  sus4: [0, 5, 7],
  maj6: [0, 4, 7, 9],
};

export const chordNotes = (root, type) => CH[type].map((i) => root + i);

/* No fixed interval pool. A list like [0,3,5,7,10,...] contains the minor
   third, and half the chords in these progressions are major — a minor third
   over a major third is not colour, it is a wrong note, and picking it at
   random is what made the radio sound broken. The lead takes chord tones,
   resolved against whatever is actually sounding. */

/**
 * A fresh arpeggio figure per section, rather than the one eight-note sequence
 * the whole soundtrack used to share. Rests matter as much as notes: the old
 * pattern never stopped, and relentless is the fastest way to wear a listener
 * out over an hour.
 */
export function makeArp(rnd = Math.random) {
  /* Length has to divide into the bar. A twelve-cell figure over eight cells
     per bar repeats every bar and a half, so its accents drift against the
     chord changes and the drums — which is heard as something being subtly
     wrong rather than as a rhythm. */
  const len = rnd() < 0.5 ? 8 : 16;
  const pat = [];
  let deg = 0;
  for (let i = 0; i < len; i++) {
    if (rnd() < 0.16 || (i % 4 === 0 && rnd() < 0.12)) { pat.push(null); continue; }
    // spread across the chord instead of circling back onto the root
    deg += rnd() < 0.5 ? 1 : (rnd() < 0.5 ? 2 : -1);
    deg = ((deg % 4) + 4) % 4;
    pat.push({
      deg,
      oct: rnd() < 0.14 ? 12 : 0,
      // every note at one volume is a machine; the beat gets the weight
      vel: i % 4 === 0 ? 0.95 : 0.5 + rnd() * 0.28,
    });
  }
  return pat;
}

/** A phrase of three to six chord tones with its own rhythm. */
export function makeLead(rnd = Math.random) {
  const n = 3 + ((rnd() * 4) | 0);
  const out = [];
  let at = (rnd() * 2) | 0;
  let deg = (rnd() * 3) | 0;
  for (let i = 0; i < n; i++) {
    deg = rnd() < 0.5 ? (deg + 1) % 4 : (rnd() * 4) | 0;
    out.push({ at, deg, oct: rnd() < 0.35 ? 12 : 0 });
    at += 2 + ((rnd() * 5) | 0);
    if (at > 15) break;
  }
  return out;
}

/**
 * A bass figure for the section.
 *
 * The arp and the lead have been regenerating every eight bars for a while, but
 * the bass played the same four hits — steps 0, 6, 8 and 14 — for as long as the
 * radio was on. It is the one voice that never stops and never rests, so it is
 * the one whose loop you learn first.
 */
export function makeBass(rnd = Math.random) {
  const shapes = [
    [0, 6, 8, 14],
    [0, 8],
    [0, 3, 8, 11],
    [0, 6, 8, 12, 14],
    [0, 4, 8, 12],
    [0, 7, 8, 15],
    [0, 8, 10, 14],
    [0, 6, 10],
  ];
  const at = shapes[(rnd() * shapes.length) | 0];
  return at.map((s) => ({
    s,
    // the fifth or the octave now and then, so a four-bar loop keeps moving;
    // never on the downbeat, which is what tells you what the chord is
    off: s === 0 ? 0 : rnd() < 0.18 ? 7 : rnd() < 0.12 ? 12 : 0,
    dur: s === 0 ? 0.5 : 0.28,
  }));
}

/**
 * A kit pattern for the section. Same idea: one fixed bar of kick and snare is
 * the first thing an hour-long loop gives away.
 */
export function makeDrums(kind, rnd = Math.random) {
  const tight = kind === 'tight';

  const kick = new Set([0]);                       // the downbeat is not negotiable
  kick.add(tight && rnd() < 0.35 ? 10 : 8);
  if (rnd() < (tight ? 0.55 : 0.3)) kick.add(rnd() < 0.5 ? 3 : 6);
  if (tight && rnd() < 0.3) kick.add(11);

  const snare = new Set([4, 12]);                  // backbeat stays put
  if (tight) snare.add(14);
  if (rnd() < 0.25) snare.add(rnd() < 0.5 ? 7 : 15);

  /* eighths, eighths opening into sixteenths, or a broken figure */
  const mode = rnd();
  const hat = [];
  for (let s = 0; s < 16; s++) {
    const on = mode < 0.45 ? s % 2 === 0
      : mode < 0.75 ? (s % 2 === 0 || s >= 8)
        : s % 4 !== 1;
    if (on) hat.push(s);
  }

  return { kick: [...kick], snare: [...snare], hat };
}

/** Same chord, different spacing — rotate some notes up an octave. */
export function voice(notes, rnd = Math.random) {
  // rotation only: an extra octave on top of the station's own padOct pushed
  // the pads into a thin register where they stopped sounding like pads
  const rot = (rnd() * notes.length) | 0;
  return notes.map((n, i) => (i < rot ? n + 12 : n));
}

export const STATIONS = {
  /* The default: the city, neon, something to nod to. */
  night: {
    id: '88.3', name: 'NIGHT FM', style: 'procedural synthwave',
    bpm: [86, 106],
    progressions: [
      [[0, 'min7'], [-4, 'maj7'], [3, 'maj7'], [-2, 'maj']],
      [[0, 'min7'], [3, 'maj7'], [-2, 'maj'], [-4, 'maj7']],
      [[0, 'min'], [-5, 'min7'], [-4, 'maj7'], [-2, 'maj']],
      [[0, 'min9'], [-2, 'maj'], [-4, 'maj7'], [-4, 'maj7']],
      [[0, 'min7'], [-7, 'maj7'], [-4, 'maj7'], [-2, 'maj']],
      [[-4, 'maj7'], [-2, 'maj'], [0, 'min7'], [0, 'min7']],
    ],
    padCut: [420, 1700], padOct: 12, arpOct: 24, arpRate: 2,
    lead: true, drums: 'four', hats: true, bassMul: 1, delayBeats: 0.75,
    level: 0.92,
  },

  /* Empty road, nobody about. Slower, wider, barely any percussion. */
  after: {
    id: '91.7', name: 'AFTER HOURS', style: 'ambient',
    bpm: [64, 76],
    progressions: [
      [[0, 'min9'], [-5, 'maj7'], [0, 'min9'], [-7, 'maj7']],
      [[0, 'sus4'], [-2, 'maj7'], [-4, 'maj7'], [-5, 'maj7']],
      [[0, 'min7'], [-4, 'maj6'], [0, 'min7'], [-2, 'sus4']],
      [[-5, 'maj7'], [0, 'min9'], [-7, 'maj7'], [-5, 'maj7']],
      [[0, 'sus4'], [0, 'min9'], [-4, 'maj7'], [-4, 'maj6']],
    ],
    padCut: [300, 950], padOct: 12, arpOct: 24, arpRate: 4,
    lead: false, drums: 'none', hats: false, bassMul: 0.55, delayBeats: 1.5,
    level: 1.75,        // ambient is meant to sit lower, but not fall out of the mix
  },

  /* Tunnels and trunk roads: lower, tighter, less melody. */
  inter: {
    id: '103.2', name: 'INTERSTATE', style: 'dark electronic',
    bpm: [94, 114],
    progressions: [
      [[0, 'min'], [1, 'maj'], [0, 'min'], [-2, 'maj']],
      [[0, 'min7'], [-2, 'maj'], [-4, 'maj7'], [-2, 'maj']],
      [[0, 'min'], [0, 'min'], [1, 'maj'], [-4, 'maj7']],
      [[0, 'min'], [-2, 'maj'], [1, 'maj'], [0, 'min']],
      [[0, 'min7'], [1, 'maj'], [-4, 'maj7'], [1, 'maj']],
    ],
    padCut: [260, 1150], padOct: 12, arpOct: 12, arpRate: 2,
    lead: false, drums: 'tight', hats: true, bassMul: 1.35, delayBeats: 0.5,
    level: 0.78,        // the loudest of the four; pulled back to match
  },

  /* The one that only turns up occasionally, and doesn't quite fit. */
  ghost: {
    id: '???', name: 'UNLISTED', style: 'unknown',
    bpm: [56, 68],
    progressions: [
      [[0, 'maj7'], [2, 'maj7'], [4, 'maj7'], [2, 'maj7']],
      [[0, 'sus4'], [5, 'sus4'], [-2, 'sus4'], [3, 'sus4']],
    ],
    padCut: [220, 760], padOct: 12, arpOct: 24, arpRate: 4,
    lead: true, drums: 'none', hats: false, bassMul: 0.35, delayBeats: 1.5,
    level: 1.4,
  },
};

/**
 * Which station suits where you are. Deliberately not a hard mapping — the
 * odd one has to be able to turn up anywhere, or it stops being a surprise.
 */
export function stationFor(ctx, rnd = Math.random) {
  if (rnd() < 0.06) return 'ghost';
  if (ctx.remote > 0.5) return 'after';
  switch (ctx.biome) {
    case 'CITY': return 'night';
    case 'TUNNEL': return 'inter';
    case 'HIGHWAY': return rnd() < 0.35 ? 'after' : 'inter';
    case 'FOREST': return 'after';
    case 'BRIDGE': return rnd() < 0.5 ? 'night' : 'inter';
    case 'COAST': return rnd() < 0.7 ? 'after' : 'night';
    default: return 'night';
  }
}

/** Arrangement within a station: same chords, different amount of band. */
export const SECTIONS = [
  { name: 'full', weight: 0.52, drums: 1, arp: 1, lead: 1, pad: 1 },
  { name: 'stripped', weight: 0.24, drums: 0, arp: 1, lead: 0, pad: 1 },
  { name: 'swell', weight: 0.12, drums: 0, arp: 0, lead: 0, pad: 1.25 },
  { name: 'drive', weight: 0.12, drums: 1, arp: 1, lead: 1, pad: 0.55 },
];

export function pickSection(rnd = Math.random) {
  let r = rnd();
  for (const s of SECTIONS) {
    r -= s.weight;
    if (r <= 0) return s;
  }
  return SECTIONS[0];
}
