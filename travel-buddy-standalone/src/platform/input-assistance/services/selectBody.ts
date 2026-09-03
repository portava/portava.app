/**
 * Global Input Intelligence — the explicit-selection recorder core (Phase 8,
 * spec §35 Selection Memory / §15 PriorSelection / §14 zero-char recents).
 *
 * The CLIENT half of the merged Phase 8 backend (POST /input-assistance/select).
 * When a user EXPLICITLY accepts a gateway suggestion — taps an entity/completion
 * to select it — the SDK records (context, canonical entity, the query that led
 * to it) so the gateway can, FOR THAT USER ONLY, rank their repeatedly-selected
 * entities higher (§15) and serve zero-character recents (§14). The gateway owns
 * the boost + the "BKK"→Bangkok abbreviation mapping; the client only RECORDS the
 * explicit accept and BENEFITS from the re-ranked results.
 *
 * THE INVARIANTS THIS MODULE ENFORCES (why it is privacy-safe + additive)
 * ----------------------------------------------------------------------
 *   1. EXPLICIT ACCEPTS ONLY. `selectionFromSuggestion` returns a payload ONLY
 *      for an accepted real-entity suggestion (carries entityType + entityId and
 *      is not an action / AI-insertion / correction / validation row). There is
 *      no view / hover / keystroke path into it — the sole caller is the SDK's
 *      accept handler, never the fetch/render path.
 *   2. OWNER-SCOPED, SERVER-SIDE. The client sends NO user id; the backend derives
 *      the owner from the session. The client additionally refuses to send for a
 *      personalization-disabled or private-message context, mirroring the
 *      backend's refusal so nothing needless leaves the device.
 *   3. FAIL-SOFT. `recordSelectionWith` NEVER throws and NEVER rejects — a failed
 *      record (offline, 404, error) resolves to `{ recorded:false }` so the
 *      selection the user made always proceeds. It is a side-effect, not a gate.
 *
 * PURE module — no React, no network, no RN. Network access is INJECTED, so this
 * is safe to import under the node:test runner (mirrors suggestBody.ts).
 */
import type { AssistanceType, EntityType, InputContext } from '../types/inputContext.ts';
import type { InputFieldPolicy } from '../types/fieldPolicy.ts';
import type { InputSuggestion } from '../types/inputSuggestion.ts';

/**
 * The POST body the SDK sends on an explicit accept. Mirrors the merged backend
 * route (`POST /input-assistance/select`) EXACTLY: it reads `context`, optional
 * `fieldId`, `entityType`, `entityId`, optional `query` (the RAW text that led to
 * the selection — the backend normalizes it into a stable key), and optional
 * `label`. No user id is ever sent (owner scope is session-derived server-side).
 */
export interface SelectRequest {
  context: InputContext;
  fieldId?: string;
  entityType: EntityType;
  entityId: string;
  /** RAW text that led to the selection; backend folds it into a query key. */
  query?: string | null;
  /** Freshest display label, so a zero-char recent can render before hydration. */
  label?: string | null;
}

/**
 * Assistance types that are NOT an entity selection worth remembering. An action
 * dispatches a command, an AI proposal is opt-in text (§22) not a canonical pick,
 * and correction/validation rows are hints — none is "the user chose THIS
 * canonical entity". Everything else (entity / recent / personalized /
 * disambiguation / completion / structured_value) is recordable IFF it also
 * carries a canonical entityType + entityId.
 */
const NON_SELECTION_TYPES: ReadonlySet<AssistanceType> = new Set<AssistanceType>([
  'action',
  'ai_suggestion',
  'correction',
  'validation',
]);

/**
 * The entity identity a suggestion carries — from its top-level fields, or from
 * an `open_entity` action when the top-level fields are absent (mirrors
 * globalSearch.entityIdentity so both paths agree on what "the picked entity" is).
 */
function entityIdentity(s: InputSuggestion): { entityType?: EntityType; entityId?: string } {
  if (s.entityType && s.entityId) return { entityType: s.entityType, entityId: s.entityId };
  const action = s.action;
  if (action && action.type === 'open_entity') {
    return {
      entityType: s.entityType ?? action.entityType,
      entityId: s.entityId ?? action.entityId,
    };
  }
  return { entityType: s.entityType, entityId: s.entityId };
}

/**
 * Derive the select-record payload for an EXPLICITLY ACCEPTED suggestion, or
 * `null` when the accept is not a recordable real-entity selection. This is the
 * single trigger predicate — the SDK accept handler calls it and fires only when
 * it returns a payload. It is deliberately conservative:
 *
 *   • `policy` must exist and be personalization-enabled — a personalization-off
 *     context (username / display_name / titles …) records nothing.
 *   • a private_message context is never tracked (mirrors the backend), even
 *     though an entity may be accepted while composing one.
 *   • the suggestion must carry a canonical entityType + entityId and must not be
 *     an action / AI / correction / validation row (NON_SELECTION_TYPES).
 *   • the entityType must be one the field policy allows (mirrors the backend's
 *     `entityTypes` gate), so a stray type is never recorded.
 *
 * Views, hovers, and keystrokes NEVER reach this function — there is no call site
 * on the fetch/render path — so a selection is the only thing it can express.
 */
export function selectionFromSuggestion(
  suggestion: InputSuggestion,
  opts: { policy: InputFieldPolicy | null | undefined; query?: string | null },
): SelectRequest | null {
  const { policy } = opts;
  if (!policy) return null;
  // Privacy gate — mirror the backend so nothing needless leaves the device.
  if (!policy.allowPersonalization) return null;
  if (policy.privacyClass === 'private_message') return null;

  if (!suggestion || NON_SELECTION_TYPES.has(suggestion.type)) return null;

  const { entityType, entityId } = entityIdentity(suggestion);
  if (!entityType || !entityId) return null;

  // Only entity types the field policy allows (mirrors the backend gate).
  if (Array.isArray(policy.entityTypes) && !policy.entityTypes.includes(entityType)) {
    return null;
  }

  const q = typeof opts.query === 'string' ? opts.query.trim() : '';
  const label = typeof suggestion.label === 'string' ? suggestion.label.trim() : '';
  return {
    context: policy.context,
    fieldId: policy.fieldId,
    entityType,
    entityId,
    query: q.length > 0 ? q : null,
    label: label.length > 0 ? label : null,
  };
}

/**
 * Build the exact JSON body for `POST /input-assistance/select`. Only the fields
 * the backend route reads are emitted; optional `fieldId` / `query` / `label` are
 * included only when meaningfully set. Pure — testable on its own.
 */
export function buildSelectBody(req: SelectRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    context: req.context,
    entityType: req.entityType,
    entityId: req.entityId,
  };
  if (typeof req.fieldId === 'string' && req.fieldId.length > 0) body.fieldId = req.fieldId;
  const q = typeof req.query === 'string' ? req.query.trim() : '';
  if (q.length > 0) body.query = q.slice(0, 200);
  const label = typeof req.label === 'string' ? req.label.trim() : '';
  if (label.length > 0) body.label = label.slice(0, 200);
  return body;
}

/** Injected network dependencies, so the fail-soft core stays RN/network-free. */
export interface SelectDeps {
  apiBase: () => string;
  getToken: () => Promise<string | null>;
  fetchImpl: typeof fetch;
}

export interface RecordResult {
  recorded: boolean;
  reason?: string;
}

/**
 * Fire the explicit-select record with injected deps. NEVER throws and NEVER
 * rejects — every failure (no api base, no token, non-2xx, network/JSON error)
 * resolves to `{ recorded:false, reason }`. This is what makes the recording a
 * pure side-effect: a failed record can never break the selection the user made.
 */
export async function recordSelectionWith(deps: SelectDeps, req: SelectRequest): Promise<RecordResult> {
  try {
    const base = (deps.apiBase() ?? '').trim();
    if (!base) return { recorded: false, reason: 'no_api_base' };

    let token: string | null = null;
    try {
      token = await deps.getToken();
    } catch {
      token = null;
    }
    // No token → do not send. Unauthenticated surfaces simply record nothing.
    if (!token) return { recorded: false, reason: 'no_token' };

    const res = await deps.fetchImpl(`${base}/input-assistance/select`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(buildSelectBody(req)),
    });
    if (!res || !res.ok) {
      return { recorded: false, reason: res ? `http_${res.status}` : 'no_response' };
    }
    return { recorded: true };
  } catch {
    // FAIL-SOFT — the selection proceeds regardless of a record failure.
    return { recorded: false, reason: 'error' };
  }
}
