export class Hud {
  constructor(root = document.getElementById('ui')) {
    root.innerHTML = `
      <div class="vig"></div>
      <div class="pane tl">
        <div class="place" data-place>—</div>
        <div class="clock" data-clock>--:--</div>
        <div class="wx" data-wx>—</div>
      </div>
      <div class="pane bl"><div class="spd" data-spd>0</div><div class="unit">km/h</div></div>
      <div class="tach" data-tachwrap><i data-tach></i></div>
      <div class="gear" data-gear>N</div>
      <div class="pane br">
        <div data-biome>—</div>
        <div><b data-odo>0.0</b> km</div>
        <div data-bpm>♪ 84</div>
      </div>
      <div class="pane tr">
        <div><kbd>W</kbd> / <kbd>S</kbd> throttle · brake</div>
        <div><kbd>A</kbd> / <kbd>D</kbd> steer</div>
        <div><kbd>Shift</kbd> boost</div>
        <div><kbd>C</kbd> camera · <kbd>F</kbd> photo</div>
        <div><kbd>R</kbd> rain · <kbd>M</kbd> music · <kbd>T</kbd> time</div>
      </div>
      <div class="toast" data-toast></div>
    `;
    this.root = root;
    const q = (sel) => root.querySelector(sel);
    this.el = {
      place: q('[data-place]'),
      clock: q('[data-clock]'),
      wx: q('[data-wx]'),
      spd: q('[data-spd]'),
      tach: q('[data-tach]'),
      tachWrap: q('[data-tachwrap]'),
      gear: q('[data-gear]'),
      biome: q('[data-biome]'),
      odo: q('[data-odo]'),
      bpm: q('[data-bpm]'),
      toast: q('[data-toast]'),
    };
    this.toastT = 0;
    this.lastSpeed = -1;

    this.start = document.createElement('div');
    this.start.id = 'start';
    this.start.innerHTML = `
      <h1>MIDNIGHT RIDE</h1>
      <div class="sub" data-startsub>—</div>
      <div class="keys">
        W / S throttle &amp; brake · A / D steer · Shift boost<br />
        C camera · F photo mode · R rain · M music
      </div>
      <div class="go">click anywhere to ride</div>
    `;
    document.body.appendChild(this.start);
  }

  setIntro(text) {
    this.start.querySelector('[data-startsub]').textContent = text;
  }

  dismiss() {
    this.start.classList.add('gone');
    setTimeout(() => this.start.remove(), 1300);
  }

  toast(text) {
    this.el.toast.textContent = text;
    this.el.toast.classList.add('on');
    this.toastT = 3.2;
  }

  photo(on) {
    this.root.classList.toggle('photo', on);
  }

  update(dt, s) {
    if (this.toastT > 0) {
      this.toastT -= dt;
      if (this.toastT <= 0) this.el.toast.classList.remove('on');
    }

    const kmh = Math.round(s.kmh);
    if (kmh !== this.lastSpeed) {
      this.el.spd.textContent = kmh;
      this.lastSpeed = kmh;
    }
    this.el.clock.textContent = s.clock;
    this.el.place.textContent = s.place;
    this.el.wx.textContent = `${s.temp}°C · ${s.weather}`;
    this.el.tach.style.width = `${Math.min(100, s.rpm / 98)}%`;
    this.el.tachWrap.classList.toggle('red', s.rpm > 8600);
    this.el.gear.textContent = s.kmh < 2 ? 'N' : `${s.gear}`;
    this.el.biome.textContent = s.biome;
    this.el.odo.textContent = (s.odo / 1000).toFixed(1);
    this.el.bpm.textContent = `♪ ${Math.round(s.bpm)}`;
  }
}

export function formatClock(d = new Date()) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
