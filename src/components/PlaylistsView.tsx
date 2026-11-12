import React, { useState, useMemo } from 'react';
import { Playlist, calculatePlaylistDuration } from '../utils/playlistUtils';
import { Track, plural } from '../utils/audioUtils';
import { PlaylistCollage } from './PlaylistCollage';

interface PlaylistsViewProps {
  playlists: Playlist[];
  tracks: Track[];
  favoriteKeys: string[];
  coverMap: Map<string, string | null | undefined>;
  onOpenPlaylist: (playlistId: string) => void;
  onCreatePlaylist: () => void;
  onCreateFromFavorites: () => void;
  onPlayPlaylist: (playlist: Playlist, shuffle?: boolean) => void;
  onOpenPlaylistMenu: (playlist: Playlist, e: React.MouseEvent) => void;
}

export const PlaylistsView: React.FC<PlaylistsViewProps> = ({
  playlists,
  tracks,
  favoriteKeys,
  coverMap,
  onOpenPlaylist,
  onCreatePlaylist,
  onCreateFromFavorites,
  onPlayPlaylist,
  onOpenPlaylistMenu,
}) => {
  const [search, setSearch] = useState('');

  // Track map for duration calculations
  const trackMap = useMemo(() => {
    const map = new Map<string, Track>();
    tracks.forEach((t) => map.set(t.key, t));
    return map;
  }, [tracks]);

  const filteredPlaylists = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return playlists;
    return playlists.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.description && p.description.toLowerCase().includes(q))
    );
  }, [playlists, search]);

  return (
    <div style={{ padding: '0 4px' }}>
      {/* Search and Action Bar */}
      <div className="pl-header-bar">
        <input
          type="search"
          className="psearch"
          placeholder="Buscar playlist..."
          aria-label="Buscar playlist"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ flex: 1, margin: 0 }}
        />
        <button
          type="button"
          className="pl-create-btn"
          onClick={onCreatePlaylist}
          title="Criar nova playlist"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M12 5v14M5 12h14" />
          </svg>
          <span>Nova playlist</span>
        </button>
      </div>

      <div className="psub acount" style={{ marginBottom: 8 }}>
        {plural(filteredPlaylists.length, ' playlist', ' playlists')}
      </div>

      {playlists.length === 0 ? (
        <div className="pl-empty-hero">
          <svg className="pl-hero-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M9 18V5l12-2v13" />
            <circle cx="6" cy="18" r="3" />
            <circle cx="18" cy="16" r="3" />
          </svg>
          <b>Crie sua primeira playlist</b>
          <p>
            Organize suas músicas prediletas para relaxar, treinar, viajar ou curtir a qualquer momento.
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, justifyContent: 'center' }}>
            <button
              type="button"
              className="act-btn primary"
              onClick={onCreatePlaylist}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 5v14M5 12h14" />
              </svg>
              <span>Criar playlist</span>
            </button>
            {favoriteKeys.length > 0 && (
              <button
                type="button"
                className="sec-btn"
                onClick={onCreateFromFavorites}
              >
                <svg viewBox="0 0 24 24" fill="currentColor" style={{ color: '#e0245e' }}>
                  <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
                </svg>
                <span>Criar com Favoritas ({favoriteKeys.length})</span>
              </button>
            )}
          </div>
        </div>
      ) : filteredPlaylists.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 36, color: 'var(--muted)', fontSize: '0.9rem' }}>
          Nenhuma playlist encontrada para &ldquo;{search}&rdquo;.
        </div>
      ) : (
        <div className="pl-card-grid">
          {filteredPlaylists.map((pl) => {
            const covers = pl.trackKeys
              .map((k) => coverMap.get(k))
              .filter((c): c is string => Boolean(c))
              .slice(0, 4);

            const durations = pl.trackKeys.map((k) => trackMap.get(k)?.dur);
            const totalDurationStr = calculatePlaylistDuration(durations);

            return (
              <div
                key={pl.id}
                className="pl-card"
                tabIndex={0}
                onClick={() => onOpenPlaylist(pl.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onOpenPlaylist(pl.id);
                }}
              >
                <div style={{ position: 'relative' }}>
                  <PlaylistCollage covers={covers} />
                  {pl.trackKeys.length > 0 && (
                    <button
                      type="button"
                      className="ib"
                      style={{
                        position: 'absolute',
                        right: 8,
                        bottom: 16,
                        background: 'var(--accent)',
                        color: 'var(--on)',
                        width: 36,
                        height: 36,
                        borderRadius: '50%',
                        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
                        opacity: 0.95,
                      }}
                      title={`Tocar playlist ${pl.name}`}
                      aria-label={`Tocar playlist ${pl.name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onPlayPlaylist(pl, false);
                      }}
                    >
                      <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: 18, height: 18, marginLeft: 2 }}>
                        <path d="M8 5.6v12.8a1 1 0 0 0 1.5.9l10.4-6.4a1 1 0 0 0 0-1.7L9.5 4.7A1 1 0 0 0 8 5.6z" />
                      </svg>
                    </button>
                  )}
                </div>

                <div className="pl-card-title" title={pl.name}>
                  {pl.name}
                </div>
                <div className="pl-card-meta">
                  {plural(pl.trackKeys.length, ' música', ' músicas')} • {totalDurationStr}
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6 }}>
                  <button
                    type="button"
                    className="qb"
                    title={`Opções para ${pl.name}`}
                    aria-label={`Opções para ${pl.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenPlaylistMenu(pl, e);
                    }}
                  >
                    <svg viewBox="0 0 24 24" fill="currentColor">
                      <circle cx="12" cy="5" r="2" />
                      <circle cx="12" cy="12" r="2" />
                      <circle cx="12" cy="19" r="2" />
                    </svg>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
