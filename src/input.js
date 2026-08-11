const MAP = {
  KeyW: 'throttle', ArrowUp: 'throttle',
  KeyS: 'brake', ArrowDown: 'brake',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
  ShiftLeft: 'boost', ShiftRight: 'boost',
  Space: 'stoppie',
};

export const isTouchDevice =
  typeof matchMedia === 'function' && matchMedia('(hover: none) and (pointer: coarse)').matches;

export class Input {
  constructor(target = window) {
    this.held = new Set();
    this.taps = new Map();
    this.pointers = new Map();
    this.touch = { steer: 0, throttle: 0, brake: 0 };

    target.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const a = MAP[e.code];
      if (a) {
        this.held.add(a);
        e.preventDefault();
      }
      const cb = this.taps.get(e.code);
      if (cb) {
        cb();
        e.preventDefault();
      }
    });

    target.addEventListener('keyup', (e) => {
      const a = MAP[e.code];
      if (a) this.held.delete(a);
    });

    target.addEventListener('blur', () => this.held.clear());

    this.bindTouch();
  }

  /**
   * Relative drag, not absolute position. The first version steered by where
   * on the screen your thumb was, which means the bike snaps sideways the
   * instant you touch it — unusable. Now each touch remembers where it began
   * and only the movement from there counts, so you can put your thumb down
   * anywhere and the bike keeps doing what it was doing.
   *
   * Left half steers. Right half is throttle and brake: hold to accelerate,
   * drag down to brake.
   */
  bindTouch() {
    const canvas = document.getElementById('scene');
    if (!canvas) return;

    const start = (e) => {
      for (const t of e.changedTouches) {
        this.pointers.set(t.identifier, {
          role: t.clientX < innerWidth * 0.5 ? 'steer' : 'drive',
          x0: t.clientX, y0: t.clientY, x: t.clientX, y: t.clientY,
        });
      }
      this.applyTouch();
      e.preventDefault();
    };

    const move = (e) => {
      for (const t of e.changedTouches) {
        const p = this.pointers.get(t.identifier);
        if (!p) continue;
        p.x = t.clientX;
        p.y = t.clientY;
      }
      this.applyTouch();
      e.preventDefault();
    };

    const end = (e) => {
      for (const t of e.changedTouches) this.pointers.delete(t.identifier);
      this.applyTouch();
      e.preventDefault();
    };

    canvas.addEventListener('touchstart', start, { passive: false });
    canvas.addEventListener('touchmove', move, { passive: false });
    canvas.addEventListener('touchend', end, { passive: false });
    canvas.addEventListener('touchcancel', end, { passive: false });
  }

  applyTouch() {
    let steer = 0, throttle = 0, brake = 0;
    const steerSpan = Math.max(90, innerWidth * 0.16);
    const driveSpan = Math.max(70, innerHeight * 0.14);

    for (const p of this.pointers.values()) {
      if (p.role === 'steer') {
        steer = Math.max(-1, Math.min(1, (p.x - p.x0) / steerSpan));
      } else {
        const dy = p.y0 - p.y;
        if (dy < -10) brake = Math.min(1, -dy / driveSpan);
        else throttle = dy > 10 ? Math.min(1, dy / driveSpan) : 1;   // a held thumb just rides
      }
    }
    this.touch = { steer, throttle, brake };
  }

  /** Fire `cb` once per press of a physical key. */
  on(code, cb) {
    this.taps.set(code, cb);
  }

  get throttle() {
    return this.held.has('throttle') ? 1 : this.touch.throttle;
  }

  get brake() {
    return Math.min(1,
      (this.held.has('brake') ? 1 : 0) + (this.held.has('stoppie') ? 1 : 0) + this.touch.brake);
  }

  get boost() {
    return this.held.has('boost');
  }

  get steer() {
    const keys = (this.held.has('right') ? 1 : 0) - (this.held.has('left') ? 1 : 0);
    return keys || this.touch.steer;
  }

  /** True while the rider is actually asking for something. */
  get active() {
    return this.throttle > 0.01 || this.brake > 0.01 || Math.abs(this.steer) > 0.01 || this.boost;
  }
}
