// Turns raw analyser output (dB spectrum + time-domain samples) into a small set of
// shader-friendly numbers: log-spaced bands, region levels, loudness and a beat impulse.
// This file is pure TypeScript with no React Native imports, so it can be tested in Node.

export const BAND_COUNT = 64;

/** AnalyserNode settings the extractor is tuned for. Shared by the engine and the Node
 *  simulation in scripts/lib/analyser-sim.ts, so both analyse audio the same way. */
export const FFT_SIZE = 2048;
/** Kept low: the extractor applies its own attack/release envelopes, and beat detection needs
 *  sharp onsets. */
export const ANALYSER_SMOOTHING = 0.3;

export interface AudioFeatures {
  /** BAND_COUNT smoothed levels, 0..1, low → high frequency (log-spaced). */
  bands: number[];
  /** Mean band level per region, 0..1. */
  bass: number;
  mid: number;
  treble: number;
  /** Overall loudness from time-domain RMS, 0..1. */
  energy: number;
  /** 1 on a detected beat, then decays toward 0. */
  beat: number;
  /** Music-driven time: advances faster when louder (about 1/s at typical loudness). Use it
   *  instead of multiplying uTime by an audio value, which makes animations jump. */
  phase: number;
  /** Number of beats detected so far. */
  beatCount: number;
}

export const EMPTY_FEATURES: AudioFeatures = {
  bands: new Array<number>(BAND_COUNT).fill(0),
  bass: 0,
  mid: 0,
  treble: 0,
  energy: 0,
  beat: 0,
  phase: 0,
  beatCount: 0,
};

export interface FeatureConfig {
  sampleRate: number;
  fftSize: number;
  bandCount: number;
  /** Frequency range covered by the bands. */
  minHz: number;
  maxHz: number;
  /** dB values mapped to 0 and 1 (after tilt). */
  floorDb: number;
  ceilDb: number;
  /** Boost per octave above `tiltPivotHz` (and cut below). Music spectra fall off with
   *  frequency, so without this the high bands barely move. */
  tiltDbPerOctave: number;
  tiltPivotHz: number;
  /** Envelope time constants in seconds: fast rise, slower fall. */
  attack: number;
  release: number;
  bassHz: [number, number];
  midHz: [number, number];
  trebleHz: [number, number];
  /** Loudness range (RMS in dBFS) mapped to energy 0..1. */
  energyFloorDb: number;
  energyCeilDb: number;
  /** Beat detection: spectral flux over `beatHz` against an adaptive threshold. */
  beatHz: [number, number];
  /** Threshold = mean + sensitivity × std-dev of recent flux. Lower fires more often. */
  beatSensitivity: number;
  /** Absolute flux floor so near-silence never triggers. */
  beatMinFlux: number;
  /** Time constant (s) of the running flux statistics. */
  beatHistory: number;
  /** Minimum time (s) between beats. */
  beatMinInterval: number;
  /** Decay time constant (s) of the beat impulse. */
  beatDecay: number;
  /** phase advances by dt × (phaseBaseSpeed + phaseEnergySpeed × energy). */
  phaseBaseSpeed: number;
  phaseEnergySpeed: number;
}

export const DEFAULT_FEATURE_CONFIG: Omit<FeatureConfig, 'sampleRate' | 'fftSize'> = {
  bandCount: BAND_COUNT,
  minHz: 30,
  maxHz: 16000,
  floorDb: -85,
  ceilDb: -30,
  tiltDbPerOctave: 3,
  tiltPivotHz: 1000,
  attack: 0.025,
  release: 0.22,
  bassHz: [20, 250],
  midHz: [250, 4000],
  trebleHz: [4000, 20000],
  energyFloorDb: -40,
  energyCeilDb: -4,
  beatHz: [30, 150],
  beatSensitivity: 1.5,
  beatMinFlux: 0.04,
  beatHistory: 1.0,
  beatMinInterval: 0.22,
  beatDecay: 0.12,
  phaseBaseSpeed: 0.2,
  phaseEnergySpeed: 1.0,
};

const clamp01 = (v: number) => (v > 0 ? (v < 1 ? v : 1) : 0); // also maps NaN to 0

export class FeatureExtractor {
  readonly config: FeatureConfig;
  /** Smoothed band levels, 0..1. Read after `process()`. */
  readonly bands: Float32Array;
  bass = 0;
  mid = 0;
  treble = 0;
  energy = 0;
  beat = 0;
  phase = 0;
  beatCount = 0;

  private readonly raw: Float32Array;
  private readonly prevRaw: Float32Array;
  /** Fractional FFT bin range [lo, hi) and center per band. */
  private readonly binLo: Float32Array;
  private readonly binHi: Float32Array;
  private readonly binCenter: Float32Array;
  private readonly tiltDb: Float32Array;
  private readonly bassRange: [number, number];
  private readonly midRange: [number, number];
  private readonly trebleRange: [number, number];
  private readonly beatRange: [number, number];
  private fluxMean = 0;
  private fluxVar = 0;
  private sinceBeat = Infinity;
  private silentFreq: Float32Array | null = null;
  private silentTime: Float32Array | null = null;

  constructor(config: Pick<FeatureConfig, 'sampleRate' | 'fftSize'> & Partial<FeatureConfig>) {
    this.config = { ...DEFAULT_FEATURE_CONFIG, ...config };
    const { bandCount, minHz, sampleRate, fftSize, tiltDbPerOctave, tiltPivotHz } = this.config;
    const maxHz = Math.min(this.config.maxHz, sampleRate * 0.475);
    const binHz = sampleRate / fftSize;

    this.bands = new Float32Array(bandCount);
    this.raw = new Float32Array(bandCount);
    this.prevRaw = new Float32Array(bandCount);
    this.binLo = new Float32Array(bandCount);
    this.binHi = new Float32Array(bandCount);
    this.binCenter = new Float32Array(bandCount);
    this.tiltDb = new Float32Array(bandCount);

    const centerHz = new Float32Array(bandCount);
    const ratio = maxHz / minHz;
    for (let i = 0; i < bandCount; i++) {
      const lo = minHz * Math.pow(ratio, i / bandCount);
      const hi = minHz * Math.pow(ratio, (i + 1) / bandCount);
      centerHz[i] = Math.sqrt(lo * hi);
      this.binLo[i] = lo / binHz;
      this.binHi[i] = hi / binHz;
      this.binCenter[i] = centerHz[i] / binHz;
      this.tiltDb[i] = tiltDbPerOctave * Math.log2(centerHz[i] / tiltPivotHz);
    }

    const range = ([a, b]: [number, number]): [number, number] => {
      let start = -1;
      let end = -1;
      for (let i = 0; i < bandCount; i++) {
        if (centerHz[i] >= a && centerHz[i] < b) {
          if (start < 0) start = i;
          end = i + 1;
        }
      }
      return start < 0 ? [0, 0] : [start, end];
    };
    this.bassRange = range(this.config.bassHz);
    this.midRange = range(this.config.midHz);
    this.trebleRange = range(this.config.trebleHz);
    this.beatRange = range(this.config.beatHz);
  }

  /**
   * @param freqDb   analyser.getFloatFrequencyData output (dB, may contain -Infinity)
   * @param timeData analyser.getFloatTimeDomainData output (-1..1)
   * @param dt       seconds since the previous call
   */
  process(freqDb: Float32Array, timeData: Float32Array, dt: number): void {
    const { bandCount, floorDb, ceilDb, attack, release } = this.config;
    const lastBin = freqDb.length - 1;
    const dbSpan = ceilDb - floorDb;
    const aAttack = 1 - Math.exp(-dt / attack);
    const aRelease = 1 - Math.exp(-dt / release);

    for (let i = 0; i < bandCount; i++) {
      const lo = this.binLo[i];
      const hi = this.binHi[i];
      let db: number;
      if (hi - lo < 1) {
        // Band narrower than one FFT bin (low end): interpolate at the band center.
        const c = this.binCenter[i];
        const k = Math.min(Math.max(Math.floor(c), 1), lastBin - 1);
        const t = Math.min(Math.max(c - k, 0), 1);
        const a = freqDb[k];
        const b = freqDb[k + 1];
        db = a === -Infinity || b === -Infinity ? Math.max(a, b) : a + (b - a) * t;
      } else {
        // Wide band: loudest bin inside it.
        const k0 = Math.max(Math.ceil(lo), 1);
        const k1 = Math.min(Math.max(Math.floor(hi), k0), lastBin);
        db = -Infinity;
        for (let k = k0; k <= k1; k++) if (freqDb[k] > db) db = freqDb[k];
      }
      const level = clamp01((db + this.tiltDb[i] - floorDb) / dbSpan);
      this.prevRaw[i] = this.raw[i];
      this.raw[i] = level;
      const cur = this.bands[i];
      this.bands[i] = cur + (level - cur) * (level > cur ? aAttack : aRelease);
    }

    this.bass = this.mean(this.bassRange);
    this.mid = this.mean(this.midRange);
    this.treble = this.mean(this.trebleRange);

    // Loudness from RMS.
    let sum = 0;
    for (let i = 0; i < timeData.length; i++) sum += timeData[i] * timeData[i];
    const rmsDb = 10 * Math.log10(sum / Math.max(timeData.length, 1) + 1e-12);
    const { energyFloorDb, energyCeilDb } = this.config;
    const energyTarget = clamp01((rmsDb - energyFloorDb) / (energyCeilDb - energyFloorDb));
    this.energy += (energyTarget - this.energy) * (energyTarget > this.energy ? aAttack : aRelease);

    // Integrated, so speed changes never make the value jump.
    this.phase += dt * (this.config.phaseBaseSpeed + this.config.phaseEnergySpeed * this.energy);

    this.detectBeat(dt);
  }

  /** Feed silence, e.g. while paused, so every envelope releases naturally. */
  processSilence(binCount: number, fftSize: number, dt: number): void {
    if (this.silentFreq?.length !== binCount) this.silentFreq = new Float32Array(binCount).fill(-Infinity);
    if (this.silentTime?.length !== fftSize) this.silentTime = new Float32Array(fftSize);
    this.process(this.silentFreq, this.silentTime, dt);
  }

  /** True once everything has decayed to (near) zero. */
  isQuiet(epsilon = 1e-3): boolean {
    if (this.energy > epsilon || this.beat > epsilon) return false;
    for (let i = 0; i < this.bands.length; i++) if (this.bands[i] > epsilon) return false;
    return true;
  }

  /** Plain-object copy, safe to hand to a Reanimated shared value. */
  snapshot(): AudioFeatures {
    return {
      bands: Array.from(this.bands),
      bass: this.bass,
      mid: this.mid,
      treble: this.treble,
      energy: this.energy,
      beat: this.beat,
      phase: this.phase,
      beatCount: this.beatCount,
    };
  }

  private mean([start, end]: [number, number]): number {
    if (end <= start) return 0;
    let s = 0;
    for (let i = start; i < end; i++) s += this.bands[i];
    return s / (end - start);
  }

  private detectBeat(dt: number): void {
    const { beatSensitivity, beatMinFlux, beatHistory, beatMinInterval, beatDecay } = this.config;
    const [start, end] = this.beatRange;
    let flux = 0;
    for (let i = start; i < end; i++) {
      const d = this.raw[i] - this.prevRaw[i];
      if (d > 0) flux += d;
    }
    flux /= Math.max(end - start, 1);

    this.sinceBeat += dt;
    const threshold = this.fluxMean + beatSensitivity * Math.sqrt(this.fluxVar) + beatMinFlux;
    if (flux > threshold && this.sinceBeat >= beatMinInterval) {
      this.beat = 1;
      this.sinceBeat = 0;
      this.beatCount++;
    } else {
      this.beat *= Math.exp(-dt / beatDecay);
    }

    // Update running statistics after the test, so an onset can't raise its own threshold.
    const a = 1 - Math.exp(-dt / beatHistory);
    const diff = flux - this.fluxMean;
    this.fluxMean += a * diff;
    this.fluxVar += a * (diff * diff - this.fluxVar);
  }
}
