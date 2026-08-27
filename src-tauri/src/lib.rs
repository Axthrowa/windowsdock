mod appbar;
mod autohide;
mod config;
mod dragwatch;
mod dropzone;
mod icons;
mod launcher;
mod memtrim;
mod running;
mod shellmenu;
mod trace;
mod tray;
mod window;

use appbar::AppBar;
use autohide::Watcher;
use tauri::Manager;
use tauri_plugin_autostart::MacosLauncher;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![
            config::load_config,
            config::save_config,
            icons::resolve_icon,
            trace::trace_js,
            shellmenu::show_item_menu,
            dropzone::set_pointer_over,
            dropzone::set_hit_rect,
            dropzone::set_input_lock,
            dropzone::set_dodge,
            running::running_flags,
            running::recycler_empty,
            tray::update_tray,
            launcher::launch_item,
            launcher::eject_to_desktop,
            window::apply_layout,
            window::monitor_info,
            window::set_acrylic,
            window::set_layer,
            window::set_hidden,
            window::raise_above_desktop,
            window::show_dock,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(Watcher::spawn(handle));
            app.manage(AppBar::default());

            let win = app
                .get_webview_window("dock")
                .expect("dock penceresi bulunamadi");

            // Surukleme katmani dock'un konumunu bilmeli.
            // hwnd() burada Err donuyorsa webview kurulumu sessizce basarisiz
            // olmustur (bkz. tauri.conf.json: iki pencerenin additionalBrowserArgs
            // degeri AYNI olmak zorunda) — teshis edilebilir olsun diye kaydediyoruz.
            #[cfg(windows)]
            match win.hwnd() {
                Ok(h) => dropzone::set_dock_hwnd(h.0 as isize),
                Err(e) => trace::trace(&format!("KRITIK: dock penceresinin hwnd'si yok: {e}")),
            }
            dragwatch::spawn(app.handle().clone());

            let cfg = config::load_or_default(app.handle());
            // Pencere olusturuldugu anda tek seferlik konumlandirma.
            // Gorunurluk, frontend olcum yaptiktan sonra show_dock() ile aciliyor.
            window::place_on_edge(&win, &cfg, &app.state::<AppBar>())?;

            tray::build(app.handle())?;

            // Emniyet agi: frontend cokerse show_dock() hic cagrilmaz ve dock
            // sonsuza dek gizli kalirdi (kullaniciya "acilmiyor" gibi gorunur).
            window::spawn_show_guard(app.handle().clone());

            // Teshis kapisi: WINDOWSDOCK_OPEN_SETTINGS=1 ile ayarlar penceresi
            // acilista dogrudan acilir (menu/tepsi yolundan bagimsiz test icin).
            if std::env::var_os("WINDOWSDOCK_OPEN_SETTINGS").is_some() {
                // NOT: pencere kurulumu ana is parcaciginin olay dongusu ICINDEN
                // yapilamaz (runtime mesaji islenemez, FailedToReceiveMessage).
                // Komut cagrilari zaten calisan is parcacigindan gelir.
                let h = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(1500));
                    if let Err(e) = window::open_settings(h) {
                        trace::trace(&format!("acilis ayarlar hata: {e}"));
                    }
                });
            }
            Ok(())
        })
        .on_window_event(|win, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Iki pencere de yok edilmez, gizlenir: ayarlar yeniden acilabilsin.
                api.prevent_close();
                let _ = win.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("Tauri uygulamasi baslatilamadi")
        .run(|app, event| {
            // AppBar rezervasyonu birakilmazsa calisma alani kalici olarak daralir.
            if matches!(event, tauri::RunEvent::Exit) {
                app.state::<AppBar>().release();
            }
        });
}
