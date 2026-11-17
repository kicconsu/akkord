# Writing visualizer shaders

How to add a shader, what each input means, and the pitfalls to watch for. The language rules below were confirmed against Skia's shader compiler for the installed versions (react-native-skia 2.14, CanvasKit 0.41).

## Making a new shader

**1. Create `src/viz/shaders/<name>.ts`:**

```ts
import { defineVisualizer } from './common';

export const pulse = defineVisualizer(
  'pulse', // unique id
  'Pulse', // name shown on the pill
  /* glsl */ `
half4 main(float2 fragCoord) {
  // Centred and aspect-correct. Dividing by the smaller side keeps shapes on screen in portrait.
  float2 uv = (fragCoord - 0.5 * uResolution) / min(uResolution.x, uResolution.y);
  float r = length(uv);
  float radius = 0.18 + 0.12 * uBass + 0.05 * uBeat;
  float ring = smoothstep(0.012, 0.0, abs(r - radius));
  float a = atan(uv.y, uv.x) / TAU + 0.5;               // 0..1 around the circle
  float spikes = spectrum(abs(a * 2.0 - 1.0));          // spectrum mirrored by angle
  float halo = smoothstep(radius + 0.18 * spikes, radius, r) * step(radius, r);
  float3 col = palette(a + uPhase * 0.05, float3(0.5), float3(0.5), float3(1.0), float3(0.0, 0.33, 0.67));
  return half4(half3(col * (ring + 0.6 * halo)), 1.0);
}
`,
);
```

This draws a ring that grows with the bass, with a spectrum halo around it and colours that rotate with the music. You don't declare the inputs or helpers yourself: `defineVisualizer` adds the shared prelude from `common.ts` (all the `u*` inputs plus the helper functions).

**2. Register it:** add it to `VISUALIZERS` in `src/viz/shaders/index.ts`.

**3. Check it without a device:**

- `npm run check:shaders` compiles every shader and checks its inputs and textures against what the app provides. Add `-- --png` for one quick preview per shader in `shader-previews/`.
- `npm run preview:shader -- pulse` renders your shader at real moments of a track, side by side in `shader-previews/pulse.png`: silence, the strongest beat, 0.1 s and 0.25 s after it, the loudest, the most treble-heavy and the quietest moment. The audio goes through a Node simulation of the app's analyser, so the inputs are what the app would compute. Options:
  - `--at 4,12.1` picks the moments yourself, in track seconds. A run of close times such as `--at 12,12.05,12.1,12.15` shows motion.
  - `--track song.wav` uses your own music. WAV files only: convert other formats with `ffmpeg -i song.mp3 -ac 1 -c:a pcm_s16le song.wav`.
  - `--scale 2` gives sharper glyphs, and `--size 820x1180` previews another screen size (in dp).
- Frames render in parallel, one per core. Expect about 10 s for a heavy shader at the default settings.

**4. Run it:** tap the visualizer pill in the player controls to reach it. Saving the file updates the app immediately through Fast Refresh. A compile error shows on screen, and the full numbered source is printed in the Metro console.

**5. Check it against the data:** turn on Debug and play the bundled test pattern. During the first 8 s a sweep runs from low to high frequencies; after that a kick lands every 0.5 s. Your shader should react the same way the Debug bars do.

## The inputs

| Input | Range / units | Use it for | Watch out |
|---|---|---|---|
| `fragCoord`, `uResolution` | dp; origin top-left, y points down | Positions | dp, not physical pixels: 1 dp is 2–3 pixels on a phone |
| `uTime` | Seconds since this visualizer appeared | Steady motion; loops with `fract(uTime / period)` | Restarts at 0 when you switch visualizers. Wraps (jumps) after 3600 s. Keeps running while paused. |
| `uPhase` | About 1 per second when loud, 0.2 when quiet | Motion whose speed follows the music | Freezes once paused audio has faded. Calculated on the JS thread, so it stutters if that thread is busy. |
| `spectrum(x)` | x 0..1 (low → high frequency); returns 0..1 | Reading the spectrum, especially several times per pixel | Read it through `spectrum()`, not `uSpectrum.eval()` directly: the raw texture is encoded (16-bit value split across R and G) |
| `band(i)` / `bandAt(x)` (`uBands[64]`) | 0..1, 64 bands from 30 Hz to 16 kHz | Same data, for shaders that read it once per pixel | Each call loops through all 64 values. You can't write `uBands[i]` with a computed `i`. |
| `uBass` / `uMid` / `uTreble` | 0..1; averages over 20–250 Hz / 250 Hz–4 kHz / 4–16 kHz | Broad reactions: size, brightness | Rarely reach 1, and treble usually sits low. Rescale with `smoothstep(lo, hi, v)`. |
| `uEnergy` | 0..1 loudness | Overall intensity | Loud modern masters sit around 0.7–0.9 almost all the time. Use `smoothstep(0.5, 0.95, uEnergy)` for contrast. |
| `uBeat` | 1 on a beat, then fades (down to about 0.3 after 150 ms) | Flashes, kicks, bumps | Detects kick-drum hits (30–150 Hz), at most one every 220 ms. Music without a clear kick gives few beats. |
| `uBeatCount` | Number of beats so far | Changes on each beat: `mod(uBeatCount, 4.0)`, `hash12(float2(uBeatCount, 0.0))` | Changes instantly by design. **`uBeatCount - uBeat` glides smoothly** from one whole number to the next after each beat. |

All the levels are smoothed: they rise in about 25 ms and fall in about 220 ms. Two data quirks:

- The lowest ~15 bands blur together because of the analysis resolution (2048-point FFT), so a single bass note lights several neighbours.
- The test track is unusually loud and bass-heavy. Tune your shaders on real music: `npm run preview:shader -- <id> --track song.wav`.

The other prelude helpers are `palette(t, a, b, c, d)` (a cosine colour palette), `hash12(p)` (a 0..1 pseudo-random value per position) and `noise(p)` (smooth 0..1 noise).

## Examples to learn from

- **`bars.ts`:** reading `uBands` with `band()`, anti-aliasing measured in dp, a reflection.
- **`ascii.ts`:** a glyph atlas, one `spectrum()` read per column so whole cells agree, noise drifting with `uPhase`, treble sparkles, a palette step per beat.
- **`galaxy.ts`:**
  - Mapping the screen onto a tilted disc, with logarithmic spiral arms.
  - Flow-aligned glyphs: picking `- / | \` from the arm's tangent projected to the screen.
  - A shockwave ring driven by `uBeat`'s decay, and a smooth push on each beat from `uBeatCount - uBeat`.
  - Wrap-safe rotation rates, and glyph indices generated from the atlas string so they can't drift out of sync.
- **`rubik.ts`:**
  - Raymarching an SDF in SkSL: camera, bounding-sphere early-out, tetrahedral normals, and global state set once per pixel.
  - Splitting the cube into three slabs along the twist axis, so twisting a layer is just rotating its points (3 box SDFs per step instead of 27).
  - Beat-driven events: `uBeatCount` picks which layer turns and in which direction, and `1 - uBeat` eases the quarter turn.
  - Seamless repeats: colours come from the surface normal, so a finished quarter turn looks exactly like the solved cube.
  - A rotation-matrix inverse built by negating angles (SkSL has no `transpose()`), and `renderScale: 0.75`.

## Adding a texture to a shader

1. Declare it in the body: `uniform shader uMyTex;`. It must come after the prelude's `uSpectrum`, and its position must match its position in step 2: Skia binds textures by declaration order, and a declared texture is required even if unused.
2. Pass its description as the last argument to `defineVisualizer`, in the same order.
3. Only one texture type exists today: `glyphAtlas` (see `src/viz/shaders/ascii.ts`). A new type, such as an image, noise texture or video frame, needs a builder in `src/viz/ChildShaders.tsx` and a matching one in `scripts/check-shaders.ts`.

## Adding a new input for all shaders

It has to go in four places, or the app throws at runtime:

1. Compute it in `src/audio/features.ts` (`AudioFeatures`, `snapshot()`).
2. Pass it in the `uniforms` in `src/viz/ShaderCanvas.tsx`.
3. Declare it in `UNIFORMS` in `src/viz/shaders/common.ts`.
4. Give it a sample value in `uniformValues` in `scripts/check-shaders.ts`.

## Limitations and pitfalls

### Language rules

- Loop bounds must be constants (`i < 64`, not `i < int(n)`). No `while` loops, no recursion. `break` and `continue` are fine.
- No `%`, `&`, `|` or `>>`. Use `mod`, `floor` and `exp2`.
- Integer variables don't convert to float automatically: write `float(i)`. Number literals are fine as written.
- Prelude names are taken, and redefining one is a compile error: `spectrum`, `band`, `bandAt`, `palette`, `hash12`, `noise`, `PI`, `TAU`, `BAND_COUNT`, and every `u*` input.
- No `texture()` and no `dFdx`/`dFdy`. Images only arrive through `uniform shader` declarations.

### Output

- Return alpha 1. The colour is premultiplied by alpha, so anything less shows the black background through it.
- Values above 1 just clip. If you stack glows, compress the result, for example `col / (1.0 + col)`.
- `half` is low precision on phones (about 3 significant digits). Use `float` for positions, time and running totals.
- `NaN` (division by 0, `sqrt`/`log` of a value ≤ 0, `pow` with a negative base, `normalize` of a zero vector, `atan(0.0, 0.0)`) shows up as black or garbage pixels, and differently on each GPU. The preview won't necessarily catch it.
  - Square with `x * x`, never `pow(x, 2.0)`: it's undefined for negative `x`. Skia's CPU preview happens to evaluate it, so the bug only shows on some phones.
  - Clamp bases built from trig: write `pow(max(0.5 + 0.5 * cos(a), 0.0), k)`, because a GPU's `cos` can overshoot ±1 by a hair.
- The canvas is sRGB on purpose: the default P3 colour space would make Skia colour-convert `uSpectrum` and corrupt its data. Don't change `colorSpace` on `ShaderCanvas`.

### Plumbing

- Ids must be unique.
- A shader that declares an input the app doesn't provide crashes on device. `check:shaders` catches this.
- Editing a shader updates instantly. Changes to `features.ts` or `engine.ts` may need a full reload, because the audio engine keeps its state across Fast Refresh.

### Timing

- The audio values arrive from the JS thread, so if that thread is busy they update late, while `uTime` stays smooth.
- Bluetooth headphones delay the sound by 100–300 ms, so the visuals run ahead of what you hear. Nothing compensates for that yet.
- `uTime` and `uPhase` wrap back to 0 at 3600, so a rotation like `uTime * 0.02` jumps once an hour. Pick rates that complete whole cycles in 3600 units, such as `uTime * (TAU / 360.0)` (one turn per 6 minutes) or `uPhase * (TAU / 20.0)`.
- Keep `hash12` inputs small. A time-based re-roll should wrap, as in `floor(mod(uTime * 14.0, 4096.0))`: large inputs lose float precision and the randomness degrades into patterns.

### Performance

- The shader runs for every pixel on every frame, even when paused, because `uTime` keeps the canvas redrawing.
- Costs multiply: each `band()`/`bandAt()` call is a 64-step loop, and each `noise()` call is four hash calculations. Prefer `spectrum()`, and keep total loop iterations per pixel in the tens.
- Character-grid shaders (`ascii`, `galaxy`) compute their per-cell values in every pixel of the cell: a 7×11 dp cell is about 700 physical pixels on a 3× screen, all repeating the same noise and maths. Expensive per-cell work costs far more than it looks. The real fix is two passes, one value per cell rendered into a small texture and then a glyph pass (see step 6 in `dev-plan.md`).
- Heavy shaders can render below screen resolution: pass `{ renderScale: 0.75 }` (or lower) as the fifth argument to `defineVisualizer`. The canvas is upscaled, and the shader still sees full-size dp in `fragCoord` and `uResolution`, so no code changes. The user's Quality setting (High / Balanced / Saver) multiplies it by 1 / 0.75 / 0.5. Glyph shaders set `minRenderScale` so text stays legible.
- Still try heavy shaders on a low-end Android phone early.

### What the preview doesn't tell you

- `check:shaders` and `preview:shader` use Skia's WASM build: a slightly different Skia version, running on the CPU at full precision. They catch compile and contract errors, not low-precision artefacts, `NaN` behaviour or speed.
- `preview:shader` simulates the analyser at 60 fps on the file's own sample rate. The app runs at the display's refresh rate on the device's sample rate, so expect small differences in values, not different behaviour.
- The previews draw glyphs with DejaVu Sans Mono (override with `MONO_FONT=/path`), while phones use Menlo (iOS) or the system monospace font (Android), so character shapes differ slightly.
