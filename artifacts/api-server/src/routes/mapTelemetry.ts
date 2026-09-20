/**
 * POST /api/map/telemetry — ingest for the Map product telemetry set (spec §35).
 *
 *   flag: map_telemetry_enabled (OFF by default; fail-soft)
 *
 * Receives batches from the client emitter
 * (travel-buddy-standalone/src/features/map/telemetry/mapTelemetry.ts) and
 * writes them to `map_telemetry_events`.
 *
 * THE ACTOR IS STAMPED SERVER-SIDE, NEVER ACCEPTED
 * ================================================
 * `viewer_id` comes from the bearer token, exactly as
 * routes/mediaAnalyticsBatch.ts does it. A client-supplied actor field is not
 * merely ignored — `stripActorKeys` removes it from the payload before the
 * write, so a batch cannot smuggle one in under a different name either.
 *
 * SECOND-LINE PRIVACY ENFORCEMENT
 * ===============================
 * The client scrubber is the first line: it coarsens every position to a
 * ~4.9 km geohash cell and strips identity keys before an event is queued. This
 * route does NOT trust that. §23 and §24 make raw coordinates the single worst
 * thing that could reach a telemetry store, so `rejectsDisallowedKeys` re-checks
 * every event and DROPS any that still carries a coordinate-, geometry- or
 * identity-shaped key at any depth. Dropped events are counted and returned, so
 * a scrubber regression shows up as a non-zero `rejected` rather than as
 * silently-stored coordinates.
 *
 * NEVER BLOCKS THE CLIENT
 * =======================
 * Analytics must not be able to break the map. Every failure path answers
 * `{ ok: true, accepted: 0 }` — unconfigured server, disabled flag, write
 * error. The client emitter re-queues on a non-2xx, so returning an error for
 * a permanent condition would make it retry forever.
 */
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import { checkRateLimit } from "../lib/rateLimit.js";

const router = Router();

/** The §35 event set. Anything else is dropped, not stored as "unknown". */
export const MAP_EVENT_NAMES = [
  "map_opened",
  "zone_selected",
  "place_opened",
  "live_state_viewed",
  "why_shown_opened",
  "compass_requested",
  "compass_option_selected",
  "route_started",
  "trip_stop_added",
  "plan_joined",
  "meet_here_created",
  "crew_locate_started",
  "contribution_submitted",
  "alternative_requested",
  "recommendation_accepted",
  "recommendation_declined",
  // Beyond §35's sixteen, deliberately: a refusal is not something the user
  // did, so §35 has no event for it — and without one, a policy block is
  // indistinguishable from a feature nobody used. See the client emitter.
  "meet_here_refused",
] as const;

export type MapEventName = (typeof MAP_EVENT_NAMES)[number];

const EVENT_NAME_SET = new Set<string>(MAP_EVENT_NAMES);

/**
 * Key fragments that must never appear in a stored telemetry payload, matched
 * case-insensitively as substrings at any depth.
 *
 * Deliberately mirrors the client scrubber's denylist. The duplication is the
 * point: this side must hold even if the client is old, modified, or replaced.
 */
export const DISALLOWED_KEY_FRAGMENTS: readonly string[] = [
  // position
  "lat", "lng", "lon", "coord", "geometry", "geohash", "bbox",
  "altitude", "accuracy", "heading", "bearing", "street", "postcode", "address",
  // identity
  "user_id", "userid", "contributor", "author", "owner", "profile_id",
  "creator", "host_id", "invitee_id", "actor", "account_id", "handle",
  "email", "phone", "avatar", "display_name", "displayname", "username",
  "device_id", "push_token",
];

/** Actor keys stripped before the write — the server stamps the actor itself. */
const ACTOR_KEYS = new Set(["viewer_id", "viewerId", "user_id", "userId", "actor"]);

const MAX_DEPTH = 8;

/**
 * True when any key at any depth contains a disallowed fragment. Also inspects
 * array elements, so a coordinate hidden inside a list is still caught.
 */
export function containsDisallowedKey(value: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH) return true; // too deep to verify => refuse
  if (Array.isArray(value)) {
    return value.some((v) => containsDisallowedKey(v, depth + 1));
  }
  if (value === null || typeof value !== "object") return false;
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    if (DISALLOWED_KEY_FRAGMENTS.some((frag) => lower.includes(frag))) return true;
    if (containsDisallowedKey(v, depth + 1)) return true;
  }
  return false;
}

/** Remove any client-supplied actor key, at the top level only (payloads are flat-ish). */
export function stripActorKeys(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (ACTOR_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

const eventSchema = z.object({
  name: z.string(),
  mapSessionId: z.string().max(128),
  seq: z.number().int().nonnegative(),
  ts: z.number().int().nonnegative(),
  payload: z.record(z.unknown()).optional().default({}),
  synthesizedSession: z.literal(true).optional(),
});

/**
 * The most events one batch may carry. Named rather than inline because the
 * disabled-flag drop counter above reads it too: it counts from the RAW body,
 * before `batchSchema` runs, and must clamp to the same ceiling.
 */
export const MAX_BATCH_EVENTS = 100;

const batchSchema = z.object({
  events: z.array(eventSchema).max(MAX_BATCH_EVENTS),
  meta: z
    .object({
      schemaVersion: z.string().max(16).optional(),
      mapSessionId: z.string().max(128).nullable().optional(),
      dropped: z.number().int().nonnegative().optional(),
      droppedTotal: z.number().int().nonnegative().optional(),
      droppedByReason: z.record(z.number().int().nonnegative()).optional(),
      queueDepth: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

router.post(
  "/map/telemetry",
  asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { user } = auth;

    const sc = getServiceClient();
    // Non-fatal: telemetry must never block the client.
    if (!sc) {
      res.json({ ok: true, accepted: 0, rejected: 0 });
      return;
    }

    if (!(await isFlagEnabled(sc, "map_telemetry_enabled"))) {
      // ── THE DISABLED FLAG DISCARDS, AND THE DISCARD IS RECORDED ──────────
      // This used to answer 200 and drop the batch on the floor. The client
      // treats any 2xx as delivered, so it cleared its queue and reset its own
      // drop counters, and the events ceased to exist without anything,
      // anywhere, counting them. Commit 63772b76c found the consequence in
      // production — "every production map telemetry event was silently
      // discarded" — and the reason it went unnoticed for months is that the
      // discard left no trace. A dashboard cannot tell an off flag from a
      // feature nobody opened, because both read zero.
      //
      // So the count is written, to the table that exists for exactly this —
      // `map_telemetry_drops` already carries the client's own losses under
      // `dropped_by_reason` — with `flag_disabled` naming the cause. What is
      // stored is a COUNT and a session id: no event names, no payloads, no
      // positions. That is deliberately the minimum that makes the loss
      // observable, and it is the reason this is not simply "collecting
      // telemetry while telemetry is switched off": the flag governs whether
      // the PRODUCT's §35 event stream is collected, and this row is an
      // operational fact about the pipeline rather than a record of anything
      // the user did on the map. It ages out on the same 90-day retention
      // (`map_telemetry_drops.expires_at`) as every other row in the table.
      //
      // An empty batch writes nothing: a row asserting that zero events were
      // lost is noise, and a row written unconditionally would satisfy "the
      // discard is recorded" without recording any discard.
      //
      // Counted from the RAW body, because the flag gate runs before
      // `batchSchema` — deliberately, so a disabled feature does not spend
      // validation on a payload it will not store. The count is clamped to the
      // batch ceiling the schema would enforce: `dropped` is an `integer`
      // column, and an unvalidated length must not be able to overflow it and
      // turn this non-fatal path into a write error.
      const rawEvents = (req.body as { events?: unknown } | null)?.events;
      const discarded = Array.isArray(rawEvents) ? Math.min(rawEvents.length, MAX_BATCH_EVENTS) : 0;
      if (discarded > 0) {
        const meta = (req.body as { meta?: { mapSessionId?: unknown } } | null)?.meta;
        const sessionId = typeof meta?.mapSessionId === "string" ? meta.mapSessionId : null;
        const { error } = await sc.from("map_telemetry_drops").insert({
          viewer_id: user.id,
          map_session_id: sessionId,
          dropped: discarded,
          dropped_total: discarded,
          dropped_by_reason: { flag_disabled: discarded },
          queue_depth: 0,
        });
        // Still non-fatal. A drop counter that cannot be written must not turn
        // a disabled feature into a client-visible error.
        if (error) req.log.warn({ err: error }, "map/telemetry: disabled-flag drop write failed");
      }
      res.json({ ok: true, accepted: 0, rejected: 0, enabled: false, discarded });
      return;
    }

    const rl = checkRateLimit("map_telemetry", user.id, 60, 60_000);
    if (!rl.allowed) {
      res.setHeader("Retry-After", Math.ceil(rl.retryAfterMs / 1000).toString());
      sendError(res, "rate_limited", "Too many requests. Please wait.");
      return;
    }

    const parsed = batchSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
      return;
    }

    const rows: Array<Record<string, unknown>> = [];
    let rejected = 0;
    let unknownName = 0;

    for (const evt of parsed.data.events) {
      if (!EVENT_NAME_SET.has(evt.name)) {
        unknownName += 1;
        continue;
      }
      const payload = stripActorKeys(evt.payload ?? {});
      // Second line of defence — see the header.
      if (containsDisallowedKey(payload)) {
        rejected += 1;
        continue;
      }
      rows.push({
        viewer_id: user.id, // stamped from the token; never from the body
        // The contract that produced this row. Stored so a breaking payload
        // change is deliberate and visible, rather than silently averaged in
        // with rows written under a different shape.
        schema_version: parsed.data.meta?.schemaVersion ?? "1.0",
        event_name: evt.name,
        map_session_id: evt.mapSessionId,
        seq: evt.seq,
        client_ts: new Date(evt.ts).toISOString(),
        synthesized_session: evt.synthesizedSession === true,
        payload,
      });
    }

    // The client's own drop counters are persisted alongside the batch so a
    // silently-shrinking event stream is observable rather than invisible.
    const meta = parsed.data.meta;
    if (meta && (meta.dropped ?? 0) > 0) {
      const { error } = await sc.from("map_telemetry_drops").insert({
        viewer_id: user.id,
        map_session_id: meta.mapSessionId ?? null,
        dropped: meta.dropped ?? 0,
        dropped_total: meta.droppedTotal ?? 0,
        dropped_by_reason: meta.droppedByReason ?? {},
        queue_depth: meta.queueDepth ?? 0,
      });
      if (error) req.log.warn({ err: error }, "map/telemetry: drop-counter write failed");
    }

    if (rows.length > 0) {
      const { error } = await sc.from("map_telemetry_events").insert(rows);
      if (error) {
        req.log.warn({ err: error }, "map/telemetry: event write failed");
        // Still 200: the client re-queues on a non-2xx, and a permanent write
        // failure would make it retry the same batch forever.
        res.json({ ok: true, accepted: 0, rejected, unknownName });
        return;
      }
    }

    res.json({ ok: true, accepted: rows.length, rejected, unknownName });
  }),
);

export default router;
