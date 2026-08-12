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

/* Intervals a lead can reach for over any of these chords without going sour. */
const LEAD_IVS = [0, 3, 5, 7, 10, 12, 14, 15, 19];

/**
 * A fresh arpeggio figure per section, rather than the one eight-note sequence
 * the whole soundtrack used to share. Rests matter as much as notes: the old
 * pattern never stopped, and relentless is the fastest way to wear a listener
 * out over an hour.
 */
export function makeArp(rnd = Math.random) {
  const len = [8, 12, 16][(rnd() * 3) | 0];
  const pat = [];
  let deg = 0;
  for (let i = 0; i < len; i++) {
    if (rnd() < 0.2) { pat.push(null); continue; }          // a hole in the figure
    deg = rnd() < 0.55 ? (deg + 1) % 4 : (rnd() * 4) | 0;   // mostly stepwise
    pat.push({ deg, oct: rnd() < 0.16 ? 12 : 0 });
  }
  return pat;
}

/** A phrase of three to six notes with its own rhythm, not a fixed motif. */
export function makeLead(rnd = Math.random) {
  const n = 3 + ((rnd() * 4) | 0);
  const out = [];
  let at = (rnd() * 2) | 0;
  for (let i = 0; i < n; i++) {
    out.push({ at, iv: LEAD_IVS[(rnd() * LEAD_IVS.length) | 0] });
    at += 2 + ((rnd() * 5) | 0);
    if (at > 15) break;
  }
  return out;
}

/** Same chord, different spacing — rotate some notes up an octave. */
export function voice(notes, rnd = Math.random) {
  const rot = (rnd() * notes.length) | 0;
  const lift = rnd() < 0.3 ? 12 : 0;
  return notes.map((n, i) => (i < rot ? n + 12 : n) + lift);
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
    padCut: [260, 1150], padOct: 0, arpOct: 12, arpRate: 2,
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
    padCut: [220, 760], padOct: 12, arpOct: 36, arpRate: 4,
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
