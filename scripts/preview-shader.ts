/// <reference types="node" />
// Renders visualizers at real moments of a track, side by side, so shaders can be tuned without
// a device. Audio goes through a Node simulation of the app's analysis (scripts/lib/analyser-sim.ts)
// and shaders through CanvasKit (scripts/lib/skia-node.ts).
//
//   npm run preview:shader                            every visualizer, test pattern, auto moments
//   npm run preview:shader -- galaxy ascii            only these visualizers
//   npm run preview:shader -- galaxy --at 4,12.1      panels at these track times (seconds)
//   npm run preview:shader -- galaxy --track song.wav tune on real music (WAV; convert with ffmpeg)
//
// Options: --size 390x844 (panel size in dp)  --scale 2 (pixels per dp)  --out shader-previews
// Auto moments: silence, the strongest beat, 0.1 s and 0.25 s after it, the loudest, the most
// treble-heavy and the quietest moment. Results are approximations of the device (see the libs).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { EMPTY_FEATURES, type AudioFeatures } from '../src/audio/features';
import { VISUALIZERS } from '../src/viz/shaders';
import { readWav, simulateAnalysis, type SimFrame, type Wav } from './lib/analyser-sim';
import { renderFrames, type FrameJob } from './lib/render-pool';
import { createHarness, numbered } from './lib/skia-node';

const FPS = 60;
const LABEL_H = 22; // dp above each panel

const USAGE = `usage: npm run preview:shader -- [visualizer ids...] [--at t1,t2,...] [--track file.wav]
                                [--size WxH] [--scale n] [--out dir]
visualizers: ${VISUALIZERS.map((v) => v.id).join(', ')}`;

interface Panel {
  label: string;
  features: AudioFeatures;
  time: number;
}

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const ids: string[] = [];
  const opts = {
    at: null as number[] | null,
    track: join(__dirname, '..', 'assets', 'audio', 'test-pattern.wav'),
    size: [390, 844] as [number, number],
    scale: 1,
    out: 'shader-previews',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => argv[++i] ?? fail(`${arg} needs a value`);
    if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else if (arg === '--at') {
      opts.at = value()
        .split(',')
        .map((s) => Number(s));
      if (opts.at.some((t) => !Number.isFinite(t) || t < 0))
        fail('--at expects times in seconds, e.g. 4,12.1');
    } else if (arg === '--track') opts.track = resolve(value());
    else if (arg === '--size') {
      const m = /^(\d+)x(\d+)$/.exec(value());
      if (!m) fail('--size expects WxH in dp, e.g. 390x844');
      opts.size = [Number(m[1]), Number(m[2])];
    } else if (arg === '--scale') {
      opts.scale = Number(value());
      if (!(opts.scale > 0 && opts.scale <= 4)) fail('--scale expects a number between 0 and 4');
    } else if (arg === '--out') opts.out = value();
    else if (arg.startsWith('-')) fail(`unknown option ${arg}`);
    else ids.push(arg);
  }
  const unknown = ids.filter((id) => !VISUALIZERS.some((v) => v.id === id));
  if (unknown.length) fail(`unknown visualizer: ${unknown.join(', ')}`);
  return { ids, ...opts };
}

const fmt = (t: number) => `${t.toFixed(2)}s`;

/** Silence plus the moments that show the most about a visualizer. */
function autoMoments(frames: SimFrame[], duration: number): Panel[] {
  const panels: Panel[] = [{ label: 'silence', features: EMPTY_FEATURES, time: 0 }];
  const used = new Set<number>();
  const add = (label: string, index: number) => {
    const fr = frames[index];
    if (!fr || used.has(index)) return;
    used.add(index);
    panels.push({ label: `${label} ${fmt(fr.time)}`, features: fr.features, time: fr.time });
  };
  // Skip the first second, while envelopes and beat statistics settle.
  const start = Math.min(FPS, Math.floor(frames.length * 0.05));
  const body = frames.slice(start).map((fr, i) => ({ ...fr, index: start + i }));
  const best = (score: (f: AudioFeatures) => number, from = body) =>
    from.reduce((a, b) => (score(b.features) > score(a.features) ? b : a), from[0]);

  const beats = body.filter((fr) => fr.features.beat === 1);
  if (beats.length) {
    const beat = best((f) => f.bass, beats);
    add('beat', beat.index);
    add('beat +0.1s', beat.index + Math.round(0.1 * FPS));
    add('beat +0.25s', beat.index + Math.round(0.25 * FPS));
  } else {
    console.log('no beats detected in the track: skipping the beat panels');
  }
  if (body.length) {
    add('loudest', best((f) => f.energy).index);
    add('most treble', best((f) => f.treble).index);
    const audible = body.filter((fr) => fr.features.energy >= 0.05);
    if (audible.length) add('quietest', best((f) => -f.energy, audible).index);
  }
  if (duration < 2) console.log('the track is very short: moments may be unrepresentative');
  return panels;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const vizs = args.ids.length ? VISUALIZERS.filter((v) => args.ids.includes(v.id)) : VISUALIZERS;

  let wav: Wav;
  try {
    wav = readWav(args.track);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
  const tooLate = args.at?.filter((t) => t > wav.duration);
  if (tooLate?.length) fail(`--at ${tooLate.join(', ')} is past the end of the track (${fmt(wav.duration)})`);

  const until = args.at ? Math.max(...args.at) : wav.duration;
  const frames = simulateAnalysis(wav, { fps: FPS, until });
  const panels: Panel[] = args.at
    ? args.at.map((t) => {
        const fr = frames[Math.min(Math.round(t * FPS), frames.length - 1)];
        return { label: fmt(fr.time), features: fr.features, time: fr.time };
      })
    : autoMoments(frames, wav.duration);

  console.log(`track: ${args.track} (${fmt(wav.duration)}, ${wav.sampleRate} Hz)`);
  for (const p of panels) {
    const f = p.features;
    console.log(
      `  ${p.label.padEnd(22)} bass ${f.bass.toFixed(2)}  mid ${f.mid.toFixed(2)}  treble ${f.treble.toFixed(2)}` +
        `  energy ${f.energy.toFixed(2)}  beat ${f.beat.toFixed(2)}  phase ${f.phase.toFixed(2)}  beats ${f.beatCount}`,
    );
  }

  const h = await createHarness();
  if (!h.fontPath)
    console.log('no monospace font found: placeholder glyphs, no labels (set MONO_FONT=/path)');

  // Compile and contract-check here, where errors print readably; then render in parallel.
  const ready = vizs.filter((viz) => {
    const { effect, error } = h.compile(viz);
    if (!effect) {
      console.error(`✗ ${viz.id}\n${error}\n${numbered(viz.sksl)}\n`);
      return false;
    }
    const problems = h.contractProblems(viz, effect);
    if (problems.length) console.error(`✗ ${viz.id}: ${problems.join('; ')}`);
    return problems.length === 0;
  });
  const jobs: FrameJob[] = ready.flatMap((viz) =>
    panels.map((p) => ({
      vizId: viz.id,
      features: p.features,
      time: p.time,
      size: args.size,
      scale: args.scale,
    })),
  );
  const started = Date.now();
  const rendered = await renderFrames(jobs);
  console.log(`rendered ${jobs.length} frames in ${((Date.now() - started) / 1000).toFixed(1)} s`);

  const { scale } = args;
  mkdirSync(args.out, { recursive: true });
  ready.forEach((viz, v) => {
    const row = rendered.slice(v * panels.length, (v + 1) * panels.length);
    const labelH = Math.round(LABEL_H * scale);
    const png = h.renderPng(row[0].width * row.length, row[0].height + labelH, (canvas) => {
      canvas.clear(h.CK.BLACK);
      row.forEach((frame, i) => {
        h.drawLabel(canvas, panels[i].label, i * frame.width + 8 * scale, 16 * scale, 13 * scale);
        canvas.drawImage(h.imageFromPixels(frame), i * frame.width, labelH);
      });
    });
    const file = resolve(args.out, `${viz.id}.png`);
    writeFileSync(file, png);
    console.log(`✓ ${viz.id} → ${file}`);
  });
  if (ready.length < vizs.length) process.exit(1);
}

main();
