# WindowsDock

RocketDock / macOS tarzi, Tauri 2 + Vite + React (TS) tabanli hafif dock.

## Gereksinimler (Windows tarafi)
- Rust (MSVC toolchain): `rustup default stable-x86_64-pc-windows-msvc`
- Visual Studio Build Tools (Desktop development with C++)
- WebView2 Runtime (Win11'de kurulu gelir)
- Node.js 20+

## Komutlar
```powershell
npm install
npm run tauri:dev      # gelistirme (HMR)
npm run tauri:build    # NSIS installer -> src-tauri/target/release/bundle/nsis
```

## Yapi
```
src/lib/magnify.ts        magnification matematigi (saf fonksiyon, allocation-free)
src/components/Dock.tsx   rAF tabanli tek gecislik DOM yazma
src-tauri/src/window.rs    ekran kenarina yaslama, work-area hesabi
src-tauri/src/launcher.rs  detached process baslatma (exe/lnk/url/uri)
src-tauri/src/config.rs    %APPDATA%\com.axthrowa.windowsdock\dock.json
```

## Tuzaklar (bozulursa buraya bakin)

**1. Tum pencerelerin `additionalBrowserArgs` degeri AYNI olmali.**
WebView2 ayni kullanici-veri klasoru icin tek bir ortam (environment) tutar ve
ikinci pencere farkli secenek isterse ortam kurulumu basarisiz olur. Tauri bu
hatayi yutar: pencere olusur, hemen yok edilir, `build()` yine de Ok doner.
Sonuc: uygulama tepside gorunur ama dock hic acilmaz. Bir pencereye argüman
eklerken digerine de birebir ayni dizeyi ekleyin.

**2. Ayarlar penceresi acilista olusturulmaz** (`"create": false`). Ikinci bir
WebView2 ornegi bosta ~80 MB tutuyor; pencere ilk `open_settings` cagrisinda
kuruluyor. Kurulum ana is parcaciginin olay dongusu ICINDEN yapilamaz
(FailedToReceiveMessage) — tepsi/menu gibi yollar `open_settings_async` kullanmali.

**3. Emniyet agi:** frontend 6 sn icinde `show_dock()` cagirmazsa Rust tarafi
pencereyi yine de gosterir; boylece bir JS hatasi uygulamayi gorunmez birakmaz.

## Temalar
`src/lib/themes.ts` tema listesini, `src/styles.css` icindeki `[data-theme="..."]`
bloklari gorunumu tutar. Bir tema yalnizca CSS degiskenlerini degistirir
(`--panel-bg`, `--panel-border`, `--panel-inset`, `--panel-drop`,
`--panel-overlay`, `--tile-*`), boylece dock paneli ile ayarlardaki onizleme
ayni koddan beslenir. Nexus/ObjectDock skinlerinin 9-dilim PNG'lerine karsilik
burada katmanli gradyanlar kullaniliyor: dosya yok, olcekleme sorunu yok.

Yeni tema eklemek: `THEMES` dizisine bir kayit + `styles.css` icine ayni
kimlikli `[data-theme="..."]` blogu + `i18n.ts` icine ad.

Tum temalari tek sayfada gormek icin (yalniz gelistirme):
```bash
npm run dev      # sonra tarayicida http://localhost:1420/preview.html
```
Bu sayfa uretim paketine girmez (vite girisleri: index.html + settings.html).

## Teshis
```powershell
$env:WINDOWSDOCK_DEBUG=1          # %LOCALAPPDATA%\com.axthrowa.windowsdock\debug.log
$env:WINDOWSDOCK_OPEN_SETTINGS=1  # acilista ayarlar penceresini dogrudan ac
```

## Ayar dosyasi
`%APPDATA%\com.axthrowa.windowsdock\dock.json` — edge, iconSize, magnification,
magnifyRange, margin, showLabels, monitor ve items alanlari elle duzenlenebilir.
