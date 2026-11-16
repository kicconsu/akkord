// Per-frame loop: analyser → FeatureExtractor → one shared-value write.
// It runs on the JS thread because the AnalyserNode is a JSI host object owned by the JS
// runtime and can't be called from a UI-thread worklet. Skia reads the shared value on the
// UI thread, so nothing here triggers a React render.
import { useEffect } from 'react';
import { useSharedValue, type SharedValue } from 'react-native-reanimated';

import { audioEngine } from './engine';
import { EMPTY_FEATURES, FeatureExtractor, type AudioFeatures } from './features';

export function useAudioFeatures(): SharedValue<AudioFeatures> {
  const features = useSharedValue<AudioFeatures>(EMPTY_FEATURES);

  useEffect(() => {
    let raf = 0;
    let last = 0;
    let extractor: FeatureExtractor | null = null;
    let freq: Float32Array<ArrayBuffer> | null = null;
    let time: Float32Array<ArrayBuffer> | null = null;
    let idle = false;

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = last ? Math.min((now - last) / 1000, 0.1) : 1 / 60;
      last = now;

      const analyser = audioEngine.analyser;
      if (!analyser) return;
      if (!extractor || !freq || !time) {
        extractor = new FeatureExtractor({ sampleRate: audioEngine.sampleRate, fftSize: analyser.fftSize });
        freq = new Float32Array(analyser.frequencyBinCount);
        time = new Float32Array(analyser.fftSize);
      }

      if (audioEngine.isPlaying) {
        idle = false;
        analyser.getFloatFrequencyData(freq);
        analyser.getFloatTimeDomainData(time);
        extractor.process(freq, time, dt);
      } else {
        // Paused: feed silence so everything releases smoothly, then stop writing.
        if (idle) return;
        extractor.processSilence(freq.length, time.length, dt);
        if (extractor.isQuiet()) {
          // This frame's write is the last until playback resumes. It's a snapshot rather than
          // EMPTY_FEATURES, so phase and beatCount don't jump back to 0.
          idle = true;
        }
      }
      features.set(extractor.snapshot());
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [features]);

  return features;
}
