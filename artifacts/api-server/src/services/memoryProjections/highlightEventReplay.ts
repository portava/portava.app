/**
 * §17 replay for the Highlight aggregate — the fold that says whether hide and
 * unhide can diverge.
 *
 * SPEC: Portava Highlights / Memories Development Architecture Specification v1
 *   §17 "All canonical writes should cross an explicit command boundary for
 *        authorization, invariants, idempotency, audit, and downstream event
 *        generation." + the seventeen command names and the five `highlight.*`
 *        domain events.
 *   §21 "Delete, archive, do-not-resurface, and 'keep but do not personalize'
 *        are different operations and must remain separate in both data model
 *        and UX." Archive: "Retain canonical Memory; remove from normal
 *        browsing unless explicitly requested."
 *   §25 Replay, Testing, and Certification — a projection rebuilt from the
 *        event log must reach the state the aggregate is actually in.
 *   §28.15 "Always make merge/split and publication changes auditable and
 *        idempotent."
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * THE QUESTION THIS FILE ANSWERS, AND THE MEASUREMENT BEHIND IT
 * ══════════════════════════════════════════════════════════════════════════════
 * MEASURED at this commit. `POST /highlights/:id/archive` issues §17's
 * HIDE_HIGHLIGHT through `dispatchMemoryCommand` and emits `highlight.hidden`.
 * `DELETE /highlights/:id/archive` — the inverse, which is what makes §21's
 * Archive REVERSIBLE rather than a second delete — is a bare
 * `.from("highlights").update({ archived_at: null })`. It crosses no command
 * boundary, writes no audit row, allocates no sequence and emits NOTHING.
 * routes/highlights.ts says so in its own header above that handler.
 *
 * So the event log and the row DIVERGE, and they diverge in the one direction
 * that matters: the log's last word on a hidden-then-unhidden Highlight is
 * `highlight.hidden`, while the row is visible. Any §18 consumer that rebuilds
 * from the log — which is what §18 means by "everything else should be
 * rebuildable" — reconstructs a Highlight the owner has already un-archived and
 * withholds it from their own profile. The divergence is not eventual; it is
 * permanent, because no later event ever contradicts the hide.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * WHY THE FOLD IS KEYED ON `command_type` AND NOT ON THE EVENT NAME
 * ══════════════════════════════════════════════════════════════════════════════
 * §17 lists `highlight.pinned` and NO `highlight.unpinned`; it lists
 * `highlight.hidden` and no inverse of that either. lib/memoryCommandBus.ts
 * already resolved the first half of that problem the only way that does not
 * invent vocabulary the spec does not have: PIN_HIGHLIGHT and UNPIN_HIGHLIGHT
 * BOTH emit `highlight.pinned`, and the payload carries `command_type` plus the
 * resulting state. UNHIDE_HIGHLIGHT follows that precedent exactly.
 *
 * The consequence is that an event NAME is not a state transition on this
 * aggregate — the COMMAND is. A fold written over names would collapse
 * PIN+UNPIN to "pinned" and HIDE+UNHIDE to "hidden", which is the same defect
 * the direct write produces, reached by a different route. So this fold reads
 * `command_type`, and an event whose payload does not carry one is REFUSED
 * rather than guessed at (§28.11: an unreadable input is never a plausible
 * empty answer).
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * ORDER COMES FROM `sequence`, NEVER FROM A TIMESTAMP
 * ══════════════════════════════════════════════════════════════════════════════
 * lib/memoryOutbox.ts records the measurement: `occurred_at`, `recorded_at` and
 * `created_at` all default to `now()`, which in PostgreSQL is TRANSACTION start
 * time. Two kernel calls two seconds apart inside one transaction produced two
 * events with byte-identical `recorded_at`. The only total order per aggregate
 * is `memory_domain_events.sequence`, allocated under a row lock and kept
 * honest by `UNIQUE (memory_id, sequence)`.
 *
 * This fold therefore sorts by `sequence` and by nothing else, and REFUSES a
 * stream with a duplicate sequence rather than picking a winner: two events
 * claiming the same position in one aggregate's history is a corrupt log, and
 * the one thing a replay must never do is produce a confident state from one.
 * Out-of-order DELIVERY is normal and is handled (the sort); out-of-order
 * HISTORY is not a thing that can be repaired here.
 *
 * PURE. No I/O, no clock. The caller supplies the events.
 */

import { COMMAND_EVENT, type MemoryCommandType } from "../../lib/memoryCommandBus.js";

/**
 * The commands that move the Highlight aggregate, and what each one asserts
 * about the row afterwards.
 *
 * TOTAL over the §17 Highlight commands by construction: a `Record` with no
 * index signature, so a fifth Highlight command added to the bus without an
 * entry here is a COMPILE error rather than a replay that silently ignores it.
 * That is the same guard COMMAND_EVENT and COMMAND_SUBJECT apply on the write
 * side, applied here on the replay side.
 */
export interface HighlightStateAssertion {
  /** `archived_at` after the command: true = set, false = cleared, null = untouched. */
  readonly hidden: boolean | null;
  /** `pinned_at` after the command: true = set, false = cleared, null = untouched. */
  readonly pinned: boolean | null;
}

export const HIGHLIGHT_COMMAND_EFFECTS: Readonly<
  Record<"PIN_HIGHLIGHT" | "UNPIN_HIGHLIGHT" | "HIDE_HIGHLIGHT" | "UNHIDE_HIGHLIGHT", HighlightStateAssertion>
> = Object.freeze({
  // §17 PIN_HIGHLIGHT / UNPIN_HIGHLIGHT — highlights.pinned_at. Neither touches
  // archived_at: §21 keeps pin and archive separate operations.
  PIN_HIGHLIGHT: { hidden: null, pinned: true },
  UNPIN_HIGHLIGHT: { hidden: null, pinned: false },
  // §17 HIDE_HIGHLIGHT — highlights.archived_at, §21's REVERSIBLE hide.
  // `deleted_at` is terminal and is a different operation; nothing here writes
  // or replays it.
  HIDE_HIGHLIGHT: { hidden: true, pinned: null },
  // EXT. §17 names no inverse of HIDE_HIGHLIGHT, and §21 requires Archive to be
  // reversible, so the inverse exists whether or not §17 named it. See
  // lib/memoryCommandBus.ts MEMORY_COMMAND_TYPES for the declaration and the
  // reason an EXT name is preferred to a direct write.
  UNHIDE_HIGHLIGHT: { hidden: false, pinned: null },
});

export type HighlightCommandName = keyof typeof HIGHLIGHT_COMMAND_EFFECTS;

export function isHighlightCommandName(v: unknown): v is HighlightCommandName {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(HIGHLIGHT_COMMAND_EFFECTS, v);
}

/**
 * One row of `memory_domain_events` as a replay reads it.
 *
 * `payload_json.command_type` is the field the fold turns on. It is typed
 * `unknown` deliberately: it arrives from the database as jsonb and a replay
 * that assumed its shape would crash on a payload written by an older schema
 * version instead of refusing it.
 */
export interface HighlightDomainEventRow {
  readonly event_id: string;
  readonly highlight_id: string;
  readonly sequence: number;
  readonly type: string;
  readonly payload_json: { readonly command_type?: unknown } | null;
}

export type HighlightReplayRefusal =
  /** An event carries no readable `command_type`, so no transition can be derived. */
  | "command_type_absent"
  /** An event names a command this aggregate has no transition for. */
  | "command_type_unknown"
  /** Two events claim the same `sequence` for one Highlight. A corrupt log. */
  | "duplicate_sequence"
  /** An event's `type` is not the `highlight.*` event its command maps to. */
  | "event_type_mismatch"
  /** The stream mixes more than one Highlight. */
  | "mixed_subjects";

export interface HighlightReplayState {
  readonly highlightId: string;
  /** `archived_at IS NOT NULL` as the log says it should be. */
  readonly hidden: boolean;
  /** `pinned_at IS NOT NULL` as the log says it should be. */
  readonly pinned: boolean;
  /** The highest `sequence` folded, so a caller can resume. */
  readonly sequence: number;
  /** Every command applied, in the order applied. The audit half of §17. */
  readonly applied: readonly HighlightCommandName[];
}

export type HighlightReplayResult =
  | { ok: true; state: HighlightReplayState }
  | { ok: false; reason: HighlightReplayRefusal; detail: string };

/**
 * Fold an event stream into the state the row should be in.
 *
 * A REFUSAL IS NOT A STATE. Every failure returns a discriminated refusal
 * rather than a best-effort state, because a replay that guesses is worse than
 * one that stops: the whole point of §18's "everything else should be
 * rebuildable" is that the rebuilt artifact can be trusted against the
 * canonical row, and a silently-degraded fold breaks exactly that.
 *
 * An EMPTY stream is not a refusal. A Highlight with no events is a Highlight
 * that never crossed the command boundary — which is every Highlight created by
 * `POST /highlights` today — and the honest answer is the aggregate's initial
 * state, with `sequence: 0` saying no event was folded.
 */
export function replayHighlightEvents(
  highlightId: string,
  events: readonly HighlightDomainEventRow[],
): HighlightReplayResult {
  for (const e of events) {
    if (e.highlight_id !== highlightId) {
      return {
        ok: false,
        reason: "mixed_subjects",
        detail: `event ${e.event_id} names highlight ${e.highlight_id}, not ${highlightId}`,
      };
    }
  }

  const seen = new Set<number>();
  for (const e of events) {
    if (seen.has(e.sequence)) {
      return {
        ok: false,
        reason: "duplicate_sequence",
        detail: `two events claim sequence ${e.sequence} for highlight ${highlightId}`,
      };
    }
    seen.add(e.sequence);
  }

  // Out-of-order DELIVERY is normal — §19's whole premise — so the stream is
  // sorted before it is folded rather than being required to arrive sorted.
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence);

  let hidden = false;
  let pinned = false;
  let sequence = 0;
  const applied: HighlightCommandName[] = [];

  for (const e of ordered) {
    const raw = e.payload_json?.command_type;
    if (typeof raw !== "string" || raw.length === 0) {
      return {
        ok: false,
        reason: "command_type_absent",
        detail: `event ${e.event_id} (${e.type}) carries no command_type; §17's event names are not transitions on this aggregate`,
      };
    }
    if (!isHighlightCommandName(raw)) {
      return {
        ok: false,
        reason: "command_type_unknown",
        detail: `event ${e.event_id} names command ${raw}, which has no Highlight transition`,
      };
    }
    // The event NAME must still be the one §17 maps that command to. A stream
    // where HIDE_HIGHLIGHT arrived as `highlight.pinned` is a producer bug, and
    // folding it anyway would hide the bug inside a plausible state.
    const expected = COMMAND_EVENT[raw as MemoryCommandType];
    if (expected !== undefined && e.type !== expected) {
      return {
        ok: false,
        reason: "event_type_mismatch",
        detail: `event ${e.event_id} is ${e.type} but ${raw} emits ${expected}`,
      };
    }

    const effect = HIGHLIGHT_COMMAND_EFFECTS[raw];
    if (effect.hidden !== null) hidden = effect.hidden;
    if (effect.pinned !== null) pinned = effect.pinned;
    sequence = e.sequence;
    applied.push(raw);
  }

  return { ok: true, state: { highlightId, hidden, pinned, sequence, applied } };
}

/** The row a replay is checked against. Only the two columns the fold asserts. */
export interface HighlightRowState {
  readonly archived_at: string | null;
  readonly pinned_at: string | null;
}

export interface ReplayDivergence {
  readonly field: "hidden" | "pinned";
  readonly replayed: boolean;
  readonly stored: boolean;
}

/**
 * §25. Does the log reproduce the row?
 *
 * This is the assertion that fails TODAY for a hidden-then-unhidden Highlight
 * and passes once the unhide crosses the command boundary. It is written as a
 * function rather than as a test body so the certification harness and any
 * future operator script check the same property in the same words.
 *
 * A Highlight with NO events is reported as `not_replayable` rather than as
 * agreement: an aggregate whose whole history is direct writes agrees with the
 * empty fold only by accident (both say "not hidden") and would report a false
 * green the moment someone archived it.
 */
export type ReplayAgreement =
  | { ok: true; agrees: true }
  | { ok: true; agrees: false; divergences: readonly ReplayDivergence[] }
  | { ok: false; reason: HighlightReplayRefusal | "not_replayable"; detail: string };

export function replayAgreesWithRow(
  highlightId: string,
  events: readonly HighlightDomainEventRow[],
  row: HighlightRowState,
): ReplayAgreement {
  if (events.length === 0) {
    return {
      ok: false,
      reason: "not_replayable",
      detail:
        `highlight ${highlightId} has no domain events: every write to it bypassed the §17 command boundary, ` +
        "so there is no log for a projection to be rebuilt from",
    };
  }

  const replay = replayHighlightEvents(highlightId, events);
  if (!replay.ok) return replay;

  const storedHidden = row.archived_at !== null;
  const storedPinned = row.pinned_at !== null;
  const divergences: ReplayDivergence[] = [];
  if (replay.state.hidden !== storedHidden) {
    divergences.push({ field: "hidden", replayed: replay.state.hidden, stored: storedHidden });
  }
  if (replay.state.pinned !== storedPinned) {
    divergences.push({ field: "pinned", replayed: replay.state.pinned, stored: storedPinned });
  }

  return divergences.length === 0
    ? { ok: true, agrees: true }
    : { ok: true, agrees: false, divergences };
}
