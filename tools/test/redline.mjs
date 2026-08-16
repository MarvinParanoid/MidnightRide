/**
 * The arcade scoring, argued with directly.
 *
 * No browser and no renderer: the scoring takes numbers and returns numbers, so
 * a run can be played out here in a millisecond. That matters more than it
 * sounds. The question this half of the project exists to answer is whether the
 * reward curve is any good, and a curve you can only feel through a browser at
 * thirty frames a second is a curve you will argue about rather than measure.
 */
import { Scoring, BANDS } from '../../src/redline/scoring.js';

/** A car going past, as the proximity reading would describe it. */
function pass(scoring, { closest, speed = 60, frames = 13 }) {
  const car = { id: Math.random() };
  /* An odd number of frames, so one of them lands exactly on the closest point.
     With an even count the dip straddles the middle and never reaches it — the
     first run of this asked for thirty centimetres, delivered fifty, and read
     as the scoring putting passes in the wrong band. */
  const half = (frames - 1) / 2;
  for (let i = 0; i < frames; i++) {
    const t = Math.abs(i - half) / half;
    scoring.update(1 / 60, speed, { nearest: car, clearance: closest + t * 2.2, closing: 8 });
  }
  /* and then they are behind you, which is what ends the pass */
  return [...scoring.update(1 / 60, speed, { nearest: null, clearance: Infinity, closing: 0 })];
}

export async function run() {
  const results = [];
  const add = (name, ok, detail) => results.push({ name, pass: ok, detail });

  /* Each band, once, at the same speed. */
  const s = new Scoring();
  const named = [];
  for (const clear of [1.6, 1.0, 0.6, 0.3, 0.1]) {
    const ev = pass(s, { closest: clear }).filter((e) => e.kind === 'pass');
    named.push(`${clear}m→${ev.length ? ev[0].band : 'nothing'}`);
  }
  add('each band of clearance is called what it should be',
    named.join(' ') === '1.6m→nothing 1m→CLOSE 0.6m→NEAR MISS 0.3m→THREAD 0.1m→NO WAY',
    named.join('  '));

  /* The same gap, at two speeds. */
  const slow = new Scoring(); pass(slow, { closest: 0.3, speed: 22 });
  const fast = new Scoring(); pass(fast, { closest: 0.3, speed: 69 });
  const ratio = fast.score / slow.score;
  add('the same gap is worth more the faster you take it',
    ratio > 1.7 && ratio < 2.4,
    `thirty centimetres at 80 km/h scores ${slow.score.toFixed(1)}, at 250 it scores `
      + `${fast.score.toFixed(1)} — ${ratio.toFixed(2)} times`);

  /* A run of passes should build, and a gap in play should let it go. */
  const c = new Scoring();
  for (let i = 0; i < 5; i++) pass(c, { closest: 0.4 });
  const built = c.combo;
  for (let i = 0; i < 60 * 5; i++) c.update(1 / 60, 60, { nearest: null, clearance: Infinity, closing: 0 });
  add('the combo builds on a run and lets go when nothing happens',
    built === 5 && c.combo === 0,
    `five passes reached ${built}; five quiet seconds took it to ${c.combo}`);

  /* Speed alone holds the meter around the middle: not punished, not rewarded. */
  const m = new Scoring();
  for (let i = 0; i < 60 * 20; i++) m.update(1 / 60, 56, { nearest: null, clearance: Infinity, closing: 0 });
  const cruising = m.meter;
  for (let i = 0; i < 6; i++) pass(m, { closest: 0.25, speed: 56 });
  add('speed holds the meter at half and danger takes it to the top',
    cruising > 0.4 && cruising < 0.75 && m.meter > 0.9,
    `twenty seconds of empty road at 200 km/h sits at ${cruising.toFixed(2)}; `
      + `six threaded gaps take it to ${m.meter.toFixed(2)}`);

  /* And backing off costs it, without any rule that says so. */
  const d = new Scoring();
  for (let i = 0; i < 60 * 20; i++) d.update(1 / 60, 56, { nearest: null, clearance: Infinity, closing: 0 });
  const before = d.meter;
  for (let i = 0; i < 60 * 12; i++) d.update(1 / 60, 18, { nearest: null, clearance: Infinity, closing: 0 });
  add('slowing down costs the meter without being punished for it',
    d.meter < before - 0.25,
    `${before.toFixed(2)} at 200 km/h, ${d.meter.toFixed(2)} after twelve seconds at 65`);

  /* A pass is judged at its closest point, not at the first frame of it. */
  const j = new Scoring();
  const ev = pass(j, { closest: 0.15, frames: 41 });
  add('a pass is judged by the closest the two ever came',
    ev.some((e) => e.kind === 'pass' && e.band === 'NO WAY'),
    ev.filter((e) => e.kind === 'pass').map((e) => `${e.band} at ${e.clearance.toFixed(2)}m`).join(', ')
      || 'no pass was scored at all');

  add('there are bands to score against', BANDS.length === 4, `${BANDS.length} bands`);
  return results;
}
