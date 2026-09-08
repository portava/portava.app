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
 * Production has NO migration ledger (no schema_migration_ledger; Supabase's
 * own schema_migrations stops at 2272), so "is migration N applied" cannot
 * be asked. "Does column X exist" can, and that is the question that matters.
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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCanonicalSchema, hasColumn, isModelled, stripSqlComments } from "./lib/canonicalSchema.js";
import {
  evaluateFlags,
  evaluateRegistry,
  loadProductionSnapshot,
  scanFlagReads,
  type SchemaRef,
} from "../lib/capability/prerequisitesCore.js";
import { CAPABILITIES } from "../lib/capability/registry.js";

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
  : join(SRC, "lib", "capability", "snapshots", "20260908-production-schema.json");
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
 * FIVE ENTRIES WERE RETIRED ON 2026-09-08 by applying the migration rather than
 * by editing the list, which is the only honest way to shrink it:
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
const KNOWN: Record<string, Known> = {
  // ── Guarded: the contract refuses before the failing call ───────────────────
  media_canonical_enabled: {
    classification: "guarded",
    objects: ["media_assets.captured_at", "media_assets.intelligence_eligibility", "media_assets.provenance"],
    note:
      "THE founding case. Registered as MEDIA_CANONICAL; lib/mediaAssets.ts refuses before building a payload " +
      "(outcome refused_schema, error-level log). Owner decision MEDIA_CANONICAL_FLAG (apply 2250/2470 or turn the flag off) is untouched.",
  },

  // ── Unguarded: ON in production, the code runs and fails ────────────────────
  intel_claim_projection_crowd: {
    classification: "unguarded",
    objects: [
      "canonical_events", "canonical_events.actor_id", "canonical_events.id", "canonical_events.payload", "canonical_events.verb",
      "intel_claims.updated_at", "intel_claims.version",
      "intel_live_promoted_scopes.expires_at", "intel_live_promoted_scopes.withdrawn_at",
      "intel_state_snapshot_versions",
      "intel_state_snapshots.conflict_state",
    ],
    note:
      "The Live spine. lib/intelProjectionScheduler.ts:64 selects updated_at/version (2274) → 42703 on every tick, " +
      "logger.warn, reason:'error'; lib/intelProjection.ts:386 inserts intel_state_snapshot_versions (2273) → PGRST205, tally.skipped. " +
      "canonical_events (2120) is read by lib/intelOutcomes.ts and lib/intelDomainEvents.ts. HANDOVER: intel owner; consumers are " +
      "lib/intelProjection.ts, lib/intelProjectionScheduler.ts, lib/liveClaimRead.ts.",
  },
  intel_limited_live: {
    classification: "unguarded",
    objects: ["intel_live_promoted_scopes.expires_at", "intel_live_promoted_scopes.withdrawn_at", "intel_state_snapshots.conflict_state"],
    note:
      "lib/liveClaimRead.ts:260 selects 2430's scope columns (42703 → no Live claim can be served); " +
      "lib/mapProducers/safetyNoticeProducer.ts:223 selects conflict_state (2275). HANDOVER: intel owner (lib/liveClaimRead.ts).",
  },
  intel_live_label_crowd: {
    classification: "unguarded",
    objects: ["intel_live_promoted_scopes.expires_at", "intel_live_promoted_scopes.withdrawn_at", "intel_state_snapshots.conflict_state"],
    note: "Same sites as intel_limited_live: both are read in liveLabelsServable (lib/liveClaimRead.ts:311-317). HANDOVER: intel owner.",
  },
  intel_capture_quick_signal: {
    classification: "unguarded",
    objects: [
      "intel_claims.observation_id",
      "intel_live_promoted_scopes.expires_at", "intel_live_promoted_scopes.withdrawn_at",
      "intel_presence_verifications", "intel_presence_verifications.actor_id", "intel_presence_verifications.evidence",
      "intel_presence_verifications.level_reached", "intel_presence_verifications.method",
      "intel_presence_verifications.observation_id", "intel_presence_verifications.verified_at",
      "intel_state_snapshots.conflict_state",
    ],
    note:
      "services/intel/IntelCaptureService.ts:303 inserts intel_presence_verifications (2276) and :534 selects intel_claims.observation_id (2274). " +
      "HANDOVER: intel owner (services/intel/IntelCaptureService.ts).",
  },
  intel_trail_followup: {
    classification: "unguarded",
    objects: [
      "intel_claims.observation_id",
      "intel_presence_verifications", "intel_presence_verifications.actor_id", "intel_presence_verifications.evidence",
      "intel_presence_verifications.level_reached", "intel_presence_verifications.method",
      "intel_presence_verifications.observation_id", "intel_presence_verifications.verified_at",
    ],
    note: "Same IntelCaptureService sites as intel_capture_quick_signal (read via SURFACE_FLAG). HANDOVER: intel owner.",
  },
  hidden_gems_enabled: {
    classification: "unguarded",
    objects: [
      "hidden_gem_contributions", "hidden_gem_contributions.contribution_type", "hidden_gem_contributions.gem_id",
      "hidden_gem_contributions.id", "hidden_gem_contributions.notes", "hidden_gem_contributions.updated_at",
      "hidden_gem_contributions.user_id",
    ],
    note:
      "services/hiddenGems/HiddenGemContributionService.ts:82-188 reads and upserts hidden_gem_contributions (2252, not in production). " +
      "HANDOVER: hidden-gems owner (the contribution service). " +
      "trip_kernel_execute() WAS listed here as a FLOOR false positive; 2420 was applied to production 2026-09-08 so the function now " +
      "exists and the object is no longer absent-and-referenced. The false-positive reasoning is preserved in git history rather than " +
      "in a list entry that no longer describes anything.",
  },
  safe_return_enabled: {
    classification: "unguarded",
    objects: [
      "locate_friends_members", "locate_friends_members.left_at", "locate_friends_members.session_id", "locate_friends_members.user_id",
      "locate_friends_sessions", "locate_friends_sessions.ended_at", "locate_friends_sessions.expires_at",
      "locate_friends_sessions.id", "locate_friends_sessions.started_at",
    ],
    note:
      "routes/safeReturn.ts reaches services/passport/PassportProjectionService.ts:1342-1353, which reads the locate_friends tables (2219, " +
      "not in production; locate_friends_enabled has no row there but that read is not gated on it). HANDOVER: passport owner " +
      "(services/passport/**) — gate the locate-friends read on its own flag or register a capability.",
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

function main(): void {
  const started = Date.now();
  if (!existsSync(SNAPSHOT)) {
    console.error(`check:flag-schema-prerequisites: snapshot missing at ${SNAPSHOT}.`);
    process.exit(2);
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
    process.exit(REPORT ? 0 : 1);
  }
  console.log(
    `OK — ${unguarded.length} unguarded (all known), ${guarded.length} guarded, ${latent.length} latent; ${Date.now() - started} ms.` +
      (unguarded.length ? ` ${unguarded.length} unguarded entries remain: each is a feature that is ON and dead in production.` : ""),
  );
}

main();
