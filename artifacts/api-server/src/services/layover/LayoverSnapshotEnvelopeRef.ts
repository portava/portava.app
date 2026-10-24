/**
 * census-layover L25 — the snapshot's `safe_envelope_ref` (spec §4 `layover_snapshots`; this tree's snapshot table is
 * `layover_certified_computations`, 2992's header). Spec §5 `EVALUATING → LANDSIDE_AVAILABLE`: "Create snapshot + safe
 * envelope + candidate set". This tree derives the safe envelope from the snapshot rather than storing it; the ref is
 * what lets a reader tell, from the stored row alone, WHICH envelope a traveller was shown under that snapshot.
 *
 * THE REF IS CONTENT-ADDRESSED, AND IT IS THE PUBLISHED ENVELOPE'S. It is computed from the record exactly as
 * `GET /airport/sessions/:id/overview` publishes `safeEnvelope` (routes/airport.ts `publishedSafeEnvelope`): withheld
 * when the landside gate is closed, absent when the airport has no coordinate, otherwise `safeEnvelope(usable minutes,
 * airport point, confidence)`. So `sha256(canonical(served safeEnvelope))` equals the stored ref, and the PostgreSQL
 * proof asserts exactly that against the router's own response.
 *
 *   env:<64 hex>                      an envelope was published; the hash of its canonical JSON (sorted keys)
 *   env:withheld:landside_closed      the gate was closed, so no envelope was drawn
 *   env:withheld:no_airport_coordinate  nothing to centre one on
 *   NULL                              NOT RECORDED: the flag was off, or a writer that does not record it (the route
 *                                     fan-out RPC, 3908, which is off in production) wrote the row. Never "no envelope".
 *
 * Written only when `layover_snapshot_envelope_ref_enabled` is ON. 3951 adds the column and seeds that flag FALSE in
 * the same file, so the flag can be ON only where the column exists; OFF, absent or unreadable sends nothing, and the
 * insert is byte-for-byte what it was before 3951.
 */
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isFlagEnabled } from "../../lib/featureFlags.js";
import type { LayoverFeasibilityRecord } from "../airport/LayoverFeasibility.js";
import { safeEnvelope, type SafeEnvelope } from "../airport/LayoverEnvelope.js";
import { airportPoint } from "../airport/LayoverTravelTime.js";
import { landsideStatusOf } from "../airport/LayoverConstraints.js";

export const SNAPSHOT_ENVELOPE_REF_FLAG = "layover_snapshot_envelope_ref_enabled";

export type SafeEnvelopeRef = `env:${string}`;
export const SAFE_ENVELOPE_REF_PATTERN = /^env:([a-f0-9]{64}|withheld:(landside_closed|no_airport_coordinate))$/;

function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
}

/** The envelope as the overview publishes it for this record, or why none was published. */
export function publishedEnvelopeOf(record: LayoverFeasibilityRecord): { envelope: SafeEnvelope; withheld: null } | { envelope: null; withheld: "landside_closed" | "no_airport_coordinate" } {
  if (landsideStatusOf(record) === "closed") return { envelope: null, withheld: "landside_closed" };
  const envelope = safeEnvelope(record.envelope.usableMinutes, airportPoint(record.inputs.airport), record.confidence);
  return envelope ? { envelope, withheld: null } : { envelope: null, withheld: "no_airport_coordinate" };
}

/** The ref of an envelope as served (a parsed JSON body or the object itself). */
export function safeEnvelopeRefOfServed(envelope: unknown): SafeEnvelopeRef {
  return `env:${createHash("sha256").update(canonical(JSON.parse(JSON.stringify(envelope)))).digest("hex")}`;
}

export function safeEnvelopeRefFor(record: LayoverFeasibilityRecord): SafeEnvelopeRef {
  const p = publishedEnvelopeOf(record);
  return p.envelope ? safeEnvelopeRefOfServed(p.envelope) : `env:withheld:${p.withheld}`;
}

/** The column to add to a certified-computation insert: `{}` unless the flag is ON (fail closed). */
export async function snapshotEnvelopeRefColumn(db: SupabaseClient, record: LayoverFeasibilityRecord): Promise<{ safe_envelope_ref?: SafeEnvelopeRef }> {
  return (await isFlagEnabled(db, SNAPSHOT_ENVELOPE_REF_FLAG)) ? { safe_envelope_ref: safeEnvelopeRefFor(record) } : {};
}
