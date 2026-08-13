/**
 * Golden frames.
 *
 * Every visual defect found in this project so far was found by a person
 * looking at a picture: a grey square on the verge, a white-hot rope of spray
 * behind the wheel, a building standing in the road, a tunnel with no inside.
 * With the session pinned, the same drive renders the same pixels, so a picture
 * can be compared against a picture and those defects stop being noticed by
 * luck.
 *
 *   node tools/test/run.mjs                 compare against the baselines
 *   node tools/test/run.mjs --update        record new baselines
 *
 * A baseline is only as good as the eyes that approved it, so --update prints
 * what it wrote and expects the diff to be looked at before it is committed.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { launch, session, settle } from './session.mjs';

const DIR = 'tests/golden';
const sha = (b) => createHash('sha1').update(b).digest('hex');
/* Fraction of the frame allowed to move by more than 8/255 before it counts as
   a change. Raise it only with a picture in hand explaining why. */
const TOLERANCE = Number(process.env.MR_VISUAL_TOLERANCE ?? 0.002);

/* One per thing that has actually broken, plus one per biome. */
export const SHOTS = [
  { name: 'city', at: 640, frames: 60 },
  { name: 'highway', at: 12000, frames: 60 },
  { name: 'remote-road', at: 22960, frames: 60 },
  { name: 'tunnel', at: 34180, frames: 60 },
  { name: 'bridge', at: 8140, frames: 60 },
  // the chase view close in, where the spray, the bounce light and the tail
  // lamp halo all live — three separate complaints came from this framing
  { name: 'behind-the-bike', at: 12000, frames: 90, opts: { camMode: 0 } },
];

/**
 * Diff two PNGs inside the browser, which already has a decoder.
 * Only reached when the hashes differ, so its cost never lands on a green run.
 */
async function compare(page, actual, expected) {
  return page.evaluate(async (a, b) => {
    const load = (d) => new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('decode failed'));   // or the promise hangs forever
      i.src = 'data:image/png;base64,' + d;
    });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    if (ia.width !== ib.width || ia.height !== ib.height) return { size: false };
    const px = (img) => {
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(img, 0, 0);
      return x.getImageData(0, 0, img.width, img.height).data;
    };
    const pa = px(ia), pb = px(ib);
    let changed = 0, worst = 0;
    for (let i = 0; i < pa.length; i += 4) {
      const d = Math.max(Math.abs(pa[i] - pb[i]), Math.abs(pa[i + 1] - pb[i + 1]),
        Math.abs(pa[i + 2] - pb[i + 2]));
      if (d > worst) worst = d;
      if (d > 8) changed++;
    }
    return { size: true, changed, worst, total: pa.length / 4 };
  }, actual, expected);
}

export async function run({ update = false } = {}) {
  mkdirSync(DIR, { recursive: true });
  const browser = await launch();
  const results = [];
  try {
    const { page, errors } = await session(browser);
    for (const shot of SHOTS) {
      await settle(page, shot.at, { frames: shot.frames, opts: shot.opts });
      const buf = await page.screenshot({ encoding: 'binary' });
      const file = `${DIR}/${shot.name}.png`;

      if (update || !existsSync(file)) {
        writeFileSync(file, buf);
        results.push({ name: `golden ${shot.name}`, pass: true, detail: 'baseline written — look at it' });
        continue;
      }
      /* A pinned session renders the same bytes, so the fast path is a hash.
         The pixel diff only runs when that fails, and exists to say how badly. */
      const want = readFileSync(file);
      if (sha(buf) === sha(want)) {
        results.push({ name: `golden ${shot.name}`, pass: true, detail: 'byte-identical' });
        continue;
      }
      /* A different Chrome or a different software rasteriser will move a few
         pixels without anything being wrong, so the gate is a fraction of the
         frame rather than zero. Locally it is zero; this tolerance exists so
         the baselines can travel to CI at all. */
      let detail = 'differs';
      let pass = false;
      try {
        const d = await compare(page, buf.toString('base64'), want.toString('base64'));
        if (!d.size) {
          detail = 'size changed';
        } else {
          const frac = d.changed / d.total;
          pass = frac < TOLERANCE;
          detail = `${(100 * frac).toFixed(3)}% of pixels moved, worst ${d.worst}/255`;
        }
      } catch (e) {
        detail = `differs (${e.message})`;
      }
      if (!pass) writeFileSync(`${DIR}/${shot.name}.actual.png`, buf);
      results.push({
        name: `golden ${shot.name}`,
        pass,
        detail: detail + (pass ? '' : ` — wrote ${shot.name}.actual.png`),
      });
    }
    results.push({ name: 'no page errors', pass: errors.length === 0, detail: errors.slice(0, 2).join(' | ') });
  } finally {
    await browser.close();
  }
  return results;
}
