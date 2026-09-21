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

/**
 * BOTH writers, not just the route file.
 *
 * `trust-admin.ts` used to carry two `trust_admin_actions` inserts. The
 * cap/override route's own insert is gone: that route now delegates to
 * `TrustAdminService.adminRemoveOverride`, so ONE action writes ONE audit row
 * instead of the route and the service each writing their own. The guard
 * follows the write rather than shrinking with the file — it now covers the
 * service's `logAdminAction`, which is where every trust admin audit row that
 * is not the settings edit is now written.
 */
const AUDIT_WRITERS: Array<{ label: string; path: string; minInserts: number }> = [
  { label: "routes/trust-admin.ts", path: join(__dir, "..", "routes", "trust-admin.ts"), minInserts: 1 },
  { label: "services/trust/TrustAdminService.ts", path: join(__dir, "..", "services", "trust", "TrustAdminService.ts"), minInserts: 1 },
];

// Verified 2026-07-21 via Supabase Management API.
const TRUST_ADMIN_ACTIONS_COLUMNS = new Set([
  "id", "admin_id", "target_user", "action_type", "source_id", "reason",
  "metadata", "created_at",
]);

for (const writer of AUDIT_WRITERS) {
  describe(`trust_admin_actions insert-payload schema drift (${writer.label})`, () => {
    const source = readFileSync(writer.path, "utf8");
    const refs = extractInsertPayloadKeys(source, "trust_admin_actions");

    it("finds the audit-log insert payloads (guard is actually wired)", () => {
      const inserts = new Set(refs.map((r) => r.index));
      assert.ok(
        inserts.size >= writer.minInserts,
        `expected >= ${writer.minInserts} trust_admin_actions insert payload(s) with ` +
          `object-literal keys in ${writer.label}, found ${inserts.size} — if inserts ` +
          `moved or became dynamic, update this guard`,
      );
      // Sanity: the known payload shape is present.
      const keys = new Set(refs.map((r) => r.column));
      for (const expected of ["admin_id", "target_user", "action_type", "reason", "metadata"]) {
        assert.ok(keys.has(expected), `expected payload key "${expected}" not extracted from ${writer.label}`);
      }
    });

    it("every insert payload key exists in the live trust_admin_actions schema", () => {
      const bad = refs.filter((r) => !TRUST_ADMIN_ACTIONS_COLUMNS.has(r.column));
      assert.deepEqual(
        bad.map((r) => `${r.column} (.${r.method} at line ${lineOf(source, r.index)})`),
        [],
        `${writer.label} writes columns that do not exist in the live ` +
          `trust_admin_actions table — the whole insert would fail (PGRST204) ` +
          `and audit logging would silently stop`,
      );
    });
  });
}

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

/**
 * IDF-53 — `score_override` is a VOCABULARY, and the settings route was
 * polluting it.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * `docs/trust/identity-foundation-checklist.md` states it: the trust-SETTINGS
 * route filed its audit row under `action_type: "score_override"`, so a query
 * for *"who overrode a user's score"* returned settings edits. Two different
 * administrative acts under one name is not a cosmetic problem — an audit log
 * whose vocabulary conflates two acts cannot answer the question it exists for,
 * and the answer it gives instead is WRONG rather than missing.
 *
 * It was visible in the row's own data. The settings insert sets
 * `target_user: adminId` — the admin auditing themselves — because a settings
 * edit HAS no target user. A `score_override` row whose target is its own
 * author is a contradiction the schema happily stored.
 *
 * ── WHY THIS IS A MIGRATION AND NOT A RENAME ────────────────────────────────
 * `trust_admin_actions_action_type_check` (baseline, line 10887) constrains the
 * column to nine literals, and `update_setting` is not among them. The
 * checklist's own verification section recorded this and called the refusal
 * correct, then added the part that matters:
 *
 *   "worse than stated: supabase-js RESOLVES on a DB error, so the 23514 would
 *    not even reach the swallowed catch. The rename would have produced NO
 *    AUDIT ROW AT ALL."
 *
 * Renaming without `2940` would have replaced a mislabelled audit row with no
 * audit row, silently, on every settings edit — trading a wrong answer for no
 * answer and losing the ability to tell. So the migration ships first and this
 * guard pins both halves.
 *
 * WHAT IS ASSERTED, and why each is separate:
 *  (1) The settings route no longer writes `score_override`. The defect itself.
 *  (2) It writes `update_setting`. Without this, deleting the audit insert
 *      entirely would pass (1).
 *  (3) Every `action_type` literal either writer uses is admitted by the live
 *      CHECK — which is what makes (2) safe rather than a 23514 waiting for
 *      the first settings edit in production.
 *  (4) `score_override` rows are written by `logAdminAction` and nowhere else,
 *      so the vocabulary means one thing.
 *  (5) The audit write's failure is no longer discarded. A fire-and-forget
 *      insert whose result is thrown away is how (1) survived: nothing could
 *      have told anyone.
 */
const ACTION_TYPE_LITERAL = /action_type:\s*"([a-z_]+)"/g;

describe("IDF-53 — the score_override audit vocabulary means one thing", () => {
  const routeSrc = readFileSync(join(__dir, "..", "routes", "trust-admin.ts"), "utf8");
  const serviceSrc = readFileSync(join(__dir, "..", "services", "trust", "TrustAdminService.ts"), "utf8");

  it("(1) the SETTINGS route no longer files its edit as a score override", () => {
    // The settings handler is the only place in the route file that inserts an
    // audit row for a settings change; the route's own `score_override` insert
    // is gone (it delegates to the service). So any `score_override` literal
    // left in this file is the defect.
    const literals = [...routeSrc.matchAll(ACTION_TYPE_LITERAL)].map((m) => m[1]);
    assert.ok(
      !literals.includes("score_override"),
      `routes/trust-admin.ts still writes action_type: "score_override" — a query for ` +
        `"who overrode a user's score" answers with settings edits, and the row's own ` +
        `target_user is the admin who wrote it`,
    );
  });

  it("(2) it files under its own action type instead", () => {
    const literals = [...routeSrc.matchAll(ACTION_TYPE_LITERAL)].map((m) => m[1]);
    assert.ok(
      literals.includes("update_setting"),
      `routes/trust-admin.ts writes no update_setting audit row — deleting the insert ` +
        `is not the fix; a settings edit that leaves no trace is worse than one filed ` +
        `under the wrong name. found: ${JSON.stringify(literals)}`,
    );
  });

  // (3) WAS HERE and is gone. It asserted that every action_type literal is
  // admitted by the live CHECK — which is, line for line, what
  // `trustAdminActionVocabulary.test.ts` already does, against both writers,
  // with its own positive controls. Two guards over one property means one of
  // them can rot silently while the other stays green, and the one I would have
  // been duplicating is the better of the two: it also types the
  // `AdminActionType` union and every logAdminAction call site. The allowlist
  // constant it needed went with it.
  //
  // That guard CAUGHT this change, which is the point worth recording: adding
  // `update_setting` to the source turned it red before anything reached a
  // database, and its own positive controls had been using `update_setting` as
  // their example of an unadmitted value — so 2940 quietly made three controls
  // pass for a reason unrelated to what they test. They now use a literal no
  // migration has ever admitted.

  it("(4) score_override is written by logAdminAction and nowhere else", () => {
    assert.ok(
      /logAdminAction\([^)]*"score_override"/s.test(serviceSrc),
      "the canonical score-override audit row is no longer written by logAdminAction",
    );
    assert.ok(
      ![...routeSrc.matchAll(ACTION_TYPE_LITERAL)].map((m) => m[1]).includes("score_override"),
      "a second writer of score_override re-opens exactly the ambiguity IDF-53 names",
    );
  });

  it("(5) the settings audit write BINDS its own error", () => {
    // Scoped to the audit insert, not the file. My first version of this case
    // asserted that `.catch(() => {})` appears nowhere in trust-admin.ts, and
    // it stayed red against the fixed code for TWO reasons, neither of them the
    // defect: the phrase occurs in the comment I had just written explaining
    // why it was removed, and it occurs again at the trust-score RECALCULATION
    // SWEEP, which is a different swallowed failure and not IDF-53's. A guard
    // whose red can be caused by prose is measuring the wrong thing.
    //
    // REPORTED, NOT WIDENED INTO: the recalculation sweep still discards its
    // own failure, so a settings change whose recalculation never ran looks
    // identical to one that did. That is a real finding and it belongs to
    // whoever owns the sweep, not to this row.
    const at = routeSrc.indexOf('action_type: "update_setting"');
    assert.ok(at > 0, "the update_setting audit insert is gone — case (2) should have caught this first");
    // The statement it sits in: back to the `.insert(` that opens it, forward
    // past the closing `});`.
    const start = routeSrc.lastIndexOf(".insert(", at);
    const end = routeSrc.indexOf("});", at);
    assert.ok(start > 0 && end > at, "could not locate the audit insert statement");
    const stmt = routeSrc.slice(Math.max(0, start - 200), end);
    assert.match(
      stmt, /const\s*\{\s*error\s*:/,
      "the audit insert does not BIND its error. supabase-js RESOLVES on a database " +
        "failure, so a refused insert is byte-identical to a written one and the row's " +
        "absence is invisible — which is how the wrong action_type survived to become a " +
        "checklist row in the first place",
    );
  });
});
