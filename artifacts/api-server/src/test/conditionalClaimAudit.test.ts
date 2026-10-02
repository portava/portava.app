/**
 * CONDITIONAL_CLAIMS — the audit exemption that depends on the target database.
 *
 * WHAT THIS EXISTS FOR
 * --------------------
 * `audit:schema` (auditMigrationsVsLive.ts) reads every `CREATE` in a migration
 * as an unconditional promise that the object exists live. Migration 2976 breaks
 * that assumption on purpose: it REPAIRS `global_journey_shadow_stop_v1`, an
 * object authored in 2127 SECTION 9 on a branch that never merged and applied to
 * production out of band. Nothing in the canonical chain creates it, so on a
 * database built from the chain 2976 correctly creates NOTHING — and the auditor
 * then reported the function it had parsed out of the file as missing.
 *
 * The exemption must be narrow in one specific way, which is what cases (3) and
 * (4) below pin down: it may NOT become "never report this object missing".
 * Where the programme is installed — production — the claim is enforced in full,
 * so dropping the stop there is still drift. That is the whole point of keying
 * the condition on tables 2976 never creates rather than on the function itself.
 *
 * WHY THE LOGIC IS IMPORTED RATHER THAN RESTATED
 * ----------------------------------------------
 * auditMigrationsVsLive.ts cannot be imported: its first import is the
 * read-only Supabase front door, which exits 2 without credentials. The decision
 * therefore lives in lib/conditionalClaims.ts and is asserted here directly —
 * the same move #516 made for the migration-block predicates.
 *
 * Run: node --import tsx/esm --test src/test/conditionalClaimAudit.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONDITIONAL_CLAIMS,
  JOURNEY_PROGRAMME_TABLES,
  partitionClaims,
  staleEntries,
} from "../scripts/lib/conditionalClaims.js";
import type { Claim, LiveSchema } from "../scripts/lib/schemaClaimResolution.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_2976 = "2976_journey_shadow_global_stop_delete_scope.sql";
const STOP_KEY = "function:global_journey_shadow_stop_v1";
/**
 * The bare function name, DERIVED rather than written as a quoted literal.
 *
 * check:security-definer-oracles resolves a reference edge from any quoted
 * `"<name>"` token anywhere in src/, and treats it as something CALLING the
 * function. This function has no caller — that is the whole content of its
 * PENDING-OWNER entry in SECURITY_DEFINER_ORACLES.json — so a test about it
 * must not manufacture the weakest and most misleading kind of reference to it
 * and quietly suppress a real finding. `STOP_KEY` carries a colon, so it is not
 * a bare identifier token and the scanner does not read it as a call.
 */
const STOP_FN = STOP_KEY.slice("function:".length);

/** An empty live schema; individual cases add only what they mean to assert. */
function emptyLive(): LiveSchema {
  return {
    relations: new Set(),
    columns: new Set(),
    functions: new Set(),
    authzFunctions: new Set(),
    indexes: new Set(),
    policies: new Set(),
    enums: new Set(),
    enumValues: new Set(),
    triggers: new Set(),
  } as unknown as LiveSchema;
}

/** The live shape of PRODUCTION for this question: programme installed, stop present. */
function productionLike(): LiveSchema {
  const live = emptyLive();
  for (const t of JOURNEY_PROGRAMME_TABLES) live.relations.add(t);
  live.functions.add(STOP_FN);
  return live;
}

/** The live shape of portava-ci: no programme at all. Measured 2026-09-21. */
function portavaCiLike(): LiveSchema {
  return emptyLive();
}

const stopClaim: Claim = {
  kind: "function",
  key: STOP_KEY,
  label: "function global_journey_shadow_stop_v1",
} as unknown as Claim;

const NO_ALLOWLIST: ReadonlySet<string> = new Set<string>();

describe("CONDITIONAL_CLAIMS — audit exemptions that depend on the database", () => {
  it("(1) 2976 really does claim the stop, so the entry is not decoration", () => {
    // If this fails, the entry is stale and staleEntries() must catch it — see (5).
    const sql = readFileSync(
      resolve(__dirname, "../migrations", MIGRATION_2976),
      "utf8",
    );
    assert.match(
      sql,
      /CREATE OR REPLACE FUNCTION public\.global_journey_shadow_stop_v1/,
      "2976 must still spell out the canonical definition — that text is what the " +
        "auditor parses the claim from, and what this exemption is about",
    );
    const entry = CONDITIONAL_CLAIMS.find(
      (x) => x.file === MIGRATION_2976 && x.key === STOP_KEY,
    );
    assert.ok(entry, "2976's stop must have a CONDITIONAL_CLAIMS entry");
  });

  it("(2) on a chain-built database the claim does not apply, and says so out loud", () => {
    const { missing, notApplicable } = partitionClaims(
      MIGRATION_2976,
      [stopClaim],
      portavaCiLike(),
      NO_ALLOWLIST,
    );
    assert.deepEqual(missing, [], "2976 creates nothing where the programme is absent");
    assert.equal(notApplicable.length, 1, "the exemption must be reported, never silent");
    assert.match(notApplicable[0]!, /out-of-band 2127 journey-shadow programme/);
  });

  it("(3) THE EXEMPTION IS NOT 'never report this missing': on production a dropped stop is drift", () => {
    // The failure this guards against. Programme installed, function gone — e.g.
    // someone DROPs it, or a later migration replaces it with a different
    // signature. The auditor must still fail.
    const live = productionLike();
    live.functions.delete(STOP_FN);

    const { missing, notApplicable } = partitionClaims(
      MIGRATION_2976,
      [stopClaim],
      live,
      NO_ALLOWLIST,
    );
    assert.equal(
      missing.length,
      1,
      "where the journey tables exist the programme IS installed, so the stop must " +
        "exist too — exempting it here would hide the loss of a live safety control",
    );
    assert.deepEqual(notApplicable, []);
  });

  it("(4) one surviving programme table is enough to keep the claim enforced", () => {
    // `some`, not `every`: losing tables must not buy an escape from the audit.
    for (const table of JOURNEY_PROGRAMME_TABLES) {
      const live = emptyLive();
      live.relations.add(table); // just this one
      const { missing } = partitionClaims(
        MIGRATION_2976,
        [stopClaim],
        live,
        NO_ALLOWLIST,
      );
      assert.equal(
        missing.length,
        1,
        `${table} alone must still count as "the programme is installed here"`,
      );
    }
  });

  it("(5) an entry that matches no claim is a dead exemption and fails the run", () => {
    const matched = new Set<string>(); // nothing matched
    const stale = staleEntries(matched);
    assert.ok(
      stale.length > 0,
      "staleEntries must report entries that matched nothing — a dead exemption is " +
        "how a real gap gets carried for months",
    );

    const allMatched = new Set(
      CONDITIONAL_CLAIMS.map((x) => `${x.file}|${x.key}`),
    );
    assert.deepEqual(
      staleEntries(allMatched),
      [],
      "and it must report nothing when every entry matched",
    );
  });

  it("(6) the exemption is scoped to 2976 — it does not leak to other files", () => {
    const { missing, notApplicable } = partitionClaims(
      "2127_some_other_file.sql",
      [stopClaim],
      portavaCiLike(),
      NO_ALLOWLIST,
    );
    assert.equal(
      missing.length,
      1,
      "the same claim from a DIFFERENT file gets no exemption; entries are file-keyed",
    );
    assert.deepEqual(notApplicable, []);
  });

  it("(7) the allowlist still wins, and a present object is never reported", () => {
    const viaAllowlist = partitionClaims(
      MIGRATION_2976,
      [stopClaim],
      portavaCiLike(),
      new Set([STOP_KEY]),
    );
    assert.deepEqual(viaAllowlist.missing, []);
    assert.deepEqual(
      viaAllowlist.notApplicable,
      [],
      "an allowlisted claim is not also reported as conditionally inapplicable",
    );

    const present = partitionClaims(
      MIGRATION_2976,
      [stopClaim],
      productionLike(),
      NO_ALLOWLIST,
    );
    assert.deepEqual(present.missing, []);
    assert.deepEqual(present.notApplicable, []);
  });
});
