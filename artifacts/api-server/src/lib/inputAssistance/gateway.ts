/**
 * InputAssistanceGateway — candidate generation + privacy gateway + projection.
 *
 * This is the unification-layer spine (§3/§4/§42). It WRAPS existing systems and
 * reimplements nothing:
 *
 *   - Candidate generation delegates to `dispatchSearch` (routes/discoverySearch)
 *     — the same per-type query + match-tier ranking + fail-closed privacy code
 *     paths /discovery/search and /discovery/suggest use.
 *   - Canonical city rows come from `suggestCanonicalLocations`
 *     (lib/canonicalLocations) merged via the existing `mergeCitySuggestions`.
 *   - Normalization goes through the ONE §40 QueryNormalizer service
 *     (`queryNormalizer.ts`), which still composes `applyAliases` and the
 *     shared `sanitizeQuery` PostgREST guard and adds §10's transliteration,
 *     emoji and keyboard-typo clauses on top.
 *   - The privacy/eligibility gateway (§29) runs BEFORE projection and is
 *     fail-closed: unknown block/age state ⇒ no entity suggestions (mirrors
 *     /discovery/suggest, which returns empty when block state is unknown).
 *   - Projection to InputSuggestion strips raw trust/ranking internals (§42).
 *
 * The gateway ORDER (§4): classify → resolve policy (caller) → normalize →
 * generate candidates filtered to the policy's allowed entity/assistance types
 * → privacy gateway → rank/dedupe → project.
 */
import { fetchBlockedSet } from '../blocks';
import { normalizeLocationName } from '../canonicalLocations';
import type { SearchQueryContext } from '../../routes/discoverySearchHelpers';
import {
  dispatchSearch,
  fetchAgeRestrictedSet,
  canonicalToCityResult,
  mergeCitySuggestions,
  type SearchResult,
} from '../../routes/discoverySearch';
import { resolveGeoCandidates, zeroCharGeoDefaults, type GeoResolution } from './geoResolver';
import { entityToSearchType, type DispatchSearchType } from './entityMap';
import {
  resolveRecipientSuggestions,
  resolveMentionSuggestions,
  resolveHashtagRefSuggestions,
  checkUsernameAvailability,
  buildUsernameValidation,
  buildHashtagValidation,
  canonicalizeHashtag,
} from './socialIdentity';
import { POLICY_VERSION } from './policyRegistry';
import {
  isCreationContext,
  buildCreationAssistance,
  buildUnresolvedAddress,
} from './creation';
import { buildSemanticAssistance, isSemanticContext } from './semanticIntent';
import { normalizeQuery, buildTypoCorrectionRow, type NormalizedQuery } from './queryNormalizer';
import {
  resolveTaskConstraint,
  classifyFeasibility,
  EMPTY_TASK_CONSTRAINT,
  type TaskConstraint,
} from './taskContext';
import { applyDiversity } from './rankingSignals';
import { extractTemporal } from './semanticParser';
import type { TemporalWindow } from './rankingSignals';
import { buildAiAssistedWriting, isAiTextContext } from './aiWriting';
import { enrichSuggestionsWithLive } from './liveSuggestions';
import {
  fetchSelectionMemory,
  applyPriorSelectionBoost,
  buildLearnedGeoInjections,
  buildSelectionRecents,
  selectionQueryKey,
  emptyMemory,
  type SelectionMemory,
} from './personalization';
import { buildSavedPlaceSuggestions } from './savedEntities';
import {
  projectSearchResult,
  projectCanonicalCity,
  projectAirportDisambiguation,
  projectGeoDefault,
  buildQueryCompletion,
  buildCompassStarters,
  orderSuggestions,
  orderSuggestionsReserving,
  dropDeadRows,
} from './projection';
import type {
  AssistanceType,
  InputContext,
  InputFieldPolicy,
  InputSuggestion,
  SuggestSessionContext,
  CreationDraft,
} from './types';

// §13: the "SEARCH FOR" query-completion row is a first-class part of a global-
// search result and must not be capped out by a long run of entity rows (which
// always sort ahead of it under §9 trust order). The final ranker reserves a
// slot for these types so at least one completion always survives the cap.
const COMPLETION_RESERVED_TYPES: ReadonlySet<AssistanceType> = new Set<AssistanceType>([
  'completion',
]);

// Geographic PICKER contexts (§12) that resolve to a canonical city and, on
// selection, return the §17/§53 binding. These get the strengthened city path:
// diacritic/stroke/alias-aware resolution, airport/ambiguity disambiguation, and
// zero-character defaults. global_search is intentionally NOT here — it keeps its
// existing mixed-entity search behavior (cities merged, no forced binding).
const GEO_PICKER_CONTEXTS: ReadonlySet<InputContext> = new Set<InputContext>([
  'city_picker',
  'country_picker',
  'neighborhood_picker',
  'place_picker',
  'trip_destination',
  'trip_stop_place',
  'event_location',
  'passport_homebase',
  'address',
  'buddy_service_area',
  'hidden_gem_location',
]);

const EMPTY_GEO: GeoResolution = { rows: [], ambiguous: false, airport: null };

// §26: free-text writing fields where an @mention / #hashtag is INSERTED as a
// structured reference (not searched-for as an entity page). When one of these
// carries a sigil, the gateway resolves the reference rather than running the
// mixed-entity search. Without a sigil the field keeps its normal assist.
const WRITING_CONTEXTS: ReadonlySet<InputContext> = new Set<InputContext>([
  'caption',
  'comment',
  'telegraph_message',
]);

export interface GenerateParams {
  context: InputContext;
  policy: InputFieldPolicy;
  text: string;
  userId: string;
  limit: number;
  sessionContext?: SuggestSessionContext;
  lat: number | null;
  lng: number | null;
  city: string | null;
  /** §23/§55 creation draft — read only by creation contexts. */
  draft?: CreationDraft;
  /** §18 IANA timezone for temporal-window normalization (optional). */
  tz?: string | null;
  /** §22 per-request opt-in for AI-assisted writing (default false). */
  aiAssist?: boolean;
}

function uniq<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

/**
 * Generate the ranked, projected suggestion list for one request.
 * Returns InputSuggestion[] (already ordered and capped).
 */
export async function generateSuggestions(
  sc: any,
  params: GenerateParams,
): Promise<InputSuggestion[]> {
  const { context, policy, text, userId, limit, sessionContext, lat, lng, city, draft, tz, aiAssist } = params;

  // no_assistance fields produce nothing (§6). generic_text lands here.
  if (policy.mode === 'no_assistance') return [];

  // ── Normalization (§10/§40, QueryNormalizer) ────────────────────────────────
  // ONE service now owns every §10 clause — sigil handling, script
  // transliteration, context-appropriate emoji handling, the Discovery alias
  // table, and keyboard-weighted typo tolerance with a confidence measure. See
  // queryNormalizer.ts for why the correction is a SECOND attempt rather than a
  // rewrite: `norm.query` is always the user's own spelling, so a query that
  // resolves today can never be rerouted by the corrector.
  const norm: NormalizedQuery = normalizeQuery(text ?? '', { context, maxLength: 80 });
  const trimmed = norm.raw;
  const isHandle = norm.sigil === '@';
  const isHashSigil = norm.sigil === '#';
  const aliased = norm.aliased;
  const q = norm.query;
  // normalizeLocationName is the canonical diacritic/case fold — kept for the
  // §16 session-bias comparison below (the stroke/alias-aware geographic fold
  // lives in the geoResolver / suggestCanonicalLocationsFolded path).
  const normalized = normalizeLocationName(q);

  // ── §15 TemporalFit — the window the parser was already computing ───────────
  // `extractTemporal` normalises "tonight" / "tomorrow morning" / "Friday after
  // dinner" into an ISO window. Until Phase 9 that window went into a search
  // STRING and was discarded; nothing ranked on it, which is why §15's
  // TemporalFit had no producer. It is resolved ONCE here and handed to the
  // projection as a ranking term — NOT as a filter. See rankingSignals.ts for
  // the measured reason a hard filter was rejected ("Saturday Night Market").
  // A deferred window ("when we arrive") carries no bounds and is dropped.
  const temporalWindow: TemporalWindow | null = (() => {
    const t = extractTemporal(aliased, tz ?? null).intent;
    if (!t || (t.startsAfter === null && t.startsBefore === null)) return null;
    return { startsAfter: t.startsAfter, startsBefore: t.startsBefore };
  })();

  const isGeoPicker = GEO_PICKER_CONTEXTS.has(context);
  const wantsRecent = policy.allowedSuggestionTypes.includes('recent');
  const wantsEntities = policy.allowedSuggestionTypes.includes('entity');
  const wantsPersonalized = policy.allowedSuggestionTypes.includes('personalized');

  // ── §35 Selection Memory (Phase 8) ──────────────────────────────────────────
  // Load the OWNER's per-context explicit-selection memory ONCE, gated by the
  // field policy's allowPersonalization (so username / private-message / hidden-
  // gem contexts never fetch or feed it). Fail-soft to an empty memory, which
  // makes every personalization step below a no-op — a user with no history gets
  // today's behaviour exactly (graceful cold-start). `personalQueryKey` is folded
  // WITHOUT alias expansion, matching how the /select write path stores it, so a
  // user's own abbreviation ("bkk") maps even when the global alias dictionary
  // does not know it.
  // ── §16/§17 ACTIVE TASK (Phase: carryover as a constraint) ──────────────────
  // One bounded, fail-soft read of the task the field lives inside: the
  // session's canonical city and the Trip's destination + date window. It is
  // resolved ONCE and handed to every projection below as the §18 feasibility
  // verdict and the §15 TripFit term, so a field inside a Bangkok Trip no
  // longer behaves as though it exists in isolation. A session with no task
  // issues no query and produces the identity transform.
  const taskConstraint: TaskConstraint =
    sessionContext?.cityId || sessionContext?.tripId
      ? await resolveTaskConstraint(sc, sessionContext).catch(() => EMPTY_TASK_CONSTRAINT)
      : EMPTY_TASK_CONSTRAINT;

  const personalizationOn = policy.allowPersonalization === true;
  const memory: SelectionMemory = personalizationOn
    ? await fetchSelectionMemory(sc, { userId, context, max: 200 }).catch(() => emptyMemory())
    : emptyMemory();
  const personalQueryKey = selectionQueryKey(trimmed);

  // ── §14 zero-character assistance (geographic pickers) ──────────────────────
  // When the field is EMPTY and the policy allows recents/entities, serve the
  // viewer's current city + active/upcoming Trip destinations (§53), plus the
  // user's own recent explicit selections (§35). Sourced only from the viewer's
  // OWN rows / public geo entities, so no person-privacy gate is required.
  if (q.length === 0 && isGeoPicker && (wantsRecent || wantsEntities)) {
    const defaults = await zeroCharGeoDefaults(sc, {
      userId,
      city,
      max: policy.maxSuggestions,
    }).catch(() => []);
    const projected = defaults.map((d, i) => projectGeoDefault(d, context, POLICY_VERSION, i));
    const existingIds = new Set(projected.map((s) => s.entityId).filter((x): x is string => !!x));
    const recents = personalizationOn
      ? await buildSelectionRecents(sc, {
          memory,
          context,
          isGeoPicker: true,
          policyVersion: POLICY_VERSION,
          max: policy.maxSuggestions,
          existingEntityIds: existingIds,
        }).catch(() => [])
      : [];
    // §35 SAVED entities — the half of "Saved and Trip-related entities" that
    // read nothing. Gated inside savedEntities.ts on the policy's entity types,
    // so it fires for place_picker / trip_stop_place and is inert for the
    // city-and-country pickers. Unlike the recents above it reads a table
    // production HAS, so this arm is live rather than ☠prod.
    const savedIds = new Set<string>([
      ...existingIds,
      ...recents.map((s) => s.entityId).filter((x): x is string => !!x),
    ]);
    const saved = await buildSavedPlaceSuggestions(sc, {
      userId,
      context,
      policy,
      policyVersion: POLICY_VERSION,
      max: policy.maxSuggestions,
      existingEntityIds: savedIds,
    }).catch(() => []);
    return dropDeadRows(
      orderSuggestions(
        applySessionBias([...projected, ...recents, ...saved], sessionContext, normalized),
        Math.min(limit, policy.maxSuggestions),
      ),
    );
  }

  // ── §14/§35 zero-character recents (non-geo personalization contexts) ────────
  // For a search-like field that allows personalization (e.g. global_search),
  // an empty query serves the user's own recent explicit GEO selections before
  // the first keystroke. telegraph_recipient is excluded — it serves eligibility-
  // scoped recipient recents through its own path below. Cold-start (no memory)
  // returns nothing and falls through to today's behaviour.
  if (
    q.length === 0 &&
    !isGeoPicker &&
    personalizationOn &&
    context !== 'telegraph_recipient' &&
    (wantsRecent || wantsPersonalized)
  ) {
    const recents = await buildSelectionRecents(sc, {
      memory,
      context,
      isGeoPicker: false,
      policyVersion: POLICY_VERSION,
      max: policy.maxSuggestions,
    }).catch(() => []);
    // §35 SAVED entities (G228) — the production-live arm of the same zero-state.
    // `global_search` names `place` in its entity types, so a user who has saved
    // a place is offered it before the first keystroke even where the §35
    // selection-memory table is absent (the ☠prod case).
    const saved = await buildSavedPlaceSuggestions(sc, {
      userId,
      context,
      policy,
      policyVersion: POLICY_VERSION,
      max: policy.maxSuggestions,
      existingEntityIds: new Set(recents.map((s) => s.entityId).filter((x): x is string => !!x)),
    }).catch(() => []);
    if (recents.length > 0 || saved.length > 0) {
      return dropDeadRows(
        orderSuggestions(
          applySessionBias([...recents, ...saved], sessionContext, normalized),
          Math.min(limit, policy.maxSuggestions),
        ),
      );
    }
  }

  // ── Social identity contexts (Phase 4, §26/§47/§54) ─────────────────────────
  // These run BEFORE the generic minChars gate so a 1-char @mention and a
  // zero-char recipient recents list both work. Each is a full takeover that
  // returns its own projected, ranked list.
  const socialCtx: SearchQueryContext = { lat, lng, userCity: city, nearbyIntent: false };

  // Recipient search (§54): eligibility-scoped, enumeration-safe (§47). Replaces
  // the generic traveler dispatch that would otherwise leak private accounts.
  if (context === 'telegraph_recipient') {
    const recips = await resolveRecipientSuggestions(sc, context, POLICY_VERSION, {
      userId,
      q,
      max: policy.maxSuggestions,
    }).catch(() => [] as InputSuggestion[]);
    // §15 PriorSelection on the recipient path. This branch is a full TAKEOVER
    // that returns before the generic `applyPriorSelectionBoost` below, so a
    // recorded recipient pick used to feed NOTHING — the write had no reader
    // here, which is why the §35 writer-coverage guard carried
    // `useTelegraphRecipients.ts` as a KNOWN GAP with "boost-only benefit" as
    // the benefit that did not exist yet. It exists now.
    //
    // It can only ever REORDER what `resolveRecipientSuggestions` already
    // returned — the eligibility/enumeration gate (§47/§54) runs first and this
    // adds nobody to its output. That is the same contract personalization.ts
    // states for every remembered person: re-ranked among candidates that are
    // already there, never surfaced on its own.
    const boostedRecips = personalizationOn
      ? applyPriorSelectionBoost(recips, memory, personalQueryKey)
      : recips;
    return dropDeadRows(
      orderSuggestions(
        applySessionBias(boostedRecips, sessionContext, normalized),
        Math.min(limit, policy.maxSuggestions),
      ),
    );
  }

  // Mention/hashtag structured references inside writing fields (§26). Only when
  // a sigil is present — otherwise the field keeps its normal mixed-entity assist.
  if (WRITING_CONTEXTS.has(context) && (isHandle || isHashSigil)) {
    const allowsUser = (policy.entityTypes ?? []).includes('user');
    const allowsHashtag = (policy.entityTypes ?? []).includes('hashtag');
    let refs: InputSuggestion[] = [];
    if (isHandle && allowsUser) {
      refs = await resolveMentionSuggestions(sc, context, POLICY_VERSION, {
        userId,
        q,
        max: policy.maxSuggestions,
        ctx: socialCtx,
      }).catch(() => [] as InputSuggestion[]);
    } else if (isHashSigil && allowsHashtag) {
      refs = await resolveHashtagRefSuggestions(sc, context, POLICY_VERSION, {
        raw: trimmed,
        max: policy.maxSuggestions,
      }).catch(() => [] as InputSuggestion[]);
      // §10: an emoji/symbol tag body canonicalizes to nothing. Say so instead
      // of returning an empty list the user cannot interpret.
      if (refs.length === 0 && policy.allowedSuggestionTypes.includes('validation')) {
        const v = buildHashtagValidation(context, POLICY_VERSION, trimmed);
        if (v) refs = [v];
      }
    }
    return dropDeadRows(orderSuggestions(refs, Math.min(limit, policy.maxSuggestions)));
  }

  // ── Phase-5 creation assistance (§20/§23/§55) ───────────────────────────────
  // Duplicate detection + the §23 validation suite for creation contexts. Driven
  // by the typed NAME *and* the creation draft (dates / city / country), so the
  // draft-only validators (trip date conflict, city-country mismatch) run even
  // below minChars where there is no typed text yet. Fail-soft to [].
  const creationRows: InputSuggestion[] = isCreationContext(context)
    ? await buildCreationAssistance(sc, {
        context,
        policy,
        text: trimmed,
        userId,
        draft: draft ?? {},
        viewerCity: city,
        lat,
        lng,
        sessionContext,
        policyVersion: POLICY_VERSION,
        max: policy.maxSuggestions,
      }).catch(() => [] as InputSuggestion[])
    : [];

  // Honor minChars (§33). compass_prompt has minChars:0 so it still yields
  // starter prompts on an empty field (§14 zero-character assistance). Creation
  // validators are draft-driven, so surface them even below minChars.
  if (q.length < policy.minChars) {
    return creationRows.length > 0
      ? dropDeadRows(orderSuggestions(creationRows, Math.min(limit, policy.maxSuggestions)))
      : [];
  }

  const suggestions: InputSuggestion[] = [];

  // POLICY GATE (§6): only the policy's declared entity types are ever queried.
  const policyEntityTypes = policy.entityTypes ?? [];
  const dispatchTypes: DispatchSearchType[] = uniq(
    policyEntityTypes.map(entityToSearchType),
  );
  const wantsCities = dispatchTypes.includes('cities');

  // ── Strengthened canonical city resolution (§10/§11/§12/§19) ─────────────────
  // Diacritic/stroke/alias-aware ("da nang"→Đà Nẵng, "hcmc"→the HCMC city id).
  // Public geo registry data with no user linkage, so it runs OUTSIDE the
  // person-privacy gate. Reused by BOTH the geo-picker path (binding +
  // disambiguation) and global_search (merged as SearchResults).
  let geoRes: GeoResolution =
    wantsEntities && wantsCities && !isHandle && q.length >= 2
      ? await resolveGeoCandidates(sc, q, Math.max(4, policy.maxSuggestions)).catch(() => EMPTY_GEO)
      : EMPTY_GEO;

  // ── §10 typo tolerance — a SECOND attempt, never a rewrite ──────────────────
  // `norm.correctedQuery` is set only when the keyboard-weighted corrector found
  // a UNIQUE vocabulary match above its apply threshold (queryNormalizer.ts).
  // It is used only after the user's OWN spelling returned nothing, so a query
  // that resolves today cannot be rerouted, and an ambiguous input is never
  // guessed (§19). `correctionHelped` records whether the retry actually found
  // something, so the correction ROW below is never a claim the results do not
  // support.
  let correctionHelped = false;
  if (
    norm.correctedQuery &&
    wantsEntities &&
    wantsCities &&
    !isHandle &&
    geoRes.rows.length === 0 &&
    geoRes.airport === null
  ) {
    const retry = await resolveGeoCandidates(
      sc,
      norm.correctedQuery,
      Math.max(4, policy.maxSuggestions),
    ).catch(() => EMPTY_GEO);
    if (retry.rows.length > 0) {
      geoRes = retry;
      correctionHelped = true;
    }
  }

  if (wantsEntities && dispatchTypes.length > 0 && q.length >= 2) {
    if (isGeoPicker) {
      // ── Geographic picker path (§12/§17/§19/§53) ────────────────────────────
      // Cities resolve to canonical entities that BIND the field on selection.
      // Airport codes and same-name-different-place inputs surface as
      // disambiguation CHOICES (§19), never a silent guess.
      if (wantsCities) {
        if (geoRes.airport) {
          suggestions.push(projectAirportDisambiguation(geoRes.airport, context, POLICY_VERSION));
        }
        for (const row of geoRes.rows) {
          suggestions.push(
            projectCanonicalCity(row, context, POLICY_VERSION, q, { disambiguation: geoRes.ambiguous }),
          );
        }
      }
      // Non-city entity types the picker allows (place / hidden_gem / country)
      // still flow through the existing per-type search behind the privacy gate.
      const otherTypes = dispatchTypes.filter((t) => t !== 'cities');
      if (otherTypes.length > 0) {
        let other = await dispatchAndProject(sc, otherTypes, {
          q, userId, context, policy, lat, lng, city, temporalWindow, taskConstraint,
        });
        // §10 second attempt — same rule as the city path above.
        if (other.length === 0 && norm.correctedQuery) {
          const retry = await dispatchAndProject(sc, otherTypes, {
            q: norm.correctedQuery, userId, context, policy, lat, lng, city, temporalWindow, taskConstraint,
          });
          if (retry.length > 0) { other = retry; correctionHelped = true; }
        }
        suggestions.push(...other);
      }
    } else {
      // ── Generic mixed-entity path (global_search, username, hashtag, …) ─────
      // Unchanged behavior: privacy-gated per-type dispatch, canonical cities
      // MERGED into the cities bucket, projected as open_entity rows.
      const [blockedSet, ageRestrictedSet] = await Promise.all([
        fetchBlockedSet(sc, userId),
        fetchAgeRestrictedSet(sc),
      ]);

      if (blockedSet !== null && ageRestrictedSet !== null) {
        const perType = Math.max(2, Math.ceil(policy.maxSuggestions / dispatchTypes.length));
        const ctx: SearchQueryContext = { lat, lng, userCity: city, nearbyIntent: false };

        const runDispatch = (key: string) =>
          Promise.all(
            dispatchTypes.map((t) =>
              dispatchSearch(sc, key, userId, blockedSet, ageRestrictedSet, t, 0, perType, ctx)
                .catch(() => [] as SearchResult[]),
            ),
          );
        let perTypeResults = await runDispatch(q);
        // §10 second attempt — same rule as the geographic path above.
        if (norm.correctedQuery && perTypeResults.every((rows) => rows.length === 0)) {
          const retry = await runDispatch(norm.correctedQuery);
          if (retry.some((rows) => rows.length > 0)) {
            perTypeResults = retry;
            correctionHelped = true;
          }
        }

        // §18 feasibility over the WHOLE candidate set for this request, so the
        // verdict is consistent across types (an out-of-Trip-city event and an
        // out-of-Trip-city place are demoted by the same rule).
        const allCandidates = perTypeResults.flat();
        const verdict = classifyFeasibility(allCandidates, taskConstraint);

        const seenIds = new Set<string>();
        dispatchTypes.forEach((t, idx) => {
          let items = perTypeResults[idx] ?? [];
          if (t === 'cities' && geoRes.rows.length > 0) {
            items = mergeCitySuggestions(geoRes.rows.map(canonicalToCityResult), items, perType);
          }
          for (const r of items) {
            if (seenIds.has(r.id)) continue;
            seenIds.add(r.id);
            suggestions.push(
              projectSearchResult(r, context, POLICY_VERSION, q, {
                temporalWindow,
                demoted: verdict.demotedIds.has(r.id),
                tripFit: verdict.tripFitIds.has(r.id),
              }),
            );
          }
        });
      }
      // else: fail-closed — no entity suggestions when eligibility is unknown.
    }
  }

  // ── §23 username validation (username context) ──────────────────────────────
  // Surface availability/uniqueness + reserved-name/normalization as a
  // `validation` assistance row, reusing the SAME rules + availability query as
  // GET /users/check-username. Additive to (not a replacement for) the user
  // entity search this context also runs.
  if (
    context === 'username' &&
    policy.allowedSuggestionTypes.includes('validation') &&
    trimmed.length >= 1
  ) {
    const avail = await checkUsernameAvailability(sc, trimmed, userId).catch(() => null);
    if (avail) suggestions.push(buildUsernameValidation(context, POLICY_VERSION, trimmed, avail));
  }

  // ── Query completion (§13 "SEARCH FOR") ─────────────────────────────────────
  // Tapping submits a search. Only when the policy allows the completion type
  // and there is a query to submit — never a dead row.
  if (policy.allowedSuggestionTypes.includes('completion') && q.length >= Math.max(1, policy.minChars)) {
    suggestions.push(buildQueryCompletion(context, POLICY_VERSION, q));
  }

  // ── Compass prompt starters (§56) ───────────────────────────────────────────
  // DETERMINISTIC, contextual (surface/Trip-aware) starter prompts, gated only by
  // the policy's AI allowance — NOT by the AI flag or opt-in (they need no model,
  // so they always work, incl. offline/AI-unavailable). Each carries structured
  // refs (a coarse {surface, city, cityId, tripId} payload) so tapping one hands
  // Compass structured context, not a raw string. The action is `replace_text`,
  // so nothing is ever silently inserted (§22).
  if (
    context === 'compass_prompt' &&
    policy.allowAI &&
    policy.allowedSuggestionTypes.includes('ai_suggestion')
  ) {
    suggestions.push(
      ...buildCompassStarters(context, POLICY_VERSION, q, policy.maxSuggestions, {
        city,
        cityId: sessionContext?.cityId ?? null,
        tripId: sessionContext?.tripId ?? null,
      }),
    );
  }

  // ── Phase-6 semantic intent (§18/§21) ───────────────────────────────────────
  // For the search-like contexts (global_search / compass_prompt) a
  // sufficiently-confident deterministic parse ADDS structured suggestions/
  // actions (a scoped search, a sequenced plan, an editable Compass prompt) and
  // recognizes §21 smart actions ("add Bangkok to my trip"). It NEVER removes the
  // raw query row: a LOW/VERY-LOW parse adds nothing (§2/§19 — raw preserved),
  // and every semantic row is an `action`/`ai_suggestion` type, so it sorts AFTER
  // entities under §9 trust order (a canonical entity always outranks the parse).
  // The parser is fed the alias-expanded text so multi-word phrases survive.
  if (isSemanticContext(context) && q.length >= 1) {
    const semanticRows = await buildSemanticAssistance(sc, {
      context,
      policy,
      text: aliased,
      tz: tz ?? null,
      sessionContext,
      policyVersion: POLICY_VERSION,
      max: policy.maxSuggestions,
    }).catch(() => [] as InputSuggestion[]);
    suggestions.push(...semanticRows);
  }

  // ── Phase-7 AI-assisted writing (§22) — OPT-IN, flag-gated, SECONDARY ────────
  // Proposes editable caption/description/title/prompt text via the EXISTING
  // Compass AI (getOpenAI → gpt-5-mini). Requires ALL of: the per-request opt-in
  // (§22), the field policy's allowAI + ai_suggestion allowance (§6), and — inside
  // buildAiAssistedWriting — the dedicated `compass_ai_writing_enabled` flag AND an available
  // model. Any of those missing ⇒ no ai_suggestion is added, and the field's
  // deterministic assistance above is unaffected (degrade-to-no-AI). Every row is
  // `type:'ai_suggestion'` / `source:'ai'` with an editable `replace_text` action,
  // so it is never silently inserted (§22) and — sorting LAST by type rank — never
  // outranks a canonical entity (§9). It creates NO canonical fact.
  if (
    aiAssist === true &&
    policy.allowAI &&
    policy.allowedSuggestionTypes.includes('ai_suggestion') &&
    isAiTextContext(context) &&
    q.length >= 1
  ) {
    const aiRows = await buildAiAssistedWriting(sc, {
      context,
      policy,
      text: trimmed,
      draft: draft ?? {},
      sessionContext,
      city,
      policyVersion: POLICY_VERSION,
      max: 2,
    }).catch(() => [] as InputSuggestion[]);
    suggestions.push(...aiRows);
  }

  // ── §35 learned abbreviation → canonical geo mapping (Phase 8) ──────────────
  // When the typed query is one the user has REPEATEDLY used to select a public
  // canonical city/country ("bkk" → Bangkok, for THIS user), and that entity is
  // not already a candidate, inject it as a `personalized` row. It resolves to
  // the EXISTING canonical entity — changing no canonical data and affecting no
  // other user. `personalized` sorts after `entity` (projection TYPE_RANK), so it
  // never outranks a canonical match (§9). Only public geo entities are injected;
  // a remembered person/place is re-surfaced only by re-ranking a candidate that
  // already passed the privacy gate, never injected around it.
  if (personalizationOn && (wantsEntities || wantsPersonalized) && q.length >= 1) {
    const existingIds = new Set(suggestions.map((s) => s.entityId).filter((x): x is string => !!x));
    const injected = await buildLearnedGeoInjections(sc, {
      memory,
      queryKey: personalQueryKey,
      context,
      isGeoPicker,
      policyVersion: POLICY_VERSION,
      max: 3,
      existingEntityIds: existingIds,
    }).catch(() => [] as InputSuggestion[]);
    suggestions.push(...injected);
  }

  // ── Phase-5: merge creation assistance + unresolved-address fallback ─────────
  // §20/§23: the duplicate + validation rows are ranked ALONGSIDE the entity
  // candidates (disambiguation/correction/validation sort after entities per §9).
  // §37: only when NOTHING canonical resolved do we offer context-appropriate
  // fallback actions — policy-gated so a canonical city picker never offers them.
  if (isCreationContext(context)) {
    const hasEntity = suggestions.some((s) => s.type === 'entity');
    const hasDuplicate = creationRows.some((s) => s.type === 'disambiguation');
    if (!hasEntity && !hasDuplicate && q.length >= 2) {
      creationRows.push(...buildUnresolvedAddress(context, policy, POLICY_VERSION, trimmed));
    }
    // §20 "resolve existing records first": when a duplicate disambiguation was
    // surfaced for an entity, drop the redundant plain entity row for the SAME
    // id so the creation flow sees a single, unambiguous "did you mean" choice.
    const dupIds = new Set(
      creationRows.filter((s) => s.type === 'disambiguation' && s.entityId).map((s) => s.entityId),
    );
    // NB: build a fresh array — `suggestions.filter(...)` returns a new array, and
    // the no-dedup branch copies, so clearing `suggestions` below never aliases it.
    const kept = dupIds.size > 0
      ? suggestions.filter((s) => !(s.type === 'entity' && s.entityId && dupIds.has(s.entityId)))
      : [...suggestions];
    suggestions.length = 0;
    suggestions.push(...kept, ...creationRows);
  }

  // ── §10 hashtag field: unsupported characters are stated, not swallowed ─────
  if (
    context === 'hashtag' &&
    policy.allowedSuggestionTypes.includes('validation') &&
    canonicalizeHashtag(trimmed) === null
  ) {
    const v = buildHashtagValidation(context, POLICY_VERSION, trimmed);
    if (v) suggestions.push(v);
  }

  // ── §10 correction row (policy-gated) ───────────────────────────────────────
  // Surfaced when the corrector ACTUALLY changed the result set ("showing
  // results for …"), or when it is only an offer the user may take. It is a
  // `replace_text` action, so the user's raw input is preserved and nothing is
  // silently inserted (§2/§22). Contexts whose policy does not allow the
  // `correction` type never see it (§6).
  if (
    norm.correction &&
    policy.allowedSuggestionTypes.includes('correction') &&
    (correctionHelped || norm.correction.disposition === 'offered')
  ) {
    suggestions.push(buildTypoCorrectionRow(context, POLICY_VERSION, norm.correction));
  }

  // ── §16 context carryover (bounded, session-scoped) ─────────────────────────
  // When the active task carries a cityId, bias a matching city/place row to the
  // front so dependent fields inherit the task's city first. Bounded to this
  // request; never mutates persistent preferences. Fuller §16/§17 carryover is
  // deferred.
  const biased = applySessionBias(suggestions, sessionContext, normalized);

  // ── §15 PriorSelection boost (Phase 8) ──────────────────────────────────────
  // AUGMENT the ranking with the OWNER's repeated-selection history: raise the
  // confidence of candidates this user has selected before in this context
  // (stronger when the SAME query led to them — the abbreviation signal). It only
  // nudges confidence, the SECONDARY sort key, and is clamped below the exact-
  // match band, so it reorders WITHIN a type and never displaces a strong
  // canonical match or a canonical entity above an AI guess (§9). Empty memory ⇒
  // identity (cold-start unchanged).
  const personalized = personalizationOn
    ? applyPriorSelectionBoost(biased, memory, personalQueryKey)
    : biased;

  // ── Phase-9 Live Intelligence (§31/§15/§8) ──────────────────────────────────
  // Attach a §8 `freshness` projection to place/gem suggestions that have a
  // CURRENT live state, and add the §15 Freshness rank term (a small confidence
  // nudge). It consumes ONLY the gated, fail-closed `readLiveClaimEnvelopes`, so
  // a live label is NEVER fabricated: off/stale/unavailable/unpromoted ⇒ no
  // label (§2/§31). Policy-gated by `allowLiveContext` and additive — with live
  // off (the prod default, ~0 observations) it is a no-op after one flag read.
  // Runs BEFORE the final rank so the Freshness term participates in ordering.
  const withLive = await enrichSuggestionsWithLive(sc, personalized, {
    policy,
    context,
    max: Math.min(limit, policy.maxSuggestions),
  }).catch(() => personalized);

  // ── §15 Diversity (within-type) ─────────────────────────────────────────────
  // The gateway's per-type fan-out and §13's reserved completion slot produce
  // diversity ACROSS types as a side effect of slot allocation. This is the term
  // §15 actually names: within one assistance type, each repeat of an
  // already-seen display signature is demoted a little further, so a run of
  // near-identical rows is spread instead of filling the cap. Demotion, not
  // removal — two real venues can share a name.
  const diversified = applyDiversity(withLive);

  // ── Rank + cap (§9 trust order, §15 tie-break by confidence) ────────────────
  // When the field carries query completions (§13 "SEARCH FOR" rows — global_
  // search, buddy_service, hashtag), reserve a slot so a submittable-search row
  // is never capped out by a full page of entity matches. Otherwise a plain cap.
  const cap = Math.min(limit, policy.maxSuggestions);
  const ranked = policy.allowedSuggestionTypes.includes('completion')
    ? orderSuggestionsReserving(diversified, cap, COMPLETION_RESERVED_TYPES, 1)
    : orderSuggestions(diversified, cap);

  // §13 "no dead rows": final safety net — every returned row must resolve to an
  // action, a canonical entity, or a routable destination.
  return dropDeadRows(ranked);
}

/**
 * Privacy-gated per-type dispatch → projection for NON-city entity types in a
 * geographic picker (place / hidden_gem / country). Same fail-closed gate as
 * the generic path: a null block/age set suppresses everything.
 */
async function dispatchAndProject(
  sc: any,
  types: DispatchSearchType[],
  p: {
    q: string;
    userId: string;
    context: InputContext;
    policy: InputFieldPolicy;
    lat: number | null;
    lng: number | null;
    city: string | null;
    /** §15 TemporalFit window resolved once by the caller (null when none). */
    temporalWindow: TemporalWindow | null;
    /** §16/§17 active-task bounds resolved once by the caller. */
    taskConstraint: TaskConstraint;
  },
): Promise<InputSuggestion[]> {
  const [blockedSet, ageRestrictedSet] = await Promise.all([
    fetchBlockedSet(sc, p.userId),
    fetchAgeRestrictedSet(sc),
  ]);
  // Fail-closed (§29): unknown eligibility ⇒ no entity suggestions.
  if (blockedSet === null || ageRestrictedSet === null) return [];

  const perType = Math.max(2, Math.ceil(p.policy.maxSuggestions / types.length));
  const ctx: SearchQueryContext = { lat: p.lat, lng: p.lng, userCity: p.city, nearbyIntent: false };
  const perTypeResults = await Promise.all(
    types.map((t) =>
      dispatchSearch(sc, p.q, p.userId, blockedSet, ageRestrictedSet, t, 0, perType, ctx)
        .catch(() => [] as SearchResult[]),
    ),
  );

  const verdict = classifyFeasibility(perTypeResults.flat(), p.taskConstraint);
  const out: InputSuggestion[] = [];
  const seen = new Set<string>();
  for (const items of perTypeResults) {
    for (const r of items) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(
        projectSearchResult(r, p.context, POLICY_VERSION, p.q, {
          temporalWindow: p.temporalWindow,
          demoted: verdict.demotedIds.has(r.id),
          tripFit: verdict.tripFitIds.has(r.id),
        }),
      );
    }
  }
  return out;
}

/**
 * Move any suggestion whose entityId matches the session's cityId to the front
 * (stable). A minimal, bounded implementation of §16 context carryover.
 */
function applySessionBias(
  suggestions: InputSuggestion[],
  sessionContext: SuggestSessionContext | undefined,
  _normalizedQuery: string,
): InputSuggestion[] {
  const cityId = sessionContext?.cityId;
  if (!cityId) return suggestions;
  const boosted: InputSuggestion[] = [];
  const rest: InputSuggestion[] = [];
  for (const s of suggestions) {
    if (s.entityId === cityId) boosted.push({ ...s, confidence: Math.max(s.confidence ?? 0, 0.995) });
    else rest.push(s);
  }
  return [...boosted, ...rest];
}
