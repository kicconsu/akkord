import { defineVisualizer } from './common';

// Classic spectrum bars standing on a baseline, with glowing caps and a fading reflection.
export const bars = defineVisualizer(
  'bars',
  'Spectrum bars',
  /* glsl */ `
half4 main(float2 fragCoord) {
  float2 uv = fragCoord / uResolution;   // 0..1, y down
  float px = 1.0 / uResolution.y;        // one pixel in uv.y units (no dFdx in SkSL)

  const float baseY = 0.62;              // baseline, from the top
  const float maxH = 0.42;               // tallest bar, fraction of height
  const float margin = 0.04;

  // Background: dark gradient plus a bass glow hugging the baseline.
  float3 col = mix(float3(0.015, 0.015, 0.04), float3(0.05, 0.02, 0.09), uv.y);
  col += float3(0.30, 0.06, 0.40) * uBass * 0.35 * exp(-abs(uv.y - baseY) * 7.0);

  float x = (uv.x - margin) / (1.0 - 2.0 * margin);
  if (x >= 0.0 && x < 1.0) {
    float fx = x * float(BAND_COUNT);
    int idx = int(floor(fx));
    float cell = fract(fx);
    float level = band(idx);
    float h = max(level * maxH, 2.0 * px);

    // Horizontal coverage, anti-aliased: the bar fills 70% of its cell.
    float cellPx = (1.0 - 2.0 * margin) * uResolution.x / float(BAND_COUNT);
    float halfPx = 0.35 * cellPx;
    float dx = abs(cell - 0.5) * cellPx;
    float mx = 1.0 - smoothstep(halfPx - 0.75, halfPx + 0.75, dx);

    float3 barCol = palette(float(idx) / float(BAND_COUNT) * 0.75 + uTime * 0.02,
                            float3(0.5), float3(0.5), float3(1.0), float3(0.0, 0.33, 0.67));
    barCol *= 0.55 + 0.6 * level + 0.4 * uBeat;

    // Bar body above the baseline, brighter toward the top.
    float up = baseY - uv.y;
    float my = smoothstep(-px, px, up) * (1.0 - smoothstep(h - px, h + px, up));
    float g = clamp(up / h, 0.0, 1.0);
    col = mix(col, barCol * (0.55 + 0.65 * g), mx * my);

    // Soft glow around the cap (falls to 1/e about 12 px away).
    col += barCol * mx * exp(-abs(up - h) * uResolution.y * 0.08) * 0.35;

    // Reflection below the baseline.
    float down = uv.y - baseY;
    float mr = step(0.0, down) * (1.0 - smoothstep(h * 0.6 - px, h * 0.6 + px, down));
    col += barCol * mx * mr * exp(-down * 9.0) * 0.25;
  }

  col += float3(0.03, 0.02, 0.05) * uBeat;             // beat lift
  float2 c = uv - 0.5;
  col *= 1.0 - 0.7 * dot(c, c);                         // vignette
  return half4(half3(col), 1.0);
}
`,
);
