/**
 * rehearse-pending-apply.ts — the W10-D rehearsal of the `portava-ci` pending
 * set, on the LOCAL harness only (docs/ops/discovery-portava-ci-apply-plan.md).
 *
 * It never reaches Supabase. Its only target is LOCAL_DB_URL, the throwaway
 * PostgreSQL 16 cluster `scripts/local-db/up.sh` boots, and it refuses any URL
 * whose host is not 127.0.0.1 / localhost.
 *
 * WHAT IT REUSES, AND WHY
 * =======================
 * Every DECISION is the repository's own code, imported rather than copied:
 *   scripts/src/apply-migrations.ts   ordering, the pending plan (planApply),
 *                                     the shape classification, the one-
 *                                     transaction apply statement and the
 *                                     stop-at-first-failure runner (runPlan).
 *   src/scripts/lib/migrationSqlBlocks.ts
 *                                     the block split certify:migrations' stage
 *                                     4 uses to pick postconditions.
 * Only the TRANSPORT differs: psql against the harness instead of the Supabase
 * Management API. That is the same substitution docs/migrations.md records for
 * the 2026-09-26 and 2026-09-27 portava-ci applies.
 *
 * SUBCOMMANDS (run from artifacts/api-server, LOCAL_DB_URL in the environment)
 *   model-ledger   write the ledger rows portava-ci holds: every file below
 *                  3338 plus 3350 (docs/migrations.md 2026-09-27 entry)
 *   plan           the dry run, compared with CI's list on 84318d1b2
 *   apply          apply the pending set through runPlan
 *   postconditions certify stage 4, re-run over the pending set
 *   objects        every object CI's audit:schema named missing on 84318d1b2
 *   catalog <label> / data <label>   fingerprints, written to LOCAL_DB_WORK
 *   diff <a> <b> [catalog|data]      compare two fingerprints
 *   rollback       every rollback file, newest first, each checked; 3441's
 *                  and 3440's REVERSAL footers in their place (W10-F, §87)
 *   emit-rollback-rehearsal [file]   the pending set as ONE transaction that
 *                  ends in ROLLBACK, for an operator's zero-persistence
 *                  pre-flight (the plan's step 3); written, never sent
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MIGRATIONS_DIR,
  assertUnambiguousOrder,
  checksumOf,
  classifyMigration,
  decideExitCode,
  formatDryRun,
  listMigrationFiles,
  planApply,
  runPlan,
  type LedgerRow,
} from "../../../../scripts/src/apply-migrations.js";
import {
  isAssertionOnlyDoBlock,
  isPreconditionDoBlock,
  topLevelStatements,
} from "../../src/scripts/lib/migrationSqlBlocks.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROLLBACK_DIR = resolve(HERE, "../../../../db/rollback");
const WORK = process.env.LOCAL_DB_WORK ?? "/tmp/portava-local-db-work";
const URL_ = process.env.LOCAL_DB_URL ?? "";

/**
 * `apply-migrations --dry-run` on `portava-ci`, CI run 36392056669 (job
 * 108830529119), head 84318d1b2, 2026-09-28 07:35 UTC: "Would apply 40
 * migration(s), IN THIS ORDER". Copied from that log, in that order.
 */
export const CI_PENDING_84318D1B2: readonly string[] = [
  "3338_media_processing_worker_flag.sql",
  "3340_media_tab_world_default_flag.sql",
  "3341_media_watch_context_overlay_flag.sql",
  "3342_media_watch_tap_to_play_flag.sql",
  "3343_media_watch_stage24_ranking_flag.sql",
  "3351_media_find_busier_flag.sql",
  "3352_media_perspective_vantage.sql",
  "3355_media_vision_provider_flag.sql",
  "3356_media_moderation_classifier_flag.sql",
  "3357_media_transcoder_flag.sql",
  "3358_media_captions_flag.sql",
  "3359_passport_postcard_cover_nullable.sql",
  "3360_intel_evidence_sealed_reference.sql",
  "3361_intel_evidence_sealed_reference_validate.sql",
  "3362_posts_client_column_grants.sql",
  "3363_place_copies_client_column_grants.sql",
  "3364_pulse_geo_tags_write_boundary.sql",
  "3365_post_media_write_boundary.sql",
  "3366_discovery_search_protected_zones_flag.sql",
  "3375_rank_events_schema_version_admitted.sql",
  "3376_discovery_recommendations_per_request.sql",
  "3380_content_trails_label_cap_serialised.sql",
  "3381_trail_lifecycle_transitions.sql",
  "3385_creator_share_ledger_includes_creator_entries.sql",
  "3386_creator_attribution_recommendation_link.sql",
  "3387_creator_ledger_integrity_and_audit.sql",
  "3390_discovery_rls_explicit_policies.sql",
  "3391_discovery_stop_condition_measurements.sql",
  "3395_discovery_dwell_telemetry_flag.sql",
  "3400_media_pending_upload_sweep_flag.sql",
  "3410_discovery_trend_snapshot_parity.sql",
  "3415_trail_proposal_serialised.sql",
  "3416_trail_relations_projection.sql",
  "3417_place_momentum_dismiss_excluded.sql",
  "3420_rank_events_outcome_receipts.sql",
  "3421_ranking_debug_samples_content_id_nullable.sql",
  "3422_tags_client_write_boundary.sql",
  "3435_place_momentum_feature_version.sql",
  "3440_canonical_search_key_letter_fold.sql",
  "3441_trail_letter_fold_decompose_first.sql",
];

/** The shapes the same CI dry run printed, for the same files. */
const CI_SHAPES_WITH_POSTCONDITIONS = new Set([
  "3362", "3363", "3364", "3365", "3366", "3375", "3376", "3380", "3381",
  "3395", "3400", "3410", "3415", "3416", "3417", "3420", "3421", "3422", "3435",
]);

/**
 * Every object `audit:schema` named MISSING on portava-ci in the same run (58
 * across 14 files), plus the seven columns check:missing-live-columns and the
 * table check:write-path-columns named in job 108831230742.
 */
const CI_MISSING: ReadonlyArray<[string, string, string]> = [
  ["3352", "column", "posts.perspective_vantage"],
  ["3360", "function", "intel_evidence_rekey_reference"],
  ["3376", "table", "recommendations"],
  ["3376", "function", "record_discovery_serve_request"],
  ["3376", "index", "recommendations_user_served_at"],
  ["3376", "index", "recommendations_served_at"],
  ["3376", "policy", "recommendations.recommendations_service_role_read"],
  ["3376", "policy", "recommendations.recommendations_service_role_insert"],
  ["3380", "index", "uq_content_trails_one_primary"],
  ["3381", "function", "trails_lifecycle_transition"],
  ["3381", "function", "content_trails_state_transition"],
  ["3381", "trigger", "trails.trails_lifecycle_transition_trg"],
  ["3381", "trigger", "content_trails.content_trails_state_transition_trg"],
  ["3386", "column", "creator_attributions.recommendation_id"],
  ["3386", "function", "creator_attribution_recommendation_is_served"],
  ["3386", "index", "ca_recommendation_idx"],
  ["3386", "trigger", "creator_attributions.ca_recommendation_is_served"],
  ["3387", "table", "creator_ledger_audit_events"],
  ["3387", "function", "creator_ledger_lock_attribution"],
  ["3387", "function", "creator_attribution_rule_version_is_published"],
  ["3387", "function", "creator_attribution_supersession_is_lawful"],
  ["3387", "function", "creator_earning_attribution_is_current"],
  ["3387", "function", "creator_earning_transaction_balances"],
  ["3387", "function", "creator_ledger_append"],
  ["3387", "index", "clae_idempotency_key_once"],
  ["3387", "index", "clae_attribution_idx"],
  ["3387", "index", "clae_resulting_idx"],
  ["3387", "trigger", "creator_attributions.ca_rule_version_is_published"],
  ["3387", "trigger", "creator_attributions.ca_supersession_is_lawful"],
  ["3387", "trigger", "creator_earning_entries.cee_attribution_is_current"],
  ["3387", "trigger", "creator_earning_entries.cee_transaction_balances"],
  ["3387", "trigger", "creator_ledger_audit_events.clae_no_update"],
  ["3391", "function", "discovery_stop_measurements"],
  ["3391", "index", "rank_events_discovery_served_at"],
  ["3410", "column", "place_momentum.recent_unique_travelers"],
  ["3410", "column", "place_momentum.window_unique_travelers"],
  ["3410", "column", "place_momentum.source_surface"],
  ["3415", "function", "trail_letter_fold"],
  ["3415", "function", "trail_canonical_slug"],
  ["3415", "function", "trail_title_tokens"],
  ["3415", "function", "trail_normalised_destination"],
  ["3415", "function", "trail_token_similarity"],
  ["3415", "function", "trail_canonicalisation_verdict"],
  ["3415", "function", "trail_proposal_peers"],
  ["3415", "function", "trail_propose"],
  ["3416", "table", "trail_relations"],
  ["3416", "function", "rebuild_trail_relations"],
  ["3416", "index", "idx_trail_relations_to"],
  ["3420", "table", "rank_event_outcome_receipts"],
  ["3420", "column", "rank_events.outcome_client_event_id"],
  ["3420", "function", "rank_events_record_outcome_receipt"],
  ["3420", "policy", "rank_event_outcome_receipts.rank_event_outcome_receipts_deny_select_clients"],
  ["3420", "policy", "rank_event_outcome_receipts.rank_event_outcome_receipts_deny_insert_clients"],
  ["3420", "policy", "rank_event_outcome_receipts.rank_event_outcome_receipts_deny_update_clients"],
  ["3420", "policy", "rank_event_outcome_receipts.rank_event_outcome_receipts_deny_delete_clients"],
  ["3420", "trigger", "rank_events.rank_events_outcome_receipt"],
  ["3435", "column", "place_momentum.feature_version"],
  ["3441", "function", "trail_letter_fold"],
];

// ─────────────────────────────────────────────────────────────────────────────

function die(msg: string): never {
  console.error(`::error::rehearse-pending-apply: ${msg}`);
  process.exit(2);
}

function assertLocalTarget(): void {
  if (!URL_) die("LOCAL_DB_URL is not set (run scripts/local-db/up.sh first).");
  const host = new URL(URL_).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") {
    die(`LOCAL_DB_URL points at ${host}. This script rehearses on the local harness ONLY.`);
  }
}

let seq = 0;
function psql(sql: string): { ok: boolean; out: string; err: string } {
  mkdirSync(WORK, { recursive: true });
  const f = join(WORK, `rehearse-${process.pid}-${seq++}.sql`);
  writeFileSync(f, sql);
  const r = spawnSync("psql", ["-X", "-q", "-tA", "-v", "ON_ERROR_STOP=1", URL_, "-f", f], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return { ok: r.status === 0, out: r.stdout ?? "", err: r.stderr ?? "" };
}

function must(sql: string): string {
  const r = psql(sql);
  if (!r.ok) die(`psql failed: ${r.err.trim().split("\n").slice(-3).join(" | ")}`);
  return r.out;
}

function readLedger(): LedgerRow[] {
  const out = must(
    "select filename || chr(9) || checksum || chr(9) || applied_by from public.schema_migration_ledger order by filename;",
  );
  return out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [filename, checksum, applied_by] = l.split("\t");
      return { filename, checksum, applied_by };
    });
}

const read = (f: string) => readFileSync(join(MIGRATIONS_DIR, f), "utf8");

function onDisk() {
  return listMigrationFiles().map((filename) => ({ filename, sql: read(filename) }));
}

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

// ─────────────────────────────────────────────────────────────────────────────

function modelLedger(): void {
  const have = new Set(readLedger().map((r) => r.filename));
  const rows = listMigrationFiles()
    .filter((f) => f < "3338" || f.startsWith("3350_"))
    .filter((f) => !have.has(f));
  if (rows.length === 0) {
    console.log("model-ledger: nothing to add.");
    return;
  }
  const values = rows
    .map(
      (f) =>
        `(${q(f)}, ${q(checksumOf(read(f)))}, 'manual', 'W10-D rehearsal: models the portava-ci ledger (every file below 3338, and 3350)')`,
    )
    .join(",\n");
  must(
    `insert into public.schema_migration_ledger (filename, checksum, applied_by, notes) values\n${values};`,
  );
  console.log(`model-ledger: ${rows.length} proven row(s) written for files the harness replayed by psql.`);
}

function plan(): string[] {
  const p = planApply(onDisk(), readLedger());
  const classify = (f: string) => classifyMigration(read(f), f);
  console.log(formatDryRun(p, classify));
  const order = assertUnambiguousOrder(p.pending);
  if (order.length > 0) die(`order undefined: ${order.join("; ")}`);
  if (p.drifted.length > 0) die(`drift: ${p.drifted.map((d) => d.filename).join(", ")}`);
  const same =
    p.pending.length === CI_PENDING_84318D1B2.length &&
    p.pending.every((f, i) => f === CI_PENDING_84318D1B2[i]);
  console.log("");
  console.log(
    same
      ? `plan: IDENTICAL to CI's dry run on 84318d1b2 (${p.pending.length} files, same order).`
      : `plan: DIFFERS from CI's dry run on 84318d1b2 — here ${p.pending.length}, CI 40.` +
          `\n  only here: ${p.pending.filter((f) => !CI_PENDING_84318D1B2.includes(f)).join(", ") || "-"}` +
          `\n  only CI  : ${CI_PENDING_84318D1B2.filter((f) => !p.pending.includes(f)).join(", ") || "-"}`,
  );
  const shapeMismatch = p.pending.filter((f) => {
    const c = classify(f);
    if (c.kind === "refuse") return true;
    const hasPost = c.postconditions.trim() !== "";
    return hasPost !== CI_SHAPES_WITH_POSTCONDITIONS.has(f.slice(0, 4));
  });
  console.log(
    shapeMismatch.length === 0
      ? "plan: every shape (unwrapped / +postconditions) matches CI's."
      : `plan: shape differs from CI for ${shapeMismatch.join(", ")}`,
  );
  return p.pending;
}

async function apply(): Promise<void> {
  const p = planApply(onDisk(), readLedger());
  if (p.pending.length === 0) {
    console.log(
      `apply: NOTHING TO DO — ${p.skipped.length} proven row(s), 0 pending. (The runner's idempotent re-run.)`,
    );
    return;
  }
  console.log(`apply: ${p.pending.length} pending, in canonical order.`);
  const outcomes = await runPlan(
    p.pending,
    read,
    async (filename, statement, phase) => {
      const t0 = Date.now();
      const r = psql(statement);
      if (!r.ok) throw new Error(r.err.trim().split("\n").filter((l) => /ERROR|DETAIL/.test(l)).join(" | "));
      console.log(`  → ${filename}: ${phase === "apply" ? "applied + recorded" : "postconditions verified"} (${Date.now() - t0} ms)`);
    },
    { appliedBy: "manual", notes: "W10-D rehearsal harness (scripts/local-db/rehearse-pending-apply.ts)" },
  );
  const bad = outcomes.find((o) => o.status !== "applied");
  if (bad) {
    console.error(`apply: STOPPED at ${bad.filename} (${bad.status}): ${bad.detail}`);
    process.exit(decideExitCode(outcomes));
  }
  console.log(`apply: PASSED — ${outcomes.length} applied, each in one transaction with its ledger row.`);
}

/** certify:migrations stage 4, over the given files: assertion-only DO blocks that are not `$pre$`. */
function postconditions(files: readonly string[]): void {
  let ran = 0;
  let held = 0;
  const failed: string[] = [];
  const none: string[] = [];
  for (const f of files) {
    const blocks = topLevelStatements(read(f)).filter(isAssertionOnlyDoBlock);
    const post = blocks.filter((b) => !isPreconditionDoBlock(b));
    held += blocks.length - post.length;
    if (post.length === 0) none.push(f);
    for (const b of post) {
      const r = psql(b);
      ran++;
      if (!r.ok) failed.push(`${f}: ${r.err.trim().split("\n").filter((l) => /ERROR/.test(l)).join(" | ")}`);
    }
  }
  console.log(`postconditions: ${ran} block(s) re-run after commit, ${held} $pre$ block(s) held back.`);
  if (none.length) console.log(`postconditions: no re-runnable assertion in ${none.length} file(s): ${none.join(", ")}`);
  if (failed.length) {
    console.log(`postconditions: ${failed.length} FAILED:`);
    for (const l of failed) console.log(`  ✖ ${l}`);
    process.exitCode = 1;
  } else {
    console.log("postconditions: every re-run block passed.");
  }
}

/**
 * Objects CI named that a LATER file in the set removes by design, so the
 * correct answer after the apply is ABSENT. audit:schema carries the same fact
 * in its ALLOWLIST (W10-F, census-discovery §87, F1).
 */
const DROPPED_BY_DESIGN = new Set(["3360 function intel_evidence_rekey_reference"]);

function objects(): void {
  const missing: string[] = [];
  let absentByDesign = 0;
  for (const [file, kind, name] of CI_MISSING) {
    if (DROPPED_BY_DESIGN.has(`${file} ${kind} ${name}`)) {
      const r = psql(`select exists(select 1 from pg_proc where pronamespace='public'::regnamespace and proname='${name}');`);
      if (!r.ok || r.out.trim() !== "f") missing.push(`${file} ${kind} ${name} (must be ABSENT: 3361 drops it)`);
      else absentByDesign++;
      continue;
    }
    const [a, b] = name.includes(".") ? name.split(".") : [name, ""];
    const probe =
      kind === "table" ? `select to_regclass('public.${a}') is not null`
      : kind === "column" ? `select exists(select 1 from information_schema.columns where table_schema='public' and table_name='${a}' and column_name='${b}')`
      : kind === "function" ? `select exists(select 1 from pg_proc where pronamespace='public'::regnamespace and proname='${a}')`
      : kind === "index" ? `select exists(select 1 from pg_indexes where schemaname='public' and indexname='${a}')`
      : kind === "trigger" ? `select exists(select 1 from pg_trigger where tgrelid='public.${a}'::regclass and tgname='${b}' and not tgisinternal)`
      : `select exists(select 1 from pg_policies where schemaname='public' and tablename='${a}' and policyname='${b}')`;
    const r = psql(`${probe};`);
    if (!r.ok || r.out.trim() !== "t") missing.push(`${file} ${kind} ${name}`);
  }
  console.log(
    `objects: ${CI_MISSING.length - missing.length - absentByDesign} of ${CI_MISSING.length} objects CI named missing are present;` +
      ` ${absentByDesign} absent by design (dropped by a later file in the set).`,
  );
  for (const m of missing) console.log(`  ✖ ${m}`);
  if (missing.length) process.exitCode = 1;
}

const CATALOG_SQL = `
select line from (
select 'rel|'||c.relname||'|'||c.relkind::text||'|rls='||c.relrowsecurity||'|acl='||coalesce(array_to_string(c.relacl,','),'')||'|comment='||coalesce(md5(obj_description(c.oid,'pg_class')),'') as line
  from pg_class c where c.relnamespace='public'::regnamespace and c.relkind in ('r','p','v','m')
union all
select 'col|'||c.relname||'.'||a.attname||'|'||format_type(a.atttypid,a.atttypmod)||'|nn='||a.attnotnull||'|def='||coalesce(pg_get_expr(d.adbin,d.adrelid),'')||'|gen='||a.attgenerated::text||'|acl='||coalesce(array_to_string(a.attacl,','),'')
  from pg_attribute a join pg_class c on c.oid=a.attrelid left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
 where c.relnamespace='public'::regnamespace and c.relkind in ('r','p','v','m') and a.attnum>0 and not a.attisdropped
union all
select 'con|'||conrelid::regclass::text||'|'||conname||'|'||pg_get_constraintdef(oid)||'|valid='||convalidated
  from pg_constraint where connamespace='public'::regnamespace
union all
select 'idx|'||indexname||'|'||indexdef from pg_indexes where schemaname='public'
union all
select 'fn|'||p.oid::regprocedure::text||'|'||md5(pg_get_functiondef(p.oid))||'|acl='||coalesce(array_to_string(p.proacl,','),'')
  from pg_proc p where p.pronamespace='public'::regnamespace and p.prokind in ('f','p')
union all
select 'trg|'||tgrelid::regclass::text||'|'||tgname||'|'||tgenabled::text||'|'||pg_get_triggerdef(oid)
  from pg_trigger where not tgisinternal and tgrelid in (select oid from pg_class where relnamespace='public'::regnamespace)
union all
select 'pol|'||tablename||'|'||policyname||'|'||permissive||'|'||array_to_string(roles,',')||'|'||cmd||'|'||coalesce(qual,'')||'|'||coalesce(with_check,'')
  from pg_policies where schemaname='public'
union all
select 'view|'||viewname||'|'||md5(definition) from pg_views where schemaname='public'
) x order by line;`;

/** Tables whose pre-existing rows the pending set must preserve. */
const DATA_TABLES = [
  "feature_flags", "profiles", "canonical_locations", "rank_events", "trails", "content_trails",
  "ranking_debug_samples", "posts", "post_media", "passport_postcards", "pulse_geo_tags", "tags",
  "intel_evidence", "place_momentum", "creator_attributions", "creator_earning_entries",
  "discovery_places", "discovery_shadow_serves",
];

function fingerprint(kind: "catalog" | "data", label: string): void {
  mkdirSync(WORK, { recursive: true });
  const out = join(WORK, `fp-${kind}-${label}.txt`);
  if (kind === "catalog") {
    writeFileSync(out, must(CATALOG_SQL));
  } else {
    const colsFile = join(WORK, "fp-data-columns.json");
    let cols: Record<string, string[]>;
    if (existsSync(colsFile)) {
      cols = JSON.parse(readFileSync(colsFile, "utf8")) as Record<string, string[]>;
    } else {
      cols = {};
      for (const t of DATA_TABLES) {
        const c = must(
          `select string_agg(quote_ident(column_name), ',' order by ordinal_position) from information_schema.columns where table_schema='public' and table_name='${t}' and is_generated='NEVER';`,
        ).trim();
        if (c) cols[t] = c.split(",");
      }
      writeFileSync(colsFile, JSON.stringify(cols, null, 1));
    }
    const lines: string[] = [];
    for (const [t, c] of Object.entries(cols)) {
      const r = must(
        `select count(*)||'|'||md5(coalesce(string_agg(r::text, chr(10) order by r::text),'')) from (select ${c.join(",")} from public.${t}) r;`,
      ).trim();
      lines.push(`${t}|${r}`);
    }
    lines.push(
      "search_key|" +
        must(
          "select string_agg(name||'='||coalesce(search_key,'<null>'), ' ; ' order by name) from public.canonical_locations;",
        ).trim(),
    );
    writeFileSync(out, lines.join("\n") + "\n");
  }
  console.log(`${kind} fingerprint '${label}' -> ${out}`);
}

function diff(a: string, b: string, kind: string): void {
  const A = readFileSync(join(WORK, `fp-${kind}-${a}.txt`), "utf8").split("\n").filter(Boolean);
  const B = readFileSync(join(WORK, `fp-${kind}-${b}.txt`), "utf8").split("\n").filter(Boolean);
  const sa = new Set(A), sb = new Set(B);
  const onlyA = A.filter((l) => !sb.has(l));
  const onlyB = B.filter((l) => !sa.has(l));
  console.log(`${kind} ${a} vs ${b}: ${A.length} vs ${B.length} lines; ${onlyA.length} only in ${a}, ${onlyB.length} only in ${b}.`);
  for (const l of onlyA) console.log(`  - ${l.slice(0, 220)}`);
  for (const l of onlyB) console.log(`  + ${l.slice(0, 220)}`);
}

/**
 * The two files with no rollback file carry their reversal in a `-- REVERSAL:`
 * footer. W10-F (census-discovery §87) runs them here, in the files' own words,
 * because at this tree 3415's rollback cannot drop trail_normalised_destination
 * while 3441's stored trails.destination_key depends on it.
 */
const FOOTER_REVERSALS: Record<string, () => string> = {
  // 3441's footer: drop the index and the column FIRST. Re-running 3415's three
  // function bodies is left to 3415's own rollback, which drops them next.
  "3441": () =>
    "BEGIN;\nDROP INDEX IF EXISTS public.idx_trails_destination_key;\n" +
    "ALTER TABLE public.trails DROP COLUMN IF EXISTS destination_key;\nCOMMIT;\n",
  // 3440's footer: drop the index and the column, then re-run 2220 (function
  // body, ADD COLUMN, CREATE INDEX) so the stored keys are recomputed.
  "3440": () =>
    "BEGIN;\nDROP INDEX IF EXISTS public.canonical_locations_search_key_trgm_idx;\n" +
    "ALTER TABLE public.canonical_locations DROP COLUMN IF EXISTS search_key;\nCOMMIT;\n" +
    read(listMigrationFiles().find((m) => m.startsWith("2220_")) ?? die("2220 is not on disk")),
};

function rollback(files: readonly string[]): void {
  const available = readdirSync(ROLLBACK_DIR);
  for (const f of [...files].reverse()) {
    const prefix = f.slice(0, 4);
    const rb = available.filter((r) => r.includes(`-${prefix}-`) && r.endsWith("-rollback.sql"));
    if (rb.length !== 1 && FOOTER_REVERSALS[prefix]) {
      const r = psql(FOOTER_REVERSALS[prefix]());
      if (!r.ok) {
        console.log(`  ✖ ${f}: footer reversal FAILED: ${r.err.trim().split("\n").filter((l) => /ERROR/.test(l)).join(" | ")}`);
        process.exitCode = 1;
        return;
      }
      must(`delete from public.schema_migration_ledger where filename=${q(f)};`);
      console.log(`  ✔ ${f}: no rollback file; its REVERSAL footer ran, and its ledger row was deleted.`);
      continue;
    }
    if (rb.length !== 1) {
      console.log(`  · ${f}: no rollback file (${rb.length}); forward fix only — not run here.`);
      continue;
    }
    const r = psql(readFileSync(join(ROLLBACK_DIR, rb[0]), "utf8"));
    if (!r.ok) {
      console.log(`  ✖ ${f}: ${rb[0]} FAILED: ${r.err.trim().split("\n").filter((l) => /ERROR/.test(l)).join(" | ")}`);
      process.exitCode = 1;
      return;
    }
    const row = must(`select count(*) from public.schema_migration_ledger where filename=${q(f)};`).trim();
    if (row !== "0") {
      // The file left its ledger row. Without the delete, the runner would treat
      // the migration as still applied and never re-apply it.
      must(`delete from public.schema_migration_ledger where filename=${q(f)};`);
      console.log(`  ✔ ${f}: ${rb[0]} ran; it LEFT the ledger row, deleted by hand here.`);
    } else {
      console.log(`  ✔ ${f}: ${rb[0]} ran and removed the ledger row.`);
    }
  }
}

/**
 * The whole pending set in ONE transaction that ends in ROLLBACK: every body
 * exactly as runPlan would send it (classifyMigration's body), each file's
 * post-COMMIT postcondition tail after it, and no ledger row. Written to a
 * file; this script never sends it anywhere but the harness. On the target it
 * answers "would every precondition, body and postcondition hold HERE?" and
 * persists nothing, because the last statement is ROLLBACK.
 */
function emitRollbackRehearsal(out: string): void {
  const parts = ["-- Generated by scripts/local-db/rehearse-pending-apply.ts emit-rollback-rehearsal.",
    "-- ONE transaction, ending in ROLLBACK: it changes nothing it runs against.",
    "BEGIN;"];
  for (const f of CI_PENDING_84318D1B2) {
    const c = classifyMigration(read(f), f);
    if (c.kind === "refuse") die(`${f} is refused: ${c.reason}`);
    parts.push(`-- ── ${f} (sha256 ${checksumOf(read(f))}) ──`, c.body.trim());
    if (c.postconditions.trim()) parts.push(`-- ${f}: postconditions`, c.postconditions.trim());
  }
  parts.push("DO $w10d$ BEGIN RAISE NOTICE 'W10-D rollback rehearsal: all 40 bodies and postconditions held; rolling back.'; END $w10d$;", "ROLLBACK;", "");
  writeFileSync(out, parts.join("\n"));
  console.log(`emit-rollback-rehearsal: ${CI_PENDING_84318D1B2.length} files -> ${out}`);
}

// ─────────────────────────────────────────────────────────────────────────────

assertLocalTarget();
const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case "model-ledger": modelLedger(); break;
  case "plan": plan(); break;
  case "apply": await apply(); break;
  case "postconditions": postconditions(args.length ? args : CI_PENDING_84318D1B2); break;
  case "objects": objects(); break;
  case "catalog": fingerprint("catalog", args[0] ?? die("label?")); break;
  case "data": fingerprint("data", args[0] ?? die("label?")); break;
  case "diff": diff(args[0], args[1], args[2] ?? "catalog"); break;
  case "rollback": rollback(args.length ? args : CI_PENDING_84318D1B2); break;
  case "emit-rollback-rehearsal": emitRollbackRehearsal(args[0] ?? join(WORK, "portava-ci-rollback-rehearsal.sql")); break;
  default: die(`unknown subcommand '${cmd ?? ""}'`);
}
