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
| `C` | camera (chase · close · cinematic · first person) |
| `F` | photo mode — hides the interface |
| `R` | cycle the rain |
| `M` | music on/off |
| `T` | push the clock forward an hour |

On a touch screen: left half steers, upper right is throttle, lower right brakes.

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
  rain.js        5000 GPU-resident streaks
  sky.js         gradient dome, stars, moon, environment map
  postfx.js      bloom, radial speed blur, chromatic fringe, grain
  timeofday.js   clock → palette; time zone → place; day → weather
  hud.js         the interface
  input.js       keyboard and touch
  audio/
    core.js      context, bus, convolution reverb, noise
    engine.js    engine, wind, tyres, rain, whoosh
    music.js     the generative synthwave sequencer
```

## Console handle

`window.__mr` exposes the renderer, scene, road, bike, traffic, audio and the
ride state, plus `__mr.teleport(metres, speed)` for jumping down the road to look
at something.
