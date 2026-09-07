/**
 * The direct-trip-write ratchet must actually bite.
 *
 * A burn-down meter that cannot fail is a number on a wall. These assert the
 * three ways this one is supposed to fail — a NEW direct write, a STALE
 * baseline entry, and a scan that finds nothing — plus that the committed
 * baseline currently matches the tree, so the meter is honest on the day it
 * ships.
 *
 * Run: node --import tsx/esm --test src/test/directTripWriteRatchet.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isTripTable,
  findDirectTripWrites,
  compareToBaseline,
  scanTree,
  stripComments,
  ESCAPE_HATCH,
  type DirectTripWrite,
} from "../scripts/checkDirectTripWrites.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = resolve(HERE, "../../scripts/DIRECT_TRIP_WRITES_BASELINE.json");
const BASELINE: Record<string, number> = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));

describe("direct-trip-write ratchet — what counts", () => {
  it("recognises the aggregate root and every trip_* child", () => {
    assert.equal(isTripTable("trips"), true);
    assert.equal(isTripTable("trip_members"), true);
    assert.equal(isTripTable("trip_events"), true);
    assert.equal(isTripTable("profiles"), false);
    assert.equal(isTripTable("tripsomething"), false);
  });

  it("counts a write chain and ignores a read chain", () => {
    const src = [
      `const a = await sc.from("trips").update({ status: "x" }).eq("id", id);`,
      `const b = await sc.from("trips").select("id").eq("id", id).maybeSingle();`,
      `const c = await sc.from("trip_members").insert({ trip_id: id });`,
    ].join("\n");
    const { writes } = findDirectTripWrites(src, "f.ts");
    assert.deepEqual(
      writes.map((w) => `${w.table}.${w.method}`),
      ["trips.update", "trip_members.insert"],
    );
  });

  it("does not count a write that only appears in a comment", () => {
    const src = [
      `// await sc.from("trips").update({ status: "x" });`,
      `/* await sc.from("trip_notes").delete(); */`,
      `const b = await sc.from("trips").select("id");`,
    ].join("\n");
    const { writes } = findDirectTripWrites(src, "f.ts");
    assert.deepEqual(writes, []);
  });

  it("keeps line numbers true after comments are blanked", () => {
    const src = [
      `/* a`,
      `   multi-line`,
      `   comment */`,
      `await sc.from("trips").delete().eq("id", id);`,
    ].join("\n");
    const { writes } = findDirectTripWrites(src, "f.ts");
    assert.equal(writes.length, 1);
    assert.equal(writes[0].line, 4);
  });

  it("stripComments leaves string contents intact — the table name is the subject", () => {
    const out = stripComments(`x.from("trips") // .from("trip_notes")`);
    assert.ok(out.includes(`"trips"`));
    assert.ok(!out.includes("trip_notes"));
  });

  it("exempts a site carrying the escape hatch WITH a reason", () => {
    const src = [
      `// trip-kernel-bypass-ok: an erasure anonymisation, not a state mutation.`,
      `await sc.from("trip_events").update({ actor_id: null }).eq("actor_id", id);`,
    ].join("\n");
    assert.deepEqual(findDirectTripWrites(src, "f.ts").writes, []);
  });

  it("does NOT exempt a bare hatch with no reason — a bypass wearing a note", () => {
    for (const note of [`// trip-kernel-bypass-ok`, `// trip-kernel-bypass-ok:`, `// trip-kernel-bypass-ok: nope`]) {
      const src = `${note}\nawait sc.from("trip_events").update({ actor_id: null }).eq("actor_id", id);`;
      assert.equal(
        findDirectTripWrites(src, "f.ts").writes.length,
        1,
        `"${note}" must not exempt anything`,
      );
    }
  });

  it("does not count a write to a non-trip table", () => {
    const src = `await sc.from("profiles").update({ handle: "x" }).eq("id", id);`;
    assert.deepEqual(findDirectTripWrites(src, "f.ts").writes, []);
  });

  it("counts a write to trip_events, so the kernel's own log cannot be written around", () => {
    const src = `await sc.from("trip_events").insert({ trip_id: id });`;
    const { writes } = findDirectTripWrites(src, "routes/somewhere.ts");
    assert.equal(writes.length, 1);
    // …and trip_events is on NO baseline entry, so such a write is always NEW.
    assert.equal(BASELINE["routes/somewhere.ts"], undefined);
    const { newViolations } = compareToBaseline(writes, BASELINE);
    assert.equal(newViolations.length, 1);
  });
});

describe("direct-trip-write ratchet — it bites", () => {
  const site = (file: string): DirectTripWrite => ({ file, line: 1, table: "trips", method: "update" });

  it("FAILS on a new direct write in a file that is already at its baseline", () => {
    const [file, count] = Object.entries(BASELINE)[0];
    const writes = Array.from({ length: count + 1 }, () => site(file));
    const { newViolations } = compareToBaseline(writes, BASELINE);
    assert.equal(newViolations.length, 1, "one extra write must be reported as one new violation");
  });

  it("FAILS on a new direct write in a file with no baseline entry at all", () => {
    const { newViolations } = compareToBaseline([site("routes/brandNew.ts")], BASELINE);
    assert.equal(newViolations.length, 1);
    assert.equal(newViolations[0].file, "routes/brandNew.ts");
  });

  it("FAILS on a STALE entry — a fixed site must be struck off, not left as headroom", () => {
    const [file, count] = Object.entries(BASELINE)[0];
    const writes = Array.from({ length: count - 1 }, () => site(file));
    const { staleEntries } = compareToBaseline(writes, BASELINE);
    const hit = staleEntries.find((s) => s.file === file);
    assert.ok(hit, "lowering the real count below the baseline must fail until the entry is lowered");
    assert.equal(hit!.baselined, count);
    assert.equal(hit!.found, count - 1);
  });
});

describe("direct-trip-write ratchet — the committed baseline is honest", () => {
  const { writes } = scanTree();

  it("is not vacuous: the tree really does still carry direct trip writes", () => {
    assert.ok(writes.length > 50, `expected a large pre-existing debt, found ${writes.length}`);
  });

  it("matches the tree exactly — no new violations, no stale entries", () => {
    const { newViolations, staleEntries } = compareToBaseline(writes, BASELINE);
    assert.deepEqual(
      newViolations.map((v) => `${v.file}:${v.line}`),
      [],
      "a new direct trip write landed. Route it through src/lib/tripKernel instead.",
    );
    assert.deepEqual(
      staleEntries,
      [],
      "a baselined site went away. Lower its count in scripts/DIRECT_TRIP_WRITES_BASELINE.json.",
    );
  });

  it("exempts the kernel, and only the kernel", () => {
    assert.ok(
      !writes.some((w) => w.file.startsWith("lib/tripKernel/")),
      "the kernel is the sanctioned writer and must not be counted",
    );
    assert.ok(
      Object.keys(BASELINE).some((f) => f.startsWith("routes/trips")),
      "the trips routers are the bulk of the debt and must be on the baseline",
    );
  });

  it("the escape hatch has not proliferated — it is used in exactly one file", () => {
    const hits = execSync(
      `grep -rl "${ESCAPE_HATCH}" src --include=*.ts || true`,
      { cwd: resolve(HERE, "../..") },
    )
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean)
      .filter((f) => !f.endsWith("checkDirectTripWrites.ts") && !f.endsWith(".test.ts"))
      .sort();
    assert.deepEqual(
      hits,
      ["src/services/accountDeletion/AccountDeletionService.ts"],
      "a new escape-hatch site appeared. Each one is a write the kernel does not mediate; " +
        "it needs a reason here as well as at the call site.",
    );
  });

  it("no trip_events write survives the scan — the kernel's log is not written around", () => {
    assert.deepEqual(
      writes.filter((w) => w.table === "trip_events"),
      [],
      "only src/lib/tripKernel may write the event log",
    );
  });

  it("the routed command's own write is gone from the count", () => {
    // POST /trips/:id/complete used to write trips directly. It does not any
    // more, and trips-expansion.ts's baseline entry is one lower than it was.
    const expansion = readFileSync(resolve(HERE, "../routes/trips-expansion.ts"), "utf8");
    const completeRoute = expansion.slice(expansion.indexOf(`router.post("/trips/:tripId/complete"`));
    const body = completeRoute.slice(0, completeRoute.indexOf(`router.post("/trips/:tripId/archive"`));
    assert.ok(body.includes("executeTripCommand"), "the complete route must go through the kernel");
    assert.deepEqual(
      findDirectTripWrites(body, "slice.ts").writes.filter((w) => w.table === "trips"),
      [],
      "the complete route must no longer write public.trips directly",
    );
  });
});
