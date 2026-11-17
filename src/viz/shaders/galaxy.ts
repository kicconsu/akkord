import { defineVisualizer, glslFloat, type GlyphAtlasSpec } from './common';

// Density ramp with four flow-aligned strokes in the middle: ' ' . : (- / | \) + * # % @
const ATLAS: GlyphAtlasSpec = {
  kind: 'glyphAtlas',
  name: 'uGlyphs',
  chars: ' .:-/|\\+*#%@',
  cellWidth: 7,
  cellHeight: 11,
  fontSize: 10.5,
};

/** Atlas index of `ch` as an SkSL float literal; throws if the atlas lacks it. */
const glyph = (ch: string): string => {
  const i = ATLAS.chars.indexOf(ch);
  if (i < 0) throw new Error(`galaxy: '${ch}' is missing from the glyph atlas`);
  return glslFloat(i);
};
if (!ATLAS.chars.includes('-/|\\')) throw new Error("galaxy: the strokes must sit together as '-/|\\'");

// ASCII galaxy: a tilted two-armed spiral seen at an angle, drawn in characters.
// - Arms rotate with music-driven time (uPhase) and get a smooth extra push on every beat.
// - At mid density the arms use - / | \ strokes aligned with the spiral's direction on screen.
// - The spectrum maps onto the radius: bass lights the core, treble the rim.
// - The bulge pulses with bass and flashes on beats; each beat sends a shockwave ring outward.
// - Background stars twinkle; treble sparkles inside the arms.
export const galaxy = defineVisualizer(
  'galaxy',
  'ASCII galaxy',
  /* glsl */ `
uniform shader uGlyphs;  // second child, after the prelude's uSpectrum

const float2 CELL = float2(${glslFloat(ATLAS.cellWidth)}, ${glslFloat(ATLAS.cellHeight)});
const float G_DOT = ${glyph('.')};
const float G_COLON = ${glyph(':')};
const float G_STROKE = ${glyph('-')};   // first of the strokes, in the order - / | \\ (indices +0..+3)
const float G_PLUS = ${glyph('+')};
const float G_STAR = ${glyph('*')};
const float G_HASH = ${glyph('#')};
const float G_PERCENT = ${glyph('%')};
const float G_AT = ${glyph('@')};

const float ARMS = 2.0;
const float WIND = 3.4;   // spiral winding: larger is tighter

float2x2 rot2(float a) {
  float c = cos(a);
  float s = sin(a);
  return float2x2(c, s, -s, c);
}

// Three octaves of value noise, normalised to about 0..1.
float fbm(float2 p) {
  float v = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 3; i++) {
    v += amp * noise(p);
    p = p * 2.07 + float2(13.1, 7.7);
    amp *= 0.5;
  }
  return v / 0.875;
}

// Density level 0..9 → glyph. Levels 3–4 are strokes picked by direction (0 -, 1 /, 2 |, 3 \\).
float glyphFor(float level, float dir) {
  if (level < 0.5) { return 0.0; }
  if (level < 1.5) { return G_DOT; }
  if (level < 2.5) { return G_COLON; }
  if (level < 4.5) { return G_STROKE + dir; }
  if (level < 5.5) { return G_PLUS; }
  if (level < 6.5) { return G_STAR; }
  if (level < 7.5) { return G_HASH; }
  if (level < 8.5) { return G_PERCENT; }
  return G_AT;
}

half4 main(float2 fragCoord) {
  const float3 paper = float3(0.005, 0.007, 0.018);

  // Whole cells only, centred on screen.
  float2 grid = floor(uResolution / CELL);
  float2 gridSize = grid * CELL;
  float2 p = fragCoord - (uResolution - gridSize) * 0.5;
  float2 cell = floor(p / CELL);
  if (cell.x < 0.0 || cell.y < 0.0 || cell.x >= grid.x || cell.y >= grid.y) {
    return half4(half3(paper), 1.0);
  }
  float2 local = p - cell * CELL;

  // Camera: the disc's long axis follows the screen's long side, tilted, swaying gently.
  float maxSide = max(gridSize.x, gridSize.y);
  float pa = (gridSize.y > gridSize.x ? 1.2 : 0.37) + 0.07 * sin(uTime * (TAU / 48.0));
  float cosI = clamp(min(gridSize.x, gridSize.y) / maxSide * 1.1, 0.4, 0.62);
  float radius = maxSide * 0.46 * (1.0 + 0.05 * uEnergy);   // disc radius in dp, breathes with loudness
  float2x2 toDisc = rot2(-pa);

  // Rotation: slow wall-clock drift, faster with the music, plus a smooth push on each beat.
  // uTime and uPhase wrap at 3600, so both rates complete whole turns by then (no hourly jump).
  float spin = uTime * (TAU / 360.0) + uPhase * (TAU / 20.0) + (uBeatCount - uBeat) * 0.05;

  // Screen → disc plane, evaluated at the cell centre so the whole cell agrees.
  float2 m = toDisc * (((cell + 0.5) * CELL - 0.5 * gridSize) / radius);
  float2 d = float2(m.x, m.y / cosI);
  float r = length(d);
  float theta = atan(d.y, d.x + 1e-5);
  float2 dr = rot2(spin) * d;   // co-rotating frame for the textures

  // Two trailing logarithmic arms, wobbled by noise, with a dust lane along one edge.
  float warp = (noise(dr * 2.3 + 5.0) - 0.5) * 1.1;
  float armPhase = ARMS * (theta + spin) - WIND * log(max(r, 0.002)) + warp;
  // max(0, ·) before pow: a GPU's cos can overshoot ±1 by an ulp, and pow(negative, y) is NaN.
  float arm = pow(max(0.5 + 0.5 * cos(armPhase), 0.0), mix(5.5, 2.5, uMid));   // mids fatten the arms
  float lane = pow(max(0.5 + 0.5 * cos(armPhase + 0.95), 0.0), 12.0);
  float clump = fbm(dr * 6.5);
  float knots = smoothstep(0.62, 0.85, clump) * arm;

  float disc = exp(-r * 1.6) * smoothstep(1.2, 0.8, r);
  float bulgeR = 0.075 + 0.04 * uBass + 0.02 * uBeat;
  float rb = length(float2(m.x, m.y / mix(cosI, 1.0, 0.65)));   // the bulge is rounder than the disc
  float bulge = exp(-pow(rb / bulgeR, 1.3)) * (0.8 + 0.7 * uBeat);

  // The spectrum maps onto the radius: bass lights the core, treble the rim. Only the arms are
  // boosted, so the gaps between them stay dark and the spiral survives loud passages.
  float level = spectrum(clamp((r - 0.04) / 0.96, 0.0, 1.0));
  float armLight = arm * (0.5 + clump) * 1.3 * (0.35 + 0.9 * level);
  float matter = disc * max(0.08 + armLight - 0.6 * lane, 0.0) + bulge;

  // Beat shockwave: a ring racing out from the core as uBeat decays.
  float ringR = (1.0 - uBeat) * 0.95;
  float ringD = (r - ringR) / (0.02 + 0.05 * ringR);
  float ring = exp(-ringD * ringD) * uBeat;   // x*x, not pow(x, 2.0): pow of a negative is undefined

  float t = 1.0 - exp(-1.35 * (matter + 0.8 * ring));

  // Stroke direction: the log spiral's tangent (b·e_r + e_θ), or the circle's (b = 0) where the
  // shockwave dominates, projected to the screen.
  float2 er = r > 1e-4 ? d / r : float2(1.0, 0.0);   // avoids atan(0, 0) at the exact centre
  float2 tangent = (ring > matter ? 0.0 : ARMS / WIND) * er + float2(-er.y, er.x);
  float2 ts = float2(tangent.x, tangent.y * cosI) * toDisc;   // v * M = transpose(M) * v: disc → screen
  float dir = mod(floor(atan(-ts.y, ts.x) / (PI * 0.25) + 0.5), 4.0);
  float g = glyphFor(floor(t * 9.999), dir);

  float3 col = mix(float3(1.0, 0.84, 0.6), float3(0.55, 0.72, 1.0), smoothstep(0.05, 0.42, r)); // warm core → blue arms
  col = mix(col, float3(0.62, 0.48, 1.0), smoothstep(0.65, 1.1, r));                         // violet rim
  col = mix(col, float3(1.0, 0.42, 0.7), knots * 0.85);                                       // pink knots
  col = mix(col, float3(1.0), level * 0.3);                                                   // loud radii run hot
  col *= 0.4 + 0.9 * t;
  col = mix(col, float3(0.75, 1.0, 1.0), clamp(ring * 1.4, 0.0, 1.0));                        // shockwave

  // Background stars twinkle; treble makes random disc cells flash, re-rolled ~14×/s.
  float h1 = hash12(cell * 1.37 + 11.3);
  float h2 = hash12(cell * 0.71 + 29.9);
  float twinkle = 0.5 + 0.5 * sin(uTime * (1.0 + 3.5 * h2) + h1 * 60.0);
  float star = step(0.966, h1) * mix(0.2, 1.0, twinkle) * (0.55 + 0.6 * uTreble);
  float reroll = floor(mod(uTime * 14.0, 4096.0));   // kept small so the hash input stays precise
  float sparkle = step(1.0 - uTreble * 0.25 * disc * (0.25 + arm), hash12(cell * 0.93 + reroll * 7.31));
  if (star > t && star > 0.15) {
    g = star > 0.72 ? G_STAR : (star > 0.42 ? G_PLUS : G_DOT);
    col = mix(float3(0.75, 0.85, 1.0), float3(1.0, 0.9, 0.72), h2) * (0.45 + 0.7 * star);
  } else if (sparkle > 0.5 && g < G_PLUS) {
    g = G_STAR;
    col = float3(0.85, 0.95, 1.0);
  }

  float ink = uGlyphs.eval(float2(g * CELL.x, 0.0) + local).a;

  // Soft glow under the characters: bulge plus a faint disc haze, per pixel (no arms, cheap).
  float2 mp = toDisc * ((p - 0.5 * gridSize) / radius);
  float glowBulge = exp(-pow(length(float2(mp.x, mp.y / mix(cosI, 1.0, 0.65))) / bulgeR, 1.3));
  float glowDisc = exp(-length(float2(mp.x, mp.y / cosI)) * 2.6);
  float3 glow = float3(1.0, 0.8, 0.55) * glowBulge * 0.22 * (0.85 + 0.9 * uBeat)
              + float3(0.35, 0.45, 0.9) * glowDisc * 0.05 * (0.4 + uEnergy);

  return half4(half3(paper + glow + col * ink), 1.0);
}
`,
  [ATLAS],
  // Glyphs blur when upscaled, so the quality setting may not shrink this one much.
  { minRenderScale: 0.75 },
);
