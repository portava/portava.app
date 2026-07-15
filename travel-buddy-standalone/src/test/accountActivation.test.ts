/**
 * Account activation / deactivation flow tests
 *
 * Tests the machine module (app/settings/settings.machine.ts) that
 * app/settings/index.tsx calls directly, so these assertions cover the
 * actual component code path rather than a mirrored helper.
 *
 * Also tests reactivateAccount / deactivateAccount at the service layer so
 * API error kinds are validated end-to-end.
 *
 * Scenarios:
 *   Service layer — reactivateAccount:
 *     1. 200 success → ok: true
 *     2. 403 forbidden → ok: false, errorKind: 'forbidden' (admin-suspended path)
 *     3. Network throw → ok: false, errorKind: 'network_unreachable'
 *     4. 500 server error → ok: false with errorKind set
 *
 *   Service layer — deactivateAccount:
 *     5. 200 success → ok: true
 *     6. 500 server error → ok: false with errorKind set
 *     7. Network throw → ok: false, errorKind: 'network_unreachable'
 *
 *   settings.machine — resolveAccountButton (exact function used in JSX):
 *     8.  'deactivated'  → 'reactivate'  (Reactivate button shown)
 *     9.  'active'       → 'deactivate'  (Deactivate button shown)
 *     10. null           → 'deactivate'  (not yet loaded → Deactivate shown)
 *     11. other status   → 'deactivate'
 *     12. deactivated status → never 'deactivate' (both buttons invisible at once)
 *
 *   settings.machine — applyReactivateResult (exact function used in handleReactivate):
 *     13. ok: true  → { type: 'success', nextStatus: 'active' }
 *     14. ok: false, errorKind: 'forbidden' → error with support message
 *     15. ok: false, network error  → error with fallback message
 *     16. rapid double-tap simulation: fail then succeed → final status is 'active'
 *
 * Run:
 *   cd travel-buddy-standalone
 *   node --import tsx --test src/test/accountActivation.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  _setTestAuthToken,
  reactivateAccount,
  deactivateAccount,
} from '../services/profile.ts';
import {
  resolveAccountButton,
  applyReactivateResult,
} from '../../app/settings/settings.machine.ts';

const FAKE_TOKEN = 'fake-test-token-account-activation';

function mockFetch(status: number, body: unknown): typeof fetch {
  return async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as unknown as Response;
}

// ── Suite 1: reactivateAccount service layer ───────────────────────────────────

describe('reactivateAccount — service layer', () => {
  let _savedFetch: typeof fetch;

  before(() => {
    _savedFetch = globalThis.fetch;
    _setTestAuthToken(FAKE_TOKEN);
    process.env.EXPO_PUBLIC_API_BASE_URL = 'http://localhost';
  });

  after(() => {
    globalThis.fetch = _savedFetch;
    _setTestAuthToken(null);
    delete process.env.EXPO_PUBLIC_API_BASE_URL;
  });

  it('returns { ok: true } on 200 success', async () => {
    globalThis.fetch = mockFetch(200, { reactivated: true });
    const res = await reactivateAccount();
    assert.equal(res.ok, true, 'expected ok=true on 200');
  });

  it('returns { ok: false, errorKind: "forbidden" } on 403 — admin-suspended path', async () => {
    globalThis.fetch = mockFetch(403, { error: 'forbidden', message: 'Admin-suspended accounts cannot self-reactivate.' });
    const res = await reactivateAccount();
    assert.equal(res.ok, false, 'expected ok=false on 403');
    assert.equal(res.errorKind, 'forbidden',
      'errorKind must be "forbidden" so applyReactivateResult routes to the support message');
  });

  it('returns { ok: false, errorKind: "network_unreachable" } on network throw', async () => {
    globalThis.fetch = async () => { throw new Error('Network request failed'); };
    const res = await reactivateAccount();
    assert.equal(res.ok, false, 'expected ok=false on network throw');
    assert.equal(res.errorKind, 'network_unreachable');
  });

  it('returns { ok: false } on 500 with errorKind set', async () => {
    globalThis.fetch = mockFetch(500, { error: 'db_error', message: 'Internal server error' });
    const res = await reactivateAccount();
    assert.equal(res.ok, false, 'expected ok=false on 500');
    assert.ok(res.errorKind, 'expected errorKind to be set for UI error handling');
  });
});

// ── Suite 2: deactivateAccount service layer ──────────────────────────────────

describe('deactivateAccount — service layer', () => {
  let _savedFetch: typeof fetch;

  before(() => {
    _savedFetch = globalThis.fetch;
    _setTestAuthToken(FAKE_TOKEN);
    process.env.EXPO_PUBLIC_API_BASE_URL = 'http://localhost';
  });

  after(() => {
    globalThis.fetch = _savedFetch;
    _setTestAuthToken(null);
    delete process.env.EXPO_PUBLIC_API_BASE_URL;
  });

  it('returns { ok: true } on 200 success', async () => {
    globalThis.fetch = mockFetch(200, { deactivated: true });
    const res = await deactivateAccount();
    assert.equal(res.ok, true, 'expected ok=true on 200');
  });

  it('returns { ok: false } on 500 error', async () => {
    globalThis.fetch = mockFetch(500, { error: 'db_error', message: 'Internal server error' });
    const res = await deactivateAccount();
    assert.equal(res.ok, false, 'expected ok=false on 500');
    assert.ok(res.errorKind, 'expected errorKind set so Alert message is surfaced to user');
  });

  it('returns { ok: false, errorKind: "network_unreachable" } on network throw', async () => {
    globalThis.fetch = async () => { throw new Error('Network request failed'); };
    const res = await deactivateAccount();
    assert.equal(res.ok, false, 'expected ok=false on network throw');
    assert.equal(res.errorKind, 'network_unreachable');
  });
});

// ── Suite 3: resolveAccountButton — the exact function used in settings/index.tsx JSX ──

describe('resolveAccountButton (settings.machine) — button visibility', () => {
  it("returns 'reactivate' when accountStatus === 'deactivated'", () => {
    assert.equal(resolveAccountButton('deactivated'), 'reactivate');
  });

  it("returns 'deactivate' when accountStatus === 'active'", () => {
    assert.equal(resolveAccountButton('active'), 'deactivate');
  });

  it("returns 'deactivate' when accountStatus === null (not yet loaded)", () => {
    assert.equal(resolveAccountButton(null), 'deactivate');
  });

  it("returns 'deactivate' for any non-deactivated status (e.g. 'suspended')", () => {
    assert.equal(resolveAccountButton('suspended'), 'deactivate');
  });

  it("Deactivate button is hidden when deactivated — both buttons are never visible simultaneously", () => {
    const mode = resolveAccountButton('deactivated');
    assert.notEqual(mode, 'deactivate',
      'Deactivate must not be shown when account is already deactivated');
  });
});

// ── Suite 4: applyReactivateResult — the exact function used in handleReactivate ──

describe('applyReactivateResult (settings.machine) — handleReactivate state transitions', () => {
  it("returns { type: 'success', nextStatus: 'active' } on ok: true", () => {
    const directive = applyReactivateResult({ ok: true });
    assert.equal(directive.type, 'success');
    if (directive.type === 'success') {
      assert.equal(directive.nextStatus, 'active',
        'component calls setAccountStatus(nextStatus) — must be "active" so Reactivate button disappears');
    }
  });

  it("returns error with support message on forbidden (admin-suspended)", () => {
    const directive = applyReactivateResult({ ok: false, errorKind: 'forbidden' });
    assert.equal(directive.type, 'error');
    if (directive.type === 'error') {
      assert.ok(
        directive.message.toLowerCase().includes('support') || directive.message.toLowerCase().includes('contact'),
        `expected support-contact message for forbidden; got: "${directive.message}"`,
      );
    }
  });

  it("returns error with fallback message on network error", () => {
    const directive = applyReactivateResult({ ok: false, errorKind: 'network_unreachable', message: 'Network unavailable' });
    assert.equal(directive.type, 'error');
    if (directive.type === 'error') {
      assert.ok(directive.message.length > 0, 'expected a non-empty error message');
    }
  });

  it("rapid double-tap simulation: fail then succeed → final status is 'active'", () => {
    let accountStatus: string | null = 'deactivated';

    const failDirective = applyReactivateResult({ ok: false, errorKind: 'network_unreachable', message: 'timeout' });
    if (failDirective.type === 'success') accountStatus = failDirective.nextStatus;
    assert.equal(accountStatus, 'deactivated', 'status stays deactivated after first tap fails');
    assert.equal(resolveAccountButton(accountStatus), 'reactivate', 'Reactivate button still shown after failure');

    const successDirective = applyReactivateResult({ ok: true });
    if (successDirective.type === 'success') accountStatus = successDirective.nextStatus;
    assert.equal(accountStatus, 'active', 'status becomes active after second tap succeeds');
    assert.equal(resolveAccountButton(accountStatus), 'deactivate', 'Deactivate button now shown after reactivation');
  });
});
