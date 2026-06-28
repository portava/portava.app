/**
 * Supabase client. Reads URL + anon key from public env (EXPO_PUBLIC_*).
 * Set these in your app config before using any service:
 *   EXPO_PUBLIC_SUPABASE_URL, EXPO_PUBLIC_SUPABASE_ANON_KEY
 *
 * Until configured, isSupabaseConfigured is false and services no-op gracefully
 * so the app keeps running on mock data.
 */
import { createClient } from '@supabase/supabase-js';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

export const isSupabaseConfigured = Boolean(url && anonKey);

export const supabase = createClient(url || 'https://placeholder.supabase.co', anonKey || 'placeholder', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

/**
 * Returns a client whose requests carry the user's access token in the Authorization
 * header explicitly. Use for writes where the default client isn't attaching the token
 * (observed on Expo web: valid session present, but auth.uid() null at the DB).
 */
export function authedClient(accessToken: string) {
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}
