/**
 * configuredSupabaseEnvFixture — makes a suite's Supabase configuration explicit.
 *
 * WHY THIS EXISTS
 * ===============
 * lib/supabase.ts computes `isSupabaseConfigured` ONCE, at module load, from
 * EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY. When it is false the
 * owner observer (services/messagingOwnerRequest.ts) never subscribes to auth,
 * so no owner is ever observed and every owner-bound call correctly refuses
 * (captureMessagingOwnerRequest() → null, errorKind 'config_error').
 *
 * Suites that exercise the CONFIGURED owner path used to inherit that
 * configuration from whatever shell ran jest: green when a developer exported
 * dummy EXPO_PUBLIC_* values, red under `pnpm check:all` / CI where they are
 * unset. This module states the configuration inside the suite instead.
 *
 * USAGE
 * =====
 * Import it FIRST, before anything that (transitively) loads lib/supabase.ts:
 *
 *   import './configuredSupabaseEnvFixture.ts';
 *
 * Imports execute in source order (only jest.mock calls are hoisted above
 * them), so the values are in place when lib/supabase.ts evaluates. Jest gives
 * every test file its own `process.env` copy, so nothing leaks to other files.
 *
 * The values are synthetic and unroutable (port 9 = discard). Consuming suites
 * stub the Supabase SDK's createClient, so no request ever reaches them; this
 * only flips the module-load configuration gate, it mocks nothing.
 */
process.env.EXPO_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:9';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'synthetic-test-anon-key';

export {};
