/**
 * Telegraph §30A.6 — the COORDINATION notification cause (census-telegraph T395),
 * with §30A.6's causal-event identity (T397).
 *
 * Spec §30A.6: "Define notification causes including MESSAGE, MENTION,
 * PLAN_CHANGED, INVITATION, COORDINATION, LOCATION, CALL, and SAFETY." and
 * §19: "P1 Coordination — Meetup moved, pickup, return state — Immediate/high
 * priority."
 *
 * ── WHAT WAS MISSING ────────────────────────────────────────────────────────
 * Seven of the eight causes had a notification; COORDINATION had none. The
 * cause was named in the thread policy (`NOTIFICATION_CAUSES`), but no template
 * and no producer existed, so a member who opened a coordination session or
 * said "on my way" told nobody who was not looking at the thread.
 *
 * ── WHAT THIS PRODUCES ──────────────────────────────────────────────────────
 * One notification (`telegraph.coordination`, P1 in the attention ladder) per
 * other active member, for two acts on POST /threads/:id/coordination:
 *   - a coordination session opened (`SESSION_STARTED`), and
 *   - a §9.1 quick state declared (ON_MY_WAY, ARRIVED, RUNNING_LATE,
 *     CANT_MAKE_IT, START_WITHOUT_ME, HEADING_BACK).
 * NEED_HELP is NOT this cause: it is SAFETY (§30A.6, §19 P0), and filing it as
 * coordination would let a thread mute silence it. It is not produced here.
 * Transitions, votes, decisions and the rest are not "pickup, return state" and
 * are not produced either: §19 names three examples and this cause takes the two
 * a conversation itself states.
 *
 * ── WHO IS TOLD, IN ORDER — and every unknown tells NOBODY ──────────────────
 *   1. The conversation's other ACTIVE members (a failed roster read: nobody).
 *   2. Minus anyone in a block with the actor, either direction
 *      (`readBlockExclusions`; an unreadable blocks table: nobody).
 *   3. Minus anyone whose thread choice excludes COORDINATION —
 *      `decideThreadNotification`, the same decision the mention path takes
 *      (MUTED, a temporary mute, MENTIONS-only). A failed read: nobody.
 * Then the ordinary pipeline: NotificationService.create (dedupe, privacy
 * guard, persist) and NotificationRouter.route (preferences, push).
 *
 * ── WHAT A LOCK SCREEN CAN SAY ──────────────────────────────────────────────
 * Fixed words per act (`COORDINATION_ACT_PHRASES`) — never the sender's note or
 * approximate label. The actor is their shown name only when they show their
 * real name (`profile_privacy_settings.show_real_name`), else their @handle,
 * else "Someone".
 *
 * ── DEDUPE ──────────────────────────────────────────────────────────────────
 * The source is (thread, actor, act), so a double-tap inside P1's 60-second
 * window is one notification while a CHANGE of state, or another member's
 * state, is not swallowed. The causal identity is the message that records the
 * act (`MESSAGE:<id>`, `causalEventIdOf`): any other producer that reports the
 * same act to the same person with that id is a duplicate (T397).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { isExcluded, readBlockExclusions } from "../../lib/exclusionSet.js";
import { nameVisibleFor, presentedName } from "../../lib/publicIdentity.js";
import { decideThreadNotification } from "../../domain/telegraph/policies/threadNotificationPolicy.js";
import { NO_THREAD_CHOICE, readThreadNotificationStates } from "./threadNotificationState.js";
import type { CreateNotificationInput, NotificationRow } from "../notifications/NotificationService.js";
import { causalEventIdOf } from "../notifications/NotificationDeduplicationService.js";

export const COORDINATION_NOTIFICATION_EVENT = "telegraph.coordination" as const;
export const COORDINATION_NOTIFICATION_SOURCE = "telegraph_coordination" as const;

/** The words each act puts on a lock screen. Closed: nothing the sender typed. */
export const COORDINATION_ACT_PHRASES = {
  SESSION_STARTED: "started coordinating",
  ON_MY_WAY: "is on the way",
  ARRIVED: "has arrived",
  RUNNING_LATE: "is running late",
  CANT_MAKE_IT: "can't make it",
  START_WITHOUT_ME: "says to start without them",
  HEADING_BACK: "is heading back",
} as const;
export type CoordinationAct = keyof typeof COORDINATION_ACT_PHRASES;

/** The act a coordination write is, or null when this cause does not report it. */
export function coordinationActOf(kind: string, payload: unknown): CoordinationAct | null {
  if (kind === "COORDINATION_SESSION") return "SESSION_STARTED";
  if (kind !== "COORDINATION") return null;
  const state = payload && typeof payload === "object" ? (payload as { state?: unknown }).state : undefined;
  if (typeof state !== "string" || state === "NEED_HELP" || state === "SESSION_STARTED") return null;
  return Object.prototype.hasOwnProperty.call(COORDINATION_ACT_PHRASES, state) ? (state as CoordinationAct) : null;
}

export interface CoordinationNotifyDeps {
  create(input: CreateNotificationInput): Promise<NotificationRow | null>;
  route(row: NotificationRow): Promise<void>;
}

export type CoordinationNotifyOutcome =
  | { readonly status: "notified"; readonly notified: string[]; readonly withheld: Array<{ userId: string; reason: string }> }
  | { readonly status: "refused"; readonly stage: "roster" | "blocks" | "thread_policy" | "threw" };

export interface CoordinationNotifyLog {
  warn(obj: object, msg: string): void;
}

async function defaultDeps(sc: SupabaseClient): Promise<CoordinationNotifyDeps> {
  const { NotificationService } = await import("../notifications/NotificationService.js");
  const { NotificationRouter } = await import("../notifications/NotificationRouter.js");
  const ns = new NotificationService(sc);
  const nr = new NotificationRouter(sc);
  return { create: (input) => ns.create(input), route: (row) => nr.route(row) };
}

/** The actor as a lock screen may name them. A failed read names nobody. */
async function actorLabel(sc: SupabaseClient, actorId: string): Promise<string> {
  const { data, error } = await sc.from("profiles").select("handle, username, display_name, name").eq("id", actorId).maybeSingle();
  if (error || !data) return "Someone";
  const row = data as { handle?: string | null; username?: string | null; display_name?: string | null; name?: string | null };
  const shown = presentedName(row, await nameVisibleFor(sc, actorId));
  if (shown) return shown;
  const handle = typeof row.handle === "string" && row.handle.length > 0 ? row.handle : (typeof row.username === "string" && row.username.length > 0 ? row.username : null);
  return handle ? `@${handle}` : "Someone";
}

export interface CoordinationNotifyInput { threadId: string; actorId: string; act: CoordinationAct; messageId: string; nowMs: number }

/**
 * Tell the conversation's other members about one coordination act. NEVER
 * rejects — the route fires it without awaiting, after the write has answered —
 * and a failure at any gate tells nobody and says which gate.
 */
export async function notifyCoordinationAct(
  sc: SupabaseClient,
  input: CoordinationNotifyInput,
  opts: { deps?: CoordinationNotifyDeps; log?: CoordinationNotifyLog } = {},
): Promise<CoordinationNotifyOutcome> {
  try {
    return await tellMembers(sc, input, opts);
  } catch (err) {
    opts.log?.warn({ err, threadId: input.threadId, act: input.act }, "coordination notification threw before anyone was told (the act itself was written)");
    return { status: "refused", stage: "threw" };
  }
}

async function tellMembers(
  sc: SupabaseClient,
  input: CoordinationNotifyInput,
  opts: { deps?: CoordinationNotifyDeps; log?: CoordinationNotifyLog },
): Promise<CoordinationNotifyOutcome> {
  const { threadId, actorId, act, messageId, nowMs } = input;

  // 1. The other active members.
  const { data: roster, error: rosterErr } = await sc
    .from("message_thread_members")
    .select("user_id")
    .eq("thread_id", threadId)
    .is("left_at", null)
    .neq("user_id", actorId);
  if (rosterErr || !Array.isArray(roster)) return { status: "refused", stage: "roster" };
  const others = [...new Set((roster as Array<{ user_id: unknown }>).map((r) => String(r.user_id)).filter((id) => id.length > 0 && id !== actorId))];
  if (others.length === 0) return { status: "notified", notified: [], withheld: [] };

  // 2. Nobody in a block with the actor, either way. Unknown block state tells nobody.
  const blocks = await readBlockExclusions(sc, actorId, { among: others });
  if (!blocks.ok) return { status: "refused", stage: "blocks" };
  const withheld: Array<{ userId: string; reason: string }> = [];
  const unblocked = others.filter((id) => {
    if (!isExcluded(blocks, id)) return true;
    withheld.push({ userId: id, reason: "blocked" });
    return false;
  });

  // 3. Each member's thread choice, for the COORDINATION cause.
  const states = await readThreadNotificationStates(sc, threadId, unblocked);
  if (!states.ok) return { status: "refused", stage: "thread_policy" };
  const deliverTo = unblocked.filter((id) => {
    const decision = decideThreadNotification({ cause: "COORDINATION", state: states.states.get(id) ?? NO_THREAD_CHOICE, nowMs });
    if (!decision.deliver) withheld.push({ userId: id, reason: decision.reason });
    return decision.deliver;
  });
  if (deliverTo.length === 0) return { status: "notified", notified: [], withheld };

  const actor = await actorLabel(sc, actorId);
  const deps = opts.deps ?? (await defaultDeps(sc));
  const causalEventId = causalEventIdOf({ objectType: "MESSAGE", objectId: messageId }) ?? undefined;
  const notified: string[] = [];
  await Promise.all(deliverTo.map(async (userId) => {
    try {
      const row = await deps.create({
        userId,
        eventType: COORDINATION_NOTIFICATION_EVENT,
        actorId,
        senderId: actorId,
        sourceType: COORDINATION_NOTIFICATION_SOURCE,
        sourceId: `${threadId}:${actorId}:${act}`,
        params: { actor, act: COORDINATION_ACT_PHRASES[act], threadId },
        ...(causalEventId ? { causalEventId } : {}),
      });
      if (!row) { withheld.push({ userId, reason: "not_created" }); return; }
      notified.push(userId);
      await deps.route(row);
    } catch (err) {
      opts.log?.warn({ err, threadId, act }, "coordination notification failed for one member (the act itself was written)");
    }
  }));
  return { status: "notified", notified, withheld };
}
