/**
 * memoryConvergenceStore — where a photo from the owner's other device is
 * recognised as belonging to a Memory they ALREADY have (census-highlights-
 * memories H180, spec §19 "Cross-device uploads/notes converge on one
 * Memory/Episode … where evidence supports it"; migration 3806).
 *
 * THE DEFECT (measured on origin/main 665a5d102, services/memory/episodeCandidates.ts):
 *   (a) captures that join a detected episode the owner already KEPT were
 *       appended to it as evidence and never reached its Memory — nothing showed
 *       them to the owner, and a retried Keep attached them unseen;
 *   (b) captures inside the time of a Memory the owner MADE BY HAND became a
 *       brand-new candidate: the overlap test only knew episodes, so the same
 *       evening was proposed twice.
 *
 * THIS MODULE IS THE DETECTION HALF. It never attaches anything. It writes a
 * PROPOSAL row (memory_convergence_proposals, 3806) that the owner keeps or
 * dismisses in the inbox (services/memory/memoryConvergence.ts). It imports
 * nothing from episodeCandidates.ts, which calls it.
 *
 * WHERE EVIDENCE SUPPORTS IT — the two bases, and nothing wider:
 *   confirmed_episode  the capture grouped (§7 deterministic grouping) with an
 *                      episode the owner kept, whose Memory is linked to it;
 *   memory_window      the capture was TAKEN inside the window of a published
 *                      Memory of this owner on the SAME trip. The window is the
 *                      Memory's own starts_at..ends_at when both are set, else
 *                      the capture span of its own photos. A window longer than
 *                      MAX_CONVERGENCE_WINDOW_MS is not evidence of one moment
 *                      ("Lisbon, the whole week") and converges nothing.
 *   A capture inside two Memories' windows is proposed to both: the owner
 *   decides, the system never picks.
 *
 * STORAGE STATES (every entry point): 3806 absent ⇒ `not_deployed` — the
 * detector behaves byte-for-byte as before this module; unreadable ⇒
 * `unavailable` — the caller refuses (503) rather than proposing a duplicate
 * candidate it cannot rule out.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { isTableAbsentError } from "../../lib/tableAbsence.js";

export const CONVERGENCE_TABLE = "memory_convergence_proposals";
/** The columns this code reads and writes (3806). A literal: check:write-path-columns resolves same-file string consts. */
export const CONVERGENCE_SELECT = "owner_id, memory_id, media_asset_id, basis, state, proposed_at, decided_at";
export type ConvergenceBasis = "confirmed_episode" | "memory_window";
export type ConvergenceState = "proposed" | "kept" | "dismissed";

/** One moment, not a holiday: a Memory window longer than this proposes nothing. Open question Q-H180-2. */
export const MAX_CONVERGENCE_WINDOW_MS = 24 * 3_600_000;
/** How many of the trip's Memories are read for windows. A bound, not a contract. */
export const MAX_TRIP_MEMORIES = 200;
/** `.in()` lists are chunked so a request URL stays bounded. */
export const IN_CHUNK = 100;

export type ConvergenceStoreState = { state: "ready" } | { state: "not_deployed"; detail: string } | { state: "unavailable"; detail: string };

/** A missing COLUMN of a table that exists is a store of the wrong shape: as good as absent for this code, never "ready". */
function columnAbsent(error: unknown): boolean {
  const code = String((error as { code?: unknown })?.code ?? "");
  return code === "42703" || code === "PGRST204";
}

/** 3806 probed for every column this code names. Absent ⇒ not_deployed; any other failure ⇒ unavailable. */
export async function convergenceStoreState(sc: SupabaseClient | any): Promise<ConvergenceStoreState> {
  try {
    const { error } = await sc
      .from("memory_convergence_proposals")
      .select(CONVERGENCE_SELECT)
      .eq("owner_id", "00000000-0000-0000-0000-000000000000")
      .limit(1);
    if (!error) return { state: "ready" };
    if (isTableAbsentError(error) || columnAbsent(error)) return { state: "not_deployed", detail: `${CONVERGENCE_TABLE}: ${String(error.message ?? "")}` };
    return { state: "unavailable", detail: `${CONVERGENCE_TABLE} probe: ${String(error.message ?? "")}` };
  } catch (err) {
    return { state: "unavailable", detail: `${CONVERGENCE_TABLE} probe threw: ${String((err as { message?: unknown })?.message ?? err)}` };
  }
}

/* ============================================================================
 * The window a Memory occupies — pure
 * ==========================================================================*/

export interface MemoryWindowInput {
  startsAt: string | null;
  endsAt: string | null;
  /** Capture times of the Memory's OWN photos (the owner's media_assets behind its items). */
  itemCaptureTimes: readonly string[];
}

/**
 * The instants [from, to] a Memory covers, or null when its record says no
 * bounded moment. The owner's stated window when both ends are set; otherwise
 * the span of its photos' capture times. A start with no end and no photo is
 * a point in time with no extent — nothing can be "inside" it but itself, and
 * a capture at exactly that instant is not evidence enough to propose. Wider
 * than MAX_CONVERGENCE_WINDOW_MS ⇒ null.
 */
export function memoryWindow(m: MemoryWindowInput): { from: number; to: number } | null {
  const s = m.startsAt ? Date.parse(m.startsAt) : NaN;
  const e = m.endsAt ? Date.parse(m.endsAt) : NaN;
  let from: number;
  let to: number;
  if (Number.isFinite(s) && Number.isFinite(e)) {
    from = Math.min(s, e);
    to = Math.max(s, e);
  } else {
    const ts = m.itemCaptureTimes.map((t) => Date.parse(t)).filter((n) => Number.isFinite(n));
    if (ts.length < 2) return null;
    from = Math.min(...ts);
    to = Math.max(...ts);
  }
  if (to - from > MAX_CONVERGENCE_WINDOW_MS) return null;
  return { from, to };
}

/** Every window the instant falls inside (inclusive at both ends). */
export function windowsContaining<W extends { from: number; to: number }>(capturedAt: string | null, windows: readonly W[]): W[] {
  const t = capturedAt ? Date.parse(capturedAt) : NaN;
  if (!Number.isFinite(t)) return [];
  return windows.filter((w) => w.from <= t && t <= w.to);
}

function chunks<T>(xs: readonly T[], n = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/* ============================================================================
 * Detection: the owner's Memories on this trip
 * ==========================================================================*/

export interface TripMemoryWindow { memoryId: string; from: number; to: number }

/**
 * The windows of the owner's PUBLISHED Memories on this trip. Owner-scoped on
 * every read: another person's Memory is never a window, so it can never be
 * proposed to (the 3806 guard trigger refuses it as well).
 */
export async function readTripMemoryWindows(
  sc: SupabaseClient | any,
  input: { ownerId: string; tripId: string },
): Promise<{ ok: true; windows: TripMemoryWindow[] } | { ok: false; detail: string }> {
  const { data: mems, error: memErr } = await sc
    .from("memories")
    .select("id, owner_id, state, trip_id, starts_at, ends_at")
    .eq("owner_id", input.ownerId)
    .eq("trip_id", input.tripId)
    .eq("state", "published")
    .limit(MAX_TRIP_MEMORIES);
  if (memErr) return { ok: false, detail: `memories: ${memErr.message}` };
  const rows = ((mems as Array<{ id: string; owner_id: string; starts_at: string | null; ends_at: string | null }> | null) ?? [])
    .filter((r) => r.owner_id === input.ownerId);
  if (rows.length === 0) return { ok: true, windows: [] };

  const urlsByMemory = new Map<string, string[]>();
  for (const ids of chunks(rows.map((r) => r.id))) {
    const { data: items, error: itemErr } = await sc.from("memory_items").select("memory_id, media_url").in("memory_id", ids);
    if (itemErr) return { ok: false, detail: `memory_items: ${itemErr.message}` };
    for (const it of ((items as Array<{ memory_id: string; media_url: string }> | null) ?? [])) {
      const list = urlsByMemory.get(it.memory_id) ?? [];
      list.push(it.media_url);
      urlsByMemory.set(it.memory_id, list);
    }
  }
  const allUrls = [...new Set([...urlsByMemory.values()].flat())];
  const capturedByUrl = new Map<string, string>();
  for (const urls of chunks(allUrls)) {
    const { data: media, error: mediaErr } = await sc
      .from("media_assets")
      .select("owner_user_id, public_url, captured_at")
      .eq("owner_user_id", input.ownerId)
      .in("public_url", urls);
    if (mediaErr) return { ok: false, detail: `media_assets: ${mediaErr.message}` };
    for (const m of ((media as Array<{ owner_user_id: string; public_url: string | null; captured_at: string | null }> | null) ?? [])) {
      if (m.owner_user_id === input.ownerId && m.public_url && m.captured_at) capturedByUrl.set(m.public_url, m.captured_at);
    }
  }
  const windows: TripMemoryWindow[] = [];
  for (const r of rows) {
    const itemCaptureTimes = (urlsByMemory.get(r.id) ?? []).map((u) => capturedByUrl.get(u)).filter((t): t is string => Boolean(t));
    const w = memoryWindow({ startsAt: r.starts_at, endsAt: r.ends_at, itemCaptureTimes });
    if (w) windows.push({ memoryId: r.id, ...w });
  }
  return { ok: true, windows };
}

export interface ConvergenceDetectReport {
  /** `not_deployed`: 3806 is absent and nothing below was looked for. */
  state: "ready" | "not_deployed";
  /** Captures that belong to a Memory the owner already has — not made into candidates. */
  capturesMatched: number;
  /** Proposal rows this run added (a re-run adds none; a dismissal is never re-added). */
  proposalsAdded: number;
  /** Distinct Memories those captures were proposed to. */
  memories: number;
}

export const EMPTY_CONVERGENCE_REPORT: ConvergenceDetectReport = Object.freeze({ state: "not_deployed", capturesMatched: 0, proposalsAdded: 0, memories: 0 }) as ConvergenceDetectReport;

/**
 * Write proposals — ON CONFLICT DO NOTHING on (owner, Memory, photo), so a row
 * the owner already decided (kept or DISMISSED) is never reopened, and a re-run
 * adds nothing. Returns how many rows were new.
 */
export async function writeProposals(
  sc: SupabaseClient | any,
  ownerId: string,
  rows: ReadonlyArray<{ memoryId: string; assetId: string; basis: ConvergenceBasis }>,
): Promise<{ ok: true; added: number } | { ok: false; detail: string }> {
  if (rows.length === 0) return { ok: true, added: 0 };
  const seen = new Set<string>();
  const payload = [];
  for (const r of rows) {
    const k = `${r.memoryId}:${r.assetId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    payload.push({ owner_id: ownerId, memory_id: r.memoryId, media_asset_id: r.assetId, basis: r.basis, state: "proposed" });
  }
  const { data, error } = await sc
    .from("memory_convergence_proposals")
    .upsert(payload, { onConflict: "owner_id,memory_id,media_asset_id", ignoreDuplicates: true })
    .select("memory_id, media_asset_id");
  if (error) return { ok: false, detail: `${CONVERGENCE_TABLE} write: ${error.message}` };
  return { ok: true, added: Array.isArray(data) ? data.length : 0 };
}

/**
 * Basis `memory_window`: split this run's captures into those that belong to a
 * Memory the owner already has on this trip (proposed to it, and NOT made into
 * a candidate) and the rest, which go on to §7 grouping exactly as before.
 * A capture the owner already DISMISSED for that Memory stays out of both: it
 * is neither re-proposed nor resurfaced as a fresh candidate.
 */
export async function convergeOntoTripMemories<T extends { id: string; captured_at: string | null }>(
  sc: SupabaseClient | any,
  input: { ownerId: string; tripId: string; captures: readonly T[] },
): Promise<
  | { ok: true; ready: boolean; rest: T[]; report: ConvergenceDetectReport }
  | { ok: false; reason: "unavailable" | "write_failed"; detail: string }
> {
  const store = await convergenceStoreState(sc);
  if (store.state === "unavailable") return { ok: false, reason: "unavailable", detail: store.detail };
  if (store.state === "not_deployed") return { ok: true, ready: false, rest: [...input.captures], report: EMPTY_CONVERGENCE_REPORT };
  const report: ConvergenceDetectReport = { state: "ready", capturesMatched: 0, proposalsAdded: 0, memories: 0 };
  if (input.captures.length === 0) return { ok: true, ready: true, rest: [], report };

  const read = await readTripMemoryWindows(sc, { ownerId: input.ownerId, tripId: input.tripId });
  if (!read.ok) return { ok: false, reason: "unavailable", detail: read.detail };

  const rest: T[] = [];
  const rows: Array<{ memoryId: string; assetId: string; basis: ConvergenceBasis }> = [];
  for (const c of input.captures) {
    const hits = windowsContaining(c.captured_at, read.windows);
    if (hits.length === 0) { rest.push(c); continue; }
    report.capturesMatched += 1;
    for (const w of hits) rows.push({ memoryId: w.memoryId, assetId: c.id, basis: "memory_window" });
  }
  const written = await writeProposals(sc, input.ownerId, rows);
  if (!written.ok) return { ok: false, reason: "write_failed", detail: written.detail };
  report.proposalsAdded = written.added;
  report.memories = new Set(rows.map((r) => r.memoryId)).size;
  return { ok: true, ready: true, rest, report };
}

/**
 * Basis `confirmed_episode`: late captures the detector appended to an episode
 * the owner kept become proposals for the Memory that episode is linked to —
 * only when that Memory is still this owner's and published.
 */
export async function proposeOntoKeptMemory(
  sc: SupabaseClient | any,
  input: { ownerId: string; memoryId: string; assetIds: readonly string[] },
): Promise<{ ok: true; proposed: number } | { ok: false; reason: "unavailable" | "write_failed"; detail: string }> {
  if (input.assetIds.length === 0) return { ok: true, proposed: 0 };
  const { data, error } = await sc
    .from("memories")
    .select("id, owner_id, state")
    .eq("id", input.memoryId)
    .eq("owner_id", input.ownerId)
    .maybeSingle();
  if (error) return { ok: false, reason: "unavailable", detail: `memories: ${error.message}` };
  const row = data as { owner_id: string; state: string } | null;
  if (!row || row.owner_id !== input.ownerId || row.state !== "published") return { ok: true, proposed: 0 };
  const written = await writeProposals(sc, input.ownerId, input.assetIds.map((assetId) => ({ memoryId: input.memoryId, assetId, basis: "confirmed_episode" as const })));
  if (!written.ok) return { ok: false, reason: "write_failed", detail: written.detail };
  return { ok: true, proposed: written.added };
}

/* ============================================================================
 * §21 — a deleted Memory takes its proposals and dismissals with it
 * ==========================================================================*/

export type ConvergenceErasure = { state: "done"; purged: number } | { state: "absent"; detail: string } | { state: "failed"; detail: string };

/**
 * RAW_EVIDENCE_PURGED for one Memory (services/memory/memoryDeletionLifecycle.ts):
 * every proposal and every decision about it — they name the owner's photos and
 * the Memory, and a deleted Memory has nothing left to converge on. Owner-scoped.
 * A delete that returns no row array is not confirmed, so it is not `done`.
 */
export async function eraseConvergenceForMemory(sc: SupabaseClient | any, input: { ownerId: string; memoryId: string }): Promise<ConvergenceErasure> {
  try {
    const { data, error } = await sc
      .from("memory_convergence_proposals")
      .delete()
      .eq("owner_id", input.ownerId)
      .eq("memory_id", input.memoryId)
      .select("memory_id");
    if (error) {
      if (isTableAbsentError(error)) return { state: "absent", detail: `${CONVERGENCE_TABLE}: ${String(error.message ?? "")}` };
      return { state: "failed", detail: `${CONVERGENCE_TABLE} purge: ${String(error.message ?? "")}` };
    }
    if (!Array.isArray(data)) return { state: "failed", detail: `${CONVERGENCE_TABLE} purge unconfirmed: no row array returned` };
    return { state: "done", purged: data.length };
  } catch (err) {
    return { state: "failed", detail: `${CONVERGENCE_TABLE} purge threw: ${String((err as { message?: unknown })?.message ?? err)}` };
  }
}
