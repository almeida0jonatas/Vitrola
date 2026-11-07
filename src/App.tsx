/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import {
  Track,
  LyricLine,
  QueueItem,
  ART_UNK,
  ALB_UNK,
  formatTime,
  plural,
  parseLrc,
  parseDurationToSeconds,
  formatQueueSummaryDuration,
  nrm,
  similar,
  primary,
  clip,
  artKey,
  albKey,
  shuffled,
  readTags,
} from './utils/audioUtils.ts';
import { createDemoTrackBlob } from './utils/demoAudio.ts';

// IndexedDB helpers
const DB_NAME = 'player-local';
const STORE_NAME = 'tracks';

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function dbRun<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<any> | void): Promise<T | null> {
  try {
    const db = await openDb();
    if (!db) return null;
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, mode);
      const req = fn(tx.objectStore(STORE_NAME));
      tx.oncomplete = () => resolve(req ? (req.result as T) : (true as unknown as T));
      tx.onerror = tx.onabort = () => resolve(null);
    });
  } catch {
    return null;
  }
}

interface StoredRecord {
  id?: number;
  key: string;
  name: string;
  artist?: string;
  album?: string;
  cover?: Blob | null;
  file: Blob;
}

const dbPut = (rec: StoredRecord) => dbRun<number>('readwrite', (s) => s.add(rec));
const dbAll = () => dbRun<StoredRecord[]>('readonly', (s) => s.getAll());
const dbClear = () => dbRun<void>('readwrite', (s) => s.clear());
const dbDeleteMany = (ids: number[], keys: string[]) =>
  dbRun<void>('readwrite', (store) => {
    ids.forEach((id) => {
      try {
        store.delete(id);
      } catch {
        // ignore
      }
    });
    if (keys.length > 0) {
      const keySet = new Set(keys);
      const cursorReq = store.openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) {
          const val = cursor.value as StoredRecord;
          if (val && keySet.has(val.key)) {
            cursor.delete();
          }
          cursor.continue();
        }
      };
    }
  });

const IK = 'info4:';
const TTL_OK = 30 * 864e5;
const TTL_NONE = 7 * 864e5;
const WL = typeof navigator !== 'undefined' && (navigator.language || 'pt').toLowerCase().startsWith('en') ? 'en' : 'pt';
const MUSIC_RE = /music|singer|band\b|rapper|compos|songwriter|guitar|vocal|\bduo\b|\bgroup\b|m[uú]sic|cantor|banda|compositor|grupo|trio|conjunto|orquestra|pianista|violonista|produtor|dj\b/i;

interface OnlineInfo {
  img?: string;
  bio?: string;
  genre?: string;
  country?: string;
  year?: string;
  label?: string;
  tracks?: number | string;
  srcs?: string[];
  url?: string;
  none?: boolean;
  fail?: boolean;
  t?: number;
}

const iMem = new Map<string, OnlineInfo>();
const iBusy = new Map<string, Promise<OnlineInfo>>();

function iKey(kind: 'artist' | 'album', a?: string, b?: string) {
  return `${kind}:${nrm(a)}${b != null ? '|' + nrm(b) : ''}`;
}

function iGet(kind: 'artist' | 'album', a?: string, b?: string): OnlineInfo | null {
  const k = iKey(kind, a, b);
  if (iMem.has(k)) return iMem.get(k)!;
  try {
    const s = localStorage.getItem(IK + k);
    if (s) {
      const o = JSON.parse(s) as OnlineInfo;
      if (Date.now() - (o.t || 0) < (o.none ? TTL_NONE : TTL_OK)) {
        iMem.set(k, o);
        return o;
      }
      localStorage.removeItem(IK + k);
    }
  } catch {
    // ignore
  }
  return null;
}

function iPut(kind: 'artist' | 'album', a: string | undefined, b: string | undefined, o: OnlineInfo) {
  o.t = Date.now();
  const k = iKey(kind, a, b);
  iMem.set(k, o);
  try {
    localStorage.setItem(IK + k, JSON.stringify(o));
  } catch {
    // ignore
  }
}

function iDrop(kind: 'artist' | 'album', a?: string, b?: string) {
  const k = iKey(kind, a, b);
  iMem.delete(k);
  try {
    localStorage.removeItem(IK + k);
  } catch {
    // ignore
  }
}

// JSONP helper for cross-origin API calls without CORS restrictions (Deezer)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function jsonp<T>(url: string, callbackParam = 'callback', timeoutMs = 6000): Promise<T> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  return new Promise((resolve, reject) => {
    const callbackName = 'dz_cb_' + Math.random().toString(36).slice(2) + Date.now();
    const script = document.createElement('script');
    let timer: NodeJS.Timeout | null = null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any)[callbackName] = (data: T) => {
      cleanup();
      resolve(data);
    };

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (window as any)[callbackName];
      if (script.parentNode) script.parentNode.removeChild(script);
    };

    timer = setTimeout(() => {
      cleanup();
      reject(new Error('JSONP timeout'));
    }, timeoutMs);

    script.onerror = () => {
      cleanup();
      reject(new Error('JSONP error'));
    };

    const sep = url.includes('?') ? '&' : '?';
    script.src = `${url}${sep}${callbackParam}=${callbackName}`;
    document.head.appendChild(script);
  });
}

// Parallel slot pool (up to 4 concurrent requests)
let activeSlots = 0;
const slotQueue: Array<() => void> = [];

function runNextSlot() {
  while (activeSlots < 4 && slotQueue.length > 0) {
    activeSlots++;
    const next = slotQueue.shift();
    next?.();
  }
}

function iSlot<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    slotQueue.push(async () => {
      try {
        const res = await fn();
        resolve(res);
      } catch (err) {
        reject(err);
      } finally {
        activeSlots--;
        setTimeout(runNextSlot, 80);
      }
    });
    runNextSlot();
  });
}

async function jget(url: string) {
  const c = new AbortController();
  const h = setTimeout(() => c.abort(), 8000);
  try {
    const r = await fetch(url, { signal: c.signal });
    if (!r.ok) throw new Error('http ' + r.status);
    return await r.json();
  } finally {
    clearTimeout(h);
  }
}

async function wikiSearch(lang: string, term: string) {
  const j = await jget(
    'https://' +
      lang +
      '.wikipedia.org/w/api.php?' +
      new URLSearchParams({
        action: 'query',
        format: 'json',
        origin: '*',
        generator: 'search',
        gsrsearch: term,
        gsrlimit: '8',
        prop: 'pageimages|extracts|info',
        inprop: 'url',
        exintro: '1',
        explaintext: '1',
        exlimit: '8',
        piprop: 'thumbnail',
        pithumbsize: '640',
      })
  );
  return j && j.query && j.query.pages
    ? (Object.values(j.query.pages) as Array<{
        index: number;
        title: string;
        extract?: string;
        fullurl?: string;
        thumbnail?: { source: string };
      }>).sort((x, y) => x.index - y.index)
    : [];
}

const langs = () => (WL === 'pt' ? ['pt', 'en'] : ['en', 'pt']);

const addSrc = (r: OnlineInfo, s: string) => {
  r.srcs = r.srcs || [];
  if (!r.srcs.includes(s)) r.srcs.push(s);
};

async function fetchArtist(name: string): Promise<OnlineInfo> {
  const q = primary(name);
  if (!q || q === ART_UNK) return { none: true };
  const r: OnlineInfo = {};
  let ok = 0;

  // 1. First attempt: Direct Server API proxy (highest reliability, no CORS/browser bot blocking)
  try {
    const sRes = await fetch(`/api/artist-info?name=${encodeURIComponent(q)}`);
    if (sRes.ok) {
      const data = await sRes.json();
      if (data && !data.fail && !data.none) {
        if (data.img) r.img = data.img;
        if (data.bio) r.bio = data.bio;
        if (data.genre) r.genre = data.genre;
        if (data.url) r.url = data.url;
        if (data.srcs && Array.isArray(data.srcs)) {
          data.srcs.forEach((s: string) => addSrc(r, s));
        }
        if (r.img || r.bio) return r;
      }
    }
  } catch {
    // continue to client fallback
  }

  // 2. High-resolution artist portrait from Deezer JSONP fallback
  try {
    const dz = await jsonp<{
      data?: Array<{
        id: number;
        name: string;
        nb_fan?: number;
        picture_medium?: string;
        picture_big?: string;
        picture_xl?: string;
      }>;
    }>('https://api.deezer.com/search/artist?q=' + encodeURIComponent(q) + '&output=jsonp');

    if (dz && dz.data && dz.data.length > 0) {
      ok++;
      const exact = dz.data.filter((d) => nrm(d.name) === nrm(q));
      const match =
        (exact.length > 0 ? exact : dz.data)
          .slice()
          .sort((a, b) => (b.nb_fan || 0) - (a.nb_fan || 0))[0] || dz.data[0];

      const img = match.picture_big || match.picture_xl || match.picture_medium;
      if (img && !img.includes('/artist//')) {
        r.img = img;
        addSrc(r, 'Deezer');
      }
    }
  } catch {
    // continue
  }

  // 3. Wikipedia for biography, formed year/country and backup photo
  for (const lang of langs()) {
    try {
      const ps = await wikiSearch(lang, q);
      if (ps && ps.length > 0) {
        ok++;
        const p =
          ps.find((z) => {
            const t = nrm(z.title.replace(/\s*\(.*\)\s*$/, ''));
            return t === nrm(q);
          }) ||
          ps.find((z) => MUSIC_RE.test(z.extract || '')) ||
          ps[0];

        if (p) {
          if (!r.img && p.thumbnail?.source) {
            r.img = p.thumbnail.source;
          }
          if (!r.bio && p.extract) {
            r.bio = p.extract;
            r.url = p.fullurl;
          }
          addSrc(r, lang === 'pt' ? 'Wikipédia' : 'Wikipedia');
        }
      }
    } catch {
      // continue
    }
    if (r.img && r.bio) break;
  }

  // 4. iTunes for genre/country
  try {
    const j = await jget('https://itunes.apple.com/search?' + new URLSearchParams({ term: q, entity: 'musicArtist', limit: '3' }));
    if (j?.results?.[0]) {
      ok++;
      r.genre = r.genre || j.results[0].primaryGenreName;
      addSrc(r, 'iTunes');
    }
  } catch {
    // continue
  }

  if (!ok && !r.img && !r.bio) return { fail: true };
  if (r.bio) r.bio = clip(r.bio, 3000);
  if (!r.img && !r.bio && !r.genre && !r.country && !r.year) return { none: true };
  return r;
}

async function fetchAlbum(artist?: string, album?: string): Promise<OnlineInfo> {
  const ar = primary(artist);
  const r: OnlineInfo = {};
  let ok = 0;

  // 1. First attempt: Direct Server API proxy
  try {
    const sRes = await fetch(
      `/api/album-info?artist=${encodeURIComponent(ar || '')}&album=${encodeURIComponent(album || '')}`
    );
    if (sRes.ok) {
      const data = await sRes.json();
      if (data && !data.fail && !data.none) {
        if (data.img) r.img = data.img;
        if (data.bio) r.bio = data.bio;
        if (data.genre) r.genre = data.genre;
        if (data.year) r.year = data.year;
        if (data.tracks) r.tracks = data.tracks;
        if (data.srcs && Array.isArray(data.srcs)) {
          data.srcs.forEach((s: string) => addSrc(r, s));
        }
        if (r.img) return r;
      }
    }
  } catch {
    // continue to client fallback
  }

  // 2. iTunes for album artwork & details
  try {
    const j = await jget(
      'https://itunes.apple.com/search?' +
        new URLSearchParams({ term: `${ar} ${album || ''}`.trim(), entity: 'album', limit: '8' })
    );
    ok++;
    const results = j?.results as
      | Array<{
          collectionName?: string;
          artistName?: string;
          artworkUrl100?: string;
          releaseDate?: string;
          primaryGenreName?: string;
          trackCount?: number;
        }>
      | undefined;
    const x = results?.find((z) => similar(z.collectionName, album) && (!ar || similar(z.artistName, ar))) || results?.[0];
    if (x) {
      if (x.artworkUrl100) r.img = x.artworkUrl100.replace(/\d+x\d+bb/, '600x600bb');
      r.year = r.year || (x.releaseDate || '').slice(0, 4);
      r.genre = r.genre || x.primaryGenreName || '';
      r.tracks = x.trackCount || '';
      addSrc(r, 'iTunes');
    }
  } catch {
    // continue
  }

  // 2. Deezer JSONP fallback for album cover
  if (!r.img && album) {
    try {
      const dz = await jsonp<{
        data?: Array<{
          title: string;
          cover_big?: string;
          cover_medium?: string;
          cover_xl?: string;
        }>;
      }>('https://api.deezer.com/search/album?q=' + encodeURIComponent(`${ar} ${album}`.trim()) + '&output=jsonp');

      if (dz?.data?.[0]) {
        ok++;
        r.img = dz.data[0].cover_big || dz.data[0].cover_medium || dz.data[0].cover_xl;
        addSrc(r, 'Deezer');
      }
    } catch {
      // continue
    }
  }

  // 3. Wikipedia for album bio
  if (!r.bio && album) {
    for (const lang of langs()) {
      try {
        const ps = await wikiSearch(lang, `${album} ${ar}`.trim());
        ok++;
        const p =
          ps.find((z) => {
            const t = nrm(`${z.title || ''} ${z.extract || ''}`);
            return t.includes(nrm(album)) && (!ar || t.includes(nrm(ar)));
          }) || ps[0];
        if (p && p.extract) {
          r.bio = p.extract;
          r.url = p.fullurl;
          addSrc(r, lang === 'pt' ? 'Wikipédia' : 'Wikipedia');
          break;
        }
      } catch {
        // continue
      }
    }
  }

  if (!ok) return { fail: true };
  if (r.bio) r.bio = clip(r.bio, 3000);
  if (!r.img && !r.bio && !r.genre && !r.year && !r.label) return { none: true };
  return r;
}

function iFetch(kind: 'artist' | 'album', a?: string, b?: string): Promise<OnlineInfo> {
  const k = iKey(kind, a, b);
  if (iBusy.has(k)) return iBusy.get(k)!;
  const p = iSlot(() => (kind === 'artist' ? fetchArtist(a || '') : fetchAlbum(a, b)))
    .then((r) => {
      if (!r.fail) iPut(kind, a, b, r);
      return r;
    })
    .catch(() => ({ fail: true }))
    .finally(() => iBusy.delete(k));
  iBusy.set(k, p);
  return p;
}

async function iLoad(kind: 'artist' | 'album', a?: string, b?: string): Promise<OnlineInfo> {
  if (kind === 'artist' ? !a || a === ART_UNK : !b || b === ALB_UNK) return { none: true };
  const cached = iGet(kind, a, b);
  if (cached && !cached.none) return cached;
  return iFetch(kind, a, b);
}

// Lyrics API Helper
const LK = 'lyr1:';
const keyOf = (t: Track) => t.key || `${t.name}|${t.artist || ''}`;

async function getLyrics(tr: Track, durationSec: number): Promise<{ synced?: string; plain?: string; instr?: boolean; error?: boolean; none?: boolean }> {
  const ck = LK + keyOf(tr);
  try {
    const c = localStorage.getItem(ck);
    if (c) return JSON.parse(c);
  } catch {
    // continue
  }

  const dur = isFinite(durationSec) ? Math.round(durationSec) : 0;
  let r: { syncedLyrics?: string; plainLyrics?: string; instrumental?: boolean; duration?: number } | null = null;
  try {
    if (tr.artist && tr.album && dur) {
      const x = await fetch('https://lrclib.net/api/get?' + new URLSearchParams({ track_name: tr.name, artist_name: tr.artist, album_name: tr.album, duration: String(dur) }));
      if (x.ok) r = await x.json();
      else if (x.status !== 404) throw new Error('http ' + x.status);
    }
    if (!r) {
      const q = new URLSearchParams({ track_name: tr.name });
      if (tr.artist) q.set('artist_name', tr.artist);
      const x = await fetch('https://lrclib.net/api/search?' + q);
      if (!x.ok) throw new Error('http ' + x.status);
      const arr = (await x.json()) as Array<{ syncedLyrics?: string; plainLyrics?: string; instrumental?: boolean; duration?: number }>;
      r = arr.find((z) => z.syncedLyrics && (!dur || Math.abs((z.duration || 0) - dur) <= 3)) || arr.find((z) => z.syncedLyrics) || arr[0] || null;
    }
  } catch {
    return { error: true };
  }

  const res = r ? { synced: r.syncedLyrics || '', plain: r.plainLyrics || '', instr: !!r.instrumental } : { none: true };
  try {
    localStorage.setItem(ck, JSON.stringify(res));
  } catch {
    // continue
  }
  return res;
}

export default function App() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [duration, setDuration] = useState<number>(0);
  const [shuffle, setShuffle] = useState<boolean>(false);
  const [repeat, setRepeat] = useState<number>(0); // 0 = off, 1 = all, 2 = one

  // YouTube Music Playback Queue State
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [queueIndex, setQueueIndex] = useState<number>(-1);
  const [queueContextTitle, setQueueContextTitle] = useState<string>('Biblioteca');
  const [showQueueHistory, setShowQueueHistory] = useState<boolean>(false);

  // Sheets and navigation
  const [isQueueOpen, setIsQueueOpen] = useState<boolean>(false);
  const [isLibraryOpen, setIsLibraryOpen] = useState<boolean>(() => {
    try {
      return Boolean(localStorage.getItem('vitrola_tour_v1'));
    } catch {
      return false;
    }
  });
  const [isLyricsOpen, setIsLyricsOpen] = useState<boolean>(false);
  const [libraryView, setLibraryView] = useState<'home' | 'tracks' | 'artists' | 'albums'>('home');
  const [artFilter, setArtFilter] = useState<string | null>(null);
  const [artSearchQuery, setArtSearchQuery] = useState<string>('');
  const [homeSearchQuery, setHomeSearchQuery] = useState<string>('');
  const [pageStack, setPageStack] = useState<Array<{ t: 'artist' | 'album'; k: string }>>([]);

  // Play Counts (Most Played), Recently Played & Favorites
  const [playCounts, setPlayCounts] = useState<Record<string, number>>(() => {
    try {
      return JSON.parse(localStorage.getItem('vitrola_playcounts1') || '{}') || {};
    } catch {
      return {};
    }
  });
  const [recentKeys, setRecentKeys] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('vitrola_recent1') || '[]') || [];
    } catch {
      return [];
    }
  });
  const [favoriteKeys, setFavoriteKeys] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('vitrola_favs1') || '[]') || [];
    } catch {
      return [];
    }
  });

  // Toast
  const [toastMsg, setToastMsg] = useState<string>('');
  const toastTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const showToast = useCallback((msg: string) => {
    setToastMsg(msg);
    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    toastTimeoutRef.current = setTimeout(() => setToastMsg(''), 1400);
  }, []);

  // Lyrics
  const [lyricsLoading, setLyricsLoading] = useState<boolean>(false);
  const [lyricsError, setLyricsError] = useState<string | null>(null);
  const [lyricsSynced, setLyricsSynced] = useState<LyricLine[]>([]);
  const [lyricsPlain, setLyricsPlain] = useState<string | null>(null);
  const [activeLyricIndex, setActiveLyricIndex] = useState<number>(-1);
  const [lyricsMode, setLyricsMode] = useState<'original' | 'translated' | 'bilingual'>('original');
  const [translatedLines, setTranslatedLines] = useState<string[]>([]);
  const [translatedPlain, setTranslatedPlain] = useState<string | null>(null);
  const [isTranslating, setIsTranslating] = useState<boolean>(false);
  const [translateError, setTranslateError] = useState<string | null>(null);
  const lyricsContainerRef = useRef<HTMLDivElement | null>(null);

  // Armed clear library
  const [armedClear, setArmedClear] = useState<boolean>(false);
  const armedTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Online artist/album info for page view
  const [activePageInfo, setActivePageInfo] = useState<OnlineInfo | null>(null);
  const [activePageInfoLoading, setActivePageInfoLoading] = useState<boolean>(false);
  const [bioClamped, setBioClamped] = useState<boolean>(true);
  const [artistAvatarCache, setArtistAvatarCache] = useState<Record<string, string>>({});
  const [albumCoverCache, setAlbumCoverCache] = useState<Record<string, string>>({});

  // Onboarding Tour State
  const [isTourOpen, setIsTourOpen] = useState<boolean>(false);
  const [tourStep, setTourStep] = useState<number>(0);
  const [spotlightRect, setSpotlightRect] = useState<{
    top: number;
    left: number;
    width: number;
    height: number;
    radius: number;
  } | null>(null);

  // Add / Import Options Sheet & Upload Progress State
  const [isImportMenuOpen, setIsImportMenuOpen] = useState<boolean>(false);
  const [uploadProgress, setUploadProgress] = useState<{
    current: number;
    total: number;
    currentName: string;
  } | null>(null);

  // Settings Menu & Player Preferences State
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1);
  const [sleepTimerMinutes, setSleepTimerMinutes] = useState<number>(0); // 0 = off
  const [sleepRemainingSec, setSleepRemainingSec] = useState<number>(0);
  const [themePref, setThemePref] = useState<'auto' | 'dark' | 'light'>(() => {
    try {
      const saved = localStorage.getItem('vitrola_theme') as 'auto' | 'dark' | 'light' | null;
      if (saved === 'dark' || saved === 'light' || saved === 'auto') return saved;
    } catch {
      // ignore
    }
    return 'auto';
  });

  // Item Context Menu & Removal Confirmation Pop-up State
  const [actionMenu, setActionMenu] = useState<{
    kind: 'track' | 'album' | 'artist';
    title: string;
    subtitle: string;
    cover?: string | null;
    trackIndices: number[];
    artistKey?: string;
    albumKey?: string;
  } | null>(null);

  const [confirmRemove, setConfirmRemove] = useState<{
    kind: 'track' | 'album' | 'artist' | 'all_tracks';
    title: string;
    trackIndices: number[];
  } | null>(null);

  // Audio current track derived from YouTube Music queue
  const currentIndex = queueIndex >= 0 && queueIndex < queue.length ? queue[queueIndex].trackIdx : -1;
  const currentTrack = currentIndex >= 0 && currentIndex < tracks.length ? tracks[currentIndex] : null;

  // Derived upcoming and previous items
  const upcomingItems = useMemo(() => {
    if (queueIndex < 0) return queue;
    return queue.slice(queueIndex + 1);
  }, [queue, queueIndex]);

  const previousItems = useMemo(() => {
    if (queueIndex <= 0) return [];
    return queue.slice(0, queueIndex);
  }, [queue, queueIndex]);

  const upcomingDurationText = useMemo(() => {
    if (!upcomingItems.length) return '';
    const totalSec = upcomingItems.reduce((acc, item) => {
      const t = tracks[item.trackIdx];
      return acc + parseDurationToSeconds(t?.dur);
    }, 0);
    return formatQueueSummaryDuration(totalSec);
  }, [upcomingItems, tracks]);

  // Sync mediaSession
  useEffect(() => {
    if ('mediaSession' in navigator && currentTrack) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: currentTrack.name,
          artist: currentTrack.artist || '',
          album: currentTrack.album || '',
          artwork: currentTrack.cover || currentTrack.web ? [{ src: currentTrack.cover || currentTrack.web! }] : [],
        });
      } catch {
        // continue
      }
    }
  }, [currentTrack]);

  const hasRestoredRef = useRef<boolean>(false);
  const pendingPosRef = useRef<number>(0);

  // Load tracks from IndexedDB on startup and restore last track & queue
  useEffect(() => {
    (async () => {
      // Snapshot saved state immediately before any async work
      const savedRaw = localStorage.getItem('pstate1');
      const recs = await dbAll();
      if (!recs || !recs.length) {
        hasRestoredRef.current = true;
        return;
      }
      try {
        if (navigator.storage && navigator.storage.persist) {
          navigator.storage.persist();
        }
      } catch {
        // continue
      }
      const seenKeys = new Set<string>();
      const loaded: Track[] = [];
      for (const r of recs) {
        if (seenKeys.has(r.key)) continue;
        seenKeys.add(r.key);
        loaded.push({
          id: r.id,
          key: r.key,
          name: r.name,
          artist: r.artist,
          album: r.album,
          cover: r.cover ? URL.createObjectURL(r.cover) : null,
          url: URL.createObjectURL(r.file),
        });
      }
      setTracks(loaded);

      // Restore state
      try {
        const s = JSON.parse(savedRaw || 'null');
        if (loaded.length > 0) {
          const idx = new Map<string, number>();
          loaded.forEach((t, n) => idx.set(t.key, n));
          const ci = s?.cur ? idx.get(s.cur) : undefined;

          if (s) {
            if (typeof s.shuf === 'boolean') setShuffle(s.shuf);
            if ([0, 1, 2].includes(s.rep)) setRepeat(s.rep);
            if (audioRef.current) audioRef.current.volume = 1;
            if (s.contextTitle) setQueueContextTitle(s.contextTitle);
          }

          let restoredQueue: QueueItem[] = [];
          if (s && Array.isArray(s.queue) && s.queue.length > 0) {
            s.queue.forEach((item: any, i: number) => {
              const k = typeof item === 'string' ? item : item?.key;
              const n = k ? idx.get(k) : undefined;
              if (n != null) {
                restoredQueue.push({
                  uid: `restore-${n}-${i}-${Date.now()}`,
                  trackIdx: n,
                  isManual: typeof item === 'object' ? !!item.isManual : false,
                  origIdx: typeof item === 'object' && typeof item.origIdx === 'number' ? item.origIdx : n,
                });
              }
            });
          }

          if (restoredQueue.length === 0) {
            restoredQueue = loaded.map((_, i) => ({
              uid: `init-${i}-${Date.now()}`,
              trackIdx: i,
              origIdx: i,
            }));
          }
          setQueue(restoredQueue);

          let targetQIdx = 0;
          if (
            s &&
            typeof s.queueIndex === 'number' &&
            s.queueIndex >= 0 &&
            s.queueIndex < restoredQueue.length &&
            (ci == null || restoredQueue[s.queueIndex].trackIdx === ci)
          ) {
            targetQIdx = s.queueIndex;
          } else if (ci != null) {
            const matchQ = restoredQueue.findIndex((q) => q.trackIdx === ci);
            if (matchQ >= 0) {
              targetQIdx = matchQ;
            } else {
              restoredQueue.unshift({
                uid: `restore-cur-${ci}-${Date.now()}`,
                trackIdx: ci,
              });
              setQueue([...restoredQueue]);
              targetQIdx = 0;
            }
          }
          setQueueIndex(targetQIdx);

          const trackToPlay = loaded[restoredQueue[targetQIdx]?.trackIdx ?? 0];
          if (trackToPlay && audioRef.current) {
            audioRef.current.src = trackToPlay.url;
            const savedPos = s && typeof s.pos === 'number' && s.pos > 0 ? s.pos : 0;
            if (savedPos > 0) {
              pendingPosRef.current = savedPos;
              setCurrentTime(savedPos);
              audioRef.current.addEventListener(
                'loadedmetadata',
                () => {
                  try {
                    if (audioRef.current && savedPos < (audioRef.current.duration || Infinity)) {
                      audioRef.current.currentTime = savedPos;
                      setCurrentTime(savedPos);
                    }
                    pendingPosRef.current = 0;
                  } catch {
                    // continue
                  }
                },
                { once: true }
              );
              if (savedPos > 1) {
                showToast('Retomado de onde você parou');
              }
            }
          }
        }
      } catch {
        // ignore
      } finally {
        setTimeout(() => {
          hasRestoredRef.current = true;
        }, 150);
      }
    })();
  }, [showToast]);

  // Save playback state to localStorage
  const saveState = useCallback(() => {
    if (!hasRestoredRef.current || tracks.length === 0 || queue.length === 0) return;
    try {
      const a = audioRef.current;
      if (!a) return;
      const k = (n: number) => tracks[n] && tracks[n].key;
      const posToSave = a.currentTime > 0 ? a.currentTime : pendingPosRef.current;
      localStorage.setItem(
        'pstate1',
        JSON.stringify({
          cur: k(currentIndex) || null,
          pos: posToSave || 0,
          playing: !a.paused,
          queue: queue
            .map((item) => ({
              key: tracks[item.trackIdx]?.key,
              isManual: !!item.isManual,
              origIdx: item.origIdx,
            }))
            .filter((x) => x.key),
          queueIndex,
          contextTitle: queueContextTitle,
          shuf: shuffle,
          rep: repeat,
          vol: a.volume,
        })
      );
    } catch {
      // ignore
    }
  }, [currentIndex, tracks, queue, queueIndex, queueContextTitle, shuffle, repeat]);

  useEffect(() => {
    saveState();
  }, [saveState]);

  // Ensure state is saved when app is backgrounded or closed
  useEffect(() => {
    const onHide = () => saveState();
    const onVisChange = () => {
      if (document.visibilityState === 'hidden') saveState();
    };
    window.addEventListener('pagehide', onHide);
    window.addEventListener('beforeunload', onHide);
    document.addEventListener('visibilitychange', onVisChange);
    return () => {
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('beforeunload', onHide);
      document.removeEventListener('visibilitychange', onVisChange);
    };
  }, [saveState]);

  // Toggle Favorite (Liked song)
  const toggleFavorite = useCallback(
    (trackKey: string, e?: React.MouseEvent) => {
      if (e) e.stopPropagation();
      if (!trackKey) return;
      setFavoriteKeys((prev) => {
        const exists = prev.includes(trackKey);
        const next = exists ? prev.filter((k) => k !== trackKey) : [trackKey, ...prev];
        try {
          localStorage.setItem('vitrola_favs1', JSON.stringify(next));
        } catch {
          // ignore
        }
        showToast(exists ? 'Removida das Favoritas' : 'Adicionada às Favoritas');
        return next;
      });
    },
    [showToast]
  );

  // Load and play track audio (and record play counts + recent history when autoPlay is true)
  const loadAudio = useCallback(
    (trackIdx: number, autoPlay: boolean) => {
      if (trackIdx < 0 || trackIdx >= tracks.length) return;
      pendingPosRef.current = 0;
      const t = tracks[trackIdx];
      if (audioRef.current) {
        audioRef.current.src = t.url;
        if (autoPlay) {
          audioRef.current.play().catch(() => {});
          if (t.key) {
            setPlayCounts((prev) => {
              const next = { ...prev, [t.key]: (prev[t.key] || 0) + 1 };
              try {
                localStorage.setItem('vitrola_playcounts1', JSON.stringify(next));
              } catch {
                // ignore
              }
              return next;
            });
            setRecentKeys((prev) => {
              const next = [t.key, ...prev.filter((k) => k !== t.key)].slice(0, 25);
              try {
                localStorage.setItem('vitrola_recent1', JSON.stringify(next));
              } catch {
                // ignore
              }
              return next;
            });
          }
        }
      }
    },
    [tracks]
  );

  // Play next track (YouTube Music style)
  const nextTrack = useCallback(
    (auto = false) => {
      if (!tracks.length || !queue.length) return;
      if (repeat === 2 && auto) {
        if (audioRef.current) {
          audioRef.current.currentTime = 0;
          audioRef.current.play().catch(() => {});
        }
        return;
      }

      if (queueIndex < queue.length - 1) {
        const nextIdx = queueIndex + 1;
        setQueueIndex(nextIdx);
        loadAudio(queue[nextIdx].trackIdx, true);
      } else if (repeat === 1 || !auto) {
        // Repeat all or manual click on next button: loop back to beginning
        setQueueIndex(0);
        loadAudio(queue[0].trackIdx, true);
      } else {
        setIsPlaying(false);
      }
    },
    [tracks.length, queue, queueIndex, repeat, loadAudio]
  );

  // Play previous track (YouTube Music style)
  const prevTrack = useCallback(() => {
    const a = audioRef.current;
    if (a && a.currentTime > 3) {
      a.currentTime = 0;
    } else if (queueIndex > 0) {
      const prevIdx = queueIndex - 1;
      setQueueIndex(prevIdx);
      loadAudio(queue[prevIdx].trackIdx, true);
    } else if (repeat === 1 && queue.length > 0) {
      const lastIdx = queue.length - 1;
      setQueueIndex(lastIdx);
      loadAudio(queue[lastIdx].trackIdx, true);
    } else if (a) {
      a.currentTime = 0;
    }
  }, [queueIndex, queue, repeat, loadAudio]);

  // Load track helper
  const loadTrack = (n: number, autoPlay: boolean) => {
    if (n < 0 || n >= tracks.length) return;
    const existingQIdx = queue.findIndex((q) => q.trackIdx === n);
    if (existingQIdx >= 0) {
      setQueueIndex(existingQIdx);
    } else {
      const newItem: QueueItem = { uid: `play-${n}-${Date.now()}`, trackIdx: n };
      setQueue((prev) => {
        const next = [...prev];
        next.splice(queueIndex + 1, 0, newItem);
        return next;
      });
      setQueueIndex(queueIndex + 1);
    }
    loadAudio(n, autoPlay);
  };

  // Online web cover lookup if track doesn't have an embedded APIC tag
  useEffect(() => {
    if (!currentTrack || currentTrack.cover || currentTrack.web) return;
    let cancel = false;
    (async () => {
      let u: string | undefined;
      if (currentTrack.album && currentTrack.artist) {
        const r = await iLoad('album', currentTrack.artist, currentTrack.album);
        u = r?.img;
      }
      if (!u && currentTrack.artist) {
        const r2 = await iLoad('artist', currentTrack.artist);
        u = r2?.img;
      }
      if (u && !cancel) {
        setTracks((prev) =>
          prev.map((tk, idx) => (idx === currentIndex ? { ...tk, web: u } : tk))
        );
      }
    })();
    return () => {
      cancel = true;
    };
  }, [currentIndex, currentTrack]);

  // Translation fetching
  const fetchLyricsTranslation = useCallback(
    async (tr: Track, syncedList: LyricLine[], plainText: string | null) => {
      const rawText = syncedList.length > 0 ? syncedList.map((l) => l.txt).join('\n') : plainText || '';
      if (!rawText.trim()) return;

      const cacheKey = 'TRLYR:' + keyOf(tr);
      try {
        const cached = localStorage.getItem(cacheKey);
        if (cached) {
          const parsed = JSON.parse(cached) as string;
          if (syncedList.length > 0) {
            setTranslatedLines(parsed.split('\n'));
          } else {
            setTranslatedPlain(parsed);
          }
          return;
        }
      } catch {
        // ignore
      }

      setIsTranslating(true);
      setTranslateError(null);

      let translatedResult = '';
      try {
        const res = await fetch('/api/translate-lyrics', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: rawText,
            targetLang: 'pt',
            trackName: tr.name,
            artistName: tr.artist,
          }),
        });

        if (res.ok) {
          const data = await res.json();
          if (data?.translated) {
            translatedResult = data.translated;
          }
        }
      } catch {
        // Fallback to direct client-side translation
      }

      // Direct client fallback via Google Translate API if server proxy is unavailable
      if (!translatedResult) {
        try {
          const lines = rawText.split('\n');
          const chunkSize = 35;
          const translatedChunks: string[] = [];

          for (let i = 0; i < lines.length; i += chunkSize) {
            const chunk = lines.slice(i, i + chunkSize).join('\n');
            const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=pt&dt=t&q=${encodeURIComponent(
              chunk
            )}`;
            const gtRes = await fetch(url);
            if (gtRes.ok) {
              const data = (await gtRes.json()) as any;
              if (data && Array.isArray(data[0])) {
                const chunkText = data[0].map((item: any) => item[0] || '').join('');
                translatedChunks.push(...chunkText.split('\n'));
              }
            }
          }

          if (translatedChunks.length > 0) {
            translatedResult = translatedChunks.join('\n');
          }
        } catch {
          // continue
        }
      }

      if (translatedResult) {
        if (syncedList.length > 0) {
          setTranslatedLines(translatedResult.split('\n'));
        } else {
          setTranslatedPlain(translatedResult);
        }
        try {
          localStorage.setItem(cacheKey, JSON.stringify(translatedResult));
        } catch {
          // ignore
        }
      } else {
        setTranslateError('Não foi possível traduzir a letra no momento.');
      }
      setIsTranslating(false);
    },
    []
  );

  const handleSelectLyricsMode = (mode: 'original' | 'translated' | 'bilingual') => {
    setLyricsMode(mode);
    if (mode !== 'original' && currentTrack) {
      if (translatedLines.length === 0 && !translatedPlain && !isTranslating) {
        fetchLyricsTranslation(currentTrack, lyricsSynced, lyricsPlain);
      }
    }
  };

  // Lyrics loading
  const loadLyricsForTrack = useCallback(async (tr: Track, dur: number) => {
    setLyricsLoading(true);
    setLyricsError(null);
    setLyricsSynced([]);
    setLyricsPlain(null);
    setActiveLyricIndex(-1);
    setTranslatedLines([]);
    setTranslatedPlain(null);
    setIsTranslating(false);
    setTranslateError(null);

    const r = await getLyrics(tr, dur);
    setLyricsLoading(false);

    if (r.error) {
      setLyricsError('Não foi possível buscar a letra. Verifique a conexão.');
      return;
    }
    if (r.none || (!r.synced && !r.plain)) {
      setLyricsError('Letra não encontrada.');
      return;
    }
    if (r.instr && !r.synced && !r.plain) {
      setLyricsError('Faixa instrumental.');
      return;
    }

    if (r.synced) {
      const parsed = parseLrc(r.synced);
      setLyricsSynced(parsed);
      if (lyricsMode !== 'original') {
        fetchLyricsTranslation(tr, parsed, null);
      }
    } else if (r.plain) {
      setLyricsPlain(r.plain);
      if (lyricsMode !== 'original') {
        fetchLyricsTranslation(tr, [], r.plain);
      }
    }
  }, [lyricsMode, fetchLyricsTranslation]);

  // When lyrics sheet is opened or track changes while open
  useEffect(() => {
    if (isLyricsOpen && currentTrack) {
      loadLyricsForTrack(currentTrack, duration);
    }
  }, [isLyricsOpen, currentTrack, duration, loadLyricsForTrack]);

  // Keep screen awake while lyrics sheet is open (Wake Lock API + Canvas Video Fallback for iOS/iframes)
  useEffect(() => {
    if (!isLyricsOpen) return;

    let wl: WakeLockSentinel | null = null;
    let fallbackVideo: HTMLVideoElement | null = null;
    let fallbackStream: MediaStream | null = null;
    let fallbackInterval: NodeJS.Timeout | null = null;
    let cancelled = false;

    const startVideoFallback = () => {
      if (cancelled || fallbackVideo) return;
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 2;
        canvas.height = 2;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          let tick = 0;
          fallbackInterval = setInterval(() => {
            tick = 1 - tick;
            ctx.fillStyle = tick ? '#010101' : '#020202';
            ctx.fillRect(0, 0, 2, 2);
          }, 1000);
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const capture = (canvas as any).captureStream || (canvas as any).webkitCaptureStream;
        if (typeof capture === 'function') {
          fallbackStream = capture.call(canvas, 1) as MediaStream;
          const v = document.createElement('video');
          v.muted = true;
          v.playsInline = true;
          v.setAttribute('playsinline', '');
          v.setAttribute('webkit-playsinline', '');
          v.loop = true;
          v.style.position = 'fixed';
          v.style.width = '1px';
          v.style.height = '1px';
          v.style.opacity = '0.001';
          v.style.pointerEvents = 'none';
          v.style.zIndex = '-1';
          v.srcObject = fallbackStream;
          document.body.appendChild(v);
          v.play().catch(() => {});
          fallbackVideo = v;
        }
      } catch {
        // ignore
      }
    };

    const acquireWakeLock = async () => {
      if (cancelled || document.visibilityState !== 'visible') return;
      if ('wakeLock' in navigator && navigator.wakeLock) {
        try {
          if (!wl || wl.released) {
            wl = await navigator.wakeLock.request('screen');
          }
          return;
        } catch {
          // If blocked by iframe permissions policy or unsupported, activate canvas video fallback
          startVideoFallback();
        }
      } else {
        startVideoFallback();
      }
    };

    acquireWakeLock();

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        acquireWakeLock();
        if (fallbackVideo && fallbackVideo.paused) {
          fallbackVideo.play().catch(() => {});
        }
      }
    };

    const onUserInteraction = () => {
      if (!wl || wl.released) {
        acquireWakeLock();
      }
      if (fallbackVideo && fallbackVideo.paused) {
        fallbackVideo.play().catch(() => {});
      }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pointerdown', onUserInteraction, { passive: true });
    window.addEventListener('touchstart', onUserInteraction, { passive: true });

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pointerdown', onUserInteraction);
      window.removeEventListener('touchstart', onUserInteraction);
      if (wl) {
        wl.release().catch(() => {});
        wl = null;
      }
      if (fallbackInterval) {
        clearInterval(fallbackInterval);
      }
      if (fallbackVideo) {
        try {
          fallbackVideo.pause();
          fallbackVideo.srcObject = null;
          if (fallbackVideo.parentNode) fallbackVideo.parentNode.removeChild(fallbackVideo);
        } catch {
          // ignore
        }
      }
      if (fallbackStream) {
        fallbackStream.getTracks().forEach((tr) => tr.stop());
      }
    };
  }, [isLyricsOpen]);

  // Update active lyric index on audio time update
  useEffect(() => {
    if (!lyricsSynced.length) return;
    let k = -1;
    for (let j = 0; j < lyricsSynced.length; j++) {
      if (lyricsSynced[j].t <= currentTime + 0.2) {
        k = j;
      } else {
        break;
      }
    }
    if (k !== activeLyricIndex) {
      setActiveLyricIndex(k);
      if (isLyricsOpen && k >= 0 && lyricsContainerRef.current) {
        const el = lyricsContainerRef.current.children[k] as HTMLElement | undefined;
        if (el) {
          el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
      }
    }
  }, [currentTime, lyricsSynced, activeLyricIndex, isLyricsOpen]);

  // Keyboard controls
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'BUTTON' || target.isContentEditable)) {
        return;
      }
      if (e.code === 'Space') {
        e.preventDefault();
        if (audioRef.current) {
          if (audioRef.current.paused) audioRef.current.play().catch(() => {});
          else audioRef.current.pause();
        }
      } else if (e.code === 'ArrowRight') {
        if (audioRef.current) audioRef.current.currentTime += 5;
      } else if (e.code === 'ArrowLeft') {
        if (audioRef.current) audioRef.current.currentTime -= 5;
      } else if (e.key === 'Escape') {
        if (pageStack.length > 0) {
          setPageStack((prev) => prev.slice(0, -1));
        } else {
          setIsLibraryOpen(false);
          setIsLyricsOpen(false);
          setIsQueueOpen(false);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [pageStack.length]);

  // File & Folder Upload handler (supports individual files and entire folders with subfolders)
  const handleFiles = async (files: FileList | File[] | null) => {
    if (!files || !files.length) return;
    const rawList = Array.from(files);
    const audioFiles = rawList.filter(
      (f) => f.type.startsWith('audio/') || /\.(mp3|m4a|wav|ogg|flac|aac|opus)$/i.test(f.name)
    );
    if (!audioFiles.length) {
      showToast('Nenhum arquivo de áudio encontrado');
      return;
    }

    const total = audioFiles.length;
    setUploadProgress({
      current: 0,
      total,
      currentName: audioFiles[0].name.replace(/\.[^.]+$/, ''),
    });
    // Yield so the progress bar renders immediately before processing starts
    await new Promise((r) => setTimeout(r, 20));

    let failed = 0;
    let addedCount = 0;
    const newTracks: Track[] = [...tracks];

    try {
      for (let i = 0; i < total; i++) {
        const f = audioFiles[i];
        const cleanFileName = f.name.replace(/\.[^.]+$/, '');
        setUploadProgress({
          current: i + 1,
          total,
          currentName: cleanFileName,
        });
        if (total <= 20 || i % 3 === 0 || i === total - 1) {
          await new Promise((r) => setTimeout(r, 0));
        }

        const key = `${f.name}|${f.size}`;
        if (newTracks.some((x) => x.key === key)) continue;
        const g = await readTags(f);

        // Infer fallback artist/album from folder hierarchy if ID3 tags are missing
        let fallbackArtist = g.artist;
        let fallbackAlbum = g.album;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const relPath = ((f as any).webkitRelativePath as string | undefined) || '';
        if (relPath && (!fallbackArtist || !fallbackAlbum)) {
          const parts = relPath.split('/').filter(Boolean);
          // e.g. RootFolder / Artist / Album / Song.mp3 or Artist / Song.mp3
          if (parts.length >= 3) {
            if (!fallbackAlbum) fallbackAlbum = parts[parts.length - 2];
            if (!fallbackArtist && parts.length >= 4) fallbackArtist = parts[parts.length - 3];
          } else if (parts.length === 2 && !fallbackAlbum) {
            fallbackAlbum = parts[0];
          }
        }

        const tr: Track = {
          key,
          name: g.title || cleanFileName,
          artist: fallbackArtist,
          album: fallbackAlbum,
          cover: g.cover,
          url: URL.createObjectURL(f),
        };
        newTracks.push(tr);
        addedCount++;
        const id = await dbPut({
          key,
          name: tr.name,
          artist: tr.artist,
          album: tr.album,
          cover: g.coverBlob || null,
          file: f,
        });
        if (id == null) failed++;
        else tr.id = id;
      }

      if (failed) {
        showToast(`Não foi possível salvar ${plural(failed, ' faixa', ' faixas')} neste navegador`);
      } else if (addedCount > 0) {
        showToast(`${plural(addedCount, ' música importada', ' músicas importadas')}!`);
      } else {
        showToast('As músicas selecionadas já estão na biblioteca');
      }

      const wasEmpty = tracks.length === 0;
      setTracks(newTracks);
      if (wasEmpty && newTracks.length > 0) {
        const initialQueue: QueueItem[] = newTracks.map((_, i) => ({
          uid: `track-${i}-${Date.now()}`,
          trackIdx: i,
          origIdx: i,
        }));
        setQueue(initialQueue);
        setQueueIndex(0);
        setQueueContextTitle('Biblioteca');
        if (audioRef.current) {
          audioRef.current.src = newTracks[0].url;
        }
      }
      await new Promise((r) => setTimeout(r, 260));
    } finally {
      setUploadProgress(null);
    }
  };

  // Pick a directory and recursively scan all subfolders
  const handlePickFolder = async () => {
    setIsImportMenuOpen(false);
    // Use native input[webkitdirectory] which works across desktop and mobile browsers
    if (folderInputRef.current) {
      folderInputRef.current.click();
    }
  };

  // Add demo audio tracks
  const loadDemoTracks = async () => {
    const demoConfigs: Array<{ genre: 'bossa' | 'synth' | 'acoustic'; name: string; artist: string; album: string }> = [
      { genre: 'bossa', name: 'Garota de Ipanema (Sintetizada)', artist: 'Tom Jobim', album: 'Bossa Nova Classics' },
      { genre: 'synth', name: 'Noite Urbana', artist: 'Legião Urbana', album: 'As Quatro Estações' },
      { genre: 'acoustic', name: 'Aquarela Melódica', artist: 'Toquinho', album: 'Aquarela' },
    ];
    setUploadProgress({
      current: 0,
      total: demoConfigs.length,
      currentName: demoConfigs[0].name,
    });
    try {
      const newTracks = [...tracks];
      for (let i = 0; i < demoConfigs.length; i++) {
        const config = demoConfigs[i];
        setUploadProgress({
          current: i + 1,
          total: demoConfigs.length,
          currentName: config.name,
        });
        await new Promise((r) => setTimeout(r, 20));
        const blob = await createDemoTrackBlob(config.genre);
        const key = `demo|${config.name}|${blob.size}`;
        if (newTracks.some((x) => x.key === key)) continue;
        const tr: Track = {
          key,
          name: config.name,
          artist: config.artist,
          album: config.album,
          url: URL.createObjectURL(blob),
          dur: '0:16',
        };
        newTracks.push(tr);
        const id = await dbPut({
          key,
          name: tr.name,
          artist: tr.artist,
          album: tr.album,
          cover: null,
          file: blob,
        });
        if (id != null) tr.id = id;
      }

      setTracks(newTracks);
      if (currentIndex < 0 && newTracks.length > 0) {
        const initialQueue: QueueItem[] = newTracks.map((_, i) => ({
          uid: `demo-${i}-${Date.now()}`,
          trackIdx: i,
          origIdx: i,
        }));
        setQueue(initialQueue);
        setQueueIndex(0);
        setQueueContextTitle('Demonstração');
        if (audioRef.current) audioRef.current.src = newTracks[0].url;
      }
      await new Promise((r) => setTimeout(r, 220));
      showToast('3 músicas de demonstração carregadas!');
    } catch {
      showToast('Erro ao gerar áudio de demonstração.');
    } finally {
      setUploadProgress(null);
    }
  };

  // Execute clearing all tracks from library (triggered from Settings confirmation dialog)
  const executeClearAllTracks = async () => {
    await dbClear();
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.removeAttribute('src');
    }
    setTracks([]);
    setQueue([]);
    setQueueIndex(-1);
    setQueueContextTitle('Biblioteca');
    setPageStack([]);
    pendingPosRef.current = 0;
    try {
      localStorage.removeItem('pstate1');
    } catch {
      // ignore
    }
    setConfirmRemove(null);
    showToast('Todas as músicas foram apagadas da biblioteca');
  };

  // Clear or reload artist/album images & metadata cache
  const handleClearImagesCache = (reloadNow: boolean) => {
    iMem.clear();
    try {
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(IK)) keysToRemove.push(k);
      }
      keysToRemove.forEach((k) => localStorage.removeItem(k));
    } catch {
      // ignore
    }

    requestedArtistsRef.current.clear();
    requestedAlbumsRef.current.clear();
    setArtistAvatarCache({});
    setAlbumCoverCache({});
    setTracks((prev) => prev.map((t) => (t.web ? { ...t, web: undefined } : t)));

    if (reloadNow) {
      showToast('Recarregando fotos de artistas e capas de álbuns...');
      // Trigger fresh fetch for all artists and albums
      setTimeout(() => {
        artistGroups.forEach((g) => {
          if (g.name !== ART_UNK) {
            requestedArtistsRef.current.add(g.name);
            iLoad('artist', g.name).then((info) => {
              const val = info?.img || 'none';
              setArtistAvatarCache((prev) => ({ ...prev, [g.name]: val }));
            });
          }
        });
        albumGroups.forEach((g) => {
          if (!g.cover && g.name !== ALB_UNK) {
            requestedAlbumsRef.current.add(g.key);
            iLoad('album', g.artist, g.name).then((info) => {
              const val = info?.img || 'none';
              setAlbumCoverCache((prev) => ({ ...prev, [g.key]: val }));
            });
          }
        });
        if (activePage) {
          const isA = activePage.t === 'artist';
          setActivePageInfoLoading(true);
          iLoad(
            isA ? 'artist' : 'album',
            isA ? activePage.k : activePage.k.split('||')[1],
            isA ? undefined : activePage.k.split('||')[0]
          ).then((info) => {
            setActivePageInfo(info);
            setActivePageInfoLoading(false);
          });
        }
      }, 60);
    } else {
      showToast('Cache de imagens e informações de artistas limpo');
    }
  };

  // Clear cached lyrics and translations
  const handleClearLyricsCache = () => {
    try {
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && (k.startsWith(LK) || k.startsWith('TRLYR:'))) {
          keysToRemove.push(k);
        }
      }
      keysToRemove.forEach((k) => localStorage.removeItem(k));
    } catch {
      // ignore
    }
    setLyricsSynced([]);
    setLyricsPlain(null);
    setTranslatedLines([]);
    setTranslatedPlain(null);
    if (isLyricsOpen && currentTrack) {
      loadLyricsForTrack(currentTrack, duration);
    }
    showToast('Cache de letras e traduções apagado');
  };

  // Apply theme preference
  useEffect(() => {
    const root = document.documentElement;
    if (themePref === 'dark') {
      root.setAttribute('data-theme', 'dark');
    } else if (themePref === 'light') {
      root.setAttribute('data-theme', 'light');
    } else {
      root.removeAttribute('data-theme');
    }
    try {
      localStorage.setItem('vitrola_theme', themePref);
    } catch {
      // ignore
    }
  }, [themePref]);

  // Apply playback speed to audio element
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.playbackRate = playbackSpeed;
    }
  }, [playbackSpeed, currentTrack]);

  // Sleep Timer countdown
  useEffect(() => {
    if (sleepTimerMinutes <= 0) {
      setSleepRemainingSec(0);
      return;
    }
    setSleepRemainingSec(sleepTimerMinutes * 60);
    const interval = setInterval(() => {
      setSleepRemainingSec((prev) => {
        if (prev <= 1) {
          if (audioRef.current && !audioRef.current.paused) {
            audioRef.current.pause();
          }
          setSleepTimerMinutes(0);
          showToast('Timer de desligamento: reprodução pausada');
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [sleepTimerMinutes, showToast]);

  // Remove specific tracks (single track, entire album, or entire artist) from IndexedDB, state, and queue
  const executeDeleteTracks = async (indicesToRemove: number[], kind: 'track' | 'album' | 'artist', title: string) => {
    const removeSet = new Set(indicesToRemove.filter((idx) => idx >= 0 && idx < tracks.length));
    if (removeSet.size === 0) {
      setConfirmRemove(null);
      return;
    }

    const idsToDelete: number[] = [];
    const keysToDelete: string[] = [];
    removeSet.forEach((idx) => {
      const tr = tracks[idx];
      if (tr) {
        if (tr.id != null) idsToDelete.push(tr.id);
        if (tr.key) keysToDelete.push(tr.key);
      }
    });

    await dbDeleteMany(idsToDelete, keysToDelete);

    // Build old index -> new index map
    const oldToNew = new Map<number, number>();
    const remainingTracks: Track[] = [];
    tracks.forEach((tr, oldIdx) => {
      if (!removeSet.has(oldIdx)) {
        oldToNew.set(oldIdx, remainingTracks.length);
        remainingTracks.push(tr);
      }
    });

    // Update queue & queueIndex
    const wasPlayingRemoved = currentIndex >= 0 && removeSet.has(currentIndex);
    const updatedQueue: QueueItem[] = [];
    let newQueueIndex = -1;

    queue.forEach((item, qPos) => {
      const mappedIdx = oldToNew.get(item.trackIdx);
      if (mappedIdx != null) {
        if (qPos === queueIndex) {
          newQueueIndex = updatedQueue.length;
        }
        updatedQueue.push({ ...item, trackIdx: mappedIdx });
      } else if (qPos < queueIndex && newQueueIndex === -1) {
        // item before current was removed
      }
    });

    if (newQueueIndex === -1 && updatedQueue.length > 0) {
      // Find the next surviving item at or after previous queueIndex
      let survivorNewPos = 0;
      let countBefore = 0;
      for (let qPos = 0; qPos < queue.length; qPos++) {
        if (oldToNew.has(queue[qPos].trackIdx)) {
          if (qPos >= queueIndex) {
            survivorNewPos = countBefore;
            break;
          }
          countBefore++;
        }
      }
      newQueueIndex = Math.min(survivorNewPos, updatedQueue.length - 1);
    }

    setTracks(remainingTracks);
    setQueue(updatedQueue);
    setQueueIndex(newQueueIndex);

    if (remainingTracks.length === 0 || updatedQueue.length === 0 || newQueueIndex < 0) {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.removeAttribute('src');
      }
      setIsPlaying(false);
      pendingPosRef.current = 0;
      try {
        localStorage.removeItem('pstate1');
      } catch {
        // ignore
      }
    } else if (wasPlayingRemoved) {
      const nextTrackToLoad = remainingTracks[updatedQueue[newQueueIndex].trackIdx];
      if (nextTrackToLoad && audioRef.current) {
        audioRef.current.src = nextTrackToLoad.url;
        if (isPlaying) {
          audioRef.current.play().catch(() => {});
        }
      }
    }

    // Close detail page if the viewed artist or album now has no tracks left
    if (pageStack.length > 0) {
      setPageStack((prev) =>
        prev.filter((p) => {
          if (p.t === 'artist') {
            return remainingTracks.some((t) => nrm(artKey(t)) === nrm(p.k));
          }
          const [alb, art] = p.k.split('||');
          return remainingTracks.some(
            (t) => `${nrm(t.album || ALB_UNK)}||${nrm(artKey(t))}` === `${nrm(alb)}||${nrm(art)}`
          );
        })
      );
    }

    setConfirmRemove(null);
    setActionMenu(null);

    if (kind === 'artist') {
      showToast(`Artista "${title}" removido`);
    } else if (kind === 'album') {
      showToast(`Álbum "${title}" removido`);
    } else {
      showToast(`Música "${title}" removida`);
    }
  };

  // Grouping for Artists & Albums (deduplicating collaborations & case/accent variations)
  const artistGroups = useMemo(() => {
    const map = new Map<string, { name: string; count: number; cover?: string }>();
    tracks.forEach((t) => {
      const display = artKey(t);
      const normKey = nrm(display) || display;
      const g = map.get(normKey) || { name: display, count: 0 };
      g.count++;
      if (!g.cover && (t.cover || t.web)) g.cover = t.cover || t.web || undefined;
      map.set(normKey, g);
    });
    return Array.from(map.values()).sort((a, b) =>
      String(a.name || '').localeCompare(String(b.name || ''), 'pt')
    );
  }, [tracks]);

  const albumGroups = useMemo(() => {
    const map = new Map<
      string,
      { key: string; name: string; artist: string; count: number; cover?: string; trackIndices: number[] }
    >();
    tracks.forEach((t, idx) => {
      const primaryArt = artKey(t);
      if (artFilter && nrm(primaryArt) !== nrm(artFilter)) return;
      const rawKey = albKey(t);
      const normAlbKey = `${nrm(t.album || ALB_UNK)}||${nrm(primaryArt)}`;
      const g = map.get(normAlbKey) || {
        key: rawKey,
        name: (t.album || ALB_UNK).trim(),
        artist: primaryArt === ART_UNK ? '' : primaryArt,
        count: 0,
        trackIndices: [],
      };
      g.count++;
      g.trackIndices.push(idx);
      if (!g.cover && (t.cover || t.web)) g.cover = t.cover || t.web || undefined;
      map.set(normAlbKey, g);
    });
    return Array.from(map.values()).sort((a, b) =>
      String(a.name || '').localeCompare(String(b.name || ''), 'pt')
    );
  }, [tracks, artFilter]);

  const requestedArtistsRef = useRef<Set<string>>(new Set());
  const requestedAlbumsRef = useRef<Set<string>>(new Set());

  // Load artist avatars online asynchronously and pre-fill from cache
  useEffect(() => {
    if (artistGroups.length > 0) {
      const initial: Record<string, string> = {};
      artistGroups.forEach((g) => {
        const cached = iGet('artist', g.name);
        if (cached?.img) initial[g.name] = cached.img;
      });
      if (Object.keys(initial).length > 0) {
        setArtistAvatarCache((prev) => ({ ...initial, ...prev }));
      }
    }
  }, [artistGroups]);

  useEffect(() => {
    if ((isLibraryOpen || tracks.length > 0) && artistGroups.length > 0) {
      artistGroups.forEach((g) => {
        if (g.name !== ART_UNK && !requestedArtistsRef.current.has(g.name)) {
          requestedArtistsRef.current.add(g.name);
          iLoad('artist', g.name).then((info) => {
            const val = info?.img || 'none';
            setArtistAvatarCache((prev) => {
              if (prev[g.name] === val) return prev;
              return { ...prev, [g.name]: val };
            });
          });
        }
      });
    }
  }, [isLibraryOpen, tracks.length, artistGroups]);

  // Pre-fill album covers from cache and load missing ones asynchronously without re-render cascades
  useEffect(() => {
    if (albumGroups.length > 0) {
      const initial: Record<string, string> = {};
      albumGroups.forEach((g) => {
        if (!g.cover && g.name !== ALB_UNK) {
          const cached = iGet('album', g.artist, g.name);
          if (cached?.img) initial[g.key] = cached.img;
        }
      });
      if (Object.keys(initial).length > 0) {
        setAlbumCoverCache((prev) => ({ ...initial, ...prev }));
      }
    }
  }, [albumGroups]);

  useEffect(() => {
    if ((libraryView === 'albums' || libraryView === 'home') && isLibraryOpen && albumGroups.length > 0) {
      albumGroups.forEach((g) => {
        if (!g.cover && g.name !== ALB_UNK && !requestedAlbumsRef.current.has(g.key)) {
          requestedAlbumsRef.current.add(g.key);
          iLoad('album', g.artist, g.name).then((info) => {
            const val = info?.img || 'none';
            setAlbumCoverCache((prev) => {
              if (prev[g.key] === val) return prev;
              return { ...prev, [g.key]: val };
            });
          });
        }
      });
    }
  }, [libraryView, isLibraryOpen, albumGroups]);

  // YouTube Music inspired queue actions

  // Play a track from a specific context (Library, Album, or Artist)
  const playFromContext = (trackIdx: number, contextList: number[], contextTitle?: string) => {
    if (!tracks[trackIdx]) return;
    const title = contextTitle || 'Biblioteca';
    setQueueContextTitle(title);

    const baseQueue: QueueItem[] = contextList.map((tIdx, i) => ({
      uid: `ctx-${tIdx}-${i}-${Date.now()}`,
      trackIdx: tIdx,
      origIdx: i,
    }));

    const targetQIdx = contextList.indexOf(trackIdx);
    const activeQIdx = targetQIdx >= 0 ? targetQIdx : 0;

    if (shuffle && baseQueue.length > 1) {
      const chosenItem = baseQueue[activeQIdx];
      const rest = baseQueue.filter((_, idx) => idx !== activeQIdx);
      setQueue([chosenItem, ...shuffled(rest)]);
      setQueueIndex(0);
    } else {
      setQueue(baseQueue);
      setQueueIndex(activeQIdx);
    }

    loadAudio(trackIdx, true);
    showToast(`Tocando ${tracks[trackIdx]?.name}`);
  };

  // "Tocar a seguir" (Play Next): inserts directly after currently playing song (at queueIndex + 1)
  const playNext = (trackIdx: number, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (!tracks[trackIdx]) return;

    const newItem: QueueItem = {
      uid: `pn-${trackIdx}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      trackIdx,
      isManual: true,
    };

    if (queue.length === 0 || queueIndex < 0) {
      setQueue([newItem]);
      setQueueIndex(0);
      loadAudio(trackIdx, true);
      showToast(`Tocando agora: ${tracks[trackIdx].name}`);
    } else {
      setQueue((prev) => {
        const next = [...prev];
        next.splice(queueIndex + 1, 0, newItem);
        return next;
      });
      showToast(`Tocar a seguir: ${tracks[trackIdx].name}`);
    }
  };

  // "Adicionar à fila" (Add to Queue): appends to the end of the queue
  const addToQueue = (trackIdx: number, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (!tracks[trackIdx]) return;

    const newItem: QueueItem = {
      uid: `add-${trackIdx}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      trackIdx,
      isManual: true,
    };

    if (queue.length === 0 || queueIndex < 0) {
      setQueue([newItem]);
      setQueueIndex(0);
      loadAudio(trackIdx, true);
      showToast(`Tocando agora: ${tracks[trackIdx].name}`);
    } else {
      setQueue((prev) => [...prev, newItem]);
      showToast(`Adicionada à fila: ${tracks[trackIdx].name}`);
    }
  };

  // Play next for multiple tracks (batch insert right after current)
  const playNextAll = (ids: number[], e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (!ids.length) return;
    const newItems: QueueItem[] = ids.map((tIdx, i) => ({
      uid: `pna-${tIdx}-${Date.now()}-${i}`,
      trackIdx: tIdx,
      isManual: true,
    }));
    if (queue.length === 0 || queueIndex < 0) {
      setQueue(newItems);
      setQueueIndex(0);
      loadAudio(newItems[0].trackIdx, true);
    } else {
      setQueue((prev) => {
        const next = [...prev];
        next.splice(queueIndex + 1, 0, ...newItems);
        return next;
      });
    }
    showToast(`${plural(ids.length, ' música será tocada', ' músicas serão tocadas')} a seguir`);
  };

  // Add multiple tracks to queue end
  const addAllToQueue = (ids: number[], e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (!ids.length) return;
    const newItems: QueueItem[] = ids.map((tIdx, i) => ({
      uid: `ada-${tIdx}-${Date.now()}-${i}`,
      trackIdx: tIdx,
      isManual: true,
    }));
    if (queue.length === 0 || queueIndex < 0) {
      setQueue(newItems);
      setQueueIndex(0);
      loadAudio(newItems[0].trackIdx, true);
    } else {
      setQueue((prev) => [...prev, ...newItems]);
    }
    showToast(`${plural(ids.length, ' música adicionada', ' músicas adicionadas')} à fila`);
  };

  // Play a set of IDs (e.g. from Album / Artist header, or shuffle all)
  const playIds = (ids: number[], shouldShuffle = false, contextTitle?: string) => {
    if (!ids.length) return;
    const title =
      contextTitle ||
      (activePage
        ? activePage.t === 'artist'
          ? `Artista: ${activePage.k}`
          : `Álbum: ${activePage.k.split('||')[0]}`
        : 'Biblioteca');
    setQueueContextTitle(title);

    const baseQueue: QueueItem[] = ids.map((tIdx, i) => ({
      uid: `list-${tIdx}-${i}-${Date.now()}`,
      trackIdx: tIdx,
      origIdx: i,
    }));

    const newQueue = shouldShuffle ? shuffled(baseQueue) : baseQueue;
    setShuffle(shouldShuffle);
    setQueue(newQueue);
    setQueueIndex(0);
    loadAudio(newQueue[0].trackIdx, true);
    showToast(newQueue.length > 1 ? `Tocando (${plural(newQueue.length, ' faixa', ' faixas')})` : 'Tocando');
  };

  // Remove a specific position from the overall queue
  const removeFromQueue = (queuePos: number, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (queuePos < 0 || queuePos >= queue.length) return;

    if (queuePos === queueIndex) {
      if (queue.length === 1) {
        setQueue([]);
        setQueueIndex(-1);
        if (audioRef.current) {
          audioRef.current.pause();
          audioRef.current.removeAttribute('src');
        }
        setIsPlaying(false);
      } else if (queueIndex < queue.length - 1) {
        const nextTrackIdx = queue[queueIndex + 1].trackIdx;
        setQueue((q) => q.filter((_, idx) => idx !== queuePos));
        loadAudio(nextTrackIdx, isPlaying);
      } else {
        const prevTrackIdx = queue[queueIndex - 1].trackIdx;
        setQueueIndex((i) => i - 1);
        setQueue((q) => q.filter((_, idx) => idx !== queuePos));
        loadAudio(prevTrackIdx, isPlaying);
      }
    } else {
      if (queuePos < queueIndex) {
        setQueueIndex((i) => i - 1);
      }
      setQueue((q) => q.filter((_, idx) => idx !== queuePos));
    }
  };

  // Clear upcoming queue (YouTube Music style: preserves currently playing song)
  const clearQueue = () => {
    if (queueIndex >= 0 && queueIndex < queue.length) {
      const currentItem = queue[queueIndex];
      setQueue([currentItem]);
      setQueueIndex(0);
      showToast('Próximas faixas removidas da fila');
    } else {
      setQueue([]);
      setQueueIndex(-1);
      showToast('Fila limpa');
    }
  };

  // Shuffle upcoming items (YouTube Music style: preserves currently playing song and saves original order)
  const shuffleUpcomingQueue = () => {
    if (queueIndex < 0 || queueIndex >= queue.length - 1) {
      showToast('Sem faixas seguintes para embaralhar');
      return;
    }
    const normalized = queue.map((item, idx) => ({
      ...item,
      origIdx: item.origIdx ?? idx,
    }));
    const currentPortion = normalized.slice(0, queueIndex + 1);
    const upcomingPortion = normalized.slice(queueIndex + 1);
    const shuffledUpcoming = shuffled(upcomingPortion);
    setQueue([...currentPortion, ...shuffledUpcoming]);
    setShuffle(true);
    showToast('Modo aleatório ativado');
  };

  // Restore queue to its original unshuffled track order while keeping current track playing seamlessly
  const restoreOriginalQueueOrder = () => {
    if (queue.length <= 1 || queueIndex < 0 || queueIndex >= queue.length) {
      showToast('Modo aleatório desativado');
      return;
    }
    const currentItem = queue[queueIndex];
    const manualUpcoming: QueueItem[] = [];
    const baseItems: QueueItem[] = [];

    queue.forEach((item, idx) => {
      if (item.isManual && idx > queueIndex) {
        manualUpcoming.push(item);
      } else {
        baseItems.push(item);
      }
    });

    baseItems.sort((a, b) => (a.origIdx ?? a.trackIdx) - (b.origIdx ?? b.trackIdx));

    const newCurrentIdx = baseItems.findIndex((item) => item.uid === currentItem.uid);
    const resolvedIdx = newCurrentIdx >= 0 ? newCurrentIdx : 0;

    if (manualUpcoming.length > 0) {
      baseItems.splice(resolvedIdx + 1, 0, ...manualUpcoming);
    }

    setQueue(baseItems);
    setQueueIndex(resolvedIdx);
    showToast('Modo aleatório desativado · Ordem original restaurada');
  };

  // Move an upcoming item up or down
  const moveUpcomingItem = (fromUpIdx: number, toUpIdx: number, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (queueIndex < 0) return;
    const realFrom = queueIndex + 1 + fromUpIdx;
    const realTo = queueIndex + 1 + toUpIdx;
    if (realFrom <= queueIndex || realTo <= queueIndex || realFrom >= queue.length || realTo >= queue.length) return;

    setQueue((prev) => {
      const next = [...prev];
      const [moved] = next.splice(realFrom, 1);
      next.splice(realTo, 0, moved);
      return next;
    });
  };

  // Move an upcoming item directly to be next in queue
  const makeNextInQueue = (upIdx: number, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (upIdx === 0) return;
    moveUpcomingItem(upIdx, 0, e);
    showToast('Movida para tocar a seguir');
  };

  // Jump directly to a queue index
  const jumpToQueueIndex = (targetIdx: number) => {
    if (targetIdx < 0 || targetIdx >= queue.length) return;
    setQueueIndex(targetIdx);
    loadAudio(queue[targetIdx].trackIdx, true);
  };

  // Active page detail for artist/album
  const activePage = pageStack.length ? pageStack[pageStack.length - 1] : null;

  useEffect(() => {
    if (!activePage) {
      setActivePageInfo(null);
      return;
    }
    const isArtist = activePage.t === 'artist';
    const artistName = isArtist ? activePage.k : activePage.k.split('||')[1] || '';
    const albumName = isArtist ? undefined : activePage.k.split('||')[0];

    setActivePageInfoLoading(true);
    let cancel = false;
    iLoad(isArtist ? 'artist' : 'album', artistName, albumName).then((info) => {
      if (!cancel) {
        setActivePageInfo(info);
        setActivePageInfoLoading(false);
      }
    });
    return () => {
      cancel = true;
    };
  }, [activePage]);

  // Page tracks
  const pageTrackIndices = useMemo(() => {
    if (!activePage) return [];
    const isArtist = activePage.t === 'artist';
    const targetNormArtist = isArtist ? nrm(activePage.k) : '';
    const [targetAlb, targetAlbArt] = !isArtist ? activePage.k.split('||') : ['', ''];
    const targetNormAlb = !isArtist ? `${nrm(targetAlb)}||${nrm(targetAlbArt)}` : '';

    return tracks
      .map((t, idx) => ({ t, idx }))
      .filter(({ t }) => {
        if (isArtist) {
          return nrm(artKey(t)) === targetNormArtist;
        }
        const trackNormAlb = `${nrm(t.album || ALB_UNK)}||${nrm(artKey(t))}`;
        return trackNormAlb === targetNormAlb;
      })
      .map(({ idx }) => idx);
  }, [activePage, tracks]);

  // Cover image URL for background blur
  const currentCoverUrl = currentTrack ? currentTrack.cover || currentTrack.web : null;

  // Has cover flag for body class
  useEffect(() => {
    if (currentCoverUrl) {
      document.body.classList.add('cv');
    } else {
      document.body.classList.remove('cv');
    }
  }, [currentCoverUrl]);

  // Onboarding Tour Steps
  const tourSteps = useMemo(
    () => [
      {
        target: null as string | null,
        radius: 20,
        pos: 'center' as 'center' | 'top' | 'bottom',
        title: 'Bem-vindo ao Vitrola!',
        desc: 'Seu player de música local com visual moderno, letras sincronizadas com tradução e fila inteligente. Vamos conhecer os recursos principais em menos de 1 minuto?',
        showDemoBtn: true,
        icon: (
          <svg className="s" viewBox="0 0 24 24">
            <path d="M9 18V5l12-2v13" />
            <circle cx="6" cy="18" r="3" />
            <circle cx="18" cy="16" r="3" />
          </svg>
        ),
      },
      {
        target: '#openList',
        radius: 999,
        pos: 'top' as const,
        title: '1. Início, Biblioteca e Importação',
        desc: 'Toque neste ícone para abrir a Página Inicial e a Biblioteca. Lá você pode importar arquivos ou pastas com subpastas (+), ver as mais tocadas e acessar as configurações (⚙️)!',
        showDemoBtn: true,
        icon: (
          <svg className="s" viewBox="0 0 24 24">
            <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
          </svg>
        ),
      },
      {
        target: '#openLyr',
        radius: 999,
        pos: 'top' as const,
        title: '3. Letras sincronizadas e tradução',
        desc: 'Acompanhe a letra em tempo real linha por linha (ou toque na capa do álbum). Alterne entre Original, Tradução em Português e Modo Bilíngue!',
        showDemoBtn: false,
        icon: (
          <svg className="s" viewBox="0 0 24 24">
            <path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM5 11a7 7 0 0 0 14 0M12 18v3" />
          </svg>
        ),
      },
      {
        target: '.ctrl',
        radius: 20,
        pos: 'top' as const,
        title: '4. Controles e retomada automática',
        desc: 'Controle a reprodução, ative o modo aleatório ou repetição. O Vitrola lembra exatamente a música, o segundo e a fila em que você parou ao reabrir.',
        showDemoBtn: false,
        icon: (
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5.6v12.8a1 1 0 0 0 1.5.9l10.4-6.4a1 1 0 0 0 0-1.7L9.5 4.7A1 1 0 0 0 8 5.6z" />
          </svg>
        ),
      },
      {
        target: '#qgrab',
        radius: 18,
        pos: 'bottom' as const,
        title: '5. Fila estilo YouTube Music',
        desc: 'Puxe esta barra inferior para ver o que está tocando agora, reorganizar as próximas músicas, usar "Tocar a seguir" ou rever o histórico.',
        showDemoBtn: false,
        icon: (
          <svg className="s" viewBox="0 0 24 24">
            <path d="m6 15 6-6 6 6" />
          </svg>
        ),
      },
    ],
    []
  );

  const finishTour = useCallback(() => {
    setIsTourOpen(false);
    setSpotlightRect(null);
    try {
      localStorage.setItem('vitrola_tour_v1', '1');
    } catch {
      // ignore
    }
  }, []);

  const startTour = useCallback(() => {
    setIsLibraryOpen(false);
    setIsLyricsOpen(false);
    setIsQueueOpen(false);
    setPageStack([]);
    setTourStep(0);
    setIsTourOpen(true);
  }, []);

  // Automatically launch onboarding tour on first startup
  useEffect(() => {
    try {
      const done = localStorage.getItem('vitrola_tour_v1');
      if (!done) {
        const timer = setTimeout(() => {
          setIsTourOpen(true);
          setTourStep(0);
        }, 450);
        return () => clearTimeout(timer);
      }
    } catch {
      // ignore
    }
  }, []);

  // Compute spotlight position for current tour step
  useEffect(() => {
    if (!isTourOpen) {
      setSpotlightRect(null);
      return;
    }

    const updateRect = () => {
      const step = tourSteps[tourStep];
      if (!step || !step.target) {
        setSpotlightRect(null);
        return;
      }
      const el = document.querySelector(step.target) as HTMLElement | null;
      if (!el) {
        setSpotlightRect(null);
        return;
      }
      const r = el.getBoundingClientRect();
      const pad = 6;
      setSpotlightRect({
        top: r.top - pad,
        left: r.left - pad,
        width: r.width + pad * 2,
        height: r.height + pad * 2,
        radius: step.radius || 16,
      });
    };

    updateRect();
    window.addEventListener('resize', updateRect);
    window.addEventListener('scroll', updateRect, true);
    return () => {
      window.removeEventListener('resize', updateRect);
      window.removeEventListener('scroll', updateRect, true);
    };
  }, [isTourOpen, tourStep, tourSteps]);

  return (
    <>
      {/* Blurred Album Artwork Background */}
      <div id="bgw" className={currentCoverUrl ? 'on' : ''}>
        <div id="bg" style={{ backgroundImage: currentCoverUrl ? `url('${currentCoverUrl}')` : 'none' }}></div>
      </div>

      <main>
        {/* Header */}
        <header className="hd">
          <h1
            style={{ cursor: 'pointer' }}
            title="Ir para a Página Inicial"
            onClick={() => {
              setIsLyricsOpen(false);
              setIsSettingsOpen(false);
              setPageStack([]);
              setLibraryView('home');
              setIsLibraryOpen(true);
            }}
          >
            <svg className="logo" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
              <defs>
                <linearGradient id="gh" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0" stopColor="#4f6bff" />
                  <stop offset=".55" stopColor="#9b4dff" />
                  <stop offset="1" stopColor="#ff4fa3" />
                </linearGradient>
              </defs>
              <rect width="512" height="512" rx="116" fill="url(#gh)" />
              <circle cx="256" cy="256" r="164" fill="#fff" fillOpacity=".19" />
              <circle cx="256" cy="256" r="164" fill="none" stroke="#fff" strokeOpacity=".9" strokeWidth="12" />
              <g fill="none" stroke="#fff" strokeLinecap="round" strokeWidth="10">
                <path d="M145.1 215.6A118 118 0 0 1 215.6 145.1" strokeOpacity="0.7" />
                <path d="M366.9 296.4A118 118 0 0 1 296.4 366.9" strokeOpacity="0.7" />
                <path d="M190.5 210.1A80 80 0 0 1 242.1 177.2" strokeOpacity="0.45" />
                <path d="M321.5 301.9A80 80 0 0 1 269.9 334.8" strokeOpacity="0.45" />
              </g>
              <circle cx="256" cy="256" r="62" fill="#fff" />
              <path d="M241 230v52a6 6 0 0 0 9 5l42-26a6 6 0 0 0 0-10l-42-26a6 6 0 0 0-9 5z" fill="#8a4dff" />
            </svg>
            <span>Vitrola</span>
          </h1>
          <div>
            {/* Hidden input for individual or multiple audio files */}
            <input
              ref={fileInputRef}
              type="file"
              id="files"
              accept="audio/*,.mp3,.m4a,.wav,.ogg,.flac,.aac,.opus"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => {
                handleFiles(e.target.files);
                e.target.value = '';
              }}
            />
            {/* Hidden input for folder and subfolders recursive selection */}
            <input
              ref={folderInputRef}
              type="file"
              id="folderFiles"
              multiple
              style={{ display: 'none' }}
              {...({ webkitdirectory: '', directory: '' } as React.InputHTMLAttributes<HTMLInputElement>)}
              onChange={(e) => {
                handleFiles(e.target.files);
                e.target.value = '';
              }}
            />
            <button
              className="ib"
              id="openLyr"
              title="Letra"
              aria-label="Letra"
              onClick={() => {
                setIsLibraryOpen(false);
                setIsLyricsOpen(true);
              }}
            >
              <svg className="s" viewBox="0 0 24 24">
                <path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM5 11a7 7 0 0 0 14 0M12 18v3" />
              </svg>
            </button>
            <button
              className="ib"
              id="openList"
              title="Biblioteca de músicas"
              aria-label="Biblioteca de músicas"
              onClick={() => {
                setIsLyricsOpen(false);
                setIsSettingsOpen(false);
                if (libraryView === 'home' && isLibraryOpen) {
                  setLibraryView('tracks');
                }
                setIsLibraryOpen(true);
              }}
            >
              <svg className="s" viewBox="0 0 24 24">
                <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
              </svg>
            </button>
          </div>
        </header>

        {/* Now Playing Main Center View */}
        <div className="now">
          {currentCoverUrl ? (
            <img
              id="cover"
              src={currentCoverUrl}
              alt="Capa do álbum"
              style={{ display: 'block' }}
              onClick={() => setIsLyricsOpen(true)}
            />
          ) : (
            <div id="ph" onClick={() => setIsLyricsOpen(true)}>
              <svg className="s" viewBox="0 0 24 24">
                <path d="M9 18V5l12-2v13" />
                <circle cx="6" cy="18" r="3" />
                <circle cx="18" cy="16" r="3" />
              </svg>
            </div>
          )}

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              marginTop: 14,
              padding: '0 8px',
            }}
          >
            <div id="title" style={{ marginTop: 0 }}>
              {currentTrack ? currentTrack.name : 'Nenhuma faixa'}
            </div>
            {currentTrack && (
              <button
                type="button"
                className={`qb ${favoriteKeys.includes(currentTrack.key) ? 'fav-on' : ''}`}
                title={favoriteKeys.includes(currentTrack.key) ? 'Remover das Favoritas' : 'Adicionar às Favoritas'}
                aria-label="Favoritar música"
                onClick={(e) => toggleFavorite(currentTrack.key, e)}
              >
                <svg
                  className="s"
                  viewBox="0 0 24 24"
                  fill={favoriteKeys.includes(currentTrack.key) ? 'currentColor' : 'none'}
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                </svg>
              </button>
            )}
          </div>
          <div
            id="sub"
            onClick={() => {
              if (currentTrack && currentTrack.artist) {
                setPageStack([{ t: 'artist', k: artKey(currentTrack) }]);
                setIsLibraryOpen(true);
              }
            }}
          >
            {currentTrack
              ? [currentTrack.artist, currentTrack.album].filter(Boolean).join(' – ') ||
                `Faixa ${currentIndex + 1} de ${tracks.length}`
              : 'Adicione arquivos para começar'}
          </div>

          <input
            type="range"
            id="seek"
            min="0"
            max="100"
            step="0.1"
            value={duration ? (currentTime / duration) * 100 : 0}
            aria-label="Posição"
            onChange={(e) => {
              if (audioRef.current && duration) {
                audioRef.current.currentTime = (parseFloat(e.target.value) / 100) * duration;
              }
            }}
          />

          <div className="times">
            <span id="cur">{formatTime(currentTime)}</span>
            <span id="dur">{formatTime(duration)}</span>
          </div>

          <div className="ctrl">
            <button
              id="shuf"
              className={`ib ${shuffle ? 'on' : ''}`}
              title="Aleatório"
              aria-label="Aleatório"
              aria-pressed={shuffle}
              onClick={() => {
                const nextShuf = !shuffle;
                setShuffle(nextShuf);
                if (nextShuf) {
                  shuffleUpcomingQueue();
                } else {
                  restoreOriginalQueueOrder();
                }
              }}
            >
              <svg className="s" viewBox="0 0 24 24">
                <path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5" />
              </svg>
            </button>

            <button id="prev" className="ib" aria-label="Anterior" onClick={prevTrack}>
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M5.5 5h2v14h-2z" />
                <path d="M20 5.6v12.8a1 1 0 0 1-1.6.8L10 13.2a1.3 1.3 0 0 1 0-2.4l8.4-6a1 1 0 0 1 1.6.8z" />
              </svg>
            </button>

            <button
              id="play"
              className={`ib big ${isPlaying ? 'playing' : ''}`}
              aria-label="Tocar ou pausar"
              onClick={() => {
                if (currentIndex < 0 && tracks.length > 0) {
                  loadTrack(0, true);
                  return;
                }
                if (audioRef.current) {
                  if (audioRef.current.paused) audioRef.current.play().catch(() => {});
                  else audioRef.current.pause();
                }
              }}
            >
              <svg className="pl" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5.6v12.8a1 1 0 0 0 1.5.9l10.4-6.4a1 1 0 0 0 0-1.7L9.5 4.7A1 1 0 0 0 8 5.6z" />
              </svg>
              <svg className="pa" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="5" width="4.5" height="14" rx="1.5" />
                <rect x="13.5" y="5" width="4.5" height="14" rx="1.5" />
              </svg>
            </button>

            <button id="next" className="ib" aria-label="Próxima" onClick={() => nextTrack(false)}>
              <svg viewBox="0 0 24 24" fill="currentColor" style={{ transform: 'scaleX(-1)' }}>
                <path d="M5.5 5h2v14h-2z" />
                <path d="M20 5.6v12.8a1 1 0 0 1-1.6.8L10 13.2a1.3 1.3 0 0 1 0-2.4l8.4-6a1 1 0 0 1 1.6.8z" />
              </svg>
            </button>

            <button
              id="rep"
              className={`ib ${repeat > 0 ? 'on' : ''}`}
              data-m={repeat}
              title={['Repetir: desligado', 'Repetir: todas', 'Repetir: esta faixa'][repeat]}
              aria-label="Repetir"
              aria-pressed={repeat > 0}
              onClick={() => {
                const nextRep = (repeat + 1) % 3;
                setRepeat(nextRep);
                const titles = ['Repetição desligada', 'Repetir toda a fila', 'Repetir faixa atual'];
                showToast(titles[nextRep]);
              }}
            >
              <svg className="s" viewBox="0 0 24 24">
                <path d="m17 2 4 4-4 4" />
                <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
                <path d="m7 22-4-4 4-4" />
                <path d="M21 13v1a4 4 0 0 1-4 4H3" />
              </svg>
            </button>
          </div>

          {/* Quick Demo tracks action if library is empty */}
          {tracks.length === 0 && (
            <div style={{ textAlign: 'center', marginTop: 16 }}>
              <button
                className="main"
                style={{ borderRadius: 999, fontSize: '0.9rem', padding: '10px 20px' }}
                onClick={loadDemoTracks}
              >
                Carregar faixas de demonstração
              </button>
            </div>
          )}
        </div>

        {/* Toast */}
        <div id="toast" role="status" className={toastMsg ? 'on' : ''}>
          {toastMsg}
        </div>

        {/* Queue Bottom Sheet (YouTube Music Architecture) */}
        <div id="qscrim" className={isQueueOpen ? 'on' : ''} onClick={() => setIsQueueOpen(false)}></div>
        <section id="qsheet" aria-label="Fila de reprodução" className={isQueueOpen ? 'on' : ''}>
          {/* Peek Bar */}
          <div id="qgrab" onClick={() => setIsQueueOpen(!isQueueOpen)}>
            <span className="grip"></span>
            <div className="qrow">
              <span className="qt">
                <span>Fila de reprodução</span>
                {upcomingItems.length > 0 && <span className="qtag">{upcomingItems.length}</span>}
              </span>
              <span className="qr">
                {!isQueueOpen && upcomingItems.length > 0 && tracks[upcomingItems[0].trackIdx] && (
                  <span
                    style={{
                      fontSize: '0.78rem',
                      color: 'var(--muted)',
                      maxWidth: 165,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    A seguir: <b>{tracks[upcomingItems[0].trackIdx].name}</b>
                  </span>
                )}
                <svg className="s qchev" viewBox="0 0 24 24">
                  <path d="m6 15 6-6 6 6" />
                </svg>
              </span>
            </div>
          </div>

          {/* YouTube Music Context & Quick Actions Bar */}
          <div className="qyt-topbar">
            <div className="qyt-context">
              <span className="qyt-sub">Tocando de</span>
              <span className="qyt-title">{queueContextTitle}</span>
            </div>
            <div className="qyt-actions">
              {queue.length > 1 && (
                <button
                  type="button"
                  className="qyt-btn"
                  onClick={() => {
                    if (shuffle) {
                      setShuffle(false);
                      restoreOriginalQueueOrder();
                    } else {
                      shuffleUpcomingQueue();
                    }
                  }}
                  title={shuffle ? 'Restaurar ordem original' : 'Embaralhar próximas faixas'}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5" />
                  </svg>
                  {shuffle ? 'Ordem original' : 'Embaralhar'}
                </button>
              )}
              {upcomingItems.length > 0 && (
                <button
                  type="button"
                  className="qyt-btn"
                  onClick={clearQueue}
                  title="Limpar próximas faixas da fila"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                  Limpar
                </button>
              )}
            </div>
          </div>

          {/* Queue Content Scroll Container */}
          <ul id="qlist">
            {/* Section 1: Tocando Agora (Now Playing Card) */}
            {currentTrack && (
              <>
                <div className="qsec-title">Tocando agora</div>
                <div className="qnow-card">
                  <div className="qnow-art">
                    {currentCoverUrl ? (
                      <img src={currentCoverUrl} alt="" />
                    ) : (
                      <div
                        style={{
                          width: '100%',
                          height: '100%',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <svg className="s" style={{ width: 22, height: 22 }} viewBox="0 0 24 24">
                          <path d="M9 18V5l12-2v13" />
                          <circle cx="6" cy="18" r="3" />
                          <circle cx="18" cy="16" r="3" />
                        </svg>
                      </div>
                    )}
                    {isPlaying && (
                      <div className="eq">
                        <b></b>
                        <b></b>
                        <b></b>
                      </div>
                    )}
                  </div>
                  <div className="qnow-tx">
                    <b>{currentTrack.name}</b>
                    <small>{[currentTrack.artist, currentTrack.album].filter(Boolean).join(' · ')}</small>
                  </div>
                  <span className="qnow-badge">{isPlaying ? 'No ar' : 'Pausado'}</span>
                </div>
              </>
            )}

            {/* Section 2: A Seguir (Upcoming tracks) */}
            <div className="qsec-title">
              A seguir
              <span>
                {upcomingItems.length
                  ? `${plural(upcomingItems.length, ' música', ' músicas')}${upcomingDurationText ? ` • ${upcomingDurationText}` : ''}`
                  : 'Fim da fila'}
              </span>
            </div>

            {upcomingItems.length === 0 ? (
              <li className="empty" style={{ margin: '10px 8px' }}>
                Nenhuma música a seguir. Adicione faixas da biblioteca tocando em &ldquo;Tocar a seguir&rdquo; ou &ldquo;Adicionar à fila&rdquo;.
              </li>
            ) : (
              upcomingItems.map((item, upIdx) => {
                const t = tracks[item.trackIdx];
                if (!t) return null;
                const coverSrc = t.cover || t.web;
                const realQueuePos = queueIndex + 1 + upIdx;
                return (
                  <li
                    key={item.uid}
                    className="qitem"
                    tabIndex={0}
                    onClick={() => jumpToQueueIndex(realQueuePos)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') jumpToQueueIndex(realQueuePos);
                    }}
                  >
                    <span className="qitem-idx">{upIdx + 1}</span>
                    <div className="qitem-art">
                      {coverSrc ? (
                        <img src={coverSrc} alt="" onError={(e) => (e.currentTarget.style.display = 'none')} />
                      ) : (
                        <div
                          style={{
                            width: '100%',
                            height: '100%',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          <svg className="s" style={{ width: 18, height: 18 }} viewBox="0 0 24 24">
                            <path d="M9 18V5l12-2v13" />
                            <circle cx="6" cy="18" r="3" />
                            <circle cx="18" cy="16" r="3" />
                          </svg>
                        </div>
                      )}
                    </div>
                    <div className="qitem-tx">
                      <b>{t.name}</b>
                      <small>{t.artist || 'Artista desconhecido'}</small>
                      {item.isManual && <span className="qitem-tag">Adicionada à fila</span>}
                    </div>
                    <span className="qitem-dur">{t.dur || ''}</span>
                    <div className="qitem-actions">
                      <button
                        type="button"
                        title="Mover para cima"
                        aria-label="Mover para cima"
                        disabled={upIdx === 0}
                        onClick={(e) => moveUpcomingItem(upIdx, upIdx - 1, e)}
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <path d="m18 15-6-6-6 6" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        title="Mover para baixo"
                        aria-label="Mover para baixo"
                        disabled={upIdx === upcomingItems.length - 1}
                        onClick={(e) => moveUpcomingItem(upIdx, upIdx + 1, e)}
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <path d="m6 9 6 6 6-6" />
                        </svg>
                      </button>
                      {upIdx > 0 && (
                        <button
                          type="button"
                          title="Tocar a seguir"
                          aria-label="Tocar a seguir"
                          onClick={(e) => makeNextInQueue(upIdx, e)}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="m5 4 10 8-10 8V4zM19 5v14" />
                          </svg>
                        </button>
                      )}
                      <button
                        type="button"
                        title="Remover da fila"
                        aria-label="Remover da fila"
                        onClick={(e) => removeFromQueue(realQueuePos, e)}
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M18 6 6 18M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  </li>
                );
              })
            )}

            {/* Section 3: Tocadas Anteriormente (History) */}
            {previousItems.length > 0 && (
              <>
                <button
                  type="button"
                  className="qhist-toggle"
                  onClick={() => setShowQueueHistory(!showQueueHistory)}
                >
                  <span>Tocadas anteriormente ({previousItems.length})</span>
                  <svg
                    className="s"
                    style={{
                      width: 16,
                      height: 16,
                      transform: showQueueHistory ? 'rotate(180deg)' : 'none',
                      transition: 'transform 0.2s',
                    }}
                    viewBox="0 0 24 24"
                  >
                    <path d="m6 9 6 6 6-6" />
                  </svg>
                </button>
                {showQueueHistory && (
                  <div>
                    {previousItems.map((item, pIdx) => {
                      const t = tracks[item.trackIdx];
                      if (!t) return null;
                      const coverSrc = t.cover || t.web;
                      return (
                        <li
                          key={`prev-${item.uid}`}
                          className="qitem history"
                          tabIndex={0}
                          onClick={() => jumpToQueueIndex(pIdx)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') jumpToQueueIndex(pIdx);
                          }}
                        >
                          <span className="qitem-idx">{pIdx + 1}</span>
                          <div className="qitem-art">
                            {coverSrc ? (
                              <img src={coverSrc} alt="" onError={(e) => (e.currentTarget.style.display = 'none')} />
                            ) : (
                              <div
                                style={{
                                  width: '100%',
                                  height: '100%',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                }}
                              >
                                <svg className="s" style={{ width: 18, height: 18 }} viewBox="0 0 24 24">
                                  <path d="M9 18V5l12-2v13" />
                                  <circle cx="6" cy="18" r="3" />
                                  <circle cx="18" cy="16" r="3" />
                                </svg>
                              </div>
                            )}
                          </div>
                          <div className="qitem-tx">
                            <b>{t.name}</b>
                            <small>{t.artist || 'Artista desconhecido'}</small>
                          </div>
                          <span className="qitem-dur">{t.dur || ''}</span>
                        </li>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </ul>
        </section>

        {/* Scrim for Library, Lyrics, and Settings */}
        <div
          id="scrim"
          className={isLibraryOpen || isLyricsOpen || isSettingsOpen ? 'on' : ''}
          onClick={() => {
            setIsLibraryOpen(false);
            setIsLyricsOpen(false);
            setIsSettingsOpen(false);
            if (pageStack.length) setPageStack([]);
          }}
        ></div>

        {/* Music Home & Library Sheet */}
        <section id="sheet" aria-label="Página inicial e Biblioteca" className={isLibraryOpen ? 'on' : ''}>
          <header>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {libraryView === 'home' ? (
                <>
                  <span>
                    {(() => {
                      const hr = new Date().getHours();
                      if (hr >= 5 && hr < 12) return 'Bom dia';
                      if (hr >= 12 && hr < 18) return 'Boa tarde';
                      return 'Boa noite';
                    })()}
                  </span>
                </>
              ) : (
                'Biblioteca'
              )}
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginLeft: 'auto' }}>
              <button
                type="button"
                className="ib"
                title="Adicionar músicas ou pastas"
                aria-label="Adicionar músicas ou pastas"
                onClick={() => setIsImportMenuOpen(true)}
              >
                <svg className="s" viewBox="0 0 24 24">
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </button>
              <button
                type="button"
                className="ib"
                title="Configurações"
                aria-label="Configurações"
                onClick={() => {
                  setIsLibraryOpen(false);
                  setIsSettingsOpen(true);
                }}
              >
                <svg className="s" viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06-.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
              </button>
              <button
                className="ib"
                id="closeList"
                title="Abrir reprodutor em tela cheia"
                aria-label="Fechar"
                onClick={() => {
                  setIsLibraryOpen(false);
                  if (pageStack.length) setPageStack([]);
                }}
              >
                <svg className="s" viewBox="0 0 24 24">
                  <path d="M6 6l12 12M18 6 6 18" />
                </svg>
              </button>
            </div>
          </header>

          <nav id="tabs">
            <button
              type="button"
              data-v="home"
              className={libraryView === 'home' ? 'on' : ''}
              onClick={() => {
                setPageStack([]);
                setLibraryView('home');
                setArtFilter(null);
              }}
            >
              Início
            </button>
            <button
              type="button"
              data-v="tracks"
              className={libraryView === 'tracks' ? 'on' : ''}
              onClick={() => {
                setPageStack([]);
                setLibraryView('tracks');
                setArtFilter(null);
              }}
            >
              Faixas
            </button>
            <button
              type="button"
              data-v="artists"
              className={libraryView === 'artists' ? 'on' : ''}
              onClick={() => {
                setPageStack([]);
                setLibraryView('artists');
                setArtFilter(null);
              }}
            >
              Artistas
            </button>
            <button
              type="button"
              data-v="albums"
              className={libraryView === 'albums' ? 'on' : ''}
              onClick={() => {
                setPageStack([]);
                setLibraryView('albums');
                setArtFilter(null);
              }}
            >
              Álbuns
            </button>
          </nav>

          <div id="lbox2">
            {/* Main Library List Content */}
            <ul id="list" className={isPlaying ? 'plg' : ''}>
              {tracks.length === 0 ? (
                <div className="home-wrap">
                  <div className="home-empty-card">
                    <svg className="s" style={{ width: 38, height: 38, color: 'var(--accent)' }} viewBox="0 0 24 24">
                      <path d="M9 18V5l12-2v13" />
                      <circle cx="6" cy="18" r="3" />
                      <circle cx="18" cy="16" r="3" />
                    </svg>
                    <b style={{ fontSize: '1rem' }}>Sua biblioteca está vazia</b>
                    <p>
                      Importe arquivos de áudio ou uma pasta inteira com subpastas para ver suas músicas mais tocadas,
                      artistas, álbuns e favoritas aqui na Página Inicial.
                    </p>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center', marginTop: 4 }}>
                      <button
                        type="button"
                        className="home-act-btn primary"
                        style={{ width: 'auto' }}
                        onClick={() => setIsImportMenuOpen(true)}
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M12 5v14M5 12h14" />
                        </svg>
                        <span>Importar músicas</span>
                      </button>
                      <button
                        type="button"
                        className="home-act-btn"
                        style={{ width: 'auto' }}
                        onClick={loadDemoTracks}
                      >
                        <svg viewBox="0 0 24 24" fill="currentColor">
                          <path d="M8 5.6v12.8a1 1 0 0 0 1.5.9l10.4-6.4a1 1 0 0 0 0-1.7L9.5 4.7A1 1 0 0 0 8 5.6z" />
                        </svg>
                        <span>Faixas de demonstração</span>
                      </button>
                    </div>
                  </div>
                </div>
              ) : libraryView === 'home' ? (
                <div className="home-wrap">
                  {/* Global Search Box */}
                  <div className="home-search-box">
                    <svg className="s search-ic" viewBox="0 0 24 24">
                      <circle cx="11" cy="11" r="8" />
                      <path d="m21 21-4.3-4.3" />
                    </svg>
                    <input
                      type="search"
                      className="home-search-input"
                      placeholder="Buscar músicas, artistas ou álbuns..."
                      aria-label="Buscar na biblioteca"
                      value={homeSearchQuery}
                      onChange={(e) => setHomeSearchQuery(e.target.value)}
                    />
                    {homeSearchQuery && (
                      <button
                        type="button"
                        className="home-search-clear"
                        aria-label="Limpar busca"
                        onClick={() => setHomeSearchQuery('')}
                      >
                        <svg className="s" style={{ width: 16, height: 16 }} viewBox="0 0 24 24">
                          <path d="M18 6 6 18M6 6l12 12" />
                        </svg>
                      </button>
                    )}
                  </div>

                  {homeSearchQuery.trim() ? (
                    (() => {
                      const qNorm = nrm(homeSearchQuery);
                      const matchedTracks = tracks
                        .map((t, idx) => ({ t, idx }))
                        .filter(
                          ({ t }) =>
                            nrm(t.name).includes(qNorm) ||
                            nrm(t.artist).includes(qNorm) ||
                            nrm(t.album).includes(qNorm)
                        );
                      const matchedArtists = artistGroups.filter((g) => nrm(g.name).includes(qNorm));
                      const matchedAlbums = albumGroups.filter(
                        (g) => nrm(g.name).includes(qNorm) || nrm(g.artist).includes(qNorm)
                      );

                      if (!matchedTracks.length && !matchedArtists.length && !matchedAlbums.length) {
                        return (
                          <div className="home-empty-card">
                            <p>Nenhum resultado encontrado para &ldquo;{homeSearchQuery}&rdquo;.</p>
                          </div>
                        );
                      }

                      return (
                        <>
                          {matchedTracks.length > 0 && (
                            <div className="home-sec">
                              <div className="home-sec-hd">
                                <h3 className="home-sec-title">Músicas ({matchedTracks.length})</h3>
                              </div>
                              <div>
                                {matchedTracks.slice(0, 12).map(({ t, idx }) => {
                                  const isCur = idx === currentIndex;
                                  const coverSrc = t.cover || t.web;
                                  const isFav = favoriteKeys.includes(t.key);
                                  return (
                                    <li
                                      key={`hsearch-t-${t.key}-${idx}`}
                                      className={`trk ${isCur ? 'cur' : ''}`}
                                      onClick={() => {
                                        playFromContext(
                                          idx,
                                          matchedTracks.map((m) => m.idx),
                                          `Busca: ${homeSearchQuery}`
                                        );
                                      }}
                                    >
                                      <span className="tth">
                                        {coverSrc ? (
                                          <img
                                            src={coverSrc}
                                            alt=""
                                            onError={(e) => (e.currentTarget.style.display = 'none')}
                                          />
                                        ) : (
                                          <svg className="s" viewBox="0 0 24 24">
                                            <path d="M9 18V5l12-2v13" />
                                            <circle cx="6" cy="18" r="3" />
                                            <circle cx="18" cy="16" r="3" />
                                          </svg>
                                        )}
                                        <i className="eq">
                                          <b></b>
                                          <b></b>
                                          <b></b>
                                        </i>
                                      </span>
                                      <span className="tx">
                                        <b>{t.name}</b>
                                        <small>{[t.artist, t.album].filter(Boolean).join(' · ')}</small>
                                      </span>
                                      <div className="row-actions">
                                        <button
                                          type="button"
                                          className={`qb ${isFav ? 'fav-on' : ''}`}
                                          aria-label="Favoritar"
                                          onClick={(e) => toggleFavorite(t.key, e)}
                                        >
                                          <svg
                                            className="s"
                                            viewBox="0 0 24 24"
                                            fill={isFav ? 'currentColor' : 'none'}
                                            stroke="currentColor"
                                            strokeWidth="2"
                                          >
                                            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                                          </svg>
                                        </button>
                                      </div>
                                    </li>
                                  );
                                })}
                              </div>
                            </div>
                          )}

                          {matchedArtists.length > 0 && (
                            <div className="home-sec">
                              <div className="home-sec-hd">
                                <h3 className="home-sec-title">Artistas ({matchedArtists.length})</h3>
                              </div>
                              <div className="home-hscroll">
                                {matchedArtists.map((g) => {
                                  const cached =
                                    artistAvatarCache[g.name] && artistAvatarCache[g.name] !== 'none'
                                      ? artistAvatarCache[g.name]
                                      : undefined;
                                  const imgSrc = cached || g.cover;
                                  return (
                                    <div
                                      key={`hsearch-a-${g.name}`}
                                      className="home-hcard artist"
                                      onClick={() => setPageStack([{ t: 'artist', k: g.name }])}
                                    >
                                      <div className="home-hcard-art">
                                        {imgSrc ? (
                                          <img
                                            src={imgSrc}
                                            alt=""
                                            onError={(e) => (e.currentTarget.style.display = 'none')}
                                          />
                                        ) : (
                                          <svg className="s" viewBox="0 0 24 24">
                                            <circle cx="12" cy="8" r="4" />
                                            <path d="M4 20c1.8-3.8 5-6 8-6s6.2 2.2 8 6" />
                                          </svg>
                                        )}
                                      </div>
                                      <b>{g.name}</b>
                                      <small>{plural(g.count, ' música', ' músicas')}</small>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          )}

                          {matchedAlbums.length > 0 && (
                            <div className="home-sec">
                              <div className="home-sec-hd">
                                <h3 className="home-sec-title">Álbuns ({matchedAlbums.length})</h3>
                              </div>
                              <div className="home-hscroll">
                                {matchedAlbums.map((g) => {
                                  const cached =
                                    albumCoverCache[g.key] && albumCoverCache[g.key] !== 'none'
                                      ? albumCoverCache[g.key]
                                      : undefined;
                                  const imgSrc = g.cover || cached;
                                  return (
                                    <div
                                      key={`hsearch-alb-${g.key}`}
                                      className="home-hcard"
                                      onClick={() => setPageStack([{ t: 'album', k: g.key }])}
                                    >
                                      <div className="home-hcard-art">
                                        {imgSrc ? (
                                          <img
                                            src={imgSrc}
                                            alt=""
                                            onError={(e) => (e.currentTarget.style.display = 'none')}
                                          />
                                        ) : (
                                          <svg className="s" viewBox="0 0 24 24">
                                            <circle cx="12" cy="12" r="9" />
                                            <circle cx="12" cy="12" r="2.5" />
                                          </svg>
                                        )}
                                      </div>
                                      <b>{g.name}</b>
                                      <small>{g.artist || plural(g.count, ' música', ' músicas')}</small>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          )}
                        </>
                      );
                    })()
                  ) : (
                    <>
                      {/* 1. Quick Player Actions (Tocar Tudo & Mix Aleatório) */}
                      <div className="home-actions">
                        <button
                          type="button"
                          className="home-act-btn primary"
                          onClick={() => {
                            const allIds = tracks.map((_, i) => i);
                            playIds(allIds, false, 'Biblioteca');
                          }}
                        >
                          <svg viewBox="0 0 24 24" fill="currentColor">
                            <path d="M8 5.6v12.8a1 1 0 0 0 1.5.9l10.4-6.4a1 1 0 0 0 0-1.7L9.5 4.7A1 1 0 0 0 8 5.6z" />
                          </svg>
                          <span>Tocar tudo ({tracks.length})</span>
                        </button>
                        <button
                          type="button"
                          className="home-act-btn"
                          onClick={() => {
                            const allIds = tracks.map((_, i) => i);
                            playIds(allIds, true, 'Mix Aleatório');
                          }}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5" />
                          </svg>
                          <span>Mix Aleatório</span>
                        </button>
                      </div>

                      {/* 2. Quick-Pick 2x2 Grid (Continuar Ouvindo / Acesso Rápido) */}
                      {(() => {
                        const quickPicks: Array<{
                          id: string;
                          title: string;
                          sub: string;
                          img?: string | null;
                          onClick: () => void;
                        }> = [];

                        if (currentTrack && currentIndex >= 0) {
                          quickPicks.push({
                            id: 'qp-now',
                            title: currentTrack.name,
                            sub: isPlaying ? 'Tocando agora' : 'Continuar ouvindo',
                            img: currentTrack.cover || currentTrack.web,
                            onClick: () => {
                              if (audioRef.current && audioRef.current.paused) {
                                audioRef.current.play().catch(() => {});
                              } else {
                                setIsLibraryOpen(false);
                              }
                            },
                          });
                        }

                        const favIndices = tracks
                          .map((t, i) => ({ t, i }))
                          .filter(({ t }) => favoriteKeys.includes(t.key))
                          .map(({ i }) => i);
                        if (favIndices.length > 0) {
                          const firstFav = tracks[favIndices[0]];
                          quickPicks.push({
                            id: 'qp-favs',
                            title: 'Suas Favoritas',
                            sub: plural(favIndices.length, ' música curtida', ' músicas curtidas'),
                            img: firstFav?.cover || firstFav?.web,
                            onClick: () => playIds(favIndices, false, 'Suas Favoritas'),
                          });
                        }

                        artistGroups.slice(0, 2).forEach((ag) => {
                          const cached =
                            artistAvatarCache[ag.name] && artistAvatarCache[ag.name] !== 'none'
                              ? artistAvatarCache[ag.name]
                              : undefined;
                          quickPicks.push({
                            id: `qp-art-${ag.name}`,
                            title: ag.name,
                            sub: `Artista · ${plural(ag.count, ' música', ' músicas')}`,
                            img: cached || ag.cover,
                            onClick: () => setPageStack([{ t: 'artist', k: ag.name }]),
                          });
                        });

                        albumGroups.slice(0, 2).forEach((alb) => {
                          if (quickPicks.length >= 6) return;
                          const cached =
                            albumCoverCache[alb.key] && albumCoverCache[alb.key] !== 'none'
                              ? albumCoverCache[alb.key]
                              : undefined;
                          quickPicks.push({
                            id: `qp-alb-${alb.key}`,
                            title: alb.name,
                            sub: alb.artist ? `Álbum · ${alb.artist}` : 'Álbum',
                            img: alb.cover || cached,
                            onClick: () => setPageStack([{ t: 'album', k: alb.key }]),
                          });
                        });

                        if (quickPicks.length < 2) return null;

                        return (
                          <div className="home-sec">
                            <div className="home-sec-hd">
                              <h3 className="home-sec-title">Acesso rápido</h3>
                            </div>
                            <div className="home-qgrid">
                              {quickPicks.slice(0, 6).map((item) => (
                                <div key={item.id} className="home-qcard" onClick={item.onClick}>
                                  <div className="home-qcard-art">
                                    {item.img ? (
                                      <img
                                        src={item.img}
                                        alt=""
                                        onError={(e) => (e.currentTarget.style.display = 'none')}
                                      />
                                    ) : (
                                      <svg className="s" style={{ width: 20, height: 20 }} viewBox="0 0 24 24">
                                        <path d="M9 18V5l12-2v13" />
                                        <circle cx="6" cy="18" r="3" />
                                        <circle cx="18" cy="16" r="3" />
                                      </svg>
                                    )}
                                  </div>
                                  <div className="home-qcard-tx">
                                    <b>{item.title}</b>
                                    <small>{item.sub}</small>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      })()}

                      {/* 3. Mais Tocadas (Most Played Tracks Ranking) */}
                      {(() => {
                        const ranked = tracks
                          .map((t, idx) => ({
                            t,
                            idx,
                            plays: playCounts[t.key] || 0,
                          }))
                          .sort((a, b) => {
                            if (b.plays !== a.plays) return b.plays - a.plays;
                            return a.idx - b.idx;
                          });

                        const topSlice = ranked.slice(0, Math.min(8, ranked.length));
                        const topIndices = topSlice.map((x) => x.idx);

                        return (
                          <div className="home-sec">
                            <div className="home-sec-hd">
                              <h3 className="home-sec-title">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <path d="M12 20V10M18 20V4M6 20v-4" />
                                </svg>
                                <span>Mais tocadas</span>
                              </h3>
                              {topIndices.length > 1 && (
                                <button
                                  type="button"
                                  className="home-sec-link"
                                  onClick={() => playIds(topIndices, false, 'Mais Tocadas')}
                                >
                                  <svg
                                    style={{ width: 13, height: 13 }}
                                    viewBox="0 0 24 24"
                                    fill="currentColor"
                                  >
                                    <path d="M8 5.6v12.8a1 1 0 0 0 1.5.9l10.4-6.4a1 1 0 0 0 0-1.7L9.5 4.7A1 1 0 0 0 8 5.6z" />
                                  </svg>
                                  Tocar top
                                </button>
                              )}
                            </div>

                            <div>
                              {topSlice.map(({ t, idx, plays }, rankIdx) => {
                                const isCur = idx === currentIndex;
                                const coverSrc = t.cover || t.web;
                                const isFav = favoriteKeys.includes(t.key);
                                const rankClass =
                                  rankIdx === 0 ? 'r1' : rankIdx === 1 ? 'r2' : rankIdx === 2 ? 'r3' : '';

                                return (
                                  <li
                                    key={`top-${t.key}-${idx}`}
                                    tabIndex={0}
                                    className={`trk ${isCur ? 'cur' : ''}`}
                                    onClick={() => playFromContext(idx, topIndices, 'Mais Tocadas')}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') playFromContext(idx, topIndices, 'Mais Tocadas');
                                    }}
                                  >
                                    <span className={`rank-num ${rankClass}`}>{rankIdx + 1}</span>
                                    <span className="tth">
                                      {coverSrc ? (
                                        <img
                                          src={coverSrc}
                                          alt=""
                                          onError={(e) => (e.currentTarget.style.display = 'none')}
                                        />
                                      ) : (
                                        <svg className="s" viewBox="0 0 24 24">
                                          <path d="M9 18V5l12-2v13" />
                                          <circle cx="6" cy="18" r="3" />
                                          <circle cx="18" cy="16" r="3" />
                                        </svg>
                                      )}
                                      <i className="eq">
                                        <b></b>
                                        <b></b>
                                        <b></b>
                                      </i>
                                    </span>
                                    <span className="tx">
                                      <b>{t.name || `Faixa ${idx + 1}`}</b>
                                      <small>{[t.artist, t.album].filter(Boolean).join(' · ') || 'Biblioteca'}</small>
                                    </span>
                                    <span className="play-pill" title={`${plays} reproduções`}>
                                      {plays > 0 ? `${plays}x` : 'Nova'}
                                    </span>
                                    <div className="row-actions">
                                      <button
                                        type="button"
                                        className={`qb ${isFav ? 'fav-on' : ''}`}
                                        title={isFav ? 'Remover das Favoritas' : 'Curtir música'}
                                        aria-label="Curtir música"
                                        onClick={(e) => toggleFavorite(t.key, e)}
                                      >
                                        <svg
                                          className="s"
                                          viewBox="0 0 24 24"
                                          fill={isFav ? 'currentColor' : 'none'}
                                          stroke="currentColor"
                                          strokeWidth="2"
                                        >
                                          <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                                        </svg>
                                      </button>
                                      <button
                                        type="button"
                                        className="qb"
                                        title="Mais opções"
                                        aria-label="Mais opções"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setActionMenu({
                                            kind: 'track',
                                            title: t.name || `Faixa ${idx + 1}`,
                                            subtitle: [t.artist, t.album].filter(Boolean).join(' · ') || 'Faixa de áudio',
                                            cover: coverSrc,
                                            trackIndices: [idx],
                                          });
                                        }}
                                      >
                                        <svg className="s" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                                          <circle cx="12" cy="5" r="2" />
                                          <circle cx="12" cy="12" r="2" />
                                          <circle cx="12" cy="19" r="2" />
                                        </svg>
                                      </button>
                                    </div>
                                  </li>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })()}

                      {/* 4. Tocadas Recentemente (Recently Played Carousel) */}
                      {(() => {
                        const keyToIdx = new Map<string, number>();
                        tracks.forEach((t, idx) => keyToIdx.set(t.key, idx));
                        const recentIndices = recentKeys
                          .map((k) => keyToIdx.get(k))
                          .filter((idx): idx is number => idx != null);

                        if (recentIndices.length === 0) return null;

                        return (
                          <div className="home-sec">
                            <div className="home-sec-hd">
                              <h3 className="home-sec-title">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <circle cx="12" cy="12" r="9" />
                                  <path d="M12 7v5l3 2" />
                                </svg>
                                <span>Tocadas recentemente</span>
                              </h3>
                              {recentIndices.length > 1 && (
                                <button
                                  type="button"
                                  className="home-sec-link"
                                  onClick={() => playIds(recentIndices, false, 'Tocadas Recentemente')}
                                >
                                  Ouvir de novo
                                </button>
                              )}
                            </div>
                            <div className="home-hscroll">
                              {recentIndices.slice(0, 12).map((tIdx) => {
                                const t = tracks[tIdx];
                                if (!t) return null;
                                const coverSrc = t.cover || t.web;
                                return (
                                  <div
                                    key={`rec-${t.key}-${tIdx}`}
                                    className="home-hcard"
                                    onClick={() => playFromContext(tIdx, recentIndices, 'Tocadas Recentemente')}
                                  >
                                    <div className="home-hcard-art">
                                      {coverSrc ? (
                                        <img
                                          src={coverSrc}
                                          alt=""
                                          onError={(e) => (e.currentTarget.style.display = 'none')}
                                        />
                                      ) : (
                                        <svg className="s" viewBox="0 0 24 24">
                                          <path d="M9 18V5l12-2v13" />
                                          <circle cx="6" cy="18" r="3" />
                                          <circle cx="18" cy="16" r="3" />
                                        </svg>
                                      )}
                                    </div>
                                    <b>{t.name}</b>
                                    <small>{t.artist || ART_UNK}</small>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })()}

                      {/* 5. Suas Favoritas (Liked Songs) */}
                      {(() => {
                        const favTracks = tracks
                          .map((t, idx) => ({ t, idx }))
                          .filter(({ t }) => favoriteKeys.includes(t.key));

                        if (favTracks.length === 0) return null;
                        const favIndices = favTracks.map((f) => f.idx);

                        return (
                          <div className="home-sec">
                            <div className="home-sec-hd">
                              <h3 className="home-sec-title">
                                <svg
                                  viewBox="0 0 24 24"
                                  fill="currentColor"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                  style={{ color: '#ff5b79' }}
                                >
                                  <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                                </svg>
                                <span>Suas Favoritas ({favTracks.length})</span>
                              </h3>
                              <button
                                type="button"
                                className="home-sec-link"
                                onClick={() => playIds(favIndices, false, 'Suas Favoritas')}
                              >
                                Tocar todas
                              </button>
                            </div>
                            <div>
                              {favTracks.slice(0, 6).map(({ t, idx }) => {
                                const isCur = idx === currentIndex;
                                const coverSrc = t.cover || t.web;
                                return (
                                  <li
                                    key={`fav-${t.key}-${idx}`}
                                    className={`trk ${isCur ? 'cur' : ''}`}
                                    onClick={() => playFromContext(idx, favIndices, 'Suas Favoritas')}
                                  >
                                    <span className="tth">
                                      {coverSrc ? (
                                        <img
                                          src={coverSrc}
                                          alt=""
                                          onError={(e) => (e.currentTarget.style.display = 'none')}
                                        />
                                      ) : (
                                        <svg className="s" viewBox="0 0 24 24">
                                          <path d="M9 18V5l12-2v13" />
                                          <circle cx="6" cy="18" r="3" />
                                          <circle cx="18" cy="16" r="3" />
                                        </svg>
                                      )}
                                      <i className="eq">
                                        <b></b>
                                        <b></b>
                                        <b></b>
                                      </i>
                                    </span>
                                    <span className="tx">
                                      <b>{t.name}</b>
                                      <small>{[t.artist, t.album].filter(Boolean).join(' · ')}</small>
                                    </span>
                                    <div className="row-actions">
                                      <button
                                        type="button"
                                        className="qb fav-on"
                                        title="Remover das Favoritas"
                                        aria-label="Remover das Favoritas"
                                        onClick={(e) => toggleFavorite(t.key, e)}
                                      >
                                        <svg className="s" viewBox="0 0 24 24" fill="currentColor">
                                          <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                                        </svg>
                                      </button>
                                    </div>
                                  </li>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })()}

                      {/* 6. Principais Artistas (Horizontal Carousel) */}
                      {artistGroups.length > 0 && (
                        <div className="home-sec">
                          <div className="home-sec-hd">
                            <h3 className="home-sec-title">
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <circle cx="12" cy="8" r="4" />
                                <path d="M4 20c1.8-3.8 5-6 8-6s6.2 2.2 8 6" />
                              </svg>
                              <span>Seus artistas</span>
                            </h3>
                            <button
                              type="button"
                              className="home-sec-link"
                              onClick={() => setLibraryView('artists')}
                            >
                              Ver todos ({artistGroups.length})
                            </button>
                          </div>
                          <div className="home-hscroll">
                            {artistGroups.slice(0, 12).map((g) => {
                              const cached =
                                artistAvatarCache[g.name] && artistAvatarCache[g.name] !== 'none'
                                  ? artistAvatarCache[g.name]
                                  : undefined;
                              const imgSrc = cached || g.cover;
                              return (
                                <div
                                  key={`hart-${g.name}`}
                                  className="home-hcard artist"
                                  onClick={() => setPageStack([{ t: 'artist', k: g.name }])}
                                >
                                  <div className="home-hcard-art">
                                    {imgSrc ? (
                                      <img
                                        src={imgSrc}
                                        alt=""
                                        onError={(e) => (e.currentTarget.style.display = 'none')}
                                      />
                                    ) : (
                                      <svg className="s" viewBox="0 0 24 24">
                                        <circle cx="12" cy="8" r="4" />
                                        <path d="M4 20c1.8-3.8 5-6 8-6s6.2 2.2 8 6" />
                                      </svg>
                                    )}
                                  </div>
                                  <b>{g.name}</b>
                                  <small>{plural(g.count, ' música', ' músicas')}</small>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {/* 7. Álbuns em Destaque (Horizontal Carousel) */}
                      {albumGroups.length > 0 && (
                        <div className="home-sec">
                          <div className="home-sec-hd">
                            <h3 className="home-sec-title">
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <circle cx="12" cy="12" r="9" />
                                <circle cx="12" cy="12" r="2.5" />
                              </svg>
                              <span>Álbuns da biblioteca</span>
                            </h3>
                            <button
                              type="button"
                              className="home-sec-link"
                              onClick={() => setLibraryView('albums')}
                            >
                              Ver todos ({albumGroups.length})
                            </button>
                          </div>
                          <div className="home-hscroll">
                            {albumGroups.slice(0, 12).map((g) => {
                              const cached =
                                albumCoverCache[g.key] && albumCoverCache[g.key] !== 'none'
                                  ? albumCoverCache[g.key]
                                  : undefined;
                              const imgSrc = g.cover || cached;
                              return (
                                <div
                                  key={`halb-${g.key}`}
                                  className="home-hcard"
                                  onClick={() => setPageStack([{ t: 'album', k: g.key }])}
                                >
                                  <div className="home-hcard-art">
                                    {imgSrc ? (
                                      <img
                                        src={imgSrc}
                                        alt=""
                                        onError={(e) => (e.currentTarget.style.display = 'none')}
                                      />
                                    ) : (
                                      <svg className="s" viewBox="0 0 24 24">
                                        <circle cx="12" cy="12" r="9" />
                                        <circle cx="12" cy="12" r="2.5" />
                                      </svg>
                                    )}
                                  </div>
                                  <b>{g.name}</b>
                                  <small>{g.artist || plural(g.count, ' música', ' músicas')}</small>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {/* 8. Adicionadas Recentemente (Recently Imported Tracks) */}
                      {(() => {
                        const newestIndices = tracks
                          .map((_, i) => i)
                          .reverse()
                          .slice(0, 6);
                        if (newestIndices.length === 0) return null;
                        return (
                          <div className="home-sec">
                            <div className="home-sec-hd">
                              <h3 className="home-sec-title">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <path d="M12 5v14M5 12h14" />
                                </svg>
                                <span>Adicionadas recentemente</span>
                              </h3>
                              <button
                                type="button"
                                className="home-sec-link"
                                onClick={() => setLibraryView('tracks')}
                              >
                                Ver todas
                              </button>
                            </div>
                            <div>
                              {newestIndices.map((idx) => {
                                const t = tracks[idx];
                                if (!t) return null;
                                const isCur = idx === currentIndex;
                                const coverSrc = t.cover || t.web;
                                const isFav = favoriteKeys.includes(t.key);
                                return (
                                  <li
                                    key={`new-${t.key}-${idx}`}
                                    className={`trk ${isCur ? 'cur' : ''}`}
                                    onClick={() => playFromContext(idx, newestIndices, 'Adicionadas Recentemente')}
                                  >
                                    <span className="tth">
                                      {coverSrc ? (
                                        <img
                                          src={coverSrc}
                                          alt=""
                                          onError={(e) => (e.currentTarget.style.display = 'none')}
                                        />
                                      ) : (
                                        <svg className="s" viewBox="0 0 24 24">
                                          <path d="M9 18V5l12-2v13" />
                                          <circle cx="6" cy="18" r="3" />
                                          <circle cx="18" cy="16" r="3" />
                                        </svg>
                                      )}
                                      <i className="eq">
                                        <b></b>
                                        <b></b>
                                        <b></b>
                                      </i>
                                    </span>
                                    <span className="tx">
                                      <b>{t.name}</b>
                                      <small>{[t.artist, t.album].filter(Boolean).join(' · ')}</small>
                                    </span>
                                    <div className="row-actions">
                                      <button
                                        type="button"
                                        className={`qb ${isFav ? 'fav-on' : ''}`}
                                        aria-label="Curtir"
                                        onClick={(e) => toggleFavorite(t.key, e)}
                                      >
                                        <svg
                                          className="s"
                                          viewBox="0 0 24 24"
                                          fill={isFav ? 'currentColor' : 'none'}
                                          stroke="currentColor"
                                          strokeWidth="2"
                                        >
                                          <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                                        </svg>
                                      </button>
                                    </div>
                                  </li>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })()}
                    </>
                  )}
                </div>
              ) : libraryView === 'tracks' ? (
                <>
                  <li className="tcount">{plural(tracks.length, ' faixa', ' faixas')}</li>
                  {tracks.map((t, n) => {
                    const isCur = n === currentIndex;
                    const coverSrc = t.cover || t.web;
                    return (
                      <li
                        key={t.id != null ? `track-${t.id}` : `${t.key}-${n}`}
                        tabIndex={0}
                        className={`trk ${isCur ? 'cur' : ''}`}
                        onClick={() => {
                          const allIndices = tracks.map((_, i) => i);
                          playFromContext(n, allIndices, 'Biblioteca');
                          setIsLibraryOpen(false);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            const allIndices = tracks.map((_, i) => i);
                            playFromContext(n, allIndices, 'Biblioteca');
                            setIsLibraryOpen(false);
                          }
                        }}
                      >
                        <span className="tth">
                          {coverSrc ? (
                            <img src={coverSrc} alt="" onError={(e) => (e.currentTarget.style.display = 'none')} />
                          ) : (
                            <svg className="s" viewBox="0 0 24 24">
                              <path d="M9 18V5l12-2v13" />
                              <circle cx="6" cy="18" r="3" />
                              <circle cx="18" cy="16" r="3" />
                            </svg>
                          )}
                          <i className="eq">
                            <b></b>
                            <b></b>
                            <b></b>
                          </i>
                        </span>
                        <span className="tx">
                          <b>{t.name || `Faixa ${n + 1}`}</b>
                          <small>{[t.artist, t.album].filter(Boolean).join(' · ') || `Faixa ${n + 1}`}</small>
                        </span>
                        <span className="td">{t.dur || ''}</span>
                        <div className="row-actions">
                          <button
                            type="button"
                            className="qb"
                            title="Tocar a seguir"
                            aria-label="Tocar a seguir"
                            onClick={(e) => playNext(n, e)}
                          >
                            <svg className="s" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="m5 4 10 8-10 8V4zM19 5v14" />
                            </svg>
                          </button>
                          <button
                            type="button"
                            className="qb"
                            title="Adicionar à fila"
                            aria-label="Adicionar à fila"
                            onClick={(e) => addToQueue(n, e)}
                          >
                            <svg className="s" viewBox="0 0 24 24">
                              <path d="M12 5v14M5 12h14" />
                            </svg>
                          </button>
                          <button
                            type="button"
                            className="qb"
                            title="Opções da música"
                            aria-label="Opções da música"
                            onClick={(e) => {
                              e.stopPropagation();
                              setActionMenu({
                                kind: 'track',
                                title: t.name || `Faixa ${n + 1}`,
                                subtitle: [t.artist, t.album].filter(Boolean).join(' · ') || 'Música na biblioteca',
                                cover: coverSrc,
                                trackIndices: [n],
                                artistKey: t.artist ? artKey(t) : undefined,
                                albumKey: t.album ? albKey(t) : undefined,
                              });
                            }}
                          >
                            <svg viewBox="0 0 24 24" fill="currentColor">
                              <circle cx="12" cy="5" r="2" />
                              <circle cx="12" cy="12" r="2" />
                              <circle cx="12" cy="19" r="2" />
                            </svg>
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </>
              ) : libraryView === 'artists' ? (
                <li className="ahost">
                  <input
                    type="search"
                    className="psearch"
                    placeholder="Buscar artista"
                    aria-label="Buscar artista"
                    value={artSearchQuery}
                    onChange={(e) => setArtSearchQuery(e.target.value)}
                  />
                  <div className="psub acount">
                    {plural(artistGroups.length, ' artista', ' artistas')}
                  </div>
                  <div className="pgrid3">
                    {artistGroups
                      .filter((g) => String(g.name || '').toLowerCase().includes(artSearchQuery.trim().toLowerCase()))
                      .map((g, gIdx) => {
                        const hasOnlineAvatar =
                          artistAvatarCache[g.name] && artistAvatarCache[g.name] !== 'none';
                        const avatar = hasOnlineAvatar ? artistAvatarCache[g.name] : g.cover;
                        return (
                          <div
                            key={`art-${g.name}-${gIdx}`}
                            className="pcard"
                            tabIndex={0}
                            style={{ textAlign: 'center' }}
                            onClick={() => setPageStack([{ t: 'artist', k: g.name }])}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') setPageStack([{ t: 'artist', k: g.name }]);
                            }}
                          >
                            {avatar ? (
                              <img
                                src={avatar}
                                className="cimg round"
                                alt=""
                                onError={(e) => {
                                  if (g.cover && e.currentTarget.src !== g.cover) {
                                    e.currentTarget.src = g.cover;
                                  }
                                }}
                              />
                            ) : (
                              <div className="cimg round pph">
                                <svg className="s" viewBox="0 0 24 24">
                                  <path d="M9 18V5l12-2v13" />
                                  <circle cx="6" cy="18" r="3" />
                                  <circle cx="18" cy="16" r="3" />
                                </svg>
                              </div>
                            )}
                            <b>{g.name}</b>
                            <small>{plural(g.count, ' música', ' músicas')}</small>
                          </div>
                        );
                      })}
                  </div>
                </li>
              ) : (
                /* Albums Tab */
                albumGroups.map((g, gIdx) => {
                  const hasOnlineCover = albumCoverCache[g.key] && albumCoverCache[g.key] !== 'none';
                  const cover = g.cover || (hasOnlineCover ? albumCoverCache[g.key] : undefined);

                  return (
                    <li
                      key={`alb-${g.key}-${gIdx}`}
                      tabIndex={0}
                      className="grp"
                      onClick={() => setPageStack([{ t: 'album', k: g.key }])}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') setPageStack([{ t: 'album', k: g.key }]);
                      }}
                    >
                      {cover ? (
                        <img className="th" src={cover} alt="" onError={(e) => (e.currentTarget.style.display = 'none')} />
                      ) : (
                        <div className="th" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <svg className="s" style={{ width: 24, height: 24 }} viewBox="0 0 24 24">
                            <path d="M9 18V5l12-2v13" />
                            <circle cx="6" cy="18" r="3" />
                            <circle cx="18" cy="16" r="3" />
                          </svg>
                        </div>
                      )}
                      <span className="tx">
                        <b>{g.name}</b>
                        <small>{(g.artist ? `${g.artist} – ` : '') + plural(g.count, ' faixa', ' faixas')}</small>
                      </span>
                      <div className="row-actions">
                        <button
                          type="button"
                          className="qb"
                          title="Adicionar tudo à fila"
                          aria-label="Adicionar tudo à fila"
                          onClick={(e) => addAllToQueue(g.trackIndices, e)}
                        >
                          <svg className="s" viewBox="0 0 24 24">
                            <path d="M3 6h12M3 12h12M3 18h8M18 14v6M15 17h6" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          className="qb"
                          title={`Opções para ${g.name}`}
                          aria-label={`Opções para ${g.name}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setActionMenu({
                              kind: 'album',
                              title: g.name,
                              subtitle: (g.artist ? `${g.artist} · ` : '') + plural(g.count, ' faixa', ' faixas'),
                              cover,
                              trackIndices: g.trackIndices,
                              artistKey: g.artist || undefined,
                              albumKey: g.key,
                            });
                          }}
                        >
                          <svg viewBox="0 0 24 24" fill="currentColor">
                            <circle cx="12" cy="5" r="2" />
                            <circle cx="12" cy="12" r="2" />
                            <circle cx="12" cy="19" r="2" />
                          </svg>
                        </button>
                      </div>
                    </li>
                  );
                })
              )}
            </ul>

            {/* Detailed Artist / Album Page Overlay */}
            <section id="page" aria-label="Página" className={pageStack.length > 0 ? 'on' : ''}>
              {(() => {
                const onlineHeroImg =
                  activePageInfo?.img ||
                  (activePage &&
                  activePage.t === 'artist' &&
                  artistAvatarCache[activePage.k] &&
                  artistAvatarCache[activePage.k] !== 'none'
                    ? artistAvatarCache[activePage.k]
                    : undefined) ||
                  (pageTrackIndices.length ? tracks[pageTrackIndices[0]].cover : undefined);
                return (
                  <>
                    <div
                      id="pbg"
                      style={{
                        backgroundImage: onlineHeroImg ? `url('${onlineHeroImg}')` : 'none',
                        opacity: onlineHeroImg ? 0.5 : 0,
                      }}
                    ></div>
                    <div id="pscroll">
                      <div className="phd">
                        <button
                          className="ib"
                          id="pback"
                          aria-label="Voltar"
                          onClick={() => setPageStack((prev) => prev.slice(0, -1))}
                        >
                          <svg className="s" viewBox="0 0 24 24">
                            <path d="M15 5l-7 7 7 7" />
                          </svg>
                        </button>
                        {activePage && (
                          <button
                            type="button"
                            className="ib"
                            title={activePage.t === 'artist' ? 'Opções do artista' : 'Opções do álbum'}
                            aria-label={activePage.t === 'artist' ? 'Opções do artista' : 'Opções do álbum'}
                            onClick={() => {
                              const isArt = activePage.t === 'artist';
                              const title = isArt ? activePage.k : activePage.k.split('||')[0];
                              setActionMenu({
                                kind: isArt ? 'artist' : 'album',
                                title,
                                subtitle: plural(pageTrackIndices.length, ' música', ' músicas'),
                                cover: onlineHeroImg,
                                trackIndices: pageTrackIndices,
                                artistKey: isArt ? activePage.k : activePage.k.split('||')[1] || undefined,
                                albumKey: !isArt ? activePage.k : undefined,
                              });
                            }}
                          >
                            <svg viewBox="0 0 24 24" fill="currentColor">
                              <circle cx="12" cy="5" r="2" />
                              <circle cx="12" cy="12" r="2" />
                              <circle cx="12" cy="19" r="2" />
                            </svg>
                          </button>
                        )}
                      </div>

                      {activePage && (
                        <>
                          <div id="phero">
                            {onlineHeroImg ? (
                              <img
                                src={onlineHeroImg}
                                className={`pimg ${activePage.t === 'artist' ? 'round' : ''}`}
                                alt=""
                              />
                            ) : (
                              <div className={`pimg pph ${activePage.t === 'artist' ? 'round' : ''}`}>
                                <svg className="s" viewBox="0 0 24 24">
                                  <path d="M9 18V5l12-2v13" />
                                  <circle cx="6" cy="18" r="3" />
                                  <circle cx="18" cy="16" r="3" />
                                </svg>
                              </div>
                            )}
                      <h2 className="pname">
                        {activePage.t === 'artist' ? activePage.k : activePage.k.split('||')[0]}
                      </h2>
                      <div className="psub">
                        {activePage.t === 'artist' ? (
                          <>
                            {plural(
                              new Set(pageTrackIndices.map((n) => albKey(tracks[n]))).size,
                              ' álbum',
                              ' álbuns'
                            )}
                            {', '}
                            {plural(pageTrackIndices.length, ' música', ' músicas')}
                          </>
                        ) : (
                          <>
                            <button
                              className="plink"
                              onClick={() => {
                                const ar = activePage.k.split('||')[1] || ART_UNK;
                                setPageStack((prev) => [...prev, { t: 'artist', k: ar }]);
                              }}
                            >
                              {activePage.k.split('||')[1] || ART_UNK}
                            </button>
                            {' – '}
                            {plural(pageTrackIndices.length, ' música', ' músicas')}
                          </>
                        )}
                      </div>
                    </div>

                    <div id="pact">
                      <button
                        className="ib"
                        title="Aleatório"
                        aria-label="Tocar em ordem aleatória"
                        onClick={() => playIds(pageTrackIndices, true)}
                      >
                        <svg className="s" viewBox="0 0 24 24">
                          <path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        className="ib"
                        title="Tocar tudo a seguir"
                        aria-label="Tocar tudo a seguir"
                        onClick={(e) => playNextAll(pageTrackIndices, e)}
                      >
                        <svg className="s" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="m5 4 10 8-10 8V4zM19 5v14" />
                        </svg>
                      </button>
                      <button
                        className="ib"
                        title="Adicionar tudo à fila"
                        aria-label="Adicionar tudo à fila"
                        onClick={(e) => addAllToQueue(pageTrackIndices, e)}
                      >
                        <svg className="s" viewBox="0 0 24 24">
                          <path d="M3 6h12M3 12h12M3 18h8M18 14v6M15 17h6" />
                        </svg>
                      </button>
                      <span className="sp"></span>
                      <button
                        className="ib big"
                        aria-label="Tocar"
                        onClick={() => playIds(pageTrackIndices, false)}
                      >
                        <svg viewBox="0 0 24 24" fill="currentColor">
                          <path d="M8 5.6v12.8a1 1 0 0 0 1.5.9l10.4-6.4a1 1 0 0 0 0-1.7L9.5 4.7A1 1 0 0 0 8 5.6z" />
                        </svg>
                      </button>
                    </div>

                    <div id="pbody">
                      {/* Online Info Section */}
                      <div className="pinfo">
                        {activePageInfoLoading ? (
                          <div className="psrc">Buscando informações…</div>
                        ) : activePageInfo && !activePageInfo.none && !activePageInfo.fail ? (
                          <>
                            <h3 className="pst">
                              {activePage.t === 'artist' ? 'Sobre o artista' : 'Sobre o álbum'}
                            </h3>
                            <div className="pmeta">
                              {activePage.t === 'artist' ? (
                                <>
                                  {activePageInfo.genre && <span className="pchip">{activePageInfo.genre}</span>}
                                  {activePageInfo.country && <span className="pchip">{activePageInfo.country}</span>}
                                  {activePageInfo.year && (
                                    <span className="pchip">Desde {activePageInfo.year}</span>
                                  )}
                                </>
                              ) : (
                                <>
                                  {activePageInfo.year && <span className="pchip">{activePageInfo.year}</span>}
                                  {activePageInfo.genre && <span className="pchip">{activePageInfo.genre}</span>}
                                  {activePageInfo.label && <span className="pchip">{activePageInfo.label}</span>}
                                  {activePageInfo.tracks && (
                                    <span className="pchip">{plural(+activePageInfo.tracks, ' faixa', ' faixas')}</span>
                                  )}
                                </>
                              )}
                            </div>
                            {activePageInfo.bio && (
                              <>
                                <p className={`pbio ${bioClamped ? 'clamp' : ''}`}>{activePageInfo.bio}</p>
                                {activePageInfo.bio.length > 380 && (
                                  <button className="plnk" onClick={() => setBioClamped(!bioClamped)}>
                                    {bioClamped ? 'Ler mais' : 'Ler menos'}
                                  </button>
                                )}
                              </>
                            )}
                            <div className="psrc">
                              {activePageInfo.srcs && activePageInfo.srcs.length > 0 && (
                                <>
                                  Fonte:{' '}
                                  {activePageInfo.srcs.map((srcName, sIdx) => (
                                    <React.Fragment key={srcName}>
                                      {sIdx > 0 && ', '}
                                      {activePageInfo?.url && /wikip/i.test(srcName) ? (
                                        <a href={activePageInfo.url} target="_blank" rel="noopener noreferrer">
                                          {srcName}
                                        </a>
                                      ) : (
                                        srcName
                                      )}
                                    </React.Fragment>
                                  ))}
                                </>
                              )}
                              <button
                                onClick={() => {
                                  const isA = activePage.t === 'artist';
                                  iDrop(
                                    isA ? 'artist' : 'album',
                                    isA ? activePage.k : activePage.k.split('||')[1],
                                    isA ? undefined : activePage.k.split('||')[0]
                                  );
                                  setActivePageInfoLoading(true);
                                  iLoad(
                                    isA ? 'artist' : 'album',
                                    isA ? activePage.k : activePage.k.split('||')[1],
                                    isA ? undefined : activePage.k.split('||')[0]
                                  ).then((info) => {
                                    setActivePageInfo(info);
                                    setActivePageInfoLoading(false);
                                  });
                                }}
                              >
                                Atualizar
                              </button>
                            </div>
                          </>
                        ) : null}
                      </div>

                      {/* If Artist Page: Show their albums first */}
                      {activePage.t === 'artist' && (
                        <>
                          <h3 className="pst">Álbuns</h3>
                          <div className="pgrid">
                            {(() => {
                              const albMap = new Map<
                                string,
                                { key: string; name: string; count: number; cover?: string; trackIndices: number[] }
                              >();
                              pageTrackIndices.forEach((n) => {
                                const t = tracks[n];
                                const k = albKey(t);
                                const normK = `${nrm(t.album || ALB_UNK)}||${nrm(artKey(t))}`;
                                const cachedCover =
                                  albumCoverCache[k] && albumCoverCache[k] !== 'none'
                                    ? albumCoverCache[k]
                                    : undefined;
                                const g = albMap.get(normK) || {
                                  key: k,
                                  name: (t.album || ALB_UNK).trim(),
                                  count: 0,
                                  cover: t.cover || t.web || cachedCover || undefined,
                                  trackIndices: [],
                                };
                                if (!g.cover && (t.cover || t.web || cachedCover)) {
                                  g.cover = t.cover || t.web || cachedCover || undefined;
                                }
                                g.count++;
                                g.trackIndices.push(n);
                                albMap.set(normK, g);
                              });
                              return Array.from(albMap.values()).map((g, gIdx) => (
                                <div
                                  key={`page-alb-${g.key}-${gIdx}`}
                                  className="pcard"
                                  tabIndex={0}
                                  onClick={() => setPageStack((prev) => [...prev, { t: 'album', k: g.key }])}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') setPageStack((prev) => [...prev, { t: 'album', k: g.key }]);
                                  }}
                                >
                                  {g.cover ? (
                                    <img className="cimg" src={g.cover} alt="" />
                                  ) : (
                                    <div className="cimg pph">
                                      <svg className="s" viewBox="0 0 24 24">
                                        <path d="M9 18V5l12-2v13" />
                                        <circle cx="6" cy="18" r="3" />
                                        <circle cx="18" cy="16" r="3" />
                                      </svg>
                                    </div>
                                  )}
                                  <b>{g.name}</b>
                                  <small>{plural(g.count, ' faixa', ' faixas')}</small>
                                </div>
                              ));
                            })()}
                          </div>
                          <h3 className="pst">Músicas</h3>
                        </>
                      )}

                      {/* Track list for page */}
                      <ul className="ptl">
                        {pageTrackIndices.map((n, j) => {
                          const t = tracks[n];
                          const isCur = n === currentIndex;
                          const isAlbum = activePage.t === 'album';
                          const contextName =
                            activePage.t === 'artist'
                              ? `Artista: ${activePage.k}`
                              : `Álbum: ${activePage.k.split('||')[0] || ''}`;
                          return (
                            <li
                              key={`page-trk-${t.id != null ? t.id : t.key}-${n}-${j}`}
                              tabIndex={0}
                              className={`prow ${isCur ? 'cur' : ''}`}
                              onClick={() => playFromContext(n, pageTrackIndices, contextName)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') playFromContext(n, pageTrackIndices, contextName);
                              }}
                            >
                              {isAlbum ? (
                                <span className="pn">{j + 1}</span>
                              ) : t.cover || t.web ? (
                                <img className="th" src={t.cover || t.web!} alt="" />
                              ) : (
                                <div className="th" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                  <svg className="s" style={{ width: 20, height: 20 }} viewBox="0 0 24 24">
                                    <path d="M9 18V5l12-2v13" />
                                    <circle cx="6" cy="18" r="3" />
                                    <circle cx="18" cy="16" r="3" />
                                  </svg>
                                </div>
                              )}
                              <span className="tx">
                                <b>{t.name}</b>
                                <small>{isAlbum ? t.artist || '' : t.album || ''}</small>
                              </span>
                              <div className="row-actions">
                                <button
                                  type="button"
                                  className="qb"
                                  title="Tocar a seguir"
                                  aria-label="Tocar a seguir"
                                  onClick={(e) => playNext(n, e)}
                                >
                                  <svg className="s" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <path d="m5 4 10 8-10 8V4zM19 5v14" />
                                  </svg>
                                </button>
                                <button
                                  type="button"
                                  className="qb"
                                  title="Adicionar à fila"
                                  aria-label="Adicionar à fila"
                                  onClick={(e) => addToQueue(n, e)}
                                >
                                  <svg className="s" viewBox="0 0 24 24">
                                    <path d="M12 5v14M5 12h14" />
                                  </svg>
                                </button>
                                <button
                                  type="button"
                                  className="qb"
                                  title="Opções da música"
                                  aria-label="Opções da música"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setActionMenu({
                                      kind: 'track',
                                      title: t.name,
                                      subtitle: [t.artist, t.album].filter(Boolean).join(' · '),
                                      cover: t.cover || t.web,
                                      trackIndices: [n],
                                      artistKey: t.artist ? artKey(t) : undefined,
                                      albumKey: t.album ? albKey(t) : undefined,
                                    });
                                  }}
                                >
                                  <svg viewBox="0 0 24 24" fill="currentColor">
                                    <circle cx="12" cy="5" r="2" />
                                    <circle cx="12" cy="12" r="2" />
                                    <circle cx="12" cy="19" r="2" />
                                  </svg>
                                </button>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  </>
                )}
              </div>
            </>
          );
        })()}
      </section>
          </div>

          {/* Mini Player inside Library bottom */}
          {currentTrack && (
            <div
              id="mini"
              role="button"
              tabIndex={0}
              aria-label="Voltar ao player"
              style={{ display: 'flex' }}
              onClick={() => setIsLibraryOpen(false)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') setIsLibraryOpen(false);
              }}
            >
              <img
                id="mimg"
                src={currentCoverUrl || undefined}
                alt=""
                style={{ visibility: currentCoverUrl ? 'visible' : 'hidden' }}
              />
              <span className="tx">
                <b id="mt">{currentTrack.name}</b>
                <small id="ma">{currentTrack.artist || ''}</small>
              </span>
              <button
                className={`ib ${isPlaying ? 'playing' : ''}`}
                id="mplay"
                aria-label="Tocar ou pausar"
                onClick={(e) => {
                  e.stopPropagation();
                  if (audioRef.current) {
                    if (audioRef.current.paused) audioRef.current.play().catch(() => {});
                    else audioRef.current.pause();
                  }
                }}
              >
                <svg className="pl" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M8 5.6v12.8a1 1 0 0 0 1.5.9l10.4-6.4a1 1 0 0 0 0-1.7L9.5 4.7A1 1 0 0 0 8 5.6z" />
                </svg>
                <svg className="pa" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="6" y="5" width="4.5" height="14" rx="1.5" />
                  <rect x="13.5" y="5" width="4.5" height="14" rx="1.5" />
                </svg>
              </button>
            </div>
          )}
        </section>

        {/* Lyrics Bottom Sheet */}
        <section id="lsheet" aria-label="Letra" className={isLyricsOpen ? 'on' : ''}>
          <header>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1 }}>
              <span id="ltitle">{currentTrack ? currentTrack.name : 'Letra'}</span>
            </div>
            <button
              className="ib"
              id="closeLyr"
              aria-label="Fechar"
              onClick={() => setIsLyricsOpen(false)}
            >
              <svg className="s" viewBox="0 0 24 24">
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          </header>

          {/* Translation Mode Segmented Toolbar */}
          {(lyricsSynced.length > 0 || lyricsPlain) && !lyricsLoading && !lyricsError && (
            <div id="lyr-bar">
              <div className="lyr-modes" role="tablist" aria-label="Modo da letra">
                <button
                  className={lyricsMode === 'original' ? 'on' : ''}
                  onClick={() => setLyricsMode('original')}
                >
                  Original
                </button>
                <button
                  className={lyricsMode === 'translated' ? 'on' : ''}
                  onClick={() => handleSelectLyricsMode('translated')}
                  title="Ver letra traduzida para português"
                >
                  {isTranslating && lyricsMode === 'translated' ? 'Traduzindo…' : 'Tradução'}
                </button>
                <button
                  className={lyricsMode === 'bilingual' ? 'on' : ''}
                  onClick={() => handleSelectLyricsMode('bilingual')}
                  title="Ver letra original e tradução juntas"
                >
                  {isTranslating && lyricsMode === 'bilingual' ? 'Traduzindo…' : 'Bilingue'}
                </button>
              </div>
            </div>
          )}

          <div id="lbody" ref={lyricsContainerRef}>
            {lyricsLoading ? (
              <div className="lm">Buscando letra…</div>
            ) : lyricsError ? (
              <div className="lm">
                {lyricsError}
                <button
                  onClick={() => {
                    if (currentTrack) {
                      try {
                        localStorage.removeItem(LK + keyOf(currentTrack));
                      } catch {
                        // continue
                      }
                      loadLyricsForTrack(currentTrack, duration);
                    }
                  }}
                >
                  Buscar de novo
                </button>
              </div>
            ) : isTranslating ? (
              <div className="lm">
                <div style={{ marginBottom: 10, fontWeight: 600 }}>Traduzindo letra para português…</div>
                <div style={{ fontSize: '0.85rem', opacity: 0.7 }}>Sincronizando linhas</div>
              </div>
            ) : translateError && lyricsMode !== 'original' ? (
              <div className="lm">
                {translateError}
                <button
                  onClick={() => {
                    if (currentTrack) {
                      fetchLyricsTranslation(currentTrack, lyricsSynced, lyricsPlain);
                    }
                  }}
                >
                  Tentar traduzir novamente
                </button>
              </div>
            ) : lyricsSynced.length > 0 ? (
              lyricsSynced.map((l, idx) => {
                const trans = translatedLines[idx] || '';
                const isCur = idx === activeLyricIndex;
                return (
                  <p
                    key={`${l.t}-${idx}`}
                    className={`ll ${isCur ? 'on' : ''} ${lyricsMode === 'bilingual' ? 'bi' : ''}`}
                    onClick={() => {
                      if (audioRef.current) {
                        audioRef.current.currentTime = l.t;
                      }
                    }}
                  >
                    {lyricsMode === 'translated' ? (
                      trans || l.txt || '♪'
                    ) : lyricsMode === 'bilingual' ? (
                      <>
                        <span className="orig">{l.txt || '♪'}</span>
                        {trans && <span className="trans">{trans}</span>}
                      </>
                    ) : (
                      l.txt || '♪'
                    )}
                  </p>
                );
              })
            ) : lyricsPlain ? (
              lyricsMode === 'translated' && translatedPlain ? (
                translatedPlain.split('\n').map((line, pIdx) => (
                  <p key={pIdx} className="lp">
                    {line || '\u00a0'}
                  </p>
                ))
              ) : lyricsMode === 'bilingual' && translatedPlain ? (
                (() => {
                  const origLines = lyricsPlain.split('\n');
                  const transLines = translatedPlain.split('\n');
                  return origLines.map((line, pIdx) => (
                    <div key={pIdx} className="lp-duo">
                      <p className="lp orig">{line || '\u00a0'}</p>
                      {transLines[pIdx] && <p className="lp trans">{transLines[pIdx]}</p>}
                    </div>
                  ));
                })()
              ) : (
                lyricsPlain.split('\n').map((line, pIdx) => (
                  <p key={pIdx} className="lp">
                    {line || '\u00a0'}
                  </p>
                ))
              )
            ) : (
              <div className="lm">Nenhuma letra disponível para esta faixa.</div>
            )}
          </div>
        </section>

        {/* Interactive First-Time Onboarding Tour */}
        {isTourOpen && tourSteps[tourStep] && (
          <div className="tour-layer" role="dialog" aria-modal="true" aria-label="Tour pelo aplicativo">
            {spotlightRect ? (
              <div
                className="tour-spotlight"
                style={{
                  top: spotlightRect.top,
                  left: spotlightRect.left,
                  width: spotlightRect.width,
                  height: spotlightRect.height,
                  borderRadius: spotlightRect.radius,
                }}
              />
            ) : (
              <div className="tour-backdrop" onClick={finishTour} />
            )}

            <div className={`tour-card pos-${tourSteps[tourStep].pos}`}>
              <div className="tour-head">
                <span className="tour-badge">
                  Passo {tourStep + 1} de {tourSteps.length}
                </span>
                <button type="button" className="tour-skip" onClick={finishTour}>
                  Pular tour
                </button>
              </div>

              <div className="tour-icon-wrap">{tourSteps[tourStep].icon}</div>

              <h2 className="tour-title">{tourSteps[tourStep].title}</h2>
              <p className="tour-desc">{tourSteps[tourStep].desc}</p>

              {tourSteps[tourStep].showDemoBtn && tracks.length === 0 && (
                <button
                  type="button"
                  className="tour-demo-cta"
                  onClick={() => {
                    loadDemoTracks();
                  }}
                >
                  <svg className="s" style={{ width: 16, height: 16 }} viewBox="0 0 24 24">
                    <path d="M9 18V5l12-2v13" />
                    <circle cx="6" cy="18" r="3" />
                    <circle cx="18" cy="16" r="3" />
                  </svg>
                  Carregar 3 músicas de demonstração agora
                </button>
              )}

              <div className="tour-foot">
                <div className="tour-dots" aria-hidden="true">
                  {tourSteps.map((_, idx) => (
                    <span key={idx} className={`tour-dot ${idx === tourStep ? 'on' : ''}`} />
                  ))}
                </div>

                <div className="tour-nav">
                  {tourStep > 0 && (
                    <button
                      type="button"
                      className="tour-btn"
                      onClick={() => setTourStep((s) => Math.max(0, s - 1))}
                    >
                      Anterior
                    </button>
                  )}
                  {tourStep < tourSteps.length - 1 ? (
                    <button
                      type="button"
                      className="tour-btn primary"
                      onClick={() => setTourStep((s) => Math.min(tourSteps.length - 1, s + 1))}
                    >
                      Próximo
                    </button>
                  ) : (
                    <button type="button" className="tour-btn primary" onClick={finishTour}>
                      Começar a usar
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Import / Add Music Options Bottom Sheet (Files vs Folder & Subfolders) */}
        {isImportMenuOpen && (
          <div className="ctx-layer" role="dialog" aria-modal="true" aria-label="Adicionar músicas">
            <div className="ctx-scrim" onClick={() => setIsImportMenuOpen(false)} />
            <div className="ctx-sheet">
              <span className="grip" />
              <div className="ctx-head">
                <div className="ctx-thumb">
                  <svg className="s" viewBox="0 0 24 24">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                </div>
                <div className="ctx-meta">
                  <b>Adicionar à biblioteca</b>
                  <small>Escolha como deseja importar suas músicas</small>
                </div>
              </div>

              <div className="ctx-list">
                <button
                  type="button"
                  className="ctx-item"
                  onClick={() => {
                    setIsImportMenuOpen(false);
                    fileInputRef.current?.click();
                  }}
                >
                  <svg className="s" viewBox="0 0 24 24">
                    <path d="M9 18V5l12-2v13" />
                    <circle cx="6" cy="18" r="3" />
                    <circle cx="18" cy="16" r="3" />
                  </svg>
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <span>Selecionar arquivos de áudio</span>
                    <small style={{ fontSize: '0.76rem', color: 'var(--muted)', fontWeight: 400 }}>
                      Escolha uma ou várias músicas (MP3, FLAC, M4A, WAV, OGG)
                    </small>
                  </div>
                </button>

                <button
                  type="button"
                  className="ctx-item"
                  onClick={handlePickFolder}
                >
                  <svg className="s" viewBox="0 0 24 24">
                    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
                  </svg>
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <span>Importar pasta e subpastas</span>
                    <small style={{ fontSize: '0.76rem', color: 'var(--muted)', fontWeight: 400 }}>
                      Busca automaticamente todas as músicas dentro da pasta escolhida
                    </small>
                  </div>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Item Options Menu Bottom Sheet (Track, Album, or Artist) */}
        {actionMenu && (
          <div className="ctx-layer" role="dialog" aria-modal="true" aria-label={`Opções para ${actionMenu.title}`}>
            <div className="ctx-scrim" onClick={() => setActionMenu(null)} />
            <div className="ctx-sheet">
              <span className="grip" />
              <div className="ctx-head">
                {actionMenu.cover ? (
                  <img
                    src={actionMenu.cover}
                    className={`ctx-thumb ${actionMenu.kind === 'artist' ? 'round' : ''}`}
                    alt=""
                  />
                ) : (
                  <div className={`ctx-thumb ${actionMenu.kind === 'artist' ? 'round' : ''}`}>
                    <svg className="s" viewBox="0 0 24 24">
                      <path d="M9 18V5l12-2v13" />
                      <circle cx="6" cy="18" r="3" />
                      <circle cx="18" cy="16" r="3" />
                    </svg>
                  </div>
                )}
                <div className="ctx-meta">
                  <b>{actionMenu.title}</b>
                  <small>{actionMenu.subtitle}</small>
                </div>
              </div>

              <div className="ctx-list">
                <button
                  type="button"
                  className="ctx-item"
                  onClick={() => {
                    const label =
                      actionMenu.kind === 'artist'
                        ? `Artista: ${actionMenu.title}`
                        : actionMenu.kind === 'album'
                          ? `Álbum: ${actionMenu.title}`
                          : 'Biblioteca';
                    playIds(actionMenu.trackIndices, false, label);
                    setActionMenu(null);
                  }}
                >
                  <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M8 5.6v12.8a1 1 0 0 0 1.5.9l10.4-6.4a1 1 0 0 0 0-1.7L9.5 4.7A1 1 0 0 0 8 5.6z" />
                  </svg>
                  <span>{actionMenu.kind === 'track' ? 'Tocar agora' : 'Tocar tudo agora'}</span>
                </button>

                <button
                  type="button"
                  className="ctx-item"
                  onClick={() => {
                    if (actionMenu.trackIndices.length === 1) {
                      playNext(actionMenu.trackIndices[0]);
                    } else {
                      playNextAll(actionMenu.trackIndices);
                    }
                    setActionMenu(null);
                  }}
                >
                  <svg className="s" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="m5 4 10 8-10 8V4zM19 5v14" />
                  </svg>
                  <span>Tocar a seguir</span>
                </button>

                <button
                  type="button"
                  className="ctx-item"
                  onClick={() => {
                    if (actionMenu.trackIndices.length === 1) {
                      addToQueue(actionMenu.trackIndices[0]);
                    } else {
                      addAllToQueue(actionMenu.trackIndices);
                    }
                    setActionMenu(null);
                  }}
                >
                  <svg className="s" viewBox="0 0 24 24">
                    <path d="M3 6h12M3 12h12M3 18h8M18 14v6M15 17h6" />
                  </svg>
                  <span>Adicionar à fila</span>
                </button>

                {actionMenu.kind !== 'artist' && actionMenu.artistKey && actionMenu.artistKey !== ART_UNK && (
                  <button
                    type="button"
                    className="ctx-item"
                    onClick={() => {
                      const k = actionMenu.artistKey!;
                      setActionMenu(null);
                      setIsLibraryOpen(true);
                      setPageStack((prev) => [...prev, { t: 'artist', k }]);
                    }}
                  >
                    <svg className="s" viewBox="0 0 24 24">
                      <circle cx="12" cy="8" r="4" />
                      <path d="M4 20c1.5-4 5-6 8-6s6.5 2 8 6" />
                    </svg>
                    <span>Ir para o artista ({actionMenu.artistKey})</span>
                  </button>
                )}

                {actionMenu.kind === 'track' && actionMenu.albumKey && !actionMenu.albumKey.startsWith(ALB_UNK) && (
                  <button
                    type="button"
                    className="ctx-item"
                    onClick={() => {
                      const k = actionMenu.albumKey!;
                      setActionMenu(null);
                      setIsLibraryOpen(true);
                      setPageStack((prev) => [...prev, { t: 'album', k }]);
                    }}
                  >
                    <svg className="s" viewBox="0 0 24 24">
                      <circle cx="12" cy="12" r="9" />
                      <circle cx="12" cy="12" r="2.5" />
                    </svg>
                    <span>Ir para o álbum ({actionMenu.albumKey.split('||')[0]})</span>
                  </button>
                )}

                <button
                  type="button"
                  className="ctx-item danger"
                  onClick={() => {
                    const target = {
                      kind: actionMenu.kind,
                      title: actionMenu.title,
                      trackIndices: actionMenu.trackIndices,
                    };
                    setActionMenu(null);
                    setConfirmRemove(target);
                  }}
                >
                  <svg className="s" viewBox="0 0 24 24">
                    <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6" />
                  </svg>
                  <span>
                    {actionMenu.kind === 'artist'
                      ? `Remover artista da biblioteca (${plural(actionMenu.trackIndices.length, ' música', ' músicas')})`
                      : actionMenu.kind === 'album'
                        ? `Remover álbum da biblioteca (${plural(actionMenu.trackIndices.length, ' música', ' músicas')})`
                        : 'Remover música da biblioteca'}
                  </span>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Settings Full Sheet (#ssheet) */}
        <section id="ssheet" aria-label="Configurações" className={isSettingsOpen ? 'on' : ''}>
          <header>
            <span>Configurações</span>
            <button
              type="button"
              className="ib"
              aria-label="Fechar configurações"
              onClick={() => setIsSettingsOpen(false)}
            >
              <svg className="s" viewBox="0 0 24 24">
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          </header>

          <div id="sbody">
            {/* Resumo da Biblioteca */}
            <div className="s-group">
              <h3 className="s-group-title">Resumo da biblioteca</h3>
              <div className="s-stats">
                <div className="s-stat-box">
                  <b>{tracks.length}</b>
                  <small>{tracks.length === 1 ? 'Música' : 'Músicas'}</small>
                </div>
                <div className="s-stat-box">
                  <b>{artistGroups.length}</b>
                  <small>{artistGroups.length === 1 ? 'Artista' : 'Artistas'}</small>
                </div>
                <div className="s-stat-box">
                  <b>{albumGroups.length}</b>
                  <small>{albumGroups.length === 1 ? 'Álbum' : 'Álbuns'}</small>
                </div>
              </div>
            </div>

            {/* Imagens, Capas e Letras (Cache) */}
            <div className="s-group">
              <h3 className="s-group-title">Imagens, capas e letras</h3>
              <div className="s-card">
                <button
                  type="button"
                  className="s-btn"
                  onClick={() => handleClearImagesCache(true)}
                >
                  <svg className="s" viewBox="0 0 24 24">
                    <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                    <path d="M3 3v5h5" />
                    <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
                    <path d="M16 16h5v5" />
                  </svg>
                  <div className="s-btn-tx">
                    <b>Recarregar imagens de artistas e álbuns</b>
                    <small>Apaga o cache atual e busca novas fotos e capas online</small>
                  </div>
                </button>

                <button
                  type="button"
                  className="s-btn"
                  onClick={() => handleClearImagesCache(false)}
                >
                  <svg className="s" viewBox="0 0 24 24">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <circle cx="8.5" cy="8.5" r="1.5" />
                    <path d="m21 15-5-5L5 21" />
                  </svg>
                  <div className="s-btn-tx">
                    <b>Apagar cache de imagens e biografias</b>
                    <small>Remove fotos de artistas e capas salvas localmente</small>
                  </div>
                </button>

                <button
                  type="button"
                  className="s-btn"
                  onClick={handleClearLyricsCache}
                >
                  <svg className="s" viewBox="0 0 24 24">
                    <path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM5 11a7 7 0 0 0 14 0M12 18v3" />
                  </svg>
                  <div className="s-btn-tx">
                    <b>Apagar cache de letras e traduções</b>
                    <small>Limpa todas as letras LRC e traduções salvas no navegador</small>
                  </div>
                </button>
              </div>
            </div>

            {/* Reprodução e Áudio */}
            <div className="s-group">
              <h3 className="s-group-title">Reprodução e áudio</h3>
              <div className="s-card">
                <div className="s-row">
                  <div className="s-row-info">
                    <b>Timer para dormir (Sleep Timer)</b>
                    <small>
                      {sleepRemainingSec > 0
                        ? `Pausando reprodução em ${formatTime(sleepRemainingSec)}`
                        : 'Desliga a música automaticamente após o tempo escolhido'}
                    </small>
                  </div>
                </div>
                <div className="s-pills">
                  {[
                    { label: 'Off', min: 0 },
                    { label: '15m', min: 15 },
                    { label: '30m', min: 30 },
                    { label: '45m', min: 45 },
                    { label: '60m', min: 60 },
                  ].map((opt) => (
                    <button
                      key={opt.min}
                      type="button"
                      className={`s-pill ${sleepTimerMinutes === opt.min ? 'on' : ''}`}
                      onClick={() => {
                        setSleepTimerMinutes(opt.min);
                        if (opt.min > 0) {
                          showToast(`Timer ativado para ${opt.min} minutos`);
                        } else {
                          showToast('Timer de desligamento desativado');
                        }
                      }}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>

                <div className="s-row" style={{ marginTop: 4 }}>
                  <div className="s-row-info">
                    <b>Velocidade da reprodução</b>
                    <small>Ajuste o ritmo de execução das faixas ({playbackSpeed}x)</small>
                  </div>
                </div>
                <div className="s-pills">
                  {[0.75, 1, 1.25, 1.5, 2].map((spd) => (
                    <button
                      key={spd}
                      type="button"
                      className={`s-pill ${playbackSpeed === spd ? 'on' : ''}`}
                      onClick={() => {
                        setPlaybackSpeed(spd);
                        showToast(`Velocidade: ${spd}x`);
                      }}
                    >
                      {spd}x
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Aparência e Ajuda */}
            <div className="s-group">
              <h3 className="s-group-title">Aparência e ajuda</h3>
              <div className="s-card">
                <div className="s-row">
                  <div className="s-row-info">
                    <b>Tema do aplicativo</b>
                    <small>Escolha entre o tema automático, escuro ou claro</small>
                  </div>
                </div>
                <div className="s-pills">
                  {[
                    { id: 'auto' as const, label: 'Automático' },
                    { id: 'dark' as const, label: 'Escuro' },
                    { id: 'light' as const, label: 'Claro' },
                  ].map((tOpt) => (
                    <button
                      key={tOpt.id}
                      type="button"
                      className={`s-pill ${themePref === tOpt.id ? 'on' : ''}`}
                      onClick={() => setThemePref(tOpt.id)}
                    >
                      {tOpt.label}
                    </button>
                  ))}
                </div>

                <button
                  type="button"
                  className="s-btn"
                  onClick={() => {
                    setIsSettingsOpen(false);
                    startTour();
                  }}
                >
                  <svg className="s" viewBox="0 0 24 24">
                    <circle cx="12" cy="12" r="9" />
                    <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.5-3 4" />
                    <circle cx="12" cy="17.2" r="0.6" fill="currentColor" />
                  </svg>
                  <div className="s-btn-tx">
                    <b>Rever tour de boas-vindas</b>
                    <small>Mostra o passo a passo das funcionalidades do Vitrola</small>
                  </div>
                </button>
              </div>
            </div>

            {/* Armazenamento e Dados */}
            <div className="s-group">
              <h3 className="s-group-title">Armazenamento e biblioteca</h3>
              <div className="s-card">
                <button
                  type="button"
                  className="s-btn"
                  onClick={() => {
                    setIsSettingsOpen(false);
                    setIsImportMenuOpen(true);
                  }}
                >
                  <svg className="s" viewBox="0 0 24 24">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                  <div className="s-btn-tx">
                    <b>Importar músicas ou pastas</b>
                    <small>Adicionar novos arquivos de áudio ou pastas com subpastas</small>
                  </div>
                </button>

                <button
                  type="button"
                  className="s-btn"
                  onClick={() => {
                    setPlayCounts({});
                    setRecentKeys([]);
                    try {
                      localStorage.removeItem('vitrola_playcounts1');
                      localStorage.removeItem('vitrola_recent1');
                    } catch {
                      // ignore
                    }
                    showToast('Ranking de mais tocadas e histórico zerados');
                  }}
                >
                  <svg className="s" viewBox="0 0 24 24">
                    <path d="M12 20V10M18 20V4M6 20v-4" />
                  </svg>
                  <div className="s-btn-tx">
                    <b>Zerar ranking de mais tocadas e histórico</b>
                    <small>Reinicia a contagem de reproduções da Página Inicial</small>
                  </div>
                </button>

                <button
                  type="button"
                  className="s-btn danger"
                  onClick={() => {
                    if (tracks.length === 0) {
                      showToast('A biblioteca já está vazia');
                      return;
                    }
                    setConfirmRemove({
                      kind: 'all_tracks',
                      title: 'Todas as músicas',
                      trackIndices: tracks.map((_, i) => i),
                    });
                  }}
                >
                  <svg className="s" viewBox="0 0 24 24">
                    <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6" />
                  </svg>
                  <div className="s-btn-tx">
                    <b>Apagar todas as músicas da biblioteca</b>
                    <small>
                      Remove permanentemente {plural(tracks.length, ' música salva', ' músicas salvas')} neste navegador
                    </small>
                  </div>
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* Confirmation Pop-up Dialog for Removal */}
        {confirmRemove && (
          <div className="confirm-layer" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
            <div className="ctx-scrim" onClick={() => setConfirmRemove(null)} />
            <div className="confirm-card">
              <div className="confirm-icon">
                <svg className="s" viewBox="0 0 24 24">
                  <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6" />
                </svg>
              </div>
              <h3 className="confirm-title" id="confirm-title">
                {confirmRemove.kind === 'all_tracks'
                  ? 'Apagar toda a biblioteca?'
                  : confirmRemove.kind === 'artist'
                    ? 'Remover artista?'
                    : confirmRemove.kind === 'album'
                      ? 'Remover álbum?'
                      : 'Remover música?'}
              </h3>
              <p className="confirm-desc">
                {confirmRemove.kind === 'all_tracks' ? (
                  <>
                    Tem certeza que deseja apagar todas as{' '}
                    <b>{plural(confirmRemove.trackIndices.length, ' música salva', ' músicas salvas')}</b> da sua
                    biblioteca?
                  </>
                ) : confirmRemove.kind === 'artist' ? (
                  <>
                    Tem certeza que deseja remover o artista <b>{confirmRemove.title}</b> e todas as suas{' '}
                    <b>{plural(confirmRemove.trackIndices.length, ' música', ' músicas')}</b> da biblioteca?
                  </>
                ) : confirmRemove.kind === 'album' ? (
                  <>
                    Tem certeza que deseja remover o álbum <b>{confirmRemove.title}</b> (
                    <b>{plural(confirmRemove.trackIndices.length, ' música', ' músicas')}</b>) da biblioteca?
                  </>
                ) : (
                  <>
                    Tem certeza que deseja remover a música <b>{confirmRemove.title}</b> da sua biblioteca?
                  </>
                )}
              </p>
              <div className="confirm-actions">
                <button type="button" className="confirm-btn" onClick={() => setConfirmRemove(null)}>
                  Cancelar
                </button>
                <button
                  type="button"
                  className="confirm-btn danger"
                  onClick={() => {
                    if (confirmRemove.kind === 'all_tracks') {
                      executeClearAllTracks();
                    } else {
                      executeDeleteTracks(confirmRemove.trackIndices, confirmRemove.kind, confirmRemove.title);
                    }
                  }}
                >
                  Sim, remover
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Upload / Import Progress Bar Banner */}
        {uploadProgress && (
          <div className="upload-banner" role="status" aria-live="polite">
            <div className="upload-top">
              <span className="upload-title">
                <span className="upload-spinner" aria-hidden="true" />
                <span>Carregando músicas...</span>
              </span>
              <span className="upload-count">
                {uploadProgress.current}/{uploadProgress.total} (
                {Math.round((uploadProgress.current / Math.max(1, uploadProgress.total)) * 100)}%)
              </span>
            </div>
            <div className="upload-track-bar">
              <div
                className="upload-fill-bar"
                style={{
                  width: `${Math.min(100, Math.round((uploadProgress.current / Math.max(1, uploadProgress.total)) * 100))}%`,
                }}
              />
            </div>
            {uploadProgress.currentName && <div className="upload-sub">{uploadProgress.currentName}</div>}
          </div>
        )}

        {/* HTML5 Audio Element */}
        <audio
          ref={audioRef}
          id="a"
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onTimeUpdate={() => {
            if (audioRef.current) {
              setCurrentTime(audioRef.current.currentTime);
              saveState();
            }
          }}
          onLoadedMetadata={() => {
            if (audioRef.current) {
              setDuration(audioRef.current.duration);
            }
          }}
          onEnded={() => {
            if (repeat === 2) {
              if (audioRef.current) {
                audioRef.current.currentTime = 0;
                audioRef.current.play().catch(() => {});
              }
            } else {
              nextTrack(true);
            }
          }}
        />
      </main>
    </>
  );
}
