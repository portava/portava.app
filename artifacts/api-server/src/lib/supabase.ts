import { createClient, type SupabaseClient } from "@supabase/supabase-js";

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
