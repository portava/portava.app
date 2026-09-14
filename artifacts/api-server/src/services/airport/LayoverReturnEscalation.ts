/**
 * LayoverReturnEscalation — the §15 escalation ladder's NOTIFICATION half.
 *
 * ── WHO OWNS THIS, AND WHY IT SITS BESIDE LayoverSafeReturnService ──────────
 * census L18: *"**Safe Return** owns escalation, return-state UX, notification
 * priority; must not recompute core feasibility."* On this surface Safe Return
 * is `LayoverSafeReturnService` — the module that already owns the §15 posture
 * — so the priority is decided in its own directory, one file over, and
 * `safeReturnPosture` ASKS for it rather than deciding it inline.
 *
 * It is deliberately NOT in `services/safeReturn/`. That directory is the Safe
 * Return PRODUCT: check-in timers, a trusted circle, missed-check-in
 * escalation over `safe_return_sessions`. A layover's return ladder is a
 * different object with a different clock, and filing it there would put two
 * unrelated escalation vocabularies in one namespace. What it does share with
 * that product is the vocabulary that matters — the app's own
 * `NotificationPriority`, imported rather than re-spelled.
 *
 * `LayoverSafetyEngine` DERIVES the four states; neither it nor the posture may
 * decide how loud a message is, because that decision is read by the
 * notification pipeline and has to be made in the pipeline's own vocabulary.
 *
 * ── WHAT WAS ACTUALLY MISSING ───────────────────────────────────────────────
 * Nothing in the layover surface carried a notification priority at all. The
 * four rungs were indistinguishable to `NotificationPreferenceService`, which
 * is the code that decides whether a message reaches a traveller: its rule is
 *
 *     const isSafetyCritical = priority === 'urgent' || category === 'admin';
 *     if (prefs.quietHoursEnabled && !safetyOverrideApplies && isQuietHour) drop push
 *
 * — so without a priority, a "you must leave for the airport NOW" alert and a
 * "here are some ideas" nudge were the same message, and a traveller with quiet
 * hours enabled (the default window is 22:00–08:00, i.e. exactly a night
 * layover) would have received NEITHER. The priority below is what makes the
 * top two rungs survive that filter and keeps the bottom two subject to it.
 *
 * ── WHAT THIS FILE DOES NOT DO ──────────────────────────────────────────────
 * IT SENDS NOTHING. Whether the return reminder is server-pushed or scheduled
 * locally by the client is the open owner decision
 * `LAYOVER_RETURN_REMINDER_DELIVERY` (docs/architecture/blocker-ledger.md), and
 * nothing here resolves it: no push provider is called, no row is written, no
 * schedule is created. This is the PRIORITY a message would carry, published so
 * the client (which is what actually schedules the local notification today)
 * and any future server sender read the same ladder instead of each inventing
 * one. census L41's notification half needs a SENDER as well as a priority, and
 * this is only the priority — L41 stays `W`.
 *
 * IT RECOMPUTES NOTHING. The only input is a `LayoverReturnState` that has
 * already been certified upstream. There is no import of `computeReturnDeadline`,
 * `computeWindow`, `computeBuffer`, `certifySessionFeasibility` or `assess` in
 * this file and `__tests__/layoverReturnEscalation.test.ts` reads the import
 * lines to keep it that way — L18's "must not recompute core feasibility" is a
 * boundary, and a boundary that is only described in a comment is not enforced.
 */
import type {
  NotificationChannel,
  NotificationPriority,
} from "../notifications/NotificationTemplateService.js";
import { RETURN_SOON_LEAD_MIN, type LayoverReturnState } from "./LayoverSafetyEngine.js";

/** The four rung levels, in order. Exported so a caller can bound-check one. */
export const ESCALATION_LEVELS = [0, 1, 2, 3] as const;
export type EscalationLevel = (typeof ESCALATION_LEVELS)[number];

export interface ReturnEscalationRung {
  /** The certified §15 state this rung answers. Never derived here. */
  state: LayoverReturnState;
  /** Position on the ladder. Strictly increasing; a client may compare them. */
  level: EscalationLevel;
  /**
   * The app's own priority vocabulary — imported, never re-spelled, so a rung
   * cannot invent a value `NotificationPreferenceService` does not understand.
   * `urgent` is the ONLY value that survives quiet hours and a push-off
   * setting, which is why it starts at RETURN_NOW and not before.
   */
  priority: NotificationPriority;
  /**
   * The channels this rung ASKS for. The pipeline narrows them against the
   * traveller's preferences; this is the request, not the outcome.
   */
  channels: NotificationChannel[];
  /**
   * §13 L120 / §15: exploration-first affordances are de-emphasised from
   * RETURN_SOON and collapsed from RETURN_NOW. Carried beside the priority
   * because "how loud" and "what does the screen do" are one decision at a
   * rung, and splitting them is how the two drifted apart before.
   */
  deEmphasiseDiscovery: boolean;
  /**
   * TRUE when a message at this rung is allowed to interrupt quiet hours. It is
   * NOT an independent switch — it is `priority === "urgent"`, which is the
   * pipeline's own rule, restated here as a readable field so a client does not
   * have to know that rule to render a warning about it.
   */
  piercesQuietHours: boolean;
  /**
   * One line a surface may show beside the rung. Deliberately contains no
   * time, no place and no number: every figure a traveller acts on comes from
   * the certified record, and a second copy here is a second source of truth.
   */
  label: string;
}

/**
 * The ladder, in order, as data.
 *
 * `notifyCrew` in `safeReturnPosture` turns on one step earlier than the spec
 * attaches it; this ladder keeps the same discipline in the other direction —
 * `urgent` is withheld until the deadline has actually passed. An `urgent`
 * priority overrides a traveller's own push settings, and spending that
 * override on a thirty-minute warning is how the override stops meaning
 * anything by the time it matters.
 */
export const RETURN_ESCALATION_LADDER: readonly ReturnEscalationRung[] = [
  {
    state: "NORMAL",
    level: 0,
    priority: "low",
    channels: ["in_app"],
    deEmphasiseDiscovery: false,
    piercesQuietHours: false,
    label: "You have time — explore.",
  },
  {
    state: "RETURN_SOON",
    level: 1,
    priority: "important",
    channels: ["in_app", "push"],
    deEmphasiseDiscovery: true,
    piercesQuietHours: false,
    label: "Start wrapping up and plan your way back.",
  },
  {
    state: "RETURN_NOW",
    level: 2,
    priority: "urgent",
    channels: ["in_app", "push"],
    deEmphasiseDiscovery: true,
    piercesQuietHours: true,
    label: "Head back to the airport now.",
  },
  {
    state: "CONNECTION_AT_RISK",
    level: 3,
    priority: "urgent",
    channels: ["in_app", "push"],
    deEmphasiseDiscovery: true,
    piercesQuietHours: true,
    label: "Your connection is at risk — get to the airport and find help.",
  },
] as const;

const BY_STATE = new Map<LayoverReturnState, ReturnEscalationRung>(
  RETURN_ESCALATION_LADDER.map((r) => [r.state, r]),
);

/**
 * The rung for a certified state.
 *
 * TOTAL over `LayoverReturnState` by construction, and the fallback is the
 * TOP rung rather than the bottom one: if a state is ever added upstream and
 * this table is not updated, the failure should be an over-loud alert a
 * traveller can dismiss, not a silent one they never receive.
 */
export function returnEscalationRung(state: LayoverReturnState): ReturnEscalationRung {
  return BY_STATE.get(state) ?? RETURN_ESCALATION_LADDER[RETURN_ESCALATION_LADDER.length - 1]!;
}

/**
 * The rung, shaped for the wire.
 *
 * A separate type from `ReturnEscalationRung` so that adding an internal field
 * to the ladder is not automatically a published API change.
 */
export interface ReturnNotificationPosture {
  level: EscalationLevel;
  priority: NotificationPriority;
  channels: NotificationChannel[];
  piercesQuietHours: boolean;
  deEmphasiseDiscovery: boolean;
  label: string;
  /**
   * Stated on every response so no reader mistakes a published priority for a
   * message that was sent. See the owner boundary in this file's header.
   */
  delivery: "not_sent_here";
}

export function returnNotificationPosture(state: LayoverReturnState): ReturnNotificationPosture {
  const rung = returnEscalationRung(state);
  return {
    level: rung.level,
    priority: rung.priority,
    channels: [...rung.channels],
    piercesQuietHours: rung.piercesQuietHours,
    deEmphasiseDiscovery: rung.deEmphasiseDiscovery,
    label: rung.label,
    delivery: "not_sent_here",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// §24 L265 / §11.1 L99 — the material-change threshold for a reminder already
// scheduled
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How far the certified deadline must move before an already-scheduled reminder
 * is worth replacing, in minutes.
 *
 * ── WHY A THRESHOLD AT ALL, AND WHY FIVE ────────────────────────────────────
 * census L265 asks for "material-change threshold + suppression/debounce". The
 * debounce half was already real — the client cancels the previous local
 * notification before scheduling a new one and never stacks them — and the
 * threshold half did not exist, because nothing compared a scheduled reminder
 * against the deadline it was scheduled for.
 *
 * Without a threshold, the correct-on-every-change rule is a storm: every
 * `+15m` press, every re-certification that shifts a buffer by a minute, would
 * cancel and re-raise a notification. With too large a threshold the reminder
 * is quietly wrong. Five minutes is the smallest movement that changes what a
 * traveller DOES — it is under the smallest shift the flight-change card offers
 * (15 minutes), so every real edit crosses it, and above the sub-minute jitter
 * that a re-certification at a different instant produces on its own.
 */
export const REMINDER_MATERIAL_DRIFT_MIN = 5;

/**
 * What should happen to a reminder the traveller already asked for.
 *
 * `none`       nothing is scheduled, or what is stored cannot be read
 * `keep`       scheduled, still aligned — or drifted below the threshold
 * `fired`      its moment has passed and the deadline has not materially moved
 * `reschedule` the deadline moved materially; this is the instant to move it to
 * `cancel`     it can no longer warn anybody, and moving it would be a lie
 */
export type ReminderAction = "none" | "keep" | "fired" | "reschedule" | "cancel";

export interface ReminderDisposition {
  action: ReminderAction;
  /** A stable token, never a sentence — clients render their own words. */
  reason:
    | "no_reminder_scheduled"
    | "reminder_unreadable"
    | "aligned"
    | "below_material_threshold"
    | "already_fired"
    | "deadline_moved"
    | "deadline_moved_after_fire"
    | "rung_already_passed"
    | "deadline_passed";
  /**
   * Minutes the certified deadline has moved relative to the moment this
   * reminder was scheduled against. POSITIVE means the flight went later, so
   * the reminder now fires too early; NEGATIVE means it was brought forward and
   * the reminder fires too late — the direction that costs a traveller warning
   * time rather than giving them extra.
   */
  driftMinutes: number;
  /** Whether that drift crossed `REMINDER_MATERIAL_DRIFT_MIN`. */
  materialChange: boolean;
  /** The instant to schedule at, or null when there is nothing to schedule. */
  firesAt: string | null;
  /** The instant currently stored, so a surface can say what it is replacing. */
  staleFiresAt: string | null;
  /** The §15 rung now in force. Read from the ladder; never derived here. */
  rung: ReturnNotificationPosture;
}

/**
 * Decide, without sending anything.
 *
 * THE LEAD IS NOT A PARAMETER, AND THAT IS THE POINT. The one reminder this
 * product schedules is set 30 minutes before the certified hard return, which
 * is `RETURN_SOON_LEAD_MIN` — the same constant that puts the §15 ladder onto
 * its RETURN_SOON rung. The reminder IS the RETURN_SOON warning, delivered by
 * the only path this tree has, so the drift below is measured against the rung
 * rather than against a number the caller passes in and could disagree about.
 *
 * `reminderAt` is what the SERVER stored (`layover_sessions.return_reminder_at`),
 * not what the device holds. Those can disagree — a device that was offline
 * when the schedule failed is a separate gap, named in this lane's report — and
 * this function answers about the stored one, which is what every surface
 * reads when it renders "Reminder set".
 */
export function reminderDisposition(input: {
  reminderAt: string | null;
  hardReturnTime: Date;
  returnState: LayoverReturnState;
  nowMs: number;
}): ReminderDisposition {
  const { reminderAt, hardReturnTime, returnState, nowMs } = input;
  const rung = returnNotificationPosture(returnState);
  const base = { driftMinutes: 0, materialChange: false, firesAt: null, staleFiresAt: null, rung };

  if (!reminderAt) return { ...base, action: "none", reason: "no_reminder_scheduled" };
  const storedMs = Date.parse(reminderAt);
  if (!Number.isFinite(storedMs)) {
    // A stored value nobody can read is not a reminder at a default time. It is
    // an unknown, and guessing one here would put a notification on a
    // traveller's phone at an instant no certified record produced.
    return { ...base, action: "none", reason: "reminder_unreadable" };
  }

  const deadlineMs = hardReturnTime.getTime();
  const correctMs = deadlineMs - RETURN_SOON_LEAD_MIN * 60_000;
  const driftMinutes = Math.round((correctMs - storedMs) / 60_000);
  const materialChange = Math.abs(driftMinutes) >= REMINDER_MATERIAL_DRIFT_MIN;
  const staleFiresAt = new Date(storedMs).toISOString();

  // A deadline that has already passed cannot be warned about. This is checked
  // before the threshold: a reminder for a flight that has gone is wrong by
  // more than a number of minutes.
  if (deadlineMs <= nowMs) {
    return { ...base, action: "cancel", reason: "deadline_passed", driftMinutes, materialChange, staleFiresAt };
  }

  if (!materialChange) {
    if (storedMs <= nowMs) {
      return { ...base, action: "fired", reason: "already_fired", driftMinutes, staleFiresAt };
    }
    return {
      ...base,
      action: "keep",
      reason: driftMinutes === 0 ? "aligned" : "below_material_threshold",
      driftMinutes,
      staleFiresAt,
    };
  }

  // Material, but the warning it would carry is already spent: "start heading
  // back in thirty minutes" is not something to say to somebody who should have
  // left. The ladder's own rung is what speaks at that point, and it is on the
  // answer above.
  if (correctMs <= nowMs) {
    return { ...base, action: "cancel", reason: "rung_already_passed", driftMinutes, materialChange: true, staleFiresAt };
  }

  return {
    ...base,
    action: "reschedule",
    reason: storedMs <= nowMs ? "deadline_moved_after_fire" : "deadline_moved",
    driftMinutes,
    materialChange: true,
    firesAt: new Date(correctMs).toISOString(),
    staleFiresAt,
  };
}
