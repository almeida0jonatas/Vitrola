/**
 * Playlist management utility functions and types for Vitrola Web Player.
 */

export interface Playlist {
  id: string;
  name: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
  trackKeys: string[];
  customCover?: string | null;
}

export const PLAYLISTS_STORAGE_KEY = 'vitrola_playlists_v1';

/**
 * Validates a playlist name.
 */
export function validatePlaylistName(name: string): { valid: boolean; error?: string } {
  const trimmed = name.trim();
  if (!trimmed) {
    return { valid: false, error: 'O nome da playlist não pode ficar em branco.' };
  }
  if (trimmed.length > 80) {
    return { valid: false, error: 'O nome da playlist deve ter no máximo 80 caracteres.' };
  }
  return { valid: true };
}

/**
 * Creates a new playlist object.
 */
export function createPlaylist(
  name: string,
  description?: string,
  initialTrackKeys: string[] = []
): Playlist {
  const now = Date.now();
  const id = `pl_${now}_${Math.random().toString(36).substring(2, 8)}`;
  return {
    id,
    name: name.trim(),
    description: description ? description.trim() : undefined,
    createdAt: now,
    updatedAt: now,
    trackKeys: [...initialTrackKeys],
  };
}

/**
 * Adds tracks to an existing playlist, optionally deduplicating.
 */
export function addTracksToPlaylist(
  playlist: Playlist,
  trackKeys: string[],
  allowDuplicates = false
): Playlist {
  if (!trackKeys.length) return playlist;

  const existingSet = new Set(playlist.trackKeys);
  const keysToAdd = allowDuplicates ? trackKeys : trackKeys.filter((k) => !existingSet.has(k));

  if (keysToAdd.length === 0) return playlist;

  return {
    ...playlist,
    trackKeys: [...playlist.trackKeys, ...keysToAdd],
    updatedAt: Date.now(),
  };
}

/**
 * Removes a track from a playlist by its positional index.
 */
export function removeTrackFromPlaylist(playlist: Playlist, indexToRemove: number): Playlist {
  if (indexToRemove < 0 || indexToRemove >= playlist.trackKeys.length) {
    return playlist;
  }
  const nextKeys = [...playlist.trackKeys];
  nextKeys.splice(indexToRemove, 1);
  return {
    ...playlist,
    trackKeys: nextKeys,
    updatedAt: Date.now(),
  };
}

/**
 * Reorders tracks in a playlist (e.g. moving a track up or down).
 */
export function reorderPlaylistTracks(
  playlist: Playlist,
  fromIndex: number,
  toIndex: number
): Playlist {
  if (
    fromIndex < 0 ||
    fromIndex >= playlist.trackKeys.length ||
    toIndex < 0 ||
    toIndex >= playlist.trackKeys.length ||
    fromIndex === toIndex
  ) {
    return playlist;
  }

  const nextKeys = [...playlist.trackKeys];
  const [movedKey] = nextKeys.splice(fromIndex, 1);
  nextKeys.splice(toIndex, 0, movedKey);

  return {
    ...playlist,
    trackKeys: nextKeys,
    updatedAt: Date.now(),
  };
}

/**
 * Renames or updates description of a playlist.
 */
export function renamePlaylist(
  playlist: Playlist,
  newName: string,
  newDescription?: string
): Playlist {
  return {
    ...playlist,
    name: newName.trim(),
    description: newDescription !== undefined ? newDescription.trim() || undefined : playlist.description,
    updatedAt: Date.now(),
  };
}

/**
 * Duplicates a playlist.
 */
export function duplicatePlaylist(playlist: Playlist, customName?: string): Playlist {
  const now = Date.now();
  const id = `pl_${now}_${Math.random().toString(36).substring(2, 8)}`;
  return {
    ...playlist,
    id,
    name: customName?.trim() || `${playlist.name} (Cópia)`,
    createdAt: now,
    updatedAt: now,
    trackKeys: [...playlist.trackKeys],
  };
}

/**
 * Parses duration strings (e.g., "03:45" or "1:02:10") to seconds.
 */
export function parseDurationToSeconds(dur?: string): number {
  if (!dur) return 0;
  const parts = dur.split(':').map((p) => parseInt(p, 10));
  if (parts.some(isNaN)) return 0;
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  if (parts.length === 1) {
    return parts[0];
  }
  return 0;
}

/**
 * Formats total seconds into a friendly Portuguese string: "45 min" or "1 h 12 min".
 */
export function formatPlaylistTotalDuration(totalSeconds: number): string {
  if (totalSeconds <= 0) return '0 min';
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (hours > 0) {
    return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`;
  }
  return `${Math.max(1, minutes)} min`;
}

/**
 * Calculates aggregate duration for a collection of track duration strings.
 */
export function calculatePlaylistDuration(durations: (string | undefined)[]): string {
  const totalSec = durations.reduce((acc, d) => acc + parseDurationToSeconds(d), 0);
  return formatPlaylistTotalDuration(totalSec);
}

/**
 * Generates an M3U8 playlist content string.
 */
export function generateM3uContent(
  playlist: Playlist,
  tracks: Array<{ name: string; artist?: string; dur?: string; key: string }>
): string {
  let out = '#EXTM3U\n';
  out += `#PLAYLIST:${playlist.name}\n`;
  if (playlist.description) {
    out += `#COMMENT:${playlist.description}\n`;
  }

  for (const t of tracks) {
    const sec = parseDurationToSeconds(t.dur) || -1;
    const title = t.artist ? `${t.artist} - ${t.name}` : t.name;
    out += `#EXTINF:${sec},${title}\n`;
    out += `${t.name}.mp3\n`;
  }

  return out;
}

/**
 * Loads playlists from localStorage safely.
 */
export function loadStoredPlaylists(): Playlist[] {
  try {
    const raw = localStorage.getItem(PLAYLISTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed.filter(
      (p) =>
        p &&
        typeof p === 'object' &&
        typeof p.id === 'string' &&
        typeof p.name === 'string' &&
        Array.isArray(p.trackKeys)
    );
  } catch (err) {
    console.warn('[Playlists] Error loading playlists from localStorage:', err);
    return [];
  }
}

/**
 * Saves playlists to localStorage safely.
 */
export function saveStoredPlaylists(playlists: Playlist[]): void {
  try {
    localStorage.setItem(PLAYLISTS_STORAGE_KEY, JSON.stringify(playlists));
  } catch (err) {
    console.warn('[Playlists] Error saving playlists to localStorage:', err);
  }
}

/**
 * Gets up to 4 unique covers for a playlist collage preview.
 */
export function getPlaylistCoverImages(
  trackKeys: string[],
  coverMap: Map<string, string | null | undefined>
): string[] {
  const covers: string[] = [];
  const seen = new Set<string>();

  for (const key of trackKeys) {
    const c = coverMap.get(key);
    if (c && !seen.has(c)) {
      seen.add(c);
      covers.push(c);
      if (covers.length >= 4) break;
    }
  }

  return covers;
}
