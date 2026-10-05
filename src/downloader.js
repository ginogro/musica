/**
 * Cola de descargas: busca la fuente, descarga el MP3 al servidor,
 * escribe los metadatos y lo incorpora a la biblioteca.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import NodeID3 from 'node-id3';
import { LIBRARY_DIR, MAX_DOWNLOAD_BYTES, QUEUE_FILE } from './config.js';
import { resolveDownload } from './providers.js';
import { downloadYouTubeAudio } from './youtube.js';
import { readMeta } from './scanner.js';
import { upsertTrack, trackId } from './catalog.js';

const UA = { 'User-Agent': 'MiMusicaServer/1.0 (personal music server)' };

let jobs = [];
let saveTimer = null;

function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(QUEUE_FILE, JSON.stringify(jobs.slice(-100)));
    } catch (err) {
      console.error('[downloader] error guardando cola:', err.message);
    }
  }, 300);
}

export function loadQueue() {
  try {
    jobs = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')) || [];
  } catch {
    jobs = [];
  }
  return jobs;
}

export function getJobs() {
  return jobs;
}

export function getJob(id) {
  return jobs.find((j) => j.id === id) || null;
}

export function cancelJob(id) {
  const job = getJob(id);
  if (!job) return false;
  if (job.status === 'queued' || job.status === 'searching') {
    job.status = 'cancelled';
    job.finishedAt = Date.now();
    persist();
    return true;
  }
  if (job.status === 'downloading') {
    job.abort = true;
    job.status = 'cancelled';
    job.finishedAt = Date.now();
    persist();
    return true;
  }
  return false;
}

/* ---------------- utilidades de ficheros ---------------- */

function sanitize(s) {
  return (s || 'Desconocido')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 120) || 'Desconocido';
}

function uniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(p);
  const base = p.slice(0, -ext.length);
  for (let i = 1; i < 1000; i++) {
    const cand = `${base} (${i})${ext}`;
    if (!fs.existsSync(cand)) return cand;
  }
  return `${base}-${Date.now()}${ext}`;
}

/** Decide la carpeta de destino: Biblioteca/Artista/Álbum/ */
function targetPath(meta) {
  const dir = path.join(LIBRARY_DIR, sanitize(meta.artist), sanitize(meta.album || 'Singles'));
  fs.mkdirSync(dir, { recursive: true });
  const name = sanitize(meta.title);
  return uniquePath(path.join(dir, `${name}.mp3`));
}

/** Nombre razonable si la fuente no informa el título. */
function fallbackName(meta) {
  return `${sanitize(meta.artist)} - ${sanitize(meta.title)}.mp3`;
}

/* ---------------- descarga real ---------------- */

async function fetchToFile(url, dest, job) {
  const res = await fetch(url, { headers: UA, redirect: 'follow', signal: AbortSignal.timeout(60000) });
  if (!res.ok) {
    const hint =
      res.status === 403 || res.status === 401
        ? ' — la fuente no permite descargar esta pista'
        : res.status === 404
          ? ' — el archivo ya no está disponible'
          : '';
    throw new Error(`El servidor respondió HTTP ${res.status}${hint}`);
  }
  const total = Number(res.headers.get('content-length')) || 0;
  if (total > MAX_DOWNLOAD_BYTES) throw new Error(`Fichero demasiado grande (${(total / 1e6).toFixed(0)} MB)`);
  if (!res.body) throw new Error('Respuesta sin cuerpo');

  const out = fs.createWriteStream(dest);
  const reader = res.body.getReader();
  let received = 0;
  try {
    while (true) {
      if (job.abort) {
        await reader.cancel();
        throw new Error('Cancelado');
      }
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_DOWNLOAD_BYTES) {
        await reader.cancel();
        throw new Error('Límite de tamaño superado');
      }
      if (!out.write(Buffer.from(value))) {
        await new Promise((r) => out.once('drain', r));
      }
      job.bytes = received;
      job.totalBytes = total;
      job.progress = total ? Math.min(0.99, received / total) : null;
      if (received % (256 * 1024) < value.byteLength) persist();
    }
  } finally {
    out.end();
    await finished(out).catch(() => {});
  }
  if (received < 1024) throw new Error('Descarga vacía o demasiado corta');
  return received;
}

function looksLikeMp3(file) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(10);
  fs.readSync(fd, buf, 0, 10, 0);
  fs.closeSync(fd);
  if (buf.slice(0, 3).toString('latin1') === 'ID3') return true;
  return buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0;
}

/* ---------------- proceso de un trabajo ---------------- */

async function processJob(job) {
  try {
    job.status = 'searching';
    job.message = 'Resolviendo la fuente...';
    persist();

    const dl = await resolveDownload(job.request);
    job.status = 'downloading';
    job.message =
      dl.tool === 'yt-dlp'
        ? 'Obteniendo el MP3 del vídeo de YouTube…'
        : `Descargando de ${job.request.sourceLabel}`;
    job.bytes = 0;
    job.totalBytes = 0;
    persist();

    const meta = {
      title: dl.title || job.request.title,
      artist: dl.artist || job.request.artist || 'Desconocido',
      album: dl.album || job.request.album || 'Descargas',
      year: dl.year || job.request.year || null,
      genre: dl.genre || job.request.genre || '',
      duration: dl.duration || job.request.duration || 0,
    };

    const dest = targetPath(meta);
    try {
      // yt-dlp (YouTube) hace la descarga y la conversión a MP3 en un solo
      // paso; el resto de fuentes es una descarga HTTP directa.
      if (dl.tool === 'yt-dlp') await downloadYouTubeAudio(dl, dest, job);
      else await fetchToFile(dl.url, dest, job);
    } catch (err) {
      fs.rmSync(dest, { force: true });
      throw err;
    }

    if (!looksLikeMp3(dest)) {
      fs.rmSync(dest, { force: true });
      throw new Error('El archivo descargado no es un MP3 válido');
    }

    job.status = 'tagging';
    job.message = 'Escribiendo etiquetas...';
    persist();

    // Etiquetas ID3 + proveniencia
    try {
      NodeID3.update(
        {
          title: meta.title,
          artist: meta.artist,
          album: meta.album,
          genre: meta.genre,
          year: meta.year ? String(meta.year) : undefined,
          comment: { language: 'spa', shortText: 'Origen', text: job.request.providerUrl || job.request.source },
        },
        dest
      );
    } catch (err) {
      console.warn('[downloader] no se pudieron escribir ID3:', err.message);
    }

    job.status = 'indexing';
    job.message = 'Añadiendo a la biblioteca...';
    persist();

    const entry = await readMeta(dest);
    entry.classified = true;
    entry.source = job.request.source;
    entry.originUrl = job.request.providerUrl || null;
    entry.addedAt = Date.now();
    upsertTrack(entry);

    job.status = 'done';
    job.progress = 1;
    job.message = 'Completado';
    job.trackId = entry.id;
    job.track = { id: entry.id, title: entry.title, artist: entry.artist, album: entry.album };
    job.finishedAt = Date.now();
    console.log(`[downloader] OK ${meta.artist} - ${meta.title}`);
  } catch (err) {
    if (job.status !== 'cancelled') {
      job.status = 'error';
      job.message = err.message;
      job.finishedAt = Date.now();
      console.error(`[downloader] fallo ${job.request?.title}:`, err.message);
    }
  } finally {
    job.abort = false;
    persist();
  }
}

/** Encola una descarga. `request` es un resultado de providers.searchMusic(). */
export function enqueue(request) {
  const existing = jobs.find(
    (j) => j.request.source === request.source && j.request.sourceId === request.sourceId && ['queued', 'searching', 'downloading', 'tagging'].includes(j.status)
  );
  if (existing) return existing;

  const job = {
    id: crypto.randomUUID(),
    request,
    status: 'queued',
    progress: 0,
    bytes: 0,
    totalBytes: 0,
    message: 'En cola',
    createdAt: Date.now(),
    finishedAt: null,
    trackId: null,
    track: null,
    abort: false,
  };
  jobs.push(job);
  persist();
  pump();
  return job;
}

let running = 0;
const CONCURRENCY = 2;

function pump() {
  while (running < CONCURRENCY) {
    const next = jobs.find((j) => j.status === 'queued');
    if (!next) return;
    running++;
    processJob(next).finally(() => {
      running--;
      pump();
    });
  }
}

export function clearFinished() {
  const before = jobs.length;
  jobs = jobs.filter((j) => !['done', 'error', 'cancelled'].includes(j.status));
  persist();
  return before - jobs.length;
}
