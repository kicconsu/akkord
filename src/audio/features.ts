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
  /** Beat detection, stage 1 (onsets): positive spectral flux in dB, SuperFlux style (each band
   *  is compared with the loudest of itself and its neighbours in the previous frame, which
   *  ignores pitch glides such as wobble bass). Two channels, each with its own threshold, and a
   *  beat fires when either crosses it: `beatLowHz` (kicks) and `beatBodyHz` (snares, plucks,
   *  vocals; it stops below the cymbals so off-beat hats don't count). */
  beatLowHz: [number, number];
  beatBodyHz: [number, number];
  /** The flux is divided by its own running mean over this many seconds, so loud, compressed
   *  masters and quiet recordings behave the same. */
  beatNormTime: number;
  /** Onset threshold = mean + sensitivity × std-dev of the recent normalised flux. Lower fires
   *  more often. */
  beatSensitivity: number;
  /** Absolute floor on the normalised flux, so steady sound never triggers. */
  beatMinFlux: number;
  /** Time constant (s) of the running flux statistics. */
  beatHistory: number;
  /** Stage 2 (tempo): the onset curve's autocorrelation over the last `tempoWindow` seconds
   *  picks a beat period in this BPM range (weighted toward `tempoPriorBpm`), and a comb over
   *  the same window finds its phase. */
  tempoMinBpm: number;
  tempoMaxBpm: number;
  tempoPriorBpm: number;
  tempoWindow: number;
  /** Normalised autocorrelation needed to trust the tempo, and below which it is dropped. */
  tempoConfidenceOn: number;
  tempoConfidenceOff: number;
  /** While the tempo is trusted, onsets only count within this many seconds of the beat grid,
   *  and a grid beat with no onset near it fires on its own (a kick buried under bass). */
  beatTolerance: number;
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
  beatLowHz: [30, 200],
  beatBodyHz: [30, 5000],
  beatNormTime: 4,
  beatSensitivity: 1.5,
  beatMinFlux: 0.5,
  beatHistory: 1.0,
  tempoMinBpm: 70,
  tempoMaxBpm: 180,
  tempoPriorBpm: 120,
  tempoWindow: 6,
  tempoConfidenceOn: 0.3,
  tempoConfidenceOff: 0.2,
  beatTolerance: 0.07,
  beatMinInterval: 0.22,
  beatDecay: 0.12,
  phaseBaseSpeed: 0.2,
  phaseEnergySpeed: 1.0,
};

/** dB floor for onset detection, so silence → sound is a finite jump. */
const ONSET_FLOOR_DB = -100;

/** The onset curve is resampled to this fixed rate for tempo analysis. */
const ODF_RATE = 60;

const clamp01 = (v: number) => (v > 0 ? (v < 1 ? v : 1) : 0); // also maps NaN to 0

/** One onset detector: flux normalised by its own running mean, against its own adaptive
 *  threshold. Separate channels keep a broadband snare from raising the bar for a lone kick. */
class OnsetChannel {
  private norm = 0;
  private mean = 0;
  private variance = 0;
  /** Normalised flux from the last update. */
  value = 0;
  /** Whether the last update crossed the threshold. */
  onset = false;

  update(rawFlux: number, dt: number, c: FeatureConfig): void {
    this.norm += (rawFlux - this.norm) * (1 - Math.exp(-dt / c.beatNormTime));
    // Log-compressed, so one huge onset (the first kick after a quiet passage) can't inflate the
    // statistics and hide the next few beats.
    const v = Math.log1p(rawFlux / (this.norm + 0.5));
    this.value = v;
    this.onset = v > this.mean + c.beatSensitivity * Math.sqrt(this.variance) + c.beatMinFlux;
    // Statistics update after the test, so an onset can't raise its own threshold.
    const a = 1 - Math.exp(-dt / c.beatHistory);
    const diff = v - this.mean;
    this.mean += a * diff;
    this.variance += a * (diff * diff - this.variance);
  }
}

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
  /** Band levels in dB (floored, no tilt) for onset detection: this frame and the previous. */
  private readonly bandDb: Float32Array;
  private readonly prevDb: Float32Array;
  /** Fractional FFT bin range [lo, hi) and center per band. */
  private readonly binLo: Float32Array;
  private readonly binHi: Float32Array;
  private readonly binCenter: Float32Array;
  private readonly tiltDb: Float32Array;
  private readonly bassRange: [number, number];
  private readonly midRange: [number, number];
  private readonly trebleRange: [number, number];
  private readonly beatLowRange: [number, number];
  private readonly beatBodyRange: [number, number];
  private readonly lowOnsets = new OnsetChannel();
  private readonly bodyOnsets = new OnsetChannel();
  private sinceBeat = Infinity;
  private sinceLowOnset = Infinity;
  /** Last `tempoWindow` seconds of the normalised onset curve at ODF_RATE (ring buffer). */
  private readonly odf: Float32Array;
  private odfHead = 0;
  private odfFilled = 0;
  private odfClock = 0;
  private sinceTempo = Infinity;
  private confidence = 0;
  /** Beat period in seconds, or 0 while the tempo isn't trusted. */
  private period = 0;
  /** Seconds until the next grid beat (valid while period > 0). */
  private untilGrid = Infinity;
  /** The grid beat nearest to now has already fired (from an onset or by itself). */
  private gridSlotUsed = false;
  private scratch = new Float32Array(0);
  private silentFreq: Float32Array | null = null;
  private silentTime: Float32Array | null = null;

  constructor(config: Pick<FeatureConfig, 'sampleRate' | 'fftSize'> & Partial<FeatureConfig>) {
    this.config = { ...DEFAULT_FEATURE_CONFIG, ...config };
    const { bandCount, minHz, sampleRate, fftSize, tiltDbPerOctave, tiltPivotHz } = this.config;
    const maxHz = Math.min(this.config.maxHz, sampleRate * 0.475);
    const binHz = sampleRate / fftSize;

    this.bands = new Float32Array(bandCount);
    this.raw = new Float32Array(bandCount);
    this.bandDb = new Float32Array(bandCount).fill(ONSET_FLOOR_DB);
    this.prevDb = new Float32Array(bandCount).fill(ONSET_FLOOR_DB);
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
    this.beatLowRange = range(this.config.beatLowHz);
    this.beatBodyRange = range(this.config.beatBodyHz);
    this.odf = new Float32Array(Math.round(this.config.tempoWindow * ODF_RATE));
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
      this.raw[i] = level;
      this.prevDb[i] = this.bandDb[i];
      this.bandDb[i] = db > ONSET_FLOOR_DB ? db : ONSET_FLOOR_DB; // also maps -Infinity/NaN
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

  /** Current tempo in BPM, or 0 while it isn't trusted. For debugging and tests. */
  get bpm(): number {
    return this.period > 0 ? 60 / this.period : 0;
  }

  private detectBeat(dt: number): void {
    const { bandCount, beatMinInterval, beatDecay, beatTolerance } = this.config;

    // Onset strength (SuperFlux) per channel.
    let body = 0;
    let low = 0;
    const [lowStart, lowEnd] = this.beatLowRange;
    const [bodyStart, bodyEnd] = this.beatBodyRange;
    for (let i = Math.min(lowStart, bodyStart); i < Math.max(lowEnd, bodyEnd); i++) {
      let ref = this.prevDb[i];
      if (i > 0 && this.prevDb[i - 1] > ref) ref = this.prevDb[i - 1];
      if (i < bandCount - 1 && this.prevDb[i + 1] > ref) ref = this.prevDb[i + 1];
      const d = this.bandDb[i] - ref;
      if (d > 0) {
        if (i >= bodyStart && i < bodyEnd) body += d;
        if (i >= lowStart && i < lowEnd) low += d;
      }
    }
    this.lowOnsets.update(low / Math.max(lowEnd - lowStart, 1), dt, this.config);
    this.bodyOnsets.update(body / Math.max(bodyEnd - bodyStart, 1), dt, this.config);
    const onset = this.lowOnsets.onset || this.bodyOnsets.onset;
    this.sinceLowOnset = this.lowOnsets.onset ? 0 : this.sinceLowOnset + dt;

    // Tempo curve: kicks carry the pulse in most music, so the low channel counts double.
    this.pushOdf(2 * this.lowOnsets.value + this.bodyOnsets.value, dt);
    this.sinceTempo += dt;
    if (this.sinceTempo >= 0.25) {
      this.sinceTempo = 0;
      this.estimateTempo();
    }

    this.sinceBeat += dt;

    // Paused or silent: the buffer still holds the old rhythm, so the grid must not keep going.
    if (this.period > 0 && this.energy < 0.05) this.dropTempo();

    let fire = false;
    if (this.period > 0) {
      // Tempo-locked: onsets count only near the grid, and a grid beat with none fires itself.
      this.untilGrid -= dt;
      while (this.untilGrid < -beatTolerance) {
        this.untilGrid += this.period;
        this.gridSlotUsed = false;
      }
      if (!this.gridSlotUsed && this.sinceBeat >= beatMinInterval) {
        const nearGrid = Math.abs(this.untilGrid) <= beatTolerance;
        if ((onset && nearGrid) || this.untilGrid <= 0) {
          fire = true;
          this.gridSlotUsed = true;
        }
      }
    } else {
      // No tempo yet: kicks lead. The body channel (snares, plucks…) only drives beats in music
      // that has had no kick for a while, so bass notes and fills don't add off-beat triggers.
      const kickless = this.sinceLowOnset > 1.5;
      fire =
        (this.lowOnsets.onset || (kickless && this.bodyOnsets.onset)) && this.sinceBeat >= beatMinInterval;
    }

    if (fire) {
      this.beat = 1;
      this.sinceBeat = 0;
      this.beatCount++;
    } else {
      this.beat *= Math.exp(-dt / beatDecay);
    }
  }

  /** Appends the onset value at a fixed rate, whatever the frame rate. */
  private pushOdf(value: number, dt: number): void {
    const step = 1 / ODF_RATE;
    this.odfClock += dt;
    const steps = Math.floor(this.odfClock / step);
    this.odfClock -= steps * step;
    // Capped, so a long stall (app in background) can't loop for long.
    for (let n = Math.min(steps, this.odf.length); n > 0; n--) {
      this.odf[this.odfHead] = value;
      this.odfHead = (this.odfHead + 1) % this.odf.length;
      if (this.odfFilled < this.odf.length) this.odfFilled++;
    }
  }

  /** The onset value k samples ago (0 = newest). */
  private odfAt(k: number): number {
    const len = this.odf.length;
    return this.odf[(((this.odfHead - 1 - k) % len) + len) % len];
  }

  /** Autocorrelation of the onset curve picks the period; a comb over it picks the phase. */
  private estimateTempo(): void {
    const { tempoMinBpm, tempoMaxBpm, tempoPriorBpm, tempoConfidenceOn, tempoConfidenceOff } = this.config;
    const tol = this.config.beatTolerance;
    const n = this.odfFilled;
    if (this.energy < 0.05) {
      this.dropTempo(); // see detectBeat: no grid without sound
      return;
    }
    const minLag = Math.floor((60 / tempoMaxBpm) * ODF_RATE);
    const maxLag = Math.ceil((60 / tempoMinBpm) * ODF_RATE);
    if (n < maxLag * 3) {
      this.dropTempo();
      return;
    }

    // Mean-removed copy, newest first.
    const x = this.scratch.length === n ? this.scratch : (this.scratch = new Float32Array(n));
    let mean = 0;
    for (let k = 0; k < n; k++) mean += this.odfAt(k);
    mean /= n;
    let ac0 = 0;
    for (let k = 0; k < n; k++) {
      x[k] = this.odfAt(k) - mean;
      ac0 += x[k] * x[k];
    }
    if (ac0 < 1e-6 * n) {
      this.confidence = 0;
      this.dropTempo(); // flat: silence or a steady tone
      return;
    }
    const r = (lag: number): number => {
      let s = 0;
      for (let k = 0; k + lag < n; k++) s += x[k] * x[k + lag];
      return s / ac0;
    };

    // Normalised autocorrelation per lag, plus its double (a real beat repeats there too),
    // weighted by a broad log-normal tempo prior.
    let bestLag = 0;
    let bestScore = -Infinity;
    let bestR = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      const rl = r(lag);
      const r2 = 2 * lag < n ? r(2 * lag) : 0;
      const bpm = (60 * ODF_RATE) / lag;
      const prior = Math.exp(-0.5 * (Math.log2(bpm / tempoPriorBpm) / 0.7) ** 2);
      const score = (rl + 0.5 * r2) * (0.5 + 0.5 * prior);
      if (score > bestScore) {
        bestScore = score;
        bestLag = lag;
        bestR = rl;
      }
    }

    // Confidence with hysteresis, so the mode doesn't flicker.
    this.confidence += (bestR - this.confidence) * 0.5;
    const trusted =
      this.period > 0 ? this.confidence >= tempoConfidenceOff : this.confidence >= tempoConfidenceOn;
    if (!trusted) {
      this.dropTempo();
      return;
    }

    // Sub-sample period: parabola through the neighbouring lags.
    let lag = bestLag;
    if (bestLag > minLag && bestLag < maxLag) {
      const a = r(bestLag - 1);
      const c = r(bestLag + 1);
      const denom = a - 2 * bestR + c;
      if (denom < 0) lag = bestLag + (0.5 * (a - c)) / denom;
    }

    // Phase: the offset (samples back) whose comb collects the most onset strength.
    let bestPhase = 0;
    let bestSum = -Infinity;
    for (let ph = 0; ph < Math.ceil(lag); ph++) {
      let sum = 0;
      for (let t = ph; t < n; t += lag) sum += x[Math.round(t)] ?? 0;
      if (sum > bestSum) {
        bestSum = sum;
        bestPhase = ph;
      }
    }

    const period = lag / ODF_RATE;
    let next = -bestPhase / ODF_RATE; // the latest comb beat, now or in the past
    while (next < -tol) next += period;
    // The slot counts as used if the last beat fired close to it.
    this.gridSlotUsed = Math.abs(next + this.sinceBeat) <= tol;
    this.period = period;
    this.untilGrid = next;
  }

  private dropTempo(): void {
    this.period = 0;
    this.untilGrid = Infinity;
    this.gridSlotUsed = false;
  }
}
