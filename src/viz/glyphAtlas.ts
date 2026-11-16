// Layout math for glyph atlases, shared by the app (react-native-skia) and
// scripts/check-shaders.ts (CanvasKit), which draw the same atlas with different APIs.
import type { GlyphAtlasSpec } from './shaders/common';

export interface GlyphPlacement {
  char: string;
  /** drawText position in atlas pixels. */
  x: number;
  y: number;
}

/** Atlas size in pixels when rendered at `scale` pixels per dp. */
export const atlasPixelSize = (spec: GlyphAtlasSpec, scale: number) => ({
  width: Math.ceil(spec.chars.length * spec.cellWidth * scale),
  height: Math.ceil(spec.cellHeight * scale),
});

/**
 * Centres each glyph's ink horizontally in its cell and puts all glyphs on one shared
 * baseline (so '.' sits low and '-' in the middle, like real text). Spaces are skipped.
 * `metrics` and `inkBounds` come from a font at `spec.fontSize * scale`.
 */
export function layoutGlyphs(
  spec: GlyphAtlasSpec,
  scale: number,
  metrics: { ascent: number; descent: number },
  inkBounds: (char: string) => { x: number; width: number },
): GlyphPlacement[] {
  const cw = spec.cellWidth * scale;
  const ch = spec.cellHeight * scale;
  const baseline = (ch - (metrics.descent - metrics.ascent)) / 2 - metrics.ascent; // ascent < 0
  return [...spec.chars]
    .map((char, i) => {
      const b = inkBounds(char);
      return { char, x: i * cw + cw / 2 - (b.x + b.width / 2), y: baseline };
    })
    .filter((g) => g.char.trim() !== '');
}
