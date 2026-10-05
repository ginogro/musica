/**
 * Fuentes de descarga.
 *
 * Servicios que distribuyen música de forma legítima:
 *  - Internet Archive: dominio público, Creative Commons y material cedido.
 *  - Audius: plataforma de artistas independientes con descargas abiertas.
 *  - Jamendo: catálogo Creative Commons para uso personal.
 *
 * Y, como último recurso, YouTube (respaldo): se busca el vídeo y se obtiene
 * el MP3 de su audio con yt-dlp + ffmpeg. Va siempre al final de la lista,
 * así lo que encuentren los sitios libres se muestra primero.
 */

import { searchYouTube, downloadYouTubeAudio, youtubeStatus } from './youtube.js';

const APP_NAME = 'MiMusicaServer';
const UA = { 'User-Agent': `${APP_NAME}/1.0 (personal music server)` };

async function getJSON(url, timeoutMs = 20000) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} en ${url}`);
  return res.json();
}

function clean(s) {
  return (s || '').toString().replace(/\s+/g, ' ').trim();
}

/* ------------------------------------------------------------------ */
/* Internet Archive                                                    */
/* ------------------------------------------------------------------ */

async function searchArchive(query, limit) {
  const q =
    `(${query}) AND mediatype:(audio) AND format:(MP3)` +
    ` AND -collection:podcasts`;
  const url =
    'https://archive.org/advancedsearch.php' +
    `?q=${encodeURIComponent(q)}` +
    '&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=year&fl[]=downloads' +
    '&sort[]=downloads+desc&rows=' + Math.min(limit * 3, 60) + '&page=1&output=json';

  const data = await getJSON(url);
  const docs = data?.response?.docs || [];
  const out = [];

  for (const d of docs) {
    if (out.length >= limit) break;
    out.push({
      source: 'archive',
      sourceId: d.identifier,
      title: clean(Array.isArray(d.title) ? d.title[0] : d.title) || d.identifier,
      artist: clean(Array.isArray(d.creator) ? d.creator.join(', ') : d.creator) || 'Desconocido',
      album: '',
      year: d.year ? String(d.year) : null,
      duration: 0,
      providerUrl: `https://archive.org/details/${d.identifier}`,
      downloadUrl: `https://archive.org/download/${d.identifier}/`,
      canDownload: true,
      kind: 'item',
    });
  }
  return out;
}

/** Devuelve la lista de pistas MP3 reales dentro de un ítem del Archive. */
async function archiveItemFiles(identifier) {
  const meta = await getJSON(`https://archive.org/metadata/${identifier}`);
  const files = meta?.files || [];
  const mp3s = files.filter((f) => /mp3/i.test(f.format || '') || /\.mp3$/i.test(f.name || ''));
  return mp3s.map((f) => ({
    name: f.name,
    title: clean(f.title) || clean(f.name).replace(/\.mp3$/i, ''),
    artist: clean(f.creator) || null,
    track: f.track ? String(f.track) : null,
    size: Number(f.size) || 0,
    length: f.length || null,
  }));
}

async function resolveArchive(item, wantedTitle) {
  const list = await archiveItemFiles(item.sourceId);
  if (!list.length) throw new Error('El ítem no contiene archivos MP3');

  let chosen = null;
  if (wantedTitle) {
    const w = wantedTitle.toLowerCase();
    chosen = list.find((f) => f.title.toLowerCase() === w) ||
      list.find((f) => f.title.toLowerCase().includes(w));
  }
  if (!chosen) chosen = list.length === 1 ? list[0] : list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))[0];

  const url =
    `https://archive.org/download/${item.sourceId}/` +
    encodeURIComponent(chosen.name).replace(/%2F/g, '/');

  return {
    url,
    title: chosen.title || item.title,
    artist: chosen.artist || item.artist,
    album: item.album || '',
    year: item.year,
    fileName: chosen.name.split('/').pop(),
    duration: parseDuration(chosen.length),
  };
}

function parseDuration(len) {
  if (!len) return 0;
  const parts = String(len).split(':').map(Number);
  if (parts.some(Number.isNaN)) return 0;
  return parts.reduce((acc, v) => acc * 60 + v, 0);
}

/* ------------------------------------------------------------------ */
/* Audius                                                              */
/* ------------------------------------------------------------------ */

const AUDIUS_HOSTS = [
  'https://discoveryprovider.audius.co',
  'https://discoveryprovider2.audius.co',
  'https://audius-discovery-1.altego.net',
];

async function audiusHost() {
  for (const h of AUDIUS_HOSTS) {
    try {
      await getJSON(`${h}/health_check`, 6000);
      return h;
    } catch { /* siguiente */ }
  }
  return AUDIUS_HOSTS[0];
}

async function searchAudius(query, limit) {
  const host = await audiusHost();
  const data = await getJSON(
    `${host}/v1/tracks/search?query=${encodeURIComponent(query)}&app_name=${APP_NAME}&limit=${limit * 3}`
  );
  const items = (data?.data || []).filter((t) => t.is_downloadable);
  return items.slice(0, limit).map((t) => ({
    source: 'audius',
    sourceId: t.id,
    title: clean(t.title) || 'Sin título',
    artist: clean(t.user?.name) || 'Desconocido',
    album: '',
    year: t.release_date ? t.release_date.slice(0, 4) : null,
    duration: t.duration || 0,
    genre: clean(t.genre),
    providerUrl: `https://audius.co/${t.user?.handle || ''}/${t.slug || t.id}`,
    downloadUrl: `${host}/v1/tracks/${t.id}/stream?app_name=${APP_NAME}`,
    canDownload: true,
    kind: 'track',
  }));
}

async function resolveAudius(item) {
  if (item.canDownload === false) {
    throw new Error('Audius no permite descargar esta pista (el artista la ha marcado como no descargable)');
  }
  const host = await audiusHost();
  return {
    url: `${host}/v1/tracks/${item.sourceId}/stream?app_name=${APP_NAME}`,
    title: item.title,
    artist: item.artist,
    album: item.album,
    year: item.year,
    fileName: null,
    duration: item.duration,
  };
}

/* ------------------------------------------------------------------ */
/* Jamendo (Creative Commons)                                          */
/* ------------------------------------------------------------------ */

async function searchJamendo(query, limit) {
  const url =
    'https://api.jamendo.com/v3.0/tracks' +
    `?client_id=${process.env.JAMENDO_CLIENT_ID}` +
    `&search=${encodeURIComponent(query)}&limit=${limit}&audioformat=mp32`;
  if (!process.env.JAMENDO_CLIENT_ID) return [];
  const data = await getJSON(url);
  const items = data?.results || [];
  return items.map((t) => ({
    source: 'jamendo',
    sourceId: t.id,
    title: clean(t.name) || 'Sin título',
    artist: clean(t.artist_name) || 'Desconocido',
    album: clean(t.album_name),
    year: t.releasedate ? t.releasedate.slice(0, 4) : null,
    duration: Number(t.duration) || 0,
    genre: clean(t.musicinfo?.tags?.genres?.[0]),
    providerUrl: t.shareurl || t.shorturl,
    downloadUrl: t.audiodownload || t.audio,
    canDownload: Boolean(t.audiodownload),
    kind: 'track',
  }));
}

async function resolveJamendo(item) {
  if (!item.downloadUrl) throw new Error('Jamendo no ofrece descarga directa para esta pista');
  return {
    url: item.downloadUrl,
    title: item.title,
    artist: item.artist,
    album: item.album,
    year: item.year,
    fileName: null,
    duration: item.duration,
  };
}

/* ------------------------------------------------------------------ */
/* YouTube (respaldo): busca el vídeo y extrae su audio como MP3        */
/* ------------------------------------------------------------------ */

async function resolveYouTube(item) {
  const st = youtubeStatus();
  if (!st.ok) throw new Error(`YouTube no disponible — ${st.reason}`);
  return {
    tool: 'yt-dlp',
    url: item.providerUrl,
    title: item.title,
    artist: item.artist,
    album: item.album || 'YouTube',
    year: item.year,
    duration: item.duration,
  };
}

/* ------------------------------------------------------------------ */
/* API pública                                                          */
/* ------------------------------------------------------------------ */

/**
 * El orden importa: los sitios libres primero y YouTube siempre al final
 * (searchMusic conserva el orden de esta lista).
 */
const SOURCES = {
  archive: { label: 'Internet Archive (dominio público / CC)', search: searchArchive, resolve: resolveArchive },
  audius: { label: 'Audius (artistas independientes)', search: searchAudius, resolve: resolveAudius },
  jamendo: { label: 'Jamendo (Creative Commons)', search: searchJamendo, resolve: resolveJamendo },
  youtube: {
    label: 'YouTube (respaldo: MP3 del vídeo)',
    search: searchYouTube,
    resolve: resolveYouTube,
    available: () => youtubeStatus().ok,
  },
};

export const sourceList = Object.entries(SOURCES).map(([id, s]) => ({
  id,
  label: s.label,
  available: s.available ? s.available() : true,
  ...(id === 'youtube' && !s.available() ? { reason: youtubeStatus().reason } : {}),
}));

/**
 * Busca en todas (o una) las fuentes.
 * @param {string} query  texto libre: "autor", "estilo jazz", "rock psicodélico"
 * @param {object} opts   { limit, sources }
 */
export async function searchMusic(query, { limit = 8, sources = null } = {}) {
  const wanted = sources && sources.length ? sources : Object.keys(SOURCES);
  const results = await Promise.allSettled(
    wanted.map((id) => (SOURCES[id] ? SOURCES[id].search(query, limit) : Promise.resolve([])))
  );

  const out = [];
  results.forEach((r, i) => {
    const id = wanted[i];
    if (r.status === 'fulfilled') {
      for (const item of r.value) out.push({ ...item, sourceLabel: SOURCES[id].label });
    } else {
      console.warn(`[providers] ${id}:`, r.reason?.message || r.reason);
    }
  });

  // dedupe simple por título+artista
  const seen = new Set();
  return out.filter((it) => {
    const k = `${it.title.toLowerCase()}|${it.artist.toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Convierte un resultado de búsqueda en una URL de descarga concreta. */
export async function resolveDownload(item) {
  const src = SOURCES[item.source];
  if (!src) throw new Error(`Fuente desconocida: ${item.source}`);
  return src.resolve(item);
}

/**
 * Construye una consulta a partir de una canción de la biblioteca para
 * encontrar algo "del mismo estilo / del mismo autor".
 */
export function similarQuery(track, mode = 'style') {
  const artist = (track.artist || '').replace(/\s*\(.*\)$/, '').trim();
  const genre = (track.genre || '').trim();
  if (mode === 'artist') return artist ? `${artist} songs` : track.title;
  const parts = [];
  if (genre) parts.push(genre);
  if (artist) parts.push(artist);
  if (!parts.length) parts.push(track.title, track.artist);
  return parts.join(' ');
}
