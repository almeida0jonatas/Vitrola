import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatTime,
  plural,
  parseLrc,
  nrm,
  similar,
  primary,
  clip,
  artKey,
  albKey,
  shuffled,
  dec,
} from './audioUtils.ts';

test('formatTime formats seconds properly', () => {
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(45), '0:45');
  assert.equal(formatTime(65), '1:05');
  assert.equal(formatTime(600), '10:00');
  assert.equal(formatTime(3665), '61:05');
  assert.equal(formatTime(-1), '0:00');
  assert.equal(formatTime(NaN), '0:00');
});

test('plural formats Portuguese count strings', () => {
  assert.equal(plural(1, ' música', ' músicas'), '1 música');
  assert.equal(plural(0, ' música', ' músicas'), '0 músicas');
  assert.equal(plural(5, ' faixa', ' faixas'), '5 faixas');
  assert.equal(plural(1, ' álbum', ' álbuns'), '1 álbum');
});

test('parseLrc parses timestamped lyric lines in order', () => {
  const lrc = `
[00:12.50]Primeira linha da música
[00:04.20]Introdução instrumental
[01:05.00]Refrão emocionante
`;
  const parsed = parseLrc(lrc);
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].txt, 'Introdução instrumental');
  assert.equal(parsed[0].t, 4.2);
  assert.equal(parsed[1].txt, 'Primeira linha da música');
  assert.equal(parsed[1].t, 12.5);
  assert.equal(parsed[2].txt, 'Refrão emocionante');
  assert.equal(parsed[2].t, 65.0);
});

test('parseLrc handles empty or malformed strings gracefully', () => {
  assert.deepEqual(parseLrc(''), []);
  assert.deepEqual(parseLrc('Sem timestamps aqui\nNem aqui'), []);
});

test('nrm normalizes accents, uppercase, and punctuation', () => {
  assert.equal(nrm('Legião Urbana'), 'legiao urbana');
  assert.equal(nrm('Rock & Roll!'), 'rock and roll');
  assert.equal(nrm('  Música Boa   '), 'musica boa');
});

test('similar tests substring and equality matching', () => {
  assert.equal(similar('Abbey Road', 'abbey road'), true);
  assert.equal(similar('As Quatro Estações', 'Quatro Estações'), true);
  assert.equal(similar('Pink Floyd', 'Metallica'), false);
});

test('primary extracts lead artist name', () => {
  assert.equal(primary('Daft Punk feat. Pharrell Williams'), 'Daft Punk');
  assert.equal(primary('Anitta ft. Cardi B'), 'Anitta');
  assert.equal(primary('Caetano Veloso; Gilberto Gil'), 'Caetano Veloso');
  assert.equal(primary('Elis Regina / Tom Jobim'), 'Elis Regina');
  assert.equal(primary('Chico Buarque'), 'Chico Buarque');
});

test('clip limits text to requested length cleanly', () => {
  const longText = 'Era uma vez uma banda. Eles tocaram em muitos lugares. Gravaram vários discos famosos.';
  const clipped = clip(longText, 40);
  assert.ok(clipped.length <= 41);
  assert.ok(clipped.endsWith('.') || clipped.endsWith('…'));
});

test('artKey and albKey generate consistent grouping keys', () => {
  assert.equal(artKey({ artist: 'Legião Urbana' }), 'Legião Urbana');
  assert.equal(artKey({}), 'Artista desconhecido');
  assert.equal(albKey({ album: 'Dois', artist: 'Legião Urbana' }), 'Dois||Legião Urbana');
  assert.equal(albKey({}), 'Álbum desconhecido||');
});

test('shuffled produces a permutation with same items', () => {
  const orig = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const shuf = shuffled(orig);
  assert.equal(shuf.length, orig.length);
  assert.deepEqual([...shuf].sort((a, b) => a - b), orig);
});

test('dec decodes UTF-8 and ISO-8859-1 buffers', () => {
  const utf8 = new TextEncoder().encode('Olá Mundo\0extra');
  assert.equal(dec(utf8, 3), 'Olá Mundo');
});
