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

export interface ReceiptsResponse {
  threadId: string;
  receipts: MessageReceipt[];
  deliveredUnavailableReason: string;
  receiptStorage: string;
}

export type UnsendRefusal = 'not_sender' | 'not_a_member' | 'already_gone' | 'seen_by_recipient';

export interface UnsendSuccess {
  id: string;
  unsent: true;
  unsentAt?: string;
  seenBy: number;
  recipientCount: number;
  lifecycleState: null;
  lifecycleStateUnavailableReason: string;
  /** Present only in the compensation-failed case. */
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

export async function fetchReceipts(
  threadId: string,
  messageIds: string[],
): Promise<LifecycleResult<ReceiptsResponse>> {
  if (messageIds.length === 0) return { ok: false, error: 'no_ids' };
  const qs = encodeURIComponent(messageIds.join(','));
  return call<ReceiptsResponse>(`/api/threads/${threadId}/receipts?messageIds=${qs}`);
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
