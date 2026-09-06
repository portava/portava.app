/**
 * WRITE-side dead-literal contract — the other half of `check:enum-literals`.
 *
 * THE CLASS
 * ---------
 * The filter side of this check has been guarding "a query names a literal its
 * column cannot hold" since the 32-site audit. Nothing looked at what the code
 * WRITES, and the write half is worse:
 *
 *   filter — an enum throws 22P02 and kills the query; a text CHECK silently
 *            matches nothing. The data is merely unread.
 *   write  — an enum throws 22P02, a text CHECK throws 23514. THE ROW IS
 *            REJECTED. And in this repo the rejection is nearly always swallowed
 *            by a fire-and-forget `catch {}` or a `logger.warn`, so the feature
 *            looks implemented and is permanently inert.
 *
 * Thirteen distinct defects were found the day this landed, including an admin
 * suspend route and an admin ban route that could never succeed.
 *
 * WHAT WOULD MAKE THIS SUITE VACUOUS
 * ----------------------------------
 * Three ways, each with a control below:
 *   1. the extractor stops finding write sites  -> productivity floors
 *   2. it resolves forwarded literals no more   -> the geofence/circle controls
 *   3. it starts GUESSING and over-reports      -> the bail table, which is the
 *      half that matters, because a false failure blocks unrelated work and is
 *      the one outcome this check must never have.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractWriteLiterals, stringsOf } from "../scripts/lib/writeLiteralExtract.js";
import {
  buildCanonicalVocabulary,
  vocabularyFromCheck,
  stripSqlLineComments,
  type CanonicalVocabulary,
} from "../scripts/lib/canonicalVocabulary.js";
import {
  findDeadLiterals,
  isWriteOp,
  API_ROOT,
  SCAN_DIRS,
  BASELINE,
  MIGRATION_DIRS,
} from "../scripts/checkEnumLiterals.js";

let cachedVocab: CanonicalVocabulary | null = null;
const vocab = (): CanonicalVocabulary =>
  (cachedVocab ??= buildCanonicalVocabulary(BASELINE, MIGRATION_DIRS));

let cachedWrites: ReturnType<typeof extractWriteLiterals> | null = null;
const writes = () => (cachedWrites ??= extractWriteLiterals(SCAN_DIRS, API_ROOT));

/** Run the extractor over a throwaway file and return its sites. */
function onSource(source: string): ReturnType<typeof extractWriteLiterals>["sites"] {
  const dir = mkdtempSync(join(tmpdir(), "write-lit-"));
  try {
    mkdirSync(join(dir, "routes"), { recursive: true });
    writeFileSync(join(dir, "routes", "f.ts"), source);
    return extractWriteLiterals([join(dir, "routes")], dir).sites;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const found = (src: string, column: string): string[] =>
  onSource(src).filter((s) => s.column === column).map((s) => s.literal).sort();

describe("write-literal extraction — the shapes it judges", () => {
  it("reads a string literal straight out of an insert payload", () => {
    const sites = onSource(`
      export async function go(db: any) {
        await db.from("widgets").insert({ state: "shipped", n: 1 });
      }
    `);
    assert.equal(sites.length, 1);
    assert.equal(sites[0]!.table, "widgets");
    assert.equal(sites[0]!.column, "state");
    assert.equal(sites[0]!.literal, "shipped");
    assert.equal(sites[0]!.op, "insert");
  });

  it("judges update and upsert, and records which one", () => {
    assert.deepEqual(
      onSource(`export const a = async (db:any) => { await db.from("t").update({ s: "x" }); };`)
        .map((s) => s.op), ["update"],
    );
    assert.deepEqual(
      onSource(`export const b = async (db:any) => { await db.from("t").upsert({ s: "x" }); };`)
        .map((s) => s.op), ["upsert"],
    );
  });

  it("judges every element of an array payload", () => {
    assert.deepEqual(
      found(`export const f = async (db:any) => { await db.from("t").insert([{ s: "a" }, { s: "b" }]); };`, "s"),
      ["a", "b"],
    );
  });

  it("resolves a ternary of literals, and refuses a half-literal one", () => {
    assert.deepEqual(
      found(`export const f = async (db:any, late:boolean) => { await db.from("t").insert({ s: late ? "l" : "e" }); };`, "s"),
      ["e", "l"],
    );
    assert.deepEqual(
      found(`export const f = async (db:any, late:boolean, x:string) => { await db.from("t").insert({ s: late ? "l" : x }); };`, "s"),
      [],
      "a branch that is not a literal makes the whole value unknowable",
    );
  });

  it("reads a payload held in an unmutated local const", () => {
    assert.deepEqual(
      found(`export const f = async (db:any) => { const row = { s: "x" }; await db.from("t").insert(row); };`, "s"),
      ["x"],
    );
  });
});

describe("write-literal extraction — forwarding through call sites", () => {
  // The motivating shape: the write names a parameter, the literal is at the
  // caller. An extractor reading only object-literal values learns nothing.
  const helperSource = (callerValue: string) => `
    async function writeEvent(db: any, opts: { eventType: string }) {
      await db.from("events_log").insert({ event_type: opts.eventType });
    }
    export async function route(db: any) {
      await writeEvent(db, { eventType: ${callerValue} });
    }
  `;

  it("recovers the literal from a same-file caller", () => {
    const sites = onSource(helperSource(`"paused"`));
    assert.deepEqual(sites.map((s) => s.literal), ["paused"]);
    assert.equal(sites[0]!.table, "events_log");
    assert.equal(sites[0]!.op, "insert.fwd1", "the op must record that this was inferred, not read");
  });

  it("recovers both branches when the caller passes a ternary", () => {
    assert.deepEqual(found(helperSource(`late ? "late_in" : "ok_in"`).replace("route(db: any)", "route(db: any, late = false)"), "event_type"),
      ["late_in", "ok_in"]);
  });

  it("recovers a literal held in a local const at the caller", () => {
    assert.deepEqual(
      found(`
        async function writeEvent(db: any, opts: { eventType: string }) {
          await db.from("t").insert({ event_type: opts.eventType });
        }
        export async function route(db: any) {
          const eventType = "from_const";
          await writeEvent(db, { eventType });
        }
      `, "event_type"),
      ["from_const"],
    );
  });

  it("takes the payload from the RIGHT argument index, not always the first", () => {
    // The real helper is writeAttendanceEvent(db, {...}) — the payload is arg 1.
    // An extractor that only inspects argument 0 finds nothing here.
    assert.deepEqual(
      found(`
        async function w(db: any, opts: { k: string }) { await db.from("t").insert({ c: opts.k }); }
        export async function r(db: any) { await w(db, { k: "second_arg" }); }
      `, "c"),
      ["second_arg"],
    );
  });
});

describe("write-literal extraction — what it REFUSES to guess", () => {
  // Each case must yield nothing. A wrong attribution is a false failure, and a
  // false failure blocks unrelated work — the one outcome this check may not have.
  const bail: Array<[string, string]> = [
    ["an exported helper (callers may be in another file)", `
      export async function w(db: any, opts: { k: string }) { await db.from("t").insert({ c: opts.k }); }
      export async function r(db: any) { await w(db, { k: "x" }); }
    `],
    ["two helpers sharing a name", `
      async function w(db: any, opts: { k: string }) { await db.from("t").insert({ c: opts.k }); }
      async function w(db: any, opts: { k: string }) { return db; }
      export async function r(db: any) { await w(db, { k: "x" }); }
    `],
    ["a parameter with a default", `
      async function w(db: any, opts: { k: string } = { k: "d" }) { await db.from("t").insert({ c: opts.k }); }
      export async function r(db: any) { await w(db, { k: "x" }); }
    `],
    ["a destructured parameter", `
      async function w(db: any, { k }: { k: string }) { await db.from("t").insert({ c: k }); }
      export async function r(db: any) { await w(db, { k: "x" }); }
    `],
    ["a helper with no visible caller", `
      async function w(db: any, opts: { k: string }) { await db.from("t").insert({ c: opts.k }); }
    `],
    ["a caller passing a non-literal", `
      async function w(db: any, opts: { k: string }) { await db.from("t").insert({ c: opts.k }); }
      export async function r(db: any, v: string) { await w(db, { k: v }); }
    `],
    ["ONE caller of several passing a non-literal", `
      async function w(db: any, opts: { k: string }) { await db.from("t").insert({ c: opts.k }); }
      export async function r(db: any, v: string) { await w(db, { k: "known" }); await w(db, { k: v }); }
    `],
    ["a spread in the caller's object", `
      async function w(db: any, opts: { k: string }) { await db.from("t").insert({ c: opts.k }); }
      export async function r(db: any, base: any) { await w(db, { ...base, k: "x" }); }
    `],
    ["a caller omitting the property", `
      async function w(db: any, opts: { k?: string }) { await db.from("t").insert({ c: opts.k }); }
      export async function r(db: any) { await w(db, {} as any); }
    `],
    ["recursion", `
      async function w(db: any, opts: { k: string }) {
        await db.from("t").insert({ c: opts.k });
        await w(db, { k: opts.k });
      }
    `],
    ["a non-literal table name", `
      export async function r(db: any, t: string) { await db.from(t).insert({ c: "x" }); }
    `],
    ["a local const that is reassigned", `
      export async function r(db: any) { let row = { c: "x" }; row = { c: "y" }; await db.from("t").insert(row); }
    `],
    ["a local const whose property is mutated", `
      export async function r(db: any) { const row = { c: "x" }; row.c = "y"; await db.from("t").insert(row); }
    `],
  ];
  for (const [name, src] of bail) {
    it(`refuses: ${name}`, () => {
      assert.deepEqual(onSource(src).map((s) => `${s.column}=${s.literal}`), []);
    });
  }

  it("refuses a literal that a LATER spread could overwrite, but reads one after it", () => {
    // `{ c: "x", ...base }` may never write "x" at all — flagging it would be a
    // false finding. `{ ...base, c: "x" }` definitely writes it.
    assert.deepEqual(found(`export const f = async (db:any, base:any) => { await db.from("t").insert({ c: "x", ...base }); };`, "c"), []);
    assert.deepEqual(found(`export const f = async (db:any, base:any) => { await db.from("t").insert({ ...base, c: "x" }); };`, "c"), ["x"]);
  });

  it("refuses an interpolated value", () => {
    assert.deepEqual(found("export const f = async (db:any, x:string) => { await db.from(\"t\").insert({ c: `p_${x}` }); };", "c"), []);
  });

  it("stringsOf is the single place literal-ness is decided", () => {
    assert.deepEqual(stringsOf(undefined), []);
  });
});

describe("write-literal extraction — the real repository", () => {
  it("finds a substantial number of write literals (vacuity floor)", () => {
    // A collapsed extractor returns [] and every assertion about "no dead
    // literals" becomes vacuously true. Measured ~900; the floor is far below.
    assert.ok(
      writes().sites.length > 300,
      `only ${writes().sites.length} write literals extracted — the extractor collapsed`,
    );
  });

  it("actually resolves forwarded literals in the repo, not just in fixtures", () => {
    const fwd = writes().sites.filter((s) => s.op.includes(".fwd"));
    assert.ok(fwd.length > 0, "no forwarded literal resolved anywhere — the hop is dead code");
  });

  it("attributes circle.ts's forwarded audit labels to the write's own table", () => {
    // writeAuditEvent writes circle_audit_events.event_type from opts.eventType;
    // the literals live at two callers. This is the control for the whole hop.
    const got = writes().sites
      .filter((s) => s.file.endsWith("routes/circle.ts") && s.column === "event_type")
      .map((s) => s.literal);
    for (const lit of ["sharing_paused", "sharing_paused_on_session_end"]) {
      assert.ok(got.includes(lit), `forwarding lost "${lit}" — got ${got.join(", ") || "nothing"}`);
    }
  });

  it("does NOT attribute geofence's trust-event literal to the attendance table", () => {
    // routes/geofence.ts writes plan_attendance_events by forwarding AND calls
    // recordTrustEvent({ eventType: "plan_attended" }), which is a
    // trust_events.event_type from a different vocabulary. A whole-file scan
    // conflates them; per-write-site attribution must not.
    const attendance = writes().sites.filter((s) => s.table === "plan_attendance_events");
    assert.ok(attendance.length > 0, "the attendance writes should be seen at all");
    assert.ok(
      !attendance.some((s) => s.literal === "plan_attended"),
      "a literal from a different sink was attributed to plan_attendance_events",
    );
  });

  it("reports no dead write literal that migration 2302 legalised", () => {
    // The regression this guards: judging against the baseline alone would call
    // suspicious_check_in and host_manual_override dead. 2302 widened the CHECK
    // to eight labels, so both are legal and reporting them would be a FALSE
    // failure demanding a correct literal be "repaired" into a wrong one.
    const dead = findDeadLiterals(writes().sites, vocab())
      .filter((f) => f.table === "plan_attendance_events");
    assert.deepEqual(dead.map((f) => f.literal), [], "2302's widening was not honoured");
  });

  it("isWriteOp classifies plain and forwarded write ops, and not filters", () => {
    for (const op of ["insert", "upsert", "update", "insert.fwd1", "update.fwd2"]) {
      assert.ok(isWriteOp(op), `${op} is a write`);
    }
    for (const op of ["eq", "in", "not.eq", "or.eq"]) {
      assert.ok(!isWriteOp(op), `${op} is a filter`);
    }
  });
});

describe("canonical vocabulary — two parser repairs this check depends on", () => {
  it("a comment inside a value list no longer truncates it", () => {
    // THE BUG: the IN-list is captured with `IN\\s*\\(([^)]*)\\)`, which stops at
    // the first `)`. Migration 2250 writes `-- §36 MediaModerationStatus
    // (canonical)` INSIDE the list, so the `)` in the comment closed the capture,
    // the fragment held no quoted values, and the ENTIRE constraint was dropped in
    // silence. media_assets.moderation_status then kept the baseline's four
    // values — from a constraint 2250 had already DROPPED — and 'active', the
    // canonical promoted state, read as dead. That was a false failure.
    const withComment = `CHECK (moderation_status IN (
      -- §36 MediaModerationStatus (canonical)
      'processing','active','limited',
      -- legacy shipped values (0191), kept for existing rows
      'pending','approved'
    ))`;
    const got = vocabularyFromCheck(withComment).get("moderation_status");
    assert.ok(got, "the constraint parsed to nothing — a comment truncated the list");
    assert.deepEqual([...got].sort(), ["active", "approved", "limited", "pending", "processing"]);
  });

  it("`--` inside a string literal is a VALUE, not a comment", () => {
    const got = vocabularyFromCheck(`CHECK (k IN ('a--b', 'c'))`).get("k");
    assert.deepEqual([...got!].sort(), ["a--b", "c"], "stripping ate a legal value");

    // Asserted on CONTENT, not on exact whitespace: the stripper replaces a
    // comment with a newline and leaves surrounding spacing alone, which is
    // irrelevant to every consumer (they all re-match with \s*).
    const stripped = stripSqlLineComments(`x '--not a comment' -- yes a comment\ny`);
    assert.match(stripped, /'--not a comment'/, "the quoted value was treated as a comment");
    assert.ok(!stripped.includes("yes a comment"), "the real comment survived");
    assert.match(stripped, /\by\b/, "content after the comment's newline was lost");
  });

  it("an ALTER TABLE guarded by IF … THEN inside DO $$ is absorbed", () => {
    // ALTER_TARGET_RE is anchored at the start of a statement, and the repo's
    // idempotency idiom puts the DDL inside a conditional, so the statement
    // begins `IF NOT EXISTS` and the anchor never matched. Distinct from the
    // plain `DO $$ ALTER TABLE … $$` case, which already worked.
    const dir = mkdtempSync(join(tmpdir(), "vocab-ifthen-"));
    try {
      const baseline = join(dir, "baseline.sql");
      writeFileSync(baseline,
        "CREATE TABLE public.gizmos (\n" +
        "    state text NOT NULL,\n" +
        "    CONSTRAINT gizmos_state_check CHECK ((state = ANY (ARRAY['old'::text])))\n" +
        ");\n");
      const migs = join(dir, "migrations");
      mkdirSync(migs);
      writeFileSync(join(migs, "9001_widen.sql"), `
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gizmos_state_canonical') THEN
            ALTER TABLE gizmos ADD CONSTRAINT gizmos_state_canonical
              CHECK (state IN ('old','new'));
          END IF;
        END $$;
      `);
      const v = buildCanonicalVocabulary(baseline, [migs]);
      const got = v.values.get("gizmos.state");
      assert.ok(got, "gizmos.state should carry a vocabulary");
      assert.ok(got.has("new"), `the IF-guarded ALTER was not absorbed — got ${[...got].sort().join(" | ")}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("media_assets.moderation_status matches the live schema, including 'active'", () => {
    // The end-to-end result of both repairs above, on the real tree. Verified
    // against the live CI project: nine labels, 'active' among them.
    const got = vocab().values.get("media_assets.moderation_status");
    assert.ok(got, "column should be modelled");
    assert.ok(got.has("active"), `'active' must be legal — got ${[...got].sort().join(" | ")}`);
    assert.equal(got.size, 9, `expected the live nine labels, got ${[...got].sort().join(" | ")}`);
  });
});
