/**
 * Mock identity verification provider.
 *
 * Drop at: travel-buddy-standalone/server/services/identityVerification/mockProvider.ts
 *
 * Lets the entire verification flow — session creation, redirect, webhook
 * processing, status polling, badge rendering, gating — be built and
 * tested with zero external accounts. Behavior:
 *
 *   * createSession returns a fake redirect URL that the client treats
 *     like a hosted flow (the client can render a "Mock verification"
 *     screen with Approve / Fail buttons in dev builds).
 *   * After MOCK_AUTO_RESOLVE_MS, getSessionStatus resolves according to
 *     the testHint given at creation (default: approve).
 *   * handleWebhook accepts a simple JSON body the dev screen can POST.
 *
 * NEVER register this provider in production. The factory in providers.ts
 * refuses 'mock' when NODE_ENV === 'production'.
 */

import crypto from 'node:crypto';
import type {
  IdentityVerificationProvider,
  VerificationRequest,
  VerificationResult,
  VerificationSession,
  WebhookEvent,
} from './types';

const MOCK_AUTO_RESOLVE_MS = 8_000;

type MockSession = {
  userId: string;
  level: 'id' | 'id_selfie';
  hint: NonNullable<VerificationRequest['testHint']>;
  createdAt: number;
};

// In-memory store: fine for the mock (single dev server process).
const sessions = new Map<string, MockSession>();

function resolve(sessionId: string, s: MockSession): VerificationResult {
  const nowMs = Date.now();
  const elapsed = nowMs - s.createdAt;
  if (elapsed < MOCK_AUTO_RESOLVE_MS) {
    return {
      provider: 'mock',
      providerSessionId: sessionId,
      status: 'processing',
    };
  }
  switch (s.hint) {
    case 'fail_document':
      return {
        provider: 'mock',
        providerSessionId: sessionId,
        status: 'failed',
        failureReason: 'document_invalid',
      };
    case 'fail_selfie':
      return {
        provider: 'mock',
        providerSessionId: sessionId,
        status: 'failed',
        failureReason: 'selfie_mismatch',
      };
    case 'fail_underage':
      return {
        provider: 'mock',
        providerSessionId: sessionId,
        status: 'failed',
        failureReason: 'underage',
        isOver18: false,
      };
    case 'approve':
    default:
      return {
        provider: 'mock',
        providerSessionId: sessionId,
        providerVerificationRef: `mockref_${sessionId}`,
        status: 'verified',
        isOver18: true,
        selfieMatch: s.level === 'id_selfie' ? true : undefined,
        documentCountry: 'PH',
        verifiedAt: new Date(nowMs).toISOString(),
      };
  }
}

export const mockProvider: IdentityVerificationProvider = {
  name: 'mock',

  async createSession(req: VerificationRequest): Promise<VerificationSession> {
    const id = `mock_${crypto.randomUUID()}`;
    sessions.set(id, {
      userId: req.userId,
      level: req.level,
      hint: req.testHint ?? 'approve',
      createdAt: Date.now(),
    });
    return {
      provider: 'mock',
      providerSessionId: id,
      // Client dev screen route; renders Approve / Fail controls.
      redirectUrl: `${req.returnUrl}?mockSession=${id}`,
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    };
  },

  async handleWebhook(event: WebhookEvent): Promise<VerificationResult | null> {
    // Mock webhook: JSON body { sessionId, outcome? } from the dev screen.
    let body: { sessionId?: string; outcome?: MockSession['hint'] };
    try {
      body = JSON.parse(event.rawBody);
    } catch {
      return null;
    }
    if (!body.sessionId) return null;
    const s = sessions.get(body.sessionId);
    if (!s) return null;
    if (body.outcome) s.hint = body.outcome;
    // Force immediate resolution on webhook.
    s.createdAt = 0;
    return resolve(body.sessionId, s);
  },

  async getSessionStatus(providerSessionId: string): Promise<VerificationResult> {
    const s = sessions.get(providerSessionId);
    if (!s) {
      return {
        provider: 'mock',
        providerSessionId,
        status: 'expired',
      };
    }
    return resolve(providerSessionId, s);
  },

  async requestProviderDeletion(): Promise<void> {
    // Nothing external to delete.
  },
};
