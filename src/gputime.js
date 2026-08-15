/**
 * How long the GPU actually spent on the frame.
 *
 * Everything in this project has been measured except the one number that
 * matters for performance. Wall-clock time around a draw call measures nothing:
 * the calls are queued and return long before the GPU has done any of the work,
 * and three separate attempts here produced a spread wider than the effect
 * being measured.
 *
 * EXT_disjoint_timer_query_webgl2 is the answer. The GPU timestamps its own
 * command stream and the result comes back a few frames later, asynchronously,
 * without stalling anything.
 *
 * Two constraints shape the code. Only one TIME_ELAPSED query may be active at
 * a time, so this times the whole frame rather than individual passes. And a
 * query can come back "disjoint" — the GPU was interrupted or throttled during
 * it — in which case the number is meaningless and gets thrown away rather than
 * averaged in.
 */
export class GpuTime {
  constructor(renderer) {
    const gl = renderer.getContext();
    this.gl = gl;
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.pending = [];
    this.ms = 0;
    this.last = 0;
    /* Set to an array by the benchmark to collect every reading with its tag;
       left null in normal play so nothing accumulates. */
    this.log = null;
    this.nextTag = 0;
    this.active = false;
    /* set by the benchmark harness; see the render loop */
    this.forced = false;
    /* Not on every browser: it was pulled from Chrome and Firefox in 2016 over
       a timing-attack worry and only came back to desktop Chrome. */
    this.supported = !!this.ext;
  }

  begin() {
    if (!this.supported || this.active) return;
    const gl = this.gl;
    this.query = gl.createQuery();
    gl.beginQuery(this.ext.TIME_ELAPSED_EXT, this.query);
    this.queryTag = this.nextTag;
    this.active = true;
  }

  end() {
    if (!this.active) return;
    const gl = this.gl;
    gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push({ q: this.query, tag: this.queryTag });
    this.active = false;
    this.poll();
  }

  poll() {
    const gl = this.gl;
    /* Results arrive a frame or three late; anything still in flight stays in
       the queue. The queue is bounded because a query is only added once a
       frame and removed as soon as it resolves. */
    while (this.pending.length) {
      const { q, tag } = this.pending[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      this.pending.shift();
      const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
      if (!disjoint) {
        const ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
        const ms = ns / 1e6;
        /* Both are wanted. The smoothed one is for a human reading a panel,
           where a number rewriting itself sixty times a second is unreadable;
           the raw one is for the benchmark, which wants the distribution and
           can do its own statistics — a median of raw frames says something a
           smoothed reading cannot, because smoothing hides exactly the spikes
           worth finding. */
        this.last = ms;
        this.ms = this.ms ? this.ms * 0.85 + ms * 0.15 : ms;
        /* Which frame this number came from, when anyone is asking. A result
           arrives several frames after the work, so a benchmark alternating two
           settings frame by frame cannot simply read the latest figure — it
           would credit half of one setting's frames to the other. The tag rides
           along with the query and comes back attached to the answer. */
        if (this.log) this.log.push({ tag, ms });
      }
      gl.deleteQuery(q);
    }
    /* The cap used to be eight, which was chosen on the assumption that a
       result comes back within a frame or three. Measured in a headless run on
       an integrated Radeon: one query in ninety resolved before being thrown
       away, so the panel was showing a number sampled roughly once every three
       seconds and the benchmark thought it had a distribution when it had a
       single reading. The queue is bounded by construction — one query in per
       frame, and every resolved one leaves — so the cap is only a leak guard
       and can be generous. */
    if (this.pending.length > 90) gl.deleteQuery(this.pending.shift().q);
  }
}
