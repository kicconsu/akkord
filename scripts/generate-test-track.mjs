#!/usr/bin/env node
// Generates assets/audio/test-pattern.wav, a deterministic track for validating the visualizer:
//   0–8 s   log sine sweep 40 Hz → 12 kHz. One band should light up and travel left → right.
//   8–24 s  120 BPM groove: kick on every beat, snare on 2 and 4, offbeat hats, bass line, pad.
//           Beats should fire exactly on the kicks (every 0.5 s starting at 8.0 s).
// Usage: node scripts/generate-test-track.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SR = 44100;
const SWEEP_END = 8;
const DURATION = 24;
const BPM = 120;
const BEAT = 60 / BPM;
const out = new Float32Array(SR * DURATION);

// Deterministic white noise (LCG) so the file is reproducible.
let seed = 1234567;
const noise = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 31 - 1;
};

const add = (startSec, lengthSec, fn) => {
  const s0 = Math.round(startSec * SR);
  const n = Math.round(lengthSec * SR);
  for (let i = 0; i < n && s0 + i < out.length; i++) out[s0 + i] += fn(i / SR, i);
};

// Section A: logarithmic sine sweep with 50 ms fades.
{
  const f0 = 40;
  const f1 = 12000;
  let phase = 0;
  add(0, SWEEP_END, (t) => {
    const f = f0 * Math.pow(f1 / f0, t / SWEEP_END);
    phase += (2 * Math.PI * f) / SR;
    const fade = Math.min(1, t / 0.05, (SWEEP_END - t) / 0.05);
    return 0.5 * fade * Math.sin(phase);
  });
}

// Section B: groove.
const beats = Math.round((DURATION - SWEEP_END) / BEAT);
for (let b = 0; b < beats; b++) {
  const t0 = SWEEP_END + b * BEAT;

  // Kick: pitch-swept sine with fast decay.
  {
    let phase = 0;
    add(t0, 0.4, (t) => {
      const f = 48 + 110 * Math.exp(-t / 0.03);
      phase += (2 * Math.PI * f) / SR;
      return 0.9 * Math.exp(-t / 0.18) * Math.sin(phase);
    });
  }

  // Snare on beats 2 and 4: noise burst plus body tone.
  if (b % 2 === 1) {
    add(
      t0,
      0.25,
      (t) =>
        0.3 * Math.exp(-t / 0.07) * noise() + 0.25 * Math.exp(-t / 0.05) * Math.sin(2 * Math.PI * 190 * t),
    );
  }

  // Closed hat on the offbeat: high-passed noise (first difference), very short.
  {
    let prev = 0;
    add(t0 + BEAT / 2, 0.08, (t) => {
      const n = noise();
      const hp = n - prev;
      prev = n;
      return 0.18 * Math.exp(-t / 0.015) * hp;
    });
  }
}

// Bass line: one note per beat, A–A–F–G per bar, 4 harmonics (saw-ish).
{
  const notes = [55, 55, 43.65, 49];
  for (let b = 0; b < beats; b++) {
    const f = notes[b % 4];
    add(SWEEP_END + b * BEAT, BEAT * 0.95, (t) => {
      const env = Math.min(1, t / 0.01) * Math.exp(-t / 0.35);
      let s = 0;
      for (let h = 1; h <= 4; h++) s += Math.sin(2 * Math.PI * f * h * t) / h;
      return 0.22 * env * s;
    });
  }
}

// Pad: A major triad, slow swell, for the mid bands.
add(SWEEP_END, DURATION - SWEEP_END, (t) => {
  const swell = 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / 8);
  const fade = Math.min(1, (DURATION - SWEEP_END - t) / 0.5);
  return (
    0.05 *
    swell *
    fade *
    (Math.sin(2 * Math.PI * 220 * t) +
      Math.sin(2 * Math.PI * 277.18 * t) +
      Math.sin(2 * Math.PI * 329.63 * t))
  );
});

// Soft-clip the groove only (the sweep must stay a pure tone; tanh would add odd harmonics),
// then normalize to -1 dBFS peak.
let peak = 0;
for (let i = 0; i < out.length; i++) {
  if (i >= SWEEP_END * SR) out[i] = Math.tanh(out[i]);
  peak = Math.max(peak, Math.abs(out[i]));
}
const gain = 0.89 / peak;

// 16-bit mono PCM WAV.
const data = Buffer.alloc(out.length * 2);
for (let i = 0; i < out.length; i++)
  data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, out[i] * gain)) * 32767), i * 2);
const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + data.length, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20); // PCM
header.writeUInt16LE(1, 22); // mono
header.writeUInt32LE(SR, 24);
header.writeUInt32LE(SR * 2, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write('data', 36);
header.writeUInt32LE(data.length, 40);

const target = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'audio', 'test-pattern.wav');
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, Buffer.concat([header, data]));
console.log(`wrote ${target} (${DURATION}s, ${(data.length / 1e6).toFixed(1)} MB)`);
