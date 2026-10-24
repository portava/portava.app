/**
 * discoveryTrailOpen — `04` §4 "Travel intent: trail_open", the server writer
 * (census-discovery DV-78, §133). POST /rank-events/trail-open
 * (routes/rankEvents.ts, at its tail).
 *
 * THE REQUIREMENT, QUOTED
 * =======================
 * `docs/specs/discovery-v1/04_Behavior_Engine.md` §4 lists `trail_open` among
 * the travel-intent events, §8 names "Trail open → place open → directions" a
 * high-value chain, and §6: "If the current table cannot represent this safely,
 * extend it by migration rather than introducing a competing event store."
 *
 * REPRESENTED IN rank_events, WITH NO SCHEMA CHANGE
 * =================================================
 * One row per open, the dwell writer's shape (lib/discoveryDwell.ts):
 * `event_type = 'trail_open'` and `outcome = 'analytics'` — the sentinel every
 * funnel, momentum, trend, seen-set and Trail reader already excludes — so an
 * open is never read as an exposure (the serve corpus is `event_type IS NULL`)
 * or as a funnel outcome, and it never enters a place's trend windows. The
 * Trail is the item: `item_id = 'trail/<trail uuid>'` (no place uses that
 * prefix), `item_kind` NULL (its CHECK has no 'trail'), surface `discovery`
 * (the surface CHECK has no Trail surface, and D-W10T-6 declined adding one).
 * `served_at` is the instant the server received the open.
 *
 * GATED, AND SEEDED OFF — THIS IS NEW COLLECTION
 * ==============================================
 * A Trail open is recorded against the viewer's account. Whether to collect it
 * is a consent and data-use question the owner has not decided (it is the same
 * class as dwell, D-W10-O-9, which names only the place detail sheet). So every
 * write sits behind `discovery_trail_open_telemetry_enabled` (3923, seeded
 * FALSE, never turned on by this lane). OFF, absent or unreadable: the flag is
 * the only read, nothing is written, and the route answers 404
 * `feature_disabled`.
 *
 * ONLY A TRAIL THE VIEWER MAY SEE
 * ===============================
 * D-66 (services/trails/TrailService.ts `trailVisibleTo`): approved, or the
 * viewer created it; never an archived Trail. Anything else is 404 and never
 * says which. A database without 3977's `review_state` cannot say whether a
 * Trail is approved, so nothing is written (503), never "approved".
 *
 * IDEMPOTENT ON RETRY
 * ===================
 * The client mints `client_event_id` once per open and re-sends it on a retry.
 * The row's `recommendation_id` is derived from (caller, client_event_id,
 * Trail) under its own `trail_open:` domain, so a retry reproduces it and
 * 2891's UNIQUE (recommendation_id, outcome) settles it ON CONFLICT DO NOTHING.
 */
import { z } from "zod";
import { recommendationIdFor } from "./discoveryRecommendationId.js";
import {
  checkEventSchemaVersion,
  isDuplicateExposureReplay,
  DISCOVERY_EVENT_SCHEMA_VERSION,
  DISCOVERY_EVENT_PRIVACY_CLASS,
} from "./discoveryRecommendationRecord.js";
import { RECOMMENDATION_ARBITER, isMissingRecommendationIdSchema, reportRankEventsRejection } from "./rankEventsProvenance.js";
import { isFlagEnabled } from "./featureFlags.js";
import { sendError } from "./http.js";

/** 3923's row, seeded FALSE. `*_enabled` ⇒ read fail-closed through `isFlagEnabled`. */
export const TRAIL_OPEN_FLAG = "discovery_trail_open_telemetry_enabled";

/** `04` §4's own token. */
export const TRAIL_OPEN_EVENT_TYPE = "trail_open" as const;

/** The surface the row is written on (see the header). */
export const TRAIL_OPEN_SURFACE = "discovery" as const;

/** The item id of a Trail: a prefix no place, event or post id carries. */
export function trailOpenItemId(trailId: string): string {
  return `trail/${trailId.toLowerCase()}`;
}

const TRAIL_OPEN_TOKEN_DOMAIN = "trail_open";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const trailOpenBodySchema = z.object({
  trail_id:        z.string().regex(UUID_RE, "trail_id must be a UUID"),
  client_event_id: z.string().regex(UUID_RE, "client_event_id must be a UUID"),
  session_id:      z.string().regex(UUID_RE, "session_id must be a UUID").nullish(),
  schema_version:  z.unknown().optional(),
}).strict();
export type TrailOpenBody = z.infer<typeof trailOpenBodySchema>;

/** The row's token: (caller, open, Trail) and nothing else — no clock — so a retry collides with its first landing. */
export function trailOpenTokenFor(userId: string, clientEventId: string, trailId: string): string {
  return recommendationIdFor({
    userId,
    sessionId: `${TRAIL_OPEN_TOKEN_DOMAIN}:${clientEventId.toLowerCase()}`,
    servedAt:  "",
    surface:   TRAIL_OPEN_SURFACE,
    position:  0,
    itemId:    trailOpenItemId(trailId),
  });
}

/** What the Trail lookup returns. */
export interface TrailOpenTrailRow {
  id?: unknown;
  created_by?: unknown;
  review_state?: unknown;
  lifecycle_status?: unknown;
}

/**
 * D-66, as `trailVisibleTo` states it (pinned equal by the suite), plus "never
 * archived": an open of a Trail the viewer may not see is not recorded.
 */
export function trailOpenAllowed(row: TrailOpenTrailRow | null | undefined, viewerId: string): boolean {
  if (!row || typeof row.id !== "string") return false;
  if (row.lifecycle_status === "archived") return false;
  if (row.review_state === "approved") return true;
  return typeof row.created_by === "string" && row.created_by === viewerId;
}

/** One row, spelled out so `check:write-path-columns` reads every column this writer sends. */
export function trailOpenRowFor(userId: string, body: TrailOpenBody, receivedAt: string) {
  return {
    event_type:        TRAIL_OPEN_EVENT_TYPE,
    item_id:           trailOpenItemId(body.trail_id),
    item_kind:         null,
    surface:           TRAIL_OPEN_SURFACE,
    user_id:           userId,
    session_id:        body.session_id ? body.session_id.toLowerCase() : null,
    served_at:         receivedAt,
    outcome:           "analytics",
    outcome_at:        receivedAt,
    recommendation_id: trailOpenTokenFor(userId, body.client_event_id, body.trail_id),
    schema_version:    DISCOVERY_EVENT_SCHEMA_VERSION,
    privacy_class:     DISCOVERY_EVENT_PRIVACY_CLASS,
  };
}

/** This writer's name in the rejection counter. */
const TRAIL_OPEN_WRITER = "lib/discoveryTrailOpen.ts";

type TrailOpenLog = { warn?: (ctx: unknown, msg?: string) => void; error?: (ctx: unknown, msg?: string) => void } | undefined;

/** Accept one Trail open for a signed-in caller. The route has authenticated; this answers exactly once. */
export async function acceptTrailOpen(
  sc: any,
  req: { body: unknown; log?: TrailOpenLog },
  res: any,
  userId: string,
  nowIso: string = new Date().toISOString(),
): Promise<void> {
  if (!sc) { sendError(res, "server_not_configured", "Service client not available"); return; }

  // The owner's gate first: with it off nothing else is read and nothing written.
  if (!(await isFlagEnabled(sc, "discovery_trail_open_telemetry_enabled"))) {
    sendError(res, "feature_disabled", "Trail-open telemetry is not enabled");
    return;
  }

  const parsed = trailOpenBodySchema.safeParse(req.body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = (issue?.path?.length ?? 0) > 0 ? `${issue!.path.join(".")}: ` : "";
    sendError(res, "invalid_payload", `${where}${issue?.message ?? "Invalid payload"}`);
    return;
  }
  const body = parsed.data;
  const version = checkEventSchemaVersion(body.schema_version);
  if (!version.ok) { sendError(res, "invalid_payload", `unsupported_schema_version: ${version.reason}`); return; }

  const trail = await sc.from("trails").select("id, created_by, review_state, lifecycle_status").eq("id", body.trail_id.toLowerCase()).maybeSingle();
  if (trail?.error) {
    const code = String(trail.error?.code ?? "");
    (req.log?.error ?? console.error).call(req.log ?? console, { err: trail.error }, "rank-events/trail-open: trail read failed");
    // 3977 absent (no review_state) or 2910 absent (no trails): whether the viewer may see it is unknown.
    if (["42703", "PGRST204", "42P01", "PGRST205"].includes(code)) { sendError(res, "degraded_unavailable", "Trail visibility cannot be read here"); return; }
    sendError(res, "db_error", String(trail.error?.message ?? "db_error"));
    return;
  }
  if (!trailOpenAllowed(trail?.data as TrailOpenTrailRow | null, userId)) { sendError(res, "not_found", "No such Trail for this viewer"); return; }

  const attempt = await sc.from("rank_events")
    .upsert([trailOpenRowFor(userId, body, nowIso)], { onConflict: RECOMMENDATION_ARBITER, ignoreDuplicates: true })
    .select("id");
  const error = attempt?.error ?? null;
  if (error && isDuplicateExposureReplay(error)) { res.json({ ok: true, recorded: 0, duplicate: true }); return; }
  if (error) {
    reportRankEventsRejection(req.log, { writer: TRAIL_OPEN_WRITER, err: error, rows: 1, extra: { where: "trail_open insert" } });
    if (isMissingRecommendationIdSchema(error)) {
      // Without 2891's arbiter a retry would double-write: write nothing rather than something non-idempotent.
      sendError(res, "degraded_unavailable", "trail_open requires migration 2891");
      return;
    }
    sendError(res, "db_error", String(error?.message ?? "db_error"));
    return;
  }
  const landed = Array.isArray(attempt?.data) ? attempt.data.length : 1;
  res.json({ ok: true, recorded: landed, duplicate: landed === 0 });
}
