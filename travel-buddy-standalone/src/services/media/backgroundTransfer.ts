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
import type { FileLike, PartOutcome, ResumableTransport } from './resumableUpload.ts';

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
  deleteAsync(uri: string, options: { idempotent: boolean }): Promise<void>; /** census-media §37.8: file NAMES in a directory, for the staged-part sweep. Optional: absent ⇒ no sweep. */ readDirectoryAsync?(uri: string): Promise<string[]>;
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
    api, putParts: (parts, contentType, onSent, owner) => putPartsInBackground(fs, parts, contentType, onSent, owner), // MD284: every missing part at once (end of file); §37.8 passes the owning slot (was: putParts: (parts, contentType, onSent) => …)
    async putPart(url, part, contentType, onSent, owner) {
      if (!isDescriptor(part)) throw new Error('background transfer needs a file-range part');
      const dir = fs.cacheDirectory ?? '';
      const partUri = stagedPartUri(dir, owner); // §37.8: the name carries the owning slot, so the sweep can attribute it
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
      deleteAsync: (uri, options) => mod.deleteAsync(uri, options), readDirectoryAsync: (uri) => mod.readDirectoryAsync(uri), // §37.8 sweep
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

/**
 * MD284 — every missing part handed to the OS AT ONCE (census-media §37).
 *
 *   1. STAGE, one part at a time: each part's byte range is copied into its own
 *      cache file. One at a time because the copy passes through JS as base64,
 *      and a 100 MB video's parts must not all sit in JS memory together. The
 *      staged files do: the remaining file is briefly in the cache twice.
 *   2. HAND OVER, all at once: every upload task is created and STARTED before
 *      any of them is awaited. On iOS each one is then a task in the app's
 *      background URLSession, so every remaining part keeps going when the app
 *      is suspended — not only the part that happened to be in flight.
 *   3. SETTLE: wait for all, delete every staged file, report one outcome per
 *      part. A part that could not be staged is never handed over and is
 *      reported as no answer, so the caller retries it; it is never success.
 *
 * What this cannot do on its own is the device half: whether iOS finishes the
 * tasks while suspended, and whether it relaunches the app to report them, is
 * what a device run must show. Android runs these on OkHttp inside the app
 * process — expo-file-system's `sessionType` has no effect there — so a
 * suspended or killed Android process loses them until a foreground service
 * (a native module) keeps it alive. Both are named in census-media §37.
 */
export async function putPartsInBackground(
  fs: FsLike,
  parts: Array<{ url: string; part: unknown }>,
  contentType: string,
  onSent?: (position: number, bytes: number) => void,
  /** census-media §37.8: the owning slot (slotOwnerKey), written into every staged file's name. */
  owner?: string,
): Promise<PartOutcome[]> {
  const outcomes: PartOutcome[] = parts.map(() => ({ error: 'not handed over' }));
  const staged: Array<{ position: number; url: string; uri: string }> = [];
  const dir = fs.cacheDirectory ?? '';
  try {
    // 1. Stage, sequentially.
    for (let position = 0; position < parts.length; position++) {
      const p = parts[position]!;
      if (!isDescriptor(p.part)) {
        outcomes[position] = { error: 'background transfer needs a file-range part' };
        continue;
      }
      const uri = stagedPartUri(dir, owner);
      try {
        const b64 = await fs.readAsStringAsync(p.part.uri, {
          encoding: 'base64',
          position: p.part.start,
          length: p.part.end - p.part.start,
        });
        await fs.writeAsStringAsync(uri, b64, { encoding: 'base64' });
        staged.push({ position, url: p.url, uri });
      } catch (err) {
        await fs.deleteAsync(uri, { idempotent: true }).catch(() => {});
        outcomes[position] = { error: err instanceof Error ? err.message : 'part could not be staged' };
      }
    }
    // 2. Create and START every task before awaiting any.
    const running = staged.map((s) => {
      try {
        const task = fs.createUploadTask(
          s.url,
          s.uri,
          {
            httpMethod: 'PUT',
            uploadType: fs.uploadBinary,
            sessionType: fs.sessionBackground,
            headers: { 'Content-Type': contentType, 'x-upsert': 'true' },
          },
          (prog) => onSent?.(s.position, prog.totalBytesSent),
        );
        return { s, done: task.uploadAsync() };
      } catch (err) {
        return { s, done: Promise.reject(err) };
      }
    });
    // 3. Settle all.
    const settled = await Promise.allSettled(running.map((r) => r.done));
    settled.forEach((result, i) => {
      const { position } = running[i]!.s;
      if (result.status === 'rejected') {
        const reason = result.reason as unknown;
        outcomes[position] = { error: reason instanceof Error ? reason.message : 'background transfer failed' };
        return;
      }
      const res = result.value;
      if (!res) {
        outcomes[position] = { error: 'background transfer returned no response' };
        return;
      }
      const h = res.headers ?? {};
      outcomes[position] = { status: res.status, retryAfter: h['retry-after'] ?? h['Retry-After'] ?? null };
    });
  } finally {
    await Promise.all(staged.map((s) => fs.deleteAsync(s.uri, { idempotent: true }).catch(() => {})));
  }
  return outcomes;
}

// ── census-media §37.8: staged part files, named by their owner, and swept ────
//
// A staged part is a COPY of one byte range of the picked file, made so the OS
// can upload it. Both staging paths delete their copies when the transfer
// settles, but a process killed first leaves them in the cache directory, and
// nothing removed them (§37.6 item 3).
//
// WHAT A STAGED COPY IS FOR, AND WHEN DELETING ONE COSTS NOTHING. Resuming never
// reads a staged copy: the next session lists what landed on the server and
// re-stages what is missing FROM THE PICKED FILE. The only reader of a staged
// copy is an OS upload task that is still sending it, and on iOS such a task
// can outlive the process. So:
//   • a copy whose slot belongs to a job that is still RESUMABLE (not done,
//     failed or cancelled, under any account on this device) is NEVER deleted;
//   • a copy whose slot belongs to no resumable job is deleted — nothing will
//     resume it, and an OS task still sending it serves a job that has ended;
//   • a copy with no owner in its name (made before owners were written, or by
//     a caller that passed none) is deleted only once it is older than
//     STAGED_UNATTRIBUTED_MAX_AGE_MS. Its signed upload URL — Supabase issues
//     them for two hours — has expired by then, so no task can still be using it.
// If the live-job set cannot be read, NOTHING with an owner is deleted.
//
// ORDER IS LOAD-BEARING: the directory is listed FIRST and the live jobs read
// SECOND. A job persists its slot before it stages a byte (postcardUploadPipeline),
// so any copy the listing saw belongs to a job already in storage when the live
// set is read — a job enqueued between the two reads cannot lose its copies.
// BOUNDED: one listing, and at most STAGED_SWEEP_MAX_DELETES deletions per run.

export const STAGED_PART_PREFIX = 'media-upload-part';
/** Three times the two-hour life of a signed upload URL. */
export const STAGED_UNATTRIBUTED_MAX_AGE_MS = 6 * 60 * 60 * 1000;
export const STAGED_SWEEP_MAX_DELETES = 200;

const OWNED_RE = /^media-upload-part\.([A-Za-z0-9_-]{1,64}~[A-Za-z0-9_-]{1,64})\.(\d{1,16})\.(\d{1,9})\.bin$/;
const UNOWNED_RE = /^media-upload-part-(\d{1,16})-(\d{1,9})\.bin$/;

/** The cache path a staged copy is written to. With an owner, the owner is in the name. */
export function stagedPartUri(dir: string, owner?: string): string {
  const n = ++partCounter;
  if (owner && /^[A-Za-z0-9_-]{1,64}~[A-Za-z0-9_-]{1,64}$/.test(owner)) {
    return `${dir}${STAGED_PART_PREFIX}.${owner}.${Date.now()}.${n}.bin`;
  }
  return `${dir}${STAGED_PART_PREFIX}-${Date.now()}-${n}.bin`;
}

/** A staged copy's owner (or null when it names none) and when it was made; null for any other file. */
export function parseStagedPartName(name: string): { owner: string | null; createdAtMs: number } | null {
  const owned = OWNED_RE.exec(name);
  if (owned) return { owner: owned[1]!, createdAtMs: Number(owned[2]) };
  const unowned = UNOWNED_RE.exec(name);
  if (unowned) return { owner: null, createdAtMs: Number(unowned[1]) };
  return null;
}

export interface StagedSweepResult {
  /** Why nothing was swept at all, when nothing could be. */
  refused: 'no_directory_listing' | 'listing_failed' | null;
  scanned: number;
  deleted: string[];
  keptLive: number;
  /** Owned copies kept because the live-job set could not be read. */
  keptUnknown: number;
  /** Unowned copies still younger than STAGED_UNATTRIBUTED_MAX_AGE_MS. */
  keptYoung: number;
  /** Deletable copies left for the next run by the per-run bound. */
  deferred: number;
}

/**
 * Delete staged copies that belong to no resumable upload. NEVER throws.
 * `loadLiveOwners` returns the slot keys (slotOwnerKey) of every job that can
 * still resume, or null when that cannot be established.
 */
export async function sweepStagedParts(
  fs: FsLike,
  loadLiveOwners: () => Promise<ReadonlySet<string> | null>,
  nowMs: number,
  maxDeletes: number = STAGED_SWEEP_MAX_DELETES,
): Promise<StagedSweepResult> {
  const out: StagedSweepResult = { refused: null, scanned: 0, deleted: [], keptLive: 0, keptUnknown: 0, keptYoung: 0, deferred: 0 };
  const dir = fs.cacheDirectory;
  if (!dir || typeof fs.readDirectoryAsync !== 'function') return { ...out, refused: 'no_directory_listing' };
  let names: string[];
  try {
    names = await fs.readDirectoryAsync(dir);
  } catch {
    return { ...out, refused: 'listing_failed' };
  }
  const staged = names
    .map((name) => ({ name, parsed: parseStagedPartName(name) }))
    .filter((s): s is { name: string; parsed: { owner: string | null; createdAtMs: number } } => s.parsed !== null);
  out.scanned = staged.length;
  if (staged.length === 0) return out;
  let live: ReadonlySet<string> | null = null;
  try {
    live = await loadLiveOwners();
  } catch {
    live = null;
  }
  for (const { name, parsed } of staged) {
    if (parsed.owner !== null) {
      if (live === null) { out.keptUnknown++; continue; }
      if (live.has(parsed.owner)) { out.keptLive++; continue; }
    } else if (nowMs - parsed.createdAtMs < STAGED_UNATTRIBUTED_MAX_AGE_MS) {
      out.keptYoung++;
      continue;
    }
    if (out.deleted.length >= maxDeletes) { out.deferred++; continue; }
    try {
      await fs.deleteAsync(`${dir}${name}`, { idempotent: true });
      out.deleted.push(name);
    } catch {
      out.deferred++;
    }
  }
  return out;
}
