//! Sistem tepsisi menusu.
//!
//! Etiketler frontend'den geliyor (i18n.ts): ceviriler tek yerde tutuluyor,
//! dil degistiginde menu yeniden kuruluyor.

use serde::Deserialize;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager,
};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayLabels {
    pub settings: String,
    pub toggle: String,
    pub quit: String,
}

impl Default for TrayLabels {
    fn default() -> Self {
        Self {
            settings: "Ayarlar…".into(),
            toggle: "Dock'u Göster/Gizle".into(),
            quit: "Çıkış".into(),
        }
    }
}

fn build_menu(app: &AppHandle, l: &TrayLabels) -> tauri::Result<Menu<tauri::Wry>> {
    let settings = MenuItem::with_id(app, "settings", &l.settings, true, None::<&str>)?;
    let toggle = MenuItem::with_id(app, "toggle", &l.toggle, true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", &l.quit, true, None::<&str>)?;
    Menu::with_items(app, &[&settings, &toggle, &sep, &quit])
}

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_menu(app, &TrayLabels::default())?;

    TrayIconBuilder::with_id("dock-tray")
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("WindowsDock")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "settings" => crate::window::open_settings_async(app.clone()),
            "toggle" => {
                if let Some(w) = app.get_webview_window("dock") {
                    let visible = w.is_visible().unwrap_or(false);
                    let _ = if visible { w.hide() } else { w.show() };
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;

    Ok(())
}

/// Dil degisince frontend cagirir.
#[tauri::command]
pub fn update_tray(app: AppHandle, labels: TrayLabels) -> Result<(), String> {
    let menu = build_menu(&app, &labels).map_err(|e| e.to_string())?;
    let tray = app.tray_by_id("dock-tray").ok_or("tepsi simgesi yok")?;
    tray.set_menu(Some(menu)).map_err(|e| e.to_string())
}
