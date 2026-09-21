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
  POLICY_VERSION,
} from '../lib/inputAssistance/policyRegistry';
import { generateSuggestions } from '../lib/inputAssistance/gateway';
import {
  SUGGESTION_SCHEMA_VERSION,
  parseClientCapabilities,
  negotiateSuggestionTypes,
  dropUnresolvableActionRows,
} from '../lib/inputAssistance/compatibility';
import { recordSelection } from '../lib/inputAssistance/personalization';
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
      const generated = await generateSuggestions(sc, {
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
        suggestions,
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
        suggestions: [],
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

    const now = Date.now();
    const rows: TelemetryRow[] = [];
    let rejected = 0;
    for (const raw of events as RawTelemetryEvent[]) {
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
      res.setHeader('Retry-After', '60');
      res.status(503).json({
        ok: false,
        retryable: result.refusal.retryable,
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
