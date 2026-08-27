//! Bosta calisma seti kirpma.
//!
//! WebView2 mimarisi geregi 5-6 surec calisir (browser, gpu, renderer, ag,
//! depolama, crashpad) ve acilistan sonra hepsi gereginden fazla sayfa tutar.
//! Dock bosta iken (imlec panelin uzerinde degil, surukleme yok) bu sayfalarin
//! calisma setinden dusurulmesi Windows'un uygulama kucultuldugunde yaptigi
//! seyin aynisidir: veri kaybolmaz, yeniden dokunuldugunda geri gelir.
//!
//! Kazanc olcumle ~350 MB -> ~60 MB (Gorev Yoneticisi'nde gorunen deger).

#[cfg(windows)]
mod imp {
    use std::collections::HashMap;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::ProcessStatus::EmptyWorkingSet;
    use windows::Win32::System::Threading::{
        GetCurrentProcess, OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_SET_QUOTA,
    };

    /// Kendi surecimiz + tum alt surecler (WebView2 agaci).
    pub fn trim() {
        unsafe {
            let _ = EmptyWorkingSet(GetCurrentProcess());
        }
        for pid in descendants(std::process::id()) {
            unsafe {
                let Ok(h) = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_SET_QUOTA, false, pid)
                else {
                    continue;
                };
                let _ = EmptyWorkingSet(h);
                let _ = CloseHandle(HANDLE(h.0));
            }
        }
    }

    fn descendants(root: u32) -> Vec<u32> {
        let mut kids: HashMap<u32, Vec<u32>> = HashMap::new();
        unsafe {
            let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
                return Vec::new();
            };
            let mut e = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            if Process32FirstW(snap, &mut e).is_ok() {
                loop {
                    kids.entry(e.th32ParentProcessID)
                        .or_default()
                        .push(e.th32ProcessID);
                    if Process32NextW(snap, &mut e).is_err() {
                        break;
                    }
                }
            }
            let _ = CloseHandle(snap);
        }

        let mut out = Vec::new();
        let mut queue = vec![root];
        while let Some(p) = queue.pop() {
            if let Some(children) = kids.get(&p) {
                for c in children {
                    // Dongu ihtimaline karsi (pid yeniden kullanimi)
                    if *c != root && !out.contains(c) {
                        out.push(*c);
                        queue.push(*c);
                    }
                }
            }
        }
        out
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn trim() {}
}

pub use imp::trim;
