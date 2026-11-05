/**
 * Telegraph §28 SLO-02 — duplicate canonical messages, measured EXACTLY from the canonical store
 * (census-telegraph T347; migration 3937).
 *
 * The request middleware's detector remembers what ONE process saw accepted, so it is a floor on the
 * true number. Under the idempotency contract (2810's columns, written by the send door while
 * telegraph_idempotent_send_enabled is on) the exact number is a property of `messages` itself, and
 * `telegraph_duplicate_canonical_messages()` counts it. This module asks it and records the answer:
 *
 *   0 duplicate rows   → `ok`
 *   n > 0              → `violation`, once per duplicate row (capped at VIOLATION_RECORD_CAP, so one
 *                        bad day cannot flood the counter it is meant to make visible)
 *   unreadable         → `unknown` — the function is absent (3937 not applied) or the read failed. Never
 *                        reported as zero: "could not count" is not "counted none".
 *
 * Called on demand by the admin-only, audited diagnostics read; never on a traveller's path. Never throws.
 */
import { recordTelegraphMetric } from "../domain/telegraph/services/telegraphObservability.js";

export const DUPLICATE_CANONICAL_METRIC = "duplicate_canonical_messages";
export const VIOLATION_RECORD_CAP = 1000;

export type CanonicalDuplicateReading =
  | { readonly status: "measured"; readonly duplicateRows: number; readonly keyedGroups: number }
  | { readonly status: "unavailable"; readonly reason: string };

const count = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 0 ? n : null;
};

export async function measureDuplicateCanonicalMessages(sc: any): Promise<CanonicalDuplicateReading> {
  let data: unknown;
  let error: unknown;
  try {
    ({ data, error } = await sc.rpc("telegraph_duplicate_canonical_messages"));
  } catch {
    error = { message: "threw" };
  }
  const row = Array.isArray(data) ? data[0] : data;
  const dup = count((row as Record<string, unknown> | null)?.["duplicate_rows"]);
  const keyed = count((row as Record<string, unknown> | null)?.["keyed_groups"]);
  if (error || dup === null || keyed === null) {
    recordTelegraphMetric(DUPLICATE_CANONICAL_METRIC, "unknown");
    return { status: "unavailable", reason: "The canonical duplicate count could not be read (migration 3937 not applied, or the read failed). This is not a count of zero." };
  }
  if (dup === 0) recordTelegraphMetric(DUPLICATE_CANONICAL_METRIC, "ok");
  else for (let i = 0; i < Math.min(dup, VIOLATION_RECORD_CAP); i++) recordTelegraphMetric(DUPLICATE_CANONICAL_METRIC, "violation");
  return { status: "measured", duplicateRows: dup, keyedGroups: keyed };
}
