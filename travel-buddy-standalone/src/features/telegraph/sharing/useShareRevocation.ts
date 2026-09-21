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
  type ResolvedShare,
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
  ref: ShareRef | null,
): ShareRevocation {
  const [value, setValue] = useState<ShareRevocation>(
    threadId && ref ? { state: 'loading', reason: null, resolved: null } : UNKNOWN,
  );

  const objectType = ref?.objectType ?? null;
  const objectId = ref?.objectId ?? null;
  const messageId = ref?.messageId ?? null;

  useEffect(() => {
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
  }, [threadId, objectType, objectId, messageId]);

  return value;
}
