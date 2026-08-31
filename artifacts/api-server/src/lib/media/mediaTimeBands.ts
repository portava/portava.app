/**
 * mediaTimeBands — the §17 Time Architecture for the Media v2 timeline.
 *
 *   ● EARLIER ─── ● NOW ─── ○ TYPICAL ─── ○ LIKELY-NEXT
 *   observed       gated       pattern        forecast
 *   (media)        (live)      (typical)      (predicted, carries confidence)
 *
 * This module CONSUMES the intel time substrate (lib/intelContracts) and the
 * gated live-claim read (lib/liveClaimRead). It owns NO truth and it opens no
 * client: the assembly is pure, and the ONE I/O function (readIntelTimeSubstrate)
 * takes the service client as an argument and only ever SELECTs. It never writes,
 * and it is deliberately NOT on the live-serving path — Typical and Likely-Next
 * are statements about the pattern and the future, so they are read WITHOUT the
 * live-label flag chain and can NEVER carry a live label.
 *
 * ── THE ONE RULE THIS FILE EXISTS TO ENFORCE (§2/§17/§31) ────────────────────
 * A prediction or a historical pattern is NEVER rendered as a current
 * observation. intelContracts.mayRenderAsLive is the single predicate; the four
 * bands are built so that:
 *   • only the NOW band may be `live`, and only from the gated live-claim read
 *     (which has already dropped every non-observation source class);
 *   • Typical items are tagged historical_pattern and Likely-Next items are
 *     tagged portava_prediction — both NON_OBSERVATION source classes — and both
 *     bands are constructed with live:false, forecast set appropriately;
 *   • a forecast (Likely-Next) MUST carry a confidence band; a predicted item
 *     with no derivable confidence is OMITTED, never surfaced bare (§17);
 *   • findNeverLiveViolations() is the executable backstop: hand it a band that
 *     tags a prediction/typical item as live and it returns a violation. The
 *     assembler runs it and DROPS any violating item (fail-closed, logged — the
 *     scrubPreciseLocation pattern), so a regression cannot leak a
 *     prediction-as-live to a client even if some future edit set the flag.
 */

import type { MediaProjection } from "./mediaProjection.js";
import type { LiveClaimEnvelope } from "../liveClaimRead.js";
import {
  confidenceBand,
  mayRenderAsLive,
  PILOT_CLAIMABLE_MODERATION_STATES,
  SOURCE_CLASS_LABELS,
  SOURCE_CLASSES,
  type ConfidenceBand,
  type SourceClass,
} from "../intelContracts.js";
import { logger } from "../logger.js";

// ── Client-facing render class (§46 distinct visual treatments) ──────────────
/**
 * The coarse rendering bucket the client keys distinct visual treatments off.
 * Orthogonal to (and coarser than) the intel SourceClass carried on each item:
 *   observed  → firsthand media / a gated live observation
 *   typical   → a historical_pattern ("typically…") — NOT live
 *   predicted → a portava_prediction forecast ("likely next") — NOT live, carries confidence
 */
export type TimeBandKind = "earlier" | "now" | "typical" | "likelyNext";
export type TimeBandRenderClass = "observed" | "typical" | "predicted";

/** One item on a time band. A discriminated-ish shape so the four kinds share a rail. */
export interface TimeBandItem {
  itemKind: "media" | "liveClaim" | "pattern" | "prediction";
  /** Coarse client render bucket (§46). */
  renderClass: TimeBandRenderClass;
  /**
   * The intel epistemic class, when the item comes from intel. Null for observed
   * media. This is what the never-live invariant checks: an item may be `live`
   * ONLY when mayRenderAsLive(intelSourceClass) is true.
   */
  intelSourceClass: SourceClass | null;
  /** Observed/derivation time — the temporal-envelope observed_at. Always timestamped. */
  observedAt: string;
  /** Coarse human label — never a coordinate. */
  label: string | null;
  claimType: string | null;
  /** The claim / pattern / prediction value. Null for observed media (the media object carries it). */
  value: unknown | null;
  /** The projected media object for an observed item; null otherwise. Coarse by construction. */
  media: MediaProjection | null;
  /** Forecast confidence in [0,1]. Non-null and finite for EVERY prediction (§17). */
  confidence: number | null;
  /** The display confidence band. Non-null for every prediction (§17). */
  confidenceBand: ConfidenceBand | null;
  /**
   * True ONLY for a gated live observation in the NOW band. Hard-false on every
   * Earlier / Typical / Likely-Next item — the truth boundary.
   */
  live: boolean;
}

/** One of the four §17 bands. */
export interface TimeBand {
  key: TimeBandKind;
  label: string;
  renderClass: TimeBandRenderClass;
  /** True only for NOW, and only when the gated live read served a claim. */
  live: boolean;
  /** True only for Likely-Next. */
  forecast: boolean;
  count: number;
  items: TimeBandItem[];
}

export interface MediaTimeBands {
  earlier: TimeBand;
  now: TimeBand;
  typical: TimeBand;
  likelyNext: TimeBand;
}

/** A gated live current-state, as read by lib/liveClaimRead (never fabricated here). */
export interface NowLiveState {
  /** True only when the gated path served ≥ 1 live claim. */
  available: boolean;
  liveClaims: LiveClaimEnvelope[];
  crowdLabel: string | null;
}

/**
 * A row from the intel time substrate (intel_observations), already gated for
 * moderation/freshness/visibility by readIntelTimeSubstrate. Carries only the
 * derived intelligence — never an actor id, coordinate, or raw evidence.
 */
export interface IntelTimeRow {
  id: string;
  claimType: string;
  value: unknown;
  sourceClass: SourceClass;
  observedAt: string;
  /** Optional device capture time (temporal envelope); informational. */
  capturedAt: string | null;
  /** Freshness horizon; null = no expiry. */
  expiresAt: string | null;
}

export interface IntelTimeSubstrate {
  /** source_class = historical_pattern. */
  typicalRows: IntelTimeRow[];
  /** source_class = portava_prediction. */
  predictedRows: IntelTimeRow[];
}

const MAX_BAND_ITEMS = 40;

// ── Intel time substrate read (the ONE I/O function; READ-ONLY over intel) ────

/** The two source classes that back Typical / Likely-Next. Both NON_OBSERVATION. */
const TIME_SUBSTRATE_SOURCE_CLASSES = ["historical_pattern", "portava_prediction"] as const;

/**
 * The visibilities a system time-pattern / prediction may be served under. These
 * are derived aggregates, not one person's private report, so only the
 * genuinely-public serving classes qualify. Fail-closed: anything else is dropped.
 */
const PUBLIC_SERVABLE_VISIBILITIES: ReadonlySet<string> = new Set(["public", "aggregate_only"]);

/**
 * Read the intel time substrate for a place — the historical_pattern (Typical)
 * and portava_prediction (Likely-Next) observations — READ-ONLY.
 *
 * This is deliberately OFF the live-serving path: it does not consult the
 * live-label flag chain (Typical/Predicted are never live, so gating them behind
 * the live switch would be wrong), but it DOES apply the same fail-closed
 * eligibility the projection aggregator uses — moderation whitelist, freshness
 * (expires_at), and a public-serving visibility — so a restricted, stale, or
 * private row can never reach a band. Any read error yields an EMPTY substrate
 * (well-formed empty bands), never a partial or fabricated one.
 */
export async function readIntelTimeSubstrate(
  sc: any,
  placeId: string | null | undefined,
  nowMs: number,
): Promise<IntelTimeSubstrate> {
  const empty: IntelTimeSubstrate = { typicalRows: [], predictedRows: [] };
  if (!sc || !placeId) return empty;

  const nowIso = new Date(nowMs).toISOString();
  let rows: any[] = [];
  try {
    const { data, error } = await sc
      .from("intel_observations")
      .select(
        "id, claim_type, value, source_class, visibility, moderation_state, observed_at, captured_at, expires_at",
      )
      .eq("subject_id", placeId)
      .in("source_class", TIME_SUBSTRATE_SOURCE_CLASSES as unknown as string[])
      .in("moderation_state", PILOT_CLAIMABLE_MODERATION_STATES as unknown as string[]);
    if (error || !Array.isArray(data)) {
      logger.warn({ err: error }, "mediaTimeBands: intel substrate read failed");
      return empty;
    }
    rows = data;
  } catch (err) {
    logger.warn({ err }, "mediaTimeBands: intel substrate read threw");
    return empty;
  }

  const typicalRows: IntelTimeRow[] = [];
  const predictedRows: IntelTimeRow[] = [];
  for (const r of rows) {
    const sourceClass = r?.source_class;
    // Only the two known non-observation classes; ignore anything unexpected.
    if (!(SOURCE_CLASSES as readonly string[]).includes(sourceClass)) continue;
    if (!(TIME_SUBSTRATE_SOURCE_CLASSES as readonly string[]).includes(sourceClass)) continue;
    // Freshness: null expiry = no horizon; otherwise must be in the future.
    if (r.expires_at != null && !(String(r.expires_at) > nowIso)) continue;
    // Public-serving visibility only (fail-closed).
    if (!PUBLIC_SERVABLE_VISIBILITIES.has(String(r.visibility ?? ""))) continue;
    const observedAt = typeof r.observed_at === "string" ? r.observed_at : nowIso;
    const row: IntelTimeRow = {
      id: String(r.id),
      claimType: String(r.claim_type),
      value: r.value,
      sourceClass: sourceClass as SourceClass,
      observedAt,
      capturedAt: typeof r.captured_at === "string" ? r.captured_at : null,
      expiresAt: typeof r.expires_at === "string" ? r.expires_at : null,
    };
    if (sourceClass === "historical_pattern") typicalRows.push(row);
    else predictedRows.push(row);
  }

  // Newest derivation first, deterministic.
  const byObservedDesc = (a: IntelTimeRow, b: IntelTimeRow): number =>
    a.observedAt < b.observedAt ? 1 : a.observedAt > b.observedAt ? -1 : a.id < b.id ? -1 : 1;
  typicalRows.sort(byObservedDesc);
  predictedRows.sort(byObservedDesc);
  return { typicalRows, predictedRows };
}

// ── Confidence extraction for forecasts (§17: forecasts carry confidence) ─────
/**
 * Derive a forecast's confidence in [0,1], or null when none is present.
 *
 * intel_observations carries no confidence COLUMN, so a prediction's confidence
 * rides in its value payload (`value.confidence`) — the convention a
 * portava_prediction producer emits. A future top-level `confidence` field is
 * also honoured. Anything non-finite or out of [0,1] yields null, and a null
 * makes toPredictedItem OMIT the prediction: a forecast without confidence is not
 * allowed to surface.
 */
export function extractForecastConfidence(row: IntelTimeRow): number | null {
  const candidates: unknown[] = [
    (row as unknown as { confidence?: unknown }).confidence,
    row.value && typeof row.value === "object" ? (row.value as Record<string, unknown>).confidence : undefined,
  ];
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c) && c >= 0 && c <= 1) return c;
  }
  return null;
}

/** A coarse, safe label for an intel time row. Never a coordinate. */
function labelForIntelRow(row: IntelTimeRow): string {
  const base = SOURCE_CLASS_LABELS[row.sourceClass] ?? row.claimType;
  return `${base} · ${row.claimType}`;
}

// ── Item builders ─────────────────────────────────────────────────────────────

/** An observed media item for the EARLIER band (historical, timestamped, never live). */
export function toEarlierItem(m: MediaProjection): TimeBandItem {
  return {
    itemKind: "media",
    renderClass: "observed",
    intelSourceClass: null,
    observedAt: m.capturedAt,
    label: m.placeLabel ?? m.neighborhood ?? m.city ?? null,
    claimType: null,
    value: null,
    media: m,
    confidence: null,
    confidenceBand: null,
    live: false,
  };
}

/** A gated live observation for the NOW band. This is the ONLY item that may be live. */
export function toNowItem(env: LiveClaimEnvelope): TimeBandItem {
  return {
    itemKind: "liveClaim",
    renderClass: "observed",
    intelSourceClass: env.sourceClass,
    observedAt: env.observedAt,
    label: env.claimType,
    claimType: env.claimType,
    value: env.value,
    media: null,
    confidence: env.confidence,
    confidenceBand: env.band,
    // Gated: the live-claim read has already dropped every non-observation class,
    // so this is honestly live. The never-live invariant re-checks it anyway.
    live: true,
  };
}

/** A historical-pattern item for the TYPICAL band. Explicitly NOT live. */
export function toTypicalItem(row: IntelTimeRow): TimeBandItem {
  return {
    itemKind: "pattern",
    renderClass: "typical",
    intelSourceClass: "historical_pattern",
    observedAt: row.observedAt,
    label: labelForIntelRow(row),
    claimType: row.claimType,
    value: row.value,
    media: null,
    confidence: null,
    confidenceBand: null,
    live: false,
  };
}

/**
 * A prediction item for the LIKELY-NEXT band, or null when it carries no
 * confidence. A forecast MUST carry a confidence band (§17); a bare prediction is
 * omitted rather than surfaced. Explicitly NOT live.
 */
export function toPredictedItem(row: IntelTimeRow): TimeBandItem | null {
  const confidence = extractForecastConfidence(row);
  if (confidence === null) return null; // forecast without confidence ⇒ omitted
  return {
    itemKind: "prediction",
    renderClass: "predicted",
    intelSourceClass: "portava_prediction",
    observedAt: row.observedAt,
    label: labelForIntelRow(row),
    claimType: row.claimType,
    value: row.value,
    media: null,
    confidence,
    confidenceBand: confidenceBand(confidence),
    live: false,
  };
}

// ── Never-live invariant (the truth boundary, executable) ────────────────────

export interface NeverLiveViolation {
  band: TimeBandKind;
  itemIndex: number;
  reason: string;
}

/**
 * Return every item that breaches the truth boundary. Empty === clean.
 *
 * A `live` item is a breach unless its intel source class may render as live
 * (mayRenderAsLive). So a Typical (historical_pattern) or Likely-Next
 * (portava_prediction) item marked live is ALWAYS a violation, as is any item
 * with no intel source class marked live outside the observed NOW rail. A
 * forecast (Likely-Next) missing its confidence band is a §17 violation too.
 *
 * This is deliberately NOT vacuous: mutate a predicted item's `live` to true and
 * this returns a violation (mediaTimeProjection.test proves it).
 */
export function findNeverLiveViolations(bands: MediaTimeBands): NeverLiveViolation[] {
  const out: NeverLiveViolation[] = [];
  const bandEntries: [TimeBandKind, TimeBand][] = [
    ["earlier", bands.earlier],
    ["now", bands.now],
    ["typical", bands.typical],
    ["likelyNext", bands.likelyNext],
  ];
  for (const [key, band] of bandEntries) {
    // Only NOW may be a live band.
    if (band.live && key !== "now") {
      out.push({ band: key, itemIndex: -1, reason: `band '${key}' is marked live; only 'now' may be live` });
    }
    band.items.forEach((item, i) => {
      if (item.live) {
        // An item may be live only if it is a real observation that may render as
        // live. A prediction / pattern (or an unclassified intel item) may not.
        if (item.intelSourceClass === null || !mayRenderAsLive(item.intelSourceClass)) {
          out.push({
            band: key,
            itemIndex: i,
            reason: `item is marked live but its source class '${item.intelSourceClass ?? "none"}' may not render as live`,
          });
        }
        // A live item outside the NOW band is a breach regardless of class.
        if (key !== "now") {
          out.push({ band: key, itemIndex: i, reason: `live item outside the 'now' band` });
        }
      }
      // A forecast must carry confidence (§17).
      if (key === "likelyNext" && (item.confidence === null || item.confidenceBand === null)) {
        out.push({ band: key, itemIndex: i, reason: `forecast item carries no confidence band (§17)` });
      }
    });
  }
  return out;
}

/**
 * Drop every truth-boundary-violating item, returning a clean copy and the count
 * removed. Fail-closed: in the healthy case nothing is removed. A caller that
 * removes > 0 should log — the leak is a regression, made visible not silent.
 */
export function enforceNeverLive(bands: MediaTimeBands): { bands: MediaTimeBands; removed: number } {
  const violations = findNeverLiveViolations(bands);
  if (violations.length === 0) return { bands, removed: 0 };

  // Group offending item indices per band (band-level live flags are corrected too).
  const dropByBand = new Map<TimeBandKind, Set<number>>();
  for (const v of violations) {
    if (v.itemIndex < 0) continue;
    const set = dropByBand.get(v.band) ?? new Set<number>();
    set.add(v.itemIndex);
    dropByBand.set(v.band, set);
  }

  let removed = 0;
  const clean = (key: TimeBandKind, band: TimeBand): TimeBand => {
    const drop = dropByBand.get(key);
    let items = band.items;
    if (drop && drop.size > 0) {
      items = band.items.filter((_, i) => !drop.has(i));
      removed += band.items.length - items.length;
    }
    // A non-now band can never be live; correct the flag as a backstop.
    const live = key === "now" ? band.live && items.some((it) => it.live) : false;
    return { ...band, items, count: items.length, live };
  };

  return {
    bands: {
      earlier: clean("earlier", bands.earlier),
      now: clean("now", bands.now),
      typical: clean("typical", bands.typical),
      likelyNext: clean("likelyNext", bands.likelyNext),
    },
    removed,
  };
}

// ── Assembly (pure) ───────────────────────────────────────────────────────────

export interface AssembleTimeBandsInput {
  /** Observed media, newest-first. Becomes the EARLIER band (historical record). */
  media: MediaProjection[];
  /** Gated live current-state. Becomes the NOW band; empty ⇒ no now label. */
  now: NowLiveState;
  /** Intel substrate rows, already gated. Become TYPICAL and LIKELY-NEXT. */
  substrate: IntelTimeSubstrate;
}

/**
 * Assemble the four §17 bands from already-fetched, already-gated inputs. Pure.
 * Runs the never-live backstop before returning — a prediction/pattern can never
 * leave here marked live, and every forecast carries a confidence band.
 */
export function assembleTimeBands(input: AssembleTimeBandsInput): {
  bands: MediaTimeBands;
  neverLiveRemoved: number;
} {
  const earlierItems = input.media.slice(0, MAX_BAND_ITEMS).map(toEarlierItem);
  const nowItems = input.now.available ? input.now.liveClaims.map(toNowItem) : [];
  const typicalItems = input.substrate.typicalRows.slice(0, MAX_BAND_ITEMS).map(toTypicalItem);
  // Predictions without confidence are omitted (§17).
  const predictedItems: TimeBandItem[] = [];
  for (const row of input.substrate.predictedRows.slice(0, MAX_BAND_ITEMS)) {
    const item = toPredictedItem(row);
    if (item) predictedItems.push(item);
  }

  const draft: MediaTimeBands = {
    earlier: {
      key: "earlier",
      label: "Earlier",
      renderClass: "observed",
      live: false,
      forecast: false,
      count: earlierItems.length,
      items: earlierItems,
    },
    now: {
      key: "now",
      label: "Now",
      renderClass: "observed",
      // Live ONLY when the gated read served a claim. No claim ⇒ no now label.
      live: input.now.available && nowItems.length > 0,
      forecast: false,
      count: nowItems.length,
      items: nowItems,
    },
    typical: {
      key: "typical",
      label: "Typically",
      renderClass: "typical",
      live: false,
      forecast: false,
      count: typicalItems.length,
      items: typicalItems,
    },
    likelyNext: {
      key: "likelyNext",
      label: "Likely next",
      renderClass: "predicted",
      live: false,
      forecast: true,
      count: predictedItems.length,
      items: predictedItems,
    },
  };

  const { bands, removed } = enforceNeverLive(draft);
  return { bands, neverLiveRemoved: removed };
}
