/**
 * LayoverDiscoveryConsent — §14 "L2 mutual discovery — profiles visible under policy", as a PER-PAIR consent
 * (census-layover L130). Storage: migration 3875 `layover_discovery_consents`, keyed on both layover sessions.
 *
 * Owner decision 2026-10-18 (§7): "Implement per-pair mutual-discovery consent. Both parties must explicitly opt in
 * before the corresponding mutual-discovery behavior is enabled. Include consent revocation and authorization tests."
 *
 * ── THE PRODUCT CONTRACT ─────────────────────────────────────────────────────
 *   1. A traveller who is sharing their own city (reciprocity: `share_city_status` + the §17 sharing gate) asks to
 *      see ONE named traveller (by handle) on this layover. That request is the requester's explicit opt-in, to that
 *      one person, from this one session.
 *   2. The target sees the request (who asked — the requester chose to say who they are) and accepts or declines.
 *      Acceptance is the target's explicit opt-in. If the target had already asked the requester, the second request
 *      IS the acceptance: both people have now asked for exactly this pair.
 *   3. Only an ACCEPTED, unexpired consent whose two sessions are both live shows each traveller to the other, and
 *      only through the same policy every other presence card uses: no block in either direction (blocks always
 *      win, also when placed after acceptance), the other traveller's sharing preference allows publishing them,
 *      names only per name visibility.
 *   4. Either party revokes at any time; the next read no longer shows them. Nothing is cached.
 *   5. The consent expires with the first of the two layovers (3875 bounds `expires_at` by both departures, and a
 *      session that ends is no longer live).
 *
 * ── WHAT THE REQUESTER IS NEVER TOLD ─────────────────────────────────────────
 * Whether the person they named is on a layover here. The request route answers the same words whether or not a
 * request was stored (no such handle, not here, not sharing, blocked, already asked), and there is no list of
 * outgoing requests — a stored request is itself proof the target is here and sharing, so listing it would be the
 * oracle this design exists to avoid. The requester learns the target is here only when the target accepts.
 *
 * ── WHY NOT AN ANONYMOUS "OPEN TO MEET" LIST ─────────────────────────────────
 * A list of anonymous candidates is a live, viewer-dependent count of people: it moves when one person toggles
 * sharing and shrinks when the viewer blocks someone — the two oracles the presence count rulings (D-PRESENCE-K-2..5)
 * closed for the L0/L1 counts. Asking by handle needs neither.
 *
 * ── THE GATE ─────────────────────────────────────────────────────────────────
 * `layover_mutual_discovery_enabled` (seeded FALSE by 3875), a literal at every read. OFF / absent / unreadable:
 * nothing is read or written, and the roster is EMPTY — never the old global-toggle roster. A failed read is
 * DEGRADED with a named reason (census L294), never an empty measurement.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";
import { isFlagEnabled } from "../../lib/featureFlags.js";
import { readBlockExclusions } from "../../lib/exclusionSet.js";
import { nameVisibilitySet } from "../../lib/publicIdentity.js";
import { evaluateSharingGate, discloseSharingGate, publishableUserIds } from "../airport/LayoverPrivacyGuard.js";
import { readDegraded, readValue, type LayoverRead } from "./layoverRead.js";

const logger = rootLogger.child({ service: "LayoverDiscoveryConsent" });

export const MUTUAL_DISCOVERY_FLAG = "layover_mutual_discovery_enabled";
/** The most profiles one L2 roster shows. */
export const MUTUAL_ROSTER_MAX = 12;
const LIVE = ["active", "returning"] as const;

export type ConsentStatus = "requested" | "accepted" | "declined" | "withdrawn" | "revoked";

export interface ConsentRow {
  id: string;
  requesterSessionId: string;
  targetSessionId: string;
  requesterUserId: string;
  targetUserId: string;
  status: ConsentStatus;
  requestedAt: string;
  respondedAt: string | null;
  expiresAt: string;
}

export interface DiscoveryCard {
  id: string;
  handle: string | null;
  name: string | null;
  avatarUrl: string | null;
}

/** The L2 roster, in the shape `cityPresence` answered (routes/airport.ts CityPresence), plus each card's consent. */
export interface MutualRoster {
  count: number;
  travelers: DiscoveryCard[];
  visibleUserIds: string[];
  consents: Array<{ consentId: string; userId: string; expiresAt: string }>;
}

const EMPTY_ROSTER: MutualRoster = Object.freeze({ count: 0, travelers: [], visibleUserIds: [], consents: [] }) as MutualRoster;
const COLS = "id, requester_session_id, target_session_id, requester_user_id, target_user_id, status, requested_at, responded_at, expires_at";

function toConsent(r: Record<string, any>): ConsentRow {
  return {
    id: String(r.id),
    requesterSessionId: String(r.requester_session_id),
    targetSessionId: String(r.target_session_id),
    requesterUserId: String(r.requester_user_id),
    targetUserId: String(r.target_user_id),
    status: r.status as ConsentStatus,
    requestedAt: new Date(r.requested_at).toISOString(),
    respondedAt: r.responded_at ? new Date(r.responded_at).toISOString() : null,
    expiresAt: new Date(r.expires_at).toISOString(),
  };
}

/** True only when the feature is on. Unreadable = off (the shared fail-closed reader). */
export async function mutualDiscoveryEnabled(db: SupabaseClient): Promise<boolean> {
  return isFlagEnabled(db, "layover_mutual_discovery_enabled");
}

/**
 * Which side of a consent is this viewer, for THIS session? Null when the row does not name this viewer on this
 * session — the cross-session forgery case: a consent made on one layover is not a consent on another.
 */
export function consentSide(row: ConsentRow, viewerId: string, sessionId: string): "requester" | "target" | null {
  if (row.requesterSessionId === sessionId && row.requesterUserId === viewerId) return "requester";
  if (row.targetSessionId === sessionId && row.targetUserId === viewerId) return "target";
  return null;
}

/**
 * Pure: may this consent show the two travellers to each other at `nowMs`? ACCEPTED, unexpired, and naming the
 * viewer on this session. Every other gate (blocks, liveness, sharing) is applied by the reader over it.
 */
export function consentShowsPair(row: ConsentRow, viewerId: string, sessionId: string, nowMs: number): boolean {
  return row.status === "accepted" && Date.parse(row.expiresAt) > nowMs && consentSide(row, viewerId, sessionId) !== null;
}

/** The transition ending a consent takes for this side, or null when nothing can be ended. */
export function endingTransition(row: ConsentRow, side: "requester" | "target"): ConsentStatus | null {
  if (row.status === "accepted") return "revoked";
  if (row.status === "requested") return side === "requester" ? "withdrawn" : "declined";
  return null;
}

export function normaliseHandle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const h = raw.trim().replace(/^@/, "").toLowerCase();
  return /^[a-z0-9_.]{1,64}$/.test(h) ? h : null;
}

function canon(city: string | null | undefined): string {
  return String(city ?? "").trim().toLowerCase();
}

/** Profile cards for these ids, names only per name visibility. A failed read is `null`. */
async function cardsFor(db: SupabaseClient, ids: string[]): Promise<DiscoveryCard[] | null> {
  if (ids.length === 0) return [];
  const { data, error } = await db.from("profiles").select("id, handle, name, avatar_url").in("id", ids);
  if (error) {
    logger.warn({ err: error.message }, "mutual discovery: profiles unreadable — no card is served");
    return null;
  }
  const named = await nameVisibilitySet(db, ids);
  const byId = new Map(((data ?? []) as any[]).map((p) => [String(p.id), p]));
  const out: DiscoveryCard[] = [];
  for (const id of ids) {
    const p = byId.get(id);
    if (!p) continue;
    out.push({ id, handle: p.handle ?? null, name: named.has(id) ? (p.name ?? null) : null, avatarUrl: p.avatar_url ?? null });
  }
  return out;
}

/** Of these sessions, the ones still live, owned by the user named for them, and not yet departed. */
async function liveSessions(
  db: SupabaseClient,
  want: Array<{ sessionId: string; userId: string }>,
  nowMs: number,
): Promise<Set<string> | null> {
  if (want.length === 0) return new Set();
  const { data, error } = await db
    .from("layover_sessions")
    .select("id, user_id, status, departure_time")
    .in("id", [...new Set(want.map((w) => w.sessionId))]);
  if (error) {
    logger.warn({ err: error.message }, "mutual discovery: sessions unreadable — nobody is shown");
    return null;
  }
  const owner = new Map(want.map((w) => [w.sessionId, w.userId]));
  const live = new Set<string>();
  for (const s of (data ?? []) as any[]) {
    const id = String(s.id);
    if (owner.get(id) !== String(s.user_id)) continue;
    if (!(LIVE as readonly string[]).includes(String(s.status))) continue;
    if (!(Date.parse(s.departure_time) > nowMs)) continue;
    live.add(id);
  }
  return live;
}

/**
 * The L2 roster for one viewer on one session: the travellers with whom an ACCEPTED, unexpired consent exists,
 * whose session is live, with no block either way, whose own sharing preference publishes them. Degraded (and
 * empty) when any read behind it fails. Flag off = empty, read nothing.
 */
export async function mutualDiscoveryRoster(
  db: SupabaseClient,
  args: { viewerId: string; sessionId: string; viewerSessionLive: boolean; nowMs: number },
): Promise<LayoverRead<MutualRoster>> {
  // No try/catch here on purpose: this function holds block reads, and `readBlockExclusions` never rejects (every
  // failure is `ok: false`, answered below as a refusal). A catch here would be a new place a thrown block read could
  // land (src/test/blockReadCatchGuard.test.ts).
  const refuse = (reason: string): LayoverRead<MutualRoster> => readDegraded<MutualRoster>({ ...EMPTY_ROSTER, travelers: [], visibleUserIds: [], consents: [] }, [reason]);
  {
    if (!(await mutualDiscoveryEnabled(db))) return readValue({ ...EMPTY_ROSTER, travelers: [], visibleUserIds: [], consents: [] });
    if (!args.viewerSessionLive) return readValue({ ...EMPTY_ROSTER, travelers: [], visibleUserIds: [], consents: [] });
    const nowIso = new Date(args.nowMs).toISOString();
    const { data, error } = await db
      .from("layover_discovery_consents")
      .select(COLS)
      .or(`requester_session_id.eq.${args.sessionId},target_session_id.eq.${args.sessionId}`)
      .eq("status", "accepted")
      .gt("expires_at", nowIso)
      .limit(100);
    if (error) {
      logger.warn({ err: error.message, sessionId: args.sessionId }, "mutual discovery: consents unreadable — nobody is shown, and the answer says so");
      return refuse("mutual_consents_unreadable");
    }
    const rows = ((data ?? []) as any[]).map(toConsent).filter((r) => consentShowsPair(r, args.viewerId, args.sessionId, args.nowMs));
    if (rows.length === 0) return readValue({ ...EMPTY_ROSTER, travelers: [], visibleUserIds: [], consents: [] });

    const others = rows.map((r) => (consentSide(r, args.viewerId, args.sessionId) === "requester"
      ? { consentId: r.id, userId: r.targetUserId, sessionId: r.targetSessionId, expiresAt: r.expiresAt }
      : { consentId: r.id, userId: r.requesterUserId, sessionId: r.requesterSessionId, expiresAt: r.expiresAt }));
    const live = await liveSessions(db, others, args.nowMs);
    if (!live) return refuse("presence_unreadable");
    const liveOthers = others.filter((o) => live.has(o.sessionId) && o.userId !== args.viewerId);
    if (liveOthers.length === 0) return readValue({ ...EMPTY_ROSTER, travelers: [], visibleUserIds: [], consents: [] });

    const ids = [...new Set(liveOthers.map((o) => o.userId))];
    const blocks = await readBlockExclusions(db, args.viewerId, { among: ids });
    if (!blocks.ok) return refuse("blocks_unreadable");
    const notBlocked = ids.filter((id) => !blocks.ids.has(id));
    const publishable = await publishableUserIds(db, notBlocked);
    if (publishable.kind === "degraded") return refuse("sharing_preferences_unreadable");
    const visible = publishable.value.allowed.slice(0, MUTUAL_ROSTER_MAX);
    if (visible.length === 0) return readValue({ ...EMPTY_ROSTER, travelers: [], visibleUserIds: [], consents: [] });
    const cards = await cardsFor(db, visible);
    if (!cards) return refuse("traveller_cards_unreadable");
    const shown = new Set(cards.map((c) => c.id));
    return readValue({
      count: cards.length,
      travelers: cards,
      visibleUserIds: cards.map((c) => c.id),
      consents: liveOthers.filter((o) => shown.has(o.userId)).map((o) => ({ consentId: o.consentId, userId: o.userId, expiresAt: o.expiresAt })),
    });
  }
}

/**
 * Does this viewer hold ANY live mutual consent (on any of their sessions)? For D-PRESENCE-K-3 rule 3: a viewer who
 * is shown people by name is withheld every count whole. Flag off = no roster, read nothing.
 */
export async function hasMutualDiscoveryRoster(
  db: SupabaseClient,
  viewerId: string,
  nowIso: string,
): Promise<{ ok: true; nonEmpty: boolean } | { ok: false }> {
  if (!(await mutualDiscoveryEnabled(db))) return { ok: true, nonEmpty: false };
  const { data, error } = await db
    .from("layover_discovery_consents")
    .select("id")
    .or(`requester_user_id.eq.${viewerId},target_user_id.eq.${viewerId}`)
    .eq("status", "accepted")
    .gt("expires_at", nowIso)
    .limit(1);
  if (error) {
    logger.warn({ err: error.message, viewerId }, "mutual discovery: consents unreadable — refusing rather than serving a count beside a roster");
    return { ok: false };
  }
  return { ok: true, nonEmpty: Array.isArray(data) && data.length > 0 };
}

export interface IncomingRequest {
  consentId: string;
  requestedAt: string;
  expiresAt: string;
  from: DiscoveryCard;
}

/** Requests waiting for this viewer's answer on this session, through blocks and the requester's sharing gate. */
export async function incomingDiscoveryRequests(
  db: SupabaseClient,
  args: { viewerId: string; sessionId: string; nowMs: number },
): Promise<LayoverRead<IncomingRequest[]>> {
  const refuse = (reason: string): LayoverRead<IncomingRequest[]> => readDegraded<IncomingRequest[]>([], [reason]);
  {
    if (!(await mutualDiscoveryEnabled(db))) return readValue([]);
    const { data, error } = await db
      .from("layover_discovery_consents")
      .select(COLS)
      .eq("target_session_id", args.sessionId)
      .eq("target_user_id", args.viewerId)
      .eq("status", "requested")
      .gt("expires_at", new Date(args.nowMs).toISOString())
      .order("requested_at", { ascending: false })
      .limit(50);
    if (error) {
      logger.warn({ err: error.message }, "mutual discovery: incoming requests unreadable");
      return refuse("mutual_consents_unreadable");
    }
    const rows = ((data ?? []) as any[]).map(toConsent);
    if (rows.length === 0) return readValue([]);
    const live = await liveSessions(db, rows.map((r) => ({ sessionId: r.requesterSessionId, userId: r.requesterUserId })), args.nowMs);
    if (!live) return refuse("presence_unreadable");
    const pending = rows.filter((r) => live.has(r.requesterSessionId));
    const ids = [...new Set(pending.map((r) => r.requesterUserId))];
    if (ids.length === 0) return readValue([]);
    const blocks = await readBlockExclusions(db, args.viewerId, { among: ids });
    if (!blocks.ok) return refuse("blocks_unreadable");
    const publishable = await publishableUserIds(db, ids.filter((id) => !blocks.ids.has(id)));
    if (publishable.kind === "degraded") return refuse("sharing_preferences_unreadable");
    const allowed = new Set(publishable.value.allowed);
    const cards = await cardsFor(db, [...allowed]);
    if (!cards) return refuse("traveller_cards_unreadable");
    const byId = new Map(cards.map((c) => [c.id, c]));
    return readValue(pending
      .filter((r) => byId.has(r.requesterUserId))
      .map((r) => ({ consentId: r.id, requestedAt: r.requestedAt, expiresAt: r.expiresAt, from: byId.get(r.requesterUserId)! })));
  }
}

export interface RequesterSession {
  id: string;
  userId: string;
  departureTime: string;
}

/** Internal outcome. The ROUTE answers the same words for every `stored: false` reason and for `stored: true`. */
export type DiscoveryRequestOutcome =
  | { ok: true; stored: boolean; accepted: boolean; reason: "stored" | "accepted_theirs" | "no_such_traveller" | "self" | "not_here" | "blocked" | "not_sharing" | "already" | "refused_by_store" }
  | { ok: false; reason: "disabled" | "read_failed" | "write_failed" };

/**
 * Ask to see one named traveller on this layover. See the header for what the requester is never told.
 * `city` is the requester's layover city as the presence surface resolves it.
 */
export async function requestMutualDiscovery(
  db: SupabaseClient,
  args: { requester: RequesterSession; city: string | null; targetHandle: string; nowMs: number },
): Promise<DiscoveryRequestOutcome> {
  if (!(await mutualDiscoveryEnabled(db))) return { ok: false, reason: "disabled" };
  const { requester, nowMs } = args;
  const nowIso = new Date(nowMs).toISOString();
  const { data: prof, error: profErr } = await db.from("profiles").select("id").eq("handle", args.targetHandle).limit(1);
  if (profErr) { logger.warn({ err: profErr.message }, "mutual discovery request: profile lookup failed"); return { ok: false, reason: "read_failed" }; }
  const targetId = ((prof ?? []) as any[])[0]?.id ? String(((prof ?? []) as any[])[0].id) : null;
  if (!targetId) return { ok: true, stored: false, accepted: false, reason: "no_such_traveller" };
  if (targetId === requester.userId) return { ok: true, stored: false, accepted: false, reason: "self" };
  const city = canon(args.city);
  if (!city || city === "unknown") return { ok: true, stored: false, accepted: false, reason: "not_here" };

  const { data: sessions, error: sErr } = await db
    .from("layover_sessions")
    .select("id, user_id, status, departure_time, share_city_status, trip_id, manual_city, airport_profiles(city)")
    .eq("user_id", targetId)
    .in("status", [...LIVE])
    .eq("share_city_status", true)
    .gt("departure_time", nowIso)
    .order("departure_time", { ascending: true })
    .limit(5);
  if (sErr) { logger.warn({ err: sErr.message }, "mutual discovery request: target sessions unreadable"); return { ok: false, reason: "read_failed" }; }
  const target = ((sessions ?? []) as any[]).find((s) => canon(s.airport_profiles?.city ?? s.manual_city) === city);
  if (!target) return { ok: true, stored: false, accepted: false, reason: "not_here" };

  const blocks = await readBlockExclusions(db, requester.userId, { among: [targetId] });
  if (!blocks.ok) return { ok: false, reason: "read_failed" };
  if (blocks.ids.has(targetId)) return { ok: true, stored: false, accepted: false, reason: "blocked" };
  const gate = discloseSharingGate(await evaluateSharingGate(db, { userId: targetId, tripId: target.trip_id ?? null }));
  if (gate.degraded) return { ok: false, reason: "read_failed" };
  if (!gate.allowed) return { ok: true, stored: false, accepted: false, reason: "not_sharing" };

  const a = requester.id;
  const b = String(target.id);
  const { data: existing, error: eErr } = await db
    .from("layover_discovery_consents")
    .select(COLS)
    .or(`and(requester_session_id.eq.${a},target_session_id.eq.${b}),and(requester_session_id.eq.${b},target_session_id.eq.${a})`)
    .in("status", ["requested", "accepted"])
    .limit(2);
  if (eErr) { logger.warn({ err: eErr.message }, "mutual discovery request: existing consents unreadable"); return { ok: false, reason: "read_failed" }; }
  const live = ((existing ?? []) as any[]).map(toConsent);
  const theirs = live.find((r) => r.status === "requested" && r.requesterSessionId === b && r.targetSessionId === a);
  if (theirs) {
    // Both people have now asked for exactly this pair: the second request IS the acceptance.
    const { data: upd, error: uErr } = await db
      .from("layover_discovery_consents")
      .update({ status: "accepted", responded_at: nowIso })
      .eq("id", theirs.id)
      .eq("status", "requested")
      .eq("target_user_id", requester.userId)
      .select("id");
    if (uErr) {
      if ((uErr as { code?: string }).code === "23514") return { ok: true, stored: false, accepted: false, reason: "refused_by_store" };
      logger.warn({ err: uErr.message }, "mutual discovery request: accepting the reverse request failed");
      return { ok: false, reason: "write_failed" };
    }
    return Array.isArray(upd) && upd.length === 1
      ? { ok: true, stored: true, accepted: true, reason: "accepted_theirs" }
      : { ok: true, stored: false, accepted: false, reason: "already" };
  }
  if (live.length > 0) return { ok: true, stored: false, accepted: false, reason: "already" };

  const expiresMs = Math.min(Date.parse(requester.departureTime), Date.parse(target.departure_time));
  if (!(expiresMs > nowMs)) return { ok: true, stored: false, accepted: false, reason: "not_here" };
  const { error: iErr } = await db.from("layover_discovery_consents").insert({
    requester_session_id: a,
    target_session_id: b,
    requester_user_id: requester.userId,
    target_user_id: targetId,
    status: "requested",
    expires_at: new Date(expiresMs).toISOString(),
  });
  if (iErr) {
    const code = (iErr as { code?: string }).code;
    if (code === "23505") return { ok: true, stored: false, accepted: false, reason: "already" };
    if (code === "23514") return { ok: true, stored: false, accepted: false, reason: "refused_by_store" };
    logger.warn({ err: iErr.message }, "mutual discovery request: insert failed");
    return { ok: false, reason: "write_failed" };
  }
  return { ok: true, stored: true, accepted: false, reason: "stored" };
}

export type ConsentAnswer = { ok: true; status: ConsentStatus } | { ok: false; reason: "disabled" | "not_found" | "refused" | "read_failed" | "write_failed" };

/** The TARGET answers a request made to them on this session. Nobody else can: the row must name them. */
export async function answerDiscoveryRequest(
  db: SupabaseClient,
  args: { viewerId: string; sessionId: string; consentId: string; accept: boolean; nowMs: number },
): Promise<ConsentAnswer> {
  if (!(await mutualDiscoveryEnabled(db))) return { ok: false, reason: "disabled" };
  const nowIso = new Date(args.nowMs).toISOString();
  if (args.accept) {
    // Blocks win before the write, as well as in 3875's guard (which refuses the acceptance if one exists).
    const { data: row, error: rErr } = await db.from("layover_discovery_consents").select(COLS).eq("id", args.consentId).limit(1);
    if (rErr) return { ok: false, reason: "read_failed" };
    const c = ((row ?? []) as any[])[0] ? toConsent(((row ?? []) as any[])[0]) : null;
    if (!c || consentSide(c, args.viewerId, args.sessionId) !== "target" || c.status !== "requested") return { ok: false, reason: "not_found" };
    const blocks = await readBlockExclusions(db, args.viewerId, { among: [c.requesterUserId] });
    if (!blocks.ok) return { ok: false, reason: "read_failed" };
    if (blocks.ids.has(c.requesterUserId)) return { ok: false, reason: "not_found" };
  }
  const patch = args.accept
    ? { status: "accepted", responded_at: nowIso }
    : { status: "declined", responded_at: nowIso, ended_at: nowIso, ended_by_user_id: args.viewerId };
  const { data, error } = await db
    .from("layover_discovery_consents")
    .update(patch)
    .eq("id", args.consentId)
    .eq("target_session_id", args.sessionId)
    .eq("target_user_id", args.viewerId)
    .eq("status", "requested")
    .gt("expires_at", nowIso)
    .select("id, status");
  if (error) {
    if ((error as { code?: string }).code === "23514") return { ok: false, reason: "refused" };
    logger.warn({ err: error.message }, "mutual discovery: answering a request failed");
    return { ok: false, reason: "write_failed" };
  }
  if (!Array.isArray(data) || data.length !== 1) return { ok: false, reason: "not_found" };
  return { ok: true, status: args.accept ? "accepted" : "declined" };
}

/**
 * Either party ends a consent on this session: accepted → revoked (either side), requested → withdrawn (the
 * requester) or declined (the target). Takes effect on the next read.
 */
export async function endDiscoveryConsent(
  db: SupabaseClient,
  args: { viewerId: string; sessionId: string; consentId: string; nowMs: number },
): Promise<ConsentAnswer> {
  if (!(await mutualDiscoveryEnabled(db))) return { ok: false, reason: "disabled" };
  const { data: row, error: rErr } = await db.from("layover_discovery_consents").select(COLS).eq("id", args.consentId).limit(1);
  if (rErr) { logger.warn({ err: rErr.message }, "mutual discovery: consent unreadable for revocation"); return { ok: false, reason: "read_failed" }; }
  const c = ((row ?? []) as any[])[0] ? toConsent(((row ?? []) as any[])[0]) : null;
  if (!c) return { ok: false, reason: "not_found" };
  const side = consentSide(c, args.viewerId, args.sessionId);
  if (!side) return { ok: false, reason: "not_found" };
  const next = endingTransition(c, side);
  if (!next) return { ok: false, reason: "not_found" };
  const nowIso = new Date(args.nowMs).toISOString();
  const patch: Record<string, unknown> = { status: next, ended_at: nowIso, ended_by_user_id: args.viewerId };
  if (next === "declined") patch.responded_at = nowIso;
  const { data, error } = await db
    .from("layover_discovery_consents")
    .update(patch)
    .eq("id", c.id)
    .eq("status", c.status)
    .select("id");
  if (error) {
    if ((error as { code?: string }).code === "23514") return { ok: false, reason: "refused" };
    logger.warn({ err: error.message }, "mutual discovery: ending a consent failed");
    return { ok: false, reason: "write_failed" };
  }
  if (!Array.isArray(data) || data.length !== 1) return { ok: false, reason: "not_found" };
  return { ok: true, status: next };
}

/**
 * The requester takes back whatever they asked of a handle on this session, without learning whether anything was
 * there: pending requests are withdrawn, accepted consents revoked. The route answers the same words either way.
 */
export async function withdrawDiscoveryByHandle(
  db: SupabaseClient,
  args: { viewerId: string; sessionId: string; targetHandle: string; nowMs: number },
): Promise<{ ok: true; ended: number } | { ok: false; reason: "disabled" | "read_failed" | "write_failed" }> {
  if (!(await mutualDiscoveryEnabled(db))) return { ok: false, reason: "disabled" };
  const { data: prof, error: profErr } = await db.from("profiles").select("id").eq("handle", args.targetHandle).limit(1);
  if (profErr) return { ok: false, reason: "read_failed" };
  const targetId = ((prof ?? []) as any[])[0]?.id ? String(((prof ?? []) as any[])[0].id) : null;
  if (!targetId) return { ok: true, ended: 0 };
  const { data, error } = await db
    .from("layover_discovery_consents")
    .select(COLS)
    .or(`and(requester_session_id.eq.${args.sessionId},target_user_id.eq.${targetId}),and(target_session_id.eq.${args.sessionId},requester_user_id.eq.${targetId})`)
    .in("status", ["requested", "accepted"])
    .limit(10);
  if (error) return { ok: false, reason: "read_failed" };
  let ended = 0;
  for (const r of ((data ?? []) as any[]).map(toConsent)) {
    const res = await endDiscoveryConsent(db, { viewerId: args.viewerId, sessionId: args.sessionId, consentId: r.id, nowMs: args.nowMs });
    if (res.ok) ended++;
    else if (res.reason === "write_failed" || res.reason === "read_failed") return { ok: false, reason: res.reason };
  }
  return { ok: true, ended };
}
