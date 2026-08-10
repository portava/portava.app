/**
 * discovery_cache key-count diagnostic — READ-ONLY.
 *
 * THE QUESTION THIS ANSWERS
 * -------------------------
 * Discovery has ZERO rows in `rank_events` even though 'discovery' is a
 * permitted surface and `routes/discovery.ts` calls `logImpression`. The
 * established mechanism is that Discovery's shared place cache ("cache A")
 * serves most requests, and every cache-A serve is UNRANKED and UNLOGGED:
 *
 *   routes/discovery.ts:1089  serveCachedPlaces() — merges DB places, filters,
 *                             slices, responds. It never ranks and never logs.
 *   routes/discovery.ts:1114  L1 hit       -> serveCachedPlaces() then `return`
 *   routes/discovery.ts:1130  L2 fresh hit -> serveCachedPlaces() then `return`
 *   routes/discovery.ts:1151  L2 stale hit -> serveCachedPlaces() then `return`
 *   routes/discovery.ts:1339  rankCandidates() — reached only on a cache MISS
 *   routes/discovery.ts:1433  logImpression(..., "discovery") — same, miss only
 *
 * So the only serve path that can produce a `rank_events` row is the cold
 * fetch. The open question was which path DOMINATES, which normally needs
 * production request counts that nobody has.
 *
 * THE ARITHMETIC — WHAT IT REPLACES LOGS WITH, WHICH IS AN ASSUMPTION
 * ------------------------------------------------------------------
 * Cache A is keyed by `cacheKey(destination, category, radiusKm)`
 * (routes/discovery.ts:159) — user-independent — and a cold fetch writes that
 * key straight back into both layers (routes/discovery.ts:1203-1207, via
 * lib/discoveryPersistentCache.ts:85 `writePlacesToDb`) with a 2-hour TTL
 * (lib/discoveryPersistentCache.ts:19 `PLACE_TTL_MS`).
 *
 * From that, IF requests for one key never overlap in time, one distinct key
 * can trigger at most one cold fetch per TTL window, and the cold fetch is the
 * only path that logs:
 *
 *   max cold fetches in a window  <=  distinct_keys * (window / TTL)
 *
 * This script measures `distinct_keys` and spells the multiplication out so a
 * human can check the reasoning rather than trust a number.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE ASSUMPTION THE CEILING RESTS ON — IT IS NOT A HARD UPPER BOUND
 * ══════════════════════════════════════════════════════════════════════════
 * "One cold fetch per key per TTL" is NOT enforced by the code. There is NO
 * in-flight deduplication on the places path. Read routes/discovery.ts:1124
 * onward: a request that finds no L2 row falls straight through to the cold
 * pipeline (:1155 onward) and only writes the cache at :1203-1207, AFTER the
 * Overpass round-trip. Nothing registers "a fetch for this key is already
 * running", so N concurrent requests for the same cold key all miss, all
 * cold-fetch, and all log.
 *
 * The codebase already knows this pattern — it just does not apply it here:
 * `_geocodePending` (routes/discovery.ts:173, used at :244/:263) is exactly an
 * in-flight promise map, and it exists ONLY for geocode. Adding the same
 * pending-promise map around the places cold path is what would turn the
 * expression below from an assumption into a true bound.
 *
 * DIRECTION OF THE ERROR — this is the part that must not be misread.
 * Concurrency pushes real cold fetches ABOVE the expression, not below it. So
 * the expression is a per-key-serialised ESTIMATE, and the argument "the
 * ceiling is far below request volume, therefore cache A dominates" is
 * WEAKENED by concurrency, not strengthened: the same high request volume that
 * makes the gap look big is what makes overlapping misses likely in the first
 * place. Do not read a large gap as proof. It is evidence only to the extent
 * that same-key requests are actually serialised, which nothing here measures.
 *
 * Concurrency gets its own section because it is the term most often forgotten,
 * NOT because it is the only term with that sign. It is not. The full tally is:
 *
 *   UP (real cold fetches EXCEED the printed figure)
 *     U1. Concurrency — no in-flight dedup, so N overlapping misses on one cold
 *         key all fetch and all log. Bounded by nothing this script can see.
 *     U2. Keys that never persist an L2 row. routes/discovery.ts:1203 writes
 *         BOTH layers only `if (enrichedOsm.length > 0)`, so a key whose
 *         Overpass query comes back empty or times out is cached in neither L1
 *         nor L2 and cold-fetches on EVERY request. It is absent from K, and
 *         because it is never cached there is no TTL to divide by at all — this
 *         term has no per-key ceiling of any kind. See limitation 3.
 *     U3. L2 rows deleted outside the TTL cycle. Save / un-save and admin image
 *         actions DELETE matching rows (lib/discoveryPersistentCache.ts:173,
 *         :210). A key whose row is deleted mid-window can cold-fetch again in
 *         that same window, so "K * windows" undercounts it; and a key deleted
 *         before this script runs is missing from K entirely.
 *     U4. Keys warmed into L1 only. GET /api/discovery/counts
 *         (routes/discovery.ts:1542) does `cache.set` with no `writePlacesToDb`,
 *         so those keys never appear in K even though the main route can still
 *         cold-fetch them on another instance or after a restart.
 *
 *   DOWN (real cold fetches FALL SHORT of the printed figure)
 *     D1. L1 hits — an in-process Map (routes/discovery.ts:144) this script
 *         cannot see; every hit is a serve that consumed no cold fetch.
 *     D2. "Any existing row is served" — once a key has an L2 row, fresh OR
 *         stale, the main route stops cold-fetching it altogether rather than
 *         once per TTL (routes/discovery.ts:1130, :1151).
 *
 *   DOWN, but on LOGGING rather than on cold fetches — do not add it to either
 *   column above without saying which quantity it moves:
 *     S1. Both Compass branches return before logImpression (see limitation 2),
 *         so some cold fetches produce no impression rows at all.
 *
 * Nothing here measures any of these against the others, so the NET DIRECTION IS
 * UNKNOWN. The printed figure is an estimate that can err in either direction,
 * and U2 in particular is unbounded.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Within the per-key-serialised assumption, the expression is LOOSER than the
 * code in one further respect: `readPlacesFromDb`
 * (lib/discoveryPersistentCache.ts:47) returns a row whether it is fresh or
 * stale, and BOTH branches serve and `return` (routes/discovery.ts:1130 and
 * :1151) — the stale branch revalidates in the background. So once a key has
 * an L2 row at all, the main route stops cold-fetching for it entirely; the
 * "once per 2h" allowance is generous on purpose. That is term D2 in the tally
 * above. It is real, but it does not cancel U1-U4 — none of these terms is
 * measured against any other anywhere, so the net direction stays unknown.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT THIS SCRIPT CANNOT SEE — READ THIS BEFORE QUOTING ANY NUMBER
 * ══════════════════════════════════════════════════════════════════════════
 * 1. IT SEES ONLY L2. L1 is `const cache = new Map()` at
 *    routes/discovery.ts:144 — in-process memory, one copy per server
 *    instance, invisible to any database query and invisible to this script.
 *    Every L1 hit is a serve that consumed no cold fetch. This term is
 *    one-directional DOWNWARD: it makes real cold fetches fewer, never more.
 *    It does not make the ceiling a hard bound on its own — every UP term in
 *    the tally above (U1-U4) points the other way and none is measured here.
 *
 * 2. IT CANNOT SEE CACHE B AT ALL. The Compass candidate cache
 *    (`_compassCandidateCache`, routes/discovery.ts:153) is a different cache:
 *    per-user, per-city, 10-minute TTL, and it holds POST-ranking output. It
 *    is also in-process memory with no table behind it. Nothing below
 *    separates it from cache A, because nothing below can observe it. Note
 *    separately that BOTH Compass branches — the candidate-cache hit at
 *    routes/discovery.ts:1228 and the candidate-cache miss at :1272 — respond
 *    and `return` before the `logImpression` call at :1433, so `for_you`
 *    traffic under the COMPASS_V1_RULE_BASED_ENABLED flag does not log on the
 *    'discovery' surface even on a cold fetch. That pushes real logging
 *    further below the ceiling; it does not raise it.
 *
 * 3. A KEY THAT NEVER PERSISTS A ROW IS INVISIBLE — terms U2, U3 and U4 of the
 *    tally above, and the most damaging of the three is U2. The cold path writes
 *    the cache only when Overpass returned something (`if (enrichedOsm.length >
 *    0)`, routes/discovery.ts:1203), and BOTH the L1 `cache.set` (:1204) and the
 *    L2 `writePlacesToDb` (:1206) sit inside that one `if`. So a key whose
 *    Overpass query is empty or times out is cached in NEITHER layer: it
 *    cold-fetches on EVERY request, this script never counts it, and — the point
 *    to notice — there is no TTL to divide by, so no per-key allowance bounds it
 *    the way "one fetch per 2 h" bounds a key that does persist. This term is
 *    unbounded by anything in the arithmetic below.
 *    Two smaller variants of the same gap: `GET /api/discovery/counts`
 *    (routes/discovery.ts:1542) warms L1 only — `cache.set` with no
 *    `writePlacesToDb` — so its keys are absent from K (U4); and rows are deleted
 *    outside the TTL cycle by `invalidateDiscoveryCacheForOsmId` /
 *    `invalidateDiscoveryCacheForEntity` (lib/discoveryPersistentCache.ts:173,
 *    :210) on saves, un-saves and admin image actions, which both lets one key
 *    cold-fetch more than once per window and drops already-deleted keys from K
 *    (U3). So the ceiling covers only KEYS THAT HAVE AN L2 ROW AT THE MOMENT OF
 *    THE READ. It says nothing about keys that never persisted one, and those
 *    keys are exactly the ones with no ceiling at all. State that whenever the
 *    number is quoted.
 *
 * 4. IT HAS NO REQUEST-VOLUME NUMBER TO COMPARE AGAINST. The ceiling is only
 *    meaningful next to Discovery's actual request rate, and no table in this
 *    database records one. This script prints the ceiling and refuses to
 *    invent the other half of the comparison. Bring the request rate from
 *    whatever actually counts requests, then compare by hand.
 *
 * 5. IT PROVES NOTHING ABOUT WHY `logImpression` ITSELF MIGHT FAIL. Zero
 *    'discovery' rows is consistent with "the cold path rarely runs" AND with
 *    "the cold path runs and the insert is rejected". This script measures the
 *    first. `checkRankEventsSurfaces.ts` is the one that asks the database
 *    whether the write would be accepted.
 *
 * 6. COLD FETCHES AND rank_events ROWS ARE DIFFERENT UNITS. One cold fetch does
 *    not produce one row. `logImpression` (lib/rankLog.ts:102-124) maps the
 *    array it is given to ONE ROW PER CANDIDATE and inserts them in a batch,
 *    and routes/discovery.ts:1427-1433 passes the SERVED SLICE — up to
 *    PAGE_SIZE = 20 items (routes/discovery.ts:62). So a cold fetch yields
 *    0..20 rows. Section 6 below converts the fetch ceiling into a ROW ceiling
 *    (x 20) before comparing, and prints both units labelled. Never put a
 *    fetch count and a row count side by side unconverted.
 *
 * 7. NOT EVERY surface='discovery' ROW IS AN IMPRESSION, AND THE ANALYTICS ROWS
 *    ARE NOT A PROXY FOR COLD FETCHES. Exactly ONE writer produces the
 *    impression stream; at least SEVEN others write the same surface with
 *    `outcome = 'analytics'`. Enumerated, with what each one counts:
 *
 *      IMPRESSION STREAM — one row per SERVED item, on the cold path
 *        logImpression                    routes/discovery.ts:1433
 *          -> lib/rankLog.ts:102-124, fed the page slice built at :1427.
 *             Rows per cold fetch: 0..PAGE_SIZE.
 *
 *      ANALYTICS, on the cold path — one row per CANDIDATE, not per served item
 *        emitCreatorCapAnalytics          routes/discovery.ts:1415
 *          -> CreatorCapEnforcer.ts writeDiversityAnalytic (def :52, called at
 *             :117) — fires only for items DEFERRED over the per-creator cap.
 *        emitFeedSlotAnalytics            routes/discovery.ts:1418
 *          -> FeedSlotAllocator.ts writeSlotAnalytic (def :60, called at :142)
 *             — one row per eligible item placed in the feed.
 *        drsRankItems(..., "discovery")   routes/discovery.ts:1398
 *          -> DiscoveryRankingService.ts rankItems, which passes that surface
 *             through to writeRankAnalyticAsync (def :569) at FOUR call sites:
 *             :768 (item eligible), :867 (item scored), :879 (activity boost)
 *             and :888 (fatigue penalty). Each inserts one row with the surface
 *             it was handed and outcome='analytics'. All four sit inside the
 *             per-INPUT loop over the full candidate set, so a single cold
 *             fetch can emit several rows for every candidate it considered —
 *             including candidates that were never served.
 *
 *      ANALYTICS, NOT on the cold path at all
 *        POST /api/rank-events/outcome    routes/rankEvents.ts:184-195
 *          echoes the CLIENT-SUPPLIED `surface` verbatim into a NEW
 *          outcome='analytics' row, and SURFACE_VALUES (:99) permits
 *          'discovery'. A client reporting a tap/save on a Discovery item
 *          therefore adds a surface='discovery' analytics row with no cold
 *          fetch, no cache miss and no Discovery request behind it.
 *
 *    TWO CONSEQUENCES, both of which the report below must respect:
 *    (i)  A non-zero analytics count does NOT establish that the cold path ran.
 *         The rankEvents.ts writer reaches the same surface from a different
 *         route entirely.
 *    (ii) The analytics count CANNOT be divided into a cold-fetch count. Its
 *         rows are per-candidate (and several per candidate), the impression
 *         rows are per-served-item, and the candidate set is neither counted
 *         nor bounded anywhere here. There is no ratio to apply. Do not try to
 *         size the cold path from the analytics figure in either direction.
 *
 *    The contrast below therefore EXCLUDES analytics rows and reports them on
 *    their own line. Note the impression filter is `outcome <> 'analytics'`,
 *    not `outcome = 'impression'`: `POST /api/rank-events/outcome` UPDATES an
 *    impression row's outcome in place to tap/save/join/rsvp/attended
 *    (routes/rankEvents.ts:137, :160), so an impression that converted no
 *    longer says 'impression'. Filtering on 'impression' would silently drop
 *    exactly the engaged rows.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * READ-ONLY BY CONSTRUCTION
 * -------------------------
 * Every statement below is a `SELECT`. Nothing is inserted, updated, deleted
 * or altered, no cache behaviour is touched, and `routes/discovery.ts` is not
 * modified by this change.
 *
 * The SQL is NOT free of interpolation, and claiming it is would be both false
 * and useless as a check. Every query below is a template literal, and five
 * values are substituted into them: CACHE_TABLE, RANK_EVENTS_TABLE,
 * DECLARED_TTL_HOURS, DISCOVERY_SURFACE and WINDOW_HOURS. The invariant that
 * actually holds, and the one to verify on every future edit, is narrower:
 *
 *   every interpolated value is a module-scope literal declared in THIS file,
 *   and nothing derived from argv, process.env, a request, a file or a previous
 *   query result is ever interpolated into a statement.
 *
 * That is what makes injection impossible here — not an absence of `${}`. Stated
 * the old way, adding one interpolation of a runtime-derived value would leave
 * the sentence looking satisfied while the property it was protecting had gone.
 *
 * Usage (from artifacts/api-server, with .env loaded):
 *   node --env-file-if-exists=.env --import tsx/esm src/scripts/checkDiscoveryCacheKeys.ts
 *
 * ══════════════════════════════════════════════════════════════════════════
 * EXIT CODE CONTRACT
 * ══════════════════════════════════════════════════════════════════════════
 *   0  REPORTED    Every required measurement was read and printed. A finding
 *                  is not a failure: a huge key count, a tiny one, or an empty
 *                  table all exit 0. The output is the deliverable.
 *
 *   1  CRASHED     NEVER chosen here. Node's default for an uncaught
 *                  exception / unhandled rejection / tsx load failure. It
 *                  means the run died before reporting anything.
 *
 *   2  CANNOT-RUN  No SUPABASE_URL / token, or a SUPABASE_URL with no derivable
 *                  project ref. The diagnostic never ran and measured nothing.
 *                  A diagnostic that silently no-ops without credentials is not
 *                  a diagnostic — so this is a failure, not a skip.
 *
 *   3  UNRELIABLE  A required read failed, so the numbers could not be
 *                  established. Nothing partial is passed off as a result.
 *
 * Machine-greppable result lines, printed on the success path. Every name
 * carries BOTH its unit and its time span, and the block is GROUPED rather than
 * listed: two lines may be divided into one another only if they share both. The
 * prose refuses the ceiling-vs-all-time comparison, so the layout must not offer
 * it either — the per-24h observed line is printed next to the ceiling, and the
 * all-time lines are pushed to their own group at the end. The two ceilings are
 * estimates under the per-key-serialised assumption above, not hard bounds:
 *
 *   KEYS distinct: <n>
 *
 *   # 24 h, IMPRESSION ROWS — the ceiling and the one observed figure it may be
 *   # set against. This pair is the only meaningful ratio in the block.
 *   CEILING_ASSUMED impression_rows_per_24h: <n>
 *   OBSERVED discovery_impression_rows_per_24h: <n> | unavailable
 *
 *   # 24 h, COLD FETCHES — a different unit. Compare only against Discovery's
 *   # real request volume, which this script cannot read.
 *   CEILING_ASSUMED cold_fetches_per_24h: <n>
 *
 *   # ANALYTICS ROWS — per-candidate, several rows per candidate, and one writer
 *   # that never touches the cold path (limitation 7). Not convertible into
 *   # fetches or into impressions.
 *   OBSERVED discovery_analytics_rows_per_24h: <n> | unavailable
 *   OBSERVED discovery_analytics_rows_all_time: <n>
 *
 *   # ALL TIME — an unknown span. Comparable to no per_24h line above.
 *   OBSERVED discovery_impression_rows_all_time: <n>
 *
 * NOTHING THAT CAN THROW RUNS AT MODULE SCOPE
 * -------------------------------------------
 * A module-scope throw happens before `main().catch()` is installed, so Node
 * would exit 1 — the one code that must never carry a result. Module scope
 * here holds only literals, `process.env` property reads and declarations; the
 * environment validation and the `new URL()` parse both run inside
 * `requireTransport()`, which `main()` calls first. Keep it that way.
 */

// THE FIRST THING THIS PROCESS DOES.
//
// This diagnostic reads a LIVE Supabase project: it derives a project ref from
// process.env.SUPABASE_URL and issues SELECTs against the Management API
// (`https://api.supabase.com/v1/projects/<ref>/database/query`) with a
// service-level token. Read-only is not the same as safe to point anywhere —
// the rows it reads are production rows, and the token it authenticates with is
// not scoped to reading.
//
// The import is placed FIRST so it is evaluated before this module's own body
// and before every sibling import. If the allowlist refuses, the guard exits 2
// and nothing below runs: no URL is parsed, no token is read, no query is
// issued. See src/lib/ciSupabaseGuard.mjs and docs/ci/README.md.
//
// This is deliberately independent of whether any workflow invokes this script
// today — it is not wired into CI, and it still must not be runnable against an
// unsanctioned project from a laptop.
import "../lib/ciSupabaseGuard.mjs";

/**
 * Module marker. This script imports nothing FROM THE APPLICATION TREE —
 * deliberately, because importing routes/discovery.ts to read a constant would
 * execute that router module and its whole import graph as a side effect of a
 * read-only diagnostic. (The guard import above is not part of that tree: it is
 * a leaf module that spawns a shell script and returns.) But
 * tsconfig.base.json sets `isolatedModules: true`, under which a file with no
 * import and no export is a GLOBAL SCRIPT, not a module: its top-level `const`s
 * would land in the global scope (colliding with any other such file) and TS
 * raises TS1208. The guard import alone would now satisfy that, but the empty
 * export is kept so the property does not depend on the guard staying here.
 * Do not delete it just because nothing appears to use it.
 */
export {};

// ── Constants mirrored from the code under test ──────────────────────────────
//
// Mirrored, not imported: importing routes/discovery.ts would execute the
// router module (and its whole import graph) as a side effect of running a
// read-only diagnostic. The trade is that these can drift, so the TTL is also
// MEASURED from the live table below (expires_at - cached_at) and the ceiling
// is computed from whichever TTL is SHORTER. A shorter live TTL means more
// cold fetches are possible, so assuming 2 h when the live value is smaller
// would silently understate an estimate that already has unmeasured terms
// pushing it up (see the tally in the header).

/** lib/discoveryPersistentCache.ts:19 — PLACE_TTL_MS = 2 * 60 * 60 * 1_000. */
const DECLARED_TTL_HOURS = 2;

/** The window the ceiling is expressed over. Arbitrary but stated everywhere. */
const WINDOW_HOURS = 24;

/**
 * routes/discovery.ts:62 — PAGE_SIZE = 20. The unit converter between the two
 * halves of the contrast: logImpression is handed the served page slice
 * (routes/discovery.ts:1427-1433) and writes ONE ROW PER SERVED CANDIDATE
 * (lib/rankLog.ts:102-124), so one cold fetch yields 0..PAGE_SIZE rows. Using
 * the maximum keeps the row figure on the same (upward) side as the fetch
 * figure it is derived from.
 */
const MAX_ROWS_PER_COLD_FETCH = 20;

/** Table names, taken from lib/discoveryPersistentCache.ts and 0168_discovery_cache_ddl.sql. */
const CACHE_TABLE = "public.discovery_cache";
const RANK_EVENTS_TABLE = "public.rank_events";

/** The surface value routes/discovery.ts:1433 passes to logImpression(). */
const DISCOVERY_SURFACE = "discovery";

/** Required read failed — the numbers could not be established. */
const EXIT_UNRELIABLE = 3;
/** Environment not configured — the diagnostic did not run. Also a failure. */
const EXIT_CANNOT_RUN = 2;
/**
 * Exit 1 is deliberately NOT a constant: nothing here may choose it. It is
 * Node's default code for an involuntary death, and a chosen 1 would make a
 * crash indistinguishable from a result.
 */

// ── Environment ──────────────────────────────────────────────────────────────
//
// Plain property reads: these cannot throw, so they are safe at module scope.
// Validating them, and parsing SUPABASE_URL, both can fail — so both happen
// inside requireTransport(), called from main().
const SUPABASE_URL = process.env.SUPABASE_URL;
const ACCESS_TOKEN =
  process.env.SUPABASE_PROJECT_TOKEN || process.env.SUPABASE_ACCESS_TOKEN;

interface Transport {
  mgmtUrl: string;
  accessToken: string;
}

/** Memoised result of requireTransport(). Declared here, never computed here. */
let transport: Transport | undefined;

/** Print the reason, then exit without pretending anything was measured. */
function abort(reason: string, detail: string, code = EXIT_UNRELIABLE): never {
  console.log();
  console.error(`NOT REPORTED — ${reason}`);
  console.error(detail);
  process.exit(code);
}

function requireTransport(): Transport {
  if (transport) return transport;

  const url = SUPABASE_URL;
  const token = ACCESS_TOKEN;
  if (!url || !token) {
    return abort(
      "environment not configured, so nothing was measured",
      "       SUPABASE_URL and a Supabase token must be set.\n" +
        "       Set SUPABASE_PROJECT_TOKEN (project-scoped, preferred for CI)\n" +
        "       or SUPABASE_ACCESS_TOKEN (personal access token).\n" +
        "       Run from artifacts/api-server with .env loaded.\n" +
        "       This diagnostic needs LIVE credentials by construction: the key\n" +
        "       count is a fact about the production cache that cannot be read off\n" +
        "       the repo. Without them it must FAIL rather than skip — which is why\n" +
        "       this is exit 2 and not exit 0.",
      EXIT_CANNOT_RUN,
    );
  }

  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch (e) {
    return abort(
      "SUPABASE_URL is not a parsable URL, so nothing was measured",
      `       SUPABASE_URL could not be parsed: ${e instanceof Error ? e.message : String(e)}\n` +
        "       The Management API endpoint is derived from its hostname. Set it to\n" +
        "       the full project URL, e.g. https://<project-ref>.supabase.co",
      EXIT_CANNOT_RUN,
    );
  }

  const projectRef = hostname.split(".")[0] ?? "";
  if (!projectRef) {
    return abort(
      "no project ref could be derived from SUPABASE_URL",
      `       SUPABASE_URL parsed, but its hostname ('${hostname}') yielded no\n` +
        "       leading label to use as the Supabase project ref. Expected\n" +
        "       https://<project-ref>.supabase.co — nothing was measured.",
      EXIT_CANNOT_RUN,
    );
  }

  transport = {
    mgmtUrl: `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
    accessToken: token,
  };
  return transport;
}

/**
 * Run one read-only SQL statement through the Supabase Management API and
 * return its rows. Throws on any non-2xx; callers decide whether that is fatal.
 */
async function liveQuery<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const { mgmtUrl, accessToken } = requireTransport();
  const res = await fetch(mgmtUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Management API ${res.status}: ${text.slice(0, 600)}`);
  try {
    return JSON.parse(text) as T[];
  } catch {
    throw new Error(`Management API returned a body that is not JSON: ${text.slice(0, 600)}`);
  }
}

/**
 * Counts are selected as ::text so a bigint can never lose precision in JSON,
 * and are converted here with an explicit finiteness check. "I could not read
 * the number" must never silently become 0 — a fake 0 would make the ceiling
 * look like a proof of total cache dominance.
 */
function num(v: unknown, what: string): number {
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw new Error(`${what}: expected a numeric value, got ${JSON.stringify(v)}`);
  }
  return n;
}

/** Same, but a NULL is a legitimate answer (empty table) rather than an error. */
function numOrNull(v: unknown, what: string): number | null {
  if (v === null || v === undefined || v === "") return null;
  return num(v, what);
}

function pad(n: number | string, w = 12): string {
  return String(n).padStart(w);
}

// ── Queries. Every one is a SELECT, and every interpolated value is a ────────
// ── module-scope literal declared above — never a runtime-derived value. ─────

// Deliberately plain aggregates only. This query is REQUIRED — if it fails the
// run has no ceiling and aborts — so it contains nothing clever. In particular
// there is no `count(distinct (a, b, c))` row-constructor here: the composite
// form is the kind of expression that can fail on a live server for reasons
// unrelated to the finding, and taking the whole diagnostic down with it to
// print one descriptive extra is a bad trade. Key composition is covered by the
// per-column distinct counts and by section 5.
const Q_CACHE_TOTALS = `
  select
    count(*)::text                                                as total_rows,
    count(distinct cache_key)::text                               as distinct_keys,
    count(distinct lower(btrim(destination)))::text               as distinct_destinations,
    count(distinct category)::text                                as distinct_categories,
    count(distinct radius_km)::text                               as distinct_radii,
    (count(*) filter (where now() <= expires_at))::text           as fresh_rows,
    (count(*) filter (where now() >  expires_at))::text           as stale_rows,
    min(cached_at)::text                                          as oldest_cached_at,
    max(cached_at)::text                                          as newest_cached_at
  from ${CACHE_TABLE}
`;

const Q_AGE_BUCKETS = `
  with a as (select (now() - cached_at) as age from ${CACHE_TABLE})
  select
    (count(*) filter (where age <  interval '30 minutes'))::text as lt_30m,
    (count(*) filter (where age >= interval '30 minutes'
                        and age <  interval '1 hour'))::text     as m30_to_1h,
    (count(*) filter (where age >= interval '1 hour'
                        and age <  interval '2 hours'))::text    as h1_to_2h,
    (count(*) filter (where age >= interval '2 hours'
                        and age <  interval '6 hours'))::text    as h2_to_6h,
    (count(*) filter (where age >= interval '6 hours'
                        and age <  interval '24 hours'))::text   as h6_to_24h,
    (count(*) filter (where age >= interval '24 hours'
                        and age <  interval '7 days'))::text     as d1_to_7d,
    (count(*) filter (where age >= interval '7 days'))::text     as gt_7d,
    (count(*) filter (where age <  interval '24 hours'))::text   as refreshed_24h
  from a
`;

const Q_TTL_SPAN = `
  select
    min(extract(epoch from (expires_at - cached_at)))::text as min_span_s,
    max(extract(epoch from (expires_at - cached_at)))::text as max_span_s,
    (count(*) filter (
      where expires_at - cached_at = interval '${DECLARED_TTL_HOURS} hours'
    ))::text as exactly_declared
  from ${CACHE_TABLE}
`;

const Q_TOP_DESTINATIONS = `
  select
    lower(btrim(destination)) as destination,
    count(*)::text            as keys
  from ${CACHE_TABLE}
  group by 1
  order by count(*) desc, 1
  limit 15
`;

const Q_KEYS_PER_CATEGORY = `
  select
    category       as category,
    count(*)::text as keys
  from ${CACHE_TABLE}
  group by 1
  order by count(*) desc, 1
  limit 20
`;

// Split by outcome, not just by surface. Exactly ONE of the writers that can
// produce surface='discovery' is the impression stream; the rest are analytics
// (full enumeration and consequences: limitation 7 in the header):
//   logImpression            routes/discovery.ts:1433  -> funnel outcomes,
//                                                         one row per SERVED item
//   emitCreatorCapAnalytics  routes/discovery.ts:1415  -> outcome='analytics'
//   emitFeedSlotAnalytics    routes/discovery.ts:1418  -> outcome='analytics'
//   drsRankItems("discovery") routes/discovery.ts:1398 -> outcome='analytics' at
//                                DiscoveryRankingService.ts :768/:867/:879/:888,
//                                inside the per-CANDIDATE loop
//   POST /api/rank-events/outcome  routes/rankEvents.ts:184-195 -> echoes the
//                                CLIENT-SUPPLIED surface (SURFACE_VALUES at :99
//                                permits 'discovery') into a new analytics row,
//                                without touching the cold path at all
// So the `analytics` column below is NOT a per-cold-fetch quantity and cannot be
// converted into one — its rows are per-candidate, several per candidate, and
// some of them have no Discovery request behind them.
// The impression predicate is `outcome <> 'analytics'` rather than
// `outcome = 'impression'`, because POST /api/rank-events/outcome UPDATES an
// impression row's outcome in place (routes/rankEvents.ts:137, :160) — an
// impression that converted to a tap/save is still an impression row.
const Q_RANK_EVENTS_BY_SURFACE = `
  select
    surface,
    (count(*) filter (where outcome is distinct from 'analytics'))::text as impressions,
    (count(*) filter (where outcome = 'analytics'))::text                as analytics
  from ${RANK_EVENTS_TABLE}
  group by surface
  order by count(*) desc
`;

const Q_RANK_EVENTS_DISCOVERY_24H = `
  select
    (count(*) filter (where outcome is distinct from 'analytics'))::text as impressions,
    (count(*) filter (where outcome = 'analytics'))::text                as analytics
  from ${RANK_EVENTS_TABLE}
  where surface = '${DISCOVERY_SURFACE}'
    and served_at >= now() - interval '${WINDOW_HOURS} hours'
`;

// ── Row shapes ───────────────────────────────────────────────────────────────

interface CacheTotalsRow {
  total_rows: string;
  distinct_keys: string;
  distinct_destinations: string;
  distinct_categories: string;
  distinct_radii: string;
  fresh_rows: string;
  stale_rows: string;
  oldest_cached_at: string | null;
  newest_cached_at: string | null;
}

interface AgeBucketsRow {
  lt_30m: string;
  m30_to_1h: string;
  h1_to_2h: string;
  h2_to_6h: string;
  h6_to_24h: string;
  d1_to_7d: string;
  gt_7d: string;
  refreshed_24h: string;
}

interface TtlSpanRow {
  min_span_s: string | null;
  max_span_s: string | null;
  exactly_declared: string;
}

/**
 * One row per surface. No combined total on purpose — a raw count printed next
 * to the split is what invites quoting analytics rows as impressions.
 */
interface SurfaceRow {
  surface: string;
  impressions: string;
  analytics: string;
}

/** Printed at the top AND the bottom, because a number gets quoted without its caveats. */
function printLimits(): void {
  console.log("──────────────────────────────────────────────────────────────────────");
  console.log("LIMITS OF THIS DIAGNOSTIC — the number below is not worth more than this");
  console.log("──────────────────────────────────────────────────────────────────────");
  console.log(
    "  * THE CEILING IS AN ESTIMATE UNDER AN ASSUMPTION, NOT A HARD UPPER BOUND.\n" +
      "    It assumes requests for one cache key never overlap in time. The code does\n" +
      "    NOT enforce that: there is no in-flight deduplication on the places path.\n" +
      "    A request that finds no L2 row falls through to the cold pipeline and only\n" +
      "    writes the cache at routes/discovery.ts:1203-1207, AFTER the Overpass\n" +
      "    round-trip, so N concurrent requests for the same cold key all miss, all\n" +
      "    cold-fetch and all log. The codebase already has this pattern for geocode\n" +
      "    (_geocodePending, routes/discovery.ts:173) — an equivalent pending-promise\n" +
      "    map around the places cold path is what would make the number a real bound.\n" +
      "    DIRECTION: concurrency makes real cold fetches HIGHER than the number\n" +
      "    below. So 'the ceiling is far below request volume, therefore cache A\n" +
      "    dominates' is WEAKENED by this, not strengthened — high volume is exactly\n" +
      "    the condition that produces overlapping misses. Do not treat a large gap\n" +
      "    as proof. And concurrency is NOT the only term pointing up: see the\n" +
      "    uncounted-keys bullet below, which has no per-key allowance at all.\n" +
      "\n" +
      "  * COLD FETCHES AND rank_events ROWS ARE DIFFERENT UNITS. logImpression writes\n" +
      "    ONE ROW PER SERVED CANDIDATE (lib/rankLog.ts:102-124) for the served page\n" +
      "    slice (routes/discovery.ts:1427-1433), so one cold fetch yields up to\n" +
      `    PAGE_SIZE = ${MAX_ROWS_PER_COLD_FETCH} rows. Section 4 prints both units and shows the conversion.\n` +
      "    Never compare a fetch count against a row count unconverted.\n" +
      "\n" +
      "  * NOT EVERY surface='discovery' ROW IS AN IMPRESSION, AND THE ANALYTICS COUNT\n" +
      "    CANNOT SIZE THE COLD PATH. Writers of outcome='analytics' on this surface:\n" +
      "    emitCreatorCapAnalytics (routes/discovery.ts:1415), emitFeedSlotAnalytics\n" +
      "    (:1418), and drsRankItems(..., 'discovery') at :1398, which reaches FOUR\n" +
      "    more inserts inside DiscoveryRankingService.ts (:768, :867, :879, :888).\n" +
      "    Those four sit in the per-CANDIDATE loop, so they count candidates — often\n" +
      "    several rows each — not served items and not fetches. A seventh writer,\n" +
      "    POST /api/rank-events/outcome (routes/rankEvents.ts:184-195), echoes the\n" +
      "    CLIENT-SUPPLIED surface verbatim ('discovery' is in SURFACE_VALUES at :99)\n" +
      "    and never touches the cold path at all. Consequences: a non-zero analytics\n" +
      "    count does not by itself prove the cold path ran, and there is NO ratio that\n" +
      "    converts analytics rows into cold fetches or into impressions. They are\n" +
      "    excluded from the contrast and reported separately below.\n" +
      "\n" +
      "  * L2 ONLY. L1 is an in-process Map (routes/discovery.ts:144), one copy per\n" +
      "    server instance, invisible to every database query and therefore to this\n" +
      "    script. Every L1 hit is a serve that consumed no cold fetch, so this term\n" +
      "    pushes real cold fetches DOWN. It does not on its own make the number an\n" +
      "    upper bound — several unmeasured terms point the other way (concurrency\n" +
      "    above, uncounted keys and invalidation deletes below).\n" +
      "\n" +
      "  * CACHE B IS NOT SEPARATED, because it cannot be seen. The Compass candidate\n" +
      "    cache (_compassCandidateCache, routes/discovery.ts:153) is per-user, has a\n" +
      "    10-minute TTL and holds POST-ranking output. It is in-process memory with\n" +
      "    no table behind it. Nothing below distinguishes it from cache A.\n" +
      "\n" +
      "  * KEYS WITH NO PERSISTED ROW ARE UNCOUNTED — a SECOND term pointing UP, and\n" +
      "    the only one with no allowance bounding it. routes/discovery.ts:1203 guards\n" +
      "    BOTH cache writes (L1 at :1204, L2 at :1206) behind one\n" +
      "    `if (enrichedOsm.length > 0)`, so a key whose Overpass query is empty or\n" +
      "    times out is cached in NEITHER layer: it cold-fetches on EVERY request, it\n" +
      "    never appears in K, and there is no TTL to divide by — the 'once per TTL'\n" +
      "    allowance simply does not apply to it. Two smaller variants: /discovery/counts\n" +
      "    warms L1 only (routes/discovery.ts:1542), so its keys are missing from K;\n" +
      "    and save / un-save / admin image actions DELETE L2 rows\n" +
      "    (lib/discoveryPersistentCache.ts:173, :210), which both lets one key\n" +
      "    cold-fetch more than once in a window and removes already-deleted keys from\n" +
      "    K. The ceiling covers only keys holding an L2 row at the moment of the read.\n" +
      "\n" +
      "  * NO REQUEST-VOLUME FIGURE EXISTS HERE. The ceiling only means something\n" +
      "    beside Discovery's real request rate, which no table in this database\n" +
      "    records. This script will not invent it. Bring it from whatever actually\n" +
      "    counts requests and do the comparison by hand.\n" +
      "\n" +
      "  * IT DOES NOT TEST WHETHER logImpression WOULD SUCCEED. Zero 'discovery'\n" +
      "    rows is consistent both with 'the cold path rarely runs' and with 'the\n" +
      "    insert is rejected'. This measures the first only; checkRankEventsSurfaces.ts\n" +
      "    asks the database about the second.",
  );
  console.log("──────────────────────────────────────────────────────────────────────");
  console.log();
}

async function main(): Promise<void> {
  // Validated here, not at module scope, so a malformed SUPABASE_URL is a
  // printed exit 2 rather than an uncaught throw Node would exit 1 on.
  requireTransport();

  console.log("discovery_cache key-count diagnostic — READ-ONLY (SELECT only)");
  console.log(`table: ${CACHE_TABLE}   declared TTL: ${DECLARED_TTL_HOURS} h ` +
    `(lib/discoveryPersistentCache.ts:19)`);
  console.log();
  printLimits();

  // ── 1. Totals and distinct keys (REQUIRED) ────────────────────────────────
  const totals = await liveQuery<CacheTotalsRow>(Q_CACHE_TOTALS).catch((e: unknown) =>
    abort(
      `${CACHE_TABLE} could not be read`,
      `       ${e instanceof Error ? e.message : String(e)}\n` +
        "       Without the key count there is no ceiling and no argument. Note the\n" +
        "       table is service-role only with RLS enabled (0168_discovery_cache_ddl.sql),\n" +
        "       so a permission error here means the token is not the right one — it\n" +
        "       does NOT mean the cache is empty.",
    ),
  );

  const t = totals[0];
  if (!t) {
    abort(
      "the totals query returned no row",
      "       A bare aggregate over a table always returns exactly one row, so an\n" +
        "       empty result means the transport did not run the statement. Nothing\n" +
        "       was measured.",
    );
  }

  const totalRows = num(t.total_rows, "total_rows");
  const distinctKeys = num(t.distinct_keys, "distinct_keys");
  const freshRows = num(t.fresh_rows, "fresh_rows");
  const staleRows = num(t.stale_rows, "stale_rows");

  console.log("── 1. discovery_cache size ──");
  console.log(`  ${pad(totalRows)}  total rows`);
  console.log(`  ${pad(distinctKeys)}  DISTINCT cache_key values  <- K, the number the ceiling uses`);
  console.log(`  ${pad(num(t.distinct_destinations, "distinct_destinations"))}  distinct destinations (lower/trimmed)`);
  console.log(`  ${pad(num(t.distinct_categories, "distinct_categories"))}  distinct categories`);
  console.log(`  ${pad(num(t.distinct_radii, "distinct_radii"))}  distinct radius_km values`);
  console.log(`  oldest cached_at: ${t.oldest_cached_at ?? "(none)"}`);
  console.log(`  newest cached_at: ${t.newest_cached_at ?? "(none)"}`);

  if (totalRows !== distinctKeys) {
    console.log(
      `\n  NOTE: total rows (${totalRows}) != distinct cache_key (${distinctKeys}).\n` +
        "        cache_key is declared PRIMARY KEY in 0168_discovery_cache_ddl.sql, so\n" +
        "        this should be impossible. The live table is not the declared one.\n" +
        "        The ceiling below uses the DISTINCT count, which is the more\n" +
        "        conservative reading only if it is the larger of the two.",
    );
  }
  console.log(
    "\n  cache_key is built by cacheKey() at routes/discovery.ts:159 as\n" +
      "  lower(trim(destination)) + ':' + category + ':' + radiusKm. The\n" +
      "  destination / category / radius_km COLUMNS are descriptive copies written\n" +
      "  alongside it (lib/discoveryPersistentCache.ts:100); the key is what the\n" +
      "  cache actually looks up on, and it is the key that is counted above.",
  );
  console.log();

  // ── 2. Age distribution against the TTL (REQUIRED) ────────────────────────
  const ages = await liveQuery<AgeBucketsRow>(Q_AGE_BUCKETS).catch((e: unknown) =>
    abort(
      "the age distribution could not be read",
      `       ${e instanceof Error ? e.message : String(e)}`,
    ),
  );
  const a = ages[0];
  if (!a) abort("the age query returned no row", "       Nothing was measured.");

  console.log(`── 2. entry age vs the ${DECLARED_TTL_HOURS} h TTL ──`);
  console.log("  age of row (now - cached_at)          rows");
  console.log(`  < 30 min                        ${pad(num(a.lt_30m, "lt_30m"))}   fresh`);
  console.log(`  30 min – 1 h                    ${pad(num(a.m30_to_1h, "m30_to_1h"))}   fresh`);
  console.log(`  1 h – 2 h                       ${pad(num(a.h1_to_2h, "h1_to_2h"))}   fresh`);
  console.log(`  2 h – 6 h                       ${pad(num(a.h2_to_6h, "h2_to_6h"))}   STALE (still served, :1151)`);
  console.log(`  6 h – 24 h                      ${pad(num(a.h6_to_24h, "h6_to_24h"))}   STALE (still served, :1151)`);
  console.log(`  1 d – 7 d                       ${pad(num(a.d1_to_7d, "d1_to_7d"))}   STALE (still served, :1151)`);
  console.log(`  > 7 d                           ${pad(num(a.gt_7d, "gt_7d"))}   STALE (still served, :1151)`);
  console.log();
  console.log(`  by expires_at:  fresh ${freshRows}   stale ${staleRows}`);
  console.log(
    "  A stale row is NOT an expired row. readPlacesFromDb\n" +
      "  (lib/discoveryPersistentCache.ts:47) returns a row whether or not it is\n" +
      "  past expires_at, and routes/discovery.ts:1151 serves the stale copy and\n" +
      "  returns, revalidating in the background. Nothing deletes rows on expiry —\n" +
      "  only the invalidation deletes do. So a stale row still suppresses the cold\n" +
      "  fetch, and still suppresses the logging.",
  );
  const refreshed24h = num(a.refreshed_24h, "refreshed_24h");
  console.log(
    `\n  keys with cached_at within the last ${WINDOW_HOURS} h: ${refreshed24h}\n` +
      "  Read this as a LOWER bound on writes, never an upper one: cached_at is\n" +
      "  overwritten by each upsert (lib/discoveryPersistentCache.ts:100), so a key\n" +
      "  written ten times in the window still shows as one row.",
  );
  console.log();

  // ── 3. The TTL actually stored in the table (REQUIRED for the arithmetic) ─
  const spans = await liveQuery<TtlSpanRow>(Q_TTL_SPAN).catch((e: unknown) =>
    abort(
      "the stored TTL span could not be read",
      `       ${e instanceof Error ? e.message : String(e)}\n` +
        "       The ceiling divides by the TTL, so an unverified TTL is an unverified\n" +
        "       ceiling. Refusing to assume the constant.",
    ),
  );
  const s = spans[0];
  if (!s) abort("the TTL span query returned no row", "       Nothing was measured.");

  const minSpanS = numOrNull(s.min_span_s, "min_span_s");
  const maxSpanS = numOrNull(s.max_span_s, "max_span_s");
  const minSpanH = minSpanS === null ? null : minSpanS / 3600;
  const maxSpanH = maxSpanS === null ? null : maxSpanS / 3600;

  console.log("── 3. TTL as actually stored (expires_at - cached_at) ──");
  if (minSpanH === null || maxSpanH === null) {
    console.log("  (no rows — no stored span to read; the declared constant is all there is)");
  } else {
    console.log(`  min span: ${minSpanH.toFixed(3)} h     max span: ${maxSpanH.toFixed(3)} h`);
    console.log(`  rows whose span is exactly ${DECLARED_TTL_HOURS} h: ${num(s.exactly_declared, "exactly_declared")} of ${totalRows}`);
  }

  // The ceiling uses the SHORTEST TTL that the data supports. A shorter TTL means
  // a key can cold-fetch more often, so assuming the declared 2 h when the live
  // value is smaller would understate the estimate on top of the terms that
  // already push it up unmeasured.
  const effectiveTtlHours =
    minSpanH !== null && minSpanH > 0 && minSpanH < DECLARED_TTL_HOURS ? minSpanH : DECLARED_TTL_HOURS;
  if (effectiveTtlHours !== DECLARED_TTL_HOURS) {
    console.log(
      `\n  NOTE: the shortest stored span (${effectiveTtlHours.toFixed(3)} h) is SHORTER than the\n` +
        `        declared ${DECLARED_TTL_HOURS} h. The ceiling below uses the shorter value, because a\n` +
        "        shorter TTL lets a key cold-fetch more often, and the estimate should\n" +
        "        not understate that as well as everything else it already understates.",
    );
  }
  if (minSpanH !== null && minSpanH <= 0) {
    console.log(
      "\n  NOTE: a stored span is <= 0 (expires_at at or before cached_at). Such a row\n" +
        "        is born stale. It is still SERVED (see section 2), so it still\n" +
        "        suppresses cold fetches; it is ignored when picking the TTL divisor\n" +
        "        because dividing by it is meaningless.",
    );
  }
  console.log();

  // ── 4. The ceiling, with the arithmetic written out ───────────────────────
  const windowsPerDay = WINDOW_HOURS / effectiveTtlHours;
  const ceilingExact = distinctKeys * windowsPerDay;
  // Rounded UP. With the declared 2 h TTL this is exact (24/2 = 12), but a
  // measured TTL can make the product fractional, and rounding down would
  // understate a figure that already understates whenever requests overlap.
  const ceiling = Math.ceil(ceilingExact);
  // Unit conversion — see MAX_ROWS_PER_COLD_FETCH. Cold FETCHES are not
  // rank_events ROWS, and section 6 compares against rows.
  const rowCeiling = ceiling * MAX_ROWS_PER_COLD_FETCH;

  console.log("── 4. the derived ceiling (an ESTIMATE under premise (d), not a proof) ──");
  console.log("  Premises (a)-(c) and (e) are checkable against the code. (d) is NOT:");
  console.log("    (a) cache A is keyed by (destination, category, radiusKm) and is");
  console.log("        user-independent                          routes/discovery.ts:159");
  console.log("    (b) a cold fetch writes that key into L1+L2 before responding");
  console.log("                                             routes/discovery.ts:1203-1207");
  console.log("    (c) any existing L2 row — fresh OR stale — is served and returns");
  console.log("                                    routes/discovery.ts:1130 and :1151");
  console.log("    (d) ASSUMED, NOT ENFORCED: one key yields ONE cold fetch per TTL");
  console.log("        window. TWO separate things have to be true for this, and neither");
  console.log("        is checked anywhere:");
  console.log("        (d1) requests for a key never overlap. There is NO in-flight dedup");
  console.log("             on the places path — the cache write at :1203-1207 happens");
  console.log("             AFTER the Overpass round-trip, so concurrent misses on the");
  console.log("             same key all fetch and all log. Compare _geocodePending");
  console.log("             (routes/discovery.ts:173), which is that dedup and exists only");
  console.log("             for geocode; the same map around the places cold path would");
  console.log("             make (d1) true.");
  console.log("        (d2) a key's row survives the whole window. It need not: the");
  console.log("             invalidation deletes at discoveryPersistentCache.ts:173/:210");
  console.log("             remove rows on saves, un-saves and admin image actions, and a");
  console.log("             key re-fetches immediately after one.");
  console.log("        Note also that (d) says nothing whatever about keys with no row at");
  console.log("        all — see the KEYS WITH NO PERSISTED ROW limit. They are outside");
  console.log("        this arithmetic entirely, not bounded loosely by it.");
  console.log("    (e) the cold fetch is the ONLY path that reaches logImpression");
  console.log("                                             routes/discovery.ts:1339, :1433");
  console.log();
  console.log("  Arithmetic:");
  console.log(`    distinct keys                    K = ${distinctKeys}`);
  console.log(`    TTL used                             = ${effectiveTtlHours} h` +
    (effectiveTtlHours === DECLARED_TTL_HOURS ? "  (declared)" : "  (shortest observed — see section 3)"));
  console.log(`    windows per ${WINDOW_HOURS} h                    = ${WINDOW_HOURS} / ${effectiveTtlHours} = ${windowsPerDay}`);
  console.log(`    ceiling  =  K * windows          = ${distinctKeys} * ${windowsPerDay} = ${ceilingExact}  COLD FETCHES`);
  if (ceiling !== ceilingExact) {
    console.log(`    rounded UP to a whole fetch      = ${ceiling}   (never down: rounding down would understate it)`);
  }
  console.log();
  console.log("  Unit conversion — rank_events counts ROWS, not fetches:");
  console.log(`    rows per cold fetch, at most         = ${MAX_ROWS_PER_COLD_FETCH}   (PAGE_SIZE, routes/discovery.ts:62;`);
  console.log("                                             one row per served candidate,");
  console.log("                                             lib/rankLog.ts:102-124, fed the");
  console.log("                                             page slice at :1427-1433)");
  console.log(`    row ceiling  =  fetches * rows       = ${ceiling} * ${MAX_ROWS_PER_COLD_FETCH} = ${rowCeiling}  IMPRESSION ROWS`);
  console.log();
  console.log(`  Read that as: IF (d1) and (d2) both hold, ${ceiling} cold fetches — up to`);
  console.log(`  ${rowCeiling} impression rows — occur across ALL of Discovery in a ${WINDOW_HOURS} h window,`);
  console.log("  counting ONLY keys that hold an L2 row. Every serve that hits either cache");
  console.log("  is unranked and unlogged. Keys with no persisted row are not covered.");
  console.log();
  console.log("  DIRECTION OF THE ERROR — the full tally, not just the famous term:");
  console.log();
  console.log("    DOWN (real cold fetches are FEWER than the figure above)");
  console.log("      D1  L1 hits, invisible to every query here, absorb serves outright.");
  console.log("      D2  premise (c): a key that already has ANY L2 row, fresh or stale,");
  console.log("          stops cold-fetching altogether rather than once per TTL.");
  console.log();
  console.log("    UP (real cold fetches are MORE than the figure above)");
  console.log("      U1  premise (d1): no in-flight dedup, so concurrent misses on one cold");
  console.log("          key each fetch and each log.");
  console.log("      U2  keys that never persist a row. :1203 guards BOTH cache writes, so");
  console.log("          an empty/timed-out Overpass result caches in NEITHER layer: that");
  console.log("          key cold-fetches on EVERY request, is absent from K, and has no");
  console.log("          TTL to divide by — this term is bounded by nothing above.");
  console.log("      U3  premise (d2): the invalidation deletes at");
  console.log("          discoveryPersistentCache.ts:173 / :210 drop L2 rows mid-window, so");
  console.log("          one key can cold-fetch more than once per TTL, and a key deleted");
  console.log("          before this read is missing from K.");
  console.log("      U4  /discovery/counts (:1542) warms L1 only, so its keys never enter K.");
  console.log();
  console.log("    Separately DOWN, but on LOGGING rather than on fetches: both Compass");
  console.log("    branches return before logImpression, so some cold fetches log nothing.");
  console.log();
  console.log("  Nothing here measures any of these against the others. The net direction is");
  console.log("  therefore UNKNOWN — the figure can err in either direction, and U2 has no");
  console.log("  ceiling of its own. Quote it as an estimate, never as a limit.");

  if (totalRows === 0) {
    console.log();
    console.log(
      "  CAUTION: the table is EMPTY, so the ceiling above is 0 by construction and\n" +
        "  proves nothing at all. An empty discovery_cache means the L2 layer is\n" +
        "  unused or failing (missing table, RLS, or a service client that is never\n" +
        "  configured — every function in lib/discoveryPersistentCache.ts fails soft\n" +
        "  and swallows the error). In that state every serve goes through L1 or the\n" +
        "  cold path, and L1 is invisible here, so this script cannot tell you which.\n" +
        "  Do NOT quote a ceiling of 0 as evidence of anything.",
    );
  }
  console.log();

  // ── 5. Key spread (informational) ─────────────────────────────────────────
  // Informational only: a failure here changes no verdict, so it prints and
  // moves on rather than aborting a run that already has its numbers.
  try {
    const dests = await liveQuery<{ destination: string; keys: string }>(Q_TOP_DESTINATIONS);
    console.log("── 5. where the keys are (top 15 destinations, INFORMATIONAL) ──");
    if (dests.length === 0) console.log("  (no rows)");
    for (const d of dests) console.log(`  ${pad(d.keys, 8)}  ${d.destination}`);
    console.log();
    const cats = await liveQuery<{ category: string; keys: string }>(Q_KEYS_PER_CATEGORY);
    console.log("── 5b. keys per category (INFORMATIONAL) ──");
    if (cats.length === 0) console.log("  (no rows)");
    for (const c of cats) console.log(`  ${pad(c.keys, 8)}  ${c.category}`);
  } catch (e) {
    console.log("── 5. key spread ──");
    console.log(
      `  (unavailable: ${e instanceof Error ? e.message : String(e)})\n` +
        "  Informational only — the ceiling above stands on sections 1–3, which\n" +
        "  completed.",
    );
  }
  console.log();

  // ── 6. Observed rank_events, for contrast (REQUIRED) ──────────────────────
  const bySurface = await liveQuery<SurfaceRow>(Q_RANK_EVENTS_BY_SURFACE).catch(
    (e: unknown) =>
      abort(
        `${RANK_EVENTS_TABLE} could not be read`,
        `       ${e instanceof Error ? e.message : String(e)}\n` +
          "       The observed discovery row count is half of the contrast this\n" +
          "       diagnostic exists to draw, so a run without it is incomplete.",
      ),
  );

  console.log("── 6. observed rank_events rows by surface ──");
  console.log("     impressions = rows from logImpression (outcome <> 'analytics';");
  console.log("     an impression that converted to a tap/save had its outcome UPDATED");
  console.log("     in place, routes/rankEvents.ts:160, and is still an impression row).");
  console.log("     analytics   = rows with outcome='analytics', from SEVEN writers, not");
  console.log("     two: emitCreatorCapAnalytics (:1415), emitFeedSlotAnalytics (:1418),");
  console.log("     the four writeRankAnalyticAsync sites DiscoveryRankingService.ts reaches");
  console.log("     via drsRankItems(..., 'discovery') at :1398, and POST /api/rank-events/");
  console.log("     outcome, which echoes a client-supplied surface. These count CANDIDATES");
  console.log("     (several rows each), not served items — see the caveat under the split.");
  console.log();
  console.log(`  ${pad("impressions", 12)} ${pad("analytics", 12)}  surface`);
  if (bySurface.length === 0) {
    console.log("  (no rows at all in rank_events)");
  } else {
    for (const r of bySurface) {
      console.log(
        `  ${pad(num(r.impressions, "impressions"))} ${pad(num(r.analytics, "analytics"))}  ${r.surface}`,
      );
    }
  }
  const discoveryRow = bySurface.find((r) => r.surface === DISCOVERY_SURFACE);
  const discoveryImpressions = discoveryRow ? num(discoveryRow.impressions, "discovery impressions") : 0;
  const discoveryAnalytics   = discoveryRow ? num(discoveryRow.analytics, "discovery analytics") : 0;

  let discoveryImpressions24h: number | null = null;
  let discoveryAnalytics24h: number | null = null;
  try {
    const rows24 = await liveQuery<{ impressions: string; analytics: string }>(
      Q_RANK_EVENTS_DISCOVERY_24H,
    );
    discoveryImpressions24h = num(rows24[0]?.impressions, "discovery impressions in window");
    discoveryAnalytics24h   = num(rows24[0]?.analytics, "discovery analytics in window");
  } catch (e) {
    console.log(
      `  (last-${WINDOW_HOURS}h discovery split unavailable: ${e instanceof Error ? e.message : String(e)})`,
    );
  }
  console.log();
  console.log(`  surface='${DISCOVERY_SURFACE}' IMPRESSION rows, all time:   ${discoveryImpressions}`);
  console.log(
    `  surface='${DISCOVERY_SURFACE}' IMPRESSION rows, last ${WINDOW_HOURS} h:  ` +
      (discoveryImpressions24h === null ? "(unavailable)" : String(discoveryImpressions24h)),
  );
  console.log();
  console.log("  Reported separately — informative, but NOT what the argument is about:");
  console.log(`  surface='${DISCOVERY_SURFACE}' ANALYTICS rows, all time:    ${discoveryAnalytics}`);
  console.log(
    `  surface='${DISCOVERY_SURFACE}' ANALYTICS rows, last ${WINDOW_HOURS} h:   ` +
      (discoveryAnalytics24h === null ? "(unavailable)" : String(discoveryAnalytics24h)),
  );
  console.log(
    "  WHAT THIS COUNT IS, AND WHAT IT CANNOT BE TURNED INTO:\n" +
      "  Most of these rows come from the cold path — emitCreatorCapAnalytics\n" +
      "  (routes/discovery.ts:1415, one row per item deferred over the creator cap),\n" +
      "  emitFeedSlotAnalytics (:1418, one row per eligible item placed in the feed),\n" +
      "  and drsRankItems(..., 'discovery') at :1398, which reaches four inserts inside\n" +
      "  DiscoveryRankingService.ts (:768, :867, :879, :888) from within its per-item\n" +
      "  loop over the FULL candidate set.\n" +
      "  But NOT all of them do. POST /api/rank-events/outcome\n" +
      "  (routes/rankEvents.ts:184-195) inserts a fresh outcome='analytics' row using\n" +
      "  the surface the CLIENT sent, and 'discovery' is a permitted value\n" +
      "  (SURFACE_VALUES, :99). That writer never touches the cold path, so a non-zero\n" +
      "  analytics count does not on its own establish that the cold path ran.\n" +
      "  Two things follow, and both matter more than the count itself:\n" +
      "   - A non-zero analytics count ALONGSIDE a zero impression count is a HINT\n" +
      "     worth following (it is consistent with the cold path running while\n" +
      "     logImpression fails to land, which checkRankEventsSurfaces.ts tests) —\n" +
      "     but it is only a hint, because the client-driven writer produces the same\n" +
      "     pattern with no cold fetch at all.\n" +
      "   - The analytics count CANNOT be divided into a cold-fetch or served-item\n" +
      "     count. Its rows are per-CANDIDATE and several per candidate; impression\n" +
      "     rows are per-SERVED-ITEM, capped at PAGE_SIZE. The candidate set is\n" +
      "     neither counted nor bounded anywhere here, so no ratio exists to apply.\n" +
      "     Do not attempt to size the cold path from this number.",
  );
  console.log();
  console.log(`  The contrast, both sides in IMPRESSION ROWS per ${WINDOW_HOURS} h:`);
  if (discoveryImpressions24h === null) {
    console.log(
      `    estimated ceiling ${rowCeiling} rows per ${WINDOW_HOURS} h  vs  (the ${WINDOW_HOURS} h observation\n` +
        `    failed above). Do NOT substitute the all-time figure (${discoveryImpressions}): it covers a\n` +
        "    different and unknown time span, and the comparison would be meaningless.",
    );
  } else {
    console.log(`    estimated ceiling ${rowCeiling} rows  vs  observed ${discoveryImpressions24h} rows.`);
  }
  console.log(
    `    (that ceiling is ${ceiling} cold fetches x ${MAX_ROWS_PER_COLD_FETCH} rows/fetch — the raw fetch count\n` +
      "     is NOT comparable to a row count, which is why it is converted here.)",
  );
  console.log(
    "  Then compare the FETCH figure against Discovery's real request volume, which\n" +
      "  this script cannot see. And note what that comparison can and cannot show:\n" +
      "  request volume far above the ceiling is consistent with cache-A dominance,\n" +
      "  but it does NOT establish it, because premise (d) is an assumption and high\n" +
      "  volume is exactly the condition that breaks it (concurrent misses on one\n" +
      "  cold key each cold-fetch and each log). Treat a large gap as suggestive.\n" +
      "  If the request volume is at or below the ceiling, this shows nothing at all\n" +
      "  and the zero has a different cause — start with checkRankEventsSurfaces.ts.",
  );
  console.log();

  // ── 7. Greppable result lines, then the limits again ──────────────────────
  // GROUPED, not listed. Every name carries its unit AND its time span, and the
  // layout is part of the content: adjacency here reads as an invitation to
  // divide, so the only adjacent pair is the one pair the prose above allows
  // (the 24 h ceiling and the 24 h observation). The all-time lines — which
  // section 6 explicitly refuses to compare against the ceiling — are printed
  // last, in their own group, never directly beneath a CEILING_ASSUMED line.
  const impressions24hText =
    discoveryImpressions24h === null ? "unavailable" : String(discoveryImpressions24h);
  const analytics24hText =
    discoveryAnalytics24h === null ? "unavailable" : String(discoveryAnalytics24h);

  console.log(`KEYS distinct: ${distinctKeys}`);
  console.log();
  console.log("# 24 h, IMPRESSION ROWS — the estimate and the one observation it may be");
  console.log("# set against. This is the only pair in the block that forms a ratio.");
  console.log(`CEILING_ASSUMED impression_rows_per_${WINDOW_HOURS}h: ${rowCeiling}`);
  console.log(`OBSERVED discovery_impression_rows_per_${WINDOW_HOURS}h: ${impressions24hText}`);
  console.log();
  console.log("# 24 h, COLD FETCHES — a different unit; compare only against Discovery's");
  console.log("# real request volume, which this script cannot read.");
  console.log(`CEILING_ASSUMED cold_fetches_per_${WINDOW_HOURS}h: ${ceiling}`);
  console.log();
  console.log("# ANALYTICS ROWS — per-candidate, several per candidate, and one writer that");
  console.log("# never touches the cold path. Not convertible into fetches or impressions.");
  console.log(`OBSERVED discovery_analytics_rows_per_${WINDOW_HOURS}h: ${analytics24hText}`);
  console.log(`OBSERVED discovery_analytics_rows_all_time: ${discoveryAnalytics}`);
  console.log();
  console.log(`# ALL TIME — an unknown span. Comparable to NO per_${WINDOW_HOURS}h line above,`);
  console.log("# including the ceilings.");
  console.log(`OBSERVED discovery_impression_rows_all_time: ${discoveryImpressions}`);
  console.log();
  printLimits();
  console.log(
    "REPORTED — read-only. Nothing was written, and no cache behaviour was\n" +
      "           changed. The figure is an ESTIMATE of cold fetches for keys that\n" +
      "           held an L2 row at the moment of the read, resting on same-key\n" +
      "           requests not overlapping AND rows not being invalidated\n" +
      "           mid-window. Keys that never persisted a row are outside it\n" +
      "           altogether. It is not a limit and it is not a measurement.",
  );
}

// A throw escaping main() means the run did not complete. Node would exit 1 for
// that by default, and 1 is the code that must never carry a result — so this
// catch converts it into a printed failure and exit 3. It covers only what
// main() awaits, which is why nothing that can throw runs at module scope.
main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  abort(
    "the diagnostic threw before reporting",
    "       The run did not complete (see the error above), so no key count, no\n" +
      "       ceiling and no contrast were established. Nothing was written either:\n" +
      "       every statement in this script is a SELECT.",
  );
});
