import type { DockConfig } from "./ipc";
import type { Key } from "./i18n";

/**
 * Hazir temalar.
 *
 * Nexus/ObjectDock skinleri 9-dilim PNG arka planlar kullanir; burada ayni
 * gorunumler CSS katmanlariyla uretiliyor (dosya yok, olcekleme sorunu yok).
 * Tema yalniz `theme` alanini degil, kendine yakisan olculeri/efektleri de
 * yaziyor — kullanici sonra hepsini tek tek degistirebilir.
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
  | "neon";

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
      reflection: false,
      glow: true,
      iconShadow: true,
      shadow: false,
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
      reflection: false,
      glow: true,
      iconShadow: true,
      shadow: false,
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
      reflection: true,
      glow: true,
      iconShadow: true,
      shadow: false,
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
      reflection: false,
      glow: false,
      iconShadow: true,
      shadow: false,
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
      reflection: true,
      glow: true,
      iconShadow: true,
      shadow: false,
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
      reflection: false,
      glow: true,
      iconShadow: true,
      shadow: false,
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
      reflection: false,
      glow: true,
      iconShadow: false,
      shadow: false,
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
      reflection: true,
      glow: true,
      iconShadow: true,
      shadow: false,
    },
  },
];
