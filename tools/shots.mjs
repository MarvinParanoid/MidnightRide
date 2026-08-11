/**
 * Screenshots for a store page.
 *
 *   npm run dev          # in another terminal
 *   node tools/shots.mjs # writes docs/cover.png and docs/shots/*.png
 *
 * Uses the same fixed-timestep record mode as the clip recorder, so the
 * simulation is in a known state when each frame is taken rather than wherever
 * a slow headless renderer happened to get to. Grain stays on here — it costs
 * nothing in a still and the picture looks better for it.
 */
import puppeteer from 'puppeteer-core';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';

const URL = 'http://127.0.0.1:5173/';
const CHROME = '/usr/bin/google-chrome-stable';
const SHOTS = 'docs/shots';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

rmSync(SHOTS, { recursive: true, force: true });
mkdirSync(SHOTS, { recursive: true });
mkdirSync('docs', { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--headless=new', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox',
    '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars'],
});

async function session(width, height) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.goto(URL, { waitUntil: 'networkidle0' });
  await sleep(1800);
  await page.mouse.click(width / 2, height / 2);
  await sleep(1200);
  return page;
}

/** Find somewhere that looks like the thing we want to photograph. */
async function findSpot(page, kind) {
  return page.evaluate((k) => {
    const r = window.__mr.road;
    const runEnd = (s) => {                       // how far the current biome lasts
      const b = r.biomeAt(s);
      let e = s;
      while (e < s + 4000 && r.biomeAt(e) === b) e += 120;
      return e;
    };
    for (let s = 400; s < 120000; s += 120) {
      const b = r.biomeAt(s);
      const remote = r.remotenessAt(s);
      const toCity = r.distanceTo('CITY', s, 2800);
      if (k === 'city' && b === 'CITY' && r.biomeAt(s + 600) === 'CITY') return s + 240;
      if (k === 'remote' && b === 'HIGHWAY' && remote > 0.8) return s;
      if (k === 'overlook' && remote > 0.35 && toCity < 2000 && toCity > 1300) return s;
      // stand in the middle of a tunnel, not in its doorway
      if (k === 'tunnel' && b === 'TUNNEL' && r.biomeAt(s + 240) === 'TUNNEL') return (s + runEnd(s)) / 2;
      if (k === 'bridge' && b === 'BRIDGE') return (s + runEnd(s)) / 2;
    }
    return 1200;
  }, kind);
}

async function shoot(page, { kind, out, cam = 0, hud = true, speed = 44, settle = 9000, photo = null }) {
  const spot = await findSpot(page, kind);
  await page.evaluate((s) => { window.__mr.state.lat = 1.9; window.__mr.teleport(s, 44); }, spot);
  await page.evaluate(() => window.__mr.setAuto(true));
  await sleep(settle);

  /* The settle above is for chunk building and the environment map — but the
     autopilot spends it riding, and at 160 km/h a ten second wait puts you
     400 m down the road from the place you picked. So snap back to the spot,
     and push the traffic away: a shot framed on the back of a lorry is not the
     screenshot anyone wants on a store page. */
  await page.evaluate((s) => { window.__mr.state.lat = 1.9; window.__mr.teleport(s, 44); }, spot);
  await page.evaluate(() => window.__mr.traffic.cars.forEach((c) => { c.s += 600; }));
  await sleep(600);

  await page.evaluate((o) => window.__mr.record.begin(o),
    { fps: 30, auto: true, camMode: cam, camCycle: false, hints: false, hud, grain: 1 });
  await page.evaluate((v) => { window.__mr.state.v = v; }, speed);

  if (photo) {
    await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyF', bubbles: true })));
    await page.evaluate((p) => {
      const pm = window.__mr.photo;
      Object.assign(pm, p);
      pm.autoFocus = false;
      pm.hideUi = true;
    }, photo);
    await page.evaluate(() => document.querySelector('.photobar').classList.remove('on'));
  }

  // few enough frames that we are still where we meant to be
  for (let i = 0; i < 18; i++) await page.evaluate(() => window.__mr.record.next());
  await page.screenshot({ path: out });
  console.log('wrote', out, `(${kind} @ ${spot} m)`);

  if (photo) {
    await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyF', bubbles: true })));
  }
  await page.evaluate(() => window.__mr.record.end());
  await sleep(400);
}

/* ── store page screenshots ─────────────────────────────────── */
const wide = await session(1280, 720);
await shoot(wide, { kind: 'city', out: `${SHOTS}/01-city.png`, hud: true });
await shoot(wide, { kind: 'remote', out: `${SHOTS}/02-empty-road.png`, hud: false, speed: 50 });
await shoot(wide, { kind: 'overlook', out: `${SHOTS}/03-city-ahead.png`, hud: false, speed: 46, settle: 14000 });
await shoot(wide, { kind: 'tunnel', out: `${SHOTS}/04-tunnel.png`, hud: true });
await shoot(wide, { kind: 'bridge', out: `${SHOTS}/05-bridge.png`, hud: false, speed: 48 });
await wide.close();

/* ── cover: rendered at 2× and scaled down, so it stays crisp ── */
const cover = await session(1260, 1000);
await shoot(cover, { kind: 'city', out: 'docs/cover-2x.png', hud: true, settle: 11000 });
await cover.close();
execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', 'docs/cover-2x.png',
  '-vf', 'scale=630:500:flags=lanczos', 'docs/cover.png'], { stdio: 'inherit' });
rmSync('docs/cover-2x.png', { force: true });
console.log('wrote docs/cover.png (630×500)');

await browser.close();
