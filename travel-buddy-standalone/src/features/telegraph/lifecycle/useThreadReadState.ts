/**
 * Telegraph §7.2 / §7.3 / §30A.15 — read state that works while you look at it.
 *
 * WHAT WAS BROKEN (TELEGRAPH lane, 2026-10-03)
 * ============================================
 *   1. SEEN WAS STAMPED ONCE. The thread screen called `POST /threads/:id/read`
 *      from a mount effect and never again, and the trip/circle chat never
 *      called it at all. A message that arrived while the person was looking
 *      at the conversation stayed unread: their badge counted it, and its
 *      sender's receipt said "Sent" for a message that had been read.
 *   2. RECEIPTS WERE READ ONCE. Both screens read every member's
 *      `last_read_at` from `message_thread_members` when the thread opened and
 *      never refreshed it, although the server publishes `read.updated` and
 *      `message.seen` the moment a read lands. "Seen" appeared only after the
 *      sender left the conversation and came back.
 *   3. A FAILED RECEIPT READ SAID "SENT". The read's error was never looked at,
 *      so an outage produced an empty copy and every message read "Sent" — a
 *      claim that nobody had read it, which nobody had measured.
 *
 * WHAT THIS DOES
 * ==============
 *   - Marks SEEN with the newest message actually rendered (`seenThreshold`),
 *     through the message-anchored `POST /threads/:id/seen`, and only while the
 *     screen is FOCUSED and the app is in the FOREGROUND — §7.2's "push
 *     delivery, app launch and background rendering do not count as seen". It
 *     re-marks whenever a newer message is rendered, never repeats a mark that
 *     succeeded, and does not hammer one that failed: it retries when the
 *     threshold changes or the screen comes back into view.
 *   - Reads receipts for the caller's own messages from
 *     `GET /threads/:id/receipts` (the server applies the §14.3 window and only
 *     ever reports who read the caller's OWN messages), and reads again when
 *     the server says a read happened, when a new message of theirs is
 *     accepted, when the app returns to the foreground, and — only while the
 *     realtime stream is not open — on a slow timer.
 *   - Keeps a failed read DISTINCT: `receiptsState: 'unavailable'`, which the
 *     status renders as "read status unavailable", not "Sent".
 *   - Observes the server's live `message.delivered` receipts for this thread.
 *
 * Stale responses are fenced by a generation counter: a receipts answer that
 * arrives after a newer request was issued, or after the thread changed, is
 * dropped rather than painted over the newer one.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { useFocusEffect } from 'expo-router';

import { telegraphRealtime, type TelegraphEvent } from '../../../services/telegraphRealtimeService.ts';
import { broadcastUnreadCounts } from '../../../hooks/useMessaging.ts';
import { deriveReceiptState, fetchReceipts, markSeen, type MessageReceipt } from './lifecycleApi.ts';
import {
  applyReadToReceipts,
  deliveryFromPayload,
  isServerMessageId,
  ownMessageStatus,
  seenThreshold,
  type DeliveryObservation,
  type OwnMessageStatus,
  type ReceiptsState,
} from './readState.ts';

/** The server refuses more than this many ids per receipts call (`RECEIPTS_MAX_IDS`). */
export const RECEIPTS_MAX_IDS = 100;
/** Several read events in a burst cost one refetch. */
export const RECEIPTS_REFRESH_DEBOUNCE_MS = 400;
/** The safety net while no realtime stream is open to say a read happened. */
export const RECEIPTS_FALLBACK_POLL_MS = 20_000;

/** What the hook needs from a message. `Message` from services/messaging satisfies it. */
export interface ReadStateMessage {
  id: string;
  senderId: string;
  createdAt: string;
  deleted?: boolean;
  deliveryStatus?: 'sending' | 'sent' | 'failed' | null;
}

export interface ThreadReadState {
  /** Null for a message that is not the caller's, or whose receipt has not been read yet. */
  statusFor: (m: ReadStateMessage) => OwnMessageStatus | null;
  /** The receipt for the long-press sheet. Null when unknown — never a guessed SENT. */
  receiptFor: (m: ReadStateMessage) => MessageReceipt | null;
  /** Who has read one of the caller's messages, for the reader chips. */
  readersFor: (m: ReadStateMessage) => string[];
  receiptsState: ReceiptsState;
  refreshReceipts: () => void;
}

function isForeground(s: AppStateStatus | null | undefined): boolean {
  return s !== 'background' && s !== 'inactive';
}

export function useThreadReadState(args: {
  threadId: string | null | undefined;
  messages: readonly ReadStateMessage[];
  viewerId: string | null | undefined;
}): ThreadReadState {
  const { threadId, messages, viewerId } = args;

  // ── Is the person looking? ────────────────────────────────────────────────
  const [focused, setFocused] = useState(false);
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );
  const [foreground, setForeground] = useState(isForeground(AppState.currentState));
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => setForeground(isForeground(next)));
    return () => { sub?.remove?.(); };
  }, []);
  const looking = focused && foreground;

  // ── SEEN ──────────────────────────────────────────────────────────────────
  const threshold = useMemo(() => seenThreshold(messages), [messages]);
  const marked = useRef<{ threadId: string; id: string } | null>(null);
  const failed = useRef<{ threadId: string; id: string } | null>(null);
  const marking = useRef(false);
  const [markTick, setMarkTick] = useState(0);

  // Coming back into view is a fresh chance for a mark that failed.
  useEffect(() => { if (looking) failed.current = null; }, [looking]);

  useEffect(() => {
    if (!threadId || !threshold || !looking || marking.current) return;
    const same = (r: { threadId: string; id: string } | null) => r?.threadId === threadId && r.id === threshold;
    if (same(marked.current) || same(failed.current)) return;
    marking.current = true;
    const target = { threadId, id: threshold };
    void markSeen(threadId, threshold).then((r) => {
      marking.current = false;
      if (r.ok) {
        marked.current = target;
        // The badge reads unread counts from the server; ask it again now that
        // this read has landed rather than on its next 15-second tick.
        broadcastUnreadCounts(null);
      } else {
        failed.current = target;
      }
      // A newer message may have been rendered while this was in flight.
      setMarkTick((n) => n + 1);
    });
  }, [threadId, threshold, looking, markTick]);

  // ── RECEIPTS ──────────────────────────────────────────────────────────────
  const ownIds = useMemo(() => {
    if (!viewerId) return [] as string[];
    return messages
      .filter((m) => m.senderId === viewerId && !m.deleted && isServerMessageId(m.id)
        && m.deliveryStatus !== 'sending' && m.deliveryStatus !== 'failed')
      .slice()
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, RECEIPTS_MAX_IDS)
      .map((m) => m.id);
  }, [messages, viewerId]);
  const idsKey = ownIds.join(',');
  const ownIdSet = useMemo(() => new Set(ownIds), [idsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const [receipts, setReceipts] = useState<Map<string, MessageReceipt>>(() => new Map());
  const [receiptsState, setReceiptsState] = useState<ReceiptsState>('idle');
  const [deliveries, setDeliveries] = useState<Map<string, DeliveryObservation>>(() => new Map());
  const generation = useRef(0);
  const latest = useRef({ threadId, ownIds, messages });
  latest.current = { threadId, ownIds, messages };

  // A different conversation starts from nothing, and anything in flight for
  // the previous one is fenced off.
  useEffect(() => {
    generation.current += 1;
    setReceipts(new Map());
    setDeliveries(new Map());
    setReceiptsState('idle');
  }, [threadId]);

  const refreshReceipts = useCallback(() => {
    const { threadId: tid, ownIds: ids } = latest.current;
    if (!tid || ids.length === 0) return;
    const gen = ++generation.current;
    setReceiptsState((s) => (s === 'idle' ? 'loading' : s));
    void fetchReceipts(tid, ids).then((r) => {
      if (gen !== generation.current) return; // superseded, or the thread changed
      if (r.ok) {
        setReceipts(new Map((r.data.receipts ?? []).map((x) => [x.messageId, x])));
        setReceiptsState('ready');
      } else {
        // Keep what was read: a SEEN receipt cannot become untrue (the marker
        // only moves forward). The STATE says the rest is unknown.
        setReceiptsState('unavailable');
      }
    });
  }, []);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefresh = useCallback((delay = RECEIPTS_REFRESH_DEBOUNCE_MS) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; refreshReceipts(); }, delay);
  }, [refreshReceipts]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  // A new message of the caller's accepted (or the first load): read again.
  useEffect(() => {
    if (!threadId || ownIds.length === 0) return;
    scheduleRefresh(0);
  }, [threadId, idsKey, scheduleRefresh]); // eslint-disable-line react-hooks/exhaustive-deps

  // Back in view, or back in the foreground: read again.
  useEffect(() => {
    if (looking) scheduleRefresh(0);
  }, [looking, scheduleRefresh]);

  // The server says a read or a delivery happened in THIS thread.
  useEffect(() => {
    if (!threadId) return;
    const unsub = telegraphRealtime.subscribe((evt: TelegraphEvent) => {
      if (evt.threadId !== threadId) return;
      if (evt.type === 'message.delivered') {
        const d = deliveryFromPayload(evt.payload ?? null);
        if (d) setDeliveries((prev) => new Map(prev).set(d.messageId, d.observation));
        return;
      }
      if (evt.type === 'read.updated') {
        const readerId = evt.payload?.userId;
        const lastReadAt = evt.payload?.lastReadAt;
        if (typeof readerId === 'string' && typeof lastReadAt === 'string') {
          // A DIRECT conversation has one recipient, so the server's own read
          // event is the whole receipt: show it now. A group waits for the
          // refetch, which applies each member's §14.3 eligibility.
          const createdAt = new Map(latest.current.messages.map((m) => [m.id, m.createdAt]));
          setReceipts((prev) => applyReadToReceipts(prev, readerId, (r) =>
            r.recipientCount <= 1 && createdAt.has(r.messageId)
              && deriveReceiptState({ createdAt: createdAt.get(r.messageId)!, otherLastReadAt: lastReadAt }) === 'read'));
        }
        scheduleRefresh();
        return;
      }
      if (evt.type === 'message.seen') scheduleRefresh();
    });
    return unsub;
  }, [threadId, scheduleRefresh]);

  // The safety net: with no open stream nobody will say a read happened.
  useEffect(() => {
    if (!threadId || !looking) return;
    const id = setInterval(() => {
      if (telegraphRealtime.getStatus() !== 'open') refreshReceipts();
    }, RECEIPTS_FALLBACK_POLL_MS);
    return () => clearInterval(id);
  }, [threadId, looking, refreshReceipts]);

  // ── Answers ───────────────────────────────────────────────────────────────
  const statusFor = useCallback((m: ReadStateMessage): OwnMessageStatus | null => {
    if (!viewerId || m.senderId !== viewerId) return null;
    if (m.deliveryStatus === 'sending' || m.deliveryStatus === 'failed') {
      return ownMessageStatus({ deliveryStatus: m.deliveryStatus, receiptsState });
    }
    const receipt = receipts.get(m.id) ?? null;
    const delivery = deliveries.get(m.id) ?? null;
    if (receipt || m.deliveryStatus === 'sent' || delivery) {
      return ownMessageStatus({ deliveryStatus: m.deliveryStatus ?? null, receipt, receiptsState, delivery });
    }
    // Not read yet (or outside the newest RECEIPTS_MAX_IDS): say nothing rather
    // than a "Sent" that would read as "unread" — unless the read failed.
    if (receiptsState === 'unavailable' && ownIdSet.has(m.id)) return { kind: 'receipt_unavailable' };
    return null;
  }, [viewerId, receipts, deliveries, receiptsState, ownIdSet]);

  const receiptFor = useCallback((m: ReadStateMessage): MessageReceipt | null => {
    if (!viewerId || m.senderId !== viewerId) return null;
    const r = receipts.get(m.id) ?? null;
    if (!r) return null;
    // A failed refresh leaves only SEEN trustworthy; a SENT copy may be stale.
    if (receiptsState === 'unavailable' && r.status !== 'SEEN') return null;
    return r;
  }, [viewerId, receipts, receiptsState]);

  const readersFor = useCallback((m: ReadStateMessage): string[] => {
    const r = receiptFor(m);
    return r && r.status === 'SEEN' ? r.seenByUserIds : [];
  }, [receiptFor]);

  return { statusFor, receiptFor, readersFor, receiptsState, refreshReceipts };
}
