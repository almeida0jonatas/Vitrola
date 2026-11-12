/**
 * Pure utility functions for Vitrola local audio player
 * Handles formatting, LRC parsing, string normalization, tag extraction helpers, etc.
 */

export interface Track {
  id?: number;
  key: string;
  name: string;
  artist?: string;
  album?: string;
  cover?: string | null;
  coverBlob?: Blob | null;
  web?: string | null;
  url: string;
  dur?: string;
  file?: Blob | null;
}

export interface LyricLine {
  t: number;
  txt: string;
}

export const ART_UNK = 'Artista desconhecido';
export const ALB_UNK = 'Álbum desconhecido';

/**
 * Format duration in seconds to MM:SS string
 */
export function formatTime(s: number): string {
  if (!isFinite(s) || isNaN(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

/**
 * Pluralize helper
 */
export function plural(n: number, singular: string, pluralStr: string): string {
  return `${n}${n === 1 ? singular : pluralStr}`;
}

/**
 * Parse LRC synchronized lyric text
 */
export function parseLrc(s: string): LyricLine[] {
  if (!s) return [];
  const out: LyricLine[] = [];
  const lines = s.split(/\r?\n/);
  for (const l of lines) {
    const txt = l.replace(/\[[^\]]*\]/g, '').trim();
    const matches = l.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g);
    for (const m of matches) {
      const min = parseFloat(m[1]);
      const sec = parseFloat(m[2]);
      if (!isNaN(min) && !isNaN(sec)) {
        out.push({ t: min * 60 + sec, txt });
      }
    }
  }
  return out.sort((x, y) => x.t - y.t);
}

/**
 * Text normalization for artist/album search
 */
export function nrm(s?: string): string {
  return (s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Similarity check for album/artist matching
 */
export function similar(x?: string, y?: string): boolean {
  const p = nrm(x);
  const q = nrm(y);
  return Boolean(p && q && (p === q || p.includes(q) || q.includes(p)));
}

/**
 * Primary artist extractor (removes feat., ft., /, ;, ,, &, etc. so collaborations group under the main artist)
 */
export function primary(name?: string): string {
  if (!name) return '';
  const cleaned = name
    .replace(/\s*\((?:feat\.?|ft\.?|featuring|with|part\.?)\b[^)]*\)/gi, '')
    .replace(/\s*\[(?:feat\.?|ft\.?|featuring|with|part\.?)\b[^\]]*\]/gi, '')
    .split(
      /\s*(?:;|\/|,|\bfeat\.?\b|\bft\.?\b|\bfeaturing\b|\bwith\b|\bvs\.?\b|\bpart\.?\b)\s*/i
    )[0]
    .trim();
  return cleaned || name.trim();
}

/**
 *Truncate long bio cleanly
 */
export function clip(s: string, maxLen: number): string {
  s = (s || '').replace(/[ \t]+\n/g, '\n').trim();
  if (s.length <= maxLen) return s;
  const c = s.slice(0, maxLen);
  const k = Math.max(c.lastIndexOf('. '), c.lastIndexOf('.\n'));
  return k > maxLen * 0.5 ? c.slice(0, k + 1) : c + '…';
}

/**
 * Artist group key (canonical primary artist display name)
 */
export function artKey(t: { artist?: string }): string {
  const p = primary(t.artist);
  return p || ART_UNK;
}

/**
 * Album group key
 */
export function albKey(t: { album?: string; artist?: string }): string {
  const p = primary(t.artist);
  return `${(t.album || ALB_UNK).trim()}||${p}`;
}

/**
 * Non-mutating array shuffle (Fisher-Yates)
 */
export function shuffled<T>(arr: T[]): T[] {
  const a2 = arr.slice();
  for (let j = a2.length - 1; j > 0; j--) {
    const k = Math.floor(Math.random() * (j + 1));
    [a2[j], a2[k]] = [a2[k], a2[j]];
  }
  return a2;
}

/**
 * Binary string decoder for ID3 tags
 */
export function dec(b: Uint8Array, enc: number): string {
  let s = '';
  try {
    if (enc === 1) {
      let le = true;
      if (b[0] === 0xFE && b[1] === 0xFF) {
        le = false;
        b = b.subarray(2);
      } else if (b[0] === 0xFF && b[1] === 0xFE) {
        b = b.subarray(2);
      }
      s = new TextDecoder(le ? 'utf-16le' : 'utf-16be').decode(b);
    } else if (enc === 2) {
      s = new TextDecoder('utf-16be').decode(b);
    } else if (enc === 3) {
      s = new TextDecoder('utf-8').decode(b);
    } else {
      s = new TextDecoder('windows-1252').decode(b);
    }
  } catch {
    s = '';
  }
  return s.split('\0')[0].trim();
}

/**
 * Extract ID3 metadata from audio file
 */
export async function readTags(file: Blob): Promise<{
  title?: string;
  artist?: string;
  album?: string;
  cover?: string;
  coverBlob?: Blob;
}> {
  const t: {
    title?: string;
    artist?: string;
    album?: string;
    cover?: string;
    coverBlob?: Blob;
  } = {};

  try {
    const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
    if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) { // "ID3"
      const ver = head[3];
      const v2 = ver === 2;
      const hl = v2 ? 6 : 10;
      const size = (head[6] << 21) | (head[7] << 14) | (head[8] << 7) | head[9];
      const buf = new Uint8Array(await file.slice(10, 10 + size).arrayBuffer());
      const map: Record<string, 'title' | 'artist' | 'album'> = {
        TIT2: 'title',
        TT2: 'title',
        TPE1: 'artist',
        TP1: 'artist',
        TALB: 'album',
        TAL: 'album',
      };
      let p = 0;
      while (p + hl <= buf.length) {
        const id = String.fromCharCode(...buf.subarray(p, p + (v2 ? 3 : 4)));
        if (!/^[A-Z0-9]+$/.test(id)) break;
        let sz = 0;
        if (v2) {
          sz = (buf[p + 3] << 16) | (buf[p + 4] << 8) | buf[p + 5];
        } else if (ver === 4) {
          sz = (buf[p + 4] << 21) | (buf[p + 5] << 14) | (buf[p + 6] << 7) | buf[p + 7];
        } else {
          sz = ((buf[p + 4] << 24) | (buf[p + 5] << 16) | (buf[p + 6] << 8) | buf[p + 7]) >>> 0;
        }
        const d = buf.subarray(p + hl, p + hl + sz);
        p += hl + sz;
        if (!d.length) continue;
        const m = map[id];
        if (m && !t[m]) {
          t[m] = dec(d.subarray(1), d[0]);
        } else if ((id === 'APIC' || id === 'PIC') && !t.cover) {
          const encType = d[0];
          let q = 1;
          if (v2) {
            q = 4;
          } else {
            while (q < d.length && d[q] !== 0) q++;
            q++;
          }
          q++;
          if (encType === 1 || encType === 2) {
            while (q + 1 < d.length && !(d[q] === 0 && d[q + 1] === 0)) q += 2;
            q += 2;
          } else {
            while (q < d.length && d[q] !== 0) q++;
            q++;
          }
          const img = d.subarray(q);
          if (img.length > 100) {
            t.coverBlob = new Blob([img], { type: img[0] === 0x89 ? 'image/png' : 'image/jpeg' });
            if (typeof URL !== 'undefined' && URL.createObjectURL) {
              t.cover = URL.createObjectURL(t.coverBlob);
            }
          }
        }
      }
    }

    if (!t.title && file.size > 128) {
      const e = new Uint8Array(await file.slice(file.size - 128).arrayBuffer());
      if (e[0] === 0x54 && e[1] === 0x41 && e[2] === 0x47) { // "TAG"
        const f = (a: number, b: number) => dec(e.subarray(a, b), 0);
        t.title = f(3, 33);
        t.artist = t.artist || f(33, 63);
        t.album = t.album || f(63, 93);
      }
    }
  } catch {
    // Graceful fallback for non-mp3 or malformed tags
  }

  return t;
}

export interface QueueItem {
  uid: string;
  trackIdx: number;
  isManual?: boolean;
  origIdx?: number;
}

export function parseDurationToSeconds(dur?: string): number {
  if (!dur) return 0;
  const parts = dur.split(':').map((x) => parseFloat(x));
  if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
    return parts[0] * 60 + parts[1];
  }
  if (parts.length === 3 && !isNaN(parts[0]) && !isNaN(parts[1]) && !isNaN(parts[2])) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return 0;
}

export function formatQueueSummaryDuration(totalSec: number): string {
  if (totalSec <= 0) return '';
  const m = Math.floor(totalSec / 60);
  const h = Math.floor(m / 60);
  const remMin = m % 60;
  if (h > 0) {
    return `${h} h ${remMin > 0 ? `${remMin} min` : ''}`.trim();
  }
  return `${m} min`;
}

export interface RawTrackFileInfo {
  originalFileName: string;
  extension: string;
  mimeType: string;
  containerCodec: string;
  sizeBytes: number;
  sizeFormatted: string;
  sampleRateHz: number | null;
  sampleRateFormatted: string;
  bitrateKbps: number | null;
  bitrateMode: string;
  bitrateFormatted: string;
  channels: number | null;
  channelMode: string;
  bitDepth: string;
  durationSec: number | null;
  durationFormatted: string;
  tagFormat: string;
  tagSizeBytes: number;
  embeddedCoverInfo: string;
  encoder?: string;
  year?: string;
  trackNumber?: string;
  genre?: string;
  lastModified?: string;
  storageKey: string;
  dbId?: number;
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1).replace('.', ',')} KB (${bytes.toLocaleString('pt-BR')} B)`;
  const mb = kb / 1024;
  return `${mb.toFixed(2).replace('.', ',')} MB (${bytes.toLocaleString('pt-BR')} B)`;
}

export function probeAudioDuration(url: string): Promise<number | null> {
  return new Promise((resolve) => {
    if (typeof Audio === 'undefined' || !url) {
      resolve(null);
      return;
    }
    const a = new Audio();
    let done = false;
    const finish = (val: number | null) => {
      if (done) return;
      done = true;
      try {
        a.removeAttribute('src');
        a.load();
      } catch {
        // ignore
      }
      resolve(val);
    };
    const timer = setTimeout(() => finish(null), 1500);
    a.preload = 'metadata';
    a.onloadedmetadata = () => {
      clearTimeout(timer);
      finish(Number.isFinite(a.duration) && a.duration > 0 ? a.duration : null);
    };
    a.onerror = () => {
      clearTimeout(timer);
      finish(null);
    };
    a.src = url;
    try {
      a.load();
    } catch {
      // ignore
    }
  });
}

/**
 * Extracts audio duration in seconds directly from binary container headers (MP3, WAV, FLAC, M4A)
 * without instantiating HTMLAudioElement instances. Runs in <1ms per file.
 */
export async function parseDurationFromBlob(blob?: Blob | null): Promise<number | null> {
  if (!blob || blob.size <= 16) return null;

  try {
    const headSliceSize = Math.min(blob.size, 131072);
    const headBuf = new Uint8Array(await blob.slice(0, headSliceSize).arrayBuffer());
    const headView = new DataView(headBuf.buffer, headBuf.byteOffset, headBuf.byteLength);

    let audioOffset = 0;
    let hasId3v1 = false;

    // 1. Check ID3v2 header
    if (headBuf[0] === 0x49 && headBuf[1] === 0x44 && headBuf[2] === 0x33) {
      const ver = headBuf[3];
      const v2 = ver === 2;
      const hl = v2 ? 6 : 10;
      const id3Size =
        (headBuf[6] << 21) | (headBuf[7] << 14) | (headBuf[8] << 7) | headBuf[9];
      const tagSizeBytes = id3Size + 10;
      audioOffset = tagSizeBytes;

      // Check for TLEN frame (duration in milliseconds) inside ID3v2
      const tagSlice =
        tagSizeBytes <= headBuf.length
          ? headBuf.subarray(10, tagSizeBytes)
          : new Uint8Array(await blob.slice(10, Math.min(blob.size, Math.min(tagSizeBytes, 65536))).arrayBuffer());
      let p = 0;
      while (p + hl <= tagSlice.length) {
        const id = String.fromCharCode(...tagSlice.subarray(p, p + (v2 ? 3 : 4)));
        if (!/^[A-Z0-9]+$/.test(id)) break;
        let sz = 0;
        if (v2) {
          sz = (tagSlice[p + 3] << 16) | (tagSlice[p + 4] << 8) | tagSlice[p + 5];
        } else if (ver === 4) {
          sz =
            (tagSlice[p + 4] << 21) |
            (tagSlice[p + 5] << 14) |
            (tagSlice[p + 6] << 7) |
            tagSlice[p + 7];
        } else {
          sz =
            ((tagSlice[p + 4] << 24) |
              (tagSlice[p + 5] << 16) |
              (tagSlice[p + 6] << 8) |
              tagSlice[p + 7]) >>>
            0;
        }
        if (sz <= 0 || p + hl + sz > tagSlice.length) break;
        const d = tagSlice.subarray(p + hl, p + hl + sz);
        p += hl + sz;
        if (id === 'TLEN' || id === 'TLE') {
          const msStr = dec(d.subarray(1), d[0]);
          const ms = parseFloat(msStr);
          if (Number.isFinite(ms) && ms > 0) {
            return ms / 1000;
          }
        }
      }
    } else if (blob.size > 128) {
      const tail = new Uint8Array(await blob.slice(blob.size - 128).arrayBuffer());
      if (tail[0] === 0x54 && tail[1] === 0x41 && tail[2] === 0x47) {
        hasId3v1 = true;
      }
    }

    const streamBuf =
      audioOffset + 4096 <= headBuf.length
        ? headBuf.subarray(audioOffset)
        : new Uint8Array(
            await blob.slice(audioOffset, Math.min(blob.size, audioOffset + 65536)).arrayBuffer()
          );
    const streamView = new DataView(streamBuf.buffer, streamBuf.byteOffset, streamBuf.byteLength);

    // 2A. RIFF WAVE
    if (
      streamBuf.length >= 44 &&
      streamBuf[0] === 0x52 &&
      streamBuf[1] === 0x49 &&
      streamBuf[2] === 0x46 &&
      streamBuf[3] === 0x46 &&
      streamBuf[8] === 0x57 &&
      streamBuf[9] === 0x41 &&
      streamBuf[10] === 0x56 &&
      streamBuf[11] === 0x45
    ) {
      let pos = 12;
      let byteRate = 0;
      let dataSize = 0;
      while (pos + 8 <= streamBuf.length) {
        const chunkId = String.fromCharCode(
          streamBuf[pos],
          streamBuf[pos + 1],
          streamBuf[pos + 2],
          streamBuf[pos + 3]
        );
        const chunkSize = streamView.getUint32(pos + 4, true);
        if (chunkId === 'fmt ' && pos + 24 <= streamBuf.length) {
          byteRate = streamView.getUint32(pos + 16, true);
        } else if (chunkId === 'data') {
          dataSize = chunkSize;
          break;
        }
        pos += 8 + chunkSize + (chunkSize % 2);
      }
      if (byteRate > 0) {
        const effectiveData = dataSize > 0 ? dataSize : Math.max(0, blob.size - audioOffset - 44);
        if (effectiveData > 0) return effectiveData / byteRate;
      }
    }

    // 2B. FLAC ("fLaC")
    if (
      streamBuf.length >= 42 &&
      streamBuf[0] === 0x66 &&
      streamBuf[1] === 0x4c &&
      streamBuf[2] === 0x61 &&
      streamBuf[3] === 0x43
    ) {
      const s = streamBuf.subarray(8, 42);
      const sampleRateHz = (s[10] << 12) | (s[11] << 4) | (s[12] >> 4);
      const totalSamples =
        (s[13] & 0x0f) * 4294967296 +
        (((s[14] << 24) | (s[15] << 16) | (s[16] << 8) | s[17]) >>> 0);
      if (sampleRateHz > 0 && totalSamples > 0) {
        return totalSamples / sampleRateHz;
      }
    }

    // 2C. MP4 / M4A ("ftyp")
    if (
      headBuf.length >= 16 &&
      headBuf[4] === 0x66 &&
      headBuf[5] === 0x74 &&
      headBuf[6] === 0x79 &&
      headBuf[7] === 0x70
    ) {
      const findMvhdDuration = (buf: Uint8Array, view: DataView): number | null => {
        for (let i = 0; i + 36 < buf.length; i++) {
          if (
            buf[i] === 0x6d &&
            buf[i + 1] === 0x76 &&
            buf[i + 2] === 0x68 &&
            buf[i + 3] === 0x64
          ) {
            const ver = buf[i + 4];
            if (ver === 0 && i + 24 <= buf.length) {
              const timescale = view.getUint32(i + 16, false);
              const durUnits = view.getUint32(i + 20, false);
              if (timescale > 0 && durUnits > 0 && durUnits !== 0xffffffff) {
                return durUnits / timescale;
              }
            } else if (ver === 1 && i + 36 <= buf.length) {
              const timescale = view.getUint32(i + 24, false);
              const durHigh = view.getUint32(i + 28, false);
              const durLow = view.getUint32(i + 32, false);
              const durUnits = durHigh * 4294967296 + durLow;
              if (timescale > 0 && durUnits > 0) {
                return durUnits / timescale;
              }
            }
          }
        }
        return null;
      };
      const headDur = findMvhdDuration(headBuf, headView);
      if (headDur && headDur > 0) return headDur;
      if (blob.size > headSliceSize) {
        const tailSize = Math.min(blob.size, 131072);
        const tailBuf = new Uint8Array(await blob.slice(blob.size - tailSize).arrayBuffer());
        const tailView = new DataView(tailBuf.buffer, tailBuf.byteOffset, tailBuf.byteLength);
        const tailDur = findMvhdDuration(tailBuf, tailView);
        if (tailDur && tailDur > 0) return tailDur;
      }
    }

    // 2D. MP3 (MPEG Audio Frame Header + Xing/Info/VBRI or CBR fallback)
    const maxScan = Math.min(streamBuf.length - 4, 32768);
    for (let i = 0; i < maxScan; i++) {
      if (streamBuf[i] === 0xff && (streamBuf[i + 1] & 0xe0) === 0xe0) {
        const b1 = streamBuf[i + 1];
        const b2 = streamBuf[i + 2];
        const b3 = streamBuf[i + 3];
        const verBits = (b1 >> 3) & 0x03; // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
        const layerBits = (b1 >> 1) & 0x03; // 1=Layer III, 2=Layer II, 3=Layer I
        const brIdx = (b2 >> 4) & 0x0f;
        const srIdx = (b2 >> 2) & 0x03;
        const chBits = (b3 >> 6) & 0x03;

        if (verBits !== 1 && layerBits !== 0 && brIdx !== 0 && brIdx !== 15 && srIdx !== 3) {
          const srTable: Record<number, [number, number, number]> = {
            3: [44100, 48000, 32000],
            2: [22050, 24000, 16000],
            0: [11025, 12000, 8000],
          };
          const sampleRateHz = srTable[verBits]?.[srIdx] || 0;
          const samplesPerFrame =
            layerBits === 3 ? 384 : layerBits === 2 ? 1152 : verBits === 3 ? 1152 : 576;

          // Check Xing / Info VBR header
          const sideInfoSize =
            verBits === 3 ? (chBits === 3 ? 17 : 32) : chBits === 3 ? 9 : 17;
          const xingPos = i + 4 + sideInfoSize;
          if (xingPos + 12 <= streamBuf.length && sampleRateHz > 0) {
            const xingId = String.fromCharCode(
              streamBuf[xingPos],
              streamBuf[xingPos + 1],
              streamBuf[xingPos + 2],
              streamBuf[xingPos + 3]
            );
            if (xingId === 'Xing' || xingId === 'Info') {
              const flags = streamView.getUint32(xingPos + 4, false);
              if (flags & 0x01) {
                const totalFrames = streamView.getUint32(xingPos + 8, false);
                if (totalFrames > 0) {
                  return (totalFrames * samplesPerFrame) / sampleRateHz;
                }
              }
            }
          }

          // Check VBRI header
          const vbriPos = i + 4 + 32;
          if (vbriPos + 18 <= streamBuf.length && sampleRateHz > 0) {
            const vbriId = String.fromCharCode(
              streamBuf[vbriPos],
              streamBuf[vbriPos + 1],
              streamBuf[vbriPos + 2],
              streamBuf[vbriPos + 3]
            );
            if (vbriId === 'VBRI') {
              const totalFrames = streamView.getUint32(vbriPos + 14, false);
              if (totalFrames > 0) {
                return (totalFrames * samplesPerFrame) / sampleRateHz;
              }
            }
          }

          // CBR MP3 fallback
          const brMpeg1L3 = [
            0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0,
          ];
          const brMpeg2L3 = [
            0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0,
          ];
          const bitrateKbps =
            verBits === 3 ? brMpeg1L3[brIdx] || 0 : brMpeg2L3[brIdx] || 0;
          if (bitrateKbps > 0) {
            const audioPayloadBytes = Math.max(
              0,
              blob.size - audioOffset - i - (hasId3v1 ? 128 : 0)
            );
            if (audioPayloadBytes > 0) {
              return (audioPayloadBytes * 8) / (bitrateKbps * 1000);
            }
          }
          break;
        }
      }
    }
  } catch {
    // ignore binary parsing errors
  }

  return null;
}

/**
 * Extracts formatted MM:SS duration string from a track's Blob or object URL.
 */
export async function extractAudioDurationFormatted(
  file?: Blob | null,
  url?: string
): Promise<string | undefined> {
  let sec = await parseDurationFromBlob(file);
  if ((!sec || sec <= 0) && url) {
    sec = await probeAudioDuration(url);
  }
  if (sec && Number.isFinite(sec) && sec > 0) {
    return formatTime(Math.round(sec));
  }
  return undefined;
}

export async function inspectTrackFile(track: Track): Promise<RawTrackFileInfo> {
  // 1. Resolve original filename & size from key or File object
  const keyParts = (track.key || '').split('|');
  const isDemo = keyParts[0] === 'demo';
  let originalFileName = isDemo
    ? `${keyParts[1] || track.name}.wav`
    : keyParts[0] || `${track.name}.mp3`;

  let blob: Blob | null = track.file || null;
  if (!blob && track.url) {
    try {
      const res = await fetch(track.url);
      if (res.ok) blob = await res.blob();
    } catch {
      // ignore
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fileObj = blob as any;
  if (fileObj && typeof fileObj.name === 'string' && fileObj.name.trim()) {
    originalFileName = fileObj.name.trim();
  }

  const extMatch = originalFileName.match(/\.([a-z0-9]+)$/i);
  const extension = extMatch ? extMatch[1].toUpperCase() : isDemo ? 'WAV' : 'MP3';

  const sizeFromKey = isDemo ? parseInt(keyParts[2] || '0', 10) : parseInt(keyParts[1] || '0', 10);
  const sizeBytes = blob?.size || (Number.isFinite(sizeFromKey) ? sizeFromKey : 0);

  const mimeMap: Record<string, string> = {
    MP3: 'audio/mpeg',
    FLAC: 'audio/flac',
    WAV: 'audio/wav',
    M4A: 'audio/mp4',
    AAC: 'audio/aac',
    OGG: 'audio/ogg',
    OPUS: 'audio/opus',
  };
  const mimeType = (blob?.type && blob.type.trim()) || mimeMap[extension] || 'audio/mpeg';

  let lastModified: string | undefined;
  if (fileObj && typeof fileObj.lastModified === 'number' && fileObj.lastModified > 0) {
    try {
      lastModified = new Date(fileObj.lastModified).toLocaleString('pt-BR');
    } catch {
      // ignore
    }
  }

  // Default values
  let containerCodec = extension;
  let sampleRateHz: number | null = null;
  let bitrateKbps: number | null = null;
  let bitrateMode = '';
  let channels: number | null = null;
  let channelMode = '';
  let bitDepth = '16 bits (padrão)';
  let tagFormat = 'Nenhuma tag detectada';
  let tagSizeBytes = 0;
  let embeddedCoverInfo = 'Não possui';
  let encoder: string | undefined;
  let year: string | undefined;
  let trackNumber: string | undefined;
  let genre: string | undefined;

  if (blob && blob.size > 16) {
    try {
      // Read initial header (up to 256 KB to cover ID3v2 + initial audio frame)
      const headSliceSize = Math.min(blob.size, 262144);
      const headBuf = new Uint8Array(await blob.slice(0, headSliceSize).arrayBuffer());
      const headView = new DataView(headBuf.buffer, headBuf.byteOffset, headBuf.byteLength);

      let audioOffset = 0;

      // Check ID3v2 tag at start
      if (headBuf[0] === 0x49 && headBuf[1] === 0x44 && headBuf[2] === 0x33) {
        const ver = headBuf[3];
        const rev = headBuf[4];
        const v2 = ver === 2;
        const hl = v2 ? 6 : 10;
        const id3Size =
          (headBuf[6] << 21) | (headBuf[7] << 14) | (headBuf[8] << 7) | headBuf[9];
        tagFormat = `ID3v2.${ver}.${rev}`;
        tagSizeBytes = id3Size + 10;
        audioOffset = tagSizeBytes;

        // Parse extra ID3 frames if within slice
        const tagSlice =
          tagSizeBytes <= headBuf.length
            ? headBuf.subarray(10, tagSizeBytes)
            : new Uint8Array(await blob.slice(10, Math.min(blob.size, tagSizeBytes)).arrayBuffer());

        let p = 0;
        while (p + hl <= tagSlice.length) {
          const id = String.fromCharCode(...tagSlice.subarray(p, p + (v2 ? 3 : 4)));
          if (!/^[A-Z0-9]+$/.test(id)) break;
          let sz = 0;
          if (v2) {
            sz = (tagSlice[p + 3] << 16) | (tagSlice[p + 4] << 8) | tagSlice[p + 5];
          } else if (ver === 4) {
            sz =
              (tagSlice[p + 4] << 21) |
              (tagSlice[p + 5] << 14) |
              (tagSlice[p + 6] << 7) |
              tagSlice[p + 7];
          } else {
            sz =
              ((tagSlice[p + 4] << 24) |
                (tagSlice[p + 5] << 16) |
                (tagSlice[p + 6] << 8) |
                tagSlice[p + 7]) >>>
              0;
          }
          if (sz <= 0 || p + hl + sz > tagSlice.length) break;
          const d = tagSlice.subarray(p + hl, p + hl + sz);
          p += hl + sz;

          if (id === 'TYER' || id === 'TDRC' || id === 'TYE') {
            year = dec(d.subarray(1), d[0]) || year;
          } else if (id === 'TRCK' || id === 'TRK') {
            trackNumber = dec(d.subarray(1), d[0]) || trackNumber;
          } else if (id === 'TCON' || id === 'TCO') {
            genre = dec(d.subarray(1), d[0]) || genre;
          } else if (id === 'TSSE' || id === 'TENC' || id === 'TEN') {
            encoder = dec(d.subarray(1), d[0]) || encoder;
          } else if (id === 'APIC' || id === 'PIC') {
            const encType = d[0];
            let q = 1;
            if (v2) {
              q = 4;
            } else {
              while (q < d.length && d[q] !== 0) q++;
              q++;
            }
            q++;
            if (encType === 1 || encType === 2) {
              while (q + 1 < d.length && !(d[q] === 0 && d[q + 1] === 0)) q += 2;
              q += 2;
            } else {
              while (q < d.length && d[q] !== 0) q++;
              q++;
            }
            const imgBytes = d.subarray(q);
            if (imgBytes.length > 64) {
              const isPng = imgBytes[0] === 0x89;
              const imgMime = isPng ? 'image/png' : 'image/jpeg';
              embeddedCoverInfo = `Sim (${imgMime} • ${(imgBytes.length / 1024).toFixed(1).replace('.', ',')} KB)`;
            }
          }
        }
      } else if (blob.size > 128) {
        // Check ID3v1 at end of file
        const tail = new Uint8Array(await blob.slice(blob.size - 128).arrayBuffer());
        if (tail[0] === 0x54 && tail[1] === 0x41 && tail[2] === 0x47) {
          tagFormat = 'ID3v1 (128 B)';
          tagSizeBytes = 128;
          const yr = dec(tail.subarray(93, 97), 0);
          if (yr) year = yr;
        }
      }

      // Ensure we have bytes starting at audioOffset to inspect the audio stream header
      const streamBuf =
        audioOffset + 4096 <= headBuf.length
          ? headBuf.subarray(audioOffset)
          : new Uint8Array(
              await blob
                .slice(audioOffset, Math.min(blob.size, audioOffset + 65536))
                .arrayBuffer()
            );
      const streamView = new DataView(
        streamBuf.buffer,
        streamBuf.byteOffset,
        streamBuf.byteLength
      );

      // 2A. Check RIFF WAVE
      if (
        streamBuf.length >= 44 &&
        streamBuf[0] === 0x52 &&
        streamBuf[1] === 0x49 &&
        streamBuf[2] === 0x46 &&
        streamBuf[3] === 0x46 &&
        streamBuf[8] === 0x57 &&
        streamBuf[9] === 0x41 &&
        streamBuf[10] === 0x56 &&
        streamBuf[11] === 0x45
      ) {
        let pos = 12;
        while (pos + 8 <= streamBuf.length) {
          const chunkId = String.fromCharCode(
            streamBuf[pos],
            streamBuf[pos + 1],
            streamBuf[pos + 2],
            streamBuf[pos + 3]
          );
          const chunkSize = streamView.getUint32(pos + 4, true);
          if (chunkId === 'fmt ' && pos + 24 <= streamBuf.length) {
            const audioFmt = streamView.getUint16(pos + 8, true);
            channels = streamView.getUint16(pos + 10, true);
            sampleRateHz = streamView.getUint32(pos + 12, true);
            const byteRate = streamView.getUint32(pos + 16, true);
            const bits = streamView.getUint16(pos + 22, true);
            containerCodec = `WAV (RIFF • ${audioFmt === 3 ? 'IEEE Float' : 'Linear PCM'})`;
            bitDepth = `${bits} bits (Lossless)`;
            bitrateKbps = byteRate > 0 ? Math.round((byteRate * 8) / 1000) : null;
            bitrateMode = 'PCM Descomprimido';
            channelMode =
              channels === 1
                ? 'Mono (1 canal)'
                : channels === 2
                  ? 'Estéreo (2 canais)'
                  : `${channels} canais`;
            break;
          }
          pos += 8 + chunkSize + (chunkSize % 2);
        }
      }
      // 2B. Check FLAC ("fLaC")
      else if (
        streamBuf.length >= 42 &&
        streamBuf[0] === 0x66 &&
        streamBuf[1] === 0x4c &&
        streamBuf[2] === 0x61 &&
        streamBuf[3] === 0x43
      ) {
        containerCodec = 'FLAC (Free Lossless Audio Codec)';
        // STREAMINFO starts at byte 8 (4 bytes "fLaC" + 4 bytes block header)
        const s = streamBuf.subarray(8, 42);
        sampleRateHz = (s[10] << 12) | (s[11] << 4) | (s[12] >> 4);
        channels = ((s[12] >> 1) & 0x07) + 1;
        const bps = (((s[12] & 0x01) << 4) | (s[13] >> 4)) + 1;
        bitDepth = `${bps} bits (Lossless)`;
        bitrateMode = 'VBR Lossless';
        channelMode =
          channels === 1
            ? 'Mono (1 canal)'
            : channels === 2
              ? 'Estéreo (2 canais)'
              : `${channels} canais`;
      }
      // 2C. Check Ogg ("OggS")
      else if (
        streamBuf.length >= 64 &&
        streamBuf[0] === 0x4f &&
        streamBuf[1] === 0x67 &&
        streamBuf[2] === 0x67 &&
        streamBuf[3] === 0x53
      ) {
        const segCount = streamBuf[26];
        const payloadStart = 27 + segCount;
        if (payloadStart + 16 <= streamBuf.length) {
          const sig = String.fromCharCode(...streamBuf.subarray(payloadStart, payloadStart + 8));
          if (sig.startsWith('\x01vorbis') && payloadStart + 28 <= streamBuf.length) {
            containerCodec = 'Ogg Vorbis';
            channels = streamBuf[payloadStart + 11];
            sampleRateHz = streamView.getUint32(payloadStart + 12, true);
            const nomBr = streamView.getInt32(payloadStart + 20, true);
            if (nomBr > 0) bitrateKbps = Math.round(nomBr / 1000);
            bitrateMode = 'VBR';
            bitDepth = 'Ponto flutuante (Lossy)';
          } else if (sig.startsWith('OpusHead') && payloadStart + 16 <= streamBuf.length) {
            containerCodec = 'Ogg Opus';
            channels = streamBuf[payloadStart + 9];
            const origRate = streamView.getUint32(payloadStart + 12, true);
            sampleRateHz = origRate || 48000;
            bitrateMode = 'VBR';
            bitDepth = 'Ponto flutuante (Opus)';
          }
          if (channels) {
            channelMode =
              channels === 1
                ? 'Mono (1 canal)'
                : channels === 2
                  ? 'Estéreo (2 canais)'
                  : `${channels} canais`;
          }
        }
      }
      // 2D. Check MP4 / M4A ("ftyp" at offset 4)
      else if (
        headBuf.length >= 16 &&
        headBuf[4] === 0x66 &&
        headBuf[5] === 0x74 &&
        headBuf[6] === 0x79 &&
        headBuf[7] === 0x70
      ) {
        const brand = String.fromCharCode(headBuf[8], headBuf[9], headBuf[10], headBuf[11]).trim();
        containerCodec = `MP4 / M4A (${brand || 'AAC/ALAC'})`;
        bitDepth = '16 bits / AAC';
        // Scan for 'mp4a' or 'alac' audio sample entry in headBuf
        for (let i = 0; i + 36 < headBuf.length; i++) {
          if (
            (headBuf[i] === 0x6d &&
              headBuf[i + 1] === 0x70 &&
              headBuf[i + 2] === 0x34 &&
              headBuf[i + 3] === 0x61) ||
            (headBuf[i] === 0x61 &&
              headBuf[i + 1] === 0x6c &&
              headBuf[i + 2] === 0x61 &&
              headBuf[i + 3] === 0x63)
          ) {
            const isAlac = headBuf[i] === 0x61;
            const ch = headView.getUint16(i + 20, false);
            const bps = headView.getUint16(i + 22, false);
            const sr = headView.getUint16(i + 28, false);
            if (sr >= 8000 && sr <= 192000 && ch >= 1 && ch <= 8) {
              sampleRateHz = sr;
              channels = ch;
              channelMode =
                ch === 1 ? 'Mono (1 canal)' : ch === 2 ? 'Estéreo (2 canais)' : `${ch} canais`;
              if (isAlac) {
                containerCodec = 'Apple Lossless (ALAC / M4A)';
                bitDepth = `${bps || 16} bits (Lossless)`;
              } else {
                containerCodec = 'AAC (Advanced Audio Coding / M4A)';
                bitDepth = 'Ponto flutuante (Lossy)';
              }
              break;
            }
          }
        }
      }
      // 2E. Scan for MP3 MPEG Audio Frame Header
      else {
        const maxScan = Math.min(streamBuf.length - 4, 32768);
        for (let i = 0; i < maxScan; i++) {
          if (streamBuf[i] === 0xff && (streamBuf[i + 1] & 0xe0) === 0xe0) {
            const b1 = streamBuf[i + 1];
            const b2 = streamBuf[i + 2];
            const b3 = streamBuf[i + 3];
            const verBits = (b1 >> 3) & 0x03; // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
            const layerBits = (b1 >> 1) & 0x03; // 1=Layer III, 2=Layer II, 3=Layer I
            const brIdx = (b2 >> 4) & 0x0f;
            const srIdx = (b2 >> 2) & 0x03;
            const chBits = (b3 >> 6) & 0x03;

            if (verBits !== 1 && layerBits !== 0 && brIdx !== 0 && brIdx !== 15 && srIdx !== 3) {
              const verName =
                verBits === 3 ? 'MPEG-1' : verBits === 2 ? 'MPEG-2' : 'MPEG-2.5';
              const layerName =
                layerBits === 1 ? 'Layer III' : layerBits === 2 ? 'Layer II' : 'Layer I';
              containerCodec = `MP3 (${verName} Audio ${layerName})`;
              bitDepth = 'Ponto flutuante (Lossy)';

              const srTable: Record<number, [number, number, number]> = {
                3: [44100, 48000, 32000],
                2: [22050, 24000, 16000],
                0: [11025, 12000, 8000],
              };
              sampleRateHz = srTable[verBits]?.[srIdx] || null;

              // Bitrate lookup table for Layer III
              const brMpeg1L3 = [
                0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0,
              ];
              const brMpeg2L3 = [
                0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0,
              ];
              bitrateKbps =
                verBits === 3 ? brMpeg1L3[brIdx] || null : brMpeg2L3[brIdx] || null;

              const chModes = [
                'Estéreo (2 canais)',
                'Joint Stereo (2 canais)',
                'Dual Channel (2 canais)',
                'Mono (1 canal)',
              ];
              channelMode = chModes[chBits] || 'Estéreo (2 canais)';
              channels = chBits === 3 ? 1 : 2;

              // Check for Xing / Info / VBRI header inside first frame
              const frameSlice = streamBuf.subarray(i, Math.min(streamBuf.length, i + 200));
              const frameAscii = String.fromCharCode(...frameSlice);
              if (frameAscii.includes('Xing') || frameAscii.includes('VBRI')) {
                bitrateMode = 'VBR (Taxa variável)';
              } else {
                bitrateMode = 'CBR (Taxa constante)';
              }
              break;
            }
          }
        }
      }
    } catch {
      // ignore binary inspection errors
    }
  }

  // 3. Duration & Fallback Average Bitrate calculation
  let durationSec: number | null = parseDurationToSeconds(track.dur) || null;
  const probedDur = await probeAudioDuration(track.url);
  if (probedDur && probedDur > 0) {
    durationSec = probedDur;
  } else if (blob) {
    const binDur = await parseDurationFromBlob(blob);
    if (binDur && binDur > 0) {
      durationSec = binDur;
    }
  }

  if (durationSec && durationSec > 0 && sizeBytes > 0) {
    const audioPayloadBytes = Math.max(0, sizeBytes - tagSizeBytes);
    const avgKbps = Math.round((audioPayloadBytes * 8) / durationSec / 1000);
    if (!bitrateKbps || bitrateMode.startsWith('VBR')) {
      bitrateKbps = avgKbps;
    }
  }

  const sampleRateFormatted = sampleRateHz
    ? `${sampleRateHz.toLocaleString('pt-BR')} Hz (${(sampleRateHz / 1000).toFixed(1).replace('.0', '').replace('.', ',')} kHz)`
    : '44.100 Hz (44,1 kHz)';

  const bitrateFormatted = bitrateKbps
    ? `${bitrateKbps} kbps${bitrateMode ? ` • ${bitrateMode}` : ''}`
    : 'Não identificado';

  const durationFormatted =
    durationSec && durationSec > 0
      ? `${formatTime(durationSec)} (${durationSec.toFixed(2).replace('.', ',')} s)`
      : track.dur || 'Desconhecida';

  return {
    originalFileName,
    extension,
    mimeType,
    containerCodec,
    sizeBytes,
    sizeFormatted: formatFileSize(sizeBytes),
    sampleRateHz,
    sampleRateFormatted,
    bitrateKbps,
    bitrateMode: bitrateMode || 'Padrão',
    bitrateFormatted,
    channels,
    channelMode: channelMode || 'Estéreo (2 canais)',
    bitDepth,
    durationSec,
    durationFormatted,
    tagFormat:
      tagSizeBytes > 0
        ? `${tagFormat} (${(tagSizeBytes / 1024).toFixed(1).replace('.', ',')} KB)`
        : tagFormat,
    tagSizeBytes,
    embeddedCoverInfo,
    encoder,
    year,
    trackNumber,
    genre,
    lastModified,
    storageKey: track.key,
    dbId: track.id,
  };
}
