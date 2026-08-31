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
 * lib/intelLiveScope.ts), never manufactured from a raw media asset. Nor does
 * it stamp an operational `expiresAt`: intel expiry belongs to the
 * observation/claim, not to the asset.
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
 * §6 MediaProvenance: source + capture + edit lineage for one asset. This is the
 * shape stored in `media_assets.provenance` (jsonb).
 */
export interface MediaProvenance {
  sourceType: MediaSourceType;
  /** When the media was captured (may precede uploadedAt); null when unknown. */
  capturedAt?: string | null;
  /** True when the asset carries a trustworthy location binding. */
  hasLocation?: boolean;
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
  return {
    sourceType: normalizeSourceType(o.sourceType),
    capturedAt: typeof o.capturedAt === "string" ? o.capturedAt : null,
    hasLocation: o.hasLocation === true,
    editHistory,
  };
}

export interface InitProvenanceInput {
  sourceType?: string | null;
  capturedAt?: string | null;
  hasLocation?: boolean;
}

/** Build a fresh provenance record with an empty edit lineage. */
export function initProvenance(input: InitProvenanceInput): MediaProvenance {
  return {
    sourceType: normalizeSourceType(input.sourceType),
    capturedAt: input.capturedAt ?? null,
    hasLocation: input.hasLocation ?? false,
    editHistory: [],
  };
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
  const locationConfidence = input.hasLocation ? 0.7 : 0.2;

  if (provenanceConfidence < MIN_EVIDENCE_CONFIDENCE) reasons.push("provenance_confidence_below_threshold");
  if (captureConfidence < MIN_EVIDENCE_CONFIDENCE) reasons.push("capture_confidence_below_threshold");

  const confidentEnough =
    provenanceConfidence >= MIN_EVIDENCE_CONFIDENCE &&
    captureConfidence >= MIN_EVIDENCE_CONFIDENCE;

  const eligible = sourceEligible && !hasBreaking && !hasUnknown && confidentEnough;
  if (eligible) reasons.unshift("evidence_eligible");

  return {
    eligible,
    reasons,
    freshnessClass: computeFreshnessClass(input.capturedAt, input.now),
    captureConfidence: round2(captureConfidence),
    locationConfidence: round2(locationConfidence),
    provenanceConfidence: round2(provenanceConfidence),
    // expiresAt intentionally omitted: operational expiry is owned by the intel
    // observation/claim, not the media asset.
  };
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
