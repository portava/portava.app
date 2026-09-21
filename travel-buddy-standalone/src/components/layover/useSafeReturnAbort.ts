/**
 * useSafeReturnAbort — §15.1's one-tap abort, owned by the SCREEN rather than
 * by one card.
 *
 * WHY IT MOVED. The abort used to live inside `LayoverSafeReturnCard`, which
 * made that card the only place on the surface able to offer it. Census L42
 * ("switch primary CTA to Return to Airport") and L123 ("map element Airport —
 * always visible; return CTA anchor") both ask for a SECOND entry point to the
 * same action, and §13.4 recorded why neither was built: *"Closing this
 * honestly means lifting the abort handler into the screen."* This is that
 * lift. There is still exactly ONE `POST /return-now` on the surface and
 * exactly one place the RETURN CONTRACT it hands back is rendered — the card —
 * so a second button cannot produce a second contract or lose the first.
 *
 * WHAT IS PRESERVED EXACTLY, because it is the safety-critical part:
 *   - the double-press guard is a REF, not state: two taps inside one frame
 *     both read `busy === false` before React commits, and the ref is written
 *     synchronously so the second one is refused;
 *   - `ok` and `partial` both changed server state, and `already_ended` means
 *     this screen is holding a stale session, so all three reload;
 *   - a PARTIAL failure still carries a contract and a posture, and they are
 *     kept, because the one instruction that must survive a half-failed abort
 *     is "head to the airport now".
 */
import { useCallback, useRef, useState } from 'react';
import {
  returnToAirportNow,
  type ReturnContract,
  type ReturnNowOutcome,
  type SafeReturnPosture,
} from '../../services/layover.ts';

export interface SafeReturnAbortState {
  outcome: ReturnNowOutcome;
  /** The contract, wherever it came from — success body or failure body. */
  contract: ReturnContract | null;
  posture: SafeReturnPosture | null;
}

export interface SafeReturnAbortController {
  busy: boolean;
  state: SafeReturnAbortState | null;
  /** Fire the abort. Safe to call from more than one control. */
  run: () => void;
}

export function useSafeReturnAbort(
  sessionId: string | undefined,
  onAborted?: () => void,
): SafeReturnAbortController {
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<SafeReturnAbortState | null>(null);
  const inFlight = useRef(false);

  const run = useCallback(() => {
    if (!sessionId) return;
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    void (async () => {
      try {
        const outcome = await returnToAirportNow(sessionId);
        const contract =
          outcome.kind === 'ok' ? outcome.result.returnContract
          : outcome.kind === 'partial' ? outcome.returnContract
          : null;
        const nextPosture =
          outcome.kind === 'ok' ? outcome.result.posture
          : outcome.kind === 'partial' ? outcome.posture
          : null;
        setState({ outcome, contract, posture: nextPosture });
        if (outcome.kind === 'ok' || outcome.kind === 'partial' || outcome.kind === 'already_ended') {
          onAborted?.();
        }
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    })();
  }, [sessionId, onAborted]);

  return { busy, state, run };
}
