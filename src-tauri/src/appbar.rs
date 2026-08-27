//! Windows AppBar kaydi: dock'u gorev cubugu gibi ekran kenarina "yapistirir".
//!
//! ABM_SETPOS ile ayrilan serit calisma alanindan dusulur; bu sayede
//! ekrani kaplayan (maximize) pencereler dock'un altinda kalir, ustune binmez.
//! Auto-hide acikken veya serbest konumda rezervasyon yapilmaz.

#[cfg(windows)]
mod imp {
    use crate::trace::trace;
    use std::mem::size_of;
    use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::UI::Shell::{
        SHAppBarMessage, ABE_BOTTOM, ABE_LEFT, ABE_RIGHT, ABE_TOP, ABM_NEW, ABM_QUERYPOS,
        ABM_REMOVE, ABM_SETPOS, APPBARDATA,
    };

    /// Kabuk bu mesajla konum degisikligi bildirir; islenmese de kayit gecerlidir.
    const WM_APPBAR_CALLBACK: u32 = 0x0400 + 0x101;


    #[derive(Default)]
    pub struct AppBar {
        registered: AtomicBool,
        hwnd: AtomicIsize,
    }

    fn edge_code(edge: &str) -> u32 {
        match edge {
            "top" => ABE_TOP,
            "left" => ABE_LEFT,
            "right" => ABE_RIGHT,
            _ => ABE_BOTTOM,
        }
    }

    fn data(hwnd: isize) -> APPBARDATA {
        APPBARDATA {
            cbSize: size_of::<APPBARDATA>() as u32,
            hWnd: HWND(hwnd as *mut core::ffi::c_void),
            uCallbackMessage: WM_APPBAR_CALLBACK,
            ..Default::default()
        }
    }

    impl AppBar {
        /// Seridi ayirir ve kabugun onayladigi dikdortgeni dondurur.
        /// `mon` = monitorun tam dikdortgeni (fiziksel px), `thickness` = serit kalinligi.
        pub fn reserve(
            &self,
            hwnd: isize,
            edge: &str,
            mon: (i32, i32, i32, i32),
            thickness: i32,
        ) -> Option<(i32, i32, i32, i32)> {
            let (mx0, my0, mx1, my1) = mon;
            let t = thickness.max(1);

            unsafe {
                if !self.registered.swap(true, Ordering::SeqCst) {
                    let mut d = data(hwnd);
                    let ok = SHAppBarMessage(ABM_NEW, &mut d);
                    trace(&format!("ABM_NEW hwnd={hwnd:#x} -> {ok}"));
                    if ok == 0 {
                        self.registered.store(false, Ordering::SeqCst);
                        return None;
                    }
                    self.hwnd.store(hwnd, Ordering::SeqCst);
                }

                let mut d = data(hwnd);
                d.uEdge = edge_code(edge);
                d.rc = match edge {
                    "top" => RECT { left: mx0, top: my0, right: mx1, bottom: my0 + t },
                    "bottom" => RECT { left: mx0, top: my1 - t, right: mx1, bottom: my1 },
                    "left" => RECT { left: mx0, top: my0, right: mx0 + t, bottom: my1 },
                    _ => RECT { left: mx1 - t, top: my0, right: mx1, bottom: my1 },
                };

                // Kabuk diger appbar'lari hesaba katarak seridi kaydirabilir;
                // kalinligi biz yeniden sabitleriz.
                SHAppBarMessage(ABM_QUERYPOS, &mut d);
                match edge {
                    "top" => d.rc.bottom = d.rc.top + t,
                    "bottom" => d.rc.top = d.rc.bottom - t,
                    "left" => d.rc.right = d.rc.left + t,
                    _ => d.rc.left = d.rc.right - t,
                }
                let set = SHAppBarMessage(ABM_SETPOS, &mut d);
                trace(&format!(
                    "ABM_SETPOS edge={edge} t={t} -> {set} rect=({},{},{},{})",
                    d.rc.left, d.rc.top, d.rc.right, d.rc.bottom
                ));

                Some((d.rc.left, d.rc.top, d.rc.right, d.rc.bottom))
            }
        }

        pub fn release(&self) {
            if !self.registered.swap(false, Ordering::SeqCst) {
                return;
            }
            let hwnd = self.hwnd.load(Ordering::SeqCst);
            unsafe {
                let mut d = data(hwnd);
                SHAppBarMessage(ABM_REMOVE, &mut d);
            }
        }
    }

    impl Drop for AppBar {
        fn drop(&mut self) {
            self.release();
        }
    }
}

#[cfg(not(windows))]
mod imp {
    #[derive(Default)]
    pub struct AppBar;

    impl AppBar {
        pub fn reserve(
            &self,
            _hwnd: isize,
            _edge: &str,
            _mon: (i32, i32, i32, i32),
            _thickness: i32,
        ) -> Option<(i32, i32, i32, i32)> {
            None
        }
        pub fn release(&self) {}
    }
}

pub use imp::AppBar;
