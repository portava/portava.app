/**
 * census-layover L159 / L161 — migrations 3789 and 3790 EXECUTED on the
 * replayed chain (CI's local-db job), not read as text.
 *
 *   D1        both flags seeded FALSE; each `$post$` passes run alone (the live
 *             applier runs it as a separate request).
 *   D2–D9     `airport_timing_fold_commit`, called as service_role (its only
 *             caller): OFF writes and deletes nothing; ON stores one verified
 *             band and deletes exactly its raw readings; a band below k = 10, a
 *             forged count, an unexpired reading, a future cutoff and a
 *             non-community reading are each refused, and a refusal commits
 *             nothing at all.
 *   D10–D15   the client boundary: anon/authenticated can neither read the
 *             table nor execute the door; the k-floor CHECK holds on a direct
 *             insert; service_role cannot rewrite a band.
 *   D16       the L159 sweep's two tables: service_role may delete, clients may not.
 *   D17–D20   the rollbacks refuse while ON / while a band exists, and drop
 *             exactly 3790's objects when allowed.
 *
 * Every case runs inside BEGIN … ROLLBACK (see airportTimingAggregatesCases.ts),
 * so nothing it plants, flips or drops survives it.
 *
 * Skips when LOCAL_DB_URL is unset; `scripts/local-db/run-tests.sh` is the run
 * that refuses skipped > 0. The authoring machine has no PostgreSQL: the same
 * case text was run on PGlite over a fixture of the touched objects (lane LAY-R
 * report); CI's job is its first run on the full chain.
 *
 * Run: bash scripts/local-db/up.sh && bash scripts/local-db/run-tests.sh
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HAVE_DB, psql } from "./localDb.js";
import { airportTimingDbCases } from "./airportTimingAggregatesCases.js";

describe("census-layover L159/L161 — 3789 and 3790 on a real database", { skip: !HAVE_DB }, () => {
  for (const c of airportTimingDbCases()) {
    it(`${c.id} ${c.name}`, () => {
      const r = psql(`BEGIN;\n${c.sql}\nROLLBACK;\n`);
      if (c.error) {
        assert.notEqual(r.status, 0, `${c.id} must be refused, and was not`);
        assert.match(r.stderr, c.error, `${c.id} was refused for the wrong reason:\n${r.stderr}`);
      } else {
        assert.equal(r.status, 0, `${c.id} failed:\n${r.stderr}`);
      }
    });
  }
});
