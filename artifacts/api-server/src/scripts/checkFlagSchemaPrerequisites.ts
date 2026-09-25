/**
 * check:flag-schema-prerequisites — the ratchet for the flag-TRUE /
 * schema-ABSENT defect class.
 *
 * ─── THE DEFECT ───────────────────────────────────────────────────────────────
 *
 *   feature flag TRUE in production
 *   + the code behind it names schema no migration applied to production creates
 *   + the resulting driver error swallowed
 *   = a feature that reports enabled and does nothing
 *
 * `media_canonical_enabled` sat in this state for three weeks (see
 * lib/media/mediaSchemaCapability.ts). `flagPhantomReads.test.ts` catches the
 * inverse — a read of a flag no migration seeds. Nothing caught this
 * direction. This does, for every flag the tree reads, not just Media.
 *
 * ─── HOW IT SEES PRODUCTION WITHOUT CREDENTIALS ──────────────────────────────
 *
 * The same way check:production-drift does: an operator with read access
 * captures `information_schema.columns`, `pg_proc` and `feature_flags` into
 * the dated snapshot under lib/capability/snapshots/, and this script is a
 * file-vs-file comparison against it. No socket, no environment variable, so
 * it runs in the credential-free preflight lane and cannot be starved.
 *
 * NEITHER production ledger is an inventory (read THE LEDGER CORRECTION near the
 * foot of this file), so "is migration N applied" cannot be asked there.
 *
 * ─── TWO KINDS OF ABSENT, KEPT APART ─────────────────────────────────────────
 *
 *   unapplied   the object IS declared by a migration in the tree and is NOT
 *               in production. The migration has not been applied. THIS
 *               script's class.
 *   undeclared  the object is declared by NO migration in the tree. A code
 *               bug, not a rollout gap; check:schema-references owns columns
 *               of that kind. Reported here for functions (which that check
 *               does not cover) but never counted as this class.
 *
 * ─── IT IS A RATCHET, NOT AN ALLOWLIST ───────────────────────────────────────
 *
 * KNOWN below lists every (flag, absent object) pair measured 2026-09-07, each
 * with a classification and a note. It fails in BOTH directions:
 *   - a flag ON in production over an unapplied object that is not listed,
 *     or a listed flag over an object that is not listed, FAILS: a new
 *     instance of the class;
 *   - a listed pair that is no longer in that state also FAILS, so the list
 *     cannot silently stay full after a migration lands or a flag is turned
 *     off. Strike the entry in the same change.
 * Entries classified `unguarded` MUST reach zero, by registering the flag in
 * lib/capability/registry.ts and wiring a consumer (→ `guarded`), by applying
 * the migration, or by turning the flag off.
 *
 * ─── THE FLOOR ───────────────────────────────────────────────────────────────
 *
 * The scan is a floor (see lib/capability/prerequisitesCore.ts): payloads
 * built elsewhere, dynamic table names, and columns reached through
 * variables are not seen; the count of what was skipped is printed. A green
 * run means "nothing this scan can see is in the state", never "nothing is".
 *
 * Usage (from artifacts/api-server):
 *   pnpm run check:flag-schema-prerequisites            # ratchet; exit 1 on drift
 *   pnpm run check:flag-schema-prerequisites -- --report # full listing, no verdict
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCanonicalSchema, hasColumn, isModelled, stripSqlComments } from "./lib/canonicalSchema.js";
import { compareVersions, profileVersionColumn } from "./lib/migrationInventoryCore.js";
import {
  evaluateFlags,
  evaluateRegistry,
  loadProductionSnapshot,
  scanFlagReads,
  type SchemaRef,
} from "../lib/capability/prerequisitesCore.js";
import { CAPABILITIES } from "../lib/capability/registry.js";
import { PRODUCTION_SNAPSHOT_FILENAME } from "../lib/capability/snapshots/current.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(HERE, "..", "..");
const SRC = join(API_ROOT, "src");
/**
 * The dated production snapshot. FLAG_SCHEMA_SNAPSHOT overrides it so the
 * test can aim the ratchet at an edited copy and PROVE it fails — the same
 * reason check-flag-polarity.mjs exposes FLAG_POLARITY_SRC. Setting it in CI
 * makes the check examine a different production; it is built to fail when
 * you do.
 *
 * THE SNAPSHOT IS THE EXPIRY DATE ON EVERY ANSWER THIS SCRIPT GIVES. It is a
 * frozen copy, so the moment production moves, this check starts grading a
 * database that no longer exists — and it does so SILENTLY, in whichever
 * direction the drift happens to fall. On 2026-09-08 eighteen migrations had
 * been applied to production against a snapshot captured on 09-07, which had
 * turned several KNOWN entries into descriptions of an already-fixed world
 * while the ratchet kept reporting green.
 *
 * So: when a migration is applied to production, refresh this file in the same
 * change. Prove the refresh is COMPLETE rather than assuming it — capture the
 * per-table digest, the function list and the flag list, and check each one
 * reproduces production's own md5 over the identical construction. A partial
 * refresh is worse than a stale one, because it looks current.
 */
const SNAPSHOT = process.env.FLAG_SCHEMA_SNAPSHOT
  ? resolve(process.env.FLAG_SCHEMA_SNAPSHOT)
  // REPOINTED 2026-09-16, for the second time and for the same reason: five
  // migrations (2297, 2894, 2995, 2989, 2984) reached production that morning,
  // production-applied-migrations.json ran ahead of the 09-15 watermark, and the
  // tripwire fired. The replacement is a FULL re-read whose three checksums
  // production recomputed independently and agreed with.
  //
  // The 09-16 capture also found four tables, five functions, a column and three
  // flags in production that THIS REPOSITORY DOES NOT DECLARE, applied outside
  // its migration chain at 07:56 UTC. They are carried in the snapshot because a
  // snapshot that hid them would misdescribe production; read that file's
  // $comment for what they are and why they are inert rather than resolved.
  : join(SRC, "lib", "capability", "snapshots", PRODUCTION_SNAPSHOT_FILENAME);
/**
 * The repository's record of what has been applied to PRODUCTION. See the file's
 * own $comment. FLAG_SCHEMA_APPLIED overrides it for the staleness test.
 */
const APPLIED_MIGRATIONS = process.env.FLAG_SCHEMA_APPLIED
  ? resolve(process.env.FLAG_SCHEMA_APPLIED)
  : join(SRC, "lib", "capability", "production-applied-migrations.json");

/**
 * THE STALE-SNAPSHOT TRIPWIRE.
 *
 * On 2026-09-08 this script reported GREEN while grading a snapshot captured
 * before eighteen migrations had been applied. Four of its KNOWN entries
 * described defects that no longer existed and it could not tell. A frozen
 * snapshot has no way to notice that the world moved underneath it, so the
 * repository has to notice for it.
 *
 * Two independent failures are detected, both entirely OFFLINE — this makes no
 * live database connection and ordinary CI does not gain a production
 * dependency:
 *
 *   1. STALE. production-applied-migrations.json is the record committed
 *      alongside each apply. If its newest version is later than the snapshot's
 *      productionMigrationWatermark, a migration landed after the capture and
 *      every answer below is suspect.
 *
 *   2. HAND-EDITED / PARTIALLY REFRESHED. The snapshot carries checksums of its
 *      own tables, functions and flags. They are RECOMPUTED here and compared.
 *      A partial refresh is more dangerous than a stale one, because it looks
 *      current; this is what makes the file's "do not edit by hand" enforceable
 *      rather than advisory.
 *
 * REFRESH PROCEDURE (documented here because a guard that fails without saying
 * how to fix it just gets disabled):
 *
 *   npm run refresh:production-snapshot     # see scripts/refresh-production-snapshot.md
 *
 * A snapshot with neither field is treated as legacy and only WARNS, so an old
 * capture does not hard-fail a checkout that has not been refreshed yet.
 */
function checkSnapshotFreshness(snapshotPath: string): string[] {
  const problems: string[] = [];
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(snapshotPath, "utf8"));
  } catch (e) {
    return [`snapshot ${snapshotPath} is not readable JSON: ${String(e)}`];
  }

  // ── 1. checksum self-consistency ──────────────────────────────────────────
  if (raw.checksums) {
    const tables: Record<string, string[]> = raw.tables ?? {};
    const per = Object.keys(tables)
      .sort()
      .map((t) => `${t}:${createHash("md5").update((tables[t] ?? []).join(",")).digest("hex")}`)
      .join("\n");
    const tablesSum = createHash("md5").update(per).digest("hex");
    const fnSum = createHash("md5").update([...(raw.functions ?? [])].sort().join(",")).digest("hex");
    const flags: Record<string, boolean> = raw.flags ?? {};
    const flagSum = createHash("md5")
      .update(Object.keys(flags).sort().map((f) => `${f}=${flags[f] ? "true" : "false"}`).join(","))
      .digest("hex");

    if (tablesSum !== raw.checksums.tables) {
      problems.push(
        `SNAPSHOT CHECKSUM MISMATCH (tables): recorded ${raw.checksums.tables}, recomputed ${tablesSum}. ` +
          `The snapshot was edited by hand or refreshed only partially — a partial refresh is worse than a stale one because it looks current.`,
      );
    }
    if (fnSum !== raw.checksums.functions) {
      problems.push(`SNAPSHOT CHECKSUM MISMATCH (functions): recorded ${raw.checksums.functions}, recomputed ${fnSum}.`);
    }
    if (flagSum !== raw.checksums.flags) {
      problems.push(`SNAPSHOT CHECKSUM MISMATCH (flags): recorded ${raw.checksums.flags}, recomputed ${flagSum}.`);
    }
  } else {
    console.log("  (legacy snapshot: no checksums recorded — cannot verify it was not hand-edited)");
  }

  // ── 2. staleness against the repository's own record of production ────────
  const watermark: string | undefined = raw.productionMigrationWatermark;
  if (!watermark) {
    console.log("  (legacy snapshot: no productionMigrationWatermark — cannot detect staleness)");
    return problems;
  }
  if (!existsSync(APPLIED_MIGRATIONS)) {
    problems.push(`production-applied-migrations.json missing at ${APPLIED_MIGRATIONS}; staleness cannot be checked.`);
    return problems;
  }
  let applied: any;
  try {
    applied = JSON.parse(readFileSync(APPLIED_MIGRATIONS, "utf8"));
  } catch (e) {
    return [...problems, `production-applied-migrations.json is not readable JSON: ${String(e)}`];
  }
  const versions: string[] = (applied.migrations ?? [])
    .map((m: any) => String(m?.version ?? ""))
    .filter(Boolean);
  if (versions.length === 0) {
    problems.push("production-applied-migrations.json lists no migrations; the tripwire would never fire.");
    return problems;
  }
  // entriesAfterWatermark() is at the foot of this file. It never compares two
  // version strings of different formats, it reports a mixed column as its own
  // problem, and an entry it cannot place is treated as NEWER rather than
  // dropped — fail closed, not quiet.
  const late = entriesAfterWatermark(applied.migrations ?? [], watermark, problems);
  if (late.length > 0) {
    problems.push(
      `STALE SNAPSHOT: ${late.length} migration(s) recorded as applied to production AFTER this snapshot ` +
        `was captured (watermark ${watermark}): ${late.join(", ")}. Every answer below is graded against ` +
        `a production that no longer exists. ` +
        `Refresh: see artifacts/api-server/scripts/refresh-production-snapshot.md`,
    );
  }
  return problems;
}

const BASELINE = join(API_ROOT, "baseline", "20260819_baseline_structure.sql");
const MIGRATION_DIRS = [join(API_ROOT, "migrations"), join(SRC, "migrations")];
const REPORT = process.argv.includes("--report");

type Known = {
  classification: "unguarded" | "guarded";
  /** Every absent, migration-declared object charged to this flag. */
  objects: string[];
  /** Who owns the consumer that must be wired, and why it is in this state. */
  note: string;
};

/**
 * Measured 2026-09-08 against snapshot 20260908-production-schema.json.
 * `objects` are `table`, `table.column` or `fn()`.
 *
 * NINE ENTRIES WERE RETIRED ON 2026-09-08 by applying the migration rather than
 * by editing the list, which is the only honest way to shrink it. In every case
 * the ratchet reported the entry STALE first; none was removed on judgement:
 *
 *   intel_claim_projection_crowd  2120 + 2273 + 2274 + 2275 + 2430
 *   intel_limited_live            2275 + 2430
 *   intel_live_label_crowd        2275 + 2430
 *   intel_capture_quick_signal    2274 + 2276 + 2430
 *   safe_return_enabled           2219
 *   intel_trail_followup          2274 + 2276
 *
 * and earlier the same day:
 *
 *   trust_engine_enabled          2371 — trust_profiles.evidence_weight/_count now exist
 *   layover_plans_enabled         2420 — trip_kernel_execute() now exists
 *   airport_mode_enabled          2410 + 2420 — rec_key and the kernel fn now exist
 *   layover_safety_engine_enabled 2410 — layover_recommendations.rec_key now exists
 *   hidden_gems_enabled           2420 — trip_kernel_execute() struck from its objects;
 *                                 the entry REMAINS because hidden_gem_contributions
 *                                 (2252) is still absent in production.
 *
 * What that does and does not mean. It closes the SCHEMA half of
 * `capability = FLAG_ENABLED && SCHEMA_CAPABILITY_READY`: these flags are no
 * longer ON over a database that cannot answer them. It does NOT mean the
 * features run. The branch carrying their code is unmerged, and the layover
 * upsert path is behind `layover_stable_recommendation_ids_enabled`, seeded
 * FALSE by 2410 — so nothing a traveller sees has changed.
 *
 * These five were only visible because the snapshot was refreshed in the same
 * change. Against the 09-07 capture the ratchet reported green while four of
 * its entries described defects that no longer existed.
 */
/**
 * EXPORTED so a test can derive its fixture from this map instead of hardcoding a
 * flag name. The STALE case in flagSchemaPrerequisites.test.ts has now outlived
 * its subject TWICE — first `trust_engine_enabled` when 2371 landed, then
 * `media_canonical_enabled` when 2470 landed on 2026-09-16 — because each time it
 * named a real entry, and resolving an entry is exactly what this file is for.
 * A test that breaks every time the thing it guards succeeds is a maintenance
 * trap, so the fixture now reads whichever entry happens to exist.
 */
export const KNOWN: Record<string, Known> = {
  // ── STRUCK OFF 2026-09-20: COMPASS_ENABLED ─────────────────────────────────
  //
  // The entry's own note said "Strike the 2996 objects when 2996 is applied to
  // production and recorded; the trails objects when 2910 is." Both were applied
  // on 2026-09-20 — 2996 at 19:46:26 UTC, 2997 at 19:49:28, 2910 at 19:56:45,
  // each with a schema_migration_ledger row and each rehearsed on production in a
  // rolled-back transaction first. Against snapshots/20260920-production-schema.json
  // none of the twelve objects is absent any more, so the ratchet reported
  // "STALE: KNOWN.COMPASS_ENABLED is no longer in the state" and the entry is
  // struck here rather than rewritten or narrowed. That rule is the reason a
  // resolved exemption cannot quietly outlive its cause; honouring it is the
  // point rather than an inconvenience, and it is the only honest way this list
  // shrinks.
  //
  // WHAT IT RECORDED, kept because the history is the useful part. Production had
  // COMPASS_ENABLED TRUE while it lacked twelve objects two closures name:
  //
  //   compass_conversations.trip_id / .status            2996 (compass-phase1-spec §1)
  //   trails, trails.id/.title/.lifecycle_status         2910 (Discovery Trails)
  //   content_trails and its trail_id/source_type/       2910
  //     source_id/content_state/created_at
  //
  // Nothing broke while it stood, because both readers probe before they name:
  // services/compass/CompassConversationService.ts (conversationSchemaReady) used
  // the legacy conversation shape when the two columns were missing, and
  // services/media/MediaActionResolver.ts `compileExperiencePlan` probed `trails`
  // with the lib/capability sentinel and refused `source_unavailable` rather than
  // naming a column of a table that did not exist — which is what made the entry
  // `guarded` rather than `unguarded`. The trails objects had entered this closure
  // only on 2026-09-20, with census-compass CM-02, via the
  // `compile_plan_from_experience` tool.
  //
  // WHAT THAT CLOSES, AND WHAT IT DOES NOT. It closes the SCHEMA half of
  // `capability = FLAG_ENABLED && SCHEMA_CAPABILITY_READY` for COMPASS_ENABLED:
  // the registry line now reads "missing in production: none", so the flag is no
  // longer ON over a database that cannot answer it, and /api/v1/discovery/trails
  // no longer reads a missing relation. It does NOT mean the Trail features run:
  // 2910 created all six tables EMPTY, so a Trail plan compiles over no rows, and
  // 2997's lineage columns are still only written by the probe-guarded path.
  // Applied is not enabled.
  //
  // 2997's three columns (compass_served_recommendations.revoked_at /
  // revocation_reason, compass_outcome_events.weight_nudge) were never listed
  // here — they are named by compass/CompassOutcomeEngine.ts, reached from routes
  // no flag gates, so the ratchet never saw them under this flag. They were
  // carried in checkMissingLiveColumns' PENDING LIVE APPLY block and were struck
  // from it on the same day and for the same reason.

  // ── Guarded: the contract refuses before the failing call ───────────────────
  //
  // `media_canonical_enabled` WAS HERE, and it was THE founding case of this whole
  // file. STRUCK 2026-09-16, by this check's own instruction: once 2470 was applied
  // the state the entry described stopped existing, and the STALE rule fired —
  // "KNOWN.media_canonical_enabled is no longer in the state. Strike the entry."
  // That rule is the reason a resolved exemption cannot quietly outlive its cause,
  // so honouring it is the point rather than an inconvenience.
  //
  // What it recorded, kept because the history is the useful part: production had
  // media_canonical_enabled TRUE while media_assets lacked captured_at, provenance
  // and intelligence_eligibility, so lib/mediaAssets.ts refused before building a
  // payload (outcome `refused_schema`, error-level log) rather than issuing an
  // upsert PostgREST would reject with 42703. It reads "missing in production:
  // none" now. The owner took MEDIA_CANONICAL_FLAG as ORDER B on 2026-09-16 and
  // 2470 was applied; see snapshots/20260916d-production-schema.json for the
  // measured before/after, including that all 8 existing rows survived.

  // ── STRUCK OFF 2026-09-17: safe_return_enabled and
  //    safe_return_trusted_circle_alerts_enabled ──────────────────────────────
  //
  // Both entries said, in their own notes, "Remove once 2780/2794 are applied to
  // production (owner's Batch C)." They were applied — 2780 on 2026-09-16
  // 20:51:19 UTC and 2794 at 21:00:38, both with ledger rows — so the ratchet
  // reported them STALE on the next run and they are struck off here rather than
  // rewritten. That is the only honest way to shrink this list: the entry is
  // removed because the state it described ended, not because someone judged it
  // no longer interesting.
  //
  // WHAT THAT CLOSES, AND WHAT IT DOES NOT. It closes the SCHEMA half for these
  // two flags: production now has trip_subgroups, trip_subgroup_members and
  // safe_return_sessions.subgroup_id, so a Safe Return session CAN carry a
  // subgroup and SafeReturnNotificationService's read can resolve. It does not
  // mean the subgroup branch runs. That branch is behind
  // tripOperationalProjectionsGate, and trip_operational_projections_enabled is
  // still FALSE in production, so POST /me/safe-return/sessions still refuses
  // feature_disabled before either table is read and a solo or full-crew Safe
  // Return still runs exactly the pre-2794 code. Applied is not enabled.
  //
  // The boundary those tables enforce was exercised on portava-ci 2026-09-17
  // under a real `authenticated` role and a real auth.uid(), and it is narrower
  // than "subgroup members only": trip_subgroups and trip_subgroup_members are
  // readable by the WHOLE CREW (both policies gate on authz.is_trip_crew), so a
  // crew member outside the subgroup sees the subgroup and its membership. What
  // they do not see is the session: safe_return_sessions carries a single
  // owner-only policy (srs_own, auth.uid() = user_id) and the crew member
  // outside the subgroup read 0 rows, as did a non-member of the trip. So
  // subgroup_id on that table is metadata for the notify path, NOT a read grant,
  // and nothing about 2794 widened who can see a Safe Return session.

  // ── Added 2026-09-25: the intel contributor token, ahead of its migration ──
  //
  // Two entries, ONE object and ONE call site: intel_capture_quick_signal and
  // intel_trail_followup are the two flags that open
  // services/intel/IntelCaptureService.writeObservation (surfaceFlagEnabled), so
  // the same closure is charged to both. They are struck together.
  //
  // Placed at the END of this map on purpose: inserting above shifts the line
  // numbers census-compass.md cites into this file, and check-doc-citations
  // catches that. Keep new entries here.
  intel_capture_quick_signal: {
    classification: "unguarded",
    objects: ["intel_contributor_token()"],
    note:
      "IntelCaptureService.findReplayedObservation names public.intel_contributor_token(). " + "3002_intel_contribution_identity.sql is IN THE TREE, NOT APPLIED. It drops intel_observations.actor_id's foreign key to profiles and replaces the stored account id with a rotating contributor token (Sensing §3/§24, census S19/S118). The only code that has to know about the swap is writeObservation's idempotent-replay lookup, which reads a row back by contributor identity, and it is written for BOTH schemas: it filters on actor_id directly FIRST — the whole answer while 3002 is unapplied, because the stored actor_id IS the account id — and reaches intel_contributor_token() only when that finds nothing, which cannot happen before the apply. So the absent function is named on a branch production never executes; and were it ever reached, the call is wrapped so an unavailable RPC yields a retryable db_error, never a crash and never a dedup that was not verified. STRIKE THIS ENTRY when 3002 is applied and recorded in the migration ledger — the ratchet will report it STALE first.",
  },
  intel_trail_followup: {
    classification: "unguarded",
    objects: ["intel_contributor_token()"],
    note:
      "Same object, same call site: the trail surface shares writeObservation. " + "3002_intel_contribution_identity.sql is IN THE TREE, NOT APPLIED. It drops intel_observations.actor_id's foreign key to profiles and replaces the stored account id with a rotating contributor token (Sensing §3/§24, census S19/S118). The only code that has to know about the swap is writeObservation's idempotent-replay lookup, which reads a row back by contributor identity, and it is written for BOTH schemas: it filters on actor_id directly FIRST — the whole answer while 3002 is unapplied, because the stored actor_id IS the account id — and reaches intel_contributor_token() only when that finds nothing, which cannot happen before the apply. So the absent function is named on a branch production never executes; and were it ever reached, the call is wrapped so an unavailable RPC yields a retryable db_error, never a crash and never a dedup that was not verified. STRIKE THIS ENTRY when 3002 is applied and recorded in the migration ledger — the ratchet will report it STALE first.",
  },
};

// ── Declared-by-a-migration ──────────────────────────────────────────────────

function listSql(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".sql")).map((f) => join(dir, f));
}

/** Functions any migration or the baseline creates: `CREATE [OR REPLACE] FUNCTION [public.]name(`. */
function declaredFunctions(): Set<string> {
  const out = new Set<string>();
  const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\(/gi;
  const files = [BASELINE, ...MIGRATION_DIRS.flatMap(listSql)];
  for (const f of files) {
    if (!existsSync(f)) continue;
    const sql = stripSqlComments(readFileSync(f, "utf8"));
    for (const m of sql.matchAll(re)) out.add(m[1]!);
  }
  return out;
}

/**
 * WHY THIS SETS `process.exitCode` AND RETURNS RATHER THAN CALLING `process.exit`.
 *
 * Node's stdout and stderr are ASYNCHRONOUS when they are pipes, which is what
 * they are whenever this script is run by another process rather than by a
 * human — `spawnSync` in src/test/flagSchemaPrerequisites.test.ts, and every CI
 * step that captures output. `process.exit()` does not wait for a queued write,
 * so the last thing written before it can simply never arrive. What is written
 * last here is the FAIL block: the list of problems, which is the entire point
 * of the run.
 *
 * That is not a theory. Six runs of this script under CPU load, spawned with
 * pipes exactly as the test spawns it: four returned 27,662 bytes and the FAIL
 * block; two returned 20,695 and 21,546 bytes with the block missing — and all
 * six exited 1. A reader who trusts the exit code sees a failure with no
 * reason attached; a reader who greps the output sees a clean run. The test
 * that greps for a specific failure line went red on CI for exactly this, while
 * passing in isolation, which is what "flaky" turned out to mean.
 *
 * Setting `exitCode` lets main() return, the event loop drain, and Node exit on
 * its own once the writes have landed. The exit code is identical.
 */
function main(): void {
  const started = Date.now();
  if (!existsSync(SNAPSHOT)) {
    console.error(`check:flag-schema-prerequisites: snapshot missing at ${SNAPSHOT}.`);
    process.exitCode = 2;
    return;
  }
  const freshness = checkSnapshotFreshness(SNAPSHOT);
  if (freshness.length) {
    console.error(`\ncheck:flag-schema-prerequisites: the snapshot cannot be trusted:`);
    for (const f of freshness) console.error(`  • ${f}`);
    console.error("");
    process.exitCode = 1;
    return;
  }
  const snap = loadProductionSnapshot(SNAPSHOT);
  const canon = buildCanonicalSchema(BASELINE, MIGRATION_DIRS);
  const fns = declaredFunctions();
  const declares = {
    table: (t: string) => canon.columns.has(t),
    column: (t: string, c: string) => hasColumn(canon, t, c),
    fn: (n: string) => fns.has(n),
  };
  const declared = (ref: SchemaRef): boolean =>
    ref.kind === "function" ? declares.fn(ref.name)
      : ref.kind === "table" ? declares.table(ref.name)
        : (isModelled(canon, ref.table!) ? hasColumn(canon, ref.table!, ref.name) : declares.table(ref.table!));

  const scan = scanFlagReads(SRC);
  const findings = evaluateFlags(scan, snap, CAPABILITIES);
  const registry = evaluateRegistry(CAPABILITIES, snap, scan, declares, (rel) => {
    const p = join(SRC, rel);
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  });

  const failures: string[] = [];
  const fail = (m: string) => failures.push(m);

  // ── Vacuity ───────────────────────────────────────────────────────────────
  if (snap.tables.size < 300) fail(`VACUOUS: snapshot has ${snap.tables.size} tables; production has >400. Wrong file?`);
  if (snap.flags.size < 100) fail(`VACUOUS: snapshot has ${snap.flags.size} flag rows; production has >150.`);
  if (scan.reads.length < 100) fail(`VACUOUS: only ${scan.reads.length} flag reads found under ${SRC}; the tree has hundreds.`);
  const refsSeen = scan.reads.reduce((n, r) => n + r.refs.length, 0);
  if (refsSeen < 500) fail(`VACUOUS: only ${refsSeen} schema references collected across all closures.`);
  const ageDays = (Date.now() - Date.parse(snap.capturedAt)) / 86_400_000;

  console.log(
    `check:flag-schema-prerequisites\n` +
      `  snapshot   ${snap.projectRef} captured ${snap.capturedAt} (${ageDays.toFixed(0)} days ago): ` +
      `${snap.tables.size} relations, ${snap.functions.size} functions, ${snap.flags.size} flag rows (${[...snap.flags.values()].filter(Boolean).length} on)\n` +
      `  canonical  ${canon.columns.size} tables from baseline + ${canon.sources.migrationFiles} migration files; ${fns.size} declared functions\n` +
      `  scan       ${scan.filesScanned} files, ${scan.reads.length} flag reads over ${findings.length} flags, ${refsSeen} refs; ` +
      `${scan.unresolvedReads.length} reads with an unresolvable flag argument`,
  );
  if (ageDays > 45) console.log(`  WARNING    snapshot is ${ageDays.toFixed(0)} days old; refresh it (see docs/architecture/flag-schema-capability.md)`);

  // ── Split each finding's absent objects into unapplied / undeclared ───────
  const rows = findings.map((f) => ({
    f,
    unapplied: f.missing.filter(declared),
    undeclared: f.missing.filter((m) => !declared(m)),
  }));

  const print = (title: string, list: typeof rows, detail: boolean) => {
    if (!list.length) return;
    console.log(`\n${title}`);
    for (const { f, unapplied, undeclared } of list) {
      const objs = [...new Set(unapplied.map((m) => m.key.split(".")[0]!.replace(/\(\)$/, "()")))];
      console.log(
        `  ${f.flag}  [production: ${f.production}]  ${f.reads.length} read(s), ${f.refCount} refs, ${f.unresolved} unresolved` +
          (detail ? "" : `  → ${unapplied.length} absent object(s) in ${objs.join(", ")}`),
      );
      if (!detail) continue;
      for (const m of unapplied) console.log(`      ABSENT (unapplied migration)  ${m.key}  ${m.file}:${m.line}`);
      for (const m of undeclared) console.log(`      absent (undeclared anywhere)  ${m.key}  ${m.file}:${m.line}`);
      if (REPORT) for (const r of f.reads) console.log(`      read ${r.file}:${r.line} (${r.reader})`);
    }
  };

  const isClass = (r: (typeof rows)[number]) => r.unapplied.length > 0 && r.f.production === "on";
  const unguarded = rows.filter((r) => isClass(r) && !r.f.registered);
  const guarded = rows.filter((r) => isClass(r) && r.f.registered);
  const latent = rows.filter((r) => r.unapplied.length > 0 && r.f.production !== "on");
  const undeclaredOnly = rows.filter((r) => r.unapplied.length === 0 && r.undeclared.length > 0);

  print(`UNGUARDED — flag ON in production, code names schema production lacks, no capability declared (${unguarded.length})`, unguarded, true);
  print(`GUARDED — same state, refused by lib/capability before the failing call (${guarded.length})`, guarded, true);
  print(`LATENT — schema absent, flag OFF or no row in production; one UPDATE away from UNGUARDED (${latent.length})`, latent, REPORT);
  if (REPORT) print(`UNDECLARED ONLY — objects no migration creates; check:schema-references territory (${undeclaredOnly.length})`, undeclaredOnly, true);

  // ── Ratchet ───────────────────────────────────────────────────────────────
  const seenFlags = new Set<string>();
  for (const r of [...unguarded, ...guarded]) {
    seenFlags.add(r.f.flag);
    const known = KNOWN[r.f.flag];
    const objs = r.unapplied.map((m) => m.key).sort();
    if (!known) {
      fail(
        `NEW INSTANCE OF THE CLASS: ${r.f.flag} is ON in production and its code names ${objs.join(", ")} which production lacks. ` +
          `Register it in lib/capability/registry.ts and wire the consumer, apply the migration, or turn the flag off — and add a KNOWN entry with a note.`,
      );
      continue;
    }
    const expected = r.f.registered ? "guarded" : "unguarded";
    if (known.classification !== expected) {
      fail(`STALE: KNOWN.${r.f.flag} is classified ${known.classification} but is now ${expected}. Update the entry.`);
    }
    const extra = objs.filter((o) => !known.objects.includes(o));
    const gone = known.objects.filter((o) => !objs.includes(o));
    if (extra.length) fail(`NEW OBJECT under ${r.f.flag}: ${extra.join(", ")} — the closure now names schema production lacks that KNOWN does not list.`);
    if (gone.length) fail(`STALE: KNOWN.${r.f.flag} lists ${gone.join(", ")} but that is no longer absent-and-referenced. Strike it.`);
  }
  for (const flag of Object.keys(KNOWN)) {
    if (!seenFlags.has(flag)) fail(`STALE: KNOWN.${flag} is no longer in the state (flag off, migration applied, or the read is gone). Strike the entry.`);
  }

  // ── Registry ──────────────────────────────────────────────────────────────
  console.log(`\nREGISTRY — ${registry.length} capability declaration(s)`);
  for (const r of registry) {
    console.log(
      `  ${r.flag}  [production: ${r.production}]  missing in production: ${r.missingInProduction.length ? r.missingInProduction.join(", ") : "none"}; ` +
        `${r.readSites} read site(s)`,
    );
    if (r.undeclared.length) fail(`REGISTRY TYPO: ${r.flag} requires ${r.undeclared.join(", ")}, which no migration in the tree declares.`);
    if (r.badConsumers.length) fail(`REGISTRY WITHOUT A CONSUMER: ${r.flag}: ${r.badConsumers.join("; ")}. A capability nobody consults guards nothing.`);
    if (r.readSites === 0) fail(`REGISTRY OVER A DEAD FLAG: ${r.flag} is registered but nothing in the tree reads it.`);
  }

  if (scan.unresolvedReads.length && REPORT) {
    console.log(`\nUNRESOLVED flag arguments (${scan.unresolvedReads.length}) — reads this scan cannot attribute:`);
    for (const u of scan.unresolvedReads) console.log(`  ${u.file}:${u.line} ${u.reader}(${u.expr})`);
  }

  console.log("");
  if (failures.length) {
    console.log(`FAIL — ${failures.length} problem(s):`);
    for (const f of failures) console.log(`  • ${f}`);
    process.exitCode = REPORT ? 0 : 1;
    return;
  }
  console.log(
    `OK — ${unguarded.length} unguarded (all known), ${guarded.length} guarded, ${latent.length} latent; ${Date.now() - started} ms.` +
      (unguarded.length ? ` ${unguarded.length} unguarded entries remain: each is a feature that is ON and dead in production.` : ""),
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// THE LEDGER CORRECTION  (2026-09-22)
// ═════════════════════════════════════════════════════════════════════════════
//
// THIS FILE'S HEADER USED TO SAY SOMETHING FALSE, and it was quoted elsewhere
// as a standing fact. It read:
//
//   "Production has NO migration ledger (no schema_migration_ledger; Supabase's
//    own schema_migrations stops at 2272)"
//
// Both halves are wrong, and the second half is a TRAP rather than a stale
// reading. Measured read-only on production (ajrurzioarfkagpuxfnb) 2026-09-22:
//
//   public.schema_migration_ledger          EXISTS, created 2026-09-15, 465 rows,
//                                           20 with a 4-digit serial >= 2890
//   supabase_migrations.schema_migrations   103 rows, 96 of them post-cutover
//                                           14-digit timestamps
//   max(version) on that table              '2272'
//
// It does not "stop at 2272". Its MAXIMUM IS '2272' because that one text column
// holds bare serials AND 14-digit timestamps, and text order sorts every
// timestamp below a four-digit serial. The number was read correctly and meant
// something else. src/scripts/lib/migrationInventoryCore.ts carries the full
// reproduction, and src/scripts/reportMigrationInventory.ts is the instrument
// for the question this script deliberately does not ask.
//
// WHAT REMAINS TRUE, and is why this script still grades a frozen snapshot
// rather than reading a ledger: NEITHER TABLE IS AN INVENTORY. A Supabase
// dashboard apply writes no row in either; the CLI writes only
// supabase_migrations; this repository's own discipline writes only
// schema_migration_ledger; and 378 of the hand ledger's 465 rows are 'backfill'
// rows that assert a filename existed when 2254 ran and never that it ran. So
// "is migration N applied" still cannot be asked of production. "Does column X
// exist" can, and that is the question that matters here.

/**
 * Every recorded apply that is NEWER than the snapshot's watermark — the
 * staleness question — answered without ever comparing two version strings of
 * different formats.
 *
 * WHAT THIS REPLACED, AND WHY. The staleness test used to read:
 *
 *   // Versions are zero-padded timestamps, so lexicographic order IS chronological.
 *   const newest = versions.reduce((a, b) => (b > a ? b : a));
 *   if (newest > watermark) { … }
 *
 * True of production-applied-migrations.json TODAY — all 126 entries are
 * 14-digit — and enforced nowhere, while that file is documented as being taken
 * FROM supabase_migrations.schema_migrations, which is the column that is NOT
 * single-format. On production that column's maximum is '2272', a pre-cutover
 * serial that sorts above every 14-digit timestamp. One hand-added serial entry
 * here and `newest` silently becomes a number from before the cutover, the
 * comparison can never fire, and the tripwire goes quiet WITHOUT EVER FAILING —
 * which is the failure mode this check was written against, reproduced inside
 * the check itself.
 *
 * THREE RULES, and each one is strictly stricter than the line above:
 *
 *   1. A version of the SAME format as the watermark is compared to it, which
 *      is safe: both are fixed-width zero-padded digits, so text order is
 *      chronological WITHIN a format. compareVersions() is what establishes
 *      that they share a format; it refuses rather than guessing.
 *   2. A version of a DIFFERENT format, or one of no recognised format, CANNOT
 *      be placed relative to the watermark. It is counted as LATE anyway and
 *      named in its own problem. Fail closed: an entry whose position is
 *      unknown might be after the capture, and the cost of assuming it is not
 *      is a snapshot silently graded against a production that moved.
 *   3. profileVersionColumn() reports a mixed column as its own problem, so the
 *      state that hides defect (1) is visible even on a run where nothing is
 *      late.
 *
 * Nothing here can pass what the old line failed: every version the old
 * comparison would have called late is either the same format (rule 1, still
 * late) or a different one (rule 2, late by default).
 */
function entriesAfterWatermark(
  migrations: readonly { version?: unknown; name?: unknown }[],
  watermark: string,
  problems: string[],
): string[] {
  const late: string[] = [];
  const unplaceable: string[] = [];

  for (const m of migrations) {
    const version = String(m?.version ?? "");
    if (version === "") continue;
    const label = `${version} ${String(m?.name ?? "")}`.trim();
    const cmp = compareVersions(version, watermark);
    if (!cmp.ok) {
      unplaceable.push(label);
      late.push(label);
      continue;
    }
    if (cmp.value > 0) late.push(label);
  }

  if (unplaceable.length > 0) {
    problems.push(
      `${unplaceable.length} entr(y/ies) in production-applied-migrations.json carry a version that cannot ` +
        `be ordered against the snapshot watermark ${watermark}: ${unplaceable.join(", ")}. They are counted ` +
        "as LATE rather than ignored, because an entry whose position is unknown might be after the capture " +
        "and a tripwire that assumes otherwise is the defect this check exists to catch.",
    );
  }

  // The shape of the column itself, reported even when nothing is late, so the
  // state that would hide a stale snapshot is visible before it hides one.
  const profile = profileVersionColumn(
    migrations.map((m) => String(m?.version ?? "")).filter(Boolean),
  );
  if (profile.mixed) {
    problems.push(
      "production-applied-migrations.json mixes version formats (" +
        profile.formats.map((f) => `${f}=${profile.counts[f]}`).join(", ") +
        "). A mixed column has no maximum: MAX over it returns a bare serial — on production, '2272' — " +
        "which is OLDER than almost every row it was asked to dominate. Put every entry in one format.",
    );
  }

  return late;
}

main();
