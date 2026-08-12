# Telemetry sink

One row per session, on Cloudflare Workers + D1. No VPS, nothing to patch, free
at this project's scale.

## Deploy

```bash
cd telemetry-worker
npx wrangler login

npx wrangler d1 create midnight-ride          # paste the printed id into wrangler.toml
npx wrangler d1 execute midnight-ride --remote --file=schema.sql
npx wrangler secret put REPORT_KEY            # invent a long random string

npx wrangler deploy
```

It prints a URL like `https://midnight-ride-telemetry.<you>.workers.dev`.
Build the game against it — note the `/c`:

```bash
cd ..
VITE_TELEMETRY_URL=https://midnight-ride-telemetry.<you>.workers.dev/c npm run build:itch
```

Check it end to end before uploading: open the build, ride for a few seconds,
close the tab, then

```bash
npx wrangler d1 execute midnight-ride --remote \
  --command "SELECT ts, secs, bucket, km, fps, device, ok FROM sessions ORDER BY id DESC LIMIT 5"
```

## Migrations

The schema gained two columns after the first deploy. If your database predates
them:

```bash
npx wrangler d1 execute midnight-ride --remote --file=migrations/001-quality-tiers.sql
npx wrangler deploy
```

## Reading it

```
https://midnight-ride-telemetry.<you>.workers.dev/report?key=YOUR_KEY&days=30
```

Returns the numbers that matter: session count, share that never rendered a
frame, share that never pressed start, returning share, average duration and
distance, autopilot share, photo-mode use, and how many people actually saw a
train.

## Queries worth keeping

```sql
-- The only question that matters: do people ride, or do they look and leave?
SELECT bucket, COUNT(*) n, ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) pct
FROM sessions WHERE started = 1 GROUP BY bucket;

-- Broken vs uninterested. A black screen counts as a view on any store page.
SELECT fail, COUNT(*) FROM sessions WHERE ok = 0 GROUP BY fail;

-- Did the title screen hold them long enough to press a key?
SELECT ROUND(AVG(CASE WHEN started = 0 THEN 1.0 ELSE 0 END) * 100, 1) AS pct_bounced_on_title
FROM sessions WHERE ok = 1;

-- Is the low-quality path pulling its weight?
SELECT device, quality, COUNT(*) n, ROUND(AVG(fps)) fps, ROUND(AVG(secs)) secs
FROM sessions GROUP BY device, quality;

-- Distance beats time: an abandoned tab racks up seconds, not kilometres.
SELECT ROUND(AVG(km), 1) avg_km, MAX(km) best_km FROM sessions WHERE started = 1;

-- Whether the rare things are too rare to ever be seen.
SELECT SUM(json_extract(seen,'$.train')) trains,
       SUM(json_extract(seen,'$.rider')) riders,
       SUM(json_extract(seen,'$.lightning')) strikes
FROM sessions;

-- Where the launch landed.
SELECT country, COUNT(*) n FROM sessions GROUP BY country ORDER BY n DESC LIMIT 15;
```

## Notes

- The beacon body is JSON but arrives as `text/plain`. `application/json` is not
  CORS-safelisted, so it would trigger a preflight, and a request fired during
  `pagehide` does not survive the extra round trip — it dies as an unanswered
  `OPTIONS` and you get silence instead of data.
- The endpoint is public, so the worker trusts nothing in the body: every field
  is coerced and clamped, unknown fields are dropped, bodies over 2 KB are
  refused. Worst case someone inserts junk rows; nothing else is reachable.
- No IP, user agent, referrer or time zone is stored. Country comes from
  Cloudflare's edge and is the only thing not sent by the game itself.
