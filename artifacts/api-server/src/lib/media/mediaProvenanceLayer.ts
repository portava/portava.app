/**
 * mediaProvenanceLayer — the §8 PROVENANCE layer, as served on a media object.
 *
 *   §8  Provenance  |  Source, capture time, edits, location confidence,
 *                   |  moderation, trust context.            Owner: Media + Trust
 *
 * PURE. Built from what the projection already holds — the canonical
 * `media_assets` row when the gated canonical read attached one, the post's own
 * location provenance, the served media row's moderation state and the
 * contributor's Trust flags — and nothing else. No extra read happens here.
 *
 * ── TWO BASES, AND THE LAYER SAYS WHICH ────────────────────────────────────
 *   canonical  The media came from `media_assets` (lib/media/mediaCanonicalRead).
 *              Source, capture time and edit lineage are the asset's DECLARED
 *              provenance (§6 MediaProvenance), written at upload by
 *              lib/mediaAssets.recordMediaAssetDetailed.
 *   legacy     The media came from `post_media` / `posts.media_urls`, which carry
 *              no provenance at all. The layer does not invent one: source is
 *              `undeclared`, capture time is null, the lineage is empty — and
 *              `basis: "legacy"` says why, so a consumer can tell "no edits" from
 *              "no record of edits".
 *
 * The legacy 0191 source value `user` is presented as `undeclared` too: it is
 * the column DEFAULT, written whenever an upload did not say where the file came
 * from, so it records the absence of a declaration rather than a source.
 *
 * ── WHAT IS NEVER SERVED ────────────────────────────────────────────────────
 *   • No coordinate, and no location basis once the location is withheld: the
 *     basis says whether a place tag was GPS-verified, which is itself a fact
 *     about a place the choke point decided not to disclose. `withholdLocation`
 *     is applied by `mediaProjection.applyLocationDisclosure` whenever the
 *     effective tier is `hidden`.
 *   • No edit parameters. `EditLineageEntry.detail` is free-form; the layer
 *     carries counts by §35 class, re-derived from the op name (a stored class
 *     is never trusted — mediaEvidenceEligibility.classifyEdit).
 */
import {
  classifyEdit,
  LOCATION_CONFIDENCE_BY_BASIS,
  locationBasisFromPost,
  type LocationBasis,
  type MediaProvenance,
  type MediaSourceType,
} from "./mediaEvidenceEligibility.js";
import {
  toCanonicalModerationStatus,
  type MediaModerationStatus,
} from "./mediaAssetContract.js";

export type ServedSourceType = Exclude<MediaSourceType, "user"> | "undeclared";

export interface MediaProvenanceLayer {
  /** Which store the media came from, and so how much provenance exists. */
  basis: "canonical" | "legacy";
  /** §6 sourceType; `undeclared` when no source was ever recorded. */
  sourceType: ServedSourceType;
  /** §6 capturedAt — the capture clock, distinct from publish time. Null when unknown. */
  capturedAt: string | null;
  /** §35 lineage, counted by class. Never the parameters. */
  edits: { count: number; evidenceBreaking: number; unclassified: number };
  /** §10 how the place tag was established; null when the location is withheld. */
  locationBasis: LocationBasis | null;
  /** §10 locationConfidence for that basis; null when the location is withheld. */
  locationConfidence: number | null;
  /** §36 moderation state of the served media, in the canonical vocabulary. */
  moderation: MediaModerationStatus | null;
  /** Trust context — the contributor flags Trust owns, as already projected. */
  trust: { verifiedContributor: boolean; officialSource: boolean };
}

/**
 * What the layer needs from a canonical asset. `MediaAsset` (the §6 contract,
 * lib/media/mediaAssetContract) satisfies it; so does a canonical row that
 * carries only its provenance columns.
 */
export interface CanonicalProvenanceSource {
  sourceType: MediaSourceType;
  provenance: MediaProvenance | null;
  moderationStatus: MediaModerationStatus | null;
  capturedAt?: string;
}

export interface ProvenanceLayerInput {
  /** The canonical asset, when the served media came from `media_assets`. */
  asset: CanonicalProvenanceSource | null;
  /** The served legacy media row's moderation value (post_media), when legacy. */
  legacyModeration?: unknown;
  /** The post's own location provenance columns. */
  post: { location_source?: unknown; location_verified?: unknown; geotag_verified?: unknown } | null;
  contributor: { verified: boolean; isOfficial: boolean } | null;
}

function servedSource(s: MediaSourceType | null | undefined): ServedSourceType {
  if (!s || s === "user") return "undeclared";
  return s;
}

function countEdits(prov: MediaProvenance | null): MediaProvenanceLayer["edits"] {
  const out = { count: 0, evidenceBreaking: 0, unclassified: 0 };
  for (const e of prov?.editHistory ?? []) {
    out.count += 1;
    const cls = classifyEdit(e.op);
    if (cls === "evidence_breaking") out.evidenceBreaking += 1;
    else if (cls === "unknown") out.unclassified += 1;
  }
  return out;
}

export function buildProvenanceLayer(input: ProvenanceLayerInput): MediaProvenanceLayer {
  const basis = locationBasisFromPost(input.post);
  const trust = {
    verifiedContributor: input.contributor?.verified === true,
    officialSource: input.contributor?.isOfficial === true,
  };
  const a = input.asset;
  if (a) {
    // The asset's provenance is authoritative over its top-level source column,
    // exactly as mediaEvidenceEligibility.evaluateEvidenceEligibility reads it.
    const prov = a.provenance;
    return {
      basis: "canonical",
      sourceType: servedSource(prov?.sourceType ?? a.sourceType),
      capturedAt: prov?.capturedAt ?? a.capturedAt ?? null,
      edits: countEdits(prov),
      locationBasis: basis,
      locationConfidence: LOCATION_CONFIDENCE_BY_BASIS[basis],
      moderation: a.moderationStatus,
      trust,
    };
  }
  return {
    basis: "legacy",
    sourceType: "undeclared",
    capturedAt: null,
    edits: { count: 0, evidenceBreaking: 0, unclassified: 0 },
    locationBasis: basis,
    locationConfidence: LOCATION_CONFIDENCE_BY_BASIS[basis],
    moderation: input.legacyModeration === undefined ? null : toCanonicalModerationStatus(input.legacyModeration),
    trust,
  };
}

/** Withhold the location half of the layer — applied when the tier is `hidden`. */
export function withholdLocation(layer: MediaProvenanceLayer): MediaProvenanceLayer {
  return { ...layer, locationBasis: null, locationConfidence: null };
}
