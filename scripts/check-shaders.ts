/// <reference types="node" />
// Compiles every visualizer's SkSL with CanvasKit, so shader errors show up without a device,
// and checks the contract with ShaderCanvas: every declared uniform must be one it provides, and
// the declared `uniform shader`s must match the prelude's plus the visualizer's `children`.
//
//   npm run check:shaders                     compile all
//   npm run check:shaders -- --png out/dir    also render one preview PNG per shader
//
// For previews driven by real audio, use `npm run preview:shader`.
// Glyph atlases use a system monospace font when one is found (override with MONO_FONT=/path),
// otherwise placeholder blocks.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { BAND_COUNT, type AudioFeatures } from '../src/audio/features';
import { VISUALIZERS, type VisualizerDef } from '../src/viz/shaders';
import { renderFrames } from './lib/render-pool';
import { createHarness, numbered } from './lib/skia-node';

const pngIdx = process.argv.indexOf('--png');
const pngDir = pngIdx > 0 ? resolve(process.argv[pngIdx + 1] ?? 'shader-previews') : null;

// A plausible music-like frame: strong lows, rolling off, with some movement.
const SIZE: [number, number] = [390, 844]; // dp, like a phone
const SCALE = 1; // preview pixels per dp (preview:shader renders sharper sheets with --scale)
const FRAME: AudioFeatures = {
  bands: Array.from({ length: BAND_COUNT }, (_, i) => {
    const x = i / (BAND_COUNT - 1);
    return Math.max(0, Math.min(1, 0.9 - 0.55 * x + 0.12 * Math.sin(i * 0.9) + 0.08 * Math.sin(i * 2.3)));
  }),
  bass: 0.8,
  mid: 0.5,
  treble: 0.35,
  energy: 0.7,
  beat: 0.6,
  phase: 9.7,
  beatCount: 42,
};

async function main() {
  const h = await createHarness();
  console.log(h.fontPath ? `glyph font: ${h.fontPath}` : 'glyph font: none found, using placeholder blocks');
  let failed = 0;
  const passed: VisualizerDef[] = [];

  for (const viz of VISUALIZERS) {
    const { effect, error } = h.compile(viz);
    if (!effect) {
      failed++;
      console.error(`✗ ${viz.id}\n${error}\n${numbered(viz.sksl)}\n`);
      continue;
    }
    const problems = h.contractProblems(viz, effect);
    if (problems.length) {
      failed++;
      console.error(`✗ ${viz.id}: ${problems.join('; ')}`);
      continue;
    }
    const shader = h.frameShader(viz, effect, FRAME, SIZE, 12.3);
    if (!shader) {
      failed++;
      console.error(`✗ ${viz.id}: makeShaderWithChildren failed`);
      continue;
    }
    console.log(
      `✓ ${viz.id} (${effect.getUniformCount()} uniforms, ${1 + viz.children.length} child shaders)`,
    );
    passed.push(viz);
  }

  if (pngDir && passed.length) {
    // Rendered in parallel worker threads: CanvasKit evaluates shaders on the CPU.
    const frames = await renderFrames(
      passed.map((viz) => ({ vizId: viz.id, features: FRAME, time: 12.3, size: SIZE, scale: SCALE })),
    );
    mkdirSync(pngDir, { recursive: true });
    passed.forEach((viz, i) => {
      const frame = frames[i];
      const png = h.renderPng(frame.width, frame.height, (canvas) => {
        canvas.drawImage(h.imageFromPixels(frame), 0, 0);
      });
      const file = join(pngDir, `${viz.id}.png`);
      writeFileSync(file, png);
      console.log(`preview → ${file}`);
    });
  }

  if (failed) {
    console.error(`\n${failed} shader(s) failed`);
    process.exit(1);
  }
}

main();
