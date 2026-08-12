/**
 * One beacon per session, sent as the tab closes. Nothing else.
 *
 * The point is to answer the only question the itch dashboard cannot: do people
 * actually ride, or do they look at it for ten seconds and leave? Views and
 * plays look identical in both cases.
 *
 * No cookies, no identifiers, no per-frame reporting — a single aggregate
 * payload of counters the game already keeps. The viewport is rounded to the
 * nearest 100 px and the time zone is deliberately not sent, so nothing here
 * narrows down to a person.
 *
 * Disabled unless VITE_TELEMETRY_URL is set at build time, so a plain
 * `npm run build` ships a game that phones nobody:
 *
 *   VITE_TELEMETRY_URL=https://example.com/mr npm run build:itch
 *   VITE_TELEMETRY_MODE=pixel   # for endpoints that want a GET (GoatCounter)
 */
const URL_ = import.meta.env?.VITE_TELEMETRY_URL || '';
const MODE = import.meta.env?.VITE_TELEMETRY_MODE || 'json';

const BUCKETS = [
  [60, '<1m'], [300, '1-5m'], [900, '5-15m'], [1800, '15-30m'], [Infinity, '30m+'],
];

class Telemetry {
  constructor() {
    this.enabled = !!URL_;
    this.t0 = performance.now();
    this.startedAt = null;
    this.sent = false;

    this.data = {
      v: 1,
      ok: false,          // did a frame ever render
      started: false,     // did they press start at all
      fail: null,
      km: 0,
      maxKmh: 0,
      fps: 0,
      autoShare: 0,       // fraction of the ride spent on autopilot
      photo: 0,           // times photo mode was opened
      shots: 0,           // screenshots saved
      cams: [],
      seen: null,
      returning: false,
      device: 'desktop',
      quality: 'high',
      w: 0, h: 0,
    };

    if (!this.enabled) return;
    addEventListener('pagehide', () => this.send());
    addEventListener('visibilitychange', () => { if (document.hidden) this.send(); });
    addEventListener('error', (e) => this.fail(`js:${(e?.message || '').slice(0, 80)}`));
  }

  set(patch) {
    Object.assign(this.data, patch);
  }

  started() {
    this.startedAt = performance.now();
    this.data.started = true;
  }

  fail(reason) {
    if (!this.data.fail) this.data.fail = reason;
    this.send();
  }

  send() {
    if (!this.enabled || this.sent) return;
    this.sent = true;
    try {
      const now = performance.now();
      const secs = Math.round(((this.startedAt ? now - this.startedAt : now - this.t0)) / 1000);
      const payload = {
        ...this.data,
        secs,
        bucket: BUCKETS.find(([lim]) => secs < lim)[1],
        km: +this.data.km.toFixed(2),
        maxKmh: Math.round(this.data.maxKmh),
        fps: Math.round(this.data.fps),
        autoShare: +this.data.autoShare.toFixed(2),
        w: Math.round(innerWidth / 100) * 100,
        h: Math.round(innerHeight / 100) * 100,
      };

      if (MODE === 'pixel') {
        // GoatCounter-style: a GET whose path carries the interesting bucket
        const q = new URLSearchParams({
          p: `/session/${payload.bucket}${payload.fail ? '/failed' : ''}`,
          t: `km=${payload.km} fps=${payload.fps} ${payload.device}`,
        });
        new Image().src = `${URL_}?${q}`;
        return;
      }

      /* Sent as text/plain even though the body is JSON: application/json is
         not a CORS-safelisted content type, so it triggers a preflight, and a
         beacon fired during pagehide never survives the round trip — the
         request dies as an unanswered OPTIONS and you get silence instead of
         data. The receiving end just parses the body itself. */
      const body = JSON.stringify(payload);
      if (navigator.sendBeacon) navigator.sendBeacon(URL_, body);
      else fetch(URL_, { method: 'POST', body, keepalive: true, mode: 'no-cors' });
    } catch {
      /* telemetry must never take the game down with it */
    }
  }
}

export const telemetry = new Telemetry();

/** True if this browser can actually run the thing. */
export function webglSupported() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}
