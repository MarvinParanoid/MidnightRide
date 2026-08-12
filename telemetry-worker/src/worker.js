/**
 * Midnight Ride telemetry sink: one row per session, on Cloudflare Workers + D1.
 *
 *   POST /c                  the beacon the game sends as its tab closes
 *   GET  /report?key=SECRET  a summary, so you never have to open a SQL client
 *
 * This is a public endpoint on the open internet, so nothing from the body is
 * trusted: every field is coerced to a known type and clamped to a sane range,
 * unknown fields are dropped, and an oversized body is refused outright.
 *
 * What is deliberately NOT stored: IP address, user agent, time zone, referrer,
 * anything that survives across sessions. Country comes from Cloudflare's own
 * edge header and is kept only because a launch tells you where it landed.
 */

const MAX_BODY = 2048;

const num = (v, lo, hi, d = 0) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const pick = (v, allowed) => (allowed.includes(v) ? v : null);
const flag = (v) => (v ? 1 : 0);

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (req.method === 'GET' && url.pathname === '/report') return report(url, env);
    if (req.method !== 'POST' || url.pathname !== '/c') {
      return new Response('midnight ride', { status: 404, headers: CORS });
    }

    const raw = await req.text();
    if (raw.length > MAX_BODY) return new Response(null, { status: 413, headers: CORS });

    let d;
    try {
      d = JSON.parse(raw);            // sent as text/plain to dodge the CORS preflight
    } catch {
      return new Response(null, { status: 400, headers: CORS });
    }
    if (!d || typeof d !== 'object' || d.v !== 1) {
      return new Response(null, { status: 400, headers: CORS });
    }

    const seen = d.seen && typeof d.seen === 'object' ? d.seen : {};
    const now = new Date();

    try {
      await env.DB.prepare(
        `INSERT INTO sessions
           (ts, day, ok, started, fail, secs, bucket, km, max_kmh, fps,
            auto_share, photo, shots, cams, seen, is_returning, device, quality, w, h, country)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21)`
      ).bind(
        now.getTime(),
        now.toISOString().slice(0, 10),
        flag(d.ok),
        flag(d.started),
        typeof d.fail === 'string' ? d.fail.slice(0, 60) : null,
        num(d.secs, 0, 86400),
        pick(d.bucket, ['<1m', '1-5m', '5-15m', '15-30m', '30m+']),
        num(d.km, 0, 100000),
        num(d.maxKmh, 0, 400),
        num(d.fps, 0, 500),
        num(d.autoShare, 0, 1),
        num(d.photo, 0, 9999),
        num(d.shots, 0, 9999),
        JSON.stringify(Array.isArray(d.cams) ? d.cams.filter((c) => c >= 0 && c <= 3).slice(0, 4) : []),
        JSON.stringify({
          train: num(seen.train, 0, 999),
          rider: num(seen.rider, 0, 999),
          plane: num(seen.plane, 0, 999),
          planeLow: num(seen.planeLow, 0, 999),
          lightning: num(seen.lightning, 0, 9999),
        }),
        flag(d.returning),
        pick(d.device, ['desktop', 'touch']),
        pick(d.quality, ['high', 'low']),
        num(d.w, 0, 20000),
        num(d.h, 0, 20000),
        (req.cf && req.cf.country) || null
      ).run();
    } catch {
      // a dropped row is not worth a retry storm from a closing tab
    }

    return new Response(null, { status: 204, headers: CORS });
  },
};

/** The handful of numbers actually worth looking at after a launch. */
async function report(url, env) {
  if (!env.REPORT_KEY || url.searchParams.get('key') !== env.REPORT_KEY) {
    return new Response('nope', { status: 403 });
  }
  const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days')) || 30));
  const since = Date.now() - days * 86400000;

  const q = (sql) => env.DB.prepare(sql).bind(since).all();

  const [totals, buckets, devices, events] = await Promise.all([
    q(`SELECT
         COUNT(*)                                        AS sessions,
         ROUND(AVG(CASE WHEN ok = 0 THEN 1.0 ELSE 0 END) * 100, 1) AS pct_never_rendered,
         ROUND(AVG(CASE WHEN started = 0 THEN 1.0 ELSE 0 END) * 100, 1) AS pct_never_started,
         ROUND(AVG(CASE WHEN is_returning = 1 THEN 1.0 ELSE 0 END) * 100, 1) AS pct_returning,
         ROUND(AVG(secs), 0)                             AS avg_secs,
         ROUND(AVG(km), 2)                               AS avg_km,
         ROUND(AVG(fps), 0)                              AS avg_fps,
         ROUND(AVG(auto_share) * 100, 0)                 AS pct_time_on_autopilot,
         SUM(photo)                                      AS photo_opens,
         SUM(shots)                                      AS screenshots
       FROM sessions WHERE ts > ?1 AND started = 1`),
    q(`SELECT bucket, COUNT(*) AS n FROM sessions
       WHERE ts > ?1 AND started = 1 GROUP BY bucket ORDER BY n DESC`),
    q(`SELECT device, quality, COUNT(*) AS n, ROUND(AVG(fps), 0) AS fps
       FROM sessions WHERE ts > ?1 GROUP BY device, quality`),
    q(`SELECT
         SUM(json_extract(seen, '$.train'))     AS trains,
         SUM(json_extract(seen, '$.rider'))     AS riders,
         SUM(json_extract(seen, '$.plane'))     AS planes,
         SUM(json_extract(seen, '$.lightning')) AS strikes
       FROM sessions WHERE ts > ?1`),
  ]);

  return Response.json({
    days,
    totals: totals.results[0],
    sessionLength: buckets.results,
    devices: devices.results,
    rareEventsSeen: events.results[0],
  });
}
