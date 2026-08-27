import type { DockConfig } from "./ipc";
import type { Key } from "./i18n";

/**
 * Hazir temalar.
 *
 * Nexus/ObjectDock skinleri 9-dilim PNG arka planlar kullanir; burada ayni
 * gorunumler CSS katmanlariyla uretiliyor (dosya yok, olcekleme sorunu yok).
 * Tema yalniz `theme` alanini degil, kendine yakisan olculeri/renkleri de
 * yaziyor — kullanici sonra hepsini tek tek degistirebilir.
 *
 * `reflection` ve `shadow` bilerek DISARIDA: ikisi de panelin gorunumunu degil
 * kapladigi ALANI degistiriyor (yansima seridi ikonlarin altina bos bir kusak
 * aciyor, golge panelin disina tasiyor). Tema secmek bunlari kendiliginden
 * acinca kullanici "neden ikonlarin altinda bosluk var, neden golge geldi"
 * diye ayarlari tek tek geri almak zorunda kaliyordu; artik ikisi de yalniz
 * kullanicinin kendi anahtari.
 */
export type ThemeId =
  | "custom"
  | "bigsur-dark"
  | "bigsur-light"
  | "aqua"
  | "metal"
  | "aero"
  | "carbon"
  | "win11"
  | "neon"
  | "nord"
  | "sunset"
  | "frost"
  | "matrix"
  | "retro95"
  | "amethyst";

export interface ThemeDef {
  id: ThemeId;
  labelKey: Key;
  /** Tema secildiginde yazilan alanlar (theme haric) */
  apply: Partial<DockConfig>;
}

export const THEMES: ThemeDef[] = [
  {
    id: "custom",
    labelKey: "thCustom",
    apply: {},
  },
  {
    id: "bigsur-dark",
    labelKey: "thBigSurDark",
    apply: {
      bgColor: "#1c1f24",
      accent: "#4fa3ff",
      radius: 28,
      panelOpacity: 0.55,
      glow: true,
      iconShadow: true,
    },
  },
  {
    id: "bigsur-light",
    labelKey: "thBigSurLight",
    apply: {
      bgColor: "#e9ebf0",
      accent: "#2a6ec4",
      radius: 28,
      panelOpacity: 0.62,
      glow: true,
      iconShadow: true,
    },
  },
  {
    id: "aqua",
    labelKey: "thAqua",
    apply: {
      bgColor: "#0e1319",
      accent: "#57b6ff",
      radius: 20,
      panelOpacity: 0.42,
      glow: true,
      iconShadow: true,
    },
  },
  {
    id: "metal",
    labelKey: "thMetal",
    apply: {
      bgColor: "#6d747b",
      accent: "#d6dde4",
      radius: 12,
      panelOpacity: 0.92,
      glow: false,
      iconShadow: true,
    },
  },
  {
    id: "aero",
    labelKey: "thAero",
    apply: {
      bgColor: "#2b4f78",
      accent: "#9bd6ff",
      radius: 16,
      panelOpacity: 0.44,
      glow: true,
      iconShadow: true,
    },
  },
  {
    id: "carbon",
    labelKey: "thCarbon",
    apply: {
      bgColor: "#101216",
      accent: "#35e0c8",
      radius: 14,
      panelOpacity: 0.88,
      glow: true,
      iconShadow: true,
    },
  },
  {
    id: "win11",
    labelKey: "thWin11",
    apply: {
      bgColor: "#202225",
      accent: "#4cc2ff",
      radius: 8,
      panelOpacity: 0.72,
      glow: true,
      iconShadow: false,
    },
  },
  {
    id: "neon",
    labelKey: "thNeon",
    apply: {
      bgColor: "#0a0f1e",
      accent: "#7cf3ff",
      radius: 18,
      panelOpacity: 0.5,
      glow: true,
      iconShadow: true,
    },
  },
  {
    id: "nord",
    labelKey: "thNord",
    apply: {
      bgColor: "#2e3440",
      accent: "#88c0d0",
      radius: 14,
      panelOpacity: 0.82,
      glow: true,
      iconShadow: true,
    },
  },
  {
    id: "sunset",
    labelKey: "thSunset",
    apply: {
      bgColor: "#26162c",
      accent: "#ff9a6c",
      radius: 22,
      panelOpacity: 0.62,
      glow: true,
      iconShadow: true,
    },
  },
  {
    id: "frost",
    labelKey: "thFrost",
    apply: {
      bgColor: "#f0f8ff",
      accent: "#3b8fd0",
      radius: 24,
      panelOpacity: 0.52,
      glow: true,
      iconShadow: true,
    },
  },
  {
    id: "matrix",
    labelKey: "thMatrix",
    apply: {
      bgColor: "#020a06",
      accent: "#40ff96",
      radius: 6,
      panelOpacity: 0.9,
      glow: true,
      iconShadow: false,
    },
  },
  {
    id: "retro95",
    labelKey: "thRetro95",
    apply: {
      bgColor: "#d4d0c8",
      accent: "#000080",
      radius: 0,
      panelOpacity: 1,
      glow: false,
      iconShadow: false,
    },
  },
  {
    id: "amethyst",
    labelKey: "thAmethyst",
    apply: {
      bgColor: "#22123a",
      accent: "#c6a0ff",
      radius: 20,
      panelOpacity: 0.66,
      glow: true,
      iconShadow: true,
    },
  },
];
