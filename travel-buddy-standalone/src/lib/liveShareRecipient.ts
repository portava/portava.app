/**
 * Pure helpers for Safe Return live sharing (TRUST-F10).
 *
 * `classifyRecipientResponse` reads the answer of
 * GET /api/safe-return/live-share/:shareId for the trusted contact's screen
 * (app/safe-return/[shareId].tsx → LiveShareRecipientView). The server keeps
 * three answers apart (routes/safeReturn.ts, the recipient route): a 404 says
 * the share is over, a 403 says it is not shared with you, a 503 says it could
 * not be read and to try again. A contact must never be told a share "has
 * ended" because a read failed — that is the difference between checking again
 * and assuming their friend is fine.
 *
 * `liveShareNoticeCopy` turns the start route's `recipientNotified` answer into
 * what the SHARER is told, so a contact who was not notified is never presented
 * as one who was.
 */

export interface RecipientShareData {
  shareId: string;
  status: 'active' | 'stopped' | 'expired';
  sharingUserName: string;
  approximateArea: string;
  areaStatus?: 'known' | 'none_recorded' | 'unavailable';
  expiresAt: string | null;
  secondsRemaining: number | null;
}

export type RecipientOutcome =
  | { kind: 'ok'; share: RecipientShareData }
  | { kind: 'ended'; message: string }
  | { kind: 'forbidden'; message: string }
  | { kind: 'disabled'; message: string }
  | { kind: 'error'; message: string };

const RETRY_COPY = "We couldn't load this live share. Check your connection and try again.";

export function classifyRecipientResponse(status: number | null, body: unknown): RecipientOutcome {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const code = typeof b.error === 'string' ? b.error : null;
  const serverMessage = typeof b.message === 'string' && b.message.length > 0 ? b.message : null;

  if (status === 200) {
    const s = b.share as RecipientShareData | undefined;
    if (b.ok === true && s && typeof s === 'object' && typeof s.shareId === 'string') return { kind: 'ok', share: s };
    return { kind: 'error', message: RETRY_COPY };
  }
  if (code === 'feature_disabled') {
    return { kind: 'disabled', message: 'Live location sharing is not available right now.' };
  }
  if (status === 404) {
    const m = serverMessage ?? 'This live share is no longer available';
    return { kind: 'ended', message: m.endsWith('.') ? m : `${m}.` };
  }
  if (status === 403) {
    return { kind: 'forbidden', message: "This live share wasn't shared with you." };
  }
  return { kind: 'error', message: RETRY_COPY };
}

export function liveShareNoticeCopy(
  res: { recipientNotified?: boolean; recipientNoticeReason?: string },
  contactName: string,
): string | null {
  if (res.recipientNotified !== false) return null;
  if (res.recipientNoticeReason === 'recipient_not_on_portava') {
    return `${contactName} isn't on Portava, so they weren't notified in the app. Let them know another way that you're sharing your location.`;
  }
  // Blocked, suppressed by a privacy setting, or the notice failed: the sharer
  // is told only that the contact was not notified. A block is never disclosed.
  return `Sharing started, but ${contactName} wasn't notified in the app. Let them know another way.`;
}
