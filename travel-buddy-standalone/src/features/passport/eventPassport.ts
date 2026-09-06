/**
 * eventPassport — client bindings for the temporary event Passport (spec §25
 * "Share Passport options", §31 "Explicitly expire … event Passport, temporary
 * sharing", Phase 8).
 *
 * The server owns EVERY rule: the bounded TTL, revocation, the event's own end,
 * co-attendance, and the narrowing to the event field allow-list. This module
 * does not re-derive any of them — it calls the four endpoints and hands back
 * what the server said, exactly as `passportProjection.ts` does for the §29
 * aggregate.
 *
 * Two client-side behaviours worth naming, because both are about NOT inventing
 * policy:
 *
 *   • `enabled: false` (the capability flag is off) is a first-class, non-error
 *     answer. A caller renders no share affordance at all rather than an error.
 *
 *   • `isShareLive` is a pure, LOCAL staleness read used only to stop showing a
 *     share the client already knows has lapsed (§31 "never render stale …
 *     as current"). It can only ever make the client show LESS; the server
 *     re-checks expiry on every resolve regardless of what the client believes.
 */
import { isSupabaseConfigured } from '../../lib/supabase.ts';
import { freshToken as freshApiToken } from '../../services/apiToken.ts';

function apiBase(): string { return process.env.EXPO_PUBLIC_API_BASE_URL ?? ''; }

/** The server's view of the caller's share for one event. */
export interface EventPassportShare {
  token: string;
  eventId: string;
  /** ISO instant after which the share stops resolving. Always present. */
  expiresAt: string;
}

/**
 * The narrow `event` projection the server serves for a resolved share — the
 * §25 QR family's minimal shape. Deliberately has no stamps / journeys / plans /
 * memories / trust / capabilities field to read, because the server never sends
 * one.
 */
export interface EventPassportProjectionView {
  variant: 'event';
  userId: string;
  viewerContext: string;
  identity: {
    userId: string;
    /** First name only — the server never sends a family name here (§25). */
    firstName: string | null;
    handle: string | null;
    avatarUrl: string | null;
    verified: boolean;
    verificationLevel: string | null;
    homeCountry: string | null;
  };
  /** Broad city only, and only while they are genuinely at the event (§5/§23). */
  atEventCity: string | null;
  intents: string[];
  actions: { can_follow: boolean; can_message: boolean };
  restricted?: { reason: string };
}

export interface ResolvedEventPassport {
  share: { eventId: string; expiresAt: string };
  passport: EventPassportProjectionView;
}

/**
 * Every call answers with one of these. `enabled === false` means the
 * capability is off server-side — not a failure, and not something to retry.
 */
export type EventPassportResult<T> =
  | { ok: true; enabled: true; data: T }
  | { ok: true; enabled: false; data: null }
  | { ok: false; enabled: true; data: null; message: string };

function disabled<T>(): EventPassportResult<T> {
  return { ok: true, enabled: false, data: null };
}
function failed<T>(message: string): EventPassportResult<T> {
  return { ok: false, enabled: true, data: null, message };
}

async function call<T>(
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown },
  pick: (body: any) => T | null,
): Promise<EventPassportResult<T>> {
  if (!isSupabaseConfigured || !apiBase()) return disabled<T>();
  const token = await freshApiToken();
  if (!token) return failed<T>('Not signed in');
  try {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${apiBase()}${path}`, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) return failed<T>(body?.message ?? `API ${res.status}`);
    // The server's explicit "capability is off" envelope.
    if (body && body.enabled === false) return disabled<T>();
    const data = pick(body);
    if (data === null) return failed<T>('Unexpected response');
    return { ok: true, enabled: true, data };
  } catch (e) {
    return failed<T>(e instanceof Error ? e.message : 'Network error');
  }
}

function pickShare(body: any): EventPassportShare | null {
  const s = body?.share;
  if (!s || typeof s.token !== 'string' || typeof s.expiresAt !== 'string') return null;
  return { token: s.token, eventId: String(s.eventId ?? ''), expiresAt: s.expiresAt };
}

/** Mint (or re-mint) the signed-in traveler's event Passport for `eventId`. */
export async function createEventPassportShare(
  eventId: string,
): Promise<EventPassportResult<EventPassportShare>> {
  return call(
    '/api/passport/event-share',
    { method: 'POST', body: { eventId } },
    pickShare,
  );
}

/** Withdraw the signed-in traveler's share for `eventId`. Idempotent. */
export async function revokeEventPassportShare(
  eventId: string,
): Promise<EventPassportResult<{ revoked: boolean }>> {
  return call(
    `/api/passport/event-share/${encodeURIComponent(eventId)}/revoke`,
    { method: 'POST' },
    (body) => (typeof body?.revoked === 'boolean' ? { revoked: body.revoked } : null),
  );
}

/**
 * The signed-in traveler's OWN live share for `eventId`, or null when there is
 * none. `data === null` with `enabled: true` means "no live share", which is a
 * normal state, not an error.
 */
export async function getMyEventPassportShare(
  eventId: string,
): Promise<EventPassportResult<EventPassportShare | null>> {
  return call<EventPassportShare | null>(
    `/api/passport/event-share/${encodeURIComponent(eventId)}`,
    { method: 'GET' },
    (body) => ('share' in (body ?? {}) ? pickShare(body) : null),
  );
}

/** Resolve a scanned event Passport token. Requires being at the same event. */
export async function resolveEventPassport(
  token: string,
): Promise<EventPassportResult<ResolvedEventPassport>> {
  return call<ResolvedEventPassport>(
    `/api/passport/event-passport/${encodeURIComponent(token)}`,
    { method: 'GET' },
    (body) => {
      const p = body?.passport;
      const s = body?.share;
      if (!p || p.variant !== 'event' || !s || typeof s.expiresAt !== 'string') return null;
      return { share: { eventId: String(s.eventId ?? ''), expiresAt: s.expiresAt }, passport: p };
    },
  );
}

// The pure link/staleness helpers live in eventPassportShareUtils.ts so they can
// be imported and tested in Node without React Native's runtime (the same split
// passportShareUtils.ts makes for the §25 QR links). Re-exported here so callers
// have a single import site.
export {
  eventPassportDeepLink,
  eventPassportWebLink,
  isShareLive,
  shareRemainingLabel,
} from './eventPassportShareUtils.ts';
