/** The canonical taxonomy intentionally groups everyday services under `other`.
 * Keep that storage category, but recover an explicit source type for display.
 * Business names are never evidence for this classification. */
const SPECIFIC_TYPES: Record<string, string> = { bank: "bank", banks: "bank", atm: "ATM", "automated teller machine": "ATM", "currency exchange": "currency exchange", "bureau de change": "currency exchange" };
export const PLACE_TYPE_ENRICHMENT_BUDGET_MS = 400;

export function canonicalDisplayType(primaryCategory: unknown, specific?: string | null): string | null {
  if (typeof primaryCategory === "string" && primaryCategory.trim() && primaryCategory.toLowerCase() !== "other") return primaryCategory;
  return specific ?? null;
}

export async function readSpecificPlaceTypes(sc: any, rows: Array<{ id: string; primary_category?: unknown }>): Promise<Map<string, string>> {
  const ids = rows.filter(row => !canonicalDisplayType(row.primary_category)).map(row => row.id);
  if (!ids.length) return new Map();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const query = sc.from("external_place_references").select("place_id, raw_category").in("place_id", ids);
    const request = typeof query.abortSignal === "function" ? query.abortSignal(controller.signal) : query;
    // Race the complete read, not just response headers. Abort releases real
    // PostgREST transport; the deadline also bounds an uncooperative driver.
    const result = await Promise.race([
      Promise.resolve(request),
      new Promise<null>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, PLACE_TYPE_ENRICHMENT_BUDGET_MS); }),
    ]);
    if (!result) return new Map();
    const { data, error } = result;
    if (error || !Array.isArray(data)) return new Map();
    const types = new Map<string, Set<string>>();
    for (const row of data) {
      if (!ids.includes(row.place_id) || typeof row.raw_category !== "string") continue;
      const raw = row.raw_category.trim().toLowerCase().replace(/^amenity[=:]/, "").replace(/_/g, " ");
      const specific = SPECIFIC_TYPES[raw];
      if (!specific) continue;
      const seen = types.get(row.place_id) ?? new Set<string>();
      seen.add(specific); types.set(row.place_id, seen);
    }
    // Conflicting source types are unknown, not a reason to guess a winner.
    return new Map([...types].flatMap(([id, values]) => values.size === 1 ? [[id, [...values][0]!] as const] : []));
  } catch { return new Map(); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
