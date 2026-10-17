/**
 * §45 / OD-INPUT-1 (census-input-intelligence G320) — the Telegraph composer's
 * `downstream_task_completed`: an input-assistance suggestion the composer
 * ACCEPTED, reported when the message it served has been sent (or refused).
 *
 * The reporter is the platform's (`servedTaskOutcome.ts#reportServedTask` →
 * `outcomeLearning.ts#reportInputTaskOutcome`). Without this account's
 * outcome-learning consent it does nothing at all — no event, no request — and
 * the server re-checks both the consent and what may be credited. This module
 * only decides WHICH field served WHICH send.
 *
 * TWO SUGGESTIONS THE COMPOSER ACCEPTS:
 *
 *   `telegraph.recipient` (New Telegraph, `app/telegraph/new.tsx`). Picking a
 *   person opens the conversation; the task it served is the first message sent
 *   there. The pick is HELD for that thread (at most HOLD_MS) and reported by
 *   the thread screen when a send answers: a refused send reports `ok: false`
 *   and keeps the hold for the retry; a sent one reports `ok: true`, credits the
 *   person picked (the field's policy remembers `user`), and ends the hold.
 *
 *   `telegraph.message` (the composer's "meet at …" bar). Its location
 *   candidate PRE-FILLS the location sheet, and that sheet's send is the task.
 *   `telegraph_message` is a private-message field with no per-user memory, so
 *   it reports the event and credits nothing. A sheet cancelled reports nothing.
 *   NOT reported: the bar's event candidate (`share_entity`). Its confirmed
 *   share runs inside the platform's `confirmShareObject`, whose answer this
 *   screen does not see, and the screen's mount of it is source-fenced
 *   (meetAtActions.component.test.tsx) — left for the input lane.
 *
 * Pure module — no React, no network of its own — safe under node:test.
 */
import {
  reportServedTask,
  servedWithoutCredit,
  type ServedField,
} from '../../../platform/input-assistance/services/servedTaskOutcome.ts';
import type { TaskOutcomeField } from '../../../platform/input-assistance/services/outcomeLearning.ts';
import { SOCIAL_FIELD_IDS } from '../../../platform/input-assistance/social/socialFields.ts';
import { TELEGRAPH_MESSAGE_FIELD_ID } from '../../../platform/input-assistance/social/telegraphMeetAt.ts';

export const TELEGRAPH_RECIPIENT_FIELD: TaskOutcomeField = { fieldId: SOCIAL_FIELD_IDS.telegraphRecipient, context: 'telegraph_recipient' };
export const TELEGRAPH_MESSAGE_FIELD: TaskOutcomeField = { fieldId: TELEGRAPH_MESSAGE_FIELD_ID, context: 'telegraph_message' };

/** A recipient pick serves only a send soon after it; an old hold is dropped unreported. */
export const HOLD_MS = 30 * 60_000;

type Reporter = typeof reportServedTask;

/** The person picked from `telegraph.recipient` — the entity its selection memory keeps. */
export function recipientServed(userId: string | null | undefined): ServedField | null {
  const id = typeof userId === 'string' ? userId.trim() : '';
  if (!id) return null;
  return { field: TELEGRAPH_RECIPIENT_FIELD, entities: [{ entityType: 'user', entityId: id }] };
}

/** A "meet at …" candidate accepted in the composer: the §44 event only. */
export function meetAtServed(): ServedField {
  return servedWithoutCredit(TELEGRAPH_MESSAGE_FIELD);
}

const held = new Map<string, { served: ServedField; at: number }>();

/** New Telegraph: the pick that opened `threadId`, held until a send there answers. */
export function holdRecipientPick(threadId: string | null | undefined, served: ServedField | null, now: number = Date.now()): void {
  if (!threadId || !served) return;
  held.set(threadId, { served, at: now });
}

/**
 * A send in `threadId` answered. Reports a held recipient pick (once per
 * attempt; a success ends the hold). Returns how many fields were reported —
 * 0 without consent or without a live hold. Never throws.
 */
export function reportThreadSend(
  threadId: string | null | undefined,
  ok: boolean,
  now: number = Date.now(),
  report: Reporter = reportServedTask,
): number {
  if (!threadId) return 0;
  const h = held.get(threadId);
  if (!h) return 0;
  if (now - h.at > HOLD_MS) {
    held.delete(threadId);
    return 0;
  }
  if (ok) held.delete(threadId);
  try {
    return report([h.served], 'message_sent', ok);
  } catch {
    return 0;
  }
}

/** The "meet at" location sheet's send answered (only when the sheet was opened by the bar). */
export function reportMeetAtSend(ok: boolean, report: Reporter = reportServedTask): number {
  try {
    return report([meetAtServed()], 'message_sent', ok);
  } catch {
    return 0;
  }
}

/** Test seam. */
export function _resetComposerOutcomesForTests(): void {
  held.clear();
}
