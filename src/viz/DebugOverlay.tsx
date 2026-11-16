// Plain Skia drawing of the raw feature values, for checking the audio data independently
// of any shader: the 64 bands as bars, then bass/mid/treble/energy meters and a beat dot.
import { Canvas, Circle, Path, Skia } from '@shopify/react-native-skia';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useDerivedValue, useSharedValue, type SharedValue } from 'react-native-reanimated';

import type { AudioFeatures } from '../audio/features';

const METERS = ['bass', 'mid', 'treble', 'energy'] as const;
const COLUMNS = [...METERS, 'beat'] as const;
const BANDS_H = 90;
const METERS_H = 56;

interface Props {
  features: SharedValue<AudioFeatures>;
  style?: StyleProp<ViewStyle>;
}

export function DebugOverlay({ features, style }: Props) {
  const bandsSize = useSharedValue({ width: 0, height: 0 });
  const metersSize = useSharedValue({ width: 0, height: 0 });

  const bandsPath = useDerivedValue(() => {
    const { width, height } = bandsSize.get();
    const bands = features.get().bands;
    const builder = Skia.PathBuilder.Make();
    const w = width / bands.length;
    for (let i = 0; i < bands.length; i++) {
      const h = Math.max(bands[i] * height, 1);
      builder.addRect(Skia.XYWHRect(i * w, height - h, Math.max(w - 1, 1), h));
    }
    return builder.detach();
  });

  // One column per meter (+ one for the beat dot). Bars are 40% of the column width.
  const metersPath = useDerivedValue(() => {
    const { width, height } = metersSize.get();
    const f = features.get();
    const col = width / COLUMNS.length;
    const builder = Skia.PathBuilder.Make();
    METERS.forEach((key, i) => {
      const h = Math.max(f[key] * height, 1);
      builder.addRect(Skia.XYWHRect(i * col + col * 0.3, height - h, col * 0.4, h));
    });
    return builder.detach();
  });

  const beatX = useDerivedValue(() => (metersSize.get().width / COLUMNS.length) * (COLUMNS.length - 0.5));
  const beatY = useDerivedValue(() => metersSize.get().height / 2);
  const beatR = useDerivedValue(() => 6 + 14 * features.get().beat);
  const beatOpacity = useDerivedValue(() => 0.25 + 0.75 * features.get().beat);

  return (
    <View style={[styles.panel, style]}>
      <Text style={styles.title}>bands (low → high)</Text>
      <Canvas style={{ height: BANDS_H }} onSize={bandsSize}>
        <Path path={bandsPath} color="#4ade80" />
      </Canvas>
      <Canvas style={[styles.meters, { height: METERS_H }]} onSize={metersSize}>
        <Path path={metersPath} color="#60a5fa" />
        <Circle cx={beatX} cy={beatY} r={beatR} color="#f472b6" opacity={beatOpacity} />
      </Canvas>
      <View style={styles.labels}>
        {COLUMNS.map((c) => (
          <Text key={c} style={styles.label}>
            {c}
          </Text>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 12,
    padding: 10,
    pointerEvents: 'none',
  },
  title: { color: '#9ca3af', fontSize: 11, marginBottom: 4 },
  meters: { marginTop: 10 },
  labels: { flexDirection: 'row', marginTop: 4 },
  label: { flex: 1, textAlign: 'center', color: '#9ca3af', fontSize: 11 },
});
