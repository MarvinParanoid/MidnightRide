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
 * The bike's own half-width and length, in metres: bars and knees, wheel to
 * wheel. Real numbers, because everything downstream of here is deciding
 * whether two objects touched.
 */
const BIKE_HALF = 0.45;
const BIKE_LEN = 2.1;

export function proximity(cars, s, lat, v, out = {}) {
  out.count = 0;             // how many cars are alongside right now
  out.clearance = Infinity;  // metres of clear road beside the nearest of them
  out.nearest = null;
  out.overlap = 0;           // how far into the bike's own width a car reaches
  out.along = Infinity;      // metres of air ahead of or behind it
  out.closing = 0;           // metres per second the gap is shrinking
  out.side = 0;              // which side the nearest one is on: -1 or +1

  for (const car of cars) {
    /* Alongside means overlapping in the direction of travel: a car ten metres
       ahead is not a near miss however close its lane is. */
    const ds = car.s - s;
    /* Air between the two bodies, along the road and across it. Negative on
       either axis means they are overlapping on that axis; negative on both
       means they are in the same place, which is a collision in any game that
       has them.
       This used to be measured against a margin of 2.1 metres between centres,
       which is the distance at which Midnight Ride starts easing you aside —
       a courtesy threshold, tuned by feel, and about seven tenths of a metre
       wider than the cars actually are. Borrowed as a *collision* test by the
       arcade game it read exactly as reported: dying while the car was still
       visibly over there. Measure the metal; let each game pick its own margin
       against it. */
    const along = Math.abs(ds) - (car.len + BIKE_LEN) / 2;
    if (along > 3) continue;

    const dl = lat - car.lat;
    const clear = Math.abs(dl) - ((car.half || 0.95) + BIKE_HALF);
    out.count++;
    if (clear < out.clearance) {
      out.along = along;
      out.clearance = clear;
      out.nearest = car;
      out.side = Math.sign(dl || 1);
      /* Oncoming closes at the sum of the speeds; overtaking, at the
         difference. The sign of `dir` carries which. */
      out.closing = car.dir > 0 ? Math.abs(v - car.speed) : v + car.speed;
    }
  }

  if (out.nearest === null) { out.clearance = Infinity; out.along = Infinity; }
  /* Touching: no air left on either axis. One game calls this a reason to move
     over — and gives itself a margin, because being eased aside before the
     paint meets is the point of it — and the other calls it the end of the run,
     with no margin at all. */
  out.contact = out.clearance < 0 && out.along < 0;
  out.overlap = Math.max(0, -out.clearance);
  return out;
}
