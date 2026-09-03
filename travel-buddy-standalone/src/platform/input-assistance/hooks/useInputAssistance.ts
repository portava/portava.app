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
import type { InputSuggestion, InputSessionContext, WritingDraft } from '../types/inputSuggestion.ts';
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
  /**
   * §22 — per-request OPT-IN for AI-assisted writing / compass continuation.
   * Only a literal `true` opts in; the gateway keeps its own flag gate on top,
   * so this is the client half of a double gate. Default: off.
   */
  aiAssist?: boolean;
  /** §29 coarse city-level context for AI writing / compass refs (no coordinates). */
  city?: string | null;
  /** §29 coarse creation draft for AI writing / compass refs (no coordinates). */
  draft?: WritingDraft;
  /** §18 IANA timezone for temporal phrasing (optional, coarse). */
  tz?: string | null;
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
  const { fieldId, text, context, sessionContext, aiAssist, city, draft, tz, enabled = true } = opts;

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

  // §22 — the AI opt-in + coarse writing context participate in the cache key
  // and effect deps ONLY when opted in, so an aiAssist request can never serve a
  // non-AI cached list (or vice-versa) and a non-AI field's behavior/key is
  // byte-for-byte unchanged from before Phase 7.
  const aiKey = useMemo(() => {
    if (aiAssist !== true) return '';
    return JSON.stringify({ city: city ?? '', tz: tz ?? '', draft: draft ?? null });
  }, [aiAssist, city, tz, draft]);

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

    // Cache hit → serve instantly, no network (§33 SWR). An opted-in AI request
    // keys separately (via the effective fieldId) so it never collides with the
    // field's non-AI cache entry for the same text.
    const cacheFieldId = aiAssist === true ? `${fieldId}::ai:${aiKey}` : fieldId;
    const cacheKey = SuggestionCache.key(cacheFieldId, trimmed, latKey, lngKey);
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
          // §22 opt-in + §29 coarse context — only forwarded when opted in.
          aiAssist: aiAssist === true ? true : undefined,
          city: aiAssist === true ? city : undefined,
          draft: aiAssist === true ? draft : undefined,
          tz: aiAssist === true ? tz : undefined,
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
  }, [trimmed, enabled, policy, fieldId, latKey, lngKey, sessionKey, aiKey]);

  // Abort any in-flight request on unmount.
  useEffect(() => () => { abortRef.current?.abort(); }, []);

  return { suggestions, loading, unavailable, policy };
}
