/**
 * census-telegraph §80 / census-trips §90 (wave W, ported from PR #530 e7be3dca9; the sweep beside census-discovery §98.1
 * finding 1): every Overpass client reads
 * an HTTP-200 answer that did not FINISH as a failed read, and none caches one as the place's answer.
 *
 * Overpass answers a query it could not finish with HTTP 200: the body parses, carries the elements written before the
 * timeout or the memory limit (none, or a set cut in quadtile order), and says so only in `remark`
 * ("runtime error: Query timed out …"). Round 3 (census-discovery §126 on PR #679) taught GET /discovery's client to read it. Three
 * other server modules call Overpass with their own `fetch` and never read `remark`:
 *
 *   - lib/venuesService.ts (`getNearbyVenues`, behind the Telegraph venue tools and commands): it also cached a non-OK
 *     answer as `[]` for 30 minutes, so one rate-limited minute emptied the venue list for half an hour;
 *   - lib/localContext.ts (`getLocalContext`, the Daily Brief's local tips): cached for 24 hours;
 *   - lib/neighborhoodMatch.ts (`fetchCityPois` / `fetchCityAreas`): a cut POI set was scored and stored for 7 days.
 *
 * The rule now has one home, `overpassBodyUnfinished` (lib/overpassAnswer.ts), which GET /discovery's client
 * (routes/discovery.ts `overpassAnswerFailed`, PR #679) delegates to.
 * An unfinished answer is a failed read in each module's own vocabulary ([] / null, as a non-OK status is), its
 * elements are not used, and nothing is cached, so the next call asks Overpass again.
 *
 *   OA1  the classifier: a `runtime error` remark (timeout, out of memory) is unfinished, with or without elements
 *   OA2  the classifier, fail-closed forms: no `elements` array, a remark in no Overpass form, a non-string remark, null
 *   OA3  CONTROL: no remark, an empty remark, an informational `runtime remark:` → finished
 *   VS1  venues: a 200 with a timeout remark and a cut element set → [] (the cut set is not served), and NOT cached
 *   VS2  venues: a 429 → [], and NOT cached (the next healthy read is served)
 *   VS3  CONTROL: a healthy answer is served and cached (one Overpass call for two reads)
 *   LC1  local context: an unfinished answer → null, and NOT cached; LC2 CONTROL: a healthy answer is cached
 *   NM1  neighborhood POIs: an unfinished answer → no POIs (never the cut set); NM2 CONTROL: a healthy answer's POIs
 *   NM3  neighborhood areas: an unfinished answer with three named areas → the grid, never those three as the city's areas
 *   NM4  refreshCityNeighborhoods: a FAILED areas read (unfinished, or a 429) with healthy POIs writes nothing and returns
 *        what is stored — the grid it used to build was upserted and served for 7 days as the city's areas; also a
 *        THROWN areas fetch (verifier R1 on #689)
 *   NM5  refreshCityNeighborhoods: a FAILED POI read writes nothing; NM6 CONTROL: two healthy reads are computed and stored
 *
 * Run: node --import tsx/esm --test src/test/overpassUnfinishedAnswer.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { overpassBodyUnfinished } from "../lib/overpassAnswer.js";
import { getNearbyVenues } from "../lib/venuesService.js";
import { getLocalContext } from "../lib/localContext.js";
import { fetchCityPois, fetchCityAreas, refreshCityNeighborhoods, _setTestFetch } from "../lib/neighborhoodMatch.js";

const TIMEOUT_REMARK = 'runtime error: Query timed out in "query" at line 3 after 6 seconds.';
const MEMORY_REMARK = "runtime error: Query run out of memory using about 2048 MB of RAM.";
const cafe = (id: number, name: string) => ({ type: "node", id, lat: 38.72, lon: -9.14, tags: { name, amenity: "cafe" } });
const HEALTHY = { elements: [cafe(1, "Cafe A"), cafe(2, "Cafe B")] };
const CUT = { elements: [cafe(1, "Cafe A")], remark: TIMEOUT_REMARK };

describe("the one reading of an Overpass body", () => {
  it("OA1 a runtime-error remark is an unfinished answer, with or without elements", () => {
    assert.equal(overpassBodyUnfinished({ elements: [], remark: TIMEOUT_REMARK }), true);
    assert.equal(overpassBodyUnfinished(CUT), true);
    assert.equal(overpassBodyUnfinished({ elements: [cafe(1, "x")], remark: MEMORY_REMARK }), true);
    assert.equal(overpassBodyUnfinished({ elements: [cafe(1, "x")], remark: "runtime remark: Timeout is 20.\n" + TIMEOUT_REMARK }), true);
  });
  it("OA2 fail-closed forms are unfinished", () => {
    assert.equal(overpassBodyUnfinished({ remark: "" }), true, "no elements array");
    assert.equal(overpassBodyUnfinished({ elements: [], remark: "Dispatcher busy, try later" }), true, "a remark in no Overpass form");
    assert.equal(overpassBodyUnfinished({ elements: [], remark: { text: "runtime error" } }), true, "a remark that is not a string");
    assert.equal(overpassBodyUnfinished(null), true);
    assert.equal(overpassBodyUnfinished("<html>gateway</html>"), true);
  });
  it("OA3 CONTROL: no remark, an empty remark and an informational remark are finished answers", () => {
    assert.equal(overpassBodyUnfinished(HEALTHY), false);
    assert.equal(overpassBodyUnfinished({ elements: [] }), false);
    assert.equal(overpassBodyUnfinished({ ...HEALTHY, remark: "" }), false);
    assert.equal(overpassBodyUnfinished({ ...HEALTHY, remark: null }), false);
    assert.equal(overpassBodyUnfinished({ ...HEALTHY, remark: "runtime remark: Timeout is 20 and maxsize is 536870912." }), false);
  });
});

// ── the two modules that call the global fetch ────────────────────────────────────────────────────────────────────
const realFetch = globalThis.fetch;
let overpassCalls = 0;
function stubFetch(overpass: () => Response) {
  overpassCalls = 0;
  globalThis.fetch = (async (url: any) => {
    const s = String(typeof url === "string" ? url : (url as URL).href ?? "");
    if (s.includes("nominatim.openstreetmap.org")) return new Response(JSON.stringify([{ lat: "38.72", lon: "-9.14" }]), { status: 200 });
    if (s.includes("overpass-api.de")) { overpassCalls += 1; return overpass(); }
    throw new Error(`unexpected fetch in test: ${s}`);
  }) as typeof globalThis.fetch;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
afterEach(() => { globalThis.fetch = realFetch; _setTestFetch(null); });

describe("getNearbyVenues never serves or caches an unfinished Overpass answer", () => {
  it("VS1 a 200 with a timeout remark and a cut element set → [], and the next healthy read is served", async () => {
    let n = 0;
    stubFetch(() => json(++n === 1 ? CUT : HEALTHY));
    assert.deepEqual(await getNearbyVenues("vs1-lisbon"), [], "the cut set was served as the place's venues");
    const second = await getNearbyVenues("vs1-lisbon");
    assert.deepEqual(second.map((v) => v.name).sort(), ["Cafe A", "Cafe B"], "the unfinished answer was cached");
    assert.equal(overpassCalls, 2);
  });
  it("VS2 a 429 → [], and the next healthy read is served", async () => {
    let n = 0;
    stubFetch(() => (++n === 1 ? new Response("rate limited", { status: 429 }) : json(HEALTHY)));
    assert.deepEqual(await getNearbyVenues("vs2-porto"), []);
    assert.deepEqual((await getNearbyVenues("vs2-porto")).map((v) => v.name).sort(), ["Cafe A", "Cafe B"], "the failed read was cached as an empty place");
  });
  it("VS3 CONTROL: a healthy answer is served and cached", async () => {
    stubFetch(() => json(HEALTHY));
    assert.equal((await getNearbyVenues("vs3-faro")).length, 2);
    assert.equal((await getNearbyVenues("vs3-faro")).length, 2);
    assert.equal(overpassCalls, 1, "a healthy answer is cached for its TTL");
  });
});

describe("getLocalContext never caches an unfinished Overpass answer", () => {
  it("LC1 an unfinished answer → null, and the next healthy read is served", async () => {
    let n = 0;
    stubFetch(() => json(++n === 1 ? CUT : HEALTHY));
    assert.equal(await getLocalContext("lc1-lisbon"), null, "an unfinished answer was served as the place's local context");
    const second = await getLocalContext("lc1-lisbon");
    assert.deepEqual(second?.tips.map((t) => t.name).sort(), ["Cafe A", "Cafe B"]);
    assert.equal(overpassCalls, 2);
  });
  it("LC2 CONTROL: a healthy answer is served and cached", async () => {
    stubFetch(() => json(HEALTHY));
    assert.equal((await getLocalContext("lc2-porto"))?.tips.length, 2);
    assert.equal((await getLocalContext("lc2-porto"))?.tips.length, 2);
    assert.equal(overpassCalls, 1);
  });
});

describe("the neighborhood fetchers never score an unfinished Overpass answer", () => {
  const answer = (body: unknown) => _setTestFetch(async () => ({ ok: true, json: async () => body }));
  it("NM1 an unfinished POI answer → no POIs, never the cut set", async () => {
    answer(CUT);
    assert.deepEqual(await fetchCityPois(38.72, -9.14), []);
  });
  it("NM2 CONTROL: a healthy POI answer → its POIs", async () => {
    answer(HEALTHY);
    assert.equal((await fetchCityPois(38.72, -9.14)).length, 2);
  });
  it("NM3 an unfinished areas answer with three named areas → the grid, never those three", async () => {
    const area = (id: number, name: string) => ({ type: "node", id, lat: 38.72 + id / 100, lon: -9.14, tags: { name, place: "suburb" } });
    answer({ elements: [area(1, "Alfama"), area(2, "Baixa"), area(3, "Chiado")], remark: MEMORY_REMARK });
    const seeds = await fetchCityAreas("Lisbon", 38.72, -9.14);
    assert.equal(seeds.length, 9, "the 3x3 grid, not an empty list");  // wave W: without this, an empty list passed the `every` below vacuously
    assert.equal(seeds.every((s) => s.source === "grid"), true, JSON.stringify(seeds.map((s) => [s.name, s.source])));
    answer({ elements: [area(1, "Alfama"), area(2, "Baixa"), area(3, "Chiado")] });
    assert.deepEqual((await fetchCityAreas("Lisbon", 38.72, -9.14)).map((s) => s.name), ["Alfama", "Baixa", "Chiado"]);
  });
});

describe("census-trips §90: refreshCityNeighborhoods never stores a city computed from a failed Overpass read", () => {
  const area = (id: number, name: string) => ({ type: "node", id, lat: 38.72 + id / 100, lon: -9.14, tags: { name, place: "suburb" } });
  const AREAS = { elements: [area(1, "Alfama"), area(2, "Baixa"), area(3, "Chiado")] };
  const POIS = { elements: [cafe(11, "Cafe A"), cafe(12, "Cafe B"), { type: "node", id: 13, lat: 38.73, lon: -9.14, tags: { name: "Bar C", amenity: "bar" } }] };
  const STORED = [{ city_name: "Lisbon", name: "Old Area", computed_at: new Date(Date.now() - 30 * 86_400_000).toISOString() }];
  /** A minimal service client: the stored rows on select, and every upsert recorded. */
  function fakeSc() {
    const upserts: unknown[][] = [];
    const sc = {
      from(_t: string) {
        return {
          select() { return { eq: async () => ({ data: STORED, error: null }) }; },
          upsert(rows: unknown[]) { upserts.push(rows); return { select: async () => ({ data: rows, error: null }) }; },
        };
      },
    };
    return { sc, upserts };
  }
  /** Overpass answers by query: the areas query names `place`, the POI query does not. */
  const byQuery = (areas: () => unknown, pois: () => unknown) => _setTestFetch(async (url: any) => {
    const body = String(url).includes(encodeURIComponent('node["place"')) ? areas() : pois();
    return body instanceof Response ? body : { ok: true, json: async () => body };
  });

  for (const [name, failed] of [
    ["an unfinished areas answer", () => ({ elements: [], remark: TIMEOUT_REMARK })],
    ["a 429 on the areas read", () => new Response("rate limited", { status: 429 })],
    ["a thrown fetch on the areas read", () => { throw new Error("TimeoutError"); }],  // verifier R1 (#689): byQuery's areas() runs inside the async fetch stub, so this is the rejection queryOverpass catches
  ] as const) {
    it(`NM4 ${name} with healthy POIs: nothing is written, the stored rows are returned`, async () => {
      byQuery(failed, () => POIS);
      const { sc, upserts } = fakeSc();
      const out = await refreshCityNeighborhoods(sc, "Lisbon", 38.72, -9.14);
      assert.equal(upserts.length, 0, `a grid built from a failed read was stored: ${JSON.stringify(upserts)}`);
      assert.deepEqual(out.map((a: any) => a.name), ["Old Area"]);
    });
  }

  it("NM5 an unfinished POI answer: nothing is written", async () => {
    byQuery(() => AREAS, () => ({ ...POIS, remark: MEMORY_REMARK }));
    const { sc, upserts } = fakeSc();
    await refreshCityNeighborhoods(sc, "Lisbon", 38.72, -9.14);
    assert.equal(upserts.length, 0);
  });

  it("NM6 CONTROL: two healthy reads are computed and stored", async () => {
    byQuery(() => AREAS, () => POIS);
    const { sc, upserts } = fakeSc();
    const out = await refreshCityNeighborhoods(sc, "Lisbon", 38.72, -9.14);
    assert.equal(upserts.length, 1);
    assert.deepEqual(out.map((a: any) => a.name).sort(), ["Alfama", "Baixa", "Chiado"]);
  });

  it("NM7 CONTROL: a healthy areas answer with fewer than 3 named areas still stores the grid (an answer, not a failure)", async () => {
    byQuery(() => ({ elements: [area(1, "Alfama")] }), () => POIS);
    const { sc, upserts } = fakeSc();
    const out = await refreshCityNeighborhoods(sc, "Lisbon", 38.72, -9.14);
    assert.equal(upserts.length, 1);
    assert.equal(out.every((a: any) => a.source === "grid"), true);
  });
});
