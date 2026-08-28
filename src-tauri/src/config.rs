use crate::trace::trace;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};

fn kind_app() -> String {
    "app".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockItem {
    pub id: String,
    pub label: String,
    /// .exe, .lnk, .url, klasor veya bir URI (https://, ms-settings: ...)
    pub path: String,
    /// `path` bir .lnk ise isaret ettigi GERCEK dosya; oge eklenirken bir kez
    /// cozulur. Masaustundeki kisayol sonradan silinince dock yalniz olu bir
    /// yol tutuyordu: ikon cikmiyor (harf fallback'i) ve "masaustune geri koy"
    /// calismiyordu. Ikisi de artik bu alana dusuyor. Bos = cozulemedi/gereksiz.
    #[serde(default)]
    pub target: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// Kullanicinin elle sectigi ikon. Bos ise Windows'tan cikarilan ikon kullanilir.
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    /// "app" (varsayilan) | "group" | "separator"
    #[serde(default = "kind_app")]
    pub kind: String,
    /// Grubun icindeki ogeler; yalniz kind == "group" icin doludur.
    #[serde(default)]
    pub children: Vec<DockItem>,
}

fn t() -> bool { true }
fn hide_delay() -> u32 { 550 }
fn reveal_zone() -> u32 { 4 }
fn radius() -> u32 { 18 }
fn opacity() -> f64 { 0.62 }
fn anchor() -> String { "edge".into() }
fn align() -> String { "center".into() }
fn auto_hide_mode() -> String { "delay".into() }
fn bg_color() -> String { "#161a22".into() }
fn accent() -> String { "#4fa3ff".into() }
fn theme() -> String { "custom".into() }
fn layer() -> String { "desktop".into() }
fn language() -> String { "tr".into() }
fn click_anim() -> String { "bounce".into() }
fn reveal_anim() -> String { "slide".into() }
fn hide_anim() -> String { "auto".into() }
fn icon_gap() -> u32 { 10 }
fn sound_volume() -> f64 { 0.5 }
fn sound_scheme() -> String { "soft".into() }
fn hover_anim() -> String { "lift".into() }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockConfig {
    pub items: Vec<DockItem>,

    // --- yerlesim ---
    /// "bottom" | "top" | "left" | "right" — yon, buyume ekseni ve gizlenme yonu
    pub edge: String,
    /// "edge" = kenara ortali, "free" = kullanicinin surukledigi serbest konum
    #[serde(default = "anchor")]
    pub anchor: String,
    /// Serbest moddaki fiziksel ekran koordinatlari
    #[serde(default)]
    pub free_x: i32,
    #[serde(default)]
    pub free_y: i32,
    /// Kenar boyunca hizalama: "start" | "center" | "end"
    #[serde(default = "align")]
    pub align: String,
    /// Ekran kenarina mesafe (logical px) — yalniz anchor = "edge" icin
    pub margin: i32,
    /// Monitor indeksi (0 = birincil)
    pub monitor: usize,

    // --- olculer ---
    /// Dinlenme halindeki ikon kenari (logical px)
    pub icon_size: u32,
    /// Hover'da maksimum olcek carpani
    pub magnification: f64,
    /// Buyutmenin yayildigi komsu ikon yaricapi
    pub magnify_range: f64,
    #[serde(default = "radius")]
    pub radius: u32,
    #[serde(default = "opacity")]
    pub panel_opacity: f64,

    // --- gorunum / efektler ---
    /// Panel arka plan rengi (#rrggbb) — saydamlikla harmanlanir
    #[serde(default = "bg_color")]
    pub bg_color: String,
    /// Vurgu rengi: hover halesi, odak halkasi
    #[serde(default = "accent")]
    pub accent: String,
    /// Hazir tema kimligi: custom | bigsur-dark | bigsur-light | aqua |
    /// metal | aero | carbon | win11 | neon | nord | sunset | frost |
    /// matrix | retro95 | amethyst. Gorunumu CSS uretir.
    #[serde(default = "theme")]
    pub theme: String,
    /// Hover'da ikon arkasinda vurgu renkli hale
    #[serde(default = "t")]
    pub glow: bool,
    /// Ikonlarin panel zemininde yansimasi (yalniz yatay kenarlar)
    #[serde(default)]
    pub reflection: bool,
    /// Tiklama animasyonu: none | bounce | shake | pulse | spin | jelly
    /// | pop | wobble | flip | tada | swing | dive
    #[serde(default = "click_anim")]
    pub click_anim: String,
    /// Gizlenme/acilma animasyonu: slide | fade | scale | slide-fade | bounce | unfold
    #[serde(default = "reveal_anim")]
    pub reveal_anim: String,
    /// Yalniz gizlenirken oynayan efekt:
    /// auto (acilmanin tersi) | fade | scale | blur | genie | flip | drop
    /// | curl | swirl | dissolve | squeeze
    #[serde(default = "hide_anim")]
    pub hide_anim: String,
    /// Hover ek hareketi: none | lift | tilt | pop | swing | float | throb
    /// | jump | wiggle | spin | ring | sink
    #[serde(default = "hover_anim")]
    pub hover_anim: String,
    /// Ikon altinda dusen golge
    #[serde(default = "t")]
    pub icon_shadow: bool,
    /// Windows 11 akrilik bulaniklik (pencere efekti)
    #[serde(default)]
    pub acrylic: bool,
    /// Gorev cubugu gibi ekran alani rezerve et (AppBar)
    #[serde(default = "t")]
    pub reserve_space: bool,
    /// Z-duzeyi: "desktop" = yalniz masaustunde gorunur (tum pencerelerin altinda),
    /// "normal" = siradan pencere, "top" = her zaman ustte
    #[serde(default = "layer")]
    pub layer: String,
    /// Arayuz dili: "tr" | "en"
    #[serde(default = "language")]
    pub language: String,

    // --- davranis ---
    pub auto_hide: bool,
    /// Otomatik gizleme bicimi: "delay" (sureli) | "dodge" (pencere kacinma)
    #[serde(default = "auto_hide_mode")]
    pub auto_hide_mode: String,
    /// Fare ayrildiktan sonra gizlenmeye kadar beklenen sure (ms)
    #[serde(default = "hide_delay")]
    pub hide_delay: u32,
    /// Gizliyken fareyi algilayan seridin kalinligi (fiziksel px)
    #[serde(default = "reveal_zone")]
    pub reveal_zone: u32,
    #[serde(default = "t")]
    pub show_labels: bool,
    /// Panelin arkasindaki dis golge
    #[serde(default)]
    pub shadow: bool,
    /// Uygulama baslatilinca dock gizlensin mi (Nexus: "hide after launching")
    #[serde(default)]
    pub hide_after_launch: bool,
    /// Acilista gizli baslasin mi
    #[serde(default)]
    pub start_hidden: bool,

    // --- gorunum ayrintilari ---
    /// Ikonlar arasi bosluk (logical px)
    #[serde(default = "icon_gap")]
    pub icon_gap: u32,
    /// Ogeler suruklenerek tasinamasin
    #[serde(default)]
    pub lock_items: bool,
    /// Calisan uygulamalarin altinda nokta goster
    #[serde(default = "t")]
    pub running_indicator: bool,
    /// Ikonlar gri dursun, yalniz imlecin altindaki renklensin
    #[serde(default)]
    pub icon_grayscale: bool,

    // --- ses ---
    /// Ses efektleri acik mi
    #[serde(default)]
    pub sounds: bool,
    /// 0..1
    #[serde(default = "sound_volume")]
    pub sound_volume: f64,
    /// soft | click | retro
    #[serde(default = "sound_scheme")]
    pub sound_scheme: String,
}

impl Default for DockConfig {
    fn default() -> Self {
        let mk = |id: &str, label: &str, path: &str, color: &str| DockItem {
            id: id.into(),
            label: label.into(),
            path: path.into(),
            target: String::new(),
            args: vec![],
            icon: None,
            color: Some(color.into()),
            kind: kind_app(),
            children: vec![],
        };

        Self {
            items: vec![
                mk("explorer", "Dosya Gezgini", "explorer.exe", "#f5c542"),
                mk("terminal", "Terminal", "wt.exe", "#2f6fd0"),
                mk("notepad", "Not Defteri", "notepad.exe", "#4fa3ff"),
                mk("calc", "Hesap Makinesi", "calc.exe", "#7d8a99"),
                mk("settings", "Ayarlar", "ms-settings:", "#59c17a"),
            ],
            edge: "top".into(),
            anchor: anchor(),
            align: align(),
            free_x: 0,
            free_y: 0,
            margin: 8,
            monitor: 0,
            icon_size: 52,
            magnification: 1.9,
            magnify_range: 2.2,
            radius: radius(),
            panel_opacity: opacity(),
            bg_color: bg_color(),
            accent: accent(),
            theme: theme(),
            glow: true,
            reflection: false,
            click_anim: click_anim(),
            reveal_anim: reveal_anim(),
            hide_anim: hide_anim(),
            hover_anim: hover_anim(),
            icon_shadow: true,
            acrylic: false,
            reserve_space: true,
            layer: layer(),
            language: language(),
            auto_hide: false,
            auto_hide_mode: auto_hide_mode(),
            hide_delay: hide_delay(),
            reveal_zone: reveal_zone(),
            show_labels: true,
            shadow: false,
            hide_after_launch: false,
            start_hidden: false,
            icon_gap: icon_gap(),
            lock_items: false,
            running_indicator: true,
            icon_grayscale: false,
            sounds: false,
            sound_volume: sound_volume(),
            sound_scheme: sound_scheme(),
        }
    }
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("config dizini alinamadi: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("config dizini olusturulamadi: {e}"))?;
    Ok(dir.join("dock.json"))
}

/// Setup asamasinda hata yutarak okuma (pencere konumlandirma icin).
pub fn load_or_default(app: &AppHandle) -> DockConfig {
    load_config(app.clone()).unwrap_or_default()
}

#[tauri::command]
pub fn load_config(app: AppHandle) -> Result<DockConfig, String> {
    let path = config_path(&app)?;
    if !path.exists() {
        let cfg = DockConfig::default();
        let _ = write(&path, &cfg);
        return Ok(cfg);
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("config okunamadi: {e}"))?;
    // Not Defteri gibi editorler UTF-8 BOM yaziyor; serde_json BOM'da patlar.
    let raw = raw.trim_start_matches('\u{feff}');

    match serde_json::from_str(raw) {
        Ok(cfg) => Ok(cfg),
        Err(e) => {
            // Bozuk dosya uygulamayi kilitlemesin — ama sessizce UZERINE DE YAZMA:
            // eskiden varsayilanlara donuluyor ve ilk kayitta kullanicinin tum
            // kisayollari siliniyordu. Once bir kenara koyuyoruz.
            let bak = path.with_extension("json.bozuk");
            let _ = fs::copy(&path, &bak);
            trace(&format!(
                "config cozulemedi ({e}); yedegi: {} - varsayilanlara donuluyor",
                bak.display()
            ));
            Ok(DockConfig::default())
        }
    }
}

#[tauri::command]
pub fn save_config(app: AppHandle, config: DockConfig) -> Result<(), String> {
    let path = config_path(&app)?;
    write(&path, &config)?;
    // Ayarlar penceresindeki degisiklik dock'a aninda yansisin.
    let _ = app.emit("config-changed", &config);
    Ok(())
}

fn write(path: &PathBuf, cfg: &DockConfig) -> Result<(), String> {
    let json = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| format!("config yazilamadi: {e}"))
}
