// Runtime-built textures that visualizers declare in `children` (see ChildSpec).
import { ImageShader, matchFont, Skia, type SkImage } from '@shopify/react-native-skia';
import { useMemo } from 'react';
import { PixelRatio, Platform } from 'react-native';

import { atlasPixelSize, layoutGlyphs } from './glyphAtlas';
import type { ChildSpec, GlyphAtlasSpec } from './shaders';

const MONO_FAMILY = Platform.select({ ios: 'Menlo', default: 'monospace' });

/** Draws the atlas once on a CPU raster surface at device pixel density. */
function makeGlyphAtlas(spec: GlyphAtlasSpec, scale: number): SkImage {
  const { width, height } = atlasPixelSize(spec, scale);
  const surface = Skia.Surface.Make(width, height);
  if (!surface)
    throw new Error(`Couldn't create a ${width}×${height} surface for glyph atlas "${spec.name}"`);
  const canvas = surface.getCanvas();
  canvas.clear(Skia.Color('transparent'));
  const paint = Skia.Paint();
  paint.setColor(Skia.Color('white'));
  paint.setAntiAlias(true);
  const font = matchFont({ fontFamily: MONO_FAMILY, fontSize: spec.fontSize * scale });
  const placements = layoutGlyphs(spec, scale, font.getMetrics(), (char) => font.measureText(char));
  for (const g of placements) canvas.drawText(g.char, g.x, g.y, paint, font);
  surface.flush();
  return surface.makeImageSnapshot();
}

function GlyphAtlasShader({ spec }: { spec: GlyphAtlasSpec }) {
  const atlas = useMemo(() => makeGlyphAtlas(spec, PixelRatio.get()), [spec]);
  // Map the high-density atlas back to dp so the shader can address cells in dp.
  return (
    <ImageShader
      image={atlas}
      tx="clamp"
      ty="clamp"
      fit="fill"
      rect={{ x: 0, y: 0, width: spec.chars.length * spec.cellWidth, height: spec.cellHeight }}
    />
  );
}

/** One child shader per spec. It must always render an image: Skia binds children by
 *  position, and a missing one would shift the others. */
export function ChildShader({ spec }: { spec: ChildSpec }) {
  switch (spec.kind) {
    case 'glyphAtlas':
      return <GlyphAtlasShader spec={spec} />;
  }
}
