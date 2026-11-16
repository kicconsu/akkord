export interface Track {
  id: string;
  title: string;
  /** A `require()`d bundled asset, or a local file URI (e.g. from the document picker). */
  source: number | string;
}

export const BUNDLED_TRACKS: Track[] = [
  {
    id: 'test-pattern',
    title: 'Test pattern: sweep + 120 BPM groove',
    // Regenerate with: node scripts/generate-test-track.mjs
    source: require('../../assets/audio/test-pattern.wav'),
  },
];
