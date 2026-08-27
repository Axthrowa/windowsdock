//! Otomatik gizleme icin imlec gozcusu.
//!
//! Dock gizliyken pencere `set_ignore_cursor_events(true)` ile tiklama gecirgen
//! olur; bu yuzden webview artik hover alamaz. Gozcu ayri bir is parcaciginda
//! yalnizca *gizli* durumdayken 60 ms araliklarla `GetCursorPos` cagirir.
//! Dock gorunurken veya auto-hide kapaliyken is parcacigi Condvar uzerinde
//! park eder — sifir uyanma, sifir CPU.

use crate::trace::trace;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub type Zone = (i32, i32, i32, i32); // x0, y0, x1, y1 (fiziksel px)

#[derive(Default)]
struct Shared {
    armed: bool,
    stop: bool,
    zone: Zone,
    /// "Yalniz masaustu" duzeyinde: dock ancak masaustu ondeyken acilsin.
    /// Yoksa tarayicinin sekme cubugu gibi ust kenara yaklastigimiz her yerde
    /// ortaya cikip pencerenin ustunu kapatiyordu.
    desktop_only: bool,
}

pub struct Watcher {
    inner: Arc<(Mutex<Shared>, Condvar)>,
}

impl Watcher {
    pub fn spawn(app: AppHandle) -> Self {
        let inner = Arc::new((Mutex::new(Shared::default()), Condvar::new()));
        let handle = Arc::clone(&inner);

        std::thread::Builder::new()
            .name("dock-reveal-watch".into())
            .spawn(move || loop {
                let (zone, desktop_only) = {
                    let (lock, cv) = &*handle;
                    let mut g = lock.lock().unwrap();
                    while !g.armed && !g.stop {
                        g = cv.wait(g).unwrap();
                    }
                    if g.stop {
                        return;
                    }
                    (g.zone, g.desktop_only)
                };

                match cursor_pos() {
                    Some((x, y)) => {
                        if x >= zone.0 && x <= zone.2 && y >= zone.1 && y <= zone.3 {
                            // Tam ekran oyun/sunum: dock hic acilmaz. Pencere
                            // ortusme testinden ONCE, cunku oyun ondeyken bile
                            // araya giren kucuk bir katman penceresi (Steam ya
                            // da surucu bindirmesi) ortusme testini gecirip
                            // dock'u aciyor, gorunmuyor ama ses efekti caliyordu.
                            if fullscreen_app_active() {
                                std::thread::sleep(Duration::from_millis(250));
                                continue;
                            }
                            if desktop_only && !reveal_allowed() {
                                // Dock'un alani baska bir pencerede: acmiyoruz
                                // (tam ekran oyun, ekrani dolduran tarayici ya
                                // da dock'un ustune gelmis siradan bir pencere).
                                std::thread::sleep(Duration::from_millis(60));
                                continue;
                            }
                            handle.0.lock().unwrap().armed = false;
                            trace(&format!("reveal! imlec=({x},{y}) zone={zone:?}"));
                            let _ = app.emit("dock-reveal", ());
                        }
                    }
                    None => trace("cursor_pos() None dondu"),
                }
                std::thread::sleep(Duration::from_millis(60));
            })
            .expect("gozcu is parcacigi baslatilamadi");

        Self { inner }
    }

    pub fn arm(&self, zone: Zone, desktop_only: bool) {
        let (lock, cv) = &*self.inner;
        let mut g = lock.lock().unwrap();
        g.zone = zone;
        g.desktop_only = desktop_only;
        g.armed = true;
        trace(&format!("watcher ARM zone={zone:?} masaustu_only={desktop_only}"));
        cv.notify_all();
    }

    pub fn disarm(&self) {
        let (lock, cv) = &*self.inner;
        lock.lock().unwrap().armed = false;
        trace("watcher DISARM");
        cv.notify_all();
    }
}

impl Drop for Watcher {
    fn drop(&mut self) {
        let (lock, cv) = &*self.inner;
        let mut g = lock.lock().unwrap();
        g.stop = true;
        cv.notify_all();
    }
}

/// Tam ekran bir uygulama (oyun, video, sunum) su an ekrani mi tutuyor?
///
/// `SHQueryUserNotificationState` kabugun "simdi bildirim gosterilir mi"
/// durumudur; D3D tam ekran, sunum modu ve tam ekran magaza uygulamasi ayni
/// yerden okunur. Pencere TARAMASI yapmadigi icin Akilli Uygulama Denetimi'ne
/// takilmiyor (butun pencereleri gezen surumler takiliyordu) ve tek cagri.
#[cfg(windows)]
fn fullscreen_app_active() -> bool {
    use std::sync::atomic::{AtomicBool, Ordering};
    use windows::Win32::UI::Shell::{
        SHQueryUserNotificationState, QUNS_APP, QUNS_BUSY, QUNS_PRESENTATION_MODE,
        QUNS_RUNNING_D3D_FULL_SCREEN,
    };

    let busy = match unsafe { SHQueryUserNotificationState() } {
        Ok(state) => {
            state == QUNS_BUSY
                || state == QUNS_RUNNING_D3D_FULL_SCREEN
                || state == QUNS_PRESENTATION_MODE
                || state == QUNS_APP
        }
        Err(_) => false,
    };

    static LAST: AtomicBool = AtomicBool::new(false);
    if LAST.swap(busy, Ordering::Relaxed) != busy {
        trace(if busy {
            "tam ekran uygulama AKTIF (dock acilmaz, ses calmaz)"
        } else {
            "tam ekran uygulama bitti"
        });
    }
    busy
}

#[cfg(not(windows))]
fn fullscreen_app_active() -> bool {
    false
}

/// Dock acilabilir mi?
///
/// Kural: dock'un panel alanini ONDEKI PENCERE isgal ediyorsa acilmaz.
/// Tam ekran oyun, ekrani kaplayan tarayici ve dock'un tam ustune gelmis
/// siradan bir pencere ayni sekilde ele alinir; ekranin baska yerindeki
/// Steam/Discord gibi pencereler dock'u engellemez.
///
/// Neden yalniz ondeki pencere: butun pencereleri tarayan surumler imzasiz
/// derlemede Akilli Uygulama Denetimi'ne (SAC) takiliyor. Zaten kullanicinin
/// baktigi pencere ondeki penceredir; arkada duran bir pencerenin ustunu
/// kapatmak sorun degil.
#[cfg(windows)]
fn reveal_allowed() -> bool {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetForegroundWindow, GetShellWindow, GetWindowRect, IsIconic,
        IsWindowVisible,
    };

    let Some((l, t, r, b)) = crate::dropzone::dock_rect() else {
        return true;
    };
    let area = (r - l) as i64 * (b - t) as i64;
    if area <= 0 {
        return true;
    }

    let busy = unsafe {
        let fg = GetForegroundWindow();
        if fg.0.is_null()
            || fg == GetShellWindow()
            || IsIconic(fg).as_bool()
            || !IsWindowVisible(fg).as_bool()
        {
            false
        } else {
            let (dock, overlay) = crate::dropzone::own_hwnds();
            let raw = fg.0 as isize;

            let mut buf = [0u16; 64];
            let n = GetClassNameW(fg, &mut buf);
            let cls = if n > 0 {
                String::from_utf16_lossy(&buf[..n as usize])
            } else {
                String::new()
            };
            let shell = matches!(
                cls.as_str(),
                "Progman" | "WorkerW" | "#32769" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd"
            );

            if raw == dock || raw == overlay || shell {
                false
            } else {
                let mut w = RECT::default();
                if GetWindowRect(fg, &mut w).is_err() {
                    false
                } else {
                    // Panelin ne kadarini ortuyor? Kucuk temaslar (pencerenin
                    // kenari dock'a degmesi) engellemesin diye esik %15.
                    let ix = (w.right.min(r) - w.left.max(l)).max(0) as i64;
                    let iy = (w.bottom.min(b) - w.top.max(t)).max(0) as i64;
                    ix * iy * 100 >= area * 15
                }
            }
        }
    };

    // Gunluge yalniz durum degisince yaz: gozcu 60 ms'de bir doner.
    use std::sync::atomic::{AtomicBool, Ordering};
    static LAST_BUSY: AtomicBool = AtomicBool::new(false);
    if LAST_BUSY.swap(busy, Ordering::Relaxed) != busy {
        trace(&format!(
            "dock alani {} panel=({l},{t},{r},{b})",
            if busy { "MESGUL (acilmaz)" } else { "bos (acilabilir)" }
        ));
    }
    !busy
}

#[cfg(not(windows))]
fn reveal_allowed() -> bool {
    true
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
