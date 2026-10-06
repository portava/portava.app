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
  _testServiceClient = client;
}

export function getServiceClient(): SupabaseClient | null {
  if (_testServiceClient) return _testServiceClient;
  if (!isServiceClientReady) return null;
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
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
  postgrestBackedClients.add(client);
  return client;
}

/** True for a client built by getServiceClient; never for an injected test double. */
export function isPostgrestBackedClient(client: unknown): boolean {
  return typeof client === "object" && client !== null && postgrestBackedClients.has(client);
}

/**
 * Test-only: record `client` as PostgREST-backed, so a suite can prove what the
 * gate does with a real client's impossible answer. Must only be called from
 * test files (it can only make the gate STRICTER for that client).
 */
export function _markPostgrestBackedForTest(client: object): void {
  postgrestBackedClients.add(client);
}
