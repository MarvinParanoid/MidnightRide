/**
 * The only interface the arcade game has.
 *
 * Almost nothing, on purpose. The meter is the soundtrack and the soundtrack is
 * the feedback; a bar on the screen is a second, worse copy of information the
 * player is already receiving through the speakers. So: what a pass was worth,
 * for the fraction of a second after it happens, and the score. The speed sits
 * bottom left where the other game keeps it, because at three hundred you do
 * want to know.
 *
 * The card at the end is four numbers and a line telling you how to go again —
 * and the going again is a keypress, not a button to find with a mouse.
 */
export class Board {
  constructor(seed) {
    const el = document.createElement('div');
    el.id = 'board';
    el.innerHTML = `
      <div class="score"><b data-score>0</b><i data-combo></i></div>
      <div class="call" data-call></div>
      <div class="speed"><b data-kmh>0</b><span>km/h</span></div>
      <div class="meter"><i data-meter></i></div>
      <div class="card" data-card>
        <h2>RUN OVER</h2>
        <dl data-cardnums></dl>
        <p>press anything to ride it again</p>
      </div>
      <div class="seed">tonight · #${seed}</div>
    `;
    document.body.appendChild(el);
    this.el = el;
    this.q = (k) => el.querySelector(`[data-${k}]`);
    this.callT = 0;
    this.shown = -1;
    this.begin();
  }

  begin() {
    this.el.classList.remove('over');
    this.q('call').textContent = '';
    this.callT = 0;
  }

  /** A pass just landed. Say what it was, briefly and large. */
  pass(e) {
    const call = this.q('call');
    call.textContent = e.combo > 1 ? `${e.band} ×${e.combo}` : e.band;
    call.className = `call show band-${e.band.toLowerCase().replace(/ /g, '-')}`;
    this.callT = 0.9;
  }

  comboLost() {
    const call = this.q('call');
    if (call.textContent) call.className = 'call';
  }

  crash(summary) {
    this.el.classList.add('over');
    this.q('cardnums').innerHTML = [
      ['score', Math.round(summary.score)],
      ['seconds', summary.seconds.toFixed(1)],
      ['top speed', `${summary.topKmh} km/h`],
      ['closest', summary.closest === null ? '—' : `${(summary.closest * 100).toFixed(0)} cm`],
      ['passes', summary.passes],
    ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  }

  update(dt, s) {
    if (this.callT > 0) {
      this.callT -= dt;
      if (this.callT <= 0) this.q('call').className = 'call';
    }
    /* Rewritten a few times a second rather than sixty: the text costs a layout
       and the panel must not be the reason a frame is late. */
    this.acc = (this.acc || 0) + dt;
    if (this.acc < 0.1) return;
    this.acc = 0;
    const score = Math.round(s.score);
    if (score !== this.shown) {
      this.q('score').textContent = score;
      this.shown = score;
    }
    this.q('combo').textContent = s.combo > 1 ? `×${s.combo}` : '';
    this.q('kmh').textContent = Math.round(s.kmh);
    this.q('meter').style.transform = `scaleX(${s.meter.toFixed(3)})`;
    this.el.classList.toggle('redline', s.meter > 0.92);
  }
}
