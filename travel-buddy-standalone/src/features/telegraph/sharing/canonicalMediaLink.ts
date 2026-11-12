import { canonicalOrigin } from '../../../constants/canonicalUrl.ts';

export type MediaShareRef = { objectType: 'POST' | 'MEDIA'; objectId: string };
const route = /^\/(posts?|media-viewer)\/([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})\/?$/i;

/** Only an app permalink on its own final line represents a shared object. */
export function canonicalMediaLink(body: string | null | undefined): (MediaShareRef & { caption: string | null }) | null {
  if (!body?.trim()) return null;
  const lines = body.trim().split('\n');
  const last = lines.pop()?.trim();
  if (!last || /\s/.test(last)) return null;
  try {
    const url = new URL(last);
    if (url.origin !== new URL(canonicalOrigin()).origin || url.username || url.password) return null;
    const matched = route.exec(url.pathname);
    if (!matched) return null;
    return { objectType: matched[1].toLowerCase() === 'media-viewer' ? 'MEDIA' : 'POST', objectId: matched[2], caption: lines.join('\n').trim() || null };
  } catch { return null; }
}
