import React from "react";
import { createRoot } from "react-dom/client";
import SettingsView from "./views/SettingsView";
import "./styles.css";
import { traceJs } from "./lib/ipc";

// Ayarlar kendi HTML girisinden acilir. Tek index.html'i iki pencereye
// yonlendirmek (sorgu/hash/etiket) gomulu varlik protokolunde bos sayfa
// uretiyordu; ayri giris Tauri'nin standart cok pencereli yapisi.
document.documentElement.dataset.view = "settings";
traceJs(`boot view=settings url=${location.href}`);
window.addEventListener("error", (e) => traceJs(`AYARLAR HATA: ${e.message}`));

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SettingsView />
  </React.StrictMode>
);
