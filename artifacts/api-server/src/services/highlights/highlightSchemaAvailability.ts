/**
 * highlightSchemaAvailability — the difference between "this control says no",
 * "this control could not be read", and "this control is not deployed".
 *
 * Highlights/Memories Development Architecture Spec v1 §28.11:
 *   "Never swallow projection/schema failures into plausible-looking empty
 *    history without structured error state."
 *
 * ── WHY THREE STATES AND NOT TWO ────────────────────────────────────────────
 * THIS PARAGRAPH RECORDED A FACT THAT HAS SINCE CHANGED, and the change is
 * kept visible rather than overwritten because it is the whole reason the
 * three-state design was worth building.
 *
 * WHEN THIS MODULE WAS WRITTEN, neither `highlight_projection_policies` nor
 * `highlight_resurfacing_preferences` existed on production — measured against
 * src/lib/capability/snapshots/20260908-production-schema.json — and migrations
 * 2720 and 2721 were written and applied to no database.
 *
 * AT THIS COMMIT BOTH ARE DEPLOYED. src/lib/capability/production-applied-
 * migrations.json records 2720 and 2721 applied to production on 2026-09-15,
 * and src/lib/capability/snapshots/20260915-production-schema.json holds both
 * tables with every column these modules probe for. Asserted, not narrated, by
 * src/test/highlightsMemoriesDeployedStorage.test.ts.
 *
 * SO `absent` IS NO LONGER THE STATE PRODUCTION IS IN, and the code did not
 * have to change for that to be true: the probe is per-client and memoised for
 * 30 seconds on a negative, so applying the migration was picked up without a
 * restart, exactly as designed. What the three states still buy is the other
 * direction — a deployment that has NOT applied them (a fresh branch database,
 * a self-hosted install) still gets `absent` rather than a dark surface, and a
 * real outage on the now-deployed table still gets `unreadable` and fails
 * closed instead of reading as "nobody set a control".
 *
 * A two-state read (`ok` / `not ok`) forces one of two wrong answers:
 *   - treat "table absent" as an unreadable control and FAIL CLOSED → the entire
 *     Highlights surface goes dark on every deployment that has not applied the
 *     migration, which is all of them;
 *   - treat "table absent" as an empty control set → a genuine outage on a
 *     deployed table becomes "no suppressions, no consent needed", which is the
 *     exact silent fail-open this spec forbids.
 *
 * So: three states.
 *   `ready`      the object exists and answered. Enforce it.
 *   `absent`     the object does not exist in this database. The control is NOT
 *                DEPLOYED. Report it, log it, do not enforce, and do not
 *                pretend an answer was obtained.
 *   `unreadable` the object exists (or we cannot tell it does not) and the read
 *                failed. FAIL CLOSED at every caller.
 *
 * `absent` is decided ONLY by PostgREST's own missing-table / missing-column
 * codes, via the pure classifiers in lib/capability/schemaCapability.ts —
 * PGRST205 / 42P01 for a table, PGRST204 / 42703 for a column. Every other
 * error, including a network failure, a permission denial and a malformed error
 * object, is `unreadable`. A degraded database can produce many things; it
 * cannot produce "42P01" for a table that exists.
 *
 * ── MEMOISATION ─────────────────────────────────────────────────────────────
 * Per client object, in a WeakMap, so a test client is collected with its test
 * and no two tests share a verdict. A `ready` verdict is held for 5 minutes; an
 * `absent` or `unreadable` one for 30 seconds, so applying 2720 is picked up
 * without a restart while a broken database is not re-probed per request. The
 * TTLs and the reasoning are lifted deliberately from
 * lib/capability/schemaCapability.ts rather than reinvented; this module does
 * not use that file's registry because the registry is another lane's surface,
 * but it uses its classifiers so the two cannot disagree about what "absent"
 * means.
 */
import { isMissingColumnError, isMissingTableError } from "../../lib/capability/schemaCapability.js";

export type ObjectAvailability =
  | { readonly state: "ready" }
  | { readonly state: "absent"; readonly reason: string }
  | { readonly state: "unreadable"; readonly reason: string };

export const READY_TTL_MS = 5 * 60 * 1000;
export const ABSENT_TTL_MS = 30 * 1000;

interface Memo {
  readonly at: number;
  readonly value: ObjectAvailability;
}

const memo = new WeakMap<object, Map<string, Memo>>();
const tracked = new Set<object>();

/** Tests only. */
export function resetHighlightSchemaMemo(): void {
  for (const k of tracked) memo.delete(k);
  tracked.clear();
}

function ttlFor(v: ObjectAvailability): number {
  return v.state === "ready" ? READY_TTL_MS : ABSENT_TTL_MS;
}

function reasonOf(err: unknown): string {
  const e = err as { message?: unknown; code?: unknown } | null;
  return String(e?.message ?? e?.code ?? err ?? "unknown error");
}

/**
 * Probe one table for a set of required columns.
 *
 * The probe is a SELECT naming exactly those columns, filtered to a sentinel id
 * the key cannot hold, so it can never return a row and can never be mistaken
 * for a data read. PostgREST answers `error: null` when every column exists.
 *
 * A client whose builder THROWS (a fake without `.eq`, a broken mock) is
 * `unreadable`, not `absent` — a probe that could not run is not evidence that
 * the table is missing.
 */
export async function probeHighlightObject(
  sc: any,
  table: string,
  columns: readonly string[],
  opts: { readonly now?: number } = {},
): Promise<ObjectAvailability> {
  const now = opts.now ?? Date.now();
  const key = `${table}:${columns.join(",")}`;
  const cached = memo.get(sc)?.get(key);
  if (cached && now - cached.at <= ttlFor(cached.value)) return cached.value;

  let result: ObjectAvailability;
  try {
    const { error } = await sc
      .from(table)
      .select(columns.join(", "))
      .eq("id", "00000000-0000-0000-0000-000000000000")
      .limit(1);
    if (!error) {
      result = { state: "ready" };
    } else if (isMissingTableError(error) || isMissingColumnError(error)) {
      result = {
        state: "absent",
        reason: `${table} (or a required column) does not exist in this database: ${reasonOf(error)}`,
      };
    } else {
      result = { state: "unreadable", reason: `${table} probe failed: ${reasonOf(error)}` };
    }
  } catch (err) {
    result = { state: "unreadable", reason: `${table} probe threw: ${reasonOf(err)}` };
  }

  let m = memo.get(sc);
  if (!m) {
    m = new Map();
    memo.set(sc, m);
    tracked.add(sc);
  }
  m.set(key, { at: now, value: result });
  return result;
}
