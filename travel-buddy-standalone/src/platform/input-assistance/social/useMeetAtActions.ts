/**
 * Global Input Intelligence — §54 action candidates for the Telegraph composer
 * (flow GII-F10).
 *
 * States, each true:
 *   idle     — the draft does not end in "meet at …"; nothing was sent;
 *   loading  — the fragment is with the gateway;
 *   ready    — candidates arrived (`partial` when a source could not be read,
 *              e.g. the Trip read — the bar says so rather than implying the
 *              person has no Trip stops);
 *   error    — the request failed; `retry` re-sends it. A failure is never
 *              rendered as "no suggestions".
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { requestSuggestions } from '../services/inputAssistance.ts';
import {
  TELEGRAPH_COMPOSER_CAPABILITIES,
  TELEGRAPH_MESSAGE_FIELD_ID,
  meetAtFragment,
  parseMeetAtCandidates,
  type MeetAtCandidate,
} from './telegraphMeetAt.ts';

export type MeetAtState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready'; candidates: MeetAtCandidate[]; partial: boolean }
  | { phase: 'error'; message: string };

export const MEET_AT_DEBOUNCE_MS = 300;

export function useMeetAtActions(draft: string) {
  const fragment = meetAtFragment(draft);
  const [state, setState] = useState<MeetAtState>({ phase: 'idle' });
  const [attempt, setAttempt] = useState(0);
  const ctrlRef = useRef<AbortController | null>(null);

  useEffect(() => {
    ctrlRef.current?.abort();
    if (!fragment) {
      setState({ phase: 'idle' });
      return;
    }
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setState((prev) => (prev.phase === 'ready' ? prev : { phase: 'loading' }));
    const timer = setTimeout(async () => {
      const res = await requestSuggestions(
        { context: 'telegraph_message', fieldId: TELEGRAPH_MESSAGE_FIELD_ID, text: fragment, client: TELEGRAPH_COMPOSER_CAPABILITIES },
        ctrl.signal,
      );
      if (ctrl.signal.aborted) return;
      if (!res.ok) {
        if (res.aborted) return;
        setState({ phase: 'error', message: 'Couldn’t load meeting suggestions.' });
        return;
      }
      setState({ phase: 'ready', candidates: parseMeetAtCandidates(res.suggestions), partial: !!res.refusal });
    }, MEET_AT_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [fragment, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, retry, fragment };
}
