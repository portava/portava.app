/**
 * Global Input Intelligence — the unified assistance hook (spec §33, §39).
 *
 * Generalizes the app's reference implementation `src/hooks/useSearchSuggestions.ts`
 * (debounce + AbortController + monotonic sequence guard + stale-while-revalidate
 * LRU) into a context-parameterized hook that any field can consume. It preserves
 * that hook's hard-won properties and adds the missing race safety the client
 * audit flagged (MentionInput had none):
 *
 *   §33 performance tiers:
 *     0 chars  → immediate cached/zero-state (only when the field's minChars is 0)
 *     1 char   → cache/prefix, still server-assisted if minChars ≤ 1
 *     2+ chars → server-assisted suggestions
 *   - debounce from the field policy (default 120ms, §33's 100–150ms band),
 *   - stale requests cancelled (AbortController) AND ignored (sequence guard),
 *   - SWR cache: backspacing re-renders instantly with zero network,
 *   - previous suggestions stay visible while the next request runs (no flash),
 *   - graceful degradation: a 404 / offline endpoint yields "no suggestions",
 *     never a throw and never an error banner (§38).
 *
 * This hook does NOT dispatch actions or mutate the field — the SmartInput /
 * overlay own that. It only produces the ranked, deduped, capped suggestion list.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { InputContext } from '../types/inputContext.ts';
import type { InputFieldPolicy } from '../types/fieldPolicy.ts';
import type { InputSuggestion, InputSessionContext } from '../types/inputSuggestion.ts';
import { resolveFieldPolicy } from '../contexts/fieldRegistry.ts';
import { requestSuggestions } from '../services/inputAssistance.ts';
import { sharedSuggestionCache, SuggestionCache } from '../services/suggestionCache.ts';
import { createSequenceGuard } from '../services/raceGuard.ts';
import { finalizeSuggestions } from '../services/suggestionRanking.ts';
import { emitInputEvent } from '../services/inputTelemetry.ts';

export interface UseInputAssistanceOptions {
  /** The field's registered id. Used for policy lookup + cache key + telemetry. */
  fieldId: string;
  /** Current field text. */
  text: string;
  /** Fallback context when the field was not pre-registered (migration aid). */
  context?: InputContext;
  /** Bounded task/session context forwarded to the server (§16, §41). */
  sessionContext?: InputSessionContext;
  /** Master switch — false clears results and stops all fetching. */
  enabled?: boolean;
}

export interface UseInputAssistanceResult {
  suggestions: InputSuggestion[];
  loading: boolean;
  /** True when the suggest endpoint is unavailable (404/offline) — the caller
   *  should degrade to local zero-state, not show an error. */
  unavailable: boolean;
  /** The resolved policy (null when the field is unregistered + no fallback). */
  policy: InputFieldPolicy | null;
}

export function useInputAssistance(
  opts: UseInputAssistanceOptions,
): UseInputAssistanceResult {
  const { fieldId, text, context, sessionContext, enabled = true } = opts;

  const policy = useMemo(
    () => resolveFieldPolicy(fieldId, context),
    [fieldId, context],
  );

  const [suggestions, setSuggestions] = useState<InputSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  // Per-instance sequence guard + abort controller + debounce timer.
  const guardRef = useRef(createSequenceGuard());
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const trimmed = text.trim();
  const lat = sessionContext?.lat;
  const lng = sessionContext?.lng;
  // Round coords for a stable dependency + cache key (~1km).
  const latKey = lat != null ? Math.round(lat * 100) / 100 : null;
  const lngKey = lng != null ? Math.round(lng * 100) / 100 : null;

  // Serialize the non-coord session context so it participates in deps without
  // churning on identity changes.
  const sessionKey = useMemo(() => {
    if (!sessionContext) return '';
    const { lat: _lat, lng: _lng, ...rest } = sessionContext;
    return JSON.stringify(rest);
  }, [sessionContext]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    // Disabled or no policy → clear + stop.
    if (!enabled || !policy) {
      abortRef.current?.abort();
      abortRef.current = null;
      guardRef.current.invalidate();
      setSuggestions([]);
      setLoading(false);
      return;
    }

    // Below the field's threshold → clear (nothing to assist yet). minChars 0
    // means "assist even at zero characters" (zero-state, §14).
    if (trimmed.length < policy.minChars) {
      abortRef.current?.abort();
      abortRef.current = null;
      guardRef.current.invalidate();
      setSuggestions([]);
      setLoading(false);
      setUnavailable(false);
      return;
    }

    // Cache hit → serve instantly, no network (§33 SWR).
    const cacheKey = SuggestionCache.key(fieldId, trimmed, latKey, lngKey);
    const cached = sharedSuggestionCache.get(cacheKey);
    if (cached) {
      guardRef.current.invalidate();
      setSuggestions(cached);
      setLoading(false);
      setUnavailable(false);
      return;
    }

    setLoading(true); // keep previous suggestions visible while fetching
    const mySeq = guardRef.current.next();
    emitInputEvent('query_length_changed', fieldId, policy.context, { length: trimmed.length }, policy.telemetryPolicy);

    debounceRef.current = setTimeout(() => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      emitInputEvent('suggestion_request_started', fieldId, policy.context, undefined, policy.telemetryPolicy);

      void requestSuggestions(
        {
          context: policy.context,
          fieldId,
          text: trimmed,
          limit: policy.maxSuggestions,
          sessionContext,
        },
        ctrl.signal,
      ).then((res) => {
        // Superseded by a newer keystroke — drop (§33 out-of-order guarantee).
        if (!guardRef.current.isCurrent(mySeq)) return;

        if (res.ok) {
          const finalized = finalizeSuggestions(res.suggestions, policy.maxSuggestions);
          sharedSuggestionCache.set(cacheKey, finalized);
          setSuggestions(finalized);
          setUnavailable(false);
          setLoading(false);
          emitInputEvent('suggestion_request_completed', fieldId, policy.context, { count: finalized.length }, policy.telemetryPolicy);
        } else if (res.aborted) {
          // Newer request in flight — do nothing (never flash empty).
        } else if (res.unavailable) {
          // Endpoint missing / offline → degrade to no suggestions, no error.
          setUnavailable(true);
          setSuggestions([]);
          setLoading(false);
        } else {
          // Transient error: keep whatever is on screen, just stop the spinner.
          setLoading(false);
        }
      });
    }, policy.debounceMs);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // sessionContext is intentionally referenced via sessionKey/latKey/lngKey
    // to avoid re-running on unstable object identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trimmed, enabled, policy, fieldId, latKey, lngKey, sessionKey]);

  // Abort any in-flight request on unmount.
  useEffect(() => () => { abortRef.current?.abort(); }, []);

  return { suggestions, loading, unavailable, policy };
}
