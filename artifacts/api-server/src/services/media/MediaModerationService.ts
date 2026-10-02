/**
 * MediaModerationService (§41) — the §36 MediaModerationStatus state machine for
 * the canonical asset, and the one place a moderation decision about a media
 * FILE reaches it.
 *
 *   §36  processing | active | limited | rejected | removed | owner_deleted
 *
 * ── WHAT WAS THERE, AND WHY IT WAS NOT A SERVICE ─────────────────────────────
 * census-media §9.2 (MD351): "There is no MediaModerationService. What exists
 * is an admin route, an audit writer, an inert table and the distribution
 * gate." The admin route flips `post_media.moderation_status` and writes the
 * audit row; nothing carried that decision to the file's CANONICAL record, so
 * `media_assets.moderation_status` — the column the canonical read, the Wall's
 * quick-media row and the Telegraph media loader consult — stayed at whatever
 * the upload wrote, forever. A rejected upload was rejected in one store and
 * `processing` (served) in the other.
 *
 * ── WHAT THIS MODULE OWNS ────────────────────────────────────────────────────
 *   • the §36 vocabulary and the ALLOWED TRANSITIONS between its states
 *     (`canTransition`) — `owner_deleted` is terminal, `removed` only moves to
 *     `owner_deleted`, and nothing moderation does can resurrect either;
 *   • the mapping from a moderation DECISION to a state (`stateForDecision`);
 *   • `applyCanonicalModerationDecision`: the decision applied to the file's
 *     `media_assets` row (found by its storage key, the only canonical id a
 *     post_media file has), as a compare-and-set on `version`
 *     (lib/mediaAssets.casUpdateMediaAsset) re-read on a lost race, so a
 *     concurrent owner deletion is never overwritten by a late approval;
 *   • `isDistributableModerationState`: the §36 distribution predicate, stated
 *     once — `processing` is distributable because the product has no
 *     pre-distribution hold (census-media MD269, the open safety-moderation
 *     STAGE, which needs a classifier/provider decision this module does not
 *     pretend to be).
 *
 * WHAT IT DOES NOT OWN: the audit row (lib/moderationAudit — the route writes it
 * before calling here) and the legacy `post_media` value (the route's update,
 * unchanged, because `post_media_moderation_status_check` admits only the
 * legacy four in both databases).
 *
 * ── GATED EXACTLY LIKE THE CANONICAL WRITER ─────────────────────────────────
 * The §36 values `active` / `limited` / `removed` are legal only where migration
 * 2250/2470's superset CHECK exists. Production does not have it (owner
 * decision MEDIA_CANONICAL_FLAG), so the schema-capability probe must say
 * `present` or nothing is written and the outcome says so — the same guard
 * lib/mediaAssets.recordMediaAssetDetailed runs. No flag is read or changed.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "../../lib/logger.js";
import { casUpdateMediaAsset } from "../../lib/mediaAssets.js";
import { probeCanonicalAssetSchema } from "../../lib/media/mediaSchemaCapability.js";
import {
  MEDIA_MODERATION_STATUSES,
  toCanonicalModerationStatus,
  type MediaModerationStatus,
} from "../../lib/media/mediaAssetContract.js";

export { MEDIA_MODERATION_STATUSES, type MediaModerationStatus };

/** A moderation decision about a media file. */
export type MediaModerationDecision = "approve" | "flag" | "reject" | "remove";

/** The §36 state each decision moves the file to. */
export function stateForDecision(d: MediaModerationDecision): MediaModerationStatus {
  switch (d) {
    case "approve": return "active";
    case "flag": return "limited";
    case "reject": return "rejected";
    case "remove": return "removed";
  }
}

/**
 * The §36 transition table. A moderator may move a file between the reviewable
 * states freely — `reject` is reversible, as routes/adminMedia documents — but:
 *   • `removed` is a take-down: only the OWNER's deletion follows it;
 *   • `owner_deleted` is terminal: the owner's choice outranks any moderator's.
 */
const TRANSITIONS: Readonly<Record<MediaModerationStatus, readonly MediaModerationStatus[]>> = {
  processing: ["active", "limited", "rejected", "removed", "owner_deleted"],
  active: ["limited", "rejected", "removed", "owner_deleted"],
  limited: ["active", "rejected", "removed", "owner_deleted"],
  rejected: ["active", "limited", "removed", "owner_deleted"],
  removed: ["owner_deleted"],
  owner_deleted: [],
};

export function canTransition(from: MediaModerationStatus, to: MediaModerationStatus): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

/**
 * §36 distribution: may a file in this state reach a social surface? The same
 * membership lib/mediaEligibility.NON_DISTRIBUTABLE_MEDIA_MODERATION_STATES and
 * lib/media/mediaProjection's deny-list hold, in the canonical vocabulary. An
 * unrecognised value is NOT distributable.
 */
export function isDistributableModerationState(v: unknown): boolean {
  const s = toCanonicalModerationStatus(v);
  return s === "processing" || s === "active";
}

export type CanonicalModerationOutcome =
  /** The asset is now in the decided state (or already was). */
  | "applied"
  /** No `media_assets` row for this storage key — nothing canonical to move. */
  | "no_asset"
  /** The §36 table forbids it (e.g. approving an owner-deleted file). Nothing written. */
  | "refused_transition"
  /** The database lacks the §36 CHECK (2250/2470). Nothing written. */
  | "refused_schema"
  /** Lost the compare-and-set on every attempt. Nothing written. */
  | "conflict"
  /** A read or write failed. */
  | "failed";

/** How many times a lost compare-and-set is re-read and re-applied. */
export const MODERATION_CAS_ATTEMPTS = 3;

/**
 * Apply one decision to the canonical asset stored at (bucket, path).
 * Never throws; the outcome is the whole report.
 */
export async function applyCanonicalModerationDecision(
  sc: SupabaseClient,
  input: { bucket: string | null | undefined; path: string | null | undefined; decision: MediaModerationDecision },
): Promise<CanonicalModerationOutcome> {
  const bucket = String(input.bucket ?? "").trim();
  const path = String(input.path ?? "").trim();
  if (!bucket || !path) return "no_asset";
  const to = stateForDecision(input.decision);
  try {
    const schema = await probeCanonicalAssetSchema(sc);
    if (schema.state !== "present") return "refused_schema";
    for (let attempt = 0; attempt < MODERATION_CAS_ATTEMPTS; attempt++) {
      const { data, error } = await sc
        .from("media_assets")
        .select("id, moderation_status, version")
        .eq("storage_bucket", bucket)
        .eq("storage_path", path)
        .maybeSingle();
      if (error) return "failed";
      if (!data) return "no_asset";
      const row = data as { id: string; moderation_status?: unknown; version?: unknown };
      // A legacy value is read in §36 terms; an unknown one is refused rather
      // than guessed at, because a guess could be the state that resurrects.
      const from = toCanonicalModerationStatus(row.moderation_status);
      if (!from) return "refused_transition";
      if (from === to) return "applied";
      if (!canTransition(from, to)) return "refused_transition";
      const written = await casUpdateMediaAsset(sc, row.id, row.version, {
        moderation_status: to,
        updated_at: new Date().toISOString(),
      });
      if (written === "written") return "applied";
      if (written === "failed") return "failed";
      // conflict: somebody moved the row after our read — re-read and re-decide.
    }
    return "conflict";
  } catch (err) {
    logger.warn({ err, bucket, path }, "canonical moderation decision threw — nothing written");
    return "failed";
  }
}
