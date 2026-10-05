/**
 * Servidor de música personal (HTTP + HTTPS para la PWA).
 *
 * - Sirve la biblioteca local con streaming por rangos (para poder avanzar
 *   la canción en el móvil sin descargarla entera).
 * - Expone la API que usa la PWA: catálogo, búsqueda, escaneo/autoclasificación
 *   y cola de descargas de fuentes gratuitas y legales.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import express from 'express';
import {
  PORT, HTTPS_PORT, LIBRARY_DIR, PUBLIC_DIR, CERT_DIR,
  DATA_DIR, APP_NAME, ensureDirs, AUDIO_EXTS,
} from './src/config.js';
import { searchTracks, facets, stats, allTracks, getTrack } from './src/catalog.js';
import { runScan, scanState, listUnclassified } from './src/scanner.js';
import { searchMusic, sourceList, similarQuery } from './src/providers.js';
import { enqueue, getJobs, getJob, cancelJob, clearFinished, loadQueue } from './src/downloader.js';

ensureDirs();
loadQueue();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
};

function clientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '';
}

/* ------------------------------------------------------------------ */
/* API: biblioteca                                                     */
/* ------------------------------------------------------------------ */

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, app: APP_NAME, stats: stats(), scan: scanState, time: Date.now() });
});

app.get('/api/tracks', (req, res) => {
  const { q = '', artist = '', album = '', genre = '', limit = '60', offset = '0' } = req.query;
  res.json(
    searchTracks({
      q: String(q),
      artist: String(artist),
      album: String(album),
      genre: String(genre),
      limit: Math.min(Number(limit) || 60, 500),
      offset: Number(offset) || 0,
    })
  );
});

app.get('/api/track/:id', (req, res) => {
  const t = getTrack(req.params.id);
  if (!t) return res.status(404).json({ error: 'No encontrada' });
  res.json(t);
});

app.get('/api/facets', (_req, res) => res.json(facets()));
app.get('/api/stats', (_req, res) => res.json(stats()));
app.get('/api/unclassified', (_req, res) => res.json({ items: listUnclassified() }));

/* ------------------------------------------------------------------ */
/* API: escaneo y autoclasificación                                   */
/* ------------------------------------------------------------------ */

app.get('/api/scan/status', (_req, res) => res.json(scanState));

app.post('/api/scan', async (req, res) => {
  const classify = req.body?.classify !== false;
  if (scanState.running) return res.status(409).json({ ...scanState, error: 'Ya hay un escaneo en curso' });
  res.json({ started: true, classify });
  runScan({ classify }).catch((err) => console.error('[scan]', err));
});

/* ------------------------------------------------------------------ */
/* API: streaming por rangos                                           */
/* ------------------------------------------------------------------ */

app.get('/api/stream/:id', (req, res) => {
  const track = getTrack(req.params.id);
  if (!track) return res.status(404).json({ error: 'No encontrada' });

  const file = track.path;
  if (!file.startsWith(LIBRARY_DIR)) return res.status(403).json({ error: 'Ruta no permitida' });
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'El fichero ya no existe' });

  const stat = fs.statSync(file);
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  // Evita que el navegador insista con el mismo rango
  res.setHeader('ETag', `W/"${stat.size}-${stat.mtimeMs}"`);

  if (range) {
    const m = range.match(/^bytes=(\d*)-(\d*)$/);
    if (m) {
      let start = m[1] === '' ? undefined : Number(m[1]);
      let end = m[2] === '' ? undefined : Number(m[2]);
      if (start === undefined) {
        // bytes=-500  → últimos 500 bytes
        start = Math.max(0, stat.size - (end || 0));
        end = stat.size - 1;
      } else if (end === undefined || end >= stat.size) {
        end = stat.size - 1;
      }
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= stat.size) {
        res.status(416).setHeader('Content-Range', `bytes */${stat.size}`);
        return res.end();
      }
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      res.setHeader('Content-Length', end - start + 1);
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
  }

  res.setHeader('Content-Length', stat.size);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
});

app.get('/api/track/:id/download', (req, res) => {
  const track = getTrack(req.params.id);
  if (!track || !track.path.startsWith(LIBRARY_DIR)) return res.status(404).json({ error: 'No encontrada' });
  res.download(track.path, `${track.artist} - ${track.title}.mp3`);
});

/* ------------------------------------------------------------------ */
/* API: buscar y pedir canciones en internet (fuentes gratuitas)       */
/* ------------------------------------------------------------------ */

app.get('/api/sources', (_req, res) => res.json({ items: sourceList }));

/** Búsqueda libre: "jazz", "canciones de Spinetta", "rock psicodélico". */
app.get('/api/discover', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Falta la consulta q=' });
  const sources = req.query.sources ? String(req.query.sources).split(',').filter(Boolean) : null;
  try {
    const items = await searchMusic(q, { limit: Math.min(Number(req.query.limit) || 6, 20), sources });
    res.json({ query: q, items });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * "Pídeme algo parecido": a partir de una canción de la biblioteca devuelve
 * propuestas del mismo autor o del mismo estilo.
 *   /api/similar?track=ID&mode=style|artist
 */
app.get('/api/similar', async (req, res) => {
  const track = req.query.track ? getTrack(String(req.query.track)) : null;
  const mode = req.query.mode === 'artist' ? 'artist' : 'style';
  let q = String(req.query.q || '').trim();
  if (!q) {
    if (!track) return res.status(400).json({ error: 'Indica track=ID o q=consulta' });
    q = similarQuery(track, mode);
  }
  try {
    const limit = Math.min(Number(req.query.limit) || 6, 20);
    let items = [];
    let alt = null; // resultados de respaldo (solo YouTube)
    let tried = [q];
    const deadline = Date.now() + 15_000; // presupuesto total de la consulta
    // Si la consulta compuesta (género + autor) no rinde, probamos con
    // variantes más sueltas hasta encontrar algo.
    if (track && !String(req.query.q || '').trim()) {
      const variants = [q];
      // modo estilo → primero el género (es lo que define "estilo"), luego el autor
      if (mode !== 'artist' && track.genre) variants.push(track.genre);
      if (track.artist && track.artist !== 'Desconocido') variants.push(track.artist);
      if (mode === 'artist' && track.genre) variants.push(track.genre);
      if (track.title) variants.push(track.title);
      for (const v of variants) {
        if (!v || tried.includes(v)) continue;
        if (Date.now() > deadline) break;
        tried.push(v);
        const r = await searchMusic(v, { limit });
        // Se prefiere lo que encuentren los sitios libres; solo si ninguna
        // variante rinde se recurre a los resultados de YouTube (respaldo).
        if (r.some((it) => it.source !== 'youtube')) { items = r; q = v; break; }
        if (r.length && !alt) alt = { items: r, q: v };
      }
      if (!items.length && alt) { items = alt.items; q = alt.q; }
    } else {
      items = await searchMusic(q, { limit });
    }
    res.json({
      query: q,
      mode,
      seed: track ? { id: track.id, title: track.title, artist: track.artist, genre: track.genre } : null,
      tried,
      items,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/** Encola la descarga de un resultado de búsqueda. */
app.post('/api/download', (req, res) => {
  const item = req.body?.item;
  if (!item || !item.source || !item.sourceId) {
    return res.status(400).json({ error: 'Falta item (resultado de /api/discover)' });
  }
  const job = enqueue(item);
  console.log(`[queue] ${clientIP(req)} pide: ${item.artist} - ${item.title} [${item.source}]`);
  res.status(201).json(job);
});

/** Descarga en lote (por ejemplo, todo lo que devolvió una búsqueda). */
app.post('/api/download/batch', (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 25) : [];
  if (!items.length) return res.status(400).json({ error: 'Falta items[]' });
  const jobs = items.filter((i) => i.source && i.sourceId).map((i) => enqueue(i));
  res.status(201).json({ queued: jobs.length, jobs });
});

app.get('/api/queue', (_req, res) => res.json({ items: getJobs() }));
app.delete('/api/queue', (_req, res) => res.json({ removed: clearFinished() }));
app.post('/api/queue/:id/cancel', (req, res) => {
  const ok = cancelJob(req.params.id);
  res.json({ ok, job: getJob(req.params.id) });
});

/* ------------------------------------------------------------------ */
/* Estáticos: la PWA                                                   */
/* ------------------------------------------------------------------ */

app.use((req, res, next) => {
  const ext = path.extname(req.path).toLowerCase();
  if (MIME[ext]) res.setHeader('Content-Type', MIME[ext]);
  next();
});

app.use(express.static(PUBLIC_DIR, { index: 'index.html', maxAge: '1h', etag: true }));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'No existe' });
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.use((err, _req, res, _next) => {
  console.error('[server]', err);
  res.status(500).json({ error: err.message || 'Error interno' });
});

/* ------------------------------------------------------------------ */
/* Arranque                                                            */
/* ------------------------------------------------------------------ */

function localIPs() {
  const out = [];
  for (const [, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

const httpServer = http.createServer(app);
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎵  ${APP_NAME} escuchando en http://0.0.0.0:${PORT}`);
  const ips = localIPs();
  if (ips.length) {
    console.log(`   Móvil (misma red WiFi): http://${ips[0]}:${PORT}`);
  }
  console.log(`   Local:                   http://localhost:${PORT}`);
  console.log(`   Biblioteca:              ${LIBRARY_DIR}`);
});

// HTTPS: necesario para instalar la PWA (el Service Worker exige HTTPS
// salvo en localhost). Si no hay certificados, se usa solo HTTP.
const certFile = path.join(CERT_DIR, 'cert.pem');
const keyFile = path.join(CERT_DIR, 'key.pem');
if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
  https
    .createServer({ cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) }, app)
    .listen(HTTPS_PORT, '0.0.0.0', () => {
      const ips = localIPs();
      console.log(`   PWA instalable (HTTPS):   https://${ips[0] || 'localhost'}:${HTTPS_PORT}`);
      console.log('   (acepta el certificado auto-firmado en el móvil una vez)\n');
    });
} else {
  console.log('   ⚠  Sin certificados HTTPS: ejecuta `npm run certs` para instalar la PWA.\n');
}

/* Escaneo inicial (no bloquea el arranque) y periódico. */
setTimeout(() => runScan({ classify: true }).catch((e) => console.error('[scan]', e)), 1500);
const PERIODIC_MS = Number(process.env.SCAN_INTERVAL_MIN || 30) * 60_000;
setInterval(() => {
  if (!scanState.running) runScan({ classify: true }).catch(() => {});
}, PERIODIC_MS);

// Escaneo por cada archivo nuevo que aparezca en la biblioteca sin reiniciar
let lastCount = 0;
setInterval(() => {
  try {
    const n = allTracks().length;
    if (n !== lastCount) lastCount = n;
  } catch { /* noop */ }
}, 60_000);

