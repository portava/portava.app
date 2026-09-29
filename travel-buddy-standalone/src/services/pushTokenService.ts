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
  const { freshToken } = await import('./apiToken.ts');
  return freshToken();
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
  const registration = await doFetch(`${base}/api/me/devices`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ pushToken, platform: 'expo' }),
  }).catch(() => null); await rememberRegisteredDevice(registration); // TM-social PLAT-F20: sign-out needs this device's row id
}

// ── Device unregistration on sign-out — TM-social PLAT-F20 ───────────────────
//
// POST /me/devices answers `{ ok, deviceId }` (routes/notifications.ts) and
// DELETE /me/devices/:id removes that row for the signed-in user only. Until
// this block, the id was thrown away and sign-out never deleted the row, so
// the server kept pushing the previous account's notifications to a device
// that no longer belonged to that session.
//
// The id is kept in memory, not on disk: usePushToken re-registers on every
// authenticated launch, which re-learns it, and a stale id surviving a crash
// could only ever delete a row that the next registration replaces anyway.

let _registeredDeviceId: string | null = null;

async function rememberRegisteredDevice(res: unknown): Promise<void> {
  const r = res as { ok?: boolean; json?: () => Promise<unknown> } | null;
  if (!r || r.ok !== true || typeof r.json !== 'function') return;
  const body = (await r.json().catch(() => null)) as { deviceId?: unknown } | null;
  if (body && typeof body.deviceId === 'string' && body.deviceId) _registeredDeviceId = body.deviceId;
}

/** The notification_devices row this app registered in this session, if any. */
export function getRegisteredDeviceId(): string | null {
  return _registeredDeviceId;
}

/** Test seam — reset the remembered device id. */
export function _resetRegisteredDevice(): void {
  _registeredDeviceId = null;
}

/**
 * Remove this device's push registration BEFORE the session is torn down —
 * DELETE /me/devices/:id needs the outgoing user's bearer token.
 *
 * Best-effort by design: sign-out must never be blocked by the network, so the
 * call is bounded by `timeoutMs` and every failure is swallowed. The outcome is
 * returned so it can be observed (and tested) rather than assumed:
 *   'none'     — this session never registered a device; nothing to remove
 *   'removed'  — the server confirmed the delete
 *   'failed'   — the server refused or the network failed
 *   'timeout'  — no answer within the bound; sign-out proceeds anyway
 */
export async function unregisterPushDeviceOnSignOut(opts?: {
  /** Defaults to notifications.unregisterDevice (DELETE /api/me/devices/:id). */
  unregister?: (deviceId: string) => Promise<boolean>;
  timeoutMs?: number;
}): Promise<'none' | 'removed' | 'failed' | 'timeout'> {
  const deviceId = _registeredDeviceId;
  if (!deviceId) return 'none';
  const unregister =
    opts?.unregister ??
    (async (id: string) => {
      const { unregisterDevice } = await import('./notifications.ts');
      return unregisterDevice(id);
    });
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), opts?.timeoutMs ?? 4000);
  });
  const attempt = unregister(deviceId)
    .then((ok): 'removed' | 'failed' => (ok ? 'removed' : 'failed'))
    .catch((): 'failed' => 'failed');
  const outcome = await Promise.race([attempt, timeout]);
  if (timer) clearTimeout(timer);
  if (outcome === 'removed') _registeredDeviceId = null;
  return outcome;
}
