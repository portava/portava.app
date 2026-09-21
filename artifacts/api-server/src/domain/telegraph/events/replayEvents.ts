/**
 * Telegraph §30A.18 / §29 / §30A.15 — the replay event vocabulary, and the fold.
 *
 * TWO THINGS ARE BEING TESTED BY THE EXISTENCE OF THIS FILE, not one.
 *
 * §30A.18 asks for deterministic final state under permutation. §29's last
 * invariant and §30A.15's last bullet ask for something else and stronger:
 * "Derived projections are rebuildable from canonical state + events." The
 * census scored that BUILT-BUT-WRONG with a precise reason — the two projections
 * that exist are computed per request and cache nothing, which is stronger than
 * rebuildable, but "there are NO EVENTS to rebuild from" (T195).
 *
 * So the simulator emits an event log, and `foldEvents` rebuilds the whole state
 * from it. The suite asserts the fold equals the state the commands produced.
 * That is the rebuildability property, executed — on a model, which is what the
 * tree currently supports, and the model says so rather than implying the real
 * system has an event log.
 */

import type { ReplayEvent, ReplayState } from "../contracts/replay.js";

export const REPLAY_EVENT_KINDS = [
  "message.created",
  "message.unsent",
  "message.unsend_refused",
  "message.delivered",
  "message.seen",
  "message.translated",
  "media.ready",
  "connection.dropped",
  "connection.restored",
  "member.removed",
  "location.expired",
  "plan.changed",
  "user.blocked",
  "send.refused",
] as const;

/** Canonical block key: order-independent, so a block is one entry either way. */
export function blockKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function emptyState(): ReplayState {
  return {
    clock: 0,
    messages: {},
    memberships: {},
    blocks: [],
    connected: {},
    plans: {},
    locationShares: {},
  };
}

/**
 * Rebuild state from the event log alone.
 *
 * `seed` carries the facts no event creates — the thread roster as it existed
 * before the first command, and the location shares that were already open.
 * That is the "canonical state +" half of §29's phrase, and separating it from
 * the event half is the point: a fold that needed the final state to rebuild the
 * final state would prove nothing.
 */
export function foldEvents(seed: ReplayState, events: readonly ReplayEvent[]): ReplayState {
  const s: ReplayState = {
    clock: 0,
    messages: {},
    memberships: Object.fromEntries(
      Object.entries(seed.memberships).map(([k, v]) => [k, { ...v, leftAt: null }]),
    ),
    blocks: [],
    connected: Object.fromEntries(Object.keys(seed.connected).map((u) => [u, true])),
    plans: Object.fromEntries(Object.entries(seed.plans).map(([k, v]) => [k, { ...v }])),
    locationShares: Object.fromEntries(
      Object.entries(seed.locationShares).map(([k, v]) => [k, { ...v, revoked: false }]),
    ),
  };

  for (const e of events) {
    s.clock = Math.max(s.clock, e.at);
    switch (e.kind) {
      case "message.created":
        s.messages[e.messageId!] = {
          id: e.messageId!,
          threadId: e.threadId!,
          senderId: e.actor,
          createdAt: e.at,
          unsentAt: null,
          seenBy: [],
          deliveredTo: [],
          translationStatus: "none",
          mediaStatus: e.withMedia ? "processing" : "none",
        };
        break;
      case "message.delivered": {
        const m = s.messages[e.messageId!];
        if (m && !m.deliveredTo.includes(e.targetUserId!)) m.deliveredTo.push(e.targetUserId!);
        break;
      }
      case "message.seen": {
        const m = s.messages[e.messageId!];
        if (m && !m.seenBy.includes(e.targetUserId!)) m.seenBy.push(e.targetUserId!);
        break;
      }
      case "message.unsent": {
        const m = s.messages[e.messageId!];
        if (m) m.unsentAt = e.at;
        break;
      }
      case "message.translated": {
        const m = s.messages[e.messageId!];
        if (m) m.translationStatus = "done";
        break;
      }
      case "media.ready": {
        const m = s.messages[e.messageId!];
        if (m) m.mediaStatus = "ready";
        break;
      }
      case "connection.dropped":
        s.connected[e.actor] = false;
        break;
      case "connection.restored":
        s.connected[e.actor] = true;
        break;
      case "member.removed": {
        const k = `${e.threadId}:${e.targetUserId}`;
        if (s.memberships[k]) s.memberships[k].leftAt = e.at;
        break;
      }
      case "location.expired": {
        const share = s.locationShares[e.actor];
        if (share) share.revoked = true;
        break;
      }
      case "plan.changed": {
        const p = s.plans[e.planId!];
        if (p) {
          p.version += 1;
          p.status = "changed";
        }
        break;
      }
      case "user.blocked": {
        const key = blockKey(e.actor, e.targetUserId!);
        if (!s.blocks.includes(key)) s.blocks.push(key);
        break;
      }
      case "message.unsend_refused":
      case "send.refused":
        // A refusal changes no state. It is in the log because an operator
        // needs to see that it happened, and because a fold that silently
        // ignored refusals could not be distinguished from one that applied
        // them — which is the bug this case exists to make impossible.
        break;
    }
  }

  // Sorted so two states that differ only in insertion order compare equal.
  s.blocks.sort();
  for (const m of Object.values(s.messages)) {
    m.seenBy.sort();
    m.deliveredTo.sort();
  }
  return s;
}
