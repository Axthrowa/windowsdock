// Konsol penceresini release modunda gizler.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    windowsdock_lib::run()
}
