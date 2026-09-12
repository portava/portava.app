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
