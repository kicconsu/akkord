import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PlayerControls } from '@/components/PlayerControls';
import { Segmented, Sheet, SheetRow, SheetSection } from '@/components/Sheet';
import { audioEngine } from '@/audio/engine';
import { pickAudioFiles, useLibrary } from '@/audio/library';
import type { Track } from '@/audio/tracks';
import { BUNDLED_TRACKS } from '@/audio/tracks';
import { useAudioFeatures } from '@/audio/useAudioFeatures';
import { usePlayerState } from '@/audio/usePlayer';
import { DebugOverlay } from '@/viz/DebugOverlay';
import { compileVisualizer } from '@/viz/effects';
import { effectiveRenderScale, QUALITY_OPTIONS, type Quality } from '@/viz/quality';
import { ShaderCanvas } from '@/viz/ShaderCanvas';
import { VISUALIZERS } from '@/viz/shaders';

type OpenSheet = 'none' | 'visualizers' | 'tracks';

export default function PlayerScreen() {
  const insets = useSafeAreaInsets();
  const features = useAudioFeatures();
  const library = useLibrary();
  const { track: currentTrack } = usePlayerState();
  const [debug, setDebug] = useState(false);
  const [vizId, setVizId] = useState(VISUALIZERS[0].id);
  const [quality, setQuality] = useState<Quality>('high');
  const [sheet, setSheet] = useState<OpenSheet>('none');
  const [pickError, setPickError] = useState<string | null>(null);

  const viz = VISUALIZERS.find((v) => v.id === vizId) ?? VISUALIZERS[0];
  const compiled = compileVisualizer(viz);
  const renderScale = effectiveRenderScale(viz, quality);

  useEffect(() => {
    // The engine is a singleton, so don't reload after Fast Refresh remounts this screen.
    if (audioEngine.getState().status === 'idle') void audioEngine.load(BUNDLED_TRACKS[0]);
  }, []);

  const playTrack = async (track: Track) => {
    setSheet('none');
    if (currentTrack?.id === track.id) return;
    await audioEngine.load(track);
    audioEngine.play();
  };

  const openFiles = async () => {
    setPickError(null);
    try {
      const picked = await pickAudioFiles();
      if (picked.length > 0) await playTrack(picked[0]);
    } catch (e) {
      setPickError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <View style={styles.root}>
      {compiled.effect ? (
        // Keyed by id: each visualizer has its own child textures, so remount rather than patch.
        <ShaderCanvas
          key={viz.id}
          viz={viz}
          effect={compiled.effect}
          features={features}
          renderScale={renderScale}
        />
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
        onOpenVisualizers={() => setSheet('visualizers')}
        onOpenTracks={() => setSheet('tracks')}
        debug={debug}
        onToggleDebug={() => setDebug((d) => !d)}
        style={{ paddingBottom: insets.bottom + 16 }}
      />

      <Sheet visible={sheet === 'visualizers'} title="Visualizer" onClose={() => setSheet('none')}>
        {VISUALIZERS.map((v) => (
          <SheetRow
            key={v.id}
            label={v.name}
            detail={`${Math.round(effectiveRenderScale(v, quality) * 100)}% resolution`}
            selected={v.id === viz.id}
            onPress={() => {
              setVizId(v.id);
              setSheet('none');
            }}
          />
        ))}
        <SheetSection>Quality</SheetSection>
        <Segmented options={QUALITY_OPTIONS} value={quality} onChange={setQuality} />
      </Sheet>

      <Sheet visible={sheet === 'tracks'} title="Tracks" onClose={() => setSheet('none')}>
        <SheetRow label="Open audio files…" detail="MP3, WAV, AAC, FLAC, OGG" onPress={openFiles} />
        {pickError ? <Text style={styles.pickError}>{pickError}</Text> : null}
        <SheetSection>Bundled</SheetSection>
        {library.bundled.map((t) => (
          <SheetRow
            key={t.id}
            label={t.title}
            selected={t.id === currentTrack?.id}
            onPress={() => playTrack(t)}
          />
        ))}
        {library.user.length > 0 && <SheetSection>Your files</SheetSection>}
        {library.user.map((t) => (
          <SheetRow
            key={t.id}
            label={t.title}
            selected={t.id === currentTrack?.id}
            onPress={() => playTrack(t)}
          />
        ))}
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  debug: { position: 'absolute', left: 12, right: 12 },
  errorTitle: { color: '#f87171', fontSize: 16, fontWeight: '600', marginBottom: 8 },
  errorBody: { color: '#fecaca', fontFamily: 'monospace', fontSize: 12 },
  errorHint: { color: '#9ca3af', fontSize: 12, marginTop: 12 },
  pickError: { color: '#f87171', fontSize: 12, paddingHorizontal: 12, marginBottom: 4 },
});
