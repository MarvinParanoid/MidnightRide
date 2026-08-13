# Tests

```
npm run dev                    # the suite drives the real dev server
npm test                       # everything, ~20 min
npm test -- music              # one suite, instant
npm test -- visual --update    # re-record the golden frames
```

Exits non-zero on any failure.

`MR_CHROME` overrides the browser path, `MR_URL` the server, and
`MR_VISUAL_TOLERANCE` the fraction of a frame allowed to move before a golden
counts as changed (default 0.002).

## In CI

`.github/workflows/test.yml` runs `music` on its own — a second, no browser — and
everything else in a second job against a real dev server, software rasterised
so no GPU is needed. Frames that fail a golden comparison are uploaded as an
artifact, so the picture can be looked at without reproducing the run.

The one thing that may need attention on the first CI run: the baselines were
recorded on a different machine and a different Chrome. Locally frames come out
byte-identical; across builds a few pixels may move. That is what the tolerance
is for, and if the first run reports a fraction just over it, raise
`MR_VISUAL_TOLERANCE` — but look at the uploaded frame first.

## Why these

Every assertion here is a bug that shipped and was found by a person noticing
something, usually much later than it should have been.

| suite | catches | runtime |
|---|---|---|
| `music` | arp figures that drift against the bar, a degree walk that repeats a pitch on a triad, a weighted deck that clumps worse than dice, a bass figure that never changes | instant, no browser |
| `determinism` | the harness itself breaking — everything below depends on it | ~2 min |
| `world` | geometry standing in the carriageway, a tunnel with no inside | ~3.5 min |
| `budgets` | a change that quietly doubles the draw calls; a render target allocated and never disposed | ~4 min |
| `visual` | squares, blown-out highlights, missing geometry — whatever a picture shows | ~3 min |

## The pinned session

`session.mjs` is the load-bearing piece. Two runs of the same drive used to
render different pictures — one scene was 0.04% identical to itself, with 43000
pixels differing by more than 25/255 — which made every visual comparison a
negotiation with noise. Three measurements in this project were reported wrong
before that was understood.

Four things had to be nailed down, and none of them needed a change in `src/`:

- **`Math.random`** — the world is already seeded, but the bike, the autopilot
  and the audio are not.
- **`Date.now`** — decides the hour of the night and the day's weather.
- **`performance.now`** — one frame runs at module load, before the loop can be
  halted, and its `dt` is however many milliseconds the script took to reach it.
  A few, and different every time: enough to leave two runs 0.0007 apart in lane
  position and 0.01 s apart in event timers.
- **the audio schedulers** — they run off the audio clock, which is wall time,
  and they draw from the same `Math.random` stream as everything else, so how
  many numbers they consume depends on how long the run took. That desynchronised
  every particle downstream. Nothing here tests sound, so they stand down.

The loop is halted the instant the game publishes `window.__mr`, before a single
variable-`dt` frame gets away, and from then on time only passes when a test
calls `record.next()`.

Result: byte-identical frames across separate browser sessions.

## Writing a test

Use `settle(page, distance)` rather than teleporting by hand — it gives every
caller the same pre-roll. Chunks stream in and the environment map converges
over the first second, so a frame taken after 90 steps is not the same picture
as one taken after 40, and comparing across that difference is how three
measurements in a row came out wrong.

Keep any single `page.evaluate` short. A scan that runs for minutes trips the
devtools protocol timeout, and a harness that dies of its own length is worse
than no harness — the world suite walks the road in forty separate calls for
this reason.
