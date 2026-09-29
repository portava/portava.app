/**
 * TM-live (WP-11) WALL-F13 — the client for GET /api/wall/moments.
 *
 * The server builds each WallMoment (Sensing §9): a CHANGE at a place the
 * viewer named — busy → packed, building, a queue appearing — with its truth
 * class, freshness and window, routed through the Attention Engine for this
 * viewer (NOTIFY / WALL / SILENT / IGNORE). It never serves a previous value on
 * its own and it never scans a city: the client names the subjects.
 *
 * WHICH SUBJECTS. The places in the viewer's Live For You strip: the server
 * already chose them as the viewer-relevant, bounded live set, and a moment can
 * only exist where a current live claim does (routes/wallMoments.ts answers no
 * moment for a subject with no current claim). Relevance is `nearby`.
 *
 * THE STATES ARE KEPT APART. Per subject the server says whether it could read
 * the history (`refusal`); a refused subject is "could not be checked", never
 * "nothing changed". `liveIntelligenceReadable: false` means no subject could be
 * looked at. A failed request is `unavailable`, never an empty strip.
 */
import { liveRequest, type LiveCall } from '../../live/liveApi.ts';

export const WALL_MOMENTS_MAX_SUBJECTS = 20;

export interface WallMomentView {
  id: string;
  subject: { kind: 'place'; id: string };
  transition: { kind: string; claimType: string; from: string | null; to: string | null };
  occurredAt: string;
  reason: { code: string; text: string };
  truthClass: string;
  freshness: string;
  expiresAt: string;
  attention: { route: 'NOTIFY' | 'WALL' | 'SILENT' | 'IGNORE' | string; reasons: string[] };
}

export interface WallMomentSubject {
  subjectId: string;
  refusal: string | null;
  moments: number;
}

export type MomentsRead =
  | { state: 'ok'; moments: WallMomentView[]; subjects: WallMomentSubject[]; liveIntelligenceReadable: boolean }
  | { state: 'off' }
  | { state: 'unavailable'; call: Exclude<LiveCall<unknown>, { kind: 'ok' }> };

export async function fetchWallMoments(subjectIds: string[], seen: string[] = []): Promise<MomentsRead> {
  const ids = Array.from(new Set(subjectIds.filter(Boolean))).slice(0, WALL_MOMENTS_MAX_SUBJECTS);
  const qs = new URLSearchParams({ subjectIds: ids.join(','), relevance: 'nearby' });
  if (seen.length > 0) qs.set('seen', seen.slice(0, 200).join(','));
  const call = await liveRequest<any>('GET', `/api/wall/moments?${qs.toString()}`);
  if (call.kind === 'off') return { state: 'off' };
  if (call.kind !== 'ok') return { state: 'unavailable', call };
  const b = call.body;
  if (!Array.isArray(b.moments) || !Array.isArray(b.subjects) || typeof b.liveIntelligenceReadable !== 'boolean') {
    return { state: 'unavailable', call: { kind: 'unavailable', status: call.status, detail: 'unreadable moments response' } };
  }
  return { state: 'ok', moments: b.moments, subjects: b.subjects, liveIntelligenceReadable: b.liveIntelligenceReadable };
}

/** The Attention Engine's placement is obeyed: NOTIFY and WALL moments are shown; SILENT / IGNORE are counted, not shown. */
export function shownMoments(moments: WallMomentView[]): { shown: WallMomentView[]; held: number } {
  const shown = moments.filter((m) => m.attention?.route === 'NOTIFY' || m.attention?.route === 'WALL');
  return { shown, held: moments.length - shown.length };
}

const TRUTH_WORDS: Record<string, string> = {
  observed: 'observed', corroborated: 'corroborated', inferred: 'inferred', predicted: 'predicted',
  conflicting: 'reports differ', stale: 'stale', unknown: 'unconfirmed',
};
export function truthWord(truthClass: string): string {
  return TRUTH_WORDS[truthClass] ?? 'unconfirmed';
}
