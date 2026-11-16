/// <reference types="node" />
// Worker thread for render-pool.ts: renders one visualizer frame per message with its own
// CanvasKit instance and posts back raw RGBA pixels.
import { parentPort } from 'node:worker_threads';

import { VISUALIZERS } from '../../src/viz/shaders';
import type { FrameJob, RenderedFrame } from './render-pool';
import { createHarness } from './skia-node';

const harness = createHarness();
const effects = new Map<string, unknown>();

parentPort!.on('message', async ({ index, job }: { index: number; job: FrameJob }) => {
  try {
    const h = await harness;
    const viz = VISUALIZERS.find((v) => v.id === job.vizId);
    if (!viz) throw new Error(`unknown visualizer ${job.vizId}`);
    if (!effects.has(viz.id)) {
      const { effect, error } = h.compile(viz);
      if (!effect) throw new Error(`${viz.id} failed to compile:\n${error}`);
      effects.set(viz.id, effect);
    }
    const width = Math.round(job.size[0] * job.scale);
    const height = Math.round(job.size[1] * job.scale);
    const surface = h.CK.MakeSurface(width, height);
    const canvas = surface.getCanvas();
    canvas.scale(job.scale, job.scale); // shaders work in dp, like on device
    const paint = new h.CK.Paint();
    paint.setShader(h.frameShader(viz, effects.get(viz.id), job.features, job.size, job.time));
    canvas.drawPaint(paint);
    const info = {
      width,
      height,
      colorType: h.CK.ColorType.RGBA_8888,
      alphaType: h.CK.AlphaType.Unpremul,
      colorSpace: h.CK.ColorSpace.SRGB,
    };
    const pixels = new Uint8Array(surface.makeImageSnapshot().readPixels(0, 0, info)); // own copy
    surface.delete();
    const frame: RenderedFrame = { width, height, pixels };
    parentPort!.postMessage({ index, frame }, [pixels.buffer]);
  } catch (e) {
    parentPort!.postMessage({ index, error: e instanceof Error ? e.message : String(e) });
  }
});
