import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

// Carpeta de almacenamiento de MP3.
// Se puede sobreescribir con MUSIC_LIBRARY_DIR para apuntar a otra carpeta.
export const LIBRARY_DIR =
  process.env.MUSIC_LIBRARY_DIR || path.join(os.homedir(), 'Music', 'ServidorMusica', 'biblioteca');

// Carpeta de trabajo del servidor (catálogo, cola de descargas, certs)
export const DATA_DIR = process.env.MUSIC_DATA_DIR || path.join(ROOT, 'data');
export const CERT_DIR = path.join(DATA_DIR, 'certs');

export const CATALOG_FILE = path.join(DATA_DIR, 'catalog.json');
export const QUEUE_FILE = path.join(DATA_DIR, 'queue.json');
export const PUBLIC_DIR = path.join(ROOT, 'public');

export const PORT = Number(process.env.PORT || 8787);
export const HTTPS_PORT = Number(process.env.HTTPS_PORT || 8443);

export const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wav']);

// Límites de descarga para no llenar el disco
export const MAX_DOWNLOAD_BYTES = 150 * 1024 * 1024;

export const APP_NAME = 'MiMúsica';
export const APP_ID = 'com.coredevx.mimusica';

export function ensureDirs() {
  for (const dir of [DATA_DIR, LIBRARY_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
