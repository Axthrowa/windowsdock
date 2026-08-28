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
  target: "",
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

/**
 * Iki kisayoldan yeni bir grup kurar (macOS'ta ikonu ikonun uzerine birakmak).
 *
 * Grup, HEDEFIN yerine gecer: kullanici neyin uzerine biraktiysa grup orada
 * belirir. Hedef bir grubun icindeyse grup o grubun icine degil, hedefin
 * koktedeki atasinin yanina kurulur — hiyerarsi tek katman kalmali.
 * Sadece kisayol + kisayol birlestirilir; grup/ayrac icin `items` aynen doner.
 */
export function groupWith(
  items: DockItem[],
  dragId: string,
  targetId: string,
  label: string
): DockItem[] {
  if (dragId === targetId) return items;
  const dragged = findItem(items, dragId);
  const target = findItem(items, targetId);
  const ok = (i: DockItem | null) => !!i && i.kind !== "group" && i.kind !== "separator";
  if (!ok(dragged) || !ok(target)) return items;

  // Hedef bir grubun icindeyse konum capasi o gruptur; yeni grup onun ardina
  // gelir (grup icine grup konmuyor).
  const anchorId = parentOf(items, targetId) ?? targetId;
  const group: DockItem = { ...makeGroup(label), children: [target!, dragged!] };

  // Tek gecis: kok listeyi bastan kurarken suruklenen ogeyi her yerden dusur,
  // capaya gelince yeni grubu yerlestir. Once "sil sonra ekle" yaptigimizda
  // capa da silinmis oluyor ve ekleme indeksi kayiyordu.
  const out: DockItem[] = [];
  for (const i of items) {
    if (i.id === dragId) continue; // koktekiyse listeden dusur
    if (i.id === anchorId) {
      if (anchorId === targetId) {
        out.push(group); // hedefin tam yerine
      } else {
        // Capa grup: hedef cocugu (ve varsa suruklenen cocugu) cikar, grubu ardina koy.
        const kids = (i.children ?? []).filter((c) => c.id !== targetId && c.id !== dragId);
        out.push({ ...i, children: kids });
        out.push(group);
      }
      continue;
    }
    out.push(
      i.children?.some((c) => c.id === dragId)
        ? { ...i, children: i.children.filter((c) => c.id !== dragId) }
        : i
    );
  }
  return out;
}

/**
 * Bu islemle BOSALAN gruplari siler.
 *
 * "Su an bos olan her grubu sil" demiyoruz: kullanici ayarlardan bilerek bos
 * bir grup kurabiliyor ve icini doldurmadan once silinmemeli. Olcut, grubun
 * onceki listede dolu olup simdi bosalmis olmasi — yani son ogesi disari
 * cikarilmis olmasi.
 */
export function pruneEmptied(prev: DockItem[], next: DockItem[]): DockItem[] {
  const wasFull = new Set(
    prev.filter((i) => i.kind === "group" && (i.children?.length ?? 0) > 0).map((i) => i.id)
  );
  if (!wasFull.size) return next;
  const out = next.filter(
    (i) => !(i.kind === "group" && !(i.children?.length ?? 0) && wasFull.has(i.id))
  );
  return out.length === next.length ? next : out;
}
