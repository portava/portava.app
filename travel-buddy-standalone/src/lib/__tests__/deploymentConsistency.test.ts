/**
 * deploymentConsistency — a build whose database and API belong to different
 * deployments must not run (verifier F4b). Pure rule, plus the shape of its one
 * call site: app/_layout.tsx must read the four addresses as literal
 * `process.env.EXPO_PUBLIC_*` (Expo inlines only those) and wrap the whole app in
 * the gate.
 *
 * Run: node --import tsx/esm --test src/lib/__tests__/deploymentConsistency.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { deploymentConsistencyProblem as problem } from '../deploymentConsistency.ts';

const __dir = dirname(fileURLToPath(import.meta.url));

const PROD_DB = 'https://ajrurzioarfkagpuxfnb.supabase.co';
const BETA_DB = 'https://emfpckykpzfturllshly.supabase.co';
const PROD_API = 'https://portava.replit.app';
const BETA_API = 'https://portava-beta.replit.app';

describe('deploymentConsistencyProblem', () => {
  it('production build, production addresses: runs (production unchanged)', () => {
    assert.equal(problem({ supabaseUrl: PROD_DB, apiBaseUrl: PROD_API, webOrigin: PROD_API }), null);
  });

  it('beta build, beta addresses: runs', () => {
    assert.equal(problem({ supabaseUrl: BETA_DB, apiBaseUrl: BETA_API, webOrigin: BETA_API, deploymentEnv: 'beta' }), null);
  });

  it('development and test addresses are not judged', () => {
    assert.equal(problem({ supabaseUrl: PROD_DB, apiBaseUrl: 'http://localhost:8080' }), null);
    assert.equal(problem({ supabaseUrl: BETA_DB, apiBaseUrl: 'https://abc.kirk.replit.dev' }), null);
    assert.equal(problem({}), null);
  });

  it('REFUSED: beta database with production API (the half-overridden beta build)', () => {
    assert.match(String(problem({ supabaseUrl: BETA_DB, apiBaseUrl: PROD_API })), /database is beta but its API is production/);
  });

  it('REFUSED: production database with beta API (the reverse)', () => {
    assert.match(String(problem({ supabaseUrl: PROD_DB, apiBaseUrl: BETA_API })), /database is production but its API is beta/);
  });

  it('REFUSED: database and API agree but the web origin is the other deployment', () => {
    assert.ok(problem({ supabaseUrl: BETA_DB, apiBaseUrl: BETA_API, webOrigin: PROD_API }));
  });

  it('REFUSED: a beta-declared build fully overridden to production (agreement is not enough)', () => {
    const r = problem({ supabaseUrl: PROD_DB, apiBaseUrl: PROD_API, webOrigin: PROD_API, deploymentEnv: 'beta' });
    assert.match(String(r), /This is a beta build, but its database .* and its API .* are not beta's/);
  });

  it('REFUSED: a beta-declared build with only its API on production, case-insensitive host', () => {
    assert.ok(problem({ supabaseUrl: BETA_DB, apiBaseUrl: 'https://PORTAVA.replit.app', deploymentEnv: 'beta' }));
  });

  it('REFUSED (verifier N7): an http:// or path-suffixed Supabase URL is judged by its host', () => {
    assert.ok(problem({ supabaseUrl: 'http://ajrurzioarfkagpuxfnb.supabase.co', apiBaseUrl: BETA_API }));
    assert.ok(problem({ supabaseUrl: `${PROD_DB}/rest/v1`, apiBaseUrl: BETA_API }));
    assert.ok(problem({ supabaseUrl: 'https://AJRURZIOARFKAGPUXFNB.supabase.co:443/', apiBaseUrl: BETA_API }));
    assert.ok(problem({ supabaseUrl: `${PROD_DB}/rest/v1`, apiBaseUrl: BETA_API, webOrigin: BETA_API, deploymentEnv: 'beta' }));
    // the same spellings of the RIGHT project still run
    assert.equal(problem({ supabaseUrl: `${BETA_DB}/rest/v1`, apiBaseUrl: BETA_API, webOrigin: BETA_API, deploymentEnv: 'beta' }), null);
    assert.equal(problem({ supabaseUrl: 'http://ajrurzioarfkagpuxfnb.supabase.co/', apiBaseUrl: PROD_API }), null);
  });

  it('REFUSED (N7 residual): a trailing-dot host is judged, unlabelled and beta-labelled', () => {
    // unlabelled: production database (FQDN spelling) + beta API, and beta database + production API (FQDN)
    assert.ok(problem({ supabaseUrl: 'https://ajrurzioarfkagpuxfnb.supabase.co.', apiBaseUrl: BETA_API }));
    assert.ok(problem({ supabaseUrl: BETA_DB, apiBaseUrl: 'https://portava.replit.app./' }));
    // beta-labelled: the same two
    assert.match(String(problem({ supabaseUrl: 'https://ajrurzioarfkagpuxfnb.supabase.co.', apiBaseUrl: BETA_API, deploymentEnv: 'beta' })), /its database \(ajrurzioarfkagpuxfnb\)/);
    assert.match(String(problem({ supabaseUrl: BETA_DB, apiBaseUrl: 'https://portava.replit.app./', deploymentEnv: 'beta' })), /its API \(portava\.replit\.app\)/);
    // and the right project spelled that way still runs
    assert.equal(problem({ supabaseUrl: 'https://emfpckykpzfturllshly.supabase.co.', apiBaseUrl: 'https://portava-beta.replit.app./', deploymentEnv: 'beta' }), null);
  });

  it('REFUSED: an unknown declared deployment', () => {
    assert.match(String(problem({ supabaseUrl: BETA_DB, apiBaseUrl: BETA_API, deploymentEnv: 'staging' })), /unknown deployment/);
  });

  it('the error sentence carries no key: only refs and hosts', () => {
    const r = String(problem({ supabaseUrl: PROD_DB, apiBaseUrl: BETA_API, deploymentEnv: 'beta' }));
    assert.doesNotMatch(r, /sb_publishable_|eyJ/);
  });
});

describe('app/_layout.tsx wires the gate around the whole app', () => {
  const layout = readFileSync(pathResolve(__dir, '../../../app/_layout.tsx'), 'utf8');

  it('reads the four addresses as literal process.env.EXPO_PUBLIC_* (inlined by Expo)', () => {
    for (const name of ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_API_BASE_URL', 'EXPO_PUBLIC_WEB_ORIGIN', 'EXPO_PUBLIC_DEPLOYMENT_ENV']) {
      assert.ok(layout.includes(`process.env.${name}`), name);
    }
  });

  it('the default export renders the app only inside DeploymentGate with the computed problem', () => {
    const tail = layout.slice(layout.indexOf('export default function RootLayout()'));
    assert.match(tail, /<DeploymentGate problem=\{DEPLOYMENT_PROBLEM\}>\s*<RootLayoutApp \/>\s*<\/DeploymentGate>/);
    assert.equal((layout.match(/export default function/g) ?? []).length, 1);
  });
});
