/**
 * Telegraph §30A.8 link previews — the two calls the client makes, both to OUR
 * API (census-telegraph T404 / T446; server: `routes/telegraphLinkPreview.ts`).
 *
 *   GET  /api/threads/:threadId/link-previews?ids=<uuid>,…   (≤ 50 ids)
 *        Any member reads what the server STORED. The request carries message
 *        ids only; the server never fetches on this door.
 *
 *   POST /api/threads/:threadId/messages/:messageId/link-preview
 *        The SENDER, right after a send or an edit, asks the server to make the
 *        preview for that message. The request has NO body: the server reads the
 *        link from the body it stored, so no URL from a message ever leaves the
 *        device, and an end-to-end-encrypted thread (whose body the server never
 *        holds) cannot have one.
 *
 * `requestPreviewAfterWrite` is the only caller of the POST. It is reached from
 * `services/messaging.ts` (`sendMessage`, `editThreadMessage`) after the server
 * accepted the write, and it does nothing unless the flag is ON on the server's
 * last answer (`context/featureFlagSnapshot.ts`), the thread is not E2EE, the
 * message is a plain text message with a link, and this message version has not
 * already been asked about. Retries are bounded (`SENDER_RETRY_DELAYS_MS`) and
 * only for answers that say "try again" (429, 5xx, no network).
 */
import { freshToken } from '../../../services/apiToken.ts';
import { featureFlagEnabledNow } from '../../../context/featureFlagSnapshot.ts';
import { LINK_PREVIEW_FLAG, bodyHasExternalLink, isDrawablePreview, isServerMessageId, type WirePreview } from './linkPreviewRules.ts';
import { LinkPreviewStore } from './linkPreviewStore.ts';

/** The server's per-read cap (`services/telegraph/linkPreviews.ts#LINK_PREVIEW_BATCH_MAX`). */
export const LINK_PREVIEW_BATCH_MAX = 50;

/** Delays before the 2nd and 3rd attempt of the sender's request. Three attempts at most. */
export const SENDER_RETRY_DELAYS_MS: readonly number[] = [3_000, 10_000];

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

export type PreviewsRead = { ok: true; previews: WirePreview[] } | { ok: false };

/** GET the stored previews of up to 50 messages. Message ids are the only thing sent. */
export async function fetchLinkPreviews(threadId: string, messageIds: readonly string[]): Promise<PreviewsRead> {
  if (!apiBase() || messageIds.length === 0 || messageIds.length > LINK_PREVIEW_BATCH_MAX) return { ok: false };
  if (!isServerMessageId(threadId) || !messageIds.every((id) => isServerMessageId(id))) return { ok: false };
  const token = await freshToken();
  if (!token) return { ok: false };
  try {
    const res = await fetch(`${apiBase()}/api/threads/${threadId}/link-previews?ids=${messageIds.join(',')}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { ok: false };
    const json = (await res.json().catch(() => null)) as { previews?: unknown } | null;
    if (!json || !Array.isArray(json.previews)) return { ok: false };
    return { ok: true, previews: json.previews.filter(isDrawablePreview) };
  } catch {
    return { ok: false };
  }
}

export type PostAnswer =
  | { kind: 'preview'; preview: WirePreview }
  | { kind: 'no_preview'; reason: string }
  | { kind: 'error'; retryable: boolean };

/** POST the sender's request. No body. */
export async function postLinkPreview(threadId: string, messageId: string): Promise<PostAnswer> {
  if (!apiBase() || !isServerMessageId(threadId) || !isServerMessageId(messageId)) return { kind: 'error', retryable: false };
  const token = await freshToken();
  if (!token) return { kind: 'error', retryable: false };
  let res: Response;
  try {
    res = await fetch(`${apiBase()}/api/threads/${threadId}/messages/${messageId}/link-preview`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    return { kind: 'error', retryable: true };
  }
  if (!res.ok) return { kind: 'error', retryable: res.status === 429 || res.status >= 500 };
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (json?.kind === 'preview' && isDrawablePreview(json.preview)) return { kind: 'preview', preview: json.preview };
  if (json?.kind === 'no_preview') return { kind: 'no_preview', reason: typeof json.reason === 'string' ? json.reason : 'none' };
  return { kind: 'error', retryable: false };
}

/** What the send path hands over once the server accepted a write. */
export interface WrittenMessage {
  threadId: string;
  messageId: string;
  /** The body the server stored (or the one just sent); read only to see whether it has a link. */
  body: string | null | undefined;
  msgType?: string | null;
  subtype?: string | null;
  /** The write's `editedAt` — '' for a fresh send. Each version is asked about once. */
  version: string;
  /** True for a thread with `is_e2ee`, or a message that carries ciphertext. */
  encrypted: boolean;
}

/** The app's one store of stored previews (the hook and the sender's request share it). */
export const linkPreviewStore = new LinkPreviewStore({
  fetchPreviews: fetchLinkPreviews,
  now: () => Date.now(),
  schedule: (fn, ms) => setTimeout(fn, ms),
  batchMax: LINK_PREVIEW_BATCH_MAX,
});

export interface SenderDeps {
  post: (threadId: string, messageId: string) => Promise<PostAnswer>;
  flagOn: () => boolean;
  schedule: (fn: () => void, ms: number) => unknown;
  store: Pick<LinkPreviewStore, 'seed'>;
}

const defaultSenderDeps: SenderDeps = {
  post: postLinkPreview,
  flagOn: () => featureFlagEnabledNow(LINK_PREVIEW_FLAG),
  schedule: (fn, ms) => setTimeout(fn, ms),
  store: linkPreviewStore,
};

const asked = new Set<string>();
const ASKED_MAX = 2000;

/**
 * The sender's half: ask the server to make this message's preview, once.
 * Returns true when a request was started. Never throws, never blocks the send.
 */
export function requestPreviewAfterWrite(m: WrittenMessage, deps: SenderDeps = defaultSenderDeps): boolean {
  if (!deps.flagOn()) return false;
  if (m.encrypted) return false;
  if ((m.msgType ?? 'text') !== 'text' || (m.subtype ?? null) !== null) return false;
  if (!isServerMessageId(m.threadId) || !isServerMessageId(m.messageId)) return false;
  if (!bodyHasExternalLink(m.body)) return false;
  const key = `${m.messageId}\u0000${m.version}`;
  if (asked.has(key)) return false;
  if (asked.size >= ASKED_MAX) asked.clear();
  asked.add(key);

  const attempt = (n: number): void => {
    void deps.post(m.threadId, m.messageId).then((answer) => {
      if (answer.kind === 'preview') { deps.store.seed(m.threadId, m.messageId, m.version, answer.preview); return; }
      if (answer.kind === 'no_preview') { deps.store.seed(m.threadId, m.messageId, m.version, null); return; }
      if (answer.retryable && n < SENDER_RETRY_DELAYS_MS.length) deps.schedule(() => attempt(n + 1), SENDER_RETRY_DELAYS_MS[n]);
    }, () => { /* post never rejects; a defect here must not reach the send */ });
  };
  attempt(0);
  return true;
}

/** Tests only. */
export function _resetSenderRequests(): void {
  asked.clear();
}

/**
 * `services/messaging.ts#sendMessage`, after the server answered: hands the
 * stored message to `requestPreviewAfterWrite` and returns the answer unchanged.
 * Never throws — a preview must never cost a send.
 */
export function previewAfterSend<R extends { ok: boolean; data: unknown }>(threadId: string, res: R, sentBody: string, encrypted: boolean): R {
  try {
    const m = res.ok ? (res.data as Record<string, unknown> | null) : null;
    if (m && typeof m.id === 'string') {
      requestPreviewAfterWrite({
        threadId: typeof m.threadId === 'string' ? m.threadId : threadId,
        messageId: m.id,
        body: typeof m.body === 'string' ? m.body : encrypted ? null : sentBody,
        msgType: typeof m.msgType === 'string' ? m.msgType : null,
        subtype: typeof m.subtype === 'string' ? m.subtype : null,
        version: typeof m.editedAt === 'string' ? m.editedAt : '',
        encrypted: encrypted || !!m.ciphertext,
      });
    }
  } catch { /* never reaches the send */ }
  return res;
}

/**
 * `services/messaging.ts#editThreadMessage`, after the server accepted an edit
 * (the canonical edit route refuses an end-to-end-encrypted thread, so an
 * accepted edit is plaintext): the edited body is a new version, asked about once.
 */
export function previewAfterEdit<R extends { ok: boolean; data: unknown }>(threadId: string, messageId: string, editedBody: string, res: R): R {
  try {
    const e = res.ok ? (res.data as Record<string, unknown> | null) : null;
    if (e && typeof e.editedAt === 'string') {
      requestPreviewAfterWrite({
        threadId,
        messageId,
        body: typeof e.body === 'string' ? e.body : editedBody,
        msgType: 'text',
        subtype: null,
        version: e.editedAt,
        encrypted: false,
      });
    }
  } catch { /* never reaches the edit */ }
  return res;
}
