/**
 * Telegraph §7 API client — receipts and unsend-before-seen.
 *
 *   GET  /api/threads/:id/receipts?messageIds=…   §7.3
 *   POST /api/threads/:id/messages/:id/unsend     §7.4
 *
 * §7.1's DELIVERED has no representation here on purpose. The server returns
 * `delivered: null` with a reason because nothing on this deployment produces a
 * delivery signal, and this module passes both through untouched rather than
 * collapsing them into a boolean the UI would then have to guess about.
 */
import { isSupabaseConfigured } from '../../../lib/supabase.ts';
import { freshToken } from '../../../services/apiToken.ts';

/** §7.1's lifecycle, as much of it as this deployment can actually report. */
export type ReceiptStatus = 'SENT' | 'SEEN';

export interface MessageReceipt {
  messageId: string;
  status: ReceiptStatus;
  /** Always null. See `deliveredUnavailableReason`. */
  delivered: null;
  deliveredUnavailableReason: string;
  seenBy: number;
  seenByUserIds: string[];
  recipientCount: number;
}

/**
 * NOTE — `fetchReceipts` and `markSeen` are at the foot of this module.
 * `GET /api/threads/:id/receipts` applies two guarantees at the API level: the
 * §14.3 window, and the rule that a caller only ever learns who read THEIR OWN
 * messages. Until 2026-10-03 this note said no screen called it, because both
 * chat surfaces read every member's `last_read_at` themselves and derived
 * receipts with `deriveReceiptState`. That copy was read ONCE, when the thread
 * opened, and never refreshed, so a message read while its sender watched said
 * "Sent"; and a read that failed left it empty, so every message said "Sent".
 * Both screens now go through `useThreadReadState`, which reads receipts from
 * the server, re-reads them when a read lands, and keeps a failed read
 * distinct. `deriveReceiptState` still decides one thing on the client: whether
 * a direct chat's `read.updated` event already covers a message, so "Seen" can
 * show before the refetch confirms it.
 */

/**
 * The server's own reason, mirrored so a client-built receipt carries it too.
 * A receipt assembled locally must not quietly drop the explanation for why
 * DELIVERED is absent — that explanation is the honest part.
 */
export const DELIVERED_UNAVAILABLE_CLIENT =
  'No delivery signal exists on this deployment: there is no per-device ' +
  'acknowledgement and no lastDeliveredSequence column, so DELIVERED cannot be ' +
  'reported as true or false.';

export type UnsendRefusal = 'not_sender' | 'not_a_member' | 'already_gone' | 'seen_by_recipient';

export interface UnsendSuccess {
  id: string;
  unsent: true;
  unsentAt?: string;
  seenBy: number;
  recipientCount: number;
  lifecycleState: null;
  lifecycleStateUnavailableReason: string;
  /**
   * Both are now ALWAYS `false` on a success and on a `seen_by_recipient`
   * refusal, and they used to be present only when the compensation scheme had
   * something to report — including `null`, when its re-read failed and it
   * could not say. The server resolves the race with a row lock now, so there
   * is no window to detect and nothing to put back. They stay optional here so
   * a client built against an older server still parses, and no code should
   * start branching on them: there is nothing left for them to distinguish.
   */
  raceDetected?: boolean;
  compensated?: boolean;
  message?: string;
}

export type LifecycleResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; message?: string; seenBy?: number };

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

async function call<T>(path: string, init?: RequestInit): Promise<LifecycleResult<T>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'unconfigured' };
  const token = await freshToken();
  if (!token) return { ok: false, error: 'unauthenticated' };
  try {
    const res = await fetch(`${apiBase()}${path}`, {
      ...init,
      headers: {
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        Authorization: `Bearer ${token}`,
        ...(init?.headers ?? {}),
      },
    });
    const body = await res.json().catch(() => ({}) as any);
    if (!res.ok) {
      return {
        ok: false,
        error: String(body?.error ?? res.status),
        message: body?.message,
        seenBy: typeof body?.seenBy === 'number' ? body.seenBy : undefined,
      };
    }
    return { ok: true, data: body as T };
  } catch (e) {
    return { ok: false, error: 'network', message: e instanceof Error ? e.message : undefined };
  }
}

export async function unsendMessage(
  threadId: string,
  messageId: string,
): Promise<LifecycleResult<UnsendSuccess>> {
  return call<UnsendSuccess>(`/api/threads/${threadId}/messages/${messageId}/unsend`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

/**
 * §7.3's label for a receipt.
 *
 * A DIRECT chat (one recipient) says "Seen". A GROUP says "Seen by N" — the
 * spec's own two shapes. Neither ever says "Delivered", because nothing here
 * knows whether it was.
 */
export function receiptLabel(receipt: MessageReceipt): string {
  if (receipt.seenBy === 0) return 'Sent';
  if (receipt.recipientCount <= 1) return 'Seen';
  return `Seen by ${receipt.seenBy}`;
}

/** One member's read position, as the two chat screens already hold it. */
export interface MemberRead {
  userId: string;
  lastReadAt: string | null;
}

/**
 * §7.3's receipt for one of the caller's own messages, derived LOCALLY from the
 * reads the screen already has.
 *
 * ── WHAT THIS REPLACED ──────────────────────────────────────────────────────
 * Both chat screens computed the receipt inline, and both FABRICATED
 * "Delivered":
 *
 *     const ageSecs = (Date.now() - new Date(msg.createdAt).getTime()) / 1000;
 *     return ageSecs > 3 ? 'delivered' : 'sent';
 *
 * A double tick reading "Delivered" appeared because three seconds had passed.
 * Nothing on this deployment produces a delivery signal — no per-device
 * acknowledgement, no `lastDeliveredSequence` column — so that tick was a claim
 * about the recipient's device that nobody measured, and §7.1's DELIVERED state
 * is precisely the one this tree cannot report. The direct-chat branch was the
 * same mistake in a subtler form: it returned 'delivered' whenever the other
 * party's `last_read_at` was merely older than the message.
 *
 * There is no 'delivered' in the return type any more. SEEN is measured — a
 * recipient's `last_read_at` has passed the message, the same predicate §7.4's
 * unsend window uses — and everything else is SENT.
 */
export function deriveReceiptState(input: {
  createdAt: string;
  /** The other party's last_read_at, for a direct chat. */
  otherLastReadAt?: string | null;
  /** Every other member's read position, for a group. */
  memberReads?: MemberRead[];
}): 'sent' | 'read' {
  const created = new Date(input.createdAt).getTime();
  if (Number.isNaN(created)) return 'sent';
  const passed = (at: string | null | undefined) =>
    !!at && !Number.isNaN(new Date(at).getTime()) && new Date(at).getTime() >= created;

  if (input.memberReads && input.memberReads.length > 0) {
    return input.memberReads.some((r) => passed(r.lastReadAt)) ? 'read' : 'sent';
  }
  return passed(input.otherLastReadAt) ? 'read' : 'sent';
}

/**
 * §7.3's "Seen by N" count for a group.
 *
 * Returns null when there is nothing to count, so a caller renders the plain
 * "Seen" rather than "Seen by 0" — a receipt that reports an absence reads as
 * an accusation.
 */
export function deriveSeenBy(createdAt: string, memberReads: MemberRead[]): number | null {
  const created = new Date(createdAt).getTime();
  if (Number.isNaN(created)) return null;
  const n = memberReads.filter(
    (r) => !!r.lastReadAt && new Date(r.lastReadAt).getTime() >= created,
  ).length;
  return n > 0 ? n : null;
}

/**
 * Whether §7.4 would currently allow an unsend, from the client's point of
 * view.
 *
 * This is an AFFORDANCE decision, not an authorization one: the server checks
 * again and is the only thing that decides. Hiding the action on a seen message
 * is how a sender learns the rule; it is not how the rule is enforced.
 */
export function canOfferUnsend(receipt: MessageReceipt | null | undefined): boolean {
  if (!receipt) return false;
  return receipt.seenBy === 0;
}

/**
 * `GET /api/threads/:id/receipts` — §7.3's receipts for the caller's OWN
 * messages, at most 100 ids per call (the server refuses more).
 *
 * The screens used to read every member's `last_read_at` straight from
 * `message_thread_members` ONCE, when the thread opened: never refreshed, so a
 * message read while the sender watched said "Sent" until they left and came
 * back; read as empty when it FAILED, so every message said "Sent" — a negative
 * nobody measured; and outside the two guarantees this endpoint applies (the
 * §14.3 window, and that a caller learns only who read THEIR OWN messages).
 */
export async function fetchReceipts(
  threadId: string,
  messageIds: string[],
): Promise<LifecycleResult<{ threadId: string; receipts: MessageReceipt[] }>> {
  return call(`/api/threads/${threadId}/receipts?messageIds=${encodeURIComponent(messageIds.join(','))}`);
}

/**
 * `POST /api/threads/:id/seen` — §7.2's "seen", stated as the newest MESSAGE
 * the person actually had on screen rather than a clock reading. The server
 * refuses a message that is not in the thread, is a tombstone, or is outside
 * the caller's §14.3 window, and never moves the marker backwards.
 */
export async function markSeen(
  threadId: string,
  upToMessageId: string,
): Promise<LifecycleResult<{ advanced: boolean; lastReadAt: string | null }>> {
  return call(`/api/threads/${threadId}/seen`, {
    method: 'POST',
    body: JSON.stringify({ upToMessageId }),
  });
}
