/**
 * A browser session in which the game is deterministic.
 *
 * Everything visual in Midnight Ride is generated, and most of it is already
 * seeded — the road, its props, traffic and events all run off mulberry32. What
 * is not seeded is the handful of `Math.random()` calls in the bike, the
 * autopilot and the audio, plus `Date.now()`, which decides the hour of the
 * night and today's weather. That is enough to make two runs of the same drive
 * different pictures: measured, a scene was 0.04% identical to itself across
 * two runs, and 43000 pixels differed by more than 25/255.
 *
 * Rather than thread a seed through the source, both clocks are replaced before
 * any page script runs. Nothing in src/ knows this is happening, so the thing
 * under test is the shipping build.
 */
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

export const URL = process.env.MR_URL || 'http://127.0.0.1:5173/';

/* Arch calls it google-chrome-stable, the GitHub runners call it google-chrome,
   and a Chrome installed by an action lands somewhere else again. Look rather
   than assume, so the suite needs no configuration on either. */
export const CHROME = process.env.MR_CHROME || [
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
].find((p) => existsSync(p)) || '/usr/bin/google-chrome-stable';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The frozen wall clock: a Tuesday in October, 23:40 local. */
export const FROZEN_TIME = Date.UTC(2025, 9, 14, 21, 40, 0);

/**
 * @param gpu  render on the machine's actual graphics card instead of on the
 *             CPU. Off by default and it must stay that way for the golden
 *             frames: SwiftShader draws the same bytes on every machine, which
 *             is the whole basis of comparing a screenshot against a recording.
 *             A real GPU draws its own bytes, so a golden recorded on this card
 *             means nothing on another one — but it is the only way to get a
 *             frame time that is worth anything, since on SwiftShader the cost
 *             of filling a pixel bears no relation to what a GPU charges. So:
 *             correctness tests on the software renderer, performance on the
 *             hardware one, and never the two confused.
 */
export async function launch({ gpu = false } = {}) {
  const soft = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
  const hard = ['--use-angle=vulkan', '--enable-features=Vulkan', '--enable-gpu'];
  return puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    protocolTimeout: 600000,     // whole-drive scans live in one evaluate
    args: ['--headless=new', ...(gpu ? hard : soft),
      '--ignore-gpu-blocklist', '--no-sandbox',
      '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars'],
  });
}

/**
 * Open the game with both sources of chance pinned.
 * Returns the page plus a live array of anything the page logged as an error.
 */
export async function session(browser, { width = 1152, height = 648, seed = 20260813, tier = null, query = '' } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });

  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.evaluateOnNewDocument((s, frozen) => {
    let a = s >>> 0;
    Math.random = () => {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    /* The loop free-runs on wall-clock dt until a test switches on record mode,
       and those few seconds of real time put the world somewhere different on
       every run — teleport moves the rider but not the traffic, the events or
       the rain. Catch the moment the game publishes its handle and halt the
       loop right there, before a single variable-dt frame gets away. */
    Object.defineProperty(window, '__mr', {
      configurable: true,
      set(v) {
        Object.defineProperty(window, '__mr', { value: v, writable: true, configurable: true });
        v.record.begin({ fps: 30, grain: 0, camCycle: false });
      },
      get() { return undefined; },
    });

    /* One frame runs at module load, before the handle exists and therefore
       before the loop can be halted, and its dt is however many milliseconds
       elapsed since the script started — a few, and different every time. That
       was enough to leave the two runs 0.0007 apart in lane position and 0.01 s
       apart in event timers. A frozen monotonic clock makes that frame a
       zero-length one; record mode supplies every dt after it. */
    /* The frozen clock is what makes a run reproducible — but a benchmark has
       to be able to time something, and a benchmark that reports zero
       milliseconds is worse than one that reports nothing at all. Keep the real
       one to hand under a name nothing in src/ knows about. */
    window.__realNow = performance.now.bind(performance);
    performance.now = () => 0;

    const Real = Date;
    const Frozen = new Proxy(Real, {
      construct(target, args) {
        return args.length ? new target(...args) : new target(frozen);
      },
    });
    Frozen.now = () => frozen;
    // eslint-disable-next-line no-global-assign
    Date = Frozen;
  }, seed, FROZEN_TIME);

  /* A tier asked for here is applied before the renderer exists, so the whole
     chain — multisampling included — is built the way that profile builds it.
     Pinning it afterwards only changes the settings that can be changed later,
     which is why a low-profile fault was not reproducible from this harness. */
  /* A wet seed unless a test asks for another one.
     The world seed decides the weather, and left to the frozen calendar it came
     out Overcast — which is a perfectly good night and a poor thing to record
     six golden frames of, because the wet road is where the reflections, the
     spray and half the shader work live. Pin a night that exercises them. */
  const params = [tier ? `q=${tier}` : '', query || 'seed=20260815'].filter(Boolean).join('&');
  await page.goto(params ? `${URL}${URL.includes('?') ? '&' : '?'}${params}` : URL,
    { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.__mr && window.__mr.record.active, { timeout: 20000 });
  await page.mouse.click(width / 2, height / 2);   // past the title screen
  /* Quality is chosen from the machine, and the machine is not the same one
     twice: `detectQuality` calls anything with two cores or fewer weak, and a
     standard GitHub runner has exactly two. CI was therefore rendering in the
     cut-down profile — half the rain, a smaller bloom buffer, no MSAA — which
     measured as 14.4% of the frame moving against a baseline recorded on a
     sixteen-core box. Pin it, like the clocks. */
  if (!tier) await page.evaluate(() => window.__mr.guard.step(0));

  /* The audio schedulers run off the audio clock, which is wall time, and they
     draw from the same Math.random stream as everything else — so how many
     numbers they consume depends on how long the run happened to take, and the
     particles downstream of them landed somewhere different every time. Nothing
     here is testing sound, so the schedulers stand down. */
  await page.evaluate(() => {
    const m = window.__mr;
    if (m.music) m.music.tick = () => {};
    if (m.engine) m.engine.update = () => {};
  });

  // the loop is already halted, so time only passes when a test asks for it
  await steps(page, 30);
  return { page, errors };
}

/**
 * Put the world in a named, repeatable state.
 *
 * The pre-roll matters as much as the destination: chunks stream in and the
 * environment map converges over the first second or so, and comparing a frame
 * taken after 90 steps against one taken after 40 is how three measurements in
 * a row came out wrong. Every caller gets the same count.
 */
export async function settle(page, distance, { speed = 34, frames = 60, opts = {} } = {}) {
  await page.evaluate((o) => window.__mr.record.begin({
    fps: 30, hints: false, grain: 0, camCycle: false, camMode: 0, hud: false, ...o,
  }), opts);
  await page.evaluate(([d, v]) => window.__mr.teleport(d, v), [distance, speed]);
  await steps(page, frames);
}

/**
 * Advance n frames.
 *
 * The loop lives in the page, not here: one devtools round trip per frame cost
 * more than the frame did on a fast machine and still added minutes on a slow
 * one. Batched so no single call sits long enough to trip the protocol timeout.
 */
export async function steps(page, n, batch = 60) {
  for (let done = 0; done < n; done += batch) {
    const k = Math.min(batch, n - done);
    await page.evaluate(async (k) => {
      for (let i = 0; i < k; i++) await window.__mr.record.next();
    }, k);
  }
}

/**
 * Freeze the simulation so repeated renders of the same instant are identical.
 *
 * The frame right after freezing is not like the ones after it — the grade
 * shader's time uniform, the beat decay and the environment-map counter all
 * settle over one more step — so it is rendered and thrown away. Comparing a
 * variant against that first frame reads as an 8-to-10 unit change in a region
 * that nothing touched, which sent three separate investigations down the wrong
 * road in one afternoon.
 */
export async function freeze(page) {
  await page.evaluate(() => { window.__mr.record.dt = 0; });
  await steps(page, 2);
}
