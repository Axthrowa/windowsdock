/** #rgb / #rrggbb -> [r,g,b]; gecersizse koyu gri. */
export function hexToRgb(hex: string): [number, number, number] {
  const h = (hex || "").trim().replace(/^#/, "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  if (!/^[0-9a-f]{6}$/i.test(full)) return [22, 26, 34];
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export const rgba = (hex: string, alpha: number) => {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

/** Akrilik tonlamasi icin RGBA baytlari. */
export const tintBytes = (hex: string, alpha: number): number[] => [
  ...hexToRgb(hex),
  Math.round(Math.min(1, Math.max(0, alpha)) * 255),
];
