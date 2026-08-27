import React from "react";
import { createRoot } from "react-dom/client";
import DockView from "./views/DockView";
import "./styles.css";
import { traceJs } from "./lib/ipc";

document.documentElement.dataset.view = "dock";

// Dock bir "chrome" katmani: tarayici jestleri kapali.
document.addEventListener("contextmenu", (e) => e.preventDefault());
document.addEventListener("dragstart", (e) => e.preventDefault());
document.addEventListener("selectstart", (e) => e.preventDefault());

traceJs(`boot view=dock url=${location.href}`);
window.addEventListener("error", (e) =>
  traceJs(`JS HATA: ${e.message} @ ${e.filename}:${e.lineno}`)
);
window.addEventListener("unhandledrejection", (e) => traceJs(`REJECT: ${String(e.reason)}`));

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <DockView />
  </React.StrictMode>
);
