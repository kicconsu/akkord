import {
  Canvas,
  Fill,
  ImageShader,
  Shader,
  useClock,
  type SkRuntimeEffect,
} from '@shopify/react-native-skia';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { useDerivedValue, useSharedValue, type SharedValue } from 'react-native-reanimated';

import type { AudioFeatures } from '../audio/features';
import { ChildShader } from './ChildShaders';
import type { VisualizerDef } from './shaders';
import { useSpectrumTexture } from './useSpectrumTexture';

interface Props {
  viz: VisualizerDef;
  effect: SkRuntimeEffect;
  features: SharedValue<AudioFeatures>;
  style?: StyleProp<ViewStyle>;
}

/**
 * Full-size canvas running one visualizer shader. Supplies the uniform contract defined in
 * src/viz/shaders/common.ts. Uniforms and the spectrum texture are derived on the UI thread,
 * so this component never re-renders per frame.
 */
export function ShaderCanvas({ viz, effect, features, style }: Props) {
  const size = useSharedValue({ width: 0, height: 0 });
  const clock = useClock();
  const spectrum = useSpectrumTexture(features);

  const uniforms = useDerivedValue(() => {
    const f = features.get();
    return {
      // Canvas units (dp). Clamped so the very first frame, before onSize fires, can't divide by 0.
      uResolution: [Math.max(size.get().width, 1), Math.max(size.get().height, 1)],
      // Wrapped so float precision in the shader stays good on long sessions.
      uTime: (clock.get() / 1000) % 3600,
      uPhase: f.phase % 3600,
      uBands: f.bands,
      uBass: f.bass,
      uMid: f.mid,
      uTreble: f.treble,
      uEnergy: f.energy,
      uBeat: f.beat,
      uBeatCount: f.beatCount,
    };
  });

  // colorSpace="srgb" is required: the default "p3" makes Skia colour-convert child images
  // into the P3 working space on wide-gamut screens, which would corrupt the data in uSpectrum.
  return (
    <Canvas style={[StyleSheet.absoluteFill, style]} onSize={size} colorSpace="srgb">
      <Fill>
        <Shader source={effect} uniforms={uniforms}>
          {/* Children bind in declaration order: the prelude's uSpectrum, then viz.children. */}
          <ImageShader image={spectrum} tx="clamp" ty="clamp" />
          {viz.children.map((spec) => (
            <ChildShader key={spec.name} spec={spec} />
          ))}
        </Shader>
      </Fill>
    </Canvas>
  );
}
