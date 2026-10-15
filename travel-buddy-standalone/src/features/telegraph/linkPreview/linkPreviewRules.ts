/**
 * Telegraph §30A.8 link previews — the client's rules (census-telegraph T404 /
 * T446; server half B58 TM-1: `artifacts/api-server/src/routes/telegraphLinkPreview.ts`,
 * migration 3825, flag `telegraph_link_previews_enabled` seeded FALSE).
 *
 * THE CONTRACT THE CLIENT KEEPS (B58 TM-2):
 *   - A recipient's device never contacts the linked site, or any third party,
 *     for a preview. It asks OUR API for the previews the server STORED
 *     (`GET /api/threads/:id/link-previews?ids=…`, message ids only) and draws
 *     their text. A preview has no image field (Q-LP5), so there is nothing a
 *     page could make the device load.
 *   - No URL taken from a message ever leaves the device: the read sends
 *     message ids, the sender's request sends the message id, and the server
 *     reads the link from the body it stored. `bodyHasExternalLink` below only
 *     decides whether there is anything worth asking about.
 *   - The sender's device asks the server to make the preview once, right
 *     after a successful send or edit, only while the flag is ON, never for an
 *     end-to-end-encrypted thread, with bounded retries. A recipient never does.
 *   - Flag OFF ⇒ nothing is drawn and no preview request is made, read or write.
 *   - The link opens only when the person taps it, and only if it is the https
 *     link to the host the preview names (`isOpenablePreviewLink`).
 */

export const LINK_PREVIEW_FLAG = 'telegraph_link_previews_enabled';

/** What `GET /threads/:id/link-previews` serves per message (`services/telegraph/linkPreviews.ts#WirePreview`). Text only. */
export interface WirePreview {
  messageId: string;
  url: string;
  host: string;
  title: string;
  description: string;
  siteName: string;
}

// The server's extraction (`services/telegraph/linkPreviews.ts#URL_TOKEN`) without the
// lookbehind, which the release JS engine is not guaranteed to have.
const URL_TOKEN = /(^|[^A-Za-z0-9+.-])https?:\/\/[^\s<>"'`]+/i;

/**
 * Does this body contain an http(s) link at all? Decides only whether the
 * device should ASK; which link (the first external https one) and whether it
 * may be fetched is the server's decision, made from the stored body.
 */
export function bodyHasExternalLink(body: unknown): boolean {
  return typeof body === 'string' && body.length > 0 && URL_TOKEN.test(body);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A server message id (an optimistic message's id is its client id until the server answers). */
export function isServerMessageId(id: unknown, clientId?: unknown): boolean {
  return typeof id === 'string' && UUID.test(id) && id !== clientId;
}

/** The fields of a message this module reads (a subset of `services/messaging.ts#Message`). */
export interface PreviewableMessage {
  id: string;
  clientId?: string | null;
  senderId?: string | null;
  body: string | null;
  originalBody?: string | null;
  msgType?: string | null;
  subtype?: string | null;
  deleted?: boolean;
  createdAt?: string | null;
  editedAt?: string | null;
  ciphertext?: string | null;
  e2eeFailed?: boolean;
  deliveryStatus?: 'sending' | 'sent' | 'failed';
}

/** A plain text message: no structured kind (the server's `isPreviewableKind`). An absent type is text. */
export function isPlainTextKind(msgType: unknown, subtype: unknown): boolean {
  return (msgType ?? 'text') === 'text' && (subtype ?? null) === null;
}

/**
 * May the device ask about a preview for this message at all? A plain text
 * message (the server's `isPreviewableKind`), stored on the server (a real
 * id, not sending or failed), live, NOT end-to-end encrypted (it carries no
 * ciphertext and did not fail to decrypt), whose original body has a link.
 */
export function messageMayHavePreview(m: PreviewableMessage | null | undefined): boolean {
  if (!m) return false;
  if (!isPlainTextKind(m.msgType, m.subtype)) return false;
  if (m.deleted) return false;
  if (m.ciphertext || m.e2eeFailed) return false;
  if (m.deliveryStatus === 'sending' || m.deliveryStatus === 'failed') return false;
  if (!isServerMessageId(m.id, m.clientId)) return false;
  return bodyHasExternalLink(m.originalBody ?? m.body);
}

/** The version of a message's body a preview describes: an edit is a new version. */
export function bodyVersion(m: Pick<PreviewableMessage, 'editedAt'>): string {
  return typeof m.editedAt === 'string' ? m.editedAt : '';
}

/** When the body was last written (sent or edited), ms; NaN when unknown. */
export function bodyWrittenAtMs(m: Pick<PreviewableMessage, 'createdAt' | 'editedAt'>): number {
  const c = typeof m.createdAt === 'string' ? Date.parse(m.createdAt) : NaN;
  const e = typeof m.editedAt === 'string' ? Date.parse(m.editedAt) : NaN;
  if (Number.isNaN(c)) return Number.isNaN(e) ? NaN : e;
  return Number.isNaN(e) ? c : Math.max(c, e);
}

const HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/**
 * A stored preview the device may draw: every text field a string, a host that
 * is a plain (punycode) DNS name, and a url that is the https link to exactly
 * that host. Anything else is not drawn — a malformed answer is never shown as
 * a link.
 */
export function isDrawablePreview(p: unknown): p is WirePreview {
  if (!p || typeof p !== 'object') return false;
  const w = p as Record<string, unknown>;
  for (const k of ['messageId', 'url', 'host', 'title', 'description', 'siteName']) {
    if (typeof w[k] !== 'string') return false;
  }
  return isOpenablePreviewLink(w.url as string, w.host as string);
}

/**
 * The url opens only when it is `https://<host>` followed by a path, query,
 * fragment or nothing — decided by prefix, so no URL parser's reading of the
 * authority matters — and contains no whitespace, control character or
 * backslash. The host is the one the preview names, shown before the tap.
 */
export function isOpenablePreviewLink(url: string, host: string): boolean {
  if (typeof url !== 'string' || typeof host !== 'string') return false;
  const h = host.toLowerCase();
  if (!HOST.test(h) || h.length > 253) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\s\\\u0000-\u001f\u007f]/.test(url) || url.length > 2048) return false;
  const prefix = `https://${h}`;
  if (url.slice(0, prefix.length).toLowerCase() !== prefix) return false;
  const rest = url.slice(prefix.length);
  return rest === '' || rest[0] === '/' || rest[0] === '?' || rest[0] === '#';
}
