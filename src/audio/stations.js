/**
 * Four stations, each with its own harmony, tempo and instrumentation.
 *
 * The old engine had one key, one four-chord loop and one drum pattern. That
 * holds for half an hour and not for five, which is the length that matters now
 * the game is also a channel. Chords are written as semitone offsets from
 * whatever the current key is, so the whole thing transposes for free.
 */
import { mulberry32 } from '../geo.js';

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

/**
 * Euclidean rhythm — Bjorklund's algorithm, in the closed form.
 *
 * Spread `pulses` hits as evenly as possible over `steps` cells. This is not a
 * curiosity: E(3,8) is the tresillo, E(5,8) the cinquillo, E(2,5) the habanera
 * cell. Two integers give a whole family of rhythms that already sound like
 * rhythms, which a list of hand-written patterns never covers.
 */
export function euclid(pulses, steps, rotate = 0) {
  const out = [];
  if (pulses <= 0 || steps <= 0) return out;
  for (let i = 0; i < steps; i++) {
    if ((i * pulses) % steps < pulses) out.push((i + rotate) % steps);
  }
  return out.sort((a, b) => a - b);
}

/**
 * Draw without replacement.
 *
 * Picking from four progressions with Math.random repeats the one you just
 * heard a quarter of the time, and can leave one of them unheard for minutes.
 * A shuffled pile plays all of them before any comes round again, and refuses
 * to start a new pile with the card it just finished on.
 */
export class Deck {
  constructor(items, rnd = Math.random) {
    this.items = items;
    this.rnd = rnd;
    this.pile = [];
    this.last = null;
  }

  draw() {
    if (!this.pile.length) this.refill();
    this.last = this.pile.pop();
    return this.last;
  }

  refill() {
    const p = this.items.slice();
    for (let i = p.length - 1; i > 0; i--) {
      const j = (this.rnd() * (i + 1)) | 0;
      [p[i], p[j]] = [p[j], p[i]];
    }
    /* A weighted pile holds duplicates — thirteen 'full' cards in twenty-five —
       so a plain shuffle leaves them clumped and repeats *more* than a dice roll
       does. Measured: 32% back-to-back against the dice's 25%. Push adjacent
       duplicates apart before dealing. */
    for (let i = 0; i + 1 < p.length; i++) {
      if (p[i] !== p[i + 1]) continue;
      for (let k = 0; k < 8; k++) {
        const j = 1 + ((this.rnd() * (p.length - 1)) | 0);
        if (p[j] === p[i] || p[j] === p[j - 1] || (j + 1 < p.length && p[j] === p[j + 1])) continue;
        [p[i + 1], p[j]] = [p[j], p[i + 1]];
        break;
      }
    }
    // the top of the pile is drawn last, so guard the *end* against the last card
    if (p.length > 1 && p[p.length - 1] === this.last) [p[0], p[p.length - 1]] = [p[p.length - 1], p[0]];
    this.pile = p;
  }
}

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
  /* The length must come out to a whole number of bars at *either* arp rate —
     the rate halves at speed, so only multiples of eight cells stay put. A
     twelve-cell figure repeats every bar and a half and its accents drift
     against the chords, which is heard as something being wrong.
     Within that rule the span can still be three or five bars instead of one,
     which is what stops the figure lining up with everything else. */
  const len = 8 * [1, 1, 2, 2, 3, 5][(rnd() * 6) | 0];
  const pat = [];
  /* A rung on the chord, not a scale degree — the player turns it into a pitch
     by climbing past the top of the chord into the next octave, the way an
     arpeggiator does. The old version walked 0..3 and the player took it modulo
     the chord size, so on any three-note chord a step from 3 to 0 was a step
     onto the same pitch: measured, fourteen per cent of neighbouring notes came
     out identical, heard as a note stuttering rather than a figure moving.
     Four rungs is injective for every chord size in use, so it cannot happen.
     Five would be too — and would reach the ninth of a min9 — but it sends the
     figure an octave up two rungs in five on a triad, which measured as a median
     of D5 and a p90 near a kilohertz. That is the register that reads as shrill.
     The ninth is still in the pad; the arp does without it. */
  let rung = 0;
  for (let i = 0; i < len; i++) {
    if (rnd() < 0.16 || (i % 4 === 0 && rnd() < 0.12)) { pat.push(null); continue; }
    rung += rnd() < 0.5 ? 1 : (rnd() < 0.5 ? 2 : -1);
    rung = ((rung % 4) + 4) % 4;
    pat.push({
      rung,
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
  /* A whole number of bars, and deliberately often not one — a one-bar bass
     figure heard eight times per section is the loop you learn first. */
  const bars = [1, 2, 3, 4][(rnd() * 4) | 0];
  const steps = 16 * bars;
  const pulses = Math.max(2, Math.round(steps * (0.14 + rnd() * 0.16)));
  const at = euclid(pulses, steps, 0);
  if (!at.includes(0)) at.unshift(0);
  return {
    bars,
    notes: at.map((st) => ({
      s: st,
      // the fifth or the octave now and then, so a long figure keeps moving;
      // never on a downbeat, which is what tells you what the chord is
      off: st % 16 === 0 ? 0 : rnd() < 0.18 ? 7 : rnd() < 0.12 ? 12 : 0,
      dur: st % 16 === 0 ? 0.5 : 0.28,
    })),
  };
}

/**
 * A kit pattern for the section. Same idea: one fixed bar of kick and snare is
 * the first thing an hour-long loop gives away.
 */
export function makeDrums(kind, rnd = Math.random) {
  const tight = kind === 'tight';
  /* One to three bars. The snare is laid down per bar, so the backbeat lands
     where it always did; it is the kick and the hats that stop repeating every
     four seconds. Spans that are coprime with the bass figure's are the point:
     two against three takes six bars to come back round. */
  const bars = [1, 2, 2, 3][(rnd() * 4) | 0];
  const steps = 16 * bars;

  const kick = new Set([0]);                       // the downbeat is not negotiable
  for (let b = 0; b < bars; b++) {
    const o = b * 16;
    kick.add(o + (tight && rnd() < 0.35 ? 10 : 8));
    if (rnd() < (tight ? 0.55 : 0.3)) kick.add(o + (rnd() < 0.5 ? 3 : 6));
    if (tight && rnd() < 0.3) kick.add(o + 11);
  }

  const snare = new Set();                         // backbeat stays put
  for (let b = 0; b < bars; b++) {
    const o = b * 16;
    snare.add(o + 4).add(o + 12);
    if (tight) snare.add(o + 14);
    if (rnd() < 0.25) snare.add(o + (rnd() < 0.5 ? 7 : 15));
  }

  /* Hats are where a Euclidean spread earns its keep: straight eighths, or an
     uneven distribution that still resolves onto the bar. */
  const hat = rnd() < 0.45
    ? Array.from({ length: steps / 2 }, (_, i) => i * 2)
    : euclid(Math.round(steps * (0.45 + rnd() * 0.3)), steps, 0);

  return { bars, kick: [...kick], snare: [...snare], hat };
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

/* The weights as a pile of cards rather than a dice roll: the same long-run
   distribution, but 'full' cannot come up five times running and 'swell'
   cannot go missing for ten minutes. */
const SECTION_PILE = SECTIONS.flatMap((x) => Array(Math.round(x.weight * 25)).fill(x));
const sectionDeck = new Deck(SECTION_PILE);

export function pickSection() {
  return sectionDeck.draw();
}

/* ────────────────────────────────────────────────────────────
   Station signatures

   The generators above give a station endless material, and endless material
   with nothing recurring is the one thing worse than a four-bar loop: there is
   nothing to recognise. The earliest version of this soundtrack had one
   progression, one arpeggio and one drum pattern, and it was memorable for
   exactly that reason — you could hum it.

   So each station keeps a fixed figure of its own, seeded from its name so it
   is the same figure every session, the way a real station has an ident. Most
   sections restate it; the rest play something derived from it. Variety now
   happens *around* a hook instead of instead of one.
   ──────────────────────────────────────────────────────────── */

const hash = (str) => {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
};

const signatures = new Map();

/** The figure this station is known by. Same one every time. */
export function signature(id) {
  let sig = signatures.get(id);
  if (!sig) {
    const st = STATIONS[id];
    const rnd = mulberry32(hash(id));
    sig = {
      arp: makeArp(rnd),
      bass: makeBass(rnd),
      drums: makeDrums(st.drums, rnd),
      progression: st.progressions[(rnd() * st.progressions.length) | 0],
    };
    signatures.set(id, sig);
  }
  return sig;
}

/**
 * A variation, not a replacement. The rhythm of the figure survives; a few of
 * its notes move by a step, a few rests open or close. Far enough to be a
 * different bar, near enough that you can still hear which tune it is.
 */
export function varyArp(pat, rnd = Math.random) {
  /* Whatever this does, it may not put the same pitch on two sounding cells in
     a row — that is the stutter that made the radio sound broken, and moving a
     rung without looking at its neighbour brought it straight back at 17%.
     Rungs 0..3 map one-to-one onto pitches for every chord size in use, so
     keeping the rung different from the last one sounded is enough. */
  let prev = null;
  return pat.map((c, i) => {
    const emit = (rung, vel) => {
      let r = rung % 4;
      if (r === prev) r = (r + 1 + ((rnd() * 3) | 0)) % 4;
      prev = r;
      return { rung: r, vel };
    };
    if (!c) return rnd() < 0.22 ? emit(i % 4, 0.55 + rnd() * 0.2) : null;
    if (rnd() < 0.16) return null;                       // open a rest instead
    if (rnd() < 0.24) return emit(c.rung + (rnd() < 0.5 ? 1 : 3), c.vel);
    return emit(c.rung, c.vel);
  });
}

/** Same hits, different colour: the octaves and fifths move, the rhythm does not. */
export function varyBass(fig, rnd = Math.random) {
  return {
    bars: fig.bars,
    notes: fig.notes.map((n) => (n.s % 16 === 0 || rnd() > 0.3
      ? n
      : { ...n, off: rnd() < 0.5 ? 7 : 12 })),
  };
}

/** The kick stays where it was; the hats and the odd extra snare move. */
export function varyDrums(d, kind, rnd = Math.random) {
  const fresh = makeDrums(kind, rnd);
  return { bars: d.bars, kick: d.kick, snare: d.snare, hat: fresh.bars === d.bars ? fresh.hat : d.hat };
}
