/// <reference types="node" />
// Renders visualizer frames in parallel worker threads. CanvasKit evaluates shaders on the CPU
// (a heavy shader takes seconds per phone-sized frame), so each frame gets its own core.
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

import type { AudioFeatures } from '../../src/audio/features';

export interface FrameJob {
  vizId: string;
  features: AudioFeatures;
  /** uTime, in seconds. */
  time: number;
  /** Frame size in dp. */
  size: [number, number];
  /** Pixels per dp. */
  scale: number;
}

export interface RenderedFrame {
  width: number;
  height: number;
  /** RGBA, unpremultiplied, sRGB. */
  pixels: Uint8Array;
}

/** Renders every job, using up to one worker per spare core. Results keep the jobs' order. */
export function renderFrames(jobs: FrameJob[]): Promise<RenderedFrame[]> {
  const results: RenderedFrame[] = new Array(jobs.length);
  if (!jobs.length) return Promise.resolve(results);
  const count = Math.max(1, Math.min(jobs.length, availableParallelism() - 1));

  return new Promise((resolve, reject) => {
    const workers: Worker[] = [];
    let next = 0;
    let done = 0;
    let failed = false;
    const finish = (error?: Error) => {
      if (failed) return;
      if (error) failed = true;
      workers.forEach((w) => w.terminate());
      if (error) reject(error);
      else resolve(results);
    };
    const dispatch = (worker: Worker) => {
      if (next < jobs.length) {
        const index = next++;
        worker.postMessage({ index, job: jobs[index] });
      }
    };

    for (let i = 0; i < count; i++) {
      // Worker threads inherit tsx's loader from the parent, so they can run TypeScript directly.
      const worker = new Worker(join(__dirname, 'render-worker.ts'));
      workers.push(worker);
      worker.on('message', (msg: { index: number; frame?: RenderedFrame; error?: string }) => {
        if (msg.error || !msg.frame) return finish(new Error(msg.error ?? 'worker returned no frame'));
        results[msg.index] = msg.frame;
        if (++done === jobs.length) finish();
        else dispatch(worker);
      });
      worker.on('error', (e) => finish(e instanceof Error ? e : new Error(String(e))));
      dispatch(worker);
    }
  });
}
