/**
 * recoveryLink — only the password-reset route feeds tokens to supabase-js.
 *
 * WHAT WOULD TURN THIS RED: drop the route check in recoveryLinkAction and the
 * Google callback and invite cases fail; accept an implicit fragment without
 * type=recovery and that case fails.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { recoveryLinkAction, routeOf, RECOVERY_ROUTE } from '../recoveryLink.ts';

describe('routeOf', () => {
  it('reads the app route out of each link form the app receives', () => {
    assert.equal(routeOf('travelbuddy://update-password?code=abc'), 'update-password');
    assert.equal(routeOf('travelbuddy://auth/callback?code=abc'), 'auth/callback');
    assert.equal(routeOf('https://rumazi.com/update-password#access_token=t'), 'update-password');
    assert.equal(routeOf('https://rumazi.com/invite/XYZ?code=1'), 'invite/xyz');
    assert.equal(routeOf('exp://127.0.0.1:8081/--/update-password?code=abc'), 'update-password');
    assert.equal(routeOf('travelbuddy://'), '');
    assert.equal(routeOf('not a url'), null);
  });
});

describe('recoveryLinkAction', () => {
  it('a PKCE recovery link carries its code, on the scheme, the website and the dev client', () => {
    assert.deepEqual(recoveryLinkAction(`travelbuddy://${RECOVERY_ROUTE}?code=abc-123`), { kind: 'pkce', code: 'abc-123' });
    assert.deepEqual(recoveryLinkAction('https://rumazi.com/update-password?code=abc'), { kind: 'pkce', code: 'abc' });
    assert.deepEqual(recoveryLinkAction('exp://10.0.0.2:8081/--/update-password?code=abc'), { kind: 'pkce', code: 'abc' });
  });

  it('an implicit recovery link carries both tokens, and only with type=recovery', () => {
    assert.deepEqual(
      recoveryLinkAction('travelbuddy://update-password#access_token=AT&refresh_token=RT&type=recovery&expires_in=3600'),
      { kind: 'implicit', accessToken: 'AT', refreshToken: 'RT' },
    );
    assert.equal(recoveryLinkAction('travelbuddy://update-password#access_token=AT&refresh_token=RT&type=magiclink'), null);
    assert.equal(recoveryLinkAction('travelbuddy://update-password#access_token=AT&type=recovery'), null, 'no refresh token');
  });

  it('the Google sign-in callback is NOT a recovery link, whatever it carries', () => {
    assert.equal(recoveryLinkAction('travelbuddy://auth/callback?code=pkce-code'), null);
    assert.equal(recoveryLinkAction('travelbuddy://auth/callback#access_token=AT&refresh_token=RT&type=recovery'), null);
  });

  it('other links that happen to carry a code are left alone', () => {
    assert.equal(recoveryLinkAction('https://rumazi.com/invite?code=FRIEND42'), null);
    assert.equal(recoveryLinkAction('travelbuddy://join?code=ABC'), null);
    assert.equal(recoveryLinkAction('travelbuddy://update-password-ish?code=ABC'), null);
  });

  it('a recovery route with nothing usable, or garbage, is null rather than a throw', () => {
    assert.equal(recoveryLinkAction('travelbuddy://update-password'), null);
    assert.equal(recoveryLinkAction('travelbuddy://update-password?error=access_denied&error_description=Email+link+is+invalid'), null);
    assert.equal(recoveryLinkAction(''), null);
    assert.equal(recoveryLinkAction('::::'), null);
  });
});
