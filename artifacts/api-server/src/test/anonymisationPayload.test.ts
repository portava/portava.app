/**
 * Account-deletion anonymisation payload — the NOT NULL contract.
 *
 * The property under test: no UPDATE in the deletion path may set a column the
 * schema declares NOT NULL to null. The original defect (`handle: null` against
 * `profiles.handle text NOT NULL UNIQUE`) was invisible to the existing suite
 * because those tests mock the Supabase client — a mocked .update() happily
 * accepts a payload the real column constraint rejects with 23502. So these
 * tests assert against the committed BASELINE SCHEMA rather than a mock.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BASELINE_PATH, notNullColumns } from "../scripts/parseBaselineSchema.js";
import { extractUpdatePayloads } from "../scripts/checkAnonymisationPayload.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const SERVICE_SRC = readFileSync(
  resolve(__dir, "../services/accountDeletion/AccountDeletionService.ts"), "utf8",
);
const BASELINE_SQL = readFileSync(BASELINE_PATH, "utf8");

describe("baseline nullability parser", () => {
  it("reads NOT NULL columns for a table", () => {
    const nn = notNullColumns(BASELINE_SQL, "profiles");
    assert.ok(nn.has("handle"), "profiles.handle is NOT NULL in the baseline");
    assert.ok(nn.has("name"), "profiles.name is NOT NULL in the baseline");
    assert.ok(!nn.has("username"), "profiles.username is nullable — must not be reported");
    assert.ok(!nn.has("bio"), "profiles.bio is nullable — must not be reported");
  });

  it("does not bleed into the next CREATE TABLE", () => {
    const sql = [
      "CREATE TABLE public.alpha (", "    a text NOT NULL,", "    b text", ");",
      "CREATE TABLE public.beta (", "    c text NOT NULL", ");",
    ].join("\n");
    assert.deepEqual([...notNullColumns(sql, "alpha")], ["a"]);
    assert.deepEqual([...notNullColumns(sql, "beta")], ["c"]);
  });

  it("returns empty for a table absent from the dump", () => {
    assert.equal(notNullColumns(BASELINE_SQL, "no_such_table_anywhere").size, 0);
  });
});

describe("account deletion — no UPDATE nulls a NOT NULL column", () => {
  const payloads = extractUpdatePayloads(SERVICE_SRC);

  it("finds the payloads at all — a vacuous check is worse than none", () => {
    assert.ok(payloads.length > 0, "extractor found no .update() payload; it is stale");
    assert.ok(payloads.some((p) => p.table === "profiles"), "the profiles anonymisation payload was not found");
  });

  it("no nulled key is NOT NULL in the baseline", () => {
    for (const p of payloads) {
      const nn = notNullColumns(BASELINE_SQL, p.table);
      for (const col of p.nulled) {
        assert.ok(!nn.has(col),
          `${p.table}.${col} is NOT NULL but the deletion payload nulls it — this raises 23502 at runtime`);
      }
    }
  });

  it("the profiles payload still satisfies handle: NOT NULL and UNIQUE", () => {
    // Regression: this exact key was `null`, which aborted every deletion after
    // the irreversible content steps had already run.
    const m = /handle:\s*(`[^`]*`|null)/.exec(SERVICE_SRC);
    assert.ok(m, "no handle assignment found in the deletion payload");
    assert.notEqual(m![1], "null", "handle is null again — deletion will fail with 23502");
    assert.ok(m![1].includes("userId"),
      "handle must derive from userId: the column is UNIQUE, and deriving it keeps the retried step idempotent");
  });
});
