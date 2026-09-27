/**
 * mediaEvidenceEligibility — §35 Evidence-Safe Editing + §10 IntelligenceEligibility.
 *
 * PURE, DETERMINISTIC classifier. No DB, no network, no clock except an
 * injectable `now`. It answers one question the *future* media→intel evidence
 * seam depends on: is this media asset allowed to back a LIVE evidence claim?
 *
 * §35 rule (the crux):
 *   Original → crop / rotate / straighten / brightness / contrast / color-temp
 *              → NON-semantic edit → STILL evidence-eligible.
 *   Original → generative fill/expand, object add/remove, AI enhancement that
 *              invents content, heavy compositing, source_type 'generated'
 *              → STILL a valid SOCIAL asset, but NOT eligible as live evidence.
 *
 * FAIL-CLOSED: an edit whose operation name we do not recognize is treated as
 * `unknown` and makes the asset NOT evidence-eligible. You never want an
 * unclassified (possibly generative) edit to silently back a live claim. The
 * same posture applies to source: only an explicit first-party capture source
 * (camera / library / community) can be evidence; everything else is social-only.
 *
 * BOUNDARY: this module NEVER touches social usability. A generative edit stays
 * fully postable/servable social media (§35 "still valid social media"); the
 * only thing it loses is live-evidence eligibility. The object returned here
 * carries no moderation/visibility/social field and cannot downgrade a post.
 *
 * BOUNDARY: this module NEVER promotes anything to "live". §10's freshnessClass
 * union includes 'live', but the media side caps at 'fresh' — the "Live" label
 * is owned by the gated Live Intelligence path (lib/liveClaimRead.ts /
 * lib/intelLiveScope.ts), never manufactured from a raw media asset.
 *
 * §10 `expiresAt` / §11 `intelligenceExpiresAt` — THE ASSET'S OPERATIONAL
 * LIFETIME, STAMPED (2026-09-26). This module used to decline the field on the
 * ground that "intel expiry belongs to the observation/claim". That conflated
 * two different expiries. A CLAIM's TTL (lib/freshnessPolicy) says how long a
 * statement about a place stays current; it is owned by Live Intelligence and
 * nothing here touches it. The ASSET's `expiresAt` says something narrower and
 * media-owned: the instant after which this photograph can no longer back ANY
 * current claim, because it is no longer a picture of "now". That instant is
 * exactly where `computeFreshnessClass` already moves the asset to
 * 'historical' — so `expiresAt = capturedAt + INTELLIGENCE_OPERATIONAL_WINDOW_MS`,
 * stamped only on an ELIGIBLE asset (an ineligible one never had operational
 * value, so it has nothing to expire). A claim may still apply a SHORTER TTL of
 * its own; this is the ceiling, never an extension.
 *
 * It is ENFORCED, not decorative: `isOperationalEvidenceAt` is the gate the
 * evidence read side (lib/media/mediaEvidenceLink) applies, so an expired asset
 * cannot count as evidence for a current claim. `eligible` itself stays
 * time-independent on purpose — §35 eligibility is a property of source and
 * edit lineage, and lib/intel PresenceVerifier asks it about a receipt inside a
 * historical observation window, where "is it still operational NOW" is the
 * wrong question.
 *
 * §10 `locationConfidence` — DISTINGUISHES HOW THE LOCATION WAS ESTABLISHED.
 * It used to be `hasLocation ? 0.7 : 0.2`, so a server-verified GPS fix and a
 * hand-typed venue scored the same. `LocationBasis` carries which one it was,
 * derived from the post's OWN location provenance (`posts.location_source`
 * gps|manual|none and the server-decided `location_verified` /
 * `geotag_verified` — routes/posts.ts computes those from `verifyLocation`,
 * never from the client). `hasLocation` without a basis keeps its old value.
 */

import { FRESH_WINDOW_MS, RECENT_WINDOW_MS } from "./mediaFreshness.js";

// ── §6 source vocabulary ──────────────────────────────────────────────────────

/** §6 MediaAsset.sourceType, plus the legacy 'user' default shipped by 0191. */
export type MediaSourceType =
  | "camera"
  | "library"
  | "provider"
  | "official"
  | "community"
  | "generated"
  | "screenshot"
  | "derivative"
  | "user";

/**
 * The ONLY source types that can back live evidence: genuine first-party human
 * captures. Provider/official are third-party feeds (not a live observation),
 * legacy 'user' is provenance-ambiguous, and generated/derivative/screenshot
 * are not observations of the world at all. All of those are social-only.
 * Fail-closed: a source not in this set is never eligible.
 */
export const EVIDENCE_ELIGIBLE_SOURCE_TYPES: ReadonlySet<string> = new Set([
  "camera",
  "library",
  "community",
]);

/**
 * Source types that are affirmatively NOT observations (their eligibility
 * failure gets a distinct, explanatory reason). generated/derivative are
 * synthetic; screenshot is a capture of a screen, not of the world.
 */
export const NON_OBSERVATION_SOURCE_TYPES: ReadonlySet<string> = new Set([
  "generated",
  "derivative",
  "screenshot",
]);

// ── §35 edit taxonomy ─────────────────────────────────────────────────────────

/** How an edit affects evidence status. */
export type EditClass = "evidence_preserving" | "evidence_breaking" | "unknown";

/**
 * NON-SEMANTIC photographic adjustments: they change how the SAME captured
 * scene is rendered, they do not invent or move content. §35 keeps these
 * evidence-eligible.
 */
export const EVIDENCE_PRESERVING_EDITS: ReadonlySet<string> = new Set([
  "crop",
  "trim", // video crop-in-time
  "rotate",
  "straighten",
  "flip",
  "flip_horizontal",
  "flip_vertical",
  "exposure",
  "brightness",
  "contrast",
  "highlights",
  "shadows",
  "whites",
  "blacks",
  "saturation",
  "vibrance",
  "white_balance",
  "color_temperature",
  "temperature",
  "tint",
  "levels",
  "curves",
  "resize",
  "downscale",
  "compress",
  "format_convert",
  "transcode",
]);

/**
 * SEMANTIC / GENERATIVE alterations: they invent, remove, relocate, or
 * synthesize content, so the pixels no longer faithfully witness the scene.
 * §35 makes these social-only, never live evidence.
 */
export const EVIDENCE_BREAKING_EDITS: ReadonlySet<string> = new Set([
  "generative_fill",
  "generative_expand",
  "generative_edit",
  "generative_remove",
  "inpaint",
  "outpaint",
  "object_add",
  "object_remove",
  "object_removal",
  "content_aware_fill",
  "magic_eraser",
  "cleanup",
  "ai_enhance",
  "ai_upscale",
  "super_resolution",
  "face_swap",
  "face_edit",
  "deepfake",
  "background_replace",
  "background_removal",
  "sky_replace",
  "style_transfer",
  "relight",
  "composite",
  "splice",
  "blend",
  "ai_generate",
  "text_to_image",
  "img2img",
]);

/** Normalize an edit-op name: lowercase, trim, collapse spaces/hyphens to `_`. */
export function normalizeEditOp(op: string): string {
  return String(op ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

/**
 * Classify a single edit operation. Unrecognized ⇒ `unknown` (fail-closed): the
 * caller must treat unknown exactly like breaking for eligibility purposes.
 */
export function classifyEdit(op: string): EditClass {
  const n = normalizeEditOp(op);
  if (n === "") return "unknown";
  if (EVIDENCE_BREAKING_EDITS.has(n)) return "evidence_breaking";
  if (EVIDENCE_PRESERVING_EDITS.has(n)) return "evidence_preserving";
  return "unknown";
}

// ── Edit lineage / provenance model (§6 MediaProvenance) ──────────────────────

/** One appended edit in an asset's lineage. Append-only; never rewritten. */
export interface EditLineageEntry {
  /** Normalized operation name. */
  op: string;
  /** The original op string, only when it differs from the normalized form. */
  rawOp?: string;
  /** Evidence classification of this op (fail-closed to 'unknown'). */
  class: EditClass;
  /** ISO timestamp the edit was recorded. */
  at: string;
  /** Optional editing tool/app identifier. */
  tool?: string;
  /** Optional structured params (kept small; never raw GPS). */
  detail?: Record<string, unknown>;
}

/**
 * §10 locationConfidence input: HOW a media item's location was established.
 *
 *   verified_gps  a device GPS fix the SERVER verified against the tagged place
 *                 (`posts.location_source='gps'` AND `location_verified` or
 *                 `geotag_verified` — both server-decided in routes/posts.ts);
 *   gps           a device GPS fix, not (or not yet) verified;
 *   manual        a place the user typed or picked — a claim, not a measurement;
 *   none          no location at all.
 */
export type LocationBasis = "verified_gps" | "gps" | "manual" | "none";

export const LOCATION_BASES: readonly LocationBasis[] = ["verified_gps", "gps", "manual", "none"];

/**
 * The §10 scalar per basis. `gps` keeps the value the old `hasLocation: true`
 * produced (0.7) and `none` keeps the old `hasLocation: false` value (0.2), so
 * every row computed before the basis existed reads identically. The two new
 * rungs are the point: a verified fix is worth more than an unverified one, and
 * a hand-typed venue is worth barely more than nothing.
 */
export const LOCATION_CONFIDENCE_BY_BASIS: Readonly<Record<LocationBasis, number>> = {
  verified_gps: 0.9,
  gps: 0.7,
  manual: 0.3,
  none: 0.2,
};

export function isLocationBasis(v: unknown): v is LocationBasis {
  return typeof v === "string" && (LOCATION_BASES as readonly string[]).includes(v);
}

/**
 * Derive the basis from a post row's OWN location provenance. Reads only the
 * enum and the two server-decided booleans — never a coordinate. Fail-closed to
 * the weaker rung: an unknown `location_source` value is `none`, and `gps`
 * is only `verified_gps` when the server said so.
 */
export function locationBasisFromPost(row: {
  location_source?: unknown;
  location_verified?: unknown;
  geotag_verified?: unknown;
} | null | undefined): LocationBasis {
  const src = String(row?.location_source ?? "none");
  if (src === "gps") {
    return row?.location_verified === true || row?.geotag_verified === true ? "verified_gps" : "gps";
  }
  if (src === "manual") return "manual";
  return "none";
}

/**
 * §6 MediaProvenance: source + capture + edit lineage for one asset. This is the
 * shape stored in `media_assets.provenance` (jsonb).
 */
export interface MediaProvenance {
  sourceType: MediaSourceType;
  /** When the media was captured (may precede uploadedAt); null when unknown. */
  capturedAt?: string | null;
  /** True when the asset carries a trustworthy location binding. */
  hasLocation?: boolean;
  /** §10: how that binding was established, when known. Absent on older rows. */
  locationBasis?: LocationBasis;
  /** Append-only edit history — the §35 lineage. */
  editHistory: EditLineageEntry[];
}

export function normalizeSourceType(v: unknown): MediaSourceType {
  const s = String(v ?? "").trim().toLowerCase();
  switch (s) {
    case "camera":
    case "library":
    case "provider":
    case "official":
    case "community":
    case "generated":
    case "screenshot":
    case "derivative":
    case "user":
      return s;
    default:
      // Fail-closed: an unrecognized source is treated as legacy-ambiguous
      // 'user' (which is NOT in the eligible allowlist).
      return "user";
  }
}

/**
 * Coerce an arbitrary jsonb value read from the DB into a MediaProvenance, or
 * null when it is not provenance-shaped. Tolerant of missing/partial data.
 */
export function normalizeProvenance(v: unknown): MediaProvenance | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const rawHistory = Array.isArray(o.editHistory) ? o.editHistory : [];
  const editHistory: EditLineageEntry[] = rawHistory
    .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
    .map((e) => {
      const op = normalizeEditOp(String(e.op ?? ""));
      // ALWAYS re-derive the class from the op name — never trust a stored
      // `class`. That way a tampered/legacy row cannot smuggle a breaking edit
      // in labeled "preserving".
      const cls: EditClass = classifyEdit(op);
      const entry: EditLineageEntry = {
        op,
        class: cls,
        at: typeof e.at === "string" ? e.at : "",
      };
      if (typeof e.rawOp === "string") entry.rawOp = e.rawOp;
      if (typeof e.tool === "string") entry.tool = e.tool;
      if (e.detail && typeof e.detail === "object") entry.detail = e.detail as Record<string, unknown>;
      return entry;
    });
  const prov: MediaProvenance = {
    sourceType: normalizeSourceType(o.sourceType),
    capturedAt: typeof o.capturedAt === "string" ? o.capturedAt : null,
    hasLocation: o.hasLocation === true,
    editHistory,
  };
  // A stored basis is kept only when it is one of the four; anything else is
  // dropped rather than trusted, and the confidence falls back to hasLocation.
  if (isLocationBasis(o.locationBasis)) prov.locationBasis = o.locationBasis;
  return prov;
}

export interface InitProvenanceInput {
  sourceType?: string | null;
  capturedAt?: string | null;
  hasLocation?: boolean;
  locationBasis?: LocationBasis | null;
}

/** Build a fresh provenance record with an empty edit lineage. */
export function initProvenance(input: InitProvenanceInput): MediaProvenance {
  const prov: MediaProvenance = {
    sourceType: normalizeSourceType(input.sourceType),
    capturedAt: input.capturedAt ?? null,
    hasLocation: input.hasLocation ?? (input.locationBasis != null && input.locationBasis !== "none"),
    editHistory: [],
  };
  if (isLocationBasis(input.locationBasis)) prov.locationBasis = input.locationBasis;
  return prov;
}

export interface AppendEditOptions {
  at?: string;
  tool?: string;
  detail?: Record<string, unknown>;
}

/**
 * Append one edit to a provenance record. PURE: returns a NEW provenance with
 * the entry appended; the input is never mutated and the prior lineage is
 * preserved in order (§35 lineage is append-only, never overwritten).
 */
export function appendEdit(
  prov: MediaProvenance | null | undefined,
  op: string,
  opts: AppendEditOptions = {},
): MediaProvenance {
  const base = normalizeProvenance(prov) ?? initProvenance({});
  const normalized = normalizeEditOp(op);
  const entry: EditLineageEntry = {
    op: normalized,
    class: classifyEdit(op),
    at: opts.at ?? new Date().toISOString(),
  };
  if (normalized !== String(op ?? "")) entry.rawOp = String(op ?? "");
  if (opts.tool) entry.tool = opts.tool;
  if (opts.detail) entry.detail = opts.detail;
  return {
    ...base,
    editHistory: [...base.editHistory, entry],
  };
}

// ── §10 IntelligenceEligibility ───────────────────────────────────────────────

/** §10 IntelligenceEligibility.freshnessClass. The media side never emits 'live'. */
export type FreshnessClass = "live" | "fresh" | "recent" | "historical";

/** §10 IntelligenceEligibility. */
export interface IntelligenceEligibility {
  eligible: boolean;
  reasons: string[];
  freshnessClass: FreshnessClass;
  captureConfidence: number;
  locationConfidence: number;
  provenanceConfidence: number;
  expiresAt?: string;
}

/** Minimum provenance AND capture confidence for an asset to be live evidence. */
export const MIN_EVIDENCE_CONFIDENCE = 0.5;

/**
 * §10/§11: how long after capture an eligible asset keeps OPERATIONAL
 * intelligence value. Deliberately the same instant `computeFreshnessClass`
 * moves it to 'historical' (RECENT_WINDOW_MS, 24 h), so the eligibility object
 * can never say "historical" and "not yet expired" about the same asset at the
 * same moment. A claim's own TTL may be shorter; this is the ceiling.
 */
export const INTELLIGENCE_OPERATIONAL_WINDOW_MS = RECENT_WINDOW_MS;

/**
 * The asset's operational expiry, or undefined when it has none: an ineligible
 * asset never had operational value, and an asset with no valid capture time
 * cannot say when its "now" was.
 */
export function operationalExpiresAt(
  eligible: boolean,
  capturedAt: string | null | undefined,
): string | undefined {
  if (!eligible || !capturedAt) return undefined;
  const t = new Date(capturedAt).getTime();
  if (!Number.isFinite(t)) return undefined;
  return new Date(t + INTELLIGENCE_OPERATIONAL_WINDOW_MS).toISOString();
}

/** Base provenance confidence per source type. */
const SOURCE_PROVENANCE_BASE: Record<MediaSourceType, number> = {
  camera: 0.9,
  library: 0.7,
  community: 0.7,
  official: 0.6,
  provider: 0.6,
  user: 0.4, // legacy-ambiguous: below threshold ⇒ not eligible until re-sourced
  screenshot: 0.15,
  derivative: 0.1,
  generated: 0.0,
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Media-side freshness. Derived purely from capture age and CAPPED at 'fresh' —
 * it can never return 'live'. Unknown/invalid capture time ⇒ 'historical'
 * (fail-closed to the oldest, weakest class).
 */
export function computeFreshnessClass(
  capturedAt: string | null | undefined,
  now?: number,
): FreshnessClass {
  if (!capturedAt) return "historical";
  const t = new Date(capturedAt).getTime();
  if (!Number.isFinite(t)) return "historical";
  const age = (now ?? Date.now()) - t;
  if (age < FRESH_WINDOW_MS) return "fresh"; // includes future timestamps
  if (age < RECENT_WINDOW_MS) return "recent";
  return "historical";
}

function computeCaptureConfidence(
  sourceType: MediaSourceType,
  capturedAt: string | null | undefined,
): number {
  const hasValidTime = !!capturedAt && Number.isFinite(new Date(capturedAt).getTime());
  if (!hasValidTime) return 0.3; // no capture time ⇒ below threshold ⇒ not eligible
  return sourceType === "camera" ? 0.9 : 0.7;
}

export interface EligibilityComputeInput {
  sourceType?: string | null;
  capturedAt?: string | null;
  editHistory?: EditLineageEntry[];
  hasLocation?: boolean;
  /** §10: how the location was established. Wins over `hasLocation` when valid. */
  locationBasis?: LocationBasis | null;
  /** Injectable clock for deterministic freshness (defaults to Date.now()). */
  now?: number;
}

/**
 * Compute the §10 IntelligenceEligibility for a media asset. This is the single
 * §35 gate. `eligible` is true ONLY when ALL hold:
 *   1. source is a first-party capture (camera/library/community);
 *   2. NO evidence-breaking edit in the lineage (no generative alteration);
 *   3. NO unknown/unclassified edit in the lineage (fail-closed);
 *   4. provenance AND capture confidence both ≥ MIN_EVIDENCE_CONFIDENCE.
 * Any failure ⇒ eligible:false with an explanatory reason. The asset remains a
 * valid social asset regardless — this object says nothing about social use.
 */
export function computeIntelligenceEligibility(
  input: EligibilityComputeInput,
): IntelligenceEligibility {
  const sourceType = normalizeSourceType(input.sourceType);
  const editHistory = input.editHistory ?? [];
  const reasons: string[] = [];

  // 1. Source gate.
  const sourceEligible = EVIDENCE_ELIGIBLE_SOURCE_TYPES.has(sourceType);
  if (!sourceEligible) {
    if (NON_OBSERVATION_SOURCE_TYPES.has(sourceType)) {
      reasons.push(`source_not_observation:${sourceType}`);
    } else {
      reasons.push(`source_not_first_party:${sourceType}`);
    }
  }

  // 2. Edit gate — worst-of, fail-closed on unknown. Re-derive each class from
  // its op name so a mislabeled stored entry cannot pass.
  let hasBreaking = false;
  let hasUnknown = false;
  for (const e of editHistory) {
    const cls = classifyEdit(e.op);
    if (cls === "evidence_breaking") hasBreaking = true;
    else if (cls === "unknown") hasUnknown = true;
  }
  if (hasBreaking) reasons.push("evidence_breaking_edit"); // §35: generative ⇒ social-only
  if (hasUnknown) reasons.push("unclassified_edit_fail_closed"); // fail-closed

  // 3. Confidence. A breaking OR unknown edit zeroes provenance confidence: we
  // cannot vouch for pixels that may have been synthesized.
  let provenanceConfidence = SOURCE_PROVENANCE_BASE[sourceType] ?? 0.2;
  if (hasBreaking || hasUnknown) provenanceConfidence = 0;
  const captureConfidence = computeCaptureConfidence(sourceType, input.capturedAt);
  const basis: LocationBasis = isLocationBasis(input.locationBasis)
    ? input.locationBasis
    : input.hasLocation ? "gps" : "none";
  const locationConfidence = LOCATION_CONFIDENCE_BY_BASIS[basis];

  if (provenanceConfidence < MIN_EVIDENCE_CONFIDENCE) reasons.push("provenance_confidence_below_threshold");
  if (captureConfidence < MIN_EVIDENCE_CONFIDENCE) reasons.push("capture_confidence_below_threshold");

  const confidentEnough =
    provenanceConfidence >= MIN_EVIDENCE_CONFIDENCE &&
    captureConfidence >= MIN_EVIDENCE_CONFIDENCE;

  const eligible = sourceEligible && !hasBreaking && !hasUnknown && confidentEnough;
  if (eligible) reasons.unshift("evidence_eligible");

  const out: IntelligenceEligibility = {
    eligible,
    reasons,
    freshnessClass: computeFreshnessClass(input.capturedAt, input.now),
    captureConfidence: round2(captureConfidence),
    locationConfidence: round2(locationConfidence),
    provenanceConfidence: round2(provenanceConfidence),
  };
  // §10 expiresAt: the asset's OPERATIONAL lifetime (see the module header).
  // Present only on an eligible asset; a claim's own TTL is separate and owned
  // by Live Intelligence.
  const expiresAt = operationalExpiresAt(eligible, input.capturedAt);
  if (expiresAt) out.expiresAt = expiresAt;
  return out;
}

// ── The public contract the media→intel seam will call ────────────────────────

/**
 * A media-asset-shaped input. Reads snake_case (a raw media_assets row) or
 * camelCase; provenance may be the jsonb column value.
 */
export interface EvidenceAssetInput {
  source_type?: string | null;
  sourceType?: string | null;
  provenance?: unknown;
  captured_at?: string | null;
  capturedAt?: string | null;
  /** Injectable clock for deterministic freshness. */
  now?: number;
}

/**
 * Evaluate a media asset's full §10 eligibility object. The provenance's own
 * source/capture/location values are the authority; the row's top-level
 * source_type/captured_at are used only when provenance omits them.
 */
export function evaluateEvidenceEligibility(
  asset: EvidenceAssetInput,
): IntelligenceEligibility {
  const prov = normalizeProvenance(asset.provenance);
  const sourceType =
    prov?.sourceType ??
    asset.source_type ??
    asset.sourceType ??
    "user";
  const capturedAt =
    prov?.capturedAt ??
    asset.captured_at ??
    asset.capturedAt ??
    null;
  return computeIntelligenceEligibility({
    sourceType,
    capturedAt,
    editHistory: prov?.editHistory ?? [],
    hasLocation: prov?.hasLocation ?? false,
    locationBasis: prov?.locationBasis ?? null,
    now: asset.now,
  });
}

/**
 * isEvidenceEligible — THE single gate the future media→intel evidence phase
 * calls. Returns the composite boolean verdict: true only when the asset's
 * source is first-party, its lineage contains no evidence-breaking or unknown
 * edit, and its provenance/capture confidence clear the bar. Fail-closed for
 * everything else. A false verdict never implies the asset is unusable as
 * social media (§35).
 */
export function isEvidenceEligible(asset: EvidenceAssetInput): boolean {
  return evaluateEvidenceEligibility(asset).eligible;
}

/**
 * isOperationalEvidenceAt — the §10/§11 gate for evidence behind a CURRENT
 * claim: §35-eligible AND still inside its operational lifetime at `nowMs`.
 *
 * The distinction from `isEvidenceEligible` is deliberate (module header):
 * eligibility is a property of source and lineage and does not decay; operational
 * value does. A photograph captured two days ago is still a first-party,
 * unedited capture — and still cannot tell anyone what a place is like now.
 * Fail-closed: no expiry (ineligible, or no capture time) ⇒ false.
 */
export function isOperationalEvidenceAt(asset: EvidenceAssetInput, nowMs?: number): boolean {
  const now = nowMs ?? asset.now ?? Date.now();
  const e = evaluateEvidenceEligibility({ ...asset, now });
  if (!e.eligible || !e.expiresAt) return false;
  return now < new Date(e.expiresAt).getTime();
}

// ── census-media §35 (MD37): §6's eight values, and the one no writer chose ───

/**
 * The eight §6 `MediaAsset.sourceType` values, exactly, in the spec's order.
 * `MediaSourceType` above is these eight plus the legacy 'user'.
 */
export const SPEC_MEDIA_SOURCE_TYPES = [
  "camera",
  "library",
  "provider",
  "official",
  "community",
  "generated",
  "screenshot",
  "derivative",
] as const satisfies readonly MediaSourceType[];

/**
 * What a `media_assets` writer passes when the spec does not settle its source.
 *
 * It is the legacy 'user' — the value those writers already stored through the
 * writer's own fallback — under a name, so that a writer nobody has told its
 * source SAYS so where it writes, and the list of such writers is the owner's
 * decision inventory (census-media §35, MD37; pinned by
 * src/test/mediaAssetSourceDeclared.test.ts).
 *
 * It is deliberately NOT one of the eight. Choosing one would be a protection
 * change, not a rename: camera, library and community are evidence-eligible
 * (EVIDENCE_ELIGIBLE_SOURCE_TYPES above), which a presence receipt reads
 * (services/intel/PresenceVerifier checkReceipt), and they rank as `authentic`
 * where 'user' ranks `unknown` (lib/mediaRankingSignals provenanceClassOf). The
 * upload route receives bytes and a Content-Type only, so which of camera,
 * library or screenshot a file is was never declared to the server.
 */
export const MEDIA_SOURCE_UNDECLARED = "user" as const satisfies MediaSourceType;
