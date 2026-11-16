// Playback + analysis graph:  AudioBufferSourceNode → AnalyserNode → destination.
// Files are fully decoded to PCM (simple, and makes seeking trivial). A source node can only
// be started once, so pause/seek stop the current node and start a new one at an offset.
import {
  AudioContext,
  AudioManager,
  type AnalyserNode,
  type AudioBuffer,
  type AudioBufferSourceNode,
} from 'react-native-audio-api';

import { ANALYSER_SMOOTHING, FFT_SIZE } from './features';
import type { Track } from './tracks';

export type PlaybackStatus = 'idle' | 'loading' | 'paused' | 'playing' | 'error';

export interface EngineState {
  status: PlaybackStatus;
  track: Track | null;
  /** Seconds; 0 until a track is decoded. */
  duration: number;
  error: string | null;
}

type Listener = () => void;

class AudioEngine {
  private ctx: AudioContext | null = null;
  private analyserNode: AnalyserNode | null = null;
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  /** Context time that corresponds to track position 0 while playing. */
  private startedAt = 0;
  /** Track position while not playing. */
  private pausedAt = 0;
  private loadToken = 0;
  private state: EngineState = { status: 'idle', track: null, duration: 0, error: null };
  private readonly listeners = new Set<Listener>();

  // Arrow properties so they can be passed straight to useSyncExternalStore.
  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = (): EngineState => this.state;

  /** Null until the first load(). */
  get analyser(): AnalyserNode | null {
    return this.analyserNode;
  }

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 44100;
  }

  get isPlaying(): boolean {
    return this.state.status === 'playing';
  }

  /** Current track position in seconds. */
  get position(): number {
    if (this.state.status === 'playing' && this.ctx) {
      return Math.min(Math.max(this.ctx.currentTime - this.startedAt, 0), this.state.duration);
    }
    return this.pausedAt;
  }

  async load(track: Track): Promise<void> {
    const token = ++this.loadToken;
    this.stopSource();
    this.buffer = null;
    this.pausedAt = 0;
    this.setState({ status: 'loading', track, duration: 0, error: null });
    try {
      const ctx = this.ensureContext();
      const buffer = await ctx.decodeAudioData(track.source);
      if (token !== this.loadToken) return; // a newer load() superseded this one
      this.buffer = buffer;
      this.setState({ status: 'paused', duration: buffer.duration });
    } catch (e) {
      if (token !== this.loadToken) return;
      this.setState({ status: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  }

  play(): void {
    if (!this.buffer || this.state.status !== 'paused') return;
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const offset = this.pausedAt >= this.state.duration ? 0 : this.pausedAt;
    this.startSource(offset);
    this.setState({ status: 'playing' });
  }

  pause(): void {
    if (this.state.status !== 'playing') return;
    this.pausedAt = this.position; // read before the status flips
    this.stopSource();
    this.setState({ status: 'paused' });
  }

  toggle(): void {
    if (this.state.status === 'playing') this.pause();
    else this.play();
  }

  seek(seconds: number): void {
    if (!this.buffer) return;
    const target = Math.min(Math.max(seconds, 0), this.state.duration);
    if (this.state.status === 'playing') {
      this.stopSource();
      this.startSource(target);
    } else {
      this.pausedAt = target;
    }
  }

  private ensureContext(): AudioContext {
    if (this.ctx) return this.ctx;
    // iOS: 'playback' keeps audio playing with the silent switch on.
    AudioManager.setSystemOptions({ ios: { category: 'playback', mode: 'default' } });
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    analyser.smoothingTimeConstant = ANALYSER_SMOOTHING;
    analyser.connect(ctx.destination);
    this.ctx = ctx;
    this.analyserNode = analyser;
    return ctx;
  }

  private startSource(offset: number): void {
    const ctx = this.ctx;
    const analyser = this.analyserNode;
    if (!ctx || !analyser || !this.buffer) return;
    const src = ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(analyser);
    src.onended = () => {
      if (this.source !== src) return; // stopped by pause/seek/load, not by reaching the end
      this.source = null;
      this.pausedAt = 0;
      this.setState({ status: 'paused' });
    };
    src.start(0, offset);
    this.source = src;
    this.startedAt = ctx.currentTime - offset;
  }

  private stopSource(): void {
    const src = this.source;
    if (!src) return;
    this.source = null; // clear first so the onended guard ignores this stop
    src.onended = null;
    try {
      src.stop();
    } catch {
      // already stopped
    }
    src.disconnect();
  }

  private setState(patch: Partial<EngineState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }
}

/** App-wide singleton: there is one audio graph. */
export const audioEngine = new AudioEngine();
