import { AlphaType, ColorType, Skia, type SkImage } from '@shopify/react-native-skia';
import { useDerivedValue, type SharedValue } from 'react-native-reanimated';

import type { AudioFeatures } from '../audio/features';
import { encodeSpectrum, SPECTRUM_WIDTH } from './spectrumTexture';

/** The uSpectrum texture, rebuilt on the UI thread whenever the features change. */
export function useSpectrumTexture(features: SharedValue<AudioFeatures>): SharedValue<SkImage | null> {
  return useDerivedValue(() => {
    const bytes = new Uint8Array(SPECTRUM_WIDTH * 4);
    encodeSpectrum(features.get().bands, bytes);
    return Skia.Image.MakeImage(
      { width: SPECTRUM_WIDTH, height: 1, colorType: ColorType.RGBA_8888, alphaType: AlphaType.Opaque },
      Skia.Data.fromBytes(bytes),
      SPECTRUM_WIDTH * 4,
    );
  });
}
