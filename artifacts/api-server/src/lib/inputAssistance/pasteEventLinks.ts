/**
 * §24 Paste Intelligence — event links (census-input-intelligence G158).
 *
 * WHAT IT DOES. A pasted Portava event link — the link the event screen's Share
 * builds (`<web origin>/event/<uuid>[?share=…]`, app/event/[id].tsx) or the
 * app's own scheme (`travelbuddy://event/<uuid>`) — is read as THAT event, and
 * the event's city is resolved for the receiving place field through the same
 * gateway serve as typed text. It is offered on the review screen like any other
 * pasted line; nothing is added until the person ticks it.
 *
 * WHAT IT NEVER DOES
 *   - The `share` token in the link is a capability. It is never read, echoed,
 *     looked up or logged; the event is resolved with the VIEWER's own access.
 *   - It never discloses more than event search already does: an event resolves
 *     only when it would appear in THIS viewer's event search — public, live
 *     (not draft / cancelled / archived / completed, and started no more than
 *     2 h ago — searchEvents' default window), its host not blocked in either
 *     direction, not age-restricted and active (searchCandidates.ts#searchEvents'
 *     gate). Anything else is "no match", dropped silently (PR-D2-7c), so a link
 *     to a private event says nothing about whether it exists.
 *   - A link from any other host is not an event link (an arbitrary site's
 *     "/event/<uuid>" is not ours to read).
 *
 * FLAG: `input_paste_event_links_enabled` (migration 3691, seeded FALSE). Off /
 * absent: an event link is the unsupported link it always was.
 */
import { isFlagEnabled } from '../featureFlags';
import { fetchBlockedSet } from '../blocks';
import { fetchAgeRestrictedSet } from './searchCandidates';

export const INPUT_PASTE_EVENT_LINKS_FLAG = 'input_paste_event_links_enabled';

/** The web hosts that serve Portava's share pages (app.json's intent filters + the canonical origin). */
export const PORTAVA_LINK_HOSTS: ReadonlySet<string> = new Set([
  'portava.replit.app',
  'portava.app',
  'www.portava.app',
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APP_SCHEME = /^travelbuddy:\/\/event\/([0-9a-f-]{36})(?:[/?#].*)?$/i;

function extraHosts(env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  for (const key of ['PORTAVA_WEB_ORIGIN', 'EXPO_PUBLIC_WEB_ORIGIN']) {
    const v = (env[key] ?? '').trim();
    if (!v) continue;
    try { out.push(new URL(v).host.toLowerCase()); } catch { /* not an origin */ }
  }
  return out;
}

/** The event a pasted line links to, or null. Pure (reads env for the configured origin only). */
export function parseEventLink(line: string, env: NodeJS.ProcessEnv = process.env): { eventId: string } | null {
  const t = (line ?? '').trim();
  if (!t || /\s/.test(t)) return null;
  const app = t.match(APP_SCHEME);
  if (app) return UUID.test(app[1]!) ? { eventId: app[1]!.toLowerCase() } : null;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(t) ? t : `https://${t}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.host.toLowerCase();
  if (!PORTAVA_LINK_HOSTS.has(host) && !extraHosts(env).includes(host)) return null;
  const m = url.pathname.match(/^\/event\/([^/]+)\/?$/);
  if (!m) return null;
  const id = decodeURIComponent(m[1]!);
  return UUID.test(id) ? { eventId: id.toLowerCase() } : null;
}

/** searchCandidates.ts#searchEvents' default cutoff: started ≤ 2 h ago. */
export const EVENT_PAST_GRACE_MS = 2 * 3600_000;

export type EventLinkOutcome =
  | { ok: true; event: { title: string; city: string; country: string | null } | null }
  | { ok: false };

/**
 * The linked event as THIS viewer's event search would show it, or null when
 * it would not appear there. `{ ok: false }` when any read failed — a failure,
 * never "no such event".
 */
export async function readLinkedEvent(sc: any, userId: string, eventId: string, now: Date = new Date()): Promise<EventLinkOutcome> {
  try {
    const { data, error } = await sc
      .from('events')
      .select('id, title, host_id, city, country, visibility, state, starts_at')
      .eq('id', eventId)
      .maybeSingle();
    if (error) return { ok: false };
    const ev = data as { title?: unknown; host_id?: unknown; city?: unknown; country?: unknown; visibility?: unknown; state?: unknown; starts_at?: unknown } | null;
    if (!ev) return { ok: true, event: null };
    if (ev.visibility !== 'public') return { ok: true, event: null };
    if (typeof ev.state !== 'string' || ['draft', 'cancelled', 'archived', 'completed'].includes(ev.state)) return { ok: true, event: null };
    // searchEvents' default window: an event that started more than 2 h ago is not in the search (V-IN F1).
    const startsMs = typeof ev.starts_at === 'string' ? Date.parse(ev.starts_at) : NaN;
    if (!Number.isFinite(startsMs) || startsMs < now.getTime() - EVENT_PAST_GRACE_MS) return { ok: true, event: null };
    const host = typeof ev.host_id === 'string' ? ev.host_id : null;
    if (!host) return { ok: true, event: null };
    const [blocked, ageRestricted] = await Promise.all([fetchBlockedSet(sc, userId), fetchAgeRestrictedSet(sc)]);
    if (blocked === null || ageRestricted === null) return { ok: false };
    if (blocked.has(host) || ageRestricted.has(host)) return { ok: true, event: null };
    const owner = await sc.from('profiles').select('id').eq('id', host).in('account_status', ['active']).maybeSingle();
    if (owner.error) return { ok: false };
    if (!owner.data) return { ok: true, event: null };
    const city = typeof ev.city === 'string' ? ev.city.trim() : '';
    if (!city) return { ok: true, event: null }; // nothing a place field can take
    return {
      ok: true,
      event: {
        title: typeof ev.title === 'string' && ev.title.trim() ? ev.title.trim().slice(0, 120) : 'Event',
        city: city.slice(0, 80),
        country: typeof ev.country === 'string' && ev.country.trim() ? ev.country.trim().slice(0, 80) : null,
      },
    };
  } catch {
    return { ok: false };
  }
}

export async function eventLinksEnabled(sc: any): Promise<boolean> {
  return isFlagEnabled(sc, INPUT_PASTE_EVENT_LINKS_FLAG);
}
