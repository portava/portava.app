import { canonicalUrl } from './canonicalUrl.ts';

export const POST_REFERENCE_MEDIA_TYPE = 'application/vnd.portava.post-reference+json';
export const POST_REFERENCE_PREFIX = 'portava-post-reference:';
export const POST_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The prior composer produced exactly this URL. Ordinary text containing a URL stays text. */
export function legacySharedPostId(content?: string | null): string | null {
  const text = content?.trim() ?? '';
  const prefix = canonicalUrl('/posts/');
  if (!text.startsWith(prefix)) return null;
  const id = text.slice(prefix.length);
  return POST_UUID.test(id) ? id : null;
}
