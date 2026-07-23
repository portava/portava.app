/**
 * Verification API client — Phase V-2 (client side).
 *
 * Talks to the server routes added in Phase V-1:
 *   POST /api/verification/session
 *   POST /api/verification/webhook   (dev-only mock trigger)
 *   GET  /api/verification/status
 */

import { supabase } from '../lib/supabase.ts';

const API_BASE = (process.env['EXPO_PUBLIC_API_BASE_URL'] ?? '').replace(/\/$/, '');

// ── Types ─────────────────────────────────────────────────────────────────────

export type VerificationLevel = 'none' | 'id_verified' | 'id_selfie_verified';

export type NormalizedVerificationStatus =
  | 'created' | 'pending' | 'processing' | 'verified' | 'failed' | 'expired' | 'canceled';

export type NormalizedFailureReason =
  | 'document_invalid' | 'selfie_mismatch' | 'underage'
  | 'abandoned' | 'provider_error' | 'other';

export type TestHint = 'approve' | 'fail_document' | 'fail_selfie' | 'fail_underage';

export interface VerificationRow {
  id: string;
  provider: string;
  providerSessionId: string;
  status: NormalizedVerificationStatus;
  failureReason: NormalizedFailureReason | null;
  isOver18: boolean | null;
  selfieMatch: boolean | null;
  documentCountry: string | null;
  verifiedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSessionResult {
  ok: true;
  redirectUrl: string;
  providerSessionId: string;
  expiresAt: string;
  /** True when an existing active session was returned instead of creating a new one. */
  existingSession?: boolean;
}

export interface VerificationStatusResult {
  ok: true;
  verificationRow: VerificationRow | null;
  verificationLevel: VerificationLevel;
  verifiedAt: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function authHeader(): Promise<string | null> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ? `Bearer ${session.access_token}` : null;
}

function mapRow(raw: any): VerificationRow {
  return {
    id:                raw.id,
    provider:          raw.provider,
    providerSessionId: raw.provider_session_id,
    status:            raw.status,
    failureReason:     raw.failure_reason ?? null,
    isOver18:          raw.is_over_18 ?? null,
    selfieMatch:       raw.selfie_match ?? null,
    documentCountry:   raw.document_country ?? null,
    verifiedAt:        raw.verified_at ?? null,
    expiresAt:         raw.expires_at ?? null,
    createdAt:         raw.created_at,
    updatedAt:         raw.updated_at,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Create a verification session. Returns a redirectUrl the client should open
 * (via Linking.openURL for mock deep links, or WebBrowser for real providers).
 *
 * @param level     'id' for document-only, 'id_selfie' for ID + selfie liveness.
 * @param testHint  Dev-only: force a specific outcome on the mock provider.
 */
export async function createVerificationSession(
  level: 'id' | 'id_selfie',
  testHint?: TestHint,
): Promise<{ ok: true; result: CreateSessionResult } | { ok: false; error: string }> {
  const token = await authHeader();
  if (!token) return { ok: false, error: 'Not authenticated' };

  const body: Record<string, unknown> = { level };
  if (testHint && __DEV__) body.testHint = testHint;

  try {
    const res = await fetch(`${API_BASE}/api/verification/session`, {
      method: 'POST',
      headers: { 'Authorization': token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) return { ok: false, error: json?.message ?? 'Server error' };
    return {
      ok: true,
      result: {
        ok: true,
        redirectUrl:       json.redirectUrl,
        providerSessionId: json.providerSessionId,
        expiresAt:         json.expiresAt,
        existingSession:   json.existingSession ?? false,
      },
    };
  } catch (e: any) {
    return { ok: false, error: e.message ?? 'Network error' };
  }
}

/**
 * Get the caller's current verification status.
 * Call this on mount + every 3 s while status is 'pending' or 'processing'.
 */
export async function getVerificationStatus(): Promise<
  { ok: true; result: VerificationStatusResult } | { ok: false; error: string }
> {
  const token = await authHeader();
  if (!token) return { ok: false, error: 'Not authenticated' };

  try {
    const res = await fetch(`${API_BASE}/api/verification/status`, {
      headers: { 'Authorization': token },
    });
    const json = await res.json();
    if (!res.ok) return { ok: false, error: json?.message ?? 'Server error' };
    return {
      ok: true,
      result: {
        ok: true,
        verificationRow:   json.verificationRow ? mapRow(json.verificationRow) : null,
        verificationLevel: json.verificationLevel ?? 'none',
        verifiedAt:        json.verifiedAt ?? null,
      },
    };
  } catch (e: any) {
    return { ok: false, error: e.message ?? 'Network error' };
  }
}

/**
 * DEV ONLY — trigger the mock webhook with a chosen outcome.
 * Should only be called from the mock-complete screen (gated by __DEV__).
 *
 * @param sessionId  The providerSessionId from createVerificationSession.
 * @param outcome    Which mock result to force.
 */
export async function triggerMockWebhook(
  sessionId: string,
  outcome: TestHint,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${API_BASE}/api/verification/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, outcome }),
    });
    return { ok: res.ok };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}
