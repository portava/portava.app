/**
 * backgroundTransfer — each resumable part as an OS-level BACKGROUND transfer
 * (Media spec §37 "Background upload").
 *
 * WHY A PART, AND WHY A FILE
 * A JavaScript fetch/XHR stops when iOS suspends the app, a few seconds after
 * it leaves the foreground. A transfer handed to the OS in a background
 * URLSession keeps going (and keeps retrying on a dead network) while the app
 * is suspended; Android runs expo-file-system transfers outside the JS thread
 * the same way. The OS can only transfer a FILE, not a slice of a JS Blob, so
 * each part is first written to a small cache file — the byte range read
 * straight from the picked file — then handed over, then deleted.
 *
 * Parts, not the whole file, because the queue's resume token is the slot
 * (resumableUpload.ts): if the app is killed while a part is in flight, either
 * the OS finishes it or the next session lists it as missing, and nothing
 * before it is sent again.
 *
 * The module surface this needs from expo-file-system is injected (FsLike), so
 * the byte-range and lifecycle logic is tested under node:test; the real module
 * is loaded lazily by loadExpoFs().
 */
import type { FileLike, ResumableTransport } from './resumableUpload.ts';

/** What a background FileLike's slice returns: a byte range of a local file. */
export interface PartDescriptor {
  kind: 'file-range';
  uri: string;
  start: number;
  end: number;
}

export interface FsUploadResult {
  status: number;
  headers?: Record<string, string> | null;
}

/** The slice of expo-file-system/legacy used here. */
export interface FsLike {
  cacheDirectory: string | null;
  sessionBackground: number;
  uploadBinary: number;
  /** An existing file's info always carries its size in bytes. */
  getInfoAsync(uri: string): Promise<{ exists: boolean; size?: number }>;
  readAsStringAsync(uri: string, options: { encoding: 'base64'; position: number; length: number }): Promise<string>;
  writeAsStringAsync(uri: string, contents: string, options: { encoding: 'base64' }): Promise<void>;
  deleteAsync(uri: string, options: { idempotent: boolean }): Promise<void>;
  createUploadTask(
    url: string,
    fileUri: string,
    options: { httpMethod: 'PUT'; uploadType: number; sessionType: number; headers: Record<string, string> },
    callback?: (progress: { totalBytesSent: number; totalBytesExpectedToSend: number }) => void,
  ): { uploadAsync(): Promise<FsUploadResult | undefined | null> };
}

/** A FileLike over a local file whose slices are byte-range descriptors, never bytes in JS. */
export async function backgroundFile(uri: string, fs: FsLike): Promise<FileLike> {
  const info = await fs.getInfoAsync(uri);
  if (!info.exists || typeof info.size !== 'number' || info.size <= 0) {
    throw new Error('The file to upload is no longer on this device.');
  }
  const size = info.size;
  return {
    size,
    slice(start: number, end: number): PartDescriptor {
      return { kind: 'file-range', uri, start: Math.max(0, start), end: Math.min(size, end) };
    },
  };
}

function isDescriptor(part: unknown): part is PartDescriptor {
  const p = part as PartDescriptor | null;
  return !!p && p.kind === 'file-range' && typeof p.uri === 'string' && p.end > p.start;
}

let partCounter = 0;

/**
 * A ResumableTransport whose parts travel as background transfers. `api`
 * (session / assemble) stays a normal foreground call: it is small, and it is
 * what the queue re-issues on the next foreground to learn what the OS finished.
 */
export function backgroundPartTransport(api: ResumableTransport['api'], fs: FsLike): ResumableTransport {
  return {
    api,
    async putPart(url, part, contentType, onSent) {
      if (!isDescriptor(part)) throw new Error('background transfer needs a file-range part');
      const dir = fs.cacheDirectory ?? '';
      const partUri = `${dir}media-upload-part-${Date.now()}-${++partCounter}.bin`;
      try {
        const b64 = await fs.readAsStringAsync(part.uri, {
          encoding: 'base64',
          position: part.start,
          length: part.end - part.start,
        });
        await fs.writeAsStringAsync(partUri, b64, { encoding: 'base64' });
        const task = fs.createUploadTask(
          url,
          partUri,
          {
            httpMethod: 'PUT',
            uploadType: fs.uploadBinary,
            sessionType: fs.sessionBackground,
            headers: { 'Content-Type': contentType, 'x-upsert': 'true' },
          },
          (p) => onSent?.(p.totalBytesSent),
        );
        const res = await task.uploadAsync();
        // No result means the task was cancelled or never answered — "no answer", retryable.
        if (!res) throw new Error('background transfer returned no response');
        const h = res.headers ?? {};
        return { status: res.status, retryAfter: h['retry-after'] ?? h['Retry-After'] ?? null };
      } finally {
        await fs.deleteAsync(partUri, { idempotent: true }).catch(() => {});
      }
    },
  };
}

/** The real module, or null where it is unavailable (web, a build without it). Never throws. */
export async function loadExpoFs(): Promise<FsLike | null> {
  try {
    const mod = await import('expo-file-system/legacy');
    return {
      cacheDirectory: mod.cacheDirectory,
      sessionBackground: mod.FileSystemSessionType.BACKGROUND,
      uploadBinary: mod.FileSystemUploadType.BINARY_CONTENT,
      getInfoAsync: (uri) => mod.getInfoAsync(uri) as Promise<{ exists: boolean; size?: number }>,
      readAsStringAsync: (uri, options) =>
        mod.readAsStringAsync(uri, { encoding: mod.EncodingType.Base64, position: options.position, length: options.length }),
      writeAsStringAsync: (uri, contents) => mod.writeAsStringAsync(uri, contents, { encoding: mod.EncodingType.Base64 }),
      deleteAsync: (uri, options) => mod.deleteAsync(uri, options),
      // The OS session type and upload type are fixed here, from the module's own
      // enums; `options` carries them only so a test can assert what was asked for.
      createUploadTask: (url, fileUri, options, callback) =>
        mod.createUploadTask(
          url,
          fileUri,
          {
            httpMethod: options.httpMethod,
            uploadType: mod.FileSystemUploadType.BINARY_CONTENT,
            sessionType: mod.FileSystemSessionType.BACKGROUND,
            headers: options.headers,
          },
          callback,
        ),
    };
  } catch {
    return null;
  }
}
