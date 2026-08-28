import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { DockConfig, DockItem } from "../lib/ipc";
import { PANEL_PAD, computeGeometry, slotAt, solve } from "../lib/magnify";
import { rgba } from "../lib/color";
import { makeT } from "../lib/i18n";
import { setInputLock, setPointerOver } from "../lib/ipc";
import { playSound, resumeAudio, type SoundEvent } from "../lib/sound";

/** Dock'ta gorunen bir oge: koktekiler parent = null, grup icindekiler grup id'si */
export interface VisibleEntry {
  item: DockItem;
  parent: string | null;
}

type Slot =
  | { kind: "item" | "group" | "sep"; item: DockItem; parent: string | null }
  | { kind: "add" };

interface Props {
  config: DockConfig;
  /** Gorunen ogeler; acik grubun cocuklari grubun hemen ardina eklenmis olur */
  entries: VisibleEntry[];
  /** Su an yerinde acilmis grubun id'si */
  expandedId: string | null;
  /** id -> uygulama su an calisiyor mu (Nexus: Running Indicator) */
  running: Record<string, boolean>;
  /** Geri donusum kutusu bos mu */
  binEmpty: boolean;
  /** id -> diskteki PNG yolu (Windows'tan cikarilan ikon) */
  icons: Record<string, string | null>;
  hidden: boolean;
  /** Explorer'dan dosya suruklenirken vurgulama */
  dropping: boolean;
  onLaunch: (item: DockItem) => void;
  /** Grubu ac/kapat (hover ya da tiklama) */
  onToggleGroup: (id: string | null) => void;
  /** Ikon bir grubun uzerine birakildi */
  onDropIntoGroup: (item: DockItem, groupId: string) => void;
  /** Ikon baska bir ikonun uzerine birakildi: ikisinden yeni grup kur */
  onGroupWith: (item: DockItem, targetId: string) => void;
  /** Grup icindeki oge disari cikarildi: koke don (index = kok sirasindaki yer) */
  onMoveOut: (item: DockItem, index: number) => void;
  onAdd: () => void;
  /** Dock disina birakildi: masaustune geri kondur ve dock'tan cikar */
  onEject: (item: DockItem) => void;
  /** Siralama; hangi listenin siralandigi parent ile belirtilir */
  onReorder: (parent: string | null, items: DockItem[]) => void;
  onMenu: (item: DockItem | null) => void;
  onGripDown: () => void;
  onResetPosition: () => void;
  onEnter: () => void;
  onLeave: () => void;
}

const ORIGIN: Record<string, string> = {
  bottom: "50% 100%",
  top: "50% 0%",
  left: "0% 50%",
  right: "100% 50%",
};

/** Suruklemenin baslamis sayilmasi icin gereken hareket (px) */
const DRAG_SLOP = 6;
/** Ikonun "yeni grup kur" bolgesi: yuva ortasindan +-bu oran kadari.
    Geri kalani siralama icin; siralama gruplamadan cok daha sik yapiliyor. */
const GROUP_ZONE = 0.22;
/** Panelden bu kadar uzaklasinca "disari at" sayilir (px) */
const EJECT = 34;
/** Grubun uzerinde bu kadar durunca yerinde acilir (ms) */
const HOVER_OPEN = 170;
/** Fare dock'tan ayrilinca acik grup bu sure sonra kapanir (ms) */
const HOVER_CLOSE = 260;
/** Dock icinde baska bir yere gidilince acik grup bu sure sonra kapanir (ms) */
const HOVER_AWAY = 220;
/** Kapandiktan sonra ayni grubun hemen yeniden acilmamasi icin bekleme (ms) */
const REOPEN_COOLDOWN = 450;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

interface DragState {
  /** Suruklenen yuvanin indeksi */
  from: number;
  /** Su anki hedef yuva */
  to: number;
  ox: number;
  oy: number;
  dx: number;
  dy: number;
  moved: boolean;
  out: boolean;
  /** Uzerine birakilacak hedef yuva: grup (icine ekle) ya da ikon (grup kur). -1 = yok */
  onGroup: number;
  rect: DOMRect;
}

/**
 * Surukleme sirasinda DOM sirasi DEGISMEZ. React dizisini yeniden siralamak
 * dugumleri tasir, bu da tarayicinin pointer capture'ini dusurur ve surukleme
 * yarida kalir. Onun yerine komsulari yalnizca transform ile kaydiriyoruz.
 */
/** Yuvanin ait oldugu liste (add yuvasi icin null) */
const rootParentOf = (slot: Slot | undefined) =>
  slot && slot.kind !== "add" ? slot.parent : null;

/**
 * Suruklenen yuva hedefin uzerine birakilabilir mi?
 *
 *  - hedef GRUP -> ogeyi o grubun icine ekle (kokten de, baska gruptan da)
 *  - hedef IKON -> ikisinden yeni grup kur; YALNIZ ikisi de koktekiyse
 *
 * Ikinci kosuldaki "ikisi de kokte" siniri onemli: grup icindeki bir ogeyi
 * kok siradaki bir ikonun uzerine birakmak "gruptan cikar" demektir (asagida
 * endDrag'deki onMoveOut dali). Bunu grup kurma hedefi sayarsak gruptan
 * suruklerek cikarmak imkansiz hale geliyor, cunku her kok ikonu yeni grup
 * kuruyor.
 *
 * Kaynak yalniz kisayol olabilir: grup icine grup konmuyor (tek katman), ayrac
 * ve "+" yuvasi da gruplanmaz. Bu kontrol vurgulamayi da yonetir; aksi halde
 * hedef "birakilabilir" gibi isaretlenip birakinca hicbir sey olmuyordu.
 */
const canDropOn = (src: Slot | undefined, target: Slot | undefined) => {
  if (!src || src.kind !== "item" || !target) return false;
  if (target.kind === "group") return true;
  return target.kind === "item" && src.parent === null && target.parent === null;
};

const displaced = (i: number, from: number, to: number) => {
  if (from < to && i > from && i <= to) return i - 1;
  if (from > to && i >= to && i < from) return i + 1;
  return i;
};

export default function Dock(props: Props) {
  const {
    config,
    entries,
    expandedId,
    running,
    binEmpty,
    icons,
    hidden,
    dropping,
    onLaunch,
    onToggleGroup,
    onDropIntoGroup,
    onGroupWith,
    onMoveOut,
    onAdd,
    onEject,
    onReorder,
    onMenu,
    onGripDown,
    onResetPosition,
    onEnter,
    onLeave,
  } = props;
  const t = useMemo(() => makeT(config.language), [config.language]);

  /** Ses efektleri: ayarlar config'den gelir */
  const snd = useCallback(
    (event: SoundEvent) =>
      playSound(event, {
        enabled: config.sounds,
        volume: config.soundVolume,
        scheme: config.soundScheme,
      }),
    [config.sounds, config.soundVolume, config.soundScheme]
  );

  const slots = useMemo<Slot[]>(() => {
    const out: Slot[] = entries.map(({ item, parent }) => ({
      kind: item.kind === "separator" ? "sep" : item.kind === "group" ? "group" : "item",
      item,
      parent,
    }));
    out.push({ kind: "add" });
    return out;
  }, [entries]);

  const kinds = useMemo(
    () => slots.map((s) => (s.kind === "sep" ? ("sep" as const) : ("icon" as const))),
    [slots]
  );

  const geo = useMemo(() => computeGeometry(config, kinds), [config, kinds]);
  const horizontal = geo.axis === "x";

  /** Acik grubun cocuklarinin kapladigi yuva araligi (arka plaka icin) */
  const span = useMemo(() => {
    if (!expandedId) return null;
    let first = -1;
    let last = -1;
    slots.forEach((s, i) => {
      if (s.kind !== "add" && s.parent === expandedId) {
        if (first < 0) first = i;
        last = i;
      }
    });
    if (first < 0) return null;
    return {
      first,
      start: geo.starts[first] - 5,
      size: geo.starts[last] + geo.sizes[last] - geo.starts[first] + 10,
    };
  }, [expandedId, slots, geo]);

  const panelRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const spanRef = useRef<HTMLDivElement>(null);
  const nodes = useRef<(HTMLElement | null)[]>([]);

  const pointer = useRef<number | null>(null);
  const hovered = useRef(-1);
  const rafId = useRef(0);
  const drag = useRef<DragState | null>(null);
  const suppressClick = useRef(false);
  const openTimer = useRef(0);
  const closeTimer = useRef(0);
  /** Kapandiktan sonra yeniden acilmanin serbest oldugu an (ms) */
  const reopenAt = useRef(0);

  // Sabit tamponlar: frame basina allocation yok.
  const buffers = useMemo(
    () => ({
      scales: new Float32Array(slots.length),
      offsets: new Float32Array(slots.length),
    }),
    [slots.length]
  );

  /** Tek yazma gecisi: DOM okumasi yok -> forced reflow yok. */
  const paint = useCallback(() => {
    rafId.current = 0;
    const { scales, offsets } = buffers;
    const d = drag.current;
    // Surukleme sirasinda buyutme kapali: iki efekt ust uste binmemeli.
    solve(d?.moved ? null : pointer.current, geo, config, scales, offsets);

    const els = nodes.current;
    for (let i = 0; i < geo.count; i++) {
      const el = els[i];
      if (!el) continue;
      if (d?.moved) {
        if (i === d.from) {
          el.style.transform = `translate3d(${d.dx.toFixed(1)}px,${d.dy.toFixed(1)}px,0) scale(1.12)`;
          el.style.opacity = d.out ? "0.35" : "0.85";
          el.style.zIndex = "5";
          continue;
        }
        // Komsular acilan bosluga kayar; "disari at" halinde yerlerinde kalirlar.
        el.classList.toggle("icon--drop", d.onGroup === i);
        const j = d.onGroup >= 0 ? i : displaced(i, d.from, d.to);
        const shift = d.out || d.onGroup >= 0 ? 0 : geo.starts[j] - geo.starts[i];
        el.style.opacity = "";
        el.style.zIndex = "";
        el.style.transform = horizontal
          ? `translate3d(${shift}px,0,0)`
          : `translate3d(0,${shift}px,0)`;
        continue;
      }
      el.style.opacity = "";
      el.style.zIndex = "";
      el.classList.remove("icon--drop");
      // Ayrac ince bir cizgi; olceklenirse hata gibi gorunuyor, yalniz kayar.
      const s = (slots[i].kind === "sep" ? 1 : scales[i]).toFixed(4);
      const o = offsets[i].toFixed(2);
      el.style.transform = horizontal
        ? `translate3d(${o}px,0,0) scale(${s})`
        : `translate3d(0,${o}px,0) scale(${s})`;
    }

    // Acik grubun arka plakasi ikonlarla birlikte kayar.
    const sp = spanRef.current;
    if (sp && span) {
      const shift = offsets[span.first] ?? 0;
      sp.style.transform = horizontal
        ? `translate3d(${shift.toFixed(1)}px,0,0)`
        : `translate3d(0,${shift.toFixed(1)}px,0)`;
    }

    const tip = tipRef.current;
    if (!tip) return;
    const i = hovered.current;
    const slot = i >= 0 ? slots[i] : undefined;

    if (!config.showLabels || !slot || slot.kind === "sep" || pointer.current === null || d?.moved) {
      tip.style.opacity = "0";
      return;
    }
    const label = slot.kind === "add" ? t("addApp") : slot.item.label;
    if (tip.textContent !== label) tip.textContent = label;
    const at = geo.starts[i] + geo.sizes[i] * 0.5 + offsets[i];
    tip.style.opacity = "1";
    tip.style.transform = horizontal
      ? `translate3d(${at.toFixed(1)}px,0,0) translateX(-50%)`
      : `translate3d(0,${at.toFixed(1)}px,0) translateY(-50%)`;
  }, [buffers, config, geo, horizontal, slots, span, t]);

  const schedule = useCallback(() => {
    if (!rafId.current) rafId.current = requestAnimationFrame(paint);
  }, [paint]);

  // Bosta hicbir zamanlayici calismaz; yalnizca pointer olaylari frame uretir.
  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (drag.current) return; // surukleme kendi isleyicisinde
      const rect = e.currentTarget.getBoundingClientRect();
      const p = horizontal ? e.clientX - rect.left : e.clientY - rect.top;
      pointer.current = p;
      const idx = slotAt(geo, p);
      if (idx !== hovered.current && idx >= 0 && slots[idx]?.kind !== "sep") snd("hover");
      hovered.current = idx;

      // Grubun uzerinde kisa bir sure durunca yerinde acilir; dock'ta baska
      // bir yere gidilince acik grup kendiliginden kapanir.
      const slot = idx >= 0 ? slots[idx] : undefined;
      const onOpenGroup =
        !!expandedId &&
        !!slot &&
        slot.kind !== "add" &&
        (slot.parent === expandedId || (slot.kind === "group" && slot.item.id === expandedId));

      clearTimeout(openTimer.current);
      if (slot && slot.kind === "group" && slot.item.id !== expandedId) {
        const id = slot.item.id;
        if (Date.now() >= reopenAt.current) {
          openTimer.current = window.setTimeout(() => onToggleGroup(id), HOVER_OPEN);
        }
      }

      if (onOpenGroup || drag.current) {
        // Grubun kendisi/cocuklari uzerindeyiz ya da surukleme suruyor: acik kalsin.
        clearTimeout(closeTimer.current);
      } else if (expandedId && !(slot?.kind === "group")) {
        // Baska bir ikonun ya da bos alanin uzerindeyiz: kisa sure sonra kapat.
        clearTimeout(closeTimer.current);
        closeTimer.current = window.setTimeout(() => {
          reopenAt.current = Date.now() + REOPEN_COOLDOWN;
          onToggleGroup(null);
        }, HOVER_AWAY);
      }

      panelRef.current?.classList.remove("settling");
      schedule();
    },
    [expandedId, geo, horizontal, onToggleGroup, schedule, slots, snd]
  );

  const onPointerLeave = useCallback(() => {
    // Surukleme sirasinda "fare ayrildi" demeyiz: Rust tarafi pencereyi
    // tiklama-gecirgen yapar ve surukleme yarida kalirdi.
    if (drag.current) return;
    setPointerOver(false);
    pointer.current = null;
    hovered.current = -1;
    clearTimeout(openTimer.current);
    // Dock'tan ayrilinca acik grup kisa bir tolerans sonrasi kapanir.
    if (expandedId) {
      clearTimeout(closeTimer.current);
      closeTimer.current = window.setTimeout(() => onToggleGroup(null), HOVER_CLOSE);
    }
    panelRef.current?.classList.add("settling");
    schedule();
    onLeave();
  }, [expandedId, onLeave, onToggleGroup, schedule]);

  useLayoutEffect(() => {
    nodes.current.length = slots.length;
    paint();
  }, [paint, slots.length]);

  useEffect(
    () => () => {
      cancelAnimationFrame(rafId.current);
      clearTimeout(openTimer.current);
      clearTimeout(closeTimer.current);
    },
    []
  );

  // ---------------------------------------------------------- surukleme

  const startDrag = useCallback(
    (e: React.PointerEvent<HTMLElement>, index: number) => {
    resumeAudio();
    if (e.button !== 0 || !panelRef.current || config.lockItems) return;
    suppressClick.current = false;
    // Surukleme boyunca acik grup kapanmamali: kapanirsa suruklenen oge
    // listeden dusuyor ve surukleme yarida kaliyordu.
    clearTimeout(openTimer.current);
    clearTimeout(closeTimer.current);
    setInputLock(true);
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = {
      from: index,
      to: index,
      ox: e.clientX,
      oy: e.clientY,
      dx: 0,
      dy: 0,
      moved: false,
      out: false,
      onGroup: -1,
      // Panel dikdortgeni bir kez okunur; her frame'de layout okumayiz.
      rect: panelRef.current.getBoundingClientRect(),
    };
    },
    [config.lockItems]
  );

  const moveDrag = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d) return;
      d.dx = e.clientX - d.ox;
      d.dy = e.clientY - d.oy;
      if (!d.moved && Math.hypot(d.dx, d.dy) < DRAG_SLOP) return;

      if (!d.moved) {
        d.moved = true;
        clearTimeout(openTimer.current);
        panelRef.current?.classList.add("settling");
      }

      const r = d.rect;
      d.out =
        e.clientX < r.left - EJECT ||
        e.clientX > r.right + EJECT ||
        e.clientY < r.top - EJECT ||
        e.clientY > r.bottom + EJECT;

      if (!d.out) {
        const p = horizontal ? e.clientX - r.left : e.clientY - r.top;
        const at = slotAt(geo, p);
        const target = at >= 0 ? slots[at] : undefined;

        // GRUP ikonu: her yerine birakmak "icine ekle" demek (eskiden beri boyle).
        // NORMAL ikon: yalniz ORTASINA birakmak "yeni grup kur"; kenarlari
        // siralamaya birakiliyor. Ortasi/kenari ayrimi olmadan her kok ikon
        // grup hedefi oluyor ve iki ikonu yan yana kaydirmak imkansiz hale
        // geliyordu. Vurgu (icon--drop) yalniz grup kurulacakken cikiyor, yani
        // hangi islemin olacagi birakmadan once gorunuyor.
        const onGroupTarget =
          at !== d.from &&
          canDropOn(slots[d.from], target) &&
          (target?.kind === "group" ||
            Math.abs(p - (geo.starts[at] + geo.sizes[at] / 2)) <= geo.sizes[at] * GROUP_ZONE);

        if (onGroupTarget) {
          d.onGroup = at;
        } else {
          d.onGroup = -1;
          if (at >= 0 && slots[at].kind !== "add") d.to = at;
        }
      } else {
        d.onGroup = -1;
      }
      schedule();
    },
    [geo, horizontal, schedule, slots]
  );

  const endDrag = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const d = drag.current;
      drag.current = null;
      setInputLock(false);
      if (!d) return;
      e.currentTarget.releasePointerCapture?.(e.pointerId);
      if (!d.moved) {
        schedule();
        return;
      }
      suppressClick.current = true;

      const src = slots[d.from];
      if (!src || src.kind === "add") {
        schedule();
        return;
      }
      const dragged = src.item;

      if (d.onGroup >= 0) {
        const target = slots[d.onGroup];
        if (target?.kind === "group") onDropIntoGroup(dragged, target.item.id);
        else if (target?.kind === "item") onGroupWith(dragged, target.item.id);
      } else if (d.out) {
        // Grup icindeki oge disari suruklenirse koke doner; kokteki oge
        // masaustune geri konur.
        if (src.parent) onMoveOut(dragged, -1);
        else onEject(dragged);
      } else if (src.parent && slots[d.to]?.kind !== "add" && rootParentOf(slots[d.to]) === null) {
        // Grup icindeki oge, kok siradaki bir yuvaya birakildi: gruptan cikar.
        const rootIndex =
          slots.filter((s2, i) => i <= d.to && s2.kind !== "add" && s2.parent === null).length - 1;
        onMoveOut(dragged, Math.max(0, rootIndex));
      } else if (d.to !== d.from) {
        // Siralama yalniz ayni listenin (ayni parent) icinde yapilir.
        const parent = src.parent;
        const sibs = slots
          .map((s, i) => ({ s, i }))
          .filter((x): x is { s: Extract<Slot, { item: DockItem }>; i: number } =>
            x.s.kind !== "add" && x.s.parent === parent
          );
        const list = sibs.map((x) => x.s.item);
        const fromIdx = list.findIndex((x) => x.id === dragged.id);
        const toIdx = clamp(
          sibs.filter((x) => x.i <= d.to && x.s.item.id !== dragged.id).length,
          0,
          Math.max(0, list.length - 1)
        );
        if (fromIdx >= 0 && toIdx !== fromIdx) {
          const next = list.slice();
          const [moved] = next.splice(fromIdx, 1);
          next.splice(toIdx, 0, moved);
          onReorder(parent, next);
        }
      }
      schedule();
    },
    [onDropIntoGroup, onGroupWith, onEject, onMoveOut, onReorder, schedule, slots]
  );

  const activate = useCallback(
    (el: HTMLElement, slot: Slot) => {
      if (suppressClick.current) {
        suppressClick.current = false;
        return;
      }
      const anim = config.clickAnim;
      // Animasyon .icon__fx uzerinde calisir; hover hareketi (.icon__inner)
      // ile ayni transform'u paylassalardi animasyon biter bitmez ikon hover
      // konumuna sicriyordu. Iki katman -> iki bagimsiz transform.
      const fx = anim && anim !== "none" ? el.querySelector<HTMLElement>(".icon__fx") : null;
      if (fx) {
        fx.className = "icon__fx";
        void fx.offsetWidth; // reflow -> animasyonu yeniden tetikle
        fx.classList.add(`anim-${anim}`);
      }
      if (slot.kind === "add") onAdd();
      else if (slot.kind === "group") {
        clearTimeout(openTimer.current);
        onToggleGroup(expandedId === slot.item.id ? null : slot.item.id);
      } else if (slot.kind === "item") onLaunch(slot.item);
    },
    [config.clickAnim, expandedId, onAdd, onLaunch, onToggleGroup]
  );

  // Varlik protokolu URL'leri: yalniz ikon listesi degisince uretilir.
  // Gruplarin kapak resmi icin cocuklarin ikonlari da lazim.
  const sources = useMemo(() => {
    const map: Record<string, string> = {};
    const add = (it: DockItem) => {
      const file = it.icon ?? icons[it.id] ?? null;
      if (file) map[it.id] = convertFileSrc(file);
      for (const c of it.children ?? []) add(c);
    };
    for (const e of entries) add(e.item);
    return map;
  }, [entries, icons]);

  /** Geri donusum kutusu simgesi: dolu/bos durumuna gore */
  const binFace = (
    <span className="bin" data-full={!binEmpty || undefined}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
        <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
        <path className="bin__fill" d="M9 11v7M12 11v7M15 11v7" />
      </svg>
    </span>
  );

  /** Ogenin ikonu: resim, yoksa harf rozeti */
  const face = (item: DockItem) => {
    if (item.kind === "recycler") return binFace;
    const src = sources[item.id] ?? null;
    return src ? (
      <img src={src} alt="" draggable={false} />
    ) : (
      <span className="glyph" style={{ background: item.color ?? "#3d4657" }}>
        {item.label.trim().charAt(0).toUpperCase() || "?"}
      </span>
    );
  };

  /**
   * Grup kapagi: kapaliyken ilk dort cocugun 2x2 kucuk izgarasi (macOS "stack"
   * hissi). ACIKKEN izgara gosterilmez — cocuklar zaten yaninda duruyor, ayni
   * ikonlarin kucuk kopyalari "ikinci bir kopya" gibi gorunuyordu.
   */
  const groupFace = (item: DockItem) => {
    if (expandedId === item.id) {
      return (
        <span className="group__grid group__grid--open">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3 7h6l2 2h6a2 2 0 0 1 2 2v1H7l-3 7H4a1 1 0 0 1-1-1V7z" />
            <path d="M7 12h14l-3 7H4l3-7z" />
          </svg>
        </span>
      );
    }
    const kids = (item.children ?? []).slice(0, 4);
    if (!kids.length) {
      return (
        <span className="group__grid group__grid--empty">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3 7h6l2 2h10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
          </svg>
        </span>
      );
    }
    return (
      <span className="group__grid">
        {kids.map((k) => (
          <span className="group__cell" key={k.id}>
            {face(k)}
          </span>
        ))}
      </span>
    );
  };

  return (
    <div
      className="stage"
      data-edge={config.edge}
      data-hidden={hidden || undefined}
      data-drop={dropping || undefined}
      data-glow={config.glow || undefined}
      data-reflection={geo.reflect > 0 || undefined}
      data-shadow={config.iconShadow || undefined}
      data-reveal={config.revealAnim}
      data-hide={config.hideAnim || "auto"}
      data-hover={config.hoverAnim}
      data-theme={config.theme || "custom"}
      data-gray={config.iconGrayscale || undefined}
      style={
        {
          "--radius": `${config.radius}px`,
          "--pad": `${PANEL_PAD}px`,
          "--bg": rgba(config.bgColor, config.panelOpacity),
          "--accent": config.accent,
          "--accent-soft": rgba(config.accent, 0.38),
          "--accent-faint": rgba(config.accent, 0.14),
          "--reflect": `${geo.reflect}px`,
          "--icon-size": `${config.iconSize}px`,
          "--drop-hint": `"${t("dropHint")}"`,
        } as React.CSSProperties
      }
    >
      <div
        ref={panelRef}
        className={config.shadow ? "panel settling panel--shadow" : "panel settling"}
        style={{ width: geo.panelW, height: geo.panelH }}
        onPointerMove={onPointerMove}
        onPointerEnter={() => {
          clearTimeout(closeTimer.current);
          // Rust tarafi bunu surukleme algilamasi icin kullaniyor (bkz. dragwatch).
          setPointerOver(true);
          onEnter();
        }}
        onPointerLeave={onPointerLeave}
        onContextMenu={(e) => {
          if (e.target === e.currentTarget) {
            e.preventDefault();
            onMenu(null);
          }
        }}
      >
        {/* Surukleme tutamaci: dock'u serbestce tasir, cift tik kenara geri yaslar. */}
        <div
          className="grip"
          title={t("gripHint")}
          onPointerDown={(e) => {
            if (e.button === 0) onGripDown();
          }}
          onDoubleClick={onResetPosition}
        >
          <span /><span /><span />
        </div>

        {/* Acik grubun cocuklarini saran plaka */}
        {span && (
          <div
            ref={spanRef}
            className="group-span"
            aria-hidden="true"
            style={
              horizontal
                ? { left: span.start, width: span.size }
                : { top: span.start, height: span.size }
            }
          />
        )}

        {slots.map((slot, i) => {
          const thin = slot.kind === "sep";
          const pos = geo.starts[i] + (geo.sizes[i] - (thin ? 2 : config.iconSize)) / 2;
          const setNode = (el: HTMLElement | null) => {
            nodes.current[i] = el;
          };
          const child = slot.kind !== "add" && slot.parent !== null;

          if (slot.kind === "sep") {
            return (
              <div
                key={slot.item.id}
                ref={setNode}
                className="icon icon--sep"
                style={{
                  width: horizontal ? 2 : config.iconSize,
                  height: horizontal ? config.iconSize : 2,
                  transformOrigin: ORIGIN[config.edge],
                  ...(horizontal ? { left: pos } : { top: pos }),
                }}
                onPointerDown={(e) => startDrag(e, i)}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onMenu(slot.item);
                }}
              >
                <span className="icon__inner" />
              </div>
            );
          }

          const item = slot.kind === "add" ? null : slot.item;
          const cls = [
            "icon",
            slot.kind === "add" ? "icon--add" : "",
            slot.kind === "group" ? "icon--group" : "",
            slot.kind === "group" && expandedId === slot.item.id ? "icon--open" : "",
            child ? "icon--child" : "",
          ]
            .filter(Boolean)
            .join(" ");

          return (
            <button
              key={slot.kind === "add" ? "__add" : item!.id}
              ref={setNode}
              className={cls}
              type="button"
              aria-label={slot.kind === "add" ? t("addApp") : item!.label}
              style={{
                width: config.iconSize,
                height: config.iconSize,
                transformOrigin: ORIGIN[config.edge],
                ...(horizontal ? { left: pos } : { top: pos }),
              }}
              onPointerDown={item ? (e) => startDrag(e, i) : undefined}
              onPointerMove={item ? moveDrag : undefined}
              onPointerUp={item ? endDrag : undefined}
              onPointerCancel={item ? endDrag : undefined}
              onClick={(e) => activate(e.currentTarget, slot)}
              onContextMenu={(e) => {
                e.preventDefault();
                onMenu(item);
              }}
            >
              <span className="icon__inner">
                <span className="icon__fx">
                  {slot.kind === "add" ? (
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                  ) : slot.kind === "group" ? (
                    groupFace(item!)
                  ) : (
                    face(item!)
                  )}
                </span>
              </span>
              {slot.kind === "item" && running[item!.id] && (
                <span className="icon__running" aria-hidden="true" />
              )}
              {geo.reflect > 0 && (
                <span className="icon__mirror" aria-hidden="true">
                  {slot.kind === "item" ? face(item!) : slot.kind === "group" ? groupFace(item!) : null}
                </span>
              )}
            </button>
          );
        })}

        <div ref={tipRef} className="tooltip" />
      </div>
    </div>
  );
}
