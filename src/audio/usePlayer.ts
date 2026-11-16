import { useEffect, useState, useSyncExternalStore } from 'react';

import { audioEngine, type EngineState } from './engine';

/** Transport state (status, track, duration, error). Re-renders only when it changes. */
export function usePlayerState(): EngineState {
  return useSyncExternalStore(audioEngine.subscribe, audioEngine.getState);
}

/** Track position in seconds, polled. Use it only in small components (it re-renders them). */
export function usePlaybackPosition(intervalMs = 100): number {
  const [position, setPosition] = useState(audioEngine.position);
  useEffect(() => {
    const id = setInterval(() => setPosition(audioEngine.position), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return position;
}
