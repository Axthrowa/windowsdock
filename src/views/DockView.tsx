import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import Dock, { type VisibleEntry } from "../components/Dock";
import { computeGeometry, kindOf, panelRect } from "../lib/magnify";
import { groupWith, moveTo, pruneEmptied, removeItem } from "../lib/items";
import * as ipc from "../lib/ipc";
import { makeT } from "../lib/i18n";
import { tintBytes } from "../lib/color";
import { playSound, type SoundEvent } from "../lib/sound";
import type { DockConfig, DockItem } from "../lib/ipc";

const PALETTE = ["#4fa3ff", "#59c17a", "#f5c542", "#e0674f", "#a97fe0", "#3fc0c8"];
/** Reveal sonrasi fare dock'a girmezse yeniden gizlenme suresi */
const GRACE = 1400;
/** Gizlenme animasyonunun suresi (styles.css ile ayni tutulmali) */
const HIDE_ANIM = 300;
/** Es zamanli ikon cikarma sayisi: kabugu bogmadan sirayi hizlandirir. */
const ICON_WORKERS = 4;
/** Ikon onbellegi anahtari: cozum hem yola hem kayitli .lnk hedefine bagli. */
const iconKey = (it: DockItem) => `${it.path}|${it.target ?? ""}`;
/** Tiklama animasyonlarinin suresi, ms (styles.css'teki .anim-* ile ayni tutulmali) */
const CLICK_ANIM: Record<string, number> = {
  bounce: 480, shake: 420, pulse: 380, spin: 520, jelly: 620,
  pop: 340, wobble: 620, flip: 560, tada: 720, swing: 640, dive: 520,
};

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export default function DockView() {
  const [config, setConfig] = useState<DockConfig | null>(null);
  const [icons, setIcons] = useState<Record<string, string | null>>({});
  const [hidden, setHidden] = useState(false);
  const [dropping, setDropping] = useState(false);

  const shown = useRef(false);
  const over = useRef(false);
  /**
   * Yerel sag tik menusu acik mi? Menu fareyi yakaladigi icin webview
   * "pointerleave" aliyor; onlem alinmazsa otomatik gizleme devreye girip
   * menu daha ekrandayken dock kayboluyordu.
   */
  const menuOpen = useRef(false);
  const dragging = useRef(false);
  const hideTimer = useRef(0);
  const graceTimer = useRef(0);
  const moveTimer = useRef(0);

  const cfgRef = useRef<DockConfig | null>(null);
  cfgRef.current = config;

  /** Ses efekti (ayarlar her zaman guncel config'den okunur) */
  const snd = useCallback((event: SoundEvent) => {
    const cfg = cfgRef.current;
    if (!cfg) return;
    playSound(event, {
      enabled: cfg.sounds,
      volume: cfg.soundVolume,
      scheme: cfg.soundScheme,
    });
  }, []);

  const layoutRef = useRef<ipc.LayoutReq | null>(null);

  // ---- gruplar: grubun uzerine gelince icerigi YERINDE acilir ----
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const expandedGroup = useMemo(
    () => config?.items.find((i) => i.id === expandedId && i.kind === "group") ?? null,
    [config?.items, expandedId]
  );
  /** Dock'ta gorunen sira: kok ogeler + acik grubun cocuklari (grubun ardina) */
  const entries = useMemo<VisibleEntry[]>(() => {
    const out: VisibleEntry[] = [];
    for (const it of config?.items ?? []) {
      out.push({ item: it, parent: null });
      if (it.id === expandedId && it.kind === "group") {
        for (const c of it.children ?? []) out.push({ item: c, parent: it.id });
      }
    }
    return out;
  }, [config?.items, expandedId]);
  // Grup silinince acik durum da dusmeli.
  useEffect(() => {
    if (expandedId && !expandedGroup) setExpandedId(null);
  }, [expandedId, expandedGroup]);

  // ---- yukleme + ayarlar penceresinden gelen degisiklikler ----
  useEffect(() => {
    ipc.loadConfig().then(setConfig).catch((e) => console.error("config", e));
    const un = listen<DockConfig>("config-changed", (e) => setConfig(e.payload));
    return () => void un.then((f) => f());
  }, []);

  const commit = useCallback((next: DockConfig) => {
    // Son ogesi disari cikarilan grup kendiliginden kaybolur. Tek yerde
    // yapiliyor: surukleme, sag tik menusu ve ayarlar ayni yoldan geciyor.
    const prev = cfgRef.current;
    const items = prev ? pruneEmptied(prev.items, next.items) : next.items;
    const cfg = items === next.items ? next : { ...next, items };
    setConfig(cfg);
    ipc.saveConfig(cfg).catch((e) => console.error("save", e));
  }, []);

  // ---- pencere olcusu + konumu ----
  // Yalniz yerlesimi etkileyen alanlara bagli: renk/efekt degisiklikleri
  // pencereyi yeniden boyutlandirip konumlandirmaz (ayarlarda surukleme
  // sirasinda saniyede onlarca IPC + AppBar cagrisi demekti).
  // Olcum tek yerde: yerlesim de fare testi de ayni geometriden beslenir
  // (eskiden ikisi ayri ayri hesapliyordu — ayni girdi, iki kat is).
  const geo = useMemo(
    () => (config ? computeGeometry(config, [...entries.map((e) => kindOf(e.item)), "icon"]) : null),
    [config, entries]
  );

  const layout = useMemo<ipc.LayoutReq | null>(() => {
    if (!config || !geo) return null;
    return {
      width: geo.winW,
      height: geo.winH,
      panelW: geo.panelW,
      panelH: geo.panelH,
      edge: config.edge,
      anchor: config.anchor,
      align: config.align ?? "center",
      margin: config.margin,
      monitor: config.monitor,
      freeX: config.freeX,
      freeY: config.freeY,
      // Masaustu duzeyinde bir arac penceresi calisma alanini daraltmamali.
      reserve: config.reserveSpace && !config.autoHide && config.layer !== "desktop",
    };
  }, [config, geo]);
  const layoutKey = layout ? JSON.stringify(layout) : "";
  layoutRef.current = layout;

  // ---- fare testi: yalnizca panelin gorunur dikdortgeni tiklanabilir olsun ----
  // Pencere panelden buyuk (buyuyen ikon + etiket payi); bu seffaf kusak
  // aksi halde masaustune giden tiklamalari yutuyordu.
  useEffect(() => {
    if (!config || !geo) return;
    const r = panelRect(geo, config.edge);
    const dpr = window.devicePixelRatio || 1;
    ipc.setHitRect({
      x: Math.round(r.x * dpr),
      y: Math.round(r.y * dpr),
      w: Math.round(r.w * dpr),
      h: Math.round(r.h * dpr),
    });
  }, [layoutKey, config, geo]);

  useEffect(() => {
    if (!layoutRef.current) return;
    ipc
      .applyLayout(layoutRef.current)
      .then(() => {
        if (shown.current) return;
        shown.current = true;
        return ipc.showDock();
      })
      .catch((e) => console.error("layout", e));
  }, [layoutKey]);

  // ---- dil: tepsi menusu etiketleri ----
  const language = config?.language;
  useEffect(() => {
    if (!language) return;
    const t = makeT(language);
    ipc
      .updateTray({ settings: t("tSettings"), toggle: t("tToggle"), quit: t("tQuit") })
      .catch((e) => console.error("tray", e));
  }, [language]);

  // ---- z-duzeyi ----
  const layer = config?.layer;
  useEffect(() => {
    if (!layer) return;
    ipc.setLayer(layer).catch((e) => console.error("layer", e));
  }, [layer]);

  // ---- pencere efekti (Windows 11 akrilik) ----
  const acrylic = config?.acrylic;
  const bgColor = config?.bgColor;
  const panelOpacity = config?.panelOpacity;
  useEffect(() => {
    if (acrylic === undefined || bgColor === undefined || panelOpacity === undefined) return;
    ipc
      .setAcrylic(acrylic, acrylic ? tintBytes(bgColor, panelOpacity) : null)
      .catch((e) => console.error("acrylic", e));
  }, [acrylic, bgColor, panelOpacity]);

  // ---- ikon cikarma (disk onbellekli, yalniz yol degisince tetiklenir) ----
  /** Gruplarin icindekiler dahil tum kisayollar (duz liste) */
  const flatItems = useMemo(() => {
    const out: DockItem[] = [];
    const walk = (list: DockItem[]) => {
      for (const it of list) {
        if (it.kind === "separator") continue;
        if (it.kind === "group") walk(it.children ?? []);
        else out.push(it);
      }
    };
    walk(config?.items ?? []);
    return out;
  }, [config?.items]);

  const pathKey = useMemo(
    () => flatItems.map((i) => `${i.id}|${i.path}|${i.target ?? ""}|${i.icon ?? ""}`).join(";"),
    [flatItems]
  );

  const flatRef = useRef<DockItem[]>([]);
  flatRef.current = flatItems;

  /** "yol|hedef" -> cozulmus PNG. Ayni kaynak iki kez kabuga sorulmaz. */
  const iconCache = useRef(new Map<string, string | null>());
  useEffect(() => {
    const items = flatRef.current;
    if (!items.length) return;
    let alive = true;
    const cache = iconCache.current;

    // Once bilinenleri yaz: onbellekteki yollar ve zaten cozulmus ogeler
    // aninda gorunur, kalkan ogeler haritadan duser.
    setIcons((prev) => {
      const seeded: Record<string, string | null> = {};
      for (const it of items) {
        const k = iconKey(it);
        const known = it.icon ?? (cache.has(k) ? cache.get(k)! : prev[it.id]);
        if (known !== undefined) seeded[it.id] = known;
      }
      return seeded;
    });

    const queue = items.filter((it) => !it.icon && !cache.has(iconKey(it)));
    if (!queue.length) return;

    // Eskiden butun ikonlar tek tek cozulur ve harita ANCAK dongu bitince
    // yazilirdi. Yeni bir kisayol eklemek pathKey'i degistirip etkiyi bastan
    // baslattigi icin yarim kalan is comp oluyordu: arka arkaya birkac kisayol
    // eklendiginde harita hic yazilamiyor ve butun ikonlar harf fallback'ine
    // dusuyordu. Artik her ikon cozulur cozulmez tek tek yaziliyor ve onbellek
    // sayesinde yeniden baslayan tur yalniz yeni yollari soruyor.
    const worker = async () => {
      while (alive) {
        const it = queue.shift();
        if (!it) return;
        let png: string | null = null;
        try {
          png = await ipc.resolveIcon(it.path, it.target ?? "");
        } catch {
          png = null;
        }
        cache.set(iconKey(it), png);
        if (!alive) return;
        setIcons((prev) => (prev[it.id] === png ? prev : { ...prev, [it.id]: png }));
      }
    };
    void Promise.all(
      Array.from({ length: Math.min(ICON_WORKERS, queue.length) }, worker)
    );

    return () => {
      alive = false;
    };
  }, [pathKey]);

  // ---- calisan uygulama gostergesi + geri donusum durumu ----
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const [binEmpty, setBinEmpty] = useState(true);

  useEffect(() => {
    // Gizliyken yoklama yapmayiz: bosuna is ve pil tuketimi.
    if (hidden || !config?.runningIndicator) {
      setRunning({});
      return;
    }
    let alive = true;
    const apps = flatItems.filter((i) => i.kind === "app" && i.path);
    const bins = flatItems.some((i) => i.kind === "recycler");
    if (!apps.length && !bins) return;

    const tick = async () => {
      if (apps.length) {
        // Kayitli hedef varsa onu gonderiyoruz: kaynak .lnk silinmisse yol
        // olu, Rust tarafi cozemiyor ve uygulama hic "calisiyor" gorunmuyordu.
        // Hedef zaten cozulmus gercek dosya; canli .lnk ile ayni sonucu verir.
        const flags = await ipc.runningFlags(apps.map((i) => i.target || i.path));
        if (!alive) return;
        const next: Record<string, boolean> = {};
        apps.forEach((it, n) => (next[it.id] = flags[n] ?? false));
        setRunning(next);
      }
      if (bins) {
        const empty = await ipc.recyclerEmpty();
        if (alive) setBinEmpty(empty);
      }
    };
    void tick();
    const id = window.setInterval(tick, 2500);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [hidden, config?.runningIndicator, flatItems]);

  // ---- otomatik gizleme ----
  // Sira onemli: gizlenirken ONCE animasyon oynar, sonra pencere arkaya duser.
  // (Once z-duzeyi degistirilirse dock kayarak degil, aniden yok oluyordu.)
  // Acilirken tersi: once one alinir, sonra kayarak girer.
  const hiddenRef = useRef(false);
  const applyHidden = useCallback(async (next: boolean) => {
    const cfg = cfgRef.current;
    if (!cfg) return;
    if (hiddenRef.current === next) return;
    hiddenRef.current = next;

    if (next) {
      snd("hide");
      setHidden(true);
      await wait(HIDE_ANIM);
      if (!hiddenRef.current) return; // bu arada geri cagrildi
    }

    try {
      await ipc.setHidden({
        hidden: next,
        edge: cfg.edge,
        zone: cfg.revealZone,
        monitor: cfg.monitor,
        desktopOnly: cfg.layer === "desktop",
      });
      // Masaustu duzeyinde dock her seyin altindadir; acilirken gorunur olmasi
      // icin one aliniyor ama "her zaman ustte" YAPILMIYOR: kullanici bir
      // uygulamaya gecer gecmez o uygulama dock'un ustunde kalir.
      if (cfg.autoHide && cfg.layer === "desktop") {
        if (next) await ipc.setLayer("desktop");
        else await ipc.raiseAboveDesktop();
      }
    } catch (e) {
      console.error("setHidden", e);
    }

    if (!next && !hiddenRef.current) {
      snd("show");
      setHidden(false);
    }
  }, [snd]);

  const scheduleHide = useCallback(
    (delay: number) => {
      clearTimeout(hideTimer.current);
      hideTimer.current = window.setTimeout(() => {
        // "dodge" modunda gizlemeyi pencere ortusu belirler, sure degil.
        if (cfgRef.current?.autoHideMode === "dodge") return;
        if (!over.current && !dragging.current && !menuOpen.current) applyHidden(true);
      }, delay);
    },
    [applyHidden]
  );

  const autoHide = config?.autoHide;
  const hideDelay = config?.hideDelay;
  const edge = config?.edge;
  const monitor = config?.monitor;
  const firstHide = useRef(true);
  useEffect(() => {
    if (autoHide === undefined || hideDelay === undefined) return;
    clearTimeout(hideTimer.current);
    clearTimeout(graceTimer.current);
    if (autoHide && cfgRef.current?.autoHideMode === "dodge") {
      // Pencere kacinma: baslangicta gorunur, karari gozcu verecek.
      applyHidden(false);
    } else if (autoHide) {
      // Acilista gizli baslama istegi varsa beklemeden gizle.
      const first = firstHide.current;
      firstHide.current = false;
      if (first && cfgRef.current?.startHidden) applyHidden(true);
      // Yoksa acilista biraz daha uzun bekle: kullanici dock'u gorup tanisin.
      else scheduleHide(hideDelay + (first ? 1200 : 0));
    } else applyHidden(false);
  }, [autoHide, hideDelay, edge, monitor, applyHidden, scheduleHide]);

  // Gizleme zamanlayicisi yukaridaki etkide yalniz autoHide/hideDelay/edge/
  // monitor degisince kuruluyor; ayarlardan tema ya da renk degistirmek
  // bunlarin hicbiri degil. Zamanlayici o ana kadar tukenmisse (menuden
  // Ayarlar'i acmak gibi) otomatik gizleme bir daha kendiliginden
  // kurulmuyordu. Her config degisimi gizlemeyi yeniden kuruyor: fare
  // dock'un ustundeyse ya da surukleme/menu varsa zaten scheduleHide'in
  // kendi korumasi engelliyor.
  useEffect(() => {
    if (!config?.autoHide || config.autoHideMode === "dodge") return;
    if (hiddenRef.current || over.current || dragging.current || menuOpen.current) return;
    scheduleHide(config.hideDelay);
  }, [config, scheduleHide]);

  // Pencere kacinma modu (Nexus: Dodge Windows)
  const dodgeOn = !!config?.autoHide && config?.autoHideMode === "dodge";
  useEffect(() => {
    ipc.setDodge(dodgeOn);
    if (!dodgeOn) return;
    const un = listen<boolean>("dock-dodge", (e) => {
      applyHidden(!!e.payload);
    });
    return () => void un.then((f) => f());
  }, [dodgeOn, applyHidden]);

  useEffect(() => {
    const un = listen("dock-reveal", () => {
      applyHidden(false);
      clearTimeout(graceTimer.current);
      graceTimer.current = window.setTimeout(() => {
        if (!over.current) applyHidden(true);
      }, GRACE);
    });
    return () => void un.then((f) => f());
  }, [applyHidden]);

  useEffect(
    () => () => {
      clearTimeout(hideTimer.current);
      clearTimeout(graceTimer.current);
      clearTimeout(moveTimer.current);
    },
    []
  );

  const onEnter = useCallback(() => {
    over.current = true;
    clearTimeout(hideTimer.current);
    clearTimeout(graceTimer.current);
  }, []);

  const onLeave = useCallback(() => {
    over.current = false;
    // Menu acikken "fare ayrildi" sinyali gercek degil: menu fareyi yakaladi.
    if (menuOpen.current) return;
    if (cfgRef.current?.autoHide) scheduleHide(cfgRef.current.hideDelay);
  }, [scheduleHide]);

  // ---- serbest tasima ----
  const onGripDown = useCallback(() => {
    dragging.current = true;
    clearTimeout(hideTimer.current);
    getCurrentWindow().startDragging().catch((e) => console.error("drag", e));
  }, []);

  useEffect(() => {
    const w = getCurrentWindow();
    const un = w.onMoved(({ payload }) => {
      if (!dragging.current) return;
      clearTimeout(moveTimer.current);
      const { x, y } = payload;
      moveTimer.current = window.setTimeout(() => {
        dragging.current = false;
        const cfg = cfgRef.current;
        if (cfg) commit({ ...cfg, anchor: "free", freeX: x, freeY: y });
      }, 260);
    });
    return () => void un.then((f) => f());
  }, [commit]);

  // ---- Explorer'dan surukle-birak ile kisayol ekleme ----
  const addPaths = useCallback(
    async (paths: string[]) => {
      const cfg = cfgRef.current;
      if (!cfg || !paths.length) return;
      const known = new Set(cfg.items.map((i) => i.path.toLowerCase()));
      const fresh = paths.filter((p) => p && !known.has(p.toLowerCase()));
      if (!fresh.length) return;

      // Kisayolun isaret ettigi gercek dosyayi SIMDI cozuyoruz: kullanici
      // masaustundeki .lnk'yi sonradan silerse dock elinde yalnizca olu bir
      // yol kaliyordu (ikon cikmiyor, "masaustune geri koy" calismiyordu).
      const targets = await Promise.all(fresh.map((p) => ipc.resolveTarget(p)));

      const items = fresh.map((p, n) => {
        const base = p.replace(/\\/g, "/").split("/").pop() ?? p;
        return {
          id: `${Date.now().toString(36)}-${n}-${Math.floor(Math.random() * 1e6).toString(36)}`,
          label: base.replace(/\.(exe|lnk|url|bat|cmd|msc|cpl)$/i, ""),
          path: p,
          target: targets[n] ?? "",
          args: [] as string[],
          icon: null,
          color: PALETTE[(cfg.items.length + n) % PALETTE.length],
          kind: "app" as const,
          children: [] as DockItem[],
        };
      });
      snd("add");
      commit({ ...cfg, items: [...cfg.items, ...items] });
    },
    [commit, snd]
  );

  // WebView2 istemci alanini kaplayan alt penceresini OLE birakma hedefi olarak
  // kaydettigi icin `tauri://drag-drop` bu pencerede hicbir zaman yayinlanmiyor.
  // Rust tarafi o alt pencereye kendi hedefimizi kurar ve asagidaki olaylari uretir.
  useEffect(() => {
    const uns = [
      listen<string[]>("dock-drop", (e) => {
        setDropping(false);
        addPaths(e.payload ?? []);
      }),
      listen<boolean>("dock-drag-over", (e) => {
        setDropping(!!e.payload);
        if (e.payload) {
          clearTimeout(hideTimer.current);
          if (cfgRef.current?.autoHide) applyHidden(false);
        }
      }),
    ];
    return () => void Promise.all(uns).then((fs) => fs.forEach((f) => f()));
  }, [addPaths, applyHidden]);

  const dropActive = useRef(false);
  useEffect(() => {
    const un = getCurrentWebview().onDragDropEvent((e) => {
      const t = e.payload.type;
      if (t === "drop") {
        ipc.traceJs(`drag-drop: drop ${JSON.stringify(e.payload.paths)}`);
        dropActive.current = false;
        setDropping(false);
        addPaths(e.payload.paths);
        return;
      }
      if (t === "leave") {
        ipc.traceJs("drag-drop: leave");
        dropActive.current = false;
        setDropping(false);
        return;
      }
      // enter / over: surekli tetiklenir, gereksiz render uretmesin.
      clearTimeout(hideTimer.current);
      if (!dropActive.current) {
        ipc.traceJs(`drag-drop: ${t}`);
        dropActive.current = true;
        setDropping(true);
        if (cfgRef.current?.autoHide) applyHidden(false);
      }
    });
    return () => void un.then((f) => f());
  }, [addPaths, applyHidden]);

  const onResetPosition = useCallback(() => {
    const cfg = cfgRef.current;
    if (cfg) commit({ ...cfg, anchor: "edge" });
  }, [commit]);

  // ---- oge yonetimi ----
  const onLaunch = useCallback(
    (item: DockItem) => {
      setExpandedId(null);
      snd("launch");
      const path = item.kind === "recycler" ? "shell:RecycleBinFolder" : item.path;
      ipc.launchItem(path, item.args, item.target ?? "").catch((e) => console.error("launch", e));
      // Nexus'taki "hide after launching an application".
      // Tiklama animasyonu bitene kadar bekliyoruz: aksi halde dock ayni
      // karede kayboluyor ve animasyon hic gorunmuyordu ("tiklama
      // animasyonlari calismiyor" sikayetinin sebebi buydu).
      const cfg = cfgRef.current;
      if (cfg?.hideAfterLaunch) {
        const ms = CLICK_ANIM[cfg.clickAnim] ?? 0;
        if (ms) window.setTimeout(() => applyHidden(true), ms);
        else applyHidden(true);
      }
    },
    [applyHidden, snd]
  );

  /** Verilen listeyi (kok ya da bir grubun cocuklari) yazan yardimci */
  const withList = useCallback(
    (cfg: DockConfig, parent: string | null, list: DockItem[]): DockConfig =>
      parent
        ? {
            ...cfg,
            items: cfg.items.map((i) => (i.id === parent ? { ...i, children: list } : i)),
          }
        : { ...cfg, items: list },
    []
  );

  const onAdd = useCallback(async () => {
    const cfg = cfgRef.current;
    if (!cfg) return;
    const picked = await open({
      multiple: false,
      title: makeT(cfg.language)("pickTitle"),
      filters: [
        { name: makeT(cfg.language)("pickFilter"), extensions: ["exe", "lnk", "url", "bat", "cmd"] },
      ],
    });
    if (typeof picked !== "string") return;

    const base = picked.replace(/\\/g, "/").split("/").pop() ?? picked;
    const item: DockItem = {
      id: `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
      label: base.replace(/\.(exe|lnk|url|bat|cmd)$/i, ""),
      path: picked,
      target: (await ipc.resolveTarget(picked)) ?? "",
      args: [],
      icon: null,
      color: PALETTE[cfg.items.length % PALETTE.length],
      kind: "app",
      children: [],
    };
    // Acik bir grup varsa yeni kisayol onun icine girer.
    const parent = expandedId && cfg.items.some((i) => i.id === expandedId) ? expandedId : null;
    const list = parent
      ? (cfg.items.find((i) => i.id === parent)?.children ?? [])
      : cfg.items;
    commit(withList(cfg, parent, [...list, item]));
  }, [commit, expandedId, withList]);

  /** Dock disina surukleme: kisayolu masaustune geri koy, sonra dock'tan cikar. */
  const onEject = useCallback(
    async (item: DockItem) => {
      // Grup ve ayrac disari suruklenince yalnizca kaldirilir; kisayol ise
      // masaustune geri konur.
      if (item.kind === "app") {
        try {
          const dest = await ipc.ejectToDesktop(item.path, item.label, item.target ?? "");
          ipc.traceJs(`eject -> ${dest}`);
        } catch (e) {
          // Masaustune konamadiysa ogeyi dock'tan SILMIYORUZ. Eskiden hata
          // yutulup oge yine de kaldiriliyordu: kisayol ne masaustunde ne
          // dock'ta kaliyor, kullanici icin "kayboldu" demekti.
          console.error("eject", e);
          ipc.traceJs(`eject hata: ${e}`);
          return;
        }
      }
      const cfg = cfgRef.current;
      if (!cfg) return;
      snd("remove");
      commit({ ...cfg, items: removeItem(cfg.items, item.id) });
    },
    [commit, snd]
  );

  const onReorder = useCallback(
    (parent: string | null, list: DockItem[]) => {
      const cfg = cfgRef.current;
      if (cfg) commit(withList(cfg, parent, list));
    },
    [commit, withList]
  );

  const onRemove = useCallback(
    (id: string) => {
      const cfg = cfgRef.current;
      if (cfg) commit({ ...cfg, items: removeItem(cfg.items, id) });
    },
    [commit]
  );

  /** Ikon bir grubun uzerine birakildi: grubun icine tasi. */
  const onDropIntoGroup = useCallback(
    (item: DockItem, groupId: string) => {
      const cfg = cfgRef.current;
      if (!cfg || item.id === groupId) return;
      commit({ ...cfg, items: moveTo(cfg.items, item.id, groupId) });
    },
    [commit]
  );

  /** Ikon baska bir ikonun uzerine birakildi: ikisinden yeni grup kur. */
  const onGroupWith = useCallback(
    (item: DockItem, targetId: string) => {
      const cfg = cfgRef.current;
      if (!cfg || item.id === targetId) return;
      const items = groupWith(cfg.items, item.id, targetId, makeT(cfg.language)("group"));
      if (items === cfg.items) return; // birlestirilemedi (grup/ayrac)
      snd("add");
      commit({ ...cfg, items });
      // Yeni grup hemen acilsin: kullanici neyin icine girdigini gorsun.
      const made = items.find((i) => i.kind === "group" && i.children?.some((c) => c.id === item.id));
      if (made) setExpandedId(made.id);
    },
    [commit, snd]
  );

  /** Gruptan cikarma: koke, istenen sirada geri koy (silme degil). */
  const onMoveOut = useCallback(
    (item: DockItem, index: number) => {
      const cfg = cfgRef.current;
      if (!cfg) return;
      const without = removeItem(cfg.items, item.id);
      const at = index < 0 ? without.length : Math.min(Math.max(0, index), without.length);
      const items = [...without.slice(0, at), item, ...without.slice(at)];
      commit({ ...cfg, items });
    },
    [commit]
  );

  const onToggleGroup = useCallback((id: string | null) => setExpandedId(id), []);

  /** Yerel Windows kabuk menusu: dosyanin masaustundeki secenekleri + kendi ogelerimiz. */
  const onMenu = useCallback(
    async (item: DockItem | null) => {
      const cfg = cfgRef.current;
      if (!cfg) return;
      const t = makeT(cfg.language);
      // Menu acikken otomatik gizleme devreye girmesin; ayrica pencere
      // tiklama-gecirgen yapilmasin (menu fareyi yakaladigi icin gozcu
      // "dock'un uzerinde degil" saniyordu).
      menuOpen.current = true;
      ipc.setInputLock(true);
      clearTimeout(hideTimer.current);
      clearTimeout(graceTimer.current);
      over.current = true;

      ipc.traceJs(`onMenu: ${item ? item.path : "(panel)"}`);
      let action: ipc.MenuAction = "";
      try {
        action = await ipc.showItemMenu({
          path: item?.path ?? null,
          removable: !!item,
          labels: {
            remove: t("mRemove"),
            add: t("mAdd"),
            settings: t("mSettings"),
            hide: t("mHide"),
            quit: t("mQuit"),
          },
        });
      } catch (e) {
        console.error("menu", e);
      } finally {
        // Bayraklar her kosulda temizlenmeli: menu cagrisi hata verir ya da
        // zaman asimina ugrarsa menuOpen acik kalir ve otomatik gizlemenin
        // korumasi ("menu acikken gizleme") dock'u sonsuza dek gorunur tutar.
        menuOpen.current = false;
        ipc.setInputLock(false);
        over.current = false;
      }
      switch (action) {
        case "remove":
          if (item) onRemove(item.id);
          break;
        case "add":
          onAdd();
          break;
      }
      // Menu kapandiktan sonra fareyi dock'a geri goturmek icin biraz sure
      // taniyoruz; imlec dock'a girerse (pointerenter) gizleme iptal olur.
      if (cfgRef.current?.autoHide) scheduleHide(cfgRef.current.hideDelay + 900);
    },
    [onAdd, onRemove, scheduleHide]
  );


  if (!config) return null;

  return (
    <Dock
      config={config}
      entries={entries}
      expandedId={expandedId}
      running={running}
      binEmpty={binEmpty}
      onToggleGroup={onToggleGroup}
      onDropIntoGroup={onDropIntoGroup}
      onGroupWith={onGroupWith}
      onMoveOut={onMoveOut}
      icons={icons}
      hidden={hidden}
      dropping={dropping}
      onLaunch={onLaunch}
      onAdd={onAdd}
      onEject={onEject}
      onReorder={onReorder}
      onMenu={onMenu}
      onGripDown={onGripDown}
      onResetPosition={onResetPosition}
      onEnter={onEnter}
      onLeave={onLeave}
    />
  );
}
