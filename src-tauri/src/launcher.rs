use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
const DETACHED_PROCESS: u32 = 0x0000_0008;

/// "https://x", "ms-settings:", "shell:startup" gibi URI'leri surucu harfinden ayirir.
fn is_uri(target: &str) -> bool {
    match target.find(':') {
        // C:\... -> surucu harfi, URI degil
        Some(1) | None => false,
        Some(i) => target[..i]
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.')),
    }
}

fn needs_shell(target: &str, p: &Path) -> bool {
    if is_uri(target) {
        return true;
    }
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    matches!(ext.as_str(), "lnk" | "url" | "appref-ms" | "msc" | "cpl")
}

/// Dock ogesini baslatir. Ana surece bagli olmayan (detached) bir cocuk process
/// olusturur; dock kapansa bile uygulama acik kalir.
#[tauri::command]
pub fn launch_item(path: String, args: Vec<String>) -> Result<(), String> {
    let target = path.trim().to_string();
    if target.is_empty() {
        return Err("bos hedef".into());
    }
    let p = PathBuf::from(&target);

    #[cfg(windows)]
    {
        if needs_shell(&target, &p) {
            return shell_start(&target, &args);
        }

        if p.is_dir() {
            return Command::new("explorer.exe")
                .arg(&p)
                .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS)
                .spawn()
                .map(|_| ())
                .map_err(|e| format!("klasor acilamadi: {e}"));
        }

        let mut cmd = Command::new(&p);
        cmd.args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(DETACHED_PROCESS);

        // Calisma dizinini exe'nin yanina sabitle (rel. asset yukleyen uygulamalar icin).
        if let Some(dir) = p.parent() {
            if dir.is_dir() {
                cmd.current_dir(dir);
            }
        }

        match cmd.spawn() {
            Ok(_) => Ok(()),
            // PATH/App-Execution-Alias durumlarinda shell'e dus.
            Err(_) => shell_start(&target, &args),
        }
    }

    #[cfg(not(windows))]
    {
        let _ = needs_shell(&target, &p);
        Command::new("xdg-open")
            .arg(&target)
            .args(&args)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("baslatilamadi: {e}"))
    }
}

#[cfg(windows)]
fn shell_start(target: &str, args: &[String]) -> Result<(), String> {
    // cmd /C start "" "<hedef>" [args...]
    Command::new("cmd")
        .arg("/C")
        .arg("start")
        .arg("")
        .arg(target)
        .args(args)
        .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("shell baslatma hatasi: {e}"))
}

/// Dock'tan disari suruklenen kisayolu masaustune geri koyar.
/// - Kaynak .lnk ise masaustune kopyalanir (zaten oradaysa dokunulmaz)
/// - Degilse hedefe isaret eden yeni bir .lnk olusturulur
#[tauri::command]
pub fn eject_to_desktop(path: String, label: String) -> Result<String, String> {
    #[cfg(not(windows))]
    {
        let _ = (&path, &label);
        Err("yalniz Windows".into())
    }

    #[cfg(windows)]
    {
        use std::path::{Path, PathBuf};
        use windows::core::{Interface, PCWSTR};
        use windows::Win32::System::Com::{
            CoCreateInstance, CoTaskMemFree, IPersistFile, CLSCTX_INPROC_SERVER,
        };
        use windows::Win32::UI::Shell::{
            IShellLinkW, SHGetKnownFolderPath, ShellLink, FOLDERID_Desktop, KF_FLAG_DEFAULT,
        };

        fn wide(s: &str) -> Vec<u16> {
            s.encode_utf16().chain(std::iter::once(0)).collect()
        }

        let desktop: PathBuf = unsafe {
            let p = SHGetKnownFolderPath(&FOLDERID_Desktop, KF_FLAG_DEFAULT, None)
                .map_err(|e| format!("masaustu klasoru bulunamadi: {e}"))?;
            let s = p.to_string().map_err(|e| e.to_string())?;
            CoTaskMemFree(Some(p.0 as *const core::ffi::c_void));
            PathBuf::from(s)
        };

        let src = Path::new(&path);
        let is_lnk = src
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("lnk"));

        // Ayni isimde dosya varsa " (2)", " (3)" ... ekle.
        let unique = |stem: &str| -> PathBuf {
            let mut candidate = desktop.join(format!("{stem}.lnk"));
            let mut n = 2;
            while candidate.exists() {
                candidate = desktop.join(format!("{stem} ({n}).lnk"));
                n += 1;
            }
            candidate
        };

        if is_lnk && src.is_file() {
            if src.parent() == Some(desktop.as_path()) {
                return Ok(path); // zaten masaustunde
            }
            let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or(&label);
            let dest = unique(stem);
            std::fs::copy(src, &dest).map_err(|e| format!("kopyalanamadi: {e}"))?;
            return Ok(dest.to_string_lossy().into_owned());
        }

        // Yeni kisayol olustur.
        let dest = unique(if label.trim().is_empty() { "Kisayol" } else { label.trim() });
        unsafe {
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| format!("ShellLink olusturulamadi: {e}"))?;
            let target = wide(&path);
            link.SetPath(PCWSTR(target.as_ptr()))
                .map_err(|e| e.to_string())?;
            if let Some(dir) = src.parent().filter(|d| d.is_dir()) {
                let w = wide(&dir.to_string_lossy());
                let _ = link.SetWorkingDirectory(PCWSTR(w.as_ptr()));
            }
            let persist: IPersistFile = link.cast().map_err(|e| e.to_string())?;
            let out = wide(&dest.to_string_lossy());
            persist
                .Save(PCWSTR(out.as_ptr()), true)
                .map_err(|e| format!("kisayol yazilamadi: {e}"))?;
        }
        Ok(dest.to_string_lossy().into_owned())
    }
}
