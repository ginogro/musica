import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CATALOG_FILE } from './config.js';

const EMPTY = { version: 2, tracks: [], updatedAt: 0 };

let cache = null;

function load() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
    cache = raw && Array.isArray(raw.tracks) ? raw : { ...EMPTY, tracks: [] };
  } catch {
    cache = { ...EMPTY, tracks: [] };
  }
  return cache;
}

let saveTimer = null;
function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const data = load();
      data.updatedAt = Date.now();
      const tmp = CATALOG_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, CATALOG_FILE);
    } catch (err) {
      console.error('[catalog] error guardando:', err.message);
    }
  }, 250);
}

export function trackId(absPath) {
  return crypto.createHash('sha1').update(absPath).digest('hex').slice(0, 16);
}

export function allTracks() {
  return load().tracks;
}

export function getTrack(id) {
  return load().tracks.find((t) => t.id === id) || null;
}

/** Inserta o actualiza por id (que deriva de la ruta absoluta). */
export function upsertTrack(entry) {
  const data = load();
  const idx = data.tracks.findIndex((t) => t.id === entry.id);
  if (idx >= 0) data.tracks[idx] = { ...data.tracks[idx], ...entry };
  else data.tracks.push(entry);
  persist();
  return entry;
}

export function removeTrack(id) {
  const data = load();
  const before = data.tracks.length;
  data.tracks = data.tracks.filter((t) => t.id !== id);
  persist();
  return data.tracks.length !== before;
}

export function clearCatalog() {
  cache = { ...EMPTY, tracks: [] };
  persist();
}

function norm(s) {
  return (s || '').toString().toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

export function searchTracks({ q = '', artist = '', album = '', genre = '', limit = 50, offset = 0 } = {}) {
  const nq = norm(q);
  const nArtist = norm(artist);
  const nAlbum = norm(album);
  const nGenre = norm(genre);

  let list = load().tracks.filter((t) => {
    if (nArtist && !norm(t.artist).includes(nArtist)) return false;
    if (nAlbum && !norm(t.album).includes(nAlbum)) return false;
    if (nGenre && !norm(t.genre).includes(nGenre)) return false;
    if (!nq) return true;
    const hay = norm(`${t.title} ${t.artist} ${t.album} ${t.genre} ${t.fileName}`);
    return nq.split(/\s+/).every((tok) => hay.includes(tok));
  });

  list.sort((a, b) => {
    if (nq) {
      const sa = norm(a.title).startsWith(nq) ? 0 : 1;
      const sb = norm(b.title).startsWith(nq) ? 0 : 1;
      if (sa !== sb) return sa - sb;
    }
    return (a.artist || '').localeCompare(b.artist || '') || (a.title || '').localeCompare(b.title || '');
  });

  return { total: list.length, items: list.slice(offset, offset + limit) };
}

export function facets() {
  const data = load();
  const artists = new Map();
  const albums = new Map();
  const genres = new Map();
  const years = new Map();
  for (const t of data.tracks) {
    if (t.artist) artists.set(t.artist, (artists.get(t.artist) || 0) + 1);
    if (t.album) albums.set(t.album, (albums.get(t.album) || 0) + 1);
    if (t.genre) genres.set(t.genre, (genres.get(t.genre) || 0) + 1);
    if (t.year) years.set(String(t.year), (years.get(String(t.year)) || 0) + 1);
  }
  const toArr = (m) => [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { artists: toArr(artists), albums: toArr(albums), genres: toArr(genres), years: toArr(years) };
}

export function stats() {
  const data = load();
  let unclassified = 0;
  let totalBytes = 0;
  let duration = 0;
  for (const t of data.tracks) {
    if (!t.classified) unclassified++;
    totalBytes += t.size || 0;
    duration += t.duration || 0;
  }
  return {
    tracks: data.tracks.length,
    unclassified,
    totalBytes,
    durationSeconds: Math.round(duration),
    updatedAt: data.updatedAt,
  };
}
