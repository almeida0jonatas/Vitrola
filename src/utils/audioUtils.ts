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
