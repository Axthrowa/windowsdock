//! WINDOWSDOCK_DEBUG=1 ile teshis satirlarini diske yazar. Degisken yoksa
//! cagri neredeyse bedava (tek env okumasi) — surum derlemesinde de kalabilir.

use std::io::Write;
use std::sync::OnceLock;

fn enabled() -> bool {
    static ON: OnceLock<bool> = OnceLock::new();
    *ON.get_or_init(|| std::env::var_os("WINDOWSDOCK_DEBUG").is_some())
}

pub fn trace(msg: &str) {
    if !enabled() {
        return;
    }
    let Some(dir) = std::env::var_os("LOCALAPPDATA").or_else(|| std::env::var_os("HOME")) else {
        return;
    };
    let path = std::path::Path::new(&dir)
        .join("com.axthrowa.windowsdock")
        .join("debug.log");
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{msg}");
    }
}

/// Frontend'in teshis satiri yazmasi icin (yalniz WINDOWSDOCK_DEBUG=1 iken).
#[tauri::command]
pub fn trace_js(msg: String) {
    trace(&format!("js: {msg}"));
}
