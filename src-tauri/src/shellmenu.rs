//! Dock ogeleri icin gercek Windows kabuk baglam menusu.
//!
//! HTML menu iki sorun uretiyordu: dock kucuk bir pencere oldugu icin disina
//! yapilan tiklama bize hic ulasmiyor ve menu ekranda asili kaliyordu; ayrica
//! Windows'un dosya menusundeki secenekler (Yonetici olarak calistir, Dosya
//! konumunu ac, Ozellikler, Gonder...) yoktu. Kabugun kendi IContextMenu'sunu
//! kullanmak ikisini birden cozuyor: menuyu isletim sistemi yonetir.

#[cfg(windows)]
mod imp {
    use crate::trace::trace;
    use windows::core::{PCSTR, PCWSTR};
    use windows::Win32::Foundation::{HWND, POINT};
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::UI::Shell::Common::ITEMIDLIST;
    use windows::Win32::UI::Shell::{
        IContextMenu, IShellFolder, SHBindToParent, SHParseDisplayName, CMF_EXPLORE, CMF_NORMAL,
        CMINVOKECOMMANDINFO,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        AppendMenuW, CreatePopupMenu, DestroyMenu, GetCursorPos, PostMessageW,
        SetForegroundWindow, TrackPopupMenuEx, HMENU, MF_SEPARATOR, MF_STRING, TPM_RETURNCMD,
        TPM_RIGHTBUTTON, WM_NULL,
    };

    // Kabuk komutlari 1..=SHELL_MAX; kendi ogelerimiz bunun uzerinde.
    const SHELL_MIN: u32 = 1;
    const SHELL_MAX: u32 = 0x6FFF;
    const ID_REMOVE: u32 = 0x7001;
    const ID_ADD: u32 = 0x7002;
    const ID_SETTINGS: u32 = 0x7003;
    const ID_HIDE: u32 = 0x7004;
    const ID_QUIT: u32 = 0x7005;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn append(menu: HMENU, id: u32, text: &str) {
        let t = wide(text);
        unsafe {
            let _ = AppendMenuW(menu, MF_STRING, id as usize, PCWSTR(t.as_ptr()));
        }
    }

    fn separator(menu: HMENU) {
        unsafe {
            let _ = AppendMenuW(menu, MF_SEPARATOR, 0, PCWSTR::null());
        }
    }

    /// Kabugun dosya menusunu `menu`ye doldurur; basarisizsa None.
    unsafe fn fill_shell(menu: HMENU, hwnd: HWND, path: &str) -> Option<IContextMenu> {
        let w = wide(path);
        let mut pidl: *mut ITEMIDLIST = std::ptr::null_mut();
        SHParseDisplayName(PCWSTR(w.as_ptr()), None, &mut pidl, 0, None).ok()?;
        if pidl.is_null() {
            return None;
        }

        let mut child: *mut ITEMIDLIST = std::ptr::null_mut();
        let folder: Option<IShellFolder> = SHBindToParent(pidl, Some(&mut child)).ok();

        let out = match folder {
            Some(folder) if !child.is_null() => {
                let cm: Option<IContextMenu> = folder
                    .GetUIObjectOf(hwnd, &[child as *const ITEMIDLIST], None)
                    .ok();
                match cm {
                    Some(cm) => {
                        let hr = cm.QueryContextMenu(menu, 0, SHELL_MIN, SHELL_MAX, CMF_NORMAL | CMF_EXPLORE);
                        if hr.is_ok() {
                            Some(cm)
                        } else {
                            trace(&format!("QueryContextMenu hata: {hr:?}"));
                            None
                        }
                    }
                    None => None,
                }
            }
            _ => None,
        };

        CoTaskMemFree(Some(pidl as *const core::ffi::c_void));
        out
    }

    /// Ana is parcaciginda cagrilmali; menu kapanana kadar bloklar.
    pub fn show(hwnd: HWND, path: Option<&str>, removable: bool, l: &super::MenuLabels) -> String {
        unsafe {
            let Ok(menu) = CreatePopupMenu() else {
                return String::new();
            };

            let shell = path.and_then(|p| fill_shell(menu, hwnd, p));
            if shell.is_some() {
                separator(menu);
            }
            if removable {
                append(menu, ID_REMOVE, &l.remove);
                separator(menu);
            }
            append(menu, ID_SETTINGS, &l.settings);
            append(menu, ID_ADD, &l.add);
            separator(menu);
            append(menu, ID_HIDE, &l.hide);
            append(menu, ID_QUIT, &l.quit);

            let mut pt = POINT::default();
            let _ = GetCursorPos(&mut pt);

            // Menuye sag tiklandiginda pencere zaten etkinlesir; on plana almak
            // menunun disari tiklamayla kapanmasini garantiler.
            // (AttachThreadInput ile zorlamak Defender'in keylogger sezgilerini
            // tetikliyor ve gercek kullanimda gerekmiyor.)
            let _ = SetForegroundWindow(hwnd);

            let cmd = TrackPopupMenuEx(
                menu,
                (TPM_RETURNCMD | TPM_RIGHTBUTTON).0,
                pt.x,
                pt.y,
                hwnd,
                None,
            );
            // Belgelenmis kapanma duzeltmesi.
            let _ = PostMessageW(Some(hwnd), WM_NULL, Default::default(), Default::default());
            let cmd = cmd.0 as u32;

            let action = match cmd {
                0 => String::new(),
                ID_REMOVE => "remove".into(),
                ID_ADD => "add".into(),
                ID_SETTINGS => "settings".into(),
                ID_HIDE => "hide".into(),
                ID_QUIT => "quit".into(),
                id if (SHELL_MIN..=SHELL_MAX).contains(&id) => {
                    if let Some(cm) = shell.as_ref() {
                        let info = CMINVOKECOMMANDINFO {
                            cbSize: std::mem::size_of::<CMINVOKECOMMANDINFO>() as u32,
                            hwnd,
                            lpVerb: PCSTR((id - SHELL_MIN) as usize as *const u8),
                            nShow: 1, // SW_SHOWNORMAL
                            ..Default::default()
                        };
                        if let Err(e) = cm.InvokeCommand(&info) {
                            trace(&format!("InvokeCommand hata: {e}"));
                        }
                    }
                    String::new()
                }
                _ => String::new(),
            };

            let _ = DestroyMenu(menu);
            trace(&format!("menu secim: cmd={cmd} -> '{action}'"));
            action
        }
    }
}

/// Menu etiketleri frontend'den gelir: ceviriler tek yerde (i18n.ts) tutuluyor.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuLabels {
    pub remove: String,
    pub add: String,
    pub settings: String,
    pub hide: String,
    pub quit: String,
}

/// Dock ogesine (veya bos alana) sag tiklandiginda cagrilir.
/// Donen deger: "" | "remove" | "add" | "settings" | "hide" | "quit"
#[tauri::command]
pub fn show_item_menu(
    app: tauri::AppHandle,
    path: Option<String>,
    removable: bool,
    labels: MenuLabels,
) -> Result<String, String> {
    #[cfg(not(windows))]
    {
        let _ = (&app, &path, removable, &labels);
        Ok(String::new())
    }

    #[cfg(windows)]
    {
        use tauri::Manager;
        let win = app
            .get_webview_window("dock")
            .ok_or("dock penceresi yok")?;
        let hwnd = win.hwnd().map_err(|e| e.to_string())?;
        let raw = hwnd.0 as isize;

        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        app.run_on_main_thread(move || {
            let h = windows::Win32::Foundation::HWND(raw as *mut core::ffi::c_void);
            let _ = tx.send(imp::show(h, path.as_deref(), removable, &labels));
        })
        .map_err(|e| e.to_string())?;

        // Menu kullanici kapatana kadar acik kalir; comert bir ust sinir.
        let action = rx
            .recv_timeout(std::time::Duration::from_secs(120))
            .map_err(|_| "menu zaman asimi".to_string())?;

        // Pencere islemlerini burada bitiriyoruz; frontend'e yalniz oge
        // yonetimi ("remove"/"add") kaliyor.
        match action.as_str() {
            "settings" => {
                if let Err(e) = crate::window::open_settings(app.clone()) {
                    crate::trace::trace(&format!("menu -> open_settings hata: {e}"));
                }
                Ok(String::new())
            }
            "hide" => {
                if let Some(w) = app.get_webview_window("dock") {
                    let _ = w.hide();
                }
                Ok(String::new())
            }
            "quit" => {
                app.exit(0);
                Ok(String::new())
            }
            _ => Ok(action),
        }
    }
}
