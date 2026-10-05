/**
 * Respaldo en YouTube: cuando los sitios libres no dan resultado, se busca el
 * vídeo en YouTube y se obtiene el MP3 de su audio.
 *
 * Requiere dos binarios instalados (brew install yt-dlp ffmpeg):
 *   - yt-dlp  → búsqueda (ytsearch) y descarga del audio del vídeo
 *   - ffmpeg  → conversión a MP3 (yt-dlp lo invoca como postproceso)
 *
 * Si no están instalados, este módulo se desactiva solo: la búsqueda devuelve
 * [] y el resto de fuentes sigue funcionando igual que antes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MAX_DOWNLOAD_BYTES } from './config.js';

const execFileAsync = promisify(execFile);

/** Límite de tiempo de la búsqueda (un vídeo muy largo no debe colgar la cola). */
const SEARCH_TIMEOUT_MS = 30000;
/** Límite de tiempo de descarga + conversión. */
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

/* ------------------------------------------------------------------ */
/* Localización de los binarios                                        */
/* ------------------------------------------------------------------ */

const TOOL_DIRS = [
  ...(process.env.PATH || '').split(path.delimiter).filter(Boolean),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
];

const toolCache = new Map();

function findTool(name) {
  if (toolCache.has(name)) return toolCache.get(name);
  let found = null;
  for (const dir of TOOL_DIRS) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      found = candidate;
      break;
    } catch { /* siguiente directorio */ }
  }
  toolCache.set(name, found);
  return found;
}

/** ¿Está listo el respaldo de YouTube? Devuelve { ok, reason }. */
export function youtubeStatus() {
  if (!findTool('yt-dlp')) return { ok: false, reason: 'Falta yt-dlp (brew install yt-dlp)' };
  if (!findTool('ffmpeg')) return { ok: false, reason: 'Falta ffmpeg (brew install ffmpeg)' };
  return { ok: true, reason: null };
}

export const youtubeReady = () => youtubeStatus().ok;

/* ------------------------------------------------------------------ */
/* Búsqueda                                                            */
/* ------------------------------------------------------------------ */

function clean(s) {
  return (s || '').toString().replace(/\s+/g, ' ').trim();
}

/**
 * El título de un vídeo suele ser "Artista - Canción (videoclip)".
 * Si trae ese patrón se separa, así las etiquetas ID3 quedan mejores que
 * dejando el título entero como "artista".
 */
function parseVideo(rawTitle, fallbackArtist) {
  const raw = clean(rawTitle).replace(/\s*\((?:official\s+)?(?:audio|video|lyric[s]?|mv)\)$/i, '');
  const m = /^(.{2,70}?)\s*[-–—]\s+(.{1,140})$/.exec(raw);
  const leftOk =
    m &&
    /[a-záéíóúüñ]/i.test(m[1]) &&
    !/^[\d\s.\-/]+$/.test(m[1]) &&
    !/^(official|live|hd|video)\b/i.test(m[1]);
  if (leftOk) {
    return { artist: clean(m[1]), title: clean(m[2]) };
  }
  return { title: raw, artist: clean(fallbackArtist) || 'Desconocido' };
}

/**
 * Busca en YouTube con `yt-dlp ytsearchN:consulta`.
 * Devuelve el mismo formato que el resto de fuentes de providers.js.
 */
export async function searchYouTube(query, limit = 6) {
  if (!youtubeReady()) return [];
  const ytdlp = findTool('yt-dlp');
  const n = Math.min(Math.max(Number(limit) || 6, 1), 20);

  let data;
  try {
    const { stdout } = await execFileAsync(
      ytdlp,
      [
        '--dump-single-json',
        '--flat-playlist',      // no resuelve cada vídeo: solo metadatos de la búsqueda
        '--no-warnings',
        '--playlist-end', String(n),
        `ytsearch${n}:${query}`,
      ],
      { timeout: SEARCH_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }
    );
    data = JSON.parse(stdout);
  } catch (err) {
    console.warn('[youtube] búsqueda fallida:', err.message);
    return [];
  }

  const entries = Array.isArray(data?.entries) ? data.entries : [];
  const out = [];

  for (const e of entries) {
    if (out.length >= n) break;
    if (!e || !e.id) continue;
    // Las entradas sin duración suelen ser listas de reproducción, no vídeos.
    if (!e.duration || Number(e.duration) <= 0) continue;

    const channel = clean(e.channel) || clean(e.uploader) || clean(e.artist);
    const artistFromChannel = channel.replace(/\s*-\s*Topic$/i, '').trim();
    const { artist, title } = parseVideo(e.title, artistFromChannel);

    out.push({
      source: 'youtube',
      sourceId: e.id,
      title: title || 'Sin título',
      artist: artist || 'Desconocido',
      album: '',
      year: e.upload_date ? String(e.upload_date).slice(0, 4) : null,
      duration: Math.round(Number(e.duration)) || 0,
      providerUrl: `https://www.youtube.com/watch?v=${e.id}`,
      downloadUrl: null,
      canDownload: true,
      kind: 'video',
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Descarga del MP3 del vídeo                                          */
/* ------------------------------------------------------------------ */

function cleanup(dir, base) {
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(base)) fs.rmSync(path.join(dir, f), { force: true });
    }
  } catch { /* nada que limpiar */ }
}

/**
 * Descarga el audio de un vídeo de YouTube y lo convierte a MP3 en `dest`.
 * Soporta progreso (job.progress / job.message) y cancelación (job.abort).
 * @param {object} dl     resultado de resolveYouTube()
 * @param {string} dest   ruta final .mp3
 * @param {object} job    trabajo de la cola (progreso / cancelación)
 * @returns {Promise<number>} bytes escritos
 */
export function downloadYouTubeAudio(dl, dest, job) {
  return new Promise((resolve, reject) => {
    const ytdlp = findTool('yt-dlp');
    const ffmpeg = findTool('ffmpeg');
    if (!ytdlp || !ffmpeg) {
      reject(new Error(youtubeStatus().reason || 'yt-dlp / ffmpeg no instalados'));
      return;
    }

    const dir = path.dirname(dest);
    // Nombre temporal propio: evita que el título del vídeo (con caracteres
    // raros o "%") rompa la plantilla de salida de yt-dlp.
    const base = `ytdl-tmp-${(job.id || 'x').slice(0, 8)}`;
    const template = path.join(dir, `${base}.%(ext)s`);

    const args = [
      '-x',                          // solo el audio
      '--audio-format', 'mp3',
      '--audio-quality', '5',        // ~130 kb/s: equilibrio tamaño/calidad
      '--no-playlist',
      '--no-warnings',
      '--newline',                   // progreso en líneas, sin ANSI
      '--concurrent-fragments', '4',
      '--retries', '3',
      '--ffmpeg-location', ffmpeg,
      '--max-filesize', String(MAX_DOWNLOAD_BYTES),
      '-o', template,
      dl.url,
    ];

    const child = spawn(ytdlp, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let errBuf = '';
    let timedOut = false;
    let killed = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, DOWNLOAD_TIMEOUT_MS);

    // Cancelación tolerante a silencio: si yt-dlp no emite nada (por ejemplo
    // mientras resuelve el vídeo), igual hay que poder matarlo en cuanto el
    // usuario pida cancelar.
    const killer = setInterval(() => {
      if (job.abort && !killed) {
        killed = true;
        child.kill('SIGTERM');
        setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 3000).unref();
      }
    }, 400);

    const step = (text) => {
      const pct = /\[download\]\s+([\d.]+)%/.exec(text);
      if (pct) {
        const p = parseFloat(pct[1]);
        if (Number.isFinite(p)) {
          job.progress = Math.min(0.85, (p / 100) * 0.85);
          job.message = `Descargando el audio de YouTube… ${p.toFixed(0)}%`;
        }
        return;
      }
      if (/\[ExtractAudio\]|Converting|Destination:.*\.mp3/.test(text)) {
        job.progress = Math.max(job.progress || 0, 0.88);
        job.message = 'Convirtiendo a MP3…';
      }
    };

    child.stdout.on('data', (d) => {
      const text = d.toString();
      if (job.abort && !killed) { killed = true; child.kill('SIGTERM'); }
      for (const line of text.split('\n')) if (line.trim()) step(line);
    });
    child.stderr.on('data', (d) => {
      errBuf = (errBuf + d.toString()).slice(-4096);
      if (job.abort && !killed) { killed = true; child.kill('SIGTERM'); }
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      clearInterval(killer);
      cleanup(dir, base);
      reject(new Error(`No se pudo ejecutar yt-dlp: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      clearInterval(killer);
      const tmpBase = path.join(dir, base);

      if (job.abort) {
        cleanup(dir, base);
        reject(new Error('Cancelado'));
        return;
      }
      if (timedOut) {
        cleanup(dir, base);
        reject(new Error('Tiempo de espera agotado descargando de YouTube'));
        return;
      }

      const produced = `${tmpBase}.mp3`;
      if (code !== 0 || !fs.existsSync(produced)) {
        cleanup(dir, base);
        const hint = /sign in|confirm you|not available|unavailable|age/i.test(errBuf)
          ? ' — el vídeo no está disponible para descarga'
          : '';
        const detail = (errBuf.split('\n').filter(Boolean).pop() || `código ${code}`) + hint;
        reject(new Error(`yt-dlp falló: ${detail}`));
        return;
      }

      try {
        fs.renameSync(produced, dest);
        cleanup(dir, base);
        const size = fs.statSync(dest).size;
        job.progress = 0.95;
        resolve(size);
      } catch (err) {
        cleanup(dir, base);
        reject(new Error(`No se pudo guardar el MP3: ${err.message}`));
      }
    });
  });
}
