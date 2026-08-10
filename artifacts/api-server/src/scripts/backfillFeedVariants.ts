/**
 * backfillFeedVariants — populate post_media.feed_url / feed_storage_path for
 * rows that predate migration 0208.
 *
 * WHY THIS IS A JOB AND NOT A CHECK
 * --------------------------------
 * 0208 added the columns and wired the live upload paths, but ran no backfill.
 * Every post_media row written before it has feed_url NULL, which the API
 * correctly reports as "no variant — serve the original". Nothing is broken;
 * historical posts just keep fetching full-size images in the feed. This script
 * closes that gap. It is deliberately NOT wired into check:all: it mutates
 * Storage and the database, it is long-running and rate-limited, and a job that
 * a gate runs on every build is a job that will eventually run when nobody
 * meant it to.
 *
 * WHAT IT DOES PER ROW
 * --------------------
 *   1. download the stored original from Storage
 *   2. sniff it (the bytes decide, not the recorded mime_type)
 *   3. makeFeedVariant() — the SAME function the live path uses
 *   4. upload to <storage_path>.feed.jpg
 *   5. write feed_storage_path + feed_url on the row
 *
 * Step 5 is last on purpose: if the process dies between 4 and 5 the object is
 * orphaned but the row still reads NULL, so a re-run redoes both steps and
 * converges. The reverse order would leave a row advertising an object that
 * does not exist — the DANGLING state check:media-objects exists to catch.
 *
 * EXIF — READ THIS BEFORE TRUSTING THE OUTPUT
 * -------------------------------------------
 * The variant is built with makeFeedVariant(), which re-encodes through sharp,
 * and sharp discards metadata on re-encode. So every variant this script writes
 * is EXIF/GPS-clean REGARDLESS of what the source carried. That is a property of
 * the re-encode, not of the input.
 *
 * The input is a different question and this script does NOT answer it. The live
 * path derives the variant from an in-memory buffer that processImage() has
 * already stripped. This script has no such guarantee: it reads whatever is in
 * the bucket, and rows uploaded before the strip landed may still have EXIF —
 * including GPS — in the stored ORIGINAL. This script neither fixes nor reports
 * on that; it is a pre-existing condition of the original object and out of
 * scope here. Use --audit-exif to find out how many originals are affected
 * before deciding whether a separate re-strip job is warranted. Do not read a
 * clean backfill as evidence that stored originals are clean.
 *
 * VIDEOS are skipped — there is no video transcode tier, and the live path does
 * not build variants for them either.
 *
 * CHECKPOINTING
 * -------------
 * Progress is written to a JSON file after every row (--state, default
 * .backfill-feed-variants.json). An interrupted run resumes from the last
 * processed id rather than restarting. The checkpoint is an optimisation, not
 * the correctness mechanism: the row filter is `feed_url IS NULL`, so a run with
 * no checkpoint at all is still idempotent and still skips completed rows. Delete
 * the state file to force a full re-scan.
 *
 * USAGE
 *   # dry run (default — reports what it WOULD do, writes nothing)
 *   pnpm run backfill:feed-variants
 *   pnpm run backfill:feed-variants -- --limit 200
 *
 *   # audit stored originals for surviving EXIF (read-only)
 *   pnpm run backfill:feed-variants -- --audit-exif --limit 100
 *
 *   # actually write
 *   pnpm run backfill:feed-variants -- --apply --limit 200
 *
 * FLAGS
 *   --apply             perform writes. Without it NOTHING is written.
 *   --limit N           max rows to consider this run (default 100)
 *   --rate-ms N         min delay between rows (default 250)
 *   --state PATH        checkpoint file (default .backfill-feed-variants.json)
 *   --audit-exif        read-only: report how many stored originals still carry
 *                       EXIF. Implies no writes.
 *   --reset             ignore and clear any existing checkpoint
 *
 * EXIT CODES — a partial success is NOT a success
 *   0  every row attempted this run succeeded (or there was nothing to do)
 *   1  at least one row FAILED. A run that fails 400 of 500 exits 1, loudly.
 *   2  cannot run (missing credentials / unusable arguments) — never a silent
 *      pass, mirroring checkMediaObjects.
 */
export {};

import { createClient } from "@supabase/supabase-js";
import sharp from "sharp";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { sniffMedia, makeFeedVariant, FEED_DIM } from "../lib/mediaProcessing.js";

const EXIT_OK = 0;
const EXIT_FAILURES = 1;
const EXIT_CANNOT_RUN = 2;

const STORAGE_BUCKET = "post-media";

function die(code: number, msg: string): never {
  console.error(`  ✘  ${msg}`);
  process.exit(code);
}

// ── Arguments ────────────────────────────────────────────────────────────────

export interface Options {
  apply: boolean;
  auditExif: boolean;
  reset: boolean;
  limit: number;
  rateMs: number;
  statePath: string;
}

/** Thrown for unusable arguments so parsing stays pure and testable. */
export class ArgError extends Error {}

/**
 * Parse argv into options. Pure: no process.exit, no globals, no I/O — the
 * caller decides what a bad argument means. DEFAULTS MATTER HERE: apply is
 * false, so the only way to write is to ask for it explicitly.
 */
export function parseArgs(argv: string[]): Options {
  const flag = (name: string) => argv.includes(`--${name}`);
  const value = (name: string, fallback: string): string => {
    const i = argv.indexOf(`--${name}`);
    if (i === -1) return fallback;
    const v = argv[i + 1];
    // A missing value must not silently consume the next flag: `--limit --apply`
    // would otherwise parse as limit="--apply" and, worse, drop the --apply.
    if (v === undefined || v.startsWith("--")) throw new ArgError(`--${name} requires a value`);
    return v;
  };
  const intValue = (name: string, fallback: number): number => {
    const raw = value(name, String(fallback));
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
      throw new ArgError(`--${name} must be a positive integer, got "${raw}"`);
    }
    return n;
  };

  const rateRaw = value("rate-ms", "250");
  const rateMs = Number(rateRaw);
  if (!Number.isFinite(rateMs) || rateMs < 0) {
    throw new ArgError(`--rate-ms must be a non-negative number, got "${rateRaw}"`);
  }

  const opts: Options = {
    apply: flag("apply"),
    auditExif: flag("audit-exif"),
    reset: flag("reset"),
    limit: intValue("limit", 100),
    rateMs,
    statePath: value("state", ".backfill-feed-variants.json"),
  };

  if (opts.apply && opts.auditExif) {
    throw new ArgError("--audit-exif is read-only and cannot be combined with --apply");
  }
  return opts;
}

/**
 * The storage key for a row's variant. Kept as one function so the backfill and
 * the live upload paths cannot drift into writing two different conventions —
 * a drift that would strand every object the other one wrote.
 */
export function variantPathFor(storagePath: string): string {
  return `${storagePath}.feed.jpg`;
}

/**
 * Exit code from the run tally. A partial success is a FAILURE: 400 failures
 * out of 500 must not exit 0 just because 100 rows worked.
 */
export function decideExitCode(failed: number): number {
  return failed > 0 ? EXIT_FAILURES : EXIT_OK;
}

/** Parse a checkpoint blob, tolerating corruption by starting clean. */
export function parseCheckpoint(raw: string): Checkpoint {
  const c = JSON.parse(raw) as Checkpoint;
  if (!Array.isArray(c.done) || !Array.isArray(c.failed)) throw new Error("malformed");
  return c;
}

// ── Bind the pure options to this process ────────────────────────────────────
// Everything below this line does I/O. Everything above is importable and
// testable without touching the network, the filesystem or process.exit.

const RUN_DIRECTLY = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;

let OPTS: Options;
try {
  OPTS = parseArgs(process.argv.slice(2));
} catch (e) {
  if (!RUN_DIRECTLY) {
    // Imported by a test runner, whose argv is not ours. Use defaults; main()
    // will not run anyway.
    OPTS = { apply: false, auditExif: false, reset: false, limit: 100, rateMs: 250, statePath: ".backfill-feed-variants.json" };
  } else {
    die(EXIT_CANNOT_RUN, e instanceof ArgError ? e.message : String(e));
  }
}
const { apply: APPLY, auditExif: AUDIT_EXIF, reset: RESET, limit: LIMIT, rateMs: RATE_MS, statePath: STATE_PATH } = OPTS!;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (RUN_DIRECTLY && (!SUPABASE_URL || !SERVICE_KEY)) {
  die(
    EXIT_CANNOT_RUN,
    "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set — exiting 2 rather than 0, " +
      "because a backfill that could not run must not read as one that had nothing to do.",
  );
}
const sc = createClient(SUPABASE_URL ?? "http://127.0.0.1:9", SERVICE_KEY ?? "unused", { auth: { persistSession: false } });

// ── Checkpoint ───────────────────────────────────────────────────────────────

interface Checkpoint {
  /** Ids already processed successfully, so a resume can skip them cheaply. */
  done: string[];
  /** Ids that failed, kept so a resume RETRIES them rather than treating them as finished. */
  failed: string[];
  updatedAt: string;
}

function loadCheckpoint(): Checkpoint {
  if (RESET || !existsSync(STATE_PATH)) return { done: [], failed: [], updatedAt: "" };
  try {
    return parseCheckpoint(readFileSync(STATE_PATH, "utf8"));
  } catch (e) {
    // A corrupt checkpoint must not silently become "nothing done". Say so and
    // start clean — the `feed_url IS NULL` filter makes that safe, just slower.
    console.warn(`  !  checkpoint at ${STATE_PATH} is unreadable (${String(e)}) — starting from scratch`);
    return { done: [], failed: [], updatedAt: "" };
  }
}

function saveCheckpoint(c: Checkpoint): void {
  if (!APPLY) return; // a dry run must leave no trace
  c.updatedAt = new Date().toISOString();
  writeFileSync(STATE_PATH, JSON.stringify(c, null, 2));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Row selection ────────────────────────────────────────────────────────────

interface Row {
  id: string;
  post_id: string | null;
  storage_path: string | null;
  storage_bucket: string | null;
  media_type: string | null;
  processing_status: string | null;
}

/**
 * Rows needing a variant. `feed_url IS NULL` is the real idempotence guard —
 * a completed row simply stops matching, so re-running converges with or
 * without a checkpoint.
 */
async function selectCandidates(limit: number): Promise<Row[]> {
  const { data, error } = await sc
    .from("post_media")
    .select("id, post_id, storage_path, storage_bucket, media_type, processing_status")
    .is("feed_url", null)
    .eq("media_type", "image")
    .eq("processing_status", "ready")
    .not("storage_path", "is", null)
    .order("id", { ascending: true })
    .limit(limit);
  if (error) die(EXIT_CANNOT_RUN, `could not read post_media: ${error.message}`);
  return (data ?? []) as Row[];
}

async function totalOutstanding(): Promise<number> {
  const { count, error } = await sc
    .from("post_media")
    .select("id", { count: "exact", head: true })
    .is("feed_url", null)
    .eq("media_type", "image")
    .eq("processing_status", "ready")
    .not("storage_path", "is", null);
  if (error) die(EXIT_CANNOT_RUN, `could not count post_media: ${error.message}`);
  return count ?? 0;
}

// ── Per-row work ─────────────────────────────────────────────────────────────

async function download(bucket: string, path: string): Promise<Buffer> {
  const dl = await sc.storage.from(bucket).download(path);
  if ((dl as any).error || !(dl as any).data) {
    throw new Error(`download failed: ${(dl as any).error?.message ?? "no data"}`);
  }
  return Buffer.from(await (dl as any).data.arrayBuffer());
}

async function processRow(row: Row): Promise<void> {
  const bucket = row.storage_bucket ?? STORAGE_BUCKET;
  const path = row.storage_path!;
  const raw = await download(bucket, path);

  const sniffed = sniffMedia(raw);
  if (!sniffed || sniffed.kind !== "image") {
    // Not a silent skip. The row claims media_type='image' and the bytes
    // disagree; that is a finding, and it fails the run.
    throw new Error(`stored bytes are not an image (sniffed: ${sniffed?.mime ?? "unrecognised"})`);
  }

  // Same function the live upload paths call — the variant therefore has the
  // same dimensions, quality and (via sharp's re-encode) the same absence of
  // metadata. See the EXIF note in the header for what this does and does not
  // guarantee about the ORIGINAL.
  const variant = await makeFeedVariant(raw);
  const variantPath = variantPathFor(path);

  if (!APPLY) return;

  const { error: upErr } = await sc.storage
    .from(bucket)
    .upload(variantPath, variant.buffer, { contentType: variant.mime, upsert: true });
  if (upErr) throw new Error(`variant upload failed: ${upErr.message}`);

  // Row LAST — see the header. An object with no row re-converges on re-run;
  // a row with no object is a user-visible broken image.
  const { error: dbErr } = await sc
    .from("post_media")
    .update({ feed_storage_path: variantPath, feed_url: `${bucket}/${variantPath}` })
    .eq("id", row.id);
  if (dbErr) throw new Error(`row update failed: ${dbErr.message}`);
}

/** Read-only: does the STORED ORIGINAL still carry EXIF? */
async function auditRow(row: Row): Promise<boolean> {
  const raw = await download(row.storage_bucket ?? STORAGE_BUCKET, row.storage_path!);
  const meta = await sharp(raw).metadata();
  return meta.exif !== undefined;
}

// ── Main ─────────────────────────────────────────────────────────────────────
// Guarded so importing this module (tests) does not run the backfill. Nothing
// above this point performs I/O.

async function main(): Promise<void> {

  const outstanding = await totalOutstanding();
  const mode = AUDIT_EXIF ? "AUDIT-EXIF (read-only)" : APPLY ? "APPLY (writing)" : "DRY RUN (no writes)";

  console.log("");
  console.log("  backfill-feed-variants");
  console.log(`  mode:        ${mode}`);
  console.log(`  variant dim: ${FEED_DIM}px longest edge`);
  console.log(`  limit:       ${LIMIT}   rate: ${RATE_MS}ms/row`);
  console.log(`  outstanding: ${outstanding} post_media row(s) are ready images with feed_url IS NULL`);
  if (!APPLY && !AUDIT_EXIF) {
    console.log("  (dry run — pass --apply to write. Nothing below is persisted.)");
  }
  console.log("");

  if (outstanding === 0) {
    console.log("  ✅ nothing to do — every ready image already has a feed variant.");
    process.exit(EXIT_OK);
  }

  const checkpoint = loadCheckpoint();
  if (RESET && existsSync(STATE_PATH)) {
    unlinkSync(STATE_PATH);
    console.log(`  checkpoint ${STATE_PATH} cleared (--reset)`);
  }
  if (checkpoint.done.length || checkpoint.failed.length) {
    console.log(
      `  resuming from ${STATE_PATH}: ${checkpoint.done.length} done, ` +
        `${checkpoint.failed.length} previously failed (will be retried)`,
    );
  }

  const doneSet = new Set(checkpoint.done);
  const candidates = (await selectCandidates(LIMIT)).filter((r) => !doneSet.has(r.id));

  let ok = 0;
  let failed = 0;
  let exifCarrying = 0;
  const failures: Array<{ id: string; post_id: string | null; reason: string }> = [];

  for (const row of candidates) {
    try {
      if (AUDIT_EXIF) {
        if (await auditRow(row)) {
          exifCarrying++;
          console.log(`  EXIF  ${row.id}  post=${row.post_id ?? "?"}  path=${row.storage_path}`);
        }
      } else {
        await processRow(row);
        checkpoint.done.push(row.id);
        checkpoint.failed = checkpoint.failed.filter((f) => f !== row.id);
        saveCheckpoint(checkpoint);
      }
      ok++;
    } catch (err) {
      failed++;
      const reason = err instanceof Error ? err.message : String(err);
      failures.push({ id: row.id, post_id: row.post_id, reason });
      if (!checkpoint.failed.includes(row.id)) checkpoint.failed.push(row.id);
      saveCheckpoint(checkpoint);
      console.error(`  ✘ ${row.id}  post=${row.post_id ?? "?"}  ${reason}`);
    }
    if (RATE_MS > 0) await sleep(RATE_MS);
  }

  console.log("");
  console.log("  ──────────────────────────────────────────────");
  if (AUDIT_EXIF) {
    console.log(`  audited:  ${ok} original(s)`);
    console.log(`  carrying EXIF: ${exifCarrying}`);
    if (exifCarrying > 0) {
      console.log("");
      console.log("  These are STORED ORIGINALS that still carry EXIF (possibly GPS).");
      console.log("  The feed variants this script writes are clean regardless — sharp");
      console.log("  discards metadata on re-encode — but the originals are not, and");
      console.log("  re-stripping them is a separate job with its own review.");
    }
  } else {
    console.log(`  processed: ${ok}   failed: ${failed}   (of ${candidates.length} attempted)`);
    console.log(`  remaining after this run: ~${Math.max(0, outstanding - (APPLY ? ok : 0))}`);
  }
  if (failures.length) {
    console.log("");
    console.error(`  ${failures.length} FAILURE(S) — not skipped, not swallowed:`);
    for (const f of failures.slice(0, 20)) {
      console.error(`    ${f.id}  post=${f.post_id ?? "?"}  ${f.reason}`);
    }
    if (failures.length > 20) {
      console.error(`    … and ${failures.length - 20} more (full count above, nothing truncated silently)`);
    }
  }
  console.log("  ──────────────────────────────────────────────");
  console.log("");

  process.exit(failed > 0 ? EXIT_FAILURES : EXIT_OK);

}

if (RUN_DIRECTLY) {
  await main();
}
