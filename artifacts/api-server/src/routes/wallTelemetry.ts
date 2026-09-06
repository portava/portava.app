/**
 * POST /api/wall/telemetry — ingest for the Wall's §32 analytics set.
 *
 * THE ROUTE THE CLIENT HAS ALWAYS POSTED TO, AND WHICH DID NOT EXIST
 * ==================================================================
 * `features/wall/services/wallAnalytics.ts` fans every Wall event to a
 * pluggable sink; `wallAnalyticsTransport.ts` — wired at app boot — POSTs each
 * one to `/api/wall/telemetry` as `{ events: [event] }`. No such route existed,
 * and the transport is fire-and-forget, so every one of those POSTs 404'd
 * silently. Thirteen of §32's fifteen events (feed open, mode select,
 * engagement, Live For You shown/opened, Context Thread shown/acted/ignored,
 * follow-from-feed, handoff, caught-up, not-interested, real-world outcome) had
 * NO server home at all — only impression and action did, via
 * POST /wall/impression and POST /wall/action.
 *
 * That is why this is a route and not a client repoint: there was nothing to
 * repoint the other thirteen events AT.
 *
 * THE PAYLOAD IS REBUILT, NOT ACCEPTED
 * ====================================
 * §32's rule is that the Wall never records raw private message text or
 * unnecessary raw typed content. A generic "strip the bad keys" scan protects
 * that only as well as the denylist is complete. The Wall's event set is a
 * closed union of fifteen shapes carrying only ids, enums and counts, so this
 * route does the stronger thing: for each event it copies ONLY the fields that
 * event is defined to have, validating each one — an unknown field cannot ride
 * along, and a free-text `outcome` is rejected rather than stored, because
 * `outcome` is a coarse enum in the spec.
 *
 * `containsDisallowedKey` remains as a backstop over the rebuilt payload, and
 * migration 2308 adds a CHECK constraint as the third line at the database.
 *
 * THE ACTOR IS STAMPED SERVER-SIDE, NEVER ACCEPTED
 * ================================================
 * `viewer_id` comes from the bearer token, exactly as routes/mapTelemetry.ts
 * and routes/mediaAnalyticsBatch.ts do it. Actor-shaped keys are not merely
 * ignored — they are not in any event's allow-list, so they cannot survive the
 * rebuild under any name.
 *
 * NEVER BLOCKS THE CLIENT
 * =======================
 * Analytics must never break the feed (§34/§40). Every failure path answers
 * `{ ok: true, accepted: 0 }` — unconfigured server, disabled flag, write
 * error. Only an unauthenticated caller, a malformed body or a rate limit gets
 * a non-2xx, and those are conditions the client should see.
 */
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import { checkRateLimit } from "../lib/rateLimit.js";

const router = Router();

/**
 * §37 ingest limit. Exported so its test derives the fixture from the gate's own
 * constant rather than a literal that can drift away from the route.
 */
export const WALL_TELEMETRY_RATE_LIMIT = {
  id: "wall_telemetry",
  limit: 600,
  windowMs: 60_000,
} as const;

/** The §32 event set, exactly as `WallAnalyticsEvent['type']` enumerates it. */
export const WALL_TELEMETRY_EVENT_NAMES = [
  "wall_feed_open",
  "wall_mode_select",
  "wall_impression",
  "wall_action",
  "wall_engagement",
  "wall_live_shown",
  "wall_live_open",
  "wall_context_shown",
  "wall_context_acted",
  "wall_context_ignored",
  "wall_follow_from_feed",
  "wall_handoff",
  "wall_caught_up",
  "wall_not_interested",
  "wall_real_world_outcome",
] as const;

export type WallTelemetryEventName = (typeof WALL_TELEMETRY_EVENT_NAMES)[number];

/** Wall feed modes (`WallMode`). */
const MODES = new Set(["for_you", "following"]);
/** Social engagements measured per object (`WallEngagementKind`). */
const ENGAGEMENT_KINDS = new Set(["stamp", "comment", "share", "save"]);
/** Surrounding surfaces a Wall object can bridge into (`WallHandoffSurface`). */
const HANDOFF_SURFACES = new Set(["map", "place", "trip", "compass", "buddy"]);
/** The mutation verbs POST /wall/action accepts (`WallActionEvent`). */
const ACTIONS = new Set(["open", "tap", "save", "hide", "report", "follow", "share"]);
/** Context Thread kinds (`ContextThreadKind`). */
const THREAD_KINDS = new Set([
  "live_place",
  "social_presence",
  "trip_relevance",
  "hidden_gem",
  "buddy",
  "map",
  "memory",
  "compass",
]);
/**
 * §32: a real-world outcome carries a COARSE ENUM, never raw typed content.
 * `WallRealWorldOutcome` on the client. The client type widens `outcome` to
 * `string` on the low-level `trackRealWorldOutcome`; this is where that widening
 * stops.
 */
const REAL_WORLD_OUTCOMES = new Set(["see_place", "add_to_trip", "book_buddy"]);

/** Ids and object-type tokens are bounded so a payload cannot smuggle prose. */
const MAX_ID_LEN = 128;
const MAX_TOKEN_LEN = 64;

function id(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_ID_LEN ? v : undefined;
}
function token(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_TOKEN_LEN ? v : undefined;
}
function member(v: unknown, set: Set<string>): string | undefined {
  return typeof v === "string" && set.has(v) ? v : undefined;
}
function count(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1_000_000
    ? Math.trunc(v)
    : undefined;
}
function bool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

type Raw = Record<string, unknown>;

/** The object-id + object-type pair shared by seven of the fifteen events. */
function objectRef(e: Raw): Raw | null {
  const objectId = id(e.objectId);
  const objectType = token(e.objectType);
  if (!objectId || !objectType) return null;
  return { objectId, objectType };
}

/**
 * Rebuild one event's payload from its allow-list. Returns null when the event
 * is unknown or its required fields are missing/invalid — a malformed event is
 * DROPPED, never stored half-formed or as "unknown".
 */
export function sanitizeWallEvent(
  event: unknown,
): { name: WallTelemetryEventName; payload: Raw } | null {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  const e = event as Raw;
  const type = typeof e.type === "string" ? e.type : "";
  switch (type) {
    case "wall_feed_open":
    case "wall_mode_select":
    case "wall_caught_up": {
      const mode = member(e.mode, MODES);
      return mode ? { name: type, payload: { mode } } : null;
    }
    case "wall_impression": {
      const ref = objectRef(e);
      if (!ref) return null;
      const session = id(e.session);
      return { name: type, payload: session ? { ...ref, session } : ref };
    }
    case "wall_action": {
      const ref = objectRef(e);
      const action = member(e.action, ACTIONS);
      return ref && action ? { name: type, payload: { ...ref, action } } : null;
    }
    case "wall_engagement": {
      const ref = objectRef(e);
      const kind = member(e.kind, ENGAGEMENT_KINDS);
      return ref && kind ? { name: type, payload: { ...ref, kind } } : null;
    }
    case "wall_live_shown": {
      const c = count(e.count);
      return c === undefined ? null : { name: type, payload: { count: c } };
    }
    case "wall_live_open": {
      const subjectId = id(e.subjectId);
      const liveObjectType = token(e.liveObjectType);
      return subjectId && liveObjectType
        ? { name: type, payload: { subjectId, liveObjectType } }
        : null;
    }
    case "wall_context_shown":
    case "wall_context_acted":
    case "wall_context_ignored": {
      const kind = member(e.kind, THREAD_KINDS);
      return kind ? { name: type, payload: { kind } } : null;
    }
    case "wall_follow_from_feed": {
      const ref = objectRef(e);
      const fromDiscovery = bool(e.fromDiscovery);
      return ref && fromDiscovery !== undefined
        ? { name: type, payload: { ...ref, fromDiscovery } }
        : null;
    }
    case "wall_handoff": {
      const ref = objectRef(e);
      const surface = member(e.surface, HANDOFF_SURFACES);
      return ref && surface ? { name: type, payload: { ...ref, surface } } : null;
    }
    case "wall_not_interested": {
      const ref = objectRef(e);
      return ref ? { name: type, payload: ref } : null;
    }
    case "wall_real_world_outcome": {
      const ref = objectRef(e);
      const outcome = member(e.outcome, REAL_WORLD_OUTCOMES);
      return ref && outcome ? { name: type, payload: { ...ref, outcome } } : null;
    }
    default:
      return null;
  }
}

/**
 * Key fragments that must never appear in a stored Wall telemetry payload,
 * matched case-insensitively as substrings at any depth. Mirrors migration
 * 2308's CHECK. The rebuild above already makes these unreachable; this is the
 * assertion that it does, so a future edit that widens an allow-list by mistake
 * is caught here rather than in the store.
 */
export const DISALLOWED_KEY_FRAGMENTS: readonly string[] = [
  // position
  "lat", "lng", "lon", "coord", "geometry", "geohash", "bbox",
  "address", "street", "postcode",
  // contact / identity
  "email", "phone", "avatar", "handle", "username", "display_name",
  "displayname", "device_id", "push_token", "user_id", "userid",
  "actor", "author", "owner", "creator", "profile_id",
  // free text (§32: never raw post/message content)
  "text", "content", "caption", "body", "message", "comment",
  "note", "query", "title", "description",
];

const MAX_DEPTH = 8;

/** True when any key at any depth contains a disallowed fragment. */
export function containsDisallowedKey(value: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH) return true; // too deep to verify => refuse
  if (Array.isArray(value)) return value.some((v) => containsDisallowedKey(v, depth + 1));
  if (value === null || typeof value !== "object") return false;
  for (const [key, v] of Object.entries(value as Raw)) {
    const lower = key.toLowerCase();
    if (DISALLOWED_KEY_FRAGMENTS.some((frag) => lower.includes(frag))) return true;
    if (containsDisallowedKey(v, depth + 1)) return true;
  }
  return false;
}

const batchSchema = z.object({
  events: z.array(z.unknown()).max(100),
  meta: z
    .object({ schemaVersion: z.string().max(16).optional() })
    .optional(),
});

router.post(
  "/wall/telemetry",
  asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { user } = auth;

    const sc = getServiceClient();
    // Non-fatal: telemetry must never block the Wall.
    if (!sc) {
      res.json({ ok: true, accepted: 0, dropped: 0 });
      return;
    }

    // The Wall's single master flag. Deliberately NOT a second telemetry-only
    // flag — see migration 2308's header.
    if (!(await isFlagEnabled(sc, "wall_enabled"))) {
      res.json({ ok: true, accepted: 0, dropped: 0, enabled: false });
      return;
    }

    // §37: bounded like the other Wall mutation endpoints. Generous enough for a
    // real scrolling session (impressions dominate), tight enough to stop a
    // flood. Ordered AFTER auth (so the counter is per real viewer) and BEFORE
    // any parse work.
    const rl = checkRateLimit(
      WALL_TELEMETRY_RATE_LIMIT.id,
      user.id,
      WALL_TELEMETRY_RATE_LIMIT.limit,
      WALL_TELEMETRY_RATE_LIMIT.windowMs,
    );
    if (!rl.allowed) {
      res.setHeader("Retry-After", Math.ceil(rl.retryAfterMs / 1000).toString());
      sendError(res, "rate_limited", "Too many events. Please slow down.");
      return;
    }

    const parsed = batchSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
      return;
    }

    const rows: Array<Record<string, unknown>> = [];
    let dropped = 0;
    for (const raw of parsed.data.events) {
      const clean = sanitizeWallEvent(raw);
      if (!clean || containsDisallowedKey(clean.payload)) {
        dropped += 1;
        continue;
      }
      rows.push({
        viewer_id: user.id, // stamped from the token; never from the body
        event_name: clean.name,
        schema_version: parsed.data.meta?.schemaVersion ?? "1.0",
        payload: clean.payload,
      });
    }

    if (rows.length > 0) {
      const { error } = await sc.from("wall_telemetry_events").insert(rows);
      if (error) {
        req.log.warn({ err: error }, "wall/telemetry: event write failed");
        // Still 200: a permanent write failure must not make the client retry
        // the same batch forever.
        res.json({ ok: true, accepted: 0, dropped });
        return;
      }
    }

    res.json({ ok: true, accepted: rows.length, dropped });
  }),
);

export default router;
