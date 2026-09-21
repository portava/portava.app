/**
 * Trust's read seams: three states, and callers that cannot fabricate a fourth.
 *
 * node:test + node:assert (NOT vitest). Judge by EXIT CODE.
 *
 * census-trust A17 recorded ELEVEN direct `trust_profiles` / `trust_caps` reads
 * outside `services/trust`, and C15 one direct `trust_restrictions` read in an
 * admin route — against two docblocks in the tree that forbid exactly that.
 *
 * The interesting half is WHY they existed. Three of them could not have
 * complied: the canonical helper was per-user where a feed needed a batch, the
 * enforcement seam answered in booleans where an admin dossier needed rows, and
 * `getActiveCaps` returns `[]` on failure where a boost gate needed to fail
 * closed. So the seam grew `getDisplayTrustScores`, `listRestrictionsForAudit`
 * and `getActiveCapsResult`, and this file pins what those three must do —
 * because every one of them replaced a read that FAILED OPEN, and a seam that
 * quietly does the same thing is worse than the reads it replaced: it is the
 * same defect with a rule pointing at it.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/trustSeamOwnership.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getDisplayTrustScores, getTrustProfileResult } from "../services/trust/TrustScoreService.js";
import { listRestrictionsForAudit } from "../services/trust/TrustRestrictionService.js";
import { getActiveCapsResult } from "../services/trust/TrustCapService.js";

const DB_ERROR = { message: "connection reset by peer", code: "08006" };
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** `errorTables` resolve with an error, exactly as PostgREST failures surface. */
function db(opts: { errorTables?: string[]; rows?: Record<string, any[]> } = {}) {
  const failing = new Set(opts.errorTables ?? []);
  const rows = opts.rows ?? {};
  function builder(table: string) {
    const isErr = failing.has(table);
    const settle = (single: boolean) =>
      isErr
        ? Promise.resolve({ data: null, error: DB_ERROR, count: null })
        : Promise.resolve(
            single
              ? { data: (rows[table] ?? [])[0] ?? null, error: null }
              : { data: rows[table] ?? [], error: null, count: (rows[table] ?? []).length },
          );
    const b: any = {
      select: () => b, eq: () => b, in: () => b, or: () => b, is: () => b,
      neq: () => b, gte: () => b, lte: () => b, order: () => b, limit: () => b,
      maybeSingle: () => settle(true), single: () => settle(true),
      then: (r: any) => settle(false).then(r),
    };
    return b;
  }
  return { from: (t: string) => builder(t) } as any;
}

describe("getDisplayTrustScores — the batch seam that replaced three fail-open reads", () => {
  it("an unreadable trust_profiles is UNAVAILABLE, not an empty score map", async () => {
    const r = await getDisplayTrustScores(db({ errorTables: ["trust_profiles"] }), [A, B]);
    assert.equal(r.state, "unavailable", "the three reads this replaced all rendered an outage as 'nobody has trust'");
  });

  it("a healthy read returns the scores it found — the empty map still means empty", async () => {
    const r = await getDisplayTrustScores(
      db({ rows: { trust_profiles: [{ user_id: A, overall_score: "72.4" }] } }),
      [A, B],
    );
    assert.equal(r.state, "ok");
    if (r.state !== "ok") return;
    assert.equal(r.scores.get(A), 72, "NUMERIC arrives as a string and is rounded like getDisplayTrustScore");
    assert.equal(r.scores.has(B), false, "a user with no row is ABSENT from the map, not defaulted to 50");
  });

  it("a row whose score is unparseable is absent rather than zero", async () => {
    const r = await getDisplayTrustScores(
      db({ rows: { trust_profiles: [{ user_id: A, overall_score: null }] } }),
      [A],
    );
    assert.equal(r.state, "ok");
    if (r.state !== "ok") return;
    assert.equal(r.scores.has(A), false, "null is not 0 and it is not 50");
  });

  it("no ids is an empty map and issues no query at all", async () => {
    const r = await getDisplayTrustScores(db({ errorTables: ["trust_profiles"] }), []);
    assert.equal(r.state, "ok", "an empty request cannot fail — it never reaches the table");
  });
});

describe("listRestrictionsForAudit — an EXCLUSION table must not render as a clean record", () => {
  it("an unreadable trust_restrictions is UNAVAILABLE, not zero restrictions", async () => {
    const r = await listRestrictionsForAudit(db({ errorTables: ["trust_restrictions"] }), A);
    assert.equal(
      r.state, "unavailable",
      "a fabricated clean record invites lifting a sanction that is still in force",
    );
  });

  it("a genuinely empty table is an empty list, which is a different answer", async () => {
    const r = await listRestrictionsForAudit(db({ rows: { trust_restrictions: [] } }), A);
    assert.equal(r.state, "ok");
    if (r.state !== "ok") return;
    assert.deepEqual(r.rows, []);
  });

  it("it returns the ROW, which is why the enforcement seam could not serve this caller", async () => {
    const r = await listRestrictionsForAudit(
      db({ rows: { trust_restrictions: [{ id: "r1", restriction_type: "hosting", reason: "spam", expires_at: null, lifted_at: null, created_at: "2026-01-01" }] } }),
      A,
    );
    assert.equal(r.state, "ok");
    if (r.state !== "ok") return;
    assert.equal(r.rows[0]!.reason, "spam", "getRestrictionState answers in booleans and has no reason to give");
  });
});

describe("getActiveCapsResult — the gate posture getActiveCaps cannot express", () => {
  it("an unreadable trust_caps is UNAVAILABLE, so a gate can fail closed", async () => {
    const r = await getActiveCapsResult(db({ errorTables: ["trust_caps"] }), A);
    assert.equal(r.state, "unavailable", "getActiveCaps returns [] here, which a gate cannot tell from 'no caps'");
  });

  it("no caps is still no caps", async () => {
    const r = await getActiveCapsResult(db({ rows: { trust_caps: [] } }), A);
    assert.equal(r.state, "ok");
    if (r.state !== "ok") return;
    assert.equal(r.caps.length, 0);
  });
});

describe("getTrustProfileResult keeps absent and unreadable apart", () => {
  it("unreadable is not absent", async () => {
    const r = await getTrustProfileResult(db({ errorTables: ["trust_profiles"] }), A);
    assert.equal(r.state, "unavailable");
  });

  it("absent is not unreadable", async () => {
    const r = await getTrustProfileResult(db({ rows: { trust_profiles: [] } }), A);
    assert.equal(r.state, "absent", "'New Traveler' is only honest for THIS state");
  });
});

describe("the callers actually go through the seams", () => {
  it("no file outside services/trust names a Trust table in executable code", async () => {
    // The guard is the enforcement; this asserts it is WIRED, so a green suite
    // cannot coexist with an unregistered checker.
    const { readFileSync } = await import("node:fs");
    const sh = readFileSync(new URL("../../scripts/run-all-checks.sh", import.meta.url), "utf8");
    assert.match(sh, /run_check "check:trust-table-ownership"/, "the guard must run in check:all, or the rule is a comment again");
    const pkg = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
    assert.match(pkg, /"check:trust-table-ownership"/);
  });
});
