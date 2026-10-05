/**
 * POST /api/input-assistance/suggest — Global Input Intelligence gateway (§41).
 *
 * The single, context-parameterized suggest endpoint (Phase 1). It is the
 * unification layer OVER the existing per-surface systems, not a replacement:
 *
 *   classify by `context`  →  resolve field policy (§6)
 *     →  normalize (reuse canonicalLocations.normalize + applyAliases)
 *     →  generate candidates by delegating to discoverySearch.dispatchSearch,
 *        filtered to the policy's allowed entity/assistance types
 *     →  privacy / eligibility gateway (§29), fail-closed, BEFORE projection
 *     →  rank + dedupe (reuse match-tier ranking)
 *     →  project to InputSuggestion[] (§8, UI-ready; raw internals stripped, §42)
 *
 * /discovery/search and /discovery/suggest are unchanged — this endpoint is the
 * unifying layer on top of them. Auth uses the same viewer-scope gate as the
 * existing search path (requireUser).
 *
 * Deferred to later phases (not built here): semantic parsing (§18), AI writing
 * (§22), the unified QueryNormalizer DB work, per-field validation (§23),
 * personalization memory (§35), and the LiveSuggestionService zone rollup (§9).
 */
import crypto from 'node:crypto';
import { Router } from 'express';
import { requireUser, sendError } from '../lib/http';
import { getServiceClient } from '../lib/supabase';
import { checkRateLimit } from '../lib/rateLimit';
import { asyncHandler } from '../lib/asyncHandler';
import { logger as rootLogger } from '../lib/logger';
import {
  resolvePolicy,
  isKnownContext,
  KNOWN_CONTEXTS,
  POLICY_VERSION,
} from '../lib/inputAssistance/policyRegistry';
import { generateSuggestionsWithCoverage, gatewayFailureRefusal } from '../lib/inputAssistance/gateway'; // census-discovery §80: coverage on the envelope
import {
  SUGGESTION_SCHEMA_VERSION,
  parseClientCapabilities,
  negotiateSuggestionTypes,
  dropUnresolvableActionRows,
} from '../lib/inputAssistance/compatibility';
import { recordSelection, policyAdmitsMemory } from '../lib/inputAssistance/personalization';
import {
  INPUT_OUTCOME_DISCLOSURE_VERSION,
  INPUT_OUTCOME_RETENTION_DAYS,
  MAX_OUTCOME_ENTITIES,
  displayedOutcomeDisclosureMatches,
  hasValidOutcomeConsent,
  isOutcomeTask,
  outcomeLearningActive,
  outcomeLearningOffered,
  readOutcomeConsent,
  recordOutcome,
  writeOutcomeConsent,
  type OutcomeConsentState,
} from '../lib/inputAssistance/outcomeLearning';
import {
  INPUT_MEMORY_CONTEXT_DISCLOSURE_VERSION,
  displayedMemoryDisclosureMatches,
  inspectMemoryContext,
  memoryContextOffered,
  writeMemoryContextConsent,
} from '../lib/inputAssistance/memoryContext';
import { hasValidInputConsent, type InputConsentState } from '../lib/inputAssistance/inputConsent';
import {
  rebuildTelemetryEvent,
  recordTelemetryEvents,
  type RawTelemetryEvent,
  type TelemetryRow,
} from '../lib/inputAssistance/telemetry';
import type {
  SuggestResponse,
  SuggestSessionContext,
  CreationDraft,
  EntityType,
} from '../lib/inputAssistance/types';

const router = Router();
const logger = rootLogger.child({ route: 'inputAssistance' });

function clampCoord(raw: unknown, max: number): number | null {
  const n = typeof raw === 'number' ? raw : parseFloat(String(raw));
  return Number.isFinite(n) && Math.abs(n) <= max ? n : null;
}

function parseSessionContext(raw: unknown): SuggestSessionContext | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const out: SuggestSessionContext = {};
  if (typeof obj.tripId === 'string' && obj.tripId.length <= 100) out.tripId = obj.tripId;
  if (typeof obj.cityId === 'string' && obj.cityId.length <= 200) out.cityId = obj.cityId;
  return out.tripId || out.cityId ? out : undefined;
}

// §23/§55 creation draft. Every field is optional and bounded; unknown keys and
// oversized values are dropped so the draft can never smuggle unexpected input.
function str(raw: unknown, max: number): string | undefined {
  return typeof raw === 'string' && raw.trim().length > 0 && raw.length <= max
    ? raw.trim()
    : undefined;
}
function num(raw: unknown, max: number): number | undefined {
  const n = typeof raw === 'number' ? raw : parseFloat(String(raw));
  return Number.isFinite(n) && Math.abs(n) <= max ? n : undefined;
}
function parseCreationDraft(raw: unknown): CreationDraft | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const out: CreationDraft = {};
  const name = str(o.name, 200);
  const city = str(o.city, 100);
  const country = str(o.country, 100);
  const category = str(o.category, 80);
  const address = str(o.address, 300);
  const startDate = str(o.startDate, 40);
  const endDate = str(o.endDate, 40);
  const lat = num(o.lat, 90);
  const lng = num(o.lng, 180);
  if (name) out.name = name;
  if (city) out.city = city;
  if (country) out.country = country;
  if (category) out.category = category;
  if (address) out.address = address;
  if (startDate) out.startDate = startDate;
  if (endDate) out.endDate = endDate;
  if (lat !== undefined) out.lat = lat;
  if (lng !== undefined) out.lng = lng;
  return Object.keys(out).length > 0 ? out : undefined;
}

// ── G340 §48: the AUTHORITATIVE policy registry, served ──────────────────────
//
// THE DEFECT THIS CLOSES. `POLICY_VERSION` has travelled on every response
// since Phase 1, but there was nothing to FETCH — so a shipped client could
// learn that its policies were stale and had no way to get the current ones.
// The client therefore re-declared all 29 contexts locally, and the two copies
// drifted: measured 2026-09-21, 26 of 29 contexts disagreed on
// `allowedSuggestionTypes` and 2 on `defaultMode`. A mirror with no source is
// not a cache, it is a second authority.
//
// WHY THIS IS A GET WITH NO BODY AND NO VIEWER SCOPE. The registry is the same
// for every caller: it declares what KINDS of assistance a field may carry, not
// anything about a person. Nothing here is viewer-scoped, so nothing here needs
// a viewer to scope it — and making it anonymous is what lets a client fetch
// its policies BEFORE the user signs in, which is when it most needs them.
// Authentication is still required, because an unauthenticated caller has no
// field to apply a policy to and the surface is not a public API.
//
// WHAT IS DELIBERATELY NOT SERVED: `telemetryPolicy`. It governs what the
// SERVER logs, the client cannot alter it, and shipping it would invite a
// client to believe it may choose. The client's own telemetry gate reads
// `privacyClass`, which IS served.
router.get(
  '/input-assistance/policies',
  asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;

    // The HANDLER touches no database — it projects an in-memory registry and
    // allocates one object per context. (`requireUser` above does read
    // `profiles.account_status`; that is the §9 account gate every route pays,
    // not something this one adds.) The limit exists so a client loop cannot
    // turn a cheap read into a hot one, and is deliberately generous: a correct
    // client fetches this once per cold start and then on a version change.
    const rl = checkRateLimit('input_assist_policies', auth.user.id, 30, 60_000);
    if (!rl.allowed) {
      res.setHeader('Retry-After', Math.ceil(rl.retryAfterMs / 1000).toString());
      sendError(res, 'rate_limited', 'Too many policy fetches. Please wait.');
      return;
    }

    const contexts: Record<string, unknown> = {};
    for (const context of KNOWN_CONTEXTS) {
      const p = resolvePolicy(context);
      if (!p) continue;
      contexts[context] = {
        context,
        mode: p.mode,
        allowedSuggestionTypes: p.allowedSuggestionTypes,
        entityTypes: p.entityTypes,
        allowPersonalization: p.allowPersonalization,
        allowLiveContext: p.allowLiveContext,
        allowMemoryContext: p.allowMemoryContext,
        allowAI: p.allowAI,
        minChars: p.minChars,
        maxSuggestions: p.maxSuggestions,
        debounceMs: p.debounceMs,
        offlinePolicy: p.offlinePolicy,
        privacyClass: p.privacyClass,
        zeroStateAssistance: p.zeroStateAssistance,
      };
    }

    res.status(200).json({ policyVersion: POLICY_VERSION, contexts });
  }),
);

router.post(
  '/input-assistance/suggest',
  asyncHandler(async (req, res) => {
    // Same viewer-scope auth as the existing search path.
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { user } = auth;

    const body = (req.body ?? {}) as Record<string, unknown>;

    // ── Classify (§4) — the context is the central contract (§5) ──────────────
    const context = body.context;
    if (!isKnownContext(context)) {
      sendError(res, 'invalid_payload', 'Unknown or missing input context');
      return;
    }

    const fieldId = typeof body.fieldId === 'string' ? body.fieldId : undefined;
    const policy = resolvePolicy(context, fieldId);
    if (!policy) {
      sendError(res, 'invalid_payload', 'No policy registered for context');
      return;
    }

    const text = typeof body.text === 'string' ? body.text : '';
    const sessionContext = parseSessionContext(body.sessionContext);
    const draft = parseCreationDraft(body.draft);
    const lat = clampCoord(body.lat, 90);
    const lng = clampCoord(body.lng, 180);
    const city =
      typeof body.city === 'string' && body.city.trim().length > 0
        ? body.city.trim().slice(0, 100)
        : null;
    // §18 optional IANA timezone for temporal-window normalization. Bounded;
    // invalid/oversized values degrade to null (windows then computed in UTC).
    const tz =
      typeof body.tz === 'string' && body.tz.trim().length > 0 && body.tz.length <= 64
        ? body.tz.trim()
        : null;
    // §22 opt-in for AI-assisted writing. Strictly boolean-true; anything else
    // (absent, false, truthy non-boolean) means NOT opted in, so AI writing is
    // never enabled by an ambiguous value.
    const aiAssist = body.aiAssist === true;

    // ── §48 capability handshake (census G343) ────────────────────────────────
    // Absent ⇒ null ⇒ served exactly as before this block existed. A
    // declaration can only NARROW: `negotiateSuggestionTypes` intersects with
    // the field's own policy, so no client can talk its way into a type §6
    // forbids.
    const clientCaps = parseClientCapabilities(body.client);
    const negotiatedTypes = negotiateSuggestionTypes(policy.allowedSuggestionTypes, clientCaps);
    const servePolicy =
      negotiatedTypes.length === policy.allowedSuggestionTypes.length
        ? policy
        : { ...policy, allowedSuggestionTypes: negotiatedTypes };

    // limit: honor the request but never exceed the policy's maxSuggestions.
    const rawLimit = typeof body.limit === 'number' ? body.limit : parseInt(String(body.limit), 10);
    const requestedLimit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : policy.maxSuggestions;
    const limit = Math.min(requestedLimit, policy.maxSuggestions);

    // Rate limit: dedicated bucket, typeahead-friendly (matches /discovery/suggest).
    const rl = checkRateLimit('input_assist_suggest', user.id, 90, 60_000);
    if (!rl.allowed) {
      res.setHeader('Retry-After', Math.ceil(rl.retryAfterMs / 1000).toString());
      sendError(res, 'rate_limited', 'Too many suggestion requests. Please wait.');
      return;
    }

    const sc = getServiceClient();
    if (!sc) {
      sendError(res, 'server_not_configured', 'Service client not ready');
      return;
    }

    const requestId = crypto.randomUUID();

    // §44/§57 P95 suggestion latency (census G372: "No latency instrumentation
    // anywhere; the response carries no server timing"). The serve measures
    // ITSELF — the one number no client can compute, because a device only ever
    // sees server time plus network. It travels on the envelope and the client
    // hands it back on `suggestion_request_completed`, where it lands in the
    // serve log beside the round trip the device actually saw.
    const startedAt = Date.now();

    try {
      const { suggestions: generated, refusal, laneRefusals } = await generateSuggestionsWithCoverage(sc, {
        context,
        policy: servePolicy,
        text,
        userId: user.id,
        limit,
        sessionContext,
        lat,
        lng,
        city,
        draft,
        tz,
        aiAssist,
      });

      // The second half of the handshake: a row the client has told us it
      // cannot resolve is withheld rather than sent to be dropped on arrival.
      const { rows: suggestions, dropped } = dropUnresolvableActionRows(generated, clientCaps);

      const serverMs = Date.now() - startedAt;
      const payload: SuggestResponse = {
        requestId,
        policyVersion: POLICY_VERSION,
        // §48 (census G341) — the SHAPE's version, independent of the policy's.
        // A policy bump and a shape bump are different events with different
        // consequences and were previously indistinguishable to a client.
        schemaVersion: SUGGESTION_SCHEMA_VERSION,
        capabilities: {
          schemaVersion: SUGGESTION_SCHEMA_VERSION,
          suggestionTypes: negotiatedTypes,
          withheldForClient: dropped,
        },
        context,
        fieldId,
        suggestions, ...(refusal ? { refusal } : {}), ...(laneRefusals?.saved ? { laneRefusals: { saved: laneRefusals.saved } } : {}),
        serverMs,
      };
      // Instrumented on the server's own side too, so the quantile is
      // computable from logs even where the client transport is not attached.
      logger.info(
        { requestId, context, fieldId, serverMs, count: suggestions.length, withheldForClient: dropped },
        'input-assistance/suggest served',
      );
      res.status(200).json(payload);
    } catch (err) {
      // Typeahead must never surface an error mid-keystroke — fail soft to an
      // empty, well-formed envelope (still carries policyVersion + requestId).
      logger.warn({ err, context, serverMs: Date.now() - startedAt }, 'input-assistance/suggest failed');
      const payload: SuggestResponse = {
        requestId,
        policyVersion: POLICY_VERSION,
        // The degraded envelope carries the schema version too: a client that
        // refuses an unknown shape must be able to tell "this serve failed"
        // from "this serve speaks a shape I do not know".
        schemaVersion: SUGGESTION_SCHEMA_VERSION,
        context,
        fieldId,
        suggestions: [], refusal: gatewayFailureRefusal(), // §80: a failed serve is not an empty one
        serverMs: Date.now() - startedAt,
      };
      res.status(200).json(payload);
    }
  }),
);

// ── POST /api/input-assistance/select — record an EXPLICIT selection (§35) ────
//
// Phase 8 (Personalization). Called ONLY when the user explicitly ACCEPTS a
// suggestion (selects an entity/completion). It records the (context, canonical
// entity, the query that led to the selection) so the gateway can — for THIS
// user only — rank their repeatedly-selected entities higher (§15) and serve
// zero-character recents (§14). It records EXPLICIT selections only: there is no
// view/typing/dwell path into this table.
//
// Owner-scoped (session-derived user id, never a query param) and additive: it
// creates NO canonical fact and touches NO existing endpoint, so it cannot
// regress the suggest path. recordSelection refuses (records nothing) for a
// context whose field policy disallows personalization (username / private-
// message / hidden-gem), so those are never tracked.
router.post(
  '/input-assistance/select',
  asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { user } = auth;

    const body = (req.body ?? {}) as Record<string, unknown>;

    const context = body.context;
    if (!isKnownContext(context)) {
      sendError(res, 'invalid_payload', 'Unknown or missing input context');
      return;
    }
    const fieldId = typeof body.fieldId === 'string' ? body.fieldId : undefined;
    const policy = resolvePolicy(context, fieldId);
    if (!policy) {
      sendError(res, 'invalid_payload', 'No policy registered for context');
      return;
    }

    const entityType = typeof body.entityType === 'string' ? body.entityType.trim() : '';
    const entityId = typeof body.entityId === 'string' ? body.entityId.trim() : '';
    if (!entityType || entityType.length > 40 || !entityId || entityId.length > 200) {
      sendError(res, 'invalid_payload', 'entityType and entityId are required');
      return;
    }
    const query =
      typeof body.query === 'string' && body.query.trim().length > 0
        ? body.query.trim().slice(0, 200)
        : null;
    const label =
      typeof body.label === 'string' && body.label.trim().length > 0
        ? body.label.trim().slice(0, 200)
        : null;

    const rl = checkRateLimit('input_assist_select', user.id, 60, 60_000);
    if (!rl.allowed) {
      res.setHeader('Retry-After', Math.ceil(rl.retryAfterMs / 1000).toString());
      sendError(res, 'rate_limited', 'Too many selection events. Please wait.');
      return;
    }

    const sc = getServiceClient();
    if (!sc) {
      sendError(res, 'server_not_configured', 'Service client not ready');
      return;
    }

    // recordSelection enforces the explicit-only + owner-scoped gate: it records
    // only for personalization-enabled contexts and only entity types the policy
    // allows, and is fail-soft (a write failure never surfaces to the client).
    const result = await recordSelection(
      sc,
      policy,
      {
        userId: user.id,
        context,
        entityType: entityType as EntityType,
        entityId,
        query,
        label,
      },
      logger,
    );

    res.status(200).json({ ok: true, recorded: result.recorded, policyVersion: POLICY_VERSION });
  }),
);

// ── POST /api/input-assistance/telemetry — the §44 serve log ingest ───────────
//
// THE DESTINATION THE CLIENT NEVER HAD
// ====================================
// `platform/input-assistance/services/inputTelemetry.ts` has declared fourteen
// §44 event names since Phase 1 and has had real call sites for nine of them
// since Phase 11 — every one handed to a sink that is `() => {}`. The census
// records that at G263 ("Emission is not measurement: in production these
// events are now produced and dropped"), at G292 ("There is no server-side
// telemetry service, no serve log, no impression record"), and again at G306,
// G355, G365, G366 and G367, each naming the same missing piece: somewhere for
// the events to LAND.
//
// This is that somewhere. It is a route and not a client repoint because there
// was nothing to repoint the events AT.
//
// THE PAYLOAD IS REBUILT, THE POLICY IS ENFORCED, THE ERROR IS BOUND
// =================================================================
// All three live in lib/inputAssistance/telemetry.ts and are argued there. In
// summary: an event is rebuilt from a per-name prop allow-list (an unknown key
// cannot ride along under any spelling), an event the field's own
// `telemetryPolicy` does not declare is REFUSED and counted, and a PostgREST
// write failure answers 503 + `retryable: true` rather than `{ok:true,
// accepted:0}` — because migration 2950 is unapplied and that failure is the
// state this route is actually in today. A telemetry endpoint that reports a
// broken ingest as "no usage" is worse than no endpoint at all.
//
// NO ACTOR IS STORED. `requireUser` runs — to refuse anonymous writers and to
// key the rate limit — and the resulting user id is then deliberately NOT
// persisted. Migration 2950's header argues that at length; the short version
// is that every §57 metric over this table is a rate or a quantile, so an
// account id would be captured unnecessarily, which is the thing §44 forbids.
// The `sessionId` the client supplies is a pseudonymous correlator and is
// bounded to a token.
const MAX_TELEMETRY_BATCH = 50;

router.post(
  '/input-assistance/telemetry',
  asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { user } = auth;

    const body = (req.body ?? {}) as Record<string, unknown>;

    const sessionIdRaw = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
    if (!sessionIdRaw || sessionIdRaw.length > 64 || !/^[A-Za-z0-9_.:-]+$/.test(sessionIdRaw)) {
      sendError(res, 'invalid_payload', 'sessionId must be a bounded opaque token');
      return;
    }

    const events = body.events;
    if (!Array.isArray(events) || events.length === 0) {
      sendError(res, 'invalid_payload', 'events must be a non-empty array');
      return;
    }
    // Refused WHOLE, not truncated. A silently truncated batch is a funnel with
    // a hole in it that nothing reports.
    if (events.length > MAX_TELEMETRY_BATCH) {
      sendError(res, 'invalid_payload', `events must contain at most ${MAX_TELEMETRY_BATCH} entries`);
      return;
    }

    const rl = checkRateLimit('input_assist_telemetry', user.id, 120, 60_000);
    if (!rl.allowed) {
      res.setHeader('Retry-After', Math.ceil(rl.retryAfterMs / 1000).toString());
      sendError(res, 'rate_limited', 'Too many telemetry batches. Please wait.');
      return;
    }

    const sc = getServiceClient();
    if (!sc) {
      sendError(res, 'server_not_configured', 'Service client not ready');
      return;
    }

    // OD-INPUT-1: `downstream_task_completed` asserts that a real task really
    // completed, so it is admitted ONLY for a caller who opted in (and only
    // while the flag is on). Checked server-side, once per batch, and only when
    // the batch carries one: the client gate is a courtesy, this is the rule.
    // A failed check refuses the event — an unknown consent is not a consent.
    // Every other §44 event is unaffected. Still no account id is stored.
    const carriesOutcome = (events as unknown[]).some(
      (e) => !!e && typeof e === 'object' && (e as { name?: unknown }).name === 'downstream_task_completed',
    );
    const outcomeAdmitted = carriesOutcome ? await outcomeLearningActive(sc, user.id) : false;

    const now = Date.now();
    const rows: TelemetryRow[] = [];
    let rejected = 0;
    for (const raw of events as RawTelemetryEvent[]) {
      if (
        !outcomeAdmitted &&
        raw && typeof raw === 'object' && (raw as { name?: unknown }).name === 'downstream_task_completed'
      ) {
        rejected += 1;
        continue;
      }
      const ctx = raw && typeof raw === 'object' ? (raw as { context?: unknown }).context : undefined;
      const fid =
        raw && typeof raw === 'object' && typeof (raw as { fieldId?: unknown }).fieldId === 'string'
          ? ((raw as { fieldId: string }).fieldId)
          : undefined;
      // An unregistered context resolves to no policy, and no policy is a
      // refusal — "declared nothing" is not "declared everything".
      const policy = isKnownContext(ctx) ? resolvePolicy(ctx, fid) : null;
      const outcome = rebuildTelemetryEvent(raw, sessionIdRaw, policy ?? null, POLICY_VERSION, now);
      if (outcome.ok) rows.push(outcome.row);
      else rejected += 1;
    }

    const result = await recordTelemetryEvents(sc, rows, logger);
    if ('refusal' in result) {
      // A PERMANENT refusal is answered 422, not 503 with a Retry-After. The
      // distinction is not cosmetic: 503 + Retry-After tells the batcher this
      // batch will succeed later, and for a constraint violation that is false
      // — the row can never be accepted, so the client would retry forever and
      // every event queued behind it would never land. A permanent failure
      // dressed as a transient one is the same dishonesty as an empty success
      // over a broken ingest, which this route's header already refuses.
      if (!result.refusal.retryable) {
        res.status(422).json({
          ok: false,
          retryable: false,
          reason: result.refusal.reason,
          accepted: 0,
          rejected,
        });
        return;
      }
      res.setHeader('Retry-After', '60');
      res.status(503).json({
        ok: false,
        retryable: true,
        reason: result.refusal.reason,
        accepted: 0,
        rejected,
      });
      return;
    }

    res.status(200).json({ ok: true, accepted: result.recorded, rejected });
  }),
);

export default router;

// ── §45 OUTCOME LEARNING — the opt-in and the outcome write (OD-INPUT-1/2) ────
//
// Census G320/G370 and the rank term G5/G14/G322/G323 need. Three endpoints:
//
//   GET  /input-assistance/outcome-consent  — is it offered (flag), and the
//        caller's own state. Readable with the flag OFF, so a person who opted
//        in can always see that and withdraw.
//   PUT  /input-assistance/outcome-consent  — { enabled, disclosureVersion }.
//        A GRANT needs the flag on and the disclosure version the client
//        DISPLAYED to equal the one stamped; a WITHDRAWAL is always accepted and
//        deletes the caller's counters.
//   POST /input-assistance/outcome           — a completed downstream task and
//        the canonical entities it used, credited to the caller's per-field
//        counters. Refused unless the flag is on AND the caller opted in, and
//        only for a field whose policy keeps per-user memory of that entity type.
//
// The shared §44 stream is gated too (see the telemetry ingest above).

function consentBody(state: OutcomeConsentState | null, available: boolean) {
  return {
    available,
    enabled: hasValidOutcomeConsent(state),
    consentVersion: state?.consentVersion ?? null,
    consentedAt: state?.consentedAt ?? null,
    withdrawnAt: state?.withdrawnAt ?? null,
    currentDisclosureVersion: INPUT_OUTCOME_DISCLOSURE_VERSION,
    retentionDays: INPUT_OUTCOME_RETENTION_DAYS,
  };
}

router.get(
  '/input-assistance/outcome-consent',
  asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const sc = getServiceClient();
    if (!sc) {
      sendError(res, 'server_not_configured', 'Service client not ready');
      return;
    }
    const available = await outcomeLearningOffered(sc);
    const read = await readOutcomeConsent(sc, auth.user.id);
    // An unreadable consent is NOT "never consented": rendering it as off would
    // let the toggle re-stamp a consent the person already gave, or hide one
    // they need to withdraw.
    if (!read.ok) {
      sendError(res, 'degraded_unavailable', 'Your setting could not be read. Please try again.');
      return;
    }
    res.status(200).json(consentBody(read.state, available));
  }),
);

router.put(
  '/input-assistance/outcome-consent',
  asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { user } = auth;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.enabled !== 'boolean') {
      sendError(res, 'invalid_payload', 'enabled must be a boolean');
      return;
    }
    const rl = checkRateLimit('input_assist_outcome_consent', user.id, 20, 60_000);
    if (!rl.allowed) {
      res.setHeader('Retry-After', Math.ceil(rl.retryAfterMs / 1000).toString());
      sendError(res, 'rate_limited', 'Too many changes. Please wait.');
      return;
    }
    const sc = getServiceClient();
    if (!sc) {
      sendError(res, 'server_not_configured', 'Service client not ready');
      return;
    }
    const available = await outcomeLearningOffered(sc);
    if (body.enabled) {
      if (!available) {
        sendError(res, 'feature_disabled', 'This setting is not available yet.');
        return;
      }
      if (!displayedOutcomeDisclosureMatches(body.disclosureVersion)) {
        sendError(res, 'conflict', 'The explanation you saw is out of date. Please review it again.');
        return;
      }
    }
    const write = await writeOutcomeConsent(sc, user.id, body.enabled);
    if (!write.ok) {
      sendError(res, 'degraded_unavailable', 'Your setting could not be saved. Please try again.');
      return;
    }
    res.status(200).json({ ...consentBody(write.state, available), countersErased: write.countersErased });
  }),
);

router.post(
  '/input-assistance/outcome',
  asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { user } = auth;
    const body = (req.body ?? {}) as Record<string, unknown>;

    const context = body.context;
    if (!isKnownContext(context)) {
      sendError(res, 'invalid_payload', 'Unknown or missing input context');
      return;
    }
    const fieldId = typeof body.fieldId === 'string' && body.fieldId.length <= 100 ? body.fieldId : undefined;
    const policy = resolvePolicy(context, fieldId);
    if (!policy || !policy.allowPersonalization) {
      sendError(res, 'invalid_payload', 'Outcome learning is not available for this field');
      return;
    }
    if (!isOutcomeTask(body.task)) {
      sendError(res, 'invalid_payload', 'Unknown task');
      return;
    }
    if (typeof body.ok !== 'boolean') {
      sendError(res, 'invalid_payload', 'ok must be a boolean');
      return;
    }
    const rawEntities = Array.isArray(body.entities) ? body.entities : [];
    if (rawEntities.length > MAX_OUTCOME_ENTITIES) {
      sendError(res, 'invalid_payload', `entities must contain at most ${MAX_OUTCOME_ENTITIES} entries`);
      return;
    }
    const entities: Array<{ entityType: string; entityId: string }> = [];
    for (const e of rawEntities) {
      const t = e && typeof e === 'object' ? (e as { entityType?: unknown }).entityType : undefined;
      const id = e && typeof e === 'object' ? (e as { entityId?: unknown }).entityId : undefined;
      if (typeof t !== 'string' || typeof id !== 'string' || !id.trim() || id.length > 200) {
        sendError(res, 'invalid_payload', 'each entity needs an entityType and an entityId');
        return;
      }
      // The same gate selection memory applies: a field that may not remember
      // this entity type for this user may not count outcomes against it either.
      if (!policyAdmitsMemory(policy, t)) {
        sendError(res, 'invalid_payload', 'This field does not keep outcomes for that kind of entity');
        return;
      }
      entities.push({ entityType: t, entityId: id.trim() });
    }

    const rl = checkRateLimit('input_assist_outcome', user.id, 30, 60_000);
    if (!rl.allowed) {
      res.setHeader('Retry-After', Math.ceil(rl.retryAfterMs / 1000).toString());
      sendError(res, 'rate_limited', 'Too many outcome reports. Please wait.');
      return;
    }
    const sc = getServiceClient();
    if (!sc) {
      sendError(res, 'server_not_configured', 'Service client not ready');
      return;
    }
    if (!(await outcomeLearningOffered(sc))) {
      sendError(res, 'feature_disabled', 'Outcome learning is not available.');
      return;
    }
    const consent = await readOutcomeConsent(sc, user.id);
    if (!consent.ok) {
      sendError(res, 'degraded_unavailable', 'Your setting could not be read.');
      return;
    }
    if (!hasValidOutcomeConsent(consent.state)) {
      sendError(res, 'forbidden', 'Outcome learning is off for this account.');
      return;
    }
    // A task that did not succeed credits nothing: the counters are completions.
    if (!body.ok || entities.length === 0) {
      res.status(200).json({ ok: true, recorded: 0, failed: 0, refused: 0 });
      return;
    }
    let recorded = 0;
    let failed = 0;
    let refused = 0;
    for (const e of entities) {
      const r = await recordOutcome(sc, { userId: user.id, context, entityType: e.entityType, entityId: e.entityId });
      if (r === 'recorded') recorded += 1;
      else if (r === 'no_consent') refused += 1;
      else failed += 1;
    }
    // Counts only — which entities a person completed tasks with is not a log fact.
    logger.info({ context, task: body.task, recorded, failed, refused }, 'input-assistance/outcome');
    if (recorded === 0 && failed > 0) {
      res.status(503).json({ ok: false, retryable: true, recorded, failed, refused });
      return;
    }
    res.status(200).json({ ok: true, recorded, failed, refused });
  }),
);

// ── §6 allowMemoryContext — Compass memory, opt-in, inspect, revoke (OD-INPUT-3) ─
//
//   GET /input-assistance/memory-context — is it offered, the caller's own
//       opt-in, and (ONLY when that opt-in is on) exactly the memory facts the
//       Compass starters would be built from: the inspect view.
//   PUT /input-assistance/memory-context-consent — { enabled, disclosureVersion }.
//       A grant needs the flag and the displayed disclosure version; revoking
//       (enabled:false) is always accepted and takes effect on the next serve.

function memoryConsentBody(state: InputConsentState | null, available: boolean) {
  return {
    available,
    enabled: hasValidInputConsent(state),
    consentVersion: state?.consentVersion ?? null,
    consentedAt: state?.consentedAt ?? null,
    withdrawnAt: state?.withdrawnAt ?? null,
    currentDisclosureVersion: INPUT_MEMORY_CONTEXT_DISCLOSURE_VERSION,
  };
}

router.get(
  '/input-assistance/memory-context',
  asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const sc = getServiceClient();
    if (!sc) {
      sendError(res, 'server_not_configured', 'Service client not ready');
      return;
    }
    const inspection = await inspectMemoryContext(sc, auth.user.id);
    if (!inspection.ok) {
      sendError(res, 'degraded_unavailable', 'Your setting could not be read. Please try again.');
      return;
    }
    res.status(200).json({
      ...memoryConsentBody(inspection.consent, inspection.available),
      // null = nothing was read (off, or not offered). [] = read, and empty.
      facts: inspection.facts?.map((f) => ({ city: f.city, country: f.country, occurredAt: f.occurredAt })) ?? null,
      factsUnavailable: inspection.factsUnavailable !== null,
    });
  }),
);

router.put(
  '/input-assistance/memory-context-consent',
  asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.enabled !== 'boolean') {
      sendError(res, 'invalid_payload', 'enabled must be a boolean');
      return;
    }
    const rl = checkRateLimit('input_assist_memory_consent', auth.user.id, 20, 60_000);
    if (!rl.allowed) {
      res.setHeader('Retry-After', Math.ceil(rl.retryAfterMs / 1000).toString());
      sendError(res, 'rate_limited', 'Too many changes. Please wait.');
      return;
    }
    const sc = getServiceClient();
    if (!sc) {
      sendError(res, 'server_not_configured', 'Service client not ready');
      return;
    }
    const available = await memoryContextOffered(sc);
    if (body.enabled) {
      if (!available) {
        sendError(res, 'feature_disabled', 'This setting is not available yet.');
        return;
      }
      if (!displayedMemoryDisclosureMatches(body.disclosureVersion)) {
        sendError(res, 'conflict', 'The explanation you saw is out of date. Please review it again.');
        return;
      }
    }
    const write = await writeMemoryContextConsent(sc, auth.user.id, body.enabled);
    if (!write.ok) {
      sendError(res, 'degraded_unavailable', 'Your setting could not be saved. Please try again.');
      return;
    }
    res.status(200).json(memoryConsentBody(write.state, available));
  }),
);

// ── POST /api/input-assistance/extract — §24 Paste Intelligence (GII-F08) ────
//
// Classify a pasted blob (coordinates, a map link, a list of stops, an
// itinerary, one place) and resolve every item through the SAME gateway the
// suggest route serves typed text from (`lib/inputAssistance/pasteExtraction.ts`).
//
// READ-ONLY BY CONSTRUCTION (§24: "Bulk extraction must always lead to a review
// screen before persistent mutation"). Nothing here writes; the client's review
// screen persists only what the person ticked, through the target field's own
// endpoint and its own authorization. `mutated: false` is on every answer.
//
// FAILURE HONESTY. Per item, `failed` (a source did not answer) is distinct
// from `no_match` (it answered, nothing matched). A serve that throws as a
// whole is a retryable 503 — never a 200 with an empty list, which the review
// screen would have to render as "nothing found".
router.post(
  '/input-assistance/extract',
  asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { user } = auth;
    const body = (req.body ?? {}) as Record<string, unknown>;

    const context = body.context;
    if (!isKnownContext(context) || !PASTE_CONTEXTS.has(context)) {
      sendError(res, 'invalid_payload', 'Paste extraction is not available for this field');
      return;
    }
    const fieldId = typeof body.fieldId === 'string' && body.fieldId.length <= 100 ? body.fieldId : undefined;
    const policy = resolvePolicy(context, fieldId);
    if (!policy || policy.mode === 'no_assistance') {
      sendError(res, 'invalid_payload', 'Paste extraction is not available for this field');
      return;
    }
    const classification = classifyPaste(body.text);
    if (classification.shape === 'empty') {
      sendError(res, 'invalid_payload', 'Nothing was pasted');
      return;
    }

    // A paste fans out into up to PASTE_MAX_ITEMS gateway serves (and geocoder
    // calls), so it has its own, much smaller bucket than typeahead.
    const rl = checkRateLimit('input_assist_extract', user.id, 20, 60_000);
    if (!rl.allowed) {
      res.setHeader('Retry-After', Math.ceil(rl.retryAfterMs / 1000).toString());
      sendError(res, 'rate_limited', 'Too many paste extractions. Please wait.');
      return;
    }
    const sc = getServiceClient();
    if (!sc) {
      sendError(res, 'server_not_configured', 'Service client not ready');
      return;
    }

    const requestId = crypto.randomUUID();
    const startedAt = Date.now();
    try {
      const items = await resolvePaste(sc, {
        context,
        policy,
        userId: user.id,
        sessionContext: parseSessionContext(body.sessionContext),
        tz: typeof body.tz === 'string' && body.tz.length <= 64 ? body.tz : null,
      }, classification);
      // Private-by-default logging: counts and statuses only, never the text.
      logger.info(
        { requestId, context, shape: classification.shape, items: items.length, failed: items.filter((i) => i.status === 'failed').length, serverMs: Date.now() - startedAt },
        'input-assistance/extract served',
      );
      res.status(200).json({
        requestId,
        policyVersion: POLICY_VERSION,
        context,
        fieldId,
        shape: classification.shape,
        truncated: classification.truncated,
        mutated: false,
        items,
      });
    } catch (err) {
      logger.warn({ err, context, requestId }, 'input-assistance/extract failed');
      sendError(res, 'degraded_unavailable', 'We could not read that paste. Please try again.');
    }
  }),
);

import { PASTE_CONTEXTS, classifyPaste, resolvePaste } from '../lib/inputAssistance/pasteExtraction';
