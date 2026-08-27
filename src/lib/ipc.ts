import { invoke } from "@tauri-apps/api/core";

export type DockEdge = "bottom" | "top" | "left" | "right";
export type DockAnchor = "edge" | "free";
export type DockAlign = "start" | "center" | "end";
/** "delay" = sureli gizleme, "dodge" = pencere kacinma */
export type AutoHideMode = "delay" | "dodge";
export type DockLayer = "desktop" | "normal" | "top";
export type ClickAnim =
  | "none" | "bounce" | "shake" | "pulse" | "spin" | "jelly"
  | "pop" | "wobble" | "flip" | "tada" | "swing" | "dive";
export type RevealAnim = "slide" | "fade" | "scale" | "slide-fade" | "bounce" | "unfold";
/** Gizlenirken oynayan efekt; "auto" = acilma animasyonunun tersi */
export type HideAnim =
  | "auto" | "fade" | "scale" | "blur" | "genie" | "flip" | "drop"
  | "curl" | "swirl" | "dissolve" | "squeeze";
export type HoverAnim =
  | "none" | "lift" | "tilt" | "pop" | "swing" | "float" | "throb"
  | "jump" | "wiggle" | "spin" | "ring" | "sink";
/** Rust tarafi settings/hide/quit secimlerini kendisi isler; buraya "" doner. */
export type SoundScheme = "soft" | "click" | "retro";

export type MenuAction = "" | "remove" | "add";

/**
 * "app" = kisayol, "group" = ic ice ogeler, "separator" = ince ayrac,
 * "recycler" = geri donusum kutusu (Nexus: Recycler modulu)
 */
export type ItemKind = "app" | "group" | "separator" | "recycler";

export interface DockItem {
  id: string;
  label: string;
  path: string;
  args: string[];
  icon: string | null;
  color: string | null;
  kind: ItemKind;
  /** Yalniz kind === "group" icin dolu */
  children: DockItem[];
}

export interface DockConfig {
  items: DockItem[];

  edge: DockEdge;
  anchor: DockAnchor;
  /** Kenar boyunca hizalama */
  align: DockAlign;
  freeX: number;
  freeY: number;
  margin: number;
  monitor: number;

  iconSize: number;
  magnification: number;
  magnifyRange: number;
  radius: number;
  panelOpacity: number;

  bgColor: string;
  accent: string;
  /** Hazir tema kimligi (bkz. lib/themes.ts) — panel gorunumunu CSS belirler */
  theme: string;
  glow: boolean;
  reflection: boolean;
  clickAnim: ClickAnim;
  revealAnim: RevealAnim;
  hideAnim: HideAnim;
  hoverAnim: HoverAnim;
  iconShadow: boolean;
  acrylic: boolean;
  reserveSpace: boolean;
  layer: DockLayer;
  language: "tr" | "en";

  autoHide: boolean;
  autoHideMode: AutoHideMode;
  hideDelay: number;
  /** Uygulama baslatildiktan sonra dock gizlensin mi */
  hideAfterLaunch: boolean;
  /** Acilista dock gizli baslasin mi */
  startHidden: boolean;
  revealZone: number;
  showLabels: boolean;
  shadow: boolean;

  /** Ikonlar arasi bosluk (logical px) */
  iconGap: number;
  /** Ogeler suruklenerek tasinamasin */
  lockItems: boolean;
  /** Calisan uygulamalarin altinda nokta */
  runningIndicator: boolean;
  /** Ikonlar gri, yalniz imlecin altindaki renkli */
  iconGrayscale: boolean;

  /** Ses efektleri */
  sounds: boolean;
  soundVolume: number;
  soundScheme: SoundScheme;
}

export interface MonitorInfo {
  index: number;
  name: string;
  width: number;
  height: number;
  scaleFactor: number;
  primary: boolean;
}

export interface LayoutReq {
  /** Pencere olculeri (panel + buyume/etiket payi) */
  width: number;
  height: number;
  /** Yalniz gorunur panelin olculeri — ekran alani rezervasyonu buna gore */
  panelW: number;
  panelH: number;
  edge: DockEdge;
  anchor: DockAnchor;
  align: DockAlign;
  margin: number;
  monitor: number;
  freeX: number;
  freeY: number;
  reserve: boolean;
}

export const loadConfig = () => invoke<DockConfig>("load_config");
export const saveConfig = (config: DockConfig) => invoke<void>("save_config", { config });

export const launchItem = (path: string, args: string[] = []) =>
  invoke<void>("launch_item", { path, args });
export const ejectToDesktop = (path: string, label: string) =>
  invoke<string>("eject_to_desktop", { path, label });

export const resolveIcon = (path: string) => invoke<string | null>("resolve_icon", { path });

export const applyLayout = (req: LayoutReq) =>
  invoke<{ x: number; y: number }>("apply_layout", { req });

export const monitorInfo = () => invoke<MonitorInfo[]>("monitor_info");
export const setPointerOver = (over: boolean) => invoke<void>("set_pointer_over", { over }).catch(() => {});

/** Panelin pencere icindeki gorunur alani (fiziksel px) — disi tiklama gecirir. */
export const setHitRect = (r: { x: number; y: number; w: number; h: number }) =>
  invoke<void>("set_hit_rect", r).catch(() => {});

/** Verilen yollarin calisip calismadigi (Nexus: Running Indicator) */
export const runningFlags = (paths: string[]) =>
  invoke<boolean[]>("running_flags", { paths }).catch(() => paths.map(() => false));

/** Geri donusum kutusu bos mu? */
export const recyclerEmpty = () => invoke<boolean>("recycler_empty").catch(() => true);

/** Pencere kacinma modu (Nexus: Dodge Windows) */
export const setDodge = (enabled: boolean) =>
  invoke<void>("set_dodge", { enabled }).catch(() => {});

/** Ikon suruklenirken fare testi dondurulur; surukleme yarida kalmasin. */
export const setInputLock = (locked: boolean) =>
  invoke<void>("set_input_lock", { locked }).catch(() => {});
export const showDock = () => invoke<void>("show_dock");

export const showItemMenu = (p: {
  path: string | null;
  removable: boolean;
  labels: { remove: string; add: string; settings: string; hide: string; quit: string };
}) => invoke<MenuAction>("show_item_menu", p);

export const updateTray = (labels: { settings: string; toggle: string; quit: string }) =>
  invoke<void>("update_tray", { labels });
export const traceJs = (msg: string) => invoke<void>("trace_js", { msg }).catch(() => {});
export const setLayer = (layer: DockLayer) => invoke<void>("set_layer", { layer });
export const setAcrylic = (enabled: boolean, tint: number[] | null) =>
  invoke<void>("set_acrylic", { enabled, tint });

export const setHidden = (p: {
  hidden: boolean;
  edge: DockEdge;
  zone: number;
  monitor: number;
  /** "Yalniz masaustu" duzeyi: dock ancak masaustu ondeyken acilsin */
  desktopOnly: boolean;
}) => invoke<void>("set_hidden", p);

/** Masaustu duzeyinde acilirken: one al ama "her zaman ustte" yapma. */
export const raiseAboveDesktop = () => invoke<void>("raise_above_desktop");
