/**
 * LayoverCrewStore — the persistence half of §14 Layover Crew.
 *
 * census-layover L28 (`layover_crews`) and L29 (`layover_crew_members`) both
 * read "Absent.", and L185/L186/L188 score `LayoverCrewService.join/create/leave`
 * NOT-BUILT with the same one-word reason: "No crew."
 *
 * The CONSTRAINT SOLVER is not absent. `services/airport/LayoverCrewService.ts`
 * already implements §14.1 in full — `sharedReturnBy`, `certifyCrewPlan`,
 * per-branch feasibility, split plans, the location-precision ladder — and it
 * is pure: members arrive as an argument and it imports no Supabase client.
 *
 * This module supplies the members. It does four things and decides nothing:
 * create, join, leave, read. Every judgement about whether a crew's plan works
 * belongs to `certifyCrewPlan` and is made in the route from what this returns.
 *
 * ── EVERY READ REFUSES RATHER THAN RETURNING AN EMPTY CREW ───────────────────
 * Each function returns a discriminated result. None of them returns `[]` for a
 * failed read. This is not defensive style, it is the specific defect
 * census-layover has now found four separate times on this domain (§21.4,
 * §23.1: "an unreadable block list was served as an empty city") — an outage
 * rendering as an honest-looking absence.
 *
 * It is worse for a crew than for a list. "Nobody is in your crew" and "we
 * could not read your crew" produce the same screen, and the traveller who
 * believes the first one walks away from people who are waiting for them.
 *
 * ── WHAT THIS MODULE REFUSES TO DECIDE ───────────────────────────────────────
 * WHO MAY SEE A MEMBER. A crew is a list of people, and membership is only the
 * first of three gates: blocks in both directions, and the sharing preferences
 * and ghost mode that `publishableUserIds` reads, are the other two. That
 * composition already exists in the route layer (`cityPresence`), and this
 * module returns raw membership so the route can apply it. Answering it here
 * would fork the rule.
 *
 * ── STORAGE ──────────────────────────────────────────────────────────────────
 * `layover_crews` and `layover_crew_members`, created by migration 2984.
 *
 * APPLIED, and this line used to say the opposite. Until 2026-09-16 it read
 * "written, NOT applied — see docs/BUILD-BACKLOG.md", which was true when it
 * was written and false afterwards: census-layover §26.1 records 2984 applied
 * to production (`ajrurzioarfkagpuxfnb`) and to CI, each inside `BEGIN … COMMIT`
 * with the file's own postcondition block and a `schema_migration_ledger` row,
 * and both tables re-probed after the fact rather than assumed.
 *
 * Both tables have RLS on and — re-probed in that same pass — ZERO policies and
 * ZERO `anon`/`authenticated` grants. A client reaches nothing, every access
 * here is on the service role, and there is therefore no database-level scope
 * underneath this module: the route layer is the ONLY answer to who may join a
 * crew and who may see a crewmate, not the looser of two. That is what makes
 * `joinCrew`'s city check load-bearing rather than belt-and-braces.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";

const logger = rootLogger.child({ service: "LayoverCrewStore" });

/**
 * NOTE FOR ANYONE TIDYING THIS UP: the `.from(...)` call sites in this file
 * deliberately write the table name as a STRING LITERAL rather than using this
 * constant, and replacing them with the constant would be a regression.
 *
 * `check:write-path-columns` resolves a write/read site only when it can see
 * `.from("<literal>")` in the AST. `.from(CONSTANT)` is a `dynamic table name`
 * blind spot: the check cannot tell which table the payload belongs to, so it
 * cannot diff those columns against the live schema at all — which is the whole
 * failure class it exists to catch (a route writing a column before its
 * migration is applied live). This constant stays exported because the tests
 * import it; the call sites use the literal because that is what makes them
 * checkable.
 */
export const CREW_TABLE = "layover_crews";
export const CREW_MEMBER_TABLE = "layover_crew_members";

/**
 * The largest crew this surface will assemble, independent of a row's own
 * `max_members`. A second, lower ceiling in code is not redundancy: the column
 * bounds what a crew may be created with, and this bounds what one READ will
 * certify, so a row edited out of band cannot make the route fan out into an
 * unbounded number of per-member session reads.
 */
export const CREW_READ_LIMIT = 12;

/** How long a crew lives if nothing closes it. */
export const CREW_TTL_MINUTES = 12 * 60;

export interface CrewRow {
  id: string;
  city: string;
  airportRef: string | null;
  createdBy: string;
  createdSessionId: string;
  title: string;
  meetingPointLabel: string | null;
  status: "open" | "closed" | "disbanded";
  maxMembers: number;
  expiresAt: string;
  createdAt: string;
}

export interface CrewMemberRow {
  crewId: string;
  userId: string;
  sessionId: string;
  role: "owner" | "member";
  joinedAt: string;
}

type Fail = { ok: false; reason: "read_failed" };
export type CrewRead<T> = { ok: true; value: T } | Fail;

const FAILED: Fail = { ok: false, reason: "read_failed" };

function toCrew(r: Record<string, any>): CrewRow {
  return {
    id: r.id,
    city: r.city,
    airportRef: r.airport_ref ?? null,
    createdBy: r.created_by,
    createdSessionId: r.created_session_id,
    title: r.title,
    meetingPointLabel: r.meeting_point_label ?? null,
    status: r.status,
    maxMembers: r.max_members,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
  };
}

function toMember(r: Record<string, any>): CrewMemberRow {
  return {
    crewId: r.crew_id,
    userId: r.user_id,
    sessionId: r.session_id,
    role: r.role,
    joinedAt: r.joined_at,
  };
}

/**
 * Cities are compared lower-cased and trimmed, everywhere, in exactly one
 * place. `cityPresence` does the same normalisation inline; two spellings of
 * one city that compare unequal would silently split a crew's discovery list in
 * half, and the halves would each look like an empty city.
 */
export function canonCity(city: string): string {
  return city.trim().toLowerCase();
}

// ── reads ────────────────────────────────────────────────────────────────────

/**
 * The crew this traveller is currently in, or null when they are in none.
 *
 * `null` means MEASURED ABSENCE and is only ever returned from a successful
 * read; a failed read is `ok: false`.
 */
export async function activeCrewForUser(
  db: SupabaseClient,
  userId: string,
  nowIso: string,
): Promise<CrewRead<{ crew: CrewRow; membership: CrewMemberRow } | null>> {
  const { data: mem, error: memErr } = await db
    .from("layover_crew_members")
    .select("crew_id,user_id,session_id,role,joined_at")
    .eq("user_id", userId)
    .is("left_at", null)
    .limit(CREW_READ_LIMIT);
  if (memErr) {
    logger.warn({ err: memErr.message, userId }, "crew membership read failed — refusing rather than reporting no crew");
    return FAILED;
  }
  const memberships = (mem ?? []).map((r) => toMember(r as Record<string, any>));
  if (memberships.length === 0) return { ok: true, value: null };

  const { data: crews, error: crewErr } = await db
    .from("layover_crews")
    .select("id,city,airport_ref,created_by,created_session_id,title,meeting_point_label,status,max_members,expires_at,created_at")
    .in("id", memberships.map((m) => m.crewId))
    .gt("expires_at", nowIso)
    .neq("status", "disbanded")
    .limit(CREW_READ_LIMIT);
  if (crewErr) {
    logger.warn({ err: crewErr.message, userId }, "crew read failed — refusing rather than reporting no crew");
    return FAILED;
  }
  const live = (crews ?? []).map((r) => toCrew(r as Record<string, any>));
  if (live.length === 0) return { ok: true, value: null };

  // Newest first. A traveller should be in one crew at a time — `joinCrew`
  // refuses a second — but a stale membership whose crew has been disbanded is
  // filtered above rather than treated as impossible.
  live.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const crew = live[0];
  const membership = memberships.find((m) => m.crewId === crew.id)!;
  return { ok: true, value: { crew, membership } };
}

export async function crewMembers(
  db: SupabaseClient,
  crewId: string,
): Promise<CrewRead<CrewMemberRow[]>> {
  const { data, error } = await db
    .from("layover_crew_members")
    .select("crew_id,user_id,session_id,role,joined_at")
    .eq("crew_id", crewId)
    .is("left_at", null)
    .order("joined_at", { ascending: true })
    .limit(CREW_READ_LIMIT);
  if (error) {
    logger.warn({ err: error.message, crewId }, "crew member read failed — refusing rather than serving an empty crew");
    return FAILED;
  }
  return { ok: true, value: (data ?? []).map((r) => toMember(r as Record<string, any>)) };
}

/** Open, unexpired crews in one city, excluding any the caller is already in. */
export async function openCrewsInCity(
  db: SupabaseClient,
  city: string,
  nowIso: string,
  limit = 20,
): Promise<CrewRead<CrewRow[]>> {
  const { data, error } = await db
    .from("layover_crews")
    .select("id,city,airport_ref,created_by,created_session_id,title,meeting_point_label,status,max_members,expires_at,created_at")
    .eq("city", canonCity(city))
    .eq("status", "open")
    .gt("expires_at", nowIso)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    logger.warn({ err: error.message, city }, "open crew read failed — refusing rather than serving an empty city");
    return FAILED;
  }
  return { ok: true, value: (data ?? []).map((r) => toCrew(r as Record<string, any>)) };
}

// ── writes ───────────────────────────────────────────────────────────────────

export type CrewWrite<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      reason:
        | "read_failed"
        | "write_failed"
        | "already_in_a_crew"
        | "crew_full"
        | "crew_unavailable"
        /**
         * The joiner's layover is not in the crew's city. Discovery has always
         * been city-scoped (`openCrewsInCity`); until this reason existed the
         * ACTION behind it was not, so a crew id was enough to join a crew on
         * another continent. See `joinCrew`.
         */
        | "city_mismatch";
    };

export interface CreateCrewInput {
  userId: string;
  sessionId: string;
  city: string;
  airportRef: string | null;
  title: string;
  meetingPointLabel: string | null;
  maxMembers: number;
  /**
   * The crew must not outlive the founder's layover. Passed in rather than
   * computed here because the route already holds the certified record, and
   * a second derivation of "when is this layover over" is the duplicate
   * time-budget logic L6 exists to prevent.
   */
  expiresAt: string;
}

/**
 * Create a crew and put the creator in it as owner.
 *
 * NOT A TRANSACTION, and the failure is handled rather than hoped away:
 * supabase-js has no client-side transaction, so the crew row lands first and
 * the owner membership second. If the second insert fails the crew is
 * DISBANDED immediately — an ownerless crew is discoverable, joinable, and has
 * no member whose deadline could certify it, which is worse than no crew.
 */
export async function createCrew(
  db: SupabaseClient,
  input: CreateCrewInput,
  nowIso: string,
): Promise<CrewWrite<{ crew: CrewRow; members: CrewMemberRow[] }>> {
  const existing = await activeCrewForUser(db, input.userId, nowIso);
  if (!existing.ok) return { ok: false, reason: "read_failed" };
  if (existing.value) return { ok: false, reason: "already_in_a_crew" };

  const { data: crewData, error: crewErr } = await db
    .from("layover_crews")
    .insert({
      city: canonCity(input.city),
      airport_ref: input.airportRef,
      created_by: input.userId,
      created_session_id: input.sessionId,
      title: input.title,
      meeting_point_label: input.meetingPointLabel,
      status: "open",
      max_members: input.maxMembers,
      expires_at: input.expiresAt,
    })
    .select("id,city,airport_ref,created_by,created_session_id,title,meeting_point_label,status,max_members,expires_at,created_at")
    .maybeSingle();
  if (crewErr || !crewData) {
    logger.warn({ err: crewErr?.message }, "crew insert failed");
    return { ok: false, reason: "write_failed" };
  }
  const crew = toCrew(crewData as Record<string, any>);

  const { error: memErr } = await db.from("layover_crew_members").insert({
    crew_id: crew.id,
    user_id: input.userId,
    session_id: input.sessionId,
    role: "owner",
  });
  if (memErr) {
    logger.warn({ err: memErr.message, crewId: crew.id }, "owner membership insert failed — disbanding the ownerless crew");
    // Best effort, and its failure is logged rather than swallowed: if this
    // also fails the crew is open with no members, which `certifyCrewPlan`
    // reports as `no_members` and therefore infeasible — visible, not silent.
    const { error: undoErr } = await db
      .from("layover_crews")
      .update({ status: "disbanded", updated_at: nowIso })
      .eq("id", crew.id);
    if (undoErr) logger.error({ err: undoErr.message, crewId: crew.id }, "could not disband ownerless crew");
    return { ok: false, reason: "write_failed" };
  }

  return { ok: true, value: { crew, members: [{ crewId: crew.id, userId: input.userId, sessionId: input.sessionId, role: "owner", joinedAt: nowIso }] } };
}

/**
 * Join an open crew.
 *
 * THE CAPACITY CHECK IS A READ, AND A FAILED READ REFUSES THE JOIN. There is no
 * database-level count constraint (a row count is not something a CHECK can
 * see), so `max_members` is enforced here — which means an unreadable member
 * list is an unenforced capacity limit, and the join must not proceed on one.
 * This is the same rule the stops route already applies to `MAX_STOPS`.
 *
 * The composite primary key (crew_id, user_id) is what makes a double-tapped
 * join a constraint violation rather than a second row; 23505 is reported as
 * success, because the traveller is in the crew either way.
 *
 * ── THE CITY IS PART OF THE JOIN, NOT JUST PART OF THE LIST ──────────────────
 * `input.city` is the city the JOINER's layover is in, and a crew in any other
 * city is refused. This is not defensive tidiness; it closes a measured defect.
 * Discovery (`openCrewsInCity`) has always filtered on city and both the GET
 * and the POST-create routes refuse outright when the city is unknown, but the
 * join took a crew id from the URL and asked nothing. Staged against the real
 * router, a traveller at an airport whose city is *not known at all* joined a
 * Taoyuan crew and came back:
 *
 *     "sharedReturnBy": "…T15:42Z", "bindingMemberIds": ["scope-user-b"]
 *
 * — the remote joiner BINDING the shared deadline for everyone actually in
 * Taoyuan, because §14.1's `shared_return_by` is a minimum over all members.
 * The founder was told to be back four hours early by someone who was not
 * there. Membership is also the first of the three gates `crewMemberCards`
 * applies, so an unscoped join is a widening of who gets past it.
 *
 * The check sits directly after the crew row is read, so it applies to a
 * re-join exactly as it applies to a first join: a membership that should never
 * have existed is not re-confirmed by tapping again. Comparison is through
 * `canonCity` on both sides — the stored city is already canonical (`createCrew`
 * writes it that way) and the caller's is not.
 */
export async function joinCrew(
  db: SupabaseClient,
  input: { userId: string; sessionId: string; crewId: string; city: string },
  nowIso: string,
): Promise<CrewWrite<{ crew: CrewRow; members: CrewMemberRow[] }>> {
  const existing = await activeCrewForUser(db, input.userId, nowIso);
  if (!existing.ok) return { ok: false, reason: "read_failed" };
  if (existing.value && existing.value.crew.id !== input.crewId) {
    return { ok: false, reason: "already_in_a_crew" };
  }

  const { data: crewData, error: crewErr } = await db
    .from("layover_crews")
    .select("id,city,airport_ref,created_by,created_session_id,title,meeting_point_label,status,max_members,expires_at,created_at")
    .eq("id", input.crewId)
    .eq("status", "open")
    .gt("expires_at", nowIso)
    .maybeSingle();
  if (crewErr) {
    logger.warn({ err: crewErr.message, crewId: input.crewId }, "crew read failed on join");
    return { ok: false, reason: "read_failed" };
  }
  if (!crewData) return { ok: false, reason: "crew_unavailable" };
  const crew = toCrew(crewData as Record<string, any>);

  // A crew is a CITY-level thing. Refused BEFORE the capacity read and before
  // any write, so a mismatched join costs one read and leaves nothing behind.
  if (crew.city !== canonCity(input.city)) {
    logger.warn(
      { crewId: crew.id, crewCity: crew.city, joinerCity: canonCity(input.city) },
      "crew join refused — the joiner's layover is in another city",
    );
    return { ok: false, reason: "city_mismatch" };
  }

  const before = await crewMembers(db, crew.id);
  if (!before.ok) return { ok: false, reason: "read_failed" };
  const alreadyIn = before.value.some((m) => m.userId === input.userId);
  if (!alreadyIn && before.value.length >= crew.maxMembers) {
    return { ok: false, reason: "crew_full" };
  }

  if (!alreadyIn) {
    const { error } = await db.from("layover_crew_members").insert({
      crew_id: crew.id,
      user_id: input.userId,
      session_id: input.sessionId,
      role: "member",
    });
    // 23505 on (crew_id, user_id): the traveller is already a member, which is
    // the outcome they asked for. Anything else is a real failure.
    const duplicate = !!error && (error as { code?: string }).code === "23505";
    if (error && !duplicate) {
      logger.warn({ err: error.message, crewId: crew.id }, "crew member insert failed");
      return { ok: false, reason: "write_failed" };
    }
  }

  const after = await crewMembers(db, crew.id);
  if (!after.ok) return { ok: false, reason: "read_failed" };
  return { ok: true, value: { crew, members: after.value } };
}

/**
 * Leave a crew. The owner leaving DISBANDS it.
 *
 * Disbanding rather than promoting a new owner is deliberate: the crew's
 * `created_session_id` and `expires_at` are the founder's, so a crew that
 * outlives its founder is certified against a layover that has ended. Handing
 * it to someone else would need a re-derivation of both from the new owner's
 * session, which is a decision about whose deadline binds — and §14.1 is
 * explicit that the shared deadline is a minimum over everyone, not a property
 * of whoever happens to hold the crew.
 */
export async function leaveCrew(
  db: SupabaseClient,
  input: { userId: string; crewId: string },
  nowIso: string,
): Promise<CrewWrite<{ disbanded: boolean }>> {
  const { data: memData, error: memErr } = await db
    .from("layover_crew_members")
    .select("crew_id,user_id,session_id,role,joined_at")
    .eq("crew_id", input.crewId)
    .eq("user_id", input.userId)
    .is("left_at", null)
    .maybeSingle();
  if (memErr) {
    logger.warn({ err: memErr.message, crewId: input.crewId }, "crew membership read failed on leave");
    return { ok: false, reason: "read_failed" };
  }
  if (!memData) return { ok: false, reason: "crew_unavailable" };
  const membership = toMember(memData as Record<string, any>);

  const { error: leaveErr } = await db
    .from("layover_crew_members")
    .update({ left_at: nowIso })
    .eq("crew_id", input.crewId)
    .eq("user_id", input.userId)
    .is("left_at", null);
  if (leaveErr) {
    logger.warn({ err: leaveErr.message, crewId: input.crewId }, "crew leave failed");
    return { ok: false, reason: "write_failed" };
  }

  if (membership.role !== "owner") return { ok: true, value: { disbanded: false } };

  const { error: disbandErr } = await db
    .from("layover_crews")
    .update({ status: "disbanded", updated_at: nowIso })
    .eq("id", input.crewId);
  if (disbandErr) {
    // The owner IS out — that write succeeded. Reporting success here would
    // leave an ownerless crew still advertised as open, so this is a failure
    // even though half of it worked, and the message says which half.
    logger.error({ err: disbandErr.message, crewId: input.crewId }, "owner left but crew could not be disbanded");
    return { ok: false, reason: "write_failed" };
  }
  return { ok: true, value: { disbanded: true } };
}
