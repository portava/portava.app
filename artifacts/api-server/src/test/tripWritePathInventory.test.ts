/**
 * Trips spec §24 Phase 0 — the write-path inventory is generated from the tree
 * and the document must carry the tree's block (census-trips TR434).
 *
 *   1. the inventory finds what the tree is known to contain: the spine
 *      tables, the kernel's command vocabulary, the commands endpoint as a
 *      kernel issuer, and a legacy direct write;
 *   2. the document's generated block IS the tree's — the same contract the
 *      CI check enforces, so drift fails here first;
 *   3. drift is reported line by line, and an empty or marker-less document
 *      is not a pass.
 *
 * Run: node --import tsx/esm --test src/test/tripWritePathInventory.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { BEGIN, DOC_PATH, END, blockDrift, buildTripInventory, documentBlock, renderInventory, withBlock } from "../scripts/tripWritePathInventory.js";

describe("§24 Phase 0 — the inventory finds the tree", () => {
  const inv = buildTripInventory();
  it("tables: the spine and the kernel-era tables, each with the migration that created it; trip_events is written by 2420", () => {
    const byName = new Map(inv.tables.map((t) => [t.table, t]));
    for (const t of ["trips", "trip_plan_items", "trip_members", "trip_events", "trip_outbox", "trip_decisions", "trip_transport_segments"]) assert.ok(byName.has(t), `${t} inventoried`);
    assert.match(byName.get("trip_events")!.createdBy, /^2420_/);
    assert.match(byName.get("trips")!.createdBy, /baseline/, "the spine predates src/migrations and is inventoried as such");
    assert.ok(byName.get("trip_events")!.kernelWriters.includes("2420"), JSON.stringify(byName.get("trip_events")));
    assert.ok(inv.tables.length >= 25, `${inv.tables.length} tables`);
    assert.deepEqual([...inv.tables.map((t) => t.table)].sort(), inv.tables.map((t) => t.table), "sorted, so the block is stable");
  });
  it("kernel commands: the union in lib/tripKernel.ts, engine commands included", () => {
    for (const c of ["CREATE_TRIP", "ADD_PLAN", "MOVE_PLAN", "CREATE_PROPOSAL", "DECLARE_DISRUPTION", "RECORD_OPPORTUNITY_CHANGE", "OPEN_FREE_WINDOW"]) assert.ok(inv.kernelCommands.includes(c), c);
    assert.ok(inv.kernelCommands.length >= 40, `${inv.kernelCommands.length} commands`);
  });
  it("issuers and direct writes: the commands endpoint issues through the kernel; the legacy plan PATCH writes trip_plan_items directly and is classified `both`", () => {
    assert.ok(inv.kernelIssuers.some((s) => s.file === "src/routes/tripCommands.ts"), "the commands endpoint is a kernel issuer");
    assert.ok(inv.kernelIssuers.some((s) => s.file === "src/routes/tripProjections.ts" && s.commandTypes.includes("CREATE_PROPOSAL")), "the replan route issues CREATE_PROPOSAL");
    assert.ok(inv.directWrites.some((d) => d.file === "src/routes/trips.ts" && d.table === "trip_plan_items" && d.verb === "update"), "the legacy plan PATCH is a direct write");
    const patch = inv.routes.find((r) => r.method === "PATCH" && r.path === "/trips/:tripId/plan/items/:itemId");
    assert.ok(patch, "the plan PATCH route is inventoried");
    assert.equal(patch!.writes, "both", "a kernel path behind the flag and a legacy path without it");
    const commands = inv.routes.find((r) => r.method === "POST" && r.path === "/trips/:tripId/commands");
    assert.equal(commands?.writes, "kernel");
    assert.ok(inv.routes.every((r) => r.method !== "GET" || r.writes === "read"));
    assert.ok(inv.services.includes("src/services/trips/TripFreedomEngine.ts") && inv.services.includes("src/lib/tripKernel.ts"));
  });
});

describe("§24 Phase 0 — the document carries the tree's block (the CI contract)", () => {
  it("docs/architecture/trips-phase0-inventory.md's generated block equals a fresh render", () => {
    const doc = readFileSync(DOC_PATH, "utf8");
    const current = documentBlock(doc);
    assert.ok(current, "the document has its markers");
    const fresh = renderInventory(buildTripInventory());
    const d = blockDrift(current, fresh);
    assert.deepEqual(d, { added: [], removed: [] }, `regenerate the inventory: pnpm -s check:trip-write-path-inventory\n+ ${d.added.slice(0, 5).join("\n+ ")}\n- ${d.removed.slice(0, 5).join("\n- ")}`);
    assert.ok(doc.indexOf(BEGIN) > 0 && doc.indexOf(END) > doc.indexOf(BEGIN), "narrative before, markers in order");
  });
  it("drift is line by line: a table the tree lacks is a removed line, a table the document lacks is an added one; no markers is no block", () => {
    const inv = buildTripInventory();
    const fresh = renderInventory(inv);
    const more = renderInventory({ ...inv, tables: [...inv.tables, { table: "trip_zzz", createdBy: "9999_x.sql", kernelWriters: [] }] });
    const d = blockDrift(fresh, more);
    assert.ok(d.added.some((l) => l.includes("`trip_zzz`")) && d.removed.some((l) => l.startsWith("### Tables —")), JSON.stringify(d));
    const back = blockDrift(more, fresh);
    assert.ok(back.removed.some((l) => l.includes("`trip_zzz`")));
    assert.equal(documentBlock("no markers here"), null);
    assert.throws(() => withBlock("no markers here", fresh), /markers/);
    assert.equal(documentBlock(withBlock(`x\n${BEGIN}\nold\n${END}\ny`, fresh)), fresh);
  });
});
