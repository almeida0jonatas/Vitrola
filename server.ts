import express, { Request, Response } from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// In-memory cache for artist, album lookups and lyrics translation
const artistCache = new Map<string, any>();
const albumCache = new Map<string, any>();
const lyricsTranslateCache = new Map<string, { translated: string; sourceLang: string }>();

function normalize(s?: string): string {
  return (s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function cleanArtistName(raw: string): string {
  return raw
    .replace(/\s*\(feat\..*?\)/i, '')
    .replace(/\s*\[feat\..*?\]/i, '')
    .replace(/\s*feat\..*$/i, '')
    .replace(/\s*ft\..*$/i, '')
    .replace(/\s*\/\s*.*$/, '')
    .replace(/\s*,\s*.*$/, '')
    .replace(/\s*&\s*.*$/, '')
    .trim();
}

// GET /api/artist-info?name=...
app.get('/api/artist-info', async (req: Request, res: Response) => {
  const rawName = String(req.query.name || '').trim();
  const name = cleanArtistName(rawName) || rawName;
  if (!name || name === 'Desconhecido' || name === 'Unknown') {
    return res.json({ none: true });
  }

  const cacheKey = normalize(name);
  if (artistCache.has(cacheKey)) {
    return res.json(artistCache.get(cacheKey));
  }

  const result: {
    img?: string;
    bio?: string;
    genre?: string;
    country?: string;
    url?: string;
    srcs?: string[];
    none?: boolean;
  } = { srcs: [] };

  // 1. Deezer API (high-resolution official artist photos)
  try {
    const dzRes = await fetch(
      `https://api.deezer.com/search/artist?q=${encodeURIComponent(name)}&limit=10`,
      { headers: { 'User-Agent': 'VitrolaMusicPlayer/1.0' } }
    );
    if (dzRes.ok) {
      const dz = (await dzRes.json()) as {
        data?: Array<{
          id: number;
          name: string;
          nb_fan?: number;
          picture_big?: string;
          picture_medium?: string;
          picture_xl?: string;
        }>;
      };
      if (dz.data && dz.data.length > 0) {
        const exact = dz.data.filter((d) => normalize(d.name) === normalize(name));
        const best =
          (exact.length > 0 ? exact : dz.data)
            .slice()
            .sort((a, b) => (b.nb_fan || 0) - (a.nb_fan || 0))[0] || dz.data[0];

        const pic = best.picture_big || best.picture_xl || best.picture_medium;
        if (pic && !pic.includes('/artist//')) {
          result.img = pic;
          result.srcs?.push('Deezer');
        }
      }
    }
  } catch {
    // continue to Wikipedia fallback
  }

  // 2. Wikipedia Summary API (bio + fallback portrait)
  const langs = ['pt', 'en'];
  for (const lang of langs) {
    try {
      const wpRes = await fetch(
        `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(name)}`,
        { headers: { 'User-Agent': 'VitrolaMusicPlayer/1.0 (local web player)' } }
      );
      if (wpRes.ok) {
        const wp = (await wpRes.json()) as {
          thumbnail?: { source: string };
          extract?: string;
          description?: string;
          content_urls?: { desktop?: { page?: string } };
        };

        const desc = `${wp.description || ''} ${wp.extract || ''}`;
        const isMusicRelated =
          /music|band|singer|musician|group|cantor|banda|músic|compositor|rock|pop/i.test(desc);

        if (isMusicRelated || !result.img) {
          if (!result.img && wp.thumbnail?.source) {
            result.img = wp.thumbnail.source;
          }
          if (!result.bio && wp.extract) {
            result.bio = wp.extract;
            result.url = wp.content_urls?.desktop?.page;
            result.srcs?.push(lang === 'pt' ? 'Wikipédia' : 'Wikipedia');
          }
        }
      }
    } catch {
      // continue
    }
    if (result.img && result.bio) break;
  }

  // 3. Wikipedia search if still missing bio or image
  if (!result.img || !result.bio) {
    for (const lang of langs) {
      try {
        const srchRes = await fetch(
          `https://${lang}.wikipedia.org/w/api.php?action=query&format=json&origin=*&generator=search&gsrsearch=${encodeURIComponent(
            name
          )}&gsrlimit=6&prop=pageimages|extracts|info&inprop=url&exintro=1&explaintext=1&piprop=thumbnail&pithumbsize=640`,
          { headers: { 'User-Agent': 'VitrolaMusicPlayer/1.0 (local web player)' } }
        );
        if (srchRes.ok) {
          const srch = (await srchRes.json()) as {
            query?: {
              pages?: Record<
                string,
                {
                  title: string;
                  thumbnail?: { source: string };
                  extract?: string;
                  fullurl?: string;
                }
              >;
            };
          };
          if (srch.query?.pages) {
            const pages = Object.values(srch.query.pages);
            const candidate =
              pages.find(
                (p) =>
                  normalize(p.title.replace(/\s*\(.*?\)/, '')) === normalize(name) &&
                  /music|band|singer|cantor|banda|músic|rock|pop/i.test(p.extract || '')
              ) ||
              pages.find((p) =>
                /music|band|singer|cantor|banda|músic|rock|pop/i.test(p.extract || '')
              ) ||
              pages[0];

            if (candidate) {
              if (!result.img && candidate.thumbnail?.source) {
                result.img = candidate.thumbnail.source;
              }
              if (!result.bio && candidate.extract) {
                result.bio = candidate.extract;
                result.url = candidate.fullurl;
                result.srcs?.push(lang === 'pt' ? 'Wikipédia' : 'Wikipedia');
              }
            }
          }
        }
      } catch {
        // continue
      }
      if (result.img && result.bio) break;
    }
  }

  // 4. iTunes fallback for genre
  try {
    const itRes = await fetch(
      `https://itunes.apple.com/search?term=${encodeURIComponent(name)}&entity=musicArtist&limit=3`
    );
    if (itRes.ok) {
      const it = (await itRes.json()) as { results?: Array<{ primaryGenreName?: string }> };
      if (it.results?.[0]?.primaryGenreName) {
        result.genre = it.results[0].primaryGenreName;
        result.srcs?.push('iTunes');
      }
    }
  } catch {
    // continue
  }

  if (!result.img && !result.bio && !result.genre) {
    result.none = true;
  }

  artistCache.set(cacheKey, result);
  res.json(result);
});

// GET /api/album-info?artist=...&album=...
app.get('/api/album-info', async (req: Request, res: Response) => {
  const artist = cleanArtistName(String(req.query.artist || ''));
  const album = String(req.query.album || '').trim();
  if (!album || album === 'Desconhecido' || album === 'Unknown') {
    return res.json({ none: true });
  }

  const cacheKey = `${normalize(artist)}|${normalize(album)}`;
  if (albumCache.has(cacheKey)) {
    return res.json(albumCache.get(cacheKey));
  }

  const result: {
    img?: string;
    bio?: string;
    genre?: string;
    year?: string;
    tracks?: number | string;
    url?: string;
    srcs?: string[];
    none?: boolean;
  } = { srcs: [] };

  // 1. iTunes for album
  try {
    const itRes = await fetch(
      `https://itunes.apple.com/search?term=${encodeURIComponent(
        `${artist} ${album}`.trim()
      )}&entity=album&limit=8`
    );
    if (itRes.ok) {
      const it = (await itRes.json()) as {
        results?: Array<{
          collectionName?: string;
          artistName?: string;
          artworkUrl100?: string;
          releaseDate?: string;
          primaryGenreName?: string;
          trackCount?: number;
        }>;
      };
      if (it.results && it.results.length > 0) {
        const match =
          it.results.find(
            (z) =>
              normalize(z.collectionName).includes(normalize(album)) &&
              (!artist || normalize(z.artistName).includes(normalize(artist)))
          ) || it.results[0];

        if (match) {
          if (match.artworkUrl100) {
            result.img = match.artworkUrl100.replace(/\d+x\d+bb/, '600x600bb');
          }
          result.year = (match.releaseDate || '').slice(0, 4);
          result.genre = match.primaryGenreName || '';
          result.tracks = match.trackCount;
          result.srcs?.push('iTunes');
        }
      }
    }
  } catch {
    // continue
  }

  // 2. Deezer fallback for album cover
  if (!result.img) {
    try {
      const dzRes = await fetch(
        `https://api.deezer.com/search/album?q=${encodeURIComponent(
          `${artist} ${album}`.trim()
        )}&limit=5`
      );
      if (dzRes.ok) {
        const dz = (await dzRes.json()) as {
          data?: Array<{
            title: string;
            cover_big?: string;
            cover_xl?: string;
            cover_medium?: string;
          }>;
        };
        if (dz.data?.[0]) {
          result.img = dz.data[0].cover_big || dz.data[0].cover_xl || dz.data[0].cover_medium;
          result.srcs?.push('Deezer');
        }
      }
    } catch {
      // continue
    }
  }

  if (!result.img && !result.bio && !result.genre && !result.year) {
    result.none = true;
  }

  albumCache.set(cacheKey, result);
  res.json(result);
});

// Helper for translation logic (used by POST and GET)
async function handleLyricsTranslation(
  text: string,
  targetLang: string,
  trackName?: string,
  artistName?: string
): Promise<{ translated: string; sourceLang: string }> {
  const cacheKey = `${normalize(trackName || '')}:${normalize(artistName || '')}:${targetLang}:${text.length}`;
  if (lyricsTranslateCache.has(cacheKey)) {
    return lyricsTranslateCache.get(cacheKey)!;
  }

  let translated = '';
  let sourceLang = '';

  // 1. Try Gemini API first if a valid GEMINI_API_KEY is configured
  const rawKey = (process.env.GEMINI_API_KEY || '').trim();
  const apiKey =
    rawKey &&
    rawKey !== 'MY_GEMINI_API_KEY' &&
    !rawKey.includes('MY_GEMINI') &&
    rawKey.length > 20
      ? rawKey
      : null;

  if (apiKey) {
    try {
      const ai = new GoogleGenAI({ apiKey });
      const prompt = `Você é um tradutor especializado em letras de músicas.
Traduza a letra de música a seguir para o Português (pt-BR).
REGRAS OBRIGATÓRIAS:
1. Mantenha a mesma quantidade exata de linhas e a estrutura linha por linha, para sincronização perfeita com o áudio.
2. Não adicione comentários, introduções, títulos ou notas. Retorne EXCLUSIVAMENTE as linhas traduzidas.
3. Se uma linha for sons vocais (la la la, oh oh, etc.) ou estiver em branco, mantenha-a idêntica ou em branco.

Letra original:
${text}`;

      const aiPromise = ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: prompt,
      });
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 15000)
      );

      const aiResponse = await Promise.race([aiPromise, timeoutPromise]);
      if (aiResponse.text && aiResponse.text.trim()) {
        translated = aiResponse.text.trim();
        sourceLang = 'gemini';
      }
    } catch {
      // Gracefully fall through to Google Translate fallback without emitting error warnings
    }
  }

  // 2. Free Google Translate fallback
  if (!translated) {
    try {
      const lines = text.split('\n');
      const chunkSize = 35;
      const translatedLines: string[] = [];

      for (let i = 0; i < lines.length; i += chunkSize) {
        const chunk = lines.slice(i, i + chunkSize).join('\n');
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(
          targetLang
        )}&dt=t&q=${encodeURIComponent(chunk)}`;

        const gtRes = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
          signal: AbortSignal.timeout(4000),
        });

        if (gtRes.ok) {
          const data = (await gtRes.json()) as any;
          if (data && Array.isArray(data[0])) {
            const chunkText = data[0].map((item: any) => item[0] || '').join('');
            if (!sourceLang && data[2]) sourceLang = data[2];
            translatedLines.push(...chunkText.split('\n'));
          }
        }
      }

      if (translatedLines.length > 0) {
        translated = translatedLines.join('\n');
      }
    } catch {
      // Continue or fail gracefully
    }
  }

  if (!translated) {
    throw new Error('Não foi possível traduzir a letra no momento.');
  }

  const result = { translated, sourceLang: sourceLang || 'auto' };
  lyricsTranslateCache.set(cacheKey, result);
  return result;
}

// POST /api/translate-lyrics
app.post('/api/translate-lyrics', async (req: Request, res: Response) => {
  const { text, targetLang = 'pt', trackName, artistName } = req.body || {};
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'Texto não fornecido' });
  }

  try {
    const result = await handleLyricsTranslation(text, targetLang, trackName, artistName);
    res.json(result);
  } catch (err: any) {
    res.status(502).json({ error: err.message || 'Erro ao traduzir letra' });
  }
});

// GET /api/translate-lyrics
app.get('/api/translate-lyrics', async (req: Request, res: Response) => {
  const text = String(req.query.text || '').trim();
  const targetLang = String(req.query.targetLang || 'pt');
  const trackName = String(req.query.trackName || '');
  const artistName = String(req.query.artistName || '');

  if (!text) {
    return res.status(400).json({ error: 'Texto não fornecido' });
  }

  try {
    const result = await handleLyricsTranslation(text, targetLang, trackName, artistName);
    res.json(result);
  } catch (err: any) {
    res.status(502).json({ error: err.message || 'Erro ao traduzir letra' });
  }
});

// Web App Manifest route that dynamically outputs theme_color and background_color matching dark or light theme
app.get(['/manifest.webmanifest', '/manifest.json'], (req: Request, res: Response) => {
  const isLight = req.query.theme === 'light';
  const color = isLight ? '#f4f5f8' : '#14171f';
  res.setHeader('Content-Type', 'application/manifest+json');
  return res.json({
    id: '/',
    name: 'Vitrola',
    short_name: 'Vitrola',
    description:
      'Player de música local com suporte a tags ID3, letras sincronizadas, capas, artistas, álbuns e persistência local via IndexedDB.',
    theme_color: color,
    background_color: color,
    display: 'standalone',
    orientation: 'portrait',
    categories: ['music', 'entertainment'],
    start_url: '/',
    scope: '/',
    icons: [
      {
        src: '/pwa-192x192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/pwa-512x512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/pwa-maskable-512x512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
      {
        src: '/pwa-monochrome-512x512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'monochrome',
      },
    ],
  });
});

async function main() {
  const isProduction = process.env.NODE_ENV === 'production';

  if (!isProduction) {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
        watch: process.env.DISABLE_HMR === 'true' ? null : undefined,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`Server running at http://0.0.0.0:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
