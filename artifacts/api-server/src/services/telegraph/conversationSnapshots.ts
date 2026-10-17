/**
 * Telegraph §12 `conversation_snapshots` — "Rebuild/replay checkpoints where
 * useful" (census-telegraph T155, migration 3998).
 *
 * WHERE: the coordination view's session read. It takes a conversation's
 * COORDINATION_SESSION and COORDINATION_TRANSITION messages newest first,
 * capped at SESSION_SCAN_LIMIT, and says `sessionScanTruncated` when the cap is
 * hit — at which point the fold (`projectConversationSessions`) is running on a
 * prefix of the evening: a long session's opening transitions, or an earlier
 * session, are simply not in its input. census-telegraph §33.7 named that number
 * as what would make a checkpoint useful. This is the checkpoint.
 *
 * WHAT A CHECKPOINT IS HERE. The fold's input through a (created_at, id)
 * cursor: every live session-kind row of the thread up to it, stored once by
 * `telegraph_write_conversation_snapshot` (3998). The read takes the checkpoint,
 * REPLAYS only the rows after the cursor (the same bounded, windowed query), and
 * hands the union to the same projection. The fold itself cannot be stored
 * pre-folded: its starting state is the plan's DERIVED state at read time, so the
 * honest checkpoint of `projectConversationSessions` is its input.
 *
 * A COPY THAT CANNOT OUTLIVE ITS SOURCE. 3998's four triggers delete a thread's
 * checkpoint in the same transaction as any edit, unsend, delete (account
 * deletion's cascade included) or backdated insert of a session-kind message,
 * under the same per-thread lock the writer takes. The read applies each
 * viewer's §14.3 window to checkpointed rows exactly as it does to live ones.
 *
 * OFF: `telegraph_conversation_snapshots_enabled` not ON (seeded FALSE) — the
 * caller's own live read runs, and nothing here touches the snapshot table.
 * A checkpoint that cannot be read, or reads malformed, falls back to the same
 * live read and says so; it is never a reason to answer less than that read.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { readFlagState } from "../../lib/featureFlags.js";
import { applyHistoryWindow, withinWindow } from "../groupChatHistoryBound.js";
import { parseCoordinationEnvelope } from "./coordination.js";

export const CONVERSATION_SNAPSHOTS_FLAG = "telegraph_conversation_snapshots_enabled";
/** 3998's closed `projection` list. */
export const COORDINATION_SNAPSHOT_PROJECTION = "coordination_sessions";
/** The message kinds the coordination fold reads, and the only ones a checkpoint holds. */
export const COORDINATION_SESSION_KINDS = ["coordination_session", "coordination_transition"] as const;
/** 3998's `row_count` ceiling (pinned equal to the migration by test). */
export const SNAPSHOT_ROW_CAP = 2000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A PostgREST timestamptz, and nothing that could become filter syntax. */
const INSTANT = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/;

export interface SessionKindRows {
  sessions: any[];
  transitions: any[];
  truncated: boolean;
}

/** How the session read used the checkpoint. Carried on the response so the fold's input is never a mystery. */
export interface SessionSnapshotUse {
  /** True when the rows came from a checkpoint plus the replayed tail. */
  used: boolean;
  /** Why not, when not: the flag, an unreadable/malformed checkpoint, none needed, or the writer's refusal. */
  reason: "off" | "flag_unreadable" | "not_needed" | "unreadable" | "malformed" | "not_written" | null;
  throughCreatedAt: string | null;
  /** Checkpointed rows (before this viewer's window); 0 when not used. */
  checkpointRows: number;
  /** What the writer answered when this read asked it to advance, or null. */
  writer: string | null;
}

export type CheckpointedSessionRows =
  | ({ ok: true; snapshot: SessionSnapshotUse } & SessionKindRows)
  | { ok: false; message: string };

interface Checkpoint {
  throughCreatedAt: string;
  throughMessageId: string;
  rows: any[];
}

/**
 * A sortable key for a PostgREST instant, to the MICROSECOND: Date.parse stops
 * at milliseconds, and two rows inside one millisecond are ordered by the
 * database, so the cursor comparison must not collapse them.
 */
export function instantKey(s: string): number {
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return NaN;
  const frac = /\.(\d+)/.exec(s)?.[1] ?? "";
  const micros = Number((frac + "000000").slice(0, 6)) % 1000;
  return ms * 1000 + micros;
}

/** True when a row is strictly after the cursor, by (created_at, id) — the writer's own order. */
export function isAfterCursor(row: { created_at?: unknown; id?: unknown }, cp: Pick<Checkpoint, "throughCreatedAt" | "throughMessageId">): boolean {
  const a = instantKey(String(row.created_at ?? ""));
  const c = instantKey(cp.throughCreatedAt);
  if (!Number.isFinite(a) || !Number.isFinite(c)) return false;
  if (a !== c) return a > c;
  return String(row.id ?? "") > cp.throughMessageId;
}

/** The checkpoint row, validated; `malformed` is never used. */
export function checkpointFrom(row: unknown): Checkpoint | "malformed" {
  const r = row as Record<string, unknown> | null;
  if (!r) return "malformed";
  const at = r.through_created_at;
  const id = r.through_message_id;
  const rows = r.rows;
  if (typeof at !== "string" || !INSTANT.test(at) || typeof id !== "string" || !UUID.test(id)) return "malformed";
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > SNAPSHOT_ROW_CAP || rows.length !== Number(r.row_count)) return "malformed";
  for (const x of rows) {
    if (!x || typeof x !== "object" || typeof (x as any).id !== "string" || typeof (x as any).created_at !== "string") return "malformed";
    if (!(COORDINATION_SESSION_KINDS as readonly string[]).includes(String((x as any).msg_type))) return "malformed";
  }
  return { throughCreatedAt: at, throughMessageId: id, rows };
}

/** Rows → the route's two lists, through the same envelope parser the live read uses. */
export function splitSessionKindRows(rows: readonly any[]): { sessions: any[]; transitions: any[] } {
  const sessions: any[] = [];
  const transitions: any[] = [];
  for (const r of rows) {
    const env = parseCoordinationEnvelope(r.msg_type, r.body);
    if (!env) continue;
    if (env.kind === "COORDINATION_SESSION") sessions.push({ ...r, kind: env.kind, payload: env.payload });
    else if (env.kind === "COORDINATION_TRANSITION") transitions.push({ ...r, kind: env.kind, payload: env.payload });
  }
  return { sessions, transitions };
}

async function readCheckpoint(client: SupabaseClient, threadId: string): Promise<Checkpoint | null | "unreadable" | "malformed"> {
  const { data, error } = await client
    .from("conversation_snapshots")
    .select("through_created_at, through_message_id, row_count, rows")
    .eq("thread_id", threadId)
    .eq("projection", COORDINATION_SNAPSHOT_PROJECTION)
    .maybeSingle();
  if (error) return "unreadable";
  if (!data) return null;
  return checkpointFrom(data);
}

async function writeCheckpoint(client: SupabaseClient, threadId: string): Promise<string> {
  const { data, error } = await client.rpc("telegraph_write_conversation_snapshot", {
    p_thread_id: threadId,
    p_projection: COORDINATION_SNAPSHOT_PROJECTION,
  });
  if (error) return "error";
  const outcome = (data as { outcome?: unknown } | null)?.outcome;
  return typeof outcome === "string" ? outcome : "error";
}

/**
 * The rows after the cursor, newest first, bounded by `tailLimit` and by the
 * viewer's §14.3 window in the query (Q6, as the live read applies it). `gte`
 * on the instant and a strict (created_at, id) test here, so a row sharing the
 * cursor's instant is replayed exactly when the writer did not fold it.
 */
async function readTail(
  client: SupabaseClient,
  cp: Checkpoint,
  input: { threadId: string; visibleFrom: string | null; viewerId: string; columns: string; tailLimit: number },
): Promise<{ ok: true; rows: any[]; truncated: boolean } | { ok: false; message: string }> {
  let q = client
    .from("messages")
    .select(input.columns)
    .eq("thread_id", input.threadId)
    .in("msg_type", [...COORDINATION_SESSION_KINDS])
    .is("deleted_at", null)
    .gte("created_at", cp.throughCreatedAt)
    .order("created_at", { ascending: false })
    .limit(input.tailLimit);
  q = applyHistoryWindow(q, input.visibleFrom, input.viewerId);
  const { data, error } = await q;
  if (error) return { ok: false, message: error.message ?? "session tail read failed" };
  const raw = (data as any[] | null) ?? [];
  return { ok: true, rows: raw.filter((r) => isAfterCursor(r, cp)), truncated: raw.length >= input.tailLimit };
}

function windowed(rows: readonly any[], visibleFrom: string | null, viewerId: string): any[] {
  return rows.filter((r) => withinWindow(r.created_at, visibleFrom, { senderId: r.sender_id, viewerId }));
}

/**
 * The session-kind rows of one thread, through the checkpoint when the flag is
 * on, else exactly `readLive`.
 */
export async function readSessionRowsThroughCheckpoint(
  client: SupabaseClient,
  input: { threadId: string; visibleFrom: string | null; viewerId: string; columns: string; tailLimit: number },
  readLive: () => Promise<({ ok: true } & SessionKindRows) | { ok: false; message: string }>,
): Promise<CheckpointedSessionRows> {
  const notUsed = (reason: SessionSnapshotUse["reason"], writer: string | null = null): SessionSnapshotUse =>
    ({ used: false, reason, throughCreatedAt: null, checkpointRows: 0, writer });
  const live = async (reason: SessionSnapshotUse["reason"], writer: string | null = null): Promise<CheckpointedSessionRows> => {
    const r = await readLive();
    return r.ok ? { ...r, snapshot: notUsed(reason, writer) } : r;
  };

  const flag = await readFlagState(client, "telegraph_conversation_snapshots_enabled"); // CONVERSATION_SNAPSHOTS_FLAG, as a literal for check:flag-polarity
  if (flag !== "on") return live(flag === "unknown" ? "flag_unreadable" : "off");

  const fromCheckpoint = async (cp: Checkpoint, writer: string | null): Promise<CheckpointedSessionRows | { tailTruncated: true }> => {
    const tail = await readTail(client, cp, input);
    if (!tail.ok) return tail;
    if (tail.truncated && writer === null) return { tailTruncated: true };
    const rows = [...windowed(cp.rows, input.visibleFrom, input.viewerId), ...windowed(tail.rows, input.visibleFrom, input.viewerId)];
    return {
      ok: true,
      ...splitSessionKindRows(rows),
      truncated: tail.truncated,
      snapshot: { used: true, reason: null, throughCreatedAt: cp.throughCreatedAt, checkpointRows: cp.rows.length, writer },
    };
  };

  let cp = await readCheckpoint(client, input.threadId);
  if (cp === "unreadable" || cp === "malformed") return live(cp);

  if (cp === null) {
    const first = await readLive();
    if (!first.ok) return first;
    if (!first.truncated) return { ...first, snapshot: notUsed("not_needed") };
  } else {
    const r = await fromCheckpoint(cp, null);
    if (!("tailTruncated" in r)) return r;
  }

  // The live read, or the tail after the checkpoint, hit the cap: advance the
  // checkpoint once, then read through it. A refusal leaves the live read's
  // answer — truncation stated — rather than a guess.
  const writer = await writeCheckpoint(client, input.threadId);
  if (writer !== "written") return live("not_written", writer);
  cp = await readCheckpoint(client, input.threadId);
  if (cp === "unreadable" || cp === "malformed") return live(cp, writer);
  if (cp === null) return live("not_written", writer);
  const r = await fromCheckpoint(cp, writer);
  return "tailTruncated" in r ? live("not_written", writer) : r;
}
