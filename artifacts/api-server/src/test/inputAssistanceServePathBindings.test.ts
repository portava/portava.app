/**
 * census-input-intelligence G109 and G176, through the SERVE PATH.
 *
 * Run: node --import tsx/esm --test src/test/inputAssistanceServePathBindings.test.ts
 *
 * WHY THIS FILE EXISTS. Independent verification (2026-10-17) restated both rows
 * C → W with a probe through the real route, and both restatements were right:
 *
 *   G109  The geo-picker branch of the gateway projects its places through
 *         `dispatchAndProject`, which never asked for a venue binding.
 *         `resolveVenueBindings` was called only on the generic branch, behind a
 *         `GEO_PICKER_CONTEXTS.has(context)` test that is false on that branch by
 *         construction. So a venue picked in place_picker or event_location never
 *         carried its City / Country / Coordinates / Timezone, and
 *         `canonical_locations` was never read. The row's own tests called the
 *         resolver and the projector directly, which is how it looked closed.
 *
 *   G176  The route reads the viewer's position from the top-level `lat`/`lng`
 *         only. The two app callers that hold a consented position (the shared
 *         GlobalPlacePicker and the search screen) put it in
 *         `sessionContext.lat/lng`, and `buildSuggestBody` forwarded that object
 *         verbatim, so the coordinates went over the wire at full device
 *         precision and were dropped on arrival. No real client ever got a band
 *         or the nearby ordering.
 *
 * THE TRANSPORT DECISION (G176). There is ONE wire transport for the viewer's
 * position: the top-level pair the route already reads
 * (`routes/inputAssistance.ts` `clampCoord(body.lat, 90)`), which the Map search
 * client already uses (`search/mapSearch.ts`). The app's `InputSessionContext`
 * keeps `lat`/`lng` as the HOOK's input (and its ~1 km cache dimension);
 * `buildSuggestBody` is the wire mapper and lifts a valid pair to the top level,
 * coarsened to 3 decimals (~110 m, the codebase's neighbourhood-level rule in
 * `lib/meetupPin.ts`) — fine enough for the 0.5 km band edge, never the device
 * fix — and strips it from the forwarded session object. The server's
 * `SuggestSessionContext` stays ID-only, so the position cannot reach the AI
 * writer, the paste resolver or any other session consumer by riding inside it.
 *
 * Every G176 case below builds its body with the APP's real `buildSuggestBody`,
 * so the test posts exactly what a client sends.
 *
 * MUTATION LOG (each applied alone, watched red, restored byte-identical by sha256):
 *   gateway.ts: drop `venueBinding:` in dispatchAndProject → 3 red (both pickers,
 *   unlinked venue); picker test there `false` → the same 3; the `exact` guard
 *   always true → 1 red (protection); the failed-read `continue` dropped → 1 red.
 *   suggestBody.ts: no top-level lift → 3 red (wire, place_picker band, global
 *   ranking); no coarsening → 1; session forwarded with the pair → 2; range or
 *   finiteness check dropped → 1 each. (`||` → `&&` on the typeof line is an
 *   equivalent mutant: Number.isFinite refuses a non-number on its own.)
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import inputAssistanceRouter from "../routes/inputAssistance.js";
import { resolveVenueBindings } from "../lib/inputAssistance/gateway.js";
import { timezoneForCoords } from "../lib/inputAssistance/geoResolver.js";
import type { SearchResult } from "../routes/discoverySearch.js";
import { buildSuggestBody } from "../../../../travel-buddy-standalone/src/platform/input-assistance/services/suggestBody.ts";

const ME = "aa000000-0000-4000-a000-000000000001";
const ME_TOK = "tok-me";

interface FakeState { [key: string]: any[] | undefined; }
interface Read { table: string; inCol?: string; inVals?: any[] }

let reads: Read[] = [];
let failCanonicalIdRead = false;

function makeFakeClient(state: FakeState) {
  return {
    auth: {
      getUser: async (tok: string) =>
        tok === ME_TOK
          ? { data: { user: { id: ME } }, error: null }
          : { data: { user: null }, error: { message: "bad token" } },
    },
    rpc: async () => ({ data: null, error: null }),
    from: (table: string) => {
      const read: Read = { table };
      reads.push(read);
      const sourceRows: any[] = [...(state[table] ?? [])];
      const filters: Array<(r: any) => boolean> = [];
      let _rangeStart = 0;
      let _rangeEnd = Infinity;
      let _limitN = Infinity;
      const failed = () => table === "canonical_locations" && read.inCol === "id" && failCanonicalIdRead;
      const builder: any = {
        select() { return builder; },
        eq(col: string, val: any) { filters.push((r) => r[col] === val); return builder; },
        neq(col: string, val: any) { filters.push((r) => r[col] !== val); return builder; },
        in(col: string, vals: any[]) { read.inCol = col; read.inVals = vals; filters.push((r) => vals.includes(r[col])); return builder; },
        not(col: string, op: string, val: any) {
          if (op === "is") filters.push((r) => r[col] !== val && r[col] != null);
          return builder;
        },
        is(col: string, val: any) {
          filters.push((r) => (val === null ? r[col] == null : r[col] === val));
          return builder;
        },
        ilike(col: string, pat: string) {
          const re = new RegExp("^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$", "i");
          filters.push((r) => re.test(String(r[col] ?? "")));
          return builder;
        },
        or(expr: string) {
          const parts = expr.split(",").map((p) => {
            const m = p.trim().match(/^(\w+)\.([\w]+)\.(.+)$/);
            if (!m) return null;
            return { col: m[1]!, op: m[2]!.toLowerCase(), val: m[3]! };
          }).filter(Boolean) as { col: string; op: string; val: string }[];
          filters.push((r) =>
            parts.some(({ col, op, val }) => {
              const cellStr = String(r[col] ?? "");
              if (op === "ilike") {
                const re = new RegExp("^" + val.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$", "i");
                return re.test(cellStr);
              }
              if (op === "eq") return cellStr === val;
              return false;
            }),
          );
          return builder;
        },
        gte(col: string, val: any) { filters.push((r) => r[col] != null && r[col] >= val); return builder; },
        lte(col: string, val: any) { filters.push((r) => r[col] != null && r[col] <= val); return builder; },
        lt(col: string, val: any) { filters.push((r) => r[col] != null && r[col] < val); return builder; },
        order() { return builder; },
        limit(n: number) { _limitN = n; return builder; },
        range(start: number, end: number) { _rangeStart = start; _rangeEnd = end; return builder; },
        maybeSingle() {
          const matched = sourceRows.filter((r) => filters.every((f) => f(r)));
          return Promise.resolve({ data: matched[0] ?? null, error: null });
        },
        then(onF: any, onR: any) {
          if (failed()) return Promise.resolve({ data: null, error: { message: "canonical_locations unavailable" } }).then(onF, onR);
          const matched = sourceRows
            .filter((r) => filters.every((f) => f(r)))
            .slice(_rangeStart, _rangeEnd < Infinity ? _rangeEnd + 1 : _limitN < Infinity ? _limitN : undefined);
          return Promise.resolve({ data: matched, error: null }).then(onF, onR);
        },
      };
      return builder;
    },
  };
}

let base: string;
let server: Server;

function setup(state: FakeState) {
  _setTestClient(makeFakeClient(state) as any, true);
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    next();
  });
  app.use("/api", inputAssistanceRouter);
  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}/api`;
});
after(() => server.close());
beforeEach(() => { _resetRateLimit(); reads = []; failCanonicalIdRead = false; setup({}); });

async function post(body: Record<string, unknown>) {
  const r = await fetch(`${base}/input-assistance/suggest`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ME_TOK}` },
    body: JSON.stringify(body),
  });
  assert.equal(r.status, 200);
  return ((await r.json()) as any).suggestions as any[];
}

function place(over: Record<string, unknown>) {
  return {
    blurb: null, image_url: null, header_image_source: null, image_source_type: null,
    image_accuracy_status: null, category: "bar", primary_category: "bar",
    canonical_location_id: null, created_at: "2026-01-01T00:00:00Z",
    submitted_by: null, status: "active", saved_count: 0, ...over,
  };
}

// ── G109 fixtures: the spec's own worked example ─────────────────────────────

/** Sky36 is on the 36th floor of the Novotel on the Han river, Da Nang. */
const SKY36 = place({ id: "venue-sky36", name: "Sky36", city: "Da Nang", lat: 16.0678, lng: 108.2233, canonical_location_id: "canon-da-nang" });
/** The Da Nang canonical CITY row. Its centroid is deliberately NOT Sky36's. */
const DA_NANG = {
  id: "canon-da-nang", kind: "city", name: "Da Nang", normalized_name: "da nang", display_name: "Da Nang, Vietnam",
  city: "Da Nang", region: null, country: "Vietnam", country_code: "VN", postal_code: null, lat: 16.0544, lng: 108.2022,
};

function world(extra: FakeState = {}): FakeState {
  return {
    discovery_places: [SKY36],
    canonical_locations: [DA_NANG],
    blocks: [], user_privacy_settings: [], profiles: [],
    ...extra,
  };
}

describe("§17 G109 — a picked venue carries its binding on the SERVED row", () => {
  for (const context of ["place_picker", "event_location"] as const) {
    it(`${context}: 'Sky36' through POST /input-assistance/suggest carries City, Country, the venue's Coordinates and Timezone`, async () => {
      setup(world());
      const rows = await post({ context, text: "Sky36" });
      const sky = rows.find((s) => s.entityId === "venue-sky36");
      assert.ok(sky, "premise: the venue is served");
      assert.deepEqual(sky.structuredValue, {
        entityType: "venue",
        venueId: "venue-sky36",
        venue: "Sky36",
        cityId: "canon-da-nang",
        city: "Da Nang",
        country: "Vietnam",
        countryCode: "VN",
        lat: 16.0678,
        lng: 108.2233,
        timezone: "Asia/Ho_Chi_Minh",
      });
      // The coordinates are the VENUE's, never the city centroid (rule 1).
      assert.notEqual(sky.structuredValue.lat, DA_NANG.lat);
      // canonical_locations is read once, by id, for the linked venue only.
      const byId = reads.filter((r) => r.table === "canonical_locations" && r.inCol === "id");
      assert.equal(byId.length, 1, "one batched canonical read per serve");
      assert.deepEqual(byId[0]!.inVals, ["canon-da-nang"]);
    });
  }

  it("a venue with no canonical link binds a city NAME and a null country — never an inferred one", async () => {
    const joes = place({ id: "venue-joes", name: "Joe's Diner", city: "Springfield", lat: 39.7817, lng: -89.6501 });
    setup(world({ discovery_places: [joes] }));
    const rows = await post({ context: "place_picker", text: "Joe's Diner" });
    const row = rows.find((s) => s.entityId === "venue-joes");
    assert.ok(row?.structuredValue, "the binding is attached");
    assert.equal(row.structuredValue.city, "Springfield");
    assert.equal(row.structuredValue.cityId, null);
    assert.equal(row.structuredValue.country, null);
    assert.equal(row.structuredValue.timezone, "America/Chicago");
    assert.equal(reads.filter((r) => r.table === "canonical_locations" && r.inCol === "id").length, 0,
      "nothing linked, nothing read");
  });

  it("a FAILED canonical read serves the venue with NO binding (absent prefill, never a wrong country)", async () => {
    setup(world());
    failCanonicalIdRead = true;
    const rows = await post({ context: "place_picker", text: "Sky36" });
    const sky = rows.find((s) => s.entityId === "venue-sky36");
    assert.ok(sky, "the venue is still served");
    assert.equal("structuredValue" in sky, false, "an outage is not rendered as 'this venue is in no country'");
  });

  it("global_search serves the same venue with no binding — a navigation row fills nothing", async () => {
    setup(world());
    const rows = await post({ context: "global_search", text: "Sky36" });
    const sky = rows.find((s) => s.entityId === "venue-sky36");
    assert.ok(sky, "premise: the venue is served in global search");
    assert.equal("structuredValue" in sky, false);
    assert.equal(reads.filter((r) => r.table === "canonical_locations" && r.inCol === "id").length, 0);
  });

  it("a position the protection pass touched is not the venue's: the binding keeps City/Country, drops Coordinates and Timezone", async () => {
    const sc = makeFakeClient(world());
    const touched = (precision: string, lat: number | null, lng: number | null): SearchResult => ({
      id: `v-${precision}`, type: "places", title: "Sky36", subtitle: null, avatarUrl: null, imageUrl: null,
      fallbackInitials: "S", locationPreview: "Da Nang", matchedReason: null, actionState: null, privacyState: null,
      accessState: { canAccess: true }, destinationRoute: "/place/x", createdAt: null, startsAt: null,
      metadata: { lat, lng, coordsPrecision: precision, livingPageId: "canon-da-nang" },
    } as unknown as SearchResult);
    const out = await resolveVenueBindings(sc, [touched("approximate", 16.06, 108.21), touched("hidden", null, null)]);
    for (const id of ["v-approximate", "v-hidden"]) {
      const b = out.get(id);
      assert.ok(b, id);
      assert.equal(b.lat, null, `${id}: a coarsened anchor is not the venue's position`);
      assert.equal(b.lng, null, id);
      assert.equal(b.timezone, null, `${id}: no position, no derived zone`);
      assert.equal(b.city, "Da Nang", id);
      assert.equal(b.country, "Vietnam", id);
    }
    // CONTROL: an untouched position still binds exactly.
    const plain = await resolveVenueBindings(sc, [{ ...touched("x", 16.0678, 108.2233), id: "v-exact", metadata: { lat: 16.0678, lng: 108.2233, livingPageId: "canon-da-nang" } } as SearchResult]);
    assert.equal(plain.get("v-exact")?.lat, 16.0678);
    assert.equal(plain.get("v-exact")?.timezone, timezoneForCoords(16.0678, 108.2233));
  });
});

// ── G176: the APP's own wire body, end to end ─────────────────────────────────

const LANTERN_NEAR = place({ id: "p-near", name: "Lantern Cafe", city: "Hoi An", category: "cafe", primary_category: "cafe", lat: 15.8801, lng: 108.3380 });
const LANTERN_FAR = place({ id: "p-far", name: "Lantern Bar", city: "Hanoi", lat: 21.0285, lng: 105.8542 });

/** What GlobalPlacePicker hands the hook after silent nearby detection: the device fix, at device precision. */
const DEVICE_FIX = { lat: 15.870012345, lng: 108.338049876 };

describe("§28 G176 — the app's own body yields the band and the nearby order", () => {
  it("the wire carries a coarse top-level pair, and none inside the session", () => {
    const wire = buildSuggestBody({ context: "place_picker", fieldId: "place_picker", text: "lantern", limit: 8, sessionContext: { surface: "event_create", ...DEVICE_FIX } });
    assert.equal(wire.lat, 15.87);
    assert.equal(wire.lng, 108.338);
    assert.deepEqual(wire.sessionContext, { surface: "event_create" });
    assert.ok(!JSON.stringify(wire).includes("15.870012") && !JSON.stringify(wire).includes("108.33804"), "the device fix never leaves the device");
  });

  it("place_picker: a nearby place carries its coarse band", async () => {
    setup(world({ discovery_places: [LANTERN_NEAR] }));
    const rows = await post(buildSuggestBody({ context: "place_picker", fieldId: "place_picker", text: "lantern", limit: 8, sessionContext: { surface: "event_create", ...DEVICE_FIX } }));
    const near = rows.find((s) => s.entityId === "p-near");
    assert.ok(near, "the place is served");
    assert.equal(near.distanceBand, "1-3km");
  });

  it("global_search (the search screen's session): band on the near place, and the near place ranks first", async () => {
    setup(world({ discovery_places: [LANTERN_FAR, LANTERN_NEAR] }));
    const body = buildSuggestBody({ context: "global_search", fieldId: "discovery.search", text: "lantern", limit: 8, sessionContext: { surface: "search", lat: 15.8790, lng: 108.3350 } });
    const rows = (await post(body)).filter((s) => s.type === "entity" && s.entityType === "place"); // the "Open on map" action row also names the place
    assert.deepEqual(rows.map((s) => s.entityId), ["p-near", "p-far"], "nearby ordering fires for a real client");
    assert.equal(rows[0].distanceBand, "<0.5km");
    assert.equal(rows[1].distanceBand, "50km+");
    // CONTROL: the same request with no position keeps the stored order and bands nothing.
    const plain = (await post(buildSuggestBody({ context: "global_search", fieldId: "discovery.search", text: "lantern", limit: 8, sessionContext: { surface: "search" } })))
      .filter((s) => s.type === "entity" && s.entityType === "place");
    assert.deepEqual(plain.map((s) => s.entityId), ["p-far", "p-near"], "premise: without a position the far place is first");
    assert.ok(plain.every((s) => s.distanceBand === undefined));
  });

  it("invalid positions never reach the wire, so nothing is banded", async () => {
    setup(world({ discovery_places: [LANTERN_NEAR] }));
    const bad: Array<Record<string, unknown>> = [
      { lat: 91, lng: 108.338 }, { lat: 15.87, lng: -181 }, { lat: Number.NaN, lng: 108.338 },
      { lat: Number.POSITIVE_INFINITY, lng: 108.338 }, { lat: 15.87 }, { lng: 108.338 }, { lat: "15.87", lng: "108.338" },
    ];
    for (const coords of bad) {
      const wire = buildSuggestBody({ context: "place_picker", fieldId: "place_picker", text: "lantern", limit: 8, sessionContext: { surface: "event_create", ...(coords as any) } });
      assert.equal("lat" in wire, false, JSON.stringify(coords));
      assert.equal("lng" in wire, false, JSON.stringify(coords));
      assert.deepEqual(wire.sessionContext, { surface: "event_create" }, `${JSON.stringify(coords)}: stripped, not forwarded`);
      const near = (await post(wire)).find((s) => s.entityId === "p-near");
      assert.ok(near, "premise: the place is served");
      assert.equal(near.distanceBand, undefined, JSON.stringify(coords));
    }
  });

  it("the server reads ONE transport: an out-of-range top-level pair is ignored, and a position inside sessionContext is not a second origin", async () => {
    setup(world({ discovery_places: [LANTERN_NEAR] }));
    const outOfRange = (await post({ context: "place_picker", text: "lantern", lat: 95, lng: 108.338 })).find((s) => s.entityId === "p-near");
    assert.equal(outOfRange?.distanceBand, undefined);
    const inSession = (await post({ context: "place_picker", text: "lantern", sessionContext: { lat: 15.87, lng: 108.338 } })).find((s) => s.entityId === "p-near");
    assert.ok(inSession, "premise: the place is served");
    assert.equal(inSession.distanceBand, undefined);
  });
});
