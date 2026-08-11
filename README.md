# Midnight Ride

An endless night ride. You get a motorcycle, a wet road, a city that keeps
rebuilding itself ahead of you, and music that follows the throttle. There is no
score, no fail state and nothing to unlock. You ride until you feel like stopping.

```bash
npm install
npm run dev      # http://127.0.0.1:5173
```

## Controls

| | |
|---|---|
| `W` / `S` | throttle · brake |
| `A` / `D` | steer |
| `Shift` | boost |
| `E` | autopilot |
| `C` | camera (chase · close · cinematic · first person) |
| `F` | photo mode — hides the interface |
| `R` | cycle the rain |
| `M` | music on/off |
| `T` | push the clock forward an hour |

## Riding itself

Leave the controls alone for twenty-five seconds and it takes over: holds a
lane, reads the next corner and arrives at a speed the corner allows, pulls out
for slower traffic, and drifts the camera between angles every half minute.
Touch anything and you have it back instantly, no confirmation, no transition.
`E` toggles it deliberately.

It is not an easy mode — there is nothing to be good at here. It is for the
times you want to watch rather than steer, and it is what makes the game
something you can leave running on a second screen.

## On a phone

It starts in autopilot, because being handed a throttle is not what you want
from a thing you opened on a phone. `AUTO` in the corner toggles it.

To ride yourself: **left thumb steers, right thumb rides.** Both are relative —
each touch remembers where it began, so you can put a thumb down anywhere
without the bike snapping sideways, and a resting thumb on the right just holds
the throttle open. Drag down on the right to brake.

Small screens also get a lighter build automatically: no pixel-ratio scaling,
a third of the rain, a half-resolution bloom chain and a slower environment
refresh. Landscape only — portrait asks you to turn the phone.

## What is generated, and when

Nothing here is an asset file. There are no models, no textures and no audio in
the repository — all of it is built at runtime, which is why the whole thing
loads instantly and ships as one 800 kB bundle (210 kB gzipped), nearly all of
it Three.js.

**The road** is a centreline defined as a pure function of distance: curvature
and elevation are sums of sines, so kilometre 4,182 looks the same on every run
without anything being stored. Geometry is built 120 m at a time, seven chunks
ahead and two behind, and each chunk is merged down to roughly half a dozen draw
calls. Every 6 km the world is translated back to the origin so floating-point
precision never degrades on a long ride.

**Biomes** follow a weighted chain — city, tunnel, highway, forest, bridge, the
occasional lone petrol station — so the ride has a shape without ever repeating a
fixed loop.

**Long hauls** are the ride's larger rhythm. Every so often the generator commits
to ten to twenty kilometres with no city at all — four to seven minutes at speed.
Each chunk carries a *remoteness* value that ramps to 1 through the middle of it,
and everything reads from it: street lighting thins out and then stops, traffic
drops to almost nothing, the orange lid of light pollution lifts off the sky and
the stars come back, and one petrol station sits alone near the midpoint. A
kilometre or two before the next city the glow returns to the horizon ahead of
you, so you see the place before you reach it. Arriving somewhere only means
something if you have been nowhere first.

**Rare events** are deliberately, aggressively rare — an aeroplane every few
minutes is scenery, an aeroplane every twenty minutes is something you look up
at. A freight train runs the parallel line and settles into your pace for a
while. Another rider catches you, or you catch them, and they sit in the next
lane for a minute before winding it on. A storm cell moves through, throwing
lightning every ten seconds or so, with the thunder arriving a few seconds
behind. Nothing is announced and nothing appears twice in a row.

**Wet asphalt** is the one thing worth spending effort on at night. It comes from
three parts: a roughness map that leaves puddles smoother than the tarmac around
them, an environment map generated from the sky itself so a mirror surface has
something to mirror, and light "pools" and "smears" laid flat on the road under
every lamp, sign and neon strip.

**Sound** is a Web Audio graph. The engine is three detuned saws, a sub and a lot
of filtered noise, geared through a six-speed box, with revs chasing road speed
rather than tracking it exactly — that lag is most of the feel. On top: wind that
scales with the square of your speed, tyre roar that changes character off the
tarmac, rain on your helmet that a tunnel mutes, overrun crackle, doppler whoosh
for oncoming traffic, and thunder a few seconds after distant lightning.

**Music** is generated the same way. A minor-key progression with layers that
unlock as you accelerate — pads while cruising, an arpeggio from about 45 km/h,
drums and bass past 110, a lead motif past 160 — and a tempo that drifts from 82
to 102 BPM with the speedometer. The bloom pulses on the beat.

## Your night, specifically

The game reads your clock and your time zone. It names the place from the zone
(`Europe/Berlin` → `Berlin`), and the sky is graded to the actual hour: dusk at
19:00, deep black at 03:00, the first blue at 05:20. Start it at noon and the
daylight hours are folded into the small hours instead — it is still Midnight
Ride. The weather is fixed for the calendar day, so tonight's rain is the same
rain every time you come back to it tonight.

## Layout

```
src/
  main.js        loop, physics, camera rigs, the glue
  road.js        centreline, chunk lifecycle, carriageway + paint
  props.js       what each biome puts beside the road
  geo.js         mesh builder, PRNG, easing
  assets.js      every texture and shared material, drawn on canvas
  bike.js        the motorcycle, the rider, the headlight, the spray
  traffic.js     pooled cars that politely move over
  events.js      the aeroplane, the train, the other rider, the storm
  rain.js        5000 GPU-resident streaks
  sky.js         gradient dome, stars, moon, environment map
  postfx.js      bloom, radial speed blur, chromatic fringe, grain
  timeofday.js   clock → palette; time zone → place; day → weather
  hud.js         the interface
  input.js       keyboard and relative-drag touch
  autopilot.js   rides for you when you stop
  quality.js     what to cut on a small device
  audio/
    core.js      context, bus, convolution reverb, noise
    engine.js    engine, wind, tyres, rain, whoosh
    music.js     the generative synthwave sequencer
```

## Console handle

`window.__mr` exposes the renderer, scene, road, bike, traffic, audio and the
ride state, plus `__mr.teleport(metres, speed)` for jumping down the road to look
at something.
