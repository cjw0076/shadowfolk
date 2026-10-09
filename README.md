# Shadowfolk — a hand-shadow theater

A paper lantern sits on your table and a paper screen stands beyond it. Raise
your hands into the light: their shadows fall on the paper in real time. Each
night, cut-outs of sleeping creatures appear on the screen. Shape your hands so
the shadow fits the cut-out — a rabbit, a snail, a heron — and the creature
wakes, blinks, and walks off into the night's story.

Built for **Meta Quest** with the **Immersive Web SDK** (WebXR, hand tracking,
passthrough). Hands only, seated, a full night in about five minutes.

- Play: open the hosted link in the Meta Quest Browser and press *Light the lantern*.
- Desktop browsers show a self-playing preview of the theater.

## How it works

- **Live shadows.** Every frame the 25 tracked joints of each hand are
  projected from the lantern onto the paper plane (`src/shadow/silhouette.ts`)
  and drawn as soft capsules and a palm polygon (`src/theater/painter.ts`).
- **Fitting a shape.** The live shadow is rasterised, normalised for position
  and size, and compared with the creature's template over ±30° of rotation
  and both hands, using a radially weighted IoU that rewards the fingers that
  make a silhouette recognisable.
- **Reachable creatures.** Every cut-out is the shadow of a real hand pose:
  captured hand data bent with forward kinematics (`src/shadow/hand-model.ts`,
  `src/shadow/targets.ts`) and cast through the same lantern geometry the
  player sees. Pass thresholds are calibrated in simulation
  (`tools/eval-targets.ts`) against noisy attempts and casual hands.
- **Help without text.** If a shape is not coming, a translucent ghost hand
  shows how to hold it.

## Develop

```sh
npm install
npm run dev        # managed dev server + IWER emulator
npm run typecheck
npm run build
```

## Credits

Base hand poses are derived from the captured hand configurations in
[IWER](https://github.com/meta-quest/immersive-web-emulation-runtime)
(MIT, Meta Platforms). All sound is synthesised at runtime.
