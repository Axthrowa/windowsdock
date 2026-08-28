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
/// `target`: ogenin kayitli .lnk hedefi; `path` artik diskte yoksa bu calisir.
pub fn launch_item(
    path: String,
    args: Vec<String>,
    target: Option<String>,
) -> Result<(), String> {
    let mut target_path = path.trim().to_string();
    if target_path.is_empty() {
        return Err("bos hedef".into());
    }
    // Kisayol silinmisse ogeyi olu birakmiyoruz: eklenirken cozulen gercek
    // dosyaya dusuyoruz. Kosul MUTLAK yola bakiyor -- "notepad.exe" gibi
    // PATH'ten cozulen adlar ve URI'ler dosya olarak var olmaz.
    if let Some(fallback) = target.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        let p = Path::new(&target_path);
        if p.is_absolute() && !p.exists() && Path::new(fallback).exists() {
            target_path = fallback.to_string();
        }
    }
    let target = target_path;
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

/// Bir .lnk/.url'yi uygulamanin kendi klasorune kopyalar ve kopyanin yolunu
/// dondurur; kisayol degilse None.
///
/// Neden kopya: kullanici kisayolu dock'a attiktan sonra masaustundekini
/// siliyor (dock'un varlik sebebi zaten masaustunu bosaltmak). Dock elinde
/// yalnizca o dosyanin YOLU olsaydi oge tamamen olu kalirdi. Sadece hedef
/// .exe'yi saklamak da yetmez: .lnk kendi argumanlarini ve calisma dizinini
/// tasiyor ("RiotClientServices.exe --launch-product=valorant" gibi), hedefi
/// dogrudan calistirmak yanlis seyi acardi. Dosyanin tamamini kopyalayinca
/// ikon, argumanlar, calisma dizini ve masaustune geri koyma aynen korunuyor.
/// Id'yi dosya adi olarak guvenli hale getirir (yol ayraci, surucu harfi yok).
fn safe_id(id: &str) -> String {
    id.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect()
}

#[tauri::command]
pub fn stash_shortcut(app: tauri::AppHandle, id: String, path: String) -> Result<Option<String>, String> {
    use tauri::Manager;

    let src = Path::new(path.trim());
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(ext.as_str(), "lnk" | "url") || !src.is_file() {
        return Ok(None);
    }

    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("config dizini alinamadi: {e}"))?
        .join("shortcuts");
    std::fs::create_dir_all(&dir).map_err(|e| format!("kisayol dizini olusturulamadi: {e}"))?;

    // Dosya adi ogenin id'si: silinen oge ile kopyasi tek eslesmede.
    let dest = dir.join(format!("{}.{ext}", safe_id(&id)));
    std::fs::copy(src, &dest).map_err(|e| format!("kisayol kopyalanamadi: {e}"))?;
    Ok(Some(dest.to_string_lossy().into_owned()))
}

/// Config'de artik gecmeyen kisayol kopyalarini siler (oge kaldirilinca kalan).
#[tauri::command]
pub fn prune_shortcuts(app: tauri::AppHandle, keep: Vec<String>) -> Result<(), String> {
    use tauri::Manager;

    let dir = match app.path().app_config_dir() {
        Ok(d) => d.join("shortcuts"),
        Err(_) => return Ok(()),
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(()); // klasor yoksa yapacak is yok
    };
    let keep: std::collections::HashSet<String> = keep.iter().map(|i| safe_id(i)).collect();
    for e in entries.flatten() {
        let p = e.path();
        let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or_default();
        if !stem.is_empty() && !keep.contains(stem) {
            let _ = std::fs::remove_file(&p);
        }
    }
    Ok(())
}

/// Dock'tan disari suruklenen kisayolu masaustune geri koyar.
/// - Kaynak .lnk ise masaustune kopyalanir (zaten oradaysa dokunulmaz)
/// - Degilse hedefe isaret eden yeni bir .lnk olusturulur
#[tauri::command]
/// `target`: ogenin kayitli .lnk hedefi; `path` artik diskte yoksa kisayol
/// buna kurulur.
pub fn eject_to_desktop(
    path: String,
    label: String,
    target: Option<String>,
) -> Result<String, String> {
    #[cfg(not(windows))]
    {
        let _ = (&path, &label, &target);
        Err("yalniz Windows".into())
    }

    #[cfg(windows)]
    {
        use std::path::{Path, PathBuf};
        use windows::core::{Interface, PCWSTR};
        use windows::Win32::System::Com::{
            CoCreateInstance, CoInitializeEx, CoTaskMemFree, IPersistFile, CLSCTX_INPROC_SERVER,
            COINIT_APARTMENTTHREADED,
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

        // Masaustundeki asil kisayol silinmisse ogenin yolu olu demektir:
        // eklenirken cozulmus gercek hedefe dusuyoruz. O da yoksa kirik bir
        // .lnk uretmek yerine hata donduruyoruz; cagiran taraf ogeyi dock'ta
        // birakiyor. Kosul MUTLAK yola bakiyor -- "notepad.exe" gibi PATH'ten
        // cozulen adlar ve "ms-settings:" gibi URI'ler dosya olarak var olmaz
        // ve onlarin kisayolu dogrudan kurulabilir.
        let dead = {
            let p = Path::new(&path);
            p.is_absolute() && !p.exists()
        };
        let path: String = if dead {
            match target.as_deref().map(str::trim).filter(|t| Path::new(t).exists()) {
                Some(t) => t.to_string(),
                None => return Err(format!("kaynak artik yok: {path}")),
            }
        } else {
            path
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
            // Etiket oncelikli: kaynak uygulamanin kendi kopyasiysa dosya adi
            // ogenin id'sidir, masaustune o adla koymak anlamsiz olurdu.
            let stem = if label.trim().is_empty() {
                src.file_stem().and_then(|s| s.to_str()).unwrap_or("Kisayol")
            } else {
                label.trim()
            };
            let dest = unique(stem);
            std::fs::copy(src, &dest).map_err(|e| format!("kopyalanamadi: {e}"))?;
            return Ok(dest.to_string_lossy().into_owned());
        }

        // Yeni kisayol olustur.
        let dest = unique(if label.trim().is_empty() { "Kisayol" } else { label.trim() });
        unsafe {
            // Komut Tauri'nin is parcacigi havuzunda calisiyor; orada COM
            // baslatilmis degil ve CoCreateInstance CO_E_NOTINITIALIZED
            // donuyordu. Hata yukarida yutuldugu icin oge dock'tan siliniyor
            // ama masaustune hicbir sey konmuyordu. (icons.rs ayni sebeple
            // kendi co_init'ini yapiyor.) Zaten baska modda baslatilmissa yut.
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
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
