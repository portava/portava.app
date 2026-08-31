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
  type ConfidenceBand,
  type SourceClass,
} from "./intelContracts.js";
import { logger } from "./logger.js";

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
}

/**
 * The source class of a Phase-1 live snapshot.
 *
 * Enrichment seam. The projection output (intel_state_snapshots, migration 2130)
 * carries NO source_class column today, and readLiveClaims does not SELECT one, so
 * `row.source_class` is undefined here and this returns the honest Phase-1 default
 * (IntelCaptureService only ever emits firsthand_unverified). When the projection
 * begins recording a source class — verified presence, official, imported — this
 * reads it, but only a KNOWN canonical value; an unrecognised label falls back to
 * the default rather than being trusted or mislabelled.
 *
 * Wiring the read now (rather than hard-coding the constant) is what lets
 * mayRenderAsLive / mayCountAsConsensus in the callers actually bite the instant a
 * real class flows: a historical_pattern or portava_prediction is dropped before
 * it can reach a Live label, and a single official/sponsored party gets no
 * community-consensus badge.
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
    state: c.band === "live" || c.band === "strong" ? "live" : "emerging",
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
    let q = sc
      .from("intel_state_snapshots")
      .select("id, zone_id, claim_type, value, confidence, source_count, observed_at, expires_at, privacy_eligible")
      .eq("subject_id", subjectId)
      .eq("privacy_eligible", true)
      .gt("expires_at", now.toISOString());
    if (opts.claimTypes && opts.claimTypes.length > 0) {
      q = q.in("claim_type", opts.claimTypes);
    }
    const { data, error } = await q;
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
      const confidence = typeof row.confidence === "number" ? row.confidence : null;
      const band = confidenceBand(confidence);
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
