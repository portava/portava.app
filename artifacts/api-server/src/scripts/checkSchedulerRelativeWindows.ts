/**
 * check:scheduler-relative-windows — a scheduled job may not pick its work
 * with a window measured backwards from NOW unless that window comes from a
 * durable watermark.
 *
 * ── THE DEFECT CLASS ────────────────────────────────────────────────────────
 * `index.ts` starts 58 schedulers (`lib/schedulerCoverage.ts`), every one a
 * `setInterval` inside the process, and `.replit` sets
 * `deploymentTarget = "autoscale"`, which suspends the container after fifteen
 * idle minutes. A suspended container's event loop does not advance, so a GAP
 * between two passes of any job is ordinary, not exceptional. On 2026-09-30
 * 15:28 all 58 stopped together for fifty-four hours.
 *
 * Two shapes of work selection behave completely differently across that gap:
 *
 *   ABSOLUTE   `expires_at < now()`, `status = 'pending'`, `deleted_at <
 *              now - 24h`. The predicate describes the ROW, not the tick. The
 *              next pass still matches it, so a gap only DELAYS the work.
 *
 *   RELATIVE   `created_at > now - 1h`,
 *              `.gte("created_at", new Date(Date.now() - N))`. The predicate
 *              describes the TICK. Once the gap exceeds the window, every row
 *              inside the gap is older than the next pass's `since` and is
 *              examined by NO later pass, ever. Nothing errors, nothing is
 *              logged, no row is left in a queue: the work is simply gone.
 *
 * Eight jobs had the relative shape. Four lost data on any quiet night because
 * their window was narrower than the idle-suspend interval, and those four now
 * read a durable "processed through" mark instead (`lib/schedulerWatermark.ts`
 * — `scanWindow` / `readWatermark` / `commitWatermark`). This check exists so
 * that the fifth cannot be written without someone noticing.
 *
 * ── WHAT IS A SITE ──────────────────────────────────────────────────────────
 * A LOWER-BOUND time filter on a PostgREST read, in a file transitively
 * imported by one of the 58 `start…()` functions:
 *
 *     .gt(col, V) / .gte(col, V)
 *     .filter(col, "gt"|"gte", V)
 *     .or("…,col.gte.<V>…")             (the `expires_at.is.null,…` idiom)
 *     a `now() - interval '…'` / `now() - '…'::interval` lower bound spelled
 *     out in a SQL string in the file
 *
 * Lower bounds only, and that is the whole point rather than an omission: an
 * UPPER bound against the clock (`.lt("deleted_at", now - 24h)`,
 * `.lte("expires_at", now)`) is the ABSOLUTE shape above — it names rows that
 * are old enough, it keeps naming them, and a missed pass postpones instead of
 * forfeiting. `lib/stamps/countryGeocoder.ts`'s tombstone reclaim was fixed by
 * converting a lower bound into exactly that, and this check must not read the
 * fix as the defect.
 *
 * A FORWARD bound counts too. `.gte("start_date", now + 22h)` is still a
 * window measured from now, and a row passes THROUGH such a band exactly as it
 * falls out of a backward one — `server/trips/.../tripReminderScheduler.ts`
 * holds a four-hour forward band, and it is in the ledger below for that
 * reason. The width is reported as negative at such a site, meaning "the bound
 * is in the future".
 *
 * A bound is only a TIME bound when its column name says so (TEMPORAL_COLUMN)
 * or the trace reaches the clock. `.gte("lat", lat - dLat)` and
 * `.gt("id", cursor)` are counted as `not-time` and judged no further.
 *
 * ── HOW A SITE IS JUDGED, AND WHERE THE REFUSALS ARE ────────────────────────
 * The bound's value is traced back lexically — no type checker: `const`
 * bindings, `.toISOString()`/`.getTime()`, `??`, `?:`, template
 * substitutions, array spreads, object literals by property path, the return
 * expressions of functions declared in the same file, `Map#get` where every
 * `Map#set` in the file is visible, `export const`s followed into the module
 * they come from, and — for a function the module does NOT export, so the file
 * holds every call — the arguments at its call sites. Each site lands in
 * exactly one bucket:
 *
 *   not-time       neither the column name nor the trace says this is a time
 *                  bound. Judged no further.
 *   absolute       the bound is `now` itself, or a constant. Not a window.
 *   watermarked    the trace reaches `scanWindow(…)`. PASSES, structurally.
 *   entity-scoped  the chain also carries a non-constant `eq`/`in`/`match`/…
 *                  predicate, so the window is NOT what chooses the rows —
 *                  the entity is, and the entity came from somewhere else.
 *                  Out of scope, with the blind spot stated below.
 *   wider-than-gap the window's width is computable and is at least
 *                  PLAUSIBLE_GAP_MS. Out of scope, counted, printed.
 *   bare           a computable window narrower than PLAUSIBLE_GAP_MS with no
 *                  watermark in its history. VIOLATION.
 *   unresolved     the bound IS clock-derived (or cannot be shown not to be)
 *                  and the trace could not establish either a watermark or a
 *                  width. VIOLATION — CONTRIBUTING.md:33-66: a check that
 *                  cannot establish its result must fail rather than assume.
 *                  `unresolved` is reported separately from `bare` because the
 *                  two need different fixes: one is a defect, the other is a
 *                  site this checker cannot read and a human must.
 *
 * WHY A WATERMARK ANYWHERE IN THE TRACE WINS. `detectorWindow` in
 * `services/trust/TrustGamingDetectionService.ts` returns the watermark's
 * `since` normally and `now - 24h` when the mark is UNREADABLE, and
 * `compass/CompassAbuseDefenseEngine.ts` hands `scanWindow` a null watermark
 * on the same refusal. Those fallbacks are the documented "cannot establish
 * the mark, so keep the old lookback and do not commit" branch — the window is
 * still governed by the watermark mechanism, and the alternative reading would
 * make the correct refusal look like the defect.
 *
 * ── PLAUSIBLE_GAP_MS IS A JUDGEMENT, AND IT IS STATED AS ONE ────────────────
 * There is no width at which a relative window is SAFE on this host: the
 * suspend has no upper bound and the recorded stall was fifty-four hours. The
 * bound below is 72 hours — longer than that stall, and the same number
 * `CompassAbuseDefenseEngine` chose for its own catch-up cap, calling it "the
 * realistic worst case for an idle-suspended autoscale host — a quiet long
 * weekend". A window at least that wide is therefore NOT certified safe by
 * this check; it is declared out of this check's scope, counted on every run
 * so the number cannot drift unseen, and listed by `--print`.
 *
 * ── ALLOWLIST ───────────────────────────────────────────────────────────────
 * `ALLOWLIST` below, one named site per entry, keyed structurally
 * (`<file>::<fn>::<table>.<method>(<column>)`) so line churn does not
 * invalidate an entry but moving or renaming the read does. Two kinds:
 *
 *   governed       the window is genuinely not the hazard at this site, and
 *                  the entry says which OTHER mechanism covers the gap.
 *   known_defect   a real relative window nobody has fixed. `reason` must start
 *                  `LOSES-DATA:` or `UNCLASSIFIED:`, the same device as
 *                  UNCHECKED_READS_ALLOWLIST.json's ledger: the guard lands
 *                  green and can then only ever shrink.
 *
 * An entry whose site no longer FAILS is stale and the check FAILS on it —
 * watermarking a site, or taking it out of scope, means deleting its entry, so
 * the list cannot describe code that has moved on. An entry with a reason
 * shorter than MIN_REASON_CHARS FAILS. An entry may carry `requires`, text
 * that must still be present in the site's own file: an entry claiming "the
 * span really does come from a watermark, by a route the trace cannot follow"
 * is worthless once someone deletes the watermark, and `requires` turns that
 * deletion into a failure instead of a silent pass. There is no pattern,
 * prefix or directory form: a new site cannot be covered by an existing entry.
 *
 * ── VACUITY ─────────────────────────────────────────────────────────────────
 * Zero files, zero `start…()` owners resolved, zero sites judged, zero
 * watermarked sites found, or any file the parser rejects — each one exits
 * non-zero. A guard that scans nothing and prints green is the trap this repo
 * has hit repeatedly.
 *
 * ── WHAT THIS CANNOT SEE, SAID PLAINLY ─────────────────────────────────────
 *  1. A window computed in one file and used as a filter in another, unless it
 *     arrives at a non-exported function whose calls are all in that file.
 *     telegraph's location sweep is exactly this and needs an entry.
 *  2. A window inside a SQL function called through `.rpc()`. The arguments
 *     are not read either; only SQL spelled out in this tree is matched.
 *  3. Whether a `wider-than-gap` window really is wide enough. The suspend has
 *     no upper bound, so no width is proof of anything.
 *  4. Whether an `entity-scoped` read's entity list was itself chosen by a
 *     relative window. The selecting read is judged; the per-entity read is
 *     not.
 *  5. ENTITY-SCOPING IS "NOT PROVABLY CONSTANT", NOT "PROVABLY RUNTIME". A
 *     chain carrying a filter whose value this checker cannot fold to a
 *     constant is treated as entity-pinned and leaves scope. Following
 *     `export const`s into their module narrows that considerably — a filter
 *     over an imported literal list no longer hides a window — but a value
 *     coming from a helper call still does. Telling runtime-valued predicates
 *     apart from merely unreadable ones is the real fix and is not done.
 *  6. A timestamp column whose name matches no TEMPORAL_COLUMN pattern,
 *     filtered by a bound the trace cannot reach the clock through.
 *  7. Whether any of this RUNS. No process, no database, no network.
 *
 * Exit 0 = clean; 1 = a violation, a vacuous scan or a rotten allowlist;
 * 2 = the tree could not be read.
 *
 * Usage (from artifacts/api-server):
 *   pnpm run check:scheduler-relative-windows
 *   node --import tsx/esm src/scripts/checkSchedulerRelativeWindows.ts
 *   … -- --print   also list every allowed, entity-scoped and wide site
 *   … -- --json
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { STARTED_SCHEDULERS } from "../lib/schedulerCoverage.js";
import { listSourceFiles } from "./lib/tableAccessExtract.js";

const __dir = dirname(fileURLToPath(import.meta.url));
export const SRC_ROOT = resolve(__dir, "..");

const HOUR_MS = 60 * 60 * 1_000;

/**
 * The gap this host is assumed able to produce. See the docblock: a judgement,
 * not a measurement, chosen above the 54-hour stall of 2026-09-30 and equal to
 * CompassAbuseDefenseEngine's own "quiet long weekend" catch-up cap.
 */
export const PLAUSIBLE_GAP_MS = 72 * HOUR_MS;

/** A reason shorter than this is not a reason. */
export const MIN_REASON_CHARS = 80;

// ── The allowlist ───────────────────────────────────────────────────────────

export interface AllowEntry {
  /** Structural site key: `<file>::<fn>::<table>.<method>(<column>)`. */
  key: string;
  kind: "governed" | "known_defect";
  /** `known_defect` notes must start with one of DEFECT_LABELS. */
  reason: string;
  /**
   * Text that must still be present in the site's own file for the reason to
   * hold — the entry's INSPECTION PROOF. An entry claiming "the span really
   * comes from a watermark the trace cannot follow" is worthless if someone
   * later deletes the watermark; naming the mechanism here makes that deletion
   * a stale-entry failure instead of a silent pass.
   */
  requires?: readonly string[];
}

export const DEFECT_LABELS = ["LOSES-DATA:", "UNCLASSIFIED:"] as const;

/**
 * Every in-scope site in the tree that is not watermarked. Short on purpose:
 * each line is a judgement someone made about one named read.
 */
export const ALLOWLIST: readonly AllowEntry[] = [
  // ── governed: the window is not the hazard here ───────────────────────────
  {
    key: 'lib/stamps/countryGeocoder.ts::runCorrectionSweep::city_country_geocode_cache.gte("corrected_at")',
    kind: "governed",
    requires: ['.lt("deleted_at", reclaimBefore)', "TOMBSTONE_RECLAIM_AFTER_MS", "evictIfDbCorrected"],
    reason:
      "Pass 1 of the correction sweep is an in-memory CACHE EVICTION SIGNAL, not a work queue. A correction has " +
      "to reach each instance's `_cache` once, and the READ path's own `evictIfDbCorrected` covers any instance " +
      "this pass missed, so a skipped window costs a stale cache entry until the next read of that city, not a " +
      "lost row. The pass whose goal this window DID defeat — reclaiming tombstone storage — was converted to " +
      "the absolute predicate in pass 3 (`.lt(\"deleted_at\", reclaimBefore)`), which this check deliberately " +
      "does not flag. The file's own 'WHY THIS IS NOT THE SWEEP WINDOW' note is the argument in full.",
  },
  {
    key: 'lib/stamps/countryGeocoder.ts::runCorrectionSweep::city_country_geocode_cache.gte("deleted_at")',
    kind: "governed",
    requires: ['.lt("deleted_at", reclaimBefore)', "TOMBSTONE_RECLAIM_AFTER_MS", "evictIfDbCorrected"],
    reason:
      "Pass 2, same mechanism as pass 1 above: it evicts in-memory entries for tombstoned cities and hard-deletes " +
      "the tombstones it could see. The rows it could NOT see — tombstoned while no sweep ran — are reclaimed by " +
      "pass 3's absolute age predicate, which exists precisely because this window forfeits them. Correctness " +
      "never depended on the window: `readDbCache` and `evictIfDbCorrected` treat a tombstoned row and an absent " +
      "row identically.",
  },
  {
    key: 'services/telegraph/lifecycleSweep.ts::sweepExpiredLocationShares::messages.gte("created_at")',
    kind: "governed",
    requires: ["sharesExpiringIn(candidates, sinceMs, nowMs)", "LOCATION_SWEEP_HORIZON_HOURS"],
    reason:
      "This bound is the sweep's HORIZON on when a share STARTED, not its selection predicate. Which shares the " +
      "pass acts on is decided by `sharesExpiringIn(candidates, sinceMs, nowMs)`, and `sinceMs` is the durable " +
      "watermark `telegraph_location_expiry` that server/telegraph/lifecycleScheduler.ts reads through " +
      "`scanWindow`. The horizon is already treated as a coverage CEILING rather than a window: " +
      "MAX_LOCATION_CATCHUP_MS is computed from LOCATION_SWEEP_HORIZON_HOURS, so a catch-up wider than this read " +
      "can serve reports `capped` instead of claiming the span. The checker cannot see this because the " +
      "watermark crosses a file boundary as a plain `{ now, since }` argument.",
  },
  {
    key: 'lib/mapTravelers.ts::loadCandidates::user_location_state.gte("last_known_at")',
    kind: "governed",
    requires: ["FRESH_MAX_MS"],
    reason:
      "A PRESENCE FRESHNESS predicate serving a request-time read, not a pass that consumes rows: it answers " +
      "\"who was last seen inside this viewport recently\" for the travellers map. `user_location_state` holds one " +
      "MUTABLE row per user that each position fix updates in place, so a traveller outside the window is matched " +
      "again after their next fix. Nothing is written per row and nothing is marked done, so a gap leaves no work " +
      "behind to forfeit.",
  },
  {
    key: 'compass/CompassAbuseDefenseEngine.ts::detectHashtagSpam::hashtag_usage.gte("created_at")',
    kind: "governed",
    requires: ["windows.set(key, scanWindow({", 'resolveWindow(win, "hashtag_spam")', "compass_abuse_hashtag_spam"],
    reason:
      "ALREADY WATERMARKED, by a route the trace cannot follow. `runScan` reads the durable mark " +
      "`compass_abuse_hashtag_spam`, builds the span with `windows.set(key, scanWindow({…}))`, and hands it to " +
      "this detector through the DETECTORS dispatch table — `DETECTORS.map(([name, fn]) => fn(db, userId, " +
      "windows.get(name) ?? null))` — so the function is never called by name and its `win` parameter has no " +
      "readable call site. `resolveWindow(win, …)`'s `now - lookbackMs` fallback is the scoped-scan path, which " +
      "commits nothing. Delete this entry if the dispatch table goes away and the trace can reach scanWindow.",
  },
  {
    key: 'compass/CompassAbuseDefenseEngine.ts::detectGeotagFarming::passport_stamps.gte("created_at")',
    kind: "governed",
    requires: ["windows.set(key, scanWindow({", 'resolveWindow(win, "geotag_farming")', "compass_abuse_geotag_farming"],
    reason:
      "ALREADY WATERMARKED, same route as detectHashtagSpam above: the span comes from `scanWindow` against the " +
      "durable mark `compass_abuse_geotag_farming` and arrives through the DETECTORS dispatch table, which the " +
      "parameter trace cannot follow. This is the detector the watermark was added FOR — a one-hour window on a " +
      "one-hour timer, so every suspended hour used to be lost outright.",
  },
  {
    key: 'compass/CompassAbuseDefenseEngine.ts::detectAvailableNowAbuse::compass_active_user_events.gte("created_at")',
    kind: "governed",
    requires: ["windows.set(key, scanWindow({", 'resolveWindow(win, "available_now_abuse")', "compass_abuse_available_now_abuse"],
    reason:
      "ALREADY WATERMARKED, same route as detectHashtagSpam above: `scanWindow` against the durable mark " +
      "`compass_abuse_available_now_abuse`, delivered through the DETECTORS dispatch table that the parameter " +
      "trace cannot follow.",
  },
  {
    key: 'compass/CompassOutcomeEngine.ts::computeValueDelivered::compass_outcome_events.gte("occurred_at")',
    kind: "governed",
    requires: ["days?: number", "basis: \"outcome_chain\""],
    reason:
      "A REPORTING aggregate over a period the CALLER chooses (`opts.days`, defaulted to 30 and clamped to 1..90), " +
      "recomputed from scratch on every call and returned to the caller. No row is marked, nothing is emitted and " +
      "nothing is consumed, so a gap changes which period a report covers rather than losing anything. The width " +
      "is unresolvable here on purpose — it depends on the caller — and that refusal is why this needs an entry " +
      "rather than falling out as wider than the plausible gap.",
  },
  {
    key: 'compass/CompassOutcomeEngine.ts::computeValueDelivered::compass_served_recommendations.gte("created_at")',
    kind: "governed",
    requires: ["days?: number", "basis: \"outcome_chain\""],
    reason:
      "The denominator of the same caller-parameterised report as the entry above (a head/count read over the " +
      "same `cutoff`). Same argument: recomputed per call, nothing consumed, so the window selects what the " +
      "report is ABOUT and not what work gets done.",
  },
  {
    key: 'lib/zombieTokenSweeper.ts::sweepZombieTokens::notification_delivery_attempts.gte("created_at")',
    kind: "governed",
    requires: ["%DeviceNotRegistered%", "FAILURE_THRESHOLD"],
    reason:
      "The evidence this window reads is REGENERATED, not consumed: a zombie push token keeps being sent to, so " +
      "it keeps producing fresh DeviceNotRegistered rows, and the threshold is met again in the next window. A " +
      "missed sweep therefore delays the revocation rather than forfeiting it. The width is genuinely not " +
      "establishable — ZOMBIE_TOKEN_SWEEP_LOOKBACK_DAYS is an environment variable (default 7 days) — which is " +
      "why this is an entry and not a wider-than-gap classification.",
  },

  // ── known defects: a real relative window nobody has fixed ────────────────
  {
    key: 'lib/intelCoverageScheduler.ts::runIntelCoveragePass::intel_observations.gte("observed_at")',
    kind: "known_defect",
    requires: ["OBS_WINDOW_MS", "MISSION_DEMAND_WINDOW_MS"],
    reason:
      "LOSES-DATA: promoted from UNCLASSIFIED on 2026-10-03, because its open question is now answered. " +
      "The 24-hour bound this " +
      "check can see (OBS_WINDOW_MS) is the lesser half: snapshots carry SNAPSHOT_TTL_MS, are rewritten every " +
      "pass, and are pruned by an absolute predicate, so a gap leaves them stale and then correct again. The " +
      "answer to the old question — is a mission that would have been created from work inside the gap still " +
      "created by a later pass — is NO, and the deciding window is one this check CANNOT SEE: " +
      "MISSION_DEMAND_WINDOW_MS is 6 hours and is applied in memory at intelCoverageScheduler.ts:182, " +
      "`saves.filter((s) => Date.parse(s.saved_at) >= missionWindowMs)`, not as a table bound. The only " +
      "mission-creating path requires `demand6h >= MISSION_TRIGGER_THRESHOLDS.minDemandEvents6h` (10) as a hard " +
      "conjunct, so once a demand spike ages past six hours the mission is forfeited permanently — saves never " +
      "get newer. Grace period is therefore about six hours of continuous suspension: the fifteen-minute idle " +
      "suspend cannot reach it, the 54-hour stall of 2026-09-30 would have. It is ledgered rather than fixed " +
      "because `intel_coverage` is false in production (read 2026-10-03), but note that the second switch the " +
      "file's header leans on, `intel_missions`, is already TRUE there, so flipping one flag arms this in one " +
      "motion. See the DOES NOT COVER line: an in-memory window is this check's blind spot, named there.",
  },
  {
    key: 'lib/sensingPublicationScheduler.ts::runSensingPublicationPass::SENSING_TABLE.gte("time_bucket")',
    kind: "known_defect",
    requires: ["SENSING_PUBLICATION_LOOKBACK_BUCKETS"],
    reason:
      "LOSES-DATA: promoted from UNCLASSIFIED on 2026-10-03. The classification question is settled — " +
      "sensingTimeBucket (lib/sensingAnonStore.ts:256) only floors, `Math.floor(atMs / width) * width`, with no " +
      "clamp and no slack — and the number this entry used to carry was wrong in the direction that understates " +
      "the hazard. It said ONE bucket, 30 minutes. MEASURED: a cohort in bucket B is selected for 60 contiguous " +
      "minutes, [B, B+60min), because the floor is applied AFTER the subtraction and `time_bucket` is itself " +
      "already floored, so `B >= floor(now - 30min)` holds for twice the bucket width. Same error shape as the " +
      "trip reminder's 28-hour band: reading the bounds is not measuring the window. " +
      "The loss is routine rather than outage-scale, and worse than 'a gap wider than the window': the only " +
      "writer of SENSING_TABLE is the HTTP ingest route, so a quiet period BEGINS with the last contribution " +
      "and the host suspends fifteen idle minutes later. That leaves only [observedAt+10min, observedAt+15min) " +
      "for a fifteen-minute tick to publish the evening's last cohort, which two thirds of tick phases miss. " +
      "NOT FIXED, and deliberately not by this lane, because a catch-up is a PRIVACY decision and not a bug " +
      "fix: (a) the only reader asks for the current and previous bucket only (CompassSensingPresenceProducer " +
      "bucketsBack = 1), so a late publication is served to nobody unless the consumer is widened too; (b) " +
      "3110's TTL CHECK measures expires_at from published_at, not from time_bucket, so publishing a cohort G " +
      "minutes late makes its record outlive its window by G — and 3110 calls that TTL a privacy bound; (c) " +
      "appending a late point to a closed cohort's published series extends the anti-differencing control into " +
      "the region where rows have been revoked or expired. Also note this caller would be the first one the " +
      "watermark module's own safety premise does not cover: recordPublishedAggregate is an append-only INSERT " +
      "and evaluateDifferencing publishes at delta 0, so re-scanning a span writes another row instead of being " +
      "idempotent. Whoever lands a fix must delete this entry in the same change, or the guard fails on it as " +
      "stale — which is the intended coupling, not an obstacle.",
  },
  {
    key: 'server/trips/projectionWorkers/tripReminderScheduler.ts::runOnce::trips.gte("start_date")',
    kind: "known_defect",
    requires: ["WINDOW_LOWER_HRS", "WINDOW_UPPER_HRS"],
    reason:
      "LOSES-DATA: the reminder band is `start_date` between `now + WINDOW_LOWER_HRS` (22 h) and " +
      "`now + WINDOW_UPPER_HRS` (26 h), which is a window relative to now even though it points FORWARD — the " +
      "band moves past a trip and no later pass looks back. The four-hour span of the bounds is NOT how long a " +
      "trip stays inside it: `start_date` is a DATE column (migration 2450 casts it) and both bounds are " +
      "truncated with `.slice(0, 10)`, so the band is compared date-to-date. Simulated minute by minute, a trip " +
      "starting 2026-10-09 is selected from 2026-10-07T22:00Z through 2026-10-09T01:59Z, contiguously: 28 hours, " +
      "not 4. That is outage-scale, not quiet-night-scale — the fifteen-minute idle suspend cannot reach it, the " +
      "54-hour stall of 2026-09-30 would have. `reminder_sent_at IS NULL` keeps the work pending but nothing " +
      "ever looks outside the band. recoverStaleClaims does not cover it: that sweep requires `reminder_sent_at " +
      "IS NOT NULL`, which is exactly what never happened here.",
  },
  {
    key: 'server/trips/projectionWorkers/tripReminderScheduler.ts::recoverStaleClaims::trips.gte("start_date")',
    kind: "known_defect",
    requires: ["RECOVERY_DRIFT_HRS", "MAX_RECOVERY_AGE_MS"],
    reason:
      "UNCLASSIFIED: the recovery sweep's own forward band, the runOnce band widened by RECOVERY_DRIFT_HRS on " +
      "each side. A claimed-but-undelivered reminder whose trip leaves this band during a stall is recovered by " +
      "no later pass. The file states the intent — 'the reminder window has passed, so there is nothing useful to " +
      "deliver' — which may make the loss deliberate; it is recorded here rather than assumed, because 'nothing " +
      "useful to deliver' is a product call and not a property of the code.",
  },
  {
    key: 'server/trips/projectionWorkers/tripReminderScheduler.ts::recoverStaleClaims::trips.gte("reminder_sent_at")',
    kind: "known_defect",
    requires: ["MAX_RECOVERY_AGE_MS"],
    reason:
      "UNCLASSIFIED: the 26-hour floor (MAX_RECOVERY_AGE_MS) on how old a claim may be and still be recovered. " +
      "Same judgement as the entry above and the same open question: a claim that aged past the floor inside a " +
      "stall is abandoned silently, with no row recording that a reminder was promised and never sent.",
  },
];

// ── Reachability: which files a scheduled job can reach ─────────────────────

export interface Tree {
  /** Every non-test, non-script source file under the root. */
  files: readonly string[];
  /** `start…()` name -> the file exporting it. */
  owners: ReadonlyMap<string, string>;
  /** `start…()` names `lib/schedulerCoverage.ts` lists that no file exports. */
  ownerless: readonly string[];
  /** Transitive import closure of the owners. */
  reachable: ReadonlySet<string>;
}

const astCache = new Map<string, ts.SourceFile>();

export function parseFile(file: string, text?: string): ts.SourceFile {
  const cached = astCache.get(file);
  if (cached && text === undefined) return cached;
  const sf = ts.createSourceFile(
    file,
    text ?? readFileSync(file, "utf8"),
    ts.ScriptTarget.ES2022,
    /* setParentNodes */ true,
  );
  if (text === undefined) astCache.set(file, sf);
  return sf;
}

function resolveRelativeImport(from: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(from), spec).replace(/\.js$/, "");
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch {
      /* unreadable candidate is not a resolution */
    }
  }
  return null;
}

/** Every in-tree file this one imports — static imports, re-exports and `import()`. */
export function importsOf(file: string, sf: ts.SourceFile): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (
      (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
      n.moduleSpecifier !== undefined &&
      ts.isStringLiteral(n.moduleSpecifier)
    ) {
      const r = resolveRelativeImport(file, n.moduleSpecifier.text);
      if (r !== null) out.push(r);
    }
    if (
      ts.isCallExpression(n) &&
      n.expression.kind === ts.SyntaxKind.ImportKeyword &&
      n.arguments.length > 0 &&
      ts.isStringLiteralLike(n.arguments[0]!)
    ) {
      const r = resolveRelativeImport(file, (n.arguments[0] as ts.StringLiteralLike).text);
      if (r !== null) out.push(r);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

export function readTree(root: string = SRC_ROOT): Tree {
  const files = listSourceFiles(root).filter(
    (f) => !f.startsWith(join(root, "test")) && !f.startsWith(join(root, "scripts")),
  );
  const owners = new Map<string, string>();
  const ownerless: string[] = [];
  for (const row of STARTED_SCHEDULERS) {
    // The same shape check:scheduler-coverage uses to find a scheduler's file.
    const re = new RegExp(`export\\s+(?:async\\s+)?(?:function|const)\\s+${row.start}\\b`);
    const owner = files.find((f) => re.test(readFileSync(f, "utf8")));
    if (owner === undefined) ownerless.push(row.start);
    else owners.set(row.start, owner);
  }
  const reachable = new Set<string>(owners.values());
  const queue = [...reachable];
  while (queue.length > 0) {
    const f = queue.shift()!;
    for (const imported of importsOf(f, parseFile(f))) {
      if (!reachable.has(imported)) {
        reachable.add(imported);
        queue.push(imported);
      }
    }
  }
  return { files, owners, ownerless, reachable };
}

// ── Provenance of a bound ──────────────────────────────────────────────────

export type Cls = "watermark" | "relative" | "now" | "const" | "unknown";
export interface Prov {
  cls: Cls;
  /** How the trace got there, for the failure message. */
  why: string;
}

const MAX_DEPTH = 24;
const CLOCK_METHODS = new Set(["toISOString", "getTime", "valueOf", "toJSON", "toUTCString", "toString"]);

function unwrap(e: ts.Expression): ts.Expression {
  let n: ts.Expression = e;
  for (;;) {
    if (ts.isParenthesizedExpression(n) || ts.isAwaitExpression(n) || ts.isNonNullExpression(n)) n = n.expression;
    else if (ts.isAsExpression(n) || ts.isTypeAssertionExpression(n)) n = n.expression;
    else if (ts.isSatisfiesExpression(n)) n = n.expression;
    else return n;
  }
}

function isFunctionLike(n: ts.Node): n is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isConstructorDeclaration(n) ||
    ts.isGetAccessorDeclaration(n)
  );
}

/**
 * The declaration `name` resolves to AT `from`, searching enclosing scopes
 * outwards. Deliberately lexical and local: no type checker, no cross-file
 * symbol resolution. A name it cannot place resolves to null, which the caller
 * turns into `unknown` rather than a guess.
 */
export function findDeclaration(name: string, from: ts.Node): ts.Node | null {
  let cur: ts.Node | undefined = from;
  while (cur !== undefined) {
    if (isFunctionLike(cur)) {
      for (const p of cur.parameters) {
        if (ts.isIdentifier(p.name) && p.name.text === name) return p;
      }
    }
    if (ts.isCatchClause(cur) && cur.variableDeclaration !== undefined) {
      const v = cur.variableDeclaration;
      if (ts.isIdentifier(v.name) && v.name.text === name) return v;
    }
    if (ts.isForOfStatement(cur) || ts.isForInStatement(cur) || ts.isForStatement(cur)) {
      const init = cur.initializer;
      if (init !== undefined && ts.isVariableDeclarationList(init)) {
        for (const d of init.declarations) {
          if (ts.isIdentifier(d.name) && d.name.text === name) return d;
        }
      }
    }
    const statements: readonly ts.Statement[] | undefined = ts.isSourceFile(cur)
      ? cur.statements
      : ts.isBlock(cur)
        ? cur.statements
        : ts.isModuleBlock(cur)
          ? cur.statements
          : ts.isCaseClause(cur) || ts.isDefaultClause(cur)
            ? cur.statements
            : undefined;
    if (statements !== undefined) {
      for (const s of statements) {
        if (ts.isVariableStatement(s)) {
          for (const d of s.declarationList.declarations) {
            if (ts.isIdentifier(d.name) && d.name.text === name) return d;
          }
        }
        if (ts.isFunctionDeclaration(s) && s.name?.text === name) return s;
        if (ts.isClassDeclaration(s) && s.name?.text === name) return s;
        if (ts.isImportDeclaration(s)) {
          const bindings = s.importClause?.namedBindings;
          if (bindings !== undefined && ts.isNamedImports(bindings)) {
            for (const spec of bindings.elements) if (spec.name.text === name) return spec;
          }
          if (bindings !== undefined && ts.isNamespaceImport(bindings) && bindings.name.text === name) return bindings;
          if (s.importClause?.name?.text === name) return s.importClause;
        }
      }
    }
    cur = cur.parent;
  }
  return null;
}

/** The function-like node `n` sits inside, if any. */
function enclosingFunction(n: ts.Node): ts.FunctionLikeDeclaration | null {
  let cur: ts.Node | undefined = n.parent;
  while (cur !== undefined) {
    if (isFunctionLike(cur)) return cur;
    cur = cur.parent;
  }
  return null;
}

/** Is this function-like reachable from outside the module? */
function isExportedFunction(fn: ts.FunctionLikeDeclaration): boolean {
  const mods = ts.canHaveModifiers(fn) ? (ts.getModifiers(fn) ?? []) : [];
  if (mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return true;
  // `export const f = () => …`, `export default function …`, a class method
  // (the class may be exported), or a function assigned into an exported object.
  let cur: ts.Node | undefined = fn.parent;
  while (cur !== undefined) {
    if (ts.isSourceFile(cur)) return false;
    if (ts.isMethodDeclaration(cur) || ts.isClassDeclaration(cur) || ts.isClassExpression(cur)) return true;
    if (ts.isExportAssignment(cur) || ts.isExportSpecifier(cur)) return true;
    const mods2 = ts.canHaveModifiers(cur) ? (ts.getModifiers(cur) ?? []) : [];
    if (mods2.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return true;
    cur = cur.parent;
  }
  return false;
}

/** Every `name(...)` call in the file. */
function callSitesOf(name: string, sf: ts.SourceFile): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const callee = unwrap(n.expression);
      if (ts.isIdentifier(callee) && callee.text === name) out.push(n);
      else if (ts.isPropertyAccessExpression(callee) && callee.name.text === name) out.push(n);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** The `return` expressions of one function body. */
function returnExpressions(fn: ts.FunctionLikeDeclaration): ts.Expression[] {
  const out: ts.Expression[] = [];
  if (fn.body === undefined) return out;
  if (!ts.isBlock(fn.body)) return [fn.body];
  const visit = (n: ts.Node): void => {
    if (isFunctionLike(n) && n !== fn) return; // a nested function's returns are not ours
    if (ts.isReturnStatement(n) && n.expression !== undefined) out.push(n.expression);
    ts.forEachChild(n, visit);
  };
  visit(fn.body);
  return out;
}

/** The function-like a declaration node denotes, if it denotes one. */
function functionOfDeclaration(decl: ts.Node): ts.FunctionLikeDeclaration | null {
  if (ts.isFunctionDeclaration(decl)) return decl;
  if (ts.isVariableDeclaration(decl) && decl.initializer !== undefined) {
    const init = unwrap(decl.initializer);
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init;
  }
  return null;
}

function worst(ps: readonly Prov[]): Prov {
  if (ps.length === 0) return { cls: "unknown", why: "nothing to trace" };
  const pick = (c: Cls): Prov | undefined => ps.find((p) => p.cls === c);
  // Watermark first: see the docblock on why a watermarked trace with a
  // documented refusal fallback is watermarked, not relative.
  return pick("watermark") ?? pick("relative") ?? pick("unknown") ?? pick("now") ?? ps[0]!;
}

interface Ctx {
  sf: ts.SourceFile;
  /** Absolute path of `sf`, so an imported name can be followed to its module. */
  path: string;
  /** Guards recursion through functions and parameters. */
  seen: Set<ts.Node>;
}

/**
 * Methods that transform a collection without changing WHERE it came from. For
 * the question these are asked (does this predicate pin the read to runtime
 * data, or is it a constant list?), a pure transformation of a constant is
 * still a constant, so the receiver's origin is the answer and the callback is
 * not read. `CONSTS.map(() => Date.now())` would therefore read as constant —
 * accepted, because a mapped array is never a time BOUND.
 */
const COLLECTION_TRANSFORMS = new Set([
  "map", "filter", "flatMap", "slice", "concat", "join", "sort", "reverse", "flat",
  "entries", "keys", "values", "at", "find",
]);

/**
 * The module an `import` specifier names, and the exported declaration of
 * `name` inside it — so a window width or a filter value held in another
 * file's `export const` is READ rather than written off as unknown. Without
 * this, any predicate over an imported constant list looks un-establishable,
 * and `.in("subtype", IMPORTED_LIST.map(…))` would read as a runtime entity
 * pin and take its whole chain out of scope.
 */
function followImport(spec: ts.ImportSpecifier, ctx: Ctx): { decl: ts.Node; ctx: Ctx } | null {
  const importDecl = spec.parent.parent.parent;
  if (!ts.isImportDeclaration(importDecl) || !ts.isStringLiteral(importDecl.moduleSpecifier)) return null;
  const target = resolveRelativeImport(ctx.path, importDecl.moduleSpecifier.text);
  if (target === null) return null;
  let sf: ts.SourceFile;
  try {
    sf = parseFile(target);
  } catch {
    return null;
  }
  const exported = spec.propertyName?.text ?? spec.name.text;
  for (const st of sf.statements) {
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === exported) return { decl: d, ctx: { sf, path: target, seen: ctx.seen } };
      }
    }
    if (ts.isFunctionDeclaration(st) && st.name?.text === exported) {
      return { decl: st, ctx: { sf, path: target, seen: ctx.seen } };
    }
  }
  return null;
}

/**
 * Where the value of `e` (optionally, of the property `path` read off it)
 * comes from.
 */
export function provenance(e: ts.Expression, ctx: Ctx, path: readonly string[] = [], depth = 0): Prov {
  if (depth > MAX_DEPTH) return { cls: "unknown", why: "trace depth exceeded" };
  const x = unwrap(e);
  const rec = (next: ts.Expression, nextPath: readonly string[] = path): Prov =>
    provenance(next, ctx, nextPath, depth + 1);

  if (x.kind === ts.SyntaxKind.NullKeyword || x.kind === ts.SyntaxKind.UndefinedKeyword) {
    return { cls: "const", why: "null/undefined" };
  }
  if (
    ts.isStringLiteralLike(x) ||
    ts.isNumericLiteral(x) ||
    x.kind === ts.SyntaxKind.TrueKeyword ||
    x.kind === ts.SyntaxKind.FalseKeyword
  ) {
    return { cls: "const", why: "literal" };
  }
  if (ts.isArrayLiteralExpression(x)) {
    return worst(x.elements.map((el) => (ts.isSpreadElement(el) ? rec(el.expression, []) : rec(el, []))));
  }
  if (ts.isSpreadElement(x)) return rec(x.expression, []);
  if (ts.isTemplateExpression(x)) {
    return worst(x.templateSpans.map((s) => rec(s.expression, [])));
  }
  if (ts.isPrefixUnaryExpression(x)) return rec(x.operand, []);

  if (ts.isNewExpression(x)) {
    const callee = unwrap(x.expression);
    if (ts.isIdentifier(callee) && callee.text === "Date") {
      if (x.arguments === undefined || x.arguments.length === 0) return { cls: "now", why: "new Date()" };
      return rec(x.arguments[0]!, []);
    }
    if (ts.isIdentifier(callee) && callee.text === "Map") return { cls: "const", why: "new Map()" };
    return { cls: "unknown", why: `new ${callee.getText(ctx.sf).slice(0, 40)}()` };
  }

  if (ts.isCallExpression(x)) {
    const callee = unwrap(x.expression);
    if (ts.isIdentifier(callee)) {
      if (callee.text === "scanWindow") return { cls: "watermark", why: "scanWindow()" };
      const decl = findDeclaration(callee.text, x);
      if (decl !== null) {
        if (ts.isImportSpecifier(decl)) {
          const imported = decl.propertyName?.text ?? decl.name.text;
          if (imported === "scanWindow") return { cls: "watermark", why: "scanWindow()" };
          return { cls: "unknown", why: `imported function ${callee.text}()` };
        }
        const fn = functionOfDeclaration(decl);
        if (fn !== null && !ctx.seen.has(fn)) {
          ctx.seen.add(fn);
          const rets = returnExpressions(fn);
          const out =
            rets.length === 0
              ? { cls: "unknown" as Cls, why: `${callee.text}() returns nothing traceable` }
              : worst(rets.map((r) => provenance(r, ctx, path, depth + 1)));
          ctx.seen.delete(fn);
          return out;
        }
      }
      return { cls: "unknown", why: `call ${callee.text}()` };
    }
    if (ts.isPropertyAccessExpression(callee)) {
      const m = callee.name.text;
      const recv = unwrap(callee.expression);
      if (m === "now" && ts.isIdentifier(recv) && recv.text === "Date") return { cls: "now", why: "Date.now()" };
      if (CLOCK_METHODS.has(m)) return rec(callee.expression);
      if (m === "slice" || m === "substring" || m === "substr") return rec(callee.expression);
      if (COLLECTION_TRANSFORMS.has(m)) return provenance(callee.expression, ctx, [], depth + 1);
      if (m === "get" && ts.isIdentifier(recv)) {
        // A container whose every write the file shows. Used by
        // CompassAbuseDefenseEngine's per-detector `windows` map.
        const decl = findDeclaration(recv.text, x);
        if (decl !== null && ts.isVariableDeclaration(decl) && decl.initializer !== undefined) {
          const init = unwrap(decl.initializer);
          if (ts.isNewExpression(init) && ts.isIdentifier(unwrap(init.expression)) && (unwrap(init.expression) as ts.Identifier).text === "Map") {
            const sets = callSitesOf("set", ctx.sf).filter((c) => {
              const cal = unwrap(c.expression);
              return ts.isPropertyAccessExpression(cal) && ts.isIdentifier(unwrap(cal.expression)) && (unwrap(cal.expression) as ts.Identifier).text === recv.text;
            });
            if (sets.length > 0) {
              return worst(sets.map((c) => (c.arguments.length > 1 ? provenance(c.arguments[1]!, ctx, path, depth + 1) : { cls: "unknown" as Cls, why: "Map#set with no value" })));
            }
          }
        }
        return { cls: "unknown", why: `${recv.text}.get(…)` };
      }
      const fnName = m;
      const decl = findDeclaration(fnName, x);
      const fn = decl !== null ? functionOfDeclaration(decl) : null;
      if (fn !== null && !ctx.seen.has(fn)) {
        ctx.seen.add(fn);
        const out = worst(returnExpressions(fn).map((r) => provenance(r, ctx, path, depth + 1)));
        ctx.seen.delete(fn);
        return out;
      }
      return { cls: "unknown", why: `call ${callee.getText(ctx.sf).slice(0, 48)}()` };
    }
    return { cls: "unknown", why: "call" };
  }

  if (ts.isBinaryExpression(x)) {
    const op = x.operatorToken.kind;
    if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.AmpersandAmpersandToken) {
      return worst([rec(x.left), rec(x.right)]);
    }
    if (op === ts.SyntaxKind.CommaToken) return rec(x.right);
    const l = rec(x.left, []);
    const r = rec(x.right, []);
    if (op === ts.SyntaxKind.MinusToken || op === ts.SyntaxKind.PlusToken) {
      if (l.cls === "watermark" || r.cls === "watermark") return { cls: "watermark", why: "watermark arithmetic" };
      const sign = op === ts.SyntaxKind.MinusToken ? "-" : "+";
      if (l.cls === "now" || l.cls === "relative") return { cls: "relative", why: `${l.why} ${sign} …` };
      if (r.cls === "now" || r.cls === "relative") return { cls: "relative", why: `… ${sign} ${r.why}` };
    }
    return worst([l, r]);
  }

  if (ts.isConditionalExpression(x)) return worst([rec(x.whenTrue), rec(x.whenFalse)]);

  if (ts.isObjectLiteralExpression(x)) {
    if (path.length === 0) return { cls: "unknown", why: "object literal, no property path" };
    const [head, ...rest] = path;
    for (const p of x.properties) {
      const nm = p.name !== undefined && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) ? p.name.text : null;
      if (nm !== head) continue;
      if (ts.isPropertyAssignment(p)) return rec(p.initializer, rest);
      if (ts.isShorthandPropertyAssignment(p)) return rec(p.name, rest);
    }
    // A property this literal does not carry is `undefined` — which is a
    // CONSTANT, and usually the left half of a `?? new Date()` default. A
    // spread means the property may still be there and cannot be read here.
    if (x.properties.some((p) => ts.isSpreadAssignment(p))) {
      return { cls: "unknown", why: `object literal spreads another; \`${String(head)}\` not readable` };
    }
    return { cls: "const", why: `object literal has no \`${String(head)}\` (undefined)` };
  }

  if (ts.isPropertyAccessExpression(x)) return rec(x.expression, [x.name.text, ...path]);
  if (ts.isElementAccessExpression(x)) {
    const arg = x.argumentExpression;
    if (arg !== undefined && ts.isStringLiteralLike(arg)) return rec(x.expression, [arg.text, ...path]);
    return rec(x.expression, path);
  }

  if (ts.isIdentifier(x)) {
    const decl = findDeclaration(x.text, x);
    if (decl === null) return { cls: "unknown", why: `${x.text} (no declaration in this file)` };
    if (ctx.seen.has(decl)) return { cls: "unknown", why: `${x.text} (cyclic)` };
    if (ts.isVariableDeclaration(decl)) {
      if (decl.initializer === undefined) return { cls: "unknown", why: `${x.text} declared without an initializer` };
      ctx.seen.add(decl);
      const out = provenance(decl.initializer, ctx, path, depth + 1);
      ctx.seen.delete(decl);
      return out;
    }
    if (ts.isParameter(decl)) {
      const fn = enclosingFunction(decl);
      const branches: Prov[] = [];
      if (decl.initializer !== undefined) branches.push(provenance(decl.initializer, ctx, path, depth + 1));
      // A parameter's value can only be established when the module holds
      // EVERY call. An exported function may be called from anywhere, so its
      // parameter stays unknown — which is a violation, not a pass.
      if (fn !== null && !isExportedFunction(fn)) {
        const name = ts.isFunctionDeclaration(fn)
          ? (fn.name?.text ?? null)
          : fn.parent !== undefined && ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)
            ? fn.parent.name.text
            : null;
        const idx = fn.parameters.indexOf(decl);
        if (name !== null && idx >= 0 && !ctx.seen.has(decl)) {
          ctx.seen.add(decl);
          for (const call of callSitesOf(name, ctx.sf)) {
            const arg = call.arguments[idx];
            branches.push(
              arg === undefined
                ? { cls: "const", why: "argument omitted" }
                : provenance(arg, ctx, path, depth + 1),
            );
          }
          ctx.seen.delete(decl);
        }
      }
      if (branches.length === 0) return { cls: "unknown", why: `parameter ${x.text}` };
      const out = worst(branches);
      return out.cls === "unknown" ? { cls: "unknown", why: `parameter ${x.text}: ${out.why}` } : out;
    }
    if (ts.isImportSpecifier(decl)) {
      const imported = decl.propertyName?.text ?? decl.name.text;
      if (imported === "scanWindow") return { cls: "watermark", why: "scanWindow (imported)" };
      const followed = followImport(decl, ctx);
      if (followed !== null && ts.isVariableDeclaration(followed.decl) && followed.decl.initializer !== undefined && !ctx.seen.has(followed.decl)) {
        ctx.seen.add(followed.decl);
        const out = provenance(followed.decl.initializer, followed.ctx, path, depth + 1);
        ctx.seen.delete(followed.decl);
        return out;
      }
      return { cls: "unknown", why: `imported ${x.text}` };
    }
    return { cls: "unknown", why: `${x.text} (${ts.SyntaxKind[decl.kind]})` };
  }

  return { cls: "unknown", why: ts.SyntaxKind[x.kind] };
}

// ── Width of a relative window ─────────────────────────────────────────────

/** A compile-time-constant number, folded, or null. */
export function constNumber(e: ts.Expression, ctx: Ctx, depth = 0): number | null {
  if (depth > MAX_DEPTH) return null;
  const x = unwrap(e);
  if (ts.isNumericLiteral(x)) return Number(x.text.replace(/_/g, ""));
  if (ts.isPrefixUnaryExpression(x)) {
    const v = constNumber(x.operand, ctx, depth + 1);
    if (v === null) return null;
    if (x.operator === ts.SyntaxKind.MinusToken) return -v;
    if (x.operator === ts.SyntaxKind.PlusToken) return v;
    return null;
  }
  if (ts.isBinaryExpression(x)) {
    const l = constNumber(x.left, ctx, depth + 1);
    const r = constNumber(x.right, ctx, depth + 1);
    if (l === null || r === null) return null;
    switch (x.operatorToken.kind) {
      case ts.SyntaxKind.AsteriskToken: return l * r;
      case ts.SyntaxKind.SlashToken: return l / r;
      case ts.SyntaxKind.PlusToken: return l + r;
      case ts.SyntaxKind.MinusToken: return l - r;
      default: return null;
    }
  }
  if (ts.isCallExpression(x)) {
    const callee = unwrap(x.expression);
    if (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(unwrap(callee.expression)) &&
      (unwrap(callee.expression) as ts.Identifier).text === "Math"
    ) {
      const args = x.arguments.map((a) => constNumber(a, ctx, depth + 1));
      if (args.some((a) => a === null)) return null;
      const nums = args as number[];
      if (callee.name.text === "min") return Math.min(...nums);
      if (callee.name.text === "max") return Math.max(...nums);
      if (callee.name.text === "round" || callee.name.text === "floor" || callee.name.text === "trunc") return Math[callee.name.text](nums[0]!);
    }
    return null;
  }
  if (ts.isPropertyAccessExpression(x)) {
    const base = unwrap(x.expression);
    if (ts.isIdentifier(base)) {
      const decl = findDeclaration(base.text, x);
      if (decl !== null && ts.isVariableDeclaration(decl) && decl.initializer !== undefined) {
        const init = unwrap(decl.initializer);
        if (ts.isObjectLiteralExpression(init)) {
          for (const p of init.properties) {
            const nm = p.name !== undefined && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) ? p.name.text : null;
            if (nm === x.name.text && ts.isPropertyAssignment(p)) return constNumber(p.initializer, ctx, depth + 1);
          }
        }
      }
    }
    return null;
  }
  if (ts.isElementAccessExpression(x)) return null;
  if (ts.isIdentifier(x)) {
    const decl = findDeclaration(x.text, x);
    if (decl !== null && ts.isVariableDeclaration(decl) && decl.initializer !== undefined) {
      if (ctx.seen.has(decl)) return null;
      ctx.seen.add(decl);
      const out = constNumber(decl.initializer, ctx, depth + 1);
      ctx.seen.delete(decl);
      return out;
    }
    if (decl !== null && ts.isImportSpecifier(decl)) {
      const followed = followImport(decl, ctx);
      if (followed !== null && ts.isVariableDeclaration(followed.decl) && followed.decl.initializer !== undefined && !ctx.seen.has(followed.decl)) {
        ctx.seen.add(followed.decl);
        const out = constNumber(followed.decl.initializer, followed.ctx, depth + 1);
        ctx.seen.delete(followed.decl);
        return out;
      }
    }
    return null;
  }
  return null;
}

/**
 * The NARROWEST width among the branches that could be read, ignoring the ones
 * that could not. Deliberately asymmetric: understating a window pulls the
 * site INTO scope, which is the direction a guard may err in.
 */
function narrowest(widths: ReadonlyArray<number | null>): number | null {
  const known = widths.filter((w): w is number => w !== null);
  return known.length === 0 ? null : Math.min(...known);
}

/**
 * How far back of NOW the bound reaches, in ms, or null when that cannot be
 * established. Null is NOT "zero" and NOT "wide" — it is a refusal, and the
 * caller treats it as in scope.
 */
export function windowWidthMs(e: ts.Expression, ctx: Ctx, path: readonly string[] = [], depth = 0): number | null {
  if (depth > MAX_DEPTH) return null;
  const x = unwrap(e);
  if (ts.isCallExpression(x)) {
    const callee = unwrap(x.expression);
    if (ts.isPropertyAccessExpression(callee)) {
      const recv = unwrap(callee.expression);
      // The clock anchor itself: zero ms back of now.
      if (callee.name.text === "now" && ts.isIdentifier(recv) && recv.text === "Date") return 0;
      if (CLOCK_METHODS.has(callee.name.text) || callee.name.text === "slice") {
        return windowWidthMs(callee.expression, ctx, path, depth + 1);
      }
    }
    if (ts.isIdentifier(callee)) {
      const decl = findDeclaration(callee.text, x);
      const fn = decl !== null ? functionOfDeclaration(decl) : null;
      if (fn !== null && !ctx.seen.has(fn)) {
        ctx.seen.add(fn);
        const widths = returnExpressions(fn).map((r) => windowWidthMs(r, ctx, path, depth + 1));
        ctx.seen.delete(fn);
        return narrowest(widths);
      }
    }
    return null;
  }
  if (ts.isNewExpression(x) && ts.isIdentifier(unwrap(x.expression)) && (unwrap(x.expression) as ts.Identifier).text === "Date") {
    if (x.arguments === undefined || x.arguments.length === 0) return 0;
    return windowWidthMs(x.arguments[0]!, ctx, [], depth + 1);
  }
  if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.MinusToken) {
    const left = windowWidthMs(x.left, ctx, [], depth + 1);
    const amount = constNumber(x.right, ctx, depth + 1);
    if (left !== null && amount !== null) return left + amount;
    return null;
  }
  if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = windowWidthMs(x.left, ctx, [], depth + 1);
    const amount = constNumber(x.right, ctx, depth + 1);
    if (left !== null && amount !== null) return left - amount;
    return null;
  }
  if (
    ts.isBinaryExpression(x) &&
    (x.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || x.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return narrowest([windowWidthMs(x.left, ctx, path, depth + 1), windowWidthMs(x.right, ctx, path, depth + 1)]);
  }
  if (ts.isConditionalExpression(x)) {
    return narrowest([windowWidthMs(x.whenTrue, ctx, path, depth + 1), windowWidthMs(x.whenFalse, ctx, path, depth + 1)]);
  }
  if (ts.isObjectLiteralExpression(x) && path.length > 0) {
    const [head, ...rest] = path;
    for (const p of x.properties) {
      const nm = p.name !== undefined && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) ? p.name.text : null;
      if (nm === head && ts.isPropertyAssignment(p)) return windowWidthMs(p.initializer, ctx, rest, depth + 1);
    }
    return null;
  }
  if (ts.isPropertyAccessExpression(x)) return windowWidthMs(x.expression, ctx, [x.name.text, ...path], depth + 1);
  if (ts.isIdentifier(x)) {
    if (x.text === "Date") return null;
    const decl = findDeclaration(x.text, x);
    if (decl === null || ctx.seen.has(decl)) return null;
    if (ts.isVariableDeclaration(decl) && decl.initializer !== undefined) {
      ctx.seen.add(decl);
      const out = windowWidthMs(decl.initializer, ctx, path, depth + 1);
      ctx.seen.delete(decl);
      return out;
    }
    if (ts.isParameter(decl)) {
      // Same rule as `provenance`: a parameter is only readable when the module
      // holds every call, which it does not for an exported function.
      const fn = enclosingFunction(decl);
      if (fn === null || isExportedFunction(fn)) return null;
      const name = ts.isFunctionDeclaration(fn)
        ? (fn.name?.text ?? null)
        : fn.parent !== undefined && ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)
          ? fn.parent.name.text
          : null;
      const idx = fn.parameters.indexOf(decl);
      if (name === null || idx < 0) return null;
      ctx.seen.add(decl);
      const widths = callSitesOf(name, ctx.sf).map((c) => {
        const arg = c.arguments[idx];
        return arg === undefined ? null : windowWidthMs(arg, ctx, path, depth + 1);
      });
      if (decl.initializer !== undefined) widths.push(windowWidthMs(decl.initializer, ctx, path, depth + 1));
      ctx.seen.delete(decl);
      return narrowest(widths);
    }
    return null;
  }
  // `Date.now()` is reached through the CallExpression branch above; anything
  // else is not a clock anchor this function can read.
  return null;
}

// ── PostgREST chains ──────────────────────────────────────────────────────

const LOWER_BOUND_METHODS = new Set(["gt", "gte"]);
/** Methods whose non-constant argument pins the read to a particular entity. */
const ENTITY_METHODS = new Set(["eq", "in", "match", "contains", "containedBy", "overlaps", "like", "ilike", "textSearch", "neq"]);

interface ChainInfo {
  table: string | null;
  /** Every filter method called on the same chain, including builder statements. */
  calls: Array<{ method: string; args: readonly ts.Expression[] }>;
  sawFrom: boolean;
}

function chainTableName(call: ts.CallExpression): string | null {
  const arg = call.arguments[0];
  if (arg === undefined) return null;
  if (ts.isStringLiteralLike(arg)) return arg.text;
  if (ts.isIdentifier(arg)) {
    const decl = findDeclaration(arg.text, arg);
    if (decl !== null && ts.isVariableDeclaration(decl) && decl.initializer !== undefined) {
      const init = unwrap(decl.initializer);
      if (ts.isStringLiteralLike(init)) return init.text;
    }
    return arg.text;
  }
  return null;
}

/**
 * The PostgREST chain the given call sits on: its table and every filter
 * applied to it, following a builder variable's declaration and the
 * `query = query.eq(…)` / `q.eq(…)` statements that mutate it.
 */
export function chainOf(call: ts.CallExpression, ctx: Ctx): ChainInfo {
  const info: ChainInfo = { table: null, calls: [], sawFrom: false };
  const visited = new Set<ts.Node>();
  const walk = (node: ts.Expression, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    const x = unwrap(node);
    if (visited.has(x)) return;
    visited.add(x);
    if (ts.isCallExpression(x)) {
      const callee = unwrap(x.expression);
      if (ts.isPropertyAccessExpression(callee)) {
        const m = callee.name.text;
        if (m === "from") {
          info.sawFrom = true;
          info.table = info.table ?? chainTableName(x);
          return;
        }
        info.calls.push({ method: m, args: x.arguments });
        walk(callee.expression, depth + 1);
        return;
      }
      return;
    }
    if (ts.isIdentifier(x)) {
      // A builder variable. Follow its declaration, then collect every
      // statement in the enclosing scope that applies a further filter to it.
      const decl = findDeclaration(x.text, x);
      if (decl !== null && ts.isVariableDeclaration(decl) && decl.initializer !== undefined && !visited.has(decl)) {
        visited.add(decl);
        walk(decl.initializer, depth + 1);
      }
      const visit = (n: ts.Node): void => {
        if (ts.isCallExpression(n)) {
          const callee = unwrap(n.expression);
          if (
            ts.isPropertyAccessExpression(callee) &&
            ts.isIdentifier(unwrap(callee.expression)) &&
            (unwrap(callee.expression) as ts.Identifier).text === x.text
          ) {
            info.calls.push({ method: callee.name.text, args: n.arguments });
          }
        }
        ts.forEachChild(n, visit);
      };
      const scope: ts.Node = enclosingFunction(x) ?? ctx.sf;
      visit(scope);
      return;
    }
    if (ts.isPropertyAccessExpression(x)) {
      // `this.db`, `ctx.sc` — the receiver of a `.from()` we already recorded.
      return;
    }
  };
  // Start at the RECEIVER of the filter call — `db.from("t").select(…)` for a
  // `…gte(…)` — not at the `….gte` property access itself.
  const head = unwrap(call.expression);
  if (ts.isPropertyAccessExpression(head)) walk(head.expression, 0);
  return info;
}

/** Does the chain pin the read to a particular entity, so the window is not what selects? */
export function entityPredicate(info: ChainInfo, ctx: Ctx): string | null {
  for (const c of info.calls) {
    if (c.method === "or") {
      const arg = c.args[0];
      if (arg !== undefined && ts.isTemplateExpression(arg)) {
        // `expires_at.is.null,expires_at.gt.${now}` is a time predicate, not an
        // entity one; anything else interpolated is treated as an entity pin.
        const text = arg.getText(ctx.sf);
        if (!/\.(gt|gte|lt|lte|is)\./.test(text)) return `or(${text.slice(0, 40)})`;
      }
      continue;
    }
    if (c.method === "filter") {
      const col = c.args[0];
      const op = c.args[1];
      const val = c.args[2];
      if (op !== undefined && ts.isStringLiteralLike(op) && LOWER_BOUND_METHODS.has(op.text)) continue;
      if (val !== undefined && provenance(val, ctx).cls !== "const") {
        return `filter(${col !== undefined && ts.isStringLiteralLike(col) ? col.text : "?"})`;
      }
      continue;
    }
    if (!ENTITY_METHODS.has(c.method)) continue;
    const col = c.args[0];
    const val = c.args[1];
    if (val === undefined) continue;
    if (provenance(val, ctx).cls === "const") continue;
    return `${c.method}(${col !== undefined && ts.isStringLiteralLike(col) ? col.text : "?"})`;
  }
  return null;
}

// ── Sites ─────────────────────────────────────────────────────────────────

/**
 * Column names that denote an instant. A lower bound is only a TIME window if
 * its column is one of these or its bound traces back to the clock; otherwise
 * it is a cursor, a bounding box or an id range (`\.gte("lat", …)`,
 * `\.gt("id", cursor)`) and not this check's business.
 *
 * THE LIMIT THIS LEAVES: a timestamp column with a name no pattern here
 * matches, filtered by a bound this checker cannot trace to the clock, is
 * invisible. The clock-trace half is what makes that narrow — a window really
 * built from `Date.now()` is in scope whatever its column is called.
 */
export const TEMPORAL_COLUMN =
  /(^|_)(at|date|time|ts|timestamp|bucket|since|until|day|week|month|expiry|expires|deadline)$|^(created|updated|deleted|expires|starts|ends|start|end|last|first|next|prev|observed|occurred|served|sent|seen|read|published|computed|corrected|edited|viewed|saved|checked)_/i;

export function isTemporalColumn(column: string): boolean {
  return TEMPORAL_COLUMN.test(column);
}

export type Verdict = "not-time" | "absolute" | "watermarked" | "entity-scoped" | "wider-than-gap" | "bare" | "unresolved";

export interface Site {
  /** Path relative to src/. */
  file: string;
  line: number;
  fn: string;
  table: string;
  method: string;
  column: string;
  key: string;
  verdict: Verdict;
  provenance: Prov;
  widthMs: number | null;
  entity: string | null;
  excerpt: string;
}

function enclosingName(n: ts.Node): string {
  let fnName: string | null = null;
  let className: string | null = null;
  let cur: ts.Node | undefined = n;
  while (cur !== undefined) {
    if (fnName === null) {
      if (ts.isFunctionDeclaration(cur) && cur.name !== undefined) fnName = cur.name.text;
      else if (ts.isMethodDeclaration(cur) && (ts.isIdentifier(cur.name) || ts.isStringLiteralLike(cur.name))) fnName = cur.name.text;
      else if (
        (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) &&
        cur.parent !== undefined &&
        ts.isVariableDeclaration(cur.parent) &&
        ts.isIdentifier(cur.parent.name)
      ) {
        fnName = cur.parent.name.text;
      }
    }
    if (className === null && (ts.isClassDeclaration(cur) || ts.isClassExpression(cur)) && cur.name !== undefined) {
      className = cur.name.text;
    }
    cur = cur.parent;
  }
  if (fnName === null) return "<module>";
  return className === null ? fnName : `${className}#${fnName}`;
}

/** `col.gte.<expr>` inside an `.or("…")` template, as (column, value) pairs. */
function orLowerBounds(call: ts.CallExpression): Array<{ column: string; value: ts.Expression }> {
  const out: Array<{ column: string; value: ts.Expression }> = [];
  const arg = call.arguments[0];
  if (arg === undefined || !ts.isTemplateExpression(arg)) return out;
  // Each span's preceding literal ends with `<col>.gt.` / `<col>.gte.` when the
  // substitution is that filter's value.
  let head = arg.head.text;
  for (const span of arg.templateSpans) {
    const m = /([A-Za-z_][A-Za-z0-9_]*)\.(gte?)\.$/.exec(head);
    if (m !== null) out.push({ column: m[1]!, value: span.expression });
    head = span.literal.text;
  }
  return out;
}

const SQL_RELATIVE_LOWER =
  /\b([A-Za-z_][A-Za-z0-9_.]*)\s*(?:>=|>)\s*(?:now\(\)|current_timestamp)\s*-\s*(?:interval\s*'[^']*'|'[^']*'::\s*interval)/gi;

/**
 * Every lower-bound time filter in one file. `text` is accepted so a test can
 * drive this over a snippet instead of the tree.
 */
export function sitesIn(relPath: string, text: string): Site[] {
  const sf = parseFile(relPath, text);
  const ctx: Ctx = { sf, path: join(SRC_ROOT, relPath), seen: new Set<ts.Node>() };
  const out: Site[] = [];
  const seenKeys = new Map<string, number>();

  const push = (
    node: ts.Node,
    table: string,
    method: string,
    column: string,
    value: ts.Expression,
    chain: ChainInfo | null,
  ): void => {
    ctx.seen = new Set<ts.Node>();
    const prov = provenance(value, ctx);
    ctx.seen = new Set<ts.Node>();
    const width = windowWidthMs(value, ctx);
    ctx.seen = new Set<ts.Node>();
    const entity = chain === null ? null : entityPredicate(chain, ctx);
    const fn = enclosingName(node);
    const base = `${relPath}::${fn}::${table}.${method}("${column}")`;
    const n = (seenKeys.get(base) ?? 0) + 1;
    seenKeys.set(base, n);
    const key = n === 1 ? base : `${base}#${n}`;

    let verdict: Verdict;
    const clockDerived = prov.cls === "relative" || prov.cls === "watermark" || prov.cls === "now";
    if (!isTemporalColumn(column) && !clockDerived) verdict = "not-time";
    else if (prov.cls === "now" || prov.cls === "const") verdict = "absolute";
    else if (prov.cls === "watermark") verdict = "watermarked";
    else if (entity !== null) verdict = "entity-scoped";
    else if (width !== null && width >= PLAUSIBLE_GAP_MS) verdict = "wider-than-gap";
    else verdict = prov.cls === "relative" ? "bare" : "unresolved";

    out.push({
      file: relPath,
      line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      fn,
      table,
      method,
      column,
      key,
      verdict,
      provenance: prov,
      widthMs: width,
      entity,
      excerpt: node.getText(sf).replace(/\s+/g, " ").slice(0, 140),
    });
  };

  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const callee = unwrap(n.expression);
      if (ts.isPropertyAccessExpression(callee)) {
        const m = callee.name.text;
        if (LOWER_BOUND_METHODS.has(m) && n.arguments.length === 2 && ts.isStringLiteralLike(n.arguments[0]!)) {
          const chain = chainOf(n, ctx);
          if (chain.sawFrom) {
            push(n, chain.table ?? "<unknown table>", m, (n.arguments[0] as ts.StringLiteralLike).text, n.arguments[1]!, chain);
          }
        } else if (
          m === "filter" &&
          n.arguments.length === 3 &&
          ts.isStringLiteralLike(n.arguments[0]!) &&
          ts.isStringLiteralLike(n.arguments[1]!) &&
          LOWER_BOUND_METHODS.has((n.arguments[1] as ts.StringLiteralLike).text)
        ) {
          const chain = chainOf(n, ctx);
          if (chain.sawFrom) {
            push(n, chain.table ?? "<unknown table>", "filter", (n.arguments[0] as ts.StringLiteralLike).text, n.arguments[2]!, chain);
          }
        } else if (m === "or") {
          const bounds = orLowerBounds(n);
          if (bounds.length > 0) {
            const chain = chainOf(n, ctx);
            if (chain.sawFrom) {
              for (const b of bounds) push(n, chain.table ?? "<unknown table>", "or", b.column, b.value, chain);
            }
          }
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);

  // SQL spelled out in a string: `created_at > now() - interval '1 hour'`.
  // There is none in the tree today; the channel is closed so that adding one
  // is a failure rather than a blind spot.
  for (const m of text.matchAll(SQL_RELATIVE_LOWER)) {
    const line = text.slice(0, m.index).split("\n").length;
    const column = m[1]!;
    const key = `${relPath}::<sql>::<sql text>.sql("${column}")`;
    out.push({
      file: relPath,
      line,
      fn: "<sql>",
      table: "<sql text>",
      method: "sql",
      column,
      key,
      verdict: "bare",
      provenance: { cls: "relative", why: "now() - interval in SQL text" },
      widthMs: null,
      entity: null,
      excerpt: m[0].replace(/\s+/g, " ").slice(0, 140),
    });
  }
  return out;
}

// ── Scan and verdict ──────────────────────────────────────────────────────

export interface Scan {
  tree: Tree;
  sites: readonly Site[];
  parseFailures: readonly string[];
}

export function scanTree(root: string = SRC_ROOT): Scan {
  const tree = readTree(root);
  const sites: Site[] = [];
  const parseFailures: string[] = [];
  for (const file of [...tree.reachable].sort()) {
    const rel = relative(root, file);
    try {
      sites.push(...sitesIn(rel, readFileSync(file, "utf8")));
    } catch (err) {
      parseFailures.push(`${rel}: ${(err as Error).message}`);
    }
  }
  return { tree, sites, parseFailures };
}

export interface AllowVerdict {
  violations: Site[];
  governed: Site[];
  ledgered: Site[];
  /** Entries whose site no longer exists. */
  stale: string[];
  /** Entries with no usable reason, or a known_defect with no direction label. */
  unjustified: string[];
  /** The same key twice. */
  duplicated: string[];
}

/**
 * Does the file still contain this text? Injectable so a test can drive
 * `applyAllowlist` without the tree.
 */
export let fileHolds: (relPath: string, needle: string) => boolean = (relPath, needle) => {
  try {
    return readFileSync(join(SRC_ROOT, relPath), "utf8").includes(needle);
  } catch {
    return false;
  }
};

/** Test seam: replace the `requires` reader. Returns the previous one. */
export function setFileHolds(next: (relPath: string, needle: string) => boolean): (relPath: string, needle: string) => boolean {
  const prev = fileHolds;
  fileHolds = next;
  return prev;
}

export function applyAllowlist(sites: readonly Site[], allowlist: readonly AllowEntry[]): AllowVerdict {
  const v: AllowVerdict = { violations: [], governed: [], ledgered: [], stale: [], unjustified: [], duplicated: [] };
  const byKey = new Map<string, AllowEntry>();
  for (const e of allowlist) {
    if (byKey.has(e.key)) v.duplicated.push(e.key);
    else byKey.set(e.key, e);
    const reason = e.reason.trim();
    const labelled = e.kind === "known_defect" ? DEFECT_LABELS.some((l) => reason.startsWith(l)) : true;
    if (reason.length < MIN_REASON_CHARS || !labelled) v.unjustified.push(e.key);
  }
  // An entry is STALE unless its site still FAILS. A site that is now
  // watermarked, absolute, entity-scoped or out of scope needs no entry, and
  // leaving one behind is how an allowlist stops describing the code.
  const failing = new Map(sites.filter((s) => s.verdict === "bare" || s.verdict === "unresolved").map((s) => [s.key, s]));
  for (const [key, entry] of byKey) {
    const site = failing.get(key);
    if (site === undefined) {
      v.stale.push(key);
      continue;
    }
    for (const needle of entry.requires ?? []) {
      if (!fileHolds(site.file, needle)) {
        v.unjustified.push(`${key} (its reason requires \`${needle}\` in ${site.file}, which is no longer there)`);
      }
    }
  }

  for (const s of sites) {
    if (s.verdict !== "bare" && s.verdict !== "unresolved") continue;
    const e = byKey.get(s.key);
    if (e === undefined || v.unjustified.some((u) => u === e.key || u.startsWith(`${e.key} (`))) v.violations.push(s);
    else if (e.kind === "governed") v.governed.push(s);
    else v.ledgered.push(s);
  }
  return v;
}

function hours(ms: number | null): string {
  if (ms === null) return "width could not be established";
  if (ms < 0) return `lower bound ${(-ms / HOUR_MS).toFixed(2)}h in the FUTURE (a forward band, which moves past a row exactly as a backward window does)`;
  return `${(ms / HOUR_MS).toFixed(ms % HOUR_MS === 0 ? 0 : 2)}h window`;
}

// ── CLI ───────────────────────────────────────────────────────────────────

export function main(argv: readonly string[]): number {
  const print = argv.includes("--print");
  const json = argv.includes("--json");

  let scan: Scan;
  try {
    scan = scanTree();
  } catch (err) {
    console.error(`check:scheduler-relative-windows: cannot read the tree: ${(err as Error).message}`);
    console.log("RESULT unreadable");
    return 2;
  }
  if (scan.parseFailures.length > 0) {
    for (const f of scan.parseFailures) console.error(`::error::unparseable: ${f}`);
    console.log("RESULT unreadable");
    return 2;
  }

  const verdict = applyAllowlist(scan.sites, ALLOWLIST);
  const count = (v: Verdict): number => scan.sites.filter((s) => s.verdict === v).length;
  const problems: string[] = [];

  // Vacuity. A guard that scans nothing and prints green is the trap.
  if (scan.tree.files.length === 0) problems.push("scanned ZERO source files — the root is wrong or the tree moved");
  if (scan.tree.owners.size === 0) problems.push("resolved ZERO start…() owners — reachability is empty, so nothing was judged");
  if (scan.tree.ownerless.length > 0) {
    problems.push(
      `${scan.tree.ownerless.length} scheduler(s) in lib/schedulerCoverage.ts have no exporting file, so nothing they reach was scanned: ${scan.tree.ownerless.join(", ")}`,
    );
  }
  if (scan.sites.length === 0) problems.push("judged ZERO lower-bound time filters — the chain matcher is broken (vacuity)");
  if (count("watermarked") === 0) {
    problems.push(
      "found ZERO watermarked windows, but this tree has them (TrustGamingDetectionService, CompassAbuseDefenseEngine) — the watermark prover has stopped working, and every site would now read as a violation or be hidden by the allowlist",
    );
  }
  if (verdict.unjustified.length > 0) {
    problems.push(
      `${verdict.unjustified.length} allowlist entr(ies) without a usable reason (>= ${MIN_REASON_CHARS} chars; a known_defect must start with ${DEFECT_LABELS.join(" or ")}): ${verdict.unjustified.join(", ")}`,
    );
  }
  if (verdict.stale.length > 0) {
    problems.push(`${verdict.stale.length} stale allowlist entr(ies) — the site is gone, moved or renamed, so delete the entry: ${verdict.stale.join(", ")}`);
  }
  if (verdict.duplicated.length > 0) problems.push(`duplicate allowlist key(s): ${verdict.duplicated.join(", ")}`);

  const summary =
    `${scan.tree.owners.size} scheduled jobs reach ${scan.tree.reachable.size} of ${scan.tree.files.length} files; ` +
    `${scan.sites.length} lower bound(s) judged, ${count("not-time")} of them not a time bound at all: ` +
    `${count("absolute")} absolute, ${count("watermarked")} watermarked, ` +
    `${count("entity-scoped")} entity-scoped, ${count("wider-than-gap")} wider than the ${PLAUSIBLE_GAP_MS / HOUR_MS}h plausible gap ` +
    `(NOT certified safe — out of this check's scope), ${count("bare")} bare, ${count("unresolved")} unresolved; ` +
    `${verdict.governed.length} allowed as governed, ${verdict.ledgered.length} ledgered as known defects`;

  if (json) {
    console.log(JSON.stringify({ summary, sites: scan.sites, verdict, problems }, null, 2));
  } else {
    console.log(`check:scheduler-relative-windows: ${summary}.`);
    for (const s of verdict.violations) {
      const tag = s.verdict === "bare" ? "BARE RELATIVE WINDOW" : "CANNOT ESTABLISH";
      console.error(
        `::error::${tag}  ${s.file}:${s.line}  ${s.key}\n` +
          `      ${hours(s.widthMs)}; bound traced to: ${s.provenance.why}\n` +
          `      ${s.excerpt}`,
      );
    }
    if (print) {
      for (const s of verdict.governed) console.log(`  governed      ${s.file}:${s.line} ${s.key}`);
      for (const s of verdict.ledgered) console.log(`  known defect  ${s.file}:${s.line} ${s.key}`);
      for (const s of scan.sites) {
        if (s.verdict === "watermarked") console.log(`  watermarked   ${s.file}:${s.line} ${s.key} (${s.provenance.why})`);
      }
      for (const s of scan.sites) {
        if (s.verdict === "wider-than-gap") console.log(`  wide          ${s.file}:${s.line} ${s.key} (${hours(s.widthMs)})`);
      }
      for (const s of scan.sites) {
        if (s.verdict === "entity-scoped") console.log(`  entity-scoped ${s.file}:${s.line} ${s.key} (pinned by ${s.entity ?? "?"})`);
      }
    }
  }

  for (const p of problems) console.error(`::error::${p}`);

  if (verdict.violations.length > 0) {
    console.error(
      `\ncheck:scheduler-relative-windows FAILED — ${verdict.violations.length} site(s).\n` +
        "A window measured backwards from now does not self-heal across a gap: this host suspends\n" +
        "after fifteen idle minutes, and once the gap exceeds the window every row inside it is older\n" +
        "than the next pass's `since` and is examined by no later pass, ever.\n" +
        "Fix: read the span from lib/schedulerWatermark.ts (scanWindow/readWatermark/commitWatermark),\n" +
        "or make the predicate absolute (an age floor the next pass still matches). If the window is\n" +
        "genuinely not the hazard here, add the site's key to ALLOWLIST with the mechanism that covers\n" +
        "the gap; a real defect nobody is fixing today goes in as a known_defect with a LOSES-DATA: or\n" +
        "UNCLASSIFIED: note.",
    );
  }
  if (verdict.violations.length > 0 || problems.length > 0) {
    console.log("RESULT failed");
    return 1;
  }
  console.log(
    "check:scheduler-relative-windows PASSED — every lower-bound time window a scheduled job reaches is absolute,\n" +
      "  watermarked, entity-scoped, wider than the plausible gap, or named in ALLOWLIST with a reason.\n" +
      "  DOES NOT COVER: whether any job RUNS; windows inside SQL functions reached through .rpc(); windows\n" +
      "  assembled in another file than the one that filters on them; whether a `wider-than-gap` window really\n" +
      "  is wide enough; whether an entity-scoped read's entity list was itself chosen by a relative window;\n" +
      "  and — the gap most likely to matter — a window applied IN MEMORY rather than in the query, as in\n" +
      "  `rows.filter((r) => Date.parse(r.saved_at) >= nowMs - CONST)`. This check reads table-access bounds,\n" +
      "  so such a filter is invisible to it however lossy it is. lib/intelCoverageScheduler.ts:182 is the\n" +
      "  worked example and the reason this sentence exists: its PostgREST bound is 24h and allowlisted, while\n" +
      "  the predicate that actually forfeits work is a 6h in-memory filter this check never sees.",
  );
  console.log("RESULT clean");
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
