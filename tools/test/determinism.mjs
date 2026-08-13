/**
 * The test that the other tests rest on: run the same drive twice and check the
 * two pictures are the same. If this fails, every visual comparison downstream
 * is measuring noise.
 */
import { createHash } from 'node:crypto';
import { launch, session, settle } from './session.mjs';

const SPOTS = [640, 12000, 34180];

async function capture(browser) {
  /* Small window on purpose. This suite is asserting a property of the harness,
     and the golden frames already prove it at full resolution every run — they
     are compared byte for byte against a baseline recorded in another session
     on another day. Rendering this one at 1152x648 as well bought nothing and
     cost a quarter of the CI budget. */
  const { page, errors } = await session(browser, { width: 640, height: 360 });
  const shots = [];
  for (const d of SPOTS) {
    await settle(page, d, { frames: 45 });
    shots.push(await page.screenshot({ encoding: 'binary' }));
  }
  await page.close();
  return { shots, errors };
}

export async function run() {
  const browser = await launch();
  try {
    const a = await capture(browser);
    const b = await capture(browser);
    const results = SPOTS.map((d, i) => {
      const ha = createHash('sha1').update(a.shots[i]).digest('hex').slice(0, 12);
      const hb = createHash('sha1').update(b.shots[i]).digest('hex').slice(0, 12);
      return { name: `identical at ${d} m`, pass: ha === hb, detail: `${ha} vs ${hb}` };
    });
    const errs = [...a.errors, ...b.errors];
    results.push({ name: 'no page errors', pass: errs.length === 0, detail: errs.slice(0, 2).join(' | ') });
    return results;
  } finally {
    await browser.close();
  }
}
