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
 * THE POPULATION IS DECIDED CANDIDATES. A candidate still in the inbox has
 * had no chance to be corrected, so counting it "not corrected" from the
 * moment it is listed would bias the rate low (the same reason a Do Again plan
 * counts only once its window has closed). Each surfaced episode's stored state
 * is read (memory_episodes): kept (with its Memory linked), dismissed or deleted
 * is DECIDED and in the denominator; still a candidate, a Keep that did not
 * finish, or a state this code does not know is UNDECIDED and only counted.
 * EXCLUDED from both sides, and counted: an episode that is gone or is not the
 * surfacing owner's (an erased account); a merged episode; an episode linked
 * to more than one Memory; and an episode whose Memory absorbed another by
 * MERGE_MEMORY (3676 re-points the absorbed Memory's link onto the survivor,
 * so the survivor's values say nothing about that episode's assertion).
 * THE SHOWN PLACE IS HELD AS A KEYED DIGEST (`placeDigest`), not as text; the
 * capture window is held as two instants.
 *
 * TIME CORRECTION IS AN EXPLICIT OWNER EDIT. app/memory/edit.tsx now sends
 * touched startsAt/endsAt fields through the existing authenticated PATCH.
 * Dates, times and UTC offsets are supplied by the owner, never inferred;
 * explicit null clears a value and untouched fields are omitted. Mounted
 * editor tests exercise the real client transport, and route tests preserve
 * the original episode and capture evidence while changing the kept Memory.
 * This availability declaration does not ratify the definitions above, add a
 * time-correction ledger or change the metric's formula or population. The
 * overall figure remains UNPRODUCIBLE while a decided kind has no correction
 * surface (`CORRECTION_SURFACES`). A source guard pins the connected controls,
 * PATCH input and this declaration together; the missing-surface refusal is
 * still tested independently of today's available controls.
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
 * stated as an owner question and not hidden. ONE SAVE CREDITS AT MOST ONE
 * PLAN: the latest plan that person opened for that place at or before the
 * save (`creditedPlan`), so two Memories of one café, Do Again on each and one
 * save, is one conversion, not two. The plan put this on a client
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
 * bounded (oldest evicted first, and the count is reported — the oldest
 * surfacings are the most likely to be decided, so a saturated process
 * measures its more recent decisions), they reset on
 * deploy, and they are not aggregated across instances. Only the DENOMINATORS
 * are in-process: corrections and conversions are read from the database, so
 * an owner's edit or save served by another instance is still seen. No
 * exporter is bound (the layover OQ-8 posture). This is census rule A.2's
 * ceiling: an in-process metric is W (the H211 precedent).
 */
import { createHmac, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z as zod } from "zod";
import { logger as rootLogger } from "../../lib/logger.js";
import { isTableAbsentError } from "../../lib/tableAbsence.js";

const log = rootLogger.child({ mod: "memoryQualityMetrics" });

/** §24's own names. Never spell one twice. */
export const MEMORY_QUALITY_METRICS = {
  FALSE_MEMORY_RATE: "false_memory_rate",
  DO_AGAIN_CONVERSION: "do_again_conversion",
} as const;

/** Bumped on any change to how a figure below is derived (§28.13). */
export const MEMORY_QUALITY_METRICS_ENGINE_VERSION = "memory-quality-metrics@2";

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
 * client source by memoryQualityMetrics.test.ts. Both client surfaces have
 * mounted transport tests; a type declaration alone is not a correction UI.
 */
export const CORRECTION_SURFACES: Readonly<Record<InferredAssertionKind, string | null>> = {
  place: "travel-buddy-standalone/app/memory/edit.tsx -> PATCH /api/memories/:id (locationCity / locationCountry)",
  time: "travel-buddy-standalone/app/memory/edit.tsx -> PATCH /api/memories/:id (startsAt / endsAt)",
};

export const NO_CORRECTION_SURFACE: Readonly<Record<InferredAssertionKind, string>> = {
  place: "no client surface corrects a kept Memory's place",
  time: "no client surface corrects a kept Memory's time",
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
  /**
   * null when the candidate showed no place. Each component is a KEYED DIGEST
   * of the shown text (`placeDigest`), or null when it was not shown: the heap
   * holds no place text.
   */
  place: { city: string | null; country: string | null } | null;
}

/**
 * A per-process random key, so the place a candidate showed is held as an
 * HMAC of its normalized text rather than as the text. A place name has little
 * entropy, so this keeps plain place text out of the heap (and out of anything
 * that dumps it) without pretending to be encryption: whoever holds this
 * process's memory holds the key. Comparison needs only equality, which an
 * HMAC of the normalized text preserves.
 */
const PLACE_DIGEST_KEY = randomBytes(32);

/** The digest a shown or stored place component is compared by. Normalization first: case, width and spacing are not a correction. */
export function placeDigest(s: string | null | undefined): string {
  return createHmac("sha256", PLACE_DIGEST_KEY).update(normText(s)).digest("hex");
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
        place: city || country ? { city: city ? placeDigest(city) : null, country: country ? placeDigest(country) : null } : null,
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

/** TEST ONLY: what the heap holds for the surfaced set, copied. */
export function _surfacedSnapshotForTest(): SurfacedCandidate[] {
  return [...surfaced.values()].map((c) => ({ ...c, time: { ...c.time }, place: c.place ? { ...c.place } : null }));
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
  /** null when a source could not be read. */
  denominator: number | null;
}

function rate4(n: number, d: number): number {
  return Math.round((n / d) * 10000) / 10000;
}

export interface AssertionKindValue {
  status: "OK" | "UNPRODUCIBLE";
  value: number | null;
  blockedBy: string | null;
  /** Assertions of this kind the inbox showed (this process, still remembered). */
  surfaced: number;
  /**
   * Of those, the ones whose candidate the owner has DECIDED (kept, dismissed
   * or deleted): the denominator. An undecided candidate is not a "not
   * corrected" one — it has had no chance to be corrected. null when unknown.
   */
  decided: number | null;
  /** null when a source could not be read: an unknown count is not 0. */
  corrected: number | null;
  correctionSurface: string | null;
}

export interface FalseMemoryRateResult extends QualityMetricValue {
  byAssertion: Record<InferredAssertionKind, AssertionKindValue>;
  population: {
    /** Episodes this process saw surfaced and still remembers. */
    tracked: number;
    /** Decided by the owner (kept, dismissed, deleted): the population every rate is over. */
    decided: number;
    /** Of the decided, kept as a Memory that still exists. */
    kept: number;
    /** Still in the inbox (or a Keep that did not finish, or a state this code does not know): excluded from both sides, counted here. */
    undecided: number;
    /** The episode row is gone or is not the surfacing owner's (an erased account): excluded from both sides. */
    erased: number;
    /** The episode was merged, or its Memory absorbed another by MERGE_MEMORY: excluded from both sides. */
    excludedMerged: number;
    /** Linked to more than one Memory: excluded from both sides. */
    excludedAmbiguousLink: number;
    /** Surfaced episodes forgotten to the bound (oldest first) since the process started. */
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

/** The surfaced episode as stored now: whose it is, and whether the owner has decided it. */
export interface EpisodeState { ownerId: string; state: string }

/** 2320's states in which the owner has KEPT the episode. */
export const KEPT_EPISODE_STATES: ReadonlySet<string> = new Set(["confirmed", "active", "archived"]);
/** States in which the owner decided AGAINST keeping it (dismissed), or deleted what was kept. */
export const DISMISSED_EPISODE_STATES: ReadonlySet<string> = new Set(["rejected", "deleted"]);

export interface FalseMemoryInputs {
  surfaced: readonly SurfacedCandidate[];
  /** episodeId → its stored owner and state (memory_episodes). A missing entry is an erased episode. */
  episodes: ReadonlyMap<string, EpisodeState>;
  /** episodeId → the Memory ids its owner kept it as (memory_evidence, asserted). */
  links: ReadonlyMap<string, readonly string[]>;
  memories: ReadonlyMap<string, KeptMemoryState>;
  /** Memories that absorbed another by MERGE_MEMORY (memory_id_redirects, reason 'merged'). */
  mergeSurvivors: ReadonlySet<string>;
  correctionSurfaces?: Readonly<Record<InferredAssertionKind, string | null>>;
  evicted?: number;
}

/** Case, width and spacing are not a correction; a different word is. */
export function normText(s: string | null | undefined): string {
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

/** A shown place component the kept Memory no longer carries (changed or cleared). An unshown one is never a correction. Compared by digest. */
export function placeCorrected(shown: NonNullable<SurfacedCandidate["place"]>, m: KeptMemoryState): boolean {
  if (shown.city != null && placeDigest(m.city) !== shown.city) return true;
  if (shown.country != null && placeDigest(m.country) !== shown.country) return true;
  return false;
}

function blockedFm(byAssertion: FalseMemoryRateResult["byAssertion"], population: FalseMemoryRateResult["population"], blockedBy: string, n: number | null, d: number | null): FalseMemoryRateResult {
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
    byAssertion[kind] = { status: "UNPRODUCIBLE", value: null, blockedBy, surfaced: surfacedOf[kind], decided: null, corrected: null, correctionSurface: CORRECTION_SURFACES[kind] };
  }
  const population = { tracked: snapshot.length, decided: 0, kept: 0, undecided: 0, erased: 0, excludedMerged: 0, excludedAmbiguousLink: 0, evicted };
  return blockedFm(byAssertion, population, blockedBy, null, null);
}

/** Pure. The whole of the definition: same inputs, same figure. */
export function computeFalseMemoryRate(input: FalseMemoryInputs): FalseMemoryRateResult {
  const surfaces = input.correctionSurfaces ?? CORRECTION_SURFACES;
  const tally: Record<InferredAssertionKind, { surfaced: number; decided: number; corrected: number }> = {
    time: { surfaced: 0, decided: 0, corrected: 0 }, place: { surfaced: 0, decided: 0, corrected: 0 },
  };
  let decided = 0, kept = 0, undecided = 0, erased = 0, excludedMerged = 0, excludedAmbiguousLink = 0;

  for (const s of input.surfaced) {
    tally.time.surfaced += 1;
    if (s.place) tally.place.surfaced += 1;

    const ep = input.episodes.get(s.episodeId);
    if (!ep || ep.ownerId !== s.ownerId) { erased += 1; continue; }
    if (ep.state === "merged") { excludedMerged += 1; continue; }
    if (!KEPT_EPISODE_STATES.has(ep.state) && !DISMISSED_EPISODE_STATES.has(ep.state)) { undecided += 1; continue; } // 'candidate', or a state this code does not know
    const linked = [...new Set(input.links.get(s.episodeId) ?? [])];
    if (linked.length > 1) { excludedAmbiguousLink += 1; continue; }
    const memoryId = linked[0] ?? null;
    if (memoryId && input.mergeSurvivors.has(memoryId)) { excludedMerged += 1; continue; }
    // A Keep claims the episode BEFORE its Memory is linked (episodeCandidates.ts confirmCandidate): kept with no
    // link is a Keep that did not finish, still in the inbox as "interrupted". Undecided, not "kept as shown".
    if (KEPT_EPISODE_STATES.has(ep.state) && !memoryId) { undecided += 1; continue; }

    decided += 1;
    const m = memoryId && KEPT_EPISODE_STATES.has(ep.state) ? input.memories.get(memoryId) : undefined;
    const keptMemory = m && m.ownerId === s.ownerId && m.state !== "deleted" ? m : null;
    if (keptMemory) kept += 1;

    tally.time.decided += 1;
    if (keptMemory && timeCorrected(s.time, keptMemory)) tally.time.corrected += 1;
    if (s.place) {
      tally.place.decided += 1;
      if (keptMemory && placeCorrected(s.place, keptMemory)) tally.place.corrected += 1;
    }
  }

  const byAssertion = {} as FalseMemoryRateResult["byAssertion"];
  for (const kind of INFERRED_ASSERTION_KINDS) {
    const t = tally[kind];
    const surface = surfaces[kind];
    const counts = { surfaced: t.surfaced, decided: t.decided, corrected: t.corrected };
    if (t.decided === 0) {
      byAssertion[kind] = { status: "UNPRODUCIBLE", value: null, ...counts, correctionSurface: surface,
        blockedBy: t.surfaced === 0 ? `no ${kind} assertion was surfaced in this process` : `no surfaced ${kind} assertion's candidate has been decided yet` };
    } else if (surface == null) {
      byAssertion[kind] = { status: "UNPRODUCIBLE", value: null, blockedBy: NO_CORRECTION_SURFACE[kind], ...counts, correctionSurface: null };
    } else {
      byAssertion[kind] = { status: "OK", value: rate4(t.corrected, t.decided), blockedBy: null, ...counts, correctionSurface: surface };
    }
  }

  const population = { tracked: input.surfaced.length, decided, kept, undecided, erased, excludedMerged, excludedAmbiguousLink, evicted: input.evicted ?? 0 };
  const numerator = tally.time.corrected + tally.place.corrected;
  const denominator = tally.time.decided + tally.place.decided;
  if (denominator === 0) {
    return blockedFm(byAssertion, population, input.surfaced.length === 0
      ? "no inferred assertion has been surfaced in this process (the candidate inbox showed nothing, or memory_episodes / memory_evidence — migration 2320 — are not deployed)"
      : "no surfaced candidate has been decided by its owner yet (undecided, erased, merged or ambiguously linked are excluded)", numerator, denominator);
  }
  const uncorrectable = INFERRED_ASSERTION_KINDS.filter((k) => tally[k].decided > 0 && surfaces[k] == null);
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
  "a Do Again plan (viewer, Memory, place) followed by a trip_saved_places row for the same viewer and place, saved within the attribution window from the plan's first compile — a PLANNING conversion (owner question Q-H222-1), attributed by person + place + time, not by button; each save credits AT MOST ONE plan, the latest one that person opened for that place at or before the save (Q-H222-2)";

/**
 * Which plan a save credits: the LATEST plan the same person opened for the
 * same place at or before the save, while that plan's window was open. One save
 * is one action, so it never converts two plans — two Memories of one café,
 * Do Again on each, then one save, is one conversion, credited to the plan the
 * person acted on last. Ties (the same instant) go to the greater Memory id, so
 * the answer is deterministic. Pending plans compete too: a save inside an
 * older plan's window that follows a newer plan credits the newer one.
 */
export function creditedPlan(save: SaveRow, plans: readonly DoAgainPlanRecord[], windowMs: number): DoAgainPlanRecord | null {
  let best: DoAgainPlanRecord | null = null;
  for (const p of plans) {
    if (p.viewerId !== save.userId || p.placeId !== save.placeId) continue;
    if (!(save.savedAtMs >= p.openedAtMs && save.savedAtMs < p.openedAtMs + windowMs)) continue;
    if (!best || p.openedAtMs > best.openedAtMs || (p.openedAtMs === best.openedAtMs && p.memoryId > best.memoryId)) best = p;
  }
  return best;
}

/** Pure. The rate is over MATURED plans only, and a save credits at most one plan. */
export function computeDoAgainConversion(input: { plans: readonly DoAgainPlanRecord[]; saves: readonly SaveRow[]; nowMs: number; windowMs?: number; evicted?: number }): DoAgainConversionResult {
  const windowMs = input.windowMs ?? DO_AGAIN_ATTRIBUTION_WINDOW_MS;
  const matured = input.plans.filter((p) => p.openedAtMs + windowMs <= input.nowMs);
  const credited = new Set<DoAgainPlanRecord>();
  for (const save of input.saves) {
    const p = creditedPlan(save, input.plans, windowMs);
    if (p) credited.add(p);
  }
  const converted = matured.filter((p) => credited.has(p)).length;
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

const falseMemoryUuidReadSchema = zod.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const falseMemoryEpisodesReadSchema = zod.array(zod.object({
  id: falseMemoryUuidReadSchema,
  user_id: falseMemoryUuidReadSchema,
  state: zod.string(),
}));
const falseMemoryLinksReadSchema = zod.array(zod.object({
  episode_id: falseMemoryUuidReadSchema,
  user_id: falseMemoryUuidReadSchema,
  source_id: zod.string(),
}));
const falseMemoryKeptReadSchema = zod.array(zod.object({
  id: falseMemoryUuidReadSchema,
  owner_id: falseMemoryUuidReadSchema,
  state: zod.string().nullable(),
  starts_at: zod.string().nullable(),
  ends_at: zod.string().nullable(),
  location_city: zod.string().nullable(),
  location_country: zod.string().nullable(),
}));
const falseMemoryMergeReadSchema = zod.array(zod.object({
  new_memory_id: falseMemoryUuidReadSchema,
}));

async function guardFalseMemorySource<T>(source: string, read: () => Promise<Read<T>>): Promise<Read<T>> {
  try {
    return await read();
  } catch {
    return { ok: false, blockedBy: `the false_memory_rate read failed: ${source} could not be read` };
  }
}

async function readLinks(sc: SupabaseClient, snapshot: readonly SurfacedCandidate[]): Promise<Read<Map<string, string[]>>> {
  return guardFalseMemorySource("memory_evidence", async () => {
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
      if (error !== null) return { ok: false, blockedBy: "memory_evidence could not be read, so which candidates were kept is unknown" };
      if (Array.isArray(data) && data.length >= READ_PAGE) return { ok: false, blockedBy: "the memory_evidence read may be truncated, so which candidates were kept is incomplete" };
      const rows = falseMemoryLinksReadSchema.safeParse(data);
      if (!rows.success) return { ok: false, blockedBy: "memory_evidence returned malformed rows, so which candidates were kept is unknown" };
      for (const row of rows.data) {
        if (ownerOf.get(row.episode_id) !== row.user_id) continue;
        const list = links.get(row.episode_id) ?? [];
        list.push(row.source_id);
        links.set(row.episode_id, list);
      }
    }
    return { ok: true, value: links };
  });
}

/** The surfaced episodes as stored now. A row that is gone is an erased episode, not an undecided one. */
async function readEpisodes(sc: SupabaseClient, snapshot: readonly SurfacedCandidate[]): Promise<Read<Map<string, EpisodeState>>> {
  return guardFalseMemorySource("memory_episodes", async () => {
    const out = new Map<string, EpisodeState>();
    for (const ids of chunks(snapshot.map((s) => s.episodeId), ID_CHUNK)) {
      const { data, error } = await sc
        .from("memory_episodes")
        .select("id, user_id, state")
        .in("id", ids)
        .limit(READ_PAGE);
      if (error !== null) return { ok: false, blockedBy: "memory_episodes could not be read, so which candidates were decided is unknown" };
      const rows = falseMemoryEpisodesReadSchema.safeParse(data);
      if (!rows.success) return { ok: false, blockedBy: "memory_episodes returned malformed rows, so which candidates were decided is unknown" };
      for (const row of rows.data) {
        out.set(row.id, { ownerId: row.user_id, state: row.state });
      }
    }
    return { ok: true, value: out };
  });
}

async function readKeptMemories(sc: SupabaseClient, ids: readonly string[]): Promise<Read<Map<string, KeptMemoryState>>> {
  return guardFalseMemorySource("memories", async () => {
    const out = new Map<string, KeptMemoryState>();
    for (const chunk of chunks(ids, ID_CHUNK)) {
      const { data, error } = await sc
        .from("memories")
        .select("id, owner_id, state, starts_at, ends_at, location_city, location_country")
        .in("id", chunk)
        .limit(READ_PAGE);
      if (error !== null) return { ok: false, blockedBy: "memories could not be read, so whether a kept candidate was corrected is unknown" };
      const rows = falseMemoryKeptReadSchema.safeParse(data);
      if (!rows.success) return { ok: false, blockedBy: "memories returned malformed rows, so whether a kept candidate was corrected is unknown" };
      for (const row of rows.data) {
        out.set(row.id, {
          id: row.id,
          ownerId: row.owner_id,
          state: row.state,
          startsAt: row.starts_at,
          endsAt: row.ends_at,
          city: row.location_city,
          country: row.location_country,
        });
      }
    }
    return { ok: true, value: out };
  });
}

/** Memories that absorbed another. 3676 unapplied ⇒ the table is absent ⇒ no merge can have happened. */
async function readMergeSurvivors(sc: SupabaseClient, ids: readonly string[]): Promise<Read<Set<string>>> {
  return guardFalseMemorySource("memory_id_redirects", async () => {
    const out = new Set<string>();
    for (const chunk of chunks(ids, ID_CHUNK)) {
      const { data, error } = await sc
        .from("memory_id_redirects")
        .select("new_memory_id")
        .eq("reason", "merged")
        .in("new_memory_id", chunk)
        .limit(READ_PAGE);
      if (error !== null) {
        if (isTableAbsentError(error)) return { ok: true, value: out };
        return { ok: false, blockedBy: "memory_id_redirects could not be read, so a merged Memory cannot be told from a corrected one" };
      }
      if (Array.isArray(data) && data.length >= READ_PAGE) return { ok: false, blockedBy: "the memory_id_redirects read may be truncated" };
      const rows = falseMemoryMergeReadSchema.safeParse(data);
      if (!rows.success) return { ok: false, blockedBy: "memory_id_redirects returned malformed rows, so a merged Memory cannot be told from a corrected one" };
      for (const row of rows.data) out.add(row.new_memory_id);
    }
    return { ok: true, value: out };
  });
}

/** false_memory_rate over what this process surfaced, corrected as the database says now. Never throws. */
export async function readFalseMemoryRate(sc: SupabaseClient): Promise<FalseMemoryRateResult> {
  const snapshot = [...surfaced.values()];
  const evicted = surfacedEvicted;
  if (snapshot.length === 0) {
    return computeFalseMemoryRate({ surfaced: snapshot, episodes: new Map(), links: new Map(), memories: new Map(), mergeSurvivors: new Set(), evicted });
  }
  try {
    const episodes = await readEpisodes(sc, snapshot);
    if (!episodes.ok) return unreadableFm(snapshot, evicted, episodes.blockedBy);
    const links = await readLinks(sc, snapshot);
    if (!links.ok) return unreadableFm(snapshot, evicted, links.blockedBy);
    const memoryIds = [...new Set([...links.value.values()].flat())];
    const memories = await readKeptMemories(sc, memoryIds);
    if (!memories.ok) return unreadableFm(snapshot, evicted, memories.blockedBy);
    const survivors = await readMergeSurvivors(sc, memoryIds);
    if (!survivors.ok) return unreadableFm(snapshot, evicted, survivors.blockedBy);
    return computeFalseMemoryRate({ surfaced: snapshot, episodes: episodes.value, links: links.value, memories: memories.value, mergeSurvivors: survivors.value, evicted });
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, "metrics: false_memory_rate read threw");
    return unreadableFm(snapshot, evicted, "the false_memory_rate read failed");
  }
}

const savedPlacesReadSchema = zod.array(zod.object({
  user_id: zod.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
  place_id: zod.string().nullable(),
  saved_at: zod.string().datetime({ offset: true }).refine((value) => Number.isFinite(Date.parse(value))),
}));

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
      if (error !== null) return unreadable("trip_saved_places could not be read, so no conversion is reported");
      if (Array.isArray(data) && data.length >= READ_PAGE) return unreadable("the trip_saved_places read may be truncated, so no conversion is reported");
      const rows = savedPlacesReadSchema.safeParse(data);
      if (!rows.success) return unreadable("trip_saved_places returned malformed rows, so no conversion is reported");
      for (const row of rows.data) {
        if (row.place_id === null) continue;
        saves.push({ userId: row.user_id, placeId: row.place_id, savedAtMs: Date.parse(row.saved_at) });
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
