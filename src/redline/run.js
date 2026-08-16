/**
 * A run: alive, then not, then immediately alive again.
 *
 * The design decision this file exists to protect is the last part. Between
 * getting it wrong and riding again there must be almost nothing — the whole
 * loop depends on the player's next attempt starting before they have finished
 * being annoyed about the previous one. A crash that plays out over two seconds
 * of ragdoll is a crash you sit through; a crash that takes a third of a second
 * is a crash you answer.
 *
 * So the hold is short and deliberate rather than a side effect of an animation:
 * long enough to register as an event, short enough that the hand is still on
 * the key. Nothing here draws the impact, and that is on purpose too — the
 * flash, the lurch and the music cutting out are the game's business, and none
 * of them may lengthen the wait.
 *
 * Like the scoring beside it, this knows nothing about the renderer. It is a
 * small machine with three states and a stopwatch, and it can be argued with in
 * plain Node.
 */

/** How long the world holds still after an impact, in seconds. */
const HOLD = 0.35;

export class Run {
  constructor({ hold = HOLD } = {}) {
    this.hold = hold;
    this.begin();
  }

  begin() {
    this.state = 'riding';     // riding | held | over
    this.time = 0;             // seconds alive this run
    this.distance = 0;         // metres covered
    this.topSpeed = 0;         // metres per second
    this.held = 0;             // seconds since the impact
    this.startedAt = null;     // where on the road this run began
  }

  /**
   * @param dt     seconds
   * @param speed  metres per second
   * @param s      distance along the road, for measuring how far this run got
   */
  update(dt, speed, s) {
    if (this.startedAt === null) this.startedAt = s;

    if (this.state === 'held') {
      this.held += dt;
      if (this.held >= this.hold) this.state = 'over';
      return this.state;
    }
    if (this.state === 'over') return this.state;

    this.time += dt;
    this.distance = s - this.startedAt;
    if (speed > this.topSpeed) this.topSpeed = speed;
    return this.state;
  }

  /** Something solid happened. Everything stops; the clock on the hold starts. */
  crash() {
    if (this.state !== 'riding') return false;
    this.state = 'held';
    this.held = 0;
    return true;
  }

  /** True once the hold is done and the player may go again. */
  get canRestart() { return this.state === 'over'; }

  /** True while the world should be frozen rather than simulated. */
  get frozen() { return this.state !== 'riding'; }

  /**
   * What to put on the card. Deliberately four numbers and no grades: there is
   * nothing to unlock and nothing to compare against but your own last run.
   */
  summary(scoring) {
    return {
      score: Math.round(scoring ? scoring.score : 0),
      seconds: this.time,
      km: this.distance / 1000,
      topKmh: Math.round(this.topSpeed * 3.6),
      passes: scoring ? scoring.passes : 0,
      closest: scoring && Number.isFinite(scoring.best) ? scoring.best : null,
    };
  }
}
