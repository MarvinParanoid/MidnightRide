/**
 * The panel that answers the questions this project keeps asking.
 *
 * Every line here exists because working something out took a headless run and
 * a screenshot diff when the number was sitting in memory all along:
 *
 *   "the reflections turn themselves off"   — the quality guard stepped down;
 *                                             tier and change count are here now
 *   "did that change cost anything?"        — draw calls, triangles, programs
 *   "is something leaking?"                 — textures and geometries over time
 *   "why is the music thin just here?"      — station, energy and layer gates
 *
 * Off unless asked for: `?dev=1`, or F3 at any time. Never in stream mode — the
 * one thing a viewer must not see is the instrumentation.
 */
const FRAMES = 120;         // about two seconds of history in the graph

export class DevHud {
  constructor() {
    this.on = new URLSearchParams(location.search).has('dev');
    this.times = new Float32Array(FRAMES);
    this.at = 0;
    this.acc = 0;
    this.el = null;
    this.canvas = null;
  }

  /** Built lazily: a dev panel should cost nothing at all until it is asked for. */
  build() {
    if (this.el) return;
    const el = document.createElement('div');
    el.className = 'devhud';
    el.innerHTML = '<canvas width="220" height="46"></canvas><pre></pre>';
    document.body.appendChild(el);
    this.el = el;
    this.canvas = el.querySelector('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.pre = el.querySelector('pre');
  }

  toggle() {
    this.on = !this.on;
    if (this.on) this.build();
    if (this.el) this.el.style.display = this.on ? 'block' : 'none';
  }

  /**
   * @param dt        seconds since the last frame
   * @param read      a function returning the numbers; only called when visible,
   *                  so nothing here is computed for a player who never looks
   */
  update(dt, read) {
    if (!this.on) return;
    this.build();
    this.times[this.at] = dt;
    this.at = (this.at + 1) % FRAMES;

    this.graph();

    /* The text costs a layout, so it is rewritten a few times a second rather
       than sixty — the panel must not be the reason the frame rate drops. */
    /* p90 as well as the average: a ragged graph is a p90 problem, and the
       number people quote — average frames per second — hides it completely. */
    this.acc += dt;
    if (this.acc < 0.25) return;
    this.acc = 0;
    const sorted = Array.from(this.times).filter((x) => x > 0).sort((a, b) => a - b);
    this.worst = sorted.length ? sorted[Math.floor(sorted.length * 0.9)] : 0;
    const d = read(this.worst);
    this.pre.textContent = Object.entries(d)
      .map(([k, v]) => `${k.padEnd(11)}${v}`)
      .join('\n');
  }

  graph() {
    const c = this.ctx;
    const w = this.canvas.width, h = this.canvas.height;
    c.clearRect(0, 0, w, h);
    /* Two lines to read against: sixty frames a second, and the forty-five the
       quality guard steps down at. A graph that dips below the lower one for
       four seconds is about to cost you a tier. */
    for (const [fps, colour] of [[60, 'rgba(120,200,255,0.25)'], [45, 'rgba(255,120,140,0.3)']]) {
      const y = h - (1 / fps) / 0.05 * h;
      c.strokeStyle = colour;
      c.beginPath();
      c.moveTo(0, y);
      c.lineTo(w, y);
      c.stroke();
    }
    c.strokeStyle = 'rgba(200,230,255,0.85)';
    c.beginPath();
    for (let i = 0; i < FRAMES; i++) {
      const t = this.times[(this.at + i) % FRAMES];
      const y = h - Math.min(1, t / 0.05) * h;     // full height is 50 ms
      const x = (i / (FRAMES - 1)) * w;
      i ? c.lineTo(x, y) : c.moveTo(x, y);
    }
    c.stroke();
  }
}
