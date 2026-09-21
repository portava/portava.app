/**
 * Telegraph §12.1 / §13.3 / §17.1 — the application side of migration 2810.
 *
 * This module exists for one reason and it is the same reason
 * `services/groupChatHistoryBound.ts` exists: a reader must be safe against a
 * database that has NOT run the migration. PostgREST rejects a select naming an
 * unknown column with 42703, so "read the column and cope with NULL" is not an
 * option — the query has to not NAME it.
 *
 * So every helper here takes the flag's value and, when it is FALSE:
 *   - `kernelColumns` returns the caller's ORIGINAL column list unchanged;
 *   - `applyLifecycleExclusion` returns the query untouched;
 *   - `sequenceOf` returns null.
 * A build carrying this code behaves identically on a database without 2810,
 * and `telegraph_message_kernel_enabled` can only exist — and therefore can only
 * be ON — in a database that has run it.
 *
 * WHY THE FLAG IS READ IN TWO PLACES AND THAT IS NOT DUPLICATION
 * =============================================================
 * 2810's triggers read the flag in plpgsql; this module reads it in TypeScript.
 * They are gating different things: the trigger decides whether a sequence is
 * ALLOCATED, this decides whether a reader may NAME the column. Turning the
 * flag on mid-flight is safe in either order — a reader that names the column
 * on a database where nothing has been allocated gets NULLs, which every
 * helper here already treats as "no sequence".
 *
 * WHAT IS DELIBERATELY NOT HERE
 * =============================
 * No writer. `routes/messaging.ts` still inserts exactly the columns it
 * inserted before 2810 and the trigger fills the rest; adding a writer here
 * would mean two places decide what a sequence is. And no outbox drainer:
 * consuming the outbox needs a worker with a cursor and a per-consumer offset,
 * which 2810 deliberately did not build (its header says so), and a half-built
 * drainer that acknowledges rows nobody projected would be worse than none.
 */

import { isFlagEnabled } from "../lib/featureFlags.js";

export const MESSAGE_KERNEL_FLAG = "telegraph_message_kernel_enabled";

/** §12.1's lifecycle vocabulary, exactly as 2810's CHECK constrains it. */
export const MESSAGE_LIFECYCLE_STATES = ["sent", "edited", "unsent", "deleted"] as const;
export type MessageLifecycleState = (typeof MESSAGE_LIFECYCLE_STATES)[number];

/** The columns 2810 adds to `public.messages`, for callers that need the list. */
export const KERNEL_MESSAGE_COLUMNS = [
  "sequence", "client_message_id", "idempotency_key", "content_ref", "unsent_at", "lifecycle_state",
] as const;

/**
 * Is the kernel in force on this database?
 *
 * `isFlagEnabled` is false-on-error, and that is the correct polarity here: an
 * unreadable `feature_flags` must leave every reader naming exactly the columns
 * it named before 2810, because the alternative — assuming the columns exist —
 * turns one bad flag read into a 42703 on every message query.
 */
export async function messageKernelEnabled(sc: any): Promise<boolean> {
  return isFlagEnabled(sc, MESSAGE_KERNEL_FLAG);
}

/**
 * Add the kernel's columns to a select list, or return it untouched.
 *
 * The same shape as `membershipSelect` in groupChatHistoryBound: the caller
 * passes what it would have selected anyway, so the OFF path is byte-identical
 * to the pre-migration query rather than merely equivalent.
 */
export function kernelColumns(baseColumns: string, enabled: boolean): string {
  return enabled ? `${baseColumns}, sequence, unsent_at, lifecycle_state` : baseColumns;
}

/**
 * §21: "Unsent/deleted/revoked objects must be removed from normal user search
 * and Compass retrieval."
 *
 * The deleted half has always been expressible (`deleted_at`). The UNSENT half
 * could not be — census T276 records exactly that — because there was no
 * column. This applies it when there is one, IN THE QUERY, for the same reason
 * the deleted filter is in the query: a row that reaches the process has
 * already consumed a limit slot and has already had its body in memory.
 *
 * Takes and returns the PostgREST builder so a caller chains it in place and
 * cannot accidentally apply it after `limit`.
 */
export function applyLifecycleExclusion<T>(query: T, enabled: boolean): T {
  if (!enabled) return query;
  return (query as any).is("unsent_at", null) as T;
}

/** The sequence on a row, or null when the kernel is off or nothing allocated. */
export function sequenceOf(row: { sequence?: number | string | null } | null | undefined, enabled: boolean): number | null {
  if (!enabled || !row) return null;
  const raw = row.sequence;
  if (raw === null || raw === undefined) return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * §17.2 "Reconnect resumes from last acknowledged conversation/event sequence."
 *
 * Parses a client-supplied cursor. Returns null for anything that is not a
 * non-negative integer — including a number dressed as a string with a sign or
 * a decimal — because a malformed cursor must mean "start from the beginning of
 * what you may see" and never "start from wherever this parses to". A resumed
 * stream that silently skips is the failure this is written to avoid.
 */
export function parseSequenceCursor(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}
