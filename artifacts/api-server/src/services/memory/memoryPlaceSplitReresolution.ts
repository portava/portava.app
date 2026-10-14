/**
 * memoryPlaceSplitReresolution — §9 "Entity splits trigger re-resolution from
 * retained evidence" (spec:317). Census-highlights-memories H72; B58 cluster
 * MEM-PLACE-SPLIT; migration 3812 (unapplied).
 *
 * ── THE SPLIT ───────────────────────────────────────────────────────────────
 * An admin decides one catalog row P is really two venues. `splitPlace` calls
 * 3812's `place_split`, which (atomically, under a lock on P) creates P2 from
 * the admin's name and position, moves the provider references the admin names,
 * and logs action 'split' (survivor P, affected P2) in place_merge_log. It runs
 * only while BOTH `external_places_enabled` and
 * `memory_place_split_reresolution_enabled` are on — the route checks, and the
 * SQL function checks again.
 *
 * ── THE JOB ─────────────────────────────────────────────────────────────────
 * `runSplitReresolution` reads, for every live Memory whose STORED place_id is
 * P, only the evidence the Memory RETAINED: its occurrence coordinates
 * (location_lat / location_lng) and the place's name as it was when the Memory
 * recorded it (place_display_name_at_occurrence, 3804). `decideProposal` is the
 * rule (owner question Q-H72, the fail-closed default):
 *
 *   suggest a candidate ONLY when exactly one of {P, P2} is within 75 m of the
 *   Memory AND that one's name equals the occurrence name once both are
 *   normalized (lib/canonicalLocations normalizeLocationName, the catalog
 *   resolver's own normalizer; an empty normalization never matches);
 *   otherwise suggested_place_id is NULL — unresolved. §28.3 and H74 forbid
 *   presenting a guess as the place.
 *
 * A Memory with ANY owner place correction (3673) gets no proposal at all (H73:
 * the owner's word beats automatic resolution). An unreadable corrections read
 * gets no proposal either (it is counted, never guessed).
 *
 * WHAT THE JOB NEVER DOES: it never writes `memories` and never writes
 * `memory_corrections`. A proposal is accepted by the OWNER changing the
 * Memory's place through the existing PATCH /memories/:id (one writer, lead
 * ruling H-10), which records the change as the owner's correction; the
 * proposal only records that decision (`acceptProposal`, which 3812's guard
 * refuses unless the Memory already stores the chosen place).
 *
 * WHAT A PROPOSAL HOLDS: candidate ids, the suggestion, and `evidence` = the
 * rule version, the bound, the reason and, per candidate, two booleans. No
 * coordinate, distance or name is stored (3812's CHECKs refuse one), and the
 * owner's served form adds only the candidates' public catalog names.
 *
 * Failure postures: flags off ⇒ inert (nothing read past the flags, nothing
 * written); any flag unreadable ⇒ refused; the occurrence-name gate unreadable
 * ⇒ refused (an unknown column is never guessed absent); 3804 absent ⇒ no
 * Memory has an occurrence name, so every proposal is unresolved.
 */
import { readFlagState } from "../../lib/capability/schemaCapability.js";
import type { FlagState } from "../../lib/capability/schemaRequirement.js";
import { isTableAbsentError } from "../../lib/tableAbsence.js";
import { normalizeLocationName } from "../../lib/canonicalLocations.js";
import { haversineKm } from "../../lib/places/placeResolve.js";
import { readPlaceCorrectionsForMemories } from "./memoryCorrections.js";
import { columnWritable } from "./memoryCanonicalFields.js";

export const MEMORY_PLACE_SPLIT_FLAG = "memory_place_split_reresolution_enabled";
export const EXTERNAL_PLACES_FLAG = "external_places_enabled";
export const OCCURRENCE_NAME_FLAG = "memory_place_occurrence_name_enabled";

/** Q-H72's default bound. The catalog resolver's own same-venue distance (placeResolve MERGE_DISTANCE_KM). */
export const RERESOLUTION_BOUND_M = 75;
export const RERESOLUTION_RULE = "h72-v1";

/** The reasons 3812's evidence CHECK admits, in the order decideProposal tests them. */
export const PROPOSAL_REASONS = [
  "no_coordinates",
  "candidate_without_coordinates",
  "none_within_bound",
  "several_within_bound",
  "no_occurrence_name",
  "name_mismatch",
  "unique_within_bound_name_match",
] as const;
export type ProposalReason = (typeof PROPOSAL_REASONS)[number];

/** States the owner can still act on. A deleted Memory's proposals are purged (3812's trigger); a removed one is not offered. */
export const LIVE_MEMORY_STATES = ["draft", "published", "archived"] as const;

/** Keyset page of Memories per read; the job reads at most MAX_PAGES of them. */
export const RERESOLUTION_PAGE = 500;
export const RERESOLUTION_MAX_PAGES = 200;
/** The most pending proposals one owner read returns. */
export const OWNER_PROPOSALS_LIMIT = 100;

const PROPOSALS_TABLE = "memory_place_reresolution_proposals";
const MEMORY_EVIDENCE_COLUMNS = "id, owner_id, place_id, state, location_lat, location_lng";
const MEMORY_EVIDENCE_COLUMNS_WITH_NAME = "id, owner_id, place_id, state, location_lat, location_lng, place_display_name_at_occurrence";
const PROPOSAL_COLUMNS = "id, memory_id, owner_id, split_id, split_from_place_id, candidate_place_ids, suggested_place_id, evidence, state, created_at";

// ── Gates ──────────────────────────────────────────────────────────────────

export type SplitGate = "on" | "off" | "unreadable";

/** Both flags. A flag that is definitely off (or absent) wins; otherwise any unreadable flag refuses. Never throws. */
export async function readSplitGates(sc: unknown): Promise<SplitGate> {
  const [split, places] = await Promise.all([readFlagState(sc, MEMORY_PLACE_SPLIT_FLAG), readFlagState(sc, EXTERNAL_PLACES_FLAG)]);
  return combineGates(split, places);
}

export function combineGates(a: FlagState, b: FlagState): SplitGate {
  if (a === "on" && b === "on") return "on";
  if (a === "off" || a === "absent" || b === "off" || b === "absent") return "off";
  return "unreadable";
}

// ── The rule (pure) ────────────────────────────────────────────────────────

export interface CandidatePlace {
  id: string;
  name: string | null;
  latitude: number | null;
  longitude: number | null;
}

export interface RetainedEvidence {
  lat: number | null;
  lng: number | null;
  occurrenceName: string | null;
}

export interface CandidateEvidence {
  place_id: string;
  within_bound: boolean | null;
  name_match: boolean | null;
}

export interface ProposalDecision {
  suggestedPlaceId: string | null;
  reason: ProposalReason;
  evidence: { rule: string; bound_m: number; reason: ProposalReason; candidates: CandidateEvidence[] };
}

/** A finite coordinate, or null. PostgREST may return `numeric` as a string. */
export function coordinate(v: unknown, limit: 90 | 180): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
}

/** The catalog resolver's normalization, or null when nothing distinctive is left (a non-Latin name normalizes to ""). */
export function normalizedPlaceName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const n = normalizeLocationName(name);
  return n.length > 0 ? n : null;
}

export function distanceMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  return haversineKm(aLat, aLng, bLat, bLng) * 1000;
}

/**
 * Q-H72's rule. Suggests a candidate only when exactly one is within the bound
 * AND its normalized name equals the occurrence name's; every other case is
 * unresolved, with the first failing condition as the reason.
 */
export function decideProposal(ev: RetainedEvidence, candidates: readonly CandidatePlace[]): ProposalDecision {
  const occ = normalizedPlaceName(ev.occurrenceName);
  const hasPoint = ev.lat !== null && ev.lng !== null;
  const rows: CandidateEvidence[] = candidates.map((c) => {
    const located = c.latitude !== null && c.longitude !== null;
    const cand = normalizedPlaceName(c.name);
    return {
      place_id: c.id,
      within_bound: hasPoint && located ? distanceMeters(ev.lat as number, ev.lng as number, c.latitude as number, c.longitude as number) <= RERESOLUTION_BOUND_M : null,
      name_match: occ !== null ? cand !== null && cand === occ : null,
    };
  });
  const decided = (reason: ProposalReason, suggestedPlaceId: string | null = null): ProposalDecision => ({
    suggestedPlaceId,
    reason,
    evidence: { rule: RERESOLUTION_RULE, bound_m: RERESOLUTION_BOUND_M, reason, candidates: rows },
  });
  if (!hasPoint) return decided("no_coordinates");
  if (rows.some((r) => r.within_bound === null)) return decided("candidate_without_coordinates");
  const within = rows.filter((r) => r.within_bound === true);
  if (within.length === 0) return decided("none_within_bound");
  if (within.length > 1) return decided("several_within_bound");
  if (occ === null) return decided("no_occurrence_name");
  const only = within[0]!;
  if (only.name_match !== true) return decided("name_mismatch");
  return decided("unique_within_bound_name_match", only.place_id);
}

// ── The split ──────────────────────────────────────────────────────────────

export interface SplitInput {
  name: string;
  latitude: number;
  longitude: number;
  primaryCategory?: string | null;
  address?: string | null;
  city?: string | null;
  neighborhood?: string | null;
  countryCode?: string | null;
  canonicalLocationId?: string | null;
  referenceIds?: string[];
}

export type SplitOutcome =
  | { kind: "split"; splitId: string; newPlaceId: string; referencesMoved: number }
  | { kind: "disabled" | "not_found" | "merged" | "reference_not_on_place" }
  | { kind: "invalid"; detail: string }
  | { kind: "failed"; detail: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One call to 3812's atomic place_split. Never throws. */
export async function splitPlace(sc: any, placeId: string, adminId: string, input: SplitInput): Promise<SplitOutcome> {
  const name = input.name.trim();
  const pNew: Record<string, unknown> = {
    name,
    normalized_name: normalizeLocationName(name),
    latitude: input.latitude,
    longitude: input.longitude,
  };
  if (input.primaryCategory) pNew.primary_category = input.primaryCategory;
  if (input.address) pNew.address = input.address;
  if (input.city) pNew.city = input.city;
  if (input.neighborhood) pNew.neighborhood = input.neighborhood;
  if (input.countryCode) pNew.country_code = input.countryCode;
  if (input.canonicalLocationId) pNew.canonical_location_id = input.canonicalLocationId;
  try {
    const { data, error } = await sc.rpc("place_split", {
      p_place_id: placeId,
      p_new: pNew,
      p_reference_ids: input.referenceIds ?? [],
      p_admin_id: adminId,
    });
    if (error) return { kind: "failed", detail: String(error.message ?? "place_split failed") };
    const outcome = (data as { outcome?: unknown } | null)?.outcome;
    if (outcome === "split") {
      const splitId = String((data as any).split_id ?? "");
      const newPlaceId = String((data as any).new_place_id ?? "");
      const moved = Number((data as any).references_moved ?? 0);
      if (!UUID_RE.test(splitId) || !UUID_RE.test(newPlaceId) || !Number.isInteger(moved)) return { kind: "failed", detail: "place_split answered split without its ids" };
      return { kind: "split", splitId, newPlaceId, referencesMoved: moved };
    }
    if (outcome === "disabled" || outcome === "not_found" || outcome === "merged" || outcome === "reference_not_on_place") return { kind: outcome };
    if (outcome === "invalid") return { kind: "invalid", detail: String((data as any).detail ?? "invalid split") };
    return { kind: "failed", detail: `place_split answered an unknown outcome: ${String(outcome)}` };
  } catch (err) {
    return { kind: "failed", detail: String((err as { message?: unknown })?.message ?? err) };
  }
}

// ── The job ────────────────────────────────────────────────────────────────

export interface ReresolutionCounts {
  /** Live Memories whose stored place is the split place. */
  scanned: number;
  /** Proposals written by this run (a re-run writes none for a Memory that already has one). */
  proposed: number;
  suggested: number;
  unresolved: number;
  /** Already proposed for this split (idempotent re-run). */
  alreadyProposed: number;
  /** Any owner place correction: no proposal (H73). */
  skippedCorrected: number;
  /** The owner's corrections could not be read: no proposal, never a guess. */
  skippedUnreadable: number;
  /** The Memory changed (deleted, moved) between the read and the write; 3812's guard refused. */
  skippedChanged: number;
  failed: number;
}

export type ReresolutionOutcome =
  | { state: "inert" }
  | { state: "unreadable"; detail: string }
  | { state: "not_found" }
  | { state: "done" | "incomplete"; counts: ReresolutionCounts; detail?: string };

interface SplitRow { id: string; action: string; survivor_place_id: string; affected_place_id: string }
interface MemoryRow { id: string; owner_id: string; place_id: string | null; state: string; location_lat: unknown; location_lng: unknown; place_display_name_at_occurrence?: string | null }

function emptyCounts(): ReresolutionCounts {
  return { scanned: 0, proposed: 0, suggested: 0, unresolved: 0, alreadyProposed: 0, skippedCorrected: 0, skippedUnreadable: 0, skippedChanged: 0, failed: 0 };
}

/** A refusal raised by 3812's guard (the Memory moved, was deleted, or changed owner since the read). */
function isGuardRefusal(error: unknown): boolean {
  const code = String((error as { code?: unknown })?.code ?? "");
  return (code === "23514" || code === "23503") && /memory_place_reresolution_proposals/.test(String((error as { message?: unknown })?.message ?? ""));
}

/**
 * Re-resolve every live Memory that stored the split place. Idempotent: a re-run
 * writes no second proposal for a Memory (UNIQUE (memory_id, split_id), ON
 * CONFLICT DO NOTHING). Never writes `memories` or `memory_corrections`. Never throws.
 */
export async function runSplitReresolution(sc: any, splitId: string): Promise<ReresolutionOutcome> {
  try {
    const gate = await readSplitGates(sc);
    if (gate === "off") return { state: "inert" };
    if (gate === "unreadable") return { state: "unreadable", detail: "a split flag is unreadable" };
    const nameGate = await readFlagState(sc, OCCURRENCE_NAME_FLAG);
    if (nameGate === "unreadable") return { state: "unreadable", detail: `${OCCURRENCE_NAME_FLAG} is unreadable, so whether occurrence names exist is unknown` };
    const withName = columnWritable(nameGate);

    const { data: split, error: splitErr } = await sc
      .from("place_merge_log")
      .select("id, action, survivor_place_id, affected_place_id")
      .eq("id", splitId)
      .maybeSingle();
    if (splitErr) return { state: "unreadable", detail: `place_merge_log unreadable: ${String(splitErr.message ?? "")}` };
    const s = split as SplitRow | null;
    if (!s || s.action !== "split") return { state: "not_found" };
    const from = String(s.survivor_place_id);
    const candidateIds = [from, String(s.affected_place_id)];

    const { data: places, error: placesErr } = await sc
      .from("places")
      .select("id, name, latitude, longitude")
      .in("id", candidateIds);
    if (placesErr) return { state: "unreadable", detail: `places unreadable: ${String(placesErr.message ?? "")}` };
    const byId = new Map(((places as any[]) ?? []).map((p) => [String(p.id), p]));
    if (!candidateIds.every((id) => byId.has(id))) return { state: "not_found" };
    const candidates: CandidatePlace[] = candidateIds.map((id) => {
      const p = byId.get(id);
      return { id, name: typeof p.name === "string" ? p.name : null, latitude: coordinate(p.latitude, 90), longitude: coordinate(p.longitude, 180) };
    });

    const counts = emptyCounts();
    let after = "00000000-0000-0000-0000-000000000000";
    for (let page = 0; ; page += 1) {
      if (page >= RERESOLUTION_MAX_PAGES) return { state: "incomplete", counts, detail: `more than ${RERESOLUTION_MAX_PAGES * RERESOLUTION_PAGE} Memories at the split place; re-run to continue` };
      const { data: mems, error: memErr } = await sc
        .from("memories")
        .select(withName ? MEMORY_EVIDENCE_COLUMNS_WITH_NAME : MEMORY_EVIDENCE_COLUMNS)
        .eq("place_id", from)
        .in("state", [...LIVE_MEMORY_STATES])
        .gt("id", after)
        .order("id", { ascending: true })
        .limit(RERESOLUTION_PAGE);
      if (memErr) return { state: "incomplete", counts, detail: `memories unreadable: ${String(memErr.message ?? "")}` };
      const rows = Array.isArray(mems) ? (mems as MemoryRow[]) : [];
      if (rows.length === 0) break;
      after = String(rows[rows.length - 1]!.id);
      counts.scanned += rows.length;

      const byOwner = new Map<string, MemoryRow[]>();
      for (const m of rows) {
        const list = byOwner.get(m.owner_id) ?? [];
        list.push(m);
        byOwner.set(m.owner_id, list);
      }
      for (const [ownerId, owned] of byOwner) {
        const corrections = await readPlaceCorrectionsForMemories(sc, ownerId, owned.map((m) => m.id));
        if (corrections.state !== "ok") { counts.skippedUnreadable += owned.length; continue; }
        for (const m of owned) {
          if (corrections.byMemory.has(m.id)) { counts.skippedCorrected += 1; continue; }
          const decision = decideProposal({
            lat: coordinate(m.location_lat, 90),
            lng: coordinate(m.location_lng, 180),
            occurrenceName: withName && typeof m.place_display_name_at_occurrence === "string" ? m.place_display_name_at_occurrence : null,
          }, candidates);
          const { data: written, error: writeErr } = await sc
            .from(PROPOSALS_TABLE)
            .upsert({
              memory_id: m.id,
              owner_id: m.owner_id,
              split_id: s.id,
              split_from_place_id: from,
              candidate_place_ids: candidateIds,
              suggested_place_id: decision.suggestedPlaceId,
              evidence: decision.evidence,
            }, { onConflict: "memory_id,split_id", ignoreDuplicates: true })
            .select("id");
          if (writeErr) {
            if (isGuardRefusal(writeErr)) counts.skippedChanged += 1;
            else counts.failed += 1;
            continue;
          }
          if (!Array.isArray(written) || written.length === 0) { counts.alreadyProposed += 1; continue; }
          counts.proposed += 1;
          if (decision.suggestedPlaceId) counts.suggested += 1; else counts.unresolved += 1;
        }
      }
      if (rows.length < RERESOLUTION_PAGE) break;
    }
    const complete = counts.failed === 0 && counts.skippedUnreadable === 0;
    return complete ? { state: "done", counts } : { state: "incomplete", counts, detail: "some Memories could not be decided or written; re-run to continue" };
  } catch (err) {
    return { state: "unreadable", detail: String((err as { message?: unknown })?.message ?? err) };
  }
}

// ── The owner's side ───────────────────────────────────────────────────────

export interface ServedProposal {
  id: string;
  memoryId: string;
  splitFromPlaceId: string;
  candidates: Array<{ placeId: string; name: string | null }>;
  suggestedPlaceId: string | null;
  reason: ProposalReason | null;
  createdAt: string;
}

export type OwnerProposalsRead = { state: "ok"; proposals: ServedProposal[] } | { state: "unreadable"; detail: string };

interface ProposalRow {
  id: string; memory_id: string; owner_id: string; split_id: string; split_from_place_id: string;
  candidate_place_ids: string[]; suggested_place_id: string | null; evidence: any; state: string; created_at: string;
}

/**
 * The owner's PENDING proposals, each only while its Memory is still the
 * owner's, live, still stores the split place, and carries no place correction
 * (a correction made since beats the proposal, H73). Unreadable anything ⇒
 * unreadable, never a partial list. Never throws.
 */
export async function listPendingProposals(sc: any, ownerId: string, opts: { memoryId?: string } = {}): Promise<OwnerProposalsRead> {
  try {
    let q = sc.from(PROPOSALS_TABLE).select(PROPOSAL_COLUMNS).eq("owner_id", ownerId).eq("state", "pending");
    if (opts.memoryId) q = q.eq("memory_id", opts.memoryId);
    const { data, error } = await q.order("created_at", { ascending: false }).limit(OWNER_PROPOSALS_LIMIT);
    if (error) {
      if (isTableAbsentError(error)) return { state: "ok", proposals: [] };
      return { state: "unreadable", detail: `${PROPOSALS_TABLE} unreadable: ${String(error.message ?? "")}` };
    }
    const rows = (Array.isArray(data) ? (data as ProposalRow[]) : []).filter((r) => r.owner_id === ownerId && r.state === "pending");
    if (rows.length === 0) return { state: "ok", proposals: [] };

    const memoryIds = [...new Set(rows.map((r) => r.memory_id))];
    const { data: mems, error: memErr } = await sc.from("memories").select("id, owner_id, state, place_id").in("id", memoryIds).eq("owner_id", ownerId);
    if (memErr) return { state: "unreadable", detail: `memories unreadable: ${String(memErr.message ?? "")}` };
    const memById = new Map(((mems as any[]) ?? []).filter((m) => m.owner_id === ownerId).map((m) => [String(m.id), m]));
    const standing = rows.filter((r) => {
      const m = memById.get(r.memory_id);
      return Boolean(m) && (LIVE_MEMORY_STATES as readonly string[]).includes(String(m.state)) && m.place_id === r.split_from_place_id;
    });
    if (standing.length === 0) return { state: "ok", proposals: [] };

    const corrections = await readPlaceCorrectionsForMemories(sc, ownerId, standing.map((r) => r.memory_id));
    if (corrections.state !== "ok") return { state: "unreadable", detail: corrections.detail };
    const offered = standing.filter((r) => !corrections.byMemory.has(r.memory_id));
    if (offered.length === 0) return { state: "ok", proposals: [] };

    const placeIds = [...new Set(offered.flatMap((r) => r.candidate_place_ids))];
    const { data: places, error: placesErr } = await sc.from("places").select("id, name").in("id", placeIds);
    if (placesErr) return { state: "unreadable", detail: `places unreadable: ${String(placesErr.message ?? "")}` };
    const nameOf = new Map(((places as any[]) ?? []).map((p) => [String(p.id), typeof p.name === "string" ? p.name : null]));
    const reasonOf = (e: any): ProposalReason | null => ((PROPOSAL_REASONS as readonly string[]).includes(e?.reason) ? (e.reason as ProposalReason) : null);
    return {
      state: "ok",
      proposals: offered.map((r) => ({
        id: r.id,
        memoryId: r.memory_id,
        splitFromPlaceId: r.split_from_place_id,
        candidates: r.candidate_place_ids.map((placeId) => ({ placeId, name: nameOf.get(placeId) ?? null })),
        suggestedPlaceId: r.suggested_place_id ?? null,
        reason: reasonOf(r.evidence),
        createdAt: r.created_at,
      })),
    };
  } catch (err) {
    return { state: "unreadable", detail: String((err as { message?: unknown })?.message ?? err) };
  }
}

export type DecisionOutcome =
  | { kind: "ok"; state: "accepted" | "dismissed"; placeId?: string }
  | { kind: "not_found" | "already_decided" | "not_a_candidate" | "memory_not_changed" }
  | { kind: "unreadable" | "write_failed"; detail: string };

async function readOwnProposal(sc: any, ownerId: string, proposalId: string): Promise<{ ok: true; row: ProposalRow | null } | { ok: false; detail: string }> {
  const { data, error } = await sc.from(PROPOSALS_TABLE).select(PROPOSAL_COLUMNS).eq("id", proposalId).eq("owner_id", ownerId).maybeSingle();
  if (error) {
    if (isTableAbsentError(error)) return { ok: true, row: null };
    return { ok: false, detail: `${PROPOSALS_TABLE} unreadable: ${String(error.message ?? "")}` };
  }
  const row = data as ProposalRow | null;
  return { ok: true, row: row && row.owner_id === ownerId ? row : null };
}

/**
 * The owner records that they ACCEPTED a candidate. The place change itself is
 * the owner's PATCH /memories/:id (H-10): this refuses unless the Memory already
 * stores `placeId`, and writes only the proposal's decision. Never throws.
 */
export async function acceptProposal(sc: any, ownerId: string, proposalId: string, placeId: string): Promise<DecisionOutcome> {
  try {
    const read = await readOwnProposal(sc, ownerId, proposalId);
    if (!read.ok) return { kind: "unreadable", detail: read.detail };
    const p = read.row;
    if (!p) return { kind: "not_found" };
    if (p.state !== "pending") return { kind: "already_decided" };
    if (!p.candidate_place_ids.includes(placeId)) return { kind: "not_a_candidate" };
    const { data: mem, error: memErr } = await sc.from("memories").select("id, owner_id, state, place_id").eq("id", p.memory_id).eq("owner_id", ownerId).maybeSingle();
    if (memErr) return { kind: "unreadable", detail: `memories unreadable: ${String(memErr.message ?? "")}` };
    if (!mem || (mem as any).owner_id !== ownerId || !(LIVE_MEMORY_STATES as readonly string[]).includes(String((mem as any).state))) return { kind: "not_found" };
    if ((mem as any).place_id !== placeId) return { kind: "memory_not_changed" };
    const { data, error } = await sc
      .from(PROPOSALS_TABLE)
      .update({ state: "accepted", accepted_place_id: placeId, decided_at: new Date().toISOString() })
      .eq("id", proposalId)
      .eq("owner_id", ownerId)
      .eq("state", "pending")
      .select("id");
    if (error) {
      if (isGuardRefusal(error)) return { kind: "memory_not_changed" };
      return { kind: "write_failed", detail: String(error.message ?? "update failed") };
    }
    if (!Array.isArray(data) || data.length === 0) return { kind: "already_decided" };
    return { kind: "ok", state: "accepted", placeId };
  } catch (err) {
    return { kind: "unreadable", detail: String((err as { message?: unknown })?.message ?? err) };
  }
}

/** The owner dismisses the proposal; the Memory keeps the place it stores. Never throws. */
export async function dismissProposal(sc: any, ownerId: string, proposalId: string): Promise<DecisionOutcome> {
  try {
    const read = await readOwnProposal(sc, ownerId, proposalId);
    if (!read.ok) return { kind: "unreadable", detail: read.detail };
    const p = read.row;
    if (!p) return { kind: "not_found" };
    if (p.state !== "pending") return { kind: "already_decided" };
    const { data, error } = await sc
      .from(PROPOSALS_TABLE)
      .update({ state: "dismissed", decided_at: new Date().toISOString() })
      .eq("id", proposalId)
      .eq("owner_id", ownerId)
      .eq("state", "pending")
      .select("id");
    if (error) return { kind: "write_failed", detail: String(error.message ?? "update failed") };
    if (!Array.isArray(data) || data.length === 0) return { kind: "already_decided" };
    return { kind: "ok", state: "dismissed" };
  } catch (err) {
    return { kind: "unreadable", detail: String((err as { message?: unknown })?.message ?? err) };
  }
}
