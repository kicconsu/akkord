// Shared SkSL prelude: the uniform contract every visualizer gets, plus helpers.
// Pure strings with no React Native imports, so scripts/check-shaders.ts can compile them in Node.
import { BAND_COUNT } from '../../audio/features';

/** A character atlas rendered at runtime with a monospace font: `chars.length` cells side by
 *  side, one cell tall, white glyphs on transparent (read `.a` as ink coverage). It is mapped
 *  into dp space, so `eval(float2(index * cellWidth, 0) + local)` samples cell `index`. */
export interface GlyphAtlasSpec {
  kind: 'glyphAtlas';
  /** The `uniform shader` name declared in the visualizer body. */
  name: string;
  /** Lightest → densest. Index 0 should be a space. */
  chars: string;
  /** Cell size in dp. */
  cellWidth: number;
  cellHeight: number;
  /** Font size in dp. */
  fontSize: number;
}

/** Extra textures a visualizer needs, beyond the prelude's uSpectrum. */
export type ChildSpec = GlyphAtlasSpec;

export interface VisualizerDef {
  id: string;
  name: string;
  /** Complete SkSL source, prelude included. */
  sksl: string;
  /** Bound after PRELUDE_CHILDREN, in this order; must match the body's `uniform shader`s. */
  children: ChildSpec[];
}

/** Child shaders declared by the prelude. Skia binds children in declaration order, and a
 *  declared child is required even when unused, so ShaderCanvas always passes these first. */
export const PRELUDE_CHILDREN = ['uSpectrum'] as const;

/** Must stay in sync with what ShaderCanvas provides. A shader may leave some unused. */
export const UNIFORMS = /* glsl */ `
uniform float2 uResolution; // canvas size in dp
uniform float  uTime;       // seconds, wall clock
uniform float  uPhase;      // music-driven time: faster when louder (~1/s at typical loudness)
uniform float  uBands[${BAND_COUNT}]; // 0..1, low → high, log-spaced (constant/loop index only)
uniform float  uBass;       // 0..1
uniform float  uMid;        // 0..1
uniform float  uTreble;     // 0..1
uniform float  uEnergy;     // 0..1 loudness
uniform float  uBeat;       // 1 on beat, decays to 0
uniform float  uBeatCount;  // beats detected so far
uniform shader uSpectrum;   // ${BAND_COUNT}×1 texture of the bands; read it with spectrum(x)
`;

export const HELPERS = /* glsl */ `
const int BAND_COUNT = ${BAND_COUNT};
const float PI = 3.14159265;
const float TAU = 6.28318531;

// Spectrum level at x in 0..1: one texture lookup, linearly interpolated between bands.
// Prefer this over band()/bandAt() when a shader reads the spectrum many times per pixel.
float spectrum(float x) {
  float4 c = uSpectrum.eval(float2(0.5 + clamp(x, 0.0, 1.0) * float(BAND_COUNT - 1), 0.5));
  return (c.r * 65280.0 + c.g * 255.0) / 65535.0; // 16-bit value split across R (high) and G (low)
}

// SkSL only allows constant or loop-index expressions as uniform array indices,
// so a runtime index has to loop and pick the matching element.
float band(int i) {
  float v = 0.0;
  for (int k = 0; k < BAND_COUNT; k++) {
    if (k == i) { v = uBands[k]; break; }
  }
  return v;
}

// Spectrum level at x in 0..1, linearly interpolated between bands (loops over uBands).
float bandAt(float x) {
  float f = clamp(x, 0.0, 1.0) * float(BAND_COUNT - 1);
  int i0 = int(floor(f));
  float t = f - float(i0);
  float a = 0.0;
  float b = 0.0;
  for (int k = 0; k < BAND_COUNT; k++) {
    if (k == i0) { a = uBands[k]; }
    if (k == i0 + 1) { b = uBands[k]; break; }
  }
  return mix(a, b, t);
}

// Cosine palette (Inigo Quilez): a + b * cos(TAU * (c * t + d)).
float3 palette(float t, float3 a, float3 b, float3 c, float3 d) {
  return a + b * cos(TAU * (c * t + d));
}

// Hash without sine (Dave Hoskins): 0..1, stable across GPUs. No bitwise ops in SkSL.
float hash12(float2 p) {
  float3 p3 = fract(float3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// Smooth value noise, 0..1.
float noise(float2 p) {
  float2 i = floor(p);
  float2 f = fract(p);
  float2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + float2(1.0, 0.0)), u.x),
             mix(hash12(i + float2(0.0, 1.0)), hash12(i + float2(1.0, 1.0)), u.x), u.y);
}
`;

/** Formats a number as an SkSL float literal (8 → "8.0"). Integer literals do convert to float,
 *  but int variables never do, so generated code stays explicitly float. */
export const glslFloat = (n: number): string => (Number.isInteger(n) ? n.toFixed(1) : String(n));

export const defineVisualizer = (
  id: string,
  name: string,
  body: string,
  children: ChildSpec[] = [],
): VisualizerDef => ({
  id,
  name,
  sksl: `${UNIFORMS}${HELPERS}${body}`,
  children,
});
