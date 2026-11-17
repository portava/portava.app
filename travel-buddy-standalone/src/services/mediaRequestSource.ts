import { currentDiscoveryScope, isCurrentDiscoveryScope, onDiscoveryScopeChange, viewerKeyForToken, type DiscoveryScope } from './discoveryViewerScope.ts';
import { ensureMediaBrowserSession, mediaBrowserOrigin } from './mediaBrowserSession.ts';
import { requestDeadline } from '../lib/requestDeadline.ts';

export type MediaRequestSource = { uri: string; headers?: Record<string, string> };

/** Select the source already resolved for a hydration result. Legacy/public
 * sources can be represented directly; an app relay never falls back to a
 * request missing its authentication contract. */
export function hydratedMediaSource(
  uri: string | null | undefined, sources?: Record<string, MediaRequestSource | null>,
): MediaRequestSource | null {
  if (!uri) return null;
  const source = Object.values(sources ?? {}).find(value => value?.uri === uri);
  return source ?? (claimsDelivery(uri) ? null : { uri });
}

/** A delivery locator contains identity, never an access token. Only the
 * configured app endpoint can receive Authorization headers. */
export function mediaDeliveryLocator(uri: string): { uri: string; viewerId: string } | null {
  try {
    const base = new URL(process.env.EXPO_PUBLIC_API_BASE_URL || mediaBrowserOrigin() || '');
    const url = new URL(uri, base);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
    if (base.username || base.password || base.search || base.hash || base.pathname !== '/'
      || base.protocol !== 'https:' && !(base.protocol === 'http:' && local)
      || url.origin !== base.origin || url.username || url.password || url.hash
      || !/^\/api\/media\/file\/(post-media|profile-media)\/.+/.test(url.pathname)) return null;
    const viewerId = url.searchParams.get('viewer');
    if (!viewerId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(viewerId)
      || url.searchParams.getAll('viewer').length !== 1
      || [...url.searchParams.keys()].some(key => !['viewer', 'width', 'quality'].includes(key))) return null;
    const path = decodeURIComponent(url.pathname.slice('/api/media/file/'.length));
    if (/[\\\u0000-\u001f\u007f]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) return null;
    return { uri: url.href, viewerId };
  } catch { return null; }
}

/** Does the value claim to be an app relay, including malformed/foreign ones?
 * Those are refused, not passed through as unauthenticated public media. */
function claimsDelivery(uri: string): boolean {
  try { return new URL(uri, process.env.EXPO_PUBLIC_API_BASE_URL || mediaBrowserOrigin() || undefined).pathname.startsWith('/api/media/file/'); }
  catch { return uri.includes('/api/media/file/'); }
}

export function mediaRequestSource(
  uri: string, token: string | null, scope: DiscoveryScope,
): MediaRequestSource | null {
  if (!isCurrentDiscoveryScope(scope)) return null;
  const delivery = mediaDeliveryLocator(uri);
  if (!delivery) return claimsDelivery(uri) ? null : { uri };
  if (!token || scope.viewer !== `u:${delivery.viewerId}` || viewerKeyForToken(token) !== scope.viewer || !isCurrentDiscoveryScope(scope)) return null;
  return { uri: delivery.uri, headers: { Authorization: `Bearer ${token}` } };
}

/** Build native/image request sources without caching bearer credentials in
 * the URL cache. Web AV session installation is a separate same-origin step;
 * its sources keep the same viewer-bound URL and server authorization path. */
export async function resolveMediaRequestSources(
  resolved: Record<string, string | null>,
): Promise<Record<string, MediaRequestSource | null>> {
  const scope = currentDiscoveryScope();
  const delivery = Object.values(resolved).some(uri => uri !== null && claimsDelivery(uri));
  let token: string | null = null;
  if (delivery) {
    const cancelled = new AbortController();
    const unsubscribe = onDiscoveryScopeChange(() => cancelled.abort());
    const budget = requestDeadline(10_000, cancelled.signal);
    try {
      // Keep the native session module lazy while using Metro/Jest's shared
      // CommonJS loader (the component runner does not enable VM ESM imports).
      const { freshToken, isCurrentSessionToken } = require('./apiToken.ts') as typeof import('./apiToken.ts');
      token = await budget.wait(() => freshToken());
      const viewerId = scope.viewer?.startsWith('u:') ? scope.viewer.slice(2) : null;
      if (!token || !viewerId || !await budget.wait(() => isCurrentSessionToken(viewerId, token!))) token = null;
      if (token && viewerId && mediaBrowserOrigin() && !await budget.wait(() => ensureMediaBrowserSession(viewerId))) token = null;
    } catch { token = null; }
    finally { budget.dispose(); unsubscribe(); }
  }
  if (!isCurrentDiscoveryScope(scope)) return Object.fromEntries(Object.keys(resolved).map(key => [key, null]));
  return Object.fromEntries(Object.entries(resolved).map(([key, uri]) => [key, uri === null ? null : mediaRequestSource(uri, token, scope)]));
}
