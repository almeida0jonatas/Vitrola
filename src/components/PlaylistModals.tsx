import React, { useState, useEffect, useMemo } from 'react';
import { Playlist, validatePlaylistName } from '../utils/playlistUtils';
import { Track, plural } from '../utils/audioUtils';
import { PlaylistCollage } from './PlaylistCollage';

interface CreatePlaylistModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (name: string, description?: string) => void;
  initialName?: string;
  initialDescription?: string;
  isEditing?: boolean;
}

export const CreatePlaylistModal: React.FC<CreatePlaylistModalProps> = ({
  isOpen,
  onClose,
  onSave,
  initialName = '',
  initialDescription = '',
  isEditing = false,
}) => {
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setName(initialName);
      setDescription(initialDescription);
      setError(null);
    }
  }, [isOpen, initialName, initialDescription]);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const val = validatePlaylistName(name);
    if (!val.valid) {
      setError(val.error || 'Nome inválido');
      return;
    }
    onSave(name.trim(), description.trim() || undefined);
    onClose();
  };

  return (
    <div className="mdl on" role="dialog" aria-modal="true" aria-labelledby="pl-modal-title">
      <div className="mdl-back" onClick={onClose} />
      <div className="mbox" style={{ maxWidth: 440 }}>
        <h3 id="pl-modal-title" style={{ marginTop: 0, marginBottom: 8, fontSize: '1.2rem' }}>
          {isEditing ? 'Editar playlist' : 'Criar nova playlist'}
        </h3>
        <p style={{ color: 'var(--muted)', fontSize: '0.86rem', margin: '0 0 16px' }}>
          {isEditing
            ? 'Altere o nome e a descrição da sua playlist.'
            : 'Dê um nome para sua playlist para organizar suas músicas.'}
        </p>

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 12 }}>
            <label
              htmlFor="pl-name-input"
              style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: 'var(--ink)', marginBottom: 4 }}
            >
              Nome da playlist *
            </label>
            <input
              id="pl-name-input"
              type="text"
              autoFocus
              className="psearch"
              placeholder="Ex: Treino Intenso, Viagem, Clássicas..."
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (error) setError(null);
              }}
              style={{ width: '100%', boxSizing: 'border-box' }}
            />
            {error && (
              <span style={{ color: '#ff4d4f', fontSize: '0.78rem', marginTop: 4, display: 'block' }}>
                {error}
              </span>
            )}
          </div>

          <div style={{ marginBottom: 16 }}>
            <label
              htmlFor="pl-desc-input"
              style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: 'var(--ink)', marginBottom: 4 }}
            >
              Descrição (opcional)
            </label>
            <textarea
              id="pl-desc-input"
              rows={2}
              className="psearch"
              placeholder="Adicione uma breve descrição para esta playlist..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              style={{
                width: '100%',
                boxSizing: 'border-box',
                resize: 'none',
                fontFamily: 'inherit',
                fontSize: '0.85rem',
              }}
            />
          </div>

          <div className="pl-modal-footer">
            <button type="button" className="sec-btn" onClick={onClose}>
              Cancelar
            </button>
            <button type="submit" className="act-btn primary">
              {isEditing ? 'Salvar alterações' : 'Criar playlist'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

interface AddToPlaylistModalProps {
  isOpen: boolean;
  onClose: () => void;
  trackKeysToAdd: string[];
  trackCountLabel: string;
  playlists: Playlist[];
  coverMap: Map<string, string | null | undefined>;
  onSelectPlaylist: (playlistId: string) => void;
  onCreateNewPlaylist: () => void;
}

export const AddToPlaylistModal: React.FC<AddToPlaylistModalProps> = ({
  isOpen,
  onClose,
  trackKeysToAdd,
  trackCountLabel,
  playlists,
  coverMap,
  onSelectPlaylist,
  onCreateNewPlaylist,
}) => {
  const [search, setSearch] = useState('');

  if (!isOpen) return null;

  const filtered = playlists.filter((p) =>
    p.name.toLowerCase().includes(search.trim().toLowerCase())
  );

  return (
    <div className="mdl on" role="dialog" aria-modal="true" aria-labelledby="add-to-pl-title">
      <div className="mdl-back" onClick={onClose} />
      <div className="mbox" style={{ maxWidth: 440 }}>
        <h3 id="add-to-pl-title" style={{ marginTop: 0, marginBottom: 4, fontSize: '1.2rem' }}>
          Adicionar à playlist
        </h3>
        <p style={{ color: 'var(--muted)', fontSize: '0.84rem', margin: '0 0 14px' }}>
          {trackCountLabel}
        </p>

        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
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
            onClick={() => {
              onClose();
              onCreateNewPlaylist();
            }}
            title="Criar nova playlist"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M12 5v14M5 12h14" />
            </svg>
            <span>Nova</span>
          </button>
        </div>

        {playlists.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '24px 10px', color: 'var(--muted)' }}>
            <p style={{ margin: '0 0 12px', fontSize: '0.9rem' }}>Você ainda não tem playlists criadas.</p>
            <button
              type="button"
              className="act-btn primary"
              onClick={() => {
                onClose();
                onCreateNewPlaylist();
              }}
            >
              Criar primeira playlist
            </button>
          </div>
        ) : (
          <div className="pl-picker-list">
            {filtered.map((pl) => {
              const alreadyHasAll =
                trackKeysToAdd.length > 0 &&
                trackKeysToAdd.every((k) => pl.trackKeys.includes(k));

              const covers = pl.trackKeys
                .map((k) => coverMap.get(k))
                .filter((c): c is string => Boolean(c))
                .slice(0, 4);

              return (
                <button
                  key={pl.id}
                  type="button"
                  className="pl-picker-item"
                  style={{ width: '100%', border: '1px solid var(--line)' }}
                  onClick={() => {
                    onSelectPlaylist(pl.id);
                    onClose();
                  }}
                >
                  <PlaylistCollage covers={covers} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: '0.9rem', color: 'var(--ink)' }}>
                      {pl.name}
                    </div>
                    <small style={{ color: 'var(--muted)', fontSize: '0.76rem' }}>
                      {plural(pl.trackKeys.length, ' faixa', ' faixas')}
                    </small>
                  </div>
                  {alreadyHasAll ? (
                    <span className="pl-badge added">Já adicionada</span>
                  ) : (
                    <span className="pl-badge">+ Adicionar</span>
                  )}
                </button>
              );
            })}
            {filtered.length === 0 && (
              <div style={{ textAlign: 'center', padding: 20, color: 'var(--muted)', fontSize: '0.85rem' }}>
                Nenhuma playlist encontrada para &ldquo;{search}&rdquo;.
              </div>
            )}
          </div>
        )}

        <div className="pl-modal-footer">
          <button type="button" className="sec-btn" onClick={onClose}>
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
};

interface AddTracksToPlaylistModalProps {
  isOpen: boolean;
  onClose: () => void;
  playlist: Playlist | null;
  tracks: Track[];
  onAddTracks: (trackKeys: string[]) => void;
}

export const AddTracksToPlaylistModal: React.FC<AddTracksToPlaylistModalProps> = ({
  isOpen,
  onClose,
  playlist,
  tracks,
  onAddTracks,
}) => {
  const [search, setSearch] = useState('');
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (isOpen) {
      setSearch('');
      setSelectedKeys(new Set());
    }
  }, [isOpen]);

  const existingKeySet = useMemo(
    () => new Set(playlist?.trackKeys || []),
    [playlist?.trackKeys]
  );

  const filteredTracks = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return tracks;
    return tracks.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        (t.artist && t.artist.toLowerCase().includes(q)) ||
        (t.album && t.album.toLowerCase().includes(q))
    );
  }, [tracks, search]);

  if (!isOpen || !playlist) return null;

  const toggleSelect = (key: string) => {
    if (existingKeySet.has(key)) return;
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const handleConfirm = () => {
    if (selectedKeys.size > 0) {
      onAddTracks(Array.from(selectedKeys));
    }
    onClose();
  };

  return (
    <div className="mdl on" role="dialog" aria-modal="true" aria-labelledby="add-tracks-title">
      <div className="mdl-back" onClick={onClose} />
      <div className="mbox" style={{ maxWidth: 480, maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}>
        <h3 id="add-tracks-title" style={{ marginTop: 0, marginBottom: 4, fontSize: '1.2rem' }}>
          Adicionar músicas à playlist
        </h3>
        <p style={{ color: 'var(--muted)', fontSize: '0.84rem', margin: '0 0 12px' }}>
          Playlist: <b>{playlist.name}</b>
        </p>

        <input
          type="search"
          className="psearch"
          placeholder="Buscar músicas da biblioteca..."
          aria-label="Buscar músicas"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: '100%', boxSizing: 'border-box', margin: '0 0 10px' }}
        />

        <div className="pl-picker-list" style={{ flex: 1, minHeight: 200, maxHeight: '50vh' }}>
          {filteredTracks.map((t) => {
            const isAlreadyIn = existingKeySet.has(t.key);
            const isSelected = selectedKeys.has(t.key);

            return (
              <div
                key={t.key}
                className={`pl-picker-item ${isSelected ? 'selected' : ''}`}
                style={{ opacity: isAlreadyIn ? 0.6 : 1, cursor: isAlreadyIn ? 'default' : 'pointer' }}
                onClick={() => toggleSelect(t.key)}
              >
                {t.cover || t.web ? (
                  <img
                    src={t.cover || t.web!}
                    alt=""
                    style={{ width: 40, height: 40, borderRadius: 6, objectFit: 'cover' }}
                  />
                ) : (
                  <div
                    style={{
                      width: 40,
                      height: 40,
                      borderRadius: 6,
                      background: 'var(--line)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <svg style={{ width: 18, height: 18, color: 'var(--muted)' }} viewBox="0 0 24 24">
                      <path d="M9 18V5l12-2v13" />
                      <circle cx="6" cy="18" r="3" />
                      <circle cx="18" cy="16" r="3" />
                    </svg>
                  </div>
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontWeight: 600,
                      fontSize: '0.88rem',
                      color: 'var(--ink)',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {t.name}
                  </div>
                  <div
                    style={{
                      color: 'var(--muted)',
                      fontSize: '0.76rem',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {t.artist || 'Artista desconhecido'} {t.dur ? `• ${t.dur}` : ''}
                  </div>
                </div>

                {isAlreadyIn ? (
                  <span className="pl-badge added">Na playlist</span>
                ) : (
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleSelect(t.key)}
                    style={{ width: 18, height: 18, cursor: 'pointer', accentColor: 'var(--accent)' }}
                    onClick={(e) => e.stopPropagation()}
                    aria-label={`Selecionar ${t.name}`}
                  />
                )}
              </div>
            );
          })}

          {filteredTracks.length === 0 && (
            <div style={{ textAlign: 'center', padding: 30, color: 'var(--muted)', fontSize: '0.85rem' }}>
              Nenhuma música encontrada para &ldquo;{search}&rdquo;.
            </div>
          )}
        </div>

        <div className="pl-modal-footer">
          <button type="button" className="sec-btn" onClick={onClose}>
            Cancelar
          </button>
          <button
            type="button"
            className="act-btn primary"
            disabled={selectedKeys.size === 0}
            onClick={handleConfirm}
          >
            Adicionar {selectedKeys.size > 0 ? `(${selectedKeys.size})` : ''}
          </button>
        </div>
      </div>
    </div>
  );
};

interface ConfirmDeletePlaylistModalProps {
  isOpen: boolean;
  onClose: () => void;
  playlist: Playlist | null;
  onConfirm: () => void;
}

export const ConfirmDeletePlaylistModal: React.FC<ConfirmDeletePlaylistModalProps> = ({
  isOpen,
  onClose,
  playlist,
  onConfirm,
}) => {
  if (!isOpen || !playlist) return null;

  return (
    <div className="mdl on" role="dialog" aria-modal="true" aria-labelledby="del-pl-title">
      <div className="mdl-back" onClick={onClose} />
      <div className="mbox" style={{ maxWidth: 420 }}>
        <h3 id="del-pl-title" style={{ marginTop: 0, marginBottom: 8, fontSize: '1.2rem', color: '#ff4d4f' }}>
          Excluir playlist?
        </h3>
        <p style={{ color: 'var(--ink)', fontSize: '0.9rem', margin: '0 0 10px', lineHeight: 1.5 }}>
          Tem certeza de que deseja excluir a playlist <b>&ldquo;{playlist.name}&rdquo;</b>?
        </p>
        <p style={{ color: 'var(--muted)', fontSize: '0.8rem', margin: '0 0 20px' }}>
          As músicas não serão removidas da sua biblioteca, apenas esta lista personalizada será excluída.
        </p>

        <div className="pl-modal-footer">
          <button type="button" className="sec-btn" onClick={onClose}>
            Cancelar
          </button>
          <button
            type="button"
            className="act-btn"
            style={{ background: '#ff4d4f', color: '#fff', border: 'none' }}
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            Excluir playlist
          </button>
        </div>
      </div>
    </div>
  );
};
