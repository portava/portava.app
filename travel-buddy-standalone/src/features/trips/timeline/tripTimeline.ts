/**
 * §7.3 conflicts on the timeline — the client for GET /trips/:tripId/timeline,
 * read for ONE thing: which plans are in a temporal conflict. census-trips
 * TR130: "a conflict is not silently rendered as a normal itinerary". The
 * plan section renders the itinerary; this reads the projection's `conflicts`
 * and `days[].conflictIds` so the days that carry a conflict are marked and
 * the conflict is named in the server's words.
 *
 * `off` and `unavailable` are different and neither means "no conflicts": a
 * timeline that could not be read is not a clean one, and the card says so.
 */
import { isConfigured, apiBase, bearerToken } from '../shared/auth.ts';
import { acceptProjection, type TripProjectionEnvelope } from '../../../services/tripProjectionEnvelope.ts';

export interface TimelineConflict {
  /** OVERLAP | ... — the §7.3 kind, in the server's vocabulary. */
  kind: string;
  planIds: string[];
  detail?: string | null;
  [k: string]: unknown;
}
export interface TimelineDayRead {
  iso: string;
  dateLabel: string;
  dateSub: string;
  items: { id: string; title?: string | null; startsAt?: string | null; endsAt?: string | null; status?: string | null; [k: string]: unknown }[];
  conflictIds: string[];
}
export interface TripTimelineRead extends TripProjectionEnvelope {
  tripId: string;
  days: TimelineDayRead[];
  conflicts: TimelineConflict[];
  atRiskPlanIds: string[];
  atRiskReading: string;
}

export type TimelineRead =
  | { state: 'ok'; timeline: TripTimelineRead }
  | { state: 'off' }
  | { state: 'unavailable'; detail: string; reason?: string };

function looksLikeTimeline(b: unknown): b is TripTimelineRead {
  const t = b as Partial<TripTimelineRead> | null;
  return !!t && typeof t === 'object' && typeof t.tripId === 'string' && Array.isArray(t.days) && Array.isArray(t.conflicts) && Array.isArray(t.atRiskPlanIds)
    && t.days.every((d) => d && typeof d.iso === 'string' && Array.isArray(d.items) && Array.isArray(d.conflictIds));
}

export async function fetchTripTimeline(tripId: string, opts: { now?: number } = {}): Promise<TimelineRead> {
  if (!isConfigured() || !apiBase()) return { state: 'off' };
  const token = await bearerToken();
  if (!token) return { state: 'off' };
  try {
    const res = await fetch(`${apiBase()}/api/trips/${tripId}/timeline`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string; reason?: string; message?: string } | null;
      if (res.status === 404 && (body?.error === 'feature_disabled' || body?.reason === 'FEATURE_DISABLED')) return { state: 'off' };
      return { state: 'unavailable', detail: body?.message ?? `HTTP ${res.status}`, reason: body?.reason };
    }
    const body: unknown = await res.json().catch(() => null);
    const accepted = acceptProjection(body, { now: opts.now });
    if (!accepted.accepted) return { state: 'unavailable', detail: accepted.message, reason: accepted.reason };
    if (!looksLikeTimeline(body)) return { state: 'unavailable', detail: 'unreadable response' };
    return { state: 'ok', timeline: body };
  } catch (e: any) {
    return { state: 'unavailable', detail: String(e?.message ?? 'network error') };
  }
}

/* ── pure readings ──────────────────────────────────────────────────────── */

export interface ConflictedDay { iso: string; dateLabel: string; dateSub: string; plans: { id: string; title: string }[]; kinds: string[] }

/** The days that carry a conflict, each with the plans in it and the §7.3 kinds, in timeline order. Empty when the timeline is clean. */
export function conflictedDays(t: TripTimelineRead): ConflictedDay[] {
  const kindByPlan = new Map<string, Set<string>>();
  for (const c of t.conflicts) for (const id of c.planIds) { const s = kindByPlan.get(id) ?? new Set<string>(); s.add(c.kind); kindByPlan.set(id, s); }
  const out: ConflictedDay[] = [];
  for (const d of t.days) {
    if (d.conflictIds.length === 0) continue;
    const plans = d.items.filter((i) => d.conflictIds.includes(i.id)).map((i) => ({ id: i.id, title: (i.title as string | null | undefined) ?? 'Untitled plan' }));
    const kinds = [...new Set(d.conflictIds.flatMap((id) => [...(kindByPlan.get(id) ?? [])]))].sort();
    out.push({ iso: d.iso, dateLabel: d.dateLabel, dateSub: d.dateSub, plans, kinds });
  }
  return out;
}

/** One sentence per conflict kind, in words a traveller can act on. */
export function conflictKindLabel(kind: string): string {
  switch (kind) {
    case 'PLAN_OVERLAP': return 'Two plans overlap in time';
    case 'OVERLAP': return 'The next deadline falls before you are free to leave';
    case 'NO_TIME_TO_TRAVEL': return 'Not enough time to travel between them';
    default: return kind.replace(/_/g, ' ').toLowerCase();
  }
}
