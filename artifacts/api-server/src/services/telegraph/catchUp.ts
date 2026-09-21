/**
 * Telegraph §20 — the conversation CATCH-UP.
 *
 * §20's Compass row names three integrations: "Authorized thread context,
 * meeting/recommendation tools, catch-up." census-telegraph T267 scored it
 * "Thread context and recommendation are real … Meeting tools (T248) and
 * catch-up do not exist." Meeting tools now DO exist — T248 and T245-T251 are
 * all C on `compass/TelegraphConversationTools.ts` — so the only member of that
 * row still missing is the catch-up, and this module is its server half.
 *
 * ── WHAT A CATCH-UP IS, AND WHAT IT REFUSES TO BE ───────────────────────────
 * "What did I miss" has an obvious cheap implementation — summarise the prose —
 * and §18.3 forbids exactly that: Compass "cannot … silently create canonical
 * plans from uncertain prose." So NOTHING here is read out of message text.
 * Every item this projection returns is either a COUNT or a TYPED object that
 * some route already validated on the way in: §8's decisions and commitments,
 * §9's coordination transitions, §6.2's announcements and safety signals, and
 * §5's shared Portava objects. `inferredFromProse` is a field on the response
 * and it is the constant `false`, asserted by test, because a later change that
 * started summarising text would otherwise be invisible to a consumer.
 *
 * ── WHERE A CATCH-UP STARTS, AND WHY THAT IS THREE ANSWERS ──────────────────
 * The obvious start is the reader's own `last_read_at`. It is not sufficient,
 * and the two other cases are not edge cases:
 *
 *   1. `read_marker`     — they have read this thread; start where they stopped.
 *   2. `history_window`  — §14.3 bounds what a member may see to their own join
 *                          (`visible_from_at`). A marker EARLIER than that bound
 *                          must not widen the catch-up: a person added to a crew
 *                          thread yesterday does not catch up on last month
 *                          because some earlier marker says so. `since` is
 *                          therefore `max(marker, windowFloor)`, and the basis
 *                          says which one won.
 *   3. `conversation_start` — no marker and no bound. The catch-up covers the
 *                          whole thread and SAYS so, rather than returning a
 *                          large number that reads like a backlog.
 *
 * A single nullable `since` would have collapsed all three into "null means
 * everything", which is the shape this census keeps finding: an absence
 * presented as a fact.
 *
 * ── WHAT IS COUNTED AS MISSED ───────────────────────────────────────────────
 * Messages strictly after `since`, not deleted, inside the viewer's §14.3
 * window, and NOT SENT BY THE VIEWER. A person did not miss what they wrote
 * themselves, and a catch-up that counted their own messages would tell
 * somebody who sent five messages and then closed the app that they missed
 * five things.
 *
 * The state of the CONVERSATION is a different question and is deliberately
 * NOT filtered the same way: a decision the viewer opened and nobody answered
 * still awaits them, so `needsYou` is computed over the whole visible thread
 * rather than over the missed slice. Counting and awaiting are two questions;
 * one filter cannot answer both.
 *
 * ── ONE PROJECTION, NOT A SECOND OPINION ────────────────────────────────────
 * `needsYou` and `safety` are NOT re-derived here. They are
 * `projectSemanticLayers` (§2.3's PLAN layer, which is by construction the
 * unresolved items for this viewer) and `projectSafetyMode`. A catch-up that
 * disagreed with the thread it summarises would be worse than no catch-up:
 * the traveller would open the conversation and find a different list. This is
 * the same rule `GET /me/commitments` follows for T84.
 */
import { parseCoordinationEnvelope, isLegalTransition } from "./coordination.js";
import type { CoordinationState } from "./vocabulary.js";
import { parseKindEnvelope } from "./messageKinds.js";
import {
  projectSemanticLayers,
  type LayerInputRow,
  type LayerItem,
} from "./layers.js";
import { projectSafetyMode, type SafetyMode } from "./safetyMode.js";
import { TELEGRAPH_SHARE_PRODUCERS } from "../../domain/telegraph/policies/shareAuthorizationPolicy.js";

// ── input ────────────────────────────────────────────────────────────────────

export interface CatchUpInputRow {
  id: string;
  sender_id: string;
  created_at: string;
  msg_type?: string | null;
  subtype?: string | null;
  body?: string | null;
}

/** Why the catch-up begins where it begins. Never inferred by the caller. */
export const CATCH_UP_BASES = ["read_marker", "history_window", "conversation_start"] as const;
export type CatchUpBasis = (typeof CATCH_UP_BASES)[number];

export interface CatchUpInput {
  threadId: string;
  viewerId: string;
  /** Every message the viewer may see, already §14.3-filtered by the caller. */
  rows: CatchUpInputRow[];
  /** The viewer's own `message_thread_members.last_read_at`, or null. */
  lastReadAt: string | null;
  /** The viewer's own §14.3 floor (`visible_from_at`), or null when unbounded. */
  windowFrom: string | null;
  nowMs: number;
  now?: Date;
}

// ── output ───────────────────────────────────────────────────────────────────

/** One typed thing that happened, named by its own message. */
export interface CatchUpRef {
  messageId: string;
  senderId: string;
  at: string;
  /** The typed kind that produced it — never a phrase lifted from the body. */
  kind: string;
  /** A title the sending route already validated, or null. Never summarised. */
  title: string | null;
}

export interface CatchUpTransition {
  at: string;
  by: string;
  from: CoordinationState | null;
  to: CoordinationState;
  /** False when §9's machine does not have this arrow — recorded, not hidden. */
  legal: boolean;
}

export interface CatchUpProjection {
  threadId: string;
  viewerId: string;
  generatedAt: string;
  /** Where this catch-up starts. */
  since: string | null;
  sinceBasis: CatchUpBasis;
  /** Messages after `since` that somebody else sent. */
  missedCount: number;
  /** Who sent them, most first. A catch-up is about people, not rows. */
  missedFrom: { userId: string; count: number }[];
  /** §8 decisions opened in the missed slice. */
  decisionsOpened: CatchUpRef[];
  /** §8 commitments made in the missed slice. */
  commitmentsMade: CatchUpRef[];
  /** §9 coordination moves in the missed slice, oldest first. */
  transitions: CatchUpTransition[];
  /** §5 Portava objects shared into the conversation in the missed slice. */
  shared: CatchUpRef[];
  /**
   * What still awaits THIS viewer — §2.3's PLAN layer, unfiltered by `since`,
   * because an unanswered question does not stop being unanswered because the
   * reader was present when it was asked.
   */
  needsYou: LayerItem[];
  /** §15.2's conversation mode right now, from the same fold `/safety-mode` serves. */
  safetyMode: SafetyMode;
  /** True when the mode was raised inside the missed slice. */
  safetyChangedWhileAway: boolean;
  /**
   * §18.3, stated in the response rather than promised in a comment: nothing
   * above was derived from message prose.
   */
  inferredFromProse: false;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function ms(v: string | null | undefined): number | null {
  if (typeof v !== "string") return null;
  const n = Date.parse(v);
  return Number.isNaN(n) ? null : n;
}

/** The later of two instants, treating an unparseable one as absent. */
function laterOf(a: string | null, b: string | null): { at: string | null; from: "a" | "b" | null } {
  const ma = ms(a);
  const mb = ms(b);
  if (ma === null && mb === null) return { at: null, from: null };
  if (mb === null) return { at: a, from: "a" };
  if (ma === null) return { at: b, from: "b" };
  return ma >= mb ? { at: a, from: "a" } : { at: b, from: "b" };
}

/**
 * What counts as "a Portava object was shared into this conversation".
 *
 * NOT a hand-written list. `TELEGRAPH_SHARE_PRODUCERS` is the registry
 * `check:telegraph-share-producers` keeps exhaustive against the tree — it
 * FAILS on any card literal either tree writes that is not declared — so
 * deriving the set from it means a new card family appears in the catch-up the
 * day it is registered rather than the day somebody remembers this file. A
 * producer with a null `sourceDomain` is chrome (text, system notices, call
 * receipts) and is deliberately excluded: it points at no source object, so
 * there is nothing that was shared.
 */
const SHARED_MSG_TYPES = new Set(
  TELEGRAPH_SHARE_PRODUCERS.filter((d) => d.column === "msg_type" && d.sourceDomain !== null).map(
    (d) => d.literal,
  ),
);
const SHARED_SUBTYPES = new Set(
  TELEGRAPH_SHARE_PRODUCERS.filter((d) => d.column === "subtype" && d.sourceDomain !== null).map(
    (d) => d.literal,
  ),
);

function sharedObjectKind(row: CatchUpInputRow): string | null {
  const t = typeof row.msg_type === "string" ? row.msg_type : null;
  const st = typeof row.subtype === "string" ? row.subtype : null;
  if (st && SHARED_SUBTYPES.has(st)) return st;
  if (t && SHARED_MSG_TYPES.has(t)) return t;
  return null;
}

function titleOf(payload: any): string | null {
  const t = payload?.title ?? payload?.what ?? payload?.question ?? payload?.label ?? null;
  return typeof t === "string" && t.length > 0 ? t : null;
}

// ── projection ───────────────────────────────────────────────────────────────

/**
 * §20's catch-up for one viewer of one conversation.
 *
 * The caller is responsible for membership and for applying §14.3 to `rows`;
 * this function applies the window a SECOND time to `since` so that a marker
 * from before the viewer's join cannot widen the answer even if a caller
 * forgot.
 */
export function projectCatchUp(input: CatchUpInput): CatchUpProjection {
  const { threadId, viewerId, rows, nowMs } = input;
  const generatedAt = (input.now ?? new Date(nowMs)).toISOString();

  // WHERE IT STARTS. The window floor is a bound, not a preference: it wins
  // whenever it is later than the marker, and the basis records which did.
  const start = laterOf(input.lastReadAt, input.windowFrom);
  const since = start.at;
  const sinceBasis: CatchUpBasis =
    start.from === null
      ? "conversation_start"
      : start.from === "a"
        ? "read_marker"
        : "history_window";
  const sinceMs = ms(since);

  const missed = (row: CatchUpInputRow): boolean => {
    const at = ms(row.created_at);
    if (at === null) return false;
    if (sinceMs !== null && at <= sinceMs) return false;
    return true;
  };

  // Parse once. Every branch below reads from this, so a body is never parsed
  // twice and a row cannot be classified two different ways.
  const parsed = rows.map((r) => ({
    row: r,
    coordination: parseCoordinationEnvelope(r.msg_type, r.body ?? null),
    envelope: parseKindEnvelope(r.msg_type, r.body ?? null),
  }));

  // WHAT WAS MISSED. The viewer's own messages are excluded here and ONLY
  // here — see the header.
  const missedRows = parsed.filter((p) => missed(p.row) && p.row.sender_id !== viewerId);

  const bySender = new Map<string, number>();
  for (const p of missedRows) {
    bySender.set(p.row.sender_id, (bySender.get(p.row.sender_id) ?? 0) + 1);
  }
  const missedFrom = [...bySender.entries()]
    .map(([userId, count]) => ({ userId, count }))
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : (a.userId < b.userId ? -1 : 1)));

  const refOf = (p: (typeof parsed)[number], kind: string): CatchUpRef => ({
    messageId: p.row.id,
    senderId: p.row.sender_id,
    at: p.row.created_at,
    kind,
    title: titleOf(p.coordination?.payload ?? (p.envelope as any)?.payload),
  });

  const decisionsOpened = missedRows
    .filter((p) => p.coordination?.kind === "DECISION")
    .map((p) => refOf(p, "DECISION"));

  const commitmentsMade = missedRows
    .filter((p) => p.coordination?.kind === "COMMITMENT")
    .map((p) => refOf(p, "COMMITMENT"));

  const shared = missedRows
    .map((p) => ({ p, kind: sharedObjectKind(p.row) }))
    .filter((x): x is { p: (typeof parsed)[number]; kind: string } => x.kind !== null)
    .map((x) => refOf(x.p, x.kind));

  // §9's moves. The `from` is the PREVIOUS transition's `to` over the whole
  // visible thread, not over the missed slice — otherwise the first move a
  // reader missed would always report `from: null` and read as an opening.
  const allTransitions = parsed
    .filter((p) => p.coordination?.kind === "COORDINATION_TRANSITION")
    .sort((a, b) => (ms(a.row.created_at) ?? 0) - (ms(b.row.created_at) ?? 0));
  const transitions: CatchUpTransition[] = [];
  let previous: CoordinationState | null = null;
  for (const p of allTransitions) {
    const to = String((p.coordination as any).payload?.to ?? "") as CoordinationState;
    const from = previous;
    if (missed(p.row)) {
      transitions.push({
        at: p.row.created_at,
        by: p.row.sender_id,
        from,
        to,
        legal: from === null ? true : isLegalTransition(from, to),
      });
    }
    previous = to;
  }

  // NOT re-derived. These are the same two projections the thread's own
  // endpoints serve, so the catch-up cannot disagree with the conversation.
  // `CatchUpInputRow` and `LayerInputRow` are the same shape. Re-building the
  // objects field by field would be a no-op that `check:telegraph-share-producers`
  // reads as a DYNAMIC message-type producer — the scan cannot tell a read from
  // a write — and a registry entry for a module that writes nothing would be a
  // false declaration. The rows are passed through.
  const layerRows: LayerInputRow[] = rows;
  const layers = projectSemanticLayers({
    threadId,
    viewerId,
    rows: layerRows,
    nowMs,
    now: input.now,
  });
  const safety = projectSafetyMode({ threadId, rows: layerRows, nowMs, now: input.now });
  const safetyRaisedMs = ms(safety.since);
  const safetyChangedWhileAway =
    safety.mode !== "NORMAL" &&
    safetyRaisedMs !== null &&
    (sinceMs === null || safetyRaisedMs > sinceMs);

  return {
    threadId,
    viewerId,
    generatedAt,
    since,
    sinceBasis,
    missedCount: missedRows.length,
    missedFrom,
    decisionsOpened,
    commitmentsMade,
    transitions,
    shared,
    needsYou: layers.plan,
    safetyMode: safety.mode,
    safetyChangedWhileAway,
    inferredFromProse: false,
  };
}
