/**
 * Invariants of the generated world, checked by raycasting rather than looking.
 *
 * Each of these is a bug that shipped once:
 *   - a building standing in the carriageway, from swapped frontage and depth
 *   - a tunnel with no inside, from a single-sided shell
 *   - ground ribbons built out over the sea on the coast road
 *
 * These are cheap to re-check over kilometres of road, which is the only way to
 * find a fault that occurs once every few hundred chunks — the building bug was
 * never reproduced by hand at all.
 */
import { launch, session, settle } from './session.mjs';

export async function run() {
  const browser = await launch();
  const results = [];
  try {
    const { page, errors } = await session(browser);
    /* One evaluate per stretch of road, not one for the whole drive: a single
       call that runs for minutes trips the devtools protocol timeout, and a
       harness that dies on its own length is worse than no harness. */
    const report = { probes: 0, intrusions: [], tunnelOpen: [], biomes: {} };
    for (let trip = 0; trip < 40; trip++) {
      const base = 2000 + trip * 600;
      await settle(page, base, { frames: 12 });
      const part = await page.evaluate((base) => {
        const m = window.__mr, T = m.THREE;
        const ray = new T.Raycaster();
        ray.far = 400;
        const out = { probes: 0, intrusions: [], tunnelOpen: [], biomes: {} };
        const half = 6.5;

        for (let k = 0; k < 14; k++) {
          const s = base + k * 40;
          const biome = m.road.biomeAt(s);
          out.biomes[biome] = (out.biomes[biome] || 0) + 1;

          /* Nothing solid may stand between the shoulders. Fire downward from
             above the carriageway and check what is hit is the road, not a wall. */
          for (const lat of [-half + 0.6, -2, 0, 2, half - 0.6]) {
            const road = m.road.point(s, lat, 0, new T.Vector3());
            const p = m.road.point(s, lat, 9, new T.Vector3());
            ray.set(p, new T.Vector3(0, -1, 0));
            out.probes++;
            /* Every hit, not just the nearest, and only inside the envelope a
               rider actually occupies. The first version fired from six metres
               and flagged whatever it hit first, which in a tunnel is the
               ceiling at 5.9 m — nineteen "intrusions" that were the tunnel
               working correctly. Clearance for a motorcycle is about three. */
            for (const h of ray.intersectObject(m.road.group, true)) {
              const mat = h.object.material;
              if (!mat || mat.transparent) continue;
              const up = h.point.y - road.y;
              if (up <= 0.6 || up >= 3.2) continue;
              out.intrusions.push({ s, lat, y: +up.toFixed(2), geom: h.object.geometry.type,
                biome, mat: mat.color ? '#' + mat.color.getHexString() : '?' });
              break;
            }
          }

          /* Inside a tunnel, looking up must find concrete, not sky. */
          if (biome === 'TUNNEL') {
            const p = m.road.point(s, 0, 1.5, new T.Vector3());
            ray.set(p, new T.Vector3(0, 1, 0));
            const hit = ray.intersectObject(m.road.group, true)[0];
            if (!hit || hit.distance > 12) out.tunnelOpen.push([s, hit ? +hit.distance.toFixed(1) : -1]);
          }
        }
        return out;
      }, base);
      report.probes += part.probes;
      report.intrusions.push(...part.intrusions);
      report.tunnelOpen.push(...part.tunnelOpen);
      for (const [k, v] of Object.entries(part.biomes)) report.biomes[k] = (report.biomes[k] || 0) + v;
    }

    results.push({
      name: 'nothing solid stands in the carriageway',
      pass: report.intrusions.length === 0,
      detail: `${report.probes} probes, ${report.intrusions.length} intrusions`
        + (report.intrusions.length ? `\n         ${report.intrusions.slice(0, 6).map((x) => JSON.stringify(x)).join('\n         ')}` : ''),
    });
    results.push({
      name: 'tunnels are enclosed from the inside',
      pass: report.tunnelOpen.length === 0,
      detail: report.tunnelOpen.length ? JSON.stringify(report.tunnelOpen.slice(0, 3)) : 'ceiling found everywhere',
    });
    results.push({
      name: 'the drive covers more than one biome',
      pass: Object.keys(report.biomes).length >= 4,
      detail: JSON.stringify(report.biomes),
    });
    results.push({ name: 'no page errors', pass: errors.length === 0, detail: errors.slice(0, 2).join(' | ') });
  } finally {
    await browser.close();
  }
  return results;
}
