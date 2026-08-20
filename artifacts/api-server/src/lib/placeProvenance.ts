/**
 * Place-supply provenance stamping — Phase 0 roadmap item 12.
 *
 * 2101 added a `source_id uuid REFERENCES sources(id)` FK to the three place
 * carrier tables and a resolver (resolveSourceId) that maps a provider/source
 * string to exactly one registry row, never guessing; it also backfilled the
 * rows that already existed. This wires the SAME resolution onto the WRITE
 * paths, so new rows carry provenance at insert time instead of waiting for the
 * next backfill.
 *
 * It is dormant until deliberately switched on. `provenanceStamp` returns {} —
 * a no-op spread — unless BOTH:
 *   (1) the CAPABILITY flag `place_provenance_stamping_enabled` is on, and
 *   (2) the provider/source string resolves to a known registry row.
 * Off by default (an absent flag reads false), which is also the only safe
 * state on any database where 2101's source_id column does not yet exist:
 * stamping a column that is not there would fail the write. Flip the flag only
 * after 2101 has been applied to the target.
 */
import { isFlagEnabled } from "./featureFlags.js";
import { resolveSourceId } from "./sourceRegistry.js";

/**
 * CAPABILITY flag — auto-classified by the `_enabled` suffix (check:flag-polarity)
 * and read through isFlagEnabled, so an absent or unreadable row is OFF.
 */
export const PLACE_PROVENANCE_STAMPING_FLAG = "place_provenance_stamping_enabled";

/**
 * The `{ source_id }` to merge into a place-supply write, or {} to stamp
 * nothing. Fail-closed on both the flag and an unknown string, so callers may
 * spread it unconditionally and it is a byte-for-byte no-op until the flag is
 * on AND the string resolves:
 *
 *   .upsert({ ...row, ...(await provenanceStamp(sc, row.provider)) })
 */
export async function provenanceStamp(
  sc: any,
  providerString: string | null | undefined,
): Promise<{ source_id: string } | Record<string, never>> {
  if (!(await isFlagEnabled(sc, PLACE_PROVENANCE_STAMPING_FLAG))) return {};
  const sourceId = await resolveSourceId(sc, providerString);
  return sourceId ? { source_id: sourceId } : {};
}
