/**
 * Telegraph §2.1 — the four reads behind the inbox's context bands.
 *
 * Every read answers `null` when it FAILED and a value when it succeeded, so a
 * band can tell "nothing to show" from "could not ask". They are read
 * independently: one band's outage does not take the other three with it.
 */
import { isSupabaseConfigured } from '../../../lib/supabase.ts';
import { freshToken } from '../../../services/apiToken.ts';

export interface InboxBandsData {
  /** The person's own quick status; null when the read failed. */
  status: { status: string | null; expiresAt: string | null } | null;
  /** §30A.2's projection, summarised; null when the read failed. `enabled: false` is the flag answering. */
  nearby: { enabled: boolean; count: number; availableNow: number } | null;
  /** Open §8 coordination sessions across the person's conversations; null when the read failed. */
  now: Array<{ sessionId: string; threadId: string; title: string; state: string | null }> | null;
  /** Upcoming plans, soonest first; null when the read failed. */
  upcoming: Array<{ id: string; title: string; startsAt: string | null; chatThreadId: string | null }> | null;
}

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

type Json = Record<string, unknown>;

function rec(v: unknown): Json | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

async function getJson(path: string): Promise<unknown> {
  if (!isSupabaseConfigured || !apiBase()) return null;
  const token = await freshToken();
  if (!token) return null;
  try {
    const res = await fetch(`${apiBase()}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export function summariseNearby(raw: unknown): InboxBandsData['nearby'] {
  const body = rec(raw);
  if (!body || typeof body.enabled !== 'boolean') return null;
  if (!body.enabled) return { enabled: false, count: 0, availableNow: 0 };
  if (!Array.isArray(body.people)) return null;
  return {
    enabled: true,
    count: body.people.length,
    availableNow: body.people.filter((p) => rec(rec(p)?.availability)?.state === 'available_now').length,
  };
}

/**
 * §2.1 NOW is active coordination. The same bound the server puts on §2.3's NOW
 * layer (services/telegraph/layers.ts NOW_LAYER_WINDOW_MINUTES) applies here: a
 * session nobody ended is NOW only while something happened in it within the
 * window — its opening or its latest transition. The sessions route answers up
 * to fourteen days back, and "Dinner · active" from last week is not now
 * (verifier F5).
 */
export const NOW_WINDOW_MINUTES = 60;

export function openSessions(raw: unknown, nowMs: number = Date.now()): InboxBandsData['now'] {
  const body = rec(raw);
  if (!body || !Array.isArray(body.sessions)) return null;
  const out: NonNullable<InboxBandsData['now']> = [];
  for (const item of body.sessions) {
    const s = rec(item);
    const sessionId = str(s?.sessionId);
    const threadId = str(s?.threadId);
    if (!s || !sessionId || !threadId || s.endedAt != null) continue;
    let last = Date.parse(str(s.startedAt) ?? '');
    for (const t of Array.isArray(s.transitions) ? s.transitions : []) {
      const at = Date.parse(str(rec(t)?.at) ?? '');
      if (Number.isFinite(at) && (!Number.isFinite(last) || at > last)) last = at;
    }
    if (!Number.isFinite(last) || nowMs - last > NOW_WINDOW_MINUTES * 60_000) continue;
    out.push({ sessionId, threadId, title: str(s.title) ?? 'Coordination', state: str(s.state) });
  }
  return out;
}

export function upcomingPlans(raw: unknown, nowMs: number): InboxBandsData['upcoming'] {
  const body = rec(raw);
  if (!body || !Array.isArray(body.meetups)) return null;
  const out: NonNullable<InboxBandsData['upcoming']> = [];
  for (const item of body.meetups) {
    const m = rec(item);
    const id = str(m?.id);
    const startsAt = str(m?.startsAt);
    // A plan the viewer DECLINED (or cancelled) is not their upcoming plan: /me/meetups
    // returns every invitation with `myRsvp` (verifier F5).
    if (!m || !id || !startsAt || m.status === 'cancelled' || m.myRsvp === 'declined' || m.myRsvp === 'cancelled' || !(Date.parse(startsAt) > nowMs)) continue;
    out.push({ id, title: str(m.title) ?? 'Plan', startsAt, chatThreadId: str(m.chatThreadId) });
  }
  return out.sort((a, b) => Date.parse(a.startsAt!) - Date.parse(b.startsAt!));
}

export async function fetchInboxBands(nowMs: number = Date.now()): Promise<InboxBandsData> {
  const [status, nearby, sessions, meetups] = await Promise.all([
    getJson('/api/me/quick-availability'),
    getJson('/api/nearby/reachable'),
    getJson('/api/me/coordination-sessions'),
    getJson('/api/me/meetups?filter=upcoming'),
  ]);
  const st = rec(status);
  return {
    status: st && 'status' in st ? { status: str(st.status), expiresAt: str(st.expiresAt) } : null,
    nearby: summariseNearby(nearby),
    now: openSessions(sessions, nowMs),
    upcoming: upcomingPlans(meetups, nowMs),
  };
}
