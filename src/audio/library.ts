// Tracks the user can play: the bundled ones plus files picked this session.
// Picked files are copied into the app cache by the document picker, so their URIs stay
// readable for decodeAudioData. They are not persisted across launches (the cache may be cleared).
import * as DocumentPicker from 'expo-document-picker';
import { useSyncExternalStore } from 'react';

import { BUNDLED_TRACKS, type Track } from './tracks';

type Listener = () => void;

let userTracks: Track[] = [];
const listeners = new Set<Listener>();

const subscribe = (listener: Listener) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const getUserTracks = () => userTracks;

/** "song.final.mp3" → "song.final". */
const titleFromName = (name: string) => name.replace(/\.[^.]+$/, '') || name;

/**
 * Opens the system file picker for audio. Resolves to the new tracks (already added to the
 * library), or an empty array if the user cancelled. Picking a file that is already in the
 * library returns the existing entry instead of a duplicate.
 */
export async function pickAudioFiles(): Promise<Track[]> {
  const result = await DocumentPicker.getDocumentAsync({
    type: 'audio/*',
    copyToCacheDirectory: true,
    multiple: true,
  });
  if (result.canceled) return [];

  const picked: Track[] = [];
  const added: Track[] = [];
  for (const asset of result.assets) {
    // Same name + size is treated as the same file; the cache copy gets a fresh URI each time.
    const id = `file:${asset.name}:${asset.size ?? 0}`;
    const existing = userTracks.find((t) => t.id === id);
    if (existing) {
      picked.push(existing);
      continue;
    }
    const track: Track = { id, title: titleFromName(asset.name), source: asset.uri };
    picked.push(track);
    added.push(track);
  }
  if (added.length > 0) {
    userTracks = [...userTracks, ...added];
    listeners.forEach((l) => l());
  }
  return picked;
}

export interface Library {
  bundled: Track[];
  user: Track[];
}

/** Bundled tracks plus the files picked so far. */
export function useLibrary(): Library {
  const user = useSyncExternalStore(subscribe, getUserTracks);
  return { bundled: BUNDLED_TRACKS, user };
}
