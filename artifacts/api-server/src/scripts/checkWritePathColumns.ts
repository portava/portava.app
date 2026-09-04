/**
 * Write-path + read-path column drift check
 *
 * Extracts every column written by `.insert()` / `.upsert()` / `.update()`
 * calls AND every column read by string-literal `.select("col_a, col_b")`
 * lists in src/routes and src/services (via the TypeScript AST — not regex,
 * so chained calls and multi-line payloads are handled correctly) and diffs
 * the referenced columns against the LIVE Supabase schema through the
 * Supabase Management API.
 *
 * The read side matters just as much as the write side: a missing column in
 * a select list fails the WHOLE query (PGRST100) and breaks reads silently.
 *
 * This is the maintained version of the ad-hoc task-1925 wizard-write-path
 * audit (2026-07-20), which found three live drifts (posts filter columns,
 * rent_buddy_bookings.country_code, rent_buddy_policy_flags.updated_at)
 * using a greedy perl extraction that bled across chained calls.  Running
 * this script catches the whole failure class: any route that starts
 * writing a column before its migration is applied live.
 *
 * What counts as a write site:
 *   - a call chain that contains `.from("<string literal>")` followed
 *     (anywhere later in the chain) by `.insert(...)`, `.upsert(...)` or
 *     `.update(...)`
 *   - payload columns are collected from object-literal arguments, arrays
 *     of object literals, and (one level deep) same-file `const x = {...}`
 *     variables passed by identifier
 *
 * What counts as a read site:
 *   - a call chain that contains `.from("<string literal>")` followed by
 *     `.select("<string literal>")`
 *   - the select list is parsed PostgREST-style: aliases (`alias:col`),
 *     casts (`col::text`), JSON paths (`col->x`, `col->>x`) all resolve to
 *     the base column; `*`, `count`, and embedded resources
 *     (`rel(...)`, including `rel!hint(...)`) are skipped — embedded
 *     resources reference OTHER tables and are out of scope here
 *
 * Skipped-but-TRACKED (the blind spot must not grow silently):
 *   - dynamic table names (`.from(tableVar)`)
 *   - payloads that cannot be statically resolved (function results,
 *     imported values, spreads — spread keys that ARE statically visible
 *     are still collected)
 *   - non-literal select lists (template strings with substitutions,
 *     variables)
 *   Every such site is counted against UNRESOLVED_ALLOWLIST below, keyed by
 *   `file|method|reason` (line numbers churn, so counts per key are used).
 *   A NEW unresolvable site — a new key, or more sites under an existing
 *   key — turns the check red: either rewrite the site so it is statically
 *   resolvable, or consciously bump the allowlist entry.
 *
 * Usage (from artifacts/api-server):
 *   pnpm run check:write-path-columns          # diff against live schema
 *   pnpm run check:write-path-columns -- --verbose
 *   pnpm run check:write-path-columns -- --print-unresolved-allowlist
 *       # emit the UNRESOLVED_ALLOWLIST block matching the current tree
 *
 * Exit code 0 → every extracted column exists live (or is allowlisted)
 * Exit code 1 → at least one written column is missing from the live schema
 * Exit code 2 → environment / API error
 */

// ── THE ALLOWLIST ASSERTION, IN THE EXECUTION PATH ───────────────────────────
//
// FIRST import, deliberately: ES modules evaluate their imports in source
// order, before the importing module's own body, so this runs before anything
// else in this file. It asserts the project this process is pointed at and
// exits 2 — this script's own "environment / API error" code — if it cannot
// establish it.
//
// It is not a workflow step, so no YAML edit can skip it. This script is
// reached from live-db.yml's api-server-check-all job via check:all ->
// scripts/run-all-checks.sh; deleting the `Preflight — Supabase target must be
// the sanctioned CI project` step from that job, disabling it with `if:`,
// moving it after the install step, or adding a brand-new job in a brand-new
// workflow file all still land here, because this process cannot start
// without it.
//
// This is the READ-ONLY front door, not src/lib/ciSupabaseGuard.mjs. In CI it
// behaves identically — the sanctioned CI project, or exit 2. Outside CI, and
// only outside CI, it additionally permits a read-only audit of the declared
// production project when the operator asks for it by name:
//
//   PORTAVA_PROD_READ_ONLY_AUDIT='read-only-audit-against-production'
//
// This script qualifies despite its name. `WRITE_METHODS` and the "write
// sites" it talks about are things it finds in the TYPESCRIPT AST of
// src/routes and src/services — it reads insert/upsert/update call sites out
// of source files on disk. It performs none of them. Its only contact with the
// database is three SELECTs: information_schema.columns, pg_class, and the
// one-row `select handle, is_official from profiles where handle = 'portava'`
// smoke test. If it ever gains a write, move it back to
// src/lib/ciSupabaseGuard.mjs and drop it from the read-only list in
// scripts/check-guard-coverage.mjs, which enforces that list on every run.
//
// See src/lib/ciProdReadOnlyAuditGuard.mjs and docs/ci/README.md.
import "../lib/ciProdReadOnlyAuditGuard.mjs";

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { extractSchemaReferences } from "./lib/schemaReferenceExtract.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(__dir, "../..");
const SCAN_DIRS = [resolve(__dir, "../routes"), resolve(__dir, "../services")];
const VERBOSE = process.argv.includes("--verbose");
const PRINT_UNRESOLVED_ALLOWLIST = process.argv.includes(
  "--print-unresolved-allowlist",
);

// ── Allowlist ─────────────────────────────────────────────────────────────────
//
// "table.column" pairs that are known-good despite not existing in the live
// public schema (or that are intentionally written pre-migration).  Keep this
// list SHORT and annotated — every entry is a hole in the check.
const ALLOWLIST = new Set<string>([
  // Add entries here only for columns that are intentionally written
  // pre-migration and have not yet been applied to the live schema.
  // Remove each entry immediately after the corresponding migration is verified.
  //
  // memory_feedback.corrected_value — added by 2213_memory_passport_controls.sql
  // for the §12 "Correct" control (records the value the user says is right
  // alongside a kind='incorrect' signal). Written by the passport/remembers
  // correct route; remove this entry once 2213 is applied to the live schema.
  "memory_feedback.corrected_value",
  //
  // intel_state_snapshots.{confidence_components, algorithm_version,
  // input_claim_versions, conflict_state} — added by
  // 2273_intel_replayable_projection.sql (IG unit I1, Table-17 lineage) and
  // written by lib/intelProjection.projectAndStore. Applied to the CI project
  // on merge to main; remove these four entries once that apply is certified.
  "intel_state_snapshots.confidence_components",
  "intel_state_snapshots.algorithm_version",
  "intel_state_snapshots.input_claim_versions",
  "intel_state_snapshots.conflict_state",
]);

// Tables that are not real live relations and should be skipped entirely
// (e.g. test doubles or tables owned by another system).
const SKIP_TABLES = new Set<string>([
  // Add entries here only for tables whose migration is intentionally pending
  // live application. Remove immediately after verification.
  //
  // intel_state_snapshot_versions — created by 2273_intel_replayable_projection.sql
  // (IG unit I1). Written by lib/intelProjection, read by lib/intelReplay.
  // Remove once 2273 is applied to the live schema.
  "intel_state_snapshot_versions",
]);

// ── Unresolvable-site allowlist ───────────────────────────────────────────────
//
// Every write/read site the AST extraction CANNOT statically resolve is a
// blind spot where a phantom column can still sneak through.  Each is
// tracked here as `file|method|reason` → expected count (line numbers churn
// too much to key on).  If a NEW unresolvable site appears — a new key, or
// more sites under an existing key — the check FAILS: rewrite the site so
// the payload/select list is statically resolvable, or consciously bump the
// entry here.  If a count DROPS, the check also fails so the entry gets
// trimmed (keeping the ledger honest).
//
// Regenerate the whole block with:
//   pnpm run check:write-path-columns -- --print-unresolved-allowlist
//
// Burn this list down — every entry is a hole in the check.
const UNRESOLVED_ALLOWLIST = new Map<string, number>([
  // ── Dynamic table names (adminGeocode — runtime table dispatch) ───────────
  ["src/routes/adminGeocode.ts|select|dynamic table name", 2],
  ["src/routes/adminGeocode.ts|update|dynamic table name", 2],
  ["src/routes/adminGeocode.ts|upsert|dynamic table name", 2],

  // ── select(BUDDY_PUBLIC_COLUMNS) — one constant, verified at its definition ─
  //
  // These sites pass the imported BUDDY_PUBLIC_COLUMNS constant rather than a
  // literal, and resolveSelectString follows an identifier only to a SAME-FILE
  // initializer, so it cannot see through the import.
  //
  // They are a weaker blind spot than most entries here. The risk this check
  // exists to catch is a select list naming a column that does not exist —
  // PostgREST then fails the WHOLE read with PGRST100 (exactly the
  // places.country bug). That risk is already covered for this string:
  // lib/buddyMapRead.ts defines BUDDY_PUBLIC_COLUMNS and calls
  // .select(BUDDY_PUBLIC_COLUMNS) in the same file, so it IS statically
  // resolved and column-checked there, on every run. These seven sites pass
  // the identical constant.
  //
  // The alternative was inlining the literal at each site, which would put
  // seven copies of the public-column allow-list back in the tree — the exact
  // drift that consolidating onto one constant removed, and a privacy drift
  // rather than a schema one. A verified-elsewhere blind spot beats that.
  //
  // THE EXCEPTION IS ONLY VALID WHILE THAT VERIFICATION EXISTS, and that is a
  // load-bearing, invisible condition: move the constant to a shared module, or
  // refactor buddyMapRead so it no longer selects through it in the same file,
  // and the live column check silently stops covering this string — leaving
  // these entries sitting here looking considered while the sites go genuinely
  // blind. So the condition is pinned executably in
  // src/test/buddyColumnsAllowlistJustification.test.ts, which fails if the
  // definition moves, if the initializer stops being a literal, if the
  // same-file select disappears, if these entries are removed, or if
  // resolveSelectString learns to follow imports (in which case these sites
  // resolve on their own and the entries should be DROPPED, not kept).
  //
  // If these ever stop passing that constant, the counts change and this
  // fails, which is the intended tripwire.
  ["src/routes/rentABuddy.ts|select|select list not statically resolvable", 4],
  ["src/routes/rentABuddyMarketplace.ts|select|select list not statically resolvable", 3],

  // ── Insert/upsert payloads built at runtime ───────────────────────────────
  ["src/routes/circle.ts|upsert|payload not statically resolvable", 1],
  // 3 sites: feed-section registration + the two /compass/ask uiBlock
  // registration upserts (chat recommendation tokens) — row arrays built
  // dynamically from RecommendationRow; columns verified by the feed paths.
  ["src/routes/compass.ts|upsert|payload not statically resolvable", 3],
  ["src/routes/compass.ts|upsert|payload partially resolvable", 2],
  // E2EE key-package upload — payload built from a dynamic array of base64 strings.
  ["src/routes/keyPackages.ts|insert|payload not statically resolvable", 1],
  // mediaFeed impression logging — upsert row array built at runtime.
  ["src/routes/mediaFeed.ts|insert|payload not statically resolvable", 1],
  ["src/routes/meetups.ts|insert|payload not statically resolvable", 2],
  ["src/routes/memories.ts|insert|payload not statically resolvable", 2],
  ["src/routes/rentABuddy.ts|insert|payload not statically resolvable", 1],
  ["src/routes/rentABuddyMarketplace.ts|insert|payload not statically resolvable", 1],
  ["src/routes/rentABuddyMarketplace.ts|upsert|payload not statically resolvable", 1],
  ["src/routes/rentABuddySpec.ts|upsert|payload not statically resolvable", 2],
  // Dynamic array built from AI extraction output — columns verified by the surrounding route logic.
  ["src/routes/tripReservations.ts|insert|payload not statically resolvable", 1],
  ["src/routes/routePlan.ts|insert|payload not statically resolvable", 2],
  ["src/routes/stampShowcase.ts|insert|payload not statically resolvable", 1],
  ["src/routes/telegraphChat.ts|insert|payload not statically resolvable", 1],
  ["src/routes/telegraphChat.ts|update|payload not statically resolvable", 1],
  ["src/routes/trips-expansion.ts|insert|payload not statically resolvable", 1],
  ["src/routes/trips.ts|insert|payload not statically resolvable", 1],
  ["src/services/groupChatSync.ts|upsert|payload not statically resolvable", 2],
  ["src/services/hiddenGems/HiddenGemService.ts|update|payload not statically resolvable", 2],
  // MediaFeedRankingService: storeRankingSnapshots builds the upsert row array dynamically.
  // Columns: viewer_id, item_id, surface, session_id, position, final_score, reason_codes, served_at.
  ["src/services/ranking/MediaFeedRankingService.ts|upsert|payload not statically resolvable", 1],
  ["src/services/safeReturn/SafeReturnService.ts|insert|payload not statically resolvable", 1],

  // ── Partially-resolvable payloads (static keys + dynamic spread/computed) ─
  ["src/routes/messaging.ts|update|payload partially resolvable", 1],
  ["src/routes/messaging.ts|upsert|payload partially resolvable", 1],
  ["src/routes/profile.ts|upsert|payload partially resolvable", 1],
  ["src/routes/rentABuddy.ts|update|payload partially resolvable", 1],
  ["src/routes/trust-admin.ts|update|payload partially resolvable", 1],
  ["src/services/notifications/NotificationPreferenceService.ts|upsert|payload partially resolvable", 1],
  ["src/services/rentBuddy/ReliabilityCounters.ts|update|payload partially resolvable", 1],
  ["src/services/trust/TrustAdminService.ts|upsert|payload partially resolvable", 1],

  // ── Dynamic table name (messaging — dispatches to per-channel tables) ─────
  ["src/routes/messaging.ts|select|dynamic table name", 1],
  // Recap parent is explicitly limited to the two canonical parent tables.
  ["src/routes/placeRecaps.ts|select|dynamic table name", 2],
  // ── Media v2 owner-count / rank helpers (landed unallowlisted in #297) ────
  //
  // Both are private helpers whose ONLY callers pass table-name string literals:
  //   MediaProjectionService.countOwned  <- "passport_postcards", "memories",
  //                                         "hidden_gems", "media_assets"
  //   MyWorldMemoryService.distinctUserRank <- "hidden_gem_contributions",
  //                                            "hidden_gem_visits"
  // They are allowlisted rather than rewritten because a rewrite would buy no
  // coverage here: countOwned selects "*", and distinctUserRank's select list is
  // a template string whose only substitution is the caller's own timeCol — so
  // even with a literal table name this checker would still have no static
  // column list to compare against the live schema. The blind spot is the
  // wildcard/dynamic SELECT, not the table identifier.
  //
  // These two sites are why `api-server · check:all` has been red on main since
  // #297; #312 merged through it. Cleared here so the branch can be judged on
  // its own checks.
  ["src/services/media/MediaProjectionService.ts|select|dynamic table name", 1],
  ["src/services/media/MyWorldMemoryService.ts|select|dynamic table name", 1],

  // ── Dynamic insert table name ─────────────────────────────────────────────
  // post_event_links is a new join table (migration 20260731_post_event_links.sql);
  // the insert uses `as any` cast to avoid database.types.ts drift until types regenerated.
  ["src/routes/postcards.ts|insert|dynamic table name", 2],

  // ── Partially-resolvable select lists (static prefix + dynamic suffix) ────
  //
  // These sites have at least one statically-known column set (now audited
  // against the live schema) but also a dynamic part that cannot be resolved
  // (e.g. `+ await stampOverlayCol(sc)` or `+ await artCol(sc)` inside an
  // embedded resource — embedded columns are skipped by parseSelectList so
  // artCol drift is harmless to the checker regardless).
  ["src/routes/mediaFeed.ts|select|payload partially resolvable", 3],
  ["src/routes/passport.ts|select|payload partially resolvable", 2],
  // 5 sites: POST_MEDIA_FEED_COLUMNS + await stampOverlayCol (×4) and
  // "id, media_type, …" + await stampOverlayCol (×1).  The stamp_overlay
  // column is additive — its presence in the DB is verified separately.
  // 2 additional sites use OWNER_POSTCARD_COLUMNS (partially resolved).
  //
  // The 4th POST_MEDIA_FEED_COLUMNS site is withPostMedia() (#3585), which
  // attaches post_media to the mutation and pending responses. It is the same
  // shape as the three feed reads beside it and unresolvable for the same
  // reason: the optional-column probes stampOverlayCol/feedVariantCol are
  // resolved at runtime because those columns may not exist yet in every
  // environment (0129 / 0208).
  //
  // Deliberately allowlisted rather than rewritten. Dropping the probes would
  // make the select statically resolvable, but it would also drop stamp_overlay
  // and feed_url from every mutation response — so editing a post would strip
  // its stamp overlay until the next refetch, which is a worse bug than the one
  // being fixed. This is the "cannot be made resolvable without losing
  // behaviour" case the list exists for, not an unexamined addition.
  ["src/routes/posts.ts|select|payload partially resolvable", 7],
  ["src/routes/pulse.ts|select|payload partially resolvable", 1],
  // rentABuddy: select lists that mix static columns with awaited sub-selects.
  // stamps: OWNER_STAMP_COLS / PUBLIC_STAMP_COLS prefix is now audited; the
  // stamp_definitions embedded resource + artCol suffix are skipped/dynamic.
  ["src/routes/stamps.ts|select|payload partially resolvable", 9],
  ["src/services/hiddenGems/HiddenGemService.ts|select|payload partially resolvable", 1],

  // ── Truly unresolvable select lists (dynamic variable / runtime value) ────
  // stamps.ts: one select via runtime `colSet` variable (owner vs public branch).
  ["src/routes/stamps.ts|select|select list not statically resolvable", 1],
  // HiddenGemService: 5 sites use select lists composed at runtime (dynamic
  // field arrays keyed by gem tier). Columns verified by the surrounding service logic.
  ["src/services/hiddenGems/HiddenGemService.ts|select|select list not statically resolvable", 5],
  // ReliabilityCounters: one select list built at runtime from a scoring formula.
  ["src/services/rentBuddy/ReliabilityCounters.ts|select|select list not statically resolvable", 1],
]);

// ── Read-path baseline ────────────────────────────────────────────────────────
//
// Pre-existing read-side drift found when select-list checking was added
// (2026-07-21).  These "table.column" pairs are selected by routes but absent
// live — each is a latent PGRST100 failure on that query.  They are
// BASELINED (not allowlisted-as-good) so the checker stays green while
// guarding against NEW read drift.  Burn this list down: either apply the
// missing migration or fix the select list, then delete the entry.
// Applies to `select` sites only — never to writes.
const READ_BASELINE = new Set<string>([
  // (empty — all previously baselined read-path drifts have been resolved)
]);

// Tables read via `.select()` that do not exist live at all (same baseline
// semantics as READ_BASELINE).
const READ_BASELINE_TABLES = new Set<string>([]);

// ── Environment ───────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL;
// Prefer SUPABASE_PROJECT_TOKEN (project-scoped, safe for CI) over the
// personal SUPABASE_ACCESS_TOKEN — mirrors auditMigrationsVsLive.ts.
const ACCESS_TOKEN =
  process.env.SUPABASE_PROJECT_TOKEN || process.env.SUPABASE_ACCESS_TOKEN;

if (!SUPABASE_URL || !ACCESS_TOKEN) {
  console.error(
    "ERROR: SUPABASE_URL and a Supabase token must be set.\n" +
      "       Set SUPABASE_PROJECT_TOKEN (project-scoped, preferred for CI)\n" +
      "       or SUPABASE_ACCESS_TOKEN (personal access token).",
  );
  process.exit(2);
}

const projectRef = new URL(SUPABASE_URL).hostname.split(".")[0];

async function liveQuery<T = Record<string, unknown>>(
  query: string,
): Promise<T[]> {
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
  if (!res.ok) {
    throw new Error(`Management API ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T[];
}

// ── AST extraction ────────────────────────────────────────────────────────────
//
// The extractor MOVED to lib/schemaReferenceExtract.ts. It used to live here,
// welded to this file's `import "../lib/ciProdReadOnlyAuditGuard.mjs"` — which
// refuses to run without live credentials, so nothing without a database could
// reuse it.
//
// That coupling had a cost. This check is the one that catches `places.country`,
// and it can only run on the live lane; of 100 sampled live-DB runs, 64 were
// cancelled and 45% of commits got no verdict at all. `places.country` reached
// main through that gap. The same extraction now also feeds
// `check:schema-references`, which diffs against the CANONICAL schema
// (baseline + migrations) and therefore runs everywhere, on every PR.
//
// One extractor, two schema sources, two different questions — see
// checkSchemaReferences.ts for the ownership split. This file keeps the LIVE
// question: has the database drifted from what the code expects?

// ── Main ──────────────────────────────────────────────────────────────────────

const { sites, skipped } = extractSchemaReferences(API_ROOT, SCAN_DIRS);

const referencedTables = [
  ...new Set(sites.map((s) => s.table).filter((t) => !SKIP_TABLES.has(t))),
].sort();

console.log(
  `Extracted ${sites.length} statically-resolvable write/read sites across ` +
    `${referencedTables.length} tables (${skipped.length} sites skipped as unresolvable).`,
);

interface LiveCol {
  t: string;
  c: string;
}

console.log(`Fetching live schema (project ${projectRef}) …`);
let liveCols: LiveCol[];
let liveRels: { name: string }[];
try {
  [liveCols, liveRels] = await Promise.all([
    liveQuery<LiveCol>(
      `select table_name as t, column_name as c
       from information_schema.columns where table_schema = 'public'`,
    ),
    liveQuery<{ name: string }>(
      `select c.relname as name from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r','p','v','m')`,
    ),
  ]);
} catch (err) {
  console.error("ERROR: failed to fetch live schema:", err);
  process.exit(2);
}

const liveColumnSet = new Set(liveCols.map((r) => `${r.t}.${r.c}`));
const liveRelationSet = new Set(liveRels.map((r) => r.name));

// ── Diff ──────────────────────────────────────────────────────────────────────

interface Finding {
  table: string;
  column: string;
  where: string[]; // "file:line (method)"
}

const missingByKey = new Map<string, Finding>();
const missingTables = new Map<string, string[]>();

let baselined = 0;

for (const site of sites) {
  if (SKIP_TABLES.has(site.table)) continue;
  const isRead = site.method === "select";
  const where = `${site.file}:${site.line} (${site.method})`;
  if (!liveRelationSet.has(site.table)) {
    if (isRead && READ_BASELINE_TABLES.has(site.table)) {
      baselined++;
      if (VERBOSE) console.log(`  baselined (read): table ${site.table} — ${where}`);
      continue;
    }
    const list = missingTables.get(site.table) ?? [];
    list.push(where);
    missingTables.set(site.table, list);
    continue;
  }
  for (const col of site.columns) {
    const key = `${site.table}.${col}`;
    if (liveColumnSet.has(key) || ALLOWLIST.has(key)) continue;
    if (isRead && READ_BASELINE.has(key)) {
      baselined++;
      if (VERBOSE) console.log(`  baselined (read): ${key} — ${where}`);
      continue;
    }
    const f = missingByKey.get(key) ?? {
      table: site.table,
      column: col,
      where: [],
    };
    f.where.push(where);
    missingByKey.set(key, f);
  }
}

if (VERBOSE && skipped.length > 0) {
  console.log("\nSkipped (unresolvable) write sites:");
  for (const s of skipped) {
    console.log(`  ${s.file}:${s.line} (${s.method}) — ${s.reason}`);
  }
}

// ── Unresolvable-site ledger ──────────────────────────────────────────────────
//
// Fully-unresolvable sites (skipped) AND partially-unresolved payloads
// (statically visible keys plus a spread/computed part we can't see) are
// both blind spots.  Count them per `file|method|reason` key and diff
// against UNRESOLVED_ALLOWLIST.

const unresolvedCounts = new Map<string, number>();
const unresolvedWhere = new Map<string, string[]>();
function trackUnresolved(file: string, line: number, method: string, reason: string) {
  const key = `${file}|${method}|${reason}`;
  unresolvedCounts.set(key, (unresolvedCounts.get(key) ?? 0) + 1);
  const list = unresolvedWhere.get(key) ?? [];
  list.push(`${file}:${line}`);
  unresolvedWhere.set(key, list);
}
for (const s of skipped) trackUnresolved(s.file, s.line, s.method, s.reason);
for (const s of sites) {
  if (s.unresolved) {
    trackUnresolved(s.file, s.line, s.method, "payload partially resolvable");
  }
}

if (PRINT_UNRESOLVED_ALLOWLIST) {
  console.log("\nconst UNRESOLVED_ALLOWLIST = new Map<string, number>([");
  for (const [key, count] of [...unresolvedCounts].sort()) {
    console.log(`  ["${key}", ${count}],`);
  }
  console.log("]);");
  process.exit(0);
}

let failed = false;

const newUnresolved: string[] = [];
const staleUnresolved: string[] = [];
for (const [key, count] of [...unresolvedCounts].sort()) {
  const allowed = UNRESOLVED_ALLOWLIST.get(key) ?? 0;
  if (count > allowed) {
    newUnresolved.push(
      `  ${key} — ${count} site(s), allowlisted ${allowed}\n` +
        unresolvedWhere
          .get(key)!
          .map((w) => `      ${w}`)
          .join("\n"),
    );
  } else if (count < allowed) {
    staleUnresolved.push(`  ${key} — allowlisted ${allowed}, found ${count}`);
  }
}
for (const [key, allowed] of [...UNRESOLVED_ALLOWLIST].sort()) {
  if (!unresolvedCounts.has(key)) {
    staleUnresolved.push(`  ${key} — allowlisted ${allowed}, found 0`);
  }
}

if (newUnresolved.length > 0) {
  failed = true;
  console.error(
    "\n✗ NEW unresolvable write/read sites (not in UNRESOLVED_ALLOWLIST):",
  );
  for (const entry of newUnresolved) console.error(entry);
  console.error(
    "\nThese sites are blind spots — the column check cannot verify them " +
      "against the live schema. Prefer rewriting the site so the payload/" +
      "select list is statically resolvable. If that is genuinely not " +
      "possible, regenerate the ledger with\n" +
      "  pnpm run check:write-path-columns -- --print-unresolved-allowlist\n" +
      "and update UNRESOLVED_ALLOWLIST in this script.",
  );
}

if (newUnresolved.length === 0 && staleUnresolved.length === 0) {
  const total = [...unresolvedCounts.values()].reduce((a, b) => a + b, 0);
  console.log(
    `\n⚠ ${total} unresolvable write/read sites tracked in UNRESOLVED_ALLOWLIST ` +
      "(blind spots — burn the list down; run with --verbose for locations).",
  );
}

if (staleUnresolved.length > 0) {
  failed = true;
  console.error(
    "\n✗ Stale UNRESOLVED_ALLOWLIST entries (fewer sites than allowlisted — trim the ledger):",
  );
  for (const entry of staleUnresolved) console.error(entry);
  console.error(
    "\nRegenerate with: pnpm run check:write-path-columns -- --print-unresolved-allowlist",
  );
}

if (baselined > 0) {
  console.log(
    `\n⚠ ${baselined} read-site references matched the READ_BASELINE ` +
      "(pre-existing read drift — see the annotated list in this script; " +
      "burn it down, don't grow it).",
  );
}

if (missingTables.size > 0) {
  failed = true;
  console.error("\n✗ Referenced TABLES missing from the live schema:");
  for (const [table, where] of [...missingTables].sort()) {
    console.error(`  ${table}`);
    for (const w of [...new Set(where)]) console.error(`      ${w}`);
  }
}

if (missingByKey.size > 0) {
  failed = true;
  console.error("\n✗ Referenced COLUMNS missing from the live schema:");
  for (const [key, f] of [...missingByKey].sort()) {
    console.error(`  ${key}`);
    for (const w of [...new Set(f.where)]) console.error(`      ${w}`);
  }
  console.error(
    "\nEach of these fails the WHOLE query: writes are rejected even when " +
      "the value is null, and a missing select-list column fails the read " +
      "with PGRST100. Apply the migration that adds the column via the " +
      "Management API and record it in docs/migrations.md, or add a " +
      "justified ALLOWLIST entry in this script.",
  );
}

// ── @portava profile smoke-test ───────────────────────────────────────────────
//
// The @portava official account must always be present in the live DB.
// A missing row means a new environment or DB reset has not run the seeder.
// This check fails loudly so the gap is caught before any deployment.

console.log("\nChecking @portava profile row …");
try {
  const portavaRows = await liveQuery<{ handle: string; is_official: boolean }>(
    `select handle, is_official from profiles where handle = 'portava' limit 1`,
  );
  if (portavaRows.length === 0) {
    failed = true;
    console.error(
      "\n✗ @portava profile row is MISSING from the live DB.\n" +
        "  Run the seeder to fix this:\n" +
        "    cd artifacts/api-server\n" +
        "    node --env-file-if-exists=.env --import tsx/esm src/scripts/seed-portava-account.ts",
    );
  } else {
    const row = portavaRows[0];
    if (!row.is_official) {
      failed = true;
      console.error(
        "\n✗ @portava profile exists but is_official=false.\n" +
          "  Re-run the seeder to patch it:\n" +
          "    cd artifacts/api-server\n" +
          "    node --env-file-if-exists=.env --import tsx/esm src/scripts/seed-portava-account.ts",
      );
    } else {
      console.log("✓ @portava profile row present (is_official=true).");
    }
  }
} catch (err) {
  failed = true;
  console.error("ERROR: could not query @portava profile row:", err);
}

if (!failed) {
  console.log(
    `✓ All ${referencedTables.length} referenced tables and every extracted ` +
      "written/selected column exist in the live schema (or are baselined).",
  );
  process.exit(0);
}
process.exit(1);
