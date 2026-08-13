/**
 * The test that the other tests rest on: run the same drive twice and check the
 * two pictures are the same. If this fails, every visual comparison downstream
 * is measuring noise.
 */
import { createHash } from 'node:crypto';
import { launch, session, settle } from './session.mjs';

const SPOTS = [640, 12000, 22960, 34180];

async function capture(browser) {
  const { page, errors } = await session(browser);
  const shots = [];
  for (const d of SPOTS) {
    await settle(page, d);
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
