/**
 * formatLocationLabel — joins a place/location name with a city, but skips
 * the city when the name already includes it (case-insensitive, either as
 * an exact match or as one of its comma-separated segments).
 *
 * Without this, "Hanoi, Vietnam" + city "Hanoi" renders as a visible
 * duplicate ("Hanoi, Vietnam · Hanoi" or "Hanoi, Vietnam, Hanoi") anywhere
 * a name and a separately-stored city are concatenated for display.
 *
 * `separator` controls how the city is appended when it's NOT a duplicate
 * (default ", " for prose contexts; pass " · " to match chip/meta rows that
 * use a dot separator).
 */
export function formatLocationLabel(
  name: string | null | undefined,
  city: string | null | undefined,
  separator: string = ', ',
): string {
  const n = name?.trim() || '';
  const c = city?.trim() || '';
  if (!n) return c;
  if (!c) return n;
  const alreadyIncludesCity =
    n.toLowerCase() === c.toLowerCase() ||
    n.toLowerCase().split(',').map((s) => s.trim()).includes(c.toLowerCase());
  return alreadyIncludesCity ? n : `${n}${separator}${c}`;
}
