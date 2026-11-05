import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL ?? "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

export const isServiceClientReady = Boolean(supabaseUrl && serviceRoleKey);

/**
 * Test-only hook — inject a fake service client so admin routes can be tested
 * without real Supabase credentials.  Must only be called from test files.
 */
let _testServiceClient: SupabaseClient | null = null;
export function _setTestServiceClient(client: SupabaseClient | null): void {
  _testServiceClient = client; builtServiceClient = null; _resetHotPathCachesForTest(); // test-only: every injection starts clean (a newly built client, nothing remembered)
}

export function getServiceClient(): SupabaseClient | null {
  if (_testServiceClient) return auditedLayoverClient(_testServiceClient);
  if (!isServiceClientReady) return null; if (builtServiceClient) return auditedLayoverClient(builtServiceClient); // built ONCE per process (see "The one service client" below)
  return auditedLayoverClient(createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  }));
}

// ---------------------------------------------------------------------------
// Which clients are PostgREST-backed
// ---------------------------------------------------------------------------
// Appended BELOW getServiceClient on purpose: the lines above are cited by line
// (10_Database_Architecture.md, census-media, sensing-input-gap).
//
// Every client this API reads the database with is built by the one
// `createClient(` call above, and each is recorded here.
// handRolledAuthAccountState.test.ts pins that no other file in src/ builds one,
// with one exception it also pins: lib/telegraphBroadcast.ts's dedicated
// Realtime client, which only opens a channel and never reads a table. The account-state
// gate (lib/accountStateGate.ts) needs the distinction: PostgREST ALWAYS returns
// the key of an embed a select names (`[]` when there are no rows), so a profile
// row from one of THESE clients that lacks `user_account_states` is not an
// answer PostgREST can give, and the gate reports the state unreadable instead
// of reading the missing key as "no ban". A test double injected through
// `_setTestServiceClient` / `_setTestClient` is never recorded, so a double that
// models the status column alone keeps the meaning it has always had.
const postgrestBackedClients = new WeakSet<object>();

/** The package's `createClient`, recording what it built. It keeps the name so the cited call above reads unchanged. */
function createClient(
  url: string,
  key: string,
  options: { auth: { autoRefreshToken: boolean; persistSession: boolean } },
): SupabaseClient {
  const client: SupabaseClient = createSupabaseClient(url, key, options);
  postgrestBackedClients.add(client); markHotPathCacheableClient(client); builtServiceClient = client; // recorded, cacheable (lib/hotPathCache.ts), and the memo getServiceClient answers from
  return client;
}

/** True for a client built by getServiceClient; never for an injected test double. */
export function isPostgrestBackedClient(client: unknown): boolean {
  return typeof client === "object" && client !== null && postgrestBackedClients.has(originalLayoverAuditClient(client));
}

/**
 * Test-only: record `client` as PostgREST-backed, so a suite can prove what the
 * gate does with a real client's impossible answer. Must only be called from
 * test files (it can only make the gate STRICTER for that client).
 */
export function _markPostgrestBackedForTest(client: object): void {
  postgrestBackedClients.add(client);
}

import { auditedLayoverClient, originalLayoverAuditClient } from './layoverServiceAudit.js';

// ---------------------------------------------------------------------------
// The one service client
// ---------------------------------------------------------------------------
// Appended BELOW on purpose, like the section above: the lines above are cited
// by line.
//
// getServiceClient used to build a NEW supabase-js client on every call — one
// per request, and often several (every door that takes its own). It now builds
// one per process, the first time it is asked, and answers every later call
// with that object (wrapped by auditedLayoverClient exactly as before, which is
// per call because the audit scope is per request). This is safe to share
// because the service client holds no per-request state: it is built with
// `persistSession: false, autoRefreshToken: false`, no runtime path in src/
// calls a session-setting Auth method on it (signIn*, setSession, verifyOtp,
// exchangeCodeForSession, refreshSession), and every call it makes is a
// stateless request — PostgREST with the service key, `auth.getUser(token)` and
// `auth.admin.*` with the token or key they are given. The one Realtime client
// is not this one (lib/telegraphBroadcast.ts builds its own).
//
// Two consequences worth knowing:
//   - The per-client-object memos elsewhere (lib/discoveryStopGate.ts,
//     lib/discoveryCandidates/pipelineFlags.ts, lib/telegraphOutboxDrainScheduler.ts,
//     services/highlights/highlightSchemaAvailability.ts, lib/intelConsent.ts)
//     used to live one request, because their key was a client nobody reused;
//     they now live for their own TTLs, as they were written to. The three flag
//     caches among them also end on featureFlagWriteEpoch() (lib/hotPathCache.ts),
//     so an admin flag write on this instance still takes effect at once.
//   - The memo is recorded in `postgrestBackedClients` (one entry, not one per
//     request) and is the only client whose answers lib/hotPathCache.ts keeps.
//
// `_setTestServiceClient` drops the memo (and empties lib/hotPathCache.ts), so a
// test that clears its double and asks again gets a newly built client, as
// every such test always has.
let builtServiceClient: SupabaseClient | null = null;

import { markHotPathCacheableClient, _resetHotPathCachesForTest } from "./hotPathCache.js";
