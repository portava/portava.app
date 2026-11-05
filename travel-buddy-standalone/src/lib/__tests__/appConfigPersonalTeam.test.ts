/**
 * PORTAVA_PERSONAL_TEAM=1 — the app.config.ts switch for a local Xcode build signed with a free Apple ID.
 *
 * A Personal Team cannot sign Sign in with Apple, associated domains or push notifications, so the switch
 * must remove all three from the generated iOS project, and must change NOTHING when it is off (store builds).
 * `npx expo prebuild --platform ios --no-install` with and without the variable was run on 2026-11-04 and
 * produced an empty entitlements dict vs. the three keys; this pins the config-level half of that.
 *
 * Run: node --import tsx --test src/lib/__tests__/appConfigPersonalTeam.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ExpoConfig } from 'expo/config';
import appConfig, { isPersonalTeamBuild, withPersonalTeam, PERSONAL_TEAM_ENTITLEMENTS_DROPPED } from '../../../app.config.ts';

const base = (): ExpoConfig => ({
  name: 'Portava',
  slug: 'travel-buddy',
  ios: { bundleIdentifier: 'com.passporttravelbuddy.app', associatedDomains: ['applinks:rumazi.com'] },
  plugins: ['expo-router', ['expo-location', { isIosBackgroundLocationEnabled: true }], 'expo-apple-authentication', '@sentry/react-native'],
});

async function runEntitlementsMod(config: ExpoConfig, modResults: Record<string, unknown>): Promise<Record<string, unknown>> {
  const mod = (config as any).mods?.ios?.entitlements;
  assert.equal(typeof mod, 'function', 'the switch registers an ios.entitlements mod');
  const out = await mod({
    ...config,
    modRequest: { projectRoot: '/', platformProjectRoot: '/ios', projectName: 'Portava', modName: 'entitlements', platform: 'ios', introspect: true },
    modResults: { ...modResults },
  });
  return out.modResults;
}

describe('isPersonalTeamBuild', () => {
  it('reads PORTAVA_PERSONAL_TEAM as 1 / true / yes and nothing else', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', ' 1 ']) assert.equal(isPersonalTeamBuild({ PORTAVA_PERSONAL_TEAM: v }), true, v);
    for (const v of ['', '0', 'false', 'no', 'eas', undefined]) assert.equal(isPersonalTeamBuild({ PORTAVA_PERSONAL_TEAM: v }), false, String(v));
  });
});

describe('withPersonalTeam', () => {
  it('drops associatedDomains, the Apple sign-in plugin and usesAppleSignIn, records extra.signInWithApple=false, keeps everything else', () => {
    const out = withPersonalTeam({ ...base(), extra: { eas: { projectId: 'keep' } } });
    assert.equal(out.ios?.associatedDomains, undefined);
    assert.equal(out.ios?.usesAppleSignIn, false);
    assert.equal(out.extra?.signInWithApple, false, 'src/lib/buildCapabilities.ts hides the Apple button on this');
    assert.equal(out.extra?.personalTeam, true, 'src/lib/buildCapabilities.ts shows the test-build diagnostics line on this');
    assert.deepEqual(out.extra?.eas, { projectId: 'keep' });
    assert.equal(out.ios?.bundleIdentifier, 'com.passporttravelbuddy.app');
    const names = (out.plugins ?? []).map((p) => (Array.isArray(p) ? p[0] : p));
    assert.deepEqual(names, ['expo-router', 'expo-location', '@sentry/react-native']);
  });

  it('its entitlements mod deletes the three Personal-Team-unsignable keys and nothing else', async () => {
    const out = withPersonalTeam(base());
    const results = await runEntitlementsMod(out, {
      'aps-environment': 'development',
      'com.apple.developer.applesignin': ['Default'],
      'com.apple.developer.associated-domains': ['applinks:rumazi.com'],
      'com.apple.security.application-groups': ['group.keep'],
    });
    for (const key of PERSONAL_TEAM_ENTITLEMENTS_DROPPED) assert.ok(!(key in results), key);
    assert.deepEqual(results['com.apple.security.application-groups'], ['group.keep']);
  });
});

describe('app.config.ts default export', () => {
  it('with the switch OFF the config is untouched: domains, plugins and no entitlements mod (store builds)', () => {
    const saved = process.env.PORTAVA_PERSONAL_TEAM;
    delete process.env.PORTAVA_PERSONAL_TEAM;
    try {
      const out = appConfig({ config: base(), projectRoot: '/', staticConfigPath: null, packageJsonPath: null });
      assert.deepEqual(out.ios?.associatedDomains, ['applinks:rumazi.com']);
      assert.ok((out.plugins ?? []).includes('expo-apple-authentication'));
      assert.equal((out as any).mods, undefined);
      assert.ok(!('signInWithApple' in (out.extra ?? {})), 'a store build leaves the key absent (reads as capable)');
      assert.ok(!('personalTeam' in (out.extra ?? {})), 'a store build never shows the diagnostics line');
    } finally {
      if (saved === undefined) delete process.env.PORTAVA_PERSONAL_TEAM; else process.env.PORTAVA_PERSONAL_TEAM = saved;
    }
  });

  it('with the switch ON the default export applies withPersonalTeam', () => {
    const saved = process.env.PORTAVA_PERSONAL_TEAM;
    process.env.PORTAVA_PERSONAL_TEAM = '1';
    try {
      const out = appConfig({ config: base(), projectRoot: '/', staticConfigPath: null, packageJsonPath: null });
      assert.equal(out.ios?.associatedDomains, undefined);
      assert.ok(!(out.plugins ?? []).includes('expo-apple-authentication'));
      assert.equal(typeof (out as any).mods?.ios?.entitlements, 'function');
    } finally {
      if (saved === undefined) delete process.env.PORTAVA_PERSONAL_TEAM; else process.env.PORTAVA_PERSONAL_TEAM = saved;
    }
  });
});
