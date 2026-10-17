/**
 * Telegraph §30A.8 link previews — the client's half (census-telegraph T404;
 * the server's doors are `artifacts/api-server/src/routes/telegraphLinkPreview.ts`,
 * migration 3825, flag `telegraph_link_previews_enabled` seeded FALSE).
 *
 *   POST /api/threads/:threadId/messages/:messageId/link-preview
 *        The SENDER, right after their send answered, asks the server to make
 *        the preview. The request carries no URL: the server reads the stored
 *        body itself, fetches once, and stores text only.
 *   GET  /api/threads/:threadId/link-previews?ids=…   (at most 50)
 *        Everyone reads stored previews. This door never fetches anything.
 *
 * T446 holds on this side too: a preview is TEXT (host, title, description,
 * site name). No image field exists on the wire and none is drawn, so drawing a
 * preview makes no request to the linked site; opening the link is the
 * viewer's own tap.
 *
 * Pure module — no React — safe under node:test.
 */
import { isSupabaseConfigured } from '../../../lib/supabase.ts';
import { freshToken } from '../../../services/apiToken.ts';

/** The server's flag (routes/telegraphLinkPreview.ts reads the same name). */
export const LINK_PREVIEWS_FLAG = 'telegraph_link_previews_enabled';
/** The GET's own cap (services/telegraph/linkPreviews.ts LINK_PREVIEW_BATCH_MAX). */
export const LINK_PREVIEW_BATCH_MAX = 50;

/** The wire shape the server serves (services/telegraph/linkPreviews.ts WirePreview). */
export interface LinkPreview {
  messageId: string;
  url: string;
  host: string;
  title: string;
  description: string;
  siteName: string;
}

export type LinkPreviewPostAnswer =
  | { kind: 'preview'; preview: LinkPreview }
  | { kind: 'no_preview'; reason: string };

export type LinkPreviewResult<T> = { ok: true; data: T } | { ok: false; error: string };

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

const isStr = (v: unknown): v is string => typeof v === 'string';

/** A body that is not exactly the wire shape is not a preview. */
export function parseLinkPreview(v: unknown): LinkPreview | null {
  if (!v || typeof v !== 'object') return null;
  const p = v as Record<string, unknown>;
  if (!isStr(p.messageId) || !isStr(p.url) || !isStr(p.host) || !isStr(p.title) || !isStr(p.description) || !isStr(p.siteName)) return null;
  if (!/^https:\/\//i.test(p.url) || p.host.length === 0) return null;
  return { messageId: p.messageId, url: p.url, host: p.host, title: p.title, description: p.description, siteName: p.siteName };
}

/**
 * Worth asking about? The server decides (it reads the STORED body and takes
 * its first external https link); this only spares a request for a message that
 * plainly has no link at all.
 */
export function mayHaveLink(body: string | null | undefined): boolean {
  return typeof body === 'string' && /https:\/\/\S/i.test(body);
}

async function call(method: 'GET' | 'POST', path: string): Promise<LinkPreviewResult<unknown>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'unconfigured' };
  const token = await freshToken();
  if (!token) return { ok: false, error: 'unauthenticated' };
  try {
    const res = await fetch(`${apiBase()}${path}`, { method, headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return { ok: false, error: String(res.status) };
    return { ok: true, data: await res.json() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'network' };
  }
}

/** The sender's door. Never carries a URL. */
export async function requestLinkPreview(threadId: string, messageId: string): Promise<LinkPreviewResult<LinkPreviewPostAnswer>> {
  const r = await call('POST', `/api/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}/link-preview`);
  if (!r.ok) return r;
  const b = r.data as Record<string, unknown> | null;
  if (b?.kind === 'preview') {
    const preview = parseLinkPreview(b.preview);
    return preview && preview.messageId === messageId ? { ok: true, data: { kind: 'preview', preview } } : { ok: false, error: 'malformed' };
  }
  if (b?.kind === 'no_preview' && isStr(b.reason)) return { ok: true, data: { kind: 'no_preview', reason: b.reason } };
  return { ok: false, error: 'malformed' };
}

/** The readers' door, for at most LINK_PREVIEW_BATCH_MAX ids. Only previews for the ids asked are kept. */
export async function fetchLinkPreviews(threadId: string, ids: readonly string[]): Promise<LinkPreviewResult<LinkPreview[]>> {
  const asked = [...new Set(ids)].slice(0, LINK_PREVIEW_BATCH_MAX);
  if (asked.length === 0) return { ok: true, data: [] };
  const r = await call('GET', `/api/threads/${encodeURIComponent(threadId)}/link-previews?ids=${asked.map(encodeURIComponent).join(',')}`);
  if (!r.ok) return r;
  const list = (r.data as { previews?: unknown } | null)?.previews;
  if (!Array.isArray(list)) return { ok: false, error: 'malformed' };
  const wanted = new Set(asked);
  return { ok: true, data: list.map(parseLinkPreview).filter((p): p is LinkPreview => p !== null && wanted.has(p.messageId)) };
}
