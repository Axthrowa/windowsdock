//! Fare gozcusu: iki isi var.
//!
//! 1) Fare testi — pencere panelden buyuktur (buyuyen ikon + etiket payi).
//!    Bu seffaf kusak masaustune giden tiklamalari yutmasin diye, imlec
//!    gorunur icerigin uzerinde degilken pencere tiklama-gecirgen yapilir.
//!    "Gorunur icerik" = panel dikdortgeni VEYA webview'in kendi isabet testi
//!    (buyuyup panel disina tasan ikon, etiket): ikisinden biri yeterli.
//!
//! 2) Surukleme algilayici.
//!
//! Birakma katmani (bkz. dropzone) yalniz surukleme sirasinda gosterilmeli;
//! surekli acik olsa dock'a yapilan tiklamalari yutardi.
//!
//! Suruklemenin isareti: imlec dock'un uzerinde ama webview hicbir pointer
//! olayi almiyor. OLE surukleme dongusu fareyi yakaladigi icin sayfaya
//! hicbir sey ulasmaz; normal gezinmede ise panel aninda pointerenter alir.
//! (Onceki surumde sol tus durumu yoklaniyordu; GetAsyncKeyState + fare
//! izleme birlesimi Defender'in keylogger sezgilerini tetikledigi icin
//! kaldirildi.)

use crate::{dropzone, memtrim, window};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// Gozcu araligi. Fare testi bu hizda guncellenir (25 Hz, olcumle ~%0 CPU).
const TICK_MS: u64 = 40;
/// Surukleme sezimi her N tickte bir (40 ms * 4 = 160 ms, eski davranis).
const DRAG_EVERY: u8 = 4;
/// Bu kadar tick boyunca dock'a dokunulmazsa calisma seti kirpilir (40 ms * 250 = 10 sn).
const IDLE_TRIM_TICKS: u32 = 250;
/// Pencere kacinma denetimi her N tickte bir (40 ms * 6 = 240 ms).
const DODGE_EVERY: u8 = 6;

/// Etkin pencere dock'un panelini ortuyor mu? (Nexus: Dodge Windows)
#[cfg(windows)]
fn covering_dock(panel: (i32, i32, i32, i32)) -> bool {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetForegroundWindow, GetShellWindow, GetWindowRect, IsIconic,
        IsWindowVisible,
    };

    unsafe {
        let fg = GetForegroundWindow();
        if fg.0.is_null() || fg == GetShellWindow() || IsIconic(fg).as_bool() {
            return false;
        }
        if !IsWindowVisible(fg).as_bool() {
            return false;
        }
        let (dock, overlay) = crate::dropzone::own_hwnds();
        let raw = fg.0 as isize;
        if raw == dock || raw == overlay {
            return false;
        }
        let mut buf = [0u16; 64];
        let n = GetClassNameW(fg, &mut buf);
        if n > 0 {
            let cls = String::from_utf16_lossy(&buf[..n as usize]);
            if matches!(cls.as_str(), "Progman" | "WorkerW" | "#32769" | "Shell_TrayWnd") {
                return false;
            }
        }
        let mut r = RECT::default();
        if GetWindowRect(fg, &mut r).is_err() {
            return false;
        }
        // Kesisim var mi?
        let (l, t, rr, b) = panel;
        r.left < rr && r.right > l && r.top < b && r.bottom > t
    }
}

#[cfg(not(windows))]
fn covering_dock(_panel: (i32, i32, i32, i32)) -> bool {
    false
}

/// Imlec gorunur dock icerigi uzerinde degilse pencereyi tiklama-gecirgen yapar.
///
/// Iki kaynak birlestirilir:
///  - panel dikdortgeni (frontend bildirir; pencerenin geri kalani seffaf pay),
///  - webview'in kendi isabet testi (`hovering`): buyuyup panel disina tasan
///    ikonlar ve etiket de "gorunur icerik" sayilsin diye.
fn hit_test(app: &AppHandle, x: i32, y: i32, panel: (i32, i32, i32, i32)) {
    // Gizliyken gecirgenligin sahibi otomatik gizleme (set_hidden);
    // surukleme sirasinda ise dokunmuyoruz, yoksa surukleme yarida kalir.
    if window::dock_hidden() || dropzone::input_locked() {
        return;
    }
    let (l, t, r, b) = panel;
    let inside = x >= l && x <= r && y >= t && y <= b;
    window::set_click_through(app, !inside && !dropzone::hovering());
}

pub fn spawn(app: AppHandle) {
    let _ = std::thread::Builder::new()
        .name("dock-pointerwatch".into())
        .spawn(move || {
            let mut active = false;
            let mut silent_ticks = 0u8;
            let mut tick: u8 = 0;
            // Gercek bir OLE suruklemesinde imlec hareket eder. Hareketsiz
            // imlecte (ornegin dock acildiktan hemen sonra) webview henuz
            // hover bildirmedigi icin bosuna "surukleme var" saniliyordu.
            let mut last_pos = (i32::MIN, i32::MIN);
            let mut idle: u32 = 0;
            let mut trimmed = false;
            let mut dodged: Option<bool> = None;

            loop {
                std::thread::sleep(Duration::from_millis(TICK_MS));
                let Some((x, y)) = cursor_pos() else { continue };
                let Some(panel) = dropzone::dock_rect() else { continue };

                hit_test(&app, x, y, panel);

                // Bosta bellek kirpma: imlec dock'un uzerinde degilken bir kez.
                let (l0, t0, r0, b0) = panel;
                if (x >= l0 && x <= r0 && y >= t0 && y <= b0) || dropzone::input_locked() {
                    idle = 0;
                    trimmed = false;
                } else if !trimmed {
                    idle += 1;
                    if idle >= IDLE_TRIM_TICKS {
                        memtrim::trim();
                        trimmed = true;
                    }
                }

                // Pencere kacinma: etkin pencere dock'u ortuyorsa gizle.
                tick = tick.wrapping_add(1);
                if dropzone::dodging() && tick % DODGE_EVERY == 0 {
                    let cover = covering_dock(panel);
                    if dodged != Some(cover) {
                        dodged = Some(cover);
                        let _ = app.emit("dock-dodge", cover);
                    }
                } else if !dropzone::dodging() {
                    dodged = None;
                }

                // Surukleme sezimi daha yavas: hover gecisleri yanlis pozitif uretmesin.
                if tick % DRAG_EVERY != 0 {
                    continue;
                }

                let (l, t, r, b) = panel;
                let inside = x >= l && x <= r && y >= t && y <= b;
                let moved = (x, y) != last_pos;
                last_pos = (x, y);

                // Dock gizliyken panel ekranda degil ama dikdortgeni yerinde
                // duruyor; webview de hover bildiremez. Bu durumda "surukleme
                // var" sanip TOPMOST birakma katmanini acmak, ekranin o
                // bolgesindeki tiklamalari sebepsiz yutardi.
                let hidden = window::dock_hidden();

                // Icerideyken webview hover bildirmiyorsa fareyi baskasi yakalamis.
                // (Sag tik menusu de fareyi yakalar; o sirada giris kilidi acik
                // oldugu icin birakma katmanini bosuna gostermiyoruz.)
                if inside
                    && !hidden
                    && !dropzone::input_locked()
                    && !dropzone::hovering()
                    && (moved || silent_ticks > 0)
                {
                    silent_ticks = silent_ticks.saturating_add(1);
                } else {
                    silent_ticks = 0;
                }

                let want = silent_ticks >= 2;
                if want != active {
                    active = want;
                    set_active(&app, active);
                }
            }
        });
}

fn set_active(app: &AppHandle, on: bool) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || dropzone::set_active(&handle, on));
}

#[cfg(windows)]
fn cursor_pos() -> Option<(i32, i32)> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut p = POINT::default();
    unsafe { GetCursorPos(&mut p).ok()? };
    Some((p.x, p.y))
}

#[cfg(not(windows))]
fn cursor_pos() -> Option<(i32, i32)> {
    None
}
