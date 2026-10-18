/**
 * The schema-capability memo is per database URL (independent verification pass 12).
 *
 * Production builds a new supabase-js client per request (lib/supabase.ts), so a memo keyed on the client OBJECT never
 * hit: every capability check sent its probe, on every request. And a module-level Set held every memoised client
 * strongly, one per probing request, released only by the test reset. The memo is now per `supabaseUrl` when a client
 * names one (every client this API builds does), else per object (test doubles), and nothing holds a client.
 *
 *   node --import tsx/esm --test src/test/schemaCapabilityMemoPerUrl.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { probeSchemaReadiness, resetSchemaCapabilityMemo, markSchemaMissing, ABSENT_TTL_MS, READY_TTL_MS } from "../lib/capability/schemaCapability.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const def: any = { flag: "memo_per_url_test_enabled", requires: { tables: { some_table: { columns: [] } } }, providedBy: ["some_migration.sql"], note: "" };

function client(url: string | undefined, counter: { n: number }) {
  const c: any = {
    from() {
      counter.n += 1;
      const b: any = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: null, error: null }) };
      return b;
    },
  };
  if (url !== undefined) c.supabaseUrl = url;
  return c;
}

describe("the schema-capability memo is per database URL", () => {
  beforeEach(() => resetSchemaCapabilityMemo());

  it("RED before: two DISTINCT clients for the same database send ONE probe within the TTL", async () => {
    const counter = { n: 0 };
    const t0 = 1_000_000;
    const a = await probeSchemaReadiness(client("http://db.example", counter), def, { now: t0 });
    const b = await probeSchemaReadiness(client("http://db.example", counter), def, { now: t0 + 1000 });
    assert.equal(a.state, "ready");
    assert.equal(b.state, "ready");
    assert.equal(counter.n, 1, "the second request's new client must be served from the memo");
  });

  it("the TTL still expires, so a press or an outage is noticed without a restart", async () => {
    const counter = { n: 0 };
    const t0 = 2_000_000;
    await probeSchemaReadiness(client("http://db.example", counter), def, { now: t0 });
    await probeSchemaReadiness(client("http://db.example", counter), def, { now: t0 + READY_TTL_MS + 1 });
    assert.equal(counter.n, 2);
    assert.ok(ABSENT_TTL_MS < READY_TTL_MS);
  });

  it("CONTROL: two different databases do not share a verdict", async () => {
    const counter = { n: 0 };
    await probeSchemaReadiness(client("http://db-one.example", counter), def, { now: 3_000_000 });
    await probeSchemaReadiness(client("http://db-two.example", counter), def, { now: 3_000_001 });
    assert.equal(counter.n, 2);
  });

  it("CONTROL: a client that names no URL (a test double) keeps its per-object memo", async () => {
    const counter = { n: 0 };
    const same = client(undefined, counter);
    await probeSchemaReadiness(same, def, { now: 4_000_000 });
    await probeSchemaReadiness(same, def, { now: 4_000_001 });
    await probeSchemaReadiness(client(undefined, counter), def, { now: 4_000_002 });
    assert.equal(counter.n, 2, "the same double is memoised; a different double is not");
  });

  it("RED before: no module-level collection holds a client strongly", () => {
    const src = readFileSync(fileURLToPath(new URL("../lib/capability/schemaCapability.ts", import.meta.url)), "utf8");
    assert.doesNotMatch(src, /^const tracked = new Set<object>\(\);/m, "a Set of clients keeps one per probing request alive forever");
    assert.doesNotMatch(src, /\btracked\.add\(/);
  });
  it("the reactive feed is process-wide too: markSchemaMissing on one client refuses the NEXT request's new client without a round trip", async () => {
    const counter = { n: 0 };
    const t0 = 5_000_000;
    assert.equal((await probeSchemaReadiness(client("http://db.example", counter), def, { now: t0 })).state, "ready");
    markSchemaMissing(client("http://db.example", counter), def, { code: "PGRST204", message: "Could not find the 'x' column of 'some_table' in the schema cache" }, t0 + 1);
    const c = await probeSchemaReadiness(client("http://db.example", counter), def, { now: t0 + 2 });
    assert.equal(c.state, "missing");
    assert.equal(c.cached, true, "served from the per-URL memo");
    assert.equal(counter.n, 1, "no probe was sent: the rejected write flipped the memo for every client of this database");
  });

  it("resetSchemaCapabilityMemo forgets a per-URL verdict as well as a per-object one", async () => {
    const counter = { n: 0 };
    await probeSchemaReadiness(client("http://db.example", counter), def, { now: 6_000_000 });
    resetSchemaCapabilityMemo();
    await probeSchemaReadiness(client("http://db.example", counter), def, { now: 6_000_001 });
    assert.equal(counter.n, 2, "after the reset the next client probes again");
  });
});
