"use strict";
var _a, _b;
Object.defineProperty(exports, "__esModule", { value: true });
exports.supabase = exports.isSupabaseConfigured = void 0;
exports.authedClient = authedClient;
/**
 * Supabase client. Reads URL + anon key from public env (EXPO_PUBLIC_*).
 * Set these in your app config before using any service:
 *   EXPO_PUBLIC_SUPABASE_URL, EXPO_PUBLIC_SUPABASE_ANON_KEY
 *
 * Until configured, isSupabaseConfigured is false and services no-op gracefully
 * so the app keeps running on mock data.
 */
var supabase_js_1 = require("@supabase/supabase-js");
var url = (_a = process.env.EXPO_PUBLIC_SUPABASE_URL) !== null && _a !== void 0 ? _a : '';
var anonKey = (_b = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY) !== null && _b !== void 0 ? _b : '';
exports.isSupabaseConfigured = Boolean(url && anonKey);
exports.supabase = (0, supabase_js_1.createClient)(url || 'https://placeholder.supabase.co', anonKey || 'placeholder', {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});
/**
 * Returns a client whose requests carry the user's access token in the Authorization
 * header explicitly. Use for writes where the default client isn't attaching the token
 * (observed on Expo web: valid session present, but auth.uid() null at the DB).
 */
function authedClient(accessToken) {
    return (0, supabase_js_1.createClient)(url, anonKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { headers: { Authorization: "Bearer ".concat(accessToken) } },
    });
}
