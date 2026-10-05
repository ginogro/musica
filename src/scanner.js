import fs from 'node:fs';
import path from 'node:path';
import { parseFile } from 'music-metadata';
import NodeID3 from 'node-id3';
import { LIBRARY_DIR, AUDIO_EXTS } from './config.js';
import { trackId, upsertTrack, allTracks, removeTrack, stats as statsSummary } from './catalog.js';

export const scanState = {
  running: false,
  lastRun: 0,
  scanned: 0,
  added: 0,
  updated: 0,
  classified: 0,
  errors: 0,
  message: 'Nunca ejecutado',
};

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile() && AUDIO_EXTS.has(path.extname(e.name).toLowerCase())) out.push(full);
  }
  return out;
}

/**
 * Clasifica archivos que llegaron sin metadatos usando el nombre de archivo
 * y la estructura de carpetas. Devuelve los metadatos inferidos.
 */
export function inferMetadata(absPath) {
  const rel = path.relative(LIBRARY_DIR, absPath);
  const parts = rel.split(path.sep);
  const fileName = parts.pop();
  const base = fileName.replace(/\.[^.]+$/, '');

  const clean = (s) =>
    (s || '')
      .replace(/\s+[\(\[][^\)\]]*[\)\]]\s*$/, '') // quita (feat...) o [remaster]
      .replace(/\s+-\s+/g, ' - ')
      .replace(/\s{2,}/g, ' ')
      .trim();

  let artist = '';
  let title = '';
  const album = clean(parts[parts.length - 1] || '');
  const folderArtist = clean(parts[parts.length - 2] || '');
  const isTrackNo = (s) => /^\d{1,3}$/.test(s);

  // 1) "Artista - Título"
  let m = base.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (m) {
    // quita numeración de pista aunque vaya pegada: "01-Título", "01 Título"
    const left = m[1].replace(/^\d{1,3}[\s._-]*/, '').trim();
    artist = isTrackNo(left) ? '' : clean(left);
    title = clean(m[2].replace(/^\d{1,3}[\s._-]+/, ''));
  }
  if (!m) {
    // 2) "01 Título" o "01. Título"
    m = base.match(/^\d{1,3}[\s._-]+(.+)$/);
    if (m) title = clean(m[1]);
  }
  if (!title) title = clean(base.replace(/^\d{1,3}[\s._-]+/, '')) || clean(base);

  // 3) Si no hay artista en el nombre, el padre de la carpeta de álbum
  //    (biblioteca/Artista/Álbum/pista.mp3) suele serlo.
  if (!artist) {
    artist = folderArtist && !isTrackNo(folderArtist) && folderArtist.toLowerCase() !== 'biblioteca'
      ? folderArtist
      : '';
  }

  const confidence = artist && artist !== 'Desconocido' ? 'high' : 'low';
  return {
    title: title || base,
    artist: artist || 'Desconocido',
    album: album || 'Sin álbum',
    year: null,
    genre: '',
    confidence,
  };
}

function firstTag(v) {
  if (Array.isArray(v)) return v.length ? v[0] : '';
  if (v && typeof v === 'object' && 'text' in v) return v.text;
  return v || '';
}

export async function readMeta(absPath) {
  const stat = fs.statSync(absPath);
  let mm = null;
  let tagError = null;
  try {
    mm = await parseFile(absPath, { duration: true });
  } catch (err) {
    tagError = err.message;
  }

  const common = mm?.common || {};
  const format = mm?.format || {};

  let title = firstTag(common.title);
  let artist = firstTag(common.artist) || firstTag(common.albumartist);
  let album = firstTag(common.album);
  let genre = firstTag(common.genre);
  let year = common.year || null;

  // "con etiquetas" solo cuenta si además aporta un artista real
  const hadTags = Boolean(title && artist && artist !== 'Desconocido');
  const tagMissing = !title || !artist || artist === 'Desconocido';
  let inferred = null;

  if (tagMissing) {
    inferred = inferMetadata(absPath);
    title = title || inferred.title;
    artist = !artist || artist === 'Desconocido' ? inferred.artist : artist;
    album = album || inferred.album;
    genre = genre || '';
    year = year || inferred.year;
  }

  // Clasificada = tenemos un artista utilizable (real o inferido con fiabilidad)
  const classified = Boolean(artist && artist !== 'Desconocido');

  return {
    id: trackId(absPath),
    path: absPath,
    relativePath: path.relative(LIBRARY_DIR, absPath),
    fileName: path.basename(absPath),
    title: title || path.basename(absPath),
    artist: artist || 'Desconocido',
    album: album || 'Sin álbum',
    genre: genre || '',
    year,
    duration: Math.round(format.duration || 0),
    bitrate: format.bitrate ? Math.round(format.bitrate) : null,
    sampleRate: format.sampleRate || null,
    codec: format.codec || null,
    size: stat.size,
    mtime: stat.mtimeMs,
    classified,
    hadTags,
    tagMissing,
    inferred: Boolean(inferred),
    confidence: inferred?.confidence || (hadTags ? 'high' : 'low'),
    tagError,
    addedAt: Date.now(),
  };
}

/**
 * Escribe en el ID3 los metadatos inferidos, para que la canción quede
 * realmente clasificada también en el propio archivo.
 */
export function writeTags(absPath, meta) {
  if (path.extname(absPath).toLowerCase() !== '.mp3') return false;
  try {
    const tags = {
      title: meta.title,
      artist: meta.artist,
      album: meta.album,
    };
    if (meta.genre) tags.genre = meta.genre;
    if (meta.year) tags.year = String(meta.year);
    tags.comment = {
      language: 'spa',
      shortText: 'Clasificado por',
      text: 'Servidor MiMúsica (autoclasificación)',
    };
    const ok = NodeID3.update(tags, absPath);
    return ok !== false;
  } catch (err) {
    console.error('[scanner] no se pudieron escribir etiquetas:', err.message);
    return false;
  }
}

/** Escanea la biblioteca completa y autoclasifica lo que no tenga metadatos. */
export async function runScan({ classify = true } = {}) {
  if (scanState.running) return { skipped: true, ...scanState };
  scanState.running = true;
  scanState.message = 'Escaneando...';
  scanState.scanned = 0;
  const t0 = Date.now();
  const files = walk(LIBRARY_DIR);
  const known = new Map(allTracks().map((t) => [t.path, t]));
  const seen = new Set();
  let added = 0;
  let updated = 0;
  let classified = 0;
  let errors = 0;

  try {
    for (const file of files) {
      seen.add(file);
      scanState.scanned += 1;
      try {
        const prev = known.get(file);
        const stat = fs.statSync(file);

        // Ya la tenemos igual y no queda nada por hacer con ella.
        if (prev && prev.mtime === stat.mtimeMs && (prev.classified || prev.tagWriteTried)) continue;

        const meta = await readMeta(file);
        if (prev?.addedAt) meta.addedAt = prev.addedAt;

        // Escribe etiquetas solo una vez por fichero: si la inferencia no
        // consigue un artista, no tiene sentido reescribir en cada pase.
        if (meta.tagMissing && classify && !prev?.tagWriteTried) {
          const written = writeTags(file, meta);
          meta.tagWriteTried = true;
          if (written) {
            const again = await readMeta(file);
            Object.assign(meta, again, {
              addedAt: meta.addedAt,
              classified: meta.classified,
              confidence: meta.confidence,
              inferred: meta.inferred,
              tagWriteTried: true,
            });
            // el id y la ruta pueden cambiar tras reescribir (no deberían)
            meta.id = trackId(file);
            meta.path = file;
          }
          classified++;
        }

        upsertTrack(meta);
        if (prev) updated++;
        else added++;
      } catch (err) {
        errors++;
        console.error('[scanner]', file, err.message);
      }
    }

    // quitar del catálogo los archivos que ya no existen
    for (const [p] of known) {
      if (!seen.has(p)) removeTrack(trackId(p));
    }

    const now = statsSummary();
    scanState.added = added;
    scanState.updated = updated;
    scanState.classified = classified;
    scanState.errors = errors;
    scanState.lastRun = Date.now();
    scanState.unclassified = now.unclassified;
    scanState.message = `OK: ${files.length} archivos, ${added} nuevos, ${classified} autoclasificados, ${now.unclassified} sin clasificar, ${errors} errores, ${((Date.now() - t0) / 1000).toFixed(1)}s`;
    console.log('[scanner]', scanState.message);
  } finally {
    scanState.running = false;
  }
  return { ...scanState };
}

export function listUnclassified() {
  return allTracks().filter((t) => !t.classified);
}

export { LIBRARY_DIR };
