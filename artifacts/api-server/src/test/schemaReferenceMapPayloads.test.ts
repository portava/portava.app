/**
 * `.map(cb)` payload resolution in scripts/lib/schemaReferenceExtract.ts.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every batch writer in this tree builds its rows the same way:
 *
 *     const rows = items.map((it) => ({ a: …, b: … }));
 *     await sc.from("t").insert(rows);
 *
 * The array is variable-length, so it can never BE an array literal — and for
 * a long time the UNRESOLVED_ALLOWLIST in checkWritePathColumns.ts read that
 * fact as "not statically resolvable", which is a claim about the extractor
 * dressed up as a claim about the code. The row SHAPE is a literal, sitting in
 * the callback, and the columns a batch insert writes are exactly its keys.
 * Reading it moved 31 sites out of the blind-spot ledger and into the checked
 * set on 2026-09-15.
 *
 * WHAT THIS PINS
 * --------------
 * The extension is only worth having if it is CONSERVATIVE: a shape it cannot
 * fully read must come back marked, because the allowlist's two categories —
 * "not statically resolvable" and "partially resolvable" — are what tells a
 * reader whether a site is unchecked or half-checked. A map extension that
 * silently narrowed a payload to the keys it happened to see would turn
 * genuine blind spots into confident green, which is strictly worse than the
 * ledger entry it replaced.
 *
 * So each case below is a shape the extractor must get RIGHT, not merely
 * resolve: the union across branches, the refusal to read a nested function's
 * return, the refusal to guess at a callback passed by name, and the
 * `unresolved` flag on a spread it cannot follow.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractSchemaReferences } from "../scripts/lib/schemaReferenceExtract.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(__dir, "../..");

let root = "";
let scanDir = "";

/** Extract from a one-file fixture tree and return that file's sites/skips. */
function extractFixture(name: string, source: string) {
  const file = join(scanDir, `${name}.ts`);
  writeFileSync(file, source, "utf8");
  const { sites, skipped } = extractSchemaReferences(root, [scanDir]);
  // Anchored on the separator: a bare endsWith would make "blockspread.ts"
  // answer for "spread", and fixtures accumulate in one scan dir.
  const rel = (p: string) => p.endsWith(`/${name}.ts`);
  return {
    sites: sites.filter((s) => rel(s.file)),
    skipped: skipped.filter((s) => rel(s.file)),
  };
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "schema-ref-map-"));
  scanDir = join(root, "src", "fixtures");
  mkdirSync(scanDir, { recursive: true });
});

after(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("map/flatMap payload resolution", () => {
  it("reads the row literal out of a concise-body arrow", () => {
    const { sites, skipped } = extractFixture(
      "concise",
      `declare const sc: any; declare const events: any[];
       const rows = events.map((e) => ({ event_type: e.t, item_id: e.id, surface: "s" }));
       await sc.from("rank_events").insert(rows);`,
    );
    assert.equal(skipped.length, 0, "the site must not be skipped");
    assert.equal(sites.length, 1);
    assert.equal(sites[0].table, "rank_events");
    assert.deepEqual(
      [...sites[0].columns].sort(),
      ["event_type", "item_id", "surface"],
      "every key of the row shape is a column the batch writes",
    );
    assert.equal(sites[0].unresolved, false);
  });

  it("takes the UNION of every branch a block-bodied callback can return", () => {
    // A batch whose rows differ by branch writes the union of their columns:
    // reporting one branch would under-report what reaches the database.
    const { sites } = extractFixture(
      "branches",
      `declare const sc: any; declare const xs: any[];
       const rows = xs.map((x) => {
         if (x.kind === "a") return { shared_col: 1, only_a: 2 };
         return { shared_col: 1, only_b: 3 };
       });
       await sc.from("t").insert(rows);`,
    );
    assert.equal(sites.length, 1);
    assert.deepEqual(
      [...new Set(sites[0].columns)].sort(),
      ["only_a", "only_b", "shared_col"],
    );
    assert.equal(sites[0].unresolved, false);
  });

  it("does NOT harvest a nested function's return as if it were a row", () => {
    const { sites } = extractFixture(
      "nested",
      `declare const sc: any; declare const xs: any[];
       const rows = xs.map((x) => {
         const decorate = () => { return { not_a_column: 1 }; };
         decorate();
         return { real_col: x };
       });
       await sc.from("t").insert(rows);`,
    );
    assert.equal(sites.length, 1);
    assert.deepEqual(sites[0].columns, ["real_col"]);
    assert.ok(
      !sites[0].columns.includes("not_a_column"),
      "an inner arrow's return belongs to the inner arrow",
    );
  });

  it("flags the whole payload when ONE branch is unreadable", () => {
    // Half a row shape is not a row shape. If the readable branch were
    // reported clean, a site whose other branch writes anything at all would
    // read as fully checked — the precise failure this ledger exists to
    // prevent.
    const { sites } = extractFixture(
      "mixedbranch",
      `declare const sc: any; declare const xs: any[]; declare const toRow: any;
       const rows = xs.map((x) => {
         if (x.a) return { known_col: 1 };
         return toRow(x);
       });
       await sc.from("t").insert(rows);`,
    );
    assert.equal(sites.length, 1);
    assert.deepEqual(sites[0].columns, ["known_col"]);
    assert.equal(
      sites[0].unresolved,
      true,
      "an unreadable branch must mark the site, not be dropped",
    );
  });

  it("propagates a PARTIALLY resolved return out of a block body", () => {
    // The inner object literal resolves, but its spread does not. That
    // `unresolved` flag has to travel up through resolveFunctionReturn or the
    // site arrives on the ledger looking fully checked.
    const { sites } = extractFixture(
      "blockspread",
      `declare const sc: any; declare const xs: any[];
       const rows = xs.map((x) => {
         return { ...x, block_col: 1 };
       });
       await sc.from("t").insert(rows);`,
    );
    assert.equal(sites.length, 1);
    assert.deepEqual(sites[0].columns, ["block_col"]);
    assert.equal(sites[0].unresolved, true);
  });

  it("handles flatMap the same way", () => {
    const { sites } = extractFixture(
      "flat",
      `declare const sc: any; declare const xs: any[];
       const rows = xs.flatMap((x) => ({ flat_col: x }));
       await sc.from("t").insert(rows);`,
    );
    assert.equal(sites.length, 1);
    assert.deepEqual(sites[0].columns, ["flat_col"]);
  });

  it("marks a spread of the callback PARAMETER partially resolvable, not resolved", () => {
    // This is the surviving rank_events shape: `...r` reaches a value no
    // same-file lookup can see, so the visible key is reported AND the site
    // stays flagged. Silently returning just `recommendation_id` would claim
    // coverage the extractor does not have.
    const { sites } = extractFixture(
      "spread",
      `declare const sc: any; declare const bare: any[];
       const rows = bare.map((r, idx) => ({ ...r, recommendation_id: idx }));
       await sc.from("rank_events").insert(rows);`,
    );
    assert.equal(sites.length, 1);
    assert.deepEqual(sites[0].columns, ["recommendation_id"]);
    assert.equal(
      sites[0].unresolved,
      true,
      "the unread spread must keep the site on the partially-resolvable ledger",
    );
  });

  it("refuses a callback passed by NAME rather than written inline", () => {
    // Following an identifier to a mapper in another module is exactly the
    // inference this extension does not attempt; it must skip, not guess.
    const { sites, skipped } = extractFixture(
      "byname",
      `declare const sc: any; declare const xs: any[]; declare const toRow: any;
       const rows = xs.map(toRow);
       await sc.from("t").insert(rows);`,
    );
    assert.equal(sites.length, 0);
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].reason, "payload not statically resolvable");
    assert.equal(skipped[0].method, "insert");
  });

  it("refuses a callback whose return is a CALL, not a literal", () => {
    // The creator-ledger mapper shape. Still a blind spot, still ledgered.
    const { sites, skipped } = extractFixture(
      "callret",
      `declare const sc: any; declare const xs: any[]; declare const toRow: any;
       const rows = xs.map((x) => toRow(x));
       await sc.from("t").insert(rows);`,
    );
    assert.equal(sites.length, 0);
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].reason, "payload not statically resolvable");
  });

  it("refuses a callback body with no return at all", () => {
    const { sites, skipped } = extractFixture(
      "noreturn",
      `declare const sc: any; declare const xs: any[]; declare const sink: any;
       const rows = xs.map((x) => { sink(x); });
       await sc.from("t").insert(rows);`,
    );
    assert.equal(sites.length, 0);
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].reason, "payload not statically resolvable");
  });
});

describe("the real tree, so the ledger's claims stay true", () => {
  const SCAN_DIRS = ["routes", "services", "domain", "server"].map((d) =>
    resolve(API_ROOT, "src", d),
  );

  it("the rank_events batch insert is checked, not ledgered as unreadable", () => {
    const { sites, skipped } = extractSchemaReferences(API_ROOT, SCAN_DIRS);
    const batch = sites.filter(
      (s) =>
        s.file === "src/routes/rankEvents.ts" &&
        s.method === "insert" &&
        s.table === "rank_events",
    );
    assert.ok(
      batch.length >= 2,
      `expected the batch insert and its retry to resolve, got ${batch.length}`,
    );
    const fully = batch.filter((s) => !s.unresolved);
    assert.ok(fully.length >= 2, "the two insert(bare) statements resolve in full");
    for (const col of [
      "event_type",
      "item_id",
      "surface",
      "user_id",
      "served_at",
      "outcome",
    ]) {
      assert.ok(
        fully.some((s) => s.columns.includes(col)),
        `${col} must be a checked column of the batch insert`,
      );
    }
    assert.equal(
      skipped.filter(
        (s) =>
          s.file === "src/routes/rankEvents.ts" &&
          s.reason === "payload not statically resolvable",
      ).length,
      0,
      "no rank_events insert is a total blind spot any more",
    );
  });

  it("the gem-observation reads name their tables literally", () => {
    // MediaGemStateService passed the table by parameter; three tables and
    // nine columns were invisible to both schema checks because of it.
    const { sites, skipped } = extractSchemaReferences(API_ROOT, SCAN_DIRS);
    assert.equal(
      skipped.filter((s) => s.file === "src/services/media/MediaGemStateService.ts")
        .length,
      0,
      "no read in this file may go back to a dynamic table name",
    );
    for (const table of [
      "hidden_gem_verifications",
      "hidden_gem_visits",
      "hidden_gem_contributions",
    ]) {
      const read = sites.find(
        (s) =>
          s.file === "src/services/media/MediaGemStateService.ts" &&
          s.method === "select" &&
          s.table === table,
      );
      assert.ok(read, `${table} must be read through a literal .from()`);
      assert.ok(read!.columns.includes("gem_id"), `${table}.gem_id is checked`);
    }
  });
});
