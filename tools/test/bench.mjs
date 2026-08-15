/**
 * The bench: one fixed drive, measured on the real graphics card.
 *
 * Everything else in tools/test answers "is it still correct". This answers
 * "what does it cost", which until now could not be answered at all from here:
 * the suite renders on SwiftShader, where filling a pixel costs whatever the
 * CPU charges and a change that halves the fill rate can measure as a
 * slowdown. Headless Chrome will use the actual card if asked (`--use-angle=
 * vulkan`), and the timer query works there, so the number is real.
 *
 * What it does NOT do is replace the golden frames. Those depend on every
 * machine drawing identical bytes, which is exactly what a real GPU refuses to
 * do. Correctness on the software renderer, cost on the hardware one.
 *
 *   node tools/test/bench.mjs                 all scenes, all three profiles
 *   node tools/test/bench.mjs --tier high     one profile
 *   node tools/test/bench.mjs --knobs         what each quality setting costs
 *   node tools/test/bench.mjs --sweep ssr     march length against coverage
 *   node tools/test/bench.mjs --soft          on SwiftShader, for comparison
 *   node tools/test/bench.mjs --shots         write a frame per scene
 *
 * Results go to tests/bench/latest.json, and a run prints the delta against
 * whatever is already there — so the question "did that change cost anything"
 * has an answer before the change is committed rather than after it ships.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { launch, session, settle, steps, freeze } from './session.mjs';

const DIR = 'tests/bench';

/* The scenes are chosen for what they stress, not for what they look like.
   Between them they cover: a hundred lit windows and neon at once, a tunnel
   with its ceiling reflecting, a wet road with the reflection pass at full
   stretch, a dry road where it should be standing down entirely, and an empty
   one where nothing but the post chain is left to pay for. */
const SCENES = [
  { name: 'city-wet', at: 640, rain: 1, note: 'windows, neon, wet tarmac' },
  { name: 'city-dry', at: 640, rain: 0, note: 'the same frame with no reflections to compute' },
  { name: 'tunnel', at: 34180, rain: 1, note: 'enclosed, sodium, ceiling above the camera' },
  { name: 'bridge', at: 12000, rain: 1, note: 'long unobstructed sightlines' },
  { name: 'coast', at: 3100, rain: 0.6, note: 'water, parapet, a long way to the horizon' },
  { name: 'remote', at: 22960, rain: 0, note: 'nothing but road and the post chain' },
];

const FRAMES = 90;        // after warm-up; enough for a p90 that means something

const arg = (flag, fallback = null) => {
  const i = process.argv.indexOf(flag);
  return i < 0 ? fallback : (process.argv[i + 1] ?? true);
};
const has = (flag) => process.argv.includes(flag);

/**
 * Stop the quality guard from moving the thing being measured.
 *
 * It watches the frame rate and steps the profile down after four bad seconds,
 * which is exactly what it should do to a player and exactly what it must not
 * do to a benchmark: the first sweep of the march length showed coverage
 * climbing to thirty-four per cent and then collapsing to half a per cent at a
 * longer march, because the longer march made the frames slow enough that the
 * guard demoted the profile and reset the very uniform under test.
 */
async function pinGuard(page) {
  await page.evaluate(() => { window.__mr.guard.update = () => {}; });
}

/**
 * Run the loop and come back with the distribution.
 *
 * A first pass read the smoothed figure once at the end and got numbers that
 * bounced between fourteen and twenty milliseconds with no relation to the load
 * — the card idles down between bursts, and one reading cannot tell that from a
 * real change. Warm it up, then take every frame.
 */
async function sample(page, n, warm = 40) {
  await steps(page, warm);                   // clocks up, history converged
  const frames = await page.evaluate(async (k) => {
    const m = window.__mr, out = [];
    for (let i = 0; i < k; i++) {
      const now = window.__realNow;
      const a = now();
      await m.record.next();
      out.push({ cpu: now() - a, gpu: m.gpu.last });
    }
    return out;
  }, n);
  const pick = (key) => frames.map((f) => f[key]).filter((v) => v > 0).sort((a, b) => a - b);
  const g = pick('gpu'), c = pick('cpu');
  const q = (a, p) => (a.length ? +a[Math.floor(a.length * p)].toFixed(2) : 0);
  /* Distinct readings, not the count of frames. A query resolves every few
     frames and the same figure is read until the next one lands, so ninety
     frames can carry three numbers — and a median over three numbers is worth
     saying out loud rather than printing as if it were a distribution. */
  return { gpuMs: q(g, 0.5), gpuP90: q(g, 0.9), cpuMs: q(c, 0.5), cpuP90: q(c, 0.9),
    reads: new Set(g).size };
}

/** Run one scene at one profile and come back with numbers. */
async function measure(page, scene) {
  await page.evaluate((r) => { window.__mr.state.rainOverride = r; }, scene.rain);
  await settle(page, scene.at, { frames: 60 });
  await page.evaluate(() => { window.__mr.gpu.forced = true; });
  await pinGuard(page);
  /* Two samples, because they answer different questions. Moving, for what the
     processor spends: chunks stream in, traffic thinks, geometry is built, and
     none of that happens on a held frame. Then held, for what the card spends:
     a moving world puts a different picture in front of the camera every frame,
     so two runs of the same scene are two different pictures and the numbers
     cannot be compared with each other, let alone with last week's. */
  const moving = await sample(page, FRAMES);
  await freeze(page);
  const held = await sample(page, FRAMES);
  const got = { gpuMs: held.gpuMs, gpuP90: held.gpuP90, reads: held.reads,
    cpuMs: moving.cpuMs, cpuP90: moving.cpuP90 };

  const rest = await page.evaluate(() => {
    const m = window.__mr, r = m.renderer, gl = r.getContext();
    return {
      calls: r.info.render.calls,
      tris: r.info.render.triangles,
      buffer: `${gl.drawingBufferWidth}x${gl.drawingBufferHeight}`,
      megapixels: +(gl.drawingBufferWidth * gl.drawingBufferHeight / 1e6).toFixed(2),
      coverage: m.ssr.enabled && m.ssr.material.uniforms.uWet.value > 0.01
        ? +(m.ssr.coverage(r) * 100).toFixed(1) : null,
      steps: m.ssr.material.uniforms.uSteps.value,
      msaa: m.composer.renderTarget1.samples,
      smaa: m.smaa.enabled,
      timer: m.gpu.supported,
      tier: m.guard.name,
    };
  });

  return { ...rest, ...got };
}

async function benchTiers(browser, tiers, shots) {
  const out = {};
  for (const tier of tiers) {
    const { page, errors } = await session(browser, { tier });
    for (const scene of SCENES) {
      const r = await measure(page, scene);
      out[`${tier}/${scene.name}`] = r;
      if (shots) writeFileSync(`${DIR}/${tier}-${scene.name}.png`,
        await page.screenshot({ encoding: 'binary' }));
      const cov = r.coverage === null ? '   —' : `${String(r.coverage).padStart(4)}%`;
      console.log(`  ${tier.padEnd(5)} ${scene.name.padEnd(9)} `
        + `gpu ${String(r.gpuMs).padStart(6)} ms   cpu p90 ${String(r.cpuP90).padStart(6)} ms   `
        + `${String(r.megapixels).padStart(4)} Mpx   ${String(r.calls).padStart(3)} calls   refl ${cov}`);
    }
    if (errors.length) console.log(`  ! ${tier}: ${errors[0]}`);
    await page.close();
  }
  return out;
}

/**
 * How far the march has to walk before the reflection stops being a scatter of
 * hits. The tier table carries a number for this and a comment claiming it was
 * measured; the algorithm has been rewritten twice since, so measure it again.
 */
async function sweepSsr(browser) {
  const { page } = await session(browser, { tier: 'high' });
  await page.evaluate(() => { window.__mr.state.rainOverride = 1; window.__mr.gpu.forced = true; });
  await pinGuard(page);
  console.log('\nssr march length — coverage is what it finds, ms is what it costs\n');
  const rows = [];
  for (const [name, at] of [['city 640 m', 640], ['coast 3.1 km', 3100]]) {
    /* Settle once per place, not once per step count. Teleporting between
       measurements re-rolls the traffic and re-streams the chunks, and the
       first sweep spent more variance on that than on the thing being swept. */
    await settle(page, at, { frames: 60 });
    /* Hold the world still. Sampling for ninety frames per step count means the
       bike covers a kilometre between the first row of the table and the last,
       and the second sweep measured the march at seven different places rather
       than at seven lengths — which is how a longer march came out finding less
       than a shorter one. */
    await freeze(page);
    console.log(`  ${name}`);
    console.log('    steps   coverage   gpu median   gpu p90');
    for (const n of [8, 12, 16, 22, 32, 48, 64]) {
      await page.evaluate((v) => { window.__mr.ssr.material.uniforms.uSteps.value = v; }, n);
      const got = await sample(page, 90);
      const cov = await page.evaluate(() =>
        +(window.__mr.ssr.coverage(window.__mr.renderer) * 100).toFixed(1));
      rows.push({ place: name, steps: n, coverage: cov, ...got });
      console.log(`    ${String(n).padStart(5)}   ${String(cov).padStart(7)}%   `
        + `${String(got.gpuMs).padStart(9)}   ${String(got.gpuP90).padStart(7)}   `
        + `${got.reads} readings`);
    }
  }
  await page.close();
  return rows;
}


/**
 * Price one knob, by asking the card the same question twice in a row.
 *
 * Comparing two runs of this file measured the same scene at 19.13 ms and then
 * at 12.17 — a forty per cent spread with nothing changed between them. That is
 * not measurement error to be averaged away, it is the graphics card changing
 * its clocks between one run and the next, and no number of frames inside a run
 * will see it. So stop comparing across runs. Alternate the two settings inside
 * one run, over and over, and take the ratio within each pair: whatever the card
 * was doing to its clocks that second, it was doing to both halves of the pair,
 * and it divides out.
 *
 * What comes back is therefore a ratio and not a time. "Turning this off makes
 * the frame 0.84 of what it was" survives being run tomorrow on a warm machine;
 * "the frame took 12.17 ms" does not.
 */
async function paired(page, apply, base, variant, { frames = 260 } = {}) {
  /* Alternate frame by frame, not sample by sample.
     Sampling one setting for a while and then the other left the card's clocks
     free to change in between, and they did: the same untouched profile
     measured 26.7 ms in one row of this table and 50.2 in another. Frame by
     frame there is no "in between" — whatever state the card is in, both
     settings are measured in it. A null comparison of a profile against itself
     is what says whether that worked, and it is the first row of the table. */
  await apply(page, base);
  await steps(page, 30);
  await apply(page, variant);
  await steps(page, 30);          // both shader sets compiled, both buffers sized

  const log = await page.evaluate(async (n) => {
    const m = window.__mr;
    m.gpu.log = [];
    for (let i = 0; i < n; i++) {
      m.gpu.nextTag = i % 2;
      window.__apply(i % 2);
      await m.record.next();
    }
    const out = m.gpu.log;
    m.gpu.log = null;
    return out;
  }, frames);

  const pull = (t) => log.filter((e) => e.tag === t && e.ms > 0)
    .map((e) => e.ms).sort((a, b) => a - b);
  const A = pull(0), B = pull(1);
  const med = (v) => (v.length ? v[Math.floor(v.length / 2)] : 0);
  const q = (v, p) => (v.length ? v[Math.floor((v.length - 1) * p)] : 0);
  const a = med(A), b = med(B);
  /* The spread quoted is the two medians' own uncertainty, taken from the
     quartiles of each side divided by the root of the count — not the spread of
     single frames, which is dominated by the card and says nothing about
     whether the two settings differ. */
  const err = (v) => (v.length ? (q(v, 0.75) - q(v, 0.25)) / 2 / Math.sqrt(v.length) : 0);
  const rel = a > 0 ? Math.hypot(err(A) / a, err(B) / a) : 0;
  return {
    reads: A.length + B.length,
    ratio: a > 0 ? +(b / a).toFixed(3) : 0,
    lo: a > 0 ? +(b / a - 2 * rel).toFixed(3) : 0,
    hi: a > 0 ? +(b / a + 2 * rel).toFixed(3) : 0,
    baseMs: +a.toFixed(2),
    variantMs: +b.toFixed(2),
  };
}

/* Every setting the quality ladder moves, one at a time, against an untouched
   high profile. This is the table the ladder should be rebuilt from: today it
   drops five of these at once and one of them — the bloom buffer — is known to
   make flicker worse, so it wants spending last rather than in the same breath
   as the others. */
const KNOBS = [
  /* The null row: the same profile against itself. It must come out at 1.00,
     and how far it strays is the smallest difference this rig can see. Any row
     below it is noise being read as a result — which is what the first version
     of this table did, reporting that switching the reflection pass off made
     the frame fifteen per cent slower. */
  { name: '(nothing changed)', over: {} },
  { name: 'pixels: 2.07 -> 1.0 Mpx', over: { maxPixels: 1.0e6 } },
  { name: 'pixels: 2.07 -> 0.5 Mpx', over: { maxPixels: 0.5e6 } },
  { name: 'msaa 2x -> off', over: { samples: 0 } },
  { name: 'bloom buffer 1.5 -> 0.5', over: { bloomScale: 0.5 } },
  { name: 'smaa off', over: { smaa: false } },
  { name: 'grade taps 5 -> 3', over: { gradeTaps: 3 } },
  { name: 'ssr 32 -> 12 steps', over: { ssrSteps: 12 } },
  { name: 'ssr off', over: { ssrSteps: 0 } },
  { name: 'ssr 32 -> 48 steps', over: { ssrSteps: 48 } },
];

async function priceKnobs(browser) {
  /* A window big enough for the pixel ceiling to mean something. At the suite's
     1152x648 the whole drawing buffer is 0.75 Mpx, under every cap in the
     table, so the one knob with the most leverage would have measured as doing
     nothing at all. */
  const { page, errors } = await session(browser, { tier: 'high', width: 1920, height: 1080 });
  await page.evaluate(() => { window.__mr.state.rainOverride = 1; window.__mr.gpu.forced = true; });
  await pinGuard(page);
  await settle(page, 640, { frames: 60 });
  await freeze(page);

  const apply = (p, over) => p.evaluate((o) => {
    const m = window.__mr;
    m.applyTier({ ...m.tiers[0], ...o });
  }, over);

  /* Installed once per knob so the switch inside the loop is a function call
     rather than a devtools round trip, which would cost more than the frame.
     And it switches the least it can. Re-applying the whole profile every frame
     rebuilds the composer's buffers every frame, which is work neither setting
     asks for and which swamped the cheap knobs — the row for a longer reflection
     march came out cheaper than a shorter one, which is not a thing that can
     happen. Structural settings still need the full apply; a uniform does not. */
  const STRUCTURAL = ['maxPixels', 'samples', 'bloomScale', 'pixelRatio', 'rain'];
  const install = (over) => page.evaluate(([o, structural]) => {
    const m = window.__mr;
    const heavy = Object.keys(o).some((k) => structural.includes(k));
    const cfg = [{ ...m.tiers[0] }, { ...m.tiers[0], ...o }];
    const light = (c) => {
      m.ssr.material.uniforms.uSteps.value = c.ssrSteps;
      m.ssr.enabled = c.ssrSteps > 0;
      m.smaa.enabled = !!c.smaa;
      const g = m.composer.passes.find((p) => p.material?.uniforms?.uTaps);
      if (g) g.material.uniforms.uTaps.value = c.gradeTaps;
    };
    let at = -1;
    window.__apply = (i) => {
      if (i === at) return;
      at = i;
      if (heavy) m.applyTier(cfg[i]); else light(cfg[i]);
    };
  }, [over, STRUCTURAL]);

  console.log('\nthe cost of each quality knob, city at 640 m, wet, 1920x1080');
  console.log('paired against an untouched high profile — a ratio below 1 is cheaper\n');
  console.log('  knob                        frame     spread        saves');
  const rows = [];
  for (const k of KNOBS) {
    await install(k.over);
    const r = await paired(page, apply, {}, k.over);
    rows.push({ ...k, ...r });
    const saved = r.baseMs - r.variantMs;
    console.log(`  ${k.name.padEnd(26)} x${r.ratio.toFixed(2)}   ${r.lo.toFixed(2)}-${r.hi.toFixed(2)}   `
      + `${saved >= 0 ? '' : '+'}${(-saved).toFixed(2)} ms of ${r.baseMs.toFixed(1)}   ${r.reads} reads`);
  }
  await page.evaluate(() => { const m = window.__mr; m.applyTier(m.tiers[0]); });
  if (errors.length) console.log(`  ! ${errors[0]}`);
  await page.close();
  return rows;
}

async function main() {
  mkdirSync(DIR, { recursive: true });
  const soft = has('--soft');
  const browser = await launch({ gpu: !soft });
  const started = Date.now();
  let result = {};
  try {
    const probe = await session(browser, { tier: 'low' });
    const card = await probe.page.evaluate(() => {
      const gl = window.__mr.renderer.getContext();
      const d = gl.getExtension('WEBGL_debug_renderer_info');
      return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    });
    await probe.page.close();
    console.log(`\n${card}\n`);
    if (/SwiftShader/.test(card) && !soft) {
      console.log('  ! asked for the card and got the software renderer;'
        + ' the timings below are worthless\n');
    }

    if (has('--knobs')) {
      result.knobs = await priceKnobs(browser);
    } else if (has('--sweep')) {
      result.sweep = await sweepSsr(browser);
    } else {
      const tiers = arg('--tier') ? [arg('--tier')] : ['high', 'mid', 'low'];
      result.scenes = await benchTiers(browser, tiers, has('--shots'));
    }
  } finally {
    await browser.close();
  }

  /* A benchmark nobody compares against is a benchmark nobody reads. */
  const file = `${DIR}/latest.json`;
  if (existsSync(file) && result.scenes) {
    const prev = JSON.parse(readFileSync(file, 'utf8'));
    const deltas = [];
    for (const k of Object.keys(result.scenes)) {
      const a = prev.scenes?.[k], b = result.scenes[k];
      if (!a) continue;
      const d = b.gpuMs - a.gpuMs;
      if (Math.abs(d) > Math.max(0.15, a.gpuMs * 0.04)) {
        deltas.push(`  ${k.padEnd(18)} ${a.gpuMs} -> ${b.gpuMs} ms  ${d > 0 ? '+' : ''}${d.toFixed(2)}`);
      }
    }
    console.log(deltas.length
      ? `\nagainst the last run:\n${deltas.join('\n')}`
      : '\nagainst the last run: nothing moved by more than four per cent');
  }
  writeFileSync(file, JSON.stringify(
    { when: new Date(started).toISOString(), soft, ...result }, null, 2));
  console.log(`\nwritten to ${file}`);
}

main();
