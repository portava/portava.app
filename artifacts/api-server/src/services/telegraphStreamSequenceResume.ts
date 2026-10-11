/**
 * The SSE stream's replay on the SEQUENCE cursor (census-telegraph T233, §71).
 *
 * §68 gave each conversation a resume by sequence over REST
 * (`GET /threads/:id/messages?afterSequence=N`); the stream itself still replayed
 * by TIMESTAMP — inclusive at the boundary (a duplicate re-sent rather than a row
 * risked), across every live thread. This module lets a reconnecting client name
 * the sequence it acknowledged per conversation, and replays exactly what came
 * after it.
 *
 * THE CURSORS TRAVEL IN A HEADER, never the URL (`x-telegraph-sequence-cursors:
 * <thread uuid>:<sequence>,…`, at most 50): conversation ids do not belong in
 * access logs.
 *
 * WHAT A CURSOR CAN REACH. Only threads the caller is a LIVE member of, read in
 * the same roster query the stream's own replay uses, with the same §14.3
 * window. A cursor naming any other thread is dropped SILENTLY and is absent
 * from the answer — the answer never says which named threads were refused, so
 * it is not an oracle for thread existence or membership. Like the REST resume
 * (PR-TREL-1), a sequence replay never carries a message across a block in
 * either direction; unreadable block state fails the whole sequence replay
 * (the timestamp replay then covers those threads, as before).
 *
 * BOUNDED: 50 rows per thread, 200 in all. A thread that had more answers
 * `hasMore: true` with its `nextSequence`; the client pages it over REST. The
 * cursor advances past rows the caller may not see (a window, a block, their
 * own sends — which are not replayed as frames), decided on the raw read.
 */
import { historyBoundEnabled, visibleFromOf, withinWindow } from "./groupChatHistoryBound.js";
import { dropBlockedSenders, resumeSummary } from "./telegraphReliability.js";
import { parseSequenceCursor } from "./telegraphMessageKernel.js";

export const SEQUENCE_CURSOR_HEADER = "x-telegraph-sequence-cursors";
export const MAX_SEQUENCE_CURSORS = 50;
export const SEQUENCE_REPLAY_PER_THREAD = 50;
export const SEQUENCE_REPLAY_TOTAL = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parse the header. Malformed entries are dropped; at most MAX_SEQUENCE_CURSORS are kept. */
export function parseSequenceCursors(raw: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 4096) return out;
  for (const part of raw.split(",")) {
    if (out.size >= MAX_SEQUENCE_CURSORS) break;
    const [tid, seqRaw] = part.trim().split(":");
    if (!tid || !UUID.test(tid)) continue;
    const seq = parseSequenceCursor(seqRaw);
    if (seq === null) continue;
    out.set(tid.toLowerCase(), seq);
  }
  return out;
}

export interface SequenceFrameRow {
  id: string;
  thread_id: string;
  sender_id: string;
  msg_type: string | null;
  subtype: string | null;
  created_at: string;
  sequence: number;
}

export type SequenceResume =
  | { ok: true; frames: SequenceFrameRow[]; threads: Record<string, { nextSequence: number; hasMore: boolean }> }
  | { ok: false; reason: "read_failed" | "blocks_unreadable" };

export async function readSequenceResume(sc: any, userId: string, cursors: ReadonlyMap<string, number>): Promise<SequenceResume> {
  const named = [...cursors.keys()];
  if (named.length === 0) return { ok: true, frames: [], threads: {} };
  const boundOn = await historyBoundEnabled(sc);
  const rosterQuery = boundOn
    ? sc.from("message_thread_members").select("thread_id, visible_from_at")
    : sc.from("message_thread_members").select("thread_id");
  const { data: memberRows, error: memberErr } = await rosterQuery
    .eq("user_id", userId)
    .is("left_at", null)
    .in("thread_id", named);
  if (memberErr) return { ok: false, reason: "read_failed" };

  const frames: SequenceFrameRow[] = [];
  const threads: Record<string, { nextSequence: number; hasMore: boolean }> = {};
  let budget = SEQUENCE_REPLAY_TOTAL;
  for (const m of (memberRows ?? []) as Array<{ thread_id?: string; visible_from_at?: string | null }>) {
    const tid = typeof m.thread_id === "string" ? m.thread_id.toLowerCase() : null;
    if (!tid || !cursors.has(tid)) continue;
    const after = cursors.get(tid)!;
    const page = Math.min(SEQUENCE_REPLAY_PER_THREAD, budget);
    if (page <= 0) { threads[tid] = { nextSequence: after, hasMore: true }; continue; }
    const { data, error } = await sc
      .from("messages")
      .select("id,thread_id,sender_id,msg_type,subtype,created_at,sequence")
      .eq("thread_id", m.thread_id)
      .gt("sequence", after)
      .order("sequence", { ascending: true })
      .limit(page + 1);
    if (error) return { ok: false, reason: "read_failed" };
    const raw = (data ?? []) as SequenceFrameRow[];
    const summary = resumeSummary(raw, after, page);
    budget -= summary.scanned;
    threads[tid] = { nextSequence: summary.nextSequence, hasMore: summary.hasMore };
    const visibleFrom = visibleFromOf(m, boundOn);
    const windowed = raw.slice(0, page).filter((r) =>
      withinWindow(r.created_at, visibleFrom, { senderId: r.sender_id, viewerId: userId }) && r.sender_id !== userId);
    frames.push(...windowed);
  }
  const kept = await dropBlockedSenders(sc, userId, frames);
  if (!kept.ok) return { ok: false, reason: "blocks_unreadable" };
  return { ok: true, frames: kept.rows, threads };
}
