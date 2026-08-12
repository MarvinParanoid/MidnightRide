import { clamp } from './geo.js';

/**
 * Stream mode: the game as a channel rather than a game.
 *
 *   index.html?stream=1
 *
 * Autopilot rides, the camera changes itself, and the interface turns into a
 * station ident — clock, weather, speed, lifetime distance, and where to go if
 * you want to drive it yourself. Nothing here changes the world; it is the
 * same ride, directed differently and paced for a second monitor.
 */
const ITCH = 'kolbasniy-veter.itch.io/midnightride';

export class StreamMode {
  constructor() {
    const q = new URLSearchParams(location.search);
    this.active = q.has('stream') && q.get('stream') !== '0';
    if (!this.active) return;

    document.body.classList.add('stream');
    this.el = document.createElement('div');
    this.el.id = 'stream';
    this.el.innerHTML = `
      <div class="s-tl">
        <div class="s-station">MIDNIGHT RIDE FM</div>
        <div class="s-clock" data-s-clock>--:--</div>
        <div class="s-where" data-s-where>—</div>
      </div>
      <div class="s-bl">
        <div class="s-speed"><b data-s-kmh>0</b><span>km/h</span></div>
        <div class="s-odo" data-s-odo>0 km travelled</div>
      </div>
      <div class="s-br">
        <div class="s-now" data-s-now>♫ 88.3 NIGHT FM</div>
        <div class="s-plug">play it yourself → ${ITCH}</div>
      </div>
    `;
    document.body.appendChild(this.el);
    this.q = (s) => this.el.querySelector(s);
    this.lastKmh = -1;
  }

  /**
   * The clock shows the hour the *sky* is set to, not the wall clock.
   * Daylight hours are folded into the small hours, so a stream started at
   * four in the afternoon looks like two in the morning — and printing 04:43 PM
   * over an obviously midnight road is the one thing a viewer would notice.
   */
  static clock12(nightHour) {
    const h24 = ((nightHour % 24) + 24) % 24;
    const h = Math.floor(h24);
    const m = String(Math.floor((h24 - h) * 60)).padStart(2, '0');
    return `${String(h % 12 || 12).padStart(2, '0')}:${m} ${h < 12 ? 'AM' : 'PM'}`;
  }

  update(s) {
    if (!this.active) return;
    const kmh = Math.round(s.kmh);
    if (kmh !== this.lastKmh) {
      this.q('[data-s-kmh]').textContent = kmh;
      this.lastKmh = kmh;
    }
    this.q('[data-s-clock]').textContent = s.clock12;
    this.q('[data-s-where]').textContent =
      `${s.place} · ${s.temp}°C · ${s.weather} · ${s.biome}`.toUpperCase();
    this.q('[data-s-odo]').textContent =
      `${Math.round(s.totalKm).toLocaleString('en-US')} km travelled`;
    this.q('[data-s-now]').textContent = `♫ 88.3 NIGHT FM · generated live · ${Math.round(s.bpm)} BPM`;
  }
}

/**
 * Pacing for a channel rather than a ride: eighty to a hundred and twenty most
 * of the time, because two hours of 190 km/h on a second monitor is exhausting
 * rather than hypnotic — with an occasional stretch of speed so it never
 * settles into one number.
 */
export class StreamPacer {
  constructor(rnd = Math.random) {
    this.rnd = rnd;
    this.burst = 0;
    this.next = 150 + rnd() * 300;
  }

  update(dt) {
    if (this.burst > 0) {
      this.burst -= dt;
      if (this.burst <= 0) this.next = 180 + this.rnd() * 360;
    } else {
      this.next -= dt;
      if (this.next <= 0) this.burst = 20 + this.rnd() * 25;
    }
    return this.burst > 0 ? 1.45 : 1;
  }

  /** Base scale on the autopilot's normal cruising speeds. */
  get scale() {
    return clamp(0.62 * (this.burst > 0 ? 1.45 : 1), 0.4, 1.1);
  }
}
