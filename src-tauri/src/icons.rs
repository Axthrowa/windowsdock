//! Kisayol/exe ikonlarinin Windows kabuk API'siyle cikarilmasi ve PNG onbellegi.
//!
//! Ikonlar bir kez cikarilir, `%LOCALAPPDATA%\...\cache\icons\<hash>.png` altina
//! yazilir ve asset protokolu uzerinden dogrudan <img> ile gosterilir. Boylece
//! her acilista COM/GDI maliyeti odenmez.

use std::fs;
use tauri::{AppHandle, Manager};

/// Yol + son degisiklik zamanindan turetilen kararli onbellek anahtari (FNV-1a 64).
fn cache_key(path: &str, stamp: u64) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in path.as_bytes().iter().chain(stamp.to_le_bytes().iter()) {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:016x}")
}

/// Bir .lnk'nin isaret ettigi gercek dosyayi dondurur (.lnk degilse dosyanin
/// kendisi, cozulemezse None). Oge dock'a eklenirken bir kez cagrilir; sonuc
/// `DockItem.target` icinde saklanir ki kaynak kisayol silinse bile ikon ve
/// "masaustune geri koy" calismaya devam etsin.
#[tauri::command]
pub fn resolve_link_target(path: String) -> Option<String> {
    resolve_target(&path)
}

/// Bir dock ogesi icin ikon PNG'sinin diskteki yolunu dondurur.
/// Cikarilamayan hedefler (URI, kayip dosya) icin `None` -> UI harf fallback'i cizer.
#[tauri::command]
/// `target`: ogenin kayitli .lnk hedefi; `path` artik diskte yoksa ikon oradan
/// cikarilir.
pub fn resolve_icon(
    app: AppHandle,
    path: String,
    target: Option<String>,
) -> Result<Option<String>, String> {
    #[cfg(not(windows))]
    {
        let _ = (&app, &path, &target);
        Ok(None)
    }

    #[cfg(windows)]
    {
        // Once ogenin kendi yolu, olmazsa eklenirken cozulmus hedef.
        let Some(target) = imp::locate(&path).or_else(|| {
            target
                .as_deref()
                .map(str::trim)
                .filter(|t| !t.is_empty())
                .and_then(imp::locate)
        }) else {
            return Ok(None);
        };

        let stamp = fs::metadata(&target)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);

        let dir = app
            .path()
            .app_cache_dir()
            .map_err(|e| format!("cache dizini alinamadi: {e}"))?
            .join("icons");
        fs::create_dir_all(&dir).map_err(|e| format!("cache dizini olusturulamadi: {e}"))?;

        let out = dir.join(format!("{}.png", cache_key(&target, stamp)));
        if out.is_file() {
            return Ok(Some(out.to_string_lossy().into_owned()));
        }

        match imp::extract_png(&target) {
            Some(bytes) => {
                fs::write(&out, bytes).map_err(|e| format!("ikon yazilamadi: {e}"))?;
                Ok(Some(out.to_string_lossy().into_owned()))
            }
            None => Ok(None),
        }
    }
}

/// Bir dock hedefinin (kisayol/PATH adi) diskteki gercek dosyasi.
/// Calisan uygulama gostergesi de bunu kullanir.
pub fn resolve_target(path: &str) -> Option<String> {
    #[cfg(windows)]
    {
        imp::locate(path)
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        None
    }
}

#[cfg(windows)]
mod imp {
    use std::ffi::c_void;
    use std::mem::size_of;
    use std::path::{Path, PathBuf};

    use windows::core::{Interface, PCWSTR};
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP, HGDIOBJ,
    };
    use windows::Win32::Storage::FileSystem::SearchPathW;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, IPersistFile, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED, STGM_READ,
    };
    use windows::Win32::UI::Controls::IImageList;
    use windows::Win32::UI::Shell::{
        IShellLinkW, SHGetFileInfoW, SHGetImageList, ShellLink, SHFILEINFOW, SHGFI_SYSICONINDEX,
        SLGP_RAWPATH,
    };
    use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO};

    // shellapi.h icindeki SHIL_* sabitleri windows-rs'te disari verilmiyor.
    const SHIL_EXTRALARGE: i32 = 2;
    const SHIL_JUMBO: i32 = 4;
    const ILD_TRANSPARENT: u32 = 1;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Bir hedefi diskteki gercek dosyaya cozer:
    /// URI -> None, .lnk -> hedef exe, ciplak isim -> PATH aramasi.
    pub fn locate(target: &str) -> Option<String> {
        let t = target.trim();
        if t.is_empty() {
            return None;
        }
        // "ms-settings:", "https://..." gibi semalar dosya degildir.
        if let Some(i) = t.find(':') {
            if i != 1 {
                return None;
            }
        }

        let p = Path::new(t);
        let resolved: PathBuf = if p.is_absolute() {
            p.to_path_buf()
        } else {
            search_path(t)?
        };

        if resolved
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("lnk"))
        {
            if let Some(dest) = shortcut_target(&resolved) {
                return Some(dest);
            }
        }

        resolved
            .is_file()
            .then(|| resolved.to_string_lossy().into_owned())
            .or_else(|| resolved.is_dir().then(|| resolved.to_string_lossy().into_owned()))
    }

    fn search_path(name: &str) -> Option<PathBuf> {
        let w = wide(name);
        let mut buf = [0u16; 1024];
        let len = unsafe {
            SearchPathW(
                PCWSTR::null(),
                PCWSTR(w.as_ptr()),
                PCWSTR::null(),
                Some(&mut buf),
                None,
            )
        };
        if len == 0 || len as usize >= buf.len() {
            return None;
        }
        Some(PathBuf::from(String::from_utf16_lossy(&buf[..len as usize])))
    }

    fn co_init() {
        unsafe {
            // Zaten baska bir modda baslatilmissa hatayi yut.
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        }
    }

    fn shortcut_target(lnk: &Path) -> Option<String> {
        co_init();
        unsafe {
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
            let persist: IPersistFile = link.cast().ok()?;
            let w = wide(&lnk.to_string_lossy());
            persist.Load(PCWSTR(w.as_ptr()), STGM_READ).ok()?;

            let mut buf = [0u16; 1024];
            link.GetPath(&mut buf, std::ptr::null_mut(), SLGP_RAWPATH.0 as u32)
                .ok()?;
            let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
            (end > 0).then(|| String::from_utf16_lossy(&buf[..end]))
        }
    }

    /// Kabuk goruntu listesinden en yuksek cozunurluklu ikonu alip PNG'ye kodlar.
    pub fn extract_png(path: &str) -> Option<Vec<u8>> {
        co_init();
        let index = sys_icon_index(path)?;

        // Once JUMBO (256px); ikon o boyutu tasimiyorsa icerik kucuk bir kutuya
        // sikisir, bu durumda EXTRALARGE (48px) daha net sonuc verir.
        for shil in [SHIL_JUMBO, SHIL_EXTRALARGE] {
            let Some((w, h, rgba)) = icon_from_list(shil, index) else {
                continue;
            };
            let Some((cw, ch, cropped)) = crop_to_content(w, h, &rgba) else {
                continue;
            };
            if shil == SHIL_JUMBO && cw <= 64 && ch <= 64 {
                continue; // dolgu tespit edildi, bir sonraki boyutu dene
            }
            return encode_png(cw, ch, &cropped);
        }
        None
    }

    fn sys_icon_index(path: &str) -> Option<i32> {
        let w = wide(path);
        let mut info = SHFILEINFOW::default();
        let ok = unsafe {
            SHGetFileInfoW(
                PCWSTR(w.as_ptr()),
                Default::default(),
                Some(&mut info),
                size_of::<SHFILEINFOW>() as u32,
                SHGFI_SYSICONINDEX,
            )
        };
        (ok != 0).then_some(info.iIcon)
    }

    fn icon_from_list(shil: i32, index: i32) -> Option<(u32, u32, Vec<u8>)> {
        unsafe {
            let list: IImageList = SHGetImageList(shil).ok()?;
            let hicon = list.GetIcon(index, ILD_TRANSPARENT).ok()?;
            let out = hicon_to_rgba(hicon);
            let _ = DestroyIcon(hicon);
            out
        }
    }

    unsafe fn hicon_to_rgba(hicon: HICON) -> Option<(u32, u32, Vec<u8>)> {
        let mut ii = ICONINFO::default();
        GetIconInfo(hicon, &mut ii).ok()?;

        let color = ii.hbmColor;
        let mask = ii.hbmMask;
        let result = (|| {
            let mut bm = BITMAP::default();
            if GetObjectW(
                HGDIOBJ(color.0),
                size_of::<BITMAP>() as i32,
                Some(&mut bm as *mut _ as *mut c_void),
            ) == 0
            {
                return None;
            }
            let (w, h) = (bm.bmWidth.max(0) as u32, bm.bmHeight.max(0) as u32);
            if w == 0 || h == 0 {
                return None;
            }

            let mut rgba = read_dib(color, w, h)?;

            // 32-bit olmayan ikonlarda alfa kanali bos gelir; maske bitmap'inden turet.
            if rgba.chunks_exact(4).all(|p| p[3] == 0) {
                let m = read_dib(mask, w, h)?;
                for (px, mp) in rgba.chunks_exact_mut(4).zip(m.chunks_exact(4)) {
                    px[3] = if mp[0] > 127 { 0 } else { 255 };
                }
            }
            Some((w, h, rgba))
        })();

        if !color.is_invalid() {
            let _ = DeleteObject(HGDIOBJ(color.0));
        }
        if !mask.is_invalid() {
            let _ = DeleteObject(HGDIOBJ(mask.0));
        }
        result
    }

    /// Top-down 32bpp DIB okur ve BGRA -> RGBA cevirir.
    unsafe fn read_dib(bmp: HBITMAP, w: u32, h: u32) -> Option<Vec<u8>> {
        let hdc = CreateCompatibleDC(None);
        if hdc.is_invalid() {
            return None;
        }
        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w as i32,
                biHeight: -(h as i32), // negatif = top-down
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut buf = vec![0u8; (w as usize) * (h as usize) * 4];
        let lines = GetDIBits(
            hdc,
            bmp,
            0,
            h,
            Some(buf.as_mut_ptr() as *mut c_void),
            &mut info,
            DIB_RGB_COLORS,
        );
        let _ = DeleteDC(hdc);
        if lines == 0 {
            return None;
        }
        for px in buf.chunks_exact_mut(4) {
            px.swap(0, 2); // BGRA -> RGBA
        }
        Some(buf)
    }

    /// Seffaf cerceveyi kirpar, sonucu kareye tamamlar.
    fn crop_to_content(w: u32, h: u32, rgba: &[u8]) -> Option<(u32, u32, Vec<u8>)> {
        let (mut x0, mut y0, mut x1, mut y1) = (w, h, 0u32, 0u32);
        for y in 0..h {
            for x in 0..w {
                if rgba[((y * w + x) * 4 + 3) as usize] > 8 {
                    x0 = x0.min(x);
                    y0 = y0.min(y);
                    x1 = x1.max(x);
                    y1 = y1.max(y);
                }
            }
        }
        if x1 < x0 || y1 < y0 {
            return None; // tamamen seffaf
        }

        // Kare kutuya genislet, goruntu sinirlarina kenetle.
        let side = (x1 - x0 + 1).max(y1 - y0 + 1);
        let cx = (x0 + x1 + 1) / 2;
        let cy = (y0 + y1 + 1) / 2;
        let sx = cx.saturating_sub(side / 2).min(w.saturating_sub(side));
        let sy = cy.saturating_sub(side / 2).min(h.saturating_sub(side));
        let side = side.min(w - sx).min(h - sy);

        let mut out = Vec::with_capacity((side * side * 4) as usize);
        for y in sy..sy + side {
            let row = ((y * w + sx) * 4) as usize;
            out.extend_from_slice(&rgba[row..row + (side * 4) as usize]);
        }
        Some((side, side, out))
    }

    fn encode_png(w: u32, h: u32, rgba: &[u8]) -> Option<Vec<u8>> {
        let mut out = Vec::new();
        {
            let mut enc = png::Encoder::new(&mut out, w, h);
            enc.set_color(png::ColorType::Rgba);
            enc.set_depth(png::BitDepth::Eight);
            enc.set_compression(png::Compression::Fast);
            let mut writer = enc.write_header().ok()?;
            writer.write_image_data(rgba).ok()?;
        }
        Some(out)
    }
}
