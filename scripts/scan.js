/**
 * Escanea la biblioteca desde la terminal:
 *   npm run scan
 */
import { ensureDirs, LIBRARY_DIR } from '../src/config.js';
import { runScan } from '../src/scanner.js';
import { stats, facets } from '../src/catalog.js';

ensureDirs();
console.log('Biblioteca:', LIBRARY_DIR);

const res = await runScan({ classify: true });
console.log(res);

const st = stats();
console.log('\nCatálogo:');
console.log(`  canciones:      ${st.tracks}`);
console.log(`  sin clasificar: ${st.unclassified}`);
console.log(`  tamaño:         ${(st.totalBytes / 1e9).toFixed(2)} GB`);
console.log(`  duración:       ${(st.durationSeconds / 3600).toFixed(1)} h`);

const f = facets();
console.log(`  artistas:       ${f.artists.length}`);
console.log(`  géneros:        ${f.genres.length}`);
