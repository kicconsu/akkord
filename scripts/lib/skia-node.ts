/// <reference types="node" />
// CanvasKit (Skia's WASM build) set up the way the app's ShaderCanvas sets up react-native-skia:
// the same uniforms, uSpectrum encoding and glyph atlas layout. Shared by check-shaders and
// preview-shader. CanvasKit's Skia version is close to, but not identical to, the one in
// react-native-skia, and it renders on the CPU at full precision: treat results as a first check.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { EMPTY_FEATURES, type AudioFeatures } from '../../src/audio/features';
import { atlasPixelSize, layoutGlyphs } from '../../src/viz/glyphAtlas';
import type { ChildSpec, GlyphAtlasSpec, VisualizerDef } from '../../src/viz/shaders';
import { PRELUDE_CHILDREN } from '../../src/viz/shaders/common';
import { encodeSpectrum, SPECTRUM_WIDTH } from '../../src/viz/spectrumTexture';

// canvaskit-wasm ships with react-native-skia (for its web support), so resolve it through there.
const ckEntry = require.resolve('canvaskit-wasm/bin/full/canvaskit.js', {
  paths: [require.resolve('@shopify/react-native-skia/package.json')],
});

/** CanvasKit objects stay untyped: canvaskit-wasm is only a transitive dependency. */
type CK = any;

const MONO_FONTS = [
  process.env.MONO_FONT,
  '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
  '/usr/share/fonts/truetype/noto/NotoMono-Regular.ttf',
  '/usr/share/fonts/TTF/DejaVuSansMono.ttf',
  '/System/Library/Fonts/Supplemental/Courier New.ttf',
  'C:\\Windows\\Fonts\\consola.ttf',
].filter((f): f is string => !!f);

/** The uniforms ShaderCanvas computes, including its 3600 wraps. Keep the two in sync. */
export function shaderUniforms(
  f: AudioFeatures,
  size: [number, number],
  time: number,
): Record<string, number[]> {
  return {
    uResolution: [Math.max(size[0], 1), Math.max(size[1], 1)],
    uTime: [time % 3600],
    uPhase: [f.phase % 3600],
    uBands: f.bands,
    uBass: [f.bass],
    uMid: [f.mid],
    uTreble: [f.treble],
    uEnergy: [f.energy],
    uBeat: [f.beat],
    uBeatCount: [f.beatCount],
  };
}

/** Names of every uniform ShaderCanvas provides. */
export const PROVIDED_UNIFORMS = Object.keys(shaderUniforms(EMPTY_FEATURES, [1, 1], 0));

export const numbered = (src: string) =>
  src
    .split('\n')
    .map((l, i) => `${String(i + 1).padStart(4)} | ${l}`)
    .join('\n');

const declaredChildren = (sksl: string) =>
  [...sksl.matchAll(/uniform\s+shader\s+(\w+)\s*;/g)].map((m) => m[1]);

export interface Harness {
  CK: CK;
  /** Monospace font used for glyph atlases and labels; null means placeholder atlases, no labels. */
  fontPath: string | null;
  compile(viz: VisualizerDef): { effect: CK; error: null } | { effect: null; error: string };
  /** Mismatches between a compiled shader and what ShaderCanvas provides; empty when fine. */
  contractProblems(viz: VisualizerDef, effect: CK): string[];
  /** One frame's shader: uniforms from `features`, uSpectrum from its bands, then viz.children. */
  frameShader(
    viz: VisualizerDef,
    effect: CK,
    features: AudioFeatures,
    size: [number, number],
    time: number,
  ): CK;
  /** Encodes a canvas drawing as PNG bytes. */
  renderPng(width: number, height: number, draw: (canvas: CK) => void): Uint8Array;
  /** An image from raw RGBA pixels, e.g. a frame rendered by render-pool. */
  imageFromPixels(frame: { width: number; height: number; pixels: Uint8Array }): CK;
  drawLabel(canvas: CK, text: string, x: number, y: number, size: number): void;
}

export async function createHarness(): Promise<Harness> {
  const CK = await require(ckEntry)({ locateFile: (f: string) => join(ckEntry, '..', f) });
  const fontPath = MONO_FONTS.find((f) => existsSync(f)) ?? null;
  const typeface = fontPath
    ? CK.Typeface.MakeTypefaceFromData(new Uint8Array(readFileSync(fontPath)).buffer)
    : null;

  const spectrumShader = (bands: readonly number[]) => {
    const bytes = new Uint8Array(SPECTRUM_WIDTH * 4);
    encodeSpectrum(bands, bytes);
    const info = {
      width: SPECTRUM_WIDTH,
      height: 1,
      alphaType: CK.AlphaType.Opaque,
      colorType: CK.ColorType.RGBA_8888,
      colorSpace: CK.ColorSpace.SRGB,
    };
    return CK.MakeImage(info, bytes, SPECTRUM_WIDTH * 4).makeShaderOptions(
      CK.TileMode.Clamp,
      CK.TileMode.Clamp,
      CK.FilterMode.Linear,
      CK.MipmapMode.None,
    );
  };

  // Same layout as the app's GlyphAtlasShader, drawn at 3 px/dp and mapped back to dp space.
  const atlasCache = new Map<GlyphAtlasSpec, CK>();
  const glyphAtlasShader = (spec: GlyphAtlasSpec) => {
    const hit = atlasCache.get(spec);
    if (hit) return hit;
    const scale = 3;
    const { width, height } = atlasPixelSize(spec, scale);
    const surface = CK.MakeSurface(width, height);
    const canvas = surface.getCanvas();
    canvas.clear(CK.TRANSPARENT);
    const paint = new CK.Paint();
    paint.setColor(CK.WHITE);
    paint.setAntiAlias(true);
    if (typeface) {
      const font = new CK.Font(typeface, spec.fontSize * scale);
      const inkBounds = (char: string) => {
        const [l, , r] = font.getGlyphBounds(font.getGlyphIDs(char), paint);
        return { x: l, width: r - l };
      };
      for (const g of layoutGlyphs(spec, scale, font.getMetrics(), inkBounds)) {
        canvas.drawText(g.char, g.x, g.y, paint, font);
      }
    } else {
      // Placeholder: centred squares growing with the character index.
      const cw = spec.cellWidth * scale;
      const ch = spec.cellHeight * scale;
      [...spec.chars].forEach((_, i) => {
        const s = (i / (spec.chars.length - 1)) * Math.min(cw, ch) * 0.8;
        canvas.drawRect(CK.XYWHRect(i * cw + (cw - s) / 2, (ch - s) / 2, s, s), paint);
      });
    }
    const shader = surface
      .makeImageSnapshot()
      .makeShaderOptions(
        CK.TileMode.Clamp,
        CK.TileMode.Clamp,
        CK.FilterMode.Linear,
        CK.MipmapMode.None,
        CK.Matrix.scaled(1 / scale, 1 / scale),
      );
    atlasCache.set(spec, shader);
    return shader;
  };
  const childShader = (spec: ChildSpec) => {
    switch (spec.kind) {
      case 'glyphAtlas':
        return glyphAtlasShader(spec);
    }
  };

  const labelPaint = new CK.Paint();
  labelPaint.setColor(CK.Color(200, 200, 200));
  labelPaint.setAntiAlias(true);

  return {
    CK,
    fontPath,

    compile(viz) {
      let error = '';
      const effect = CK.RuntimeEffect.Make(viz.sksl, (msg: string) => {
        error = msg;
      });
      return effect ? { effect, error: null } : { effect: null, error };
    },

    contractProblems(viz, effect) {
      const problems: string[] = [];
      // Same rule as react-native-skia's processUniforms: every declared uniform needs a value.
      const missing: string[] = [];
      for (let i = 0; i < effect.getUniformCount(); i++) {
        const name = effect.getUniformName(i);
        if (!PROVIDED_UNIFORMS.includes(name)) missing.push(name);
      }
      if (missing.length) problems.push(`uniforms not provided by ShaderCanvas: ${missing.join(', ')}`);
      // Children are bound by position, so names and order must match exactly.
      const declared = declaredChildren(viz.sksl);
      const expected = [...PRELUDE_CHILDREN, ...viz.children.map((c) => c.name)];
      if (declared.join() !== expected.join()) {
        problems.push(
          `declared child shaders [${declared.join(', ')}] don't match provided [${expected.join(', ')}]`,
        );
      }
      return problems;
    },

    frameShader(viz, effect, features, size, time) {
      const all = shaderUniforms(features, size, time);
      const values: number[] = [];
      for (let i = 0; i < effect.getUniformCount(); i++) values.push(...all[effect.getUniformName(i)]);
      return effect.makeShaderWithChildren(values, [
        spectrumShader(features.bands),
        ...viz.children.map(childShader),
      ]);
    },

    renderPng(width, height, draw) {
      const surface = CK.MakeSurface(width, height);
      draw(surface.getCanvas());
      const png = surface.makeImageSnapshot().encodeToBytes();
      surface.delete();
      return png;
    },

    imageFromPixels({ width, height, pixels }) {
      const info = {
        width,
        height,
        colorType: CK.ColorType.RGBA_8888,
        alphaType: CK.AlphaType.Unpremul,
        colorSpace: CK.ColorSpace.SRGB,
      };
      return CK.MakeImage(info, pixels, width * 4);
    },

    drawLabel(canvas, text, x, y, size) {
      if (!typeface) return;
      const font = new CK.Font(typeface, size);
      canvas.drawText(text, x, y, labelPaint, font);
      font.delete();
    },
  };
}
