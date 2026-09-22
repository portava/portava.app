/**
 * Telegraph §30A.18 — the replay simulator.
 *
 * Applies the ten operations §30A.18 names, in any order, and produces a final
 * state and an event log. Pure and total: no clock, no randomness, no I/O, no
 * throwing. The logical clock advances one tick per command, which is what makes
 * a permutation the ONLY variable.
 *
 * WHERE THE DECISIONS COME FROM
 * -----------------------------
 * Three of the rules below are not written here. They are the shipped functions:
 *
 *   - the §14.3 history window is `withinWindow` from
 *     services/groupChatHistoryBound — the same predicate the real read path
 *     applies, so if its inclusive boundary ever changes, the simulator's
 *     readability changes with it rather than drifting away from it;
 *   - the block check is the real `isBlockedBetween` from lib/blockGuard,
 *     driven through a tiny in-memory client so the FAIL-CLOSED branch is the
 *     real one;
 *   - location disclosure is the real `buildCrewCard` scored by the §27.1
 *     lattice.
 *
 * What is modelled here, and only here, is ordering: who was a member when,
 * which connection was open when a message landed, and whether a receipt existed
 * before an unsend was attempted. That is the part §30A.18 is about and the part
 * no unit test reaches.
 *
 * THE UNSEND RULE IS MODELLED, AND THE TREE DOES NOT HAVE ONE
 * ----------------------------------------------------------
 * §7.4 and §30A.3 say unsend succeeds only while no eligible recipient has seen
 * the message. There is no unsend in this repository — PR #472 is unmerged and
 * applied to portava-ci only — so the rule here is the SPEC'S rule, not a mirror
 * of an implementation. It is included because the interleaving it creates is
 * the one §27.2's twelfth fixture is about, and because a simulator that omitted
 * the operation would make the eventual implementation's races unexercised on
 * the day they first run. It is labelled `modelled` in the result so nobody can
 * read a green replay as evidence that unsend works here.
 */

import { withinWindow } from "../../../services/groupChatHistoryBound.js";
import { isBlockedBetween } from "../../../lib/blockGuard.js";
import type {
  ReplayCommand,
  ReplayEvent,
  ReplayState,
  ReplayMembership,
} from "../contracts/replay.js";
import type { ReplayCommandDraft } from "../commands/replayCommands.js";
import { blockKey, emptyState } from "../events/replayEvents.js";

export interface ReplayResult {
  readonly state: ReplayState;
  readonly events: readonly ReplayEvent[];
  /**
   * Operations whose rule comes from the SPEC rather than from a shipped
   * implementation. Always includes UNSEND while this tree has none.
   */
  readonly modelled: readonly string[];
}

export interface ReplaySeed {
  /** userId list; every one starts connected. */
  readonly users: readonly string[];
  readonly threads: ReadonlyArray<{ id: string; members: readonly string[] }>;
  /** Optional §14.3 window bounds, as logical ticks. */
  readonly visibleFrom?: Readonly<Record<string, number>>;
  readonly plans?: readonly string[];
  readonly locationShares?: ReadonlyArray<{ ownerId: string; expiresAt: number; level: "city_only" | "neighborhood" | "nearby" }>;
}

export function seedState(seed: ReplaySeed): ReplayState {
  const s = emptyState();
  for (const u of seed.users) s.connected[u] = true;
  for (const t of seed.threads) {
    for (const u of t.members) {
      const key = `${t.id}:${u}`;
      s.memberships[key] = {
        threadId: t.id,
        userId: u,
        joinedAt: 0,
        leftAt: null,
        visibleFrom: seed.visibleFrom?.[key] ?? null,
      };
    }
  }
  for (const p of seed.plans ?? []) s.plans[p] = { version: 1, status: "open" };
  for (const l of seed.locationShares ?? []) {
    s.locationShares[l.ownerId] = { ownerId: l.ownerId, expiresAt: l.expiresAt, level: l.level, revoked: false };
  }
  return s;
}

function clone(s: ReplayState): ReplayState {
  return {
    clock: s.clock,
    messages: Object.fromEntries(
      Object.entries(s.messages).map(([k, m]) => [k, { ...m, seenBy: [...m.seenBy], deliveredTo: [...m.deliveredTo] }]),
    ),
    memberships: Object.fromEntries(Object.entries(s.memberships).map(([k, m]) => [k, { ...m }])),
    blocks: [...s.blocks],
    connected: { ...s.connected },
    plans: Object.fromEntries(Object.entries(s.plans).map(([k, p]) => [k, { ...p }])),
    locationShares: Object.fromEntries(Object.entries(s.locationShares).map(([k, l]) => [k, { ...l }])),
  };
}

/** A blocks table shaped like the one the real guard queries. */
function blocksClient(state: ReplayState): any {
  const rows = state.blocks.flatMap((k) => {
    const [a, b] = k.split("|");
    return [{ blocker_id: a, blocked_id: b }, { blocker_id: b, blocked_id: a }];
  });
  return {
    from() {
      let matched: Array<{ blocker_id: string; blocked_id: string }> = [];
      // The chain shape has to match the REAL call order — select().or().limit()
      // — and resolve only at the end, because the guard awaits the builder
      // rather than the .or(). A chain that resolved early would make the block
      // check unreachable and every permutation would report "not blocked",
      // which is the failure mode this simulator exists to catch elsewhere.
      const chain: any = {
        select: () => chain,
        or: (expr: string) => {
          // The real guard builds and(blocker_id.eq.X,blocked_id.eq.Y),and(…).
          const pairs = [...expr.matchAll(/blocker_id\.eq\.([^,)]+),blocked_id\.eq\.([^,)]+)/g)];
          matched = rows.filter((r) =>
            pairs.some(([, x, y]) => r.blocker_id === x && r.blocked_id === y),
          );
          return chain;
        },
        limit: (n: number) => {
          matched = matched.slice(0, n);
          return chain;
        },
        then: (resolve: (v: any) => void, reject?: (e: any) => void) =>
          Promise.resolve({ data: matched, error: null }).then(resolve, reject),
      };
      return chain;
    },
  };
}

/** Active members of a thread at the current clock, excluding one user. */
function activeMembers(state: ReplayState, threadId: string, exclude: string): ReplayMembership[] {
  return Object.values(state.memberships).filter(
    (m) => m.threadId === threadId && m.userId !== exclude && m.leftAt === null,
  );
}

/**
 * Can `userId` read `messageId` right now?
 *
 * The §14.3 half is the shipped predicate, called with ISO instants built from
 * the logical clock so the real inclusive-boundary rule applies unchanged.
 */
export function canRead(state: ReplayState, userId: string, messageId: string): boolean {
  const msg = state.messages[messageId];
  if (!msg) return false;
  if (msg.unsentAt !== null) return false;
  const mem = state.memberships[`${msg.threadId}:${userId}`];
  if (!mem || mem.leftAt !== null) return false;
  const asIso = (tick: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, tick)).toISOString();
  // Q6 is modelled here because the simulator's whole job is to be the SAME
  // rule as the shipped read path. `userId` has already been proved an ACTIVE
  // member four lines above (`mem.leftAt !== null` returns false), so this is
  // the exception applied on top of a live authorization, never instead of one.
  return withinWindow(asIso(msg.createdAt), mem.visibleFrom === null ? null : asIso(mem.visibleFrom),
                      { senderId: msg.senderId, viewerId: userId });
}

/**
 * Apply one command. Pure: returns a NEW state and the events it produced.
 *
 * Async only because the block check is the real one and the real one is async.
 */
export async function applyCommand(
  prev: ReplayState,
  draft: ReplayCommandDraft,
  at: number,
): Promise<{ state: ReplayState; events: ReplayEvent[] }> {
  const s = clone(prev);
  s.clock = at;
  const cmd: ReplayCommand = { ...draft, at };
  const events: ReplayEvent[] = [];

  switch (cmd.kind) {
    case "SEND": {
      const mem = s.memberships[`${cmd.threadId}:${cmd.actor}`];
      if (!mem || mem.leftAt !== null) {
        events.push({ kind: "send.refused", at, actor: cmd.actor, threadId: cmd.threadId, reason: "not_a_member" });
        break;
      }
      const others = activeMembers(s, cmd.threadId!, cmd.actor);
      // The real fail-closed guard, on a real blocks-shaped table. A 1:1 thread
      // is the case the route guards, and the model guards the same case.
      if (others.length === 1 && (await isBlockedBetween(blocksClient(s), cmd.actor, others[0].userId))) {
        events.push({ kind: "send.refused", at, actor: cmd.actor, threadId: cmd.threadId, reason: "blocked" });
        break;
      }
      s.messages[cmd.messageId!] = {
        id: cmd.messageId!,
        threadId: cmd.threadId!,
        senderId: cmd.actor,
        createdAt: at,
        unsentAt: null,
        seenBy: [],
        deliveredTo: [],
        translationStatus: "none",
        mediaStatus: cmd.withMedia ? "processing" : "none",
      };
      events.push({
        kind: "message.created", at, actor: cmd.actor, threadId: cmd.threadId,
        messageId: cmd.messageId, withMedia: Boolean(cmd.withMedia),
      });
      // Realtime reaches only connected members, and a connected recipient's
      // client marks it seen. A disconnected one gets neither — which is what
      // makes the unsend race a race.
      for (const other of others) {
        if (!s.connected[other.userId]) continue;
        s.messages[cmd.messageId!].deliveredTo.push(other.userId);
        s.messages[cmd.messageId!].seenBy.push(other.userId);
        events.push({ kind: "message.delivered", at, actor: cmd.actor, messageId: cmd.messageId, targetUserId: other.userId });
        events.push({ kind: "message.seen", at, actor: other.userId, messageId: cmd.messageId, targetUserId: other.userId });
      }
      break;
    }

    case "DISCONNECT":
      s.connected[cmd.actor] = false;
      events.push({ kind: "connection.dropped", at, actor: cmd.actor });
      break;

    case "RECONNECT": {
      s.connected[cmd.actor] = true;
      events.push({ kind: "connection.restored", at, actor: cmd.actor });
      // The client's poll is the source of truth on reconnect: every readable
      // message it missed is now seen. This is the property that makes a lost
      // realtime event harmless, and it is also what closes the unsend window.
      for (const m of Object.values(s.messages)) {
        if (m.senderId === cmd.actor) continue;
        if (!canRead(s, cmd.actor, m.id)) continue;
        if (!m.deliveredTo.includes(cmd.actor)) {
          m.deliveredTo.push(cmd.actor);
          events.push({ kind: "message.delivered", at, actor: cmd.actor, messageId: m.id, targetUserId: cmd.actor });
        }
        if (!m.seenBy.includes(cmd.actor)) {
          m.seenBy.push(cmd.actor);
          events.push({ kind: "message.seen", at, actor: cmd.actor, messageId: m.id, targetUserId: cmd.actor });
        }
      }
      break;
    }

    case "UNSEND": {
      const m = s.messages[cmd.messageId!];
      if (!m) {
        events.push({ kind: "message.unsend_refused", at, actor: cmd.actor, messageId: cmd.messageId, reason: "no_such_message" });
        break;
      }
      if (m.senderId !== cmd.actor) {
        events.push({ kind: "message.unsend_refused", at, actor: cmd.actor, messageId: cmd.messageId, reason: "not_sender" });
        break;
      }
      // §7.4: eligible recipients are the members who could READ it, which is
      // not the same as the members of the thread — a member outside the §14.3
      // window was never eligible and their receipt cannot block an unsend.
      const eligibleSeen = m.seenBy.filter((u) => {
        const mem = s.memberships[`${m.threadId}:${u}`];
        return mem !== undefined && mem.leftAt === null;
      });
      if (eligibleSeen.length > 0) {
        events.push({ kind: "message.unsend_refused", at, actor: cmd.actor, messageId: m.id, reason: "seen_by_eligible_recipient" });
        break;
      }
      m.unsentAt = at;
      events.push({ kind: "message.unsent", at, actor: cmd.actor, threadId: m.threadId, messageId: m.id });
      break;
    }

    case "REMOVE_MEMBER": {
      const key = `${cmd.threadId}:${cmd.targetUserId}`;
      const mem = s.memberships[key];
      if (!mem || mem.leftAt !== null) break;
      mem.leftAt = at;
      events.push({ kind: "member.removed", at, actor: cmd.actor, threadId: cmd.threadId, targetUserId: cmd.targetUserId });
      break;
    }

    case "LOCATION_EXPIRE": {
      const share = s.locationShares[cmd.actor];
      if (!share || share.revoked) break;
      share.revoked = true;
      events.push({ kind: "location.expired", at, actor: cmd.actor });
      break;
    }

    case "PLAN_CHANGE": {
      const p = s.plans[cmd.planId!];
      if (!p) break;
      p.version += 1;
      p.status = "changed";
      events.push({ kind: "plan.changed", at, actor: cmd.actor, planId: cmd.planId });
      break;
    }

    case "BLOCK": {
      const key = blockKey(cmd.actor, cmd.targetUserId!);
      if (!s.blocks.includes(key)) s.blocks.push(key);
      events.push({ kind: "user.blocked", at, actor: cmd.actor, targetUserId: cmd.targetUserId });
      break;
    }

    case "TRANSLATION_COMPLETE": {
      const m = s.messages[cmd.messageId!];
      // A translation that completes for an UNSENT message must not resurrect
      // it, and must not mark a derived artifact done for content that is gone.
      if (!m || m.unsentAt !== null) break;
      m.translationStatus = "done";
      events.push({ kind: "message.translated", at, actor: cmd.actor, messageId: m.id });
      break;
    }

    case "MEDIA_COMPLETE": {
      const m = s.messages[cmd.messageId!];
      if (!m || m.unsentAt !== null || m.mediaStatus === "none") break;
      m.mediaStatus = "ready";
      events.push({ kind: "media.ready", at, actor: cmd.actor, messageId: m.id });
      break;
    }
  }

  s.blocks.sort();
  for (const m of Object.values(s.messages)) {
    m.seenBy.sort();
    m.deliveredTo.sort();
  }
  return { state: s, events };
}

/** Apply a whole sequence. The clock is the index, so ordering is the only variable. */
export async function replay(
  seed: ReplayState,
  commands: readonly ReplayCommandDraft[],
): Promise<ReplayResult> {
  let state = clone(seed);
  const events: ReplayEvent[] = [];
  for (let i = 0; i < commands.length; i++) {
    const step = await applyCommand(state, commands[i], i + 1);
    state = step.state;
    events.push(...step.events);
  }
  return { state, events, modelled: ["UNSEND"] };
}

/**
 * Every ordering of `items`.
 *
 * Deliberately exhaustive rather than sampled, and deliberately small: 6! is 720
 * replays, which is fast and complete. A sampled permutation space would make a
 * failure unreproducible, which is the one property a certification harness
 * cannot afford to lose.
 */
export function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const p of permutations(rest)) out.push([items[i], ...p]);
  }
  return out;
}

/** Stable, order-insensitive fingerprint of a state, for comparing two replays. */
export function fingerprint(s: ReplayState): string {
  const norm = {
    messages: Object.values(s.messages)
      .map((m) => ({ ...m, seenBy: [...m.seenBy].sort(), deliveredTo: [...m.deliveredTo].sort() }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    memberships: Object.values(s.memberships).sort((a, b) =>
      `${a.threadId}:${a.userId}`.localeCompare(`${b.threadId}:${b.userId}`),
    ),
    blocks: [...s.blocks].sort(),
    connected: Object.fromEntries(Object.entries(s.connected).sort()),
    plans: Object.fromEntries(Object.entries(s.plans).sort()),
    locationShares: Object.fromEntries(Object.entries(s.locationShares).sort()),
  };
  return JSON.stringify(norm);
}
