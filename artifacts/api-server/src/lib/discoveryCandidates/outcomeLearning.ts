/**
 * Learn from outcomes — `06` §1 stage 10, census-discovery §85 (lane W10-R3),
 * DC-11. Behind `discovery_outcome_learning_enabled` (3483, seeded FALSE).
 *
 * WHAT "LEARNING" IS HERE, SAID EXACTLY. Not a trained model. A per-item
 * outcome RATE, estimated from the served Discovery rows the outcome writer
 * already records (`rank_events.outcome`, updated in place from `impression`
 * to what the viewer did), smoothed toward the population rate of the same
 * read (empirical Bayes, prior strength LEARNING_PRIOR_STRENGTH), and turned
 * into a BOUNDED nudge on the served order:
 *
 *   rate_i  = (positive_i + m·p0) / (served_i + m)       p0 = the read's own rate
 *   lift_i  = rate_i / p0
 *   shift_i = clamp(LEARNING_MAX_SHIFT · (lift_i − 1), ±LEARNING_MAX_SHIFT)
 *
 * and the list is re-sorted, stably, by `(n − position) + shift`. So an item
 * can move at most LEARNING_MAX_SHIFT positions in either direction, and only
 * an item with at least LEARNING_MIN_SERVED served rows in the window moves at
 * all — the confidence control. A dismiss counts as a served row with no
 * positive outcome; a place the viewer dismissed is already removed by the
 * route's "Not interested" gate, and nothing here reads per-viewer rows.
 *
 * It is USER-INDEPENDENT (the rows of every viewer, per item), like momentum.
 * Nothing here is a claim that the nudge improves anything: that is a
 * production measurement the §12 instrument (§55) exists to take.
 */

export const LEARNING_MODEL_VERSION = "discovery-outcome-rate-v1";
export const LEARNING_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;
export const LEARNING_MIN_SERVED = 20;
export const LEARNING_PRIOR_STRENGTH = 10;
export const LEARNING_MAX_SHIFT = 3;
/** The outcomes that count as the viewer acting on a served row. */
export const LEARNING_POSITIVE_OUTCOMES: ReadonlySet<string> = new Set(["tap", "save", "join", "rsvp", "attended", "trip_add"]);
const READ_CAP = 5_000;

export interface LearningReport {
  status: "applied" | "no_evidence" | "read_failed";
  modelVersion: string;
  window: { kind: "bounded"; startMs: number; endMs: number };
  /** Served rows the read returned (capped at READ_CAP). */
  rowsRead: number;
  /** Items with at least LEARNING_MIN_SERVED served rows. */
  itemsWithEvidence: number;
  /** Items whose position changed. */
  moved: number;
}

export interface LearnedShift { id: string; shift: number; served: number; positive: number }

/** Pure: per-item shifts from outcome counts. */
export function learnedShifts(counts: ReadonlyMap<string, { served: number; positive: number }>): Map<string, LearnedShift> {
  let served = 0, positive = 0;
  for (const c of counts.values()) { served += c.served; positive += c.positive; }
  const out = new Map<string, LearnedShift>();
  if (served === 0) return out;
  const p0 = (positive + 1) / (served + 2);   // never 0 or 1
  for (const [id, c] of counts) {
    if (c.served < LEARNING_MIN_SERVED) continue;
    const rate = (c.positive + LEARNING_PRIOR_STRENGTH * p0) / (c.served + LEARNING_PRIOR_STRENGTH);
    const lift = rate / p0;
    const shift = Math.max(-LEARNING_MAX_SHIFT, Math.min(LEARNING_MAX_SHIFT, LEARNING_MAX_SHIFT * (lift - 1)));
    out.set(id, { id, shift, served: c.served, positive: c.positive });
  }
  return out;
}

/** Pure: the bounded re-sort. Stable; ties keep the input order. */
export function applyLearnedShifts(order: readonly string[], shifts: ReadonlyMap<string, LearnedShift>): string[] {
  const n = order.length;
  return order
    .map((id, i) => ({ id, i, key: (n - i) + (shifts.get(id)?.shift ?? 0) }))
    .sort((a, b) => (b.key - a.key) || (a.i - b.i))
    .map((x) => x.id);
}

/** Read the window's served rows for these ids and compute the shifts. Never throws. */
export async function loadLearnedShifts(
  sc: any, ids: readonly string[], nowMs: number,
): Promise<{ shifts: Map<string, LearnedShift>; report: LearningReport }> {
  const window = { kind: "bounded" as const, startMs: nowMs - LEARNING_WINDOW_MS, endMs: nowMs };
  const base: LearningReport = { status: "no_evidence", modelVersion: LEARNING_MODEL_VERSION, window, rowsRead: 0, itemsWithEvidence: 0, moved: 0 };
  const list = [...new Set(ids)].slice(0, 200);
  if (!sc || list.length === 0) return { shifts: new Map(), report: base };
  let data: any[] = [];
  try {
    const r = await sc.from("rank_events")
      .select("item_id, outcome, served_at")
      .eq("surface", "discovery")
      .neq("outcome", "analytics")
      .in("item_id", list)
      .gte("served_at", new Date(window.startMs).toISOString())
      .lt("served_at", new Date(window.endMs).toISOString())
      .order("served_at", { ascending: false })
      .limit(READ_CAP);
    if (r.error) return { shifts: new Map(), report: { ...base, status: "read_failed" } };
    data = Array.isArray(r.data) ? r.data : [];
  } catch { return { shifts: new Map(), report: { ...base, status: "read_failed" } }; }
  const counts = new Map<string, { served: number; positive: number }>();
  for (const row of data) {
    const id = typeof row.item_id === "string" ? row.item_id : null;
    if (!id) continue;
    const c = counts.get(id) ?? { served: 0, positive: 0 };
    c.served += 1;
    if (LEARNING_POSITIVE_OUTCOMES.has(String(row.outcome))) c.positive += 1;
    counts.set(id, c);
  }
  const shifts = learnedShifts(counts);
  return { shifts, report: { ...base, rowsRead: data.length, itemsWithEvidence: shifts.size, status: shifts.size > 0 ? "applied" : "no_evidence" } };
}
