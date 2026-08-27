import type { DockConfig, DockEdge, DockItem } from "./ipc";

export const GAP = 10;
export const PANEL_PAD = 10;
/** Panelin bas tarafindaki tutamac (surukleyerek tasima) genisligi */
export const GRIP = 14;
export const LABEL_ROOM = 26;

/**
 * Yuva turu. Ayraclar ikonlardan dar oldugu icin yuva uzunlugu artik sabit
 * degil; her yuvanin baslangici ve uzunlugu ayri tutuluyor.
 */
export type SlotKind = "icon" | "sep";

export const kindOf = (item: DockItem): SlotKind =>
  item.kind === "separator" ? "sep" : "icon";

export interface Geometry {
  axis: "x" | "y";
  /** Ikon yuvasinin uzunlugu (ikon + bosluk) — buyutme yaricapi bunun katidir */
  slot: number;
  /** Ilk yuvanin panel basina uzakligi (tutamac + dolgu + yayilma payi) */
  lead: number;
  /** Buyume sirasinda komsulari itmek icin ayrilan pay */
  spreadPad: number;
  /** Yansima seridinin kalinligi (logical px, 0 = kapali) */
  reflect: number;
  /** Panelin sabit olculeri (logical px) */
  panelW: number;
  panelH: number;
  /** Pencerenin olculeri: panel + buyume tasmasi + gizlenme payi */
  winW: number;
  winH: number;
  count: number;
  /** Her yuvanin panel basina uzakligi (lead dahil) */
  starts: number[];
  /** Her yuvanin uzunlugu */
  sizes: number[];
}

const isHorizontal = (edge: DockEdge) => edge === "bottom" || edge === "top";

export function computeGeometry(cfg: DockConfig, kinds: SlotKind[]): Geometry {
  const size = cfg.iconSize;
  const gap = cfg.iconGap ?? GAP;
  const slot = size + gap;
  const sepSize = Math.max(10, Math.round(size * 0.34));
  const horizontal = isHorizontal(cfg.edge);

  const spreadPad = Math.ceil((cfg.magnification - 1) * size * 0.75);
  const lead = PANEL_PAD + GRIP + spreadPad;

  // Yansima yalniz yatay kenarlarda anlamli; panele ek zemin serit acar.
  const reflect = cfg.reflection && horizontal ? Math.round(size * 0.38) : 0;

  const starts: number[] = [];
  const sizes: number[] = [];
  let cursor = lead;
  for (const k of kinds) {
    const w = k === "sep" ? sepSize : slot;
    starts.push(cursor);
    sizes.push(w);
    cursor += w;
  }

  const main = cursor + PANEL_PAD + spreadPad;
  const cross = size + 2 * PANEL_PAD + reflect;

  const panelW = horizontal ? main : cross;
  const panelH = horizontal ? cross : main;

  // Ikon buyudugunde panel disina tasar; ayrica gizlenme animasyonu icin pay.
  const grow = Math.ceil((cfg.magnification - 1) * size) + (cfg.showLabels ? LABEL_ROOM : 6);

  return {
    axis: horizontal ? "x" : "y",
    slot,
    lead,
    spreadPad,
    reflect,
    panelW,
    panelH,
    winW: horizontal ? panelW + 8 : panelW + grow,
    winH: horizontal ? panelH + grow : panelH + 8,
    count: kinds.length,
    starts,
    sizes,
  };
}

/** Verilen konumdaki yuvanin indeksi (yoksa -1). */
export function slotAt(geo: Geometry, pos: number): number {
  for (let i = 0; i < geo.count; i++) {
    if (pos >= geo.starts[i] && pos < geo.starts[i] + geo.sizes[i]) return i;
  }
  return -1;
}

/**
 * Panelin pencere icindeki yeri (logical px). Pencere panelden buyuktur:
 * buyuyen ikonlar ve etiket icin pay birakilir. Bu pay gorunmezdir, bu yuzden
 * fare testinde panel disi alan "yok" sayilmali.
 */
export function panelRect(geo: Geometry, edge: DockEdge) {
  const { winW, winH, panelW, panelH } = geo;
  const cx = Math.round((winW - panelW) / 2);
  const cy = Math.round((winH - panelH) / 2);
  switch (edge) {
    case "top":
      return { x: cx, y: 0, w: panelW, h: panelH };
    case "left":
      return { x: 0, y: cy, w: panelW, h: panelH };
    case "right":
      return { x: winW - panelW, y: cy, w: panelW, h: panelH };
    default:
      return { x: cx, y: winH - panelH, w: panelW, h: panelH };
  }
}

/**
 * Tek gecislik cozum: olcek + kaydirma degerlerini onceden ayrilmis
 * dizilere yazar. Allocation yok, DOM okuma yok -> layout thrash yok.
 */
export function solve(
  pointer: number | null,
  geo: Geometry,
  cfg: DockConfig,
  scales: Float32Array,
  offsets: Float32Array
): void {
  const { count, slot, spreadPad, starts, sizes } = geo;

  if (pointer === null) {
    scales.fill(1);
    offsets.fill(0);
    return;
  }

  const reach = Math.max(1, cfg.magnifyRange * slot);
  const amp = cfg.magnification - 1;

  let running = 0;
  for (let i = 0; i < count; i++) {
    const center = starts[i] + sizes[i] * 0.5;
    const t = Math.min(1, Math.abs(pointer - center) / reach);
    // Kosinus falloff: C1 surekli -> gorsel olarak sicramasiz.
    const f = 0.5 * (1 + Math.cos(Math.PI * t));
    const s = 1 + amp * f;
    scales[i] = s;

    const extra = (s - 1) * sizes[i];
    offsets[i] = running + extra * 0.5;
    running += extra;
  }

  // Yayilmayi merkeze gore dengele.
  const half = running * 0.5;
  let maxAbs = 0;
  for (let i = 0; i < count; i++) {
    offsets[i] -= half;
    const a = Math.abs(offsets[i]);
    if (a > maxAbs) maxAbs = a;
  }

  // Panel disina tasmayi engelle.
  if (maxAbs > spreadPad && maxAbs > 0) {
    const k = spreadPad / maxAbs;
    for (let i = 0; i < count; i++) offsets[i] *= k;
  }
}
