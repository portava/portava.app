/**
 * EventPassportService — temporary / event Passport (Passport spec §25, §31,
 * TABLE 31 Phase 8: "Sharing — QR Passport, Bump Passport, temporary event
 * Passport").
 *
 * WHAT THIS IS
 * ============
 * A short-lived, event-scoped share of a traveler's Passport. The owner, while
 * attending a live event, mints ONE opaque token for that event. Another
 * attendee who opens it gets the narrow `event` consumer-projection variant.
 * The share dies with the event, can be revoked at any moment, and is a POINTER
 * — it stores no projected content, so nothing about the owner is frozen into
 * it at mint time.
 *
 * FOUR RULES, ALL ENFORCED ON READ
 * ================================
 *   1. IT NEVER WIDENS. `resolveEventPassport` builds the projection with
 *      `buildPassportProjection(sc, ownerId, viewerId)` — the ORDINARY resolver,
 *      the viewer's own relationship — and then NARROWS it to the `event`
 *      allow-list. The share confers no relationship the viewer did not already
 *      have, so a scan can only ever show LESS than opening the passport
 *      normally would (§25 "Scanning a QR never bypasses privacy policy").
 *
 *   2. IT IS EVENT-SCOPED, FAIL-CLOSED. The viewer must themselves be an
 *      attendee of the SAME event (an RSVP the service reads, or the event's
 *      host, or the owner themselves). Any other viewer — and any unreadable
 *      attendance row — resolves to `not_attending`, never to a projection.
 *      That is a RESTRICTION on top of ordinary privacy, never a bypass of it.
 *
 *   3. IT EXPIRES, AND EXPIRY IS CHECKED ON READ (§31 "Explicitly expire …
 *      event Passport, temporary sharing"). Three independent horizons must all
 *      still be in the future: the share's own `expires_at` (bounded at mint to
 *      MIN(event end, now + EVENT_SHARE_MAX_TTL_MS), and structurally capped by
 *      migration 2294's CHECK), the event's `ends_at`, and the event still being
 *      in a live state. A stalled sweep cannot make a dead share resolve.
 *
 *   4. IT IS REVOCABLE. `revoked_at` is set, never deleted, so a revoked share
 *      resolves as `revoked` rather than as an unknown token — and the partial
 *      unique index still admits a fresh share for the same event afterwards.
 *
 * The whole surface is behind `passport_event_share_enabled` (migration 2294,
 * seeded OFF), read fail-closed via isFlagEnabled.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import { isFlagEnabled } from "../../lib/featureFlags.js";
import {
  buildConsumerProjection,
  type EventPassportProjection,
  type ConsumerProjectionOptions,
} from "./PassportConsumerProjections.js";

// The §25/§31 capability flag is `passport_event_share_enabled` (migration 2294,
// seeded OFF). It is written as a LITERAL at every isFlagEnabled call site below
// — never via a shared constant — so check:flag-polarity can resolve the
// argument, exactly as PassportProjectionService does for the §8 window flag.

/**
 * Hard ceiling on a share's life, independent of the event. Twelve hours covers
 * a festival day without ever becoming a standing link; migration 2294's CHECK
 * independently forbids anything past 24h, so a bug here still cannot store an
 * unbounded event Passport.
 */
export const EVENT_SHARE_MAX_TTL_MS = 12 * 60 * 60 * 1000;

/** Event states in which an event is genuinely happening (not draft/cancelled). */
const LIVE_EVENT_STATES = new Set(["open", "full", "waitlist", "started"]);

/** RSVP statuses that make someone an attendee for share purposes. */
const ATTENDING_RSVP_STATUSES = new Set(["going", "interested"]);

const SHARE_COLUMNS = "id, user_id, event_id, token, created_at, expires_at, revoked_at";

export interface EventPassportShare {
  id: string;
  userId: string;
  eventId: string;
  token: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

/** Why a share could not be minted or resolved. Every value is a REFUSAL. */
export type EventPassportRefusal =
  | "disabled"          // the capability flag is off (or unreadable)
  | "event_not_found"
  | "event_not_live"    // draft / cancelled / ended / no bounded end
  | "owner_not_attending"
  | "not_found"         // unknown token
  | "revoked"
  | "expired"
  | "not_attending"     // the VIEWER is not at this event
  | "no_passport";      // the owner has no passport at all

export type EventPassportResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: EventPassportRefusal };

function refuse<T>(reason: EventPassportRefusal): EventPassportResult<T> {
  return { ok: false, reason };
}

function rowToShare(row: any): EventPassportShare {
  return {
    id: row.id,
    userId: row.user_id,
    eventId: row.event_id,
    token: row.token,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at ?? null,
  };
}

interface EventFacts {
  id: string;
  city: string | null;
  startsAt: string | null;
  endsAt: string | null;
  state: string;
  hostId: string | null;
}

/** Load the event facts the share rules depend on. Never throws. */
async function loadEvent(sc: SupabaseClient, eventId: string): Promise<EventFacts | null> {
  try {
    const { data } = await sc
      .from("events")
      .select("id, city, starts_at, ends_at, state, host_id")
      .eq("id", eventId)
      .maybeSingle();
    if (!data) return null;
    const e = data as any;
    return {
      id: e.id,
      city: e.city ?? null,
      startsAt: e.starts_at ?? null,
      endsAt: e.ends_at ?? null,
      state: String(e.state ?? ""),
      hostId: e.host_id ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Is the event still a thing an event Passport may be scoped to? It must be in
 * a live state AND carry an explicit `ends_at` still in the future. An event
 * with no end cannot bound a TTL, so it can never carry a share (§31: a
 * temporary Passport that never expires is not temporary).
 */
export function eventIsShareable(e: EventFacts, nowMs: number): boolean {
  if (!LIVE_EVENT_STATES.has(e.state)) return false;
  if (typeof e.endsAt !== "string") return false;
  const end = Date.parse(e.endsAt);
  return Number.isFinite(end) && end > nowMs;
}

/**
 * Attendance, fail-closed: the event's host counts, an RSVP of going/interested
 * counts, and ANY read failure counts as NOT attending.
 */
async function isAttending(
  sc: SupabaseClient,
  e: EventFacts,
  userId: string,
): Promise<boolean> {
  if (e.hostId && e.hostId === userId) return true;
  try {
    const { data, error } = await sc
      .from("event_rsvps")
      .select("status")
      .eq("event_id", e.id)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) return false;
    if (!data) return false;
    return ATTENDING_RSVP_STATUSES.has(String((data as any).status));
  } catch {
    return false;
  }
}

/**
 * The instant a share minted now must stop resolving: the sooner of the event's
 * end and the service's own hard ceiling. Exported so the bound is testable
 * without a database.
 */
export function shareExpiryFor(eventEndsAt: string, nowMs: number): number {
  const end = Date.parse(eventEndsAt);
  const cap = nowMs + EVENT_SHARE_MAX_TTL_MS;
  return Math.min(Number.isFinite(end) ? end : cap, cap);
}

/** 48 hex chars — comfortably past migration 2294's 32-character floor. */
function mintToken(): string {
  return randomBytes(24).toString("hex");
}

// ─────────────────────────────────────────────────────────────────────────────
// Create
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mint (or re-mint) `ownerId`'s event Passport share for `eventId`.
 *
 * Refuses unless the flag is on, the event is live + time-bounded, and the OWNER
 * is attending it. Any previously live share for the same (owner, event) is
 * revoked first, so the partial unique index in 2294 always sees at most one
 * live row and an old QR stops working the moment a new one is made.
 */
export async function createEventPassportShare(
  sc: SupabaseClient,
  ownerId: string,
  eventId: string,
  nowMs: number = Date.now(),
): Promise<EventPassportResult<EventPassportShare>> {
  if (!(await isFlagEnabled(sc, "passport_event_share_enabled"))) return refuse("disabled");

  const event = await loadEvent(sc, eventId);
  if (!event) return refuse("event_not_found");
  if (!eventIsShareable(event, nowMs)) return refuse("event_not_live");
  if (!(await isAttending(sc, event, ownerId))) return refuse("owner_not_attending");

  const nowIso = new Date(nowMs).toISOString();
  // Revoke any live share for this (owner, event) BEFORE inserting, so the
  // partial unique index never sees two live rows.
  const revokeRes: any = await sc
    .from("event_passport_shares")
    .update({ revoked_at: nowIso })
    .eq("user_id", ownerId)
    .eq("event_id", eventId)
    .is("revoked_at", null);
  if (revokeRes?.error) return refuse("not_found");

  const expiresAt = new Date(shareExpiryFor(String(event.endsAt), nowMs)).toISOString();
  const { data, error } = await sc
    .from("event_passport_shares")
    .insert({
      user_id: ownerId,
      event_id: eventId,
      token: mintToken(),
      expires_at: expiresAt,
    })
    .select(SHARE_COLUMNS)
    .maybeSingle();
  if (error || !data) return refuse("not_found");
  return { ok: true, value: rowToShare(data) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Revoke
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Revoke `ownerId`'s live share for `eventId`. Scoped by user_id, so one
 * traveler can never revoke another's share. Idempotent: revoking when nothing
 * is live succeeds with `revoked: false`.
 */
export async function revokeEventPassportShare(
  sc: SupabaseClient,
  ownerId: string,
  eventId: string,
  nowMs: number = Date.now(),
): Promise<EventPassportResult<{ revoked: boolean }>> {
  if (!(await isFlagEnabled(sc, "passport_event_share_enabled"))) return refuse("disabled");
  const { data, error } = await sc
    .from("event_passport_shares")
    .update({ revoked_at: new Date(nowMs).toISOString() })
    .eq("user_id", ownerId)
    .eq("event_id", eventId)
    .is("revoked_at", null)
    .select(SHARE_COLUMNS);
  if (error) return refuse("not_found");
  return { ok: true, value: { revoked: Array.isArray(data) && data.length > 0 } };
}

// ─────────────────────────────────────────────────────────────────────────────
// Owner's own view
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The owner's LIVE share for an event, or null. Applies the same read-time
 * expiry as `resolveEventPassport`, so the owner is never shown "sharing" for a
 * share that has already lapsed.
 */
export async function getOwnEventPassportShare(
  sc: SupabaseClient,
  ownerId: string,
  eventId: string,
  nowMs: number = Date.now(),
): Promise<EventPassportShare | null> {
  try {
    const { data } = await sc
      .from("event_passport_shares")
      .select(SHARE_COLUMNS)
      .eq("user_id", ownerId)
      .eq("event_id", eventId)
      .is("revoked_at", null)
      .maybeSingle();
    if (!data) return null;
    const share = rowToShare(data);
    if (Date.parse(share.expiresAt) <= nowMs) return null;
    return share;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolve (the read path)
// ─────────────────────────────────────────────────────────────────────────────

export interface ResolvedEventPassport {
  share: { eventId: string; expiresAt: string };
  passport: EventPassportProjection;
}

/**
 * Resolve a share token for `viewerId`.
 *
 * Order matters and every step is a refusal, not a degradation:
 *   flag → token exists → not revoked → not past its own TTL → the event is
 *   still live and unfinished → the VIEWER is attending it → and only then the
 *   viewer's ORDINARY passport projection, narrowed to the `event` variant.
 *
 * An anonymous viewer (`viewerId === null`) can never be an attendee, so an
 * unauthenticated scan refuses at the attendance gate rather than falling
 * through to the public projection.
 */
export async function resolveEventPassport(
  sc: SupabaseClient,
  token: string,
  viewerId: string | null,
  nowMs: number = Date.now(),
  opts: ConsumerProjectionOptions = {},
): Promise<EventPassportResult<ResolvedEventPassport>> {
  if (!(await isFlagEnabled(sc, "passport_event_share_enabled"))) return refuse("disabled");

  const raw = String(token ?? "").trim();
  if (!raw) return refuse("not_found");

  let row: any = null;
  try {
    const { data } = await sc
      .from("event_passport_shares")
      .select(SHARE_COLUMNS)
      .eq("token", raw)
      .maybeSingle();
    row = data ?? null;
  } catch {
    return refuse("not_found");
  }
  if (!row) return refuse("not_found");
  const share = rowToShare(row);

  // §31 — revocation and expiry are re-evaluated HERE, on the read, never
  // delegated to a sweep.
  if (share.revokedAt !== null) return refuse("revoked");
  const expires = Date.parse(share.expiresAt);
  if (!Number.isFinite(expires) || expires <= nowMs) return refuse("expired");

  const event = await loadEvent(sc, share.eventId);
  if (!event) return refuse("event_not_found");
  // The share expires WITH the event, independently of its own TTL.
  if (!eventIsShareable(event, nowMs)) return refuse("expired");

  // Event-scoped, fail-closed: the viewer must be at this event too.
  if (!viewerId) return refuse("not_attending");
  const viewerIsOwner = viewerId === share.userId;
  if (!viewerIsOwner && !(await isAttending(sc, event, viewerId))) return refuse("not_attending");

  // The ORDINARY projection for this viewer, narrowed to the event allow-list.
  // No forced context, no elevated permissions: the share cannot widen.
  const passport = await buildConsumerProjection(sc, "event", share.userId, viewerId, opts);
  if (!passport) return refuse("no_passport");

  return {
    ok: true,
    value: {
      share: { eventId: share.eventId, expiresAt: share.expiresAt },
      passport,
    },
  };
}
