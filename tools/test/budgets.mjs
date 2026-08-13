/**
 * Frame budgets and leaks.
 *
 * Two things this catches that nobody notices by looking: a change that quietly
 * doubles the draw calls, and a render target that is allocated but never
 * disposed. Both have happened here — sprites had grown to 128 of 346 draw
 * calls before anyone counted, and a PMREM target leaked textures 21 -> 54 in
 * three minutes.
 *
 * The caps are deliberately loose. They are there to catch a change of kind,
 * not to freeze a number.
 */
import { launch, session, settle, steps } from './session.mjs';

const CAPS = {
  calls: 420,        // measured 132-229 across biomes
  triangles: 140000,
  textures: 40,      // measured flat at 21
  programs: 60,
};

export async function run() {
  const browser = await launch();
  const results = [];
  try {
    /* Draw calls, triangles and texture counts are resolution-independent, so
       this runs in a small window. On a software rasteriser that is the whole
       difference between three minutes and twenty. */
    const { page, errors } = await session(browser, { width: 640, height: 360 });
    const spots = [640, 8140, 12000, 22960, 34180];
    const seen = { calls: 0, triangles: 0 };

    for (const at of spots) {
      await settle(page, at);
      const info = await page.evaluate(() => {
        const m = window.__mr, r = m.renderer.info;
        return {
          calls: r.render.calls, triangles: r.render.triangles,
          textures: r.memory.textures, programs: m.renderer.info.programs.length,
          biome: m.road.biomeAt(m.state.s),
        };
      });
      seen.calls = Math.max(seen.calls, info.calls);
      seen.triangles = Math.max(seen.triangles, info.triangles);
      for (const k of ['calls', 'triangles', 'programs']) {
        results.push({
          name: `${info.biome} @ ${at}m ${k} <= ${CAPS[k]}`,
          pass: info[k] <= CAPS[k],
          detail: String(info[k]),
        });
      }
    }

    /* Textures should be flat over a long drive. Anything that climbs is a
       resource created per frame or per chunk and never released. */
    const before = await page.evaluate(() => window.__mr.renderer.info.memory.textures);
    await steps(page, 600);
    const after = await page.evaluate(() => ({
      tex: window.__mr.renderer.info.memory.textures,
      geo: window.__mr.renderer.info.memory.geometries,
      km: window.__mr.state.s / 1000,
    }));
    results.push({
      name: 'textures flat over the drive',
      pass: after.tex <= before + 2 && after.tex <= CAPS.textures,
      detail: `${before} -> ${after.tex} over ${after.km.toFixed(1)} km`,
    });
    results.push({
      name: 'geometries bounded',
      pass: after.geo < 900,
      detail: String(after.geo),
    });
    results.push({ name: 'no page errors', pass: errors.length === 0, detail: errors.slice(0, 2).join(' | ') });
  } finally {
    await browser.close();
  }
  return results;
}
