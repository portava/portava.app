/**
 * Every input-assistance request reaches the API under `/api` (WP-19).
 *
 * THE DEFECT. `EXPO_PUBLIC_API_BASE_URL` is the ORIGIN
 * (`https://portava.replit.app`, `https://${REPLIT_DEV_DOMAIN}`), and the API
 * server mounts every router under `app.use("/api", router)`. The rest of the
 * client says `${apiBase()}/api/...` (263 call sites). The four input-assistance
 * requests said `${base}/input-assistance/...` — so on the hosted testing app
 * suggest, policies and telemetry all hit the web catch-all, came back
 * not-JSON or 404, and were reported as "assistance unavailable": the whole
 * Global Input Intelligence layer degraded silently on every field.
 *
 * Only `fetch` is faked (and the Supabase-backed token helper, which cannot load
 * under jest). The real service functions build the URLs.
 *
 * Run with: pnpm test:component
 */

// NOTE: exhaustive — the real token helper reaches the Supabase client.
jest.mock('../../../../services/apiToken.ts', () => ({ freshToken: async () => 'tok' }));

import { requestSuggestions, requestMapSearchPage } from '../inputAssistance.ts';
import { fetchInputPolicies } from '../policyClient.ts';
import { installInputTelemetryTransport } from '../telemetryTransport.ts';

const ORIGIN = 'https://portava.test';
let calls: string[] = [];

beforeEach(() => {
  calls = [];
  process.env.EXPO_PUBLIC_API_BASE_URL = ORIGIN;
  (global as any).fetch = jest.fn(async (url: string) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ requestId: 'r', policyVersion: 'v', suggestions: [], contexts: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
});

test('suggest goes to /api/input-assistance/suggest', async () => {
  await requestSuggestions({ context: 'global_search', fieldId: 'test.prefix', text: 'hoi an' });
  expect(calls).toEqual([`${ORIGIN}/api/input-assistance/suggest`]);
});

test('the Map search page goes to /api/input-assistance/suggest', async () => {
  await requestMapSearchPage('hoi an', {});
  expect(calls).toEqual([`${ORIGIN}/api/input-assistance/suggest`]);
});

test('the policy table is fetched from /api/input-assistance/policies', async () => {
  await fetchInputPolicies();
  expect(calls).toEqual([`${ORIGIN}/api/input-assistance/policies`]);
});

test('telemetry is posted to /api/input-assistance/telemetry', async () => {
  const batcher = installInputTelemetryTransport('session-prefix');
  batcher.sink({ name: 'suggestion_rendered', fieldId: 'test.prefix', context: 'global_search', at: 1, props: {} } as any);
  await batcher.flush();
  expect(calls).toEqual([`${ORIGIN}/api/input-assistance/telemetry`]);
});
