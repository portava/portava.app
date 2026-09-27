/**
 * census-discovery §57 — A10 (Trips `:25`, `:488`): *"Map, Compass,
 * Discovery… consume explicit Trip projections/contracts rather than
 * duplicating Trip semantics."*
 *
 * A RATCHET, NOT A CLOSURE. §57 re-derived every place a Discovery module still
 * reads a Trip table directly, and found four. None could be moved to the
 * Trip-owned projection as a read-path change with no behaviour change:
 *
 *   routes/discoverySearch.ts  searchTrips, `trips`        — the LEGACY arm of
 *   routes/discoverySearch.ts  searchPlans, `trips`          the capability
 *                                (`discovery_trip_projection_enabled` 2550 AND
 *                                2420's `trips.version`). The projection arm
 *                                already exists beside each; switching the
 *                                legacy arm over IS the behaviour change the
 *                                capability exists to hold back (production
 *                                lacks 2420, so the projection reader fails
 *                                closed on every request there).
 *   routes/discoverySearch.ts  searchPlans, `trip_plan_items` — read on BOTH
 *                                arms. Trips publishes no plan-item projection
 *                                (domain/trips/contracts has none), so there is
 *                                nothing to move it to.
 *   services/location/DiscoveryLocationContext.ts  getNextTripCity, `trips` —
 *                                "the viewer's next trip" for `?context=going_soon`,
 *                                re-deciding which statuses count ('planning',
 *                                'active' — not 'upcoming') and whose trips
 *                                count (owned only — not joined). Trips
 *                                publishes no viewer-trip projection either.
 *
 * This file pins that inventory. A NEW direct Trip read in a Discovery module
 * fails here and has to go through a Trip contract instead; one of the four
 * removed (because Trips published what it needs) fails here too, so the
 * census row is re-graded rather than left describing a duplicate that is gone.
 *
 * Run: node --import tsx/esm --test src/test/discoveryTripReadInventory.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SRC = fileURLToPath(new URL("..", import.meta.url));

/** Every module this census counts as Discovery's, by the census's own globs. */
function discoveryFiles(): string[] {
  const dirs: Array<[string, RegExp]> = [
    [path.join(SRC, "lib"), /^(discovery|mapDiscovery).*\.ts$/],
    [path.join(SRC, "routes"), /^discovery.*\.ts$/],
  ];
  const files = dirs.flatMap(([dir, re]) => readdirSync(dir).filter((f) => re.test(f)).map((f) => path.join(dir, f)));
  files.push(path.join(SRC, "services", "location", "DiscoveryLocationContext.ts"));
  return files.sort();
}

/** `.from("trip…")` sites, comments stripped, as `file · table · function`. */
function tripReads(): Array<{ file: string; table: string; fn: string; at: number; text: string }> {
  const out: Array<{ file: string; table: string; fn: string; at: number; text: string }> = [];
  for (const f of discoveryFiles()) {
    const raw = readFileSync(f, "utf8");
    const text = raw.split("\n").map((l) => l.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "")).join("\n");
    const re = /\.from\(\s*["'`](trip[a-z_]*)["'`]\s*\)/g;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const before = text.slice(0, m.index);
      const fnMatch = [...before.matchAll(/(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*[(<]/g)].pop();
      out.push({ file: path.relative(SRC, f), table: m[1]!, fn: fnMatch?.[1] ?? "?", at: m.index, text });
    }
  }
  return out;
}

const EXPECTED = [
  "routes/discoverySearch.ts · trips · searchTrips",
  "routes/discoverySearch.ts · trip_plan_items · searchPlans",
  "routes/discoverySearch.ts · trips · searchPlans",
  "services/location/DiscoveryLocationContext.ts · trips · getNextTripCity",
].map((s) => s.split("/").join(path.sep)).sort();

describe("§57 A10 — every direct Trip read left in Discovery, named", () => {
  it("I1 the inventory is exactly the four named sites — no new one, none silently gone", () => {
    const got = tripReads().map((r) => `${r.file} · ${r.table} · ${r.fn}`).sort();
    assert.deepEqual(got, EXPECTED);
  });

  it("I2 both `trips` reads in discoverySearch sit in the LEGACY arm, beside a projection arm, behind the capability", () => {
    const reads = tripReads().filter((r) => r.file.endsWith("discoverySearch.ts") && r.table === "trips");
    assert.equal(reads.length, 2);
    for (const r of reads) {
      const gateAt = r.text.lastIndexOf('if (gate.source === "projection")', r.at);
      assert.ok(gateAt > 0, `${r.fn}: no capability branch precedes the trips read`);
      const between = r.text.slice(gateAt, r.at);
      assert.match(between, /Projections?\(sc,/, `${r.fn}: the projection arm must call a Trip-owned reader`);
      assert.match(between, /\}\s*else\s*\{/, `${r.fn}: the direct trips read escaped the legacy arm`);
      const gateRead = r.text.lastIndexOf("await discoveryTripProjectionGate(sc)", gateAt);
      assert.ok(gateRead > 0 && gateAt - gateRead < 400, `${r.fn}: the branch is not decided by the capability`);
    }
  });

  it("I3 the Trip-owned contract Discovery consumes still exists, and states the visibility rule once", () => {
    const contract = readFileSync(path.join(SRC, "domain", "trips", "contracts", "tripDiscoveryProjection.ts"), "utf8");
    assert.match(contract, /export async function searchTripDiscoveryProjections\(/);
    assert.match(contract, /export async function readTripDiscoveryProjections\(/);
    assert.match(contract, /discoverable: boolean;/);
  });
});
