/**
 * Telegraph §14.3 / §30A.4 — adding people to a DM creates a NEW group.
 *
 * Spec §14.3: "Adding a third person to a DM creates a new group; it does not
 * expose the old DM history. Explicitly selected Plans/Places may be carried
 * forward as new share objects." §30A.4: "never exposes prior DM history by
 * default."
 *
 * ── WHAT THIS EXECUTES, AND ONLY THIS ──────────────────────────────────────
 * `planGroupFormation` (domain/telegraph/invariants/groupFormationInvariants.ts)
 * decides the plan; this module checks who may be in it, checks what may be
 * carried, and writes it. The plan has no field that could name a DM message,
 * so the writes below cannot copy, move or point at one:
 *
 *   1. a NEW `message_threads` row, `thread_type = 'group'` (migration 3660);
 *   2. NEW `message_thread_members` rows for the DM's two people plus the added
 *      people, every one joined at the formation instant;
 *   3. for each explicitly selected Plan / Place, a NEW PORTAVA_OBJECT message
 *      naming the CANONICAL object — written through the shared send guard,
 *      exactly as POST /threads/:id/share writes one.
 *
 * The source DM is READ (its type and its two members) and never written. The
 * group records nothing about which DM it came from.
 *
 * ── WHO MAY BE ADDED (lead ruling T-GRP-6) ─────────────────────────────────
 *   - the actor must be an ACTIVE member of a two-party `direct` thread whose
 *     other party is also still active;
 *   - the actor's OWN messaging restriction refuses first, in its own sentence
 *     (OD-TRUST-5; D-24 names "start new conversations");
 *   - EVERY PAIR in the new roster is checked through the permission engine,
 *     fail-closed: actor → each added person and the DM partner → each added
 *     person and each added person → each other must allow a DIRECT message
 *     (blocks either way, account state, Trust restriction — so the partner's
 *     own D-24 state is consulted — and the request door); actor ↔ partner must
 *     have no block and the partner's account must be live. `isBlockedBetween`
 *     then re-reads the blocks table over every pair. Any failure refuses the
 *     WHOLE formation with ONE sentence that does not say which pair or why.
 *
 * ── WHAT MAY BE CARRIED FORWARD (T213) ─────────────────────────────────────
 * Only PLAN and PLACE (§14.3 names exactly two), de-duplicated. Each selected object must be
 * currently visible to the ACTOR (you may only share what you can open — the
 * POST /share rule) AND to EVERY member of the new group, by the object's own
 * loader (services/telegraph/shareables.ts), at formation time. An object some
 * member cannot see is refused rather than carried as a card that member would
 * see as "unavailable": the card itself would disclose that the object exists.
 * A Plan any member DECLINED is refused too (the loader would show it).
 * Any load failure refuses (fail closed). Recipients' projections are still
 * re-derived per viewer at read time by POST /share-projections.
 *
 * ── ATOMICITY ──────────────────────────────────────────────────────────────
 * Every check runs before the first write. A write that fails after the thread
 * row exists deletes that thread (members and messages cascade — FK ON DELETE
 * CASCADE), so a refused formation leaves nothing behind.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { planGroupFormation, type CarryForwardSelection, type GroupFormationPlan } from "../../domain/telegraph/invariants/groupFormationInvariants.js";
import { isBlockedBetween } from "../../lib/blockGuard.js";
import { isKillSwitchEngaged, readFlagState } from "../../lib/featureFlags.js";
import { guardTelegraphThreadWrite, messagingStopUnknownRefusal } from "../../lib/telegraphThreadWrite.js";
import { resolveInteractionPermissions } from "../interactionPermissions.js";
import { getRestrictionState } from "../trust/TrustRestrictionService.js";
import { restrictionSentence } from "../trust/TrustPrivacyGuard.js";
import { logger as rootLogger } from "../../lib/logger.js";
import { buildPortavaObjectBody, shareableFor } from "./shareables.js";
import { msgTypeOf } from "./vocabulary.js";

export const DM_GROUP_FORMATION_FLAG = "telegraph_dm_group_formation_enabled";

/** The most people one formation may add. A group is not a broadcast list. */
export const MAX_ADDED_PEOPLE = 10;
/** The most objects one formation may carry forward. */
export const MAX_CARRY_FORWARD = 10;
export const MAX_GROUP_TITLE = 80;

/** The ONE sentence for every "this person cannot be in this group" refusal. */
export const CANNOT_ADD_MESSAGE = "One or more of these people can't be added to a group with you.";
export const CARRY_FORWARD_REFUSED_MESSAGE =
  "One or more of the selected plans or places can't be shared with everyone in this group.";
const RETRY_MESSAGE = "We could not set up this group right now. Please try again shortly.";

export type GroupFormationRefusalCode =
  | "feature_disabled"
  | "degraded_unavailable"
  | "forbidden"
  | "not_found"
  | "invalid_payload"
  | "db_error";

export type GroupFormationOutcome =
  | { ok: true; threadId: string; memberUserIds: string[]; carriedForward: Array<{ kind: "PLAN" | "PLACE"; objectId: string; messageId: string }>; inboxOrderStale?: true }
  | { ok: false; code: GroupFormationRefusalCode; message: string; refusal?: string };

export interface GroupFormationRequest {
  actorId: string;
  sourceThreadId: string;
  addedUserIds: readonly string[];
  carryForward?: readonly CarryForwardSelection[];
  title?: string | null;
  nowIso?: string;
}

const refuse = (code: GroupFormationRefusalCode, message: string, refusal?: string): GroupFormationOutcome =>
  ({ ok: false, code, message, ...(refusal ? { refusal } : {}) });

const log = rootLogger.child({ service: "telegraphGroupFormation" });

function dedupeSelections(list: readonly CarryForwardSelection[]): CarryForwardSelection[] {
  const seen = new Set<string>();
  const out: CarryForwardSelection[] = [];
  for (const sel of list) {
    const key = `${String(sel.kind)}|${String(sel.objectId)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(sel);
  }
  return out;
}

/** The carry-forward kind → the shareable family that loads it. */
const CARRY_FAMILY = { PLAN: "PLAN", PLACE: "PLACE" } as const;

/**
 * Form a group out of a DM. `sc` is the request's client (the service client in
 * production); `flagSc` is the service client used for flags, the stop and the
 * permission engine, as every other Telegraph write door does.
 */
export async function formGroupFromDirect(
  sc: SupabaseClient,
  flagSc: SupabaseClient | null,
  req: GroupFormationRequest,
): Promise<GroupFormationOutcome> {
  // 0. The capability flag, read so that "could not read" is not "off".
  const flagState = await readFlagState(flagSc ?? sc, DM_GROUP_FORMATION_FLAG);
  if (flagState === "unknown") return refuse("degraded_unavailable", RETRY_MESSAGE);
  if (flagState !== "on") return refuse("feature_disabled", "Adding people to a conversation is not available yet");

  // 1. The messaging stop — fail closed on an absent client AND an unreadable flag.
  const stopUnknown = messagingStopUnknownRefusal(flagSc);
  if (stopUnknown) return refuse("degraded_unavailable", stopUnknown.message);
  if (await isKillSwitchEngaged(flagSc!, "disable_messaging")) {
    return refuse("feature_disabled", "Messaging is temporarily disabled");
  }

  const added = Array.from(new Set(req.addedUserIds));
  if (added.length > MAX_ADDED_PEOPLE) {
    return refuse("invalid_payload", `At most ${MAX_ADDED_PEOPLE} people can be added at once`);
  }
  if ((req.carryForward ?? []).length > MAX_CARRY_FORWARD) {
    return refuse("invalid_payload", `At most ${MAX_CARRY_FORWARD} plans or places can be carried forward`);
  }
  if (added.includes(req.actorId)) return refuse("invalid_payload", "You are already in this conversation");

  // 2. The source: a DIRECT thread with exactly two ACTIVE members, one the actor.
  const { data: source, error: sourceErr } = await sc
    .from("message_threads")
    .select("id, thread_type, status")
    .eq("id", req.sourceThreadId)
    .maybeSingle();
  if (sourceErr) return refuse("degraded_unavailable", RETRY_MESSAGE);
  const { data: roster, error: rosterErr } = await sc
    .from("message_thread_members")
    .select("user_id, left_at")
    .eq("thread_id", req.sourceThreadId);
  if (rosterErr) return refuse("degraded_unavailable", RETRY_MESSAGE);
  const rows = ((roster as Array<{ user_id: string; left_at: string | null }> | null) ?? []);
  const actorActive = rows.some((r) => r.user_id === req.actorId && r.left_at == null);
  // A non-member learns nothing about the thread — not even that it exists.
  if (!source || !actorActive) return refuse("not_found", "Conversation not found");
  const sourceType = (source as { thread_type?: string | null }).thread_type ?? "direct";
  const everActive = rows.filter((r) => r.left_at == null).map((r) => r.user_id);

  const nowIso = req.nowIso ?? new Date().toISOString();
  const planned = planGroupFormation({
    sourceConversationId: req.sourceThreadId,
    sourceConversationType: sourceType,
    // The ACTIVE members: a DM whose other party left is not two-party any more.
    sourceMemberUserIds: everActive,
    addedUserIds: added,
    // One carried object per (kind, id): a duplicated selection is one share (V-TG F6).
    carryForward: dedupeSelections(req.carryForward ?? []),
    nowIso,
  });
  if (!planned.ok) {
    const code: GroupFormationRefusalCode =
      planned.refusal === "source_not_direct" || planned.refusal === "source_not_two_party" ? "forbidden" : "invalid_payload";
    return refuse(code, planned.detail, planned.refusal);
  }
  const plan: GroupFormationPlan = planned.plan;

  const permSc = (flagSc ?? sc) as SupabaseClient;
  const partnerId = plan.memberUserIds.find((id) => id !== req.actorId && !added.includes(id))!;

  // 3. The ACTOR's own Trust state first, and said as theirs (OD-TRUST-5,
  //    V-TG F4): a messaging restriction's sentence names "start new
  //    conversations", which forming a group is (D-24). Unreadable → retry.
  const actorRestriction = await getRestrictionState(permSc, req.actorId);
  if (actorRestriction.degradedReason === "fail_closed") return refuse("degraded_unavailable", RETRY_MESSAGE);
  if (actorRestriction.activeRestrictions.includes("messaging")) {
    return refuse("forbidden", restrictionSentence("messaging"), "actor_restricted");
  }

  // 4. EVERY PAIR in the new roster (lead ruling T-GRP-6, V-TG F1), through
  //    the permission engine, fail-closed; any failure refuses the WHOLE
  //    formation with the one uniform sentence:
  //    - actor → each added person: a DIRECT message must be allowed (blocks,
  //      account state, the request door);
  //    - actor ↔ the DM partner: no block either way, and the partner's account
  //      is live (deleted / deactivated / banned → "unavailable"). The DM
  //      itself is their consent to talk; their message-privacy door is not
  //      re-asked of the actor;
  //    - the DM partner → each added person, and each added person → each
  //      other: a DIRECT message must be allowed, which consults the partner's
  //      own D-24 restriction and account state, and every block.
  //    `isBlockedBetween` is then run over every pair as a second, independent
  //    fail-closed reading of the blocks table.
  const allows = async (viewer: string, target: string): Promise<boolean | null> => {
    try {
      return (await resolveInteractionPermissions(permSc, viewer, target)).canMessage === true;
    } catch {
      return null; // a degraded block / restriction / account-state read. Never a pass.
    }
  };
  const directPairs: Array<[string, string]> = [];
  for (const p of added) directPairs.push([req.actorId, p], [partnerId, p]);
  for (let i = 0; i < added.length; i++) for (let j = i + 1; j < added.length; j++) directPairs.push([added[i]!, added[j]!]);
  for (const [v, t] of directPairs) {
    const ok = await allows(v, t);
    if (ok === null) return refuse("degraded_unavailable", RETRY_MESSAGE);
    if (!ok) return refuse("forbidden", CANNOT_ADD_MESSAGE, "cannot_add_person");
  }
  try {
    const toPartner = await resolveInteractionPermissions(permSc, req.actorId, partnerId);
    if (["unavailable", "blocked", "blocks_you", "mutual_block"].includes(toPartner.relationshipLabel)) {
      return refuse("forbidden", CANNOT_ADD_MESSAGE, "cannot_add_person");
    }
  } catch {
    return refuse("degraded_unavailable", RETRY_MESSAGE);
  }
  const everyone = plan.memberUserIds;
  for (let i = 0; i < everyone.length; i++) {
    for (let j = i + 1; j < everyone.length; j++) {
      if (await isBlockedBetween(permSc, everyone[i]!, everyone[j]!)) return refuse("forbidden", CANNOT_ADD_MESSAGE, "cannot_add_person");
    }
  }

  // 5. Carry-forward: visible to the actor AND to every member, per object.
  for (const item of plan.carriedForward) {
    for (const viewerId of plan.memberUserIds) {
      // A fresh shareable per viewer: the loader caches its first answer.
      const shareable = shareableFor(sc, CARRY_FAMILY[item.kind], item.objectId);
      if (!shareable) return refuse("invalid_payload", CARRY_FORWARD_REFUSED_MESSAGE, "carry_forward_not_shareable");
      let available = false;
      try {
        available = (await shareable.getCurrentState(viewerId)).available === true;
      } catch {
        return refuse("degraded_unavailable", RETRY_MESSAGE);
      }
      if (!available) {
        return refuse(
          "forbidden",
          CARRY_FORWARD_REFUSED_MESSAGE,
          viewerId === req.actorId ? "carry_forward_not_visible_to_you" : "carry_forward_not_visible_to_group",
        );
      }
    }
  }

  // 5b. A Plan any member has DECLINED is not carried to them (T-GRP-6, V-TG
  //     F6): the loader shows a declined invitee the plan, so this is read here.
  const planIds = plan.carriedForward.filter((c) => c.kind === "PLAN").map((c) => c.objectId);
  if (planIds.length > 0) {
    const { data: declined, error: declinedErr } = await sc
      .from("meetup_invites")
      .select("meetup_id")
      .in("meetup_id", planIds)
      .in("user_id", plan.memberUserIds)
      .eq("status", "declined")
      .limit(1);
    if (declinedErr) return refuse("degraded_unavailable", RETRY_MESSAGE);
    if (((declined as unknown[]) ?? []).length > 0) {
      return refuse("forbidden", CARRY_FORWARD_REFUSED_MESSAGE, "carry_forward_declined_by_member");
    }
  }

  // ── Writes ────────────────────────────────────────────────────────────────
  const title = typeof req.title === "string" && req.title.trim() ? req.title.trim().slice(0, MAX_GROUP_TITLE) : null;
  const { data: thread, error: threadErr } = await sc
    .from("message_threads")
    .insert({ thread_type: "group", created_by: req.actorId, title, created_at: nowIso, updated_at: nowIso })
    .select("id")
    .single();
  if (threadErr || !thread) return refuse("db_error", "Failed to create the group");
  const threadId = String((thread as { id: string }).id);

  const rollback = async () => {
    // Members and messages go with the thread (FK ON DELETE CASCADE). A delete
    // that fails leaves an orphan group, which must at least be visible.
    const { error: rbErr } = await sc.from("message_threads").delete().eq("id", threadId);
    if (rbErr) log.error({ threadId, err: rbErr.message }, "group formation rollback failed — an orphan group thread remains");
  };

  // The actor is the group's first admin (its host); everyone else a member.
  // Every member's window opens at the formation instant (the plan's floor).
  for (const userId of plan.memberUserIds) {
    // One literal row per member so check:write-path-columns can resolve every
    // column. visible_from_at is not named: 2400's trigger stamps it from
    // joined_at where that migration is applied, and a database without 2400
    // has no such column. Either way the new thread holds no earlier message.
    const { error: memErr } = await sc.from("message_thread_members").insert({
      thread_id: threadId,
      user_id: userId,
      role: userId === req.actorId ? "admin" : "member",
      joined_at: plan.visibleFromAt,
    });
    if (memErr) {
      await rollback();
      return refuse("db_error", "Failed to add the group's members");
    }
  }

  const carried: Array<{ kind: "PLAN" | "PLACE"; objectId: string; messageId: string }> = [];
  for (const item of plan.carriedForward) {
    // The same six gates every share passes (stop, membership, block, E2EE,
    // Trust restriction, burst limit) — on the NEW thread.
    const guard = await guardTelegraphThreadWrite(sc, threadId, req.actorId);
    if (!guard.ok) {
      await rollback();
      return refuse(guard.code === "rate_limited" ? "degraded_unavailable" : guard.code === "forbidden" ? "forbidden" : "degraded_unavailable", guard.message);
    }
    const body = buildPortavaObjectBody(CARRY_FAMILY[item.kind], item.objectId, null);
    const { data: msg, error: msgErr } = await sc
      .from("messages")
      .insert({
        thread_id: threadId,
        sender_id: req.actorId,
        body: JSON.stringify(body),
        created_at: nowIso,
        msg_type: msgTypeOf("PORTAVA_OBJECT"),
        subtype: item.kind === "PLAN" ? "plan" : "place",
      })
      .select("id")
      .single();
    if (msgErr || !msg) {
      await rollback();
      return refuse("db_error", "Failed to carry a plan or place forward");
    }
    carried.push({ kind: item.kind, objectId: item.objectId, messageId: String((msg as { id: string }).id) });
  }

  if (carried.length > 0) {
    // Inbox ordering only. A failure leaves the group usable and is reported
    // to the caller rather than swallowed.
    const { error: bumpErr } = await sc
      .from("message_threads")
      .update({ last_message_at: nowIso, updated_at: nowIso })
      .eq("id", threadId);
    if (bumpErr) return { ok: true, threadId, memberUserIds: plan.memberUserIds, carriedForward: carried, inboxOrderStale: true };
  }

  return { ok: true, threadId, memberUserIds: plan.memberUserIds, carriedForward: carried };
}
