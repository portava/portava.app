/**
 * §24's two QUALITY metrics: `false_memory_rate` (census H217) and
 * `do_again_conversion` (census H222).
 *
 * SPEC: Portava Highlights / Memories Development Architecture Specification v1
 *       §24 (docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt:612)
 *         false_memory_rate    "Corrected inferred assertions / surfaced inferred assertions."
 *         do_again_conversion  "Real-world action from Memory, not watch time."
 *
 * Both were refused by name in memoryKernelMetrics.ts's MEMORY_METRICS_NOT_MEASURABLE:
 * nothing recorded what the inbox SHOWED, and nothing tied a trip save back
 * to the Do Again plan before it. This module records the half that only the
 * server sees as it happens, and reads the other half from data that already
 * exists. The definitions below are the plan's fail-closed defaults, and each one
 * is an OPEN OWNER QUESTION, not an approved definition (census §BK).
 *
 * ── false_memory_rate ────────────────────────────────────────────────────────
 * SURFACED. Counted when GET /me/memory-candidates shows the owner a candidate
 * (routes/memoryCandidates.ts). It is counted once per episode in this process. A candidate
 * carries two INFERRED assertions, and the inbox shows exactly these
 * (travel-buddy-standalone/src/features/memories/candidates/CandidateInbox.tsx):
 *   time   when it happened: the capture-time window, always shown.
 *   place  where: the city and country inferred from the trip. Counted only when the candidate showed
 *          one. The detector never invents a place, so a candidate without a
 *          place asserts no place.
 * CORRECTED. Read when an admin asks. The owner kept the candidate (a
 * `memory_evidence` link: source_table 'memories', truth_level 'asserted').
 * The kept Memory's stored value of an inferred component now differs from the
 * one the owner was shown. Clearing a value is a correction. Filling a
 * component that was not shown is not. An edit that was reverted is not.
 * Dismissing the candidate is not a correction: that is candidate_reject_rate.
 * Deleting the Memory is not a correction either.
 * EXCLUDED from both sides. An episode linked to more than one Memory is
 * excluded. So is an episode whose Memory absorbed another by MERGE_MEMORY
 * (3676 re-points the absorbed Memory's link onto the survivor, so the
 * survivor's values say nothing about that episode's assertion).
 *
 * THE TIME HALF HAS NO CORRECTION SURFACE. The app cannot change a kept
 * Memory's time: `UpdateMemoryInput`
 * (travel-buddy-standalone/src/services/memories.ts) has no startsAt or
 * endsAt, and app/memory/edit.tsx sends neither. So a wrong time that an owner
 * sees can never be counted as corrected, except through the bare API. Counting
 * time assertions in the denominator would make the rate low BY
 * CONSTRUCTION. That is the "0 that looks like 'measured, and fine'" the kernel
 * module's header refuses. So the overall figure is UNPRODUCIBLE while any
 * surfaced kind has no correction surface (`CORRECTION_SURFACES`). Both kinds
 * still report their counts, and the place half reports its own rate. A guard
 * test fails if the client grows a time field without this declaration being
 * updated.
 *
 * ── do_again_conversion ──────────────────────────────────────────────────────
 * A PLAN is counted when GET /memories/:id/actions/DO_AGAIN serves one
 * (routes/memoryActions.ts). A plan is keyed by (viewer, Memory, current
 * place). Re-compiles of the same plan inside its window (picking another trip
 * to check free time) are the same plan, not new denominator members.
 * A CONVERSION is a `trip_saved_places` row (0079, applied in production) by
 * the same person for the same place, saved inside the plan's attribution
 * window (`DO_AGAIN_ATTRIBUTION_WINDOW_MS`, from the plan's first compile).
 * That is the write `TripWishlistPicker` makes through
 * POST /trips/:tripId/saved-places from the Do Again sheet. A save made BEFORE
 * the plan cannot count: (trip, user, place) is UNIQUE, so the Do Again save of
 * an already-saved place is a 409 and writes no row. The rate is taken over
 * MATURED plans only (window closed). A plan still inside its window could
 * still convert, so counting it as "not converted" would bias the rate down.
 * ATTRIBUTION IS BY PERSON + PLACE + TIME, NOT BY BUTTON. A save of that place
 * by that person in the window counts whichever surface made it. This is
 * stated as an owner question and not hidden. The plan put this on a client
 * call (POST …/converted). It is read on the server instead: a client build that never made that call would turn every
 * plan into a non-conversion, which is a fabricated 0. A compile served by one
 * process would also be unknown to another.
 *
 * ── WHAT IS NEVER REPORTED ───────────────────────────────────────────────────
 *   - A rate over nothing. Empty ⇒ UNPRODUCIBLE with the reason.
 *   - A read failure as an empty read. Any source that fails ⇒ UNPRODUCIBLE,
 *     naming the source. A read that may be truncated (it hit the page size)
 *     ⇒ UNPRODUCIBLE. A partial count is never presented as complete.
 *   - An identifier. The exports (routes/adminMemoryMetrics.ts and one log line
 *     per metric) carry counts and rates only. The episode, owner, Memory,
 *     viewer and place ids held here never leave this module.
 *
 * ── IN-PROCESS MEANS PER-PROCESS ─────────────────────────────────────────────
 * The surfaced set and the plan log live in this process's heap. They are
 * bounded (oldest evicted first, and the count is reported), they reset on
 * deploy, and they are not aggregated across instances. Only the DENOMINATORS
 * are in-process: corrections and conversions are read from the database, so
 * an owner's edit or save served by another instance is still seen. No
 * exporter is bound (the layover OQ-8 posture). This is census rule A.2's
 * ceiling: an in-process metric is W (the H211 precedent).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";
import { isTableAbsentError } from "../../lib/tableAbsence.js";

const log = rootLogger.child({ mod: "memoryQualityMetrics" });

/** §24's own names. Never spell one twice. */
export const MEMORY_QUALITY_METRICS = {
  FALSE_MEMORY_RATE: "false_memory_rate",
  DO_AGAIN_CONVERSION: "do_again_conversion",
} as const;

/** Bumped on any change to how a figure below is derived (§28.13). */
export const MEMORY_QUALITY_METRICS_ENGINE_VERSION = "memory-quality-metrics@1";

/** The most surfaced episodes / Do Again plans one process remembers. Oldest go first. */
export const MAX_TRACKED_SURFACED = 5000;
export const MAX_TRACKED_PLANS = 5000;
/** OWNER QUESTION Q-H222-2: how long after a plan a save still counts as its conversion. */
export const DO_AGAIN_ATTRIBUTION_WINDOW_MS = 24 * 3_600_000;
/** Ids per `.in()` read. A read returning READ_PAGE rows may be truncated (PostgREST's max-rows). */
export const ID_CHUNK = 100;
export const READ_PAGE = 1000;

export type InferredAssertionKind = "time" | "place";
export const INFERRED_ASSERTION_KINDS: readonly InferredAssertionKind[] = ["time", "place"];

/**
 * Where an owner can correct each kind of inferred assertion, or null when no
 * client surface can. Read by `computeFalseMemoryRate`, and pinned against the
 * client source by memoryQualityMetrics.test.ts. If the app gains a time
 * field, that test fails until `time` names the surface.
 */
export const CORRECTION_SURFACES: Readonly<Record<InferredAssertionKind, string | null>> = {
  place: "travel-buddy-standalone/app/memory/edit.tsx -> PATCH /api/memories/:id (locationCity / locationCountry)",
  time: null,
};

export const NO_CORRECTION_SURFACE: Readonly<Record<InferredAssertionKind, string>> = {
  place: "no client surface corrects a kept Memory's place",
  time: "no client surface corrects a kept Memory's time: UpdateMemoryInput (travel-buddy-standalone/src/services/memories.ts) has no startsAt/endsAt, so a wrong time an owner sees can never be counted as corrected and the rate would be low by construction",
};

// ── Clock (a seam for tests) ─────────────────────────────────────────────────
let clock: () => number = () => Date.now();
/** TEST ONLY. `null` restores the wall clock. */
export function _setMemoryQualityClock(fn: (() => number) | null): void {
  clock = fn ?? (() => Date.now());
}

// ── false_memory_rate: what the inbox showed ─────────────────────────────────

export interface SurfacedCandidate {
  episodeId: string;
  ownerId: string;
  surfacedAtMs: number;
  time: { startedAtMs: number; endedAtMs: number | null };
  /** null when the candidate showed no place. Each component is null when it was not shown. */
  place: { city: string | null; country: string | null } | null;
}

const surfaced = new Map<string, SurfacedCandidate>();
let surfacedEvicted = 0;

/** What a candidate view carries — the shape `listCandidates` returns and the inbox renders. */
export interface SurfacedCandidateView {
  id: string;
  startedAt: string;
  endedAt: string | null;
  city: string | null;
  country: string | null;
}

const present = (s: string | null | undefined): string | null =>
  typeof s === "string" && s.trim().length > 0 ? s : null;

/**
 * The inbox showed these candidates to their owner. Once per episode per
 * process: a second listing of the same candidate is the same assertion, not a
 * second one. Never throws — a metric must not be the reason an inbox fails.
 */
export function noteCandidatesSurfaced(ownerId: string, candidates: readonly SurfacedCandidateView[]): void {
  try {
    const now = clock();
    for (const c of candidates) {
      if (surfaced.has(c.id)) continue;
      const startedAtMs = Date.parse(c.startedAt);
      if (!Number.isFinite(startedAtMs)) continue; // nothing was shown as a time
      const endedAtMs = c.endedAt == null ? null : Date.parse(c.endedAt);
      const city = present(c.city);
      const country = present(c.country);
      surfaced.set(c.id, {
        episodeId: c.id,
        ownerId,
        surfacedAtMs: now,
        time: { startedAtMs, endedAtMs: endedAtMs != null && Number.isFinite(endedAtMs) ? endedAtMs : null },
        place: city || country ? { city, country } : null,
      });
      while (surfaced.size > MAX_TRACKED_SURFACED) {
        const oldest = surfaced.keys().next().value as string;
        surfaced.delete(oldest);
        surfacedEvicted += 1;
      }
    }
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "metrics: false_memory_rate surfacing was not recorded");
  }
}

// ── do_again_conversion: the plans served ────────────────────────────────────

export interface DoAgainPlanRecord {
  viewerId: string;
  memoryId: string;
  placeId: string;
  openedAtMs: number;
  /** Compiles of this same plan inside its window (re-picks of a trip). */
  compiles: number;
}

const plans = new Map<string, DoAgainPlanRecord>();
const openPlanByTriple = new Map<string, string>();
let plansEvicted = 0;

/**
 * A Do Again plan was served. One plan per (viewer, Memory, place) per
 * attribution window. Never throws.
 */
export function noteDoAgainCompiled(input: { viewerId: string; memoryId: string; placeId: string }): void {
  try {
    if (!input.viewerId || !input.memoryId || !input.placeId) return;
    const now = clock();
    const triple = `${input.viewerId}\u0000${input.memoryId}\u0000${input.placeId}`;
    const openKey = openPlanByTriple.get(triple);
    const open = openKey ? plans.get(openKey) : undefined;
    if (open && now >= open.openedAtMs && now < open.openedAtMs + DO_AGAIN_ATTRIBUTION_WINDOW_MS) {
      open.compiles += 1;
      return;
    }
    const key = `${triple}\u0000${now}`;
    plans.set(key, { viewerId: input.viewerId, memoryId: input.memoryId, placeId: input.placeId, openedAtMs: now, compiles: 1 });
    openPlanByTriple.set(triple, key);
    while (plans.size > MAX_TRACKED_PLANS) {
      const oldest = plans.keys().next().value as string;
      const p = plans.get(oldest)!;
      plans.delete(oldest);
      const t = `${p.viewerId}\u0000${p.memoryId}\u0000${p.placeId}`;
      if (openPlanByTriple.get(t) === oldest) openPlanByTriple.delete(t);
      plansEvicted += 1;
    }
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "metrics: do_again_conversion plan was not recorded");
  }
}

/** Test hook. */
export function _resetMemoryQualityMetrics(): void {
  surfaced.clear();
  surfacedEvicted = 0;
  plans.clear();
  openPlanByTriple.clear();
  plansEvicted = 0;
}

// ── The figures ──────────────────────────────────────────────────────────────

export interface QualityMetricValue {
  name: string;
  status: "OK" | "UNPRODUCIBLE";
  /** A rate in [0,1] when OK; null when UNPRODUCIBLE. Never 0 standing in for "unknown". */
  value: number | null;
  /** Why there is no value. null when OK. */
  blockedBy: string | null;
  /** null when a source could not be read: an unknown count is not 0. */
  numerator: number | null;
  denominator: number;
}

function rate4(n: number, d: number): number {
  return Math.round((n / d) * 10000) / 10000;
}

export interface AssertionKindValue {
  status: "OK" | "UNPRODUCIBLE";
  value: number | null;
  blockedBy: string | null;
  surfaced: number;
  /** null when the kept Memories could not be read: an unknown count is not 0. */
  corrected: number | null;
  correctionSurface: string | null;
}

export interface FalseMemoryRateResult extends QualityMetricValue {
  byAssertion: Record<InferredAssertionKind, AssertionKindValue>;
  population: {
    /** Episodes this process saw surfaced and still remembers. */
    tracked: number;
    /** Of those, kept as a Memory that still exists. */
    kept: number;
    /** Linked to a Memory that absorbed another by MERGE_MEMORY: excluded from both sides. */
    excludedMerged: number;
    /** Linked to more than one Memory: excluded from both sides. */
    excludedAmbiguousLink: number;
    /** Surfaced episodes forgotten to the bound since the process started. */
    evicted: number;
  };
  engineVersion: string;
}

/** The kept Memory as stored now — the columns an inferred assertion is compared with. */
export interface KeptMemoryState {
  id: string;
  ownerId: string;
  state: string | null;
  startsAt: string | null;
  endsAt: string | null;
  city: string | null;
  country: string | null;
}

export interface FalseMemoryInputs {
  surfaced: readonly SurfacedCandidate[];
  /** episodeId → the Memory ids its owner kept it as (memory_evidence, asserted). */
  links: ReadonlyMap<string, readonly string[]>;
  memories: ReadonlyMap<string, KeptMemoryState>;
  /** Memories that absorbed another by MERGE_MEMORY (memory_id_redirects, reason 'merged'). */
  mergeSurvivors: ReadonlySet<string>;
  correctionSurfaces?: Readonly<Record<InferredAssertionKind, string | null>>;
  evicted?: number;
}

/** Case, width and spacing are not a correction; a different word is. */
function normText(s: string | null | undefined): string {
  return (s ?? "").normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

function sameInstant(stored: string | null, shownMs: number): boolean {
  if (stored == null) return false;
  const t = Date.parse(stored);
  return Number.isFinite(t) && t === shownMs;
}

/** The kept Memory's time differs from the window the owner was shown. */
export function timeCorrected(shown: SurfacedCandidate["time"], m: KeptMemoryState): boolean {
  if (!sameInstant(m.startsAt, shown.startedAtMs)) return true;
  if (shown.endedAtMs != null && !sameInstant(m.endsAt, shown.endedAtMs)) return true;
  return false;
}

/** A shown place component the kept Memory no longer carries (changed or cleared). An unshown one is never a correction. */
export function placeCorrected(shown: NonNullable<SurfacedCandidate["place"]>, m: KeptMemoryState): boolean {
  if (shown.city != null && normText(m.city) !== normText(shown.city)) return true;
  if (shown.country != null && normText(m.country) !== normText(shown.country)) return true;
  return false;
}

function blockedFm(byAssertion: FalseMemoryRateResult["byAssertion"], population: FalseMemoryRateResult["population"], blockedBy: string, n: number | null, d: number): FalseMemoryRateResult {
  return {
    name: MEMORY_QUALITY_METRICS.FALSE_MEMORY_RATE, status: "UNPRODUCIBLE", value: null, blockedBy,
    numerator: n, denominator: d, byAssertion, population, engineVersion: MEMORY_QUALITY_METRICS_ENGINE_VERSION,
  };
}

/**
 * A source could not be read. What was SURFACED is known (it is this
 * process's own record); what was corrected is not, so every corrected count
 * is null and every figure is UNPRODUCIBLE with the source named.
 */
function unreadableFm(snapshot: readonly SurfacedCandidate[], evicted: number, blockedBy: string): FalseMemoryRateResult {
  const surfacedOf: Record<InferredAssertionKind, number> = {
    time: snapshot.length,
    place: snapshot.filter((s) => s.place != null).length,
  };
  const byAssertion = {} as FalseMemoryRateResult["byAssertion"];
  for (const kind of INFERRED_ASSERTION_KINDS) {
    byAssertion[kind] = { status: "UNPRODUCIBLE", value: null, blockedBy, surfaced: surfacedOf[kind], corrected: null, correctionSurface: CORRECTION_SURFACES[kind] };
  }
  const population = { tracked: snapshot.length, kept: 0, excludedMerged: 0, excludedAmbiguousLink: 0, evicted };
  return blockedFm(byAssertion, population, blockedBy, null, surfacedOf.time + surfacedOf.place);
}

/** Pure. The whole of the definition: same inputs, same figure. */
export function computeFalseMemoryRate(input: FalseMemoryInputs): FalseMemoryRateResult {
  const surfaces = input.correctionSurfaces ?? CORRECTION_SURFACES;
  const tally: Record<InferredAssertionKind, { surfaced: number; corrected: number }> = {
    time: { surfaced: 0, corrected: 0 }, place: { surfaced: 0, corrected: 0 },
  };
  let kept = 0, excludedMerged = 0, excludedAmbiguousLink = 0;

  for (const s of input.surfaced) {
    const linked = [...new Set(input.links.get(s.episodeId) ?? [])];
    if (linked.length > 1) { excludedAmbiguousLink += 1; continue; }
    const memoryId = linked[0] ?? null;
    if (memoryId && input.mergeSurvivors.has(memoryId)) { excludedMerged += 1; continue; }
    const m = memoryId ? input.memories.get(memoryId) : undefined;
    const keptMemory = m && m.ownerId === s.ownerId && m.state !== "deleted" ? m : null;
    if (keptMemory) kept += 1;

    tally.time.surfaced += 1;
    if (keptMemory && timeCorrected(s.time, keptMemory)) tally.time.corrected += 1;
    if (s.place) {
      tally.place.surfaced += 1;
      if (keptMemory && placeCorrected(s.place, keptMemory)) tally.place.corrected += 1;
    }
  }

  const byAssertion = {} as FalseMemoryRateResult["byAssertion"];
  for (const kind of INFERRED_ASSERTION_KINDS) {
    const t = tally[kind];
    const surface = surfaces[kind];
    if (t.surfaced === 0) {
      byAssertion[kind] = { status: "UNPRODUCIBLE", value: null, blockedBy: `no ${kind} assertion was surfaced in this process`, surfaced: 0, corrected: 0, correctionSurface: surface };
    } else if (surface == null) {
      byAssertion[kind] = { status: "UNPRODUCIBLE", value: null, blockedBy: NO_CORRECTION_SURFACE[kind], surfaced: t.surfaced, corrected: t.corrected, correctionSurface: null };
    } else {
      byAssertion[kind] = { status: "OK", value: rate4(t.corrected, t.surfaced), blockedBy: null, surfaced: t.surfaced, corrected: t.corrected, correctionSurface: surface };
    }
  }

  const population = { tracked: input.surfaced.length, kept, excludedMerged, excludedAmbiguousLink, evicted: input.evicted ?? 0 };
  const numerator = tally.time.corrected + tally.place.corrected;
  const denominator = tally.time.surfaced + tally.place.surfaced;
  if (denominator === 0) {
    return blockedFm(byAssertion, population, input.surfaced.length === 0
      ? "no inferred assertion has been surfaced in this process (the candidate inbox showed nothing, or memory_episodes / memory_evidence — migration 2320 — are not deployed)"
      : "every surfaced episode was excluded (merged or ambiguously linked)", numerator, denominator);
  }
  const uncorrectable = INFERRED_ASSERTION_KINDS.filter((k) => tally[k].surfaced > 0 && surfaces[k] == null);
  if (uncorrectable.length > 0) {
    return blockedFm(byAssertion, population, uncorrectable.map((k) => `${k}: ${NO_CORRECTION_SURFACE[k]}`).join("; "), numerator, denominator);
  }
  return {
    name: MEMORY_QUALITY_METRICS.FALSE_MEMORY_RATE, status: "OK", value: rate4(numerator, denominator), blockedBy: null,
    numerator, denominator, byAssertion, population, engineVersion: MEMORY_QUALITY_METRICS_ENGINE_VERSION,
  };
}

export interface DoAgainConversionResult extends QualityMetricValue {
  plans: {
    /** Plans this process remembers. */
    tracked: number;
    /** Window closed: in the denominator. */
    matured: number;
    /** Window still open: not in the denominator (they may yet convert). */
    pending: number;
    /** Compiles folded into those plans (re-picks of a trip are the same plan). */
    compiles: number;
    evicted: number;
  };
  windowMs: number;
  /** What a conversion is, in one line, so a reader of the figure cannot mistake it for a visit. */
  definition: string;
  engineVersion: string;
}

export interface SaveRow { userId: string; placeId: string; savedAtMs: number }

export const DO_AGAIN_CONVERSION_DEFINITION =
  "a Do Again plan (viewer, Memory, place) followed by a trip_saved_places row for the same viewer and place, saved within the attribution window from the plan's first compile — a PLANNING conversion (owner question Q-H222-1), attributed by person + place + time, not by button";

/** Pure. The rate is over MATURED plans only. */
export function computeDoAgainConversion(input: { plans: readonly DoAgainPlanRecord[]; saves: readonly SaveRow[]; nowMs: number; windowMs?: number; evicted?: number }): DoAgainConversionResult {
  const windowMs = input.windowMs ?? DO_AGAIN_ATTRIBUTION_WINDOW_MS;
  const matured = input.plans.filter((p) => p.openedAtMs + windowMs <= input.nowMs);
  const converted = matured.filter((p) => input.saves.some((s) =>
    s.userId === p.viewerId && s.placeId === p.placeId && s.savedAtMs >= p.openedAtMs && s.savedAtMs < p.openedAtMs + windowMs)).length;
  const base = {
    name: MEMORY_QUALITY_METRICS.DO_AGAIN_CONVERSION,
    numerator: converted,
    denominator: matured.length,
    plans: {
      tracked: input.plans.length, matured: matured.length, pending: input.plans.length - matured.length,
      compiles: input.plans.reduce((n, p) => n + p.compiles, 0), evicted: input.evicted ?? 0,
    },
    windowMs,
    definition: DO_AGAIN_CONVERSION_DEFINITION,
    engineVersion: MEMORY_QUALITY_METRICS_ENGINE_VERSION,
  };
  if (matured.length === 0) {
    return {
      ...base, status: "UNPRODUCIBLE", value: null,
      blockedBy: input.plans.length === 0
        ? "no Do Again plan has been served by this process"
        : "no Do Again plan served by this process has finished its attribution window yet",
    };
  }
  return { ...base, status: "OK", value: rate4(converted, matured.length), blockedBy: null };
}

// ── Reads (the data that already exists) ─────────────────────────────────────

function chunks<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

type Read<T> = { ok: true; value: T } | { ok: false; blockedBy: string };

async function readLinks(sc: SupabaseClient, snapshot: readonly SurfacedCandidate[]): Promise<Read<Map<string, string[]>>> {
  const ownerOf = new Map(snapshot.map((s) => [s.episodeId, s.ownerId] as const));
  const links = new Map<string, string[]>();
  for (const ids of chunks(snapshot.map((s) => s.episodeId), ID_CHUNK)) {
    const { data, error } = await sc
      .from("memory_evidence")
      .select("episode_id, source_id, user_id")
      .eq("source_table", "memories")
      .eq("truth_level", "asserted")
      .in("episode_id", ids)
      .limit(READ_PAGE);
    if (error) return { ok: false, blockedBy: "memory_evidence could not be read, so which candidates were kept is unknown" };
    const rows = (data as Array<{ episode_id: string; source_id: string; user_id: string }> | null) ?? [];
    if (rows.length >= READ_PAGE) return { ok: false, blockedBy: "the memory_evidence read may be truncated, so which candidates were kept is incomplete" };
    for (const r of rows) {
      // The owner's own keep only: a link written under another user is not this owner's word.
      if (ownerOf.get(String(r.episode_id)) !== String(r.user_id)) continue;
      const list = links.get(String(r.episode_id)) ?? [];
      list.push(String(r.source_id));
      links.set(String(r.episode_id), list);
    }
  }
  return { ok: true, value: links };
}

async function readKeptMemories(sc: SupabaseClient, ids: readonly string[]): Promise<Read<Map<string, KeptMemoryState>>> {
  const out = new Map<string, KeptMemoryState>();
  for (const chunk of chunks(ids, ID_CHUNK)) {
    const { data, error } = await sc
      .from("memories")
      .select("id, owner_id, state, starts_at, ends_at, location_city, location_country")
      .in("id", chunk)
      .limit(READ_PAGE);
    if (error) return { ok: false, blockedBy: "memories could not be read, so whether a kept candidate was corrected is unknown" };
    const rows = (data as Array<Record<string, unknown>> | null) ?? [];
    if (rows.length >= READ_PAGE) return { ok: false, blockedBy: "the memories read may be truncated" };
    for (const r of rows) {
      out.set(String(r.id), {
        id: String(r.id),
        ownerId: String(r.owner_id),
        state: r.state == null ? null : String(r.state),
        startsAt: r.starts_at == null ? null : String(r.starts_at),
        endsAt: r.ends_at == null ? null : String(r.ends_at),
        city: r.location_city == null ? null : String(r.location_city),
        country: r.location_country == null ? null : String(r.location_country),
      });
    }
  }
  return { ok: true, value: out };
}

/** Memories that absorbed another. 3676 unapplied ⇒ the table is absent ⇒ no merge can have happened. */
async function readMergeSurvivors(sc: SupabaseClient, ids: readonly string[]): Promise<Read<Set<string>>> {
  const out = new Set<string>();
  for (const chunk of chunks(ids, ID_CHUNK)) {
    const { data, error } = await sc
      .from("memory_id_redirects")
      .select("new_memory_id")
      .eq("reason", "merged")
      .in("new_memory_id", chunk)
      .limit(READ_PAGE);
    if (error) {
      if (isTableAbsentError(error)) return { ok: true, value: out };
      return { ok: false, blockedBy: "memory_id_redirects could not be read, so a merged Memory cannot be told from a corrected one" };
    }
    const rows = (data as Array<{ new_memory_id: string }> | null) ?? [];
    if (rows.length >= READ_PAGE) return { ok: false, blockedBy: "the memory_id_redirects read may be truncated" };
    for (const r of rows) out.add(String(r.new_memory_id));
  }
  return { ok: true, value: out };
}

/** false_memory_rate over what this process surfaced, corrected as the database says now. Never throws. */
export async function readFalseMemoryRate(sc: SupabaseClient): Promise<FalseMemoryRateResult> {
  const snapshot = [...surfaced.values()];
  const evicted = surfacedEvicted;
  if (snapshot.length === 0) {
    return computeFalseMemoryRate({ surfaced: snapshot, links: new Map(), memories: new Map(), mergeSurvivors: new Set(), evicted });
  }
  try {
    const links = await readLinks(sc, snapshot);
    if (!links.ok) return unreadableFm(snapshot, evicted, links.blockedBy);
    const memoryIds = [...new Set([...links.value.values()].flat())];
    const memories = await readKeptMemories(sc, memoryIds);
    if (!memories.ok) return unreadableFm(snapshot, evicted, memories.blockedBy);
    const survivors = await readMergeSurvivors(sc, memoryIds);
    if (!survivors.ok) return unreadableFm(snapshot, evicted, survivors.blockedBy);
    return computeFalseMemoryRate({ surfaced: snapshot, links: links.value, memories: memories.value, mergeSurvivors: survivors.value, evicted });
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, "metrics: false_memory_rate read threw");
    return unreadableFm(snapshot, evicted, "the false_memory_rate read failed");
  }
}

/** do_again_conversion over the plans this process served, converted as trip_saved_places says now. Never throws. */
export async function readDoAgainConversion(sc: SupabaseClient): Promise<DoAgainConversionResult> {
  const nowMs = clock();
  const snapshot = [...plans.values()].map((p) => ({ ...p }));
  const evicted = plansEvicted;
  const windowMs = DO_AGAIN_ATTRIBUTION_WINDOW_MS;
  const matured = snapshot.filter((p) => p.openedAtMs + windowMs <= nowMs);
  const unreadable = (blockedBy: string): DoAgainConversionResult => ({
    ...computeDoAgainConversion({ plans: snapshot, saves: [], nowMs, windowMs, evicted }),
    status: "UNPRODUCIBLE", value: null, blockedBy, numerator: null,
  });
  if (matured.length === 0) return computeDoAgainConversion({ plans: snapshot, saves: [], nowMs, windowMs, evicted });
  try {
    const saves: SaveRow[] = [];
    for (const chunk of chunks(matured, ID_CHUNK)) {
      const from = Math.min(...chunk.map((p) => p.openedAtMs));
      const to = Math.max(...chunk.map((p) => p.openedAtMs + windowMs));
      const { data, error } = await sc
        .from("trip_saved_places")
        .select("user_id, place_id, saved_at")
        .in("user_id", [...new Set(chunk.map((p) => p.viewerId))])
        .in("place_id", [...new Set(chunk.map((p) => p.placeId))])
        .gte("saved_at", new Date(from).toISOString())
        .lt("saved_at", new Date(to).toISOString())
        .limit(READ_PAGE);
      if (error) return unreadable("trip_saved_places could not be read, so no conversion is reported");
      const rows = (data as Array<{ user_id: string; place_id: string | null; saved_at: string }> | null) ?? [];
      if (rows.length >= READ_PAGE) return unreadable("the trip_saved_places read may be truncated, so no conversion is reported");
      for (const r of rows) {
        const savedAtMs = Date.parse(String(r.saved_at));
        if (r.place_id == null || !Number.isFinite(savedAtMs)) continue;
        saves.push({ userId: String(r.user_id), placeId: String(r.place_id), savedAtMs });
      }
    }
    return computeDoAgainConversion({ plans: snapshot, saves, nowMs, windowMs, evicted });
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, "metrics: do_again_conversion read threw");
    return unreadable("the do_again_conversion read failed");
  }
}

export interface MetricLogger {
  info?: (obj: unknown, msg: string) => void;
}

/**
 * The log half of the export: one structured line per metric, counts and rates
 * only. A missing logger is a no-op (memoryPrivacyMetrics.ts's posture).
 */
export function recordQualityMetrics(logger: MetricLogger | undefined, results: readonly QualityMetricValue[]): void {
  if (!logger || typeof logger.info !== "function") return;
  for (const r of results) {
    logger.info(
      { metric: r.name, status: r.status, value: r.value, numerator: r.numerator, denominator: r.denominator, blockedBy: r.blockedBy, engineVersion: MEMORY_QUALITY_METRICS_ENGINE_VERSION },
      r.status === "OK" ? `metrics: ${r.name}` : `metrics: ${r.name} — UNPRODUCIBLE, not 0`,
    );
  }
}

/** The logger this module's export uses by default. */
export const qualityMetricsLog: MetricLogger = log;
