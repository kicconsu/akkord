// Encoding for the uSpectrum texture: one texel per band, 16-bit precision split across two
// 8-bit channels (R = high byte, G = low byte, B unused, A = 255). The SkSL decode is linear,
// so the GPU's linear filtering between neighbouring bands stays correct.
// Pure TS (and a worklet), shared by the app and scripts/check-shaders.ts.
import { BAND_COUNT } from '../audio/features';

export const SPECTRUM_WIDTH = BAND_COUNT;

/** Writes `bands` (0..1) into `out`, which must hold SPECTRUM_WIDTH × 4 bytes. */
export function encodeSpectrum(bands: readonly number[], out: Uint8Array): void {
  'worklet';
  for (let i = 0; i < SPECTRUM_WIDTH; i++) {
    const v = bands[i] ?? 0;
    const q = Math.round((v > 0 ? (v < 1 ? v : 1) : 0) * 65535);
    out[i * 4] = q >> 8;
    out[i * 4 + 1] = q & 255;
    out[i * 4 + 2] = 0;
    out[i * 4 + 3] = 255;
  }
}
