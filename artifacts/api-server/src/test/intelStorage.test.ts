/**
 * IG-02 storage — structural contract of migration 2130.
 *
 * Asserts properties of the migration text and its wiring, because the
 * properties being protected ARE structural: which tables are append-only, which
 * are deliberately not, that erasure has exactly one path, and that the tables
 * ruled out in A0 were not created after all.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ERASED_BY_CASCADE, POST_BASELINE_TABLES } from "../lib/deletionDispositions.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SQL = readFileSync(join(HERE, "../migrations/2130_intel_storage.sql"), "utf8");
const SERVICE = readFileSync(join(HERE, "../services/accountDeletion/AccountDeletionService.ts"), "utf8");

const APPEND_ONLY = ["intel_observations", "intel_evidence", "intel_confirmations"];
const DERIVED = ["intel_claims", "intel_state_snapshots"];

describe("IG-02 — what is created", () => {
  it("creates exactly the five tables", () => {
    for (const t of [...APPEND_ONLY, ...DERIVED]) {
      assert.match(SQL, new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${t}\\b`), `${t} not created`);
    }
    assert.equal((SQL.match(/CREATE TABLE IF NOT EXISTS/g) ?? []).length, 5);
  });

  it("does NOT create the four tables A0 ruled out as duplicates", () => {
    for (const t of ["intel_outcomes", "intel_expertise_scopes", "intel_coverage_cells", "intel_missions"]) {
      assert.doesNotMatch(SQL, new RegExp(`CREATE TABLE[^\\n]*${t}\\b`), `${t} would duplicate an existing system`);
    }
  });

  it("keys subjects to canonical places, not an untyped string", () => {
    assert.match(SQL, /subject_id\s+uuid NOT NULL REFERENCES public\.places\(id\)/);
  });
});

describe("IG-02 — append-only where it belongs, and not where it does not", () => {
  it("guards the three record tables", () => {
    for (const t of APPEND_ONLY) {
      assert.ok(SQL.includes(`'${t}'`), `${t} missing from the trigger loop`);
    }
    assert.match(SQL, /ARRAY\['intel_observations','intel_evidence','intel_confirmations'\]/);
  });

  it("leaves derived tables updatable — a claim is superseded, a snapshot recomputed", () => {
    const triggerBlock = SQL.slice(SQL.indexOf("APPEND-ONLY ENFORCEMENT"), SQL.indexOf("RLS AND GRANTS"));
    for (const t of DERIVED) {
      assert.ok(!triggerBlock.includes(`'${t}'`), `${t} must not be append-only or projection is impossible`);
    }
    assert.match(SQL, /GRANT INSERT, SELECT, UPDATE ON public\.intel_claims/);
  });

  it("UPDATE has no escape hatch — only DELETE does", () => {
    const fn = SQL.slice(SQL.indexOf("CREATE OR REPLACE FUNCTION public.intel_append_only()"), SQL.indexOf("intel_append_only_stmt"));
    assert.match(fn, /IF TG_OP = 'DELETE'[\s\S]*erasure_in_progress/, "DELETE must consult the erasure declaration");
    // the final RAISE covers UPDATE unconditionally
    assert.match(fn, /RAISE EXCEPTION\s*\n?\s*'% is append-only: % is not permitted/);
  });
});

describe("IG-02 — erasure is possible, auditable, and singular", () => {
  it("provides exactly one erasure entry point, granted only to service_role", () => {
    assert.match(SQL, /CREATE OR REPLACE FUNCTION public\.erase_intel_for_actor\(p_actor_id uuid\)/);
    assert.match(SQL, /SECURITY DEFINER/);
    assert.match(SQL, /GRANT EXECUTE ON FUNCTION public\.erase_intel_for_actor\(uuid\) TO service_role/);
    assert.match(SQL, /REVOKE ALL ON FUNCTION public\.erase_intel_for_actor\(uuid\) FROM authenticated/);
  });

  it("the erasure declaration is transaction-scoped, not connection-scoped", () => {
    assert.match(SQL, /set_config\('portava\.erasure_in_progress', 'on', true\)/,
      "the third argument must be true (SET LOCAL) or the permission leaks to later work");
  });

  it("does not delete derived claims — they are other people's contributions too", () => {
    const fn = SQL.slice(SQL.indexOf("erase_intel_for_actor"));
    assert.doesNotMatch(fn.slice(0, fn.indexOf("$$;")), /DELETE FROM public\.intel_claims/);
  });

  it("the account-deletion worker actually calls it", () => {
    assert.match(SERVICE, /erase_intel_for_actor/, "the intel tables would silently survive account deletion");
    assert.match(SERVICE, /sc\.rpc\("erase_intel_for_actor"/);
  });

  it("the new tables are registered as erased on day one", () => {
    for (const t of [...APPEND_ONLY, ...DERIVED]) {
      assert.ok(ERASED_BY_CASCADE.includes(t), `${t} is not in the deletion manifest`);
      assert.ok(POST_BASELINE_TABLES.includes(t), `${t} must be declared post-baseline`);
    }
  });
});

describe("IG-02 — deny-default access", () => {
  it("revokes before granting, per the 2093 grant fix", () => {
    assert.match(SQL, /REVOKE ALL ON public\.%I FROM service_role/);
    const revokeIdx = SQL.indexOf("REVOKE ALL ON public.%I FROM service_role");
    const grantIdx = SQL.indexOf("GRANT INSERT, SELECT ON public.intel_observations");
    assert.ok(revokeIdx < grantIdx, "a bare GRANT after Supabase default privileges establishes no limit");
  });

  it("anon gets nothing and authenticated sees only its own rows", () => {
    assert.match(SQL, /REVOKE ALL ON public\.%I FROM anon/);
    assert.match(SQL, /intel_observations_select_own[\s\S]*USING \(actor_id = auth\.uid\(\)\)/);
    assert.doesNotMatch(SQL, /GRANT[^\n]*ON public\.intel_state_snapshots TO authenticated/,
      "projected state must reach clients through a server-controlled projection");
  });

  it("the trigger functions are not callable over REST", () => {
    // Regression: Postgres grants EXECUTE to PUBLIC by default on every new
    // function, so without these the trigger functions land in the same
    // anon-executable class this codebase has been clearing out.
    // intel_append_only_stmt() was removed by 2137 — a statement-level BEFORE
    // trigger fires even when zero rows would be deleted, so it refused any
    // cascade that merely TOUCHED the table and broke the live-DB RLS suite's
    // fixture teardown. The row-level guard is the one that matters and remains.
    for (const fn of ["intel_append_only()"]) {
      assert.ok(SQL.includes(`REVOKE ALL ON FUNCTION public.${fn} FROM PUBLIC`), `${fn}: no PUBLIC revoke`);
      assert.ok(SQL.includes(`REVOKE ALL ON FUNCTION public.${fn} FROM anon`), `${fn}: no anon revoke`);
    }
  });

  it("privacy_eligible defaults false", () => {
    assert.match(SQL, /privacy_eligible boolean NOT NULL DEFAULT false/);
  });
});
