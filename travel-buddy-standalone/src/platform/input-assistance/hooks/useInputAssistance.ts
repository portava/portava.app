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
import { getContextDescriptor } from '../contexts/inputContexts.ts';
import { offlineSurfaceAllowed } from '../contexts/policyFallback.ts';
import {
  capabilitySignature,
  type ClientCapabilities,
} from '../contexts/clientCapabilities.ts';
import { requestSuggestions } from '../services/inputAssistance.ts';
import { sharedSuggestionCache, SuggestionCache, isCacheablePrivacyClass } from '../services/suggestionCache.ts';
import { createSequenceGuard } from '../services/raceGuard.ts';
import { finalizeSuggestions, narrowToQuery } from '../services/suggestionRanking.ts';
import { localZeroState } from '../services/localZeroState.ts';
import { offlineLocalRows } from '../services/localDictionary.ts';
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
  /**
   * §48 (census G343) — what THIS surface can render and dispatch, declared to
   * the server so it stops building rows the surface drops on arrival. Omit it
   * and the request is exactly what it was before the handshake existed.
   *
   * `contexts/clientCapabilities.ts` holds the two declarations that exist:
   * the shared overlay's (wide, and honest about it) and the global search
   * bar's (genuinely narrower — three action types).
   */
  capabilities?: ClientCapabilities;
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
  /**
   * §44 — the `requestId` of the serve that produced `suggestions`, or null
   * when nothing has been served yet (zero-character state, local tier only,
   * or a failed request).
   *
   * Census G355: "`requestId` is generated per request and no event carries it
   * back, so an impression still cannot be joined to the selection that
   * followed it." Returning it is the hook's half of closing that.
   */
  requestId: string | null;
}

export function useInputAssistance(
  opts: UseInputAssistanceOptions,
): UseInputAssistanceResult {
  const { fieldId, text, context, sessionContext, aiAssist, city, draft, tz, capabilities, enabled = true } = opts;

  const policy = useMemo(
    () => resolveFieldPolicy(fieldId, context),
    [fieldId, context],
  );

  const [suggestions, setSuggestions] = useState<InputSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  // §44 ACTION/RESULT LINKAGE (census G355). The suggest response has always
  // carried a `requestId` and this hook has always thrown it away, so an
  // impression could never be joined to the selection that followed it. It is
  // now state: SmartInput puts it on the field's TelemetryField and every event
  // the field emits names the serve it belongs to.
  const [requestId, setRequestId] = useState<string | null>(null);

  // §48 — the capability signature is part of the cache identity. Two surfaces
  // sharing a fieldId but declaring different capabilities receive DIFFERENT
  // lists from the same serve, and a shared key would let the narrower surface
  // hand the wider one a list the server had already thinned. An undeclared
  // caller's signature is '' — today's key exactly, byte for byte.
  const capKey = useMemo(() => capabilitySignature(capabilities), [capabilities]);

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

    // ── The ZERO-STATE TIER, and the gate that had no reader ────────────────
    // `zeroStateAssistance` is declared on all 29 context descriptors
    // (`contexts/inputContexts.ts`) — `true` on every geographic picker,
    // `global_search` and `hashtag` — and `buildDefaultPolicy` DROPS it: it is
    // not a member of `InputFieldPolicy`, so nothing on either side has ever
    // read it. The consequence was not cosmetic. `minChars` is 1 or 2 on every
    // one of those contexts, so the branch below returned on an EMPTY field and
    // no request was made — which means the server's §14 zero-character
    // answer (`gateway.ts` `zeroCharGeoDefaults`: the viewer's current city and
    // their Trip destinations) was built for a request this client never sends,
    // and §34's "prefer local: immediate zero-state" had no tier to be local
    // in. Opening a city picker showed an empty panel, always.
    //
    // `minChars` governs TYPED queries — "how much text before we search". The
    // zero-character tier is a different question, and the descriptor already
    // answers it per context. Read from the descriptor rather than the policy
    // so this needs no change to `InputFieldPolicy` or `buildDefaultPolicy`,
    // whose shapes other sections' rows cite.
    const zeroStateTier =
      trimmed.length === 0 && getContextDescriptor(policy.context).zeroStateAssistance === true;

    // Below the field's threshold → clear (nothing to assist yet). minChars 0
    // means "assist even at zero characters" (zero-state, §14).
    if (trimmed.length < policy.minChars && !zeroStateTier) {
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
    const baseFieldId = capKey ? `${fieldId}::cap:${capKey}` : fieldId;
    const cacheFieldId = aiAssist === true ? `${baseFieldId}::ai:${aiKey}` : baseFieldId;
    const cacheKey = SuggestionCache.key(cacheFieldId, trimmed, latKey, lngKey);
    // §29 — the field's declared privacyClass decides whether its suggestions
    // may live in the process-global cache at all. A `personal` / `sensitive` /
    // `private_message` field never reads from it and never writes to it, so a
    // viewer-scoped list (recipients, a sensitive location) is not retained
    // under the raw text that produced it. See suggestionCache.ts.
    const cacheable = isCacheablePrivacyClass(policy.privacyClass);
    const cached = cacheable ? sharedSuggestionCache.get(cacheKey) : null;
    if (cached) {
      guardRef.current.invalidate();
      setSuggestions(cached);
      setLoading(false);
      setUnavailable(false);
      return;
    }

    // ── §33 TIER 1 / §34 — the LOCAL prefix tier ────────────────────────────
    // The ladder in this file's own header claims three tiers; until now there
    // were two. `minChars` was checked, the exact-string cache was probed, and a
    // miss went straight to the network — so typing forward ("ba" → "ban" →
    // "bang") was a round trip per keystroke even though the answer for the
    // shorter prefix was in the map, and §34's "prefer local: cached city prefix
    // matching" had nothing behind it.
    //
    // This is that tier. It reuses the longest cached PREFIX of the typed text
    // and narrows it on-device to the rows that still match. It is subtractive
    // only (`narrowToQuery` cannot invent, reorder or re-score a row), so the
    // server remains the authority (§42) — this just stops the field going blank
    // between keystrokes, and is the list retained when the network dies below.
    //
    // Privacy is the same gate as the exact-string cache: an uncacheable field
    // (personal / sensitive / private_message) neither wrote to the cache nor
    // reads from it here, so no viewer-scoped list is ever re-shown locally.
    const localTier = cacheable
      ? (() => {
          const hit = sharedSuggestionCache.longestPrefix(cacheFieldId, trimmed, latKey, lngKey);
          if (!hit) return null;
          const narrowed = finalizeSuggestions(
            narrowToQuery(hit.suggestions, trimmed),
            policy.maxSuggestions,
          );
          return narrowed.length > 0 ? narrowed : null;
        })()
      : null;

    // ── §34 "prefer local: IMMEDIATE ZERO-STATE" ────────────────────────────
    // `longestPrefix` above is a STRICT-prefix scan, so an empty field gets
    // nothing from it: there is no shorter query to reuse. That left the one
    // case §34 names by itself — the zero-character open — as a pure server
    // round trip, and a cold or offline open of a picker showed an empty panel
    // even when the user had accepted a row in that same field moments before.
    //
    // This is the local answer for that case: this session's explicit accepts
    // for the field's context, replayed verbatim as `recent` rows. It is gated
    // by the SAME privacy predicate as the cache (see localZeroState.ts), so a
    // viewer-scoped field retains nothing and reads nothing back.
    //
    // It does NOT cancel the request below. The server's zero-state is richer
    // than this session's memory (current city, Trip destinations, the §35
    // cross-device recents) and it is the authority on eligibility — so the
    // local list is what the field shows WHILE that answer is fetched, and what
    // it keeps if the answer never arrives.
    const local = localTier
      ?? (zeroStateTier || (trimmed.length === 0 && policy.minChars === 0)
        ? (() => {
            const rows = finalizeSuggestions(localZeroState(policy), policy.maxSuggestions);
            return rows.length > 0 ? rows : null;
          })()
        : null);
    if (local) {
      setSuggestions(local);
      setUnavailable(false);
    }

    setLoading(true); // keep previous suggestions visible while fetching
    const mySeq = guardRef.current.next();
    emitInputEvent('query_length_changed', fieldId, policy.context, { length: trimmed.length }, policy.telemetryPolicy);

    debounceRef.current = setTimeout(() => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      emitInputEvent('suggestion_request_started', fieldId, policy.context, undefined, policy.telemetryPolicy);
      const sentAt = Date.now();

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
          // §48 capability handshake — omitted when the caller declared none.
          client: capabilities,
        },
        ctrl.signal,
      ).then((res) => {
        // Superseded by a newer keystroke — drop (§33 out-of-order guarantee).
        if (!guardRef.current.isCurrent(mySeq)) return;

        if (res.ok) {
          const finalized = finalizeSuggestions(res.suggestions, policy.maxSuggestions);
          if (cacheable) sharedSuggestionCache.set(cacheKey, finalized);
          setSuggestions(finalized);
          setUnavailable(false);
          setLoading(false);
          setRequestId(res.requestId || null);
          // §57 P95 suggestion latency. `clientMs` is the round trip this
          // device saw; `serverMs` is what the serve itself cost. Both, because
          // the difference between them is the network, and neither side can
          // measure that alone. `serverMs` is omitted rather than zeroed when
          // the deployment does not send it — see services/inputAssistance.ts.
          emitInputEvent(
            'suggestion_request_completed',
            fieldId,
            policy.context,
            { count: finalized.length, clientMs: Date.now() - sentAt, serverMs: res.serverMs },
            policy.telemetryPolicy,
            res.requestId || null,
          );
        } else if (res.aborted) {
          // Newer request in flight — do nothing (never flash empty).
        } else if (res.unavailable) {
          // §33 "network loss: RETAIN local/cached suggestions" + explicit
          // degraded behaviour. This branch used to `setSuggestions([])`, which
          // is the exact opposite of the requirement: it discarded the last good
          // rows at the one moment the user cannot get new ones. The degraded
          // STATE is still set (the overlay shows its quiet note, never an
          // error) — what changes is that the local tier computed above survives
          // it. `local` is either the prefix tier — already narrowed to the
          // typed text, so this retains rows that still match rather than
          // freezing a stale list — or, for an empty field, the §34 local
          // zero-state. With nothing local to retain it is `[]`, the old
          // behaviour.
          //
          // ── §32 ENFORCEMENT, AND WHY IT NARROWS THE PARAGRAPH ABOVE ───────
          //
          // Everything above is the §33 rule "network loss: RETAIN local/cached
          // suggestions", and it is right for a field the authority says HAS an
          // offline surface. `offlinePolicy` names which fields those are, and
          // for `server_required` and `unavailable` the answer is none: the
          // field is assisted only with a network, or not assisted at all.
          //
          // Retaining rows for such a field is not a smaller version of the
          // feature — it is assistance the authority declined to license, shown
          // at the one moment nothing can re-check it. For `place_picker`,
          // `event_location`, `address` and the six others the authority marks
          // `server_required`, those rows are places and people resolved under
          // conditions that no longer hold.
          //
          // This is the line the union alignment did NOT buy. Making both sides
          // spell `server_required` the same way let the value ARRIVE intact;
          // only a consumer that branches on it changes what the user sees.
          // Until this branch existed, `offlinePolicy` was still read by
          // nothing, and G13's behavioural half stayed open no matter how
          // exactly the two registries agreed.
          //
          // `offlineSurfaceAllowed` fails CLOSED on a value this build cannot
          // name, so a newer server's offline vocabulary retains nothing rather
          // than everything.
          //
          // ── AND WHAT THE GATE HAD NOTHING TO OPEN ONTO (§32, G197/G198) ───
          //
          // The paragraph above is about RETAINING. For nine contexts the
          // answer is "retain nothing", and the branch is exact. For the other
          // twenty it was "retain whatever is left" — which, on a COLD start,
          // is nothing: the SWR cache is empty, no row has been accepted yet,
          // and `local` is `null`. So the licensed surfaces still produced an
          // empty panel, and `static_dictionary` in particular licensed a
          // SHIPPED LIST THAT DID NOT EXIST. `contexts/fieldInventory.ts` said
          // so in as many words about the country picker.
          //
          // `offlineLocalRows` is the substrate that gate now opens onto: the
          // retained rows FIRST (they are rows the server projected, and they
          // outrank anything shipped), then the field's licensed dictionaries
          // — countries / languages / interests for `static_dictionary`, plus
          // the compact city index for `cached_local` — then the raw query for
          // a field licensed to show one. It re-applies this same
          // `offlineSurfaceAllowed` check and the §29 privacy predicate
          // internally, so the licence cannot be lost by a second caller.
          //
          // It is reached ONLY from this arm. A transient error keeps what is
          // on screen; an online serve is served alone. A shipped row appears
          // when, and only when, the authority is unreachable and the
          // authority said this field may answer without it.
          const mayRetain = offlineSurfaceAllowed(policy.offlinePolicy);
          const degradedRows = mayRetain ? offlineLocalRows(policy, trimmed, local ?? []) : [];
          setUnavailable(true);
          setSuggestions(degradedRows);
          setLoading(false);

          // ── §44 / §57 — THE DEGRADED SERVE, RECORDED (census G373) ───────
          //
          // G373 ("offline completion rate") is refused in
          // `lib/inputAssistance/metrics.ts` with a precise reason: "nothing
          // marks a serve as degraded — useInputAssistance sets `unavailable`
          // state and emits no event for it, so there is no offline
          // denominator". This arm IS that detection, and until now it was the
          // only arm of the request that emitted nothing at all.
          //
          // INFERRING IT FROM WHAT IS ALREADY LOGGED DOES NOT WORK, which is
          // why a flag is needed rather than a query. A degraded serve today
          // looks exactly like an ABORTED one and like an ABANDONED one — a
          // `suggestion_request_started` with no `suggestion_request_completed`
          // after it — and those three have nothing to do with each other.
          //
          // WHAT IT CARRIES, AND WHAT IT MAY NOT.
          //   - `degraded: true` — one boolean. G373's own criterion asks for
          //     exactly this, "inside the existing name, so no migration to
          //     2950's event-name CHECK is needed": `suggestion_request_completed`
          //     is one of that CHECK's fourteen names already.
          //   - `count` — how many rows the field ended up showing, which for a
          //     `server_required` field is 0 by the gate above. The numerator
          //     and denominator of "offline completion rate" are both in those
          //     two values, and neither is about the user.
          //   - NO QUERY, NO LABEL, NO TITLE, NO LENGTH, NO IDENTIFIER. 2950's
          //     `iate_props_no_raw_text` refuses thirteen key names and the
          //     ingest rebuilds every event from a per-name allow-list; nothing
          //     here goes near either. The table carries no account id BY
          //     DESIGN (G371) and this adds none — a rate over degraded serves
          //     never needs to know whose they were.
          //
          // AND DELIBERATELY NO `clientMs`/`serverMs`, WHICH IS NOT AN
          // OVERSIGHT. `metrics.ts` builds G372's P95 latency from EVERY
          // `suggestion_request_completed` carrying those keys, and the ingest
          // does not yet name `degraded` in its allow-list — so a degraded row
          // carrying a round trip would arrive INDISTINGUISHABLE from a
          // successful serve and pull the quantile toward the fast local
          // failures ("API not configured", "Not signed in") that never touched
          // a network. A latency this event cannot be told apart from is worse
          // than no latency. `count` is inert by comparison: no §57 metric
          // reads it on this event name.
          //
          // WHAT THIS DOES NOT YET BUY, stated here rather than only in the
          // census: until `TELEMETRY_EVENT_PROPS.suggestion_request_completed`
          // in `artifacts/api-server/src/lib/inputAssistance/telemetry.ts`
          // names `degraded: 'bool'`, the ingest DROPS the flag and the stored
          // row cannot be told from an online one. The producer exists; the
          // metric stays refused until that one line lands. G373 is NOT moved
          // on this alone.
          emitInputEvent(
            'suggestion_request_completed',
            fieldId,
            policy.context,
            { count: degradedRows.length, degraded: true },
            policy.telemetryPolicy,
          );
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
    // `capabilities` is addressed through `capKey` below, which is its identity
    // for this effect; depending on the object itself would re-fetch on every
    // render that produced an equal declaration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trimmed, enabled, policy, fieldId, latKey, lngKey, sessionKey, aiKey, capKey]);

  // Abort any in-flight request on unmount.
  useEffect(() => () => { abortRef.current?.abort(); }, []);

  return { suggestions, loading, unavailable, policy, requestId };
}
