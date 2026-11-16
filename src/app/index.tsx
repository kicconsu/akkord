import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PlayerControls } from '@/components/PlayerControls';
import { audioEngine } from '@/audio/engine';
import { BUNDLED_TRACKS } from '@/audio/tracks';
import { useAudioFeatures } from '@/audio/useAudioFeatures';
import { DebugOverlay } from '@/viz/DebugOverlay';
import { compileVisualizer } from '@/viz/effects';
import { ShaderCanvas } from '@/viz/ShaderCanvas';
import { VISUALIZERS } from '@/viz/shaders';

export default function PlayerScreen() {
  const insets = useSafeAreaInsets();
  const features = useAudioFeatures();
  const [debug, setDebug] = useState(false);
  const [vizIndex, setVizIndex] = useState(0);

  // A proper picker arrives in step 5; for now the controls' pill cycles through VISUALIZERS.
  const viz = VISUALIZERS[vizIndex % VISUALIZERS.length];
  const compiled = compileVisualizer(viz);

  useEffect(() => {
    // The engine is a singleton, so don't reload after Fast Refresh remounts this screen.
    if (audioEngine.getState().status === 'idle') void audioEngine.load(BUNDLED_TRACKS[0]);
  }, []);

  return (
    <View style={styles.root}>
      {compiled.effect ? (
        // Keyed by id: each visualizer has its own child textures, so remount rather than patch.
        <ShaderCanvas key={viz.id} viz={viz} effect={compiled.effect} features={features} />
      ) : (
        <ScrollView
          style={StyleSheet.absoluteFill}
          contentContainerStyle={{ paddingTop: insets.top + 16, padding: 16 }}
        >
          <Text style={styles.errorTitle}>Shader “{viz.name}” failed to compile</Text>
          <Text style={styles.errorBody}>{compiled.error}</Text>
          <Text style={styles.errorHint}>Full numbered source is in the Metro console.</Text>
        </ScrollView>
      )}

      {debug && <DebugOverlay features={features} style={[styles.debug, { top: insets.top + 12 }]} />}

      <PlayerControls
        vizName={viz.name}
        onNextViz={() => setVizIndex((i) => (i + 1) % VISUALIZERS.length)}
        debug={debug}
        onToggleDebug={() => setDebug((d) => !d)}
        style={{ paddingBottom: insets.bottom + 16 }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  debug: { position: 'absolute', left: 12, right: 12 },
  errorTitle: { color: '#f87171', fontSize: 16, fontWeight: '600', marginBottom: 8 },
  errorBody: { color: '#fecaca', fontFamily: 'monospace', fontSize: 12 },
  errorHint: { color: '#9ca3af', fontSize: 12, marginTop: 12 },
});
