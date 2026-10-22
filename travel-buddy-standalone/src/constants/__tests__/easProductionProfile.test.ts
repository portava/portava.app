/**
 * eas.json `production` and `preview` build profiles — the installable iPhone/Android binaries talk to the SAME
 * production backend the published Replit app does.
 *
 * Until 2026-10-22 both profiles pinned only EXPO_PUBLIC_API_BASE_URL / EXPO_PUBLIC_WEB_ORIGIN, to
 * https://portava.replit.app (no longer production's live origin — .replit [userenv.production] names rumazi.com), and
 * carried no Supabase URL or publishable key, so a native build depended on whatever an EAS environment held. They now
 * name all four inlined values themselves, read here from .replit so the native build and the published bundle cannot
 * drift apart.
 *
 * And no profile may carry an empty env value: eas.json rejects one ("is not allowed to be empty"), and a single empty
 * value in the beta profiles made every eas command fail for every profile.
 *
 * Run: node --import tsx/esm --test src/constants/__tests__/easProductionProfile.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deploymentConsistencyProblem } from '../../lib/deploymentConsistency.ts';

const __dir = dirname(fileURLToPath(import.meta.url));
const eas = JSON.parse(readFileSync(pathResolve(__dir, '../../../eas.json'), 'utf8')) as {
  build: Record<string, { distribution?: string; environment?: string; env?: Record<string, string>; [k: string]: unknown }>;
};
const replit = readFileSync(pathResolve(__dir, '../../../../.replit'), 'utf8');

function replitValue(section: string, name: string): string {
  const body = new RegExp(`^\\[${section.replace('.', '\\.')}\\]$([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, 'm').exec(replit)?.[1] ?? '';
  const v = new RegExp(`^${name}\\s*=\\s*"([^"]+)"`, 'm').exec(body)?.[1];
  assert.ok(v, `.replit [${section}] ${name} not found`);
  return v;
}

const PUBLISHED = {
  EXPO_PUBLIC_SUPABASE_URL: replitValue('userenv.shared', 'EXPO_PUBLIC_SUPABASE_URL'),
  EXPO_PUBLIC_SUPABASE_ANON_KEY: replitValue('userenv.shared', 'EXPO_PUBLIC_SUPABASE_ANON_KEY'),
  EXPO_PUBLIC_API_BASE_URL: replitValue('userenv.production', 'EXPO_PUBLIC_API_BASE_URL'),
};

describe('eas.json production-backed profiles', () => {
  it('no profile carries an empty env value (eas.json rejects it, and then every eas command fails)', () => {
    for (const [name, profile] of Object.entries(eas.build)) {
      for (const [k, v] of Object.entries(profile.env ?? {})) {
        assert.ok(typeof v === 'string' && v.length > 0, `build.${name}.env.${k} is empty`);
      }
    }
  });

  for (const name of ['production', 'preview'] as const) {
    describe(name, () => {
      const p = eas.build[name];

      it("inlines the published app's Supabase URL, publishable key and API base", () => {
        assert.ok(p, `build.${name} is missing`);
        assert.equal(p.env?.EXPO_PUBLIC_SUPABASE_URL, PUBLISHED.EXPO_PUBLIC_SUPABASE_URL);
        assert.equal(p.env?.EXPO_PUBLIC_SUPABASE_ANON_KEY, PUBLISHED.EXPO_PUBLIC_SUPABASE_ANON_KEY);
        assert.equal(p.env?.EXPO_PUBLIC_API_BASE_URL, PUBLISHED.EXPO_PUBLIC_API_BASE_URL);
        assert.equal(p.env?.EXPO_PUBLIC_WEB_ORIGIN, new URL(PUBLISHED.EXPO_PUBLIC_API_BASE_URL).origin);
      });

      it('names production and nothing else: no beta value, no deployment label, no secret', () => {
        const text = JSON.stringify(p);
        assert.ok(!text.includes('emfpckykpzfturllshly') && !text.includes('portava-beta'), `build.${name} names beta`);
        assert.ok(!text.includes('portava.replit.app'), `build.${name} names the retired origin`);
        // Unlabelled, like the published bundle: a 'production' label demands every address be a KNOWN production host.
        assert.equal(p.env?.EXPO_PUBLIC_DEPLOYMENT_ENV, undefined);
        assert.match(p.env?.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '', /^sb_publishable_[A-Za-z0-9_-]+$/);
        assert.ok(!/eyJ[A-Za-z0-9_-]{10,}|sb_secret_|service_role/.test(text), 'no JWT anon key, secret key or service-role key');
      });

      it("passes the app's own deployment gate (src/lib/deploymentConsistency.ts)", () => {
        assert.equal(deploymentConsistencyProblem({
          supabaseUrl: p.env?.EXPO_PUBLIC_SUPABASE_URL,
          apiBaseUrl: p.env?.EXPO_PUBLIC_API_BASE_URL,
          webOrigin: p.env?.EXPO_PUBLIC_WEB_ORIGIN,
          deploymentEnv: p.env?.EXPO_PUBLIC_DEPLOYMENT_ENV,
          publishableKey: p.env?.EXPO_PUBLIC_SUPABASE_ANON_KEY,
        }), null);
      });
    });
  }

  it('production is a store build (TestFlight / Play) that reads the production EAS environment; preview stays internal', () => {
    assert.equal(eas.build.production.distribution ?? 'store', 'store');
    assert.equal(eas.build.production.environment, 'production');
    assert.equal(eas.build.production.autoIncrement, true);
    assert.equal(eas.build.preview.distribution, 'internal');
  });
});
