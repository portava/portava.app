/**
 * Sweep for abandoned resumable MESSAGE-media parts (census-telegraph T223,
 * migration 3656; routes/messageMediaTransport.ts).
 *
 * WHY IT EXISTS. A part is a raw 4 MiB slice of what the person picked — before
 * assemble runs the EXIF/GPS strip. A session nobody finishes would otherwise
 * leave those bytes in post-media/message-upload-parts/<user>/ indefinitely,
 * with no row pointing at them for account deletion to find (a session has no
 * table, by design). This sweep is what bounds that.
 *
 * WHAT IT REMOVES, per upload folder `<upload id>.parts`:
 *   • every part, once the folder's NEWEST part is older than
 *     PENDING_UPLOAD_ORPHAN_CUTOFF_MS (a signed upload URL's 2 h lifetime + the
 *     30 min an authorized PUT can still be in flight — the postcard sweep's own
 *     cutoff, so a live upload is never swept from under its owner);
 *   • every part AT ONCE when the owner has no `profiles` row any more (the
 *     account was deleted): nobody can finish that upload.
 * An unreadable listing or profile read never deletes: it is counted as a
 * failure and the folder is left for the next pass.
 *
 * NOT FLAG-GATED, deliberately (the layover retention sweep's argument): it
 * only ever deletes temporary raw bytes, and a flag could only keep them longer.
 * With 3656's flag never turned on there is nothing under the prefix and a pass
 * is one empty listing.
 *
 * Bounded per pass (users, uploads per user); what is left waits for the next.
 * Hourly. Reported at GET /healthz/schedulers as "messageMediaPartsSweep".
 * Loop: generation counter (PR #652's pattern).
 */
import { getServiceClient } from "./supabase.js";
import { logger } from "./logger.js";
import { MAX_RESUMABLE_PARTS, type StorageBucketLike } from "./postcardMediaTransport.js";
import { PENDING_UPLOAD_ORPHAN_CUTOFF_MS } from "../services/media/PendingUploadSweep.js";

export const MESSAGE_PARTS_PREFIX = "message-upload-parts";
export const MESSAGE_PARTS_BUCKET = "post-media";
export const MESSAGE_PARTS_SWEEP_INTERVAL_MS = 60 * 60_000;
export const MESSAGE_PARTS_MAX_USERS_PER_PASS = 200;
export const MESSAGE_PARTS_MAX_UPLOADS_PER_USER = 100;
const STARTUP_DELAY_MS = 120_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UPLOAD_FOLDER_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.parts$/i;

type ListBucket = Pick<StorageBucketLike, "list" | "remove">;
type Listed = Array<{ name: string; id?: string | null; updated_at?: string | null; created_at?: string | null }>;

export interface MessagePartsSweepResult {
  outcome: "swept" | "idle" | "failed";
  usersScanned: number;
  uploadsRemoved: number;
  partsRemoved: number;
  ownerGone: number;
  kept: number;
  failures: number;
}

async function list(bucket: ListBucket, path: string, limit: number): Promise<Listed | null> {
  try {
    const r = await bucket.list(path, { limit, sortBy: { column: "name", order: "asc" } });
    if (r.error || !Array.isArray(r.data)) return null;
    return r.data as Listed;
  } catch {
    return null;
  }
}

/** One pass. `now` is the cutoff's clock. Never throws. */
export async function runMessagePartsSweep(opts: { client?: any; now?: Date } = {}): Promise<MessagePartsSweepResult> {
  const result: MessagePartsSweepResult = { outcome: "idle", usersScanned: 0, uploadsRemoved: 0, partsRemoved: 0, ownerGone: 0, kept: 0, failures: 0 };
  const db = "client" in opts && opts.client !== undefined ? opts.client : getServiceClient();
  if (!db) return { ...result, outcome: "failed", failures: 1 };
  const nowMs = (opts.now ?? new Date()).getTime();
  const cutoffMs = nowMs - PENDING_UPLOAD_ORPHAN_CUTOFF_MS;
  const bucket = db.storage.from(MESSAGE_PARTS_BUCKET) as ListBucket;

  const users = await list(bucket, MESSAGE_PARTS_PREFIX, MESSAGE_PARTS_MAX_USERS_PER_PASS);
  if (users === null) return { ...result, outcome: "failed", failures: 1 };
  const userIds = users.map((u) => u.name).filter((n) => UUID_RE.test(n));
  if (userIds.length === 0) return result;

  // Which owners still exist? An unreadable answer means "unknown", never "gone".
  let existing: Set<string> | null = null;
  try {
    const { data, error } = await db.from("profiles").select("id").in("id", userIds);
    if (!error && Array.isArray(data)) existing = new Set((data as Array<{ id: string }>).map((r) => String(r.id)));
  } catch { existing = null; }
  if (existing === null) result.failures += 1;

  for (const userId of userIds) {
    result.usersScanned += 1;
    const ownerGone = existing !== null && !existing.has(userId);
    const uploads = await list(bucket, `${MESSAGE_PARTS_PREFIX}/${userId}`, MESSAGE_PARTS_MAX_UPLOADS_PER_USER);
    if (uploads === null) { result.failures += 1; continue; }
    for (const u of uploads) {
      const m = UPLOAD_FOLDER_RE.exec(u.name);
      if (!m) continue;
      const folder = `${MESSAGE_PARTS_PREFIX}/${userId}/${u.name}`;
      const parts = await list(bucket, folder, MAX_RESUMABLE_PARTS + 50);
      if (parts === null) { result.failures += 1; continue; }
      if (parts.length === 0) continue;
      let newest = Number.NEGATIVE_INFINITY;
      for (const p of parts) {
        const t = Date.parse(String(p.updated_at ?? p.created_at ?? ""));
        if (Number.isFinite(t) && t > newest) newest = t;
      }
      // A part with no readable timestamp is treated as NEW: never delete what cannot be dated.
      const undatable = parts.some((p) => !Number.isFinite(Date.parse(String(p.updated_at ?? p.created_at ?? ""))));
      const stale = !undatable && newest < cutoffMs;
      if (!ownerGone && !stale) { result.kept += 1; continue; }
      try {
        const { error } = await bucket.remove(parts.map((p) => `${folder}/${p.name}`));
        if (error) { result.failures += 1; continue; }
      } catch { result.failures += 1; continue; }
      result.uploadsRemoved += 1;
      result.partsRemoved += parts.length;
      if (ownerGone) result.ownerGone += 1;
    }
  }
  result.outcome = result.failures > 0 ? "failed" : result.uploadsRemoved > 0 ? "swept" : "idle";
  if (result.uploadsRemoved > 0) logger.info({ ...result }, "message media parts sweep removed abandoned raw parts");
  return result;
}

export interface MessagePartsSweepStatus {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  lastResult: MessagePartsSweepResult | null;
}
const _status: MessagePartsSweepStatus = { lastAttemptAt: null, lastSuccessAt: null, consecutiveFailures: 0, lastResult: null };
export function getMessagePartsSweepStatus(): Readonly<MessagePartsSweepStatus> { return { ..._status }; }
/** Test seam. */
export function _resetMessagePartsSweepStatus(): void { Object.assign(_status, { lastAttemptAt: null, lastSuccessAt: null, consecutiveFailures: 0, lastResult: null }); }

export async function runMessagePartsSweepTick(opts: { client?: any; now?: Date } = {}): Promise<MessagePartsSweepResult> {
  const now = opts.now ?? new Date();
  _status.lastAttemptAt = now.toISOString();
  let r: MessagePartsSweepResult;
  try {
    r = await runMessagePartsSweep({ ...opts, now });
  } catch (err) {
    logger.warn({ err }, "message media parts sweep threw");
    r = { outcome: "failed", usersScanned: 0, uploadsRemoved: 0, partsRemoved: 0, ownerGone: 0, kept: 0, failures: 1 };
  }
  _status.lastResult = r;
  if (r.outcome === "failed") {
    _status.consecutiveFailures += 1;
    const log = _status.consecutiveFailures >= 3 ? logger.error.bind(logger) : logger.warn.bind(logger);
    log({ ...r, consecutiveFailures: _status.consecutiveFailures }, "message media parts sweep did NOT complete — raw parts may outlive their cutoff");
  } else {
    _status.consecutiveFailures = 0;
    _status.lastSuccessAt = now.toISOString();
  }
  return r;
}

let _timer: ReturnType<typeof setTimeout> | null = null; let _generation = 0; // a pass re-arms only if no stop() came after its own start() (PR #652's pattern)

export function startMessageMediaPartsSweepScheduler(): void {
  if (_timer !== null) return;
  logger.info({ intervalMs: MESSAGE_PARTS_SWEEP_INTERVAL_MS }, "MessageMediaPartsSweepScheduler scheduled (an empty listing until 3656's flag is ever on)");
  const generation = ++_generation; _timer = setTimeout(function tick() {
    void runMessagePartsSweepTick().finally(() => {
      if (_timer !== null && generation === _generation) { _timer = setTimeout(tick, MESSAGE_PARTS_SWEEP_INTERVAL_MS); _timer.unref?.(); }
    });
  }, STARTUP_DELAY_MS);
  _timer.unref?.();
}

export function stopMessageMediaPartsSweepScheduler(): void {
  _generation += 1; if (_timer !== null) { clearTimeout(_timer); _timer = null; }
}
