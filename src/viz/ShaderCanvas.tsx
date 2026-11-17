import {
  Canvas,
  Fill,
  Group,
  ImageShader,
  Shader,
  useClock,
  type SkRuntimeEffect,
} from '@shopify/react-native-skia';
import { useState } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useDerivedValue, useSharedValue, type SharedValue } from 'react-native-reanimated';

import type { AudioFeatures } from '../audio/features';
import { ChildShader } from './ChildShaders';
import type { VisualizerDef } from './shaders';
import { useSpectrumTexture } from './useSpectrumTexture';

interface Props {
  viz: VisualizerDef;
  effect: SkRuntimeEffect;
  features: SharedValue<AudioFeatures>;
  /** Fraction of the view's resolution to render at, (0..1]. The result is upscaled. */
  renderScale?: number;
  style?: StyleProp<ViewStyle>;
}

/**
 * Full-size canvas running one visualizer shader. Supplies the uniform contract defined in
 * src/viz/shaders/common.ts. Uniforms and the spectrum texture are derived on the UI thread,
 * so this component never re-renders per frame.
 *
 * Resolution scaling: below 1, the native canvas is laid out at `scale` × the view size (so the
 * GPU shades scale² as many pixels) and then enlarged with a view transform. Inside, a Group
 * scales drawing back up, so the shader still sees fragCoord and uResolution in full-size dp
 * and visualizers need no changes.
 */
export function ShaderCanvas({ viz, effect, features, renderScale = 1, style }: Props) {
  const [layout, setLayout] = useState({ width: 0, height: 0 });
  const size = useSharedValue({ width: 0, height: 0 });
  const clock = useClock();
  const spectrum = useSpectrumTexture(features);
  const scale = Math.min(Math.max(renderScale, 0.25), 1);

  const uniforms = useDerivedValue(() => {
    const f = features.get();
    return {
      // Full-size dp. Clamped so the very first frame, before layout, can't divide by 0.
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

  // Round the scaled size up to whole dp so the upscaled canvas always covers the view.
  const canvasW = Math.ceil(layout.width * scale);
  const canvasH = Math.ceil(layout.height * scale);

  return (
    <View
      style={[StyleSheet.absoluteFill, styles.clip, style]}
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout;
        setLayout({ width, height });
        size.set({ width, height });
      }}
    >
      {layout.width > 0 && (
        // colorSpace="srgb" is required: the default "p3" makes Skia colour-convert child images
        // into the P3 working space on wide-gamut screens, which would corrupt uSpectrum's data.
        <Canvas
          colorSpace="srgb"
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: canvasW,
            height: canvasH,
            transformOrigin: 'left top',
            transform: [{ scale: 1 / scale }],
          }}
        >
          <Group transform={[{ scale }]}>
            <Fill>
              <Shader source={effect} uniforms={uniforms}>
                {/* Children bind in declaration order: the prelude's uSpectrum, then viz.children. */}
                <ImageShader image={spectrum} tx="clamp" ty="clamp" />
                {viz.children.map((spec) => (
                  <ChildShader key={spec.name} spec={spec} />
                ))}
              </Shader>
            </Fill>
          </Group>
        </Canvas>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  clip: { overflow: 'hidden' },
});
