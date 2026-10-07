/**
 * eas.json `beta` build profile — the private-beta binary can never be built
 * against PRODUCTION.
 *
 * The profile pins the three public URLs the app inlines at build time
 * (EXPO_PUBLIC_SUPABASE_URL, EXPO_PUBLIC_API_BASE_URL, EXPO_PUBLIC_WEB_ORIGIN)
 * to portava-beta. eas.json's build-profile `env` outranks EAS environment
 * variables of the same name — documented for EAS Workflows build jobs
 * (https://docs.expo.dev/eas/workflows/environment/, read 2026-10-06); the
 * runbook has the owner confirm it in the first beta build's log. Because that
 * precedence is not documented for a plain `eas build`, the profile also
 * carries the beta project's PUBLISHABLE key (public by design, as .replit
 * commits production's) and EXPO_PUBLIC_DEPLOYMENT_ENV=beta, so the build needs
 * nothing from an EAS environment, and the app refuses to start on a
 * half-overridden build (src/lib/deploymentConsistency.ts; docs/eas-runbook.md
 * § "Private beta build").
 *
 * Run: node --import tsx/esm --test src/constants/__tests__/easBetaProfile.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const eas = JSON.parse(readFileSync(pathResolve(__dir, '../../../eas.json'), 'utf8')) as {
  build: Record<string, { distribution?: string; environment?: string; env?: Record<string, string>; [k: string]: unknown }>;
};

const PRODUCTION_REF = 'ajrurzioarfkagpuxfnb';
const PRODUCTION_ORIGIN = 'portava.replit.app';
const BETA_SUPABASE_URL = 'https://emfpckykpzfturllshly.supabase.co';
const BETA_ORIGIN = 'https://portava-beta.replit.app';

describe('eas.json beta profile', () => {
  const beta = eas.build.beta;

  it('exists and is internal distribution', () => {
    assert.ok(beta, 'build.beta is missing');
    assert.equal(beta.distribution, 'internal');
  });

  it('pins the inlined URLs to portava-beta', () => {
    assert.equal(beta.env?.EXPO_PUBLIC_SUPABASE_URL, BETA_SUPABASE_URL);
    assert.equal(beta.env?.EXPO_PUBLIC_API_BASE_URL, BETA_ORIGIN);
    assert.equal(beta.env?.EXPO_PUBLIC_WEB_ORIGIN, BETA_ORIGIN);
  });

  it("never names production's Supabase ref or production's origin", () => {
    const text = JSON.stringify(beta);
    assert.ok(!text.includes(PRODUCTION_REF), 'the beta profile names production');
    assert.ok(!text.includes(PRODUCTION_ORIGIN), 'the beta profile names portava.replit.app');
  });

  it('carries every inlined value itself — URLs, the deployment marker and beta\'s PUBLISHABLE key — so no EAS environment has to', () => {
    // The `preview` EAS environment is shared with the production-targeting `preview` profile, and Expo does not
    // document which side wins for a plain `eas build`. So the profile names every EXPO_PUBLIC_* the app needs
    // itself, and the app refuses to start if the database and API disagree (src/lib/deploymentConsistency.ts).
    assert.equal(beta.env?.EXPO_PUBLIC_DEPLOYMENT_ENV, 'beta');
    const key = beta.env?.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';
    assert.match(key, /^sb_publishable_[A-Za-z0-9_-]+$/, 'only a PUBLISHABLE key may be in the file');
    assert.ok(!/eyJ[A-Za-z0-9_-]{10,}|sb_secret_|service_role/.test(JSON.stringify(beta)), 'no JWT anon key, secret key or service-role key');
    // Not production's publishable key (.replit [userenv.shared] commits production's).
    const replit = readFileSync(pathResolve(__dir, '../../../../.replit'), 'utf8');
    const prodKey = /EXPO_PUBLIC_SUPABASE_ANON_KEY\s*=\s*"([^"]+)"/.exec(replit)?.[1];
    assert.ok(prodKey && prodKey.startsWith('sb_publishable_'), 'could not read production\'s publishable key from .replit');
    assert.notEqual(key, prodKey, 'the beta profile carries PRODUCTION\'s publishable key');
  });

  // lane BETA2 (2026-10-07): the store-distribution twin for TestFlight / Play internal testing.
  describe('beta-store (TestFlight internal testing / Google Play internal track)', () => {
    const store = eas.build['beta-store'];
    const submit = (eas as unknown as { submit?: Record<string, { android?: { track?: string }; ios?: Record<string, unknown> }> }).submit ?? {};

    it('carries EXACTLY the beta profile\'s inlined values (no reliance on how `extends` merges env)', () => {
      assert.ok(store, 'build.beta-store is missing');
      assert.equal(store.extends, undefined, 'spelled out, not extended: Expo does not document env merging under extends');
      assert.deepEqual(store.env, beta.env);
      assert.equal(store.environment, beta.environment);
    });

    it('is a store build, versioned like production', () => {
      assert.equal(store.distribution, 'store');
      assert.equal(store.autoIncrement, true);
    });

    it("never names production's Supabase ref or production's origin", () => {
      const text = JSON.stringify(store);
      assert.ok(!text.includes(PRODUCTION_REF) && !text.includes(PRODUCTION_ORIGIN));
    });

    it('submits to testing tracks only: Android internal; nothing that targets a public release', () => {
      assert.equal(submit['beta-store']?.android?.track, 'internal');
      assert.doesNotMatch(JSON.stringify(submit['beta-store']), /"production"|"beta"\s*:|"alpha"|releaseStatus/);
    });
  });
});
