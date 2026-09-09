/**
 * The direct-write ratchet's non-aggregate exemption (Trips spec §24 Phase 1;
 * src/scripts/checkTripKernelWriters.ts, tripKernelWriterBaseline.ts).
 *
 * WHAT IS PROVEN HERE
 * ===================
 * The task an exemption mechanism has to survive is not "does it let the five
 * argued writes through" — anything lets those through. It is "can it be
 * widened without anybody noticing". So most of this file is the ways a
 * declaration is REFUSED:
 *
 *   1. A declaration covers exactly the columns it names. Add a column to the
 *      annotated statement and the check fails; remove one and it fails too, so
 *      a declaration can neither grow silently nor outlive its write.
 *   2. A payload whose columns cannot be read from the file — a spread, a
 *      variable, a computed key — is refused outright. An unverifiable claim is
 *      not an exemption.
 *   3. insert / upsert / delete are refused whatever the columns say: creating
 *      or destroying a canonical trip row IS aggregate state.
 *   4. A bare marker with no column list is refused — it would be a blanket
 *      exemption by another name.
 *   5. A declaration binds to ONE statement. The write below the annotated one
 *      gets nothing.
 *   6. nonAggregate is ratcheted per file: a write cannot be reclassified out
 *      of `ungated` (or out of `gated`) into `nonAggregate` without editing the
 *      baseline table by hand.
 *
 * And two facts about the real tree, so a future edit cannot quietly undo this
 * pass: each of the five declared sites is still recognised, and the total is
 * still five.
 *
 * Runtime: node:test + node:assert/strict
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy node --import tsx/esm --test src/test/tripKernelNonAggregateRatchet.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  countCanonicalWrites,
  judge,
  readObjectKeys,
  statementSemicolons,
  ungatedOf,
  verifyNonAggregate,
  type WriterCount,
} from "../scripts/checkTripKernelWriters.js";
import { TRIP_KERNEL_DIRECT_WRITERS } from "../scripts/tripKernelWriterBaseline.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A file whose only content is one annotated write, so the count is unambiguous. */
function oneWrite(comment: string, statement: string): string {
  return `const sc: any = null;\n${comment}\n${statement}\n`;
}

const DECL = "// trip-kernel:non-aggregate(trips.reminder_sent_at)";

describe("a declaration covers exactly the columns it names", () => {
  it("accepts the write it describes", () => {
    const c = countCanonicalWrites(oneWrite(DECL, `await sc.from("trips").update({ reminder_sent_at: NOW }).eq("id", id);`));
    assert.equal(c.count, 1);
    assert.equal(c.nonAggregate, 1);
    assert.deepEqual(c.refusedNonAggregate, []);
    assert.equal(ungatedOf({ ...c }), 0);
  });

  it("REFUSES when the statement grows a column the declaration does not name", () => {
    // The silent-expansion case: somebody adds `title` to a write that was
    // exempt for touching only a scheduler claim column.
    const c = countCanonicalWrites(oneWrite(DECL, `await sc.from("trips").update({ reminder_sent_at: NOW, title: t }).eq("id", id);`));
    assert.equal(c.nonAggregate, 0);
    assert.equal(c.refusedNonAggregate.length, 1);
    assert.match(c.refusedNonAggregate[0], /declares \{reminder_sent_at\} but the statement writes \{reminder_sent_at, title\}/);
    // and it is still counted as a direct, ungated write
    assert.equal(ungatedOf({ ...c }), 1);
  });

  it("REFUSES when the declaration outlives the column it described", () => {
    const c = countCanonicalWrites(oneWrite(DECL, `await sc.from("trips").update({ reminder_delivered_at: NOW }).eq("id", id);`));
    assert.equal(c.nonAggregate, 0);
    assert.match(c.refusedNonAggregate[0], /declares \{reminder_sent_at\} but the statement writes \{reminder_delivered_at\}/);
  });

  it("REFUSES a declaration naming a different table than the statement writes", () => {
    const c = countCanonicalWrites(oneWrite(
      "// trip-kernel:non-aggregate(trip_members.reminder_sent_at)",
      `await sc.from("trips").update({ reminder_sent_at: NOW }).eq("id", id);`,
    ));
    assert.equal(c.nonAggregate, 0);
    assert.match(c.refusedNonAggregate[0], /declares "trip_members\.reminder_sent_at" but the statement writes "trips"/);
  });

  it("REFUSES a column that is not qualified by a table", () => {
    const c = countCanonicalWrites(oneWrite(
      "// trip-kernel:non-aggregate(reminder_sent_at)",
      `await sc.from("trips").update({ reminder_sent_at: NOW }).eq("id", id);`,
    ));
    assert.equal(c.nonAggregate, 0);
    assert.match(c.refusedNonAggregate[0], /is not <table>\.<column>/);
  });

  it("accepts a multi-column declaration, in either order", () => {
    const decl = "// trip-kernel:non-aggregate(trips.reminder_delivered_at, trips.reminder_sent_at)";
    const c = countCanonicalWrites(oneWrite(decl, `await sc.from("trips").update({ reminder_sent_at: A, reminder_delivered_at: B }).eq("id", id);`));
    assert.equal(c.nonAggregate, 1);
  });
});

describe("a payload the check cannot read is refused, never assumed harmless", () => {
  const unreadable: Array<[string, string]> = [
    ["a spread", `await sc.from("trips").update({ ...patch, reminder_sent_at: NOW }).eq("id", id);`],
    ["a variable", `await sc.from("trips").update(patch).eq("id", id);`],
    ["a computed key", `await sc.from("trips").update({ [col]: NOW }).eq("id", id);`],
  ];
  for (const [what, statement] of unreadable) {
    it(`REFUSES ${what}`, () => {
      const c = countCanonicalWrites(oneWrite(DECL, statement));
      assert.equal(c.count, 1);
      assert.equal(c.nonAggregate, 0, `${what} must not be exempt`);
      assert.match(c.refusedNonAggregate[0], /not a literal object/);
      assert.equal(ungatedOf({ ...c }), 1);
    });
  }
});

describe("only a column-scoped update can be outside the aggregate", () => {
  for (const verb of ["insert", "upsert", "delete"] as const) {
    it(`REFUSES a declaration on .${verb}()`, () => {
      const stmt = verb === "delete"
        ? `await sc.from("trips").delete().eq("id", id);`
        : `await sc.from("trips").${verb}({ reminder_sent_at: NOW }).eq("id", id);`;
      const c = countCanonicalWrites(oneWrite(DECL, stmt));
      assert.equal(c.count, 1);
      assert.equal(c.nonAggregate, 0);
      assert.match(c.refusedNonAggregate[0], /creating or destroying a canonical trip row IS aggregate state/);
    });
  }
});

describe("the marker cannot be used as a blanket exemption", () => {
  it("REFUSES a bare marker with no column list", () => {
    const c = countCanonicalWrites(oneWrite(
      "// trip-kernel:non-aggregate — scheduler bookkeeping, trust me",
      `await sc.from("trips").update({ reminder_sent_at: NOW }).eq("id", id);`,
    ));
    assert.equal(c.nonAggregate, 0);
    assert.match(c.refusedNonAggregate[0], /must name the exact columns it covers/);
  });

  it("REFUSES an empty column list", () => {
    const c = countCanonicalWrites(oneWrite(
      "// trip-kernel:non-aggregate()",
      `await sc.from("trips").update({ reminder_sent_at: NOW }).eq("id", id);`,
    ));
    assert.equal(c.nonAggregate, 0);
    assert.match(c.refusedNonAggregate[0], /declares no column/);
  });

  it("exempts ONE statement — the next write gets nothing from it", () => {
    const text = [
      "const sc: any = null;",
      DECL,
      `await sc.from("trips").update({ reminder_sent_at: NOW }).eq("id", id);`,
      `await sc.from("trips").update({ title: t }).eq("id", id);`,
      "",
    ].join("\n");
    const c = countCanonicalWrites(text);
    assert.equal(c.count, 2);
    assert.equal(c.nonAggregate, 1, "the second write must not inherit the first's declaration");
    assert.equal(ungatedOf({ ...c }), 1);
  });
});

describe("statement boundaries ignore semicolons that are not statement terminators", () => {
  it("binds a declaration across prose that contains a semicolon", () => {
    // The reason this matters: a non-aggregate exemption has to be ARGUED, and
    // an argument that cannot contain a semicolon is not a serious one.
    const comment = [
      "// trip-kernel:non-aggregate(trips.reminder_sent_at)",
      "//",
      "// This is the claim half of a two-phase outbox; the predicate is what",
      "// makes delivery at-most-once; a command cannot carry it.",
    ].join("\n");
    const c = countCanonicalWrites(oneWrite(comment, `await sc.from("trips").update({ reminder_sent_at: NOW }).eq("id", id);`));
    assert.equal(c.nonAggregate, 1);
  });

  it("does not treat a semicolon inside a string or a regex as a terminator", () => {
    const text = `const a = "x;y"; const b = /a;b/; const c = 1;`;
    // Three real terminators: after the string, after the regex, after `1`.
    assert.deepEqual(statementSemicolons(text).map((i) => text[i]), [";", ";", ";"]);
    assert.equal(statementSemicolons(text).length, 3);
  });

  it("still refuses to let a declaration reach across a real statement boundary", () => {
    const text = [
      "const sc: any = null;",
      DECL,
      "const unrelated = 1;",
      `await sc.from("trips").update({ reminder_sent_at: NOW }).eq("id", id);`,
      "",
    ].join("\n");
    const c = countCanonicalWrites(text);
    assert.equal(c.nonAggregate, 0, "a declaration separated from the write by another statement must not apply");
  });
});

describe("readObjectKeys / verifyNonAggregate units", () => {
  it("reads keys past nested calls, strings and nested objects", () => {
    const t = `x.update({ a: new Date(f()).toISOString(), "b": "c: not a key", d: { e: 1 }, f })`;
    assert.deepEqual(readObjectKeys(t, t.indexOf("(") + 1), ["a", "b", "d", "f"]);
  });
  it("returns null for a non-literal payload", () => {
    const t = `x.update(payload)`;
    assert.equal(readObjectKeys(t, t.indexOf("(") + 1), null);
  });
  it("refuses when the payload could not be read", () => {
    assert.match(verifyNonAggregate("trips.a", "trips", "update", null)!, /not a literal object/);
  });
  it("accepts an exact match and nothing else", () => {
    assert.equal(verifyNonAggregate("trips.a, trips.b", "trips", "update", ["b", "a"]), null);
    assert.notEqual(verifyNonAggregate("trips.a", "trips", "update", ["a", "b"]), null);
  });
});

describe("nonAggregate is ratcheted per file", () => {
  const row = (over: Partial<WriterCount> = {}): WriterCount => ({
    file: "routes/x.ts", count: 1, gated: 0, nonAggregate: 1,
    importsKernel: false, dynamicFrom: false, refusedNonAggregate: [], ...over,
  });

  it("FAILS when a file's exempt count grows beyond the baseline", () => {
    const v = judge([row({ count: 2, nonAggregate: 2 })], { "routes/x.ts": { direct: 2, ungated: 1, nonAggregate: 1 } });
    assert.equal(v.grew.length, 1, "reclassifying an ungated write as exempt must fail until the baseline is edited");
  });

  it("FAILS when a file acquires its first exemption (absent nonAggregate means zero)", () => {
    const v = judge([row()], { "routes/x.ts": { direct: 1, ungated: 1 } });
    assert.equal(v.grew.length, 1);
  });

  it("FAILS a legacy-path marker in a file that never imports the kernel", () => {
    // The sibling rule this pass did not change, pinned here because the two
    // markers now share a code path: an annotation is a CLAIM that a command
    // exists, and the check refuses a claim the file cannot back.
    const v = judge([row({ gated: 1, nonAggregate: 0, importsKernel: false })], { "routes/x.ts": { direct: 1, ungated: 1 } });
    assert.equal(v.falseMarkers.length, 1);
  });

  it("reports a REFUSED declaration as its own failure, not merely as an ungated write", () => {
    const v = judge([row({ nonAggregate: 0, refusedNonAggregate: ["nope"] })], { "routes/x.ts": { direct: 1, ungated: 1 } });
    assert.equal(v.refusedExemptions.length, 1);
  });

  it("invites tightening when a file needs fewer exemptions than the baseline allows", () => {
    const v = judge([row({ nonAggregate: 0, count: 1, gated: 0 })], { "routes/x.ts": { direct: 1, ungated: 1, nonAggregate: 1 } });
    assert.equal(v.shrank.length, 1);
  });
});

describe("the five declared sites in the real tree", () => {
  const expected: Array<[string, number]> = [
    ["lib/tripReminderScheduler.ts", 3],
    ["routes/admin.ts", 1],
    ["services/contentTranslation.ts", 1],
  ];
  for (const [file, n] of expected) {
    it(`${file} still declares ${n} non-aggregate write(s), all verified`, () => {
      const c = countCanonicalWrites(readFileSync(join(SRC, file), "utf8"));
      assert.deepEqual(c.refusedNonAggregate, [], `${file} has a declaration the check refuses`);
      assert.equal(c.nonAggregate, n);
    });
  }

  it("the baseline allows exactly those five and no more", () => {
    const total = Object.values(TRIP_KERNEL_DIRECT_WRITERS).reduce((n, b) => n + (b.nonAggregate ?? 0), 0);
    assert.equal(total, 5);
  });

  it("no file outside those three claims an exemption", () => {
    for (const [file, b] of Object.entries(TRIP_KERNEL_DIRECT_WRITERS)) {
      if (expected.some(([f]) => f === file)) continue;
      assert.equal(b.nonAggregate ?? 0, 0, `${file} must not carry a non-aggregate allowance`);
    }
  });
});
