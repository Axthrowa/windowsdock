//! Calisan uygulama gostergesi (Nexus: "Running Indicator").
//!
//! Ust duzey PENCERELERDEN yola cikariz (gorev cubugunun yaptigi is).
//! (Tum surecleri listeleyen anlik goruntu yontemi bilerek kullanilmadi:
//! zararli yazilim sezgilerini tetikliyor — bkz. dragwatch'taki GetAsyncKeyState
//! notu. Ayrica dock icin "penceresi olan uygulama" zaten daha dogru olcut.)
//!
//! Kisayol cozumlemesi pahali oldugu icin yol -> hedef exe eslemesi onbelleklenir.

#[cfg(windows)]
mod imp {
    use std::collections::{HashMap, HashSet};
    use std::sync::Mutex;
    use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM};
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowThreadProcessId};

    /// yol -> hedef exe (kisayol cozumlemesi bir kez yapilir)
    static TARGETS: Mutex<Option<HashMap<String, Option<String>>>> = Mutex::new(None);

    unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> windows::core::BOOL {
        let pids = &mut *(lparam.0 as *mut Vec<u32>);

        // Ust duzey penceresi olan her surec sayilir. Gorunurluk sarti YOK:
        // tepsiye kuculmus uygulamalarin (oyun istemcileri, sohbet programlari)
        // penceresi gizli olur ama uygulama calisiyordur.
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid != 0 && !pids.contains(&pid) {
            pids.push(pid);
        }
        true.into()
    }

    /// Penceresi olan uygulamalarin exe adlari (kucuk harf).
    fn running_names() -> HashSet<String> {
        let mut pids: Vec<u32> = Vec::new();
        unsafe {
            let _ = EnumWindows(Some(collect), LPARAM(&mut pids as *mut _ as isize));
        }

        let mut out = HashSet::new();
        for pid in pids {
            unsafe {
                let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
                    continue;
                };
                let mut buf = [0u16; 260];
                let mut len = buf.len() as u32;
                if QueryFullProcessImageNameW(
                    h,
                    PROCESS_NAME_FORMAT(0),
                    windows::core::PWSTR(buf.as_mut_ptr()),
                    &mut len,
                )
                .is_ok()
                    && len > 0
                {
                    let full = String::from_utf16_lossy(&buf[..len as usize]);
                    if let Some(name) = std::path::Path::new(&full).file_name().and_then(|f| f.to_str())
                    {
                        out.insert(name.to_lowercase());
                    }
                }
                let _ = CloseHandle(h);
            }
        }
        out
    }

    pub fn flags(paths: &[String]) -> Vec<bool> {
        let names = running_names();
        let mut guard = TARGETS.lock().unwrap();
        let cache = guard.get_or_insert_with(HashMap::new);

        paths
            .iter()
            .map(|p| {
                let target = cache
                    .entry(p.clone())
                    .or_insert_with(|| crate::icons::resolve_target(p));
                target
                    .as_deref()
                    .and_then(|t| std::path::Path::new(t).file_name())
                    .and_then(|f| f.to_str())
                    .map(|f| names.contains(&f.to_lowercase()))
                    .unwrap_or(false)
            })
            .collect()
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn flags(paths: &[String]) -> Vec<bool> {
        vec![false; paths.len()]
    }
}

/// Verilen yollarin her biri icin "calisiyor mu" bilgisi (sirali).
#[tauri::command]
pub fn running_flags(paths: Vec<String>) -> Vec<bool> {
    imp::flags(&paths)
}

/// Geri donusum kutusu bos mu? (Nexus: Recycler modulu)
#[tauri::command]
pub fn recycler_empty() -> bool {
    #[cfg(windows)]
    {
        use windows::core::PCWSTR;
        use windows::Win32::UI::Shell::{SHQueryRecycleBinW, SHQUERYRBINFO};

        let mut info = SHQUERYRBINFO {
            cbSize: std::mem::size_of::<SHQUERYRBINFO>() as u32,
            ..Default::default()
        };
        unsafe { SHQueryRecycleBinW(PCWSTR::null(), &mut info).is_ok() && info.i64NumItems == 0 }
    }
    #[cfg(not(windows))]
    {
        true
    }
}
