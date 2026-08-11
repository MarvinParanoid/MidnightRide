/**
 * Records a clip of the ride and encodes it.
 *
 *   npm run dev            # in another terminal
 *   node tools/record.mjs  # writes docs/ride.gif
 *
 * Capturing from a browser normally produces a stuttering mess: the renderer
 * runs at whatever speed the machine manages and a screenshot takes far longer
 * than a frame. So the page is put into a fixed-timestep record mode
 * (`__mr.record`) and stepped one frame at a time — the machine can take half a
 * second per frame and the clip still comes out at an exact, smooth frame rate.
 *
 * Needs a dev server on :5173, Chrome, and ffmpeg on PATH.
 *
 * Options: --fps --seconds --width --height --out --gif-width --colors
 *          --spot (metres along the road) --cam (0 chase, 1 close, 2 cinematic,
 *          3 first person) --webp --mp4 --keep
 */
import puppeteer from 'puppeteer-core';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
};

const FPS = Number(arg('fps', 20));
const SECONDS = Number(arg('seconds', 3));
const W = Number(arg('width', 800));
const H = Number(arg('height', 450));
const GIF_W = Number(arg('gif-width', 400));
const COLORS = Number(arg('colors', 256));
const CAM = Number(arg('cam', 0));
const SPOT = arg('spot', null);
const OUT = String(arg('out', 'docs/ride.gif'));
const URL = String(arg('url', 'http://127.0.0.1:5173/'));
const TMP = '.record-frames';
const CHROME = String(arg('chrome', '/usr/bin/google-chrome-stable'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
mkdirSync(dirname(OUT), { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--headless=new', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox',
    '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars',
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('page error:', e.message));
await page.goto(URL, { waitUntil: 'networkidle0' });

await sleep(2000);
await page.mouse.click(W / 2, H / 2);          // start the ride (and the audio)
await sleep(1500);

const spot = SPOT !== null ? Number(SPOT) : await page.evaluate(() => {
  // somewhere with a decent run of city either side of it
  const r = window.__mr.road;
  for (let s = 3000; s < 60000; s += 120) {
    if (r.biomeAt(s) === 'CITY' && r.biomeAt(s + 700) === 'CITY') return s + 200;
  }
  return 1200;
});
console.log(`recording ${SECONDS}s @ ${FPS}fps from ${spot} m, camera ${CAM}`);

await page.evaluate((s) => { window.__mr.state.lat = 1.9; window.__mr.teleport(s, 46); }, spot);
await page.evaluate(() => window.__mr.setAuto(true));
await sleep(9000);                             // chunks, environment map, toasts

const total = Math.round(FPS * SECONDS);
await page.evaluate((o) => window.__mr.record.begin(o),
  { fps: FPS, auto: true, camMode: CAM, camCycle: false, hints: false });

const t0 = Date.now();
for (let i = 0; i < total; i++) {
  await page.evaluate(() => window.__mr.record.next());
  await page.screenshot({ path: `${TMP}/f-${String(i).padStart(4, '0')}.png` });
  if (i && i % 20 === 0) {
    const per = (Date.now() - t0) / i / 1000;
    console.log(`  ${i}/${total}  ${per.toFixed(2)}s/frame  eta ${Math.round(per * (total - i))}s`);
  }
}
console.log(`captured ${total} frames in ${Math.round((Date.now() - t0) / 1000)}s`);
await browser.close();

/* ── encode ───────────────────────────────────────────────────
   Two things dominate GIF size here, and neither is obvious: film grain (off
   during recording — it re-randomises every pixel and defeats inter-frame
   compression) and dithering. Coarse ordered dithering compresses well but
   turns every lamp halo into concentric rings, so this uses the finest bayer
   pattern, which stays cheap enough because the pattern itself is static.   */
const ff = (args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'inherit' });

ff(['-framerate', String(FPS), '-i', `${TMP}/f-%04d.png`,
  '-vf', `scale=${GIF_W}:-1:flags=lanczos,palettegen=stats_mode=diff:max_colors=${COLORS}`,
  `${TMP}/palette.png`]);
ff(['-framerate', String(FPS), '-i', `${TMP}/f-%04d.png`, '-i', `${TMP}/palette.png`,
  '-lavfi', `scale=${GIF_W}:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=1:diff_mode=rectangle`,
  '-loop', '0', OUT]);
console.log('wrote', OUT);

if (arg('webp', false)) {
  const out = OUT.replace(/\.gif$/, '.webp');
  ff(['-framerate', String(FPS), '-i', `${TMP}/f-%04d.png`,
    '-vf', `scale=${Math.max(GIF_W, 640)}:-1:flags=lanczos`,
    '-loop', '0', '-q:v', '70', '-compression_level', '6', out]);
  console.log('wrote', out, '(smaller and sharper than the gif, if the target supports it)');
}

if (arg('mp4', false)) {
  const out = OUT.replace(/\.gif$/, '.mp4');
  ff(['-framerate', String(FPS), '-i', `${TMP}/f-%04d.png`,
    '-vf', `scale=${W}:-1:flags=lanczos`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-crf', '20', '-movflags', '+faststart', out]);
  console.log('wrote', out);
}

if (!arg('keep', false)) rmSync(TMP, { recursive: true, force: true });
if (existsSync(OUT)) {
  const { size } = await import('node:fs').then((fs) => fs.statSync(OUT));
  console.log(`${(size / 1048576).toFixed(1)} MB`);
}
