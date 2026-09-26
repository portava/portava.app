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
import { classifyStatus, DEFAULT_RETRY, withRetry, type RetryOptions } from './uploadRetry.ts';

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
    onSent?: (bytes: number) => void,
  ): Promise<{ status: number; retryAfter: string | null }>;
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
  | { ok: true; partCount: number; resumedFromBytes: number }
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
): Promise<ResumableResult> {
  const retry: RetryOptions = {
    ...DEFAULT_RETRY,
    ...env.retry,
    sleep: env.sleep,
    random: env.random,
    isCancelled: env.isCancelled,
  };
  const base = sessionPath(slot);
  let resumedFromBytes: number | null = null;

  for (let round = 1; round <= MAX_SESSION_ROUNDS; round++) {
    // ── 1. The session: what landed, and signed URLs for what did not ──────
    const opened = await withRetry<Session | { unsupported: string }>(async () => {
      const r = await transport.api('POST', base, {});
      if (r.status === 200) {
        const s = parseSession(r.body);
        return s ? { kind: 'done', value: s } : { kind: 'fail', reason: 'malformed upload session' };
      }
      const code = errorCode(r.body);
      if (r.status === 404 && code === null) return { kind: 'done', value: { unsupported: 'resumable upload is not available on this server' } };
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

    // ── 2. The missing parts, each retried on its own ──────────────────────
    let needFreshUrls = false;
    for (const part of session.missing) {
      const start = part.index * session.chunkBytes;
      const body = file.slice(start, start + part.size);
      const put = await withRetry<true>(async () => {
        const r = await transport.putPart(part.uploadUrl, body, contentType, (bytes) =>
          onProgress?.(Math.min(1, (sent + Math.min(bytes, part.size)) / session.totalBytes)),
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
    const assembled = await withRetry<'assembled' | 'incomplete'>(async () => {
      const r = await transport.api('POST', `${base}/assemble`, {});
      if (r.status === 200) return { kind: 'done', value: 'assembled' };
      if (r.status === 409) return { kind: 'done', value: 'incomplete' };
      const c = classifyStatus(r.status, r.retryAfter);
      if (c.kind === 'retry') return { kind: 'retry', reason: `assemble HTTP ${r.status}`, afterMs: c.afterMs };
      return { kind: 'fail', reason: errorCode(r.body) ?? `assemble HTTP ${r.status}`, status: r.status };
    }, retry);
    if (!assembled.ok) return { ok: false, retryable: assembled.retryable, reason: assembled.reason, cancelled: assembled.cancelled };
    if (assembled.value === 'assembled') {
      onProgress?.(1);
      return { ok: true, partCount: Math.ceil(session.totalBytes / session.chunkBytes), resumedFromBytes: resumedFromBytes ?? 0 };
    }
  }
  return { ok: false, retryable: true, reason: 'the upload did not converge in this run; it will resume' };
}

/** Best-effort: abandon a session (remove the parts). Never throws. */
export async function abandonSlotSession(slot: SlotRef, transport: ResumableTransport): Promise<void> {
  try {
    await transport.api('DELETE', sessionPath(slot));
  } catch {
    // best-effort; the server's orphan sweep removes parts of an abandoned slot
  }
}
