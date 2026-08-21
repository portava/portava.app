/**
 * Tier 1 OSM tag mapping — unit tests for `mapOsmElementToPlace`.
 *
 * WHAT THIS PINS. Overpass returns the full tag set for every element and this
 * route used to keep seven tags and discard the rest. The owner's Tier 1 ruling
 * names six of the discarded ones — outdoor_seating, wheelchair,
 * internet_access, addr:neighbourhood, wikidata, image — and these tests are the
 * standing proof that they survive the mapping.
 *
 * ── FIXTURE PROVENANCE, stated rather than implied ───────────────────────────
 *
 * The elements below are **schema-derived, not capture-derived.** They are built
 * from the documented Overpass/OSM element shape and the documented value sets
 * of each tag, NOT copied from a live response. Three things were tried first,
 * in the order an operator ruled:
 *
 *   1. A real response already committed to the repo — none exists. The only
 *      OSM element fixtures in the tree (`neighborhoodMatch.test.ts`) are
 *      hand-written minimal nodes carrying `amenity`/`place` and none of the
 *      six tags at issue.
 *   2. Capture indirectly through the production API — **structurally
 *      impossible for this purpose.** Both `/api/discovery` and the
 *      `discovery_cache` rows behind it store the MAPPED `DiscoveryPlace`, so
 *      the raw tags have already been discarded before anything is observable
 *      from outside. The very defect under repair is what makes production
 *      unable to witness it.
 *   3. Model on the documented schema and say so — this file.
 *
 * That limitation is acceptable here and it is worth being precise about why:
 * this test is about WHICH KEYS WE KEEP, which is verifiable against our own
 * code and exercised correctly by any well-formed element. It is not about
 * exotic real-world payload shapes. What a schema-derived fixture cannot tell
 * us is how OFTEN these tags occur in the wild — that is a coverage question,
 * it needs real data, and it is tracked as its own step rather than pretended
 * at here.
 *
 * Run: node --import tsx/esm --test src/test/discoveryOsmTier1Mapping.test.ts
 */
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import discoveryRouter, {
  _resetWikidataCacheForTests,
  mapOsmElementToPlace,
} from "../routes/discovery.js";
import { _clearTestClient, _setTestClient } from "../lib/http.js";

// Paris centre, so distances stay small and readable.
const ORIGIN = { lat: 48.8566, lng: 2.3522 };

type OsmTags = Record<string, string>;

/** A well-formed named Overpass node at the origin, plus whatever tags a test
 *  is actually about. Keeps each case to the one variable it exercises. */
function node(tags: OsmTags, id = 1) {
  return {
    type: "node" as const,
    id,
    lat: ORIGIN.lat,
    lon: ORIGIN.lng,
    tags: { name: "Test Place", ...tags },
  };
}

function map(tags: OsmTags) {
  return mapOsmElementToPlace(node(tags), "food_drink", ORIGIN.lat, ORIGIN.lng);
}

describe("Tier 1 OSM mapping — the six ruled tags survive", () => {
  it("keeps outdoor_seating, wheelchair and internet_access as chips", () => {
    const place = map({
      amenity: "cafe",
      outdoor_seating: "yes",
      wheelchair: "yes",
      internet_access: "wlan",
    });

    assert.ok(place.tags.includes("outdoor seating"), "outdoor_seating must reach the card");
    assert.ok(place.tags.includes("wheelchair accessible"), "wheelchair must reach the card");
    assert.ok(place.tags.includes("wifi"), "internet_access must reach the card");
  });

  it("populates neighborhood from addr:neighbourhood", () => {
    const place = map({ amenity: "cafe", "addr:neighbourhood": "Le Marais" });
    assert.equal(place.neighborhood, "Le Marais");
  });

  it("carries wikidata and image without consuming them", () => {
    const place = map({
      amenity: "cafe",
      wikidata: "Q243",
      image: "https://upload.wikimedia.org/wikipedia/commons/a/af/Tour.jpg",
    });

    assert.equal(place.wikidataId, "Q243");
    assert.equal(
      place.osmImageUrl,
      "https://upload.wikimedia.org/wikipedia/commons/a/af/Tour.jpg",
    );
  });

  it("leaves the photo chain alone — osmImageUrl is NOT promoted to headerImageUrl", () => {
    // The client's useFsqPhoto returns early when a header image is already
    // present. If Tier 1 promoted this value, it would silently replace the
    // working FSQ -> Google -> artwork chain with an unvalidated third-party
    // URL. Precedence is ruled to be settled in the photo-persistence step.
    const place = map({ amenity: "cafe", image: "https://example.org/x.jpg" });

    assert.equal(place.osmImageUrl, "https://example.org/x.jpg");
    assert.equal(place.headerImageUrl, undefined, "Tier 1 must not set a header image");
  });
});

describe("Absence of evidence must not become evidence of absence", () => {
  it("emits nothing at all for an untagged place", () => {
    const place = map({ amenity: "cafe" });

    // An untagged place is not a place without wifi. OSM tagging is sparse and
    // voluntary, so silence is the only honest output.
    assert.deepEqual(place.tags, ["cafe"]);
    assert.equal(place.neighborhood, null);
    assert.equal(place.wikidataId, null);
    assert.equal(place.osmImageUrl, null);
  });

  it("emits nothing for explicitly negative values, rather than a negative claim", () => {
    const place = map({
      amenity: "cafe",
      outdoor_seating: "no",
      wheelchair: "no",
      internet_access: "no",
    });

    assert.deepEqual(
      place.tags,
      ["cafe"],
      "a negative tag must produce no chip, never a 'no wifi' chip",
    );
  });
});

describe("Value handling that would otherwise overstate or break", () => {
  it("does not flatten wheelchair=limited into full accessibility", () => {
    const place = map({ amenity: "restaurant", wheelchair: "limited" });

    assert.ok(place.tags.includes("partial wheelchair access"));
    assert.ok(
      !place.tags.includes("wheelchair accessible"),
      "'limited' must never be reported as full access",
    );
  });

  it("maps the internet_access technology values, not just yes/no", () => {
    assert.ok(map({ amenity: "cafe", internet_access: "terminal" }).tags.includes("internet terminal"));
    assert.ok(map({ amenity: "cafe", internet_access: "wifi" }).tags.includes("wifi"));
    assert.ok(map({ amenity: "cafe", internet_access: "wlan" }).tags.includes("wifi"));
  });

  it("rejects wikidata values that are not entity ids", () => {
    assert.equal(map({ wikidata: "Tour Eiffel" }).wikidataId, null);
    assert.equal(map({ wikidata: "P31" }).wikidataId, null);
    assert.equal(map({ wikidata: "Q0" }).wikidataId, null);
    assert.equal(map({ wikidata: "Q243" }).wikidataId, "Q243");
  });

  it("rejects image values that are not absolute http(s) URLs", () => {
    // Bare Commons filenames are common in OSM and are not displayable without
    // a Wikimedia call, which is Tier 2. Carrying them as if they were URLs
    // would hand the next step a value that renders as a broken image.
    assert.equal(map({ image: "File:Cafe.jpg" }).osmImageUrl, null);
    assert.equal(map({ image: "commons.wikimedia.org/wiki/File:Cafe.jpg" }).osmImageUrl, null);
    assert.equal(map({ image: "" }).osmImageUrl, null);
    assert.equal(map({ image: "http://example.org/a.jpg" }).osmImageUrl, "http://example.org/a.jpg");
  });

  it("falls back through the same neighbourhood chain the seed script uses", () => {
    // seed-discovery-places.ts resolves neighbourhood ?? suburb ?? addr:suburb.
    // The live route must not disagree with the seeded rows about what a
    // neighbourhood is.
    assert.equal(map({ neighbourhood: "Pigalle" }).neighborhood, "Pigalle");
    assert.equal(map({ "addr:suburb": "Passy" }).neighborhood, "Passy");
    assert.equal(map({ suburb: "Passy" }).neighborhood, "Passy");

    // Most specific key wins when several are present.
    assert.equal(
      map({ "addr:neighbourhood": "Le Marais", suburb: "3e arrondissement" }).neighborhood,
      "Le Marais",
    );
  });

  it("trims whitespace-only values to null rather than rendering a blank line", () => {
    assert.equal(map({ "addr:neighbourhood": "   " }).neighborhood, null);
  });
});

describe("The chip row cannot be flooded, and identity keeps priority", () => {
  it("caps total chips and puts category identity first", () => {
    const place = map({
      cuisine: "italian",
      amenity: "restaurant",
      tourism: "attraction",
      leisure: "garden",
      historic: "monument",
      outdoor_seating: "yes",
      wheelchair: "yes",
      internet_access: "wlan",
    });

    assert.ok(place.tags.length <= 6, `expected <= 6 chips, got ${place.tags.length}`);
    assert.deepEqual(
      place.tags.slice(0, 3),
      ["italian", "attraction", "restaurant"],
      "category chips keep the first three slots",
    );
    assert.ok(place.tags.includes("outdoor seating"), "attributes fill the remaining slots");
  });

  it("does not repeat a chip that both sources produce", () => {
    const place = map({ amenity: "cafe", internet_access: "wlan" });
    assert.equal(new Set(place.tags).size, place.tags.length);
  });
});

describe("Nothing that already worked was disturbed", () => {
  it("still maps the pre-existing fifteen fields", () => {
    const place = mapOsmElementToPlace(
      {
        type: "way",
        id: 42,
        center: { lat: 48.8600, lon: 2.3600 },
        tags: {
          name: "Cafe de Flore",
          amenity: "cafe",
          description: "A cafe",
          "addr:housenumber": "172",
          "addr:street": "Boulevard Saint-Germain",
          "addr:city": "Paris",
          website: "https://example.org",
          phone: "+33 1 45 48 55 26",
          opening_hours: "Mo-Su 07:30-01:30",
          stars: "4",
        },
      },
      "food_drink",
      ORIGIN.lat,
      ORIGIN.lng,
    );

    assert.equal(place.id, "way/42");
    assert.equal(place.name, "Cafe de Flore");
    assert.equal(place.category, "food_drink");
    assert.equal(place.description, "A cafe");
    assert.equal(place.address, "172 Boulevard Saint-Germain, Paris");
    assert.equal(place.website, "https://example.org");
    assert.equal(place.phone, "+33 1 45 48 55 26");
    assert.equal(place.openingHours, "Mo-Su 07:30-01:30");
    assert.equal(place.rating, 4);
    assert.equal(place.lat, 48.86);
    assert.equal(place.lng, 2.36);
    assert.ok(place.distanceKm != null && place.distanceKm > 0, "way centre still yields a distance");
  });
});

// ── Wikidata enrichment cache controls ─────────────────────────────────────────

const WIKIDATA_ADMIN_ID = "aa000000-0000-4000-a000-000000000001";
const WIKIDATA_MEMBER_ID = "bb000000-0000-4000-b000-000000000002";
const WIKIDATA_ADMIN_TOKEN = "admin-token";
const WIKIDATA_MEMBER_TOKEN = "member-token";

function makeWikidataAuthClient() {
  return {
    auth: {
      getUser: async (token: string) => {
        if (token === WIKIDATA_ADMIN_TOKEN) return { data: { user: { id: WIKIDATA_ADMIN_ID } }, error: null };
        if (token === WIKIDATA_MEMBER_TOKEN) return { data: { user: { id: WIKIDATA_MEMBER_ID } }, error: null };
        return { data: { user: null }, error: { message: "invalid token" } };
      },
    },
    from: (table: string) => {
      assert.equal(table, "profiles", "the admin guard should only need the caller profile");
      let userId: string | null = null;
      const query: any = {
        select: () => query,
        eq: (column: string, value: string) => {
          if (column === "id") userId = value;
          return query;
        },
        maybeSingle: async () => ({
          data: {
            role: userId === WIKIDATA_ADMIN_ID ? "admin" : "member",
            account_status: "active",
          },
          error: null,
        }),
      };
      return query;
    },
  };
}

let wikidataServer: Server;
let wikidataBaseUrl: string;
let wikidataUpstreamDescriptions: string[];
let wikidataUpstreamCalls = 0;
const originalFetch = globalThis.fetch;

before(async () => {
  const app = express();
  app.use((req, _res, next) => {
    (req as any).log = { error() {}, info() {}, warn() {}, debug() {} };
    next();
  });
  app.use("/api", discoveryRouter);
  wikidataServer = createServer(app);
  await new Promise<void>((resolve) => wikidataServer.listen(0, "127.0.0.1", resolve));
  wikidataBaseUrl = `http://127.0.0.1:${(wikidataServer.address() as { port: number }).port}`;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.includes("www.wikidata.org/w/api.php")) return originalFetch(input, init);

    const description = wikidataUpstreamDescriptions.shift();
    assert.ok(description, "each upstream Wikidata fetch must have a fixture");
    wikidataUpstreamCalls++;
    return new Response(JSON.stringify({
      entities: {
        Q42: {
          descriptions: { en: { value: description } },
          sitelinks: { enwiki: { title: "Douglas Adams" } },
          claims: {},
        },
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
});

after(async () => {
  globalThis.fetch = originalFetch;
  _clearTestClient();
  await new Promise<void>((resolve) => wikidataServer.close(() => resolve()));
});

beforeEach(() => {
  _resetWikidataCacheForTests();
  _setTestClient(makeWikidataAuthClient(), true);
  wikidataUpstreamDescriptions = ["original Wikidata description", "updated Wikidata description"];
  wikidataUpstreamCalls = 0;
});

function getWikidata(path: string, token?: string) {
  return fetch(`${wikidataBaseUrl}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

describe("GET /api/discovery/wikidata/:wikidataId cache controls", () => {
  it("reports cache age and lets only an admin replace a stale cached entity", async () => {
    const first = await getWikidata("/api/discovery/wikidata/Q42");
    assert.equal(first.status, 200);
    assert.equal((await first.json() as { description: string }).description, "original Wikidata description");
    assert.equal(first.headers.get("x-wikidata-cache"), "MISS");
    assert.equal(first.headers.get("x-wikidata-cache-ttl"), "86400");
    assert.ok(Number(first.headers.get("x-wikidata-cache-age")) >= 0);
    assert.ok(
      Number.isFinite(Date.parse(first.headers.get("x-wikidata-cache-created-at") ?? "")),
      "fresh responses must say when their server-side entry was created",
    );
    assert.equal(wikidataUpstreamCalls, 1);

    const cached = await getWikidata("/api/discovery/wikidata/Q42");
    assert.equal(cached.status, 200);
    assert.equal((await cached.json() as { description: string }).description, "original Wikidata description");
    assert.equal(cached.headers.get("x-wikidata-cache"), "HIT");
    assert.equal(wikidataUpstreamCalls, 1, "a fresh L1 entry must avoid another upstream request");

    const anonymousRefresh = await getWikidata("/api/discovery/wikidata/Q42?refresh=1");
    assert.equal(anonymousRefresh.status, 401);
    assert.equal(wikidataUpstreamCalls, 1, "unauthenticated callers must not bypass the cache");

    const memberRefresh = await getWikidata(
      "/api/discovery/wikidata/Q42?refresh=1",
      WIKIDATA_MEMBER_TOKEN,
    );
    assert.equal(memberRefresh.status, 403);
    assert.equal(wikidataUpstreamCalls, 1, "non-admin callers must not bypass the cache");

    const refreshed = await getWikidata(
      "/api/discovery/wikidata/Q42?refresh=1",
      WIKIDATA_ADMIN_TOKEN,
    );
    assert.equal(refreshed.status, 200);
    assert.equal((await refreshed.json() as { description: string }).description, "updated Wikidata description");
    assert.equal(refreshed.headers.get("x-wikidata-cache"), "REFRESH");
    assert.ok(Number(refreshed.headers.get("x-wikidata-cache-age")) >= 0);
    assert.equal(wikidataUpstreamCalls, 2, "an admin refresh must fetch the current entity");

    const afterRefresh = await getWikidata("/api/discovery/wikidata/Q42");
    assert.equal(afterRefresh.status, 200);
    assert.equal((await afterRefresh.json() as { description: string }).description, "updated Wikidata description");
    assert.equal(afterRefresh.headers.get("x-wikidata-cache"), "HIT");
    assert.equal(wikidataUpstreamCalls, 2, "the refreshed result must become the new L1 entry");
  });
});
