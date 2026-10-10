/**
 * beta-configure.ts — configure the portava-beta project AFTER beta-db.yml has
 * built its schema: close sign-up in Supabase Auth, set the redirect URLs, set
 * every feature flag to scripts/src/beta-flag-policy.json, and read both back.
 *
 * Run ONLY through .github/workflows/beta-config.yml (workflow_dispatch, typed
 * confirmation CONFIGURE-BETA). The contract is in beta-config-core.ts.
 *
 * ORDER (each step prints what it did; the first failure stops the run)
 *   a. guards — the repo's allowlist (ciSupabaseGuard.mjs, imported first under
 *      RUN_DIRECTLY) AND a hard-coded beta ref: anything else exits 2, portava-ci
 *      and production included. A missing token or confirmation exits 2.
 *      The policy is validated against the migrations' flag population before
 *      any request; an invalid policy exits 2.
 *   b. flags, READ AND PLANNED FIRST — read every row; a policy flag missing
 *      from the database exits 1 with NOTHING written, Auth included (the chain
 *      has not landed; invite_only_beta or disable_signups absent would leave
 *      sign-up open). Rows no policy entry names will be forced OFF and are listed.
 *      ONE EXCEPTION, AND IT CREATES ROWS RATHER THAN SKIPPING THE CHECK: a missing
 *      flag whose only definition is a seed row in a migration sorting before
 *      CHAIN_START_PREFIX (the structure-only baseline never carries those rows,
 *      and the portava-ci reference snapshot lacks exactly these 128 — see
 *      preBaselineFlagDefinitions in beta-config-core.ts). If EVERY missing flag
 *      is such a flag, step b2 inserts exactly those rows from their migration
 *      definitions (ON CONFLICT DO NOTHING: no existing row is touched), STOPs
 *      ENGAGED and everything else OFF, then reads every row again and repeats
 *      this check on what the database now holds. One missing flag the chain
 *      seeds refuses the whole step with nothing written.
 *      --dry-run prints the rows b2 would create and plans on top of them.
 *   c. auth — PATCH /config/auth, then GET and compare (exit 1 on any difference,
 *      before any flag is written).
 *   d. flags — one transaction sets every row and audits each flip.
 *   e. read-back — every row equals its target, or exit 1.
 *   f. the profiles boundary (migrations 3740, PR #647, and 3742, PR #653) —
 *      READ-ONLY. Exit 1 while anon/authenticated hold TABLE-level SELECT/UPDATE
 *      on public.profiles, SELECT on a personal column (date_of_birth,
 *      phone_e164, expo_push_token, full_name …), UPDATE on a server-only
 *      authority column (verified, trust_score, created_at, role … — 3742's
 *      nineteen), or while 3742's trigger trg_profiles_authority_privileged is
 *      missing, disabled, conditional (WHEN) or misshapen, its function no
 *      longer compares or refuses before RETURN, or the predicate it trusts
 *      (caller_may_write_profile_role(), 2078) is missing or no longer reads the
 *      role GUC and session_user (the textual checks of 3742's own
 *      postcondition; its executed SET ROLE probe is not repeated here). Steps c-e have already
 *      closed sign-up and set the flags (both protective); the red run says the
 *      database is NOT ready for tester accounts (runbook step 8).
 *
 *   --dry-run  does (a) and (b), reads the auth config and the profiles grant,
 *              prints the plan, and writes nothing.
 *
 * EXIT 0 configured (or planned) · 1 a request failed or a read-back differs ·
 *      2 refused before any write
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { argValue, BETA_PROJECT_REF } from "./beta-db-core.js";
import {
  BETA_AUTH_CONFIG,
  CONFIRMATION,
  FLAG_STATE_SQL,
  PROFILES_CLIENT_GRANT_SQL,
  authConfigProblems,
  betaManagementClient,
  buildFlagApplySql,
  configureTargetRefusal,
  flagPolicyProblems,
  flagStateProblems,
  loadFlagPolicy,
  parseFlagRows,
  planFlagApply,
  profilesGrantProblems,
  seededFlagPopulation,
  type FetchLike,
  type FlagPolicy,
  buildFlagRepairSql,
  planPreBaselineFlagRepair,
  preBaselineFlagDefinitions,
  type PreBaselineFlagDefinition,
  type SeededFlag,
} from "./beta-config-core.js";

export interface ConfigureDeps {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  fetch: FetchLike;
  policy?: FlagPolicy;
  population?: ReadonlyMap<string, SeededFlag>;
  /** Pre-baseline flag definitions (default: read from the migrations). */
  definitions?: ReadonlyMap<string, PreBaselineFlagDefinition>;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

export async function runBetaConfigure(deps: ConfigureDeps): Promise<0 | 1 | 2> {
  const log = deps.log ?? ((l) => console.log(l));
  const error = deps.error ?? ((l) => console.error(l));
  const refuse = (m: string): 2 => { error(`::error::beta-configure REFUSED: ${m}`); return 2; };
  const fail = (m: string): 1 => { error(`::error::beta-configure FAILED: ${m}`); return 1; };

  // ── a. guards ──────────────────────────────────────────────────────────────
  log("── a · guards");
  const confirm = argValue(deps.argv, "--confirm");
  if (confirm !== CONFIRMATION) return refuse(`--confirm=${CONFIRMATION} is required; nothing was sent.`);
  const dryRun = deps.argv.includes("--dry-run");
  const target = configureTargetRefusal(deps.env.SUPABASE_URL);
  if (target !== null) return refuse(target);
  const token = deps.env.SUPABASE_PROJECT_TOKEN || deps.env.SUPABASE_ACCESS_TOKEN;
  if (!token) return refuse("no Management API token (SUPABASE_PROJECT_TOKEN). A configuration that did not run is not a skip.");
  let policy: FlagPolicy;
  try {
    policy = deps.policy ?? loadFlagPolicy();
  } catch (err) {
    return refuse(`cannot read the flag policy: ${(err as Error).message}`);
  }
  const population = deps.population ?? seededFlagPopulation();
  const policyProblems = flagPolicyProblems(policy, population);
  if (policyProblems.length > 0) return refuse(`the flag policy does not match the migrations:\n  ${policyProblems.join("\n  ")}`);
  const onFlags = policy.flags.filter((e) => e.enabled).map((e) => e.flag).sort();
  log(`  target ${BETA_PROJECT_REF} (portava-beta); policy: ${policy.flags.length} flags, ${onFlags.length} ON (${onFlags.join(", ")})${dryRun ? "; DRY RUN" : ""}`);

  const api = betaManagementClient(BETA_PROJECT_REF, token, deps.fetch);
  try {
    // ── b. flags: READ AND PLAN FIRST, before anything is written ────────────
    // A refusal here (a policy flag missing from the database) leaves Auth and
    // every flag exactly as they were: the plan is decided before the first write.
    log("── b · feature flags (read and plan; nothing written yet)");
    let before = parseFlagRows(await api.query(FLAG_STATE_SQL));
    let plan = planFlagApply(before, policy);
    if (plan.missing.length > 0) {
      // ── b2. pre-baseline rows: create them from their definitions, or refuse ──
      const repair = planPreBaselineFlagRepair(plan.missing, policy, deps.definitions ?? preBaselineFlagDefinitions());
      if (repair.refused.length > 0) {
        return fail(
          `${plan.missing.length} policy flag(s) are not in public.feature_flags (${plan.missing.join(", ")}). ` +
            "Nothing was written — neither Auth nor any flag: the schema build has not landed, and a missing " +
            "invite_only_beta or disable_signups row would leave sign-up open. " +
            `Not creatable from a pre-baseline definition: ${repair.refused.map((r) => `${r.flag} (${r.why})`).join("; ")}.`,
        );
      }
      log(`── b2 · ${repair.create.length} pre-baseline flag row(s) absent (the structure-only baseline carries no rows; created from their migration definitions, ON CONFLICT DO NOTHING)`);
      for (const r of repair.create) log(`  ${r.flag} := ${r.enabled}${r.enabled ? " (STOP, engaged)" : ""} — defined at ${r.seededIn} (seeded ${r.seededValue})`);
      if (dryRun) {
        log(`  DRY RUN: would create ${repair.create.length} row(s); planning on top of them`);
        before = [...before, ...repair.create.map((r) => ({ flag: r.flag, enabled: r.enabled }))].sort((a, b) => (a.flag < b.flag ? -1 : 1));
      } else {
        const created = parseFlagRows(await api.query(buildFlagRepairSql(repair.create)));
        log(`  created ${created.length} row(s) in one statement; no existing row touched`);
        before = parseFlagRows(await api.query(FLAG_STATE_SQL));
      }
      plan = planFlagApply(before, policy);
      if (plan.missing.length > 0) {
        return fail(
          `${plan.missing.length} policy flag(s) are still not in public.feature_flags after the pre-baseline repair ` +
            `(${plan.missing.join(", ")}). Only the repair's inserts were written (STOPs engaged, the rest OFF) — not Auth, ` +
            "and no existing flag.",
        );
      }
    }
    if (plan.unknown.length > 0) {
      log(`::warning::${plan.unknown.length} flag(s) in the database are not in the policy and are forced OFF: ${plan.unknown.join(", ")}`);
    }
    log(`  ${before.length} rows; ${plan.changes.length} to change: ${plan.changes.map((c) => `${c.flag} ${c.from}→${c.to}`).join(", ") || "(none)"}`);

    // ── c. auth ──────────────────────────────────────────────────────────────
    log("── c · auth config");
    if (dryRun) {
      const now = authConfigProblems(await api.getAuthConfig());
      log(now.length ? `  would change: ${now.join("; ")}` : "  already as required");
      const grant = profilesGrantProblems(await api.query(PROFILES_CLIENT_GRANT_SQL));
      log(grant.length ? `::warning::step f would FAIL — profiles boundary (3740 + 3742): ${grant.join("; ")}` : "  profiles boundary: as 3740 and 3742 leave it");
      log("\nbeta-configure DRY RUN — nothing written.");
      return 0;
    }
    await api.patchAuthConfig(BETA_AUTH_CONFIG);
    const authProblems = authConfigProblems(await api.getAuthConfig());
    if (authProblems.length > 0) {
      return fail(
        `the auth config read-back differs from what was written (no flag has been written yet):\n  ${authProblems.join("\n  ")}`,
      );
    }
    log(`  disable_signup=true, site_url=${BETA_AUTH_CONFIG.site_url}, uri_allow_list=${BETA_AUTH_CONFIG.uri_allow_list} — read back and equal`);

    // ── d. flags: apply ──────────────────────────────────────────────────────
    log("── d · feature flags (apply)");
    const flipped = (await api.query(buildFlagApplySql(onFlags))).map((r) => String(r.flag));
    log(`  applied in one transaction; ${flipped.length} audited flip(s)`);

    // ── e. read-back ─────────────────────────────────────────────────────────
    log("── e · read-back");
    const after = parseFlagRows(await api.query(FLAG_STATE_SQL));
    const problems = flagStateProblems(after, plan.target);
    if (problems.length > 0) return fail(`the flag read-back differs from the policy:\n  ${problems.join("\n  ")}`);
    log(`  ${after.length} rows equal the policy; ON: ${after.filter((r) => r.enabled).map((r) => r.flag).join(", ")}`);

    // ── f. the profiles boundary (3740 + 3742) ───────────────────────────────
    log("── f · profiles boundary (migrations 3740 + 3742; read-only)");
    const grant = profilesGrantProblems(await api.query(PROFILES_CLIENT_GRANT_SQL));
    if (grant.length > 0) {
      return fail(
        "configured (sign-up closed, flags at policy), but the database is NOT ready for tester accounts — " +
          `a client role can read personal columns of public.profiles or write its authority columns:\n  ${grant.join("\n  ")}\n` +
          "Migrations 3740 (PR #647) and 3742 (PR #653) must be applied and their postconditions verified before runbook step 8. " +
          "Once they are on main, apply them without a reset (beta-db.yml confirm=APPLY-PENDING-BETA apply=yes, or pnpm -C scripts beta:provision), then re-dispatch this step.",
      );
    }
    log("  no TABLE-level SELECT/UPDATE for anon or authenticated, no SELECT on a personal column (3740), no UPDATE on an authority column, and 3742's unconditional trigger, its refusal and the 2078 predicate in place — the boundary holds");
  } catch (err) {
    return fail((err as Error).message);
  }
  log("\nbeta-configure PASSED — sign-up closed in Supabase Auth, redirects set, flags at policy, all read back; profiles' boundary (3740 + 3742) holds.");
  return 0;
}

const RUN_DIRECTLY = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (RUN_DIRECTLY) {
  // THE TARGET GUARD, first, before any client or request.
  await import("../../artifacts/api-server/src/lib/ciSupabaseGuard.mjs");
  const code = await runBetaConfigure({ argv: process.argv.slice(2), env: process.env, fetch: fetch as unknown as FetchLike });
  process.exit(code);
}
