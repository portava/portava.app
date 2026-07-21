/**
 * Write-path schema-drift guard for the trust admin audit log
 * (trust_admin_actions inserts in trust-admin.ts).
 *
 * The read-path drift guards (adminRemainingDashboardsSchemaDrift.test.ts
 * etc.) only cover select/filter chains — but trust-admin.ts only ever
 * INSERTs into trust_admin_actions. PostgREST fails the WHOLE insert on a
 * single unknown payload key (PGRST204), and one of these inserts is
 * fire-and-forget with a swallowed .catch(), so a drifted column would
 * silently stop admin actions from being recorded.
 *
 * This test statically extracts the object-literal payload keys of every
 * .insert()/.upsert()/.update() rooted at .from("trust_admin_actions") and
 * asserts each key exists in the LIVE column list.
 *
 * Live column list verified 2026-07-21 via the Supabase Management API
 * (information_schema.columns, table_schema='public').
 *
 * Run: node --import tsx/esm --test src/test/trustAdminAuditInsertSchemaDrift.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { extractInsertPayloadKeys, lineOf } from "./helpers/schemaColumnExtractor.ts";

const __dir = dirname(fileURLToPath(import.meta.url));
const routeFile = join(__dir, "..", "routes", "trust-admin.ts");

// Verified 2026-07-21 via Supabase Management API.
const TRUST_ADMIN_ACTIONS_COLUMNS = new Set([
  "id", "admin_id", "target_user", "action_type", "source_id", "reason",
  "metadata", "created_at",
]);

describe("trust_admin_actions insert-payload schema drift (trust-admin.ts)", () => {
  const source = readFileSync(routeFile, "utf8");
  const refs = extractInsertPayloadKeys(source, "trust_admin_actions");

  it("finds the audit-log insert payloads (guard is actually wired)", () => {
    const inserts = new Set(refs.map((r) => r.index));
    assert.ok(
      inserts.size >= 2,
      `expected >= 2 trust_admin_actions insert payloads with object-literal ` +
        `keys, found ${inserts.size} — if inserts moved or became dynamic, ` +
        `update this guard`,
    );
    // Sanity: the known payload shape is present.
    const keys = new Set(refs.map((r) => r.column));
    for (const expected of ["admin_id", "target_user", "action_type", "reason", "metadata"]) {
      assert.ok(keys.has(expected), `expected payload key "${expected}" not extracted`);
    }
  });

  it("every insert payload key exists in the live trust_admin_actions schema", () => {
    const bad = refs.filter((r) => !TRUST_ADMIN_ACTIONS_COLUMNS.has(r.column));
    assert.deepEqual(
      bad.map((r) => `${r.column} (.${r.method} at line ${lineOf(source, r.index)})`),
      [],
      `trust-admin.ts writes columns that do not exist in the live ` +
        `trust_admin_actions table — the whole insert would fail (PGRST204) ` +
        `and audit logging would silently stop`,
    );
  });
});

describe("extractInsertPayloadKeys extractor", () => {
  it("extracts depth-1 keys only, skips nested objects and spreads", () => {
    const src = `
      await sc.from("t").insert({
        a: 1,
        b: { nested: true, deep: { x: 1 } },
        c: [ { arr_obj: 1 } ],
        d,
        ...spread,
        e: fn(x, { call_arg: 1 }),
      });
    `;
    const keys = extractInsertPayloadKeys(src, "t").map((r) => r.column);
    assert.deepEqual(keys.sort(), ["a", "b", "c", "d", "e"]);
  });

  it("handles array-of-objects payloads and string values with braces", () => {
    const src = `sc.from("t").insert([{ a: "}{", b: 2 }, { c: 3 }]);`;
    const keys = extractInsertPayloadKeys(src, "t").map((r) => r.column);
    assert.deepEqual(keys.sort(), ["a", "b", "c"]);
  });

  it("skips non-literal payloads (variables)", () => {
    const src = `sc.from("t").insert(payload);`;
    assert.deepEqual(extractInsertPayloadKeys(src, "t"), []);
  });

  it("follows chains after other methods and ignores other tables", () => {
    const src = `
      sc.from("other").insert({ zzz: 1 });
      Promise.resolve().then(() =>
        sc.from("t").insert({ a: 1, b: 2 }),
      ).catch(() => {});
    `;
    const keys = extractInsertPayloadKeys(src, "t").map((r) => r.column);
    assert.deepEqual(keys.sort(), ["a", "b"]);
  });
});
