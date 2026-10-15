/**
 * Telegraph §30A.19 — the Context Kernel's reads (census-telegraph T439).
 *
 * The contract, and every rule that holds whatever a read returns, is
 * domain/telegraph/contracts/telegraphContextKernel.ts. This module gathers the
 * five inputs for ONE viewer in ONE conversation, and it gathers each through
 * the resolver that already owns it — the kernel composes; it resolves nothing
 * itself (census §45.3's objection to T379 was a fifth resolver; this is not
 * one):
 *
 *   RELATIONSHIP   ./telegraphContextRelationship.ts → §30A.1's canonical
 *                  relationship (services/telegraph/telegraphRelationship.ts),
 *                  behind its own flag (3662). Direct conversations only.
 *   TIME           the conversation's plan timeline — §9's derived state
 *                  (services/telegraph/coordination.ts: derivedCoordinationState,
 *                  leaveByFor, threadIsCoordinating), over the plan the GET
 *                  /coordination route chooses, read the way it reads it — and
 *                  the viewer's own §14.3 window (services/groupChatHistoryBound.ts).
 *   PROXIMITY      Nearby itself: the SAME chain GET /nearby/reachable runs —
 *                  its flag, its rate limit, its poll quantum, the loader, the
 *                  §4.1 signal contract and the §4.3 observation budget — then the
 *                  other member's served bucket, or nothing. Direct conversations
 *                  only, and only when Nearby is ON and the other member is one
 *                  of the viewer's graph candidates (circle, crew).
 *   INTENT         the planning intents services/telegraphIntent.ts already
 *                  detected for this viewer in this conversation, as stored in
 *                  the viewer's own live `telegraph_chat_suggestions` rows. The
 *                  kernel reads no message: it does not re-classify chat.
 *   SHARED OBJECTS §3's rail (services/telegraph/sharedContext.ts
 *                  buildSharedContextProjection) over the same participants and
 *                  the same client (and viewer) GET /shared-context passes it.
 *
 * ── ORDER, AND WHY ──────────────────────────────────────────────────────────
 * Membership first (a non-member is told nothing, not even the conversation's
 * type), then the roster, then — in a direct conversation — the pair's block
 * EITHER WAY through the shared reader (lib/exclusionSet.ts readPairExclusion).
 * A block, or a block state that could not be read (returned OR thrown), ends it
 * there: the minimal context, and no input is even read.
 *
 * ── PROXIMITY IS A NEARBY POLL ──────────────────────────────────────────────
 * With Nearby ON, a kernel read IS a Nearby poll whose answer is narrowed to one
 * person: it spends the same per-viewer rate limit and is recorded by the same
 * per-relationship observation budget (a row write, as GET /nearby/reachable's
 * own GET does). Serving a bucket outside the budget would be the unbounded
 * observation §4.3 forbids, through a second door.
 *
 * ── CLIENTS: ONE SERVICE CLIENT, SCOPED BY THE GATE AND THE PREDICATES ──────
 * `requireUser` hands every route the SERVICE client (lib/http.ts); nothing on
 * this path is RLS-scoped. `client` is that same client the coordination,
 * suggestion and rail routes read with, so the kernel sees what they see: rows
 * scoped by membership (the gate, first) and by each read's own predicates
 * (`user_id` = viewer on intents, `chat_thread_id` on plans, the rail's viewer).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger as rootLogger } from "../../lib/logger.js";
import { isFlagEnabled } from "../../lib/featureFlags.js";
import { checkRateLimit } from "../../lib/rateLimit.js";
import { exclusionsUnavailable, readPairExclusion, type ExclusionSet } from "../../lib/exclusionSet.js";
import { historyBoundEnabled, membershipSelect, visibleFromOf } from "../../services/groupChatHistoryBound.js";
import { derivedCoordinationState, leaveByFor, threadIsCoordinating, type CoordinatedPlan } from "../../services/telegraph/coordination.js";
import { loadReachablePeople } from "../../services/telegraph/reachablePeopleQuery.js";
import { withSignalContract } from "../../services/telegraph/availabilitySignalContract.js";
import { applyObservationBudget } from "../../services/telegraph/proximityObservationBudget.js";
import { buildSharedContextProjection, railModeFor } from "../../services/telegraph/sharedContext.js";
import { isIntentType } from "../../services/telegraphIntent.js";
import { quantiseNow } from "../../routes/nearbyReachable.js";
import { MAX_RAIL_PARTICIPANTS } from "../../routes/telegraphSharedContext.js";
import { readKernelRelationship } from "./telegraphContextRelationship.js";
import {
  composeConversationContext,
  degradedInput,
  notConsultedInput,
  readInput,
  withheldInput,
  type ContextInput,
  type ConversationContext,
  type ConversationGate,
  type KernelIntentValue,
  type KernelProximityValue,
  type KernelSharedObjectsValue,
  type KernelTimeValue,
} from "../../domain/telegraph/contracts/telegraphContextKernel.js";

const log = rootLogger.child({ mod: "telegraphContextKernel" });

/** GET /coordination reads at most this many plans for a thread; the kernel reads the same set. */
export const KERNEL_PLAN_SCAN = 20;
/** The newest stored intents considered (a viewer's suggestions in one thread expire after four hours). */
export const KERNEL_INTENT_SCAN = 20;
/** Nearby's own limiter id and ceiling — the kernel's read spends the same budget (routes/nearbyReachable.ts). */
export const NEARBY_RATE_LIMITER = "nearby_reachable";
export const NEARBY_RATE_LIMIT = 20;
export const NEARBY_RATE_WINDOW_MS = 60_000;

// ── the gate ─────────────────────────────────────────────────────────────────

interface GateRead {
  gate: ConversationGate;
  conversationType: string;
  /** The other member of a pairwise conversation. */
  otherId: string | null;
  /** Active members, viewer included, capped as the rail caps them. */
  participantIds: string[];
  historyVisibleFrom: string | null;
}

async function readGate(sc: SupabaseClient, viewerId: string, conversationId: string): Promise<GateRead> {
  const base = { otherId: null, participantIds: [], historyVisibleFrom: null };
  const { data: thread, error: threadErr } = await sc
    .from("message_threads")
    .select("id, thread_type")
    .eq("id", conversationId)
    .maybeSingle();
  if (threadErr) return { ...base, gate: { kind: "unreadable", reason: "TELEGRAPH_DEGRADED_THREAD_UNREADABLE" }, conversationType: "unknown" };
  // A conversation that does not exist and one the viewer is not in answer alike, type included.
  if (!thread) return { ...base, gate: { kind: "not_member", reason: "TELEGRAPH_AUTH_NOT_MEMBER" }, conversationType: "unknown" };

  const boundOn = await historyBoundEnabled(sc);
  const { data: membership, error: membershipErr } = await sc
    .from("message_thread_members")
    .select(membershipSelect("user_id, left_at", boundOn))
    .eq("thread_id", conversationId)
    .eq("user_id", viewerId)
    .maybeSingle();
  if (membershipErr) return { ...base, gate: { kind: "unreadable", reason: "TELEGRAPH_DEGRADED_MEMBERSHIP_UNREADABLE" }, conversationType: "unknown" };
  if (!membership) return { ...base, gate: { kind: "not_member", reason: "TELEGRAPH_AUTH_NOT_MEMBER" }, conversationType: "unknown" };
  if ((membership as { left_at?: unknown }).left_at != null) {
    return { ...base, gate: { kind: "not_member", reason: "TELEGRAPH_AUTH_LEFT_THREAD" }, conversationType: "unknown" };
  }
  const conversationType = String((thread as { thread_type?: unknown }).thread_type ?? "direct");
  const historyVisibleFrom = visibleFromOf(membership as never, boundOn);

  const { data: roster, error: rosterErr } = await sc
    .from("message_thread_members")
    .select("user_id")
    .eq("thread_id", conversationId)
    .is("left_at", null)
    .limit(MAX_RAIL_PARTICIPANTS + 1);
  // An unreadable roster is not "no other members": whether the conversation is
  // pairwise, and whose block applies, cannot be known.
  if (rosterErr) return { ...base, gate: { kind: "unreadable", reason: "TELEGRAPH_DEGRADED_MEMBERSHIP_UNREADABLE" }, conversationType, historyVisibleFrom };
  const ids = [...new Set(((roster as Array<{ user_id?: unknown }> | null) ?? []).map((r) => String(r.user_id ?? "")).filter(Boolean))];
  const others = ids.filter((id) => id !== viewerId);
  const participantIds = [viewerId, ...others].slice(0, MAX_RAIL_PARTICIPANTS);
  const pairwise = conversationType === "direct" && others.length === 1;
  if (!pairwise) {
    return { gate: { kind: "member", pairwise: false, pairBlock: "not_applicable" }, conversationType, otherId: null, participantIds, historyVisibleFrom };
  }

  const otherId = others[0]!;
  let pair: ExclusionSet;
  try {
    pair = await readPairExclusion(sc, viewerId, otherId);
  } catch (err) {
    pair = exclusionsUnavailable(err); // a THROWN block read is the same unknown as a returned one: the minimal context
  }
  const pairBlock = !pair.ok ? "unreadable" : pair.ids.size > 0 ? "blocked" : "clear";
  return { gate: { kind: "member", pairwise: true, pairBlock }, conversationType, otherId, participantIds, historyVisibleFrom };
}

// ── the inputs ───────────────────────────────────────────────────────────────

/**
 * TIME. The plan is chosen exactly as GET /threads/:id/coordination chooses it
 * (routes/telegraphCoordination.ts: the soonest plan whose end has not passed,
 * else the latest) — `src/test/telegraphContextKernel.test.ts` drives both and
 * asserts they agree.
 */
export async function readKernelTime(
  client: SupabaseClient,
  conversationId: string,
  historyVisibleFrom: string | null,
  nowMs: number,
): Promise<ContextInput<KernelTimeValue>> {
  const { data: meetups, error } = await client
    .from("meetups")
    .select("id, title, starts_at, ends_at, status")
    .eq("chat_thread_id", conversationId)
    .limit(KERNEL_PLAN_SCAN);
  if (error) return degradedInput("KERNEL_SOURCE_UNREADABLE");
  const candidates = ((meetups as Array<Record<string, unknown>> | null) ?? [])
    .filter((m) => typeof m.starts_at === "string" && m.starts_at.length > 0)
    .sort((a, b) => Date.parse(String(a.starts_at)) - Date.parse(String(b.starts_at)));
  const chosen =
    candidates.find((m) => Date.parse(String(m.ends_at ?? m.starts_at)) >= nowMs) ??
    candidates[candidates.length - 1] ??
    null;
  let coordination: KernelTimeValue["coordination"] = null;
  if (chosen) {
    const plan: CoordinatedPlan = {
      objectId: String(chosen.id),
      title: typeof chosen.title === "string" ? chosen.title : "Plan",
      startsAt: (chosen.starts_at as string | null) ?? null,
      endsAt: (chosen.ends_at as string | null) ?? null,
      status: (chosen.status as string | null) ?? null,
    };
    const state = derivedCoordinationState(plan, nowMs);
    coordination = {
      planId: plan.objectId,
      state,
      coordinating: threadIsCoordinating(state),
      startsAt: plan.startsAt,
      endsAt: plan.endsAt,
      leaveByAt: leaveByFor(plan),
    };
  }
  return readInput({ coordination, historyVisibleFrom });
}

/**
 * PROXIMITY, as Nearby serves it: GET /nearby/reachable's chain, step for step
 * (`src/test/telegraphContextKernelGuard.test.ts` holds the two to the same
 * limiter, quantum, loader, contract and budget). The other member's bucket is
 * served only if Nearby served it — after consent, invisible mode, protected
 * zones, the signal contract and the observation budget — and never finer.
 */
export async function readKernelProximity(
  sc: SupabaseClient,
  viewerId: string,
  otherId: string,
  nowMs: number,
): Promise<ContextInput<KernelProximityValue>> {
  if (!(await isFlagEnabled(sc, "nearby_reachable_enabled"))) return notConsultedInput("KERNEL_SOURCE_OFF");
  const rl = checkRateLimit(NEARBY_RATE_LIMITER, viewerId, NEARBY_RATE_LIMIT, NEARBY_RATE_WINDOW_MS);
  if (!rl.allowed) return withheldInput("KERNEL_RATE_LIMITED");
  const quantum = quantiseNow(nowMs);
  const result = await withSignalContract(sc, viewerId, quantum, await loadReachablePeople(sc, { viewerId, nowMs: quantum }));
  if (!result.ok) return degradedInput("KERNEL_SOURCE_UNREADABLE");
  const budget = await applyObservationBudget(sc, viewerId, result.people, quantum, result.unpublished, result.heldBack);
  if (!budget.ok) return degradedInput("KERNEL_SOURCE_UNREADABLE");
  const person = budget.people.find((p) => p.personId === otherId);
  if (!person || !person.privacy.proximityPublished) return withheldInput("KERNEL_NOT_SHOWN");
  return readInput({ bucket: person.proximity.bucket, precision: "bucket", freshness: person.proximity.freshness });
}

/**
 * INTENT. The viewer's own live suggestion rows in this thread — the stored
 * outputs of services/telegraphIntent.ts#detectIntent — newest first, each
 * intent once, and only values of its closed vocabulary.
 */
export async function readKernelIntent(
  client: SupabaseClient,
  viewerId: string,
  conversationId: string,
  nowMs: number,
): Promise<ContextInput<KernelIntentValue>> {
  const { data, error } = await client
    .from("telegraph_chat_suggestions")
    .select("intent_type, created_at")
    .eq("user_id", viewerId)
    .eq("thread_id", conversationId)
    .eq("status", "shown")
    .gt("expires_at", new Date(nowMs).toISOString())
    .order("created_at", { ascending: false })
    .limit(KERNEL_INTENT_SCAN);
  if (error) return degradedInput("KERNEL_SOURCE_UNREADABLE");
  const detected: string[] = [];
  for (const r of (data as Array<{ intent_type?: unknown }> | null) ?? []) {
    if (isIntentType(r.intent_type) && !detected.includes(r.intent_type)) detected.push(r.intent_type);
  }
  return readInput({ detected });
}

/**
 * SHARED OBJECTS. §3's rail, counted. A rail any of whose resolvers failed is
 * `degraded`, not a smaller rail: the kernel serves no floor.
 */
export async function readKernelSharedObjects(
  client: SupabaseClient,
  conversationId: string,
  viewerId: string,
  participantIds: string[],
  nowMs: number,
): Promise<ContextInput<KernelSharedObjectsValue>> {
  const result = await buildSharedContextProjection(client, { conversationId, viewerId, participantIds, now: new Date(nowMs) });
  if (result.problems.length > 0) return degradedInput("KERNEL_SOURCE_UNREADABLE");
  const p = result.projection;
  return readInput({ now: p.now.length, upcoming: p.upcoming.length, unresolved: p.unresolved.length, past: p.past.length, railMode: railModeFor(p) });
}

// ── the composer ─────────────────────────────────────────────────────────────

/** One input's read; a THROWN read is that input's unknown, never the whole answer's 500. */
async function settle<T>(input: string, conversationId: string, read: () => Promise<ContextInput<T>>): Promise<ContextInput<T>> {
  try {
    return await read();
  } catch (err) {
    log.warn({ input, conversationId, message: err instanceof Error ? err.message : String(err) }, "context kernel: an input's read threw; that input answers unreadable");
    return degradedInput("KERNEL_SOURCE_UNREADABLE");
  }
}

export async function readConversationContext(args: {
  sc: SupabaseClient;
  client: SupabaseClient;
  viewerId: string;
  conversationId: string;
  nowMs: number;
}): Promise<ConversationContext> {
  const { sc, client, viewerId, conversationId, nowMs } = args;
  const g = await readGate(sc, viewerId, conversationId);
  if (g.gate.kind !== "member" || g.gate.pairBlock === "blocked" || g.gate.pairBlock === "unreadable") {
    return composeConversationContext({ conversationId, conversationType: g.conversationType, gate: g.gate });
  }
  const otherId = g.otherId;
  const [relationship, time, proximity, intent, sharedObjects] = await Promise.all([
    otherId ? settle("relationship", conversationId, () => readKernelRelationship(sc, viewerId, otherId)) : notConsultedInput("KERNEL_PAIRWISE_ONLY"),
    settle("time", conversationId, () => readKernelTime(client, conversationId, g.historyVisibleFrom, nowMs)),
    otherId ? settle("proximity", conversationId, () => readKernelProximity(sc, viewerId, otherId, nowMs)) : notConsultedInput("KERNEL_PAIRWISE_ONLY"),
    settle("intent", conversationId, () => readKernelIntent(client, viewerId, conversationId, nowMs)),
    settle("sharedObjects", conversationId, () => readKernelSharedObjects(client, conversationId, viewerId, g.participantIds, nowMs)),
  ]);
  return composeConversationContext({
    conversationId,
    conversationType: g.conversationType,
    gate: g.gate,
    readings: { relationship, time, proximity, intent, sharedObjects },
  });
}
