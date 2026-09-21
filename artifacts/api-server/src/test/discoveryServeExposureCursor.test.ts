/**
 * DC-22 — `GET /discovery` must hand the client (a) the exposure id it minted
 * for each served item and (b) a cursor it can page with.
 *
 * LEG 1 — THE RECOMMENDATION ID WAS MINTED AND THEN THROWN AWAY
 * ============================================================
 * `lib/discoveryRecommendationId.ts` derives `04` §5's exposure id, and
 * `lib/discoveryServeLog.ts` writes it into `rank_events.features` for every
 * item a serve-log path puts in front of a user. The client never saw it:
 * `recommendationId` had ZERO occurrences in `routes/discovery.ts`. So the
 * server could say "these twenty exposures happened" and the client could say
 * "the user tapped this place", and nothing could join the two — the outcome
 * arrived against an ITEM, while the denominator was keyed to an EXPOSURE.
 *
 * The assertion that matters is therefore NOT "the response has an id field".
 * An id the response invents for itself would satisfy that and join to nothing.
 * It is R2: the id on the response is BYTE-EQUAL to the id on the row the same
 * request wrote. That is what "report an outcome against the same exposure"
 * means, and it is the only form of this test that can fail for the real reason.
 *
 * LEG 2 — CURSOR PAGINATION, ALONGSIDE `page`
 * ===========================================
 * The route reads `req.query.page` and slices `(page-1)*PAGE_SIZE .. page*PAGE_SIZE`.
 * `GET /discovery/feed` — in the same file — already speaks `cursor`/`nextCursor`
 * through `decodeOffset`/`encodeOffset`, so a client paging Discovery had to use
 * one vocabulary on one route and a different one on the other.
 *
 * This is ADDITIVE and C2/C4 are the guards on that word. C2: with no `cursor`
 * in the query, every `page` value must select exactly the items it selected
 * before — a cursor implementation that shifts the `page` window by even one
 * item has broken every existing client to serve a new one. C4: the RESPONSE
 * shape does not move either, which is why `cursor` is an input vocabulary and
 * there is no `nextCursor` key. `discoveryCuratedSourceRefusal.test.ts`
 * CONTROL 2 pins the success envelope's exact key list on all four serve paths,
 * and that pin is not this row's to break; C4 asserts the same fact from this
 * side, so a later attempt to emit the key fails HERE too and has to be an
 * argued change rather than an accident.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx --test src/test/discoveryServeExposureCursor.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import pino from "pino";
import discoveryRouter, {
  _setTestDbPlacesOverride,
  _injectTestCacheEntry,
  _clearTestCacheEntry,
  type DiscoveryPlace,
} from "../routes/discovery.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { invalidateDiscoveryEngineModeCache } from "../lib/discoveryEngineMode.js";
import {
  DISCOVERY_SERVE_LOG_FLAG,
  invalidateServeLogFlagCache,
} from "../lib/discoveryServeLog.js";

const USER  = "aaaa1111-0000-0000-0000-0000000000c2";
const TOKEN = "dc22-tok";
/** cacheKey(dest.toLowerCase().trim(), category, radiusKm) — the cache-A key. */
const KEY   = "miami:for_you:10";
/** routes/discovery.ts's own PAGE_SIZE. Stated here so a change to it fails loudly. */
const PAGE_SIZE = 20;
/** Two full pages' worth minus fifteen, so page 2 is short and page 3 is empty. */
const TOTAL = 25;

/** The route's own cursor alphabet — `decodeOffset` reads base64url of the decimal offset. */
const cursorFor = (offset: number) => Buffer.from(String(offset)).toString("base64url");

function cand(id: string, savedCount: number): DiscoveryPlace {
  return {
    id: `db/${id}`, name: id, category: "for_you", type: "traveler_pick",
    description: null, distanceKm: 1.0, lat: 25.77, lng: -80.19, tags: [],
    address: "Miami, FL", website: null, phone: null, openingHours: null,
    rating: null, isOpenNow: null, savedCount,
  } as DiscoveryPlace;
}

/** 25 distinct places in a fixed order — p00 … p24. */
function candidates(): DiscoveryPlace[] {
  return Array.from({ length: TOTAL }, (_, i) => cand(`p${String(i).padStart(2, "0")}`, i));
}

// ── Capturing service client (modelled on discoveryRouteRecommendationPropagation) ──

function fakeClient(opts: { serveLog: boolean }) {
  const inserts: Array<{ table: string; rows: any[] }> = [];

  function benign(table: string): any {
    const q: any = {
      select: () => q, eq: () => q, in: () => q, is: () => q, or: () => q,
      neq: () => q, not: () => q, ilike: () => q, like: () => q,
      gte: () => q, lte: () => q, gt: () => q, lt: () => q, order: () => q,
      limit: () => q, range: () => q, contains: () => q, overlaps: () => q,
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({ data: null, error: null }),
      insert: (data: any) => {
        const rows = Array.isArray(data) ? data : [data];
        inserts.push({ table, rows });
        return Promise.resolve({ data: null, error: null });
      },
      upsert: () => Promise.resolve({ data: null, error: null }),
      update: () => q, delete: () => q,
      // A DELIBERATE 5ms stall on the `blocks` read, and R2 depends on it.
      //
      // `fetchBlockedSet` runs INSIDE the request, after the route mints the
      // exposure and long before the serve log — fired after res.json — reads
      // its own clock. Everything else in this harness is in-memory, so a
      // whole cache-A serve can complete inside a single millisecond; an
      // implementation where the route and the writer each mint their own
      // timestamp would then produce matching ids BY COINCIDENCE, and R2 would
      // pass while proving nothing. Five milliseconds makes the coincidence
      // impossible (verified by mutation: with the writer reading its own
      // clock, R2 fails every run), so R2 can only pass if the two share ONE
      // exposure — which is the property under test.
      then: (r: any) => (table === "blocks"
        ? new Promise((done) => setTimeout(done, 5)).then(() => ({ data: [], error: null }))
        : Promise.resolve({ data: [], error: null })).then(r),
    };
    return q;
  }

  const client = {
    auth: {
      getUser: async (t: string) =>
        t === TOKEN ? { data: { user: { id: USER } }, error: null }
                    : { data: { user: null }, error: null },
    },
    from(table: string) {
      if (table !== "feature_flags") return benign(table);
      let flag = "";
      const q: any = {
        select: () => q,
        eq: (col: string, val: any) => { if (col === "flag") flag = val; return q; },
        like: () => ({ then: (r: any) => Promise.resolve({ data: [], error: null }).then(r) }),
        maybeSingle: async () => {
          if (flag === "DISCOVERY_ENGINE_MODE") {
            return {
              data: { enabled: true, metadata: { mode: "legacy", cohort: { kind: "all" } } },
              error: null,
            };
          }
          if (flag === DISCOVERY_SERVE_LOG_FLAG) {
            // A DELIBERATE 5ms stall, and R2 depends on it.
            //
            // The serve log reads this flag AFTER the response has been flushed
            // and BEFORE it stamps `served_at`. Without the stall the writer's
            // own clock read usually lands in the same millisecond as the
            // route's, so an implementation where each side mints its own
            // timestamp produces matching ids BY COINCIDENCE and R2 passes
            // while proving nothing. Five milliseconds makes the coincidence
            // impossible, so R2 can only pass if the route and the writer share
            // ONE exposure — which is the property under test.
            await new Promise((r) => setTimeout(r, 5));
            return opts.serveLog
              ? { data: { enabled: true }, error: null }
              : { data: null, error: null };
          }
          return { data: null, error: null };
        },
        then: (r: any) => Promise.resolve({ data: [], error: null }).then(r),
      };
      return q;
    },
    rpc: async () => ({ data: null, error: null }),
  } as any;

  return {
    client,
    /** IMPRESSION rows only — `analytics` rows are scored candidates, not exposures. */
    rankEventRows: () =>
      inserts.filter((i) => i.table === "rank_events")
             .flatMap((i) => i.rows)
             .filter((r: any) => r.outcome === "impression"),
  };
}

function makeApp() {
  const app = express();
  app.use((req, _res, next) => { (req as any).log = pino({ level: "silent" }); next(); });
  app.use(discoveryRouter);
  return app;
}

function startServer(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer(makeApp());
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${(server.address() as any).port}` });
    });
  });
}

interface ServedPlace { id: string; recommendationId?: string }
interface ServedBody { places: ServedPlace[]; total: number; keys: string[] }

async function serve(url: string, query: string, opts: { auth: boolean } = { auth: true }): Promise<ServedBody> {
  const res = await fetch(`${url}/discovery?destination=Miami&lat=25.77&lng=-80.19${query}`, {
    headers: opts.auth ? { authorization: `Bearer ${TOKEN}` } : {},
  });
  assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  const body = (await res.json()) as { places?: ServedPlace[]; total: number };
  return { places: body.places ?? [], total: body.total, keys: Object.keys(body) };
}

/** Every serve-log write is un-awaited and lands AFTER res.json. Poll, do not guess. */
async function waitForRows(f: ReturnType<typeof fakeClient>, atLeast: number): Promise<any[]> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const rows = f.rankEventRows();
    if (rows.length >= atLeast || Date.now() > deadline) return rows;
    await new Promise((r) => setTimeout(r, 10));
  }
}

const ids = (b: ServedBody) => b.places.map((p) => p.id);

describe("DC-22 leg 1 — the served exposure id reaches the client", () => {
  let server: Server;
  let url: string;

  beforeEach(async () => {
    ({ server, url } = await startServer());
    _setTestDbPlacesOverride(async () => []);
    invalidateDiscoveryEngineModeCache();
    invalidateServeLogFlagCache();
  });
  afterEach(async () => {
    _clearTestCacheEntry(KEY);
    _setTestDbPlacesOverride(null);
    _setTestServiceClient(null);
    invalidateDiscoveryEngineModeCache();
    invalidateServeLogFlagCache();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("R1. every served place carries a distinct, non-blank recommendationId", async () => {
    const f = fakeClient({ serveLog: true });
    _setTestServiceClient(f.client);
    _injectTestCacheEntry(KEY, candidates());

    const body = await serve(url, "");
    assert.equal(body.places.length, PAGE_SIZE, "precondition: a full first page was served");

    const recIds = body.places.map((p) => p.recommendationId);
    for (const r of recIds) {
      assert.equal(typeof r, "string", "04 §5: every SERVED item must carry its recommendation id");
      assert.ok((r as string).length > 0, "a blank id is an absent id wearing a field name");
    }
    assert.equal(
      new Set(recIds).size, recIds.length,
      "two items on one page are two exposures and must not share one id",
    );
  });

  it("R2. the id on the response IS the id on the row — the same exposure, not a lookalike", async () => {
    const f = fakeClient({ serveLog: true });
    _setTestServiceClient(f.client);
    _injectTestCacheEntry(KEY, candidates());

    const body = await serve(url, "");
    const rows = await waitForRows(f, PAGE_SIZE);
    assert.equal(rows.length, PAGE_SIZE, "precondition: the serve wrote one exposure row per served item");
    assert.deepEqual(
      rows.map((r: any) => r.item_id), ids(body),
      "precondition: the rows describe the page the client received, in served order",
    );

    assert.deepEqual(
      body.places.map((p) => p.recommendationId),
      rows.map((r: any) => r.features?.recommendationId),
      "an outcome reported against the response's id must land on the row's exposure; " +
      "two different ids for one exposure is a denominator nothing can join to",
    );
  });

  it("R3. an anonymous serve carries no recommendationId — no exposure record exists to bind to", async () => {
    const f = fakeClient({ serveLog: true });
    _setTestServiceClient(f.client);
    _injectTestCacheEntry(KEY, candidates());

    const body = await serve(url, "", { auth: false });
    assert.ok(body.places.length > 0, "precondition: the anonymous request was served");
    for (const p of body.places) {
      assert.equal(
        p.recommendationId, undefined,
        "the serve log writes nothing for an anonymous caller, so an id here would join to no row at all",
      );
    }
  });

  it("R4. the id binds the SERVE — the same page fetched twice yields two sets of ids", async () => {
    const f = fakeClient({ serveLog: true });
    _setTestServiceClient(f.client);
    _injectTestCacheEntry(KEY, candidates());

    const first  = await serve(url, "");
    const second = await serve(url, "");
    assert.deepEqual(ids(first), ids(second), "precondition: both requests served the same page");

    const a = first.places.map((p) => p.recommendationId);
    const b = second.places.map((p) => p.recommendationId);
    assert.notDeepEqual(
      a, b,
      "the same item served twice is TWO exposures; one id for both under-counts the denominator",
    );
  });
});

describe("DC-22 leg 2 — cursor pagination, alongside page", () => {
  let server: Server;
  let url: string;

  beforeEach(async () => {
    ({ server, url } = await startServer());
    _setTestDbPlacesOverride(async () => []);
    invalidateDiscoveryEngineModeCache();
    invalidateServeLogFlagCache();
    _setTestServiceClient(fakeClient({ serveLog: false }).client);
    _injectTestCacheEntry(KEY, candidates());
  });
  afterEach(async () => {
    _clearTestCacheEntry(KEY);
    _setTestDbPlacesOverride(null);
    _setTestServiceClient(null);
    invalidateDiscoveryEngineModeCache();
    invalidateServeLogFlagCache();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("C1. a cursor selects the same window the equivalent page does", async () => {
    const byPage   = await serve(url, "&page=2");
    const byCursor = await serve(url, `&cursor=${cursorFor(PAGE_SIZE)}`);
    assert.equal(byPage.places.length, TOTAL - PAGE_SIZE, "precondition: page 2 is the short tail");
    assert.deepEqual(
      ids(byCursor), ids(byPage),
      "cursor(20) and page=2 name the same window; anything else is a second, disagreeing pagination",
    );
    assert.equal(byCursor.total, TOTAL, "`total` counts the whole result set on either vocabulary");
  });

  it("C1b. a cursor that is not on a page boundary is honoured as an offset", async () => {
    const all  = await serve(url, "&page=1");
    const mid  = await serve(url, `&cursor=${cursorFor(5)}`);
    assert.deepEqual(
      ids(mid), Array.from({ length: PAGE_SIZE }, (_, i) => `db/p${String(i + 5).padStart(2, "0")}`),
      "an offset cursor is an OFFSET — rounding it to a page boundary silently drops or repeats items",
    );
    assert.notDeepEqual(ids(mid), ids(all), "precondition: offset 5 is not offset 0");
  });

  it("C2. ADDITIVE — with no cursor, every page selects exactly what it selected before", async () => {
    const p1 = await serve(url, "&page=1");
    const p2 = await serve(url, "&page=2");
    const p3 = await serve(url, "&page=3");
    assert.deepEqual(
      ids(p1), Array.from({ length: PAGE_SIZE }, (_, i) => `db/p${String(i).padStart(2, "0")}`),
      "page 1 is the first PAGE_SIZE items, unchanged",
    );
    assert.deepEqual(
      ids(p2), Array.from({ length: TOTAL - PAGE_SIZE }, (_, i) => `db/p${String(i + PAGE_SIZE).padStart(2, "0")}`),
      "page 2 is the tail, unchanged",
    );
    assert.deepEqual(ids(p3), [], "page 3 is past the end, unchanged");
    assert.equal(p1.total, TOTAL, "`total` is the whole set, unchanged");
  });

  it("C3. a cursor WALK covers the result set exactly once and terminates on `total`", async () => {
    // The walk a client actually performs: start at 0, advance by PAGE_SIZE,
    // stop when the offset reaches the `total` the envelope already carries.
    const seen: string[] = [];
    for (let off = 0; off < TOTAL; off += PAGE_SIZE) {
      const window = await serve(url, `&cursor=${cursorFor(off)}`);
      assert.equal(window.total, TOTAL, "`total` is what ends the walk, so every window must report it");
      seen.push(...ids(window));
    }
    assert.deepEqual(
      seen, Array.from({ length: TOTAL }, (_, i) => `db/p${String(i).padStart(2, "0")}`),
      "a cursor walk must cover the result set exactly once — no gap, no repeat",
    );
    const past = await serve(url, `&cursor=${cursorFor(TOTAL + PAGE_SIZE)}`);
    assert.deepEqual(ids(past), [], "a cursor past the end is empty, not a wrap-around to page 1");
  });

  it("C4. the RESPONSE shape does not move — `cursor` is an input, not a new key", async () => {
    const byPage   = await serve(url, "&page=1");
    const byCursor = await serve(url, `&cursor=${cursorFor(0)}`);
    assert.deepEqual(
      byCursor.keys, byPage.keys,
      "a cursor request must answer with the same envelope a page request does",
    );
    assert.ok(
      !byCursor.keys.includes("nextCursor"),
      "discoveryCuratedSourceRefusal CONTROL 2 pins this envelope's exact key list on all four " +
      "serve paths; adding a key here breaks a contract another census put down on purpose",
    );
  });
});
