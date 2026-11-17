import assert from 'node:assert/strict';

export type MediaDeliveryRead = { bucket: string; path: string; options?: { transform: { width?: number; quality?: number; resize: string } }; url: URL };

/** A provider byte fixture: exercises the real route and stream transport,
 * asserts the private provider credential stays on the configured upstream,
 * and records actual transform requests. It never supplies a signed URL. */
export function installMediaDeliveryFixture(
  onRead: (read: MediaDeliveryRead) => void = () => {},
  provide?: (read: MediaDeliveryRead, method: string) => Response,
) {
  const originalFetch = globalThis.fetch;
  const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'synthetic-media-fixture-service-key';
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const configured = new URL(process.env.SUPABASE_URL!);
    if (url.origin !== configured.origin) return originalFetch(input, init);
    const match = /^\/storage\/v1\/(object|render\/image\/authenticated)\/(post-media|profile-media)\/(.+)$/.exec(url.pathname);
    assert.ok(match, `unexpected provider path: ${url.pathname}`);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), 'Bearer synthetic-media-fixture-service-key');
    assert.equal(headers.get('apikey'), 'synthetic-media-fixture-service-key');
    assert.equal(init?.redirect, 'error');
    const transform = match[1] === 'object' ? undefined : {
      ...(url.searchParams.has('width') ? { width: Number(url.searchParams.get('width')) } : {}),
      ...(url.searchParams.has('quality') ? { quality: Number(url.searchParams.get('quality')) } : {}),
      resize: url.searchParams.get('resize')!,
    };
    const read = { bucket: match[2]!, path: decodeURIComponent(match[3]!), options: transform ? { transform } : undefined, url };
    onRead(read);
    if (provide) return provide(read, init?.method ?? 'GET');
    return new Response(init?.method === 'HEAD' ? null : 'media-fixture-bytes', { headers: { 'Content-Type': 'image/jpeg', 'Content-Length': '19' } });
  };
  return () => {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey;
  };
}
