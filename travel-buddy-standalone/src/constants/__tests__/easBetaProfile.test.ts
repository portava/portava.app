/**
 * eas.json `beta` build profile — the private-beta binary can never be built
 * against PRODUCTION.
 *
 * The profile pins the three public URLs the app inlines at build time
 * (EXPO_PUBLIC_SUPABASE_URL, EXPO_PUBLIC_API_BASE_URL, EXPO_PUBLIC_WEB_ORIGIN)
 * to portava-beta. eas.json's build-profile `env` outranks EAS environment
 * variables of the same name (https://docs.expo.dev/eas/workflows/environment/,
 * read 2026-10-06), so a production value stored in the EAS environment cannot
 * override them. The anon/publishable key is deliberately NOT in the file: it
 * comes from the EAS environment the profile names (docs/eas-runbook.md
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

  it('carries no key in the file — the publishable key comes from the named EAS environment', () => {
    assert.equal(beta.env?.EXPO_PUBLIC_SUPABASE_ANON_KEY, undefined);
    assert.ok(!/sb_publishable_|eyJ[A-Za-z0-9_-]{10,}/.test(JSON.stringify(beta)), 'a key literal is in eas.json');
    assert.equal(typeof beta.environment, 'string', 'the EAS environment must be named explicitly, not inferred');
  });
});
