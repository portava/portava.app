/**
 * Telegraph §5.3 — the hook that makes a shared card revocable.
 *
 * "If the source becomes deleted, private or unauthorized, the Telegraph
 * reference must degrade to an unavailable state. Telegraph is never a
 * backdoor into revoked source content."
 *
 * THREE STATES, NOT TWO, and the third one matters. `unknown` means the
 * resolve could not run — no thread id, an unmappable legacy source type, a
 * network failure, an unconfigured build. A card in `unknown` renders exactly
 * as it did before §5 existed. Collapsing `unknown` into `available` is the
 * backdoor; collapsing it into `unavailable` blanks every card in the thread
 * the moment the network hiccups. Neither is acceptable, so it is its own
 * state and every caller must handle it.
 */
import { useEffect, useState } from 'react';
import {
  resolveShareProjections,
  type ResolvedShare, type SharedCardTruth,
  type ShareRef,
  type UnavailableReason,
} from './shareApi.ts';

export type RevocationState = 'loading' | 'available' | 'unavailable' | 'unknown';

export interface ShareRevocation {
  state: RevocationState;
  reason: UnavailableReason | null;
  resolved: ResolvedShare | null;
}

const UNKNOWN: ShareRevocation = { state: 'unknown', reason: null, resolved: null };

/** Human copy for an unavailable reference. Never names the source. */
export function revokedLabel(reason: UnavailableReason | null): string {
  switch (reason) {
    case 'deleted':
      return 'This content was removed';
    case 'private':
      return 'This content is now private';
    case 'unauthorized':
      return 'You no longer have access to this';
    case 'not_found':
      return 'This content is no longer available';
    default:
      return 'This content is no longer available';
  }
}

export function useShareRevocation(
  threadId: string | null | undefined,
  ref: ShareRef | null, /** census-telegraph T448: the server's truth for this card, when the message carried one. */ serverCard?: SharedCardTruth | null,
): ShareRevocation {
  const fromServer = revocationFromServerCard(serverCard, ref?.messageId ?? null);
  const [value, setValue] = useState<ShareRevocation>(
    fromServer ?? (threadId && ref ? { state: 'loading', reason: null, resolved: null } : UNKNOWN),
  );

  const objectType = ref?.objectType ?? null;
  const objectId = ref?.objectId ?? null;
  const messageId = ref?.messageId ?? null;
  const serverKey = fromServer ? `${fromServer.state}:${fromServer.reason ?? ''}` : null;

  useEffect(() => {
    // The server already resolved this card for this viewer, in the page's one
    // batch: asking again per card is the N+1 the batch exists to remove.
    if (serverKey !== null) return;
    if (!threadId || !objectType || !objectId) {
      setValue(UNKNOWN);
      return;
    }
    let cancelled = false;
    setValue({ state: 'loading', reason: null, resolved: null });
    void (async () => {
      const r = await resolveShareProjections(threadId, [
        { objectType, objectId, messageId },
      ]);
      if (cancelled) return;
      if (!r.ok) {
        // Could not tell. Not "available", not "revoked".
        setValue(UNKNOWN);
        return;
      }
      const first = r.data.projections[0];
      if (!first) {
        // The server named it unsupported rather than dropping it; that is a
        // "cannot tell", not a revocation.
        setValue(UNKNOWN);
        return;
      }
      setValue(
        first.available
          ? { state: 'available', reason: null, resolved: first }
          : { state: 'unavailable', reason: first.reason, resolved: first },
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [threadId, objectType, objectId, messageId, serverKey]);

  return fromServer ?? value;
}

/**
 * The server's card truth as this hook's three states.
 *
 *   live                     → available, with the server's projection and actions;
 *   unavailable (a reason)   → unavailable — the card draws the revoked notice;
 *   unavailable (`unknown`)  → unknown: the server could not READ the source, which
 *                              is "cannot tell", not "revoked" — the card draws the
 *                              reference only, never the snapshot;
 *   withheld                 → unknown: the card names no source the server can
 *                              resolve, so nothing from one may be shown.
 *
 * Returns null when there is no server truth (an older server): the hook then
 * resolves for itself as it always did.
 */
export function revocationFromServerCard(
  card: SharedCardTruth | null | undefined,
  messageId: string | null,
): ShareRevocation | null {
  if (!card) return null;
  if (card.state === 'live') {
    return {
      state: 'available',
      reason: null,
      resolved: {
        objectType: card.objectType,
        objectId: card.objectId,
        messageId,
        available: true,
        status: card.status,
        projection: card.projection,
        actions: card.actions,
        deepLink: card.deepLink,
      },
    };
  }
  if (card.state === 'unavailable' && card.reason !== 'unknown') {
    return {
      state: 'unavailable',
      reason: card.reason,
      resolved: {
        objectType: card.objectType,
        objectId: card.objectId,
        messageId,
        available: false,
        status: card.reason,
        reason: card.reason,
        projection: null,
        actions: [],
        deepLink: card.deepLink,
      },
    };
  }
  return UNKNOWN;
}
