/**
 * locationSharePurpose — binds a location share ROW to the purpose it was
 * granted for, and makes every reader say which purpose it serves.
 *
 * Census-telegraph T149 / T214 / T215 / T356 / T420 (RECON-W cluster A1),
 * migration 3753.
 *
 * ── THE DEFECT ────────────────────────────────────────────────────────────────
 * `lib/locationPurposes.ts` is a real, ratcheted registry of twelve
 * location-processing purposes, and `trip_crew_location_sessions` is the share
 * store (audience `allowed_member_ids`, precision `visibility_level`, expiry
 * `expires_at`). The two were joined by nothing: no share row carried a purpose,
 * so a grant made for one purpose could be read by a surface serving another.
 * The table had one writer and every reader happened to serve the same purpose,
 * which is luck, not a control — the next reader (Nearby was the example the
 * census gave) would have inherited every crew grant.
 *
 * ── THE RULE ──────────────────────────────────────────────────────────────────
 *   1. Migration 3753 adds `purpose text NULL` with a CHECK equal to the
 *      registry's ids (asserted by locationSharePurpose.test.ts) and makes it
 *      immutable once a row exists (trigger). It writes NO row: no backfill.
 *   2. The writer stamps the purpose it grants for (`CREW_LIVE_SHARE_PURPOSE`),
 *      which must be a registry purpose that declares this table.
 *   3. Every reader is listed in `LOCATION_SHARE_ACCESS` with the ONE purpose it
 *      serves, and passes its rows through `admitSharesForPurpose`, which keeps
 *      a row only when its purpose IS the reader's purpose.
 *   4. A row with NO purpose (every row written before 3753, and every row on a
 *      database 3753 has not reached) is admitted ONLY by readers serving
 *      `LEGACY_SHARE_CREATOR_PURPOSE` — the purpose of the one writer that ever
 *      created rows here (TripCrewLiveShareService.startLiveShare, "share your
 *      live position with your trip crew"). Every other reader refuses it. That
 *      is the fail-closed default for undecided legacy data (owner decision
 *      LSP-1): the data is neither deleted nor re-purposed, and it stays visible
 *      exactly where it was granted.
 *   5. An unknown purpose string is refused by every reader (and by the CHECK).
 *   6. Housekeeping paths that only END shares (stop, expire, revoke a removed
 *      member, close out a trip) are listed with the reason they span every
 *      purpose: ending more than asked is the safe direction; ending less is a
 *      grant that outlives its withdrawal.
 *
 * A static test (locationSharePurpose.test.ts) scans `src/` for every file that
 * names the table in `.from(...)` and fails when one is not in
 * `LOCATION_SHARE_ACCESS` — a new reader cannot ship without declaring a purpose.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { LOCATION_PURPOSES } from "./locationPurposes.js";
import { isMissingColumnError } from "./capability/schemaCapability.js";

/** The share store this module binds. */
export const LOCATION_SHARE_TABLE = "trip_crew_location_sessions" as const;

/**
 * Every purpose id the registry publishes — the list migration 3753's CHECK
 * enumerates. A test asserts the SQL list and this one are the same set, so the
 * registry growing without a migration is a red test, not a silent gap.
 */
export const SHARE_PURPOSE_CHECK_IDS: readonly string[] = LOCATION_PURPOSES.map((p) => p.id);

/** Registry purposes whose declared `tables` include the share store. */
export function purposesDeclaringShareTable(): string[] {
  return LOCATION_PURPOSES.filter((p) => p.tables.includes(LOCATION_SHARE_TABLE)).map((p) => p.id);
}

/** The purpose a trip-crew live share is granted for (the one writer's purpose). */
export const CREW_LIVE_SHARE_PURPOSE = "live_session_sharing" as const;

/**
 * OWNER DECISION LSP-1 (open; fail-closed default implemented): rows written
 * before 3753 carry no purpose. They were all created by the crew live-share
 * writer, so they stay visible to readers serving THAT purpose and to no other.
 * They are not backfilled — stamping them would be re-purposing data by
 * inference, which is the owner's call, not this file's.
 */
export const LEGACY_SHARE_CREATOR_PURPOSE = CREW_LIVE_SHARE_PURPOSE;

export type ShareAccessKind = "writer" | "reader" | "housekeeping" | "binding";

export interface ShareAccessEntry {
  /** Path relative to `src/`. */
  readonly file: string;
  readonly kind: ShareAccessKind;
  /** The one purpose a writer stamps or a reader serves; null for housekeeping. */
  readonly purpose: string | null;
  readonly note: string;
}

/**
 * Every source file that touches the share store, and what for. Several files
 * appear once per role. The static test keys on `file`.
 */
export const LOCATION_SHARE_ACCESS: readonly ShareAccessEntry[] = Object.freeze([
  {
    file: "lib/locationSharePurpose.ts",
    kind: "binding",
    purpose: null,
    note: "admitSharesForPurpose reads (id, purpose) for rows a declared reader already holds; it decides nothing about audience.",
  },
  {
    file: "domain/trips/services/TripCrewLiveShareService.ts",
    kind: "writer",
    purpose: CREW_LIVE_SHARE_PURPOSE,
    note: "startLiveShare stamps the purpose on insert. getActiveLiveShares is a reader of the same purpose. stopLiveShare, the stop-before-start update, revokeAccessForMember and sweepExpiredLiveShares only END shares, across every purpose.",
  },
  {
    file: "domain/trips/services/TripCrewLocationService.ts",
    kind: "reader",
    purpose: CREW_LIVE_SHARE_PURPOSE,
    note: "getCrewMap (whose live share decides each card's disclosure) and getViewerOwnPresence (the viewer's own active crew share).",
  },
  {
    file: "domain/telegraph/policies/conversationCapabilityPolicy.ts",
    kind: "reader",
    purpose: CREW_LIVE_SHARE_PURPOSE,
    note: "INPUT 8 reads the viewer's own active crew share's precision to state canShareExactLocation's ceiling.",
  },
  {
    file: "domain/trips/services/TripCloseoutService.ts",
    kind: "housekeeping",
    purpose: null,
    note: "Closeout counts and STOPS every active share on the trip; a share of any purpose must end with the trip.",
  },
  {
    file: "server/trips/projectionWorkers/tripCrewLiveShareScheduler.ts",
    kind: "housekeeping",
    purpose: null,
    note: "Expiry sweep probe: is any active share past expires_at. Expiry applies to every purpose.",
  },
]);

/**
 * Readers that serve a location purpose but must NOT read the share store at
 * all. Nearby (§30A.2 reachable people) runs on standing consent
 * (location_preferences, user_location_state), never on a grant; the static test
 * asserts these files never name the share store, so a crew grant cannot be
 * reused for discovery by a later edit without that test going red.
 */
export const SHARE_STORE_FORBIDDEN_READERS: readonly { file: string; note: string }[] = Object.freeze([
  { file: "services/telegraph/reachablePeopleQuery.ts", note: "Nearby / reachable people: standing consent only, never a share grant." },
  { file: "services/telegraph/reachablePeople.ts", note: "Nearby decisions (pure)." },
]);

const KNOWN = new Set(SHARE_PURPOSE_CHECK_IDS);

/**
 * May a reader serving `readerPurpose` see a share whose stored purpose is
 * `rowPurpose`? PURE.
 *   - a stored purpose admits exactly its own reader;
 *   - no stored purpose (legacy / pre-3753) admits only the legacy creator's
 *     purpose (LSP-1);
 *   - an unknown stored purpose, or an unknown reader purpose, admits nothing.
 */
export function shareAdmittedFor(rowPurpose: unknown, readerPurpose: string): boolean {
  // An unknown reader purpose needs no line of its own: it equals neither a
  // known stored purpose nor LEGACY_SHARE_CREATOR_PURPOSE, so it admits nothing.
  if (rowPurpose === null || rowPurpose === undefined) return readerPurpose === LEGACY_SHARE_CREATOR_PURPOSE;
  if (typeof rowPurpose !== "string" || !KNOWN.has(rowPurpose)) return false;
  return rowPurpose === readerPurpose;
}

export class SharePurposeUnreadableError extends Error {
  readonly code = "SHARE_PURPOSE_UNREADABLE";
  constructor(readonly detail: string) {
    super(`location share purpose could not be read: ${detail}`);
    this.name = "SharePurposeUnreadableError";
  }
}

/**
 * Keep only the rows a reader serving `readerPurpose` may see.
 *
 * Reads `purpose` for the rows' ids in ONE query. When the column does not exist
 * (a database 3753 has not reached) every row is a legacy row and rule 4
 * applies. Any OTHER failure throws `SharePurposeUnreadableError`: a reader that
 * cannot establish a share's purpose must not serve it, and must not serve "no
 * shares" as if that were the truth either — the caller maps the throw to its
 * own retryable unavailable answer.
 *
 * A row the purpose read does not return (deleted between the two reads) is
 * dropped: no purpose was established for it.
 */
export async function admitSharesForPurpose<T extends { id: unknown }>(
  db: SupabaseClient | any,
  rows: readonly T[],
  readerPurpose: string,
): Promise<T[]> {
  if (rows.length === 0) return [];
  if (!KNOWN.has(readerPurpose)) return [];
  const ids = rows.map((r) => String(r.id));
  let res: any;
  try {
    res = await db.from("trip_crew_location_sessions").select("id, purpose").in("id", ids);
  } catch (err) {
    throw new SharePurposeUnreadableError(String((err as any)?.message ?? err));
  }
  if (!res || !("error" in res)) throw new SharePurposeUnreadableError("purpose read resolved without an error field");
  if (res.error) {
    if (isMissingColumnError(res.error) && /purpose/i.test(String(res.error?.message ?? ""))) {
      // Pre-3753: no row has a purpose. Rule 4.
      return readerPurpose === LEGACY_SHARE_CREATOR_PURPOSE ? [...rows] : [];
    }
    throw new SharePurposeUnreadableError(String(res.error?.message ?? res.error?.code ?? "db_error"));
  }
  if (!Array.isArray(res.data)) throw new SharePurposeUnreadableError("purpose read returned no rows array");
  const purposeById = new Map<string, unknown>();
  for (const r of res.data as any[]) purposeById.set(String(r.id), r.purpose ?? null);
  return rows.filter((r) => {
    const id = String(r.id);
    if (!purposeById.has(id)) return false;
    return shareAdmittedFor(purposeById.get(id), readerPurpose);
  });
}

/**
 * Whether an insert error is "this database has no `purpose` column yet". The
 * writer then writes the row it wrote before 3753 — a legacy row, which rule 4
 * keeps visible to the crew live-share readers only — rather than refusing to
 * start a share on every database the migration has not reached.
 */
export function isPurposeColumnAbsent(error: unknown): boolean {
  return isMissingColumnError(error) && /purpose/i.test(String((error as any)?.message ?? ""));
}
