#!/usr/bin/env bash
# Certificado autofirmado para la LAN: necesario para que Chrome en Android
# registre el Service Worker e instale la PWA (HTTPS es obligatorio fuera
# de localhost).
#
#   npm run certs
#
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/data/certs"
mkdir -p "$DIR"

IPS="$(ipconfig getifaddr en0 2>/dev/null || true) $(ipconfig getifaddr en1 2>/dev/null || true)"
IPS="${IPS// /,}"
IPS="${IPS//,,/,}"
IPS="${IPS#,}"

SAN="DNS:localhost,IP:127.0.0.1"
if [ -n "${IPS:-}" ]; then
  for ip in ${IPS//,/ }; do SAN="$SAN,IP:$ip"; done
fi

if [ -f "$DIR/cert.pem" ] && [ -f "$DIR/key.pem" ]; then
  echo "Los certificados ya existen en $DIR"
  exit 0
fi

echo "Generando certificado autofirmado con SAN: $SAN"
# CA:TRUE es lo que permite instalarlo en Android como
# "Certificado de autoridad de certificación" (Ajustes → Seguridad).
openssl req -x509 -newkey rsa:2048 -sha256 -days 825 -nodes \
  -keyout "$DIR/key.pem" -out "$DIR/cert.pem" \
  -subj "/CN=mimusica.local/O=MiMusica" \
  -addext "subjectAltName=$SAN" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
  -addext "keyUsage=critical,keyCertSign,cRLSign,digitalSignature" \
  -addext "extendedKeyUsage=serverAuth" 2>/dev/null

printf '\nPara que el móvil no avise del certificado, copia este fichero al celular\ne instálalo: Ajustes → Seguridad → Instalar certificado → Certificado de autoridad (CA)\n  %s\n' "$DIR/cert.pem"

chmod 600 "$DIR/key.pem"
echo "✓ $DIR/cert.pem"
echo
echo "Ahora reinicia el servidor y abre https://<ip-de-la-mac>:8443 desde el móvil."
echo "Acepta el certificado (Añadir excepción / visitar) y luego instala la PWA."
