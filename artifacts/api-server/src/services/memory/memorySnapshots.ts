/**
 * memorySnapshots — the server's doors onto a Memory's fact history (§3
 * `memory_snapshots`, migration 3811). Census-highlights-memories H35, B58
 * cluster MEM-SNAPSHOTS.
 *
 * SPEC: docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt
 *       :172-173 "memory_snapshots — Versioned fact/evidence snapshots for
 *       replay"; §25 (:641-642) "Memory behavior must be replayable from
 *       structured evidence, commands, and engine versions."
 *
 * WHO WRITES THE HISTORY: NOT THIS FILE. 3811's AFTER INSERT OR UPDATE trigger
 * on public.memories (memory_snapshot_record) writes one version per change of
 * FACTS, on every writer — the API's direct writes, 2711's kernel, 3676's merge
 * and split. The API's role holds SELECT and DELETE on the table and nothing
 * else, so the server can read and purge a history but never forge or rewrite a
 * version. This file is the three things the server does with it:
 *
 *   readMemoryHistory              GET /memories/:id/history (routes/memoryHistory.ts),
 *                                  owner only
 *   readSnapshotRows               the raw rows, for the §25 replay
 *                                  (services/memoryCertification/snapshotReplay.ts)
 *   eraseSnapshotsForDeletedMemory §21's RAW_EVIDENCE_PURGED step
 *                                  (services/memory/memoryDeletionLifecycle.ts)
 *
 * WHAT A FACT IS (open owner question Q-H35; fail-closed default implemented):
 * the whitelist below and nothing else — no title, no caption, no coordinate,
 * no city or country text, no person. 3811 holds the same list in a CHECK, so a
 * key outside it cannot be STORED; this file additionally never SERVES one
 * (`whitelistFacts`), so the API's answer is bounded by this list even on a
 * database whose CHECK was dropped. src/test/memorySnapshots.test.ts pins the
 * SQL list and this one equal.
 *
 * ABSENT IS NOT EMPTY. 3811 unapplied (42P01 / PGRST205, lib/tableAbsence) is
 * `not_deployed` — "this database keeps no history" — never an empty history.
 * Any other failure is `unreadable`, and the caller answers 503.
 */

import { isTableAbsentError } from "../../lib/tableAbsence.js";

/** 3811's table. */
export const MEMORY_SNAPSHOTS_TABLE = "memory_snapshots";

/** The extractor 3811's trigger stamps into engine_versions.snapshot. Must equal the SQL literal. */
export const MEMORY_SNAPSHOT_EXTRACTOR_VERSION = "memory-snapshot@1";

/** Versions kept per Memory: the trigger prunes the oldest beyond this (Q-H35). */
export const MEMORY_SNAPSHOT_CAP = 50;

/** Memory columns that are facts, present on every database (the 2026-08-19 baseline). */
export const MEMORY_SNAPSHOT_BASE_COLUMNS = ["state", "visibility", "place_id", "canonical_location_id", "starts_at", "ends_at"] as const;
/** Memory columns that are facts where their migration is applied (2338, 3804, 3674, 3803). Absent column, absent key. */
export const MEMORY_SNAPSHOT_LATER_COLUMNS = ["location_precision", "place_display_name_at_occurrence", "source_mode", "memory_type"] as const;
/** Every key a snapshot's facts may carry: the columns above plus the item count. Nothing else. */
export const MEMORY_SNAPSHOT_FACT_KEYS: readonly string[] = Object.freeze([
  ...MEMORY_SNAPSHOT_BASE_COLUMNS,
  ...MEMORY_SNAPSHOT_LATER_COLUMNS,
  "item_count",
]);
/** The time-window columns, stored as UTC ISO text at millisecond precision. */
const TIME_COLUMNS: ReadonlySet<string> = new Set(["starts_at", "ends_at"]);
/** What `cause` may say, and nothing else. */
export const MEMORY_SNAPSHOT_CAUSE_KEYS = ["command_id", "correction_id"] as const;

export type SnapshotFactValue = string | number | null;
export type SnapshotFacts = Readonly<Record<string, SnapshotFactValue>>;

/** A time as 3811 stores it: `YYYY-MM-DDTHH:MM:SS.mmmZ`, or null. */
export function snapshotTimeOf(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * The facts of one Memory row, exactly as 3811's trigger extracts them: the
 * baseline fact columns always, a later fact column only when the row carries
 * it, the item count. Used by the §25 harness to build its in-memory world and
 * to compare a history's newest version with the Memory as it is;
 * src/test/db/memorySnapshots.db.test.ts holds it equal to the SQL on the full
 * chain. PURE.
 */
export function snapshotFactsOf(row: Readonly<Record<string, unknown>>, itemCount: number): SnapshotFacts {
  const facts: Record<string, SnapshotFactValue> = {};
  const value = (k: string): SnapshotFactValue => {
    const v = row[k];
    if (TIME_COLUMNS.has(k)) return snapshotTimeOf(v);
    return v === null || v === undefined ? null : String(v);
  };
  for (const k of MEMORY_SNAPSHOT_BASE_COLUMNS) facts[k] = value(k);
  for (const k of MEMORY_SNAPSHOT_LATER_COLUMNS) if (Object.prototype.hasOwnProperty.call(row, k)) facts[k] = value(k);
  facts["item_count"] = itemCount;
  return facts;
}

/** Only the whitelisted keys, and what else was there (never served, reported by the replay). */
export function whitelistFacts(raw: unknown): { facts: SnapshotFacts; dropped: string[] } {
  const facts: Record<string, SnapshotFactValue> = {};
  const dropped: string[] = [];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { facts, dropped: ["<not an object>"] };
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!MEMORY_SNAPSHOT_FACT_KEYS.includes(k)) { dropped.push(k); continue; }
    if (v === null || typeof v === "string" || typeof v === "number") facts[k] = v;
    else dropped.push(k);
  }
  return { facts, dropped: dropped.sort() };
}

/** Key-order-insensitive equality of two fact sets. */
export function factsEqual(a: SnapshotFacts, b: SnapshotFacts): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((k) => a[k] === b[k]);
}

/** The fact keys whose value differs (or which one side lacks), sorted. */
export function changedFactKeys(prev: SnapshotFacts | null, next: SnapshotFacts): string[] {
  if (prev === null) return Object.keys(next).sort();
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  return [...keys].filter((k) => !(k in prev) || !(k in next) || prev[k] !== next[k]).sort();
}

/** One stored version, as read. `facts` is the stored object, unfiltered. */
export interface SnapshotRow {
  readonly memory_id: string;
  readonly owner_id: string;
  readonly version: number;
  readonly facts: unknown;
  readonly engine_versions: unknown;
  readonly cause: unknown;
  readonly created_at: string;
}

const SNAPSHOT_SELECT = "memory_id, owner_id, version, facts, engine_versions, cause, created_at";

export type SnapshotRowsRead =
  | { state: "ok"; rows: SnapshotRow[] }
  | { state: "absent"; detail: string }
  | { state: "unreadable"; detail: string };

/**
 * One Memory's stored versions, oldest first. Bounded by 3811's cap (the
 * trigger prunes, the guard refuses any other delete), so no page is needed.
 * Never throws.
 */
export async function readSnapshotRows(sc: any, memoryId: string, ownerId?: string): Promise<SnapshotRowsRead> {
  try {
    let q = sc.from("memory_snapshots").select(SNAPSHOT_SELECT).eq("memory_id", memoryId);
    if (ownerId !== undefined) q = q.eq("owner_id", ownerId);
    const { data, error } = await q;
    if (error) {
      if (isTableAbsentError(error)) return { state: "absent", detail: `memory_snapshots: ${String(error.message ?? "absent")}` };
      return { state: "unreadable", detail: `memory_snapshots read: ${String(error.message ?? "read failed")}` };
    }
    if (!Array.isArray(data)) return { state: "unreadable", detail: "memory_snapshots read returned no row array" };
    const rows = (data as SnapshotRow[]).filter((r) => Number.isInteger(Number(r.version)));
    if (rows.length !== data.length) return { state: "unreadable", detail: "memory_snapshots read returned a row without an integer version" };
    return { state: "ok", rows: [...rows].sort((a, b) => Number(a.version) - Number(b.version)) };
  } catch (err) {
    return { state: "unreadable", detail: `memory_snapshots read threw: ${String((err as { message?: unknown })?.message ?? err)}` };
  }
}

/** One version as GET /memories/:id/history serves it. */
export interface HistoryVersion {
  version: number;
  recordedAt: string;
  /** The whitelisted facts as stored (snake_case keys, 3811's). */
  facts: SnapshotFacts;
  /** The fact keys that differ from the version before it; every key for the first version kept. */
  changed: string[];
  engineVersions: { snapshot: string | null };
  cause: { commandId?: string; correctionId?: string };
}

export type MemoryHistory =
  | { state: "recorded"; versions: HistoryVersion[]; prunedBefore: number | null }
  | { state: "none_recorded"; versions: []; prunedBefore: null }
  | { state: "not_deployed"; versions: []; prunedBefore: null; detail: string }
  | { state: "unreadable"; detail: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function causeOf(raw: unknown): { commandId?: string; correctionId?: string } {
  const c = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    ...(typeof c["command_id"] === "string" && UUID_RE.test(c["command_id"]) ? { commandId: c["command_id"] } : {}),
    ...(typeof c["correction_id"] === "string" && UUID_RE.test(c["correction_id"]) ? { correctionId: c["correction_id"] } : {}),
  };
}

/**
 * The owner's history of one Memory. The CALLER has already established that
 * `ownerId` owns a live Memory `memoryId` (the route does, and answers anyone
 * else exactly as a missing Memory). Rows are read for that owner only. A fact
 * outside the whitelist is never served. Never throws.
 *
 *   recorded       one or more versions, oldest first; `prunedBefore` is the
 *                  first version kept when the cap pruned older ones
 *   none_recorded  3811 is applied and this Memory has not been written since
 *                  (no backfill: Q-H35)
 *   not_deployed   3811 is not applied on this database
 *   unreadable     anything else — the caller answers 503
 */
export async function readMemoryHistory(sc: any, memoryId: string, ownerId: string): Promise<MemoryHistory> {
  const read = await readSnapshotRows(sc, memoryId, ownerId);
  if (read.state === "absent") return { state: "not_deployed", versions: [], prunedBefore: null, detail: read.detail };
  if (read.state === "unreadable") return { state: "unreadable", detail: read.detail };
  if (read.rows.length === 0) return { state: "none_recorded", versions: [], prunedBefore: null };
  const versions: HistoryVersion[] = [];
  let prev: SnapshotFacts | null = null;
  for (const r of read.rows) {
    const { facts } = whitelistFacts(r.facts);
    const ev = r.engine_versions !== null && typeof r.engine_versions === "object" ? (r.engine_versions as Record<string, unknown>) : {};
    versions.push({
      version: Number(r.version),
      recordedAt: String(r.created_at),
      facts,
      changed: changedFactKeys(prev, facts),
      engineVersions: { snapshot: typeof ev["snapshot"] === "string" ? ev["snapshot"] : null },
      cause: causeOf(r.cause),
    });
    prev = facts;
  }
  const first = versions[0]!.version;
  return { state: "recorded", versions, prunedBefore: first > 1 ? first : null };
}

export type SnapshotsErasure =
  | { state: "done"; purged: number }
  | { state: "absent"; detail: string }
  | { state: "failed"; detail: string };

/**
 * §21: a deleted Memory's fact history goes in RAW_EVIDENCE_PURGED, with its
 * evidence and its place corrections. 3811's guard permits this DELETE only
 * after the soft delete (state = 'deleted'), so a purge that runs on a live
 * Memory fails rather than erasing it. CONFIRMED by a read that finds none left:
 * a delete that answered without error but left a version is a failure. Absent
 * table (3811 not applied) ⇒ `absent`: no version can exist. Never throws.
 */
export async function eraseSnapshotsForDeletedMemory(sc: any, input: { memoryId: string }): Promise<SnapshotsErasure> {
  try {
    const { data, error } = await sc.from("memory_snapshots").delete().eq("memory_id", input.memoryId).select("version");
    if (error) {
      if (isTableAbsentError(error)) return { state: "absent", detail: `memory_snapshots: ${String(error.message ?? "absent")}` };
      return { state: "failed", detail: `memory_snapshots purge: ${String(error.message ?? "delete failed")}` };
    }
    if (!Array.isArray(data)) return { state: "failed", detail: "memory_snapshots purge returned no row array" };
    const left = await sc.from("memory_snapshots").select("version").eq("memory_id", input.memoryId).limit(1);
    if (left.error) return { state: "failed", detail: `memory_snapshots purge unconfirmed: ${String(left.error.message ?? "read failed")}` };
    if (!Array.isArray(left.data) || left.data.length > 0) {
      return { state: "failed", detail: "memory_snapshots purge unconfirmed: a version of the deleted Memory is still readable" };
    }
    return { state: "done", purged: data.length };
  } catch (err) {
    return { state: "failed", detail: `memory_snapshots purge threw: ${String((err as { message?: unknown })?.message ?? err)}` };
  }
}
