#!/usr/bin/env bash
# Tauri bundler'in `signCommand` kancasi: WSL yolundaki dosyayi Windows tarafinda
# signtool ile imzalar. Dosya once Windows TEMP'e kopyalanir — UNC uzerinden
# imzalama 9p koprusunde guvenilir degil.
#
# Zaman damgasi sunucusu tek derlemede onlarca istek aldiginda (her NSIS eklentisi
# ayri imzalanir) hiz sinirina takilabiliyor; bu yuzden yeniden deneme var ve son
# care olarak damgasiz imzalaniyor. Damgasiz imza da SAC icin yeterli, yalniz
# sertifika suresi dolunca gecersizlesir.
set -euo pipefail

FILE="$1"
THUMB="${WINDOWSDOCK_CERT_THUMBPRINT:-C111F8943858B938053836E8275672D03E094407}"
TS_URL="${WINDOWSDOCK_TIMESTAMP_URL:-http://timestamp.digicert.com}"

TMP_WIN="$(powershell.exe -NoProfile -Command '$env:TEMP' | tr -d '\r\n')"
TMP_UNIX="$(wslpath -u "$TMP_WIN")"
BASE="wd-sign-$$-$(basename "$FILE")"

cp "$FILE" "$TMP_UNIX/$BASE"

sign_once() {
  local ts_args="$1"
  powershell.exe -NoProfile -Command "
    \$st = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin' -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
           Where-Object { \$_.FullName -like '*x64*' } | Select-Object -Last 1
    if (-not \$st) { Write-Error 'signtool.exe bulunamadi'; exit 1 }
    \$out = & \$st.FullName sign /fd SHA256 /sha1 '$THUMB' $ts_args '$TMP_WIN\\$BASE' 2>&1
    if (\$LASTEXITCODE -ne 0) { Write-Host (\$out -join ' '); }
    exit \$LASTEXITCODE
  "
}

ok=0
for attempt in 1 2 3; do
  if sign_once "/tr '$TS_URL' /td SHA256"; then ok=1; break; fi
  echo "    imzalama denemesi $attempt basarisiz (zaman damgasi), yeniden deneniyor..."
  sleep 3
done

if [ "$ok" -eq 0 ]; then
  echo "    zaman damgasiz imzalaniyor (damga sunucusu yanit vermedi)"
  sign_once "" || { rm -f "$TMP_UNIX/$BASE"; echo "    IMZALAMA BASARISIZ: $(basename "$FILE")" >&2; exit 1; }
fi

cp "$TMP_UNIX/$BASE" "$FILE"
rm -f "$TMP_UNIX/$BASE"
echo "    imzalandi: $(basename "$FILE")"
