/**
 * Telegraph §30A.18 — the ten replay operations, as constructors.
 *
 * Constructors rather than object literals for one reason that matters: the
 * logical clock. A replay is only deterministic if the ordering is the ONLY
 * thing a permutation changes, so `at` is assigned by the engine as it applies
 * each command, never by whoever wrote the command. A caller who could set a
 * timestamp could build a permutation whose events happen in an order the
 * permutation did not choose, and every convergence result after that would be
 * about a scenario nobody ran.
 *
 * The spec's list is the spec's list, in the spec's order. There are exactly ten
 * and `src/scripts/checkTelegraphCertification.ts` is not what keeps it at ten —
 * `src/test/telegraphReplaySimulator.test.ts` asserts the vocabulary matches
 * §30A.18's sentence, so adding an eleventh operation without deciding whether
 * the spec wants it turns that suite red.
 */

import type { ReplayCommand, ReplayCommandKind } from "../contracts/replay.js";

/** The ten, in the order §30A.18 writes them. */
export const REPLAY_COMMAND_KINDS: readonly ReplayCommandKind[] = [
  "SEND",
  "DISCONNECT",
  "UNSEND",
  "RECONNECT",
  "REMOVE_MEMBER",
  "LOCATION_EXPIRE",
  "PLAN_CHANGE",
  "BLOCK",
  "TRANSLATION_COMPLETE",
  "MEDIA_COMPLETE",
];

type Draft = Omit<ReplayCommand, "at">;

export const send = (actor: string, threadId: string, messageId: string, withMedia = false): Draft => ({
  kind: "SEND",
  actor,
  threadId,
  messageId,
  withMedia,
});

export const disconnect = (actor: string): Draft => ({ kind: "DISCONNECT", actor });

export const unsend = (actor: string, threadId: string, messageId: string): Draft => ({
  kind: "UNSEND",
  actor,
  threadId,
  messageId,
});

export const reconnect = (actor: string): Draft => ({ kind: "RECONNECT", actor });

export const removeMember = (actor: string, threadId: string, targetUserId: string): Draft => ({
  kind: "REMOVE_MEMBER",
  actor,
  threadId,
  targetUserId,
});

export const locationExpire = (actor: string): Draft => ({ kind: "LOCATION_EXPIRE", actor });

export const planChange = (actor: string, planId: string): Draft => ({
  kind: "PLAN_CHANGE",
  actor,
  planId,
});

export const block = (actor: string, targetUserId: string): Draft => ({
  kind: "BLOCK",
  actor,
  targetUserId,
});

export const translationComplete = (actor: string, messageId: string): Draft => ({
  kind: "TRANSLATION_COMPLETE",
  actor,
  messageId,
});

export const mediaComplete = (actor: string, messageId: string): Draft => ({
  kind: "MEDIA_COMPLETE",
  actor,
  messageId,
});

export type { Draft as ReplayCommandDraft };
