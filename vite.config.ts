import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri, sabit port ve HMR host'u bekler.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "0.0.0.0",
    hmr: { protocol: "ws", host: "localhost", port: 1421 },
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    // Iki pencere = iki HTML girisi (Tauri cok pencereli standart yapisi).
    rollupOptions: { input: { main: "index.html", settings: "settings.html" } },
    target: "chrome110",       // WebView2 (Evergreen) — polyfill yükü yok
    minify: "esbuild",
    sourcemap: false,
    cssCodeSplit: false,
    reportCompressedSize: false,
  },
  esbuild: { legalComments: "none" },
});
