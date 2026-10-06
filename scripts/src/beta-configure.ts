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
 *   c. auth — PATCH /config/auth, then GET and compare (exit 1 on any difference,
 *      before any flag is written).
 *   d. flags — one transaction sets every row and audits each flip.
 *   e. read-back — every row equals its target, or exit 1.
 *
 *   --dry-run  does (a) and (b), reads the auth config, prints the plan, and
 *              writes nothing.
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
  authConfigProblems,
  betaManagementClient,
  buildFlagApplySql,
  configureTargetRefusal,
  flagPolicyProblems,
  flagStateProblems,
  loadFlagPolicy,
  parseFlagRows,
  planFlagApply,
  seededFlagPopulation,
  type FetchLike,
  type FlagPolicy,
  type SeededFlag,
} from "./beta-config-core.js";

export interface ConfigureDeps {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  fetch: FetchLike;
  policy?: FlagPolicy;
  population?: ReadonlyMap<string, SeededFlag>;
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
    const before = parseFlagRows(await api.query(FLAG_STATE_SQL));
    const plan = planFlagApply(before, policy);
    if (plan.missing.length > 0) {
      return fail(
        `${plan.missing.length} policy flag(s) are not in public.feature_flags (${plan.missing.join(", ")}). ` +
          "Nothing was written — neither Auth nor any flag: the schema build has not landed, and a missing " +
          "invite_only_beta or disable_signups row would leave sign-up open.",
      );
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
  } catch (err) {
    return fail((err as Error).message);
  }
  log("\nbeta-configure PASSED — sign-up closed in Supabase Auth, redirects set, flags at policy, all read back.");
  return 0;
}

const RUN_DIRECTLY = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (RUN_DIRECTLY) {
  // THE TARGET GUARD, first, before any client or request.
  await import("../../artifacts/api-server/src/lib/ciSupabaseGuard.mjs");
  const code = await runBetaConfigure({ argv: process.argv.slice(2), env: process.env, fetch: fetch as unknown as FetchLike });
  process.exit(code);
}
