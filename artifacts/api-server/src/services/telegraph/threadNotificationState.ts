/**
 * Telegraph §30A.6 — read members' thread notification state, and write one
 * member's choice. The DECISION is `domain/telegraph/policies/threadNotificationPolicy.ts`;
 * this module only establishes the facts, and never presents a failed read as one.
 *
 * ── THE COLUMNS ARE NEVER NAMED WITHOUT THE FLAG ────────────────────────────
 * `notification_level` and `muted_until` exist only where migration 4090 is
 * applied. PostgREST answers an unknown column with 42703 and fails the WHOLE
 * statement, so with telegraph_thread_notification_policy_enabled OFF (the seed)
 * every select and update here names `muted_at` only — which every database has
 * — and MUTED / ALL keep working everywhere. Same shape as `membershipSelect`
 * (groupChatHistoryBound) and `originInsertColumns` (requestOrigin).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { isFlagEnabled } from "../../lib/featureFlags.js";
import {
  levelFromColumn,
  levelToColumn,
  type ThreadNotificationLevel,
  type ThreadNotificationState,
} from "../../domain/telegraph/policies/threadNotificationPolicy.js";

export const THREAD_NOTIFICATION_POLICY_FLAG = "telegraph_thread_notification_policy_enabled";

/** A tagged person with no active membership row: no thread choice applies to them. */
export const NO_THREAD_CHOICE: ThreadNotificationState = { level: null, mutedAt: null, mutedUntil: null };

type Row = { user_id?: unknown; muted_at?: unknown; notification_level?: unknown; muted_until?: unknown };

function stateOf(row: Row, levelsOn: boolean): ThreadNotificationState {
  return {
    level: levelsOn ? levelFromColumn(row.notification_level) : null,
    mutedAt: typeof row.muted_at === "string" ? row.muted_at : null,
    mutedUntil: levelsOn && typeof row.muted_until === "string" ? row.muted_until : null,
  };
}

export async function threadNotificationLevelsEnabled(sc: SupabaseClient): Promise<boolean> {
  return isFlagEnabled(sc, THREAD_NOTIFICATION_POLICY_FLAG);
}

/**
 * The thread notification state of each of `userIds` who is an ACTIVE member of
 * `threadId`. A user absent from the map has no active membership. `ok: false`
 * means the read failed — callers must not deliver on it as if nobody had muted.
 */
export async function readThreadNotificationStates(
  sc: SupabaseClient,
  threadId: string,
  userIds: readonly string[],
): Promise<{ ok: true; levelsOn: boolean; states: Map<string, ThreadNotificationState> } | { ok: false }> {
  const levelsOn = await threadNotificationLevelsEnabled(sc);
  if (userIds.length === 0) return { ok: true, levelsOn, states: new Map() };
  const base = levelsOn
    ? sc.from("message_thread_members").select("user_id, muted_at, notification_level, muted_until")
    : sc.from("message_thread_members").select("user_id, muted_at");
  const { data, error } = await base
    .eq("thread_id", threadId)
    .in("user_id", [...userIds])
    .is("left_at", null);
  if (error) return { ok: false };
  const states = new Map<string, ThreadNotificationState>();
  for (const row of (data ?? []) as Row[]) {
    if (typeof row.user_id === "string") states.set(row.user_id, stateOf(row, levelsOn));
  }
  return { ok: true, levelsOn, states };
}

export type WriteChoiceResult =
  | { ok: true; state: ThreadNotificationState; levelsOn: boolean }
  | { ok: false; code: "feature_disabled" | "db_error" | "not_written" };

/**
 * Write one member's choice and READ IT BACK — the answer is what the database
 * holds, never what was asked for.
 *
 * Flag OFF: only ALL and MUTED are expressible (through muted_at); MENTIONS,
 * IMPORTANT and a temporary mute are `feature_disabled`, refused rather than
 * silently stored as something else.
 * Flag ON: the level, the temporary mute and muted_at (kept equal to "MUTED" so
 * older readers — the inbox's mute icon — agree) are written together.
 */
export async function writeThreadNotificationChoice(
  sc: SupabaseClient,
  threadId: string,
  userId: string,
  choice: { level: ThreadNotificationLevel; muteForMinutes: number | null },
  nowMs: number,
): Promise<WriteChoiceResult> {
  const levelsOn = await threadNotificationLevelsEnabled(sc);
  const now = new Date(nowMs).toISOString();
  let patch: Record<string, string | null>;
  if (!levelsOn) {
    if (choice.muteForMinutes !== null || (choice.level !== "ALL" && choice.level !== "MUTED")) {
      return { ok: false, code: "feature_disabled" };
    }
    patch = { muted_at: choice.level === "MUTED" ? now : null };
  } else {
    patch = {
      notification_level: levelToColumn(choice.level),
      muted_until: choice.muteForMinutes === null ? null : new Date(nowMs + choice.muteForMinutes * 60_000).toISOString(),
      muted_at: choice.level === "MUTED" ? now : null,
    };
  }
  const { error } = await sc
    .from("message_thread_members")
    .update(patch)
    .eq("thread_id", threadId)
    .eq("user_id", userId)
    .is("left_at", null);
  if (error) return { ok: false, code: "db_error" };

  const readBack = await readThreadNotificationStates(sc, threadId, [userId]);
  if (!readBack.ok) return { ok: false, code: "db_error" };
  const state = readBack.states.get(userId);
  if (!state) return { ok: false, code: "not_written" };
  return { ok: true, state, levelsOn };
}
