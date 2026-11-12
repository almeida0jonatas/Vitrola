import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPlaylist,
  validatePlaylistName,
  addTracksToPlaylist,
  removeTrackFromPlaylist,
  reorderPlaylistTracks,
  renamePlaylist,
  duplicatePlaylist,
  parseDurationToSeconds,
  formatPlaylistTotalDuration,
  calculatePlaylistDuration,
  generateM3uContent,
  getPlaylistCoverImages,
} from './playlistUtils';

test('validatePlaylistName checks empty and valid names', () => {
  assert.equal(validatePlaylistName('').valid, false);
  assert.equal(validatePlaylistName('   ').valid, false);
  assert.equal(validatePlaylistName('Minha Playlist').valid, true);
  assert.equal(validatePlaylistName('a'.repeat(81)).valid, false);
  assert.equal(validatePlaylistName('a'.repeat(80)).valid, true);
});

test('createPlaylist creates playlist with unique ID and timestamp', () => {
  const pl = createPlaylist('Favoritas da Manhã', 'Músicas para acordar', ['track1', 'track2']);
  assert.equal(pl.name, 'Favoritas da Manhã');
  assert.equal(pl.description, 'Músicas para acordar');
  assert.deepEqual(pl.trackKeys, ['track1', 'track2']);
  assert.ok(pl.id.startsWith('pl_'));
  assert.ok(pl.createdAt > 0);
  assert.equal(pl.createdAt, pl.updatedAt);
});

test('addTracksToPlaylist prevents duplicates when requested', () => {
  const pl = createPlaylist('Treino', '', ['track1', 'track2']);
  const updated = addTracksToPlaylist(pl, ['track2', 'track3', 'track4'], false);

  assert.deepEqual(updated.trackKeys, ['track1', 'track2', 'track3', 'track4']);
  assert.ok(updated.updatedAt >= pl.updatedAt);

  // If no new tracks added, returns same or unchanged trackKeys
  const noChange = addTracksToPlaylist(updated, ['track1', 'track3'], false);
  assert.deepEqual(noChange.trackKeys, ['track1', 'track2', 'track3', 'track4']);
});

test('removeTrackFromPlaylist removes track at specific index', () => {
  const pl = createPlaylist('Chill', '', ['t0', 't1', 't2', 't3']);
  const removed = removeTrackFromPlaylist(pl, 1);
  assert.deepEqual(removed.trackKeys, ['t0', 't2', 't3']);

  // Invalid index returns original
  const invalid = removeTrackFromPlaylist(removed, 99);
  assert.deepEqual(invalid.trackKeys, ['t0', 't2', 't3']);
});

test('reorderPlaylistTracks moves track positions correctly', () => {
  const pl = createPlaylist('Viagem', '', ['A', 'B', 'C', 'D']);
  // Move 'C' (index 2) to start (index 0)
  const moved = reorderPlaylistTracks(pl, 2, 0);
  assert.deepEqual(moved.trackKeys, ['C', 'A', 'B', 'D']);

  // Move 'A' (index 1) to end (index 3)
  const movedToEnd = reorderPlaylistTracks(moved, 1, 3);
  assert.deepEqual(movedToEnd.trackKeys, ['C', 'B', 'D', 'A']);
});

test('renamePlaylist updates name and description', () => {
  const pl = createPlaylist('Antigo', 'Desc antiga');
  const updated = renamePlaylist(pl, 'Novo Nome', 'Nova Desc');
  assert.equal(updated.name, 'Novo Nome');
  assert.equal(updated.description, 'Nova Desc');
});

test('duplicatePlaylist creates a copy with new ID', () => {
  const pl = createPlaylist('Original', 'Desc', ['k1', 'k2']);
  const dup = duplicatePlaylist(pl);
  assert.notEqual(dup.id, pl.id);
  assert.equal(dup.name, 'Original (Cópia)');
  assert.deepEqual(dup.trackKeys, ['k1', 'k2']);
});

test('duration calculations and formatting', () => {
  assert.equal(parseDurationToSeconds('03:45'), 225);
  assert.equal(parseDurationToSeconds('01:02:10'), 3730);
  assert.equal(parseDurationToSeconds(''), 0);

  assert.equal(formatPlaylistTotalDuration(225), '3 min');
  assert.equal(formatPlaylistTotalDuration(3600), '1 h');
  assert.equal(formatPlaylistTotalDuration(3730), '1 h 2 min');

  assert.equal(calculatePlaylistDuration(['03:30', '02:30', '04:00']), '10 min');
});

test('generateM3uContent outputs valid m3u playlist', () => {
  const pl = createPlaylist('Rock Clássico', 'Seleção dos anos 70', ['k1', 'k2']);
  const m3u = generateM3uContent(pl, [
    { key: 'k1', name: 'Stairway to Heaven', artist: 'Led Zeppelin', dur: '08:02' },
    { key: 'k2', name: 'Bohemian Rhapsody', artist: 'Queen', dur: '05:55' },
  ]);

  assert.ok(m3u.includes('#EXTM3U'));
  assert.ok(m3u.includes('#PLAYLIST:Rock Clássico'));
  assert.ok(m3u.includes('Led Zeppelin - Stairway to Heaven'));
  assert.ok(m3u.includes('Queen - Bohemian Rhapsody'));
});

test('getPlaylistCoverImages extracts up to 4 unique covers', () => {
  const coverMap = new Map<string, string | null | undefined>([
    ['t1', 'http://img1.jpg'],
    ['t2', 'http://img2.jpg'],
    ['t3', 'http://img1.jpg'], // duplicate
    ['t4', 'http://img3.jpg'],
    ['t5', 'http://img4.jpg'],
    ['t6', 'http://img5.jpg'],
  ]);

  const images = getPlaylistCoverImages(['t1', 't2', 't3', 't4', 't5', 't6'], coverMap);
  assert.equal(images.length, 4);
  assert.deepEqual(images, ['http://img1.jpg', 'http://img2.jpg', 'http://img3.jpg', 'http://img4.jpg']);
});
