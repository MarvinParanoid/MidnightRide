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
async function sample(page, n) {
  await steps(page, 40);                     // clocks up, history converged
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

    if (has('--sweep')) {
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
