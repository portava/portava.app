/**
 * Push-token registration service.
 *
 * Extracted from usePushToken.ts so the registration logic can be imported
 * and tested in Node.js without native Expo module bindings.
 *
 * Test slot: _setTestTokenProvider(fn) injects a mock token-fetching function.
 * This is the same pattern as _setTestCalendarDeps / _setTestClient elsewhere
 * in the codebase.
 */

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

// ── Test-slot ──────────────────────────────────────────────────────────────────

let _testTokenProvider: (() => Promise<string | null>) | null = null;

/**
 * Override the token-fetch function in tests.  Pass null to restore default
 * behaviour (delegates to real Supabase session).  Has zero effect in
 * production because tests never run in the Expo runtime.
 */
export function _setTestTokenProvider(fn: (() => Promise<string | null>) | null): void {
  _testTokenProvider = fn;
}

/** Exposed for testing only — do not call from production screens. */
export function _getApiBase(): string {
  return apiBase();
}

// ── Device timezone ────────────────────────────────────────────────────────────

/**
 * Resolve the device's IANA timezone (e.g. "Europe/Paris").
 * Returns null when the runtime can't report one.
 */
export function getDeviceTimezone(): string | null {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz && typeof tz === 'string' ? tz : null;
  } catch {
    return null;
  }
}

async function resolveAccessToken(): Promise<string | null> {
  if (_testTokenProvider) return _testTokenProvider();
  // Dynamic import keeps this module loadable in Node.js.
  const { supabase } = await import('../lib/supabase');
  const { data: refreshed } = await supabase.auth.refreshSession();
  const session =
    refreshed?.session ?? (await supabase.auth.getSession()).data.session;
  return session?.access_token ?? null;
}

/**
 * Sync the device's IANA timezone to the server so quiet hours are evaluated
 * in the user's local time without any manual setup.
 *
 * PUT /api/me/notification-preferences  { timezone }
 *
 * Best-effort, same silent no-op rules as savePushToken. Also no-ops when the
 * device timezone can't be resolved.
 */
export async function saveDeviceTimezone(
  opts?: {
    /** Override the API base URL (for tests). */
    baseUrl?: string;
    /** Override the fetch implementation (for tests). */
    fetchImpl?: typeof fetch;
    /** Override the timezone (for tests). */
    timezone?: string;
  },
): Promise<void> {
  const base = opts?.baseUrl ?? apiBase();
  if (!base) return;

  const timezone = opts?.timezone ?? getDeviceTimezone();
  if (!timezone) return;

  const token = await resolveAccessToken();
  if (!token) return;

  const doFetch = opts?.fetchImpl ?? fetch;
  await doFetch(`${base}/api/me/notification-preferences`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ timezone }),
  }).catch(() => {});
}

// ── Production function ────────────────────────────────────────────────────────

/**
 * Register a push token with the API server.
 *
 * POST /api/me/devices  { pushToken, platform: 'expo' }
 *
 * Silent no-op when:
 *   - EXPO_PUBLIC_API_BASE_URL is not set
 *   - The user session cannot be resolved to an access token
 *   - The network request fails (errors are swallowed — registration is best-effort)
 */
export async function savePushToken(
  pushToken: string,
  opts?: {
    /** Override the API base URL (for tests). */
    baseUrl?: string;
    /** Override the fetch implementation (for tests). */
    fetchImpl?: typeof fetch;
  },
): Promise<void> {
  const base = opts?.baseUrl ?? apiBase();
  if (!base) return;

  // Resolve auth token — use the injected test provider or the real Supabase session.
  let token: string | null;
  if (_testTokenProvider) {
    token = await _testTokenProvider();
  } else {
    // Dynamic import keeps this module loadable in Node.js.
    const { freshToken } = await import('./apiToken.ts');
    token = await freshToken();
  }

  if (!token) return;

  const doFetch = opts?.fetchImpl ?? fetch;
  await doFetch(`${base}/api/me/devices`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ pushToken, platform: 'expo' }),
  }).catch(() => {});
}
