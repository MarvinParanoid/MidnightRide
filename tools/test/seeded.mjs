/**
 * A seed is a promise: the same night, whoever rides it and on whatever machine.
 *
 * Two halves, and this checks both.
 *
 * Every rare event used to be a countdown in seconds, so the train arrived four
 * minutes in. That is frame-rate independent — the steps sum to the same
 * elapsed time however finely they are chopped — and it is not independent of
 * anything else: four minutes is kilometre eight for someone dawdling and
 * kilometre fourteen for someone pressing on, so two people on the same seed
 * did not share a night at all. Both are checked below, and it was the second
 * that was broken; asserting only the first would have passed against the old
 * code and proved nothing.
 *
 * And a seed names a night, not a road. `?seed=` is deliberately not wired to
 * the centreline: the road's permanence is what makes "kilometre 4,182" mean
 * anything to anyone. So two seeds must differ in weather and in what happens,
 * and must not differ in where the road goes.
 *
 * Nothing here renders. The property under test is where the scheduler puts
 * things, and driving the real Events object over a synthetic ride reaches it
 * in a second where twenty thousand rendered frames would take a quarter of an
 * hour and answer the same question.
 */
import { launch, session } from './session.mjs';

/**
 * Drive the real event scheduler down the real road at a given timestep, and
 * write down what happened and where.
 */
const RIDE = `(dt, metres, speed) => {
  const m = window.__mr;
  const ev = new (m.events.constructor)(m.scene, m.road);
  window.__lastRide = ev;
  const st = { s: 0, v: speed, lat: 1.9, now: 0, remote: 0, rain: 0.4, biome: 'HIGHWAY', audio: null };
  const seen = [];
  const was = { train: false, rider: false, plane: false, works: false, broken: false, storm: false };
  while (st.s < metres) {
    st.s += st.v * dt;
    st.now += dt;
    st.biome = m.road.biomeAt(st.s);
    st.remote = m.road.remotenessAt(st.s);
    ev.update(dt, st);
    for (const k in was) {
      const on = k === 'plane' ? ev.plane.t >= 0 : ev[k].active;
      if (on && !was[k]) seen.push(k + '@' + (st.s / 1000).toFixed(1));
      was[k] = on;
    }
  }
  return seen;
}`;

/* The slot kilometres the scheduler laid down, in order, as one string. */
const RIDE_SLOTS = `() => {
  const ev = window.__lastRide;
  return ['plane', 'train', 'rider', 'storm', 'works', 'broken']
    .map((k) => k + ':' + (ev[k].slots || []).join(','))
    .join(' ');
}`;

async function ride(page, dt, speed = 34, metres = 60000) {
  return page.evaluate(`(${RIDE})(${dt}, ${metres}, ${speed})`);
}

async function open(browser, seed) {
  const { page, errors } = await session(browser, { tier: 'low', query: `seed=${seed}` });
  return { page, errors };
}

export async function run() {
  const browser = await launch();
  const results = [];
  try {
    const a = await open(browser, 74291);

    /* One seed, three timesteps: a slow machine, a fast one, and the fixed
       rhythm the recorder uses. */
    const logs = [];
    for (const fps of [12, 30, 60]) logs.push(await ride(a.page, 1 / fps));
    const same = logs.every((l) => l.join(' ') === logs[0].join(' '));
    results.push({
      name: 'one seed puts the same events at the same kilometres at any frame rate',
      pass: same,
      detail: same
        ? `${logs[0].length} events over 60 km, identical at 12, 30 and 60 fps`
        : [12, 30, 60].map((f, i) => `${f} fps: ${logs[i].join(' ') || '(none)'}`).join('\n        '),
    });

    /* And at any speed — but the assertion has to be the right one.
       What belongs to the seed is the timetable: the kilometres at which the
       night has something scheduled. Whether you are *present* for a given
       slot does not, and cannot: a rider who is still running alongside you
       when the next rider slot passes will not meet a second one, and how long
       he runs alongside is two moving bodies and your throttle. Making that
       positional too would mean deleting the encounter and leaving a marker.
       So: the timetable is the road's and is asserted exactly; presence is the
       ride's and is reported rather than required. */
    const timetable = (page) => page.evaluate(`(${RIDE_SLOTS})()`);
    const tables = [];
    for (const v of [20, 34, 50]) {
      await ride(a.page, 1 / 30, v);
      tables.push(await timetable(a.page));
    }
    /* One list must be the beginning of the other. The timetable is laid down
       lazily — the next slot is placed when the current one is done with — so a
       rider still mid-encounter at the finish has simply not been handed his
       next kilometre yet. What must never happen is the two disagreeing about a
       kilometre they have both reached. */
    const parse = (t) => Object.fromEntries(t.split(' ').map((p) => {
      const [k, v] = p.split(':');
      return [k, v ? v.split(',').filter(Boolean) : []];
    }));
    const prefix = (a, b) => a.every((v, i) => i >= b.length || v === b[i]);
    const first = parse(tables[0]);
    const steady = tables.every((t) => {
      const o = parse(t);
      return Object.keys(first).every((k) => prefix(first[k], o[k]) && prefix(o[k], first[k]));
    });
    results.push({
      name: 'the timetable belongs to the road, not to how fast you took it',
      pass: steady,
      detail: steady
        ? `same kilometres at 72, 122 and 180 km/h — ${tables[0].split(' ')[2]}`
        : [20, 34, 50].map((v, i) => `${(v * 3.6) | 0} km/h: ${tables[i].slice(0, 90)}`).join('\n        '),
    });

    const weatherA = await a.page.evaluate(() => window.__mr.weather.name);
    const bendA = await a.page.evaluate(() => {
      let b = 0;
      for (let s = 0; s < 60000; s += 250) b += Math.abs(window.__mr.road.poseAt(s).h);
      return +b.toFixed(6);
    });
    await a.page.close();

    /* A different seed is a different night... */
    const b = await open(browser, 5150);
    const other = await ride(b.page, 1 / 30, 34);
    const weatherB = await b.page.evaluate(() => window.__mr.weather.name);
    const bendB = await b.page.evaluate(() => {
      let x = 0;
      for (let s = 0; s < 60000; s += 250) x += Math.abs(window.__mr.road.poseAt(s).h);
      return +x.toFixed(6);
    });
    await b.page.close();

    const differs = other.join(' ') !== logs[1].join(' ');
    results.push({
      name: 'a different seed is a different night',
      pass: differs,
      detail: differs
        ? `74291 gave ${logs[1].length} events and ${weatherA}; 5150 gave ${other.length} and ${weatherB}`
        : 'both seeds produced the same events, so the seed is not reaching them',
    });

    /* ...over the same road. */
    const sameRoad = Math.abs(bendA - bendB) < 1e-6;
    results.push({
      name: 'and the same road under it',
      pass: sameRoad,
      detail: sameRoad ? `the centreline bends by ${bendA} on either seed`
        : `the road moved: ${bendA} against ${bendB}`,
    });

    const errs = [...a.errors, ...b.errors];
    results.push({ name: 'no page errors', pass: errs.length === 0, detail: errs[0] || '' });
  } finally {
    await browser.close();
  }
  return results;
}
