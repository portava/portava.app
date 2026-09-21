/**
 * Telegraph §6.2 VOICE — the two calls the composer makes.
 *
 *   POST /api/telegraph/voice/upload    raw M4A bytes  → a storage path
 *   POST /api/threads/:id/voice         the path + meta → the message
 *
 * TWO CALLS AND NOT ONE, and the split is the server's: the upload is
 * rate-limited, sniffed and location-scrubbed before anything is written, and
 * the send re-checks thread membership at the moment the row is written. A
 * single call would have had to choose which of those two moments to do the
 * membership check at, and either choice is wrong.
 *
 * WHAT HAPPENS WHEN A SEND FAILS AFTER AN UPLOAD SUCCEEDS: nothing is written
 * to the thread and the uploaded object is left in storage, unreferenced. That
 * is the same behaviour the photo and video paths have had since they were
 * built — `POST /api/media/upload` then `POST /threads/:id/media` — and it is
 * recorded in `docs/BUILD-BACKLOG.md` rather than quietly matched.
 */
import { isSupabaseConfigured } from '../../../lib/supabase.ts';
import { freshToken } from '../../../services/apiToken.ts';

export interface VoiceUploadResult {
  url: string;
  path: string;
  mimeType: string;
  sizeBytes: number;
  maxDurationSeconds: number;
  maxWaveformPeaks: number;
}

export interface VoiceMessage {
  id: string;
  threadId: string;
  senderId: string;
  createdAt: string;
  msgType: string;
  kind: 'VOICE';
  payload: {
    url: string;
    durationSeconds: number;
    waveform: number[];
    mimeType: string;
    sizeBytes?: number | null;
  };
  mediaUrl: string;
  mediaType: string;
  mediaDurationSeconds: number;
  clientId: string | null;
}

export type VoiceResult<T> = { ok: true; data: T } | { ok: false; error: string; message?: string };

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

/**
 * Upload the recording.
 *
 * The local file is read into a Blob and POSTed as raw bytes with the
 * container as `Content-Type`, exactly as `services/media.ts#uploadMedia` does
 * for photos — the server's body reader keys off the content type, and
 * `express.json` skips a non-JSON body, which is why this works alongside the
 * global parser.
 */
export async function uploadVoiceRecording(
  localUri: string,
  mimeType = 'audio/mp4',
): Promise<VoiceResult<VoiceUploadResult>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'unconfigured' };
  const token = await freshToken();
  if (!token) return { ok: false, error: 'unauthenticated' };

  let blob: Blob;
  try {
    const read = await fetch(localUri);
    blob = await read.blob();
  } catch (e) {
    return {
      ok: false,
      error: 'read_failed',
      message: e instanceof Error ? e.message : 'Could not read the recording',
    };
  }

  try {
    const res = await fetch(`${apiBase()}/api/telegraph/voice/upload`, {
      method: 'POST',
      headers: { 'Content-Type': mimeType, Authorization: `Bearer ${token}` },
      body: blob,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}) as any);
      return { ok: false, error: String(body?.error ?? res.status), message: body?.message };
    }
    return { ok: true, data: (await res.json()) as VoiceUploadResult };
  } catch (e) {
    return { ok: false, error: 'network', message: e instanceof Error ? e.message : undefined };
  }
}

/** Send the uploaded recording into a thread as a §6.2 VOICE message. */
export async function sendVoiceMessage(
  threadId: string,
  payload: {
    url: string;
    durationSeconds: number;
    waveform: number[];
    mimeType: string;
    sizeBytes?: number | null;
  },
  opts?: { replyToId?: string | null; clientId?: string | null },
): Promise<VoiceResult<VoiceMessage>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'unconfigured' };
  const token = await freshToken();
  if (!token) return { ok: false, error: 'unauthenticated' };

  try {
    const res = await fetch(`${apiBase()}/api/threads/${threadId}/voice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        payload,
        replyToId: opts?.replyToId ?? null,
        clientId: opts?.clientId ?? null,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}) as any);
      return { ok: false, error: String(body?.error ?? res.status), message: body?.message };
    }
    return { ok: true, data: (await res.json()) as VoiceMessage };
  } catch (e) {
    return { ok: false, error: 'network', message: e instanceof Error ? e.message : undefined };
  }
}
