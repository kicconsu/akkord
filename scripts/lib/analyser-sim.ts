/// <reference types="node" />
// Node simulation of the app's analysis path: a Web Audio AnalyserNode (Blackman window, |X|/N,
// temporal smoothing, dB) feeding FeatureExtractor once per display frame. react-native-audio-api
// follows the Web Audio spec, so this approximates what the app computes from the same audio.
// Differences: the app decodes at the device's sample rate and runs at the display's refresh rate.
import { readFileSync } from 'node:fs';

import { ANALYSER_SMOOTHING, FeatureExtractor, FFT_SIZE, type AudioFeatures } from '../../src/audio/features';

export interface Wav {
  sampleRate: number;
  /** Mono, -1..1: channels averaged, as the analyser downmixes its input. */
  samples: Float32Array;
  duration: number;
}

const CONVERT_HINT = 'Convert it first, e.g.: ffmpeg -i input.mp3 -ac 1 -c:a pcm_s16le output.wav';

/** Reads a PCM (8/16/24/32-bit) or float (32/64-bit) WAV with any channel count, as mono. */
export function readWav(path: string): Wav {
  const buf = readFileSync(path);
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${path} is not a WAV file. ${CONVERT_HINT}`);
  }

  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let dataStart = -1;
  let dataLength = 0;
  // Walk the chunks: real files carry LIST/fact/etc. chunks besides 'fmt ' and 'data'.
  for (let pos = 12; pos + 8 <= buf.length;) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      format = buf.readUInt16LE(body);
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
      // WAVE_FORMAT_EXTENSIBLE: the real format code opens the sub-format GUID.
      if (format === 0xfffe && size >= 40) format = buf.readUInt16LE(body + 24);
    } else if (id === 'data') {
      dataStart = body;
      dataLength = Math.min(size, buf.length - body); // tolerate truncated or streamed files
    }
    pos = body + size + (size & 1); // chunks are word-aligned
  }
  if (!sampleRate || !channels || dataStart < 0) throw new Error(`${path}: missing 'fmt ' or 'data' chunk.`);

  const isFloat = format === 3;
  if (!((format === 1 && [8, 16, 24, 32].includes(bits)) || (isFloat && (bits === 32 || bits === 64)))) {
    throw new Error(`${path}: unsupported WAV encoding (format ${format}, ${bits}-bit). ${CONVERT_HINT}`);
  }
  const bytes = bits / 8;
  const read = isFloat
    ? bits === 32
      ? (o: number) => buf.readFloatLE(o)
      : (o: number) => buf.readDoubleLE(o)
    : bits === 8
      ? (o: number) => (buf.readUInt8(o) - 128) / 128
      : bits === 16
        ? (o: number) => buf.readInt16LE(o) / 32768
        : bits === 24
          ? (o: number) => buf.readIntLE(o, 3) / 8388608
          : (o: number) => buf.readInt32LE(o) / 2147483648;

  const frameBytes = bytes * channels;
  const frames = Math.floor(dataLength / frameBytes);
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += read(dataStart + i * frameBytes + c * bytes);
    samples[i] = sum / channels;
  }
  return { sampleRate, samples, duration: frames / sampleRate };
}

export interface SimFrame {
  /** Track time in seconds. */
  time: number;
  features: AudioFeatures;
}

/**
 * Runs the analyser + FeatureExtractor over the track, one snapshot per display frame, from the
 * start (features depend on history: envelopes, phase, beat statistics) up to `until`.
 */
export function simulateAnalysis(wav: Wav, { fps = 60, until = wav.duration } = {}): SimFrame[] {
  const N = FFT_SIZE;
  const bins = N / 2;
  const levels = Math.log2(N);

  // Tables: Blackman window (Web Audio's alpha = 0.16), bit reversal, twiddle factors.
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    win[i] = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / N) + 0.08 * Math.cos((4 * Math.PI * i) / N);
  }
  const rev = new Uint32Array(N);
  for (let i = 0; i < N; i++) {
    let r = 0;
    for (let b = 0; b < levels; b++) r |= ((i >> b) & 1) << (levels - 1 - b);
    rev[i] = r;
  }
  const cosT = new Float64Array(N / 2);
  const sinT = new Float64Array(N / 2);
  for (let k = 0; k < N / 2; k++) {
    cosT[k] = Math.cos((2 * Math.PI * k) / N);
    sinT[k] = -Math.sin((2 * Math.PI * k) / N);
  }

  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const smoothed = new Float64Array(bins);
  const freqDb = new Float32Array(bins);
  const timeData = new Float32Array(N);
  const extractor = new FeatureExtractor({ sampleRate: wav.sampleRate, fftSize: N });
  const out: SimFrame[] = [];

  const last = Math.floor(Math.min(until, wav.duration) * fps);
  for (let f = 0; f <= last; f++) {
    const t = f / fps;
    // The analyser sees the most recent N samples.
    const end = Math.floor(t * wav.sampleRate);
    for (let i = 0; i < N; i++) {
      const s = end - N + i;
      const v = s >= 0 && s < wav.samples.length ? wav.samples[s] : 0;
      timeData[i] = v;
      re[rev[i]] = v * win[i];
      im[rev[i]] = 0;
    }
    // Iterative radix-2 FFT (decimation in time, input already in bit-reversed order).
    for (let size = 2; size <= N; size <<= 1) {
      const half = size >> 1;
      const step = N / size;
      for (let start = 0; start < N; start += size) {
        for (let k = 0; k < half; k++) {
          const wr = cosT[k * step];
          const wi = sinT[k * step];
          const a = start + k;
          const b = a + half;
          const tr = re[b] * wr - im[b] * wi;
          const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
    for (let k = 0; k < bins; k++) {
      const magnitude = Math.hypot(re[k], im[k]) / N;
      smoothed[k] = ANALYSER_SMOOTHING * smoothed[k] + (1 - ANALYSER_SMOOTHING) * magnitude;
      freqDb[k] = 20 * Math.log10(smoothed[k]); // -Infinity for silence, like the analyser
    }
    extractor.process(freqDb, timeData, 1 / fps);
    out.push({ time: t, features: extractor.snapshot() });
  }
  return out;
}
