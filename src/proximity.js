/**
 * How close the traffic is — as a fact, not as a consequence.
 *
 * The same arithmetic was being done twice and neither copy could be reused.
 * `main.js` measured overlap to decide whether to nudge the rider aside;
 * `audio/traffic.js` measured distance, bearing and closing rate to place a
 * doppler. Both walked the same list of cars, both computed the same gaps, and
 * because each one went straight from measuring to acting, neither could answer
 * a third question — such as how close the closest pass of the last second was,
 * which is the entire subject of an arcade mode built on this world.
 *
 * So this measures and stops. It says how far the nearest car is, how much room
 * there was beside it, whether that room ran out, and how fast the two were
 * closing. What any of that *means* — filter past politely, or end the run and
 * score the near miss — belongs to whoever is asking.
 *
 * The two games differ in exactly that layer and nowhere else, which is the
 * reason for drawing the line here rather than around some larger notion of a
 * "traffic system".
 */

/**
 * How far apart their centres have to be to have passed without touching.
 *
 * Not a sum of half-widths, though it looks like one: it is a figure tuned by
 * feel, at which filtering past a car reads as tight rather than as clipping
 * through it, and the ride has been using it for months. Kept exactly, because
 * changing it would change how the existing game handles for no reason beyond
 * tidiness.
 */
const PASSING_ROOM = 2.1;

/**
 * @param cars   the live traffic
 * @param s      the rider's distance along the road
 * @param lat    the rider's lateral offset
 * @param v      the rider's speed, for the closing rate
 * @returns a reading of this frame, reusing one object — it is read and acted
 *          on immediately, and a fresh one every frame at sixty frames a second
 *          is a garbage collection nobody needs.
 */
export function proximity(cars, s, lat, v, out = {}) {
  out.count = 0;             // how many cars are alongside right now
  out.clearance = Infinity;  // metres of clear road beside the nearest of them
  out.nearest = null;
  out.overlap = 0;           // how far into the bike's own width a car reaches
  out.closing = 0;           // metres per second the gap is shrinking
  out.side = 0;              // which side the nearest one is on: -1 or +1

  for (const car of cars) {
    /* Alongside means overlapping in the direction of travel: a car ten metres
       ahead is not a near miss however close its lane is. */
    const ds = car.s - s;
    const reach = car.len / 2 + 2.2;
    if (Math.abs(ds) > reach) continue;

    const dl = lat - car.lat;
    /* Clearance is the air between them, not the gap between their centres. */
    const clear = Math.abs(dl) - PASSING_ROOM;
    out.count++;
    if (clear < out.clearance) {
      out.clearance = clear;
      out.nearest = car;
      out.side = Math.sign(dl || 1);
      out.overlap = Math.max(0, -clear);
      /* Oncoming closes at the sum of the speeds; overtaking, at the
         difference. The sign of `dir` carries which. */
      out.closing = car.dir > 0 ? Math.abs(v - car.speed) : v + car.speed;
    }
  }

  if (out.nearest === null) out.clearance = Infinity;
  /* Touching, in the sense that matters: no air left between them. One game
     calls this a reason to move over, the other calls it the end of the run. */
  out.contact = out.clearance < 0;
  return out;
}
