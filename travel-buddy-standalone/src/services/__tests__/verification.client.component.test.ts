/**
 * Verification client service tests — Phase V-2.
 *
 * Tests the API-client wrapper without hitting a real server.
 * fetch is mocked at module level using jest.fn().
 *
 * Run as part of: pnpm test:component
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// Import the module under test with static imports (dynamic import() fails under Jest/babel)
import { createVerificationSession, getVerificationStatus, triggerMockWebhook } from '../verification.ts';

// ── Mock supabase session ─────────────────────────────────────────────────────
// NOTE: Intentionally minimal — only `supabase.auth.getSession` is called by the
// verification service. All other supabase exports are unused in these tests.
jest.mock('../../lib/supabase.ts', () => ({
  supabase: {
    auth: {
      getSession: () => Promise.resolve({
        data: { session: { access_token: 'test-token' } },
      }),
    },
  },
}));

// ── Mock fetch globally ───────────────────────────────────────────────────────
const mockFetch = jest.fn<typeof fetch>();
global.fetch = mockFetch as any;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('createVerificationSession', () => {
  beforeEach(() => { mockFetch.mockReset(); });

  it('returns ok result with redirectUrl on 201', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: () => Promise.resolve({
        redirectUrl: 'portava://app/verification/mock-complete?mockSession=abc',
        providerSessionId: 'abc',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      }),
    } as any);
    const res = await createVerificationSession('id');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.result.redirectUrl).toContain('mockSession=');
      expect(res.result.providerSessionId).toBe('abc');
    }
  });

  it('returns ok=false on 429 rate-limit response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false, status: 429,
      json: () => Promise.resolve({ message: 'Too many verification attempts.' }),
    } as any);
    const res = await createVerificationSession('id');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain('Too many');
    }
  });

  it('returns ok=false on network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network fail'));
    const res = await createVerificationSession('id');
    expect(res.ok).toBe(false);
  });

  it('maps existingSession flag when server returns one', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: () => Promise.resolve({
        redirectUrl: 'portava://app/verification/mock-complete?mockSession=existing-sess',
        providerSessionId: 'existing-sess',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        existingSession: true,
      }),
    } as any);
    const res = await createVerificationSession('id');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.result.existingSession).toBe(true);
    }
  });
});

describe('getVerificationStatus', () => {
  beforeEach(() => { mockFetch.mockReset(); });

  it('returns verificationLevel=none when no row', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: () => Promise.resolve({
        verificationRow: null,
        verificationLevel: 'none',
        verifiedAt: null,
      }),
    } as any);
    const res = await getVerificationStatus();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.result.verificationLevel).toBe('none');
      expect(res.result.verificationRow).toBeNull();
    }
  });

  it('maps snake_case row to camelCase VerificationRow', async () => {
    const now = new Date().toISOString();
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: () => Promise.resolve({
        verificationRow: {
          id: 'row-1', provider: 'mock',
          provider_session_id: 'sess-1',
          status: 'verified',
          failure_reason: null,
          is_over_18: true,
          selfie_match: null,
          document_country: 'US',
          verified_at: now,
          expires_at: null,
          created_at: now,
          updated_at: now,
        },
        verificationLevel: 'id_verified',
        verifiedAt: now,
      }),
    } as any);
    const res = await getVerificationStatus();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.result.verificationLevel).toBe('id_verified');
      expect(res.result.verificationRow?.status).toBe('verified');
      expect(res.result.verificationRow?.providerSessionId).toBe('sess-1');
      expect(res.result.verificationRow?.isOver18).toBe(true);
      expect(res.result.verificationRow?.documentCountry).toBe('US');
    }
  });

  it('returns ok=false on 401', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false, status: 401,
      json: () => Promise.resolve({ message: 'Unauthorized' }),
    } as any);
    const res = await getVerificationStatus();
    expect(res.ok).toBe(false);
  });
});

describe('triggerMockWebhook', () => {
  beforeEach(() => { mockFetch.mockReset(); });

  it('returns ok=true on 200', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200 } as any);
    const res = await triggerMockWebhook('sess-1', 'approve');
    expect(res.ok).toBe(true);
  });

  it('returns ok=false on non-200', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400 } as any);
    const res = await triggerMockWebhook('sess-1', 'approve');
    expect(res.ok).toBe(false);
  });
});
