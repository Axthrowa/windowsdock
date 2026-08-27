#!/usr/bin/env bash
# WSL'den Windows hedefi icin tam surum uretimi:
#   1) portable  -> imzali tek exe (MSVC hedefinde ek DLL gerekmez)
#   2) setup     -> imzali NSIS kurulum sihirbazi (icindeki exe de imzali)
#
# Imzasiz binary Smart App Control tarafindan bloklanir; imzalama opsiyonel
# bir adim degil, hattin parcasi.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# MSVC hedefi bilincli bir secim: MinGW cikti profili Defender/Smart App Control
# itibarinda kotu duruyor ve imzali olsa bile bloklaniyordu; MSVC bagli binary
# hem geciyor hem de WebView2Loader.dll'i statik alarak tek dosya oluyor.
# Derleme WSL'den cargo-xwin (clang-cl + lld-link) ile yapiliyor, VS gerekmiyor.
TARGET="${WINDOWSDOCK_TARGET:-x86_64-pc-windows-msvc}"
BUILD="$ROOT/src-tauri/target/$TARGET/release"

# Linux host'ta Windows paketi uretmek icin gereken yerel arac zinciri.
NSIS_HOME="${WINDOWSDOCK_NSIS_HOME:-$HOME/.local/opt/nsis}"
export PATH="$NSIS_HOME/wrap:$PATH"
export PKG_CONFIG_PATH="$NSIS_HOME/pkgconfig:${PKG_CONFIG_PATH:-}"
# Bundler eklenti klasorunu buradan kopyalar; ayarlanmazsa /usr/share/nsis arar.
export NSISDIR="$NSIS_HOME/share/nsis"
export NSISCONFDIR="$NSISDIR"
# Tauri CLI, Linux host'ta hedef Windows olsa bile appindicator ariyor (CLI hatasi).
export TAURI_LINUX_AYATANA_APPINDICATOR=true

WIN_USER="$(powershell.exe -NoProfile -Command '$env:USERNAME' | tr -d '\r\n')"
OUT_UNIX="${WINDOWSDOCK_DEST:-/mnt/c/Users/$WIN_USER/Desktop/WindowsDock}"
PORTABLE="$OUT_UNIX/portable"
SETUP="$OUT_UNIX/setup"

echo "==> calisan ornegi kapat"
powershell.exe -NoProfile -Command "Get-Process WindowsDock -ErrorAction SilentlyContinue | Stop-Process -Force" >/dev/null 2>&1 || true

echo "==> frontend"
cd "$ROOT" && npm run build

echo "==> portable binary ($TARGET)"
cd "$ROOT/src-tauri"
cargo xwin build --release --target "$TARGET" --features custom-protocol

echo "==> portable imzalama"
cd "$ROOT"
bash scripts/sign.sh "$BUILD/windowsdock.exe"

rm -rf "$PORTABLE"
mkdir -p "$PORTABLE"
cp "$BUILD/windowsdock.exe" "$PORTABLE/WindowsDock.exe"
# MSVC hedefinde WebView2Loader statik; MinGW hedefinde ayri dosya gerekir.
if [ -f "$BUILD/WebView2Loader.dll" ]; then cp "$BUILD/WebView2Loader.dll" "$PORTABLE/"; fi
cp "$ROOT/packaging/OKUBENI.txt" "$PORTABLE/" 2>/dev/null || true

# Bundler exe'yi "NSIS ile kuruldu" isaretiyle yamalar; portable kopyayi yukarida
# aldigimiz icin bu yama yalnizca kurulum paketine gider.
# tauri-bundler eklenti klasorunu /usr/share/nsis'ten kopyalar (Linux host'ta
# sabit kodlu yol). Kok yetkisi olmadan, yalniz bu komut icin gecerli bir
# mount namespace'inde oraya sembolik bag kuruyoruz.
echo "==> setup (NSIS)"
bwrap --dev-bind / / --overlay-src /usr/share --tmp-overlay /usr/share -- \
  bash -c 'ln -sfn "$NSISDIR" /usr/share/nsis && exec npx --no-install tauri build --runner cargo-xwin --target "$1" --bundles nsis' _ "$TARGET"

mkdir -p "$SETUP"
cp "$BUILD"/bundle/nsis/*-setup.exe "$SETUP/"

echo "==> paketleme"
powershell.exe -NoProfile -Command "
  Compress-Archive -Path '$(wslpath -w "$PORTABLE")\*' -DestinationPath '$(wslpath -w "$OUT_UNIX")\WindowsDock-0.1.0-x64-portable.zip' -Force
"

echo "==> dogrulama"
powershell.exe -NoProfile -Command "
  Get-ChildItem -Path '$(wslpath -w "$OUT_UNIX")' -Recurse -Filter *.exe | ForEach-Object {
    \$s = Get-AuthenticodeSignature \$_.FullName
    '{0,-34} {1,8:N0} KB  {2}' -f \$_.Name, (\$_.Length/1KB), \$s.Status
  }
"
echo "==> hazir: $(wslpath -w "$OUT_UNIX")"
