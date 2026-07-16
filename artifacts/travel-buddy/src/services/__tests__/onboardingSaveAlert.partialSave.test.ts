/**
 * Onboarding save-alert tests — partial save copy
 *
 * The onboarding finish step used to show a fixed generic alert for any
 * save failure, dropping the server's partial-save warning. These tests
 * assert that buildOnboardingSaveAlert surfaces the specific
 * "Some fields couldn't be saved: …" message (and that onboarding.tsx is
 * actually wired through it).
 *
 * Run:
 *   node --import tsx --test src/services/__tests__/onboardingSaveAlert.partialSave.test.ts
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { _setTestAuthToken, updateMyProfile } from '../profile.ts';
import {
  buildOnboardingSaveAlert,
  ONBOARDING_SAVE_ALERT_TITLE,
  ONBOARDING_SAVE_FALLBACK_MESSAGE,
} from '../profileSaveFlow.ts';

const FAKE_TOKEN = 'fake-test-token-onboarding-alert';
const WARNING = "Some fields couldn't be saved: travelPace, budgetStyle";

function mockFetch(status: number, body: unknown): typeof fetch {
  return async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as unknown as Response;
}

let savedFetch: typeof fetch;

beforeEach(() => {
  savedFetch = globalThis.fetch;
  _setTestAuthToken(FAKE_TOKEN);
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  _setTestAuthToken(null);
});

describe('buildOnboardingSaveAlert — partial save copy', () => {
  it('a real partial-save response surfaces the specific warning in the alert', async () => {
    globalThis.fetch = mockFetch(200, {
      id: 'u1',
      displayName: 'Ada',
      unsavedFields: ['travelPace', 'budgetStyle'],
      warning: WARNING,
    });

    const res = await updateMyProfile({ displayName: 'Ada', travelPace: 'slow' });
    assert.equal(res.ok, false);
    const alert = buildOnboardingSaveAlert(res);

    assert.equal(alert.title, ONBOARDING_SAVE_ALERT_TITLE);
    // The alert must name the dropped fields — never only the generic text.
    assert.ok(alert.message.includes(WARNING), `alert message must include the warning; got: ${alert.message}`);
    assert.ok(alert.message.includes('travelPace'));
    assert.ok(alert.message.includes('budgetStyle'));
    assert.notEqual(alert.message, ONBOARDING_SAVE_FALLBACK_MESSAGE);
  });

  it('falls back to the generic copy when the failure carries no message', () => {
    const alert = buildOnboardingSaveAlert({ ok: false });
    assert.equal(alert.title, ONBOARDING_SAVE_ALERT_TITLE);
    assert.equal(alert.message, ONBOARDING_SAVE_FALLBACK_MESSAGE);
  });
});

describe('onboarding screen actually routes through the tested alert builder', () => {
  it('onboarding.tsx imports buildOnboardingSaveAlert from profileSaveFlow', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join('app', '(auth)', 'onboarding.tsx'), 'utf8');
    assert.ok(
      src.includes('buildOnboardingSaveAlert') && src.includes('services/profileSaveFlow'),
      'onboarding.tsx must use buildOnboardingSaveAlert so partial-save warnings are shown',
    );
    assert.ok(
      !src.includes("couldn't be saved right now"),
      'onboarding.tsx must not hardcode the generic alert copy inline',
    );
  });
});
