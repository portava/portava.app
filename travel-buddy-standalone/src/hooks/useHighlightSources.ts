/**
 * useHighlightSources — §12 / §3.6 provenance for one Highlight.
 *
 * Highlights/Memories Development Architecture Spec v1 §12 ("Highlights are
 * disposable, audience-specific projections over Memories and Episodes").
 * Census H93.
 *
 * ── WHY THIS IS LAZY, AND WHY THAT IS NOT AN OPTIMISATION ──────────────────
 *
 * `GET /highlights/:id/sources` is one request per Highlight and is owner-only.
 * A list screen that fetched provenance for every row on mount would issue N
 * owner-scoped reads for information nobody asked for, and — worse — would have
 * to render SOMETHING for each row before the answers arrived. The only honest
 * thing to render in that gap is "unknown", and a list where every row says
 * "unknown" for a second and then changes its mind is a list that has taught
 * its reader to ignore the field. So nothing is fetched until a row is opened,
 * and a row that has not been opened says nothing at all.
 *
 * ── THE FOUR STATES ARE FOUR, NOT TWO ──────────────────────────────────────
 *
 *   'idle'     — nobody asked. NOT "no sources".
 *   'loading'  — asked, no answer yet. NOT "no sources".
 *   'ready'    — the server answered. `sources` may legitimately be empty, and
 *                an empty `ready` is the real §12 finding: this Highlight is
 *                sourceless.
 *   'refused'  — the server could not or would not answer, and `errorKind`
 *                says which. NOT "no sources".
 *
 * §28.11 forbids swallowing a failed read "into plausible-looking empty
 * history"; three of these four states collapse to an empty list if the
 * distinction is not carried, and a sourceless Highlight is exactly the claim
 * H93 is about. So the distinction is carried.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchHighlightSources,
  type HighlightSource,
  type HighlightErrorKind,
} from '../services/highlights.ts';

export type HighlightSourcesStatus = 'idle' | 'loading' | 'ready' | 'refused';

export interface HighlightSourcesState {
  status: HighlightSourcesStatus;
  /** Meaningful only when `status === 'ready'`. */
  sources: HighlightSource[];
  /** Meaningful only when `status === 'refused'`. */
  errorKind: HighlightErrorKind | null;
  /** Meaningful only when `status === 'refused'`. */
  message: string | null;
  /** Ask. Idempotent while a request is in flight. */
  load: () => void;
}

export function useHighlightSources(
  highlightId: string | null,
  /** Nothing is fetched until this is true. See the header. */
  enabled: boolean,
): HighlightSourcesState {
  const [status, setStatus] = useState<HighlightSourcesStatus>('idle');
  const [sources, setSources] = useState<HighlightSource[]>([]);
  const [errorKind, setErrorKind] = useState<HighlightErrorKind | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // Survives re-render without re-triggering the effect, so a second `load()`
  // during a flight is a no-op rather than a second request.
  const inFlight = useRef(false);

  const load = useCallback(() => {
    if (inFlight.current) return;
    setAttempt((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!enabled || !highlightId) {
      // Going back to disabled RESETS to idle rather than keeping the last
      // answer: a collapsed row that reopens against a different Highlight
      // must not flash the previous one's provenance.
      setStatus('idle');
      setSources([]);
      setErrorKind(null);
      setMessage(null);
      return;
    }
    let cancelled = false;
    inFlight.current = true;
    setStatus('loading');
    void fetchHighlightSources(highlightId)
      .then((r) => {
        if (cancelled) return;
        if (r.ok && r.data) {
          setSources(r.data);
          setErrorKind(null);
          setMessage(null);
          setStatus('ready');
          return;
        }
        // NOT `setSources([])` plus `ready`. See the header.
        setSources([]);
        setErrorKind(r.errorKind ?? 'db_error');
        setMessage(r.message ?? null);
        setStatus('refused');
      })
      .catch(() => {
        if (cancelled) return;
        setSources([]);
        setErrorKind('db_error');
        setMessage(null);
        setStatus('refused');
      })
      .finally(() => {
        inFlight.current = false;
      });
    return () => {
      cancelled = true;
      inFlight.current = false;
    };
  }, [highlightId, enabled, attempt]);

  return { status, sources, errorKind, message, load };
}
