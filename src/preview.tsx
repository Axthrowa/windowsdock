/**
 * GECICI tema onizleme sayfasi (yalniz `npm run dev` icin).
 * Tauri calisma zamani olmadan tum temalari yan yana cizer; uretim
 * paketine dahil degildir (vite rollup girisleri: index.html + settings.html).
 */
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import Dock, { type VisibleEntry } from "./components/Dock";
import { THEMES } from "./lib/themes";
import { rgba } from "./lib/color";
import { groupWith, moveTo } from "./lib/items";
import { makeT } from "./lib/i18n";
import type { DockConfig, DockItem } from "./lib/ipc";
import "./styles.css";

const app = (id: string, label: string, color: string): DockItem => ({
  id,
  label,
  path: `${id}.exe`,
  args: [],
  icon: null,
  color,
  kind: "app",
  children: [],
});
const sep = (id: string): DockItem => ({
  id,
  label: "",
  path: "",
  args: [],
  icon: null,
  color: null,
  kind: "separator",
  children: [],
});
const group = (id: string, label: string, children: DockItem[]): DockItem => ({
  id,
  label,
  path: "",
  args: [],
  icon: null,
  color: null,
  kind: "group",
  children,
});

const recycler = (id: string): DockItem => ({
  id,
  label: "Geri Dönüşüm",
  path: "shell:RecycleBinFolder",
  args: [],
  icon: null,
  color: null,
  kind: "recycler",
  children: [],
});

const items: DockItem[] = [
  app("a", "Gezgin", "#f5c542"),
  app("b", "Terminal", "#2f6fd0"),
  sep("s1"),
  group("g1", "Oyunlar", [app("c", "Spider-Man", "#e0674f"), app("d", "MW4", "#f5c542"), app("e", "Steam", "#3fc0c8")]),
  app("f", "Notlar", "#4fa3ff"),
  recycler("r1"),
];

const base: DockConfig = {
  items,
  edge: "bottom",
  anchor: "edge",
  align: "center",
  freeX: 0,
  freeY: 0,
  margin: 10,
  monitor: 0,
  iconSize: 46,
  magnification: 1.7,
  magnifyRange: 2.2,
  radius: 18,
  panelOpacity: 0.62,
  bgColor: "#161a22",
  accent: "#4fa3ff",
  theme: "custom",
  glow: true,
  reflection: false,
  clickAnim: "bounce",
  revealAnim: "slide",
  hideAnim: "auto",
  hoverAnim: "lift",
  iconShadow: true,
  acrylic: false,
  reserveSpace: false,
  layer: "top",
  language: "tr",
  autoHide: false,
  autoHideMode: "delay",
  hideDelay: 550,
  revealZone: 4,
  showLabels: true,
  shadow: true,
  hideAfterLaunch: false,
  startHidden: false,
  iconGap: 10,
  lockItems: false,
  runningIndicator: true,
  iconGrayscale: false,
  sounds: false,
  soundVolume: 0.5,
  soundScheme: "soft",
};

const noop = () => {};

const t = makeT("tr");

/** Cekmece dogrulamasi: grup acilinca dock o grubun icerigini gosterir. */
function DrawerDemo({ config, autoOpen = true }: { config: DockConfig; autoOpen?: boolean }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [list, setList] = useState(config.items);
  useEffect(() => {
    if (!autoOpen) return;
    const id = setTimeout(() => setOpenId("g1"), 250);
    return () => clearTimeout(id);
  }, [autoOpen]);
  config = { ...config, items: list };
  const entries: VisibleEntry[] = [];
  for (const it of list) {
    entries.push({ item: it, parent: null });
    if (it.id === openId) for (const c of it.children) entries.push({ item: c, parent: it.id });
  }
  return (
    <Dock
      config={config}
      entries={entries}
      expandedId={openId}
      running={{ a: true, b: true }}
      binEmpty={false}
      onToggleGroup={setOpenId}
      onDropIntoGroup={(it, gid) => setList((x) => moveTo(x, it.id, gid))}
      onGroupWith={(it, tid) => setList((x) => groupWith(x, it.id, tid, "Grup"))}
      onMoveOut={(it) => setList((x) => moveTo(x, it.id, null))}
      icons={{}}
      hidden={false}
      dropping={false}
      onLaunch={noop}
      onAdd={noop}
      onEject={noop}
      onReorder={(parent, next) =>
        setList((x) => (parent ? x.map((i) => (i.id === parent ? { ...i, children: next } : i)) : next))
      }
      onMenu={noop}
      onGripDown={noop}
      onResetPosition={noop}
      onEnter={noop}
      onLeave={noop}
    />
  );
}

/** Ayarlar penceresindeki tema galerisinin birebir kopyasi (gorsel dogrulama). */
function ChipGallery() {
  return (
    <div className="settings" style={{ gridColumn: "1 / -1", padding: 12 }}>
      <span className="themes">
        {THEMES.map((th) => {
          const bg = th.apply.bgColor ?? base.bgColor;
          const op = th.apply.panelOpacity ?? base.panelOpacity;
          const ac = th.apply.accent ?? base.accent;
          return (
            <button
              key={th.id}
              type="button"
              data-theme={th.id}
              className={th.id === "aqua" ? "theme-chip theme-chip--on" : "theme-chip"}
              style={
                {
                  "--bg": rgba(bg, op),
                  "--accent": ac,
                  "--accent-soft": rgba(ac, 0.38),
                  "--accent-faint": rgba(ac, 0.14),
                } as React.CSSProperties
              }
            >
              <span className="theme-chip__panel">
                <span className="theme-chip__dot" />
                <span className="theme-chip__dot" />
                <span className="theme-chip__dot" />
              </span>
              <span className="theme-chip__name">{t(th.labelKey)}</span>
            </button>
          );
        })}
      </span>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <div className="preview-grid">
    <ChipGallery />
    {THEMES.map((th) => {
      const config: DockConfig = { ...base, ...th.apply, theme: th.id };
      return (
        <div className="preview-cell" key={th.id}>
          <span className="preview-label">{th.id === "custom" ? "custom — GRUP YERINDE ACIK" : th.id}</span>
          {th.id === "custom" ? <DrawerDemo config={config} /> : <Dock
            config={config}
            entries={config.items.map((it) => ({ item: it, parent: null }))}
            expandedId={null}
            running={{ a: true, f: true }}
            binEmpty={false}
            onToggleGroup={noop}
            onDropIntoGroup={noop}
            onGroupWith={noop}
            onMoveOut={noop}
            icons={{}}
            hidden={false}
            dropping={false}
            onLaunch={noop}
            onAdd={noop}
            onEject={noop}
            onReorder={noop}
            onMenu={noop}
            onGripDown={noop}
            onResetPosition={noop}
            onEnter={noop}
            onLeave={noop}
          />}
        </div>
      );
    })}
  </div>
);
