import { useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { audioEngine } from '../audio/engine';
import { usePlaybackPosition, usePlayerState } from '../audio/usePlayer';

interface Props {
  vizName: string;
  onNextViz: () => void;
  debug: boolean;
  onToggleDebug: () => void;
  style?: StyleProp<ViewStyle>;
}

const formatTime = (s: number) => {
  const total = Math.max(0, Math.floor(s));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

/** Track title, seek bar and transport buttons. It re-renders at ~10 Hz for the position,
 *  so it is kept separate from the canvas. */
export function PlayerControls({ vizName, onNextViz, debug, onToggleDebug, style }: Props) {
  const { status, track, duration, error } = usePlayerState();
  const position = usePlaybackPosition();
  const [scrub, setScrub] = useState<number | null>(null);
  const [barWidth, setBarWidth] = useState(1);

  const ready = status === 'paused' || status === 'playing';
  const shown = scrub ?? position;
  const progress = duration > 0 ? Math.min(shown / duration, 1) : 0;

  const timeAt = (e: GestureResponderEvent) =>
    Math.min(Math.max(e.nativeEvent.locationX / barWidth, 0), 1) * duration;

  const subtitle = status === 'loading' ? 'Loading…' : status === 'error' ? `Couldn't load: ${error}` : null;

  return (
    <View style={[styles.root, style]}>
      <View style={styles.header}>
        <View style={styles.titles}>
          <Text style={styles.title} numberOfLines={1}>
            {track?.title ?? 'No track'}
          </Text>
          {subtitle && (
            <Text style={[styles.subtitle, status === 'error' && styles.error]} numberOfLines={2}>
              {subtitle}
            </Text>
          )}
        </View>
        <Pressable
          onPress={onNextViz}
          style={styles.pill}
          accessibilityRole="button"
          accessibilityLabel={`Visualizer: ${vizName}. Tap for next`}
        >
          <Text style={styles.pillText} numberOfLines={1}>
            {vizName} ›
          </Text>
        </Pressable>
        <Pressable
          onPress={onToggleDebug}
          style={[styles.pill, debug && styles.pillOn]}
          accessibilityRole="switch"
          accessibilityState={{ checked: debug }}
        >
          <Text style={styles.pillText}>Debug</Text>
        </Pressable>
      </View>

      {/* Seek bar: tap or drag. Children ignore touches so locationX is relative to this view. */}
      <View
        style={styles.seekArea}
        onLayout={(e) => setBarWidth(Math.max(e.nativeEvent.layout.width, 1))}
        onStartShouldSetResponder={() => ready && duration > 0}
        onMoveShouldSetResponder={() => ready && duration > 0}
        onResponderTerminationRequest={() => false}
        onResponderGrant={(e) => setScrub(timeAt(e))}
        onResponderMove={(e) => setScrub(timeAt(e))}
        onResponderRelease={(e) => {
          audioEngine.seek(timeAt(e));
          // Hold the scrub position until the next position poll has caught up.
          setTimeout(() => setScrub(null), 150);
        }}
        onResponderTerminate={() => setScrub(null)}
        accessibilityRole="adjustable"
        accessibilityLabel="Seek"
      >
        <View style={styles.track}>
          <View style={[styles.fill, { width: `${progress * 100}%` }]} />
        </View>
        <View style={[styles.thumb, { left: `${progress * 100}%` }]} />
      </View>
      <View style={styles.times}>
        <Text style={styles.time}>{formatTime(shown)}</Text>
        <Text style={styles.time}>{formatTime(duration)}</Text>
      </View>

      <Pressable
        onPress={() => audioEngine.toggle()}
        disabled={!ready}
        style={({ pressed }) => [styles.play, !ready && styles.disabled, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel={status === 'playing' ? 'Pause' : 'Play'}
      >
        {status === 'playing' ? (
          <View style={styles.pauseIcon}>
            <View style={styles.pauseBar} />
            <View style={styles.pauseBar} />
          </View>
        ) : (
          <View style={styles.playIcon} />
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 24,
    paddingTop: 16,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  titles: { flex: 1 },
  title: { color: '#fff', fontSize: 16, fontWeight: '600' },
  subtitle: { color: '#9ca3af', fontSize: 13, marginTop: 2 },
  error: { color: '#f87171' },
  pill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  pillOn: { backgroundColor: 'rgba(74,222,128,0.35)' },
  pillText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  seekArea: { height: 32, justifyContent: 'center', marginTop: 12 },
  track: {
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.2)',
    overflow: 'hidden',
    pointerEvents: 'none',
  },
  fill: { height: '100%', backgroundColor: '#fff' },
  thumb: {
    position: 'absolute',
    width: 14,
    height: 14,
    marginLeft: -7,
    borderRadius: 7,
    backgroundColor: '#fff',
    pointerEvents: 'none',
  },
  times: { flexDirection: 'row', justifyContent: 'space-between' },
  time: { color: '#9ca3af', fontSize: 12, fontVariant: ['tabular-nums'] },
  play: {
    alignSelf: 'center',
    width: 64,
    height: 64,
    borderRadius: 32,
    marginTop: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.15)',
  },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.7 },
  playIcon: {
    width: 0,
    height: 0,
    marginLeft: 5,
    borderLeftWidth: 20,
    borderTopWidth: 12,
    borderBottomWidth: 12,
    borderLeftColor: '#fff',
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
  },
  pauseIcon: { flexDirection: 'row', gap: 6 },
  pauseBar: { width: 6, height: 22, borderRadius: 1, backgroundColor: '#fff' },
});
