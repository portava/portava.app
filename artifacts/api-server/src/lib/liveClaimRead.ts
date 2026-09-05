/**
 * Live-claim read path (IG-05) — the one place a surface asks "what is true here
 * right now?".
 *
 * WHAT THIS REPLACES. routes/placeLiving.ts had TWO dead crowd-level reads:
 *   :241-242  `(group.place as any).best_time` / `.crowd_level`
 *   :582      `const crowdLevel = null; // populated by precompute worker`
 * `group.place` is a row from `places`, and `places` has no crowd_level or
 * best_time_to_go column — those live on `hidden_gems`. The `as any` casts
 * suppressed the type error, so both expressions always evaluated to null while
 * looking like real reads, and the worker at :582 never existed.
 *
 * Deleting them and reading here instead is BEHAVIOUR-PRESERVING: with the flag
 * off, or before any claim exists, this returns exactly the null those
 * expressions already produced. It does not start showing data — it gives the
 * surface a real wiring point for when claims begin to flow.
 *
 * THREE GATES, ALL FAIL-CLOSED, IN THIS ORDER:
 *   1. the `intel_live_label_crowd` flag (absent or unreadable => off);
 *   2. `privacy_eligible` on the snapshot row — the projection sets this only
 *      after lib/privacyGate.ts passes, and this read refuses anything else even
 *      if it somehow got written;
 *   3. `expires_at` — an expired snapshot is not live, and a claim past its TTL
 *      degrades to "unknown" rather than to a stale value presented as current.
 *
 * The degradation order the spec requires is Live -> Likely current ->
 * Historical -> Official -> Unknown. This module only ever returns a LIVE label
 * or null. It never invents a weaker-but-still-confident answer, and it never
 * substitutes a historical pattern for an observation — that distinction is what
 * SOURCE_CLASSES and mayRenderAsLive() exist to protect.
 */
import { isFlagEnabled, isKillSwitchEngaged } from "./featureFlags.js";
import {
  confidenceBand,
  mayRenderAsLive,
  mayCountAsConsensus,
  SOURCE_CLASSES,
  MIN_BAND_FOR_LIVE_STATE,
  CONFIDENCE_BAND_FLOOR,
  PRIVACY_THRESHOLD_V1,
  type ConfidenceBand,
  type SourceClass,
} from "./intelContracts.js";
import { meetsKAnonymity } from "./kAnonymity.js";
import { logger } from "./logger.js";
import {
  normalizeConflictState,
  capForConflict,
  conflictBlock,
  type ConflictState,
  type ConflictBlock,
} from "./intelConflict.js";

export interface LiveClaim {
  /** Snapshot id — the provenance reference the "why" surface points at. */
  id: string;
  claimType: string;
  value: unknown;
  confidence: number | null;
  band: ConfidenceBand;
  /**
   * Epistemic standing of the derived claim. Phase-1 capture emits only
   * firsthand_unverified observations (IntelCaptureService hard-codes it and
   * presence is P0/off by default), and the projection reads those, so a live
   * snapshot is honestly firsthand_unverified. See `deriveSourceClass` for the
   * enrichment seam when presence-verified or official inputs begin to flow.
   */
  sourceClass: SourceClass;
  sourceCount: number;
  observedAt: string;
  expiresAt: string;
  /**
   * §10 conflict state of the cohort behind this snapshot (2275). When
   * 'material' the `confidence`/`band` above are ALREADY capped below the live
   * band by readLiveClaims — a strong Live label is never derivable from this
   * object. Pre-2275 rows read as 'none'. Optional so a LiveClaim built by
   * hand still compiles; toLiveClaimEnvelope normalises an absent value to
   * 'none'.
   */
  conflictState?: ConflictState;
  /** ISO — when the snapshot (and so its conflict state) was last recomputed. */
  conflictUpdatedAt?: string;
}

/**
 * The display state the read path may assign. `live` is RESERVED for a claim whose
 * evidence actually qualifies as live (confidence band 'live'/'strong', i.e. the
 * public-label-qualified state). A claim that clears the serve floor
 * (MIN_BAND_FOR_LIVE_STATE = likely_current) but not the live band is 'emerging' —
 * real, current, but not yet live-qualified. So a Phase-1 P0 claim (which caps at
 * the likely_current band) is honestly 'emerging', never overstated as 'live'.
 * 'typical'/'unknown' are reserved for a future fallback layer and for the client
 * to render when the array is empty.
 */
export type LiveState = "live" | "emerging" | "typical" | "unknown";

/** Coarse cohort-size bucket for the client. The EXACT count is the privacy
 *  parameter itself (dataRights: distinct_actors is restricted), so the envelope
 *  serves only a bucket. Every published aggregate is already ≥ the k=15 floor. */
export type SourceCountBucket = "few" | "several" | "many";
export function sourceCountBucket(n: number): SourceCountBucket {
  if (n < 25) return "few";
  if (n < 100) return "several";
  return "many";
}

/**
 * The client-facing, decision-exposure shape for one live claim (what
 * `placeLiving.liveClaims[]` carries). Deliberately derived intelligence only —
 * NO contributor ids, coordinates, raw GPS evidence, visibility, or k-anonymity
 * internals (distinct_actors) ever appear here.
 */
export interface LiveClaimEnvelope {
  id: string;
  claimType: string;
  value: unknown;
  confidence: number | null;
  band: ConfidenceBand;
  sourceClass: SourceClass;
  /** Coarse cohort-size bucket (few/several/many) — the exact count is withheld.
   *  NULL when the source class may not be counted as independent community
   *  consensus (mayCountAsConsensus false): a single official / sponsored /
   *  imported party talking about itself must not present a crowd-size badge that
   *  implies many independent reporters. Clients render null as "no consensus
   *  badge", showing only the source-class label. */
  sourceCountBucket: SourceCountBucket | null;
  observedAt: string;
  /** expires_at — the freshness horizon the client uses to degrade to unknown. */
  validUntil: string;
  state: LiveState;
  /**
   * §10 conflict state. 'material' ⇒ `state` is never 'live' and `band` is at
   * most likely_current (capped in readLiveClaims): the client renders
   * "Reports differ" wherever it would have rendered a Live label.
   */
  conflictState: ConflictState;
  /** Counts-only conflict block ({state, sidesCount, lastUpdated}); null when 'none'. */
  conflict: ConflictBlock | null;
}

/**
 * The source class of a live snapshot.
 *
 * intel_state_snapshots.source_class exists (migration 2279) and
 * lib/intelProjection now WRITES it from the cohort's real observations, so this
 * guard is load-bearing: a historical_pattern / portava_prediction is dropped
 * before it can reach a Live label (mayRenderAsLive), and a wholly
 * official/sponsored/imported cohort — one party talking about itself — gets no
 * community-consensus badge (mayCountAsConsensus).
 *
 * It was INERT until the select list below started projecting the column: the
 * query omitted `source_class`, so `row.source_class` was always undefined and
 * this always returned the default, whatever the projection had recorded.
 *
 * Only a KNOWN canonical value is trusted; an unrecognised label — and a row
 * from a schema where the column is not yet applied — falls back to the honest
 * Phase-1 default (IntelCaptureService's own class for an undisclosed report)
 * rather than being trusted or mislabelled.
 */
function deriveSourceClass(row: Record<string, unknown>): SourceClass {
  const raw = row?.source_class;
  if (typeof raw === "string" && (SOURCE_CLASSES as readonly string[]).includes(raw)) {
    return raw as SourceClass;
  }
  return "firsthand_unverified";
}

/**
 * Deterministic ordering: best/current first — highest confidence, then most
 * recently observed, then claim_type for a total order (§ IG ranking).
 */
function compareLiveClaims(a: LiveClaim, b: LiveClaim): number {
  const ca = a.confidence ?? -1;
  const cb = b.confidence ?? -1;
  if (cb !== ca) return cb - ca;
  if (a.observedAt !== b.observedAt) return a.observedAt < b.observedAt ? 1 : -1;
  return a.claimType < b.claimType ? -1 : a.claimType > b.claimType ? 1 : 0;
}

/** Shape a live claim into the client-facing envelope (derived fields only). */
export function toLiveClaimEnvelope(c: LiveClaim): LiveClaimEnvelope {
  // Re-normalised here so a LiveClaim built by hand (tests, future callers)
  // without the field reads as 'none' rather than as an undefined state.
  const conflictState = normalizeConflictState(c.conflictState);
  return {
    id: c.id,
    claimType: c.claimType,
    value: c.value,
    confidence: c.confidence,
    band: c.band,
    sourceClass: c.sourceClass,
    // A consensus / cohort badge is only honest for a class that CAN be
    // independent community consensus. For official_signed / sponsored /
    // imported_owned — one party talking about itself — withhold the bucket (null)
    // rather than imply a crowd. mayCountAsConsensus is the single rule.
    sourceCountBucket: mayCountAsConsensus(c.sourceClass) ? sourceCountBucket(c.sourceCount) : null,
    observedAt: c.observedAt,
    validUntil: c.expiresAt,
    // 'live' ONLY when the evidence qualifies (band live/strong); a claim that
    // cleared the serve floor but not the live band is 'emerging'. readLiveClaims
    // already dropped anything below the serve floor and anything expired.
    // A MATERIAL conflict is never 'live' (§10 "suppress strong Live label") —
    // readLiveClaims already capped the band, and this guard makes the rule
    // hold for any LiveClaim built by hand too.
    state: conflictState !== "material" && (c.band === "live" || c.band === "strong") ? "live" : "emerging",
    conflictState,
    conflict: conflictBlock(conflictState, typeof c.conflictUpdatedAt === "string" ? c.conflictUpdatedAt : c.observedAt),
  };
}

/**
 * Read the currently-live claims for a place. Returns an empty array whenever
 * anything is off, missing, expired or not privacy-eligible — never a partial
 * or stale answer dressed as current.
 */
// ── Per-scope Live promotion allowlist (short TTL cache) ──────────────────────
// Which (zone × claim) scopes are promoted for Live. Cached briefly so the
// per-place read path does not query the table on every call. Fail-closed: an
// error yields an empty set (nothing serves) and is NOT cached.
let _promotedScopeCache: { at: number; keys: Set<string> } | null = null;
const PROMOTED_SCOPE_TTL_MS = 30_000;

async function loadPromotedScopes(sc: any, now: Date): Promise<Set<string>> {
  const t = now.getTime();
  if (_promotedScopeCache && t - _promotedScopeCache.at < PROMOTED_SCOPE_TTL_MS) {
    return _promotedScopeCache.keys;
  }
  try {
    const { data, error } = await sc.from("intel_live_promoted_scopes").select("scope_key");
    if (error || !data) return new Set(); // fail-closed; do not cache an error
    const keys = new Set(((data as any[]) ?? []).map((r) => String(r.scope_key)));
    _promotedScopeCache = { at: t, keys };
    return keys;
  } catch {
    return new Set();
  }
}

/** Test hook — clears the promoted-scope allowlist cache. */
export function _clearPromotedScopeCache(): void { _promotedScopeCache = null; }

/**
 * The GLOBAL Live-label gates: the flag dependency chain, the emergency kill
 * switch, and the IG-09 pilot master switch. True only when Live intelligence may
 * be served AT ALL right now — independent of any particular subject, scope or
 * snapshot. Fail-closed: a missing/unreadable flag, or an engaged kill switch,
 * returns false.
 *
 * ONE gate, TWO readers. `readLiveClaims` consults it before touching a snapshot,
 * and `routes/placeLiving.ts` consults it again at cache-SERVE time. That second
 * reader is the whole point: place_living_cache bakes the Live label in at compute
 * time and serves it stale-while-revalidate for up to the 24h sparse TTL, so a
 * label written before the kill switch was thrown would keep serving until its TTL
 * unless the serve path re-checks these gates. Sharing this one function is what
 * stops the compute path and the serve path from disagreeing about whether Live is
 * live.
 *
 * The flag args are LITERAL so scripts/check-flag-polarity.mjs resolves each stop:
 *   • intel_live_label_crowd depends on intel_claim_projection_crowd, which depends
 *     on intel_capture_quick_signal (INTEL_FLAG_DEPENDENCIES) — serving a Live
 *     label while projection is OFF keeps re-serving already-written snapshots
 *     until their TTL, the exact unsafe combination the chain forbids;
 *   • disable_intel_live_labels is the global emergency stop, read as a kill switch
 *     so a DB error ENGAGES it (suppresses without deleting records);
 *   • intel_limited_live is the IG-09 pilot master switch. Per-scope promotion (a
 *     scope clearing the §26 density gate) is enforced separately, per snapshot, in
 *     readLiveClaims — this only answers the global question.
 */
export async function liveLabelsServable(sc: any): Promise<boolean> {
  if (!sc) return false;
  if (!(await isFlagEnabled(sc, "intel_live_label_crowd"))) return false;
  if (!(await isFlagEnabled(sc, "intel_claim_projection_crowd"))) return false;
  if (!(await isFlagEnabled(sc, "intel_capture_quick_signal"))) return false;
  if (await isKillSwitchEngaged(sc, "disable_intel_live_labels")) return false;
  if (!(await isFlagEnabled(sc, "intel_limited_live"))) return false;
  return true;
}

/** The snapshot projection. `source_class` (2279) is REQUIRED, not optional —
 *  deriveSourceClass cannot enforce anything on a column that is never selected. */
export const SNAPSHOT_COLUMNS =
  "id, zone_id, claim_type, value, confidence, source_count, observed_at, expires_at, privacy_eligible, conflict_state, source_class, computed_at";
/** The same projection minus source_class, for a schema predating migration 2279. */
export const SNAPSHOT_COLUMNS_PRE_2279 =
  "id, zone_id, claim_type, value, confidence, source_count, observed_at, expires_at, privacy_eligible, conflict_state, computed_at";

/** True for the "this column does not exist" family (Postgres 42703 / PostgREST PGRST204). */
function isUndefinedColumnError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; message?: unknown };
  const code = typeof e.code === "string" ? e.code : "";
  if (code === "42703" || code === "PGRST204") return true;
  const msg = typeof e.message === "string" ? e.message.toLowerCase() : "";
  return msg.includes("source_class") && (msg.includes("does not exist") || msg.includes("could not find"));
}

export async function readLiveClaims(
  sc: any,
  subjectId: string | null | undefined,
  opts: { claimTypes?: readonly string[]; now?: Date } = {},
): Promise<LiveClaim[]> {
  if (!sc || !subjectId) return [];

  // The global Live-label gates (flag chain + kill switch + pilot master switch),
  // in ONE place so this compute path and the cache-serve path in placeLiving.ts
  // cannot drift. Fail-closed: any missing flag or an engaged kill switch → [].
  if (!(await liveLabelsServable(sc))) return [];

  const now = opts.now ?? new Date();

  // Per-scope gate: the global intel_limited_live flag is only the master switch.
  // A scope (zone × claim) serves Live ONLY when it is also PROMOTED in
  // intel_live_promoted_scopes. Without this the single global flag exposed every
  // scope at once (IG-09 requires per-scope promotion). Empty allowlist (or an
  // unreadable one) ⇒ nothing serves — fail-closed.
  const promotedScopes = await loadPromotedScopes(sc, now);
  if (promotedScopes.size === 0) return [];

  try {
    const runSnapshotQuery = async (columns: string) => {
      let q = sc
        .from("intel_state_snapshots")
        .select(columns)
        .eq("subject_id", subjectId)
        .eq("privacy_eligible", true)
        .gt("expires_at", now.toISOString());
      if (opts.claimTypes && opts.claimTypes.length > 0) {
        q = q.in("claim_type", opts.claimTypes);
      }
      return await q;
    };

    // source_class (2279) MUST be in the select list — deriveSourceClass's truth
    // boundary and the consensus-badge rule read it, and a column that is never
    // projected reads as undefined, which silently turned both guards off.
    let { data, error } = await runSnapshotQuery(SNAPSHOT_COLUMNS);
    if (error && isUndefinedColumnError(error)) {
      // Tolerate a schema where 2279 has not been applied yet: retry WITHOUT the
      // column instead of failing the whole read. No row can carry a class in
      // that schema, so deriveSourceClass's Phase-1 default is the honest answer
      // — and it is exactly the behaviour before 2279 existed.
      logger.warn({ err: error }, "liveClaimRead: source_class not present; reading without it");
      ({ data, error } = await runSnapshotQuery(SNAPSHOT_COLUMNS_PRE_2279));
    }
    if (error || !data) {
      // Fail-closed: an unreadable projection means "unknown", not "assume last known".
      logger.warn({ err: error }, "liveClaimRead: snapshot read failed");
      return [];
    }

    const out: LiveClaim[] = [];
    for (const row of data as any[]) {
      // Per-scope gate: only serve snapshots whose (zone, claim) scope is promoted.
      const scopeKey = `${(row.zone_id ?? "")}|${row.claim_type}`;
      if (!promotedScopes.has(scopeKey)) continue;
      // §10 material conflict (2275): cap the served (confidence, band) BELOW the
      // live band before anything else looks at it, so no consumer of this read
      // — envelope, wall strip, map projection, Compass context — can derive a
      // strong Live label from a materially-conflicted cohort. Only ever lowers;
      // a pre-2275 row (no column) reads as 'none' and is untouched. The capped
      // band still clears the serve floor, so the value continues to serve, as
      // 'emerging' with a "Reports differ" block — visible, not silently averaged.
      const conflictState = normalizeConflictState(row.conflict_state);
      const capped = capForConflict(conflictState, typeof row.confidence === "number" ? row.confidence : null, confidenceBand(typeof row.confidence === "number" ? row.confidence : null));
      const confidence = capped.confidence;
      const band = capped.band;
      // Below the live floor a claim is not shown as live at all.
      if (CONFIDENCE_BAND_FLOOR[band] < CONFIDENCE_BAND_FLOOR[MIN_BAND_FOR_LIVE_STATE]) continue;
      // Truth boundary (intelContracts.mayRenderAsLive): a class that is a
      // statement about the past or a likelihood — historical_pattern,
      // portava_prediction — must NEVER be presented as a current observation.
      // Drop it here rather than let it reach a Live label. Today deriveSourceClass
      // yields firsthand_unverified (which passes), so this is inert; it becomes
      // load-bearing the instant the enrichment seam supplies a real class.
      const sourceClass = deriveSourceClass(row);
      if (!mayRenderAsLive(sourceClass)) continue;
      out.push({
        id: String(row.id),
        claimType: String(row.claim_type),
        value: row.value,
        confidence,
        band,
        sourceClass,
        sourceCount: typeof row.source_count === "number" ? row.source_count : 0,
        observedAt: String(row.observed_at),
        expiresAt: String(row.expires_at),
        conflictState,
        // computed_at is when the projection last (re)assessed the cohort; fall
        // back to observed_at for a row that somehow lacks it.
        conflictUpdatedAt: typeof row.computed_at === "string" ? row.computed_at : String(row.observed_at),
      });
    }
    // Deterministic, best/current first.
    out.sort(compareLiveClaims);
    return out;
  } catch (err) {
    logger.warn({ err }, "liveClaimRead: snapshot read threw");
    return [];
  }
}

/**
 * The crowd level for a place, or null when it is not live.
 * Null is the honest answer and is what every caller rendered before this
 * existed — see the header.
 */
export async function readLiveCrowdLevel(
  sc: any,
  subjectId: string | null | undefined,
  opts: { now?: Date } = {},
): Promise<string | null> {
  const claims = await readLiveClaims(sc, subjectId, { claimTypes: ["crowd.level"], now: opts.now });
  const crowd = claims.find((c) => c.claimType === "crowd.level");
  if (!crowd) return null;
  // A bare string cannot carry a "Reports differ" marker, so serving the
  // plurality value here under a MATERIAL conflict would be exactly the silent
  // averaging §1 forbids. The rich envelope (readLiveClaimEnvelopes) still
  // serves the value WITH its conflict block; this legacy string is null.
  if (crowd.conflictState === "material") return null;
  const v = crowd.value as any;
  const level = typeof v === "string" ? v : v?.level;
  return typeof level === "string" && level.length > 0 ? level : null;
}

/**
 * The live claims for a place as client-facing envelopes (decision-exposure
 * shape), deterministically ordered best/current first. Returns [] in every
 * suppressed/empty case — same fail-closed contract as `readLiveClaims`, never
 * a fabricated or stale answer. This is what `placeLiving.liveClaims` serves;
 * the existing `crowdLevel` string is untouched and read separately, so the two
 * always agree (both come from this one projection) yet neither can break the
 * other.
 */
export async function readLiveClaimEnvelopes(
  sc: any,
  subjectId: string | null | undefined,
  opts: { claimTypes?: readonly string[]; now?: Date } = {},
): Promise<LiveClaimEnvelope[]> {
  const claims = await readLiveClaims(sc, subjectId, opts);
  return claims.map(toLiveClaimEnvelope);
}

// ══════════════════════════════════════════════════════════════════════════════
// IG-05 'typical' FALLBACK (spec §5 degradation order Live → … → Historical → …)
// ══════════════════════════════════════════════════════════════════════════════
/**
 * The degradation order the place card owes is Live → Likely current → Historical
 * → Official → Unknown. `readLiveClaims`/`readLiveClaimEnvelopes` cover the top
 * (live/emerging) and return [] otherwise. THIS is the next rung down: when no live
 * observation exists, a `historical_pattern` from intel_historical_patterns (§12)
 * answers "what is it TYPICALLY like right now?" — a 'typical' claim, NEVER a Live
 * one. Below it there is only 'unknown' (silence), which is the empty array.
 *
 * TRUTH BOUNDARY. A typical claim carries sourceClass 'historical_pattern', and
 * mayRenderAsLive('historical_pattern') is false — so even if one ever reached the
 * live path it would be dropped before a Live label. The client's liveState() maps
 * this class to 'Typical' and its own distinct colour, never 'Live'. This function
 * is the ONE producer of a 'typical' envelope; it does not touch the live gates
 * (a typical answer is available even when the Live pilot is off), and it fails
 * closed to [] on any error, so the honest fallback of last resort is 'unknown'.
 */
function padHour(h: number): string {
  return `hour_${String(h).padStart(2, "0")}`;
}

export async function readTypicalPatterns(
  sc: any,
  subjectId: string | null | undefined,
  opts: { claimTypes?: readonly string[]; now?: Date } = {},
): Promise<LiveClaimEnvelope[]> {
  if (!sc || !subjectId) return [];
  const now = opts.now ?? new Date();
  const dow = now.getUTCDay();
  const timeBand = padHour(now.getUTCHours());
  try {
    let q = sc
      .from("intel_historical_patterns")
      .select("id, zone_id, claim_family, pattern_kind, time_band, dow, value_json, confidence, cohort_size, distinct_contributors, window_days, is_invalidation, computed_at")
      .eq("subject_id", subjectId)
      .eq("time_band", timeBand)
      .eq("dow", dow)
      .order("computed_at", { ascending: false });
    if (opts.claimTypes && opts.claimTypes.length > 0) {
      q = q.in("claim_family", opts.claimTypes);
    }
    const { data, error } = await q;
    if (error || !data) {
      logger.warn({ err: error }, "liveClaimRead: pattern read failed");
      return [];
    }
    // Latest row per (zone, claim_family, pattern_kind) — the append-only store
    // supersedes by newer row. A tombstone (is_invalidation) that is the latest
    // row means "no typical pattern" for that scope, so it is skipped, not served.
    const seen = new Set<string>();
    const out: LiveClaimEnvelope[] = [];
    for (const row of data as any[]) {
      const scope = `${row.zone_id ?? ""}|${row.claim_family}|${row.pattern_kind}`;
      if (seen.has(scope)) continue; // an older row for a scope we already resolved
      seen.add(scope);
      if (row.is_invalidation === true) continue; // latest is a tombstone ⇒ no pattern

      // ── k-ANONYMITY FLOOR (the SAME one the live path enforces) ─────────────
      // The live rung publishes only snapshots the shared privacy gate marked
      // privacy_eligible, which is meetsKAnonymity(distinctActors,
      // PRIVACY_THRESHOLD_V1.minUniqueActors) plus the group clauses. This rung
      // had NO actor floor at all: the DB's Table-19 minimums count independent
      // VISITS and DATES, and 'typical_crowd_by_weekday_hour' sets
      // minContributors to 0 (lib/intelPatternLearning.PATTERN_MINIMUMS), so
      // eight visits by ONE person across four dates satisfied the CHECK and
      // served — a one-person routine, published with a cohort badge.
      //
      // Same constant, same helper, no second policy: below the floor the
      // pattern does not serve at all (and so can never carry a badge). The
      // scope is already in `seen`, so an older row for it is not served either
      // — the LATEST row governs, fail-closed. A row with no contributor count
      // reads as 0 and is withheld.
      const distinctContributors = typeof row.distinct_contributors === "number" ? row.distinct_contributors : 0;
      if (!meetsKAnonymity(distinctContributors, PRIVACY_THRESHOLD_V1.minUniqueActors)) continue;

      const confidence = typeof row.confidence === "number" ? row.confidence : null;
      const computedAt = String(row.computed_at);
      const windowDays = typeof row.window_days === "number" ? row.window_days : 0;
      const validUntil = new Date(Date.parse(computedAt) + windowDays * 24 * 60 * 60 * 1000).toISOString();
      out.push({
        id: String(row.id),
        claimType: String(row.claim_family),
        value: row.value_json,
        confidence,
        band: confidenceBand(confidence),
        // A pattern is always historical_pattern — the client renders it 'Typical'.
        sourceClass: "historical_pattern",
        // A pattern is a cohort aggregate over many independent contributors, so a
        // cohort badge is honest (mayCountAsConsensus true) — but only above the
        // k-floor checked above, which is what makes "many" true at all. The exact
        // count stays withheld; only the coarse bucket leaves.
        sourceCountBucket: mayCountAsConsensus("historical_pattern")
          ? sourceCountBucket(typeof row.cohort_size === "number" ? row.cohort_size : 0)
          : null,
        observedAt: computedAt,
        validUntil,
        state: "typical",
        // A historical pattern has no live cohort, so no §10 conflict to surface.
        conflictState: "none",
        conflict: null,
      });
    }
    return out;
  } catch (err) {
    logger.warn({ err }, "liveClaimRead: pattern read threw");
    return [];
  }
}

/** The resolved intel state for a place, in the spec's degradation order. */
export interface PlaceIntelState {
  /** 'live'/'emerging' if a live claim exists, else 'typical' if a pattern does, else 'unknown'. */
  state: LiveState;
  /** The claims backing `state` (live/emerging envelopes, or typical envelopes, or []). */
  claims: LiveClaimEnvelope[];
}

/**
 * Resolve a place's intel state along the degradation order: LIVE/EMERGING first
 * (the gated projection), then TYPICAL (a §12 pattern for the current weekday/hour),
 * then UNKNOWN (empty). One place composes the two reads so a caller cannot get the
 * order wrong — a typical answer is NEVER returned when a live one exists, and a
 * live answer is never downgraded to typical.
 */
export async function resolvePlaceIntelState(
  sc: any,
  subjectId: string | null | undefined,
  opts: { claimTypes?: readonly string[]; now?: Date } = {},
): Promise<PlaceIntelState> {
  const live = await readLiveClaimEnvelopes(sc, subjectId, opts);
  if (live.length > 0) {
    // 'live' if any claim is live-qualified, else 'emerging'.
    const anyLive = live.some((c) => c.state === "live");
    return { state: anyLive ? "live" : "emerging", claims: live };
  }
  const typical = await readTypicalPatterns(sc, subjectId, opts);
  if (typical.length > 0) return { state: "typical", claims: typical };
  return { state: "unknown", claims: [] };
}
