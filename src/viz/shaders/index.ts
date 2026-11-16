import { ascii } from './ascii';
import { bars } from './bars';
import { galaxy } from './galaxy';
import type { VisualizerDef } from './common';

export type { ChildSpec, GlyphAtlasSpec, VisualizerDef } from './common';

/** Every visualizer the app offers, in picker order. */
export const VISUALIZERS: VisualizerDef[] = [bars, ascii, galaxy];
