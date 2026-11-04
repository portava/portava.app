/**
 * buildDiagnostics — the sign-in screen's test-build line names the backend.
 *
 * WHAT WOULD TURN THIS RED: show the line for a store build and the first case
 * fails; name the backend by URL instead of by known deployment and the
 * production case fails; say nothing on a test build when a Google browser
 * session closes without returning, or say it on a store build, and the
 * browser-closed cases fail.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isPersonalTeamBuildFrom, testBuildBrowserSignInClosed, testBuildDiagnostics } from '../buildDiagnostics.ts';
import { KNOWN_DEPLOYMENTS } from '../deploymentConsistency.ts';

const production = KNOWN_DEPLOYMENTS.find((d) => d.name === 'production')!;
const beta = KNOWN_DEPLOYMENTS.find((d) => d.name === 'beta')!;

describe('testBuildDiagnostics', () => {
  it('a store build shows nothing, whatever it was built against', () => {
    assert.equal(testBuildDiagnostics({ personalTeam: false, supabaseUrl: `https://${production.supabaseRef}.supabase.co`, apiBaseUrl: 'https://rumazi.com', version: '1.0.0' }), null);
  });

  it('a Personal Team build against production says so, by deployment name and project ref', () => {
    assert.equal(
      testBuildDiagnostics({ personalTeam: true, supabaseUrl: `https://${production.supabaseRef}.supabase.co`, apiBaseUrl: 'https://rumazi.com/', version: '1.4.2' }),
      `Test build v1.4.2 · backend production (${production.supabaseRef}) · API rumazi.com`,
    );
  });

  it('a Personal Team build against beta says beta', () => {
    assert.equal(
      testBuildDiagnostics({ personalTeam: true, supabaseUrl: `https://${beta.supabaseRef}.supabase.co`, apiBaseUrl: 'https://portava-beta.replit.app' }),
      `Test build · backend beta (${beta.supabaseRef}) · API portava-beta.replit.app`,
    );
  });

  it('an unknown project and a missing API address are named as such, not hidden', () => {
    assert.equal(
      testBuildDiagnostics({ personalTeam: true, supabaseUrl: 'https://zzzzzzzzzzzzzzzzzzzz.supabase.co', apiBaseUrl: '' }),
      'Test build · backend unknown project at zzzzzzzzzzzzzzzzzzzz.supabase.co · API not configured',
    );
    assert.equal(
      testBuildDiagnostics({ personalTeam: true, supabaseUrl: '', apiBaseUrl: 'not a url' }),
      'Test build · backend not configured · API not configured',
    );
  });
});

describe('isPersonalTeamBuildFrom', () => {
  it('only an explicit true marks the test build; absent, null, a string or false do not', () => {
    assert.equal(isPersonalTeamBuildFrom({ personalTeam: true }), true);
    assert.equal(isPersonalTeamBuildFrom({ personalTeam: false }), false);
    assert.equal(isPersonalTeamBuildFrom({ personalTeam: 'true' }), false);
    assert.equal(isPersonalTeamBuildFrom({}), false);
    assert.equal(isPersonalTeamBuildFrom(undefined), false);
    assert.equal(isPersonalTeamBuildFrom(null), false);
  });
});

describe('testBuildBrowserSignInClosed', () => {
  const redirectTo = 'travelbuddy://auth/callback';

  it('a store build stays silent: a cancel is the person\'s own choice', () => {
    assert.equal(testBuildBrowserSignInClosed({ personalTeam: false, provider: 'Google', outcome: 'cancel', redirectTo }), null);
  });

  it('a Personal Team build names the provider, the browser result and the return address the backend must allow', () => {
    assert.equal(
      testBuildBrowserSignInClosed({ personalTeam: true, provider: 'Google', outcome: 'cancel', redirectTo }),
      'Google sign-in closed without returning to the app (browser result: cancel). ' +
        "If the sheet showed the website instead of coming back here, the backend's redirect allow-list is missing travelbuddy://auth/callback.",
    );
    assert.match(testBuildBrowserSignInClosed({ personalTeam: true, provider: 'Google', outcome: 'dismiss', redirectTo })!, /browser result: dismiss\)/);
  });

  it('a blank browser result reads as cancel rather than as an empty parenthesis', () => {
    assert.match(testBuildBrowserSignInClosed({ personalTeam: true, provider: 'Google', outcome: '  ', redirectTo })!, /browser result: cancel\)/);
  });
});
