/**
 * The music generators are pure functions, so they need no browser and run in
 * milliseconds. Every assertion here is a bug that shipped and was reported by
 * ear before it was found by measurement:
 *
 *   - an arp figure whose length did not divide into the bar, so its accents
 *     drifted against the chords ("странно звучит")
 *   - a degree walk taken modulo a three-note chord, so one pair of notes in
 *     seven was the same pitch twice ("как будто две ноты подряд")
 *   - a weighted deck that clumped worse than the dice it replaced
 *   - a bass figure that never changed for the length of a session
 */
import {
  makeArp, makeBass, makeDrums, makeLead, euclid, pickSection, SECTIONS, STATIONS, chordNotes,
} from '../../src/audio/stations.js';

const N = 4000;
const CHORDS = { min: 3, maj: 3, sus4: 3, min7: 4, maj7: 4, maj6: 4, min9: 5 };

export async function run() {
  const r = [];
  const push = (name, pass, detail) => r.push({ name, pass, detail });

  /* Euclidean rhythms against patterns with names. */
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  push('euclid(3,8) is the tresillo', eq(euclid(3, 8), [0, 3, 6]), JSON.stringify(euclid(3, 8)));
  push('euclid(5,8) is the cinquillo', eq(euclid(5, 8), [0, 2, 4, 5, 7]), JSON.stringify(euclid(5, 8)));
  push('euclid(2,5) is the habanera cell', eq(euclid(2, 5), [0, 3]), JSON.stringify(euclid(2, 5)));

  /* Arp: whole bars at either rate, and never the same pitch twice running. */
  let badLen = 0, dupes = 0, pairs = 0, spanSet = new Set();
  for (let i = 0; i < N; i++) {
    const pat = makeArp();
    if (pat.length % 8) badLen++;               // 8 cells/bar at one rate, 4 at the other
    spanSet.add(pat.length / 8);
    const cells = pat.filter(Boolean);
    for (const [type, li] of Object.entries(CHORDS)) {
      const notes = chordNotes(48, type);
      for (let k = 1; k < cells.length; k++) {
        const f = (c) => notes[c.rung % li] + 12 * Math.floor(c.rung / li);
        pairs++;
        if (f(cells[k]) === f(cells[k - 1])) dupes++;
      }
    }
  }
  push('arp figures span a whole number of bars', badLen === 0, `${badLen}/${N} bad`);
  push('arp never repeats a pitch back to back', dupes === 0, `${dupes} of ${pairs} pairs`);
  push('arp spans vary beyond one and two bars', spanSet.size >= 3, `spans ${[...spanSet].sort().join(', ')}`);

  /* Bass and drums regenerate, and keep the parts of the bar that anchor it. */
  const bassSet = new Set(), kitSet = new Set();
  let noDownbeat = 0, noBackbeat = 0, emptyHats = 0, bassOffRoot = 0;
  for (let i = 0; i < N; i++) {
    const b = makeBass();
    bassSet.add(b.bars + '|' + b.notes.map((x) => x.s + ':' + x.off).join(','));
    if (b.notes[0].s !== 0 || b.notes[0].off !== 0) bassOffRoot++;
    const d = makeDrums(i % 2 ? 'tight' : 'four');
    kitSet.add(d.bars + '|' + d.kick + '|' + d.snare + '|' + d.hat);
    if (!d.kick.includes(0)) noDownbeat++;
    if (!d.snare.includes(4)) noBackbeat++;
    if (!d.hat.length) emptyHats++;
  }
  push('bass figures are not one repeated shape', bassSet.size > 500, `${bassSet.size} distinct in ${N}`);
  push('bass states the root on the downbeat', bassOffRoot === 0, `${bassOffRoot} bad`);
  push('kits are not one repeated pattern', kitSet.size > 500, `${kitSet.size} distinct in ${N}`);
  push('every kit keeps the downbeat', noDownbeat === 0, `${noDownbeat} bad`);
  push('every kit keeps the backbeat', noBackbeat === 0, `${noBackbeat} bad`);
  push('no kit is left without hats', emptyHats === 0, `${emptyHats} bad`);

  /* Lead phrases stay inside the bar. */
  let leadOverrun = 0;
  for (let i = 0; i < N; i++) if (makeLead().some((x) => x.at > 15)) leadOverrun++;
  push('lead phrases stay inside the bar', leadOverrun === 0, `${leadOverrun} bad`);

  /* The section deck: same long-run mix as the weights, fewer clumps than dice. */
  const counts = {};
  let deckRepeat = 0, last = null;
  for (let i = 0; i < 20000; i++) {
    const s = pickSection();
    counts[s.name] = (counts[s.name] || 0) + 1;
    if (s.name === last) deckRepeat++;
    last = s.name;
  }
  let diceRepeat = 0; last = null;
  const roll = () => { let x = Math.random(); for (const s of SECTIONS) { x -= s.weight; if (x <= 0) return s; } return SECTIONS[0]; };
  for (let i = 0; i < 20000; i++) { const n = roll().name; if (n === last) diceRepeat++; last = n; }
  const drift = Math.max(...SECTIONS.map((s) => Math.abs(counts[s.name] / 20000 - s.weight)));
  push('section mix matches the weights', drift < 0.02, `worst drift ${(100 * drift).toFixed(1)}%`);
  push('the deck clumps less than a dice roll', deckRepeat < diceRepeat,
    `${(deckRepeat / 200).toFixed(1)}% vs ${(diceRepeat / 200).toFixed(1)}%`);

  /* Stations have to differ, or the dial is decoration. */
  const ids = Object.keys(STATIONS);
  const bpms = new Set(ids.map((k) => STATIONS[k].bpm.join('-')));
  const progs = ids.reduce((a, k) => a + STATIONS[k].progressions.length, 0);
  push('stations have distinct tempo ranges', bpms.size === ids.length, [...bpms].join(' '));
  push('there are progressions to draw from', progs >= 15, `${progs} across ${ids.length} stations`);

  return r;
}
