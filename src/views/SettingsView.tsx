import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { open } from "@tauri-apps/plugin-dialog";
import * as ipc from "../lib/ipc";
import type {
  AutoHideMode,
  ClickAnim,
  DockConfig,
  DockAlign,
  DockEdge,
  DockItem,
  DockLayer,
  HideAnim,
  HoverAnim,
  MonitorInfo,
  RevealAnim,
  SoundScheme,
} from "../lib/ipc";
import { LANGS, makeT, type Key, type Lang } from "../lib/i18n";
import { THEMES } from "../lib/themes";
import {
  makeGroup,
  makeRecycler,
  makeSeparator,
  moveTo,
  moveWithin,
  removeItem,
  updateItem,
} from "../lib/items";
import { rgba } from "../lib/color";

const PALETTE = ["#4fa3ff", "#59c17a", "#f5c542", "#e0674f", "#a97fe0", "#3fc0c8"];

const EDGES: DockEdge[] = ["bottom", "top", "left", "right"];
const EDGE_KEY = { bottom: "edgeBottom", top: "edgeTop", left: "edgeLeft", right: "edgeRight" } as const;

function Row({
  label,
  hint,
  stack,
  children,
}: {
  label: string;
  hint?: string;
  /** Yuksek denetimler (tema galerisi) icin: etiket ustte, denetim tam genislikte */
  stack?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className={stack ? "row row--stack" : "row"}>
      <span className="row__label">
        {label}
        {hint && <em>{hint}</em>}
      </span>
      <span className="row__control">{children}</span>
    </label>
  );
}

function Slider(props: {
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  digits?: number;
  onChange: (v: number) => void;
}) {
  const { value, min, max, step, unit = "", digits = 0, onChange } = props;
  return (
    <>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <output>
        {value.toFixed(digits)}
        {unit}
      </output>
    </>
  );
}

/** Uygulama / grup / ayrac satiri (gruplar cocuklarini icinde cizer). */
function ItemRow({
  item,
  parentId,
  groups,
  t,
  editItems,
}: {
  item: DockItem;
  parentId: string | null;
  groups: DockItem[];
  t: (k: Key) => string;
  editItems: (fn: (items: DockItem[]) => DockItem[]) => void;
}) {
  const ops = (
    <span className="apps__ops">
      <button type="button" onClick={() => editItems((x) => moveWithin(x, item.id, -1))} title={t("up")}>
        ↑
      </button>
      <button type="button" onClick={() => editItems((x) => moveWithin(x, item.id, 1))} title={t("down")}>
        ↓
      </button>
      <button
        type="button"
        className="danger"
        onClick={() => editItems((x) => removeItem(x, item.id))}
        title={t("removeItem")}
      >
        ✕
      </button>
    </span>
  );

  /** Kisayol ve ayraclar bir gruba tasinabilir; gruplar tasinmaz. */
  const groupPicker =
    item.kind === "group" ? null : (
      <select
        className="apps__group-pick"
        value={parentId ?? ""}
        title={t("moveToGroup")}
        onChange={(e) => editItems((x) => moveTo(x, item.id, e.target.value || null))}
      >
        <option value="">{t("noGroup")}</option>
        {groups.map((g) => (
          <option key={g.id} value={g.id}>
            {g.label || t("group")}
          </option>
        ))}
      </select>
    );

  if (item.kind === "separator") {
    return (
      <li className="apps__sep">
        <span className="apps__name apps__sep-line">— {t("separator")} —</span>
        <span className="apps__path" />
        {groupPicker}
        {ops}
      </li>
    );
  }

  if (item.kind === "group") {
    return (
      <li className="apps__group">
        <input
          className="apps__name"
          value={item.label}
          placeholder={t("group")}
          onChange={(e) => editItems((x) => updateItem(x, item.id, { label: e.target.value }))}
        />
        <span className="apps__path">
          {item.children.length ? `${item.children.length} öğe` : t("emptyGroup")}
        </span>
        {ops}
        {item.children.length > 0 && (
          <ul className="apps apps--nested">
            {item.children.map((c) => (
              <ItemRow
                key={c.id}
                item={c}
                parentId={item.id}
                groups={groups}
                t={t}
                editItems={editItems}
              />
            ))}
          </ul>
        )}
      </li>
    );
  }

  return (
    <li>
      <input
        className="apps__name"
        value={item.label}
        onChange={(e) => editItems((x) => updateItem(x, item.id, { label: e.target.value }))}
      />
      <span className="apps__path" title={item.path}>
        {item.path}
      </span>
      {groupPicker}
      {ops}
    </li>
  );
}

export default function SettingsView() {
  const [cfg, setCfg] = useState<DockConfig | null>(null);
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [autostart, setAutostart] = useState(false);
  const [autostartError, setAutostartError] = useState<string | null>(null);

  const cfgRef = useRef<DockConfig | null>(null);
  cfgRef.current = cfg;

  useEffect(() => {
    ipc.loadConfig().then(setCfg).catch((e) => console.error("config", e));
    ipc.monitorInfo().then(setMonitors).catch((e) => console.error("monitors", e));
    isEnabled().then(setAutostart).catch(() => setAutostart(false));

    // Dock tarafinda yapilan degisiklikler (surukleme, oge ekleme) burada da gorunsun.
    const un = listen<DockConfig>("config-changed", (e) => setCfg(e.payload));
    return () => void un.then((f) => f());
  }, []);

  // Slider surukleyisi saniyede onlarca degisiklik uretir; diske yazma ve
  // dock'a yayin kisa bir gecikmeyle toplanir.
  const saveTimer = useRef(0);
  const pending = useRef<DockConfig | null>(null);

  const flush = useCallback(() => {
    clearTimeout(saveTimer.current);
    const next = pending.current;
    if (!next) return;
    pending.current = null;
    ipc.saveConfig(next).catch((e) => console.error("save", e));
  }, []);

  const patch = useCallback(
    (delta: Partial<DockConfig>) => {
      const base = cfgRef.current;
      if (!base) return;
      const next = { ...base, ...delta };
      setCfg(next);
      cfgRef.current = next;
      pending.current = next;
      clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(flush, 90);
    },
    [flush]
  );

  // Pencere gizlenirken/kapanirken son degisiklik kaybolmasin.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [flush]);

  const toggleAutostart = useCallback(async (on: boolean) => {
    setAutostartError(null);
    try {
      if (on) await enable();
      else await disable();
      setAutostart(await isEnabled());
    } catch (e) {
      setAutostartError(String(e));
      setAutostart(await isEnabled().catch(() => false));
    }
  }, []);

  const addApp = useCallback(async () => {
    const base = cfgRef.current;
    if (!base) return;
    const tr = makeT(base.language as Lang);
    const picked = await open({
      multiple: false,
      title: tr("pickTitle"),
      filters: [{ name: tr("pickFilter"), extensions: ["exe", "lnk", "url", "bat", "cmd"] }],
    });
    if (typeof picked !== "string") return;
    const name = picked.replace(/\\/g, "/").split("/").pop() ?? picked;
    const item: DockItem = {
      id: `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
      label: name.replace(/\.(exe|lnk|url|bat|cmd)$/i, ""),
      path: picked,
      // .lnk sonradan silinse bile ikon/baslatma calissin diye hedefi simdi cozuyoruz.
      target: (await ipc.resolveTarget(picked)) ?? "",
      args: [],
      icon: null,
      color: PALETTE[base.items.length % PALETTE.length],
      kind: "app",
      children: [],
    };
    patch({ items: [...base.items, item] });
  }, [patch]);

  /** Oge listesini donusturen tek giris noktasi */
  const editItems = useCallback(
    (fn: (items: DockItem[]) => DockItem[]) => {
      const base = cfgRef.current;
      if (!base) return;
      patch({ items: fn(base.items) });
    },
    [patch]
  );

  const addGroup = useCallback(
    () => editItems((items) => [...items, makeGroup("Grup")]),
    [editItems]
  );
  const addSeparator = useCallback(
    () => editItems((items) => [...items, makeSeparator()]),
    [editItems]
  );
  const addRecycler = useCallback(
    () => editItems((items) => [...items, makeRecycler("Geri Dönüşüm Kutusu")]),
    [editItems]
  );

  const t = useMemo(() => makeT((cfg?.language ?? "tr") as Lang), [cfg?.language]);
  const groups = useMemo(
    () => (cfg?.items ?? []).filter((i) => i.kind === "group"),
    [cfg?.items]
  );
  if (!cfg) return <div className="settings settings--loading">{t("loading")}</div>;

  return (
    <div className="settings">
      <section>
        <h2>{t("secGeneral")}</h2>

        <Row label={t("language")}>
          <select value={cfg.language} onChange={(e) => patch({ language: e.target.value as Lang })}>
            {LANGS.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </Row>
      </section>

      <section>
        <h2>{t("secPosition")}</h2>

        <Row label={t("edge")}>
          <select value={cfg.edge} onChange={(e) => patch({ edge: e.target.value as DockEdge })}>
            {EDGES.map((e) => (
              <option key={e} value={e}>
                {t(EDGE_KEY[e])}
              </option>
            ))}
          </select>
        </Row>

        <Row label={t("monitor")}>
          <select value={cfg.monitor} onChange={(e) => patch({ monitor: Number(e.target.value) })}>
            {monitors.map((m) => (
              <option key={m.index} value={m.index}>
                {m.index + 1}. {m.name} — {m.width}x{m.height}
                {m.primary ? ` (${t("primary")})` : ""}
              </option>
            ))}
          </select>
        </Row>

        <Row label={t("layout")} hint={t("layoutHint")}>
          <button
            type="button"
            className={cfg.anchor === "edge" ? "seg seg--on" : "seg"}
            onClick={() => patch({ anchor: "edge" })}
          >
            {t("anchorEdge")}
          </button>
          <button
            type="button"
            className={cfg.anchor === "free" ? "seg seg--on" : "seg"}
            onClick={() => patch({ anchor: "free" })}
          >
            {t("anchorFree")}
          </button>
        </Row>

        <Row label={t("align")}>
          <select value={cfg.align} onChange={(e) => patch({ align: e.target.value as DockAlign })}>
            <option value="start">{t("alignStart")}</option>
            <option value="center">{t("alignCenter")}</option>
            <option value="end">{t("alignEnd")}</option>
          </select>
        </Row>

        <Row label={t("margin")}>
          <Slider value={cfg.margin} min={0} max={80} step={1} unit=" px"
            onChange={(margin) => patch({ margin })} />
        </Row>
      </section>

      <section>
        <h2>{t("secSizes")}</h2>

        <Row label={t("iconSize")}>
          <Slider value={cfg.iconSize} min={24} max={160} step={2} unit=" px"
            onChange={(iconSize) => patch({ iconSize })} />
        </Row>

        <Row label={t("magnification")}>
          <Slider value={cfg.magnification} min={1} max={2.6} step={0.05} digits={2} unit="x"
            onChange={(magnification) => patch({ magnification })} />
        </Row>

        <Row label={t("magnifyRange")} hint={t("magnifyRangeHint")}>
          <Slider value={cfg.magnifyRange} min={0.6} max={4} step={0.1} digits={1}
            onChange={(magnifyRange) => patch({ magnifyRange })} />
        </Row>

        <Row label={t("iconGap")}>
          <Slider value={cfg.iconGap} min={0} max={40} step={1} unit=" px"
            onChange={(iconGap) => patch({ iconGap })} />
        </Row>

        <Row label={t("radius")}>
          <Slider value={cfg.radius} min={0} max={40} step={1} unit=" px"
            onChange={(radius) => patch({ radius })} />
        </Row>

        <Row label={t("opacity")}>
          <Slider value={cfg.panelOpacity} min={0} max={1} step={0.02} digits={2}
            onChange={(panelOpacity) => patch({ panelOpacity })} />
        </Row>
      </section>

      <section>
        <h2>{t("secColors")}</h2>

        <Row label={t("theme")} hint={t("themeHint")} stack>
          <span className="themes">
            {THEMES.map((th) => {
              const bg = th.apply.bgColor ?? cfg.bgColor;
              const op = th.apply.panelOpacity ?? cfg.panelOpacity;
              const ac = th.apply.accent ?? cfg.accent;
              return (
                <button
                  key={th.id}
                  type="button"
                  data-theme={th.id}
                  title={t(th.labelKey)}
                  className={cfg.theme === th.id ? "theme-chip theme-chip--on" : "theme-chip"}
                  style={
                    {
                      "--bg": rgba(bg, op),
                      "--accent": ac,
                      "--accent-soft": rgba(ac, 0.38),
                      "--accent-faint": rgba(ac, 0.14),
                    } as React.CSSProperties
                  }
                  onClick={() => patch({ ...th.apply, theme: th.id })}
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
        </Row>

        <Row label={t("bgColor")} hint={t("bgColorHint")}>
          <input type="color" value={cfg.bgColor}
            onChange={(e) => patch({ bgColor: e.target.value })} />
          <input className="hex" value={cfg.bgColor} spellCheck={false}
            onChange={(e) => patch({ bgColor: e.target.value })} />
        </Row>

        <Row label={t("accent")} hint={t("accentHint")}>
          <input type="color" value={cfg.accent}
            onChange={(e) => patch({ accent: e.target.value })} />
          <input className="hex" value={cfg.accent} spellCheck={false}
            onChange={(e) => patch({ accent: e.target.value })} />
        </Row>

        <Row label={t("presets")}>
          <span className="swatches">
            {[
              { bg: "#161a22", ac: "#4fa3ff", t: t("themeNight") },
              { bg: "#0e1512", ac: "#59c17a", t: t("themeForest") },
              { bg: "#1b1220", ac: "#a97fe0", t: t("themeViolet") },
              { bg: "#201612", ac: "#f0894f", t: t("themeCopper") },
              { bg: "#f2f4f8", ac: "#2a6ec4", t: t("themeDay") },
              { bg: "#0d1b26", ac: "#3fc0c8", t: t("themeOcean") },
              { bg: "#241016", ac: "#e0678f", t: t("themeRose") },
              { bg: "#101010", ac: "#c8c8c8", t: t("themeCarbon") },
              { bg: "#0a0f1e", ac: "#7cf3ff", t: t("themeNeon") },
              { bg: "#241f16", ac: "#d8b26a", t: t("themeSand") },
              { bg: "#141024", ac: "#8b7bff", t: t("themeNebula") },
            ].map((sw) => (
              <button key={sw.t} type="button" title={sw.t} className="swatch"
                style={{ background: sw.bg, borderColor: sw.ac }}
                onClick={() => patch({ bgColor: sw.bg, accent: sw.ac })} />
            ))}
          </span>
        </Row>
      </section>

      <section>
        <h2>{t("secEffects")}</h2>

        <Row label={t("showLabels")}>
          <input type="checkbox" checked={cfg.showLabels}
            onChange={(e) => patch({ showLabels: e.target.checked })} />
        </Row>

        <Row label={t("glow")} hint={t("glowHint")}>
          <input type="checkbox" checked={cfg.glow}
            onChange={(e) => patch({ glow: e.target.checked })} />
        </Row>

        <Row label={t("reflection")} hint={t("reflectionHint")}>
          <input type="checkbox" checked={cfg.reflection}
            onChange={(e) => patch({ reflection: e.target.checked })} />
        </Row>

        <Row label={t("clickAnim")}>
          <select value={cfg.clickAnim} onChange={(e) => patch({ clickAnim: e.target.value as ClickAnim })}>
            <option value="none">{t("animNone")}</option>
            <option value="bounce">{t("animBounce")}</option>
            <option value="shake">{t("animShake")}</option>
            <option value="pulse">{t("animPulse")}</option>
            <option value="spin">{t("animSpin")}</option>
            <option value="jelly">{t("animJelly")}</option>
            <option value="pop">{t("animPop")}</option>
            <option value="wobble">{t("animWobble")}</option>
            <option value="flip">{t("animFlip")}</option>
            <option value="tada">{t("animTada")}</option>
            <option value="swing">{t("animSwing")}</option>
            <option value="dive">{t("animDive")}</option>
          </select>
        </Row>

        <Row label={t("hoverAnim")}>
          <select value={cfg.hoverAnim} onChange={(e) => patch({ hoverAnim: e.target.value as HoverAnim })}>
            <option value="none">{t("animNone")}</option>
            <option value="lift">{t("hoverLift")}</option>
            <option value="tilt">{t("hoverTilt")}</option>
            <option value="pop">{t("hoverPop")}</option>
            <option value="swing">{t("hoverSwing")}</option>
            <option value="float">{t("hoverFloat")}</option>
            <option value="throb">{t("hoverThrob")}</option>
            <option value="jump">{t("hoverJump")}</option>
            <option value="wiggle">{t("hoverWiggle")}</option>
            <option value="spin">{t("hoverSpin")}</option>
            <option value="ring">{t("hoverRing")}</option>
            <option value="sink">{t("hoverSink")}</option>
          </select>
        </Row>

        <Row label={t("revealAnim")}>
          <select value={cfg.revealAnim} onChange={(e) => patch({ revealAnim: e.target.value as RevealAnim })}>
            <option value="slide">{t("revSlide")}</option>
            <option value="fade">{t("revFade")}</option>
            <option value="scale">{t("revScale")}</option>
            <option value="slide-fade">{t("revSlideFade")}</option>
            <option value="bounce">{t("revBounce")}</option>
            <option value="unfold">{t("revUnfold")}</option>
          </select>
        </Row>

        <Row label={t("hideAnim")} hint={t("hideAnimHint")}>
          <select value={cfg.hideAnim} onChange={(e) => patch({ hideAnim: e.target.value as HideAnim })}>
            <option value="auto">{t("hideAuto")}</option>
            <option value="fade">{t("hideFade")}</option>
            <option value="scale">{t("hideScale")}</option>
            <option value="blur">{t("hideBlur")}</option>
            <option value="genie">{t("hideGenie")}</option>
            <option value="flip">{t("hideFlip")}</option>
            <option value="drop">{t("hideDrop")}</option>
            <option value="curl">{t("hideCurl")}</option>
            <option value="swirl">{t("hideSwirl")}</option>
            <option value="dissolve">{t("hideDissolve")}</option>
            <option value="squeeze">{t("hideSqueeze")}</option>
          </select>
        </Row>

        <Row label={t("iconGrayscale")} hint={t("iconGrayscaleHint")}>
          <input type="checkbox" checked={cfg.iconGrayscale}
            onChange={(e) => patch({ iconGrayscale: e.target.checked })} />
        </Row>

        <Row label={t("iconShadow")}>
          <input type="checkbox" checked={cfg.iconShadow}
            onChange={(e) => patch({ iconShadow: e.target.checked })} />
        </Row>

        <Row label={t("panelShadow")}>
          <input type="checkbox" checked={cfg.shadow}
            onChange={(e) => patch({ shadow: e.target.checked })} />
        </Row>

        <Row label={t("acrylic")} hint={t("acrylicHint")}>
          <input type="checkbox" checked={cfg.acrylic}
            onChange={(e) => patch({ acrylic: e.target.checked })} />
        </Row>
      </section>

      <section>
        <h2>{t("secBehavior")}</h2>

        <Row label={t("windowLayer")} hint={t("windowLayerHint")}>
          <select value={cfg.layer} onChange={(e) => patch({ layer: e.target.value as DockLayer })}>
            <option value="desktop">{t("layerDesktop")}</option>
            <option value="normal">{t("layerNormal")}</option>
            <option value="top">{t("layerTop")}</option>
          </select>
        </Row>

        <Row label={t("taskbarLike")} hint={t("taskbarLikeHint")}>
          <input type="checkbox" checked={cfg.reserveSpace}
            onChange={(e) => patch({ reserveSpace: e.target.checked })} />
        </Row>

        <Row label={t("autoHide")} hint={t("autoHideHint")}>
          <input type="checkbox" checked={cfg.autoHide}
            onChange={(e) => patch({ autoHide: e.target.checked })} />
        </Row>

        <Row label={t("autoHideMode")} hint={t("modeDodgeHint")}>
          <select value={cfg.autoHideMode}
            onChange={(e) => patch({ autoHideMode: e.target.value as AutoHideMode })}>
            <option value="delay">{t("modeDelay")}</option>
            <option value="dodge">{t("modeDodge")}</option>
          </select>
        </Row>

        <Row label={t("runningIndicator")} hint={t("runningIndicatorHint")}>
          <input type="checkbox" checked={cfg.runningIndicator}
            onChange={(e) => patch({ runningIndicator: e.target.checked })} />
        </Row>

        <Row label={t("hideDelay")}>
          <Slider value={cfg.hideDelay} min={0} max={3000} step={50} unit=" ms"
            onChange={(hideDelay) => patch({ hideDelay })} />
        </Row>

        <Row label={t("revealZone")} hint={t("revealZoneHint")}>
          <Slider value={cfg.revealZone} min={1} max={24} step={1} unit=" px"
            onChange={(revealZone) => patch({ revealZone })} />
        </Row>

        <Row label={t("lockItems")} hint={t("lockItemsHint")}>
          <input type="checkbox" checked={cfg.lockItems}
            onChange={(e) => patch({ lockItems: e.target.checked })} />
        </Row>

        <Row label={t("hideAfterLaunch")}>
          <input type="checkbox" checked={cfg.hideAfterLaunch}
            onChange={(e) => patch({ hideAfterLaunch: e.target.checked })} />
        </Row>

        <Row label={t("startHidden")}>
          <input type="checkbox" checked={cfg.startHidden}
            onChange={(e) => patch({ startHidden: e.target.checked })} />
        </Row>

        <Row label={t("autostart")}>
          <input type="checkbox" checked={autostart}
            onChange={(e) => toggleAutostart(e.target.checked)} />
        </Row>
        {autostartError && <p className="err">{t("autostartError")} {autostartError}</p>}
      </section>

      <section>
        <h2>{t("secSound")}</h2>

        <Row label={t("sounds")} hint={t("soundsHint")}>
          <input type="checkbox" checked={cfg.sounds}
            onChange={(e) => patch({ sounds: e.target.checked })} />
        </Row>

        <Row label={t("soundVolume")}>
          <Slider value={cfg.soundVolume} min={0} max={1} step={0.05} digits={2}
            onChange={(soundVolume) => patch({ soundVolume })} />
        </Row>

        <Row label={t("soundScheme")}>
          <select value={cfg.soundScheme}
            onChange={(e) => patch({ soundScheme: e.target.value as SoundScheme })}>
            <option value="soft">{t("schemeSoft")}</option>
            <option value="click">{t("schemeClick")}</option>
            <option value="retro">{t("schemeRetro")}</option>
          </select>
        </Row>
      </section>

      <section>
        <h2>
          {t("secApps")}
          <span className="apps__add">
            <button type="button" className="add" onClick={addApp}>
              + {t("add")}
            </button>
            <button type="button" className="add" onClick={addGroup}>
              + {t("addGroup")}
            </button>
            <button type="button" className="add" onClick={addSeparator}>
              + {t("addSeparator")}
            </button>
            <button type="button" className="add" onClick={addRecycler}>
              + {t("addRecycler")}
            </button>
          </span>
        </h2>

        <ul className="apps">
          {cfg.items.map((item) => (
            <ItemRow
              key={item.id}
              item={item}
              parentId={null}
              groups={groups}
              t={t}
              editItems={editItems}
            />
          ))}
        </ul>
      </section>
    </div>
  );
}
