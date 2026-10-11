/**
 * resumableUpload — fill a reserved postcard `post_media` slot in fixed-size
 * parts, so a dropped connection or a killed app costs the part in flight, not
 * the whole file (Media spec §37 "Upload resume / retry").
 *
 * THE PROTOCOL (server: artifacts/api-server/src/routes/postcardMediaTransport.ts)
 *   POST <slot>/upload-session            → { chunkBytes, totalBytes, receivedParts,
 *                                             receivedBytes, missingParts: [{index,size,uploadUrl}] }
 *   PUT  <missingParts[i].uploadUrl>        (straight to Storage, one part each)
 *   POST <slot>/upload-session/assemble   → 200 assembled | 409 incomplete
 *
 * THE RESUME TOKEN IS THE SLOT. Asking for the session again LISTS what Storage
 * already holds and signs only what is missing, so the same call resumes after
 * a dropped part, after the signed URLs expired, and after a relaunch: nothing
 * but (postId, mediaId) has to survive on the device.
 *
 * Pure orchestration: the network is injected (ResumableTransport), so this
 * runs under node:test with no react-native. The real transport is
 * uploadHttp.ts.
 */
import { backoffDelayMs, classifyStatus, DEFAULT_RETRY, withRetry, type RetryOptions } from './uploadRetry.ts';

/** What `file.slice()` returns is opaque here — it is handed straight to putPart. */
export interface FileLike {
  size: number;
  slice(start: number, end: number): unknown;
}

export interface ResumableTransport {
  /** An authenticated API call. Must NOT throw on an HTTP error status; throws only when no answer came back. */
  api(method: 'POST' | 'DELETE', path: string, body?: unknown): Promise<{ status: number; body: unknown; retryAfter: string | null }>;
  /** PUT one part to its signed Storage URL. Throws only when no answer came back. */
  putPart(
    url: string,
    part: unknown,
    contentType: string,
    onSent?: (bytes: number) => void, /** census-media §37.8: the slot this part belongs to (slotOwnerKey), so a staged copy can be attributed and swept. */ owner?: string,
  ): Promise<{ status: number; retryAfter: string | null }>; /** MD284 — OPTIONAL: every part handed over AT ONCE (see PutPartsFn at the end of this file). */ putParts?: PutPartsFn;
}

export interface ResumableEnv {
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  retry?: Partial<Omit<RetryOptions, 'sleep' | 'random' | 'isCancelled'>>;
  isCancelled?: () => boolean;
}

export interface SlotRef {
  postId: string;
  mediaId: string;
}

export type ResumableResult =
  | { ok: true; partCount: number; resumedFromBytes: number; /** census-telegraph T223: the assemble answer's body (a message upload's stored-media descriptor). */ assembled?: unknown }
  /** The server cannot run a session for this slot (route absent, or the slot was reserved without a usable size). */
  | { ok: false; unsupported: true; reason: string }
  | { ok: false; unsupported?: false; retryable: boolean; reason: string; cancelled?: boolean };

interface SessionPart {
  index: number;
  size: number;
  uploadUrl: string;
}

interface Session {
  chunkBytes: number;
  totalBytes: number;
  receivedBytes: number;
  missing: SessionPart[];
}

/** Rounds of (session → parts → assemble) before giving up for this run. A later run resumes. */
const MAX_SESSION_ROUNDS = 4;

function sessionPath(slot: SlotRef): string {
  return `/api/postcards/${encodeURIComponent(slot.postId)}/media/${encodeURIComponent(slot.mediaId)}/upload-session`;
}

function errorCode(body: unknown): string | null {
  const e = (body as { error?: unknown } | null)?.error;
  return typeof e === 'string' ? e : null;
}

function parseSession(body: unknown): Session | null {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== 'object') return null;
  const chunkBytes = Number(b.chunkBytes);
  const totalBytes = Number(b.totalBytes);
  const receivedBytes = Number(b.receivedBytes ?? 0);
  if (!Number.isInteger(chunkBytes) || chunkBytes <= 0 || !Number.isInteger(totalBytes) || totalBytes <= 0) return null;
  const missing: SessionPart[] = [];
  for (const raw of Array.isArray(b.missingParts) ? b.missingParts : []) {
    const p = raw as Record<string, unknown>;
    const index = Number(p?.index);
    const size = Number(p?.size);
    const uploadUrl = typeof p?.uploadUrl === 'string' ? p.uploadUrl : '';
    if (!Number.isInteger(index) || index < 0 || !Number.isInteger(size) || size <= 0 || !uploadUrl) return null;
    missing.push({ index, size, uploadUrl });
  }
  missing.sort((a, b) => a.index - b.index);
  return { chunkBytes, totalBytes, receivedBytes: Number.isFinite(receivedBytes) ? receivedBytes : 0, missing };
}

/**
 * Upload `file` into the reserved slot, resuming whatever part of it Storage
 * already holds. `onProgress` receives a fraction in [0, 1] of the WHOLE file,
 * so a resumed upload starts where it left off rather than at 0 %.
 */
export async function uploadSlotResumable(
  slot: SlotRef,
  file: FileLike,
  contentType: string,
  transport: ResumableTransport,
  env: ResumableEnv,
  onProgress?: (fraction: number) => void,
  /**
   * census-telegraph T223: a session that is not a postcard slot (message media). `path` replaces the slot's
   * session path, `body` is sent on the session and assemble calls, and a 404 carrying one of
   * `unsupportedCodes` means "this server does not offer it" (fall back), exactly like a bare 404.
   * Omitted: the postcard behaviour, unchanged.
   */
  sessionOpts?: { path: string; body: unknown; unsupportedCodes?: readonly string[] },
): Promise<ResumableResult> {
  const retry: RetryOptions = {
    ...DEFAULT_RETRY,
    ...env.retry,
    sleep: env.sleep,
    random: env.random,
    isCancelled: env.isCancelled,
  };
  const base = sessionOpts?.path ?? sessionPath(slot);
  const callBody = sessionOpts ? sessionOpts.body : {};
  let resumedFromBytes: number | null = null;

  for (let round = 1; round <= MAX_SESSION_ROUNDS; round++) {
    // ── 1. The session: what landed, and signed URLs for what did not ──────
    const opened = await withRetry<Session | { unsupported: string }>(async () => {
      const r = await transport.api('POST', base, callBody);
      if (r.status === 200) {
        const s = parseSession(r.body);
        return s ? { kind: 'done', value: s } : { kind: 'fail', reason: 'malformed upload session' };
      }
      const code = errorCode(r.body);
      if (r.status === 404 && (code === null || (sessionOpts?.unsupportedCodes ?? []).includes(code))) return { kind: 'done', value: { unsupported: 'resumable upload is not available on this server' } };
      if (r.status === 409) return { kind: 'done', value: { unsupported: 'this upload slot cannot be resumed' } };
      const c = classifyStatus(r.status, r.retryAfter);
      if (c.kind === 'retry') return { kind: 'retry', reason: `session HTTP ${r.status}`, afterMs: c.afterMs };
      return { kind: 'fail', reason: code ?? `session HTTP ${r.status}`, status: r.status };
    }, retry);
    if (!opened.ok) return { ok: false, retryable: opened.retryable, reason: opened.reason, cancelled: opened.cancelled };
    if ('unsupported' in opened.value) return { ok: false, unsupported: true, reason: opened.value.unsupported };
    const session = opened.value;

    // The slot was reserved for a declared size. A different file is not this upload.
    if (session.totalBytes !== file.size) {
      return { ok: false, retryable: false, reason: `the file is ${file.size} bytes but the upload was reserved for ${session.totalBytes}` };
    }
    if (resumedFromBytes === null) resumedFromBytes = session.receivedBytes;
    let sent = session.receivedBytes;
    onProgress?.(Math.min(1, sent / session.totalBytes));

    // ── 2. The missing parts ───────────────────────────────────────────────
    // MD284: a transport that can hand parts to the OS (backgroundTransfer.ts)
    // gets EVERY missing part at once, so the whole remaining file is queued
    // with the OS before the app can be suspended — not just the part in
    // flight. What that batch could not deliver (no answer, 408/425/429/5xx)
    // falls through to the one-at-a-time path below, with its own retries.
    let needFreshUrls = false;
    let pending: SessionPart[] = session.missing;
    if (transport.putParts && pending.length > 1) {
      const batch = await putAllAtOnce(transport.putParts, session, pending, file, contentType, sent, onProgress, slotOwnerKey(slot.postId, slot.mediaId));
      if (batch.kind === 'fail') return { ok: false, retryable: false, reason: batch.reason };
      sent = batch.sent;
      onProgress?.(Math.min(1, sent / session.totalBytes));
      needFreshUrls = batch.needFreshUrls;
      pending = needFreshUrls ? [] : batch.stragglers;
      if (pending.length > 0) {
        await env.sleep(batch.retryAfterMs ?? backoffDelayMs(1, retry, retry.random));
        if (env.isCancelled?.()) return { ok: false, retryable: false, reason: 'cancelled', cancelled: true };
      }
    }
    for (const part of pending) {
      const start = part.index * session.chunkBytes;
      const body = file.slice(start, start + part.size);
      const put = await withRetry<true>(async () => {
        const r = await transport.putPart(part.uploadUrl, body, contentType, (bytes) =>
          onProgress?.(Math.min(1, (sent + Math.min(bytes, part.size)) / session.totalBytes)), slotOwnerKey(slot.postId, slot.mediaId),
        );
        const c = classifyStatus(r.status, r.retryAfter);
        if (c.kind === 'ok') return { kind: 'done', value: true };
        if (c.kind === 'retry') return { kind: 'retry', reason: `part ${part.index} HTTP ${r.status}`, afterMs: c.afterMs };
        return { kind: 'fail', reason: `part ${part.index} HTTP ${r.status}`, status: r.status };
      }, retry);
      if (!put.ok) {
        if (put.cancelled) return { ok: false, retryable: false, reason: 'cancelled', cancelled: true };
        // A refused PUT to a SIGNED url is almost always an expired or consumed
        // signature. The fix is a fresh session, not the same request again.
        if (!put.retryable && (put.status === 400 || put.status === 401 || put.status === 403)) {
          needFreshUrls = true;
          break;
        }
        return { ok: false, retryable: put.retryable, reason: put.reason };
      }
      sent += part.size;
      onProgress?.(Math.min(1, sent / session.totalBytes));
    }
    if (needFreshUrls) continue;

    // ── 3. Assemble; an incomplete answer is another round, not a failure ──
    let assembledBody: unknown = undefined;
    const assembled = await withRetry<'assembled' | 'incomplete'>(async () => {
      const r = await transport.api('POST', `${base}/assemble`, callBody);
      if (r.status >= 200 && r.status < 300) { assembledBody = r.body; return { kind: 'done', value: 'assembled' }; } // a message upload answers 201 with what was stored
      if (r.status === 409) return { kind: 'done', value: 'incomplete' };
      const c = classifyStatus(r.status, r.retryAfter);
      if (c.kind === 'retry') return { kind: 'retry', reason: `assemble HTTP ${r.status}`, afterMs: c.afterMs };
      return { kind: 'fail', reason: errorCode(r.body) ?? `assemble HTTP ${r.status}`, status: r.status };
    }, retry);
    if (!assembled.ok) return { ok: false, retryable: assembled.retryable, reason: assembled.reason, cancelled: assembled.cancelled };
    if (assembled.value === 'assembled') {
      onProgress?.(1);
      return { ok: true, partCount: Math.ceil(session.totalBytes / session.chunkBytes), resumedFromBytes: resumedFromBytes ?? 0, ...(sessionOpts ? { assembled: assembledBody } : {}) };
    }
  }
  return { ok: false, retryable: true, reason: 'the upload did not converge in this run; it will resume' };
}

/** Best-effort: abandon a session (remove the parts). Never throws. */
export async function abandonSlotSession(slot: SlotRef, transport: ResumableTransport, sessionOpts?: { path: string; body: unknown }): Promise<void> {
  try {
    await transport.api('DELETE', sessionOpts?.path ?? sessionPath(slot), sessionOpts?.body);
  } catch {
    // best-effort; the server's orphan sweep removes parts of an abandoned slot
  }
}

// ── MD284: every missing part handed over at once ────────────────────────────
//
// census-media MD284's RED WHEN: "an iOS device build shows a multi-part upload
// completing while the app is suspended from the moment it is backgrounded.
// That needs every missing part enqueued as a background task at once rather
// than serially." Serially, only the part in flight is in the OS's hands when
// iOS suspends the app; the next part is started by JavaScript, which is not
// running. Handing every part over at once is the JS half; whether the OS then
// finishes them while the app is suspended is exactly what only a device run
// can show (census-media §37).

/** One part's outcome from a batch: an HTTP answer, or no answer at all. */
export type PartOutcome = { status: number; retryAfter: string | null } | { error: string };

/**
 * Hand every part to the transport at once and settle them all. `onSent`
 * reports bytes per part, by its position in `parts`. Must not throw; a part
 * that got no answer is `{ error }`. The result has one entry per part, in order.
 */
export type PutPartsFn = (
  parts: Array<{ url: string; part: unknown }>,
  contentType: string,
  onSent?: (position: number, bytes: number) => void,
  /** census-media §37.8: the slot every part belongs to (slotOwnerKey). */
  owner?: string,
) => Promise<PartOutcome[]>;

type BatchResult =
  | { kind: 'fail'; reason: string }
  | { kind: 'ok'; sent: number; stragglers: SessionPart[]; needFreshUrls: boolean; retryAfterMs: number | null };

async function putAllAtOnce(
  putParts: PutPartsFn,
  session: Session,
  parts: SessionPart[],
  file: FileLike,
  contentType: string,
  sentBefore: number,
  onProgress?: (fraction: number) => void,
  owner?: string,
): Promise<BatchResult> {
  const inFlight = new Array<number>(parts.length).fill(0);
  const report = () => onProgress?.(Math.min(1, (sentBefore + inFlight.reduce((a, b) => a + b, 0)) / session.totalBytes));
  let outcomes: PartOutcome[];
  try {
    outcomes = await putParts(
      parts.map((p) => {
        const start = p.index * session.chunkBytes;
        return { url: p.uploadUrl, part: file.slice(start, start + p.size) };
      }),
      contentType,
      (position, bytes) => {
        const p = parts[position];
        if (!p) return;
        inFlight[position] = Math.min(Math.max(0, bytes), p.size);
        report();
      },
      owner,
    );
  } catch (err) {
    outcomes = parts.map(() => ({ error: err instanceof Error ? err.message : 'batch dispatch failed' }));
  }
  let sent = sentBefore;
  const stragglers: SessionPart[] = [];
  let needFreshUrls = false;
  let retryAfterMs: number | null = null;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const o = outcomes[i];
    // A missing entry is the transport breaking its contract: treat it as no answer, never as success.
    if (!o || 'error' in o) {
      stragglers.push(part);
      continue;
    }
    const c = classifyStatus(o.status, o.retryAfter);
    if (c.kind === 'ok') {
      sent += part.size;
      continue;
    }
    if (c.kind === 'retry') {
      stragglers.push(part);
      if (c.afterMs != null) retryAfterMs = Math.max(retryAfterMs ?? 0, c.afterMs);
      continue;
    }
    // Refused by Storage: an expired or consumed signature is fixed by a fresh session.
    if (o.status === 400 || o.status === 401 || o.status === 403) {
      needFreshUrls = true;
      continue;
    }
    return { kind: 'fail', reason: `part ${part.index} HTTP ${o.status}` };
  }
  return { kind: 'ok', sent, stragglers, needFreshUrls, retryAfterMs };
}

/**
 * census-media §37.8 — the one spelling of "which upload slot owns this staged
 * part". The transport writes it into each staged file's NAME
 * (backgroundTransfer.ts), and the queue derives the same key from every job
 * that is still resumable (postcardUploadQueue.liveUploadOwners), so the sweep
 * can tell a live slot's copy from an orphan's. Only [A-Za-z0-9-] survive, so
 * the key is always a safe file-name segment; `~` separates the two ids.
 */
export function slotOwnerKey(postId: string, mediaId: string): string {
  const safe = (s: string) => String(s).replace(/[^A-Za-z0-9-]/g, '_').slice(0, 64) || '_';
  return `${safe(postId)}~${safe(mediaId)}`;
}
