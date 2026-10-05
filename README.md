# 🎵 Mi Música — servidor personal estilo Spotify

Sirve tu música desde esta Mac y escúchala en el celular Android con una PWA
instalable. El servidor cataloga solo los MP3 que no están clasificados y puede
descargar más canciones a petición tuya desde fuentes gratuitas; si esas fuentes
no encuentran lo que pides, recurre a **YouTube** y extrae el MP3 del vídeo.

---

## Arranque rápido

```bash
cd music-server
npm install        # solo la primera vez
npm run certs      # solo la primera vez: certificado HTTPS para instalar la PWA
npm start
```

Para el respaldo de YouTube hace falta además (opcional):

```bash
brew install yt-dlp ffmpeg
```

Al arrancar imprime algo como:

```
🎵  MiMúsica escuchando en http://0.0.0.0:8787
   Móvil (misma red WiFi): http://192.168.100.10:8787
   PWA instalable (HTTPS):   https://192.168.100.10:8443
   Biblioteca:              /Users/…/Music/ServidorMusica/biblioteca
```

Usa la URL **HTTPS** en el móvil (la necesaria para instalar la PWA).

---

## Carpeta de almacenamiento de MP3

Por defecto:

```
~/Music/ServidorMusica/biblioteca/
├── EIME/Descargas/Siberian Jazz.mp3
├── Otro Artista - Título.mp3
└── Artista/Álbum/01 - Canción.mp3
```

- **Añade tus MP3 ahí** (a mano, arrastrando) y pulsa **Cola → Escanear
  biblioteca**. También se reescanea solo cada 30 min.
- Para usar otra carpeta, define la variable de entorno antes de arrancar:

```bash
MUSIC_LIBRARY_DIR="/ruta/a/tu/musica" npm start
```

Se admiten `.mp3`, `.m4a`, `.aac`, `.flac`, `.ogg`, `.opus`, `.wav`.

---

## Autoclasificación de canciones sin clasificar

Cuando un archivo **no trae etiquetas** (o trae título pero no artista), el
servidor infiere los metadatos y **los escribe en el propio ID3**:

| Situación | Cómo se resuelve |
|---|---|
| `Spinetta - Juras que nunca más.mp3` | artista = `Spinetta`, título = `Juras que nunca más` |
| `Artista/Álbum/01 - Canción.mp3` | artista = `Artista`, álbum = `Álbum`, título = `Canción` |
| `01. Título.mp3` dentro de `Artista/Álbum/` | artista = `Artista` |
| `pista_sin_nada.mp3` en la raíz | queda **sin clasificar** (no hay nada que inferir) |

Solo se reescribe el ID3 **una vez por fichero**, así que los escaneos sucesivos
no tocan nada. Lo que siga sin resolver se lista en **Ajustes → sin clasificar**.

Acciones:

- **Cola → Escanear biblioteca** (o `POST /api/scan`)
- **Ajustes → Reescanear y autoclasificar**
- Terminal: `npm run scan`

---

## Pedir canciones (búsqueda y descarga)

Pestaña **Pedir**: escribe un autor, un estilo o un título
(`Spinetta`, `jazz instrumental`, `blues…`) y pulsa **Buscar**. Cada resultado
tiene un botón **＋** que lo manda a la cola; el servidor lo descarga, escribe
las etiquetas, lo coloca en `biblioteca/Artista/Álbum/` y lo indexa.

El selector **Buscar en** (junto a la caja de búsqueda) decide dónde mirar:

| Opción | Qué hace |
|---|---|
| **Todas** (por defecto) | sitios libres primero y **YouTube al final** |
| **Sitios libres** | solo Internet Archive, Audius y Jamendo |
| **YouTube** | solo la búsqueda en YouTube (MP3 extraído del vídeo) |

Pestaña **Similares**: elige una canción tuya y busca **mismo estilo** o
**mismo autor**.

### Fuentes usadas

| Fuente | Contenido | Sin configuración |
|---|---|---|
| **Internet Archive** | dominio público, Creative Commons, material cedido | sí |
| **Audius** | artistas independientes con descargas abiertas | sí |
| **Jamendo** | catálogo Creative Commons | requiere `JAMENDO_CLIENT_ID` |
| **YouTube** (respaldo) | búsqueda de vídeo + MP3 extraído con yt-dlp/ffmpeg | requiere `brew install yt-dlp ffmpeg` |

YouTube se consulta **siempre** en todas las búsquedas, pero sus resultados van
**al final** de la lista: primero aparece lo que encuentren los sitios libres.
En **Similares** se prefiere también lo libre y solo se usan los vídeos de
YouTube cuando ninguna variante de la consulta rinde en los sitios libres.

Si `yt-dlp` o `ffmpeg` no están instalados, el respaldo se desactiva solo y el
servidor funciona exactamente igual que antes: el chip **YouTube** aparece
apagado y debajo del selector se explica el motivo.

```bash
JAMENDO_CLIENT_ID=tu-clave npm start   # opcional
```

---

## Acceso desde el celular Android

1. Ambos dispositivos en la **misma red WiFi**.
2. Abre **Chrome** en el móvil y visita `https://192.168.100.10:8443`
   (la IP que imprime el servidor al arrancar).
3. Aparecerá el aviso de certificado autofirmado. Dilo:
   - **«Avanzado → Continuar»** en el móvil, o
   - escribe `thisisunsafe` en la pantalla de error, o
   - mejor: instala el certificado como de confianza
     (Ajustes → Seguridad → **Instalar certificado de seguridad**) para que no
     vuelva a avisar.
4. En Chrome: menú ⋮ → **Instalar aplicación** (o el banner «Añadir a
   pantalla de inicio»).
5. Ya tienes el icono en el launcher, se abre a pantalla completa y reproduce
   con la pantalla apagada (controles en el bloqueo vía *Media Session*).

### Si prefieres solo HTTP (sin instalar)

`http://192.168.100.10:8787` funciona para escuchar, pero **Chrome no registra
el Service Worker sin HTTPS**, así que no se podrá instalar como app.

---

## API

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/health` | estado, estadísticas y del escaneo |
| GET | `/api/tracks?q=&artist=&album=&genre=&limit=&offset=` | buscar en la biblioteca |
| GET | `/api/track/:id` | metadatos de una pista |
| GET | `/api/track/:id/download` | descargar el MP3 al móvil |
| GET | `/api/facets` | artistas, álbumes, géneros, años |
| GET | `/api/stats` · `/api/unclassified` | estadísticas / sin clasificar |
| GET | `/api/stream/:id` | audio con soporte **HTTP Range** (seek) |
| POST | `/api/scan` | escanear + autoclasificar (`{"classify":true}`) |
| GET | `/api/scan/status` | progreso del escaneo |
| GET | `/api/sources` | fuentes disponibles |
| GET | `/api/discover?q=blues&limit=8&sources=youtube` | buscar en internet (`sources`: `archive,audius,jamendo,youtube`, opcional) |
| GET | `/api/similar?track=ID&mode=style\|artist` | proponer parecidas |
| POST | `/api/download` | encolar una descarga (`{"item":{…}}`) |
| POST | `/api/download/batch` | encolar hasta 25 a la vez |
| GET/DELETE | `/api/queue` | ver / limpiar la cola |
| POST | `/api/queue/:id/cancel` | cancelar un trabajo |

---

## Configuración

| Variable | Por defecto | Descripción |
|---|---|---|
| `MUSIC_LIBRARY_DIR` | `~/Music/ServidorMusica/biblioteca` | carpeta de MP3 |
| `PORT` | `8787` | puerto HTTP |
| `HTTPS_PORT` | `8443` | puerto HTTPS |
| `SCAN_INTERVAL_MIN` | `30` | escaneo automático (minutos) |
| `JAMENDO_CLIENT_ID` | — | habilita la fuente Jamendo |

## Estructura

```
music-server/
├── server.js            Express: API, streaming con Range, estáticos
├── src/
│   ├── config.js        rutas, puertos, extensiones
│   ├── catalog.js       catálogo JSON en memoria: alta, búsqueda, facets
│   ├── scanner.js       escaneo + inferencia y escritura de ID3
│   ├── providers.js     Internet Archive, Audius, Jamendo, YouTube
│   ├── youtube.js       respaldo: busca el vídeo y extrae el MP3 (yt-dlp)
│   └── downloader.js    cola de descargas con progreso y cancelación
├── public/              la PWA (index.html, app.js, styles.css, sw.js, manifest)
├── scripts/             scan, gen-certs, gen-icons
└── data/                catalog.json, queue.json, certs/
```

## Solución de problemas

- **«Sin conexión con el servidor»** — revisa el firewall de macOS cuando
  pregunte por `node`; comprueba que el móvil está en la misma red.
- **No se instala la PWA** — hace falta HTTPS (`npm run certs` y usar la URL
  `https://…:8443`), que sea de confianza, y que el manifest y el Service
  Worker carguen sin errores.
- **No suena nada** — en Android, ajusta el volumen tras tocar reproducir una
  vez; el primer gesto también desbloquea la reproducción automática.
- **Reiniciar el catálogo** — para con el servidor y borra
  `data/catalog.json`; el siguiente arranque lo reconstruye desde los ficheros.

> **Nota legal**: las fuentes libres (Internet Archive, Audius, Jamendo) solo
> ofrecen música de dominio público, con licencia Creative Commons o cedida por
> su autor. El respaldo de **YouTube** extrae el audio de un vídeo para tu
> biblioteca personal: va en contra de los Términos de Servicio de YouTube y,
> según el país, puede requerir que ya seas titular de la obra. Úsalo bajo tu
> responsabilidad y solo para contenido que te corresponda.
