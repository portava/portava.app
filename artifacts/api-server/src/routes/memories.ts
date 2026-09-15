/**
 * Memory System routes
 *
 * POST   /memories                       — create a memory
 * GET    /memories/:id                   — get a memory (privacy-gated)
 * PATCH  /memories/:id                   — update (owner only)
 * DELETE /memories/:id                   — soft-delete (owner only)
 *
 * POST   /memories/:id/items             — add item (photo/video)
 * DELETE /memories/:id/items/:itemId     — remove item
 *
 * GET    /memories/:id/tags              — list tags
 * PATCH  /memories/:id/tags/:userId      — approve / remove self-tag
 *
 * POST   /memories/:id/like              — like (idempotent)
 * DELETE /memories/:id/like              — unlike
 * POST   /memories/:id/save              — save (idempotent)
 * DELETE /memories/:id/save              — unsave
 * POST   /memories/:id/share             — log share intent
 *
 * POST   /trips/:tripId/memory           — create-from-trip (owner only)
 * POST   /events/:eventId/memory         — handled in events.ts (stub upgraded below)
 *
 * GET    /users/:userId/memories         — public memory listing for a profile
 * GET    /memories                       — discovery feed (public only)
 */

import { Router } from "express";
import { z } from "zod";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import { sendPushWithRetry } from "../lib/pushWithRetry.js";
import { nameVisibilitySet, nameVisibleFor } from "../lib/publicIdentity.js";
import {
  loadParticipantVisibility,
  projectParticipants,
} from "../services/memory/memoryParticipantVisibility.js";
import { truncateDisplayName } from "../lib/displayName.js";
import { logger } from "../lib/logger.js";
import { linkOutcomeSignal } from "../compass/CompassOutcomeEngine.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  loadRestrictiveGems,
  gemCeilingForItem,
  UNDETERMINED_GEM_CEILING,
  type RestrictiveGem,
  type LocationVisibilityTier,
} from "../lib/mediaLocationVisibility.js";
import {
  MEMORY_LOCATION_PRECISIONS,
  normalizeMemoryPrecision,
  normalizeMemoryPrecisionForWrite,
  publicationPrecision,
  resolveMemoryLocationCeiling,
  coarsenMemoryLocation,
} from "../lib/memoryLocationPrecision.js";
// §17 Command Bus and Domain Events. Every canonical Memory write below crosses
// this boundary: a typed command, an actor, an idempotency key, an audit row
// and — when the kernel is enabled — a domain event in the same transaction as
// the state change. See lib/memoryCommandBus.ts for what runs with the flag off.
import {
  lifecycleStateOf,
  readMemoryCommandEnvelope,
  sendMemoryCommandRejection,
} from "../lib/memoryCommandBus.js";
import { asHistoricalMemoryPayload } from "../services/memory/historicalTruth.js";
// §13 compression hierarchy — see GET /memories/graph below.
// §18 projection registry — see GET /trips/:tripId/memories/recap below. Until
// this import existed, NOTHING outside src/test/ and the certification suite
// read the registry, which is the blanket reason every §18 row is BBW.
import {
  getProjectionDefinition,
  sourceVersionOf,
  type MemorySourceRow,
} from "../services/memoryProjections/projectionRegistry.js";
import {
  buildCompressionHierarchy,
  deriveChapterThemes,
  unplacedAt,
  type CompressedNode,
  type GraphMoment,
} from "../services/memoryProjections/memoryGraph.js";
// §21 / §28.8. A Memory whose audience narrows, or which is deleted, must not
// survive inside a cached Compass projection. See
// services/memory/memoryAudienceRevocation.ts for why this is NOT the one-line
// `invalidateCompassCache(sc, user.id, …)` the highlights surface uses
// (routes/highlights.ts:977): the user whose cache holds a Memory is almost
// never the user who narrowed it, so the targets are resolved, not assumed.
import {
  audienceChanged,
  mergedAudience,
  revokeMemoryAudienceCaches,
} from "../services/memory/memoryAudienceRevocation.js";
import { runMemoryDeletionLifecycle } from "../services/memory/memoryDeletionLifecycle.js";
import {
  classifyMemoryMediaUrl,
  FOREIGN_MEDIA_REFUSAL,
} from "../services/memory/memoryMediaOrigin.js";
import {
  authorizeParticipantCommand,
  commandTypeForPatch,
  dispatchMemoryCommand,
  guardLifecycle,
  loadMemoryForCommand,
  type CommandOutcome,
} from "../services/memory/MemoryDomainService.js";

const router = Router();
const UUID_RE = /^[0-9a-f-]{36}$/i;
function isUuid(s: string) { return UUID_RE.test(s); }

// ── Hidden-Gem location protection for memory reads (Media v2 P1b) ─────────────
//
// A memory carries an exact location_lat/location_lng that reaches non-owner
// viewers (the public discovery feed, and any shared/visible single memory). If
// that coordinate sits on a protected Hidden Gem it de-anonymizes a location the
// gem guard hides. Memories link to places via canonical_location_id (not the
// gem's canonical_place_id), so the cross-check here is coordinate proximity
// (plus city, to scope the gem load). Owner sees their own memory unchanged.
// Fail-closed: a gem-lookup failure coarsens every non-owner read.

interface MemoryGemContext {
  gems: RestrictiveGem[];
  determined: boolean;
}

async function loadMemoryGemContext(
  db: SupabaseClient,
  rows: any[],
): Promise<MemoryGemContext> {
  try {
    const gems = await loadRestrictiveGems(db, {
      placeIds: [],
      cities: rows.map((r) => r?.location_city ?? null),
    });
    return { gems, determined: true };
  } catch {
    return { gems: [], determined: false };
  }
}

/**
 * Coarsen a raw memory row's location (snake_case) to the STRICTER of two
 * independent ceilings, for a non-owner viewer:
 *
 *   1. the Hidden-Gem ceiling — a property of the PLACE. "Is this coordinate
 *      sitting on a gem whose own guard hides it?" Fail-closed when the gem
 *      status could not be determined.
 *   2. the owner's §10 `location_precision` rung — a property of the OWNER'S
 *      CHOICE. "How precisely may this Memory of mine be published to anyone
 *      who is not me?" Read only when `memory_location_precision_enabled` is
 *      on, because production does not have the column (see migration 2338).
 *
 * These answer different questions and neither subsumes the other: a Memory at
 * an unremarkable address has no gem to protect it, and a Memory on a protected
 * gem is coarsened however permissive its owner's rung is.
 *
 * Owner bypass. Both ceilings absent ⇒ row returned unchanged, which with the
 * flag off is byte-for-byte the pre-2338 behaviour. Operates before mapMemory /
 * enrichMemories so the coarsened values flow through every projection.
 */
function protectMemoryRow(
  row: any,
  ctx: MemoryGemContext,
  viewerId: string,
  precisionEnabled: boolean,
): any {
  if (row?.owner_id === viewerId) return row; // owner sees their own exact
  const lat = row?.location_lat != null ? Number(row.location_lat) : null;
  const lng = row?.location_lng != null ? Number(row.location_lng) : null;
  const gemCeiling: LocationVisibilityTier | null = ctx.determined
    ? gemCeilingForItem(ctx.gems, { placeId: null, lat, lng })
    : UNDETERMINED_GEM_CEILING; // fail-closed
  // Flag off ⇒ 'exact' ⇒ contributes no constraint, so `ceiling` collapses to
  // exactly the gem ceiling and this function is a no-op wherever it was before.
  // Flag on ⇒ the row's rung; a row that does not carry the key, or carries
  // null / a value off the ladder, is clamped to 'hidden' — the read-side
  // normalization that keeps an unreadable policy from being served as 'exact'.
  const ownerPrecision = publicationPrecision(row, precisionEnabled);
  const ceiling = resolveMemoryLocationCeiling(ownerPrecision, gemCeiling);
  if (ceiling == null) return row; // no constraint from either source → unchanged
  const d = coarsenMemoryLocation(row, ceiling);
  return {
    ...row,
    location_city: d.city,
    location_country: d.country,
    location_lat: d.lat, // coarse grid-snapped — never the exact stored coord
    location_lng: d.lng,
  };
}

// ── Feature flag ───────────────────────────────────────────────────────────────

// FL-04: removed the dead memoriesEnabled() helper — it was never called and
// failed OPEN, contradicting the fail-closed isFlagEnabled contract. The Memories
// routes are intentionally ungated (backend is live).

// ── Visibility helpers ─────────────────────────────────────────────────────────
//
// §23's `canReadMemory(userId, memoryId, surface)`, the accepted-crew rule and
// the bidirectional block check MOVED to `services/memory/memoryReadPolicy.ts`.
// Nothing in the ladder changed; what changed is that it is no longer
// module-private, which was the CEILING census-highlights-memories H205 stated
// on itself. §16's Compass accessors now call the same function rather than
// adding a fourth transcription of the rule to the repository.
import {
  VISIBILITY_VALUES,
  canReadMemory,
  canPublishMemory,
  acceptedCrewOfTrip,
  isBlocked,
  type MemoryReadSurface,
} from "../services/memory/memoryReadPolicy.js";

export type { MemoryReadSurface };


/**
 * The viewer's block set, in both directions, as an explicit result.
 *
 * Fail CLOSED, and the reason it returns a discriminated result rather than a
 * Set is that a Set has no way to say "I could not establish this". supabase-js
 * RESOLVES on a DB error, so `data ?? []` on an errored blocks query yields an
 * EMPTY set — nothing filtered — which reads at the call site exactly like "this
 * viewer has blocked nobody". That is how a transient blocks-table failure
 * turns into a feed that serves blocked owners' content (audit MEM·M6, and
 * §28.11: "never swallow projection/schema failures into plausible-looking
 * empty history without structured error state").
 */
async function loadBlockedIds(
  sc: any,
  viewerId: string,
): Promise<{ ok: true; ids: Set<string> } | { ok: false; error: unknown }> {
  const [blockedByMe, blockingMe] = await Promise.all([
    sc.from("blocks").select("blocked_id").eq("blocker_id", viewerId),
    sc.from("blocks").select("blocker_id").eq("blocked_id", viewerId),
  ]);
  if (blockedByMe.error || blockingMe.error) {
    return { ok: false, error: blockedByMe.error ?? blockingMe.error };
  }
  return {
    ok: true,
    ids: new Set<string>([
      ...((blockedByMe.data ?? []).map((r: any) => r.blocked_id as string)),
      ...((blockingMe.data ?? []).map((r: any) => r.blocker_id as string)),
    ]),
  };
}

// ── Schemas ────────────────────────────────────────────────────────────────────

const createMemorySchema = z.object({
  title: z.string().max(300).nullable().optional(),
  caption: z.string().max(2000).nullable().optional(),
  visibility: z.enum(VISIBILITY_VALUES).default("friends_only"),
  allowedUserIds: z.array(z.string().uuid()).max(200).optional().default([]),
  hiddenUserIds: z.array(z.string().uuid()).max(200).optional().default([]),
  tripId: z.string().uuid().nullable().optional(),
  eventId: z.string().uuid().nullable().optional(),
  placeId: z.string().max(200).nullable().optional(),
  locationCity: z.string().max(200).nullable().optional(),
  locationCountry: z.string().max(200).nullable().optional(),
  locationLat: z.number().min(-90).max(90).nullable().optional(),
  locationLng: z.number().min(-180).max(180).nullable().optional(),
  canonicalLocationId: z.string().uuid().nullable().optional(),
  // §10 — the owner's ceiling on how precisely this Memory may be published.
  // OPTIONAL, and left undefined the column keeps its DEFAULT 'exact', so a
  // client that has never heard of it creates exactly what it created before.
  locationPrecision: z.enum(MEMORY_LOCATION_PRECISIONS).optional(),
  startsAt: z.string().datetime({ offset: true }).nullable().optional(),
  endsAt: z.string().datetime({ offset: true }).nullable().optional(),
  state: z.enum(["draft", "published"]).default("published"),
  taggedUserIds: z.array(z.string().uuid()).max(50).optional().default([]),
});

const patchMemorySchema = z.object({
  title: z.string().max(300).nullable().optional(),
  caption: z.string().max(2000).nullable().optional(),
  visibility: z.enum(VISIBILITY_VALUES).optional(),
  allowedUserIds: z.array(z.string().uuid()).max(200).optional(),
  hiddenUserIds: z.array(z.string().uuid()).max(200).optional(),
  placeId: z.string().max(200).nullable().optional(),
  locationCity: z.string().max(200).nullable().optional(),
  locationCountry: z.string().max(200).nullable().optional(),
  locationLat: z.number().min(-90).max(90).nullable().optional(),
  locationLng: z.number().min(-180).max(180).nullable().optional(),
  canonicalLocationId: z.string().uuid().nullable().optional(),
  locationPrecision: z.enum(MEMORY_LOCATION_PRECISIONS).optional(),
  startsAt: z.string().datetime({ offset: true }).nullable().optional(),
  endsAt: z.string().datetime({ offset: true }).nullable().optional(),
  state: z.enum(["draft", "published", "archived"]).optional(),
});

const addItemSchema = z.object({
  mediaUrl: z.string().url(),
  mediaType: z.string().min(1).max(100).default("image/jpeg"),
  caption: z.string().max(500).nullable().optional(),
  position: z.number().int().min(0).default(0),
});

const patchTagSchema = z.object({
  action: z.enum(["approve", "remove"]),
});

// ── §17 command plumbing for the handlers below ───────────────────────────────

/**
 * Render a MemoryDomainService outcome that is NOT a success.
 *
 * Two refusal shapes, deliberately kept apart. A `rejection` is command-shaped
 * — a §5 illegal transition, a §23 capability refusal, the kernel being absent
 * — and carries a §24 reason code the client can switch on; lib/memoryCommandBus
 * .sendMemoryCommandRejection owns that mapping so every route answers the same
 * refusal the same way. An `http` error is everything else (an unreadable table,
 * a write that matched zero rows) and keeps the exact code, status and message
 * the handler used before this lane, so no existing client sees a new shape for
 * an old failure.
 */
function sendCommandFailure(
  req: any,
  res: any,
  outcome: Extract<CommandOutcome<unknown>, { ok: false }>,
): void {
  if ("rejection" in outcome) {
    sendMemoryCommandRejection(res, outcome.rejection, req.log);
    return;
  }
  const e = outcome.http;
  sendError(res, e.code as any, e.message, e.exposeDetail ? { exposeDetail: true } : undefined);
}

/**
 * Read the §19 Idempotency-Key header, or answer 400.
 *
 * Absent header => a fresh UUID, i.e. the request is not idempotent — exactly
 * what every Memory write did before this lane, so an unaware client is not
 * given a dedup window keyed on something it did not choose.
 */
function requireIdempotencyKey(req: any, res: any): string | null {
  const env = readMemoryCommandEnvelope(req);
  if (!env.ok) { sendError(res, "invalid_payload", env.message); return null; }
  return env.idempotencyKey;
}

// ── Notification helper ────────────────────────────────────────────────────────

async function notifyTagged(sc: any, memory: any, taggedUserId: string): Promise<void> {
  try {
    const { data: owner } = await sc
      .from("profiles")
      .select("name, handle, expo_push_token")
      .eq("id", memory.owner_id)
      .maybeSingle();

    const { data: tagged } = await sc
      .from("profiles")
      .select("expo_push_token")
      .eq("id", taggedUserId)
      .maybeSingle();

    if (tagged?.expo_push_token) {
      const ownerNameAllowed = await nameVisibleFor(sc, memory.owner_id);
      const ownerName = truncateDisplayName(ownerNameAllowed
        ? (owner?.name ?? (owner?.handle ? `@${owner.handle}` : "Someone"))
        : (owner?.handle ? `@${owner.handle}` : "Someone"));
      await sendPushWithRetry(sc, { userId: taggedUserId, tokens: [tagged.expo_push_token] }, {
        title: "You were tagged in a Memory",
        body: `${ownerName} tagged you in a memory. Tap to approve or remove.`,
        data: { screen: "memory", memoryId: memory.id },
      });
    }

    // supabase-js resolves rather than throws on a DB error, so the old
    // `.then(()=>{}).catch(()=>{})` discarded a failed insert silently — and this
    // notification is how the tagged user learns they can approve/remove the tag.
    // Still non-fatal, but a failure is now visible in the server log.
    const { error: notifErr } = await sc.from("notifications").insert({
      user_id: taggedUserId,
      actor_id: memory.owner_id,
      event_type: "trip.memory_tagged",
      category: "trips",
      title: "You were tagged in a Memory",
      body: "Tap to approve or remove the tag.",
      metadata: { memoryId: memory.id, memoryTitle: memory.title },
    });
    if (notifErr) {
      logger.warn({ err: notifErr, taggedUserId, memoryId: memory.id },
        "notifyTagged: notifications insert failed — tagged user not informed in-app");
    }
  } catch (err) {
    // Non-fatal, but observable.
    logger.warn({ err, taggedUserId, memoryId: memory?.id }, "notifyTagged: unexpected error");
  }
}

async function notifyLike(sc: any, memoryId: string, ownerId: string, likerId: string): Promise<void> {
  try {
    if (ownerId === likerId) return;
    const { data: liker } = await sc
      .from("profiles")
      .select("name, handle")
      .eq("id", likerId)
      .maybeSingle();
    const { data: owner } = await sc
      .from("profiles")
      .select("expo_push_token")
      .eq("id", ownerId)
      .maybeSingle();
    if (owner?.expo_push_token) {
      const likerNameAllowed = await nameVisibleFor(sc, likerId);
      const likerName = truncateDisplayName(likerNameAllowed
        ? (liker?.name ?? (liker?.handle ? `@${liker.handle}` : "Someone"))
        : (liker?.handle ? `@${liker.handle}` : "Someone"));
      await sendPushWithRetry(sc, { userId: ownerId, tokens: [owner.expo_push_token] }, {
        title: "New like on your Memory",
        body: `${likerName} liked your memory.`,
        data: { screen: "memory", memoryId },
      });
    }
  } catch {
    // Non-fatal
  }
}

// ── POST /memories ─────────────────────────────────────────────────────────────

router.post("/memories", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const parsed = createMemorySchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }
  const d = parsed.data;

  const idempotencyKey = requireIdempotencyKey(req, res);
  if (idempotencyKey === null) return;

  // §5. A create names its own starting state. The schema admits draft or
  // published; neither is a transition, but naming them through the same
  // vocabulary is what lets the event payload carry a §5 `to_state` rather than
  // the legacy column value.
  const createState = lifecycleStateOf(d.state);

  // §23 `canPublishMemory(userId, memoryId, audience)`. It refuses only the
  // audiences canReadMemory could deliver to NOBODY - a crew audience with no
  // trip, a crew audience whose owner is not accepted crew, and a custom
  // audience with an empty list - so a user is never told their Memory is
  // shared with people it reaches none of. See
  // services/memory/memoryReadPolicy.ts for why those three and no others.
  const publishable = await canPublishMemory(
    sc,
    user.id,
    { owner_id: user.id, trip_id: d.tripId ?? null, allowed_user_ids: d.allowedUserIds },
    d.visibility,
  );
  if (!publishable.ok) {
    sendError(res, "conflict", publishable.message, { exposeDetail: true, reason: publishable.reason });
    return;
  }

  const precisionEnabled = await isFlagEnabled(sc, "memory_location_precision_enabled");

  // A client may not name a column this database does not have: PostgREST fails
  // the WHOLE insert on an unknown key (PGRST204), so an accepted-but-unwritable
  // field would take Memory creation to 100% failure. With the flag off, a
  // locationPrecision the client sent is dropped — the same posture
  // routes/highlights.ts documents for media_thumbnail_url.
  //
  // `undefined` rather than a conditional spread, deliberately. Measured against
  // the installed @supabase/supabase-js: an undefined property is dropped from
  // the request entirely — it appears neither in the JSON body nor in a
  // `columns=` parameter — so with the flag off this insert is byte-identical on
  // the wire to the pre-2338 one. A spread would have produced the same request
  // but a payload that `src/scripts/checkWritePathColumns.ts` cannot resolve
  // statically, which trades a real guarantee for a cosmetic one: that check is
  // the thing standing between this route and the PGRST204 outage above.
  // Write-side normalization: only an exact ladder value is ever named; anything
  // else leaves the column to its DEFAULT (whose value is the owner's pending
  // decision, not this route's).
  const precisionValue = precisionEnabled ? normalizeMemoryPrecisionForWrite(d.locationPrecision) : undefined;

  const insertRow = {
    location_precision: precisionValue,
    owner_id: user.id,
    title: d.title ?? null,
    caption: d.caption ?? null,
    visibility: d.visibility,
    allowed_user_ids: d.allowedUserIds,
    hidden_user_ids: d.hiddenUserIds,
    trip_id: d.tripId ?? null,
    event_id: d.eventId ?? null,
    place_id: d.placeId ?? null,
    location_city: d.locationCity ?? null,
    location_country: d.locationCountry ?? null,
    location_lat: d.locationLat ?? null,
    location_lng: d.locationLng ?? null,
    canonical_location_id: d.canonicalLocationId ?? null,
    starts_at: d.startsAt ?? null,
    ends_at: d.endsAt ?? null,
    state: d.state,
  };

  const created = await dispatchMemoryCommand<any>({
    sc,
    commandType: "CREATE_MEMORY",
    memoryId: null, // assigned by the kernel / the database
    actorUserId: user.id,
    idempotencyKey,
    payload: {
      to_state: createState,
      visibility: d.visibility,
      write: insertRow,
      select: precisionEnabled ? MEMORY_CREATE_SELECT_WITH_PRECISION : MEMORY_CREATE_SELECT,
    },
    legacy: async () => {
      const { data, error } = await sc
        .from("memories")
        .insert(insertRow)
        .select((precisionEnabled ? MEMORY_CREATE_SELECT_WITH_PRECISION : MEMORY_CREATE_SELECT) as any)
        .single();
      if (error) {
        req.log.error({ err: error }, "memories: create failed");
        return { ok: false, http: { code: "db_error", message: error.message } };
      }
      return { ok: true, body: data };
    },
  });

  if (!created.ok) { sendCommandFailure(req, res, created); return; }
  const memory = created.body;

  // Tag users if provided. §17 ADD_PERSON — the participant set is part of the
  // Memory, and a replay of CREATE_MEMORY must not tag anyone twice, which is
  // why this is skipped on a duplicate: the original command already did it.
  if (d.taggedUserIds.length > 0 && !created.duplicate) {
    const tagRows = d.taggedUserIds
      .filter((uid) => uid !== user.id)
      .map((uid) => ({
        memory_id: (memory as any).id,
        tagged_user_id: uid,
        status: "pending",
      }));

    if (tagRows.length > 0) {
      // `.then(undefined, () => {})` — MEASURED THIS SESSION: that is a
      // REJECTION handler, and supabase-js RESOLVES on a database error, so it
      // never ran for the failure it was written to absorb. The tag insert
      // failing meant nobody was tagged, no notification row was written, and
      // the route answered 201 with a `taggedUserIds` the caller had every
      // reason to believe had landed. Not fatal to the Memory — the Memory is
      // created and correct — so the response stays 201, but the failure is now
      // visible in the log and the per-user notification loop is skipped rather
      // than told about tags that do not exist.
      const { error: tagErr } = await sc.from("memory_tags").insert(tagRows);
      if (tagErr) {
        req.log.error({ err: tagErr, memoryId: (memory as any).id, count: tagRows.length },
          "memories: create tagged nobody — memory_tags insert failed");
      } else {
        for (const uid of d.taggedUserIds.filter((u) => u !== user.id)) {
          notifyTagged(sc, memory, uid);
        }
      }
    }
  }

  // Phase 14 — a memory made at a recommended event/place is the strongest
  // realized-outcome signal; link it back to the originating recommendation.
  const outcomeAnchorId = d.eventId ?? d.placeId ?? d.tripId ?? null;
  void linkOutcomeSignal(sc, user.id, outcomeAnchorId, "made_memory", "route:memory_create");

  res.status(201).json({ memory: mapMemory(memory, user.id) });
});

// ── GET /memories (discovery feed) ────────────────────────────────────────────

router.get("/memories", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const limit = Math.min(Number(req.query.limit ?? 30), 100);
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : null;

  const precisionEnabled = await isFlagEnabled(sc, "memory_location_precision_enabled");

  // ── Two defects lived in the shape this route used to have ─────────────────
  //
  // 1. `.limit(n)` ran in the DATABASE and the block filter ran afterwards in
  //    TypeScript, so a page silently shrank by however many blocked owners it
  //    happened to contain — request 30, receive 27. And because `nextCursor` is
  //    emitted only when `visible.length === limit`, that shrunken page also
  //    ENDED the feed: one blocked owner anywhere in the first page and the
  //    viewer's discovery feed simply stopped, with more rows behind it.
  //
  // 2. Far worse: the feed never consulted `hidden_user_ids` at all. Every
  //    OTHER read path routes through canReadMemory, whose comment states that
  //    "a hidden viewer is denied for EVERY visibility mode" (audit MEM·M1) —
  //    but the feed did not call it. A user the owner had explicitly hidden
  //    read that owner's public Memories in the global discovery feed. The fix
  //    for MEM·M1 landed inside the helper; the one path that bypassed the
  //    helper never got it.
  //
  // Both are the same architectural mistake, and the spec names it: §10 "public
  // search only queries public derivatives, never private canonical storage
  // followed by post-query filtering", restated as a prohibition in §28.6.
  // Post-query filtering is not merely inelegant — it is how a filter goes
  // missing, because nothing about the query says which predicates are owed.
  //
  // So every privacy predicate now runs INSIDE the query, and LIMIT applies to
  // the already-filtered set. Two ways to do that, and both are here:
  //
  //   • `memory_public_feed_projection_enabled` ON → the §18
  //     PublicMemoryProjection (migration 2338): one RPC, all predicates in
  //     SQL, and a return shape that does not even contain the owner's
  //     allow/hide lists.
  //   • OFF → the PostgREST path below, carrying the same predicates as query
  //     filters. It exists because production has neither the function nor the
  //     column, and the leak had to close there too.
  //
  // Both paths are exercised in src/test/memoriesPublicFeedPrivacy.test.ts, and
  // the derivative's SQL was additionally rehearsed against portava-ci with the
  // five-row fixture (public / only_me / draft / hidden-from-viewer / blocked
  // owner) that it must reduce to one.
  const blockList = await loadBlockedIds(sc, user.id);
  if (!blockList.ok) {
    req.log.error({ err: blockList.error }, "memories: block lookup failed — failing closed");
    sendError(res, "db_error", "Could not resolve block state");
    return;
  }
  const blockedSet = blockList.ids;

  const useProjection = await isFlagEnabled(sc, "memory_public_feed_projection_enabled");

  let rows: any[];
  if (useProjection) {
    const { data, error } = await (sc as any).rpc("memory_public_feed", {
      p_viewer: user.id,
      p_limit: limit,
      p_cursor: cursor,
    });
    if (error) {
      req.log.error({ err: error }, "memories: public feed projection failed");
      sendError(res, "db_error", error.message);
      return;
    }
    rows = (data ?? []) as any[];
  } else {
    let q = sc
      .from("memories")
      .select((precisionEnabled ? MEMORY_SELECT_WITH_PRECISION : MEMORY_SELECT) as any)
      .eq("state", "published")
      .eq("visibility", "public")
      // MEM·M1 on the surface that was missing it: a viewer the owner hid never
      // reaches the feed's result set in the first place.
      .not("hidden_user_ids", "cs", `{${user.id}}`)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (blockedSet.size > 0) {
      // Quoted list, matching the established form in this repo
      // (routes/discoverySearch.ts, routes/compassHome.ts): PostgREST accepts a
      // bare uuid, but quoting is what every other `not.in` site here does and
      // it is the form that stays correct if the values ever stop being uuids.
      (q as any) = (q as any).not("owner_id", "in", `(${[...blockedSet].map((b) => `"${b}"`).join(",")})`);
    }
    if (cursor) {
      (q as any) = (q as any).lt("created_at", cursor);
    }

    const { data, error } = await q;
    if (error) {
      req.log.error({ err: error }, "memories: discovery failed");
      sendError(res, "db_error", error.message);
      return;
    }
    rows = (data ?? []) as any[];
  }

  // Defence in depth, not the filter. Every predicate above already ran in the
  // database; this re-asserts the verdict on the public surface so that a
  // future edit to either query cannot reintroduce the leak silently. It can
  // only ever remove rows, never add them, and on a correct query it removes
  // none — which is what the mutation test in memoriesPublicFeedPrivacy asserts.
  const feedChecks = await Promise.all(
    rows.map((m) => canReadMemory(sc, m, user.id, "public_feed")),
  );
  const visibleRaw = rows.filter((m, i) => feedChecks[i] && !blockedSet.has(m.owner_id as string));

  // Location protection (fail-closed): the stricter of the Hidden-Gem ceiling
  // and the owner's §10 precision rung. It is applied INSIDE `enrichMemories`
  // now — see that function's header for why it moved — so this handler states
  // the ceiling and not the mechanism.
  //
  // `|| useProjection` closes a flag-COMBINATION hazard. The derivative always
  // returns `location_precision` (it cannot exist without migration 2338), so a
  // database where someone turned the projection flag on and left the precision
  // flag off would serve rows that carry an owner's narrowed rung while ignoring
  // it — a privacy regression produced by a configuration nobody intended.
  // Neither flag may widen disclosure; only narrow it.
  const clampPrecision = precisionEnabled || useProjection;
  // Kept as an alias rather than folded away: `visible` is read below for the
  // saved-collection lookup and the cursor, and both read only `id` and
  // `created_at`, which no coarsening touches. The coarsened rows are the ones
  // `enrichMemories` serializes.
  const visible = visibleRaw;

  const enriched = await enrichMemories(sc, visible, user.id, clampPrecision);

  // Batch-fetch saved state for the viewer across these memories
  const memoryIds = visible.map((m: any) => m.id as string);
  const savedMemoryIds = new Set<string>();
  try {
    const { data: userCols } = await sc
      .from("collections")
      .select("id")
      .eq("owner_id", user.id);
    const colIds = ((userCols ?? []) as any[]).map((c) => c.id as string);
    if (colIds.length > 0 && memoryIds.length > 0) {
      const { data: savedItems } = await sc
        .from("collection_items")
        .select("entity_id")
        .eq("entity_type", "memory")
        .in("collection_id", colIds)
        .in("entity_id", memoryIds);
      for (const s of (savedItems ?? []) as any[]) savedMemoryIds.add(s.entity_id as string);
    }
  } catch { /* non-fatal */ }

  res.json({
    memories: (enriched as any[]).map((m: any) => ({ ...m, isSaved: savedMemoryIds.has(m.id as string) })),
    nextCursor: visible.length === limit ? (visible[visible.length - 1]?.created_at ?? null) : null,
  });
});

// ── GET /memories/:id ─────────────────────────────────────────────────────────

const MEMORY_SELECT = "id, owner_id, title, caption, visibility, allowed_user_ids, hidden_user_ids, trip_id, event_id, place_id, location_city, location_country, location_lat, location_lng, canonical_location_id, starts_at, ends_at, state, created_at, updated_at";

/**
 * The create-from-trip narrower list (POST /trips/:tripId/memory). Module-level
 * and a bare literal for the same reason as the two above: a select list
 * assembled at the call site is one `check:write-path-columns` cannot resolve.
 */
const TRIP_MEMORY_SELECT = "id, owner_id, title, caption, visibility, trip_id, starts_at, ends_at, state, created_at";

/**
 * The same list plus the §10 precision rung.
 *
 * TWO SELECT CONSTANTS, NOT ONE WITH A CONDITIONAL SUFFIX BUILT AT THE CALL
 * SITE, so that both strings are greppable literals: `check:write-path-columns`
 * resolves string-literal select lists through the AST and would lose sight of
 * a list assembled from fragments, and losing sight of it is precisely how a
 * column reference outlives the migration that created it.
 *
 * Which one a route uses is decided by `memory_location_precision_enabled`, and
 * that flag is a SCHEMA-PRESENCE gate, not a product switch: production has not
 * run migration 2338, and in PostgREST one unknown column fails the WHOLE
 * statement with PGRST100 — a select naming `location_precision` there returns
 * zero rows, not an error anybody sees. Same failure class as migration 0164.
 */
/**
 * POST /memories returns a narrower row than the read paths (no allow/hide
 * lists, no updated_at). Same two-literal rule as MEMORY_SELECT.
 */
const MEMORY_CREATE_SELECT = "id, owner_id, title, caption, visibility, trip_id, event_id, place_id, location_city, location_country, location_lat, location_lng, canonical_location_id, starts_at, ends_at, state, created_at";
const MEMORY_CREATE_SELECT_WITH_PRECISION = "id, owner_id, title, caption, visibility, trip_id, event_id, place_id, location_city, location_country, location_lat, location_lng, canonical_location_id, location_precision, starts_at, ends_at, state, created_at";

const MEMORY_SELECT_WITH_PRECISION = "id, owner_id, title, caption, visibility, allowed_user_ids, hidden_user_ids, trip_id, event_id, place_id, location_city, location_country, location_lat, location_lng, canonical_location_id, location_precision, starts_at, ends_at, state, created_at, updated_at";

/* ============================================================================
 * GET /memories/graph — §13's compression hierarchy over the caller's own
 * Memories, and the Life Chapters projected from it.
 *
 * CENSUS H104 / H105. Section D.1 filed both in group (b) — "the compression
 * hierarchy and Life Chapters are pure functions over `memories`; nothing calls
 * them". `services/memoryProjections/memoryGraph.ts` has been complete and
 * unreachable since it was written. This is the caller.
 *
 * OWNER-ONLY, AND THAT IS NOT A SIMPLIFICATION. §13's hierarchy is built over
 * a person's whole Memory set; there is no audience ladder that makes sense for
 * "a DAY node of somebody else's life", and a node carries `member_memory_ids`
 * for Memories whose individual visibility differs. So the only viewer is the
 * owner, the query is pinned to `owner_id = <caller>`, and there is no
 * `?userId=` parameter to get that wrong with.
 *
 * NOTHING IS COPIED UPWARD (§28.8 / H105). The response projects exactly the
 * `CompressedNode` shape: ids, counts, derived keys and the engine version. No
 * title, no caption, no media url appears anywhere in it, which is what makes a
 * Life Chapter a projection rather than a second copy of the Memory.
 *
 * TIME BASIS IS DECLARED, NOT ASSUMED. §3.1's `occurred_at` does not exist on
 * this schema (H17/H22), so a moment is placed by `starts_at` when the owner
 * gave one and by `created_at` when they did not — which is a RECORDING time,
 * not an occurrence time. The response says how many moments fell back
 * (`momentsOnRecordedTime`) rather than presenting a day bucket built from
 * upload timestamps as if it were a day of someone's life. `occurred_timezone`
 * does not exist either, so day and season buckets are UTC; that is stated in
 * `timezoneBasis` for the same reason.
 *
 * FAIL CLOSED ON THE COMPANION READ. supabase-js RESOLVES on a database error,
 * so `(data ?? [])` on an unreadable `memory_tags` yields a graph in which the
 * owner travelled alone — a confident, wrong answer with no companion chapter
 * in it. Both reads bind `.error` and the route refuses.
 * ============================================================================ */

/**
 * PostgREST puts `.in()` lists in the QUERY STRING. 2 000 uuids is ~74 KB of
 * URL and the request is rejected before it reaches the database — as a
 * transport error, which `(data ?? [])` would then read as "this Memory has no
 * tags". Every batched read on the two projection routes below is chunked at
 * this width, and every chunk's `.error` is checked.
 */
const IN_LIST_CHUNK = 200;

function chunkIds<T>(ids: readonly T[], size = IN_LIST_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size) as T[]);
  return out;
}

/** One page of a life. A person with more Memories than this gets the most recent. */
const GRAPH_MEMORY_LIMIT = 2000;

router.get("/memories/graph", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: rows, error } = await sc
    .from("memories")
    .select("id, owner_id, trip_id, place_id, canonical_location_id, starts_at, created_at")
    .eq("owner_id", user.id)
    .neq("state", "deleted")
    .order("starts_at", { ascending: false })
    .limit(GRAPH_MEMORY_LIMIT);
  if (error) {
    req.log.error({ err: error, ownerId: user.id }, "memories: graph read failed — refusing rather than projecting a partial life");
    sendError(res, "degraded_unavailable", "We could not build your memory graph. Please try again.");
    return;
  }

  const memoryRows = (rows ?? []) as any[];
  const ids = memoryRows.map((r) => r.id as string);

  const people = new Map<string, string[]>();
  for (const batch of chunkIds(ids)) {
    const { data: tagRows, error: tagErr } = await sc
      .from("memory_tags")
      .select("memory_id, tagged_user_id, status")
      .in("memory_id", batch)
      .eq("status", "approved");
    if (tagErr) {
      req.log.error({ err: tagErr, ownerId: user.id }, "memories: graph companion read failed — refusing rather than reporting a companion-free life");
      sendError(res, "degraded_unavailable", "We could not build your memory graph. Please try again.");
      return;
    }
    for (const t of (tagRows ?? []) as any[]) {
      const list = people.get(t.memory_id as string) ?? [];
      list.push(t.tagged_user_id as string);
      people.set(t.memory_id as string, list);
    }
  }

  let onRecordedTime = 0;
  const moments: GraphMoment[] = memoryRows.map((r) => {
    const occurred = (r.starts_at as string | null) ?? (r.created_at as string | null) ?? "";
    if (!r.starts_at) onRecordedTime++;
    return {
      memory_id: r.id as string,
      owner_id: user.id,
      occurred_at: occurred,
      // §3.1's occurred_timezone does not exist on this schema (H17), so every
      // bucket is UTC and the response says so.
      utc_offset_minutes: 0,
      // §3.6 memory_episodes is not deployed (H8), so no moment carries an
      // episode id and the EPISODE level is legitimately empty rather than
      // fabricated from proximity here.
      episode_id: null,
      trip_id: (r.trip_id as string | null) ?? null,
      place_id: (r.canonical_location_id as string | null) ?? (r.place_id as string | null) ?? null,
      people: (people.get(r.id as string) ?? []).slice().sort(),
      // §8's score has no column to be stored in (H63), and a node never
      // projects it anyway.
      significance_score: null,
    };
  });

  const themes = deriveChapterThemes(moments);
  const hierarchy = buildCompressionHierarchy(moments, themes);

  const project = (n: CompressedNode) => ({
    level: n.level,
    id: n.id,
    key: n.key,
    startedAt: n.started_at,
    endedAt: n.ended_at,
    memberMemoryIds: n.member_memory_ids,
    childNodeIds: n.child_node_ids,
    memoryCount: n.memory_count,
  });

  res.json({
    graph: {
      levels: {
        EPISODE: hierarchy.levels.EPISODE.map(project),
        DAY: hierarchy.levels.DAY.map(project),
        TRIP: hierarchy.levels.TRIP.map(project),
        SEASON: hierarchy.levels.SEASON.map(project),
        LIFE_CHAPTER: hierarchy.levels.LIFE_CHAPTER.map(project),
      },
      chapters: hierarchy.levels.LIFE_CHAPTER.map((n) => ({
        id: n.id,
        key: n.key,
        label: themes.find((t) => t.key === n.key)?.label ?? n.key,
        memoryCount: n.memory_count,
      })),
      momentCount: moments.length,
      momentsOnRecordedTime: onRecordedTime,
      timezoneBasis: "utc",
      truncated: memoryRows.length >= GRAPH_MEMORY_LIMIT,
      engineVersion: hierarchy.engine_version,
      unplaced: {
        EPISODE: unplacedAt(moments, "EPISODE").length,
        TRIP: unplacedAt(moments, "TRIP").length,
      },
    },
  });
});

// §8 significance, derived from the rows this schema actually holds, and the
// gate that decides whether a score may cross a boundary. See
// services/memory/memorySignificanceDisclosure.ts: six of §8's eleven inputs
// have no source column and are DECLARED absent rather than defaulted, because
// a partial score that reads as a complete one is the decorated green this
// census exists to catch.
import {
  UNAVAILABLE_SIGNIFICANCE_INPUTS,
  deriveSignificance,
  discloseProjectionRows,
  significanceAudienceFor,
} from "../services/memory/memorySignificanceDisclosure.js";
import { SIGNIFICANCE_POLICY_VERSION } from "../services/memoryProjections/significance.js";

// ── §18 owner-scoped projections, reached by a caller ─────────────────────────
//
// H163 / H167 / H168. The §18 block's blanket reason for BBW is "defined in the
// registry and unreachable"; section J answered it for TripMemoryProjection
// with a NEW route rather than by changing a shipped response shape, and these
// three follow that pattern exactly. Nothing below alters an existing response.
//
// THE PROJECTION IS NOT THE PERMISSION. Every builder filters to
// `scope.owner_id`'s undeleted Memories and does not run §23's ladder. These
// three destinations are the owner's own: the scope owner IS the authenticated
// caller on all three, which is the authorization and is why no route here
// accepts a `?userId=`. §10's person ladder still runs before the builder sees
// a tag, because who may be NAMED on a Memory is a separate question from who
// may read it.
//
// CEILING, on the response and not only here: the registry TABLE is 2730 and
// unapplied (H174), so these projections are built per request and NOT
// registered. `sourceVersion` travels on the response instead of being stored.
const TIMELINE_LIMIT = 500;
const PLACE_HISTORY_LIMIT = 500;
const SHARED_HISTORY_LIMIT = 500;

/**
 * Read the approved-and-disclosed tags for a set of Memories, chunked.
 *
 * §J item 5: `.in()` rides in the QUERY STRING, so an unchunked list of several
 * hundred uuids is rejected as a TRANSPORT error that `(data ?? [])` would then
 * read as "these Memories have no participants". Every chunk's `.error` is
 * bound; a failure is a refusal, never an empty list.
 */
async function readMemoryTags(
  sc: SupabaseClient,
  memoryIds: readonly string[],
): Promise<{ ok: true; tags: any[] } | { ok: false; error: unknown }> {
  const tags: any[] = [];
  for (const batch of chunkIds(memoryIds)) {
    const { data, error } = await sc
      .from("memory_tags")
      .select("memory_id, tagged_user_id, status")
      .in("memory_id", batch);
    if (error) return { ok: false, error };
    tags.push(...((data ?? []) as any[]));
  }
  return { ok: true, tags };
}

async function readMemoryItems(
  sc: SupabaseClient,
  memoryIds: readonly string[],
): Promise<{ ok: true; items: any[] } | { ok: false; error: unknown }> {
  const items: any[] = [];
  for (const batch of chunkIds(memoryIds)) {
    const { data, error } = await sc
      .from("memory_items")
      .select("memory_id")
      .in("memory_id", batch);
    if (error) return { ok: false, error };
    items.push(...((data ?? []) as any[]));
  }
  return { ok: true, items };
}

/**
 * §10's person ladder over a set of the SAME owner's Memories, per row.
 *
 * The ladder is loaded once for the whole set — its inputs are the owner, the
 * viewer and the participant ids — and re-decided per row on the only input
 * that varies, the Memory's own visibility.
 */
async function discloseParticipants(
  sc: SupabaseClient,
  ownerId: string,
  viewerId: string,
  rows: readonly any[],
  rawTags: readonly any[],
): Promise<Array<{ memory_id: string; tagged_user_id: string; status: string }>> {
  const participantIds = [...new Set(rawTags.map((t) => t.tagged_user_id as string))];
  const baseCtx = await loadParticipantVisibility(
    sc,
    { owner_id: ownerId, visibility: null, trip_id: null },
    viewerId,
    participantIds,
  );
  const out: Array<{ memory_id: string; tagged_user_id: string; status: string }> = [];
  for (const m of rows) {
    const mine = rawTags.filter((t) => t.memory_id === m.id);
    if (mine.length === 0) continue;
    const projected = projectParticipants(
      { ...baseCtx, memoryVisibility: (m.visibility as string | null) ?? null },
      mine as any,
    );
    for (const p of projected.participants) {
      out.push({ memory_id: m.id as string, tagged_user_id: p.userId, status: p.status ?? "" });
    }
  }
  return out;
}

// GET /memories/timeline — §18 MemoryTimelineProjection (H163), the one
// projection whose `emits_significance` is true because its audience is
// OWNER_PRIVATE (H64).
router.get("/memories/timeline", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: rows, error } = await sc
    .from("memories")
    .select(MEMORY_SELECT as any)
    .eq("owner_id", user.id)
    .neq("state", "deleted")
    .order("starts_at", { ascending: false })
    .limit(TIMELINE_LIMIT);
  if (error) {
    req.log.error({ err: error, ownerId: user.id }, "memories: timeline read failed — refusing rather than serving an empty life");
    sendError(res, "degraded_unavailable", "We could not build your timeline. Please try again.");
    return;
  }

  const owned = (rows ?? []) as any[];
  const ids = owned.map((r) => r.id as string);

  const tagRes = await readMemoryTags(sc, ids);
  if (!tagRes.ok) {
    req.log.error({ err: tagRes.error, ownerId: user.id }, "memories: timeline tag read failed — refusing rather than reporting a companion-free life");
    sendError(res, "degraded_unavailable", "We could not build your timeline. Please try again.");
    return;
  }
  const itemRes = await readMemoryItems(sc, ids);
  if (!itemRes.ok) {
    req.log.error({ err: itemRes.error, ownerId: user.id }, "memories: timeline item read failed — refusing rather than reporting a photograph-free life");
    sendError(res, "degraded_unavailable", "We could not build your timeline. Please try again.");
    return;
  }

  const disclosedTags = await discloseParticipants(sc, user.id, user.id, owned, tagRes.tags);

  const definition = getProjectionDefinition("MemoryTimelineProjection");
  if (!definition) { sendError(res, "db_error", "Projection definition missing"); return; }

  const scope = { owner_id: user.id, viewer_id: user.id };
  // §8. Derived from the owner's own rows, so a repeat visit is the owner's own
  // return and not a coincidence with a stranger. Every Memory here is
  // user-created, so `never_discard` is true on all of them and NOTHING below
  // drops a row for scoring low — §8's hard rule is a property of this route,
  // not only of the scorer.
  const significance = deriveSignificance(user.id, owned as any, disclosedTags as any);

  const sourceRows = owned as unknown as MemorySourceRow[];
  const built = definition.build({
    scope,
    memories: sourceRows,
    tags: disclosedTags as any,
    items: itemRes.items as any,
    significance,
  });
  const disclosed = discloseProjectionRows(definition, scope, built as any);

  const explanations: Record<string, unknown> = {};
  if (significanceAudienceFor(definition, scope) === "OWNER") {
    for (const [id, e] of significance) explanations[id] = e;
  }

  res.json({
    timeline: {
      projectionId: definition.id,
      builderVersion: definition.builder_version,
      destination: definition.destination,
      audience: definition.audience,
      sourceVersion: sourceVersionOf(sourceRows).digest,
      // The registry table is 2730 and unapplied (H174): built, not registered.
      registered: false,
      truncated: owned.length >= TIMELINE_LIMIT,
      rows: disclosed,
      significance: {
        policyVersion: SIGNIFICANCE_POLICY_VERSION,
        // §8's inputs that this schema cannot produce, each with its reason, so
        // a partial score is never served as a complete one.
        inputsUnavailable: UNAVAILABLE_SIGNIFICANCE_INPUTS,
        explanations,
      },
    },
  });
});

// GET /memories/places/:placeId — §18 PlaceMemoryProjection (H167).
router.get("/memories/places/:placeId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { placeId } = req.params;
  if (!isUuid(placeId)) { sendError(res, "invalid_payload", "Invalid place id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // A Memory may name its place either way round: `place_id` is the legacy
  // reference and `canonical_location_id` the resolved one (§9). The builder
  // accepts both, so the read must too, or a merged entity would silently lose
  // half its history.
  const { data: rows, error } = await sc
    .from("memories")
    .select(MEMORY_SELECT as any)
    .eq("owner_id", user.id)
    .neq("state", "deleted")
    .or(`place_id.eq.${placeId},canonical_location_id.eq.${placeId}`)
    .limit(PLACE_HISTORY_LIMIT);
  if (error) {
    req.log.error({ err: error, ownerId: user.id, placeId }, "memories: place history read failed — refusing rather than reporting no history here");
    sendError(res, "degraded_unavailable", "We could not build your history at this place. Please try again.");
    return;
  }

  const owned = (rows ?? []) as any[];
  const definition = getProjectionDefinition("PlaceMemoryProjection");
  if (!definition) { sendError(res, "db_error", "Projection definition missing"); return; }

  const scope = { owner_id: user.id, viewer_id: user.id, place_id: placeId };
  const sourceRows = owned as unknown as MemorySourceRow[];
  const built = definition.build({ scope, memories: sourceRows, tags: [], items: [] });
  const disclosed = discloseProjectionRows(definition, scope, built as any);

  res.json({
    history: {
      placeId,
      projectionId: definition.id,
      builderVersion: definition.builder_version,
      destination: definition.destination,
      audience: definition.audience,
      sourceVersion: sourceVersionOf(sourceRows).digest,
      registered: false,
      // visit_index counts the visits this read returned. A truncated read
      // would number them from the wrong one, so the response says so.
      truncated: owned.length >= PLACE_HISTORY_LIMIT,
      rows: disclosed,
    },
  });
});

// GET /memories/people/:personId — §18 PeopleMemoryProjection (H168).
router.get("/memories/people/:personId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { personId } = req.params;
  if (!isUuid(personId)) { sendError(res, "invalid_payload", "Invalid person id"); return; }
  // Your shared history with yourself is your timeline, and answering it here
  // would hand a caller the whole owner-private projection under a different
  // audience. Refuse rather than quietly serve it.
  if (personId === user.id) { sendError(res, "invalid_payload", "Not a shared history"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // §11 / §21: a block ends shared history in both directions. `isBlocked`
  // fails CLOSED on an unreadable `blocks`, so an outage refuses rather than
  // publishing a history the two people may no longer share.
  if (await isBlocked(sc, user.id, personId)) {
    sendError(res, "not_found", "No shared history");
    return;
  }

  const { data: tagRows, error: tagErr } = await sc
    .from("memory_tags")
    .select("memory_id, tagged_user_id, status")
    .eq("tagged_user_id", personId)
    .eq("status", "approved")
    .limit(SHARED_HISTORY_LIMIT);
  if (tagErr) {
    req.log.error({ err: tagErr, ownerId: user.id }, "memories: shared history tag read failed — refusing rather than reporting no shared history");
    sendError(res, "degraded_unavailable", "We could not build your shared history. Please try again.");
    return;
  }
  const approved = (tagRows ?? []) as any[];
  const memoryIds = [...new Set(approved.map((t) => t.memory_id as string))];

  const owned: any[] = [];
  for (const batch of chunkIds(memoryIds)) {
    const { data, error } = await sc
      .from("memories")
      .select(MEMORY_SELECT as any)
      .eq("owner_id", user.id)
      .neq("state", "deleted")
      .in("id", batch);
    if (error) {
      req.log.error({ err: error, ownerId: user.id }, "memories: shared history read failed — refusing rather than reporting no shared history");
      sendError(res, "degraded_unavailable", "We could not build your shared history. Please try again.");
      return;
    }
    owned.push(...((data ?? []) as any[]));
  }

  const definition = getProjectionDefinition("PeopleMemoryProjection");
  if (!definition) { sendError(res, "db_error", "Projection definition missing"); return; }

  const scope = { owner_id: user.id, viewer_id: user.id, person_id: personId };
  const sourceRows = owned as unknown as MemorySourceRow[];
  const built = definition.build({
    scope,
    memories: sourceRows,
    // Only the person's own approved tags reach the builder. The builder
    // re-checks `status === "approved"` itself; both are load-bearing, because
    // this read could later be widened and the builder is the invariant.
    tags: approved as any,
    items: [],
  });
  const disclosed = discloseProjectionRows(definition, scope, built as any);

  res.json({
    sharedHistory: {
      personId,
      projectionId: definition.id,
      builderVersion: definition.builder_version,
      destination: definition.destination,
      audience: definition.audience,
      sourceVersion: sourceVersionOf(sourceRows).digest,
      registered: false,
      truncated: approved.length >= SHARED_HISTORY_LIMIT,
      rows: disclosed,
    },
  });
});

router.get("/memories/:id", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid memory id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const precisionEnabled = await isFlagEnabled(sc, "memory_location_precision_enabled");

  const { data: memoryRow, error } = await sc
    .from("memories")
    .select((precisionEnabled ? MEMORY_SELECT_WITH_PRECISION : MEMORY_SELECT) as any)
    .eq("id", id)
    .neq("state", "deleted")
    .maybeSingle();

  if (error) { sendError(res, "db_error", error.message); return; }
  if (!memoryRow) { sendError(res, "not_found", "Memory not found"); return; }
  // The select list is chosen at runtime (see MEMORY_SELECT_WITH_PRECISION), so
  // the generated row type cannot be resolved statically here.
  const memory = memoryRow as any;

  if (memory.owner_id !== user.id) {
    const blocked = await isBlocked(sc, user.id, memory.owner_id);
    if (blocked) { sendError(res, "not_found", "Memory not found"); return; }

    const ok = await canReadMemory(sc, memory, user.id, "single");
    if (!ok) { sendError(res, "not_found", "Memory not found"); return; }
  }

  const [items, tags, likeCount, likedByMe, saveCount, savedByMe] = await Promise.all([
    sc.from("memory_items").select("id, media_url, media_type, caption, position, created_at").eq("memory_id", id).order("position"),
    sc.from("memory_tags").select("tagged_user_id, status").eq("memory_id", id),
    sc.from("memory_likes").select("memory_id", { count: "exact", head: true }).eq("memory_id", id),
    sc.from("memory_likes").select("memory_id").eq("memory_id", id).eq("user_id", user.id).maybeSingle(),
    sc.from("memory_saves").select("memory_id", { count: "exact", head: true }).eq("memory_id", id),
    sc.from("memory_saves").select("memory_id").eq("memory_id", id).eq("user_id", user.id).maybeSingle(),
  ]);

  // §28.11, on the two reads that make a CLAIM ABOUT WHAT HAPPENED.
  //
  // supabase-js RESOLVES on a database error, so `items.data` and `tags.data`
  // were `null` for an unreadable table and the `?? []` below turned that into
  // "this Memory has no photographs" and "nobody was there" — a 200 that is
  // byte-identical to the truth. THE SIBLING PATH IN THIS FILE ALREADY REFUSED:
  // the trip recap binds both errors and answers `degraded_unavailable` with
  // "refusing rather than reporting a trip with no photographs" and "refusing
  // rather than reporting a trip nobody shared". Same two tables, same
  // question, and the single read answered it with a lie.
  if (items.error || tags.error) {
    const table = items.error ? "memory_items" : "memory_tags";
    req.log.error({ err: items.error ?? tags.error, memoryId: id, table },
      `memories: ${table} read failed — refusing rather than reporting a Memory with no photographs or no participants`);
    sendError(res, "degraded_unavailable", "Could not load this Memory. Please try again.");
    return;
  }

  const ownerProfile = await sc
    .from("profiles")
    .select("id, name, handle, avatar_url")
    .eq("id", memory.owner_id)
    .maybeSingle();

  // The ENGAGEMENT reads degrade rather than refuse, and the asymmetry is
  // deliberate: a wrong like count is not a statement about the Memory's
  // history, an empty item list is. What was wrong is that the failure was
  // invisible EVERYWHERE — not in the response, not in the log. It is now in
  // the log. `memoriesSingleReadDegraded.test.ts` asserts both halves, so
  // neither can drift into the other by somebody copying the branch above.
  for (const [table, r] of [
    ["memory_likes", likeCount], ["memory_likes", likedByMe],
    ["memory_saves", saveCount], ["memory_saves", savedByMe],
    ["profiles", ownerProfile],
  ] as const) {
    if ((r as any).error) {
      req.log.error({ err: (r as any).error, memoryId: id, table },
        "memories: engagement read failed — serving the Memory with a degraded count");
    }
  }

  const ownerNameAllowed = memory.owner_id === user.id || await nameVisibleFor(sc, memory.owner_id);

  // Location protection (fail-closed) — the stricter of the Hidden-Gem ceiling
  // and the owner's §10 precision rung, for non-owner reads.
  const singleMemoryGemCtx = await loadMemoryGemContext(sc, [memory]);
  const safeMemory = protectMemoryRow(memory, singleMemoryGemCtx, user.id, precisionEnabled);

  // §10's person visibility ladder, and §23's `canSeeParticipant`. Before this,
  // EVERY memory_tags row went out with its `tagged_user_id` to every viewer
  // permitted to read the Memory — so a person who had not consented (`pending`)
  // was profile-linked to it, and a person who had used the one exit the product
  // offers (`removed`) was still shipped by id. See
  // services/memory/memoryParticipantVisibility.ts for the rung order and why
  // the rung is derived rather than stored.
  const tagRows = (tags.data ?? []) as any[];
  const participantIds = [...new Set(tagRows.map((t: any) => String(t.tagged_user_id ?? "")).filter(Boolean))];
  const participantCtx = await loadParticipantVisibility(sc, memory, user.id, participantIds);
  const participantProfiles = new Map<string, { name?: string | null; handle?: string | null }>();
  if (participantIds.length > 0) {
    // `error` is bound: an unreadable profiles table must not silently become
    // "nobody has a handle". It costs the handle, never the rung — the ladder
    // has already decided what may be shown before this map is consulted.
    const { data: profs, error: profErr } = await sc
      .from("profiles")
      .select("id, name, handle")
      .in("id", participantIds);
    if (profErr) req.log.error({ err: profErr, memoryId: id }, "memories: participant profile read failed");
    for (const pr of ((profs as any[]) ?? [])) {
      participantProfiles.set(String(pr.id), { name: pr.name ?? null, handle: pr.handle ?? null });
    }
  }
  const participants = projectParticipants(participantCtx, tagRows, participantProfiles);

  res.json({
    memory: {
      ...mapMemory(safeMemory, user.id),
      items: (items.data ?? []).map(mapItem),
      tags: participants.participants,
      anonymousParticipants: participants.anonymousCount,
      likeCount: likeCount.count ?? 0,
      likedByMe: Boolean(likedByMe.data),
      saveCount: saveCount.count ?? 0,
      savedByMe: Boolean(savedByMe.data),
      owner: ownerProfile.data ? {
        id: (ownerProfile.data as any).id,
        name: ownerNameAllowed ? (ownerProfile.data as any).name : null,
        handle: (ownerProfile.data as any).handle,
        avatarUrl: (ownerProfile.data as any).avatar_url ?? null,
      } : null,
    },
  });
});

// ── PATCH /memories/:id ───────────────────────────────────────────────────────

router.patch("/memories/:id", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid memory id"); return; }

  const parsed = patchMemorySchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }

  if (Object.keys(parsed.data).length === 0) {
    sendError(res, "invalid_payload", "At least one field must be provided");
    return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const idempotencyKey = requireIdempotencyKey(req, res);
  if (idempotencyKey === null) return;

  const precisionEnabled = await isFlagEnabled(sc, "memory_location_precision_enabled");

  const loaded = await loadMemoryForCommand(sc, id);
  if (!loaded.ok) { sendCommandFailure(req, res, loaded); return; }
  const existing = loaded.row;
  if (existing.owner_id !== user.id) { sendError(res, "forbidden", "Not your memory"); return; }

  const d = parsed.data;

  // §21. The audience as it stands BEFORE the command, snapshotted rather than
  // re-read from `existing` afterwards. `existing` is the row object the write
  // path may have mutated in place, and a revocation that compares a row with
  // itself revokes nothing — silently, and only for the field that changed.
  const previousAudience = mergedAudience(existing as any, {});

  // §5. THE GUARD H50 SAYS WAS MISSING. Before this line the handler accepted
  // any of draft/published/archived as `state` and wrote it unconditionally —
  // published -> draft (un-publish, an arrow §5 does not draw), archived ->
  // draft, and, for a row a moderator had set to 'removed', removed ->
  // published, which puts moderator-removed content back into the discovery
  // feed. The guard runs whether or not the kernel flag is on, because it needs
  // no table that does not exist.
  const lifecycle = guardLifecycle(existing.state, d.state);
  if (!lifecycle.ok) { sendCommandFailure(req, res, lifecycle); return; }

  // §23 `canPublishMemory`, on the row AS IT WOULD BE. Evaluating the merged
  // row and not just `d.visibility` is the whole point: emptying an allow-list
  // while leaving the visibility field alone silently reduces the audience to
  // nobody without `visibility` appearing in the patch at all. Skipped entirely
  // when neither input is touched, so an unrelated caption edit costs no extra
  // read.
  if (d.visibility !== undefined || d.allowedUserIds !== undefined) {
    const merged = {
      id: existing.id as string,
      owner_id: existing.owner_id as string,
      trip_id: (existing.trip_id as string | null) ?? null,
      allowed_user_ids: d.allowedUserIds !== undefined
        ? d.allowedUserIds
        : ((existing.allowed_user_ids as string[] | null) ?? []),
    };
    const audience = d.visibility !== undefined ? d.visibility : (existing.visibility as string | null);
    const publishable = await canPublishMemory(sc, user.id, merged, audience);
    if (!publishable.ok) {
      sendError(res, "conflict", publishable.message, { exposeDetail: true, reason: publishable.reason });
      return;
    }
  }

  const patch: Record<string, unknown> = {};
  if (d.title !== undefined) patch.title = d.title;
  if (d.caption !== undefined) patch.caption = d.caption;
  if (d.visibility !== undefined) patch.visibility = d.visibility;
  if (d.allowedUserIds !== undefined) patch.allowed_user_ids = d.allowedUserIds;
  if (d.hiddenUserIds !== undefined) patch.hidden_user_ids = d.hiddenUserIds;
  if (d.placeId !== undefined) patch.place_id = d.placeId;
  if (d.locationCity !== undefined) patch.location_city = d.locationCity;
  if (d.locationCountry !== undefined) patch.location_country = d.locationCountry;
  if (d.locationLat !== undefined) patch.location_lat = d.locationLat;
  if (d.locationLng !== undefined) patch.location_lng = d.locationLng;
  if (d.canonicalLocationId !== undefined) patch.canonical_location_id = d.canonicalLocationId;
  // Same schema-presence rule as create: never name the column unless the
  // database has it. See MEMORY_SELECT_WITH_PRECISION.
  if (precisionEnabled && d.locationPrecision !== undefined) {
    const rung = normalizeMemoryPrecisionForWrite(d.locationPrecision);
    if (rung !== undefined) patch.location_precision = rung;
  }
  if (d.startsAt !== undefined) patch.starts_at = d.startsAt;
  if (d.endsAt !== undefined) patch.ends_at = d.endsAt;
  if (d.state !== undefined) patch.state = d.state;
  // ONE captured instant, derived rather than re-read. `audienceWriteCommittedAt`
  // below is a second, DELIBERATE read taken after the write returns — it starts
  // the §24 revocation stopwatch, so folding it into this one would charge the
  // write's own duration to the revocation. Two reads with different jobs are
  // fine; a no-arg `new Date()` beside a `Date.now()` is not, because those two
  // silently disagree about what is supposed to be the same instant.
  const updatedAtMs = Date.now();
  patch.updated_at = new Date(updatedAtMs).toISOString();

  // §17. Which command this PATCH is — a lifecycle transition, an audience
  // change, a place correction, or a plain field edit. The name reaches the
  // audit row and the domain event's payload, which is what makes §24's
  // place_correction_rate countable at all.
  const commandType = commandTypeForPatch(d);

  const outcome = await dispatchMemoryCommand<any>({
    sc,
    commandType,
    memoryId: id,
    actorUserId: user.id,
    idempotencyKey,
    // §24 source version — the row as it was BEFORE this command.
    sourceVersion: existing.updated_at ?? null,
    payload: {
      patch,
      from_state: lifecycle.fromState,
      to_state: lifecycle.toState,
      select: precisionEnabled ? MEMORY_SELECT_WITH_PRECISION : MEMORY_SELECT,
    },
    legacy: async () => {
      // §19 "Concurrent edits should resolve at command/field level, not blind
      // row last-write-wins", and the §5 guard above is what makes it urgent.
      //
      // THE WRITE RE-ASSERTS THE VALUE THE GUARD WAS JUDGED ON. Before this,
      // `guardLifecycle` decided on `existing.state` and the UPDATE filtered on
      // `id` and `owner_id` only — so a row that became TERMINAL between the
      // read and the write took the transition anyway. That is not theoretical:
      // `DELETE /memories/:id` sets `state='deleted'` and is an ordinary
      // authenticated route the same owner can call from a second device, so
      // "publish on the phone, delete on the laptop" republished a deleted
      // Memory past a guard that had already refused exactly that arrow. The
      // same window is what would let a racing owner edit overwrite a
      // moderator's `state='removed'`, which is the case
      // `assertLifecycleTransition`'s own comment exists to prevent.
      //
      // PINNED TO `state` AND NOTHING ELSE, WHICH IS THE FIELD-LEVEL HALF OF
      // §19's sentence. A precondition on the whole row (an `updated_at`
      // compare-and-swap) would refuse a caption edit racing a title edit —
      // two commands that are not in competition — and §19 asks for the
      // opposite. So a concurrent edit to any other field still merges, and a
      // concurrent edit to THIS field is the one that conflicts.
      //
      // No client contract changes: the precondition is the server's own read,
      // not a header the caller must learn to send. Census owner decision D-C1
      // (should a client be REQUIRED to state its base?) is untouched and still
      // open — two concurrent edits of the same non-lifecycle field still
      // resolve by last-write-wins, because for those the server has no base.
      let write = sc
        .from("memories")
        .update(patch)
        .eq("id", id)
        .eq("owner_id", user.id);
      write = existing.state == null
        ? (write as any).is("state", null)
        : (write as any).eq("state", existing.state);
      // `.select()` WITHOUT `.single()`: zero matched rows must be an empty
      // array this code can inspect, not PGRST116 — "nobody changed anything"
      // and "somebody changed it first" are different answers and only one of
      // them is an error.
      const { data, error } = await write
        .select((precisionEnabled ? MEMORY_SELECT_WITH_PRECISION : MEMORY_SELECT) as any);
      if (error) {
        req.log.error({ err: error }, "memories: patch failed");
        return { ok: false, http: { code: "db_error", message: error.message } };
      }
      const written = (data ?? []) as any[];
      if (written.length === 0) {
        // Say WHY. A zero-row update on a precondition is almost always a
        // conflict, but "almost always" is how a database outage gets reported
        // to a user as somebody else's edit, so the row is re-read and the
        // three outcomes are answered separately.
        const { data: current, error: reErr } = await sc
          .from("memories")
          .select("id, state")
          .eq("id", id)
          .eq("owner_id", user.id)
          .maybeSingle();
        if (reErr) {
          req.log.error({ err: reErr, memoryId: id }, "memories: patch matched zero rows and the re-read failed");
          return { ok: false, http: { code: "db_error", message: "The memory could not be updated. Please try again.", exposeDetail: true } };
        }
        if (!current) {
          return { ok: false, http: { code: "not_found", message: "Memory not found" } };
        }
        req.log.warn(
          { memoryId: id, expectedState: existing.state, actualState: (current as any).state },
          "memories: patch refused — the Memory changed while the command was being judged",
        );
        return {
          ok: false,
          http: {
            code: "conflict",
            message: "This Memory changed while you were editing it. Reload it and try again.",
            exposeDetail: true,
          },
        };
      }
      return { ok: true, body: written[0] };
    },
  });

  if (!outcome.ok) { sendCommandFailure(req, res, outcome); return; }
  const audienceWriteCommittedAt = Date.now();

  // §21 / §28.8. The write has happened; now revoke the derived artifacts that
  // still carry the OLD audience. This runs AFTER the command so a cache
  // eviction can never be the reason a legitimate edit fails, and it is awaited
  // rather than fired and forgotten so the response is not sent while a viewer
  // who just lost access can still be served the Memory out of a cache.
  //
  // `audienceChanged` gates it: a caption edit must not evict every follower's
  // Compass feed, and a Memory whose audience did not move has nothing to
  // revoke.
  const nextAudience = mergedAudience(previousAudience, patch);
  if (audienceChanged(previousAudience, nextAudience)) {
    await revokeMemoryAudienceCaches(sc, {
      memoryId: id,
      ownerId: user.id,
      previous: previousAudience,
      next: nextAudience,
      reason: nextAudience.state === "archived" ? "memory_archived" : "memory_visibility_changed",
      log: req.log,
      // §24 `privacy_revocation_latency` is measured from the moment the
      // audience change COMMITTED — the owner's clock, not the eviction loop's.
      requestedAt: audienceWriteCommittedAt,
    });
  }

  res.json({ memory: mapMemory(outcome.body, user.id) });
});

// ── DELETE /memories/:id ──────────────────────────────────────────────────────

router.delete("/memories/:id", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid memory id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const idempotencyKey = requireIdempotencyKey(req, res);
  if (idempotencyKey === null) return;

  const loaded = await loadMemoryForCommand(sc, id);
  if (!loaded.ok) { sendCommandFailure(req, res, loaded); return; }
  const existing = loaded.row;
  if (existing.owner_id !== user.id) { sendError(res, "forbidden", "Not your memory"); return; }

  // §21. Snapshot the audience before the soft delete, for the same reason the
  // PATCH handler does: the row object is mutated by the write path.
  const audienceBeforeDelete = mergedAudience(existing as any, {});

  // §5. `:642` wrote state:"deleted" directly with no transition check. A
  // 'removed' (moderator) row reaching this handler now gets a refusal instead
  // of a soft-delete that would hide the moderation verdict behind the owner's
  // own delete.
  const lifecycle = guardLifecycle(existing.state, "deleted");
  if (!lifecycle.ok) { sendCommandFailure(req, res, lifecycle); return; }

  // Soft-delete by design: the memory becomes invisible everywhere (every read
  // path filters `state != 'deleted'`) but the row, its items and their media
  // are retained, e.g. so support can recover an accidental deletion. This is
  // NOT a privacy hole on account deletion: executeAccountDeletion sweeps
  // memories by owner_id with no state filter and removes the items' storage
  // objects, so soft-deleted memories are hard-erased when the account goes
  // (audit MEM·H2).
  //
  // §21's full deletion lifecycle (DELETION_REQUESTED -> PUBLIC_REVOKED ->
  // DERIVATIVES_PURGED -> RAW_EVIDENCE_PURGED -> DELETED) is NOT built: there is
  // no derivative registry to revoke against (§18, NOT-BUILT). This command
  // emits memory.deleted so that registry, when it exists, has the one event it
  // needs to start from — which is the whole reason the outbox goes in first.
  const outcome = await dispatchMemoryCommand<{ id: string }>({
    sc,
    commandType: "DELETE_MEMORY",
    memoryId: id,
    actorUserId: user.id,
    idempotencyKey,
    // §24 source version — the row as it was BEFORE this command.
    sourceVersion: existing.updated_at ?? null,
    payload: { from_state: lifecycle.fromState, to_state: lifecycle.toState },
    legacy: async () => {
      // ONE clock read for the stamp, derived rather than re-read below.
      // `deleteCommittedAt` further down is a second, DELIBERATE read taken
      // after the write returns — it starts the §24 revocation stopwatch.
      const deletedAtMs = Date.now();
      // THE WRITE THAT MAKES THE DELETION REAL, AND ITS RESULT WAS THROWN AWAY.
      //
      // No `error` binding and no `.select()`: supabase-js RESOLVES on a
      // failure, so a rejected update produced 204 "deleted" for a memory still
      // published, still on the owner's profile and still in the discovery
      // feed. An UPDATE without .select() also returns `data: null`, so even a
      // bound `error` would not have said whether any row was touched.
      // `.select("id")` is what turns this into an answer. Deleting your own
      // content is the operation that must not lie.
      const { data: deleted, error: delErr } = await sc
        .from("memories")
        .update({ state: "deleted", updated_at: new Date(deletedAtMs).toISOString() })
        .eq("id", id)
        .eq("owner_id", user.id)
        .select("id");
      if (delErr) {
        req.log.error({ err: delErr, memoryId: id }, "memories: delete failed");
        return { ok: false, http: { code: "db_error", message: delErr.message } };
      }
      if (!deleted || (deleted as any[]).length === 0) {
        req.log.error({ memoryId: id, ownerId: user.id }, "memories: delete matched zero rows — memory NOT deleted");
        return { ok: false, http: { code: "db_error", message: "The memory could not be deleted. Please try again.", exposeDetail: true } };
      }
      return { ok: true, body: { id } };
    },
  });

  if (!outcome.ok) { sendCommandFailure(req, res, outcome); return; }
  const deleteCommittedAt = Date.now();

  // §21's five states, run and reported. Before this, per-Memory deletion was
  // one UPDATE and a 204 — no named step, no report, no retry (census H193,
  // group (a); H190's "§21's five-step deletion lifecycle still does not
  // exist"). PUBLIC_REVOKED is the step that evicts the cached Compass
  // projection: a feed assembled thirty seconds ago still contains this Memory
  // and is served from `compass_feed_cache` for up to four hours.
  //
  // TWO OF THE FIVE STORES ARE NOT DEPLOYED and report `not_applicable` with
  // their reason rather than `done` — see services/memory/
  // memoryDeletionLifecycle.ts for why that is three outcomes and not two.
  //
  // The report is LOGGED, not returned: DELETE answers 204 and changing that is
  // a client contract change. A caller is never told a deletion failed when the
  // canonical row really is gone; an operator is.
  const deletionReport = await runMemoryDeletionLifecycle(sc, {
    memoryId: id,
    ownerId: user.id,
    actorUserId: user.id,
    previous: audienceBeforeDelete,
    log: req.log,
    requestedAt: deleteCommittedAt,
  });
  req.log.info({ report: deletionReport }, "memories: §21 deletion lifecycle");

  res.status(204).send();
});

// ── POST /memories/:id/items ──────────────────────────────────────────────────

router.post("/memories/:id/items", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid memory id"); return; }

  const parsed = addItemSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const idempotencyKey = requireIdempotencyKey(req, res);
  if (idempotencyKey === null) return;

  const loaded = await loadMemoryForCommand(sc, id);
  if (!loaded.ok) { sendCommandFailure(req, res, loaded); return; }
  if (loaded.row.owner_id !== user.id) { sendError(res, "forbidden", "Not your memory"); return; }

  // §20 / census H181 — a Memory item may not claim another user's storage
  // object. `mediaUrl` was `z.string().url()` and nothing else: the same
  // unchecked client assertion `src/test/storyMediaOwnership.test.ts` documents
  // for POST /stories. Refused BEFORE the command so nothing is written and no
  // audit row claims a media attachment that did not happen.
  //
  // Only a path inside our own storage whose owner segment is a DIFFERENT user
  // is refused. An `external` URL is untouched — this route has always accepted
  // those and whether it should is a product decision, not a defect. See
  // services/memory/memoryMediaOrigin.ts.
  const origin = classifyMemoryMediaUrl(parsed.data.mediaUrl, user.id);
  if (origin.verdict === "foreign_storage") {
    req.log.error(
      { memoryId: id, actorUserId: user.id, bucket: origin.bucket, path: origin.path },
      "memories: refused a media item whose storage path belongs to another user",
    );
    sendError(res, "invalid_payload", FOREIGN_MEDIA_REFUSAL, { exposeDetail: true });
    return;
  }
  if (origin.verdict === "unattributable_storage") {
    req.log.warn(
      { memoryId: id, actorUserId: user.id, bucket: origin.bucket, path: origin.path },
      "memories: media item points at one of our objects whose owner cannot be derived from its path — accepted, unattributed",
    );
  }

  // §17 ADD_MEDIA. §19 H176/H177 are already correct here and stay correct: the
  // Memory exists before any media and a failed item write leaves its facts
  // intact. What the command adds is the idempotency key — §19's "enqueue media
  // uploads independently ... sync command with idempotency key" is exactly the
  // retry that used to produce a duplicate item on every network stutter.
  const outcome = await dispatchMemoryCommand<any>({
    sc,
    commandType: "ADD_MEDIA",
    memoryId: id,
    actorUserId: user.id,
    idempotencyKey,
    // §24 source version — the row as it was BEFORE this command.
    sourceVersion: loaded.row.updated_at ?? null,
    payload: {
      media_type: parsed.data.mediaType,
      position: parsed.data.position,
      // media_url and caption are deliberately NOT in the command payload's
      // top level: the kernel takes them from `write` and never copies them
      // into the event (§23 privacy-filtered event payloads).
      write: {
        memory_id: id,
        media_url: parsed.data.mediaUrl,
        media_type: parsed.data.mediaType,
        caption: parsed.data.caption ?? null,
        position: parsed.data.position,
      },
    },
    legacy: async () => {
      const { data, error } = await sc
        .from("memory_items")
        .insert({
          memory_id: id,
          media_url: parsed.data.mediaUrl,
          media_type: parsed.data.mediaType,
          caption: parsed.data.caption ?? null,
          position: parsed.data.position,
        })
        .select("id, media_url, media_type, caption, position, created_at")
        .single();
      if (error) {
        req.log.error({ err: error }, "memories: add item failed");
        return { ok: false, http: { code: "db_error", message: error.message } };
      }
      return { ok: true, body: data };
    },
  });

  if (!outcome.ok) { sendCommandFailure(req, res, outcome); return; }

  res.status(201).json({ item: mapItem(outcome.body) });
});

// ── DELETE /memories/:id/items/:itemId ───────────────────────────────────────

router.delete("/memories/:id/items/:itemId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { id, itemId } = req.params;
  if (!isUuid(id) || !isUuid(itemId)) { sendError(res, "invalid_payload", "Invalid id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const idempotencyKey = requireIdempotencyKey(req, res);
  if (idempotencyKey === null) return;

  const loaded = await loadMemoryForCommand(sc, id);
  if (!loaded.ok) { sendCommandFailure(req, res, loaded); return; }
  if (loaded.row.owner_id !== user.id) { sendError(res, "forbidden", "Not your memory"); return; }

  // Fetch the item to get its media_url before deleting.
  //
  // `error` is bound: supabase-js RESOLVES on a database error, so an
  // unreadable memory_items answered "Item not found" — a 404 for an outage,
  // and worse, a 404 that tells the owner their media is already gone. §28.11.
  const { data: item, error: itemErr } = await sc
    .from("memory_items")
    .select("id, media_url")
    .eq("id", itemId)
    .eq("memory_id", id)
    .maybeSingle();

  if (itemErr) {
    req.log.error({ err: itemErr, memoryId: id, itemId }, "memories: item read failed");
    sendError(res, "db_error", itemErr.message);
    return;
  }
  if (!item) { sendError(res, "not_found", "Item not found"); return; }

  // §17 REMOVE_MEDIA. The storage delete below stays OUTSIDE the command: it is
  // not a canonical write, it cannot participate in the transaction, and §21
  // ("Delete media asset — remove asset and derivatives; Memory may survive if
  // other evidence remains") makes it a consequence of the command rather than
  // part of it. Ordering is what keeps that honest — the row goes first, and if
  // the row does not go, the bytes stay.
  const outcome = await dispatchMemoryCommand<{ id: string }>({
    sc,
    commandType: "REMOVE_MEDIA",
    memoryId: id,
    actorUserId: user.id,
    idempotencyKey,
    // §24 source version — the row as it was BEFORE this command.
    sourceVersion: loaded.row.updated_at ?? null,
    payload: { item_id: itemId },
    legacy: async () => {
      // Delete the DB row first so the item is immediately inaccessible.
      //
      // The result of this delete was discarded, and the storage object is
      // removed UNCONDITIONALLY below. So a failed row delete did not merely
      // leave the item in place: it left the row pointing at bytes that had just
      // been erased, i.e. a permanently broken item in the memory, and answered
      // 204. Ordering makes the check load-bearing — nothing downstream can
      // repair it.
      const { data: removed, error: rmErr } = await sc
        .from("memory_items").delete().eq("id", itemId).eq("memory_id", id).select("id");
      if (rmErr) {
        req.log.error({ err: rmErr, memoryId: id, itemId }, "memories: item delete failed — storage object left in place");
        return { ok: false, http: { code: "db_error", message: rmErr.message } };
      }
      if (!removed || (removed as any[]).length === 0) {
        req.log.error({ memoryId: id, itemId }, "memories: item delete matched zero rows — storage object left in place");
        return { ok: false, http: { code: "db_error", message: "The item could not be removed. Please try again.", exposeDetail: true } };
      }
      return { ok: true, body: { id: itemId } };
    },
  });

  if (!outcome.ok) { sendCommandFailure(req, res, outcome); return; }

  // Delete the storage object — derive path from public URL.
  // URL format: https://<host>/storage/v1/object/public/post-media/<path>
  // Storage path format: memories/{userId}/{filename}
  // Security: only delete objects that begin with the owner's path prefix.
  // media_url is a client-supplied value at insert time, so an adversary could
  // craft a URL pointing to another user's object.  Enforcing the path prefix
  // means only files uploaded by this user (path = `memories/${user.id}/...`) can ever
  // be removed via this code path.
  //
  // THE `try/catch` HERE USED TO BE THE ONLY HANDLING, AND IT NEVER RAN.
  // supabase-storage-js RESOLVES with `{ data: null, error }` on a failed
  // removal — it does not throw — so the catch below was written for an
  // exception that never arrives, and `await remove(...)` discarded its error.
  // The row is already gone at this point, which makes the discarded error the
  // whole of §25's "partial media deletion" chaos case: the item is
  // unreachable, the bytes are still publicly served, and nothing anywhere
  // recorded that the two had diverged.
  //
  // The response stays 204. The canonical command DID succeed and re-running it
  // would 404; turning a storage failure into a client error would be a lie in
  // the other direction. What changes is that the orphan is now findable:
  // error-level, with the storage path and the §24 `failureClass`. §21 asks for
  // deletion to be "observable, retryable, dead-lettered on repeated downstream
  // failure" — there is no dead-letter table (census H193), so this is the
  // observable half, and it is honest about being only that.
  try {
    const mediaUrl: string = (item as any).media_url ?? "";
    const marker = "/object/public/post-media/";
    const markerIdx = mediaUrl.indexOf(marker);
    if (markerIdx !== -1) {
      const storagePath = mediaUrl.slice(markerIdx + marker.length);
      const ownerPrefix = `memories/${user.id}/`;
      if (storagePath && storagePath.startsWith(ownerPrefix)) {
        const { error: storageErr } = await sc.storage.from("post-media").remove([storagePath]);
        if (storageErr) {
          req.log.error(
            { err: storageErr, memoryId: id, itemId, storagePath, failureClass: "storage_object_orphaned" },
            "memories: item row deleted but its storage object could not be removed — the bytes are orphaned and still served",
          );
        }
      } else {
        req.log.warn({ storagePath, userId: user.id }, "memories: storage path does not match owner prefix — skipping delete");
      }
    }
  } catch (storageErr) {
    // Kept for a genuine throw (a malformed client, a transport error). It is
    // no longer the only thing standing between a failed removal and silence.
    req.log.error(
      { err: storageErr, memoryId: id, itemId, failureClass: "storage_object_orphaned" },
      "memories: item row deleted but the storage removal threw — the bytes are orphaned and still served",
    );
  }

  res.status(204).send();
});

// ── GET /memories/:id/tags ────────────────────────────────────────────────────

router.get("/memories/:id/tags", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid memory id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: memory, error: memoryErr } = await sc
    .from("memories")
    .select("id, owner_id, visibility, trip_id, state")
    .eq("id", id)
    .neq("state", "deleted")
    .maybeSingle();

  if (memoryErr) {
    req.log.error({ err: memoryErr, memoryId: id }, "memories: memory read failed");
    sendError(res, "db_error", memoryErr.message);
    return;
  }
  if (!memory) { sendError(res, "not_found", "Memory not found"); return; }

  const isOwner = memory.owner_id === user.id;
  const isTagged = !isOwner && (await sc
    .from("memory_tags")
    .select("memory_id")
    .eq("memory_id", id)
    .eq("tagged_user_id", user.id)
    .maybeSingle()
  ).data != null;

  if (!isOwner && !isTagged) {
    const ok = await canReadMemory(sc, memory, user.id, "single");
    if (!ok) { sendError(res, "not_found", "Memory not found"); return; }
  }

  const { data, error } = await sc
    .from("memory_tags")
    .select("tagged_user_id, status, created_at")
    .eq("memory_id", id);

  if (error) { sendError(res, "db_error", error.message); return; }

  // The same ladder as the single read, from the same function. Two
  // transcriptions of a privacy rule drift, and the drift is silent.
  const tagRows = (data ?? []) as any[];
  const participantIds = [...new Set(tagRows.map((t: any) => String(t.tagged_user_id ?? "")).filter(Boolean))];
  const participantCtx = await loadParticipantVisibility(sc, memory, user.id, participantIds);
  const participantProfiles = new Map<string, { name?: string | null; handle?: string | null }>();
  if (participantIds.length > 0) {
    const { data: profs, error: profErr } = await sc
      .from("profiles")
      .select("id, name, handle")
      .in("id", participantIds);
    if (profErr) req.log.error({ err: profErr, memoryId: id }, "memories: participant profile read failed");
    for (const pr of ((profs as any[]) ?? [])) {
      participantProfiles.set(String(pr.id), { name: pr.name ?? null, handle: pr.handle ?? null });
    }
  }
  const participants = projectParticipants(participantCtx, tagRows, participantProfiles);

  res.json({ tags: participants.participants, anonymousParticipants: participants.anonymousCount });
});

// ── PATCH /memories/:id/tags/:userId — approve or remove self-tag ────────────

router.patch("/memories/:id/tags/:userId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { id, userId } = req.params;
  if (!isUuid(id) || !isUuid(userId)) { sendError(res, "invalid_payload", "Invalid id"); return; }

  const parsed = patchTagSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const idempotencyKey = requireIdempotencyKey(req, res);
  if (idempotencyKey === null) return;

  // §17 ADD_PERSON (consent) / REMOVE_PERSON.
  //
  // THIS HANDLER USED TO OPEN WITH `if (userId !== user.id) forbidden`, so the
  // Memory's OWNER could not remove a person from their own Memory, and no other
  // route could either. See authorizeParticipantCommand in
  // services/memory/MemoryDomainService.ts for the spec lines: Appendix A step 7
  // (line 776) walks the owner through removing a participant, §23 line 597/610
  // makes the participant set an owner-editable canonical fact, and §10 line 338
  // ("being tagged does not make another user a co-owner") is why the tagged
  // person's presence is not a veto. Approval stays the tagged person's alone —
  // §5 line 226, "only after participant consent".
  //
  // The Memory must be loaded before the tag, because the owner's identity is
  // the thing being authorized against and it is not on the tag row.
  const loaded = await loadMemoryForCommand(sc, id);
  if (!loaded.ok) { sendCommandFailure(req, res, loaded); return; }

  const command = parsed.data.action === "approve" ? "ADD_PERSON" : "REMOVE_PERSON";
  const authorized = authorizeParticipantCommand(command, user.id, loaded.row.owner_id, userId);
  if (!authorized.ok) { sendCommandFailure(req, res, authorized); return; }

  // `error` is bound: an unreadable memory_tags answered "Tag not found", i.e.
  // told a person their tag does not exist because the table was down. §28.11.
  const { data: tag, error: tagErr } = await sc
    .from("memory_tags")
    .select("memory_id, tagged_user_id, status")
    .eq("memory_id", id)
    .eq("tagged_user_id", userId)
    .maybeSingle();

  if (tagErr) {
    req.log.error({ err: tagErr, memoryId: id }, "memories: tag read failed");
    sendError(res, "db_error", tagErr.message);
    return;
  }
  if (!tag) { sendError(res, "not_found", "Tag not found"); return; }

  const newStatus = parsed.data.action === "approve" ? "approved" : "removed";

  const outcome = await dispatchMemoryCommand<{ status: string }>({
    sc,
    commandType: command,
    memoryId: id,
    actorUserId: user.id,
    idempotencyKey,
    // §24 source version — the row as it was BEFORE this command.
    sourceVersion: loaded.row.updated_at ?? null,
    payload: { tagged_user_id: userId, status: newStatus, actor_role: authorized.actorRole },
    legacy: async () => {
      // `.select()`: an UPDATE without it returns data:null, so `error === null`
      // did not mean a row changed. Approving or removing a tag is a consent
      // decision; reporting it as applied when nothing was written leaves the
      // tag standing while the person believes it is gone.
      const { data: updatedTag, error } = await sc
        .from("memory_tags")
        .update({ status: newStatus })
        .eq("memory_id", id)
        .eq("tagged_user_id", userId)
        .select("memory_id");
      if (error) {
        req.log.error({ err: error, memoryId: id }, "memories: tag update failed");
        return { ok: false, http: { code: "db_error", message: error.message } };
      }
      if (!updatedTag || (updatedTag as any[]).length === 0) {
        req.log.error({ memoryId: id, userId, newStatus }, "memories: tag update matched zero rows — the tag is unchanged");
        return { ok: false, http: { code: "db_error", message: "Your tag could not be updated. Please try again.", exposeDetail: true } };
      }
      return { ok: true, body: { status: newStatus } };
    },
  });

  if (!outcome.ok) { sendCommandFailure(req, res, outcome); return; }

  res.json({ status: newStatus });
});

// ── POST /memories/:id/like ───────────────────────────────────────────────────

router.post("/memories/:id/like", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid memory id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: memory, error: memoryErr } = await sc
    .from("memories")
    .select("id, owner_id, visibility, allowed_user_ids, hidden_user_ids, trip_id, state")
    .eq("id", id)
    .neq("state", "deleted")
    .maybeSingle();

  if (memoryErr) {
    req.log.error({ err: memoryErr, memoryId: id }, "memories: memory read failed");
    sendError(res, "db_error", memoryErr.message);
    return;
  }
  if (!memory) { sendError(res, "not_found", "Memory not found"); return; }

  if (memory.owner_id !== user.id) {
    const blocked = await isBlocked(sc, user.id, memory.owner_id);
    if (blocked) { sendError(res, "not_found", "Memory not found"); return; }
    const ok = await canReadMemory(sc, memory, user.id, "single");
    if (!ok) { sendError(res, "not_found", "Memory not found"); return; }
  }

  const { error } = await sc
    .from("memory_likes")
    .upsert({ memory_id: id, user_id: user.id }, { onConflict: "memory_id,user_id" });

  if (error && (error as any).code !== "23505") {
    sendError(res, "db_error", error.message);
    return;
  }

  const { count, error: countErr } = await sc.from("memory_likes").select("memory_id", { count: "exact", head: true }).eq("memory_id", id);
  if (countErr) req.log.warn({ err: countErr, memoryId: id }, "memories: like count unreadable after a successful like");

  notifyLike(sc, id, memory.owner_id, user.id);

  // Phase 14 — link like back to the originating Compass recommendation.
  void linkOutcomeSignal(sc, user.id, id, "liked", "route:memory_like");

  res.json({ likedByMe: true, likeCount: countErr ? null : (count ?? 0) });
});

// ── DELETE /memories/:id/like ─────────────────────────────────────────────────

router.delete("/memories/:id/like", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid memory id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Discarded, so a failed delete answered 200 { likedByMe: false } with the
  // like still stored — the client renders an empty heart until the next
  // refresh contradicts it.
  const { error: unlikeErr } = await sc
    .from("memory_likes").delete().eq("memory_id", id).eq("user_id", user.id);
  if (unlikeErr) {
    req.log.error({ err: unlikeErr, memoryId: id }, "memories: unlike write failed");
    sendError(res, "db_error", "Could not remove the like. Please try again.", { exposeDetail: true });
    return;
  }

  // `count ?? 0` on an errored count is a fabricated zero; report null instead.
  const { count, error: countErr } = await sc.from("memory_likes").select("memory_id", { count: "exact", head: true }).eq("memory_id", id);
  if (countErr) req.log.warn({ err: countErr, memoryId: id }, "memories: like count unreadable after a successful unlike");

  res.json({ likedByMe: false, likeCount: countErr ? null : (count ?? 0) });
});

// ── POST /memories/:id/save ───────────────────────────────────────────────────

router.post("/memories/:id/save", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid memory id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: memory, error: memoryErr } = await sc
    .from("memories")
    .select("id, owner_id, visibility, allowed_user_ids, hidden_user_ids, trip_id, state")
    .eq("id", id)
    .neq("state", "deleted")
    .maybeSingle();

  if (memoryErr) {
    req.log.error({ err: memoryErr, memoryId: id }, "memories: memory read failed");
    sendError(res, "db_error", memoryErr.message);
    return;
  }
  if (!memory) { sendError(res, "not_found", "Memory not found"); return; }

  if (memory.owner_id !== user.id) {
    const blocked = await isBlocked(sc, user.id, memory.owner_id);
    if (blocked) { sendError(res, "not_found", "Memory not found"); return; }
    const ok = await canReadMemory(sc, memory, user.id, "single");
    if (!ok) { sendError(res, "not_found", "Memory not found"); return; }
  }

  const { error } = await sc
    .from("memory_saves")
    .upsert({ memory_id: id, user_id: user.id }, { onConflict: "memory_id,user_id" });

  if (error && (error as any).code !== "23505") {
    sendError(res, "db_error", error.message);
    return;
  }

  res.json({ savedByMe: true });
});

// ── DELETE /memories/:id/save ─────────────────────────────────────────────────

router.delete("/memories/:id/save", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid memory id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { error: unsaveErr } = await sc
    .from("memory_saves").delete().eq("memory_id", id).eq("user_id", user.id);
  if (unsaveErr) {
    req.log.error({ err: unsaveErr, memoryId: id }, "memories: unsave write failed");
    sendError(res, "db_error", "Could not remove the save. Please try again.", { exposeDetail: true });
    return;
  }

  res.json({ savedByMe: false });
});

// ── POST /memories/:id/share ──────────────────────────────────────────────────

router.post("/memories/:id/share", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid memory id"); return; }

  res.json({ ok: true });
});

// ── POST /trips/:tripId/memory — create-from-trip ─────────────────────────────

router.post("/trips/:tripId/memory", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId } = req.params;
  if (!isUuid(tripId)) { sendError(res, "invalid_payload", "Invalid trip id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // §19. The eighth Memory-creating path, and the last one that did not read
  // the envelope. Placed before any read so a malformed key is refused without
  // the server having looked at anything.
  const idempotencyKey = requireIdempotencyKey(req, res);
  if (idempotencyKey === null) return;

  // `.error` IS BOUND ON BOTH READS BELOW, and the difference is not cosmetic.
  //
  // supabase-js RESOLVES on a database error. The two reads here used to be
  // `const { data: trip }` and `const { data: members }`, so an unreadable
  // `trips` answered 404 "Trip not found" for a trip that exists, and — far
  // worse — an unreadable `trip_members` produced `members === null`,
  // `crewIds === []`, and the handler WENT ON TO WRITE a canonical Memory with
  // `visibility: 'trip_crew'` and no participant at all. §22 forbids
  // fabricating participant links; an empty crew the server never managed to
  // read is exactly that, and it is durable. §28.11 forbids the shape in
  // general: a failure must not become plausible-looking empty history.
  //
  // The refusal is `degraded_unavailable` (503, retryable) — this codebase's
  // established answer for "the check could not be performed", as distinct from
  // "the check was performed and failed". Nothing is written on either arm; the
  // client retries and gets ONE Memory, not a second one.
  const { data: trip, error: tripErr } = await sc
    .from("trips")
    .select("id, owner_id, title, destination_city, destination_country, start_date, end_date, status")
    .eq("id", tripId)
    .maybeSingle();

  if (tripErr) {
    req.log.error({ err: tripErr, tripId }, "create-from-trip: trips read failed — refusing rather than answering not_found");
    sendError(res, "degraded_unavailable", "Could not read the trip. Please try again.");
    return;
  }
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }
  if ((trip as any).owner_id !== user.id) { sendError(res, "forbidden", "Only the trip owner can create a memory"); return; }

  if ((trip as any).status !== "completed") {
    sendError(res, "forbidden", "Only completed trips can be converted to a memory");
    return;
  }

  const { data: members, error: membersErr } = await sc
    .from("trip_members")
    .select("user_id")
    .eq("trip_id", tripId)
    .in("role", ["owner", "member"]);

  if (membersErr) {
    req.log.error({ err: membersErr, tripId }, "create-from-trip: trip_members read failed — refusing BEFORE the write");
    sendError(res, "degraded_unavailable", "Could not read the trip crew. Please try again.");
    return;
  }

  const crewIds = ((members ?? []) as any[])
    .map((m) => m.user_id as string)
    .filter((uid) => uid !== user.id);

  const tripInsertRow = {
    owner_id: user.id,
    title: (trip as any).title,
    caption: null,
    visibility: "trip_crew",
    allowed_user_ids: [],
    hidden_user_ids: [],
    trip_id: tripId,
    starts_at: (trip as any).start_date ? new Date((trip as any).start_date).toISOString() : null,
    ends_at: (trip as any).end_date ? new Date((trip as any).end_date).toISOString() : null,
    state: "draft",
  };

  // §17. This insert used to be a bare `sc.from("memories").insert(...)` — the
  // one canonical-Memory write in this file that never crossed the command
  // boundary, so it had no commandId, no audit line and no idempotency key
  // while the other six did. It goes through the same dispatch as POST
  // /memories now: kernel when `memory_kernel_enabled` is on, the identical
  // direct write when it is off, and an audit line either way.
  const created = await dispatchMemoryCommand<any>({
    sc,
    commandType: "CREATE_MEMORY",
    memoryId: null,
    actorUserId: user.id,
    idempotencyKey,
    payload: {
      to_state: lifecycleStateOf("draft"),
      visibility: "trip_crew",
      write: tripInsertRow,
      select: TRIP_MEMORY_SELECT,
    },
    legacy: async () => {
      const { data, error } = await sc
        .from("memories")
        .insert(tripInsertRow)
        .select(TRIP_MEMORY_SELECT as any)
        .single();
      if (error) {
        req.log.error({ err: error }, "create-from-trip failed");
        return { ok: false, http: { code: "db_error", message: error.message } };
      }
      return { ok: true, body: data };
    },
  });

  if (!created.ok) { sendCommandFailure(req, res, created); return; }
  const memory = created.body;

  const memoryId = (memory as any).id;
  let taggedCount = 0;

  // `!created.duplicate` for the same reason POST /memories skips it: a replayed
  // command must not tag the crew a second time — the original command already
  // did, and the receipt is what says so.
  if (crewIds.length > 0 && !created.duplicate) {
    const tagRows = crewIds.map((uid) => ({ memory_id: memoryId, tagged_user_id: uid, status: "pending" }));
    // Same defect as the create route: `.then(undefined, cb)` is a REJECTION
    // handler and supabase-js RESOLVES on a database error, so a failed insert
    // was invisible — and here the route went on to answer
    // `taggedCount: crewIds.length`, a number describing rows that did not
    // exist. The count is now what actually landed.
    const { error: tagErr } = await sc.from("memory_tags").insert(tagRows);
    if (tagErr) {
      req.log.error({ err: tagErr, memoryId, count: tagRows.length },
        "create-from-trip: memory_tags insert failed — no crew member was tagged");
      taggedCount = 0;
    } else {
      taggedCount = tagRows.length;
      for (const uid of crewIds) {
        notifyTagged(sc, memory, uid);
      }
    }
  }

  res.status(201).json({ memory: mapMemory(memory, user.id), taggedCount });
});

// ── GET /trips/:tripId/memory — fetch memory linked to a trip ─────────────────

router.get("/trips/:tripId/memory", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId } = req.params;
  if (!isUuid(tripId)) { sendError(res, "invalid_payload", "Invalid trip id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Resolve the trip owner first.  The create-from-trip route (POST /trips/:tripId/memory)
  // requires caller == trip owner, so the canonical trip memory always has owner_id == trip.owner_id.
  // Scoping to that owner prevents an unrelated crew member's trip-linked memory from being surfaced.
  //
  // `.error` bound for the same reason as the POST twin: an unreadable `trips`
  // used to answer 404 "Trip not found", which is a claim about the world made
  // out of a failure to look at it (§28.11).
  const { data: trip, error: tripErr } = await sc
    .from("trips")
    .select("id, owner_id")
    .eq("id", tripId)
    .maybeSingle();

  if (tripErr) {
    req.log.error({ err: tripErr, tripId }, "trip-memory: trips read failed — refusing rather than answering not_found");
    sendError(res, "degraded_unavailable", "Could not read the trip. Please try again.");
    return;
  }
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }

  const tripOwnerId = (trip as any).owner_id as string;

  const precisionEnabled = await isFlagEnabled(sc, "memory_location_precision_enabled");

  const { data: memory, error } = await sc
    .from("memories")
    .select((precisionEnabled ? MEMORY_SELECT_WITH_PRECISION : MEMORY_SELECT) as any)
    .eq("trip_id", tripId)
    .eq("owner_id", tripOwnerId)
    .neq("state", "deleted")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) { req.log.error({ err: error }, "trip-memory: query failed"); sendError(res, "db_error", error.message); return; }
  if (!memory) { sendError(res, "not_found", "No memory for this trip"); return; }

  if ((memory as any).owner_id !== user.id) {
    const blocked = await isBlocked(sc, user.id, (memory as any).owner_id);
    if (blocked) { sendError(res, "not_found", "No memory for this trip"); return; }
    const ok = await canReadMemory(sc, memory, user.id, "trip");
    if (!ok) { sendError(res, "not_found", "No memory for this trip"); return; }
  }

  const memoryId = (memory as any).id;
  const ownerId = (memory as any).owner_id;

  const [coverRow, likeCount, likedByMe, ownerProfile] = await Promise.all([
    sc.from("memory_items").select("media_url, media_type").eq("memory_id", memoryId).eq("position", 0).maybeSingle(),
    sc.from("memory_likes").select("memory_id", { count: "exact", head: true }).eq("memory_id", memoryId),
    sc.from("memory_likes").select("memory_id").eq("memory_id", memoryId).eq("user_id", user.id).maybeSingle(),
    sc.from("profiles").select("id, name, handle, avatar_url").eq("id", ownerId).maybeSingle(),
  ]);

  const ownerNameAllowed = ownerId === user.id || await nameVisibleFor(sc, ownerId);

  // Location protection (fail-closed) — the stricter of the Hidden-Gem ceiling
  // and the owner's §10 precision rung, for non-owner reads.
  const tripMemoryGemCtx = await loadMemoryGemContext(sc, [memory]);
  const safeTripMemory = protectMemoryRow(memory, tripMemoryGemCtx, user.id, precisionEnabled);

  res.json({
    memory: {
      ...mapMemory(safeTripMemory, user.id),
      likeCount: likeCount.count ?? 0,
      likedByMe: Boolean(likedByMe.data),
      cover: coverRow.data ? { mediaUrl: (coverRow.data as any).media_url, mediaType: (coverRow.data as any).media_type } : null,
      owner: ownerProfile.data ? {
        id: (ownerProfile.data as any).id,
        name: ownerNameAllowed ? (ownerProfile.data as any).name : null,
        handle: (ownerProfile.data as any).handle,
        avatarUrl: (ownerProfile.data as any).avatar_url ?? null,
      } : null,
    },
  });
});

/* ============================================================================
 * GET /trips/:tripId/memories/recap — §18 TripMemoryProjection, consumed.
 *
 * CENSUS H166. The §18 block of this census carries one blanket reason for
 * every row in it: "No route, lib or service outside `src/test/` and
 * `src/services/memoryCertification/` imports the registry". H.7 corrected
 * H166's evidence and left the gap stated exactly — "`TripMemoryProjection`
 * builds a LIST of a trip's Memories and nothing consumes it". This consumes
 * it.
 *
 * A NEW ROUTE, NOT A CHANGED ONE. `GET /trips/:tripId/memory` returns a single
 * `{ memory }` object and a shipped client reads that shape (D.1 group (b)
 * declined to change it on this lane's authority). Nothing about that route
 * moves here.
 *
 * THE PROJECTION IS NOT THE PERMISSION. `TripMemoryProjection.build` filters
 * to the scope owner's undeleted Memories on the trip; it does NOT run §23's
 * audience ladder, and it must not be asked to — the registry is a shaping
 * layer, not an authorization layer. So the ladder runs FIRST, per row, through
 * the same `canReadMemory(..., "trip")` the sibling route uses, and only the
 * rows it admits are handed to the builder. The builder's own owner filter then
 * runs on top, which is why another crew member's Memory cannot appear even if
 * the ladder admitted it.
 *
 * WHAT THE WHITELIST BUYS. `TRIP_FIELDS` has eight members and none of them is
 * `caption`, `location_lat` or `location_lng`. Serving the projection instead
 * of the row is what makes that structural rather than a matter of remembering
 * which keys to delete — the disclosure failure this census keeps finding.
 *
 * PARTICIPANTS GO THROUGH THE §10 LADDER BEFORE THE BUILDER SEES THEM. The
 * projection's `people` field is built from `approvedTagsFor`, which is consent
 * but not disclosure policy: a participant this viewer has blocked, or whose
 * rung is ANONYMOUS_COUNT, must not be named. `projectParticipants` decides
 * that once, and only the ids it keeps are handed in as tags.
 *
 * FAIL CLOSED ON EVERY INPUT. A recap assembled from an unreadable
 * `memory_items` is a recap in which nobody took any photographs, and a recap
 * assembled from an unreadable `memories` is an empty trip. Both refuse.
 * ============================================================================ */

/** A trip is a bounded thing; this is a guard against a pathological one. */
const TRIP_RECAP_LIMIT = 500;

router.get("/trips/:tripId/memories/recap", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId } = req.params;
  if (!isUuid(tripId)) { sendError(res, "invalid_payload", "Invalid trip id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: trip, error: tripErr } = await sc
    .from("trips").select("id, owner_id").eq("id", tripId).maybeSingle();
  if (tripErr) {
    req.log.error({ err: tripErr, tripId }, "trip-recap: trips read failed — refusing rather than answering not_found");
    sendError(res, "degraded_unavailable", "Could not read the trip. Please try again.");
    return;
  }
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }
  const tripOwnerId = (trip as any).owner_id as string;

  // AUDIENCE: §18 names this projection's audience TRIP_RECAP. Accepted crew
  // only — the same `acceptedCrewOfTrip` rule the visibility ladder uses, which
  // fails closed on an unreadable trip_members.
  const crew = await acceptedCrewOfTrip(sc, tripId);
  if (!crew.ok) {
    req.log.error({ err: crew.error, tripId }, "trip-recap: crew read failed — withholding the recap");
    sendError(res, "not_found", "No recap for this trip");
    return;
  }
  if (!crew.ids.has(user.id)) { sendError(res, "not_found", "No recap for this trip"); return; }

  if (user.id !== tripOwnerId && await isBlocked(sc, user.id, tripOwnerId)) {
    sendError(res, "not_found", "No recap for this trip");
    return;
  }

  const { data: rows, error } = await sc
    .from("memories")
    .select(MEMORY_SELECT as any)
    .eq("trip_id", tripId)
    .eq("owner_id", tripOwnerId)
    .neq("state", "deleted")
    .limit(TRIP_RECAP_LIMIT);
  if (error) {
    req.log.error({ err: error, tripId }, "trip-recap: memories read failed — refusing rather than serving an empty trip");
    sendError(res, "degraded_unavailable", "Could not build the trip recap. Please try again.");
    return;
  }

  // §23, per row, BEFORE the builder. `canReadMemory` is async, so this is a
  // filter over resolved verdicts rather than an `Array.prototype.filter`.
  const candidates = (rows ?? []) as any[];
  const verdicts = await Promise.all(
    candidates.map((m) => (m.owner_id === user.id ? Promise.resolve(true) : canReadMemory(sc, m, user.id, "trip"))),
  );
  const readable = candidates.filter((_m, i) => verdicts[i]);
  const memoryIds = readable.map((m) => m.id as string);

  const items: any[] = [];
  const tags: any[] = [];
  for (const batch of chunkIds(memoryIds)) {
    const [itemRes, tagRes] = await Promise.all([
      sc.from("memory_items").select("memory_id").in("memory_id", batch),
      sc.from("memory_tags").select("memory_id, tagged_user_id, status").in("memory_id", batch),
    ]);
    if (itemRes.error) {
      req.log.error({ err: itemRes.error, tripId }, "trip-recap: memory_items read failed — refusing rather than reporting a trip with no photographs");
      sendError(res, "degraded_unavailable", "Could not build the trip recap. Please try again.");
      return;
    }
    if (tagRes.error) {
      req.log.error({ err: tagRes.error, tripId }, "trip-recap: memory_tags read failed — refusing rather than reporting a trip nobody shared");
      sendError(res, "degraded_unavailable", "Could not build the trip recap. Please try again.");
      return;
    }
    items.push(...((itemRes.data ?? []) as any[]));
    tags.push(...((tagRes.data ?? []) as any[]));
  }

  // §10's person ladder, once for the whole recap. Every Memory here shares the
  // trip and the owner, so the only per-row input is the Memory's own
  // visibility — which is overridden per row below rather than re-loaded.
  const participantIds = [...new Set(tags.map((t) => t.tagged_user_id as string))];
  const baseCtx = await loadParticipantVisibility(
    sc,
    { owner_id: tripOwnerId, visibility: null, trip_id: tripId },
    user.id,
    participantIds,
  );
  const disclosedTags: Array<{ memory_id: string; tagged_user_id: string; status: string }> = [];
  for (const m of readable) {
    const mine = tags.filter((t) => t.memory_id === m.id);
    if (mine.length === 0) continue;
    const projected = projectParticipants(
      { ...baseCtx, memoryVisibility: (m.visibility as string | null) ?? null },
      mine as any,
    );
    for (const p of projected.participants) {
      // The builder's `approvedTagsFor` keys on status === "approved", so a
      // participant the ladder kept is passed through with the status it
      // actually has — the ladder narrows the list, it never promotes a tag.
      disclosedTags.push({ memory_id: m.id as string, tagged_user_id: p.userId, status: p.status ?? "" });
    }
  }

  const definition = getProjectionDefinition("TripMemoryProjection");
  if (!definition) { sendError(res, "db_error", "Projection definition missing"); return; }

  const sourceRows = readable as unknown as MemorySourceRow[];
  const built = definition.build({
    scope: { owner_id: tripOwnerId, viewer_id: user.id, trip_id: tripId },
    memories: sourceRows,
    tags: disclosedTags as any,
    items: items as any,
  });

  res.json({
    recap: {
      tripId,
      projectionId: definition.id,
      builderVersion: definition.builder_version,
      destination: definition.destination,
      audience: definition.audience,
      // §18 "every derivative is registered with source Memory version". The
      // registry TABLE is 2730 and unapplied (H174), so the version travels on
      // the response instead of being stored — a caller can still tell one
      // build of this recap from another.
      sourceVersion: sourceVersionOf(sourceRows).digest,
      rows: built,
    },
  });
});

// ── GET /users/:userId/memories ───────────────────────────────────────────────

router.get("/users/:userId/memories", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { userId } = req.params;
  if (!isUuid(userId)) { sendError(res, "invalid_payload", "Invalid user id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const isOwnProfile = user.id === userId;

  if (!isOwnProfile) {
    const blocked = await isBlocked(sc, user.id, userId);
    if (blocked) { res.json({ memories: [] }); return; }
  }

  const limit = Math.min(Number(req.query.limit ?? 30), 100);
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : null;

  const precisionEnabled = await isFlagEnabled(sc, "memory_location_precision_enabled");

  let q = sc
    .from("memories")
    .select((precisionEnabled ? MEMORY_SELECT_WITH_PRECISION : MEMORY_SELECT) as any)
    .eq("owner_id", userId)
    .neq("state", "deleted")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (!isOwnProfile) {
    (q as any) = (q as any).eq("state", "published");
  }

  if (cursor) {
    (q as any) = (q as any).lt("created_at", cursor);
  }

  const { data, error } = await q;
  if (error) { req.log.error({ err: error }, "user memories failed"); sendError(res, "db_error", error.message); return; }

  const rows = (data ?? []) as any[];

  let visible = rows;
  if (!isOwnProfile) {
    const permChecks = await Promise.all(rows.map((m) => canReadMemory(sc, m, user.id, "profile")));
    visible = rows.filter((_, i) => permChecks[i]);
  }

  // Location protection is applied by `enrichMemories`, which is the single
  // serialization point every LIST response on this surface goes through. Before
  // 2026-09-13 this handler was the one of four reads that did not perform it at
  // all, so a Memory sitting on a protected Hidden Gem was served COARSE from
  // `GET /memories` and EXACT from here — the same row, the same viewer, two
  // disclosures decided by which handler was reached. The fix is where it is so
  // that a fifth list read cannot repeat it by omission.
  const enriched = await enrichMemories(sc, visible, user.id, precisionEnabled);

  res.json({
    memories: enriched,
    nextCursor: visible.length === limit ? (visible[visible.length - 1]?.created_at ?? null) : null,
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function mapMemory(r: any, viewerId?: string) {
  // The allow/hide lists are the owner's private audience choices — literally the
  // set of user ids they hid this memory FROM. They must never reach another
  // viewer (audit MEM·M2). Fail-safe: only the owner sees them; any caller that
  // does not pass a viewer gets them omitted.
  const isOwner = viewerId != null && viewerId === r.owner_id;
  // §1 / §14 — every Memory this domain serves says, on the datum, that it is a
  // record of the past and establishes nothing about now. Applied by the
  // serializer, so no handler can forget it and none can override it: see
  // services/memory/historicalTruth.ts. THIS IS THE ONLY SERIALIZATION POINT
  // for a canonical Memory in this file — every route below returns
  // mapMemory(...) or spreads it — which is what makes one call here a property
  // of the domain rather than of whichever handler remembered.
  return asHistoricalMemoryPayload({
    id: r.id,
    ownerId: r.owner_id,
    title: r.title ?? null,
    caption: r.caption ?? null,
    visibility: r.visibility,
    ...(isOwner
      ? { allowedUserIds: r.allowed_user_ids ?? [], hiddenUserIds: r.hidden_user_ids ?? [] }
      : {}),
    // §10 location_precision is the OWNER'S publication policy, and like the
    // allow/hide lists it is a private choice about an audience rather than a
    // fact about the Memory: telling a viewer "you are being shown this at city
    // level" discloses that the owner narrowed it for them. Owner only, and
    // omitted entirely when the column was not selected (flag off) so that an
    // absent column never serializes as a fabricated 'exact'.
    ...(isOwner && r.location_precision !== undefined
      ? { locationPrecision: normalizeMemoryPrecision(r.location_precision) }
      : {}),
    tripId: r.trip_id ?? null,
    eventId: r.event_id ?? null,
    placeId: r.place_id ?? null,
    locationCity: r.location_city ?? null,
    locationCountry: r.location_country ?? null,
    locationLat: r.location_lat != null ? Number(r.location_lat) : null,
    locationLng: r.location_lng != null ? Number(r.location_lng) : null,
    canonicalLocationId: r.canonical_location_id ?? null,
    startsAt: r.starts_at ?? null,
    endsAt: r.ends_at ?? null,
    state: r.state,
    createdAt: r.created_at,
    updatedAt: r.updated_at ?? null,
  });
}

function mapItem(r: any) {
  return {
    id: r.id,
    mediaUrl: r.media_url,
    mediaType: r.media_type,
    caption: r.caption ?? null,
    position: r.position,
    createdAt: r.created_at,
  };
}

/**
 * Serialize a LIST of Memory rows for one viewer.
 *
 * THE LOCATION PROTECTION LIVES HERE, AND THAT IS THE POINT. It used to be the
 * caller's job: `GET /memories` ran `protectMemoryRow` over its page before
 * handing it over, `GET /users/:userId/memories` did not, and nothing about the
 * call site said the second one owed anything. The result was live — a Memory
 * whose coordinates sit on a `protected` Hidden Gem (a DEPLOYED table, not a
 * pending migration) was coarsened to the city grid by the discovery feed and
 * served at its exact point by the profile listing, to the same viewer.
 *
 * Moving it inside the one list serializer makes the guarantee structural: a
 * future list read cannot omit it without also omitting the serializer, and
 * it cannot be applied TWICE by accident either — coarsening is a grid snap,
 * not an idempotent clamp, so a doubly-protected row would move again.
 *
 * `precisionEnabled` is the §10 rung's schema-presence gate, passed by the
 * caller because only the caller knows whether the row it read carries the
 * column (see MEMORY_SELECT_WITH_PRECISION and the feed's flag-combination
 * note). The Hidden-Gem ceiling is NOT gated on anything: it is independent,
 * fail-closed, and it is the half that was leaking.
 */
async function enrichMemories(sc: any, rows: any[], viewerId: string, precisionEnabled: boolean) {
  if (rows.length === 0) return [];

  const gemCtx = await loadMemoryGemContext(sc, rows);
  const safeRows = rows.map((m) => protectMemoryRow(m, gemCtx, viewerId, precisionEnabled));

  const ids = rows.map((m) => m.id as string);
  const ownerIds = [...new Set(rows.map((m) => m.owner_id as string))];

  const [likeRows, savedRows, coverRows, ownerRows, allowedNames] = await Promise.all([
    sc.from("memory_likes").select("memory_id, user_id").in("memory_id", ids),
    sc.from("memory_saves").select("memory_id").eq("user_id", viewerId).in("memory_id", ids),
    sc.from("memory_items")
      .select("memory_id, media_url, media_type")
      .in("memory_id", ids)
      .eq("position", 0),
    sc.from("profiles").select("id, name, handle, avatar_url").in("id", ownerIds),
    nameVisibilitySet(sc, ownerIds),
  ]);

  const likeCounts: Record<string, number> = {};
  const likedByMeSet = new Set<string>();
  for (const r of (likeRows.data ?? []) as any[]) {
    likeCounts[r.memory_id] = (likeCounts[r.memory_id] ?? 0) + 1;
    if (r.user_id === viewerId) likedByMeSet.add(r.memory_id);
  }

  const savedSet = new Set<string>((savedRows.data ?? []).map((r: any) => r.memory_id as string));
  const coverMap: Record<string, { mediaUrl: string; mediaType: string }> = {};
  for (const r of (coverRows.data ?? []) as any[]) {
    coverMap[r.memory_id] = { mediaUrl: r.media_url, mediaType: r.media_type };
  }

  const ownerMap: Record<string, { id: string; name: string | null; handle: string | null; avatarUrl: string | null }> = {};
  for (const r of (ownerRows.data ?? []) as any[]) {
    const nameAllowed = r.id === viewerId || allowedNames.has(r.id as string);
    ownerMap[r.id] = { id: r.id, name: nameAllowed ? r.name : null, handle: r.handle, avatarUrl: r.avatar_url ?? null };
  }

  return safeRows.map((m) => ({
    ...mapMemory(m, viewerId),
    likeCount: likeCounts[m.id] ?? 0,
    likedByMe: likedByMeSet.has(m.id),
    savedByMe: savedSet.has(m.id),
    cover: coverMap[m.id] ?? null,
    owner: ownerMap[m.owner_id] ?? null,
  }));
}

// ── GET /users/:userId/memories/highlights ────────────────────────────────────
//
// §18 ProfileHighlightProjection (H165), reached by a caller. §E.5 filed this
// row risk-blocked because "each changes a live response shape"; nothing here
// changes one. `GET /users/:userId/memories` is byte-identical and this is a
// LONGER path, so the shipped route cannot match it.
//
// WHY THE PROJECTION IS OVER `memories` AND NOT `highlights`: the definition
// declares `source_tables: ["memories", "memory_items"]`. §12's thesis is that
// a Highlight is a disposable projection over Memories, and the `highlights`
// table is the 24-hour Stories product §1 names as a non-goal.
//
// THREE GATES, IN THIS ORDER, AND EACH DOES SOMETHING THE OTHERS CANNOT:
//   1. the block check, on the pair, before anything is read;
//   2. §23's ladder per row, which knows about blocks and relationship classes
//      the builder has no notion of;
//   3. the builder's own audience filter, which is published-only, public or
//      explicitly allow-listed, and never a hidden viewer.
// The builder is the invariant and the ladder is the authorization; neither is
// asked to be the other.
//
// LOCATION IS COARSENED BEFORE THE BUILDER SEES IT. §H found three profile
// reads that published more than their siblings; a fourth profile read that
// skipped `protectMemoryRow` would be the same defect in a new place.
// PROFILE_HIGHLIGHT_FIELDS carries `location_city` / `location_country`, and a
// Hidden-Gem or §10 precision ceiling can empty both.
const PROFILE_HIGHLIGHT_LIMIT = 200;

router.get("/users/:userId/memories/highlights", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { userId } = req.params;
  if (!isUuid(userId)) { sendError(res, "invalid_payload", "Invalid user id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Fails CLOSED on an unreadable `blocks`: an outage refuses the profile
  // rather than publishing it to somebody who may have been blocked.
  if (user.id !== userId && await isBlocked(sc, user.id, userId)) {
    sendError(res, "not_found", "No profile highlights");
    return;
  }

  const { data: rows, error } = await sc
    .from("memories")
    .select(MEMORY_SELECT as any)
    .eq("owner_id", userId)
    .neq("state", "deleted")
    .order("starts_at", { ascending: false })
    .limit(PROFILE_HIGHLIGHT_LIMIT);
  if (error) {
    req.log.error({ err: error, ownerId: userId }, "memories: profile highlights read failed — refusing rather than serving an empty profile");
    sendError(res, "degraded_unavailable", "We could not build this profile. Please try again.");
    return;
  }

  const owned = (rows ?? []) as any[];

  // §23, per row, BEFORE the builder.
  const verdicts = await Promise.all(
    owned.map((m) => (m.owner_id === user.id ? Promise.resolve(true) : canReadMemory(sc, m, user.id, "profile"))),
  );
  const readable = owned.filter((_m, i) => verdicts[i]);

  const precisionEnabled = await isFlagEnabled(sc, "memory_location_precision_enabled");
  const gemCtx = await loadMemoryGemContext(sc, readable);
  const safeRows = readable.map((m) => protectMemoryRow(m, gemCtx, user.id, precisionEnabled));

  const itemRes = await readMemoryItems(sc, safeRows.map((m) => m.id as string));
  if (!itemRes.ok) {
    req.log.error({ err: itemRes.error, ownerId: userId }, "memories: profile highlight item read failed — refusing rather than reporting a photograph-free profile");
    sendError(res, "degraded_unavailable", "We could not build this profile. Please try again.");
    return;
  }

  const definition = getProjectionDefinition("ProfileHighlightProjection");
  if (!definition) { sendError(res, "db_error", "Projection definition missing"); return; }

  const scope = { owner_id: userId, viewer_id: user.id };
  const sourceRows = safeRows as unknown as MemorySourceRow[];
  const built = definition.build({ scope, memories: sourceRows, tags: [], items: itemRes.items as any });
  const disclosed = discloseProjectionRows(definition, scope, built as any);

  res.json({
    profileHighlights: {
      userId,
      projectionId: definition.id,
      builderVersion: definition.builder_version,
      destination: definition.destination,
      audience: definition.audience,
      sourceVersion: sourceVersionOf(sourceRows).digest,
      // 2730 is unapplied (H174): built per request, not registered.
      registered: false,
      truncated: owned.length >= PROFILE_HIGHLIGHT_LIMIT,
      rows: disclosed,
    },
  });
});

export default router;
