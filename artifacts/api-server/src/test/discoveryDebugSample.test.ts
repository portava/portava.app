/**
 * census-discovery §62 (DV-52) — the ranking debug sample production accepts,
 * and a refusal that is SURFACED rather than swallowed.
 *
 * §59 pinned (db/discoveryVerifyExplain X1/X5): every sample omitted
 * production's NOT NULL `content_type` / `content_id`, was refused 23502, and
 * `.then(() => {}, () => {})` threw the refusal away. The harness suite proves
 * the rows now land (with 3421 applied). These offline cases pin the writer's
 * own contract, on a recording stub:
 *
 *   D1  content_id is the item id only when it IS a uuid — never a `db/` uuid
 *       (whose table the id does not state), never a minted one
 *   D2  every sample carries content_type = the item's type, and the column
 *       set is exactly the one the writer names
 *   D3  a refusal that RESOLVES with { error } (PostgREST's shape; 23502 before
 *       3421) is logged with its code, surface, item and type, and counted —
 *       and the ranked output is byte-identical to a healthy run
 *   D4  a REJECTED insert is logged and counted, never an unhandled rejection
 *   D5  an insert that THROWS synchronously never reaches the ranked request
 *   D6  flag off: no sample, no warning — the sampler is inert
 *
 * Run: node --import tsx/esm --test src/test/discoveryDebugSample.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  rankItems, sampleContentId, _debugSampleRefusalCount,
  type RankingInput, type RankingViewerContext,
} from "../services/ranking/DiscoveryRankingService.js";
import { logger } from "../lib/logger.js";

const UUID = "3f2b8c1e-5a6d-4e7f-8a9b-0c1d2e3f4a5b";
const DB_UUID = "0d9e8f7a-6b5c-4d3e-8f2a-1b0c9d8e7f6a";

function viewer(): RankingViewerContext {
  return {
    viewerId: "aaaaaaaa-aaaa-aaaa-aaaa-000000000001", travelStyles: ["food"], preferredLanguages: ["en"],
    preferredCities: ["lisbon"], currentCity: "lisbon", currentCountry: "PT", lat: null, lng: null, viewerAge: null,
    followedCreatorIds: new Set<string>(), mutedCreatorIds: new Set<string>(), sessionId: "sess-62",
  } as RankingViewerContext;
}

function item(itemId: string, itemType: string): RankingInput {
  return {
    itemId, itemType, creatorId: null, createdAt: null, city: "lisbon", country: "PT", tags: ["food"],
    category: "food", languageCode: "en", hasMedia: false, distanceKm: 1,
  } as RankingInput;
}

const ITEMS = () => [item(`db/${DB_UUID}`, "place"), item("node/4242", "place"), item(UUID, "post")];

type Mode = "ok" | "error" | "reject" | "throw";
interface Recorded { table: string; row: any }

/** Recording stub: every read resolves empty; `mode` decides how a debug-sample insert settles. */
function stubDb(mode: Mode) {
  const inserts: Recorded[] = [];
  const chain: any = {
    select() { return chain; }, eq() { return chain; }, in() { return Promise.resolve({ data: [], error: null }); },
    gte() { return Promise.resolve({ data: [], error: null }); }, maybeSingle() { return Promise.resolve({ data: null, error: null }); },
    then(ok: any, bad: any) { return Promise.resolve({ data: [], error: null }).then(ok, bad); },
  };
  return {
    inserts,
    from(table: string) {
      return {
        ...chain,
        insert(row: any) {
          inserts.push({ table, row });
          if (table !== "ranking_debug_samples") return Promise.resolve({ data: null, error: null });
          if (mode === "throw") throw new Error("connection reset");
          if (mode === "reject") return Promise.reject(new Error("socket hang up"));
          if (mode === "error") {
            return Promise.resolve({ data: null, error: { code: "23502", message: 'null value in column "content_id" of relation "ranking_debug_samples" violates not-null constraint' } });
          }
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
  } as any;
}

const FLAGS_ON = { flags: { RANKING_EXPERIMENT_ENABLED: true }, activityScores: new Map(), fatiguedCreators: new Set() } as any;
const FLAGS_OFF = { flags: { RANKING_EXPERIMENT_ENABLED: false }, activityScores: new Map(), fatiguedCreators: new Set() } as any;
const settle = () => new Promise((r) => setTimeout(r, 20));
const samples = (db: { inserts: Recorded[] }) => db.inserts.filter((i) => i.table === "ranking_debug_samples").map((i) => i.row);

async function run(mode: Mode, overrides = FLAGS_ON) {
  const db = stubDb(mode);
  const out = await rankItems(ITEMS(), "discovery", viewer(), db, overrides, { emitPerCandidateAnalytics: false, nowMs: 1_790_000_000_000 });
  await settle();
  return { db, out: out.map((o) => [o.itemId, o.finalScore, o.explanationKey]) };
}

let warnings: Array<{ ctx: any; msg: string }>;
let originalWarn: typeof logger.warn;
let realRandom: () => number;
beforeEach(() => {
  warnings = [];
  originalWarn = logger.warn.bind(logger);
  (logger as any).warn = (ctx: any, msg?: string) => { warnings.push({ ctx, msg: msg ?? "" }); };
  realRandom = Math.random;
  Math.random = () => 0;   // sample EVERY item (the writer samples 1-in-10)
});
afterEach(() => { (logger as any).warn = originalWarn; Math.random = realRandom; });

describe("ranking debug sample (census-discovery §62, DV-52)", () => {
  it("D1. content_id is the item id only when it IS a uuid", () => {
    assert.equal(sampleContentId(UUID), UUID);
    assert.equal(sampleContentId(UUID.toUpperCase()), UUID.toUpperCase());
    assert.equal(sampleContentId(`db/${DB_UUID}`), null, "a db/ uuid names a discovery_places OR a places row: not stated, so not written");
    assert.equal(sampleContentId("node/4242"), null);
    assert.equal(sampleContentId(""), null);
    assert.equal(sampleContentId(`${UUID}x`), null);
  });

  it("D2. every sample carries the item's type, a uuid content_id only where one exists, and exactly the writer's columns", async () => {
    const { db } = await run("ok");
    const rows = samples(db);
    assert.equal(rows.length, 3, "one sample per scored item");
    assert.deepEqual(rows.map((r) => [r.item_id, r.content_type, r.content_id]).sort(),
      [[`db/${DB_UUID}`, "place", null], ["node/4242", "place", null], [UUID, "post", UUID]].sort());
    for (const r of rows) {
      assert.deepEqual(Object.keys(r).sort(), ["components", "content_id", "content_type", "explanation_key", "final_score",
        "item_id", "sampled_at", "session_id", "surface", "viewer_id"]);
    }
    assert.equal(warnings.filter((w) => w.msg === "rankingDebugSample: insert refused").length, 0, "a healthy write logs nothing");
  });

  it("D3. a refusal that RESOLVES with { error } is logged with context and counted — and the ranked output is unchanged", async () => {
    const healthy = await run("ok");
    warnings = [];
    const before = _debugSampleRefusalCount();
    const refused = await run("error");
    assert.deepEqual(refused.out, healthy.out, "the served order and scores do not depend on the sample");
    assert.equal(_debugSampleRefusalCount() - before, 3, "each refusal is counted");
    const logged = warnings.filter((w) => w.msg === "rankingDebugSample: insert refused");
    assert.equal(logged.length, 3, "each refusal is logged, never discarded");
    for (const w of logged) {
      assert.equal(w.ctx.code, "23502");
      assert.equal(w.ctx.table, "ranking_debug_samples");
      assert.equal(w.ctx.surface, "discovery");
      assert.ok(typeof w.ctx.itemId === "string" && typeof w.ctx.itemType === "string");
      assert.match(String(w.ctx.hint), /3421/, "a 23502 names the migration that ends it");
    }
  });

  it("D4. a REJECTED insert is logged and counted, never an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const before = _debugSampleRefusalCount();
      const r = await run("reject");
      assert.equal(r.out.length, 3);
      assert.equal(_debugSampleRefusalCount() - before, 3);
      assert.equal(warnings.filter((w) => w.msg === "rankingDebugSample: insert refused").length, 3);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    assert.deepEqual(unhandled, []);
  });

  it("D5. an insert that THROWS never reaches the ranked request", async () => {
    const healthy = await run("ok");
    warnings = [];
    const before = _debugSampleRefusalCount();
    const thrown = await run("throw");
    assert.deepEqual(thrown.out, healthy.out);
    assert.equal(_debugSampleRefusalCount() - before, 3);
    const logged = warnings.filter((w) => w.msg === "rankingDebugSample: insert refused");
    assert.equal(logged.length, 3, "each throw is logged");
    assert.ok(logged.every((w) => /connection reset/.test(String(w.ctx.err?.message))), "with the error that was thrown");
  });

  it("D6. flag off: no sample is attempted and nothing is logged", async () => {
    const before = _debugSampleRefusalCount();
    const { db } = await run("error", FLAGS_OFF);
    assert.equal(samples(db).length, 0);
    assert.equal(_debugSampleRefusalCount(), before);
    assert.equal(warnings.filter((w) => w.msg === "rankingDebugSample: insert refused").length, 0);
  });
});
