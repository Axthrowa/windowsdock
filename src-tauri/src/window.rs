use crate::appbar::AppBar;
use crate::trace::trace;
use crate::autohide::{Watcher, Zone};
use crate::config::DockConfig;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{
    AppHandle, LogicalSize, Manager, Monitor, PhysicalPosition, State, WebviewWindow,
    WebviewWindowBuilder,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInfo {
    pub index: usize,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub scale_factor: f64,
    pub primary: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutReq {
    pub width: f64,
    pub height: f64,
    /// Gorunur panel olculeri; ekran alani rezervasyonu pencerenin tamamini
    /// degil yalniz bunu ayirir (pencerede buyuyen ikon icin seffaf pay var).
    #[serde(default)]
    pub panel_w: f64,
    #[serde(default)]
    pub panel_h: f64,
    pub edge: String,
    /// "edge" | "free"
    pub anchor: String,
    pub margin: i32,
    pub monitor: usize,
    /// Kenar boyunca hizalama: "start" | "center" | "end"
    #[serde(default)]
    pub align: String,
    pub free_x: i32,
    pub free_y: i32,
    /// Gorev cubugu gibi ekran alani ayirilsin mi (AppBar)
    #[serde(default)]
    pub reserve: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Placed {
    pub x: i32,
    pub y: i32,
}

fn pick_monitor(win: &WebviewWindow, index: usize) -> Option<Monitor> {
    let all = win.available_monitors().ok()?;
    if let Some(m) = all.get(index) {
        return Some(m.clone());
    }
    win.primary_monitor()
        .ok()
        .flatten()
        .or_else(|| all.first().cloned())
}

/// Monitorun gorev cubugu disinda kalan calisma alani (fiziksel px).
fn work_rect(m: &Monitor) -> (i32, i32, i32, i32) {
    let area = m.work_area();
    let (x, y) = (area.position.x, area.position.y);
    let (w, h) = (area.size.width as i32, area.size.height as i32);

    if w > 0 && h > 0 {
        (x, y, w, h)
    } else {
        let p = m.position();
        let s = m.size();
        (p.x, p.y, s.width as i32, s.height as i32)
    }
}

/// Pencereyi verilen logical olculere getirip konumlandirir.
/// Serbest modda kullanicinin konumu korunur, yalnizca ekran disina tasmamasi
/// icin calisma alanina kenetlenir.
/// SHAppBarMessage kabuk ile pencere mesaji alisverisi yapar; UI is parcacigi
/// disindan cagrildiginda kayit sessizce etkisiz kalabiliyor. Bu yuzden cagri
/// ana is parcacigina aktarilip sonucu kanaldan geri alinir.
fn reserve_on_main(
    app: &AppHandle,
    hwnd: isize,
    edge: String,
    mon: (i32, i32, i32, i32),
    thickness: i32,
) -> Option<(i32, i32, i32, i32)> {
    use std::sync::mpsc::sync_channel;
    use std::time::Duration;

    let (tx, rx) = sync_channel(1);
    let handle = app.clone();
    if app
        .run_on_main_thread(move || {
            let bar = handle.state::<AppBar>();
            let _ = tx.send(bar.reserve(hwnd, &edge, mon, thickness));
        })
        .is_err()
    {
        return None;
    }
    rx.recv_timeout(Duration::from_millis(2000)).ok().flatten()
}

fn place(win: &WebviewWindow, req: &LayoutReq, bar: &AppBar) -> tauri::Result<Placed> {
    win.set_size(LogicalSize::new(req.width.max(1.0), req.height.max(1.0)))?;

    let Some(mon) = pick_monitor(win, req.monitor) else {
        return Ok(Placed { x: 0, y: 0 });
    };
    let sf = mon.scale_factor();

    let w = (req.width * sf).round() as i32;
    let h = (req.height * sf).round() as i32;
    let m = (req.margin as f64 * sf).round() as i32;

    // AppBar rezervasyonu: kendi seridimiz calisma alanindan dusuldugu icin
    // konumu work_area'dan degil, kabugun onayladigi seritten turetmeliyiz —
    // aksi halde dock her yerlesimde kendi seridi kadar daha kayardi.
    let reserved = if req.anchor == "edge" && req.reserve {
        let mp = mon.position();
        let ms = mon.size();
        let full = (mp.x, mp.y, mp.x + ms.width as i32, mp.y + ms.height as i32);
        let pw = if req.panel_w > 0.0 { (req.panel_w * sf).round() as i32 } else { w };
        let ph = if req.panel_h > 0.0 { (req.panel_h * sf).round() as i32 } else { h };
        let thickness = if req.edge == "left" || req.edge == "right" { pw + m } else { ph + m };
        hwnd_of(win).and_then(|hwnd| {
            reserve_on_main(&win.app_handle().clone(), hwnd, req.edge.clone(), full, thickness)
        })
    } else {
        bar.release();
        None
    };

    let (ox, oy, ow, oh) = match reserved {
        Some((x0, y0, x1, y1)) => (x0, y0, x1 - x0, y1 - y0),
        None => work_rect(&mon),
    };

    let (x, y) = if req.anchor == "free" {
        (
            req.free_x.clamp(ox, (ox + ow - w).max(ox)),
            req.free_y.clamp(oy, (oy + oh - h).max(oy)),
        )
    } else {
        // Kenar boyunca hizalama (Nexus: "Align dock to which side")
        let along = |span: i32, size: i32| match req.align.as_str() {
            "start" => m,
            "end" => span - size - m,
            _ => (span - size) / 2,
        };
        match req.edge.as_str() {
            "top" => (ox + along(ow, w), oy + m),
            "left" => (ox + m, oy + along(oh, h)),
            "right" => (ox + ow - w - m, oy + along(oh, h)),
            _ => (ox + along(ow, w), oy + oh - h - m),
        }
    };

    win.set_position(PhysicalPosition::new(x, y))?;
    Ok(Placed { x, y })
}

fn hwnd_of(win: &WebviewWindow) -> Option<isize> {
    #[cfg(windows)]
    {
        win.hwnd().ok().map(|h| h.0 as isize)
    }
    #[cfg(not(windows))]
    {
        let _ = win;
        None
    }
}

/// Setup asamasindaki kaba ilk yerlesim; frontend olcum yapinca duzeltilir.
pub fn place_on_edge(win: &WebviewWindow, cfg: &DockConfig, bar: &AppBar) -> tauri::Result<()> {
    let size = cfg.icon_size as f64;
    let count = (cfg.items.len() + 1).max(1) as f64;
    let req = LayoutReq {
        width: count * (size + 12.0) + 24.0,
        height: size * cfg.magnification + 40.0,
        // Bu asamada rezervasyon yapilmiyor (asagida reserve: false), panel
        // olculeri ilk apply_layout cagrisinda frontend'den gelir.
        panel_w: 0.0,
        panel_h: 0.0,
        align: cfg.align.clone(),
        edge: cfg.edge.clone(),
        anchor: cfg.anchor.clone(),
        margin: cfg.margin,
        monitor: cfg.monitor,
        free_x: cfg.free_x,
        free_y: cfg.free_y,
        // Kurulum asamasinda olay dongusu henuz donmuyor; appbar rezervasyonu
        // ilk apply_layout cagrisinda ana is parcaciginda yapilir.
        reserve: false,
    };
    place(win, &req, bar).map(|_| ())
}

#[tauri::command]
pub fn apply_layout(
    app: AppHandle,
    req: LayoutReq,
    bar: State<'_, AppBar>,
) -> Result<Placed, String> {
    let win = app.get_webview_window("dock").ok_or("dock penceresi yok")?;
    place(&win, &req, &bar).map_err(|e| e.to_string())
}

/// Windows 11 akrilik bulaniklik. Seffaf pencerede opsiyoneldir; kapaliyken
/// panel yalnizca CSS rengiyle cizilir (daha ucuz).
#[tauri::command]
pub fn set_acrylic(app: AppHandle, enabled: bool, tint: Option<Vec<u8>>) -> Result<(), String> {
    use tauri::utils::config::{Color, WindowEffectsConfig};
    use tauri::utils::WindowEffect;

    let win = app.get_webview_window("dock").ok_or("dock penceresi yok")?;
    let color = tint.and_then(|c| {
        (c.len() == 4).then(|| Color(c[0], c[1], c[2], c[3]))
    });
    let cfg = enabled.then(|| WindowEffectsConfig {
        effects: vec![WindowEffect::Acrylic],
        state: None,
        radius: None,
        color,
    });
    win.set_effects(cfg).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn monitor_info(app: AppHandle) -> Result<Vec<MonitorInfo>, String> {
    let win = app.get_webview_window("dock").ok_or("dock penceresi yok")?;
    let primary = win.primary_monitor().ok().flatten();
    let list = win.available_monitors().map_err(|e| e.to_string())?;

    Ok(list
        .iter()
        .enumerate()
        .map(|(index, m)| MonitorInfo {
            index,
            name: m
                .name()
                .cloned()
                .unwrap_or_else(|| format!("Ekran {}", index + 1)),
            width: m.size().width,
            height: m.size().height,
            scale_factor: m.scale_factor(),
            primary: primary
                .as_ref()
                .map(|p| p.position() == m.position())
                .unwrap_or(index == 0),
        })
        .collect())
}

/// Gizliyken dokunulan "sicak serit": dock'un kenara bakan yuzu, ekran
/// kenarina kadar uzatilmis halde.
fn hot_zone(win: &WebviewWindow, edge: &str, thickness: i32, mon: &Monitor) -> Zone {
    let pos = win.outer_position().unwrap_or(PhysicalPosition::new(0, 0));
    let size = win.outer_size().unwrap_or_default();
    let (x0, y0) = (pos.x, pos.y);
    let (x1, y1) = (x0 + size.width as i32, y0 + size.height as i32);

    let mp = mon.position();
    let ms = mon.size();
    let (mx0, my0) = (mp.x, mp.y);
    let (mx1, my1) = (mx0 + ms.width as i32, my0 + ms.height as i32);
    let t = thickness.max(1);

    match edge {
        "top" => (x0, my0, x1, (y0 + t).max(my0 + t)),
        "left" => (mx0, y0, (x0 + t).max(mx0 + t), y1),
        "right" => ((x1 - t).min(mx1 - t), y0, mx1, y1),
        _ => (x0, (y1 - t).min(my1 - t), x1, my1),
    }
}

/// Dock'u gizli/gorunur duruma alir. Gizliyken pencere tiklama gecirgen olur ve
/// imlec gozcusu silahlanir; gorunurken gozcu park eder.
#[tauri::command]
pub fn set_hidden(
    app: AppHandle,
    hidden: bool,
    edge: String,
    zone: u32,
    monitor: usize,
    // Frontend camelCase gonderir (desktopOnly); Tauri snake_case'e cevirir.
    desktop_only: bool,
    watcher: State<'_, Watcher>,
) -> Result<(), String> {
    let win = app.get_webview_window("dock").ok_or("dock penceresi yok")?;
    DOCK_HIDDEN.store(hidden, Ordering::SeqCst);
    IGNORING.store(hidden, Ordering::SeqCst);
    win.set_ignore_cursor_events(hidden)
        .map_err(|e| e.to_string())?;
    trace(&format!("set_hidden({hidden}) edge={edge} zone={zone} mon={monitor}"));

    if hidden {
        match pick_monitor(&win, monitor) {
            Some(mon) => watcher.arm(hot_zone(&win, &edge, zone as i32, &mon), desktop_only),
            None => trace("set_hidden: monitor bulunamadi, gozcu silahlanmadi"),
        }
    } else {
        watcher.disarm();
    }
    Ok(())
}

/// Frontend hazir mi: show_dock() cagrildi mi?
static DOCK_SHOWN: AtomicBool = AtomicBool::new(false);
/// Dock su an gizli mi (otomatik gizleme)?
static DOCK_HIDDEN: AtomicBool = AtomicBool::new(false);
/// Pencere su an tiklama-gecirgen mi?
static IGNORING: AtomicBool = AtomicBool::new(false);

pub fn dock_hidden() -> bool {
    DOCK_HIDDEN.load(Ordering::SeqCst)
}
/// Pencereyi tiklama-gecirgen yapar/geri alir. Fare testi gozcusu (dragwatch)
/// panelin gorunur dikdortgenine gore bunu surekli gunceller: panel disindaki
/// seffaf pay masaustune giden tiklamalari yutmasin.
pub fn set_click_through(app: &AppHandle, on: bool) {
    if IGNORING.swap(on, Ordering::SeqCst) == on {
        return;
    }
    if let Some(win) = app.get_webview_window("dock") {
        if let Err(e) = win.set_ignore_cursor_events(on) {
            trace(&format!("set_ignore_cursor_events({on}) hata: {e}"));
        }
    }
}

/// Frontend ilk render + olcumu bitirdiginde cagrilir: beyaz flash olmaz.
/// Z-duzeyi ayri komutla (set_layer) belirlenir.
#[tauri::command]
pub fn show_dock(app: AppHandle) -> Result<(), String> {
    DOCK_SHOWN.store(true, Ordering::SeqCst);
    let win = app.get_webview_window("dock").ok_or("dock penceresi yok")?;
    win.show().map_err(|e| e.to_string())
}

/// Emniyet agi: webview yuklenemez ya da JS coker de show_dock() hic cagrilmazsa
/// pencere sonsuza dek gizli kalir ve uygulama "acilmiyor" gibi gorunur.
/// Belirli bir sure sonra dock'u yine de gosteririz.
pub fn spawn_show_guard(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(6));
        if DOCK_SHOWN.load(Ordering::SeqCst) {
            return;
        }
        trace("emniyet agi: frontend show_dock cagirmadi, dock zorla gosteriliyor");
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Some(w) = handle.get_webview_window("dock") {
                let _ = w.show();
            }
        });
    });
}

/// Masaustu duzeyindeki dock acilirken cagrilir: pencereyi normal bandin
/// USTUNE alir ama "her zaman ustte" YAPMAZ. Boylece masaustundeyken gorunur,
/// kullanici bir uygulamaya gecince o uygulama dock'un ustunde kalir
/// (eskiden always-on-top yapiliyordu ve tarayicinin sekme cubugunu kapatiyordu).
#[tauri::command]
pub fn raise_above_desktop(app: AppHandle) -> Result<(), String> {
    let win = app.get_webview_window("dock").ok_or("dock penceresi yok")?;
    win.set_always_on_bottom(false).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{
            SetWindowPos, HWND_TOP, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
        };
        if let Some(h) = hwnd_of(&win) {
            unsafe {
                let _ = SetWindowPos(
                    HWND(h as *mut core::ffi::c_void),
                    Some(HWND_TOP),
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                );
            }
        }
    }
    trace("raise_above_desktop");
    Ok(())
}

/// Pencerenin z-duzeyi.
/// - "desktop": tum pencerelerin altinda kalir; yalnizca masaustu gorunurken ortaya cikar
/// - "normal" : siradan pencere sirasi
/// - "top"    : her zaman ustte
#[tauri::command]
pub fn set_layer(app: AppHandle, layer: String) -> Result<(), String> {
    let win = app.get_webview_window("dock").ok_or("dock penceresi yok")?;
    let e = |x: tauri::Error| x.to_string();
    match layer.as_str() {
        "desktop" => {
            win.set_always_on_top(false).map_err(e)?;
            win.set_always_on_bottom(true).map_err(e)?;
        }
        "normal" => {
            win.set_always_on_top(false).map_err(e)?;
            win.set_always_on_bottom(false).map_err(e)?;
        }
        _ => {
            win.set_always_on_bottom(false).map_err(e)?;
            win.set_always_on_top(true).map_err(e)?;
        }
    }
    trace(&format!("set_layer -> {layer}"));
    Ok(())
}

/// Ayarlar penceresi acilista OLUSTURULMAZ (tauri.conf.json: "create": false).
/// Ikinci bir WebView2 ornegi bosta ~100 MB tutuyordu; nadiren acilan bir
/// pencere icin bu maliyeti odememek gerekiyor. Ilk cagride tanimindan kurulur.
///
/// DIKKAT: pencere kurulumu ana is parcaciginin olay dongusu ICINDEN yapilamaz
/// (runtime mesaji islenemez -> FailedToReceiveMessage). Tepsi/menu gibi ana
/// is parcaciginda calisan yollar bunu `open_settings_async` ile cagirmali.
pub fn open_settings(app: AppHandle) -> Result<(), String> {
    let e = |x: tauri::Error| x.to_string();
    let w = match app.get_webview_window("settings") {
        Some(w) => w,
        None => {
            let cfg = app
                .config()
                .app
                .windows
                .iter()
                .find(|w| w.label == "settings")
                .cloned()
                .ok_or("ayarlar penceresi tanimli degil")?;
            trace("open_settings: pencere ilk kez kuruluyor");
            WebviewWindowBuilder::from_config(&app, &cfg)
                .map_err(e)?
                .build()
                .map_err(e)?
        }
    };
    w.unminimize().map_err(e)?;
    w.show().map_err(e)?;
    w.set_focus().map_err(e)?;
    trace("open_settings: gosterildi");
    Ok(())
}

/// Ana is parcacigindan (tepsi menusu, kabuk menusu) guvenli cagri.
pub fn open_settings_async(app: AppHandle) {
    std::thread::spawn(move || {
        if let Err(e) = open_settings(app) {
            trace(&format!("open_settings hata: {e}"));
        }
    });
}

