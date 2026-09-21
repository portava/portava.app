/**
 * Telegraph §10.3 — is there anything to look back on?
 *
 * The recap's entry point must not be a button that is always there. §9's
 * coordination panel is gone by the time a plan is COMPLETE (COMPLETE is not a
 * coordinating state), so the recap needs its own affordance — and an
 * affordance that appears whether or not a session happened would be the app
 * asserting a night that nobody confirmed, which is the "automatic historical
 * truth" §10.3 refuses.
 *
 * So this hook performs the §10.3 READ once and reports whether the server
 * found a completed plan. The button appears only when it did.
 *
 * THIS HOOK WRITES NOTHING. `GET /threads/:id/recap` is a read; the server
 * returns `wrote: "nothing"` and this hook passes it through untouched. There
 * is no path from opening a thread to creating a Memory.
 */
import { useEffect, useState } from 'react';
import { fetchRecap, type RecapResponse } from './memoryApi.ts';

export interface ThreadRecapState {
  /** True only when the server returned a recap for a COMPLETED plan. */
  available: boolean;
  /** The response, so the sheet does not refetch what we already read. */
  response: RecapResponse | null;
  loading: boolean;
  /** Why there is nothing, when there is nothing. */
  reason: string | null;
}

export function useThreadRecap(threadId: string | null | undefined): ThreadRecapState {
  const [state, setState] = useState<ThreadRecapState>({
    available: false,
    response: null,
    loading: false,
    reason: null,
  });

  useEffect(() => {
    if (!threadId) return;
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    void (async () => {
      const r = await fetchRecap(threadId);
      if (cancelled) return;
      if (!r.ok) {
        // A failed read is NOT "there was no night". We simply do not offer
        // the affordance, rather than offering an empty recap.
        setState({ available: false, response: null, loading: false, reason: r.error });
        return;
      }
      setState({
        available: r.data.recap !== null,
        response: r.data,
        loading: false,
        reason: r.data.recap === null ? (r.data.reason ?? 'no_completed_plan') : null,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  return state;
}
