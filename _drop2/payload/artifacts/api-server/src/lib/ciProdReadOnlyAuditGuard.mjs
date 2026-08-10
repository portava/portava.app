/**
 * ciProdReadOnlyAuditGuard.mjs — THE CHOKEPOINT, for the read-only audits.
 * Imported for its side effect, first, exactly like src/lib/ciSupabaseGuard.mjs.
 *
 * WHO MAY IMPORT THIS FILE
 * ========================
 *
 *   src/scripts/auditMigrationsVsLive.ts    SELECTs on pg catalogs
 *   src/scripts/checkMissingLiveColumns.ts  SELECTs on information_schema
 *   src/scripts/checkMediaObjects.ts        reads post_media + storage.objects
 *   src/scripts/checkWritePathColumns.ts    TypeScript AST + one SELECT on
 *                                           profiles
 *   src/scripts/checkDiscoveryCacheKeys.ts  SELECTs on discovery_cache, plus a
 *                                           SELECT and a WITH-prefixed SELECT
 *                                           aggregating rank_events
 *
 * That list, and nothing else. The list is not advice: scripts/check-guard-
 * coverage.mjs fails the build if any other file imports this module, and fails
 * if one of them stops importing it. Each was read before being
 * moved here, and each issues SELECTs only — no INSERT, no UPDATE, no DELETE,
 * no DDL, no auth admin call.
 *
 * WHAT THIS FILE IS FOR
 * =====================
 *
 * These audits are the reason this repo knows what its live drift is. Auditing
 * PRODUCTION is their primary purpose. Under the uniform guard they could not
 * do it: the Replit workspace's SUPABASE_URL points at production
 * (.replit:148), so `check:all` failed there on every run, and the honest
 * workaround would have been to stop running them.
 *
 * So this front door is the strict rule PLUS one narrow mode. In CI, and in
 * every environment that does not deliberately ask for the mode, it behaves
 * EXACTLY like src/lib/ciSupabaseGuard.mjs: it runs
 * .github/scripts/assert-nonprod-supabase.sh and exits 2 on any refusal. The
 * mode is additional, and it is available only when all of the following hold:
 *
 *   * no CI marker variable is PRESENT in the environment — the named list in
 *     src/lib/supabaseTargetPolicy.mjs plus every GITHUB_*, RUNNER_* and
 *     ACTIONS_* variable. Presence alone refuses, whatever the value. No
 *     workflow reaches this mode by accident, by inheriting an `env:` block or
 *     by setting one variable; the residual — a `run:` step that explicitly
 *     unsets the whole runner environment first — is stated in that file and in
 *     docs/ci/README.md rather than claimed away;
 *   * PORTAVA_PROD_READ_ONLY_AUDIT is set to exactly
 *     'read-only-audit-against-production' — a sentence, not "1" or "true";
 *   * KNOWN_PROD_PROJECT_REF is set and is a bare project ref;
 *   * SUPABASE_URL parses, and the ref it resolves to IS the declared
 *     production ref. The mode permits that one target and no other.
 *
 * WHAT IT IS NOT
 * ==============
 *
 * It is not a way to disable the guard, and there is still no such thing. The
 * write-capable entry points — the rank_events INSERT probe and the three RLS
 * suites — import src/lib/ciSupabaseGuard.mjs, which hard-codes the strict
 * mode; the mode below is not reachable from them by any variable, and setting
 * PORTAVA_PROD_READ_ONLY_AUDIT in one of those processes makes it refuse rather
 * than proceed.
 *
 * It is also not a claim that a production read is harmless. It is a claim that
 * these processes only read, that the operator asked for it in a sentence
 * they had to mean to type, and that no automated build can do the same.
 *
 * Every refusal exits 2, unchanged: see the EXIT CODE 2, DELIBERATELY section
 * in src/lib/ciSupabaseGuard.mjs. All of these scripts already document 2
 * as "environment / API error — cannot run".
 */

import {
  MODE_PROD_READ_ONLY_AUDIT,
  assertSupabaseTarget,
} from "./supabaseTargetPolicy.mjs";

// The mode is a hard-coded constant, exactly as in the strict front door. What
// differs between the two files is this one argument, and that is the whole of
// the difference between "the CI project only" and "the CI project, or a
// read-only audit of declared production from a terminal".
assertSupabaseTarget(MODE_PROD_READ_ONLY_AUDIT, "ciProdReadOnlyAuditGuard");
