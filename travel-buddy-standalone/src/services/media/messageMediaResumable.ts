/**
 * Resumable MESSAGE-media upload, the client half (census-telegraph T223;
 * server: artifacts/api-server/src/routes/messageMediaTransport.ts, migration
 * 3656, flag seeded OFF).
 *
 * The postcard part protocol (resumableUpload.ts) pointed at the message
 * session: POST /api/media/upload-session with { uploadId, mimeType,
 * totalBytes }, 4 MiB parts PUT straight to signed Storage URLs, then assemble —
 * which answers with the SAME descriptor POST /api/media/upload returns, so the
 * message send that follows is unchanged.
 *
 * THE RESUME TOKEN IS THE UPLOAD ID. The caller keeps one id per picked file and
 * passes it again on retry; the server lists what already landed under that id
 * and signs only what is missing, so a retry after a dropped connection costs
 * the part in flight, not the whole file (the census row's complaint: "retry
 * restarts the transfer").
 *
 * UNSUPPORTED IS REMEMBERED. A server without the capability answers 404
 * not_found; this module then reports `unsupported` (the caller uses the
 * single-request upload) and does not probe again for the rest of the app run,
 * so a deployment with the flag OFF pays one extra request per app run at most.
 */
import { uploadSlotResumable, abandonSlotSession, type FileLike, type ResumableEnv, type ResumableTransport } from './resumableUpload.ts';

export const MESSAGE_UPLOAD_SESSION_PATH = '/api/media/upload-session';

let unsupportedThisRun = false;
/** Test seam. */
export function _resetMessageResumableSupport(): void { unsupportedThisRun = false; }
export function messageResumableKnownUnsupported(): boolean { return unsupportedThisRun; }

export interface StoredMediaDescriptor {
  url: string;
  path: string | null;
  thumbnailUrl: string | null;
  width: number | null;
  height: number | null;
  processed: boolean;
  durationSeconds: number | null;
}

export type MessageResumableOutcome =
  | { kind: 'stored'; media: StoredMediaDescriptor; resumedFromBytes: number }
  | { kind: 'unsupported' }
  | { kind: 'failed'; retryable: boolean; message: string; cancelled?: boolean };

function sessionBody(uploadId: string, mimeType: string, totalBytes: number) {
  return { uploadId, mimeType, totalBytes };
}

export async function uploadMessageMediaResumable(
  file: FileLike,
  mimeType: string,
  uploadId: string,
  transport: ResumableTransport,
  env: ResumableEnv,
  onProgress?: (fraction: number) => void,
): Promise<MessageResumableOutcome> {
  if (unsupportedThisRun) return { kind: 'unsupported' };
  const r = await uploadSlotResumable(
    { postId: 'message', mediaId: uploadId },
    file, mimeType, transport, env, onProgress,
    { path: MESSAGE_UPLOAD_SESSION_PATH, body: sessionBody(uploadId, mimeType, file.size), unsupportedCodes: ['not_found'] },
  );
  if (r.ok) {
    const b = (r.assembled ?? {}) as Record<string, unknown>;
    const url = typeof b.url === 'string' ? b.url : null;
    if (!url) return { kind: 'failed', retryable: false, message: 'Upload finished but no media URL came back.' };
    return {
      kind: 'stored',
      resumedFromBytes: r.resumedFromBytes,
      media: {
        url,
        path: typeof b.path === 'string' ? b.path : null,
        thumbnailUrl: typeof b.thumbnailUrl === 'string' ? b.thumbnailUrl : null,
        width: typeof b.width === 'number' ? b.width : null,
        height: typeof b.height === 'number' ? b.height : null,
        processed: b.processed === true,
        durationSeconds: typeof b.durationSeconds === 'number' ? b.durationSeconds : null,
      },
    };
  }
  if ('unsupported' in r && r.unsupported) {
    unsupportedThisRun = true;
    return { kind: 'unsupported' };
  }
  const f = r as { retryable: boolean; reason: string; cancelled?: boolean };
  return { kind: 'failed', retryable: f.retryable, message: f.reason, cancelled: f.cancelled };
}

/** Best-effort: drop the parts of an upload the person discarded. Never throws. */
export async function abandonMessageMediaUpload(uploadId: string, mimeType: string, totalBytes: number, transport: ResumableTransport): Promise<void> {
  if (unsupportedThisRun) return;
  await abandonSlotSession({ postId: 'message', mediaId: uploadId }, transport, { path: MESSAGE_UPLOAD_SESSION_PATH, body: sessionBody(uploadId, mimeType, totalBytes) });
}

/** A fresh upload id (uuid v4): one per picked file, reused on every retry of that file. */
export function newUploadId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const h = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `${h()}${h()}-${h()}-4${h().slice(1)}-${(8 + Math.floor(Math.random() * 4)).toString(16)}${h().slice(1)}-${h()}${h()}${h()}`;
}

/**
 * The upload id for a picked file: the same id for the same file across
 * retries (that is what makes a retry RESUME), a new one for a new file.
 */
export function uploadIdFor(prev: { key: string; id: string } | null, fileKey: string, mint: () => string = newUploadId): { key: string; id: string } {
  return prev && prev.key === fileKey ? prev : { key: fileKey, id: mint() };
}
