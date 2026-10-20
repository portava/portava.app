import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { findServerOnlyTableBreaches, SERVER_ONLY_TABLES } from "../scripts/lib/serverOnlyTables.js";
import { loadContract } from "../security/authorizationContract.js";

const stores = [
  ["memory_snapshots", "3990_memory_snapshots.sql"],
  ["memory_video_segments", "3991_memory_video_segments.sql"],
  ["memory_video_segment_operations", "3991_memory_video_segments.sql"],
  ["memory_import_batches", "3992_memory_import_batches.sql"],
  ["memory_import_batch_items", "3992_memory_import_batches.sql"],
  ["memory_resurfacing_policy_heads", "3993_owner_resurfacing_policy.sql"],
] as const;

describe("private Memory infrastructure client boundary", () => {
  for (const [table, migration] of stores) {
    describe(table, () => {
      const schema = { name: migration, sql: readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8") };
      const registered = SERVER_ONLY_TABLES.filter((entry) => entry.table === table);

      it("is explicitly protected in both offline and live authorization contracts", () => {
        assert.equal(registered.length, 1);
        assert.equal(registered[0]!.closedBy, migration);
        const contract = loadContract().tables[table];
        assert.ok(contract);
        assert.deepEqual([contract.tableGrants, contract.insertCols, contract.updateCols], [{}, {}, {}]);
        const result = findServerOnlyTableBreaches([schema], "", { realTree: true, tables: registered });
        assert.deepEqual(result.findings, []);
        assert.deepEqual(result.vacuity, []);
      });

      for (const role of ["anon", "authenticated", "PUBLIC"]) {
        it(`rejects a later direct read granted to ${role}`, () => {
          assert.equal(registered.length, 1);
          const result = findServerOnlyTableBreaches([
            schema, { name: "9999_test_only_reopen.sql", sql: `GRANT SELECT ON public.${table} TO ${role};` },
          ], "", { realTree: true, tables: registered });
          assert.deepEqual(result.vacuity, []);
          assert.ok(result.findings.some((finding) => finding.table === table && /holding SELECT/.test(finding.message)));
        });
      }

      it("rejects later direct writes even when RLS is enabled", () => {
        assert.equal(registered.length, 1);
        const result = findServerOnlyTableBreaches([
          schema, { name: "9999_test_only_reopen.sql", sql: `GRANT INSERT, UPDATE, DELETE ON public.${table} TO authenticated;` },
        ], "", { realTree: true, tables: registered });
        assert.deepEqual(result.vacuity, []);
        assert.ok(result.findings.some((finding) => finding.table === table && /holding/.test(finding.message)));
      });
    });
  }
});
