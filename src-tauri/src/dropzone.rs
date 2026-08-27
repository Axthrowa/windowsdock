//! Explorer'dan surukle-birak ile kisayol ekleme.
//!
//! Neden bu kadar dolayli: WebView2 istemci alanini kaplayan en ust pencereleri
//! (`Chrome_WidgetWin_1`, `Chrome_RenderWidgetHostHWND`) KENDI SURECINDE
//! (msedgewebview2.exe) olusturup bizim pencereye evlat ediniyor. OLE, birakma
//! hedefini imlecin altindaki pencereden yukari yuruyerek arar ve bu arama
//! surec sinirini gecmiyor; dolayisiyla ne wry'nin ust pencereye kaydettigi
//! hedef ne de bizimki cagriliyor. Olcumle dogrulandi: hedef kayitli olmasina
//! ragmen DragEnter hic tetiklenmiyor.
//!
//! Cozum: surukleme suresince dock'un uzerinde duran, alt pencereleri olmayan
//! ayri bir katman penceresi. `WindowFromPoint` dogrudan onu dondurdugu icin
//! OLE hedefimizi aninda bulur. Pencere neredeyse tamamen saydam (alfa 1) ve
//! yalniz surukleme algilandiginda gosterilir; normal zamanda gizli oldugu icin
//! tiklamalara hic karismaz.

#[cfg(windows)]
mod imp {
    use crate::trace::trace;
    use std::cell::Cell;
    use std::sync::atomic::{AtomicBool, AtomicI32, AtomicIsize, Ordering};
    use tauri::{AppHandle, Emitter};
    use windows::core::{implement, Ref, Result as WinResult, PCWSTR};
    use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINTL, WPARAM};
    use windows::Win32::System::Com::{IDataObject, DVASPECT_CONTENT, FORMATETC, TYMED_HGLOBAL};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Ole::{
        IDropTarget, IDropTarget_Impl, RegisterDragDrop, ReleaseStgMedium, DROPEFFECT,
        DROPEFFECT_COPY, DROPEFFECT_NONE,
    };
    use windows::Win32::System::SystemServices::MODIFIERKEYS_FLAGS;
    use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, GetWindowRect, RegisterClassW, SetLayeredWindowAttributes,
        SetWindowPos, ShowWindow, HWND_TOPMOST, LWA_ALPHA, SWP_NOACTIVATE, SW_HIDE, SW_SHOWNA,
        WNDCLASSW, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
    };

    const CF_HDROP: u16 = 15;
    const CLASS_NAME: &str = "WindowsDockDropOverlay";

    static OVERLAY: AtomicIsize = AtomicIsize::new(0);
    static DOCK: AtomicIsize = AtomicIsize::new(0);
    /// Panelin pencere icindeki gorunur dikdortgeni (fiziksel px):
    /// x, y, genislik, yukseklik. Pencere panelden buyuktur (buyuyen ikon payi).
    static PANEL: [AtomicI32; 4] = [
        AtomicI32::new(0),
        AtomicI32::new(0),
        AtomicI32::new(0),
        AtomicI32::new(0),
    ];
    /// Ikon suruklenirken fare testi dondurulur.
    static LOCK: AtomicBool = AtomicBool::new(false);
    /// "Pencere kacinma" modu acik mi (Nexus: Dodge Windows)
    static DODGE: AtomicBool = AtomicBool::new(false);
    /// Webview panelin uzerinde fare bildirdi mi? OLE suruklemesi sirasinda
    /// webview hicbir pointer olayi almaz — surukleme sinyalimiz bu.
    static HOVER: AtomicBool = AtomicBool::new(false);

    pub fn set_hover(on: bool) {
        HOVER.store(on, Ordering::SeqCst);
    }
    pub fn hovering() -> bool {
        HOVER.load(Ordering::SeqCst)
    }

    pub fn set_dock_hwnd(hwnd: isize) {
        DOCK.store(hwnd, Ordering::SeqCst);
    }

    /// Kendi pencerelerimiz: fare testinde "bunlarin altina bak" demek icin.
    pub fn own_hwnds() -> (isize, isize) {
        (DOCK.load(Ordering::SeqCst), OVERLAY.load(Ordering::SeqCst))
    }

    pub fn set_panel_rect(x: i32, y: i32, w: i32, h: i32) {
        PANEL[0].store(x, Ordering::SeqCst);
        PANEL[1].store(y, Ordering::SeqCst);
        PANEL[2].store(w, Ordering::SeqCst);
        PANEL[3].store(h, Ordering::SeqCst);
    }

    pub fn set_input_lock(locked: bool) {
        LOCK.store(locked, Ordering::SeqCst);
    }
    pub fn input_locked() -> bool {
        LOCK.load(Ordering::SeqCst)
    }

    pub fn set_dodge(on: bool) {
        DODGE.store(on, Ordering::SeqCst);
    }
    pub fn dodging() -> bool {
        DODGE.load(Ordering::SeqCst)
    }

    /// Pencerenin tamami (seffaf pay dahil).
    pub fn window_rect() -> Option<(i32, i32, i32, i32)> {
        let h = DOCK.load(Ordering::SeqCst);
        if h == 0 {
            return None;
        }
        let mut r = windows::Win32::Foundation::RECT::default();
        unsafe { GetWindowRect(HWND(h as *mut core::ffi::c_void), &mut r).ok()? };
        Some((r.left, r.top, r.right, r.bottom))
    }

    /// Yalnizca gorunur panel (ekran koordinati). Frontend olcum gondermediyse
    /// pencerenin tamamina duseriz.
    pub fn dock_rect() -> Option<(i32, i32, i32, i32)> {
        let (wl, wt, wr, wb) = window_rect()?;
        let (px, py, pw, ph) = (
            PANEL[0].load(Ordering::SeqCst),
            PANEL[1].load(Ordering::SeqCst),
            PANEL[2].load(Ordering::SeqCst),
            PANEL[3].load(Ordering::SeqCst),
        );
        if pw <= 0 || ph <= 0 {
            return Some((wl, wt, wr, wb));
        }
        Some((wl + px, wt + py, wl + px + pw, wt + py + ph))
    }

    // ---------------------------------------------------------------- hedef

    #[implement(IDropTarget)]
    pub struct DockDropTarget {
        app: AppHandle,
        acceptable: Cell<bool>,
    }

    impl DockDropTarget {
        fn new(app: AppHandle) -> Self {
            Self {
                app,
                acceptable: Cell::new(false),
            }
        }
    }

    /// CF_HDROP icinden tam dosya yollarini cikarir.
    fn paths_of(data: &IDataObject) -> Vec<String> {
        let fmt = FORMATETC {
            cfFormat: CF_HDROP,
            ptd: std::ptr::null_mut(),
            dwAspect: DVASPECT_CONTENT.0,
            lindex: -1,
            tymed: TYMED_HGLOBAL.0 as u32,
        };

        unsafe {
            let mut medium = match data.GetData(&fmt) {
                Ok(m) => m,
                Err(e) => {
                    trace(&format!("GetData(CF_HDROP) hata: {e}"));
                    return Vec::new();
                }
            };
            let hdrop = HDROP(medium.u.hGlobal.0);
            let count = DragQueryFileW(hdrop, u32::MAX, None);

            let mut out = Vec::with_capacity(count as usize);
            for i in 0..count {
                let len = DragQueryFileW(hdrop, i, None);
                if len == 0 {
                    continue;
                }
                let mut buf = vec![0u16; len as usize + 1];
                let written = DragQueryFileW(hdrop, i, Some(&mut buf));
                if written > 0 {
                    out.push(String::from_utf16_lossy(&buf[..written as usize]));
                }
            }
            ReleaseStgMedium(&mut medium);
            out
        }
    }

    impl IDropTarget_Impl for DockDropTarget_Impl {
        fn DragEnter(
            &self,
            pdataobj: Ref<'_, IDataObject>,
            _keys: MODIFIERKEYS_FLAGS,
            _pt: &POINTL,
            effect: *mut DROPEFFECT,
        ) -> WinResult<()> {
            let ok = pdataobj
                .as_ref()
                .map(|d| !paths_of(d).is_empty())
                .unwrap_or(false);
            trace(&format!("DragEnter ok={ok}"));
            self.acceptable.set(ok);
            unsafe { *effect = if ok { DROPEFFECT_COPY } else { DROPEFFECT_NONE } };
            let _ = self.app.emit("dock-drag-over", ok);
            Ok(())
        }

        fn DragOver(
            &self,
            _keys: MODIFIERKEYS_FLAGS,
            _pt: &POINTL,
            effect: *mut DROPEFFECT,
        ) -> WinResult<()> {
            unsafe {
                *effect = if self.acceptable.get() {
                    DROPEFFECT_COPY
                } else {
                    DROPEFFECT_NONE
                }
            };
            Ok(())
        }

        fn DragLeave(&self) -> WinResult<()> {
            self.acceptable.set(false);
            let _ = self.app.emit("dock-drag-over", false);
            Ok(())
        }

        fn Drop(
            &self,
            pdataobj: Ref<'_, IDataObject>,
            _keys: MODIFIERKEYS_FLAGS,
            _pt: &POINTL,
            effect: *mut DROPEFFECT,
        ) -> WinResult<()> {
            let paths = pdataobj.as_ref().map(paths_of).unwrap_or_default();
            self.acceptable.set(false);
            unsafe { *effect = DROPEFFECT_COPY };
            trace(&format!("Drop: {paths:?}"));
            let _ = self.app.emit("dock-drag-over", false);
            if !paths.is_empty() {
                let _ = self.app.emit("dock-drop", paths);
            }
            Ok(())
        }
    }

    // ------------------------------------------------------------- katman

    unsafe extern "system" fn wndproc(h: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
        DefWindowProcW(h, msg, w, l)
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Ana is parcaciginda cagrilmali: pencere olusturur ve OLE hedefini baglar.
    pub fn ensure_overlay(app: &AppHandle) -> Result<HWND, String> {
        let existing = OVERLAY.load(Ordering::SeqCst);
        if existing != 0 {
            return Ok(HWND(existing as *mut core::ffi::c_void));
        }

        unsafe {
            let hinst = GetModuleHandleW(None).map_err(|e| e.to_string())?;
            let cls = wide(CLASS_NAME);
            let wc = WNDCLASSW {
                lpfnWndProc: Some(wndproc),
                hInstance: hinst.into(),
                lpszClassName: PCWSTR(cls.as_ptr()),
                ..Default::default()
            };
            // Ikinci kayit 0 doner; sinif zaten varsa sorun degil.
            RegisterClassW(&wc);

            let hwnd = CreateWindowExW(
                WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TOPMOST,
                PCWSTR(cls.as_ptr()),
                PCWSTR::null(),
                WS_POPUP,
                0,
                0,
                16,
                16,
                None,
                None,
                Some(hinst.into()),
                None,
            )
            .map_err(|e| format!("CreateWindowExW: {e}"))?;

            // Neredeyse gorunmez: dock altinda kalir ama hit-test alir.
            SetLayeredWindowAttributes(hwnd, COLORREF(0), 1, LWA_ALPHA)
                .map_err(|e| e.to_string())?;

            let target: IDropTarget = DockDropTarget::new(app.clone()).into();
            RegisterDragDrop(hwnd, &target).map_err(|e| format!("RegisterDragDrop: {e}"))?;
            std::mem::forget(target);

            OVERLAY.store(hwnd.0 as isize, Ordering::SeqCst);
            trace(&format!("drop overlay kuruldu: 0x{:x}", hwnd.0 as isize));
            Ok(hwnd)
        }
    }

    /// Ana is parcaciginda cagrilmali.
    pub fn set_active(app: &AppHandle, active: bool) {
        let Ok(hwnd) = ensure_overlay(app) else {
            return;
        };
        unsafe {
            if active {
                let Some((l, t, r, b)) = dock_rect() else {
                    return;
                };
                let _ = SetWindowPos(
                    hwnd,
                    Some(HWND_TOPMOST),
                    l,
                    t,
                    r - l,
                    b - t,
                    SWP_NOACTIVATE,
                );
                let _ = ShowWindow(hwnd, SW_SHOWNA);
            } else {
                let _ = ShowWindow(hwnd, SW_HIDE);
            }
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use tauri::AppHandle;
    pub fn own_hwnds() -> (isize, isize) {
        (0, 0)
    }
    pub fn set_hover(_on: bool) {}
    pub fn hovering() -> bool {
        false
    }
    pub fn set_dock_hwnd(_h: isize) {}
    pub fn set_panel_rect(_x: i32, _y: i32, _w: i32, _h: i32) {}
    pub fn set_input_lock(_locked: bool) {}
    pub fn input_locked() -> bool {
        false
    }
    pub fn set_dodge(_on: bool) {}
    pub fn dodging() -> bool {
        false
    }
    pub fn window_rect() -> Option<(i32, i32, i32, i32)> {
        None
    }
    pub fn dock_rect() -> Option<(i32, i32, i32, i32)> {
        None
    }
    pub fn set_active(_app: &AppHandle, _active: bool) {}
}

pub use imp::{
    dock_rect, dodging, hovering, input_locked, own_hwnds, set_active, set_dock_hwnd, set_hover,
    set_panel_rect,
};

/// Panel uzerinde fare var mi — frontend bildirir.
#[tauri::command]
pub fn set_pointer_over(over: bool) {
    set_hover(over);
}

/// Panelin pencere icindeki gorunur alani (fiziksel px, pencereye gore).
#[tauri::command]
pub fn set_hit_rect(x: i32, y: i32, w: i32, h: i32) {
    set_panel_rect(x, y, w, h);
}

/// Ikon surukleme baslarken/biterken frontend bildirir.
#[tauri::command]
pub fn set_input_lock(locked: bool) {
    imp::set_input_lock(locked);
}

/// "Pencere kacinma" modunu ac/kapat (Nexus: Dodge Windows).
#[tauri::command]
pub fn set_dodge(enabled: bool) {
    imp::set_dodge(enabled);
}
