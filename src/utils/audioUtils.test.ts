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
  parseDurationFromBlob,
  extractAudioDurationFormatted,
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

test('parseDurationFromBlob extracts WAV and MP3 durations accurately', async () => {
  // 1. Create a synthetic WAV header for 180 seconds at 44100 Hz stereo 16-bit (byteRate = 176400)
  const wavBuf = new Uint8Array(64);
  const wavView = new DataView(wavBuf.buffer);
  wavBuf.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  wavBuf.set([0x57, 0x41, 0x56, 0x45], 8); // "WAVE"
  wavBuf.set([0x66, 0x6d, 0x74, 0x20], 12); // "fmt "
  wavView.setUint32(16, 16, true); // fmt chunk size = 16
  wavView.setUint16(20, 1, true); // PCM
  wavView.setUint16(22, 2, true); // 2 channels
  wavView.setUint32(24, 44100, true); // sampleRate
  wavView.setUint32(28, 176400, true); // byteRate
  wavBuf.set([0x64, 0x61, 0x74, 0x61], 36); // "data"
  wavView.setUint32(40, 176400 * 185, true); // 185 seconds of audio

  const wavBlob = new Blob([wavBuf], { type: 'audio/wav' });
  const wavSec = await parseDurationFromBlob(wavBlob);
  assert.equal(wavSec, 185);
  const wavFormatted = await extractAudioDurationFormatted(wavBlob);
  assert.equal(wavFormatted, '3:05');

  // 2. Create a synthetic MP3 with Xing header (MPEG1 Layer III, 44100Hz, Stereo, 9000 frames)
  const mp3Buf = new Uint8Array(256);
  const mp3View = new DataView(mp3Buf.buffer);
  // MPEG1 Layer III, 128kbps (brIdx=9), 44100Hz (srIdx=0), Stereo (chBits=0)
  mp3Buf[0] = 0xff;
  mp3Buf[1] = 0xfb; // MPEG1 Layer III
  mp3Buf[2] = 0x90; // brIdx=9 (128kbps), srIdx=0 (44100Hz)
  mp3Buf[3] = 0x00; // Stereo
  // Xing header at offset 4 + 32 = 36
  mp3Buf.set([0x58, 0x69, 0x6e, 0x67], 36); // "Xing"
  mp3View.setUint32(40, 0x01, false); // flags: frames field present
  mp3View.setUint32(44, 9188, false); // 9188 frames * 1152 / 44100 ≈ 240.01 sec (4:00)

  const mp3Blob = new Blob([mp3Buf], { type: 'audio/mpeg' });
  const mp3Formatted = await extractAudioDurationFormatted(mp3Blob);
  assert.equal(mp3Formatted, '4:00');
});

