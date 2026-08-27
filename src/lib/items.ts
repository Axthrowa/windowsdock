import type { DockItem } from "./ipc";

/**
 * Dock listesi uzerinde kucuk, saf yardimcilar.
 *
 * Hiyerarsi TEK KATMAN: kokte kisayol/grup/ayrac olabilir, grup icinde yalniz
 * kisayol ve ayrac bulunur (grup icinde grup yok). Bu sinir hem arayuzu hem
 * dock'un gezinmesini basit tutuyor.
 */

export const newId = () =>
  `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

const blank = (kind: DockItem["kind"], label: string): DockItem => ({
  id: newId(),
  label,
  path: "",
  args: [],
  icon: null,
  color: null,
  kind,
  children: [],
});

export const makeGroup = (label: string) => blank("group", label);
export const makeSeparator = () => blank("separator", "");
/** Geri donusum kutusu ogesi: kabuk klasorune isaret eder. */
export const makeRecycler = (label: string) => ({
  ...blank("recycler", label),
  path: "shell:RecycleBinFolder",
});

/** Ogeyi (kokte ya da bir grupta) bulur. */
export function findItem(items: DockItem[], id: string): DockItem | null {
  for (const it of items) {
    if (it.id === id) return it;
    for (const c of it.children ?? []) if (c.id === id) return c;
  }
  return null;
}

/** Ogenin bagli oldugu grubun id'si (kokteyse null). */
export function parentOf(items: DockItem[], id: string): string | null {
  for (const it of items) {
    for (const c of it.children ?? []) if (c.id === id) return it.id;
  }
  return null;
}

/** Ogeyi listeden cikarir (grup iclerine de bakar). */
export function removeItem(items: DockItem[], id: string): DockItem[] {
  return items
    .filter((i) => i.id !== id)
    .map((i) =>
      i.children?.length ? { ...i, children: i.children.filter((c) => c.id !== id) } : i
    );
}

/** Ogenin alanlarini gunceller (grup iclerine de bakar). */
export function updateItem(
  items: DockItem[],
  id: string,
  patch: Partial<DockItem>
): DockItem[] {
  return items.map((i) => {
    if (i.id === id) return { ...i, ...patch };
    if (i.children?.some((c) => c.id === id)) {
      return {
        ...i,
        children: i.children.map((c) => (c.id === id ? { ...c, ...patch } : c)),
      };
    }
    return i;
  });
}

/** Ogeyi hedef gruba (null = kok) tasir; sirasi sona eklenir. */
export function moveTo(items: DockItem[], id: string, groupId: string | null): DockItem[] {
  const item = findItem(items, id);
  if (!item || item.kind === "group") return items; // grup icine grup konmaz
  const without = removeItem(items, id);
  if (!groupId) return [...without, item];
  return without.map((i) =>
    i.id === groupId ? { ...i, children: [...(i.children ?? []), item] } : i
  );
}

/** Ogeyi kendi listesi icinde bir yukari/asagi tasir. */
export function moveWithin(items: DockItem[], id: string, dir: -1 | 1): DockItem[] {
  const swap = (list: DockItem[]): DockItem[] | null => {
    const idx = list.findIndex((i) => i.id === id);
    if (idx < 0) return null;
    const to = idx + dir;
    if (to < 0 || to >= list.length) return list;
    const out = list.slice();
    [out[idx], out[to]] = [out[to], out[idx]];
    return out;
  };

  const top = swap(items);
  if (top) return top;

  return items.map((i) => {
    if (!i.children?.length) return i;
    const kids = swap(i.children);
    return kids ? { ...i, children: kids } : i;
  });
}
