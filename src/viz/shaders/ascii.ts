import { defineVisualizer, glslFloat, type GlyphAtlasSpec } from './common';

// Characters ordered by ink density; the shader picks one per cell from an intensity in 0..1.
const ATLAS: GlyphAtlasSpec = {
  kind: 'glyphAtlas',
  name: 'uGlyphs',
  chars: ' .:-=+*#%@',
  cellWidth: 8,
  cellHeight: 13,
  fontSize: 12,
};

// ASCII spectrum: mirrored bars built from characters (dense near the horizon, light at the
// tips), over a faint field of glyphs drifting with music-driven time. Treble makes random
// cells sparkle, and the palette steps forward on every beat.
export const ascii = defineVisualizer(
  'ascii',
  'ASCII spectrum',
  /* glsl */ `
uniform shader uGlyphs;  // second child, after the prelude's uSpectrum

const float2 CELL = float2(${glslFloat(ATLAS.cellWidth)}, ${glslFloat(ATLAS.cellHeight)});
const float RAMP = ${glslFloat(ATLAS.chars.length)};

half4 main(float2 fragCoord) {
  const float3 paper = float3(0.0, 0.012, 0.018);

  // Whole cells only, centred on screen.
  float2 grid = floor(uResolution / CELL);
  float2 p = fragCoord - (uResolution - grid * CELL) * 0.5;
  float2 cell = floor(p / CELL);
  if (cell.x < 0.0 || cell.y < 0.0 || cell.x >= grid.x || cell.y >= grid.y) {
    return half4(half3(paper), 1.0);
  }
  float2 local = p - cell * CELL;
  float2 uv = (cell + 0.5) / grid;   // cell centre, 0..1: every pixel of a cell agrees

  // Mirrored bars: one spectrum lookup per column, reaching up and down from the horizon.
  float reach = spectrum(uv.x) * 0.92;
  float d = abs(uv.y - 0.5) * 2.0;   // 0 at the horizon, 1 at the top/bottom edge
  float bar = clamp((reach - d) / max(reach, 0.05) * 1.4, 0.0, 1.0); // '@' at the base → '.' at the tip

  // Background field drifting with uPhase, denser with bass.
  float n = noise(float2(cell.x * 0.18, cell.y * 0.12 - uPhase * 0.8));
  float bg = smoothstep(0.55, 0.95, n) * (0.18 + 0.25 * uBass);

  // Treble sparkles: random cells re-rolled about 10 times per unit of phase.
  float spark = step(1.0 - uTreble * 0.03, hash12(cell + floor(uPhase * 10.0) * 17.0));

  float t = max(max(bar, bg), spark * 0.6);
  float glyph = min(floor(t * (RAMP - 1.0) + 0.5), RAMP - 1.0);
  float ink = uGlyphs.eval(float2(glyph * CELL.x, 0.0) + local).a;

  float3 barCol = palette(uv.x * 0.7 + uBeatCount * 0.04,   // one palette step per beat
                          float3(0.5), float3(0.5), float3(1.0), float3(0.0, 0.33, 0.67));
  float3 col = bar >= bg ? barCol * (0.55 + 0.6 * bar) : float3(0.1, 0.4, 0.33);
  if (spark > 0.0 && bar < 0.01) { col = float3(0.75, 0.95, 1.0); }
  col *= 1.0 + 0.6 * uBeat;                 // flash on beats
  if (uv.y > 0.5) { col *= 0.65; }          // lower half reads as a reflection

  return half4(half3(paper + col * ink), 1.0);
}
`,
  [ATLAS],
  // Glyphs blur when upscaled, so the quality setting may not shrink this one much.
  { minRenderScale: 0.75 },
);
