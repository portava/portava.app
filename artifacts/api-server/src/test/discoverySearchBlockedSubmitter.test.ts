/**
 * Blocked submitters on discovery SEARCH and SUGGEST — serve points 8 and 9.
 *
 * THE DEFECT
 * ==========
 * A `discovery_places` row can carry a `submitted_by`: a real person, whose
 * blurb, photo and rating ride along with the venue. Blocking that person is
 * supposed to hide their submission, and PR #355 made that true — of
 * routes/discovery.ts. That fix is documented in `queryDbPlaces` as
 *
 *     "the single funnel through which a discovery_places row reaches any
 *      discovery serve point, which is why the block filter lives here rather
 *      than at one of them — no serve point can forget it."
 *
 * It was not the single funnel. `GET /discovery/search` and
 * `GET /discovery/suggest` (routes/discoverySearch.ts, serve points 8 and 9)
 * build their OWN `discovery_places` query and never pass through it, so both
 * kept serving a blocked submitter's rows straight back to the person who
 * blocked them, in both directions, long after every other surface stopped.
 *
 * The `activities` type is the same table under a category filter and had the
 * same hole — worse, it is served in the SAME response as `places`, so the
 * identical row could be filtered out of one group and present in the next.
 *
 * WHAT IS PINNED HERE
 * ===================
 *   1. viewer-blocked-them  ⇒ absent from /discovery/search
 *   2. they-blocked-viewer  ⇒ absent from /discovery/search  (bidirectional)
 *   3. both directions      ⇒ absent from /discovery/suggest
 *   4. same, for the `activities` type on both routes
 *   5. an UNREADABLE blocks table yields NO content, not ALL content
 *   6. an unauthored (venue-fact) row is never withheld — the filter targets a
 *      voice, not a venue
 *
 * (5) is the one that matters most: fetchBlockedSet returns null on a read
 * error, and the pre-fix searchPlaces did not take the set at all, so a
 * transient blocks-table failure served the entire unfiltered corpus.
 *
 * Run: node --import tsx/esm --test src/test/discoverySearchBlockedSubmitter.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import discoveryRouter from "../routes/discoverySearch.js";
import { submitterIsVisible } from "../lib/blocks.js";

let server: http.Server;
let base: string;

const VIEWER_TOKEN    = "disc-block-viewer";
const VIEWER_ID       = "aaaaaaaa-0000-0000-0000-000000000001";
/** The viewer blocked this person. */
const BLOCKED_BY_ME   = "aaaaaaaa-0000-0000-0000-000000000002";
/** This person blocked the viewer — the other direction. */
const BLOCKED_ME      = "aaaaaaaa-0000-0000-0000-000000000003";
/** No block relationship at all. */
const STRANGER        = "aaaaaaaa-0000-0000-0000-000000000004";

// Every place shares the same searchable token so ONE query returns all of
// them: the test is about which rows survive, not about matching.
const Q = "kopitiam";

const PLACES = [
  { id: "pl-mine",     name: "Kopitiam Mine",     submitted_by: BLOCKED_BY_ME, category: "food" },
  { id: "pl-theirs",   name: "Kopitiam Theirs",   submitted_by: BLOCKED_ME,    category: "food" },
  { id: "pl-stranger", name: "Kopitiam Stranger", submitted_by: STRANGER,      category: "food" },
  { id: "pl-venue",    name: "Kopitiam Venue",    submitted_by: null,          category: "food" },
  // The same four again in an ACTIVITY category, so the `activities` type — the
  // same table under `.in("category", [...])` — is exercised too.
  { id: "ac-mine",     name: "Kopitiam Trek Mine",     submitted_by: BLOCKED_BY_ME, category: "adventure" },
  { id: "ac-theirs",   name: "Kopitiam Trek Theirs",   submitted_by: BLOCKED_ME,    category: "adventure" },
  { id: "ac-stranger", name: "Kopitiam Trek Stranger", submitted_by: STRANGER,      category: "adventure" },
  { id: "ac-venue",    name: "Kopitiam Trek Venue",    submitted_by: null,          category: "adventure" },
].map((p) => ({
  ...p,
  city: "Singapore",
  blurb: null,
  image_url: null,
  header_image_source: null,
  image_source_type: null,
  image_accuracy_status: null,
  primary_category: p.category,
  lat: null,
  lng: null,
  canonical_location_id: null,
  saved_count: 0,
  status: "active",
  created_at: "2026-09-01T00:00:00.000Z",
}));

const BLOCK_ROWS = [
  { blocker_id: VIEWER_ID,    blocked_id: BLOCKED_BY_ME },  // viewer → them
  { blocker_id: BLOCKED_ME,   blocked_id: VIEWER_ID     },  // them → viewer
];

/**
 * @param blocksError when true the `blocks` table read returns a PostgREST
 *        error — the "block state is unknown" case the whole fail-closed
 *        contract exists for.
 */
function buildFakeClient(opts: { blocksError?: boolean } = {}) {
  function from(table: string) {
    const tableRows: Record<string, any[]> = {
      discovery_places: PLACES,
      blocks: BLOCK_ROWS,
      profiles: [],
      user_privacy_settings: [],
      profile_privacy_settings: [],
      user_follows: [],
      hidden_gems: [],
      hashtags: [],
      posts: [],
      circles: [],
      stamps: [],
      trips: [],
      events: [],
      trip_plans: [],
      rank_events: [],
      canonical_locations: [],
    };
    let rows: any[] = tableRows[table] ?? [];
    const preds: Array<(r: any) => boolean> = [];
    let _from = 0;
    let _to: number | null = null;

    const b: any = {
      select() { return b; },
      insert() { return b; },
      update() { return b; },
      upsert() { return b; },
      delete() { return b; },
      eq(col: string, val: any)    { preds.push((r) => r[col] === val); return b; },
      neq(col: string, val: any)   { preds.push((r) => r[col] !== val); return b; },
      is()  { return b; },
      gte() { return b; },
      lte() { return b; },
      in(col: string, vals: any[]) { preds.push((r) => vals.includes(r[col])); return b; },
      // `.or()` is used for the ilike name/city/blurb match and for the block
      // lookup. Left permissive on purpose: the fixture is built so that every
      // row matches the query, which keeps this test about the BLOCK filter and
      // not about pattern matching.
      or() { return b; },
      ilike() { return b; },
      order() { return b; },
      limit(n: number) { _from = 0; _to = n - 1; return b; },
      range(f: number, t: number) { _from = f; _to = t; return b; },
      maybeSingle() { return resolveOne(); },
      single() { return resolveOne(); },
      then(onF: any, onR: any) { return resolveList().then(onF, onR); },
    };

    function filtered() { return rows.filter((r) => preds.every((p) => p(r))); }

    async function resolveList() {
      if (table === "blocks" && opts.blocksError) {
        // Exactly what supabase-js hands back: it RESOLVES with an error, it
        // does not reject. Reading only `data` here is how a fail-open bug
        // gets written.
        return { data: null, error: { message: "blocks unavailable" }, count: null };
      }
      let data = filtered();
      if (_to !== null) data = data.slice(_from, _to + 1);
      return { data, error: null, count: filtered().length };
    }
    async function resolveOne() {
      if (table === "blocks" && opts.blocksError) {
        return { data: null, error: { message: "blocks unavailable" } };
      }
      return { data: filtered()[0] ?? null, error: null };
    }

    return b;
  }

  return {
    auth: {
      getUser: async (token: string) =>
        token === VIEWER_TOKEN
          ? { data: { user: { id: VIEWER_ID } }, error: null }
          : { data: { user: null }, error: { message: "invalid token" } },
    },
    from,
  };
}

function setClient(opts: { blocksError?: boolean } = {}) {
  const fc = buildFakeClient(opts);
  _setTestClient(fc as any, true);
  _setTestServiceClient(fc as any);
}

function req(path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const r = http.request(
      {
        hostname: url.hostname, port: Number(url.port),
        path: url.pathname + url.search, method: "GET",
        headers: { "content-type": "application/json", authorization: `Bearer ${VIEWER_TOKEN}` },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    r.end();
  });
}

/** ids served by /discovery/search for one type. */
async function searchIds(type: string): Promise<string[]> {
  const r = await req(`/api/discovery/search?q=${Q}&type=${type}`);
  assert.equal(r.status, 200, `unexpected status: ${JSON.stringify(r.body)}`);
  return ((r.body.results ?? []) as any[]).map((x) => x.id);
}

/** ids served by /discovery/suggest inside one group. */
async function suggestIds(type: string): Promise<string[]> {
  const r = await req(`/api/discovery/suggest?q=${Q}`);
  assert.equal(r.status, 200, `unexpected status: ${JSON.stringify(r.body)}`);
  const group = ((r.body.groups ?? []) as any[]).find((g) => g.type === type);
  return ((group?.items ?? []) as any[]).map((x) => x.id);
}

describe("discovery search + suggest — blocked submitters (serve points 8 and 9)", () => {
  before(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api", discoveryRouter);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
    setClient();
  });

  after(() => {
    server.close();
    _setTestClient(null as any, false);
    _setTestServiceClient(null as any);
  });

  it("/discovery/search hides a place submitted by someone the VIEWER blocked", async () => {
    setClient();
    const ids = await searchIds("places");
    assert.ok(
      !ids.includes("pl-mine"),
      "search served a blocked submitter's place back to the person who blocked them",
    );
    assert.ok(ids.includes("pl-stranger"), "an unblocked submitter's place must still be served");
  });

  it("/discovery/search hides a place submitted by someone who blocked the VIEWER", async () => {
    // Bidirectional: a block hides the content in BOTH directions, which is
    // what lib/blocks.fetchBlockedSet resolves and what every other surface
    // enforces. Filtering only the viewer→them direction is a half-fix.
    setClient();
    const ids = await searchIds("places");
    assert.ok(!ids.includes("pl-theirs"), "the reverse block direction was not applied");
  });

  it("/discovery/search keeps an UNAUTHORED row — the filter targets a voice, not a venue", async () => {
    setClient();
    const ids = await searchIds("places");
    assert.ok(
      ids.includes("pl-venue"),
      "a discovery_places row with no submitted_by is a venue fact; withholding it " +
      "would delete real places from search on the strength of an unrelated block",
    );
  });

  it("/discovery/search applies the same filter to `activities` — the same table", async () => {
    // places and activities are the SAME discovery_places rows under different
    // category filters, and both groups are served in one response. Filtering
    // one and not the other hides a submission in the Places group and shows
    // the identical submitter's row two groups down.
    setClient();
    const ids = await searchIds("activities");
    assert.ok(!ids.includes("ac-mine"),   "viewer-blocked submitter leaked through `activities`");
    assert.ok(!ids.includes("ac-theirs"), "reverse-blocked submitter leaked through `activities`");
    assert.ok(ids.includes("ac-stranger"), "an unblocked submitter's activity must still be served");
  });

  it("/discovery/suggest hides blocked submitters in BOTH directions", async () => {
    setClient();
    const ids = await suggestIds("places");
    assert.ok(!ids.includes("pl-mine"),   "suggest served a viewer-blocked submitter's place");
    assert.ok(!ids.includes("pl-theirs"), "suggest served a reverse-blocked submitter's place");
    assert.ok(ids.includes("pl-stranger") || ids.includes("pl-venue"),
      "suggest must still serve unblocked places — an empty group proves nothing");
  });

  it("/discovery/suggest applies the same filter to the `activities` group", async () => {
    setClient();
    const ids = await suggestIds("activities");
    assert.ok(!ids.includes("ac-mine"),   "suggest leaked a viewer-blocked submitter via activities");
    assert.ok(!ids.includes("ac-theirs"), "suggest leaked a reverse-blocked submitter via activities");
  });

  it("an UNREADABLE blocks table yields NO content, never ALL content", async () => {
    // fetchBlockedSet resolves to null when the blocks read errors. The
    // pre-fix searchPlaces did not take the set at all, so this — a transient
    // blocks-table failure — served the entire unfiltered corpus, including
    // every blocked submitter, to every viewer.
    setClient({ blocksError: true });

    for (const type of ["places", "activities"]) {
      const ids = await searchIds(type);
      assert.deepEqual(
        ids, [],
        `/discovery/search?type=${type} served content while block state was UNKNOWN. ` +
        "Fail closed: an unreadable blocks table must withhold, not publish.",
      );
    }

    const r = await req(`/api/discovery/suggest?q=${Q}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.groups, [], "/discovery/suggest must serve nothing on an unreadable blocks table");
  });

  it("type=all fans out through the same filtered readers", async () => {
    setClient();
    const r = await req(`/api/discovery/search?q=${Q}&type=all&limit=50`);
    assert.equal(r.status, 200, `unexpected status: ${JSON.stringify(r.body)}`);
    const ids = ((r.body.results ?? []) as any[]).map((x) => x.id);
    for (const leaked of ["pl-mine", "pl-theirs", "ac-mine", "ac-theirs"]) {
      assert.ok(!ids.includes(leaked), `type=all leaked ${leaked}`);
    }
  });
});

// ── The rule itself, and where it lives ──────────────────────────────────────

describe("submitterIsVisible is ONE rule, shared by every discovery_places reader", () => {
  it("is exported from lib/blocks — not re-implemented per route", async () => {
    // Two copies of a privacy rule is precisely how search and suggest drifted
    // away from the feed: the rule lived inside routes/discovery.ts, described
    // itself as unmissable, and the other reader simply never called it.
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../routes/discoverySearch.ts", import.meta.url), "utf8");

    assert.match(
      src, /import \{ submitterIsVisible \} from "\.\.\/lib\/blocks\.js"/,
      "discoverySearch must import the shared rule rather than define its own",
    );
    assert.ok(
      !/function submitterIsVisible/.test(src),
      "a second implementation of the block rule has appeared in discoverySearch",
    );
  });

  it("searchPlaces and searchActivities both select submitted_by and apply the rule", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../routes/discoverySearch.ts", import.meta.url), "utf8");

    for (const fn of ["async function searchPlaces(", "async function searchActivities("]) {
      const start = src.indexOf(fn);
      assert.ok(start > -1, `${fn} not found — this guard needs re-anchoring`);
      const end = src.indexOf("\nasync function ", start + 1);
      const body = src.slice(start, end > start ? end : undefined);

      assert.match(body, /\bsubmitted_by\b/,
        `${fn} no longer selects submitted_by — the filter below it cannot see the author`);
      assert.match(body, /submitterIsVisible\(\s*p\.submitted_by/,
        `${fn} no longer applies submitterIsVisible`);
      assert.match(body, /blockedSet === null\) return \[\]/,
        `${fn} no longer fails closed on an unreadable blocks table`);
    }
  });

  it("the rule's own contract: no author passes, unknown block state withholds", () => {
    const blocked = new Set([BLOCKED_BY_ME]);
    assert.equal(submitterIsVisible(null, blocked), true, "a venue fact has no voice to withhold");
    assert.equal(submitterIsVisible(BLOCKED_BY_ME, blocked), false);
    assert.equal(submitterIsVisible(STRANGER, blocked), true);
    assert.equal(submitterIsVisible(STRANGER, null), false, "unknown block state must fail closed");
    assert.equal(submitterIsVisible(null, null), true, "…but there is still nothing to withhold");
  });
});
