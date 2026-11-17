# Akkord dev plan (React Native + Skia music visualizer)

## Context
The goal is a small RN app that plays **local audio files** (bundled tracks or ones the user picks) and drives **custom Skia shaders (SkSL)** from live audio analysis. Toolchain: **Expo with a dev build** (not Expo Go). This document is the technical reference and progress tracker for the project.

---

## 1. Stack
| Concern | Choice | Why |
|---|---|---|
| App shell | Expo SDK (latest), New Architecture, TypeScript, expo-router | Dev build gives native modules while keeping Expo tooling |
| Rendering | `@shopify/react-native-skia` | GPU canvas plus `RuntimeEffect`, which gives custom SkSL fragment shaders |
| Per-frame driver | `react-native-reanimated` (+ `react-native-worklets`) | Feeds shader uniforms on the UI thread with no React re-renders |
| Audio playback + analysis | `react-native-audio-api` (Software Mansion) | Web Audio API port with `AudioContext`, `decodeAudioData`, `AudioBufferSourceNode` and **`AnalyserNode`** (FFT/time-domain data). It does playback and analysis in one graph. |
| File picking | `expo-document-picker` | Gets a local URI to decode. Bundled tracks need no helper: `decodeAudioData` accepts a `require()`d asset directly. |

**Installed versions (step 1):** Expo SDK 58, React Native 0.88.1, React 19.3, Reanimated 4.7.1 + worklets 0.13, Skia 2.14.0, react-native-audio-api 1.0.0.

Expo Go is out because `react-native-audio-api` is a native module. You'd run `npx expo prebuild` / EAS dev client instead.

## 2. Audio pipeline
```
file URI ─► decodeAudioData ─► AudioBufferSourceNode ─► AnalyserNode ─► destination (speakers)
                                                        │
                                       getFloatFrequencyData / getFloatTimeDomainData
```
- **AnalyserNode settings:** `fftSize` 2048 gives 1024 bins (21.5 Hz each at 44.1 kHz). `smoothingTimeConstant` is **0.3**: kept low because `FeatureExtractor` applies its own attack/release envelopes and beat detection needs sharp onsets. We read raw dB with `getFloatFrequencyData` and normalize ourselves, so `minDecibels`/`maxDecibels` don't matter.
- **Decoding the full file to PCM** is simple and enables seeking, but it uses memory (about 10 MB per stereo minute at 44.1 kHz float32). That's fine for a small app. If long tracks become a problem, we can switch to a streaming/queue source later.
- **Transport:** play, pause, seek. With Web Audio a source node is single-use, so pause/seek means recreating the source with an offset. Track position comes from `context.currentTime`.
- **Audio session:** iOS `playback` category through `AudioManager.setSystemOptions`. The audio-api config plugin also enables iOS background audio and an Android media-playback foreground service by default.
- **Implementation:** `src/audio/engine.ts` is a singleton `audioEngine` with `load(track)`, `play()`, `pause()`, `toggle()`, `seek(s)`, a `position` getter, and `subscribe`/`getState` for `useSyncExternalStore`. A load token makes sure a newer `load()` always wins.

## 3. Feature extraction (raw FFT → shader-friendly numbers)
Don't push 1024 raw bins into a shader each frame. Reduce them to a compact feature set:
- **Bands:** 32 or 64 **log-spaced** bands (perceptual; linear bins waste most of the resolution on highs). Convert dB to a normalized 0..1 range.
- **Envelope smoothing:** asymmetric attack/release per band (fast rise, slow fall), so motion looks musical rather than jittery.
- **Scalars:** `bass`, `mid`, `treble`, overall `energy` (RMS from the time-domain data).
- **Beat/onset:** spectral flux on the low bands against an adaptive threshold. Output a `beat` impulse that decays over about 200 ms.
- Optional **waveform**: 128–256 time-domain samples for oscilloscope-style effects.

This is plain math over a few hundred floats per frame and is cheap in JS.

**As implemented** (`src/audio/features.ts`, pure TS so Node can test it):
- 64 bands, 30 Hz–16 kHz. A band narrower than one FFT bin samples the spectrum at its center by interpolation. A wider band takes the loudest bin inside it.
- Normalization: dB plus a tilt of **+3 dB/octave around 1 kHz**, mapped from **−85..−30 dB** to 0..1. Without the tilt the treble barely moves.
- Envelopes: attack 25 ms, release 220 ms. Energy is RMS mapped from −40..−4 dBFS.
- Beat, in two stages (rewritten after a loud, compressed dubstep master, Skrillex's "Rock n Roll", lost most beats in its drops: the old flux on clamped 0..1 levels over 30–150 Hz was swamped by the wobble bass):
  1. **Onsets.** SuperFlux in dB: each band is compared with the loudest of itself and its two neighbours in the previous frame, so pitch glides (wobble) don't count. There are two channels, kicks (30–200 Hz) and body (30 Hz–5 kHz, below the cymbals). Each channel's flux is divided by its own 4 s running mean (so mastering loudness doesn't matter), log-compressed (so one huge onset can't inflate the statistics), and tested against its own running mean + 1.5 × std-dev (1 s) + 0.5. While there is no tempo, kicks lead, and the body channel fires only after 1.5 s without a kick (music without drums).
  2. **Tempo.** The onset curve (kicks ×2 + body) is resampled to 60 Hz into a 6 s buffer. Every 0.25 s, its autocorrelation over 70–180 BPM (with a bonus at the double lag and a broad prior around 120 BPM) picks the period, and a comb over the buffer picks the phase. When the normalised autocorrelation is above 0.3 (dropped below 0.2), beats lock to that grid. Onsets within ±70 ms of a grid beat fire it, onsets off the grid are ignored, and a grid beat with no onset fires by itself (a kick buried under bass). With no sound (energy < 0.05) the grid stops.
  - Minimum gap between beats is 220 ms, and the impulse decays with a 120 ms time constant.
- **Tuning evidence:** I fed the test track through a Node simulation of the Web Audio analyser (Blackman window, same smoothing). Results:
  - The sweep's peak band matched the expected frequency at every checkpoint.
  - All **32/32 kicks** were detected, with no extra triggers and about 17 ms (one frame) of lag.
  - A −95 dB floor missed 2 kicks.
  - `fftSize` 4096 separated the lows better but missed about half the beats.
- **Re-tuning evidence (two-stage detector):**
  - Test track: 32/32 kicks within −40..+60 ms, 1 extra trigger in the groove; it locks to 120 BPM after about 4 s of groove. The sine sweep now triggers about 6 times (a pure glide is a worst case).
  - "Rock n Roll" (274 s, decoded from the MP3): locks to **128 BPM** wherever the drums play and unlocks in the two breakdowns. It gives 21–22 beats per 10 s in the drops (it gave 4–9 before), and the most common gap is 0.45–0.50 s.
  - Pausing: at most one beat while the energy fades, then none.
- Known limit: a 2048 FFT can't resolve the lowest bands individually, so a bass tone lights several neighbouring low bands. If that matters, a second analyser at 4096 could feed only the bands while beats stay on 2048.

## 4. Getting data into Skia every frame (the critical path)
- A loop at display rate pulls analyser data, computes features, and writes **one** Reanimated shared value holding an `AudioFeatures` object (`src/audio/useAudioFeatures.ts`). One write per frame means one cross-runtime copy. While paused it feeds silence, so the envelopes release smoothly, and it stops writing once everything reaches zero.
- Skia's `<Shader uniforms={...}>` accepts a shared or derived value directly. Uniform updates then happen on the UI thread with **no React re-render**.
- **Setup finding:** in audio-api 1.0.0, `AnalyserNode` is a JS class that wraps a JSI host object owned by the JS runtime, so it can't be called from a UI-thread worklet. The frame loop therefore runs on the **JS thread** (`requestAnimationFrame`): read the analyser, compute features, then write the shared values. That's fine for under 100 floats at 60 fps under JSI/New Arch. If JS-thread jank shows up later, the fallback is a small native module.
- **The spectrum reaches shaders two ways:**
  1. **Uniform array** `uBands[64]`, read with `band(i)`/`bandAt(x)`. These loop over all 64 values per call, so they suit shaders that read the spectrum once or twice per pixel.
  2. **Texture** `uSpectrum` (64×1), read with `spectrum(x)`: one lookup, with free linear interpolation between bands. `src/viz/useSpectrumTexture.ts` rebuilds it on the UI thread whenever the features change (`Skia.Image.MakeImage` from 256 bytes). Each level is stored as 16 bits: R = high byte, G = low byte (`src/viz/spectrumTexture.ts`). The decode is linear, so GPU filtering stays exact. Measured in CanvasKit, `spectrum(x)` matches `bandAt(x)` within 0.00002; reduced GPU shader precision on phones will widen that, still well under 8-bit steps. The same texture can later gain rows for a waveform or a spectrogram history.
- **Colour space:** `ShaderCanvas` sets `colorSpace="srgb"` on its `<Canvas>`. The default is `"p3"`, and on wide-gamut screens Skia then colour-converts child images into P3, which mixes the channels and would corrupt the data in `uSpectrum`. The cost is slightly less saturated colours.

## 5. Shader authoring (SkSL specifics)
Standard uniform contract shared by every visualizer:
```glsl
uniform float2 uResolution;
uniform float  uTime;
uniform float  uBands[64];
uniform float  uPhase;      // music-driven time: faster when louder (~1/s at typical loudness)
uniform float  uBass;       // also uMid, uTreble, uEnergy, uBeat (one declaration each)
uniform float  uBeatCount;  // beats detected so far
uniform shader uSpectrum;   // 64×1 band texture, read with spectrum(x)
half4 main(float2 fragCoord) { ... }
```
It lives in `src/viz/shaders/common.ts` (`UNIFORMS` + `HELPERS`). `defineVisualizer(id, name, body, children?)` prepends both. A shader may leave uniforms unused, but every uniform it declares must be provided, because react-native-skia throws on a missing one.

- **Helpers:** `spectrum(x)`, `band(i)`, `bandAt(x)`, `palette(...)`, `hash12(p)` (sine-free hash) and `noise(p)` (smooth value noise).
- **Animation timing:** use `uPhase` for motion whose speed should follow the music. Never multiply `uTime` by an audio value: `uTime` is large, so any change in the multiplier makes the animation jump. `uPhase` is integrated in `features.ts`. Use `uBeatCount` for beat-stepped changes. For seamless loops, drive periodic functions with `fract(uTime / period)`.
- **Child shaders (textures):** Skia binds them by declaration order, and a declared child is required even if unused. The prelude declares `uSpectrum`, so `ShaderCanvas` always passes it first. A visualizer needing more textures declares them in its body and lists them in `children` (currently `GlyphAtlasSpec`). `src/viz/ChildShaders.tsx` builds them, and `check:shaders` verifies that names and order match.
SkSL differs from GLSL/Shadertoy in a few ways:
- The entry point is `half4 main(float2 fragCoord)` and receives **canvas coordinates in dp**, not physical pixels (no `gl_FragCoord`, no `iResolution`). `uResolution` uses the same units.
- There's no `texture()` / `sampler2D`. Textures come in as child `shader` uniforms through `.eval(coord)`.
- Loops need **constant bounds**, and uniform arrays have a fixed size.
- **A uniform array can only be indexed by a constant or a loop index** (`index expression must be constant`). `uBands[i]` with a runtime `i` fails to compile. Use `spectrum(x)`, or `band(int i)`/`bandAt(float x)`, which loop and select the element.
- No `%`, `&` or `>>` (use `mod`, `floor`, `exp2`). No `while` loops. Loop conditions must compare against a constant. Child shader `.eval()` returns `half4`, which assigns to `float4` fine.
- There's no `dFdx`/`dFdy`, which matters when porting some Shadertoy code.
- In Skia 2.14, `Skia.RuntimeEffect.Make(src)` **throws** `Error in sksl: ...` when compilation fails (older versions returned `null`). `src/viz/effects.ts` → `compileVisualizer()` catches it, caches by source, logs numbered source to Metro, and the screen shows the error instead of crashing.
- Paths are immutable in this Skia version: build them with `Skia.PathBuilder.Make()` … `.detach()`.

Each visualizer is a module exporting `{ id, name, sksl, children }`. The registry is `VISUALIZERS` in `src/viz/shaders/index.ts`. Shaders are TS template strings, so Fast Refresh reloads them instantly. **The step-by-step guide to writing shaders, with input reference and pitfalls, is [`docs/shaders.md`](docs/shaders.md).**

**Checking shaders without a device:** `npm run check:shaders` compiles every visualizer with CanvasKit (Skia's WASM build, already installed through react-native-skia). It also checks that every declared uniform is one `ShaderCanvas` provides, and that declared child shaders match the prelude plus `children`. It binds the real spectrum encoding and renders glyph atlases with a system monospace font (`MONO_FONT=/path` overrides; otherwise placeholder blocks). Add `-- --png <dir>` to render a preview PNG per shader at phone size. CanvasKit's Skia version differs slightly from the native one, so this is a fast first check, not a guarantee.

**Previewing with real audio:** `npm run preview:shader -- <id> [--at t1,t2] [--track song.wav]` renders contact sheets of a visualizer at real moments of a track, picked automatically by default. It feeds a Node simulation of the analysis path (`scripts/lib/analyser-sim.ts`): a Web Audio `AnalyserNode` emulation using the app's `FFT_SIZE`/`ANALYSER_SMOOTHING` from `features.ts`, then the real `FeatureExtractor`. On the test track it reproduces the earlier tuning results exactly (32/32 kicks), and it simulates about 100× faster than real time. Frames render in worker threads (`scripts/lib/render-pool.ts`), because CanvasKit runs shaders on the CPU (about 6 s per galaxy frame at 390×844). The WAV reader handles 8/16/24/32-bit PCM and 32/64-bit float, any channel count, and extra chunks.

## 6. Performance
- Full-screen fragment shaders run per pixel. Phones with 3x density are expensive, so render the shader canvas at **0.5–0.75 scale and upscale** when needed.
- Keep raymarch/FBM iteration counts small, and **test on a low-end Android device early**.
- **Character-grid shaders do their per-cell work once per pixel.** A 7×11 dp cell is about 700 physical pixels at 3×, all repeating the same maths. The galaxy is the heaviest shader so far (fbm + noise + about 10 transcendental calls per pixel). The fix is two passes: render one value per cell (glyph index + colour) into a grid-sized texture with an offscreen surface on the UI thread, then sample it in a light glyph pass. That cuts the per-cell work by roughly 700×.
- **Implemented:** `ShaderCanvas` lays the native canvas out at `scale` × the screen size and enlarges it with a view transform (`transformOrigin: 'left top'`), while a `<Group transform={[{ scale }]}>` inside keeps the shader's coordinates in full-size dp. The GPU shades scale² as many pixels. Each visualizer sets a `renderScale` (Rubik 0.75, the rest 1) and a `minRenderScale` (glyph shaders 0.75). The Quality setting in the visualizer sheet multiplies it by 1 / 0.75 / 0.5.
- No React state in the frame loop: shared values only.
- Reuse typed arrays (`Float32Array`) for analyser reads, with no per-frame allocations.

## 7. Platform notes and limits
- We can only visualize audio **our app plays**. System or other-app audio (Spotify etc.) is not accessible. That's fine for the local-files scope.
- Android may need `READ_MEDIA_AUDIO` for broad library access, but the document picker avoids that.
- Simulators work for development, but judge performance on real devices only.

## 8. Project layout
```
src/app/index.tsx               player screen (routes only in src/app/)
src/audio/engine.ts             AudioContext, decode, transport, analyser (singleton)
src/audio/features.ts           band mapping, envelopes, beat detection (pure TS)
src/audio/useAudioFeatures.ts   JS-thread frame loop → one shared value
src/audio/usePlayer.ts          transport state + polled position for the UI
src/audio/tracks.ts             Track type + bundled tracks
src/viz/shaders/common.ts       uniform contract, SkSL helpers, child specs, defineVisualizer
src/viz/shaders/*.ts            one file per visualizer (bars, ascii, …)
src/viz/shaders/index.ts        VISUALIZERS registry (pure data)
src/viz/spectrumTexture.ts      uSpectrum byte encoding (pure, worklet)
src/viz/glyphAtlas.ts           glyph atlas layout math (pure, shared with check-shaders)
src/viz/useSpectrumTexture.ts   features → uSpectrum SkImage on the UI thread
src/viz/ChildShaders.tsx        runtime-built child textures (glyph atlas)
src/viz/effects.ts              compile + cache + error reporting
src/viz/ShaderCanvas.tsx        <Canvas><Fill><Shader>children</Shader></Fill></Canvas> + uniforms + resolution scaling
src/viz/quality.ts              Quality setting → effective render scale per visualizer (pure)
src/viz/DebugOverlay.tsx        plain-Skia bands/meters/beat view for validating data
src/components/PlayerControls.tsx  title (opens tracks), seek bar, play/pause, visualizer pill, debug toggle
src/components/Sheet.tsx        bottom sheet + rows/sections/segmented control for the pickers
src/audio/library.ts            bundled + user-picked tracks (expo-document-picker), session-only
scripts/check-shaders.ts        compile + contract-check shaders in Node via CanvasKit (+ quick previews)
scripts/preview-shader.ts       contact sheets of a visualizer at real moments of a track
scripts/lib/skia-node.ts        CanvasKit harness mirroring ShaderCanvas (uniforms, uSpectrum, glyph atlases)
scripts/lib/analyser-sim.ts     WAV reader + Node simulation of AnalyserNode → FeatureExtractor
scripts/lib/render-pool.ts      parallel frame rendering in worker threads (+ render-worker.ts)
scripts/generate-test-track.mjs regenerates assets/audio/test-pattern.wav
assets/audio/                   bundled tracks
```

## 9. Build order
1. ✅ Scaffold the Expo TS app. Add Skia, Reanimated, audio-api and document-picker, then create the dev build on a device. *Dev build running on an Android emulator (Windows); see Status.*
2. ✅ (code side) Audio engine: load a bundled track, play/pause/seek.
3. ✅ (code side) Analyser and feature extraction. Debug-render the bands as plain Skia rects to validate the data.
4. ✅ (code side) `ShaderCanvas` with the uniform contract, plus the first shader (spectrum bars in SkSL).
5. ✅ Add 2–3 more shaders and a picker UI. Add the file picker for user tracks. *(ASCII spectrum, ASCII galaxy and Rubik cube; visualizer sheet; track sheet with "Open audio files…".)*
6. ✅ (code side) Performance pass: per-visualizer render scale plus a Quality setting. *Still to do: measure fps on a low-end Android phone, and the two-pass glyph rendering from section 6 if the ASCII shaders are too slow.*

## Verification
- Dev build runs on iOS and Android devices. A bundled track plays, pauses and seeks.
- Debug overlay shows bands and a beat indicator reacting in sync with the audio. Test with a sine sweep plus a kick-drum loop to confirm band mapping and onsets.
- `npm run check:shaders` passes. On device, each shader compiles (no error screen) and hits a steady 60 fps on a mid-range device (Perf Monitor / Skia FPS).

## Status
**Step 1: scaffolding** (code done; first device build pending)
- Expo SDK 58 app from the default template, reset to blank. Installed Skia, audio-api (config plugin added), document-picker and dev-client. Added `eas.json` with development/preview/production profiles and ESLint. `/android` and `/ios` are gitignored (CNG).
- `tsc` and lint are clean, and `expo-doctor` passes 20/20.
- Local Android build issues hit so far:
  - **JRE instead of JDK:** `Toolchain ... does not provide the required capabilities: [JAVA_COMPILER]`. Fix: install `openjdk-21-jdk` and set `JAVA_HOME`.
  - **Incomplete NDK:** `CXX1214 ... User has minSdkVersion 22 but library was built for 24`. Every Gradle module resolves to minSdk 24. The NDK at `~/Android/Sdk/ndk/27.1.12297006` had no `meta/` folder (no `platforms.json`), and without it AGP falls back to platform 22 for native code. Fix: reinstall that NDK through Android Studio's SDK Manager and confirm `meta/platforms.json` exists.
- **Windows (Android Studio emulator), first successful device build:**
  - The SDK's CMake 3.22.1 ships ninja 1.10.2, which fails on object paths over 260 characters (`Filename longer than 260 characters`, in `react-native-gesture-handler` codegen; the path was 321 characters) even with `LongPathsEnabled` on. Fix: install `cmake/3.31.6` with `sdkmanager` (its ninja 1.12.1 handles long paths) and point Gradle at it with `cmake.dir=C:/Users/<you>/AppData/Local/Android/Sdk/cmake/3.31.6` in `android/local.properties`. That file is gitignored and is not regenerated by prebuild, but a clean prebuild removes `android/`, so it has to be added again.
  - Use Android Studio's bundled JDK (`JAVA_HOME=<Android Studio>/jbr`).
  - The dev client couldn't reach Metro at `10.0.2.2`. `adb reverse tcp:8081 tcp:8081` and opening `exp+akkord://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081` works.
  - First build ≈ 30 min (NDK + C++), incremental ≈ 15 min. JS-only changes need only `npx expo start --dev-client`.
- EAS cloud builds are the alternative: `npx eas-cli@latest login`, then `npm run build:dev:android` / `build:dev:ios`. EAS will ask for a package name / bundle id; prebuild currently falls back to `com.anonymous.akkord`.

**Steps 2–4: engine, features, first shader** (code done; not yet run on a device)
- The player screen (`src/app/index.tsx`) replaces the step-1 smoke test. It shows the bars shader full-screen, a Debug toggle (bands, bass/mid/treble/energy meters, beat dot) and the controls (title, tap/drag seek bar, play/pause). On launch it auto-loads the bundled test pattern.
- `assets/audio/test-pattern.wav` (24 s, generated): 0–8 s is a log sine sweep from 40 Hz to 12 kHz, then 8–24 s is a 120 BPM groove (kick on every beat, snare on 2 and 4, offbeat hats, bass, pad).
- Checked without a device:
  - `tsc`, lint and Prettier are clean.
  - Metro bundles for Android and iOS (`expo export --dev`) with the WAV included and worklets transformed.
  - `check:shaders` passes, and preview PNGs look right.
  - Node simulation of analyser → features → bars shader at sweep and groove moments renders the expected picture (travelling peak during the sweep; broad lows, beat lift and bass glow on kicks).
- **What to verify on device:**
  1. The track loads ("Loading…" disappears), and play, pause and seek work. At the end it resets to 0:00.
  2. With Debug on, during the sweep a single green peak travels left to right over 8 s. From 8 s the beat dot pulses every 0.5 s in sync with the kick.
  3. The bars follow the audio with no visible lag, and the bars and caps stay smooth at 60 fps.
  4. Pausing makes the bars fall smoothly to the baseline.
- Possible device-only issues to watch for:
  - The CanvasKit-vs-native SkSL version gap.
  - JS-thread frame pacing of the analyser loop.
  - Whether `ctx.currentTime` advances smoothly enough for the position display.

**New shader inputs + ASCII visualizer** (code done; not yet run on a device)
- New inputs:
  - `uPhase`: music-driven time, integrated as dt × (0.2 + 1.0 × energy).
  - `uBeatCount`: beats detected so far.
  - `uSpectrum`: band texture, read with `spectrum(x)`.
  - Prelude helpers `hash12` and `noise`.
- The canvas is now sRGB, for the colour-space reason in section 4.
- **ASCII spectrum** (`src/viz/shaders/ascii.ts`):
  - 8×13 dp character cells. Mirrored bars run from `@` at the horizon to `.` at the tips, one `spectrum()` lookup per column.
  - A faint glyph field drifts with `uPhase` and gets denser with bass. Treble makes random cells sparkle.
  - The palette steps forward on every beat (`uBeatCount`), and beats flash the brightness.
  - Glyphs come from an atlas drawn once at device pixel density (Menlo on iOS, `monospace` on Android) and mapped back to dp with `ImageShader rect`.
- The controls have a visualizer pill that cycles through `VISUALIZERS`.
- Checked without a device:
  - `tsc`, lint and Prettier are clean, and Metro bundles for Android and iOS (`encodeSpectrum` is transformed into a worklet).
  - `check:shaders` passes with real child textures, and the ASCII preview looks right.
  - Simulation: still 32/32 kicks. `phase` advances about 1.02/s on the test track, and `beatCount` reaches 33 (32 kicks plus the sweep onset).
- **What to verify on device:**
  1. ASCII glyphs are crisp, not blurry, and centred in their cells.
  2. The ASCII bars match the Debug overlay's bands. A mismatch would point to colour conversion or texture sampling.
  3. The palette steps on each kick.
  4. The background drifts faster as the music gets louder and freezes once paused audio has faded out.
  5. Switching visualizers works without errors.

**ASCII galaxy** (`src/viz/shaders/galaxy.ts`; code done, not yet run on a device)
- A tilted two-armed spiral seen at an angle, whose long axis follows the screen's long side.
- Motion: trailing log-spiral arms rotate with uTime + uPhase, plus a smooth push per beat (`uBeatCount - uBeat`). The rates are wrap-safe at 3600.
- Glyphs: at mid density the arms use `- / | \` strokes chosen from the spiral's tangent projected to the screen, so the characters follow the flow.
- Audio:
  - The spectrum maps onto the radius (bass at the core, treble at the rim), boosting only the arms, so the spiral survives loud passages.
  - The bulge pulses with bass and flashes on beats, and each beat sends a shockwave ring out from the core.
  - Treble sparkles inside the arms. Mids fatten the arms, and loudness makes the disc breathe.
- Colour: warm core, blue arms, pink knots, violet rim, with a faint smooth glow under the characters.
- Checked without a device:
  - Previewed across silence, a sweep, a kick, the ring mid-flight, an offbeat and treble-heavy states, using real analyser output from the test track.
  - A rotation strip confirms the arms trail.
  - GPU-undefined maths (`pow` of negatives, `atan(0, 0)`) is guarded.
  - `check:shaders`, `tsc`, lint and the Metro bundle are clean.
- **What to verify on device:**
  1. Frame rate. This is the heaviest shader so far; see section 6.
  2. The strokes are legible at 7×11 dp.
  3. The shockwave fires on kicks, and the rotation speeds up with louder music.

**Rubik cube + pickers + resolution scaling** (code done; run on the Android emulator)
- **Rubik cube** (`src/viz/shaders/rubik.ts`): a raymarched 3×3×3 cube.
  - It spins on its tilted vertical axis, at a constant rate plus a part driven by `uPhase`. Both rates are wrap-safe at 3600.
  - It is always scrambled, and solves itself one move per beat in a loop. Each cycle is 22 beats: a fast whirl applies a 20-move hashed scramble on the first beat, each of the next 20 beats undoes one move (the quarter turn eases in as `uBeat` decays, done in about 0.23 s), and the cube then stays solved for one beat with a halo flare. The app starts scrambled.
  - Stateless: the state is a function of `uBeatCount`. To colour a sticker, each pixel walks its cell and normal back through the moves applied so far (at most 20 rotations, only on pixels that hit the cube). Consecutive scramble moves never share an axis, so no move cancels the previous one. Rendered frames at the end of one beat and the start of the next are pixel-identical.
  - The 54 sticker positions each glow with one slice of the spectrum (bass on the white face, treble on the blue one). Bass pushes the cubies apart and swells the cube, and beats flash the stickers. Treble sharpens the highlights.
  - A spectrum halo circles the cube, mirrored so the bass sits at the top.
  - Cost: three box SDFs per step, at most 64 steps, only inside a bounding sphere; rendered at 75%.
- **Visualizer sheet:** the pill opens a list of all visualizers with their effective resolution, and the Quality control.
- **Track sheet:** tapping the title opens it: "Open audio files…" (multi-select, `audio/*`, copied to cache), the bundled tracks, and the files picked this session. Choosing a track loads it and starts playing.
- Checked:
  - `check:shaders` passes for all four shaders. `preview:shader rubik` across the sweep and the groove shows the twists, gaps and halo.
  - `tsc`, lint and Prettier are clean.
  - On the Pixel_7 emulator (API 37): the bundle loads, the sheets open, Rubik renders at 75% and fills the screen, the cube reacts to the test track, and the system file picker opens and cancels cleanly.
- **What to verify on a real phone:**
  1. Frame rate of Rubik and galaxy on a low-end Android device, at each Quality level.
  2. Playing an MP3/AAC picked from the device, including a long one (memory use of full decoding).
  3. That the upscaled canvas has no seam or offset on iOS.
