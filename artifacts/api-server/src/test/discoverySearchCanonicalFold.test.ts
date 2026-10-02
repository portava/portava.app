/**
 * discoverySearchCanonicalFold — census-discovery B01 (§46): Discovery's
 * readers of `canonical_locations` match on the STORED diacritic fold
 * (migration 2220's `search_key`), and degrade — loudly — where it is absent.
 *
 * The fixture rows are shaped as 2220 stores them: `normalized_name` is what
 * the legacy normaliser wrote (a stroke letter DELETED: "Łódź" → "odz",
 * "Thành phố Đà Nẵng" → "thanh pho a nang", the latter verbatim from
 * production per census-input-intelligence §26), and `search_key` is what the
 * generated column computes. src/test/db/discoverySearchCanonicalFold.db.test.ts
 * proves the same matches against the real column on PostgreSQL 16.
 *
 * Run: node --import tsx/esm --test src/test/discoverySearchCanonicalFold.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import discoverySearchRouter, { invalidateBuddyLaunchGateCache } from "../routes/discoverySearch.js";
import {
  CANONICAL_FOLD_SOURCE,
  canonicalFoldFailures,
  canonicalFoldOf,
  readCanonicalCitySuggestions,
  withStoredFoldCentroids,
} from "../lib/discoverySearchCanonical.js";
import { CanonicalReadUnavailableError, suggestCanonicalLocations } from "../lib/canonicalLocations.js";
import { invalidateSearchProtectionFlagCache } from "../lib/discoverySearchProtection.js";
import { invalidateDiscoveryTripProjectionFlagCache } from "../lib/discoveryTripProjectionConsumer.js";
import {
  VIEWER,
  emptyCalls,
  emptyState,
  installKit,
  kitGet,
  makeKitClient,
  startKitServer,
  type KitState,
} from "./discoverySearchTestKit.js";

function canon(id: string, name: string, normalized: string, searchKey: string, over: Record<string, unknown> = {}) {
  return {
    id, kind: "city", name, normalized_name: normalized, search_key: searchKey, display_name: name,
    city: null, region: null, country: "X", country_code: "XX", postal_code: null,
    lat: 10, lng: 20, provider_ids: {}, aliases: [], ...over,
  };
}
const ZURICH = canon("c-zurich", "Zürich", "zurich", "zurich", { country: "Switzerland", lat: 47.37, lng: 8.54 });
const SAO_PAULO = canon("c-sp", "São Paulo", "sao paulo", "sao paulo", { country: "Brazil", lat: -23.55, lng: -46.63 });
const LODZ = canon("c-lodz", "Łódź", "odz", "lodz", { country: "Poland", lat: 51.76, lng: 19.46 });
const DA_NANG_VI = canon("c-dn-vi", "Thành phố Đà Nẵng", "thanh pho a nang", "thanh pho da nang", { country: "Vietnam", lat: 16.05, lng: 108.2 });
const OSLO = canon("c-oslo", "Oslo", "oslo", "oslo", { country: "Norway", lat: 59.91, lng: 10.75 });
const REGISTRY = [ZURICH, SAO_PAULO, LODZ, DA_NANG_VI, OSLO];

function client(over: Partial<KitState> = {}) {
  const state = emptyState({ rows: { canonical_locations: REGISTRY.map((r) => ({ ...r })) }, ...over });
  const calls = emptyCalls();
  return { sc: makeKitClient(state, calls) as any, state, calls };
}
const names = (rows: Array<{ name: string }>) => rows.map((r) => r.name);

// ═════════════════════════════════════════════════════════════════════════════
// F. The suggest reader
// ═════════════════════════════════════════════════════════════════════════════

describe("F — readCanonicalCitySuggestions matches the STORED fold", () => {
  it("F1 — 'lodz' reaches Łódź through search_key, which the legacy normalized_name reader cannot (the defect, as a control)", async () => {
    const { sc } = client();
    assert.deepEqual(names(await readCanonicalCitySuggestions(sc, "lodz", 5)), ["Łódź"]);
    assert.deepEqual(names(await suggestCanonicalLocations(client().sc, "lodz", 5)), [],
      "control: the legacy reader must NOT find Łódź, or this test proves nothing");
  });

  for (const [typed, expected] of [
    ["zurich", "Zürich"], ["Zurich", "Zürich"], ["Zürich", "Zürich"],
    ["sao paulo", "São Paulo"], ["São Paulo", "São Paulo"],
    ["Łódź", "Łódź"], ["LODZ", "Łódź"],
    ["da nang", "Thành phố Đà Nẵng"],
  ] as const) {
    it(`F2 — '${typed}' → ${expected}`, async () => {
      const { sc } = client();
      assert.ok(names(await readCanonicalCitySuggestions(sc, typed, 5)).includes(expected));
    });
  }

  it("F3 — a non-matching control matches nothing, and a real query does not over-match", async () => {
    const { sc } = client();
    assert.deepEqual(await readCanonicalCitySuggestions(sc, "xyzzy", 5), []);
    assert.deepEqual(names(await readCanonicalCitySuggestions(client().sc, "oslo", 5)), ["Oslo"]);
    assert.equal(canonicalFoldOf(await readCanonicalCitySuggestions(client().sc, "xyzzy", 5)), "stored",
      "a genuine no-match through the fold is NOT marked degraded");
  });

  it("F4 — the query side folds with the SAME function the column mirrors (the pattern sent is the fold, not the raw text)", async () => {
    const { sc, calls } = client();
    await readCanonicalCitySuggestions(sc, "Łódź", 5);
    assert.deepEqual(calls.ilikes.map((c) => [c.col, c.pat]), [["search_key", "lodz%"], ["search_key", "%lodz%"]]);
  });

  it("F5 — prefix before contains, city-class only, deduped by fold, capped at the limit", async () => {
    const rows = [
      canon("a", "Portland", "portland", "portland"), canon("b", "Oporto", "oporto", "oporto"),
      canon("c", "Portugal", "portugal", "portugal", { kind: "country" }), canon("d", "Portland", "portland", "portland"),
      canon("e", "Porto", "porto", "porto"),
    ];
    const { sc } = client({ rows: { canonical_locations: rows } });
    assert.deepEqual((await readCanonicalCitySuggestions(sc, "port", 2)).map((r) => r.id), ["a", "e"]);
  });
});

describe("F — the degrade: search_key ABSENT (defence in depth; production has 2220)", () => {
  const absent = () => client({ missingColumns: new Set(["canonical_locations.search_key"]) });

  it("F6 — falls back to the legacy key: a decomposable accent still matches, and the answer is MARKED legacy", async () => {
    const { sc, calls } = absent();
    const rows = await readCanonicalCitySuggestions(sc, "zurich", 5);
    assert.deepEqual(names(rows), ["Zürich"]);
    assert.equal(canonicalFoldOf(rows), "legacy");
    assert.deepEqual(canonicalFoldFailures(rows), [CANONICAL_FOLD_SOURCE]);
    assert.ok(calls.ilikes.some((c) => c.col === "normalized_name"), "the fallback must actually read the legacy column");
  });

  it("F7 — a stroke-letter city is unreachable on the fallback, and that absence is marked rather than silent", async () => {
    const { sc } = absent();
    const rows = await readCanonicalCitySuggestions(sc, "lodz", 5);
    assert.deepEqual(rows, []);
    assert.equal(canonicalFoldOf(rows), "legacy", "an unreadable fold index reads exactly like 'no such city'");
  });

  it("F8 — the TABLE absent is the legacy reader's structural 'no registry': [] and NOT marked degraded", async () => {
    const { sc } = client({ errorTables: { canonical_locations: { code: "42P01", message: 'relation "canonical_locations" does not exist' } } });
    const rows = await readCanonicalCitySuggestions(sc, "zurich", 5);
    assert.deepEqual(rows, []);
    assert.deepEqual(canonicalFoldFailures(rows), []);
  });

  it("F9 — any OTHER read error is a refusal, never a no-match (D11)", async () => {
    const { sc } = client({ errorTables: { canonical_locations: { code: "57014", message: "canceling statement due to statement timeout" } } });
    await assert.rejects(() => readCanonicalCitySuggestions(sc, "zurich", 5), (e) => e instanceof CanonicalReadUnavailableError);
  });

  it("F10 — a read that REJECTS is a refusal too", async () => {
    const { sc } = client({ throwTables: new Set(["canonical_locations"]) });
    await assert.rejects(() => readCanonicalCitySuggestions(sc, "zurich", 5), (e) => e instanceof CanonicalReadUnavailableError);
  });

  it("F11 — the fallback's own read failing is still a refusal (its D11 contract is kept, not swallowed)", async () => {
    const { sc } = client({
      missingColumns: new Set(["canonical_locations.search_key"]),
      errorOn: ({ named }) => (named.has("normalized_name") ? { code: "57014", message: "timeout" } : null),
    });
    await assert.rejects(() => readCanonicalCitySuggestions(sc, "zurich", 5), (e) => e instanceof CanonicalReadUnavailableError);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// C. The centroid lookup (search type=cities / countries) — enrichment, never a gate
// ═════════════════════════════════════════════════════════════════════════════

describe("C — withStoredFoldCentroids", () => {
  const legacyLodz = new Map([["zurich", { id: "c-zurich", lat: 47.37, lng: 8.54 }]]);

  it("C1 — a name the legacy key placed keeps that placement and costs no second read", async () => {
    const { sc, calls } = client();
    const out = await withStoredFoldCentroids(sc, ["Zürich"], ["city"], legacyLodz);
    assert.deepEqual(out.get("Zürich"), { id: "c-zurich", lat: 47.37, lng: 8.54 });
    assert.equal(calls.tables.length, 0);
  });

  it("C2 — a name the legacy key could not place is placed through the stored fold ('Lodz' → Łódź)", async () => {
    const { sc } = client();
    const out = await withStoredFoldCentroids(sc, ["Lodz", "Zürich"], ["city"], legacyLodz);
    assert.deepEqual(out.get("Lodz"), { id: "c-lodz", lat: 51.76, lng: 19.46 });
  });

  it("C3 — the fold absent or unreadable leaves the name unplaced, never an error", async () => {
    for (const over of [
      { missingColumns: new Set(["canonical_locations.search_key"]) },
      { errorTables: { canonical_locations: { code: "57014", message: "timeout" } } },
      { throwTables: new Set(["canonical_locations"]) },
    ] as Array<Partial<KitState>>) {
      const { sc } = client(over);
      const out = await withStoredFoldCentroids(sc, ["Lodz"], ["city"], new Map());
      assert.equal(out.has("Lodz"), false);
    }
  });

  it("C4 — a registry row without both coordinates places nothing (never half a pin)", async () => {
    const { sc } = client({ rows: { canonical_locations: [canon("c-lodz", "Łódź", "odz", "lodz", { lng: null })] } });
    const out = await withStoredFoldCentroids(sc, ["Lodz"], ["city"], new Map());
    assert.equal(out.has("Lodz"), false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// S. Through the routes
// ═════════════════════════════════════════════════════════════════════════════

let base = "";
let server: Server;
before(async () => { ({ base, server } = await startKitServer(discoverySearchRouter)); });
after(() => server.close());
beforeEach(() => {
  invalidateBuddyLaunchGateCache();
  invalidateSearchProtectionFlagCache();
  invalidateDiscoveryTripProjectionFlagCache();
});

function routeWorld(over: Partial<KitState> = {}): Partial<KitState> {
  return {
    rows: {
      profiles: [{ id: VIEWER, handle: "viewer", name: "Viewer", account_status: "active", is_private: false }],
      blocks: [], user_privacy_settings: [], profile_privacy_settings: [], user_follows: [], friend_requests: [],
      user_friendships: [], event_rsvps: [], events: [], trips: [], trip_plan_items: [], hidden_gems: [], posts: [],
      circles: [], hashtags: [], stamp_definitions: [], discovery_places: [],
      canonical_locations: REGISTRY.map((r) => ({ ...r })),
    },
    ...over,
  };
}
const cityTitles = (body: any) => ((body.groups ?? []) as any[]).filter((g) => g.type === "cities").flatMap((g) => g.items.map((i: any) => i.title));

describe("S — GET /discovery/suggest's Cities group", () => {
  it("S1 — 'lodz' suggests Łódź from the registry, with no refusal", async () => {
    installKit(routeWorld());
    const { status, body } = await kitGet(base, "/discovery/suggest?q=lodz");
    assert.equal(status, 200);
    assert.deepEqual(cityTitles(body), ["Łódź"]);
    assert.equal(body.refusal, undefined);
  });

  it("S2 — 'da nang' suggests the Vietnamese-spelled registry row (production's own example)", async () => {
    installKit(routeWorld());
    const { body } = await kitGet(base, "/discovery/suggest?q=da%20nang");
    assert.deepEqual(cityTitles(body), ["Thành phố Đà Nẵng"]);
  });

  it("S3 — search_key ABSENT: 200, the legacy match is served, and the body says it is PARTIAL and why", async () => {
    installKit(routeWorld({ missingColumns: new Set(["canonical_locations.search_key"]) }));
    const { status, body } = await kitGet(base, "/discovery/suggest?q=zurich");
    assert.equal(status, 200, "an absent column must not 500");
    assert.deepEqual(cityTitles(body), ["Zürich"]);
    assert.deepEqual(body.refusal, {
      class: "feature_disabled", code: "canonical_fold_unavailable", route: "GET /discovery/suggest",
      coverage: "partial", failedSources: [CANONICAL_FOLD_SOURCE],
    });
  });

  it("S4 — search_key ABSENT and nothing matches: the empty answer carries the refusal, so it cannot pass for 'no match'", async () => {
    installKit(routeWorld({ missingColumns: new Set(["canonical_locations.search_key"]) }));
    const degraded = await kitGet(base, "/discovery/suggest?q=lodz");
    installKit(routeWorld());
    const genuine = await kitGet(base, "/discovery/suggest?q=xyzzy");
    assert.deepEqual(degraded.body.groups, []);
    assert.deepEqual(genuine.body.groups, []);
    assert.equal(genuine.body.refusal, undefined, "control: a genuine no-match is unmarked");
    assert.equal(degraded.body.refusal?.code, "canonical_fold_unavailable");
    assert.notDeepEqual(degraded.body, { ...genuine.body, query: "lodz" }, "the degraded empty is byte-identical to a genuine one");
  });

  it("S5 — the fold absent AND a type unreadable: one refusal naming both sources", async () => {
    installKit(routeWorld({
      missingColumns: new Set(["canonical_locations.search_key"]),
      errorTables: { hashtags: { code: "57014", message: "timeout" } },
    }));
    const { body } = await kitGet(base, "/discovery/suggest?q=zurich");
    assert.equal(body.refusal?.code, "suggest_sources_unreadable");
    assert.equal(body.refusal?.coverage, "partial");
    assert.ok(body.refusal.failedSources.includes("hashtags"));
    assert.ok(body.refusal.failedSources.includes(CANONICAL_FOLD_SOURCE));
  });

  it("S6 — a transient registry failure still refuses the whole suggest (D11 unchanged)", async () => {
    installKit(routeWorld({ errorTables: { canonical_locations: { code: "57014", message: "timeout" } } }));
    const { status, body } = await kitGet(base, "/discovery/suggest?q=zurich");
    assert.equal(status, 200);
    assert.deepEqual(body.groups, []);
    assert.equal(body.refusal?.code, "suggest_failed");
  });
});

describe("S — GET /discovery/search type=cities places a profile city through the stored fold", () => {
  const resident = (city: string) => ({
    id: "d1000000-0000-4000-a000-000000000001", handle: "res", name: "Res", home_city: city, home_country: "Poland",
    account_status: "active", is_private: false,
  });

  it("S7 — a resident who typed 'Lodz' is placed at the registry's Łódź; one who typed 'Zürich' keeps the legacy placement", async () => {
    const w = routeWorld();
    w.rows!.profiles!.push(resident("Lodz"), { ...resident("Zürich"), id: "d1000000-0000-4000-a000-000000000002" });
    installKit(w);
    const lodz = await kitGet(base, "/discovery/search?q=lodz&type=cities");
    assert.equal(lodz.status, 200);
    assert.equal(lodz.body.results[0].title, "Lodz", "display spelling is the resident's, never rewritten");
    assert.equal(lodz.body.results[0].metadata.canonicalId, "c-lodz");
    assert.equal(lodz.body.results[0].metadata.lat, 51.76);
    const zurich = await kitGet(base, "/discovery/search?q=z%C3%BCrich&type=cities");
    assert.equal(zurich.body.results[0].metadata.canonicalId, "c-zurich");
  });

  it("S8 — search_key absent: the 'Lodz' row is served UNPLACED — never an error, never a refusal", async () => {
    const w = routeWorld({ missingColumns: new Set(["canonical_locations.search_key"]) });
    w.rows!.profiles!.push(resident("Lodz"));
    installKit(w);
    const { status, body } = await kitGet(base, "/discovery/search?q=lodz&type=cities");
    assert.equal(status, 200);
    assert.equal(body.refusal, undefined);
    assert.equal(body.results[0].metadata.lat, null);
    assert.equal(body.results[0].metadata.lng, null);
  });
});
