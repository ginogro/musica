#!/usr/bin/env bash
# Crea MP3 de prueba (sin etiquetas y con nombres que hay que inferir) para
# verificar la autoclasificación. Usa la API del propio servidor, así que
# antes hay que tenerlo arrancado: npm start
#
#   bash scripts/make-test-mp3.sh
set -euo pipefail

API="${API:-http://localhost:8787}"
LIB="${MUSIC_LIBRARY_DIR:-$HOME/Music/ServidorMusica/biblioteca}"

echo "• Pidiendo una muestra a $API ..."
TRACK_JSON=$(curl -fsS --max-time 60 "$API/api/discover?q=instrumental&sources=audius&limit=1")
ID=$(printf '%s' "$TRACK_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['items'][0]['sourceId'] if d['items'] else '')")
[ -n "$ID" ] || { echo "✗ la API no devolvió resultados" >&2; exit 1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
echo "• Descargando la pista de prueba ..."
curl -fsSL --max-time 120 -o "$TMP/sample.mp3" \
  "$API/api/discover?q=instrumental&sources=audius&limit=1" >/dev/null

# Si el endpoint de stream directo no está, usa la cola del servidor
if ! head -c 3 "$TMP/sample.mp3" | grep -q . || [ ! -s "$TMP/sample.mp3" ]; then
  echo "  (usando la cola de descargas)"
  curl -fsS -X POST "$API/api/download" -H 'Content-Type: application/json' \
    -d "{\"item": $(printf '%s' "$TRACK_JSON" | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin)['items'][0]))")}" >/dev/null
  sleep 15
  FIRST=$(find "$LIB" -name '*.mp3' -type f | head -1)
  [ -n "$FIRST" ] || { echo "✗ no se descargó nada" >&2; exit 1; }
  cp "$FIRST" "$TMP/sample.mp3"
fi

mkdir -p "$LIB/Carpeta Artista/Album de Prueba"
# 1) "Artista - Título" en el nombre → se infiere el artista
cp "$TMP/sample.mp3" "$LIB/Otro Artista - Titulo Inventado.mp3"
# 2) numerado dentro de Artista/Álbum/ → artista = carpeta del abuelo
cp "$TMP/sample.mp3" "$LIB/Carpeta Artista/Album de Prueba/01 - Cancion de Prueba.mp3"
# 3) sin ninguna estructura → debe quedarse SIN clasificar
cp "$TMP/sample.mp3" "$LIB/pista_completamente_sin_nada.mp3"

echo "✓ 3 archivos creados en $LIB"
echo "Ahora: curl -X POST $API/api/scan -H 'Content-Type: application/json' -d '{\"classify\":true}'"
