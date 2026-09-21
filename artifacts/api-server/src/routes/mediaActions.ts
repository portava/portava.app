/**
 * Media v2 — action rail + intent + experience-plan endpoints (§15/§43).
 *
 *   GET  /api/media/:id/actions                       §15/§43  eligible action set
 *   POST /api/media/:id/intent                        §15.1    "I Want This" signal
 *   DELETE /api/media/:id/intent                       §15.1    undo the signal
 *   POST /api/media/:id/retry                         §6       owner re-queues processing
 *   POST /api/media/:id/attachments                   §6.1     link asset → owned entity
 *   GET  /api/media/experiences/:experienceId/plan    §15.2    "Do This Experience"
 *
 * TWO ID SPACES SHARE ONE `:id` SLOT, and that is deliberate rather than
 * accidental: /actions and /intent take a POST id (they run through
 * `loadEligibleMediaRow`, and `media_intent_signals.media_id` REFERENCES
 * posts(id)), while /retry and /attachments take a `media_assets.id`, because
 * processing state and §6.1 attachments have no post-id spelling at all. Both
 * are uuids, both answer `not_found` for anything the caller does not own, so a
 * caller passing the wrong kind gets a deny and never a cross-space read.
 *
 * ADDITIVE. New routes only; existing media/compass behavior is untouched.
 *
 * INVARIANTS:
 *   • requireUser on every route (auth + ban gate — never client.auth.getUser).
 *   • The action rail is eligibility-gated: a media item the viewer may not see
 *     returns not_found, and every offered action is gated by the SAME
 *     authorization as its target endpoint (§47) inside the resolver.
 *   • "I Want This" records an intent SIGNAL to its own store — not a like/save.
 *   • "Do This Experience" produces a plan PROPOSAL bound to the existing
 *     trip-plan endpoint; it writes nothing (Compass stays propose-only).
 */

import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { checkRateLimit } from "../lib/rateLimit.js";
import { resolveViewer } from "../services/media/MediaProjectionService.js";
import {
  resolveMediaActions,
  buildDoThisExperiencePlan,
  recordMediaIntent,
  loadEligibleMediaRow,
  resolveMediaEntities,
  MEDIA_INTENT_KINDS,
  type MediaIntentKind,
} from "../services/media/MediaActionResolver.js";
import { authorizeMediaContext } from "../lib/mediaVisibility.js";
import { retryMediaProcessing } from "../services/media/MediaLifecycleService.js";
import { recordMediaAttachment } from "../lib/mediaAssets.js";

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The §6.1 attachment audiences a client may ASK for. A subset of what
 * `media_attachments.visibility_override` can hold — this is the write
 * vocabulary, and `lib/mediaVisibility` is the read side that enforces it.
 */
const ATTACHMENT_VISIBILITIES = [
  "inherit",
  "public",
  "private",
  "followers",
  "following",
  "trip_crew",
  "shared_moment",
] as const;

/**
 * Entity types this route can PROVE ownership of, below. A strict subset of
 * `lib/mediaAssets.ATTACHMENT_ENTITY_TYPES`: `place` and `observation` are
 * omitted because neither has a single owning user, so there is no ownership
 * question this route could answer about them — better to reject than to guess
 * a table.
 */
export const SUPPORTED_ATTACHMENT_ENTITY_TYPES = [
  "post",
  "postcard",
  "memory",
  "trip",
  "event",
  "hidden_gem",
  "shared_moment",
] as const;

export const attachmentBodySchema = z.object({
  entity_type: z.enum(SUPPORTED_ATTACHMENT_ENTITY_TYPES),
  entity_id: z.string().regex(UUID_RE),
  position: z.number().int().min(0).max(10000).optional(),
  is_cover: z.boolean().optional(),
  visibility_override: z.enum(ATTACHMENT_VISIBILITIES).nullable().optional(),
}).strict();

export function validateMediaAttachmentBody(body: unknown) {
  return attachmentBodySchema.safeParse(body);
}

/**
 * May `userId` attach media to this entity? The owner column per entity type is
 * a LOOKUP TABLE, never an interpolated guess: an unknown entityType returns
 * false rather than reaching for a table named after client input.
 *
 * `trip` is the one collaborative case — an accepted crew member may attach to
 * a trip they do not own. That uses the repo's accepted-member rule
 * (status='accepted'); a `pending`/`invited` row is not membership.
 */
export async function ownsAttachmentEntity(
  sc: any,
  userId: string,
  entityType: string,
  entityId: string,
): Promise<boolean> {
  // WRITTEN AS A SWITCH OVER LITERALS, NOT A LOOKUP TABLE, AND THE REASON IS A
  // CHECK RATHER THAN A STYLE PREFERENCE. The obvious shape here is a
  // Record<string, {table, ownerColumn}> and `.from(entity.table)`, which is
  // what this was. It reads better and it is a BLIND SPOT:
  // check:write-path-columns resolves `.from("<literal>")` by AST and diffs the
  // column list against the live schema, so a computed table name — and the
  // template-literal select list that goes with it — is a site it cannot verify
  // at all. CI caught exactly this at :126 and refused it as an unresolvable
  // site. Seven literal branches are verifiable; one elegant lookup is not.
  //
  // The property the lookup was protecting is kept: an unknown entityType falls
  // through to `return false` and never reaches for a table named after client
  // input. Each branch names its own owner column because they genuinely differ
  // (author_id, host_id, submitted_by, owner_id, user_id).
  try {
    // One helper, so each branch is a single literal `.from("…").select("…")`
    // that the checker can resolve, and the shared shape is written once.
    const ownerIdOf = async (q: any, col: string): Promise<string | null> => {
      const { data, error } = await q.eq("id", entityId).maybeSingle();
      if (error || !data) return null;
      return String(data[col]);
    };

    let ownerId: string | null;
    switch (entityType) {
      case "post":
        ownerId = await ownerIdOf(sc.from("posts").select("id,author_id"), "author_id");
        break;
      case "postcard":
        ownerId = await ownerIdOf(sc.from("passport_postcards").select("id,user_id"), "user_id");
        break;
      case "memory":
        ownerId = await ownerIdOf(sc.from("passport_memories").select("id,user_id"), "user_id");
        break;
      case "event":
        ownerId = await ownerIdOf(sc.from("events").select("id,host_id"), "host_id");
        break;
      case "hidden_gem":
        ownerId = await ownerIdOf(sc.from("hidden_gems").select("id,submitted_by"), "submitted_by");
        break;
      case "shared_moment":
        ownerId = await ownerIdOf(sc.from("shared_moments").select("id,owner_id"), "owner_id");
        break;
      case "trip":
        ownerId = await ownerIdOf(sc.from("trips").select("id,owner_id"), "owner_id");
        break;
      default:
        // An unknown entityType never reaches for a table named after client
        // input. This is the property the lookup table was protecting.
        return false;
    }

    // A missing or unreadable row is not ownership, for any entity type
    // including trip: there is no trip to be a crew member of.
    if (ownerId === null) return false;
    if (ownerId === userId) return true;
    if (entityType !== "trip") return false;

    const member = await sc
      .from("trip_members")
      .select("user_id")
      .eq("trip_id", entityId)
      .eq("user_id", userId)
      .eq("status", "accepted")
      .maybeSingle();
    return !member.error && Boolean(member.data);
  } catch {
    return false;
  }
}

// ── POST /media/:id/retry  (owner re-queues a failed processing run) ─────────
//
// `:id` here is a `media_assets.id`, NOT the post id every other `/media/:id/*`
// route in this router takes: processing state lives on the canonical asset and
// has no post-id spelling. Both this route and /attachments below answer
// `not_found` for a missing asset and for one owned by somebody else, so the
// endpoint cannot be used to probe which asset ids exist.
router.post(
  "/media/:id/retry",
  asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const sc = getServiceClient();
    if (!sc) {
      sendError(res, "server_not_configured");
      return;
    }
    const id = String(req.params.id ?? "");
    if (!UUID_RE.test(id)) {
      sendError(res, "invalid_payload", "Invalid media id");
      return;
    }
    const rl = checkRateLimit("media_retry", auth.user.id, 30, 60_000);
    if (!rl.allowed) {
      res.setHeader("Retry-After", Math.ceil(rl.retryAfterMs / 1000).toString());
      sendError(res, "rate_limited", "Too many requests. Please wait.");
      return;
    }
    const result = await retryMediaProcessing(sc, id, auth.user.id);
    if (!result.ok) {
      sendError(res, "not_found", "Media item not found");
      return;
    }
    res.status(202).json({ retryQueued: true, alreadyQueued: result.alreadyQueued });
  }),
);

// ── POST /media/:id/attachments  (§6.1 link an owned asset to an owned entity) ─
router.post(
  "/media/:id/attachments",
  asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const sc = getServiceClient();
    if (!sc) {
      sendError(res, "server_not_configured");
      return;
    }
    const mediaId = String(req.params.id ?? "");
    if (!UUID_RE.test(mediaId)) {
      sendError(res, "invalid_payload", "Invalid media id");
      return;
    }
    const parsed = validateMediaAttachmentBody(req.body);
    if (!parsed.success) {
      sendError(res, "invalid_payload", "Invalid attachment");
      return;
    }
    const rl = checkRateLimit("media_attachments", auth.user.id, 60, 60_000);
    if (!rl.allowed) {
      res.setHeader("Retry-After", Math.ceil(rl.retryAfterMs / 1000).toString());
      sendError(res, "rate_limited", "Too many requests. Please wait.");
      return;
    }
    const body = parsed.data;
    let asset: any;
    try {
      const result = await sc
        .from("media_assets")
        .select("id, owner_user_id")
        .eq("id", mediaId)
        .maybeSingle();
      asset = result.error ? null : result.data;
    } catch {
      asset = null;
    }
    // BOTH halves must hold: the caller owns the ASSET and may attach to the
    // ENTITY. Missing, not-owned and not-permitted deliberately share one
    // `not_found`, so neither half leaks which one failed.
    if (
      !asset ||
      asset.owner_user_id !== auth.user.id ||
      !(await ownsAttachmentEntity(sc, auth.user.id, body.entity_type, body.entity_id))
    ) {
      sendError(res, "not_found", "Media item not found");
      return;
    }
    const attachmentId = await recordMediaAttachment(sc, {
      mediaAssetId: mediaId,
      entityType: body.entity_type,
      entityId: body.entity_id,
      position: body.position,
      isCover: body.is_cover,
      visibilityOverride: body.visibility_override,
    });
    if (!attachmentId) {
      // recordMediaAttachment returns null when `media_canonical_enabled` is off
      // or the upsert was rejected. Neither is a state this endpoint can report
      // usefully without saying whether the asset exists.
      sendError(res, "not_found", "Media item not found");
      return;
    }
    res.status(200).json({
      id: attachmentId,
      mediaAssetId: mediaId,
      entityType: body.entity_type,
      entityId: body.entity_id,
    });
  }),
);

// ── GET /media/:id/actions ────────────────────────────────────────────────────
router.get(
  "/media/:id/actions",
  asyncHandler(async (req, res) => {
    const nowMs = Date.now();
    const auth = await requireUser(req, res);
    if (!auth) return;
    const sc = getServiceClient();
    if (!sc) {
      sendError(res, "server_not_configured");
      return;
    }
    const id = String(req.params.id ?? "");
    if (!UUID_RE.test(id)) {
      sendError(res, "invalid_payload", "Invalid media id");
      return;
    }
    const rl = checkRateLimit("media_actions", auth.user.id, 120, 60_000);
    if (!rl.allowed) {
      res.setHeader("Retry-After", Math.ceil(rl.retryAfterMs / 1000).toString());
      sendError(res, "rate_limited", "Too many requests. Please wait.");
      return;
    }
    const viewer = await resolveViewer(sc, auth.user.id, { needFollows: true });
    const result = await resolveMediaActions(sc, viewer, id, nowMs);
    if (!result) {
      // Not visible to this viewer (private / blocked / ineligible) or missing —
      // a probe-safe not_found, identical to GET /media/:id.
      sendError(res, "not_found", "Media item not found");
      return;
    }
    res.json({ ...result, generatedAt: new Date(nowMs).toISOString() });
  }),
);

// ── POST /media/:id/intent  ("I Want This", §15.1) ────────────────────────────
const intentBodySchema = z.object({
  intent: z.enum(MEDIA_INTENT_KINDS).default("want_to_go"),
});

router.post(
  "/media/:id/intent",
  asyncHandler(async (req, res) => {
    const nowMs = Date.now();
    const auth = await requireUser(req, res);
    if (!auth) return;
    const sc = getServiceClient();
    if (!sc) {
      sendError(res, "server_not_configured");
      return;
    }
    const id = String(req.params.id ?? "");
    if (!UUID_RE.test(id)) {
      sendError(res, "invalid_payload", "Invalid media id");
      return;
    }
    const parsed = intentBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
      return;
    }
    const rl = checkRateLimit("media_intent", auth.user.id, 60, 60_000);
    if (!rl.allowed) {
      res.setHeader("Retry-After", Math.ceil(rl.retryAfterMs / 1000).toString());
      sendError(res, "rate_limited", "Too many requests. Please wait.");
      return;
    }

    // Resolve the media THROUGH the eligibility gate: an intent can only be
    // recorded on an item the viewer may see, and the entity it is keyed to is
    // resolved server-side (never trusted from the client).
    const viewer = await resolveViewer(sc, auth.user.id, { needFollows: true });
    const row = await loadEligibleMediaRow(sc, viewer, id);
    if (!row) {
      sendError(res, "not_found", "Media item not found");
      return;
    }
    // The eligibility gate knows blocks, mutes, visibility and membership. It
    // does NOT know the directional per-trip circle overrides, which are a
    // statement about a PERSON inside one trip rather than about the post. A
    // viewer the author has hidden themselves from must not be able to record
    // an intent signal against that author's trip media, so the same check
    // lib/mediaAccess applies to the bytes is applied here to the write.
    if ((row as any).trip_id && (row as any).author_id &&
      !(await authorizeMediaContext(sc, auth.user.id, String((row as any).author_id), {
        contextType: "trip",
        contextId: String((row as any).trip_id),
      }))) {
      sendError(res, "not_found", "Media item not found");
      return;
    }
    const entities = await resolveMediaEntities(sc, viewer, row, nowMs);
    const entityType = entities.tripId
      ? "trip"
      : entities.gemId
        ? "gem"
        : entities.placeId
          ? "place"
          : "media";
    const entityId = entities.tripId ?? entities.gemId ?? entities.placeId ?? id;

    const result = await recordMediaIntent(
      sc,
      auth.user.id,
      id,
      { entityType, entityId },
      parsed.data.intent as MediaIntentKind,
    );
    if (!result.recorded) {
      sendError(res, "db_error", "Could not record intent", { exposeDetail: false });
      return;
    }
    res.status(200).json({ recorded: true, intent: parsed.data.intent, entityType, entityId });
  }),
);

// ── DELETE /media/:id/intent  (undo the signal) ───────────────────────────────
router.delete(
  "/media/:id/intent",
  asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const sc = getServiceClient();
    if (!sc) {
      sendError(res, "server_not_configured");
      return;
    }
    const id = String(req.params.id ?? "");
    if (!UUID_RE.test(id)) {
      sendError(res, "invalid_payload", "Invalid media id");
      return;
    }
    const { error } = await (sc as any)
      .from("media_intent_signals")
      .delete()
      .eq("user_id", auth.user.id)
      .eq("media_id", id);
    if (error) {
      req.log?.warn({ err: error }, "media/intent: delete failed");
      sendError(res, "db_error", "Could not remove intent", { exposeDetail: false });
      return;
    }
    res.status(200).json({ removed: true });
  }),
);

// ── GET /media/experiences/:experienceId/plan  ("Do This Experience", §15.2) ──
router.get(
  "/media/experiences/:experienceId/plan",
  asyncHandler(async (req, res) => {
    const nowMs = Date.now();
    const auth = await requireUser(req, res);
    if (!auth) return;
    const sc = getServiceClient();
    if (!sc) {
      sendError(res, "server_not_configured");
      return;
    }
    const experienceId = String(req.params.experienceId ?? "");
    if (!UUID_RE.test(experienceId)) {
      sendError(res, "invalid_payload", "Invalid experience id");
      return;
    }
    const rl = checkRateLimit("media_experience_plan", auth.user.id, 60, 60_000);
    if (!rl.allowed) {
      res.setHeader("Retry-After", Math.ceil(rl.retryAfterMs / 1000).toString());
      sendError(res, "rate_limited", "Too many requests. Please wait.");
      return;
    }
    const viewer = await resolveViewer(sc, auth.user.id, { needFollows: true });
    const proposal = await buildDoThisExperiencePlan(sc, viewer, experienceId, nowMs);
    if (!proposal) {
      // Experience not visible to this viewer (private / blocked / missing).
      sendError(res, "not_found", "Experience not available");
      return;
    }
    res.json({ ...proposal, generatedAt: new Date(nowMs).toISOString() });
  }),
);

export default router;
