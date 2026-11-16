import { Skia, type SkRuntimeEffect } from '@shopify/react-native-skia';

import type { VisualizerDef } from './shaders';

export type CompileResult = { effect: SkRuntimeEffect; error: null } | { effect: null; error: string };

const cache = new Map<string, CompileResult>();

/**
 * Compiles a visualizer's SkSL once per source string. Edited shaders recompile on Fast
 * Refresh because the source changes. Errors come back as text with numbered source lines,
 * since Skia reports positions as "error: <line>: ...".
 */
export function compileVisualizer(viz: VisualizerDef): CompileResult {
  const key = `${viz.id}\n${viz.sksl}`;
  const hit = cache.get(key);
  if (hit) return hit;

  let result: CompileResult;
  try {
    // react-native-skia throws "Error in sksl: ..." on failure; older versions returned null.
    const effect = Skia.RuntimeEffect.Make(viz.sksl);
    result = effect ? { effect, error: null } : { effect: null, error: 'RuntimeEffect.Make returned null' };
  } catch (e) {
    result = { effect: null, error: e instanceof Error ? e.message : String(e) };
  }

  if (result.error) {
    const numbered = viz.sksl
      .split('\n')
      .map((line, i) => `${String(i + 1).padStart(4)} | ${line}`)
      .join('\n');
    console.error(`[shader:${viz.id}] ${result.error}\n${numbered}`);
  }
  cache.set(key, result);
  return result;
}
