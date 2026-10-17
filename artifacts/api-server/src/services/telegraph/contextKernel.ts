/**
 * Telegraph §30A.19 — the Context Kernel's GATHERER (census-telegraph T439).
 *
 * `contextKernelPolicy.ts` decides; this module reads the five inputs from the
 * resolvers that already exist and hands them over. It resolves nothing a
 * second time:
 *
 *   Relationship    services/telegraph/telegraphRelationship.ts — §30A.1's
 *                   canonical resolver, behind ITS OWN flag
 *                   (`telegraph_relationship_context_enabled`, 3662), exactly
 *                   as GET /users/:id/telegraph-relationship reads it.
 *   Time            the clock, stated in UTC, plus §3.3's band of the shared
 *                   objects (decided by the policy from the projection).
 *   Proximity       the §30A.2 reachable projection, through the SAME pipeline
 *                   GET /nearby/reachable runs — its flag, the loader (kill
 *                   switch, blocks, consent, protected zones), the §4.1 signal
 *                   contract and the §4.3 observation budget — then narrowed to
 *                   this conversation's members. The kernel can therefore reveal
 *                   no bucket that surface would not serve this viewer at this
 *                   instant, and every bucket it reads is an observation the
 *                   budget records.
 *   Intent          services/telegraphIntent.ts `detectIntent`, over the newest
 *                   text messages the viewer may read: the §14.3 window applied
 *                   in the query and per row, tombstones and (kernel on) unsent
 *                   rows excluded, blocked senders dropped. Only the label
 *                   leaves this module.
 *   Shared Objects  services/telegraph/sharedContext.ts — §3.4's projection,
 *                   the rail's own.
 *
 * Every read's failure becomes `unreadable` for THAT input, never an empty
 * answer; only the membership read the whole kernel rests on refuses outright.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { readFlagState } from "../../lib/featureFlags.js"; import { readPairExclusion } from "../../lib/exclusionSet.js"; import { recordTelegraphMetric } from "../../domain/telegraph/services/telegraphObservability.js"; import { allDenied } from "../../domain/telegraph/contracts/conversationCapabilities.js"; // wave 5: the gatherer's own block read (readKernelPairBlock, file foot)
import { resolveConversationCapabilities } from "../../domain/telegraph/policies/conversationCapabilityPolicy.js";
import type { TelegraphRelationship } from "../../domain/telegraph/contracts/telegraphRelationship.js";
import { applyHistoryWindow, historyBoundEnabled, membershipSelect, visibleFromOf, withinWindow } from "../groupChatHistoryBound.js";
import { detectIntent } from "../telegraphIntent.js";
import { applyLifecycleExclusion, messageKernelEnabled } from "../telegraphMessageKernel.js";
import { dropBlockedSenders } from "../telegraphReliability.js";
import { withSignalContract } from "./availabilitySignalContract.js";
import {
  decideContextKernel,
  proximityMayBeRead,
  type ContextKernel,
  type KernelIntent,
  type KernelProximity,
  type KernelReading,
  type KernelSharedObjects,
} from "./contextKernelPolicy.js";
import { applyObservationBudget } from "./proximityObservationBudget.js";
import { loadReachablePeople } from "./reachablePeopleQuery.js";
import type { ReachablePersonProjection } from "./reachablePeople.js";
import { buildSharedContextProjection } from "./sharedContext.js";
import { readTelegraphRelationship, RELATIONSHIP_CONTEXT_FLAG } from "./telegraphRelationship.js";

/** The §30A.2 surface's own gate — the kernel reads proximity only where that surface would serve it. */
export const KERNEL_PROXIMITY_FLAG = "nearby_reachable_enabled";

/** Newest text messages the intent input classifies. */
export const KERNEL_INTENT_SCAN_LIMIT = 20;
/** A message older than this states no CURRENT intent. */
export const KERNEL_INTENT_RECENCY_MS = 24 * 60 * 60_000;
/** The rail's own participant cap (routes/telegraphSharedContext.ts MAX_RAIL_PARTICIPANTS), pinned equal by test. */
export const KERNEL_MAX_PARTICIPANTS = 50;

export interface ContextKernelRequest {
  readonly viewerId: string;
  readonly conversationId: string;
  /** Quantised by the route (the §4.5 poll quantum), so two calls inside one quantum read one instant. */
  readonly nowMs: number;
}

export type ContextKernelResult =
  | { readonly ok: true; readonly kernel: ContextKernel }
  | { readonly ok: false; readonly stage: "thread" | "membership" | "roster" | "blocks"; readonly message: string };

/**
 * Proximity through the §30A.2 pipeline, unmodified and in the route's order,
 * for the WHOLE candidate list (so the observation budget's state is exactly
 * what a GET /nearby/reachable at this instant would leave), then narrowed to
 * `memberIds`.
 */
export async function readKernelProximity(
  sc: SupabaseClient,
  viewerId: string,
  memberIds: readonly string[],
  nowMs: number,
): Promise<KernelReading<KernelProximity>> {
  const flag = await readFlagState(sc, "nearby_reachable_enabled"); // KERNEL_PROXIMITY_FLAG, as a literal for check:flag-polarity
  if (flag === "unknown") return { status: "unreadable", detail: "the proximity flag could not be read" };
  if (flag === "off") return { status: "off", detail: "nearby_reachable_enabled is off: no deployment publishes proximity" };
  const loaded = await withSignalContract(sc, viewerId, nowMs, await loadReachablePeople(sc, { viewerId, nowMs }));
  if (!loaded.ok) return { status: "unreadable", detail: `the reachable projection refused at ${loaded.stage}` };
  const budget = await applyObservationBudget(sc, viewerId, loaded.people, nowMs, loaded.unpublished, loaded.heldBack);
  if (!budget.ok) return { status: "unreadable", detail: `the observation budget refused at ${budget.stage}` };
  return { status: "read", value: kernelProximityFrom(budget.people, memberIds) };
}

/**
 * The served list, narrowed to this conversation's other members and to the
 * people whose proximity the projection actually PUBLISHED. A person on the
 * list for their availability alone carries an `unknown` bucket that is not a
 * proximity fact, so they are not in the kernel's proximity input at all.
 */
export function kernelProximityFrom(
  served: ReadonlyArray<Pick<ReachablePersonProjection, "personId" | "proximity" | "privacy">>,
  memberIds: readonly string[],
): KernelProximity {
  const members = new Set(memberIds);
  return {
    people: served
      .filter((p) => members.has(p.personId) && p.privacy.proximityPublished === true)
      .map((p) => ({ userId: p.personId, bucket: p.proximity.bucket, travel: p.proximity.travel, freshness: p.proximity.freshness })),
  };
}

/** The intent input: the newest recognisable intent among the messages this viewer may read. */
export async function readKernelIntent(
  sc: SupabaseClient,
  input: { threadId: string; viewerId: string; visibleFrom: string | null; isE2ee: boolean },
  nowMs: number,
): Promise<KernelReading<KernelIntent | null>> {
  if (input.isE2ee) return { status: "not_applicable", detail: "an end-to-end encrypted conversation has no text the server can read" };
  const kernelOn = await messageKernelEnabled(sc);
  let q = sc
    .from("messages")
    .select("id, sender_id, created_at, msg_type, body")
    .eq("thread_id", input.threadId)
    .eq("msg_type", "text")
    .is("deleted_at", null)
    .gte("created_at", new Date(nowMs - KERNEL_INTENT_RECENCY_MS).toISOString())
    .order("created_at", { ascending: false })
    .limit(KERNEL_INTENT_SCAN_LIMIT);
  q = applyLifecycleExclusion(q, kernelOn);
  q = applyHistoryWindow(q, input.visibleFrom, input.viewerId);
  const { data, error } = await q;
  if (error || !Array.isArray(data)) return { status: "unreadable", detail: "the conversation's recent messages could not be read" };
  const visible = (data as Array<{ id: string; sender_id: string; created_at: string; body: unknown }>).filter((r) =>
    withinWindow(r.created_at, input.visibleFrom, { senderId: r.sender_id, viewerId: input.viewerId }));
  const unblocked = await dropBlockedSenders(sc, input.viewerId, visible);
  if (!unblocked.ok) return { status: "unreadable", detail: "block state could not be established" };
  for (const r of unblocked.rows) {
    const found = typeof r.body === "string" ? detectIntent(r.body) : null;
    if (found) {
      return {
        status: "read",
        value: { intent: found.intent, confidence: found.confidence, messageId: String(r.id), at: String(r.created_at), sentByViewer: r.sender_id === input.viewerId },
      };
    }
  }
  return { status: "read", value: null };
}

async function readKernelRelationship(sc: SupabaseClient, viewerId: string, counterpartId: string | null, nowMs: number): Promise<KernelReading<TelegraphRelationship>> {
  if (!counterpartId) return { status: "not_applicable", detail: "a relationship is between two people; this conversation is not a direct one" };
  const flag = await readFlagState(sc, "telegraph_relationship_context_enabled"); // RELATIONSHIP_CONTEXT_FLAG, as a literal for check:flag-polarity
  if (flag === "unknown") return { status: "unreadable", detail: `${RELATIONSHIP_CONTEXT_FLAG} could not be read` };
  if (flag === "off") return { status: "off", detail: `${RELATIONSHIP_CONTEXT_FLAG} is off` };
  const read = await readTelegraphRelationship(sc, viewerId, counterpartId, nowMs);
  if (read.degraded) return { status: "unreadable", detail: "the relationship could not be read" };
  return { status: "read", value: read.relationship };
}

async function readKernelSharedObjects(
  sc: SupabaseClient,
  input: { conversationId: string; viewerId: string; participantIds: string[] },
  nowMs: number,
): Promise<KernelReading<KernelSharedObjects>> {
  const built = await buildSharedContextProjection(sc, { ...input, now: new Date(nowMs) });
  return { status: "read", value: { projection: built.projection, incomplete: built.problems.length > 0 } };
}

const NOT_GATHERED: KernelReading<never> = { status: "not_applicable", detail: "not gathered: this viewer is shown nothing here (not an active member, or blocked)" };

/**
 * Gather the five inputs for one viewer in one conversation and decide.
 *
 * `sc` must be a service-role client, for the reason `resolveConversationCapabilities`
 * states: an RLS-filtered read that returns nothing is indistinguishable from a
 * fact that is absent.
 */
export async function assembleContextKernel(sc: SupabaseClient, req: ContextKernelRequest): Promise<ContextKernelResult> {
  const { viewerId, conversationId, nowMs } = req;

  const { data: thread, error: threadErr } = await sc
    .from("message_threads")
    .select("id, thread_type, is_e2ee")
    .eq("id", conversationId)
    .maybeSingle();
  if (threadErr) return { ok: false, stage: "thread", message: String(threadErr.message ?? "thread unreadable") };

  const boundOn = await historyBoundEnabled(sc);
  const { data: membership, error: memberErr } = await sc
    .from("message_thread_members")
    .select(membershipSelect("user_id, left_at", boundOn))
    .eq("thread_id", conversationId)
    .eq("user_id", viewerId)
    .maybeSingle();
  if (memberErr) return { ok: false, stage: "membership", message: String(memberErr.message ?? "membership unreadable") };

  const capabilities = await resolveConversationCapabilities(sc, { viewerId, conversationId });
  const member = !!thread && !!membership && (membership as any).left_at == null;
  const conversationType = thread ? String((thread as any).thread_type ?? "direct") : "unknown";
  if (!member || capabilities.reasons.canSendMessage === "TELEGRAPH_AUTH_BLOCKED") { // T439: a member §14.1 saw blocked gets the non-member answer (the policy's rule), so nothing is gathered for them either — no roster, input or observation read whose failure could change its status
    return {
      ok: true,
      kernel: decideContextKernel({
        conversationId, viewerId, conversationType: "unknown", member, capabilities,
        relationship: NOT_GATHERED, proximity: NOT_GATHERED, intent: NOT_GATHERED, sharedObjects: NOT_GATHERED, nowMs,
      }),
    };
  }

  const { data: roster, error: rosterErr } = await sc
    .from("message_thread_members")
    .select("user_id")
    .eq("thread_id", conversationId)
    .is("left_at", null)
    .limit(KERNEL_MAX_PARTICIPANTS + 1);
  if (rosterErr) return { ok: false, stage: "roster", message: String(rosterErr.message ?? "roster unreadable") };
  const participantIds = [...new Set(((roster as Array<{ user_id: string }> | null) ?? []).map((r) => String(r.user_id)))].slice(0, KERNEL_MAX_PARTICIPANTS);
  if (!participantIds.includes(viewerId)) participantIds.push(viewerId);
  const others = participantIds.filter((id) => id !== viewerId);
  const counterpartId = conversationType === "direct" && others.length === 1 ? others[0] : null; const pairBlock = await readKernelPairBlock(sc, viewerId, counterpartId); if (pairBlock === "unreadable") return { ok: false, stage: "blocks", message: "block state unreadable" }; if (pairBlock === "blocked") return { ok: true, kernel: decideContextKernel({ conversationId, viewerId, conversationType: "unknown", member: true, capabilities: { ...capabilities, ...allDenied("TELEGRAPH_AUTH_BLOCKED") }, relationship: NOT_GATHERED, proximity: NOT_GATHERED, intent: NOT_GATHERED, sharedObjects: NOT_GATHERED, nowMs }) }; // wave 5: a block §14.1 did not report (its own roster read failed, or the block landed between the two reads) is the same stranger's answer, gathered no further; an unreadable blocks table refuses like the reads above
  const visibleFrom = visibleFromOf(membership as any, boundOn);

  const relationship = await readKernelRelationship(sc, viewerId, counterpartId, nowMs); const blockedPair = relationship.status === "read" && relationship.value.state === "BLOCKED"; // T439: a block only the relationship saw (in an archived DM §14.1 reports the archive first) is the same non-member answer, and nothing is gathered across it
  const sharedObjects = blockedPair ? NOT_GATHERED : await readKernelSharedObjects(sc, { conversationId, viewerId, participantIds }, nowMs);
  const proximity: KernelReading<KernelProximity> = proximityMayBeRead(conversationType, relationship)
    ? await readKernelProximity(sc, viewerId, others, nowMs)
    : { status: "not_applicable", detail: "not read: no relationship here admits a proximity bucket" };
  const intent = blockedPair ? NOT_GATHERED : await readKernelIntent(sc, { threadId: conversationId, viewerId, visibleFrom, isE2ee: (thread as any).is_e2ee === true }, nowMs);

  return {
    ok: true,
    kernel: decideContextKernel({
      conversationId, viewerId, conversationType, member: true, capabilities,
      relationship, proximity, intent, sharedObjects, nowMs,
    }),
  };
}

// ── wave 5 — the gatherer's own block read (census-telegraph §14.1 / T439) ────

/**
 * The pair's block state, read by the gatherer itself, after its own roster
 * read named the counterpart.
 *
 * §14.1's resolver reads it first, and a block it reports never reaches here
 * (the short-circuit in `assembleContextKernel`). This read covers what that
 * one cannot: a block §14.1 never saw because ITS roster read failed — it then
 * answers a degraded refusal, not a block, and the gather used to carry on and
 * reveal the shared objects, the band and the intent — and a block created
 * between the two reads.
 *
 * `readPairExclusion`, not `isBlockedBetween`: the kernel must tell
 * "unreadable" from "blocked". `isBlockedBetween` folds a failed read into
 * `true`, which here would serve a member a stranger's answer during an
 * outage; this read REFUSES instead (503, `stage: "blocks"`), as the thread,
 * membership and roster reads already do. `readPairExclusion` never rejects, so
 * there is no catch here for blockReadCatchGuard to judge. The read is counted
 * on SLO-14 (`block_enforcement_failures`): a refusal made without knowing is
 * a violation, a read that answered is ok — the guard's own semantics.
 */
export async function readKernelPairBlock(
  sc: SupabaseClient,
  viewerId: string,
  counterpartId: string | null,
): Promise<"not_applicable" | "clear" | "blocked" | "unreadable"> {
  if (!counterpartId) return "not_applicable";
  const pair = await readPairExclusion(sc, viewerId, counterpartId);
  recordTelegraphMetric("block_enforcement_failures", pair.ok ? "ok" : "violation");
  if (!pair.ok) return "unreadable";
  return pair.ids.has(counterpartId) ? "blocked" : "clear";
}
