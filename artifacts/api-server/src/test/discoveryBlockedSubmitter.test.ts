/**
 * Blocking a person hides the places they submitted, on Discovery.
 *
 * `discovery_places.submitted_by` is a real author: the row carries that
 * person's blurb, photo and rating. Every other surface in the tree already
 * hides their submission from someone who blocked them — CompassItemHydrator
 * hands `submitted_by` to the ranker as `authorId` and CompassFeedBuilder turns
 * it into `authorIsBlockedByViewer`, CompassFallbackFeedBuilder filters on it
 * directly, mapSearch and mediaFeed do the same for `hidden_gems`. Discovery
 * did not, so the same row was hidden on Compass and served on Discovery to the
 * same viewer.
 *
 * The filter is a candidate PRE-FILTER inside queryDbPlaces, not a wiring of the
 * ranker's eligibility gate. That placement is the subject of half these tests:
 *
 *  - queryDbPlaces is the single funnel every discovery_places row passes
 *    through on its way to ANY serve point, so no serve point can forget it;
 *  - the blocked row never becomes a candidate, so every eligibility input in
 *    lib/discoveryPde.ts stays constant and the per-candidate analytics opt-out
 *    #203 introduced stays honest (guard tests S and T there still pass);
 *  - `submitted_by` is consumed inside the query and never mapped onto
 *    DiscoveryPlace, because toPublic is the identity function and would
 *    serialise a submitter's user id straight to the client.
 *
 * Run: node --import tsx/esm --test src/test/discoveryBlockedSubmitter.test.ts
 */
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import express from "express";
import pino from "pino";
import discoveryRouter, { submitterIsVisible } from "../routes/discovery.js";
import { _setTestServiceClient } from "../lib/supabase.js";

// ── Block external network calls ──────────────────────────────────────────────
// Overpass/Nominatim go through fetchWithTimeout, which degrades gracefully.
// Throwing immediately keeps the OSM half of the merge empty and the tests fast.

const _originalFetch = globalThis.fetch;
globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
  const urlStr = String(typeof url === "string" ? url : (url as URL).href ?? "");
  if (urlStr.includes("overpass-api.de") || urlStr.includes("nominatim.openstreetmap.org")) {
    throw new Error("Network blocked in test environment");
  }
  return _originalFetch(url as string, init);
};

// ── Fixtures ──────────────────────────────────────────────────────────────────

const VIEWER    = "11111111-1111-4111-8111-111111111111";
const BLOCKED   = "22222222-2222-4222-8222-222222222222";
const BLOCKER   = "33333333-3333-4333-8333-333333333333"; // blocked the viewer, not vice versa
const STRANGER  = "44444444-4444-4444-8444-444444444444";

const BASE_ROW = {
  city:                   "Cebu",
  place_type:             "restaurant",
  category:               "food",
  primary_category:       "food",
  secondary_categories:   null,
  neighborhood:           null,
  blurb:                  "you have to try the lechon",
  image_url:              "https://example.test/photo.jpg",
  header_image_source:    null,
  image_source_type:      null,
  image_accuracy_status:  null,
  rating:                 4.5,
  saved_count:            3,
  lat:                    10.3,
  lng:                    123.9,
  tag:                    null,
  verified:               false,
  created_at:             "2026-01-01T00:00:00.000Z",
  source:                 "traveler",
  status:                 "active",
};

/** The profiles join GET /discovery/community selects — this is the byline. */
function profile(id: string, handle: string) {
  return { id, name: `${handle} display name`, avatar_url: `https://example.test/${handle}.jpg`, username: handle };
}

const ROW_NO_AUTHOR = { ...BASE_ROW, id: "aaaa1111", name: "Legacy Row",    submitted_by: null,     profiles: null };
const ROW_STRANGER  = { ...BASE_ROW, id: "bbbb2222", name: "Stranger Pick", submitted_by: STRANGER, profiles: profile(STRANGER, "stranger") };
const ROW_BLOCKED   = { ...BASE_ROW, id: "cccc3333", name: "Blocked Pick",  submitted_by: BLOCKED,  profiles: profile(BLOCKED,  "blockedperson") };
const ROW_BLOCKER   = { ...BASE_ROW, id: "dddd4444", name: "Blocker Pick",  submitted_by: BLOCKER,  profiles: profile(BLOCKER,  "blockerperson") };

const ALL_ROWS = [ROW_NO_AUTHOR, ROW_STRANGER, ROW_BLOCKED, ROW_BLOCKER];

// ── Fake service client ───────────────────────────────────────────────────────
//
// Chainable and thenable, like the real PostgREST builder. `.eq()` constraints
// are applied when resolving so the route's own `.eq("status", "active")` really
// filters. Every table the request touches beyond blocks/discovery_places
// (place_votes, reviews, the event-post pipeline) resolves empty, which those
// call sites already treat as "nothing to add".

function makeFakeClient(opts: { rows: typeof ALL_ROWS; blocks: any[]; blocksError?: boolean }) {
  const calls = { getUser: 0 };
  return {
    __calls: calls,
    auth: {
      getUser: async (_token: string) => {
        calls.getUser += 1;
        return { data: { user: { id: VIEWER } }, error: null };
      },
    },
    rpc: async () => ({ data: [], error: null }),
    from(table: string) {
      const eqFilters: Array<{ col: string; val: unknown }> = [];
      const obj: any = {
        select()  { return obj; },
        eq(col: string, val: unknown) { eqFilters.push({ col, val }); return obj; },
        or()      { return obj; },
        in()      { return obj; },
        is()      { return obj; },
        not()     { return obj; },
        ilike()   { return obj; },
        gte()     { return obj; },
        lte()     { return obj; },
        order()   { return obj; },
        limit()   { return obj; },
        range()   { return obj; },
        maybeSingle() { return obj; },
        single()      { return obj; },
        then(onF: any, onR: any) { return resolve().then(onF, onR); },
      };

      async function resolve(): Promise<{ data: any; error: any }> {
        if (table === "blocks") {
          if (opts.blocksError) return { data: null, error: { message: "blocks unavailable" } };
          return { data: opts.blocks, error: null };
        }
        if (table === "discovery_places") {
          let rows: any[] = [...opts.rows];
          for (const { col, val } of eqFilters) rows = rows.filter((r) => r[col] === val);
          return { data: rows, error: null };
        }
        return { data: [], error: null };
      }

      return obj;
    },
  } as any;
}

// ── HTTP harness ──────────────────────────────────────────────────────────────

function makeApp() {
  const app = express();
  app.use((req, _res, next) => { (req as any).log = pino({ level: "silent" }); next(); });
  app.use(discoveryRouter);
  return app;
}

/** GET /discovery/feed with lat+lng supplied so no geocode is attempted. */
async function feed(server: Server, authed: boolean) {
  const port = (server.address() as any).port as number;
  const res = await fetch(
    `http://127.0.0.1:${port}/discovery/feed?city=Cebu&lat=10.3&lng=123.9&category=food&includePlaces=1`,
    authed ? { headers: { authorization: "Bearer test-token" } } : undefined,
  );
  const body = await res.json() as any;
  return { status: res.status, body };
}

/** GET /discovery/community — the surface that returns the submitter's byline. */
async function community(server: Server, authed: boolean) {
  const port = (server.address() as any).port as number;
  const res = await fetch(
    `http://127.0.0.1:${port}/discovery/community?city=Cebu`,
    authed ? { headers: { authorization: "Bearer test-token" } } : undefined,
  );
  const body = await res.json() as any;
  return { status: res.status, body };
}

/** Names of the community rows that survived to the response. */
function servedNames(body: any): string[] {
  return ((body.places ?? []) as any[]).map((p) => p.name as string).sort();
}

describe("discovery: blocked submitters", () => {
  let server: Server;

  before(() => new Promise<void>((resolve) => {
    server = createServer(makeApp());
    server.listen(0, "127.0.0.1", () => resolve());
  }));

  after(() => new Promise<void>((resolve) => {
    globalThis.fetch = _originalFetch;
    server.close(() => resolve());
  }));

  afterEach(() => { _setTestServiceClient(null); });

  it("hides a place submitted by someone the viewer blocked", async () => {
    _setTestServiceClient(makeFakeClient({
      rows:   ALL_ROWS,
      blocks: [{ blocker_id: VIEWER, blocked_id: BLOCKED }],
    }));
    const { status, body } = await feed(server, true);
    assert.equal(status, 200);
    const names = servedNames(body);
    assert.ok(!names.includes("Blocked Pick"), `blocked submitter's place was served: ${names.join(", ")}`);
    assert.ok(names.includes("Stranger Pick"), "an unrelated submitter's place must still be served");
    assert.ok(names.includes("Legacy Row"),    "a row with no submitter is a venue fact and must survive");
  });

  it("is bidirectional — a place submitted by someone who blocked the VIEWER is hidden too", async () => {
    // The viewer never blocked anyone here; the block points the other way.
    // lib/blocks.ts treats a block as symmetric for visibility, and so must this.
    _setTestServiceClient(makeFakeClient({
      rows:   ALL_ROWS,
      blocks: [{ blocker_id: BLOCKER, blocked_id: VIEWER }],
    }));
    const { body } = await feed(server, true);
    const names = servedNames(body);
    assert.ok(!names.includes("Blocker Pick"), `place by a user who blocked the viewer was served: ${names.join(", ")}`);
    assert.ok(names.includes("Stranger Pick"));
  });

  it("withholds authored rows when the block list cannot be READ, and keeps unauthored ones", async () => {
    // Fail-closed, per the contract lib/blocks.ts states: never leak while block
    // state is uncertain. A row with no submitter has no author to be uncertain
    // about, so the feed does not go empty.
    _setTestServiceClient(makeFakeClient({ rows: ALL_ROWS, blocks: [], blocksError: true }));
    const { body } = await feed(server, true);
    assert.deepEqual(servedNames(body), ["Legacy Row"]);
  });

  it("filters nothing for an unauthenticated caller — no viewer, no block relationship", async () => {
    _setTestServiceClient(makeFakeClient({
      rows:   ALL_ROWS,
      blocks: [{ blocker_id: VIEWER, blocked_id: BLOCKED }],
    }));
    const { body } = await feed(server, false);
    assert.deepEqual(
      servedNames(body),
      ["Blocked Pick", "Blocker Pick", "Legacy Row", "Stranger Pick"],
    );
  });

  it("never serialises submitted_by to the client", async () => {
    // toPublic is the identity function, so anything placed on DiscoveryPlace
    // reaches the client. The submitter's user id must be consumed by the filter
    // and dropped.
    _setTestServiceClient(makeFakeClient({ rows: ALL_ROWS, blocks: [] }));
    const { body } = await feed(server, true);
    const served = (body.places ?? []) as any[];
    assert.ok(served.length > 0, "nothing was served — this test would pass vacuously");
    for (const p of served) {
      assert.ok(!("submitted_by" in p), `submitted_by leaked on ${p.name}`);
      assert.ok(!("submittedBy"  in p), `submittedBy leaked on ${p.name}`);
    }
  });
});

describe("discovery/community: blocked submitters", () => {
  // The most exposed community surface: it joins profiles and returns the
  // submitter's name, avatar and handle. An unfiltered row here does not just
  // show a blocked person's pick, it shows their byline.
  let server: Server;

  before(() => new Promise<void>((resolve) => {
    server = createServer(makeApp());
    server.listen(0, "127.0.0.1", () => resolve());
  }));

  after(() => new Promise<void>((resolve) => { server.close(() => resolve()); }));

  afterEach(() => { _setTestServiceClient(null); });

  const names = (body: any) => ((body.items ?? []) as any[]).map((i) => i.name as string).sort();

  it("hides the place AND the byline of someone the viewer blocked", async () => {
    _setTestServiceClient(makeFakeClient({
      rows:   ALL_ROWS,
      blocks: [{ blocker_id: VIEWER, blocked_id: BLOCKED }],
    }));
    const { status, body } = await community(server, true);
    assert.equal(status, 200);
    assert.ok(!names(body).includes("Blocked Pick"), `blocked submitter's place was served: ${names(body).join(", ")}`);
    assert.ok(names(body).includes("Stranger Pick"));
    assert.ok(names(body).includes("Legacy Row"));

    // Nothing of the blocked person survives anywhere in the payload — not the
    // display name, not the handle, not the avatar, not the raw id.
    const payload = JSON.stringify(body);
    for (const needle of [BLOCKED, "blockedperson", "blockedperson display name"]) {
      assert.ok(!payload.includes(needle), `blocked submitter's ${needle} leaked into the response`);
    }
    // Control: the same fields DO appear for a submitter who is not blocked, so
    // the assertion above is not passing because bylines are simply absent.
    assert.ok(payload.includes("stranger"), "no byline was rendered at all — the check above would pass vacuously");
  });

  it("is bidirectional", async () => {
    _setTestServiceClient(makeFakeClient({
      rows:   ALL_ROWS,
      blocks: [{ blocker_id: BLOCKER, blocked_id: VIEWER }],
    }));
    const { body } = await community(server, true);
    assert.ok(!names(body).includes("Blocker Pick"));
    assert.ok(names(body).includes("Stranger Pick"));
  });

  it("withholds authored rows when the block list cannot be READ", async () => {
    _setTestServiceClient(makeFakeClient({ rows: ALL_ROWS, blocks: [], blocksError: true }));
    const { body } = await community(server, true);
    assert.deepEqual(names(body), ["Legacy Row"]);
  });

  it("filters nothing for an unauthenticated caller, and never resolves a viewer", async () => {
    const client = makeFakeClient({
      rows:   ALL_ROWS,
      blocks: [{ blocker_id: VIEWER, blocked_id: BLOCKED }],
    });
    _setTestServiceClient(client);
    const { body } = await community(server, false);
    assert.deepEqual(names(body), ["Blocked Pick", "Blocker Pick", "Legacy Row", "Stranger Pick"]);
    assert.equal((client as any).__calls.getUser, 0, "an anonymous request must not trigger an auth lookup");
  });

  it("reports total as what the viewer received, not what the query returned", async () => {
    _setTestServiceClient(makeFakeClient({
      rows:   ALL_ROWS,
      blocks: [{ blocker_id: VIEWER, blocked_id: BLOCKED }],
    }));
    const { body } = await community(server, true);
    assert.equal(body.total, 3, "total still counts the row that was filtered out");
    assert.equal((body.items ?? []).length, 3);
  });

  it("resolves the viewer at most once — the filter costs no extra round trip", async () => {
    // The route comments make this a rule, not an accident: identity is needed
    // by the age filter, the block filter and the saved-state lookup, and all
    // three go through one memoised resolver. Before it, an open_to_me request
    // spent two auth.getUser calls; a second one creeping back in is a
    // regression this pins.
    const client = makeFakeClient({
      rows:   ALL_ROWS,
      blocks: [{ blocker_id: VIEWER, blocked_id: BLOCKED }],
    });
    _setTestServiceClient(client);
    const port = (server.address() as any).port as number;
    const res  = await fetch(
      `http://127.0.0.1:${port}/discovery/community?city=Cebu&ageFilter=open_to_me`,
      { headers: { authorization: "Bearer test-token" } },
    );
    assert.equal(res.status, 200);
    await res.json();
    assert.equal((client as any).__calls.getUser, 1,
      "the community route resolved its viewer more than once");
  });
});

describe("submitterIsVisible", () => {
  const blocked = new Set([BLOCKED]);

  it("a row with no submitter is a venue fact and is always visible", () => {
    assert.equal(submitterIsVisible(null,      blocked), true);
    assert.equal(submitterIsVisible(undefined, blocked), true);
    assert.equal(submitterIsVisible("",        blocked), true);
    // Even when block state is unknown: there is no author to withhold.
    assert.equal(submitterIsVisible(null, null), true);
  });

  it("hides a blocked submitter and keeps everyone else", () => {
    assert.equal(submitterIsVisible(BLOCKED,  blocked), false);
    assert.equal(submitterIsVisible(STRANGER, blocked), true);
  });

  it("an empty set blocks nobody — that is not the same as an unreadable list", () => {
    assert.equal(submitterIsVisible(BLOCKED, new Set()), true);
    assert.equal(submitterIsVisible(BLOCKED, null),      false);
  });
});

describe("where the filter lives (source guards)", () => {
  // The placement is the whole point, and it is invisible from outside: a feed
  // with the block applied in the ranker's eligibility gate would pass every
  // test above while costing ~180 rank_events inserts per ranked request and
  // failing the guard tests in discoveryPde.test.ts.

  async function discoverySrc(): Promise<string> {
    const fs = await import("node:fs/promises");
    return fs.readFile(new URL("../routes/discovery.ts", import.meta.url), "utf8");
  }

  /** The body of queryDbPlaces, up to the next top-level function. */
  async function queryDbPlacesSrc(): Promise<string> {
    const src = await discoverySrc();
    const start = src.indexOf("async function queryDbPlaces(");
    assert.ok(start > -1, "queryDbPlaces not found — this guard needs re-anchoring");
    const end = src.indexOf("\nasync function ", start + 1);
    assert.ok(end > start, "could not bound queryDbPlaces — this guard needs re-anchoring");
    return src.slice(start, end);
  }

  it("queryDbPlaces selects submitted_by and applies the filter", async () => {
    const body = await queryDbPlacesSrc();
    assert.match(body, /\bsubmitted_by\b/, "the projection no longer selects submitted_by");
    assert.match(
      body, /submitterIsVisible\(\s*row\.submitted_by/,
      "queryDbPlaces no longer applies submitterIsVisible to the row's submitter — " +
      "every discovery serve point reads community rows through this one function, " +
      "so dropping the call here silently unblocks all of them.",
    );
  });

  it("the community route filters before it resolves display names", async () => {
    // Order matters: nameVisibilitySet and the item mapping must run over the
    // FILTERED rows, or a blocked submitter's name is resolved (and `total`
    // counts a row nobody received) even though the item is dropped later.
    const src = await discoverySrc();
    const route = src.indexOf('router.get("/discovery/community"');
    assert.ok(route > -1, "the community route moved — this guard needs re-anchoring");
    const body = src.slice(route, src.indexOf('router.post("/discovery/community"', route));

    const filterAt = body.indexOf("submitterIsVisible(row.submitted_by");
    const namesAt  = body.indexOf("nameVisibilitySet(");
    assert.ok(filterAt > -1, "the community route no longer filters blocked submitters");
    assert.ok(namesAt  > -1, "nameVisibilitySet moved — this guard needs re-anchoring");
    assert.ok(filterAt < namesAt, "the block filter now runs AFTER display names are resolved");
  });

  it("submitted_by is never mapped onto the DiscoveryPlace that toPublic returns", async () => {
    const body = await queryDbPlacesSrc();
    const mapStart = body.indexOf(".map((row: any): DiscoveryPlace =>");
    assert.ok(mapStart > -1, "the DiscoveryPlace mapping moved — this guard needs re-anchoring");
    assert.ok(
      !body.slice(mapStart).includes("submitted_by"),
      "a submitter's user id is being mapped onto DiscoveryPlace. toPublic is the " +
      "identity function, so that field is serialised straight to every client.",
    );
  });

  it("the ranker's eligibility inputs are untouched by this — the gate is not how it is enforced", async () => {
    const fs  = await import("node:fs/promises");
    const pde = await fs.readFile(new URL("../lib/discoveryPde.ts", import.meta.url), "utf8");
    assert.match(
      pde, /creatorId:\s*null/,
      "discovery is now handing the ranker a real creatorId. If the block moved into " +
      "the eligibility gate, re-enable the per-candidate analytics with it — see the " +
      "guard tests in discoveryPde.test.ts, which fail for the same reason.",
    );
    assert.match(
      pde, /authorIsBlockedByViewer:\s*false,\s*authorBlocksViewer:\s*false/,
      "the author-side eligibility inputs are no longer constants; discovery's " +
      "per-candidate analytics opt-out is no longer honest.",
    );
  });
});
