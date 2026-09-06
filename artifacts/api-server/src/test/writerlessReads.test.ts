/**
 * writerlessReads.test.ts
 *
 * Pins `check:writerless-reads` — the guard for tables this server READS that
 * NOTHING anywhere WRITES.
 *
 * WHY THE GUARD EXISTS
 * --------------------
 * Every read of such a table returns zero rows, in every environment, forever.
 * The query is well-formed, the columns exist, the enum labels are valid, and
 * the suite is green — because a query against an empty TABLE is
 * indistinguishable from a query against an empty FIXTURE. Confirmed twice:
 * `activity_events` (0.70 of the creator-activity score, structurally zero) and
 * `public.circles` (nine readers, one of them an authorization predicate that
 * therefore denies everyone).
 *
 * WHY THESE TESTS LOOK THE WAY THEY DO
 * ------------------------------------
 * The extractor is the interesting half, so most of what follows drives it
 * against real source text rather than asserting on the repo's current numbers.
 * Two of these cases are regression pins for bugs this check ACTUALLY HAD
 * during development, both of which produced confident, plausible, wrong output:
 *
 *   1. The consuming-regex bug. The first prototype used
 *      `.from\\("t"\\)[\\s\\S]{0,400}?\\.(insert|upsert)\\(`, and because regex
 *      matches do not overlap, an earlier `.from()` swallowed a later
 *      `.upsert(` so the table between them was reported as writerless. It
 *      turned 377 real writers into 350 and produced 41 false dead tables
 *      instead of 16. `writesAcrossAdjacentChains` is that exact shape.
 *   2. Storage buckets read as tables. `supabase.storage.from("post-media")` is
 *      not a table read, but the first run reported `stamp-artwork` and
 *      `post-media` as writerless tables. `storageBucketsAreNotTables` pins it.
 *
 * Run: node --import tsx/esm --test src/test/writerlessReads.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  extractTableAccess,
  extractSqlWrittenTables,
  collectStringLiterals,
} from "../scripts/lib/tableAccessExtract.js";
import {
  findWriterless,
  partition,
  findUnreachableProducers,
} from "../scripts/checkWriterlessReads.js";

/** Write `files` into a throwaway dir and extract from it. */
function onFixture(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "writerless-"));
  try {
    for (const [name, body] of Object.entries(files)) {
      const full = join(dir, name);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, body, "utf8");
    }
    return { dir, result: extractTableAccess([dir], dir) };
  } finally {
    // caller reads the result; the dir is removed by the caller via cleanup()
    // — kept simple: we remove it immediately, extraction has already read it.
    setTimeout(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} }, 0);
  }
}

describe("extractTableAccess — reads and writes", () => {
  it("records a plain read and a plain write", () => {
    const { result } = onFixture({
      "a.ts": `
        export async function f(sc: any) {
          const { data } = await sc.from("posts").select("id").eq("author_id", "u");
          await sc.from("audit_log").insert({ what: "x" });
          return data;
        }
      `,
    });
    assert.equal(result.reads.has("posts"), true, "posts should be recorded as read");
    assert.equal(result.writes.has("audit_log"), true, "audit_log should be recorded as written");
    assert.equal(result.writes.has("posts"), false, "posts is only read here");
  });

  it("REGRESSION: writesAcrossAdjacentChains — a later write is not swallowed by an earlier from()", () => {
    // This is the exact shape that broke the regex prototype: two .from() calls
    // where the SECOND one's .upsert() sits textually after the first .from().
    const { result } = onFixture({
      "b.ts": `
        export async function accept(sc: any, inv: any, user: any) {
          const { error: invErr } = await sc.from("circle_invites").update({ status: "accepted" });
          if (invErr) return;
          const { error: cmErr } = await sc.from("circle_memberships").upsert({ user_id: inv.owner_id, other_id: user.id });
          if (cmErr) return;
        }
      `,
    });
    assert.equal(
      result.writes.has("circle_memberships"),
      true,
      "circle_memberships MUST be seen as written. A consuming regex misses exactly this: " +
        "the earlier .from(\"circle_invites\") match eats the text through the later .upsert(, " +
        "so the real writer is never attributed and the table is reported dead. That single bug " +
        "produced 41 false findings instead of 16.",
    );
    assert.equal(result.writes.has("circle_invites"), true, "and the first write is still seen");
  });

  it("REGRESSION: storageBucketsAreNotTables — .storage.from() is not a table read", () => {
    const { result } = onFixture({
      "c.ts": `
        export async function g(sc: any) {
          const a = await sc.storage.from("stamp-artwork").download("k");
          const b = await sc.storage.from("post-media").createSignedUrl("k", 60);
          const { data } = await sc.from("real_table").select("id");
          return [a, b, data];
        }
      `,
    });
    assert.equal(result.reads.has("stamp-artwork"), false, "storage bucket must not be a table");
    assert.equal(result.reads.has("post-media"), false, "storage bucket must not be a table");
    assert.equal(result.reads.has("real_table"), true, "a genuine table read is still recorded");
  });

  it("follows a chain that spans statements via an identifier binding", () => {
    const { result } = onFixture({
      "d.ts": `
        export async function h(sc: any, on: boolean) {
          let q = sc.from("events").select("id");
          if (on) q = q.eq("visibility", "public");
          const { data } = await q;
          const w = sc.from("events");
          await w.insert({ id: 1 });
          return data;
        }
      `,
    });
    assert.equal(result.writes.has("events"), true, "the write through `w` must resolve to events");
  });

  it("refuses to guess when one identifier is bound to two tables", () => {
    const { result } = onFixture({
      "e.ts": `
        export async function i(sc: any, alt: boolean) {
          let q = sc.from("table_one");
          if (alt) q = sc.from("table_two");
          await q.insert({ x: 1 });
        }
      `,
    });
    // Ambiguous binding is dropped rather than attributed to the wrong table —
    // a wrong attribution would report a real writer as missing.
    assert.equal(result.writes.has("table_one"), false);
    assert.equal(result.writes.has("table_two"), false);
  });

  it("ignores tables that appear only in comments", () => {
    const { result } = onFixture({
      "f.ts": `
        // Historical note: this used to call sc.from("ghost_table").select("id").
        /* and sc.from("other_ghost").insert({}) — both removed. */
        export const x = 1;
      `,
    });
    assert.equal(result.reads.has("ghost_table"), false, "a parser sees no comments; a text scan does");
    assert.equal(result.writes.has("other_ghost"), false);
  });

  it("counts .delete() as a writer — you cannot delete rows that never exist", () => {
    const { result } = onFixture({
      "g.ts": `export async function j(sc: any) { await sc.from("sessions").delete().eq("id", "1"); }`,
    });
    assert.equal(result.writes.has("sessions"), true);
  });
});

describe("extractSqlWrittenTables", () => {
  it("finds INSERT INTO, UPDATE … SET and COPY, including inside a function body", () => {
    const dir = mkdtempSync(join(tmpdir(), "writerless-sql-"));
    const f = join(dir, "m.sql");
    writeFileSync(
      f,
      `
      CREATE OR REPLACE FUNCTION public.promote() RETURNS void AS $$
      BEGIN
        INSERT INTO public.promoted_scopes (scope_key) VALUES ('a');
        UPDATE public.counters SET n = n + 1;
      END; $$ LANGUAGE plpgsql;
      COPY public.seeded_reference FROM stdin;
      `,
      "utf8",
    );
    const written = extractSqlWrittenTables([f]);
    rmSync(dir, { recursive: true, force: true });
    assert.equal(written.has("promoted_scopes"), true, "INSERT inside a function body counts");
    assert.equal(written.has("counters"), true, "UPDATE … SET counts");
    assert.equal(written.has("seeded_reference"), true, "COPY counts — the table is externally seeded");
  });
});

describe("findWriterless + partition", () => {
  const reads = new Map<string, { file: string; line: number }[]>([
    ["written_table", [{ file: "a.ts", line: 1 }]],
    ["dead_table", [{ file: "a.ts", line: 2 }, { file: "b.ts", line: 9 }]],
  ]);

  it("reports only tables with no writer anywhere", () => {
    const out = findWriterless(reads, new Set(["written_table"]));
    assert.deepEqual(out.map((w) => w.table), ["dead_table"]);
    assert.equal(out[0]!.readers, 2);
    assert.deepEqual(out[0]!.sites, ["a.ts:2", "b.ts:9"]);
  });

  it("a table written ONLY in SQL is not reported", () => {
    const out = findWriterless(reads, new Set(["written_table", "dead_table"]));
    assert.deepEqual(out, [], "an SQL-only writer is still a writer");
  });

  it("partition separates fresh findings from the ratchet", () => {
    const found = findWriterless(reads, new Set(["written_table"]));
    const empty = partition(found, {});
    assert.equal(empty.fresh.length, 1, "with no ratchet entry it is a NEW finding and must fail");

    const ratcheted = partition(found, {
      dead_table: { readers: 2, classification: "dead-lane", note: "n" },
    });
    assert.equal(ratcheted.fresh.length, 0);
    assert.equal(ratcheted.known.length, 1);
    assert.equal(ratcheted.miscounted.length, 0);
  });

  it("fails when a ratcheted count drifts — the list must not silently grow", () => {
    const found = findWriterless(reads, new Set(["written_table"]));
    const p = partition(found, {
      dead_table: { readers: 1, classification: "dead-lane", note: "n" },
    });
    assert.equal(p.miscounted.length, 1, "2 readers against a ratchet of 1 must be reported");
  });

  it("fails when a ratcheted table gained a writer and was not struck off", () => {
    const found = findWriterless(reads, new Set(["written_table", "dead_table"]));
    const p = partition(found, {
      dead_table: { readers: 2, classification: "dead-lane", note: "n" },
    });
    assert.deepEqual(p.stale, ["dead_table"], "a fixed entry left on the ratchet must fail loudly");
  });
});

describe("read counts exclude the .from() that opens a write", () => {
  it("a write-only table has no readers", () => {
    const { result } = onFixture({
      "h.ts": `export async function k(sc: any) { await sc.from("audit_only").insert({ a: 1 }); }`,
    });
    assert.equal(result.writes.has("audit_only"), true);
    assert.equal(
      result.reads.has("audit_only"),
      false,
      "the .from() opening an insert consumes no rows; counting it inflates every " +
        "reader count by one per write site and makes a write-only table look read",
    );
  });

  it("a table both read and written records both", () => {
    const { result } = onFixture({
      "i.ts": `
        export async function l(sc: any) {
          const { data } = await sc.from("both").select("id");
          await sc.from("both").insert({ id: 2 });
          return data;
        }
      `,
    });
    assert.equal(result.reads.has("both"), true);
    assert.equal(result.writes.has("both"), true);
  });
});

describe("collectStringLiterals — prose is not a caller", () => {
  it("returns string literals and NOT the text of comments", () => {
    const dir = mkdtempSync(join(tmpdir(), "writerless-lit-"));
    const f = join(dir, "j.ts");
    writeFileSync(
      f,
      `
      /** POST /internal/ghost-route — described here, called nowhere. */
      // see also /internal/ghost-route
      export const realCall = "/internal/live-route";
      `,
      "utf8",
    );
    const lits = collectStringLiterals(f);
    rmSync(dir, { recursive: true, force: true });
    assert.equal(lits.includes("/internal/live-route"), true, "a real literal is collected");
    assert.equal(
      lits.includes("/internal/ghost-route"),
      false,
      "prose must NOT count as a reference. The first version of the route-caller " +
        "search scanned raw text and was defeated immediately: the doc comment above " +
        "the route, and the comments describing this very defect, all contain the path, " +
        "so an uncalled route looked well-referenced and the check stayed silent.",
    );
  });
});

describe("findUnreachableProducers — a producer nothing invokes", () => {
  const reads = new Map<string, { file: string; line: number }[]>([
    ["evented", [{ file: "reader.ts", line: 5 }]],
  ]);

  it("reports a table whose only writer is an uncalled internal route", () => {
    const writes = new Map([
      ["evented", [{ file: "routes/x.ts", line: 40, routePath: "/internal/evented", internalGated: true }]],
    ]);
    const out = findUnreachableProducers(reads, writes, () => false);
    assert.equal(out.length, 1, "this is the activity_events shape and MUST be caught");
    assert.equal(out[0]!.routePath, "/internal/evented");
  });

  it("does NOT report it once something calls that route", () => {
    const writes = new Map([
      ["evented", [{ file: "routes/x.ts", line: 40, routePath: "/internal/evented", internalGated: true }]],
    ]);
    assert.deepEqual(findUnreachableProducers(reads, writes, () => true), []);
  });

  it("does NOT report a writer that is not internal-gated", () => {
    const writes = new Map([
      ["evented", [{ file: "routes/x.ts", line: 40, routePath: "/evented", internalGated: false }]],
    ]);
    assert.deepEqual(
      findUnreachableProducers(reads, writes, () => false),
      [],
      "an ordinary route is reachable by the client by definition",
    );
  });

  it("does NOT report when ANY of several writers is reachable", () => {
    const writes = new Map([
      ["evented", [
        { file: "routes/x.ts", line: 40, routePath: "/internal/evented", internalGated: true },
        { file: "routes/y.ts", line: 12, routePath: "/public/evented", internalGated: false },
      ]],
    ]);
    assert.deepEqual(findUnreachableProducers(reads, writes, () => false), []);
  });

  it("leaves tables with no writer to the plain writerless check", () => {
    assert.deepEqual(findUnreachableProducers(reads, new Map(), () => false), []);
  });
});
