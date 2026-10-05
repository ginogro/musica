/* PWA de Mi Música: catálogo, petición de canciones y reproductor. */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const state = {
  view: 'library',
  libMode: 'all',
  discoSrc: 'all',
  tracks: [],
  facets: null,
  queue: [],
  // Reproducción
  list: [],       // cola de reproducción actual
  idx: -1,
  playing: false,
  shuffle: false,
  repeat: 'off',  // off | one | all
  seeking: false,
  deferredPrompt: null,
};

/* ---------------- API ---------------- */

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}

function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), ms);
}

function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
           : `${m}:${String(s).padStart(2, '0')}`;
}
function fmtBytes(b) {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------- navegación ---------------- */

function setView(name) {
  state.view = name;
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  window.scrollTo({ top: 0 });
  if (name === 'discover') setTimeout(() => $('#discoSearch').focus(), 120);
  if (name === 'similar') loadSeedSelect();
  if (name === 'queue') { refreshQueue(); refreshScan(); }
  if (name === 'settings') refreshStats();
  if (name === 'library') loadLibrary();
}

$$('.tab').forEach((t) => t.addEventListener('click', () => setView(t.dataset.view)));

/* ---------------- biblioteca ---------------- */

function rowHTML(t, i, opts = {}) {
  const playing = state.list[state.idx]?.id === t.id;
  const dur = t.duration ? `<span class="dur">${fmtTime(t.duration)}</span>` : '';
  const badge = opts.showUncls && !t.classified
    ? '<span class="badge">sin clasificar</span>' : '';
  return `<div class="row ${playing ? 'playing' : ''}" data-i="${i}">
    <div class="art">♪</div>
    <div class="meta">
      <div class="t1">${esc(t.title)} ${badge}</div>
      <div class="t2">${esc(t.artist)}${t.album && t.album !== 'Sin álbum' ? ' · ' + esc(t.album) : ''}</div>
    </div>
    ${dur}
  </div>`;
}

function emptyHTML(msg) {
  return `<div class="empty">${msg}</div>`;
}

async function loadLibrary(force = false) {
  const q = $('#libSearch').value.trim();
  const summary = $('#libSummary');
  const listEl = $('#libList');
  const gridEl = $('#libArtists');

  if (state.libMode === 'artists' || state.libMode === 'genres' || state.libMode === 'albums') {
    listEl.innerHTML = '';
    gridEl.classList.remove('hidden');
    if (!state.facets || force) state.facets = await api('/api/facets');
    const key = state.libMode;
    const items = state.facets[key] || [];
    summary.textContent = `${items.length} ${key === 'genres' ? 'géneros' : key === 'albums' ? 'álbumes' : 'artistas'}`;
    const ico = key === 'genres' ? '🎛' : key === 'albums' ? '💿' : '🎤';
    gridEl.innerHTML = items.length
      ? items.map((x) => `<div class="gcard" data-name="${esc(x.name)}" data-key="${key}">
          <div class="ico">${ico}</div>
          <div class="n">${esc(x.name)}</div><div class="c">${x.count} canciones</div>
        </div>`).join('')
      : emptyHTML('Aún no hay nada catalogado.');
    $$('.gcard', gridEl).forEach((c) => c.addEventListener('click', () => {
      $('#libSearch').value = c.dataset.name;
      state.libMode = 'all';
      $$('#libChips .chip').forEach((x) => x.classList.toggle('active', x.dataset.lib === 'all'));
      gridEl.classList.add('hidden');
      listEl.classList.remove('hidden');
      loadLibrary();
    }));
    return;
  }

  gridEl.classList.add('hidden');
  const params = new URLSearchParams({ q, limit: '300' });
  const data = await api(`/api/tracks?${params}`);
  state.tracks = data.items;

  if (state.libMode === 'recent') {
    state.tracks = [...state.tracks].sort((a, b) => b.addedAt - a.addedAt).slice(0, 100);
  }

  const st = await api('/api/stats');
  summary.textContent = q
    ? `${data.total} resultado(s) para «${q}»`
    : `${st.tracks} canciones · ${fmtBytes(st.totalBytes)} · ${fmtTime(st.durationSeconds)} de audio`;

  listEl.innerHTML = state.tracks.length
    ? state.tracks.map((t, i) => rowHTML(t, i)).join('')
    : emptyHTML(q ? 'Nada coincide con tu búsqueda.'
        : 'Tu biblioteca está vacía.<br>Ve a <strong>Pedir</strong> para descargar música, o pulsa <strong>Escanear</strong> en Cola.');

  $$('.row', listEl).forEach((r) =>
    r.addEventListener('click', () => playFrom(state.tracks, Number(r.dataset.i))));
}

$$('#libChips .chip').forEach((c) => c.addEventListener('click', () => {
  state.libMode = c.dataset.lib;
  $$('#libChips .chip').forEach((x) => x.classList.toggle('active', x === c));
  loadLibrary();
}));

let searchTimer = null;
$('#libSearch').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadLibrary(), 260);
});

/* ---------------- pedir música (descubrir) ---------------- */

const SRC_LABELS = { archive: 'Archivo', audius: 'Audius', jamendo: 'Jamendo', youtube: 'YouTube' };

function resultRowHTML(item, i) {
  const canDl = item.canDownload !== false;
  const dur = item.duration ? `<span class="dur">${fmtTime(item.duration)}</span>` : '';
  const src = SRC_LABELS[item.source] || item.sourceLabel || item.source;
  return `<div class="row" data-i="${i}">
    <div class="art">⬇</div>
    <div class="meta">
      <div class="t1">${esc(item.title)}</div>
      <div class="t2">${esc(item.artist)} · ${src}${item.genre ? ' · ' + esc(item.genre) : ''}</div>
    </div>
    ${dur}
    <button class="addbtn" ${canDl ? '' : 'disabled title="Sin descarga disponible"'}>＋</button>
  </div>`;
}

function bindResultRows(container, items, onAdd) {
  $$('.row', container).forEach((r) => {
    const i = Number(r.dataset.i);
    const btn = $('.addbtn', r);
    if (btn && !btn.disabled) {
      btn.addEventListener('click', (e) => { e.stopPropagation(); onAdd(items[i], btn); });
    }
  });
}

async function addToLibrary(item, btn) {
  if (btn) { btn.classList.add('busy'); btn.textContent = '…'; btn.disabled = true; }
  try {
    await api('/api/download', { method: 'POST', body: { item } });
    if (btn) { btn.classList.remove('busy'); btn.classList.add('done'); btn.textContent = '✓'; }
    toast(`Encolada: ${item.artist} - ${item.title}`);
    setView('queue');
  } catch (err) {
    if (btn) { btn.classList.remove('busy'); btn.textContent = '＋'; btn.disabled = false; }
    toast('Error: ' + err.message, 4000);
  }
}

async function runDiscover() {
  const q = $('#discoSearch').value.trim();
  if (!q) { toast('Escribe algo: autor, estilo o canción'); return; }
  const src = state.discoSrc || 'all';
  const meta = $('#discoMeta');
  const list = $('#discoList');
  meta.textContent = `Buscando en ${DISCO_SRC_NAME[src]}…`;
  list.innerHTML = '';
  try {
    const extra = DISCO_SRC_PARAM[src] ? `&sources=${DISCO_SRC_PARAM[src]}` : '';
    const data = await api(`/api/discover?q=${encodeURIComponent(q)}&limit=8${extra}`);
    meta.textContent = data.items.length
      ? `${data.items.length} propuestas para «${data.query}» — pulsa ＋ para descargarlas al servidor`
      : src === 'youtube'
        ? 'YouTube no devolvió nada para esa búsqueda. Prueba con otros términos.'
        : 'No encontré nada. Prueba con otros términos o elige «YouTube» arriba.';
    list.innerHTML = data.items.length
      ? data.items.map((it, i) => resultRowHTML(it, i)).join('')
      : emptyHTML('Sin resultados.');
    bindResultRows(list, data.items, addToLibrary);
  } catch (err) {
    meta.textContent = '';
    list.innerHTML = emptyHTML('Error al buscar: ' + esc(err.message));
  }
}

$('#btnDiscoSearch').addEventListener('click', runDiscover);
$('#discoSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') runDiscover(); });
$$('#discoChips .chip').forEach((c) => c.addEventListener('click', () => {
  $('#discoSearch').value = c.dataset.q;
  runDiscover();
}));

/* Selector de dónde buscar: todas las fuentes, solo sitios libres o YouTube. */
const DISCO_SRC_PARAM = { all: '', free: 'archive,audius,jamendo', youtube: 'youtube' };
const DISCO_SRC_NAME = { all: 'fuentes gratuitas y YouTube', free: 'sitios libres', youtube: 'YouTube' };

$$('#discoSources .chip').forEach((c) => c.addEventListener('click', () => {
  if (c.disabled) return;
  state.discoSrc = c.dataset.src;
  $$('#discoSources .chip').forEach((x) => x.classList.toggle('active', x === c));
  if ($('#discoSearch').value.trim()) runDiscover();
}));

/* Si la máquina no tiene yt-dlp/ffmpeg, se desactiva el chip de YouTube
   y se explica el motivo debajo del selector. */
api('/api/sources').then((d) => {
  const yt = (d.items || []).find((s) => s.id === 'youtube');
  if (!yt || yt.available) return;
  const reason = yt.reason || 'YouTube no disponible';
  const chip = $('#discoSources .chip[data-src="youtube"]');
  if (chip) { chip.disabled = true; chip.title = reason; }
  const all = $('#discoSources .chip[data-src="all"]');
  if (all) all.title = `YouTube desactivado: ${reason}`;
  const note = $('#discoSrcNote');
  if (note) { note.textContent = reason; note.classList.remove('hidden'); }
}).catch(() => {});

/* ---------------- similares ---------------- */

let seedCache = [];
async function loadSeedSelect() {
  const sel = $('#seedSelect');
  if (!seedCache.length) {
    const data = await api('/api/tracks?limit=300');
    seedCache = data.items;
  }
  sel.innerHTML = seedCache.length
    ? seedCache.map((t) => `<option value="${t.id}">${esc(t.artist)} — ${esc(t.title)}</option>`).join('')
    : '<option value="">(biblioteca vacía)</option>';
}

let similarMode = 'style';
$$('.row-actions [data-mode]').forEach((b) => b.addEventListener('click', () => {
  similarMode = b.dataset.mode;
  $$('.row-actions [data-mode]').forEach((x) => x.classList.toggle('active', x === b));
  $('#similarModeLabel').textContent = similarMode === 'artist' ? 'autor' : 'estilo';
}));

async function runSimilar() {
  const id = $('#seedSelect').value;
  if (!id) { toast('Elige una canción de tu biblioteca'); return; }
  const meta = $('#similarMeta');
  const list = $('#similarList');
  meta.textContent = 'Buscando parecidas…';
  list.innerHTML = '';
  try {
    const data = await api(`/api/similar?track=${id}&mode=${similarMode}&limit=8`);
    meta.textContent = data.items.length
      ? `«${data.query}» — ${data.items.length} propuestas`
      : 'No encontré parecidas. Prueba el otro modo.';
    list.innerHTML = data.items.length
      ? data.items.map((it, i) => resultRowHTML(it, i)).join('')
      : emptyHTML('Sin resultados.');
    bindResultRows(list, data.items, addToLibrary);
  } catch (err) {
    meta.textContent = '';
    list.innerHTML = emptyHTML('Error: ' + esc(err.message));
  }
}
$('#btnSimilar').addEventListener('click', runSimilar);

/* ---------------- cola de descargas ---------------- */

const STATUS_LABEL = {
  queued: ['En cola', ''], searching: ['Buscando', 'run'], downloading: ['Descargando', 'run'],
  tagging: ['Etiquetando', 'run'], indexing: ['Indexando', 'run'],
  done: ['Completado', 'ok'], error: ['Error', 'err'], cancelled: ['Cancelado', ''],
};

async function refreshQueue() {
  let data;
  try { data = await api('/api/queue'); } catch { return; }
  state.queue = data.items;
  const el = $('#queueList');
  if (!data.items.length) {
    el.innerHTML = emptyHTML('No hay descargas.<br>Ve a <strong>Pedir</strong> o <strong>Similares</strong> para pedir música.');
    return;
  }
  const active = data.items.filter((j) => !['done', 'error', 'cancelled'].includes(j.status)).length;
  el.innerHTML = [...data.items].reverse().map((j) => {
    const [label, cls] = STATUS_LABEL[j.status] || [j.status, ''];
    const pct = j.progress != null ? Math.round(j.progress * 100) : 0;
    const kb = j.bytes ? ` · ${fmtBytes(j.bytes)}${j.totalBytes ? ' / ' + fmtBytes(j.totalBytes) : ''}` : '';
    const showBar = ['downloading'].includes(j.status);
    return `<div class="row" data-id="${j.id}">
      <div class="art">${j.status === 'done' ? '✓' : j.status === 'error' ? '✕' : '↓'}</div>
      <div class="meta">
        <div class="t1">${esc(j.request?.title || '—')}</div>
        <div class="t2">${esc(j.request?.artist || '')} <span class="badge ${cls}">${label}</span></div>
        <div class="t2">${esc(j.message || '')}${kb}</div>
        ${showBar ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ''}
      </div>
      ${j.trackId ? '<button class="addbtn done">▶</button>'
        : ['queued', 'downloading'].includes(j.status) ? '<button class="addbtn cancel">✕</button>' : ''}
    </div>`;
  }).join('');

  $$('.row .cancel', el).forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    const id = b.closest('.row').dataset.id;
    await api(`/api/queue/${id}/cancel`, { method: 'POST' });
    refreshQueue();
  }));
  $$('.row .done', el).forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    const id = b.closest('.row').dataset.id;
    const job = state.queue.find((x) => x.id === id);
    if (job?.trackId) {
      const t = await api(`/api/track/${job.trackId}`);
      playFrom([t], 0, [t]);
    }
  }));

  $('#scanStatus').textContent = active
    ? `${active} descarga(s) en curso — actualiza para ver el progreso`
    : '';
}

async function refreshScan() {
  try {
    const s = await api('/api/scan/status');
    $('#scanStatus').textContent = s.running
      ? `Escaneando… ${s.scanned} archivos`
      : `Último escaneo: ${s.message}`;
  } catch { /* noop */ }
}

$('#btnQueueRefresh').addEventListener('click', () => { refreshQueue(); refreshScan(); });
$('#btnQueueClear').addEventListener('click', async () => {
  await api('/api/queue', { method: 'DELETE' });
  refreshQueue();
});
async function triggerScan() {
  try {
    await api('/api/scan', { method: 'POST', body: { classify: true } });
    toast('Escaneo iniciado: se autoclasificarán las canciones nuevas');
    setTimeout(() => { refreshScan(); loadLibrary(true); }, 1200);
    const iv = setInterval(refreshScan, 1500);
    setTimeout(() => clearInterval(iv), 40000);
  } catch (err) { toast(err.message); }
}
$('#btnRescan').addEventListener('click', triggerScan);
$('#btnRescan2').addEventListener('click', triggerScan);

setInterval(() => { if (state.view === 'queue') refreshQueue(); }, 3000);

/* ---------------- ajustes / estadísticas ---------------- */

async function refreshStats() {
  try {
    const [st, unc] = await Promise.all([api('/api/stats'), api('/api/unclassified')]);
    $('#statsBox').innerHTML = `
      <div class="stat"><div class="v">${st.tracks}</div><div class="k">canciones</div></div>
      <div class="stat"><div class="v">${st.unclassified}</div><div class="k">sin clasificar</div></div>
      <div class="stat"><div class="v">${fmtBytes(st.totalBytes)}</div><div class="k">en disco</div></div>
      <div class="stat"><div class="v">${fmtTime(st.durationSeconds)}</div><div class="k">de audio</div></div>`;
    $('#unclassifiedBox').innerHTML = unc.items.length
      ? `<strong>${unc.items.length} canciones aún sin clasificar.</strong> Pulsa «Reescanear» para que el servidor infiera autor/título desde el nombre del archivo y los escriba en el ID3.`
      : 'Todo el catálogo está clasificado. ✓';
    $('#aboutBox').innerHTML = `
      Servidor en <code>${location.host}</code><br>
      La música se guarda en la Mac, en la carpeta configurada con
      <code>MUSIC_LIBRARY_DIR</code>. El móvil solo envía órdenes:
      la descarga y la indexación las hace el servidor.`;
  } catch (err) { toast(err.message); }
}

/* ---------------- reproductor ---------------- */

const audio = $('#audio');

function trackURL(t) { return `/api/stream/${t.id}`; }

function playFrom(list, i) {
  state.list = list;
  state.idx = i;
  loadTrack(true);
}

function loadTrack(autoPlay) {
  const t = state.list[state.idx];
  if (!t) return;
  audio.src = trackURL(t);
  $('#player').classList.remove('hidden');
  $('#pTitle').textContent = t.title;
  $('#pArtist').textContent = t.artist;
  $('#nowTitle').textContent = t.title;
  $('#nowArtist').textContent = t.artist;
  $('#tDur').textContent = fmtTime(t.duration || 0);
  $('#tDur2').textContent = fmtTime(t.duration || 0);
  setPlaying(autoPlay);
  updateMediaSession(t);
  markPlayingRow();
}

function setPlaying(on) {
  state.playing = on;
  const ic = on ? '⏸' : '▶';
  $('#btnPlay').textContent = ic;
  $('#btnPlay2').textContent = ic;
  if (on) audio.play().catch(() => setPlaying(false));
  else audio.pause();
}

function togglePlay() { setPlaying(!state.playing); }

function next(auto = false) {
  if (!state.list.length) return;
  if (state.repeat === 'one' && auto) { audio.currentTime = 0; audio.play(); return; }
  if (state.shuffle) {
    state.idx = Math.floor(Math.random() * state.list.length);
  } else if (state.idx < state.list.length - 1) {
    state.idx++;
  } else if (state.repeat === 'all') {
    state.idx = 0;
  } else {
    setPlaying(false);
    return;
  }
  loadTrack(true);
}

function prev() {
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  if (state.idx > 0) state.idx--;
  else if (state.repeat === 'all') state.idx = state.list.length - 1;
  loadTrack(true);
}

function markPlayingRow() {
  const t = state.list[state.idx];
  $$('.row').forEach((r) => {
    const i = Number(r.dataset.i);
    r.classList.toggle('playing', Boolean(t) && state.tracks === state.list && state.tracks[i]?.id === t.id);
  });
}

audio.addEventListener('ended', () => next(true));
audio.addEventListener('error', () => {
  if (audio.src) toast('No se pudo reproducir (¿el fichero desapareció?)');
});
audio.addEventListener('pause', () => {
  state.playing = false;
  $('#btnPlay').textContent = '▶';
  $('#btnPlay2').textContent = '▶';
});
audio.addEventListener('play', () => {
  state.playing = true;
  $('#btnPlay').textContent = '⏸';
  $('#btnPlay2').textContent = '⏸';
});

function updateProgress() {
  if (state.seeking) return;
  const d = audio.duration || state.list[state.idx]?.duration || 0;
  const p = d ? (audio.currentTime / d) * 1000 : 0;
  $('#seek').value = p;
  $('#seek2').value = p;
  $('#tCur').textContent = fmtTime(audio.currentTime);
  $('#tCur2').textContent = fmtTime(audio.currentTime);
  if (d) { $('#tDur').textContent = fmtTime(d); $('#tDur2').textContent = fmtTime(d); }
  if ('mediaSession' in navigator && d) {
    try { navigator.mediaSession.setPositionState({ duration: d, position: Math.min(audio.currentTime, d) }); } catch { /* noop */ }
  }
}
setInterval(updateProgress, 500);

function bindSeek(el) {
  const start = () => { state.seeking = true; };
  const end = () => {
    const d = audio.duration || state.list[state.idx]?.duration || 0;
    if (d) audio.currentTime = (Number(el.value) / 1000) * d;
    state.seeking = false;
  };
  el.addEventListener('pointerdown', start);
  el.addEventListener('input', start);
  el.addEventListener('change', end);
  el.addEventListener('pointerup', end);
}
bindSeek($('#seek'));
bindSeek($('#seek2'));

function bindVol(el, other) {
  el.addEventListener('input', () => {
    const v = Number(el.value);
    audio.volume = v / 100;
    if (other) other.value = v;
    try { localStorage.setItem('mm_vol', v); } catch { /* noop */ }
  });
}
bindVol($('#vol'), $('#vol2'));
bindVol($('#vol2'), $('#vol'));
const savedVol = Number(localStorage.getItem('mm_vol') ?? 85);
audio.volume = Math.min(1, Math.max(0, savedVol / 100));
$('#vol').value = savedVol;
$('#vol2').value = savedVol;

/* botones del reproductor */
for (const id of ['#btnPlay', '#btnPlay2']) $(id).addEventListener('click', togglePlay);
for (const id of ['#btnNext', '#btnNext2']) $(id).addEventListener('click', () => next());
for (const id of ['#btnPrev', '#btnPrev2']) $(id).addEventListener('click', prev);

function toggleShuffle() {
  state.shuffle = !state.shuffle;
  for (const id of ['#btnShuffle', '#btnShuffle2']) $(id).classList.toggle('on', state.shuffle);
}
function toggleRepeat() {
  state.repeat = state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off';
  for (const id of ['#btnRepeat', '#btnRepeat2']) {
    $(id).classList.toggle('on', state.repeat !== 'off');
    $(id).textContent = state.repeat === 'one' ? '↻¹' : '↻';
  }
}
for (const id of ['#btnShuffle', '#btnShuffle2']) $(id).addEventListener('click', toggleShuffle);
for (const id of ['#btnRepeat', '#btnRepeat2']) $(id).addEventListener('click', toggleRepeat);

$('#btnExpand').addEventListener('click', () => $('#now').classList.remove('hidden'));
$('#btnCollapse').addEventListener('click', () => $('#now').classList.add('hidden'));
$('#btnDownloadCur').addEventListener('click', () => {
  const t = state.list[state.idx];
  if (t) window.open(`/api/track/${t.id}/download`, '_blank');
});

/* swipe para cerrar la vista ampliada */
let ty0 = null;
$('#now').addEventListener('touchstart', (e) => { ty0 = e.touches[0].clientY; }, { passive: true });
$('#now').addEventListener('touchend', (e) => {
  if (ty0 != null && e.changedTouches[0].clientY - ty0 > 90) $('#now').classList.add('hidden');
  ty0 = null;
}, { passive: true });

function updateMediaSession(t) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title, artist: t.artist, album: t.album || 'Mi Música',
    });
    navigator.mediaSession.setActionHandler('play', () => setPlaying(true));
    navigator.mediaSession.setActionHandler('pause', () => setPlaying(false));
    navigator.mediaSession.setActionHandler('nexttrack', () => next());
    navigator.mediaSession.setActionHandler('previoustrack', prev);
  } catch { /* noop */ }
}

/* ---------------- inicialización ---------------- */

async function healthLoop() {
  try {
    const h = await api('/api/health');
    const el = $('#connStatus');
    el.textContent = `conectado · ${h.stats.tracks} canciones` + (h.scan.running ? ' · escaneando…' : '');
    el.className = 'conn ok';
  } catch {
    const el = $('#connStatus');
    el.textContent = 'sin conexión con el servidor';
    el.className = 'conn err';
  }
}

/* Instalación de la PWA */
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  state.deferredPrompt = e;
  $('#btnInstall').classList.remove('hidden');
});
async function doInstall() {
  if (!state.deferredPrompt) {
    toast('Abre el menú del navegador → «Instalar aplicación»');
    return;
  }
  state.deferredPrompt.prompt();
  await state.deferredPrompt.userChoice;
  state.deferredPrompt = null;
  $('#btnInstall').classList.add('hidden');
}
$('#btnInstall').addEventListener('click', doInstall);
$('#btnInstall2').addEventListener('click', doInstall);

/* Service Worker */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('SW:', e));
  });
}

/* Arranque */
(async function init() {
  await healthLoop();
  setInterval(healthLoop, 10000);
  try { await loadLibrary(); } catch (e) { console.error(e); }
  try {
    const q = await api('/api/queue');
    if (q.items.some((j) => !['done', 'error', 'cancelled'].includes(j.status))) refreshQueue();
  } catch { /* noop */ }
})();
