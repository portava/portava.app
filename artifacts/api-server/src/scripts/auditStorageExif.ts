/**
 * auditStorageExif — EXIF / GPS census of the media buckets. STRICTLY READ-ONLY.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT backfillFeedVariants --audit-exif
 * ===================================================================
 *
 * The `--audit-exif` flag on backfillFeedVariants answers a much narrower
 * question than the one that matters, in three ways that all under-report:
 *
 *   1. It walks `post_media` ROWS, filtered `feed_url IS NULL AND
 *      media_type='image' AND processing_status='ready'`, capped by --limit.
 *      An object nothing references — the exact case where content believed
 *      deleted is still fetchable by URL — is invisible to a row walk. Those
 *      are the objects an EXIF audit most needs to see, because no product
 *      surface will ever re-render (and therefore re-strip) them.
 *   2. It reports `metadata.exif !== undefined` — a boolean. "Carries EXIF" and
 *      "carries a GPS IFD" are not the same question, and only the second one
 *      is a location-privacy finding.
 *   3. It reads no timestamps, so it cannot say which upload era is affected —
 *      the thing you need to know to decide whether the strip landed and held.
 *
 * This script enumerates the BUCKET instead, via the Storage API, and reports
 * counts only.
 *
 * WHAT IT DELIBERATELY NEVER DOES
 * ===============================
 *
 * IT NEVER PARSES A COORDINATE. The GPS check reads the IFD0 entry list for tag
 * 0x8825 (GPS IFD pointer), follows it far enough to COUNT its entries, and
 * stops. Latitude (0x0002) and longitude (0x0004) values are never dereferenced,
 * never decoded, never held in a variable. This is not a formatting rule about
 * the output — it is the parser's shape. A log line or CI artifact carrying real
 * user coordinates is itself the leak the audit exists to measure, and the only
 * durable way to not print a value is to never compute it.
 *
 * Where the report needs to characterise GPS richness it reports the ENTRY COUNT
 * of the GPS IFD (how many GPS tags were written), never any tag's value.
 *
 * IT NEVER DOWNLOADS PIXELS. EXIF lives in a header segment near the start of
 * the file, so each object is fetched with `Range: bytes=0-<HEADER_BYTES>`.
 * A partial read is enough to answer every question asked here, and it means a
 * privacy audit does not itself pull every user's photograph across the wire.
 * Objects whose header did not arrive intact are counted as UNSCANNED and named
 * in the totals rather than silently assumed clean.
 *
 * IT NEVER WRITES. No strip, no rewrite, no delete, no bucket mutation, no row
 * update. Every Storage call is list or ranged-GET; every SQL statement is a
 * SELECT. There is no --apply and no code path that could take one.
 *
 * THE PRODUCTION QUESTION
 * =======================
 *
 * This imports src/lib/ciProdReadOnlyAuditGuard.mjs as its first statement, the
 * same front door as the other read-only audits, and is listed in
 * READ_ONLY_AUDIT_ENTRY_POINTS in scripts/check-guard-coverage.mjs. Auditing
 * production is the point of the script, and that door is how a process asks:
 * outside CI, with PORTAVA_PROD_READ_ONLY_AUDIT set to the exact sentence, and
 * only against the ref declared in KNOWN_PROD_PROJECT_REF. Everywhere else, and
 * in CI always, it behaves exactly like the strict guard and exits 2.
 *
 * Read-only is not the same as harmless: this script's job is to pull the header
 * of every user photograph in a bucket into a process's memory, which is why the
 * request has to be made out loud rather than inferred from the verbs being
 * read-shaped.
 *
 * IT USED TO CARRY ITS OWN AUDIT_READONLY_ACK_PRODUCTION VARIABLE. That has been
 * deleted, and it should not be reintroduced. It was described in its own
 * comments as an acknowledgement rather than an override, and that description
 * was wrong on the only point that mattered: on the acknowledged path the guard
 * module was never imported, so nothing consulted the CI markers, the allowlist
 * script, or the declared production ref. Set inside GitHub Actions it would
 * have permitted a production run from a workflow — the one thing the front door
 * refuses unconditionally. It was also not scoped to production at all: it
 * compared the variable against the ref parsed out of SUPABASE_URL itself, a
 * self-referential test that ANY project satisfies. The door below is narrower
 * in every direction.
 *
 * Usage (from artifacts/api-server):
 *   pnpm run audit:storage-exif                 # every bucket, every image
 *   pnpm run audit:storage-exif -- --bucket post-media
 *   pnpm run audit:storage-exif -- --limit 500 --json
 *
 * Exit 0 → census completed (findings are reported, not failed on)
 * Exit 2 → cannot run (credentials or target refused). Never reads as a pass.
 */

// THE CHOKEPOINT. First import, static, above @supabase-touching module and
// above every other import, because the guard works by ES module evaluation
// order: placed second, everything above it is already loaded before the
// allowlist is consulted.
//
// This is the read-only front door, and this file is in
// READ_ONLY_AUDIT_ENTRY_POINTS in scripts/check-guard-coverage.mjs, which fails
// the build if an unlisted file imports it or if a listed file stops. The grant
// rests on the claim that this script only reads: every Storage call is a bucket
// listing, an object listing or a ranged GET, and both Management API statements
// are SELECTs. If a write is ever added here, the fix is to move this import to
// ../lib/ciSupabaseGuard.mjs and delete the entry, in the same change.
//
// There is no bypass beside this line, and adding one would defeat it — see the
// note on the deleted AUDIT_READONLY_ACK_PRODUCTION variable in the header.
import "../lib/ciProdReadOnlyAuditGuard.mjs";

import { exifFactsFrom, NO_EXIF } from "../lib/exifFacts.js";

export {};

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ACCESS_TOKEN =
  process.env.SUPABASE_PROJECT_TOKEN || process.env.SUPABASE_ACCESS_TOKEN;

if (!SUPABASE_URL || !SERVICE_KEY || !ACCESS_TOKEN) {
  console.error(
    "ERROR: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and a Supabase token must be set.\n" +
      "       Exiting 2 rather than 0: an unrunnable audit must not read as a clean one.",
  );
  process.exit(2);
}

const projectRef = new URL(SUPABASE_URL).hostname.split(".")[0];

/** Header bytes fetched per object. EXIF sits far below this in every real file. */
const HEADER_BYTES = 128 * 1024;

// ── args ─────────────────────────────────────────────────────────────────────

interface Opts {
  buckets: string[] | null;
  limit: number | null;
  json: boolean;
}

export function parseArgs(argv: string[]): Opts {
  const buckets: string[] = [];
  let limit: number | null = null;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") continue; // pnpm forwards its own separator through
    if (a === "--bucket") buckets.push(String(argv[++i]));
    else if (a === "--limit") limit = Number(argv[++i]);
    else if (a === "--json") json = true;
    else if (a.startsWith("--")) throw new Error(`unknown flag ${a}`);
  }
  if (limit !== null && (!Number.isFinite(limit) || limit <= 0)) {
    throw new Error("--limit must be a positive integer");
  }
  return { buckets: buckets.length ? buckets : null, limit, json };
}

const OPTS = parseArgs(process.argv.slice(2));

// ── live SQL (read-only), same Management API path as checkMediaObjects ──────

async function liveQuery<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    },
  );
  if (!res.ok) throw new Error(`Management API ${res.status}: ${await res.text()}`);
  return (await res.json()) as T[];
}

// ── Storage API enumeration ──────────────────────────────────────────────────

interface StorageEntry {
  id: string | null;
  name: string;
  created_at: string | null;
  metadata: { mimetype?: string; size?: number } | null;
}

async function storageFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${SUPABASE_URL}/storage/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${SERVICE_KEY}`,
      apikey: SERVICE_KEY!,
      ...(init?.headers ?? {}),
    },
  });
}

async function listBuckets(): Promise<string[]> {
  const res = await storageFetch("/bucket");
  if (!res.ok) throw new Error(`listBuckets ${res.status}: ${await res.text()}`);
  return ((await res.json()) as Array<{ name: string }>).map((b) => b.name);
}

/**
 * Recursive listing. The Storage list API is directory-shaped: an entry with a
 * null `id` is a prefix, not an object, and must be descended into. Paginated
 * by offset because a bucket can hold more objects than one page returns, and a
 * census that stopped at page one would under-report in exactly the direction
 * that makes the result look reassuring.
 */
async function listObjects(bucket: string, prefix = ""): Promise<StorageEntry[]> {
  const out: StorageEntry[] = [];
  const PAGE = 100;
  let offset = 0;
  for (;;) {
    const res = await storageFetch(`/object/list/${encodeURIComponent(bucket)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prefix,
        limit: PAGE,
        offset,
        sortBy: { column: "name", order: "asc" },
      }),
    });
    if (!res.ok) throw new Error(`list ${bucket}/${prefix} ${res.status}: ${await res.text()}`);
    const page = (await res.json()) as StorageEntry[];
    if (page.length === 0) break;

    for (const e of page) {
      const full = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.id === null) {
        out.push(...(await listObjects(bucket, full)));
      } else {
        out.push({ ...e, name: full });
      }
    }
    if (page.length < PAGE) break;
    offset += PAGE;
  }
  return out;
}

/** Ranged GET — header bytes only. Never the whole object. */
async function fetchHeader(bucket: string, name: string): Promise<Buffer | null> {
  const res = await storageFetch(
    `/object/${encodeURIComponent(bucket)}/${name.split("/").map(encodeURIComponent).join("/")}`,
    { headers: { Range: `bytes=0-${HEADER_BYTES - 1}` } },
  );
  if (!res.ok && res.status !== 206) return null;
  return Buffer.from(await res.arrayBuffer());
}

// ── reachability ─────────────────────────────────────────────────────────────

/**
 * Every value anywhere in the schema that could make an object reachable.
 *
 * WHY THIS IS DISCOVERED AND NOT HARD-CODED
 * -----------------------------------------
 * The first version of this listed post_media and media_assets by hand and
 * reported 277 of 293 objects as unreachable — which was nonsense produced by
 * the omission, not a finding: stamp-artwork is referenced from
 * universal_stamp_catalog and generated_visuals, and profile-media from
 * profiles.avatar_url / cover_photo_url, none of which were consulted. A
 * hand-written column list understates reachability by exactly the columns its
 * author forgot, and "unreachable" is the number most likely to be quoted as
 * alarming, so it is the last one that should depend on my memory of the schema.
 *
 * So the column set is read from information_schema at run time: every text-ish
 * public column whose name looks like a path or a URL. Columns that hold no
 * storage references simply never match, costing nothing.
 *
 * Note this also covers post_media.thumbnail_storage_path (0103), which
 * checkMediaObjects' orphan query omits — that check over-reports orphans by
 * however many thumbnails exist. Flagged, not fixed here.
 */
async function referenceValues(): Promise<{ values: string[]; columns: number }> {
  const cols = await liveQuery<{ table_name: string; column_name: string }>(`
    select table_name, column_name
      from information_schema.columns
     where table_schema = 'public'
       and data_type in ('text', 'character varying')
       and (column_name like '%path%' or column_name like '%url%')
     order by table_name, column_name
  `);
  if (cols.length === 0) return { values: [], columns: 0 };

  const parts = cols.map(
    (c) =>
      `select distinct "${c.column_name}"::text as v from public."${c.table_name}" where "${c.column_name}" is not null`,
  );
  const rows = await liveQuery<{ v: string }>(`${parts.join(" union ")} limit 200000`);
  return { values: rows.map((r) => r.v), columns: cols.length };
}

/**
 * An object is reachable if some reference value IS its name, or ENDS WITH it —
 * columns hold bare paths, bucket-qualified paths and full public URLs
 * interchangeably (see lib/storagePath.ts), so suffix matching is what covers
 * all three forms without parsing each.
 */
function makeReachabilityTest(values: string[]): (bucket: string, name: string) => boolean {
  const exact = new Set(values);
  return (bucket, name) => {
    if (exact.has(name)) return true;
    const qualified = `${bucket}/${name}`;
    for (const v of values) {
      if (v.endsWith(qualified) || v.endsWith(`/${name}`)) return true;
    }
    return false;
  };
}

// ── main ─────────────────────────────────────────────────────────────────────

const buckets = OPTS.buckets ?? (await listBuckets());
const { values: refValues, columns: refColumns } = await referenceValues();
const isReachable = makeReachabilityTest(refValues);
console.log(
  `  reachability basis: ${refValues.length} reference value(s) across ${refColumns} path/url column(s)\n`,
);
const perBucketUnreachable: Record<string, number> = {};

/**
 * `enumerated` is every image object the bucket listing returned; `scanned` is
 * how many of those were actually opened. They are separate on purpose: the
 * headline "total image objects" must be the enumerated figure, or a --limit
 * would quietly shrink the denominator and make the EXIF percentage look better
 * than it is. A capped run reports both and says so.
 */
let enumerated = 0;
let scanned = 0;
let withExif = 0;
let withGps = 0;
let unscanned = 0;
let unreachable = 0;
let unreachableWithGps = 0;
const gpsIds: string[] = [];
const exifIds: string[] = [];
let unreachableWithExif = 0;
let exifMinUp: string | null = null;
let exifMaxUp: string | null = null;
let exifMinTs: string | null = null;
let exifMaxTs: string | null = null;
/** Container census — makes a zero GPS count interpretable rather than merely reassuring. */
const byMime: Record<string, number> = {};
const gpsEntryCounts: number[] = [];
let minTs: string | null = null;
let maxTs: string | null = null;
let skippedByLimit = 0;

for (const bucket of buckets) {
  const entries = await listObjects(bucket);
  const images = entries.filter(
    (e) => (e.metadata?.mimetype ?? "").startsWith("image/") ||
           /\.(jpe?g|png|webp|heic|heif|tiff?|gif)$/i.test(e.name),
  );

  enumerated += images.length;

  // Reachability is a property of the LISTING, not of the scan — it needs no
  // download, so it is computed for every enumerated object even under --limit.
  let bucketUnreachable = 0;
  for (const obj of images) {
    if (!isReachable(bucket, obj.name)) bucketUnreachable++;
  }
  perBucketUnreachable[bucket] = bucketUnreachable;
  unreachable += bucketUnreachable;

  const budget = OPTS.limit === null ? images.length : Math.max(0, OPTS.limit - scanned);
  if (images.length > budget) skippedByLimit += images.length - budget;
  const scan = images.slice(0, budget);

  for (const obj of scan) {
    scanned++;
    const mime = obj.metadata?.mimetype ?? "unknown";
    byMime[mime] = (byMime[mime] ?? 0) + 1;
    const isUnreachable = !isReachable(bucket, obj.name);

    const head = await fetchHeader(bucket, obj.name);
    if (!head || head.length === 0) {
      unscanned++;
      continue;
    }
    const facts = exifFactsFrom(head);
    if (facts === null) {
      unscanned++;
      continue;
    }
    if (facts.hasExif) {
      withExif++;
      if (obj.id) exifIds.push(obj.id);
      if (isUnreachable) unreachableWithExif++;
      // Upload time, tracked separately from capture time: a photo taken in
      // 2019 and uploaded today is a live leak, and a capture-date range would
      // report it as ancient. Only created_at answers "did the strip hold?".
      if (obj.created_at) {
        if (exifMinUp === null || obj.created_at < exifMinUp) exifMinUp = obj.created_at;
        if (exifMaxUp === null || obj.created_at > exifMaxUp) exifMaxUp = obj.created_at;
      }
      const ets = facts.captureTs ?? obj.created_at;
      if (ets) {
        if (exifMinTs === null || ets < exifMinTs) exifMinTs = ets;
        if (exifMaxTs === null || ets > exifMaxTs) exifMaxTs = ets;
      }
    }
    if (facts.hasGpsIfd) {
      withGps++;
      gpsEntryCounts.push(facts.gpsEntryCount);
      if (obj.id) gpsIds.push(obj.id);
      if (isUnreachable) unreachableWithGps++;

      // Date range is over the GPS-CARRYING set: capture time where the file
      // states one, object created_at otherwise.
      const ts = facts.captureTs ?? obj.created_at;
      if (ts) {
        if (minTs === null || ts < minTs) minTs = ts;
        if (maxTs === null || ts > maxTs) maxTs = ts;
      }
    }
  }
}

const summary = {
  project: projectRef,
  buckets,
  totalImageObjects: enumerated,
  scannedForExif: scanned,
  containerBreakdown: byMime,
  carryingAnyExif: withExif,
  exifDateRange: { earliest: exifMinTs, latest: exifMaxTs },
  exifUploadRange: { earliest: exifMinUp, latest: exifMaxUp },
  exifObjectIds: exifIds,
  unreachableAndCarryingExif: unreachableWithExif,
  carryingGpsIfd: withGps,
  gpsIfdEntryCounts: {
    min: gpsEntryCounts.length ? Math.min(...gpsEntryCounts) : null,
    max: gpsEntryCounts.length ? Math.max(...gpsEntryCounts) : null,
  },
  gpsDateRange: { earliest: minTs, latest: maxTs },
  unreachableFromAnyRenderPath: unreachable,
  unreachableByBucket: perBucketUnreachable,
  unreachableAndCarryingGps: unreachableWithGps,
  unscanned,
  skippedByLimit,
  gpsObjectIds: gpsIds,
};

if (OPTS.json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`\nEXIF / GPS census — project ${projectRef}, buckets: ${buckets.join(", ")}\n`);
  console.log(`  image objects enumerated:      ${enumerated}`);
  console.log(`  opened and scanned:            ${scanned}`);
  console.log(`  containers:                    ${Object.entries(byMime).map(([m, n]) => `${m}=${n}`).join(", ")}`);
  console.log(`  carrying any EXIF:             ${withExif}`);
  if (withExif > 0) {
    console.log(`    date range:                  ${exifMinTs ?? "?"} → ${exifMaxTs ?? "?"}`);
    console.log(`    UPLOADED (created_at) range: ${exifMinUp ?? "?"} → ${exifMaxUp ?? "?"}`);
    console.log(`    of those, unreachable:       ${unreachableWithExif}`);
    console.log(`    object ids:                  ${exifIds.join(", ") || "(none with ids)"}`);
  }
  console.log(`  carrying a GPS IFD (0x8825):   ${withGps}`);
  if (withGps > 0) {
    console.log(`    GPS IFD entry count range:   ${summary.gpsIfdEntryCounts.min}–${summary.gpsIfdEntryCounts.max} tags (counts only; no values read)`);
    console.log(`    date range:                  ${minTs ?? "?"} → ${maxTs ?? "?"}`);
    console.log(`    of those, unreachable:       ${unreachableWithGps}`);
  }
  console.log(`  unreachable from render paths: ${unreachable}`);
  for (const [b, n] of Object.entries(perBucketUnreachable)) {
    console.log(`      ${b}: ${n}`);
  }
  console.log(`  unscanned (format/short read): ${unscanned}`);
  if (skippedByLimit > 0) {
    console.log(`\n  NOT A COMPLETE CENSUS: ${skippedByLimit} image object(s) were skipped by --limit.`);
  }
  if (gpsIds.length > 0) {
    console.log(`\n  GPS-carrying object ids (ids only — no paths, no coordinates):`);
    for (const id of gpsIds) console.log(`    ${id}`);
  }
}

process.exit(0);
