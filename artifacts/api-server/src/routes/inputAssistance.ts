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
import { recordSelection } from '../lib/inputAssistance/personalization';
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

    try {
      const suggestions = await generateSuggestions(sc, {
        context,
        policy,
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

      const payload: SuggestResponse = {
        requestId,
        policyVersion: POLICY_VERSION,
        context,
        fieldId,
        suggestions,
      };
      res.status(200).json(payload);
    } catch (err) {
      // Typeahead must never surface an error mid-keystroke — fail soft to an
      // empty, well-formed envelope (still carries policyVersion + requestId).
      logger.warn({ err, context }, 'input-assistance/suggest failed');
      const payload: SuggestResponse = {
        requestId,
        policyVersion: POLICY_VERSION,
        context,
        fieldId,
        suggestions: [],
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

export default router;
