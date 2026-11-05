import { canonicalOrigin, CANONICAL_APP_URL } from '../../../constants/canonicalUrl.ts';
import { sendDiscoveryWrite } from '../shared/discoveryApi.ts';

export interface TrailSource { sourceType: 'post' | 'place' | 'event' | 'route'; sourceId: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE_PATHS: Record<string, TrailSource['sourceType']> = {
  post: 'post', posts: 'post', place: 'place', places: 'place', event: 'event', events: 'event', route: 'route', routes: 'route',
};

/** Parse only app-owned links. Visibility and ownership are checked again by the server. */
export function trailSourceFromLink(value: string): TrailSource | null {
  try {
    const url = new URL(value.trim());
    let path: string;
    if (url.protocol === 'travelbuddy:') path = `/${url.hostname}${url.pathname}`;
    else {
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
      if (![canonicalOrigin(), CANONICAL_APP_URL].includes(url.origin)) return null;
      path = url.pathname;
    }
    const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
    const type = Object.hasOwn(SOURCE_PATHS, parts[0]) ? SOURCE_PATHS[parts[0]] : undefined;
    if (!type || parts.length !== 2 || !UUID.test(parts[1])) return null;
    return { sourceType: type, sourceId: parts[1].toLowerCase() };
  } catch { return null; }
}

export type ContributionResult = { state: 'added' | 'suggested' } | { state: 'failed'; detail: string };

export async function contributeToTrail(trailId: string, source: TrailSource, relationship: 'primary' | 'supporting'): Promise<ContributionResult> {
  const answer = await sendDiscoveryWrite<{ attached?: number; suggested?: number }>('POST',
    `/api/v1/discovery/trails/${encodeURIComponent(trailId)}/suggestions`,
    { labels: [{ ...source, relationship }] });
  if (answer.state === 'done') {
    if ((answer.data?.attached ?? 0) > 0) return { state: 'added' };
    if ((answer.data?.suggested ?? 0) > 0) return { state: 'suggested' };
    return { state: 'failed', detail: 'The result could not be confirmed. Please try again.' };
  }
  if (answer.state === 'refused') {
    const reasons: Record<string, string> = {
      content_refused: 'This item is unavailable or cannot be added to this Trail.',
      label_cap_refused: 'This item has reached its Trail limit. Try a different item or relationship.',
      feature_disabled: 'Trail contributions are currently unavailable.',
      trust_restricted: 'Your account cannot contribute right now. Check your account restrictions.',
    };
    return { state: 'failed', detail: reasons[answer.reason] ?? 'This contribution was not accepted. Check the item and try again.' };
  }
  return { state: 'failed', detail: 'The contribution could not be confirmed. Please try again.' };
}
