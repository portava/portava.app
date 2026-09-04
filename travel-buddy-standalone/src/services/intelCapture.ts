/**
 * Intelligence Gathering — capture service (client of the shadow IG-03 API).
 *
 * Wraps POST /api/v1/intel/observations, .../claims:propose, :approve,
 * /confirm and /correct. Uses the same authedFetch / freshToken pattern as the
 * other service modules (intelligence.ts, tripPlan.ts): the access token is
 * fetched internally; callers pass only domain arguments.
 *
 * Every WRITE carries an `Idempotency-Key` header (required by the route). The
 * key is minted per prepared submission and reused across retries, so a dropped
 * response never doubles an observation. `actor_id`, `source_class`,
 * `observed_at` clamping and all canonical mapping happen server-side.
 *
 * INERT WHEN OFF. This module never checks the feature flag itself — the UI
 * gates every entry point on `intel_capture_quick_signal` and its dependants, so
 * with the flags off nothing here is ever called. If it were called anyway the
 * server fail-closes (`feature_disabled`), which is surfaced verbatim as the
 * result's `code`. When the API base is unconfigured every call is a no-op
 * `{ ok: false, error: 'not_configured' }`.
 */
import { isSupabaseConfigured } from '../lib/supabase.ts';
import { freshToken as freshApiToken } from './apiToken.ts';
import type { QuickSignalContext, Visibility, ConfirmStance, PartySizeBucket } from '../lib/intel/contracts.ts';

const apiBase = () => process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
const INTEL_BASE = '/api/v1/intel';

async function authedFetch(path: string, opts: RequestInit = {}): Promise<Response> {
  const token = await freshApiToken();
  return fetch(`${apiBase()}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers ?? {}),
    },
  });
}

/**
 * A collision-resistant idempotency key that matches the server's accepted
 * shape `^[A-Za-z0-9][A-Za-z0-9._:-]*$` (max 128). Prefers a real UUID where the
 * runtime provides one (web / polyfilled), else composes from time + entropy —
 * no crypto polyfill is required on native.
 */
export function makeIdempotencyKey(prefix = 'qs'): string {
  const g: any = globalThis as any;
  const uuid: string | null =
    typeof g?.crypto?.randomUUID === 'function' ? g.crypto.randomUUID() : null;
  const body = uuid ?? `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e12).toString(36)}`;
  return `${prefix}-${body}`.slice(0, 128);
}

/** The §19 response envelope the route returns for a stored observation. */
export interface ObservationEnvelope {
  id: string;
  subjectId: string;
  zoneId: string | null;
  claimType: string;
  value: unknown;
  sourceLabel: string;
  observedAt: string;
  validUntil: string | null;
  schemaVersion: unknown;
  presenceLevel: string;
  visibility: Visibility;
}

export interface CaptureResult {
  ok: boolean;
  observation?: ObservationEnvelope;
  deduped?: boolean;
  /** Stable server error code (e.g. 'feature_disabled', 'invalid_payload'). */
  code?: string;
  error?: string;
}

async function readError(res: Response): Promise<{ code?: string; error?: string }> {
  try {
    const data = await res.json();
    return { code: data?.error, error: data?.message ?? data?.error };
  } catch {
    return { error: `http_${res.status}` };
  }
}

// ── The write payload ────────────────────────────────────────────────────────
export interface ObservationInput {
  subjectId: string;
  subjectKind?: string;
  zoneId?: string | null;
  /** Defaults to now at call time if omitted. */
  observedAt?: string;
  capturedAt?: string | null;
  visibility?: Visibility;
  presenceLevel?: string;
  /** Quick Signal form: a context + a chosen option, mapped server-side. */
  context?: QuickSignalContext;
  option?: string;
  /** Direct form: an already-canonical Phase-1 claim. */
  claimType?: string;
  value?: Record<string, unknown>;
  /**
   * V1 independent-group signal: the "who are you here with?" answer. The server
   * derives a privacy-safe group_key from it; omitting it is fail-closed (null
   * group_key, no credit toward the independent-group floor). Only sent for
   * label-eligible captures.
   */
  partySize?: PartySizeBucket;
  /**
   * The observer's active Trip Crew id, if the client already knows it. Optional
   * and normally omitted — the server resolves the active crew itself and
   * VALIDATES membership before honouring any value here.
   */
  partyId?: string | null;
  /** Reused across retries of the same logical write. Minted if omitted. */
  idempotencyKey?: string;
}

function buildBody(input: ObservationInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    subjectId: input.subjectId,
    observedAt: input.observedAt ?? new Date().toISOString(),
  };
  if (input.subjectKind) body.subjectKind = input.subjectKind;
  if (input.zoneId !== undefined) body.zoneId = input.zoneId;
  if (input.capturedAt !== undefined) body.capturedAt = input.capturedAt;
  if (input.visibility) body.visibility = input.visibility;
  if (input.presenceLevel) body.presenceLevel = input.presenceLevel;
  if (input.context && input.option) {
    body.context = input.context;
    body.option = input.option;
  } else if (input.claimType && input.value) {
    body.claimType = input.claimType;
    body.value = input.value;
  }
  // Independent-group signal — omitted entirely when unset (server fail-closes).
  if (input.partySize) body.partySize = input.partySize;
  if (input.partyId) body.partyId = input.partyId;
  return body;
}

/** POST /api/v1/intel/observations — the one capture write. */
export async function submitObservation(input: ObservationInput): Promise<CaptureResult> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'not_configured' };
  const key = input.idempotencyKey ?? makeIdempotencyKey();
  try {
    const res = await authedFetch(`${INTEL_BASE}/observations`, {
      method: 'POST',
      headers: { 'Idempotency-Key': key },
      body: JSON.stringify(buildBody(input)),
    });
    if (!res.ok) return { ok: false, ...(await readError(res)) };
    const data = await res.json();
    return { ok: true, observation: data?.observation, deduped: !!data?.deduped };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'network_error' };
  }
}

/** Convenience: a Quick Signal (context + option). */
export function submitQuickSignal(args: {
  subjectId: string;
  context: QuickSignalContext;
  option: string;
  visibility?: Visibility;
  zoneId?: string | null;
  subjectKind?: string;
  /** V1 independent-group signal for label-eligible captures. */
  partySize?: PartySizeBucket;
  partyId?: string | null;
  idempotencyKey?: string;
}): Promise<CaptureResult> {
  return submitObservation(args);
}

/** Convenience: the direct Phase-1 walk-in claim (access.walk_in). */
export function submitWalkIn(args: {
  subjectId: string;
  accepted: boolean;
  visibility?: Visibility;
  /** V1 independent-group signal — walk-in is a label-eligible access signal. */
  partySize?: PartySizeBucket;
  partyId?: string | null;
  idempotencyKey?: string;
}): Promise<CaptureResult> {
  return submitObservation({
    subjectId: args.subjectId,
    claimType: 'access.walk_in',
    value: { accepted: args.accepted },
    visibility: args.visibility,
    partySize: args.partySize,
    partyId: args.partyId,
    idempotencyKey: args.idempotencyKey,
  });
}

/**
 * Convenience: the direct Phase-1 music.current claim (§29 Included). `genre` is a
 * canonical MUSIC_GENRES value — the composer sends no free text, only a genre.
 */
export function submitMusic(args: {
  subjectId: string;
  genre: string;
  visibility?: Visibility;
  zoneId?: string | null;
  /** V1 independent-group signal — music is a label-eligible nightlife signal. */
  partySize?: PartySizeBucket;
  partyId?: string | null;
  idempotencyKey?: string;
}): Promise<CaptureResult> {
  return submitObservation({
    subjectId: args.subjectId,
    claimType: 'music.current',
    value: { genre: args.genre },
    visibility: args.visibility,
    zoneId: args.zoneId,
    partySize: args.partySize,
    partyId: args.partyId,
    idempotencyKey: args.idempotencyKey,
  });
}

// ── Claim lifecycle ───────────────────────────────────────────────────────────
export interface ProposeResult {
  ok: boolean;
  claim?: { id: string; [k: string]: unknown };
  code?: string;
  error?: string;
}

/** POST /observations/:id/claims:propose — observation → candidate claim. */
export async function proposeClaim(observationId: string): Promise<ProposeResult> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'not_configured' };
  try {
    const res = await authedFetch(`${INTEL_BASE}/observations/${observationId}/claims:propose`, { method: 'POST' });
    if (!res.ok) return { ok: false, ...(await readError(res)) };
    const data = await res.json();
    return { ok: true, claim: data?.claim };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'network_error' };
  }
}

/** POST /observations/:id/claims:approve — candidate → active. */
export async function approveClaim(observationId: string, claimId: string): Promise<{ ok: boolean; code?: string; error?: string }> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'not_configured' };
  try {
    const res = await authedFetch(`${INTEL_BASE}/observations/${observationId}/claims:approve`, {
      method: 'POST',
      body: JSON.stringify({ claimId }),
    });
    if (!res.ok) return { ok: false, ...(await readError(res)) };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'network_error' };
  }
}

/** POST /claims/:id/confirm — independent agree / disagree / unsure. */
export async function confirmClaim(
  claimId: string,
  stance: ConfirmStance,
  opts: { observedAt?: string; presenceLevel?: string } = {},
): Promise<{ ok: boolean; deduped?: boolean; code?: string; error?: string }> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'not_configured' };
  try {
    const res = await authedFetch(`${INTEL_BASE}/claims/${claimId}/confirm`, {
      method: 'POST',
      body: JSON.stringify({
        stance,
        observedAt: opts.observedAt ?? new Date().toISOString(),
        ...(opts.presenceLevel ? { presenceLevel: opts.presenceLevel } : {}),
      }),
    });
    if (!res.ok) return { ok: false, ...(await readError(res)) };
    const data = await res.json();
    return { ok: true, deduped: !!data?.deduped };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'network_error' };
  }
}

/** POST /claims/:id/correct — supersede a claim with a new direct observation. */
export async function correctClaim(
  claimId: string,
  args: { subjectId: string; claimType: string; value: Record<string, unknown>; visibility?: Visibility; observedAt?: string; idempotencyKey?: string },
): Promise<CaptureResult> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'not_configured' };
  const key = args.idempotencyKey ?? makeIdempotencyKey('corr');
  try {
    const res = await authedFetch(`${INTEL_BASE}/claims/${claimId}/correct`, {
      method: 'POST',
      headers: { 'Idempotency-Key': key },
      body: JSON.stringify({
        subjectId: args.subjectId,
        claimType: args.claimType,
        value: args.value,
        observedAt: args.observedAt ?? new Date().toISOString(),
        ...(args.visibility ? { visibility: args.visibility } : {}),
      }),
    });
    if (!res.ok) return { ok: false, ...(await readError(res)) };
    const data = await res.json();
    return { ok: true, observation: data?.observation, deduped: !!data?.deduped };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'network_error' };
  }
}
