/**
 * Telegraph §15.2 — the CONVERSATION-LEVEL safety mode.
 *
 * Spec §15.2, in full:
 *   "NORMAL → SAFETY_ATTENTION → SAFETY_EVENT
 *    Safety mode promotes trusted contact, current status, official help,
 *    route/return, call, block/report and relevant location scope while
 *    de-prioritizing entertainment actions."
 *
 * ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
 * census-telegraph T217: "Two escalation ladders exist and neither is this one:
 * Safe Return sessions escalate via `trigger-missed` … and circle presence
 * escalates via `needs_help` … **Neither is a conversation-level mode.**" §13.4
 * then classified the row NEITHER — "A conversation-level safety mode does not
 * exist in either tree" — i.e. as needing something this tree does not have.
 *
 * It does not. Both carriers are already IN the thread and both are already
 * written by shipped routes:
 *
 *   - §6.2's SAFETY message kind, whose payload enumerates exactly
 *     `check_in | heads_up | need_help | all_clear`
 *     (`services/telegraph/messageKinds.ts#SafetyPayload`), sent through
 *     `POST /threads/:id/typed-messages`;
 *   - §9.1's `NEED_HELP` quick state, sent through
 *     `POST /threads/:id/coordination`.
 *
 * The mode is a projection over those. No table, no migration, no flag —
 * which is what makes it true on every deployment of this tree rather than
 * capped by one nobody has run.
 *
 * ── THE THREE RULES A CARELESS PROJECTION GETS WRONG ────────────────────────
 * 1. **An EVENT is cleared only by an explicit ALL CLEAR, never by time.** A
 *    help request that ages out of the mode is a help request the product
 *    forgot about. `SAFETY_ATTENTION` does decay — a heads-up from three days
 *    ago should not hold a conversation in a safety posture forever — and the
 *    asymmetry is deliberate and asserted.
 * 2. **A routine CHECK-IN does not clear anything.** §6.2 gives `check_in` and
 *    `all_clear` separate names precisely so "I am here" and "it is over" are
 *    different statements. Collapsing them would let a habit silently answer an
 *    emergency.
 * 3. **The mode is the HIGHEST unresolved signal, not the latest one.** A
 *    heads-up posted after a need-help does not de-escalate the thread.
 *
 * ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
 * It is not Safe Return and it does not replace it. Safe Return is a session
 * between a traveller and their trusted contacts with its own escalation and
 * its own storage; this is a property of a CONVERSATION, derived from what was
 * said in it. A thread can be NORMAL while its members have Safe Return
 * sessions running, and that is correct: §15.2's mode is about the surface the
 * people in this conversation are looking at.
 *
 * Everything here is pure: no client, no clock beyond the `nowMs` passed in,
 * no environment.
 */
import { parseCoordinationEnvelope } from "./coordination.js";
import { parseKindEnvelope } from "./messageKinds.js";

/** §15.2's ladder, verbatim and in the spec's order. Index IS the severity. */
export const SAFETY_MODES = ["NORMAL", "SAFETY_ATTENTION", "SAFETY_EVENT"] as const;

export type SafetyMode = (typeof SAFETY_MODES)[number];

export function safetyRank(mode: SafetyMode): number {
  return SAFETY_MODES.indexOf(mode);
}

export function isSafetyMode(v: unknown): v is SafetyMode {
  return typeof v === "string" && (SAFETY_MODES as readonly string[]).includes(v);
}

/**
 * How long a HEADS-UP holds a conversation in SAFETY_ATTENTION without being
 * cleared. Six hours: long enough to cover an evening, short enough that a
 * thread is not still amber the next afternoon.
 *
 * There is deliberately NO equivalent constant for SAFETY_EVENT. See rule 1.
 */
export const SAFETY_ATTENTION_WINDOW_MINUTES = 360;

/** Where a signal came from. Both carriers are shipped routes. */
export type SafetySignalSource = "SAFETY_MESSAGE" | "QUICK_STATE";

export type SafetySignalKind = "check_in" | "heads_up" | "need_help" | "all_clear";

export interface SafetySignal {
  messageId: string;
  senderId: string;
  at: string;
  kind: SafetySignalKind;
  source: SafetySignalSource;
  /** The mode this signal raises, or null when it raises nothing. */
  raises: SafetyMode | null;
}

/** The §6.2 / §9.1 rows this projection reads. Nothing else is touched. */
export interface SafetyInputRow {
  id: string;
  sender_id: string;
  created_at: string;
  msg_type?: string | null;
  subtype?: string | null;
  body?: string | null;
}

export interface SafetyModeProjection {
  threadId: string;
  generatedAt: string;
  modes: readonly SafetyMode[];
  mode: SafetyMode;
  /** When the current mode was raised. Null in NORMAL. */
  since: string | null;
  /** Who raised it. Null in NORMAL. */
  raisedBy: string | null;
  /** The last ALL CLEAR, when one has been posted. */
  clearedAt: string | null;
  /** Why the thread is in this mode, in words. Never silent. */
  reason: string;
  /** Every safety signal in the window, oldest first. */
  signals: SafetySignal[];
  affordances: SafetyAffordances;
}

// ── §15.2's promotion list ───────────────────────────────────────────────────

export interface SafetyAffordances {
  /** §15.2's seven, verbatim and in the spec's order. */
  promoted: readonly string[];
  /** §15.2's one. */
  deprioritized: readonly string[];
}

/**
 * §15.2's sentence, as data.
 *
 * The order is the SPEC'S order and not a judgement made here — trusted
 * contact first, location scope last — so a surface that renders this list
 * top-to-bottom is rendering §15.2 rather than someone's opinion of urgency.
 *
 * NORMAL promotes nothing and de-prioritizes nothing. A product that always
 * promoted safety affordances would have no way to escalate, and §15.2's whole
 * shape is that the surface CHANGES.
 */
export const SAFETY_PROMOTED: readonly string[] = [
  "TRUSTED_CONTACT",
  "CURRENT_STATUS",
  "OFFICIAL_HELP",
  "ROUTE_OR_RETURN",
  "CALL",
  "BLOCK_OR_REPORT",
  "LOCATION_SCOPE",
];

export const SAFETY_DEPRIORITIZED: readonly string[] = ["ENTERTAINMENT"];

const NO_AFFORDANCES: SafetyAffordances = { promoted: [], deprioritized: [] };

export function affordancesFor(mode: SafetyMode): SafetyAffordances {
  if (mode === "NORMAL") return NO_AFFORDANCES;
  return { promoted: SAFETY_PROMOTED, deprioritized: SAFETY_DEPRIORITIZED };
}

// ── reading the signals ──────────────────────────────────────────────────────

function ms(v: string | null | undefined): number | null {
  if (typeof v !== "string" || v.length === 0) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

function raisedBy(kind: SafetySignalKind): SafetyMode | null {
  switch (kind) {
    case "need_help":
      return "SAFETY_EVENT";
    case "heads_up":
      return "SAFETY_ATTENTION";
    // `check_in` is reassurance and `all_clear` is a resolution. Neither raises.
    default:
      return null;
  }
}

/**
 * Pull every safety signal out of a thread's rows.
 *
 * Two carriers, one vocabulary: §9.1's `NEED_HELP` quick state is read as a
 * `need_help` signal so the ladder does not depend on which button a person
 * happened to press. Nothing else in §9.1 is a safety signal — ARRIVED and
 * RUNNING_LATE are coordination, and mapping them here would make every busy
 * evening look like an incident.
 */
export function readSafetySignals(rows: SafetyInputRow[]): SafetySignal[] {
  const out: SafetySignal[] = [];
  for (const r of rows) {
    const envelope = parseKindEnvelope(r.msg_type, r.body ?? null);
    if (envelope && envelope.kind === "SAFETY") {
      const kind = (envelope.payload as { kind?: unknown }).kind;
      if (
        kind === "check_in" ||
        kind === "heads_up" ||
        kind === "need_help" ||
        kind === "all_clear"
      ) {
        out.push({
          messageId: r.id,
          senderId: r.sender_id,
          at: r.created_at,
          kind,
          source: "SAFETY_MESSAGE",
          raises: raisedBy(kind),
        });
      }
      continue;
    }
    const coordination = parseCoordinationEnvelope(r.msg_type, r.body ?? null);
    if (coordination && coordination.kind === "COORDINATION") {
      if (coordination.payload?.state === "NEED_HELP") {
        out.push({
          messageId: r.id,
          senderId: r.sender_id,
          at: r.created_at,
          kind: "need_help",
          source: "QUICK_STATE",
          raises: "SAFETY_EVENT",
        });
      }
    }
  }
  return out.sort((a, b) => (ms(a.at) ?? 0) - (ms(b.at) ?? 0));
}

// ── the projection ───────────────────────────────────────────────────────────

/**
 * §15.2's mode for one conversation.
 *
 * The fold is: walk the signals oldest-first, keep the highest mode that has
 * not been cleared, and let ATTENTION — and only ATTENTION — decay.
 */
export function projectSafetyMode(input: {
  threadId: string;
  rows: SafetyInputRow[];
  nowMs: number;
  now?: Date;
}): SafetyModeProjection {
  const generatedAt = (input.now ?? new Date(input.nowMs)).toISOString();
  const signals = readSafetySignals(input.rows);

  let mode: SafetyMode = "NORMAL";
  let since: string | null = null;
  let raiser: string | null = null;
  let clearedAt: string | null = null;

  for (const s of signals) {
    if (s.kind === "all_clear") {
      clearedAt = s.at;
      mode = "NORMAL";
      since = null;
      raiser = null;
      continue;
    }
    if (s.raises === null) continue;
    // Highest wins, not latest: a heads-up after a need-help does not
    // de-escalate the conversation.
    if (safetyRank(s.raises) >= safetyRank(mode)) {
      if (safetyRank(s.raises) > safetyRank(mode) || since === null) {
        since = s.at;
        raiser = s.senderId;
      }
      mode = s.raises;
    }
  }

  // ATTENTION decays; an EVENT does not. This is the asymmetry rule 1 names,
  // and it is the only place time enters the fold.
  let reason: string;
  if (mode === "SAFETY_ATTENTION") {
    const raisedMs = ms(since);
    const expired =
      raisedMs !== null && input.nowMs - raisedMs > SAFETY_ATTENTION_WINDOW_MINUTES * 60_000;
    if (expired) {
      mode = "NORMAL";
      since = null;
      raiser = null;
      reason =
        `A heads-up was raised more than ${SAFETY_ATTENTION_WINDOW_MINUTES} minutes ago and ` +
        "nothing has been raised since, so the conversation is back to normal.";
    } else {
      reason = "Somebody in this conversation raised a heads-up that has not been cleared.";
    }
  } else if (mode === "SAFETY_EVENT") {
    reason =
      "Somebody in this conversation asked for help and no ALL CLEAR has been posted. " +
      "This mode does not expire with time; it is cleared by a person saying so.";
  } else {
    reason = clearedAt
      ? "The last safety signal in this conversation was an ALL CLEAR."
      : "No safety signal has been raised in this conversation.";
  }

  return {
    threadId: input.threadId,
    generatedAt,
    modes: SAFETY_MODES,
    mode,
    since,
    raisedBy: raiser,
    clearedAt,
    reason,
    signals,
    affordances: affordancesFor(mode),
  };
}
