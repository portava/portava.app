/**
 * wallMomentRead — the PREVIOUS readings a transition is detected against:
 * the projection's own append-only record, intel_state_snapshot_versions
 * (2273), read privacy-eligible only, for one subject.
 *
 * The CURRENT value never comes from here — it comes from lib/liveClaimRead,
 * where every gate lives. A previous reading is a comparison baseline: it is
 * never served, and a sub-k version (privacy_eligible false) is never read,
 * so nothing this module returns can leak a cohort the gate withheld.
 *
 * A failed read is a REFUSAL with a name, never an empty list: an absent
 * table (2273 unapplied on a database), a permission problem and a transient
 * error must not read as "no history" (§20 schema failure ≠ no activity).
 * The client is injected; this module names no credential.
 */
import type { PreviousReading } from "./wallMoments.js";

export const SNAPSHOT_VERSIONS_TABLE = "intel_state_snapshot_versions";
/** Versions read per claim type — enough history to find the last differing value. */
export const PREVIOUS_READINGS_PER_TYPE = 20;

export type PreviousReadResult =
  | { ok: true; readings: PreviousReading[] }
  | { ok: false; reason: "no_client" | "versions_unavailable" | "error" };

function isMissingRelation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; message?: unknown };
  const code = typeof e.code === "string" ? e.code : "";
  if (code === "42P01" || code === "PGRST205") return true;
  const msg = typeof e.message === "string" ? e.message.toLowerCase() : "";
  return msg.includes("does not exist") || msg.includes("could not find the table");
}

export async function readPreviousReadings(
  sc: any,
  subjectId: string,
  claimTypes: readonly string[],
): Promise<PreviousReadResult> {
  if (!sc) return { ok: false, reason: "no_client" };
  if (!subjectId || claimTypes.length === 0) return { ok: true, readings: [] };
  try {
    const { data, error } = await sc
      .from(SNAPSHOT_VERSIONS_TABLE)
      .select("claim_type, value, observed_at, generated_at")
      .eq("subject_id", subjectId)
      .eq("privacy_eligible", true)
      .in("claim_type", claimTypes)
      .order("generated_at", { ascending: false })
      .limit(PREVIOUS_READINGS_PER_TYPE * claimTypes.length);
    if (error) return { ok: false, reason: isMissingRelation(error) ? "versions_unavailable" : "error" };
    const readings: PreviousReading[] = [];
    for (const row of (data as any[]) ?? []) {
      if (!row || typeof row.claim_type !== "string") continue;
      readings.push({
        claimType: row.claim_type,
        value: row.value,
        observedAt: String(row.observed_at ?? ""),
        generatedAt: String(row.generated_at ?? ""),
      });
    }
    return { ok: true, readings };
  } catch {
    return { ok: false, reason: "error" };
  }
}
