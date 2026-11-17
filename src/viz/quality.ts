import type { VisualizerDef } from './shaders';

export type Quality = 'high' | 'balanced' | 'saver';

export const QUALITY_OPTIONS = [
  { value: 'high', label: 'High' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'saver', label: 'Saver' },
] as const satisfies readonly { value: Quality; label: string }[];

/** Multiplies each visualizer's own renderScale. */
const QUALITY_FACTOR: Record<Quality, number> = { high: 1, balanced: 0.75, saver: 0.5 };

/** Fraction of screen resolution to render `viz` at (0..1]. Pure, so it can be tested in Node. */
export function effectiveRenderScale(viz: VisualizerDef, quality: Quality): number {
  const scale = viz.renderScale * QUALITY_FACTOR[quality];
  return Math.min(1, Math.max(scale, viz.minRenderScale, 0.25));
}
