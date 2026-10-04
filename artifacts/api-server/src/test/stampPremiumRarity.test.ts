/**
 * Premium stamp art rarity — the composition engine's rarity must come from the
 * stamp definition the catalog entry is actually linked to, and an unreadable
 * link must FAIL the job rather than paint the stamp "common".
 *
 * THE DEFECT (passport lane, 2026-10-03). `rarityForCatalog` filtered
 * `stamp_definitions` on `catalog_id` — a column that table does not have, in
 * the canonical chain or on the hosted testing database (read-only
 * information_schema SELECT, 2026-10-03). PostgREST rejects the unknown name
 * with 42703, the function caught it and answered "common", so EVERY premium
 * stamp was composed as common: a legendary definition's art got the common
 * frame, and nothing logged it.
 *
 * The link that does exist is `user_stamps (stamp_definition_id, catalog_id)`,
 * plus the queue row's `triggered_by_action = "user_stamp:<id>"` for the award
 * that enqueued the job (the worker can claim the job before the award engine
 * back-fills `user_stamps.catalog_id`).
 *
 * Run: node --import tsx/esm --test src/test/stampPremiumRarity.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// The worker reads these at import time: keep the cycle test to the one job.
process.env.STAMP_FAILED_REQUEUE_HOURS = "0";
process.env.STAMP_STALE_SWEEP_INTERVAL_MINUTES = "0";
const { rarityForCatalog } = await import("../lib/stamps/generationWorker.js");
import { makeSchemaStrictClient } from "./helpers/schemaStrictSupabase.ts";
import { makeFailClosedClient } from "./helpers/failClosedSupabase.ts";

const CAT = "c0000000-0000-4000-8000-000000000001";
const DEF_LEG = "d0000000-0000-4000-8000-00000000000a";
const DEF_RARE = "d0000000-0000-4000-8000-00000000000b";
const US_1 = "a0000000-0000-4000-8000-000000000001";
const US_2 = "a0000000-0000-4000-8000-000000000002";
const USER = "e0000000-0000-4000-8000-000000000001";

function us(id: string, def: string | null, catalog: string | null) {
  return { id, user_id: USER, stamp_definition_id: def, catalog_id: catalog, is_revoked: false };
}
const defs = [
  { id: DEF_LEG, slug: "globe_trotter_legend", rarity: "legendary" },
  { id: DEF_RARE, slug: "first_city", rarity: "rare" },
];

describe("rarityForCatalog — reads only columns the live schema has", () => {
  it("a catalog entry linked to ONE legendary definition composes as legendary", async () => {
    const sc = makeSchemaStrictClient({
      user_stamps: [us(US_1, DEF_LEG, CAT)],
      stamp_definitions: defs,
    });
    const r = await rarityForCatalog(sc as any, CAT, null);
    assert.deepEqual(sc.deadColumnErrors, [], "named a column the live schema does not have");
    assert.equal(r.rarity, "legendary");
    assert.equal(r.basis, "definition");
    assert.equal(r.definitionId, DEF_LEG);
  });

  it("the triggering award resolves the definition before catalog_id is back-filled", async () => {
    const sc = makeSchemaStrictClient({
      user_stamps: [us(US_1, DEF_RARE, null)],
      stamp_definitions: defs,
    });
    const r = await rarityForCatalog(sc as any, CAT, `user_stamp:${US_1}`);
    assert.deepEqual(sc.deadColumnErrors, []);
    assert.equal(r.rarity, "rare");
    assert.equal(r.basis, "definition");
  });

  it("artwork shared by two definitions is common, and SAYS why", async () => {
    const sc = makeSchemaStrictClient({
      user_stamps: [us(US_1, DEF_LEG, CAT), us(US_2, DEF_RARE, CAT)],
      stamp_definitions: defs,
    });
    const r = await rarityForCatalog(sc as any, CAT, null);
    assert.equal(r.rarity, "common");
    assert.equal(r.basis, "shared_by_definitions");
  });

  it("no linked definition at all is common, and SAYS why", async () => {
    const sc = makeSchemaStrictClient({ user_stamps: [], stamp_definitions: defs });
    const r = await rarityForCatalog(sc as any, CAT, "admin:regenerate");
    assert.equal(r.rarity, "common");
    assert.equal(r.basis, "no_linked_definition");
  });
});

describe("rarityForCatalog — an unreadable link fails loudly, never 'common'", () => {
  for (const table of ["user_stamps", "stamp_definitions"]) {
    it(`a failed ${table} read rejects with rarity_unresolved`, async () => {
      const sc = makeFailClosedClient({
        rows: { user_stamps: [us(US_1, DEF_LEG, CAT)], stamp_definitions: defs },
        failOn: (ctx) => (ctx.table === table ? { message: "boom", code: "57P01" } : null),
      });
      await assert.rejects(
        () => rarityForCatalog(sc, CAT, null),
        // "read failed" — an outage, not the missing-row refusal below.
        (e: any) => /^rarity_unresolved: .*read failed/.test(e.message) && e.message.includes(table),
      );
    });
  }

  it("a failed read of the TRIGGERING award rejects", async () => {
    const sc = makeFailClosedClient({
      rows: { user_stamps: [us(US_1, DEF_LEG, CAT)], stamp_definitions: defs },
      failOn: (ctx) => (ctx.table === "user_stamps" && ctx.eq("id") === US_1 ? { message: "boom" } : null),
    });
    await assert.rejects(() => rarityForCatalog(sc, CAT, `user_stamp:${US_1}`), /rarity_unresolved/);
  });

  it("a definition id that resolves to no definition row rejects", async () => {
    const sc = makeFailClosedClient({
      rows: { user_stamps: [us(US_1, DEF_LEG, CAT)], stamp_definitions: [] },
    });
    await assert.rejects(() => rarityForCatalog(sc, CAT, null), /rarity_unresolved/);
  });

  it("the second-definition probe failing rejects (it decides 'shared')", async () => {
    const sc = makeFailClosedClient({
      rows: { user_stamps: [us(US_1, DEF_LEG, CAT)], stamp_definitions: defs },
      failOn: (ctx) =>
        ctx.table === "user_stamps" && ctx.filters.some((f) => f.op === "neq") ? { message: "boom" } : null,
    });
    await assert.rejects(() => rarityForCatalog(sc, CAT, null), /rarity_unresolved/);
  });
});

describe("runGenerationCycle — premium job whose rarity cannot be read", () => {
  it("does not generate, does not compose, and puts the job back with rarity_unresolved", async () => {
    const { runGenerationCycle } = await import("../lib/stamps/generationWorker.js");
    const { _setTestStampImageProvider } = await import("../lib/stamps/imageProvider.js");
    const { _setTestServiceClient } = await import("../lib/supabase.js");

    let generateCalls = 0;
    _setTestStampImageProvider({
      async generate() { generateCalls++; return []; },
    } as any);

    const updated: Record<string, any[]> = {};
    const sc = makeFailClosedClient({
      rows: {
        stamp_generation_queue: [{
          id: "job-r-1", catalog_id: CAT, status: "queued", attempts: 0, max_attempts: 3,
          triggered_by_action: `user_stamp:${US_1}`, locked_until: null, priority: 1,
          created_at: "2026-10-03T00:00:00Z",
        }],
        universal_stamp_catalog: [{
          id: CAT, canonical_location_key: "jp/kyoto", stamp_type: "city", display_name: "Kyoto",
          country: "Japan", country_code: "JP", region: null, city: "Kyoto", neighborhood: null,
        }],
        feature_flags: [{ flag: "stamp_premium_rendering_enabled", enabled: true }],
        user_stamps: [us(US_1, DEF_LEG, CAT)],
        stamp_definitions: defs,
      },
      updated,
      failOn: (ctx) => (ctx.table === "user_stamps" ? { message: "connection reset", code: "57P01" } : null),
    });
    _setTestServiceClient(sc);
    try {
      const r = await runGenerationCycle();
      assert.equal(r.processed, false);
      assert.equal(generateCalls, 0, "spent a paid generation on a job whose rarity was unknown");
      const queueWrites = updated.stamp_generation_queue ?? [];
      const final = queueWrites[queueWrites.length - 1];
      assert.ok(final, "the job was never put back");
      assert.equal(final.status, "queued");
      assert.match(String(final.last_error), /^rarity_unresolved:/);
      assert.equal((updated.stamp_artwork_versions ?? []).length, 0);
    } finally {
      _setTestServiceClient(null);
      _setTestStampImageProvider(null as any);
    }
  });
});
