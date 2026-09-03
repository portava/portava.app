/**
 * useWallSessionIntent — the temporary typed steer for For You (Wall spec §17).
 *
 * A typed/voice intent ("food", "Bangkok nightlife", "just friends") steers For
 * You for THIS session only. It never changes a saved preference. Two pieces of
 * state:
 *   - `intentText`: the raw steer string. This is what the feed hook passes as
 *     the per-request `session_intent` query param — a TEMPORARY steer the
 *     server parses fresh and does NOT persist. Clearing it restores the prior
 *     (unsteered) feed exactly, with no server round-trip required.
 *   - `intent`: the STRUCTURED interpretation (canonical filters, not raw
 *     strings — spec §17) returned by POST /wall/session-intent, used to render
 *     filter chips. Purely presentational; its absence never blocks steering.
 *
 * `clearIntent()` drops both locally (restoring prior state immediately) and
 * fires DELETE /wall/session-intent to clear any stored intent server-side.
 */

import { useCallback, useState } from 'react';
import { clearSessionIntent, setSessionIntent } from '../services/wallApi.ts';
import type { StructuredIntent } from '../types/wallProjection.ts';

export interface UseWallSessionIntentOptions {
  /** Seed a structured intent already known from a prior WallResponse. */
  initial?: StructuredIntent | null;
  /** Seed the raw steer text matching `initial` (so the feed steers on mount). */
  initialText?: string | null;
}

export interface UseWallSessionIntentResult {
  /** Structured interpretation for chips (may be null even while steering). */
  intent: StructuredIntent | null;
  /** Raw steer text driving the feed's `session_intent` param. */
  intentText: string | null;
  /** True while an intent is steering the feed. */
  active: boolean;
  pending: boolean;
  error: string | null;
  setIntent: (text: string) => Promise<void>;
  clearIntent: () => void;
}

export function useWallSessionIntent(
  opts: UseWallSessionIntentOptions = {},
): UseWallSessionIntentResult {
  const [intent, setStructuredIntent] = useState<StructuredIntent | null>(opts.initial ?? null);
  const [intentText, setIntentText] = useState<string | null>(opts.initialText ?? null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clearIntent = useCallback(() => {
    // Restore prior state immediately — the feed hook sees a null steer and
    // starts a fresh, unsteered session.
    setIntentText(null);
    setStructuredIntent(null);
    setError(null);
    // Best-effort: also clear any server-stored intent.
    void clearSessionIntent();
  }, []);

  const setIntent = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) {
        clearIntent();
        return;
      }
      // Steer immediately with the raw text (temporary per-request steer §17).
      setIntentText(trimmed);
      setPending(true);
      setError(null);
      try {
        const res = await setSessionIntent(trimmed);
        if (res.ok) {
          setStructuredIntent(res.sessionIntent);
        } else {
          // Steering by raw text still applies; we just lack structured chips.
          setStructuredIntent(null);
          setError(res.error);
        }
      } finally {
        setPending(false);
      }
    },
    [clearIntent],
  );

  return {
    intent,
    intentText,
    active: intentText != null,
    pending,
    error,
    setIntent,
    clearIntent,
  };
}
