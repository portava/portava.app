/**
 * §24 Paste Intelligence — POST /api/input-assistance/extract (GII-F08, WP-19).
 *
 * Run: node --import tsx/esm --test src/test/inputAssistancePasteExtraction.test.ts
 *
 * What this proves, through the REAL route, the REAL gateway and the REAL
 * canonical resolver. Only the network is faked: the Supabase client (the
 * database's wire) and `fetch` to the reverse geocoder.
 *
 *   G154  pasted input is classified and each extracted item is resolved by the
 *         SAME gateway typed text goes through (`generateSuggestionsWithCoverage`)
 *         — "hcmc" resolves by the alias table, "danang" by the stroke fold.
 *   G155  place names / addresses (a comma is NOT a list separator).
 *   G156  map links from the configured parsers (Google, Apple, OSM, geo:), and a
 *         shortened link is REPORTED as unsupported rather than silently dropped.
 *   G157  coordinates, decimal and DMS.
 *   G161  lists of stops: newline, bullets, arrows, "then"; itinerary day labels
 *         and time hints are carried, not treated as places.
 *   G162  the endpoint MUTATES NOTHING: every write verb on the fake client is
 *         recorded and the suite asserts none was called. The review screen is
 *         the only way anything gets persisted.
 *   Failure honesty: an unreadable canonical registry is an item that FAILED,
 *   never an item with "no match".
 *   PR-D2-7c (lead, 2026-10-08): no paste path reaches a third-party provider
 *   (a coordinate is named from the canonical registry, never a geocoder); only
 *   a line that resolved to a place is echoed back; an unmatched line is dropped
 *   silently and never logged; the booking and label sets are localised for the
 *   launch languages (en, vi, ja, th, de, es).
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import inputAssistanceRouter from "../routes/inputAssistance.js";
import { searchKey, normalizeLocationName } from "../lib/canonicalLocations.js";
import {
  classifyPaste, classifyTravelBooking, dropBeforeLookup, safeLabelValue,
  parseCoordinates,
  parseMapLink,
  sanitizePastedText,
  displaySafeUrl,
  redactUrlsForDisplay,
  PASTE_MAX_ITEMS,
} from "../lib/inputAssistance/pasteExtraction.js";

const ME = "aa000000-0000-4000-a000-000000000001";
const ME_TOK = "tok-me";

// ── Fake Supabase client: reads from fixtures, RECORDS every write ─────────────
interface FakeState { [key: string]: any[] | undefined }
const writes: string[] = [];

function makeFakeClient(state: FakeState, tableErrors: Set<string> = new Set()) {
  const errorBuilder: any = {};
  for (const fn of ["select","eq","neq","in","not","is","ilike","or","gte","lte","lt","order","limit","range","maybeSingle"]) {
    errorBuilder[fn] = () => errorBuilder;
  }
  errorBuilder.then = (onF: any, onR: any) =>
    Promise.resolve({ data: null, error: { message: "simulated DB error" } }).then(onF, onR);

  return {
    auth: {
      getUser: async (tok: string) =>
        tok === ME_TOK
          ? { data: { user: { id: ME } }, error: null }
          : { data: { user: null }, error: { message: "bad token" } },
    },
    rpc: (name: string) => { writes.push(`rpc:${name}`); return Promise.resolve({ data: null, error: null }); },
    from: (table: string) => {
      if (tableErrors.has(table)) return errorBuilder;
      const rows: any[] = [...(state[table] ?? [])];
      const filters: Array<(r: any) => boolean> = [];
      let limitN = Infinity;
      const write = (verb: string) => () => { writes.push(`${verb}:${table}`); return builder; };
      const builder: any = {
        select() { return builder; },
        insert: write("insert"), update: write("update"), upsert: write("upsert"), delete: write("delete"),
        eq(c: string, v: any) { filters.push((r) => r[c] === v); return builder; },
        neq(c: string, v: any) { filters.push((r) => r[c] !== v); return builder; },
        in(c: string, vs: any[]) { filters.push((r) => vs.includes(r[c])); return builder; },
        not() { return builder; },
        is(c: string, v: any) { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return builder; },
        ilike(c: string, pat: string) {
          const re = new RegExp("^" + pat.replace(/\\([%_])/g, "$1").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$", "i");
          filters.push((r) => re.test(String(r[c] ?? "")));
          return builder;
        },
        or() { return builder; },
        // PR-D2-7c: the registry's nearest-city box reads lat/lng ranges; a row without the column is not filtered.
        gte(c: string, v: any) { filters.push((r) => r[c] == null || r[c] >= v); return builder; },
        lte(c: string, v: any) { filters.push((r) => r[c] == null || r[c] <= v); return builder; },
        lt() { return builder; },
        order() { return builder; },
        range() { return builder; },
        limit(n: number) { limitN = n; return builder; },
        maybeSingle() {
          return Promise.resolve({ data: rows.filter((r) => filters.every((f) => f(r)))[0] ?? null, error: null });
        },
        then(onF: any, onR: any) {
          const out = rows.filter((r) => filters.every((f) => f(r))).slice(0, limitN);
          return Promise.resolve({ data: out, error: null }).then(onF, onR);
        },
      };
      return builder;
    },
  };
}

function canonCity(name: string, country: string, cc: string, lat: number, lng: number) {
  const key = searchKey(name);
  return {
    id: `canon-${key.replace(/\s+/g, "-")}`,
    kind: "city", name, normalized_name: normalizeLocationName(name), search_key: key,
    display_name: `${name}, ${country}`, city: null, region: null, country, country_code: cc,
    postal_code: null, lat, lng, provider_ids: {}, aliases: [],
  };
}

const DA_NANG = canonCity("Đà Nẵng", "Vietnam", "VN", 16.0678, 108.2208);
const HCMC = canonCity("Ho Chi Minh City", "Vietnam", "VN", 10.8231, 106.6297);
const HOI_AN = canonCity("Hoi An", "Vietnam", "VN", 15.8801, 108.338);
const STATE: FakeState = {
  canonical_locations: [DA_NANG, HCMC, HOI_AN],
  profiles: [{ id: ME, account_status: "active" }],
  blocks: [], user_privacy_settings: [], profile_privacy_settings: [],
  trip_members: [], trips: [], input_selection_history: [], saved_places: [],
};

// ── fetch: the local server passes through; EVERY other request is a provider ──
// call, counted. Since PR-D2-7c the paste path makes none (no geocoder at all);
// `geocoder` answers whatever is asked so a regression is COUNTED, not hung.
const realFetch = globalThis.fetch;
let geocoder: (url: string) => Promise<Response> = async () => new Response("{}", { status: 500 });
const geocodeCalls: string[] = [];

let base: string;
let server: Server;

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
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("http://127.0.0.1")) return realFetch(input, init);
    geocodeCalls.push(url);
    return geocoder(url);
  }) as typeof fetch;
});
after(() => { globalThis.fetch = realFetch; server.close(); });
beforeEach(() => {
  _resetRateLimit();
  writes.length = 0;
  geocodeCalls.length = 0;
  delete process.env.MAPBOX_TOKEN;
  _setTestClient(makeFakeClient(STATE) as any, true);
});
afterEach(() => { assert.deepEqual(writes, [], "the extract endpoint must never write (G162)"); });

function extract(body: unknown, tok: string | null = ME_TOK) {
  return realFetch(`${base}/input-assistance/extract`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    body: JSON.stringify(body),
  });
}

function nominatim(address: Record<string, string>, display = "") {
  return async () => new Response(JSON.stringify({ address, display_name: display }), { status: 200 });
}

// ═══ 1. Classification (pure) ═══════════════════════════════════════════════
describe("classifyPaste — the shapes §24 names", () => {
  it("decimal and DMS coordinates (G157)", () => {
    assert.deepEqual(parseCoordinates("16.0544, 108.2022"), { lat: 16.0544, lng: 108.2022 });
    assert.deepEqual(parseCoordinates("(-33.8568 151.2153)"), { lat: -33.8568, lng: 151.2153 });
    const dms = parseCoordinates(`16°03'15.8"N 108°12'07.9"E`);
    assert.ok(dms && Math.abs(dms.lat - 16.05439) < 1e-4 && Math.abs(dms.lng - 108.20219) < 1e-4);
    const hemi = parseCoordinates("33.8568° S, 151.2153° E");
    assert.ok(hemi && hemi.lat < 0 && hemi.lng > 0);
    assert.equal(parseCoordinates("95.1234, 10.1234"), null, "latitude out of range is not a coordinate");
    assert.equal(parseCoordinates("12, 7"), null, "bare integers are not coordinates");
    const c = classifyPaste("16.0544, 108.2022");
    assert.equal(c.shape, "coordinates");
    assert.equal(c.items[0]!.source, "coordinates");
  });

  it("map links from the configured parsers, and short links refused by name (G156)", () => {
    const place = parseMapLink("https://www.google.com/maps/place/Dragon+Bridge/@16.0612,108.2272,17z/data=!3m1");
    assert.equal(place?.provider, "google");
    assert.deepEqual(place?.stops, [{ query: "Dragon Bridge", lat: 16.0612, lng: 108.2272 }]);
    const dir = parseMapLink("https://www.google.com/maps/dir/Da+Nang/Hoi+An/@15.9,108.2,11z");
    assert.deepEqual(dir?.stops.map((s) => s.query), ["Da Nang", "Hoi An"]);
    assert.deepEqual(parseMapLink("https://maps.google.com/?q=16.0544,108.2022")?.stops, [{ query: null, lat: 16.0544, lng: 108.2022 }]);
    assert.deepEqual(parseMapLink("https://maps.apple.com/?ll=16.05,108.2&q=Han%20Market")?.stops, [{ query: "Han Market", lat: 16.05, lng: 108.2 }]);
    assert.deepEqual(parseMapLink("https://www.openstreetmap.org/?mlat=16.05&mlon=108.2#map=15/16.05/108.2")?.stops, [{ query: null, lat: 16.05, lng: 108.2 }]);
    assert.deepEqual(parseMapLink("geo:16.05,108.2?q=My+Khe")?.stops, [{ query: "My Khe", lat: 16.05, lng: 108.2 }]);
    assert.equal(parseMapLink("https://maps.app.goo.gl/AbCdEf123")?.unsupported, "short_link");
    assert.equal(parseMapLink("https://example.com/itinerary")?.unsupported, "unsupported_link");
    assert.equal(parseMapLink("javascript:alert(1)"), null, "a script URL is not a map link");
  });

  it("an itinerary block keeps day labels and time hints OUT of the place query (G161)", () => {
    const c = classifyPaste("Friday:\nDinner at 7\nRooftop at 9\nClub around 11");
    assert.equal(c.shape, "itinerary");
    assert.deepEqual(c.items.map((i) => [i.query, i.timeHint, i.dayLabel]), [
      ["Dinner", "7", "Friday"],
      ["Rooftop", "9", "Friday"],
      ["Club", "11", "Friday"],
    ]);
  });

  it("lists: bullets, numbering, arrows and 'then' split; a comma does NOT (G155/G161)", () => {
    assert.deepEqual(classifyPaste("- Da Nang\n• Hoi An\n3) Hue").items.map((i) => i.query), ["Da Nang", "Hoi An", "Hue"]);
    assert.deepEqual(classifyPaste("Da Nang → Hoi An -> Hue").items.map((i) => i.query), ["Da Nang", "Hoi An", "Hue"]);
    assert.deepEqual(classifyPaste("Da Nang then Hoi An").items.map((i) => i.query), ["Da Nang", "Hoi An"]);
    const addr = classifyPaste("2 Bach Dang, Hai Chau, Da Nang");
    assert.equal(addr.shape, "single");
    assert.equal(addr.items.length, 1, "an address is one place, not three");
  });

  it("sanitizes pasted text before anything renders it, and bounds it", () => {
    const s = sanitizePastedText("Da\u202E Nang\u200B\u0007");
    assert.equal(s, "Da Nang ");
    const many = Array.from({ length: PASTE_MAX_ITEMS + 5 }, (_, i) => `Stop ${i}`).join("\n");
    const c = classifyPaste(many);
    assert.equal(c.items.length, PASTE_MAX_ITEMS);
    assert.equal(c.truncated, true);
  });
});

// ═══ 2. The route, through the real gateway ══════════════════════════════════
describe("§47 sanitize pasted URLs before rendering (G337) — what `raw` may echo back", () => {
  it("shows ONLY the host — userinfo, path, query, fragment and port never survive", () => {
    // RESTATED 2026-10-05 (verifier finding 2): the path was kept, and paths
    // carry tokens too (/reset-password/<token>, ;jsessionid=…). The host is
    // what lets a person recognise the link; everything after it is "…".
    assert.equal(
      displaySafeUrl("https://alice:hunter2@maps.example.com/place/Dragon-Bridge?token=s3cr3t&utm_source=mail#frag"),
      "https://maps.example.com…",
    );
    assert.equal(displaySafeUrl("https://maps.app.goo.gl/AbCdEf123"), "https://maps.app.goo.gl…", "a short-link code is a token");
    assert.equal(displaySafeUrl("http://example.com:8080/x"), "http://example.com…");
    assert.equal(displaySafeUrl("https://example.com"), "https://example.com", "nothing after the host, nothing hidden");
    assert.equal(displaySafeUrl("Hội An"), "…", "displaySafeUrl is only ever handed URL-like tokens");
  });

  it("an unparseable http string still never echoes a userinfo segment", () => {
    assert.ok(!displaySafeUrl("https://bob:pw@exa mple.com").includes("pw"));
  });

  it("a URL inside a text line is redacted in place, the words around it kept", () => {
    assert.equal(
      redactUrlsForDisplay("Dinner here https://booking.example.com/r/123?session=abc then bar"),
      "Dinner here https://booking.example.com… then bar",
    );
    assert.equal(redactUrlsForDisplay("Hội An, Vietnam"), "Hội An, Vietnam", "a line with no URL is untouched");
  });

  it("classifyPaste: an UNREADABLE link shows its display form, never its token", () => {
    const c = classifyPaste("https://user:pw@example.com/itinerary?share_token=XYZ");
    const item = c.items[0]!;
    assert.equal(item.unsupported, "unsupported_link", "still reported, not dropped");
    assert.equal(item.raw, "https://example.com…");
    assert.ok(!/pw|XYZ|itinerary/.test(item.raw));
  });

  // ── The verifiers' inputs (41f17e7b7d #2, 62f960a7c #1–2), each through
  //    classifyPaste — the /extract route's own path — and the route below. ──
  const SECRET_INPUTS: Array<[string, string, RegExp]> = [
    ["a SCHEME-LESS url (www.)", "www.booking.com/hotel?sid=SESSIONSECRET", /SESSIONSECRET|sid=|hotel/],
    ["an UNPARSEABLE https url inside a text line", "Dinner https://exa%zzmple.com/?token=SECRET 7pm", /SECRET|token|%zz/],
    ["a PASSWORD containing '/'", "https://user:pa/ss@host.com/x?token=SECRET", /SECRET|pa\/ss|user:|token/],
    ["tokens in the PATH", "https://example.com/reset-password/TOKENinPATH;jsessionid=JSESSIONSECRET", /TOKENinPATH|JSESSIONSECRET|reset-password/],
    // Re-verification of 62f960a7c (finding 1): the scheme-less class was open
    // for a userinfo, a port and an IPv4 host — each echoed in `raw`, carried
    // in the query and repeated in "No place matched “…”".
    ["a SCHEME-LESS url with USERINFO", "user:pass9@host.com/path?token=SECRET9", /SECRET9|pass9|user:|token|\/path/],
    ["a SCHEME-LESS url with a PORT", "host.com:8443/reset?token=SECRET10", /SECRET10|:8443|reset|token/],
    ["a SCHEME-LESS url on an IPv4 host", "192.168.1.1/reset?token=SECRET11", /SECRET11|reset|token/],
    ["USERINFO inside a text line", "Hoi An then user:pw12@booking.com/r?sid=SECRET12 at 8pm", /SECRET12|pw12|user:|sid=/],
    ["a SCHEME-LESS password containing '/'", "user:pa/ss@host.com/x?token=SECRET17", /SECRET17|pa\/|user:|token/],
    // (finding 2) a bare domain WITHOUT www. inside a text line — the only
    // proof that the bare-domain alternative is load-bearing.
    ["a bare domain without www. inside a text line", "Dinner booking.com/r?sid=SECRET16 then bar", /SECRET16|sid=|\/r\?/],
  ];
  for (const [label, input, secret] of SECRET_INPUTS) {
    it(`classifyPaste: ${label} leaks nothing into raw or the query`, () => {
      const c = classifyPaste(input);
      for (const item of c.items) {
        assert.ok(!secret.test(item.raw), `raw leaked: ${item.raw}`);
        assert.ok(!secret.test(item.query ?? ""), `query leaked: ${item.query}`);
      }
    });
  }

  it("an UNPARSEABLE URL-only line is reported as a link it cannot read — not dropped into 'nothing was pasted'", () => {
    const c = classifyPaste("https://user:pa/ss@host.com/x?token=SECRET");
    assert.equal(c.shape === "empty", false);
    assert.equal(c.items[0]!.unsupported, "unsupported_link");
    assert.equal(c.items[0]!.raw, "https://host.com…");
  });

  it("a scheme-less URL-only line is REPORTED as a link it cannot read, not silently dropped", () => {
    const c = classifyPaste("www.booking.com/hotel?sid=SESSIONSECRET");
    assert.equal(c.items.length, 1);
    assert.equal(c.items[0]!.source, "map_link");
    assert.equal(c.items[0]!.unsupported, "unsupported_link");
    assert.equal(c.items[0]!.raw, "www.booking.com…");
  });

  it("the words around an unparseable URL still resolve, and its time is still the time", () => {
    const c = classifyPaste("Dinner https://exa%zzmple.com/?token=SECRET 7pm");
    const item = c.items[0]!;
    assert.equal(item.query, "Dinner");
    assert.equal(item.timeHint, "7pm");
  });

  it("classifyPaste: a READABLE link still resolves from the FULL url — only the display is trimmed", () => {
    const c = classifyPaste("https://www.google.com/maps/search/?api=1&query=Dragon+Bridge&g_ep=tracking123");
    const item = c.items[0]!;
    assert.equal(item.query, "Dragon Bridge", "parsing read the query string");
    assert.ok(!item.raw.includes("tracking123"), "the display form does not repeat it");
  });

  it("through the route: none of the verifiers' inputs reaches the response in any field", async () => {
    for (const [label, input, secret] of SECRET_INPUTS) {
      _resetRateLimit();
      const r = await extract({ context: "trip_destination", fieldId: "trip.destination", text: input });
      assert.equal(r.status, 200, label);
      const text = JSON.stringify(await r.json());
      assert.ok(!secret.test(text), `${label}: ${text}`);
    }
  });

  it("through the route: the response a review screen renders carries no credential or token", async () => {
    const r = await extract({
      context: "trip_destination",
      fieldId: "trip.destination",
      text: "https://alice:hunter2@maps.app.goo.gl/AbC?token=s3cr3t\nDa Nang https://t.co/x?ref=y",
    });
    assert.equal(r.status, 200);
    const text = JSON.stringify(await r.json());
    assert.ok(!/hunter2|s3cr3t|ref=y/.test(text), text);
  });

  it("a scheme-less userinfo, port or IPv4 URL-only line is REPORTED as a link it cannot read, host only", () => {
    const cases: Array<[string, string]> = [
      ["user:pass9@host.com/path?token=SECRET9", "host.com…"],
      ["host.com:8443/reset?token=SECRET10", "host.com…"],
      ["192.168.1.1/reset?token=SECRET11", "192.168.1.1…"],
    ];
    for (const [input, raw] of cases) {
      const c = classifyPaste(input);
      assert.equal(c.items.length, 1, input);
      assert.equal(c.items[0]!.source, "map_link", input);
      assert.equal(c.items[0]!.unsupported, "unsupported_link", input);
      assert.equal(c.items[0]!.query, null, input);
      assert.equal(c.items[0]!.raw, raw, input);
    }
  });

  // ── What the scheme-less recogniser must NOT swallow: a time, a ratio, a
  //    terminal, a price (both thousands separators), an e-mail address. ──────
  // (The e-mail line is no longer read as an item at all — lead ruling
  // PR-D2-7b drops it before any lookup; its "not a URL" half is pinned below.)
  const NOT_URLS = ["Dinner 19:30", "Hoi An 3:1", "Terminal 2/3", "1,500/night Da Nang", "2.500.000/night Da Nang", "1.500.000.000/night Da Nang"];
  for (const input of NOT_URLS) {
    it(`not a URL: ${JSON.stringify(input)} is left as text, unredacted`, () => {
      assert.equal(redactUrlsForDisplay(input), input);
      const c = classifyPaste(input);
      assert.ok(c.items.length > 0, input);
      for (const item of c.items) {
        assert.equal(item.source, "text", `${input} became ${item.source}`);
        assert.ok(!item.raw.includes("…"), `${input} was redacted: ${item.raw}`);
      }
    });
  }

  it("an e-mail address is not a URL (never redacted as one), and since PR-D2-7b its line is dropped before any lookup", () => {
    const input = "Email anna@gmail.com about Hoi An";
    assert.equal(redactUrlsForDisplay(input), input, "the URL recogniser does not swallow it");
    const c = classifyPaste(input);
    assert.equal(c.items.length, 0);
    assert.ok(!JSON.stringify(c).includes("anna@gmail.com"));
  });

  it("mailto:, data: and javascript: stay PLAIN TEXT — never a link item — and a mailto's query is still never rendered", () => {
    for (const input of ["mailto:alice@example.com?subject=hi&body=SECRET2", "data:text/plain;base64,U0VDUkVUMw==", 'javascript:alert("x")']) {
      const c = classifyPaste(input);
      assert.ok(c.items.length > 0, input);
      for (const item of c.items) assert.equal(item.source, "text", `${input} became ${item.source}`);
    }
    const mail = classifyPaste("mailto:alice@example.com?subject=hi&body=SECRET2").items[0]!;
    assert.ok(!/SECRET2|subject|body=/.test(`${mail.raw} ${mail.query ?? ""}`), JSON.stringify(mail));
  });
});

describe("POST /input-assistance/extract — resolution through the shared gateway (G154)", () => {
  it("a pasted list resolves each stop to its CANONICAL city; the unmatched line is DROPPED (PR-D2-7c)", async () => {
    const r = await extract({ context: "trip_destination", fieldId: "trip.destination", text: "danang\nhcmc\nAtlantis" });
    assert.equal(r.status, 200);
    const body = (await r.json()) as any;
    assert.equal(body.mutated, false);
    assert.equal(body.shape, "list");
    const [a, b] = body.items;
    assert.equal(a.status, "resolved");
    assert.equal(a.candidates[0].entityId, DA_NANG.id, "the stroke fold resolved 'danang'");
    assert.equal(a.candidates[0].structuredValue.city, "Đà Nẵng");
    assert.equal(b.status, "resolved");
    assert.equal(b.candidates[0].entityId, HCMC.id, "the alias table resolved 'hcmc'");
    // PR-D2-7c changed this assertion (it was `no_match` with the line echoed):
    // the third line resolved to nothing, so it is not in the answer at all.
    assert.equal(body.items.length, 2);
    assert.ok(!JSON.stringify(body).includes("Atlantis"), "an unmatched line is never echoed");
  });

  it("an UNREADABLE registry is a FAILED item, never 'no match'", async () => {
    _setTestClient(makeFakeClient(STATE, new Set(["canonical_locations"])) as any, true);
    const r = await extract({ context: "trip_destination", text: "Atlantis\nDa Nang" });
    assert.equal(r.status, 200);
    const [atlantis, daNang] = ((await r.json()) as any).items;
    // No other source could answer "Atlantis" and the cities source was down:
    // that is a FAILURE. With the registry readable the same line is "no_match"
    // (first test) — the two are never merged.
    assert.equal(atlantis.status, "failed", `expected failed, got ${JSON.stringify(atlantis)}`);
    assert.ok(atlantis.reason, "a failure carries a reason");
    // PR-D2-7c: a failed line keeps its slot but not its text — fixed copy only.
    assert.equal(atlantis.query, null);
    assert.equal(atlantis.raw, "Pasted line");
    // The countries source still answered "Da Nang" (Vietnam) — so the answer
    // is marked PARTIAL: the review screen says the city lookup was down and
    // does not pre-tick it. It is never presented as a complete answer.
    assert.equal(daNang.status, "resolved");
    assert.equal(daNang.partial, true);
    assert.ok(!daNang.candidates.some((c: any) => c.entityId === DA_NANG.id));
  });

  // PR-D2-7c changed the next three (they named a point through the reverse
  // geocoder — Nominatim, a third party): a point is now named by the NEAREST
  // catalog city in Portava's own registry, and no request leaves the server.
  it("coordinates are named from Portava's OWN registry (nearest catalog city), then resolved like typed text — no geocoder (G157, PR-D2-7c)", async () => {
    geocoder = nominatim({ city: "Somewhere Else", country: "Elsewhere", country_code: "zz" });
    const r = await extract({ context: "trip_destination", text: "16.0544, 108.2022" });
    const body = (await r.json()) as any;
    assert.equal(body.shape, "coordinates");
    const [item] = body.items;
    assert.equal(item.status, "resolved");
    assert.equal(item.lat, 16.0544);
    assert.equal(item.candidates[0].entityId, DA_NANG.id, "Da Nang's centre is 2 km away; Hoi An is 25 km");
    assert.equal(geocodeCalls.length, 0, "no provider was asked");
  });

  it("an UNREADABLE registry for a point is a failed item with fixed copy, not 'nothing here'", async () => {
    _setTestClient(makeFakeClient(STATE, new Set(["canonical_locations"])) as any, true);
    const r = await extract({ context: "trip_destination", text: "16.0544, 108.2022" });
    const [item] = ((await r.json()) as any).items;
    assert.equal(item.status, "failed");
    assert.equal(item.raw, "Pasted coordinates");
    assert.equal(item.lat, null, "the pasted point is not echoed");
    assert.equal(geocodeCalls.length, 0);
  });

  it("a point with no catalog city within 40 km is dropped silently", async () => {
    const r = await extract({ context: "trip_destination", text: "0.0100, -140.0100" });
    assert.equal(r.status, 200);
    assert.deepEqual(((await r.json()) as any).items, []);
    assert.equal(geocodeCalls.length, 0);
  });

  it("a map link's place name resolves; a short link is reported unsupported (G156)", async () => {
    const r = await extract({
      context: "trip_destination",
      text: "https://www.google.com/maps/dir/Da+Nang/Hoi+An/@15.9,108.2,11z\nhttps://maps.app.goo.gl/AbCdEf123",
    });
    const body = (await r.json()) as any;
    assert.deepEqual(body.items.map((i: any) => i.status), ["resolved", "resolved", "unsupported"]);
    assert.equal(body.items[1].candidates[0].entityId, HOI_AN.id);
    assert.match(body.items[2].reason, /short/i);
    assert.equal(geocodeCalls.length, 0, "a named stop needs no geocoder");
  });

  it("refuses fields where bulk extraction has no meaning, and unauthenticated callers", async () => {
    assert.equal((await extract({ context: "username", text: "Da Nang" })).status, 400);
    assert.equal((await extract({ context: "not_a_context", text: "Da Nang" })).status, 400);
    assert.equal((await extract({ context: "trip_destination", text: "   " })).status, 400);
    assert.equal((await extract({ context: "trip_destination", text: "Da Nang" }, null)).status, 401);
  });

  it("an over-long paste is bounded and SAYS it was truncated", async () => {
    const text = Array.from({ length: PASTE_MAX_ITEMS + 3 }, () => "Hoi An").join("\n");
    const body = (await (await extract({ context: "trip_destination", text })).json()) as any;
    assert.equal(body.items.length, PASTE_MAX_ITEMS);
    assert.equal(body.truncated, true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// §24 flight / hotel text (census G159; lead ruling PR-D2-7)
//
// MUTATION LOG (each applied, watched go red, reverted, `git diff` clean):
//   H1 classifyPaste: drop the classifyTravelBooking short-circuit → "a hotel
//      confirmation yields EXACTLY ONE item" red (every line becomes an item).
//   H2 classifyTravelBooking: put the whole LINE in `raw` instead of the value →
//      "never echoed" red (the label survives; with the guest line variant, red too).
//   H3 classifyTravelBooking: drop the flight branch → "flight text yields ONE
//      unsupported item" red.
//   H4 classifyTravelBooking: one signal is enough → "a single line naming a hotel
//      is a place, not a booking" red.
//   H5 classifyTravelBooking: no name/address → guess the first line → "fail closed" red.
// ═══════════════════════════════════════════════════════════════════════════════

const GUEST = "Nguyen Van Secretname";
const CONF = "8823991744";
const CARD = "4111 1111 1111 4242";
const HOTEL_PASTE = [
  "Booking confirmation",
  `Confirmation number: ${CONF}`,
  `Guest name: ${GUEST}`,
  "Hotel: Sala Danang Beach Hotel",
  "Address: 36-38 Lam Hoanh, Da Nang",
  "Check-in: Fri 10 Oct 2026",
  "Check-out: Sun 12 Oct 2026",
  `Paid with card ending ${CARD.slice(-4)} (${CARD})`,
].join("\n");
const FLIGHT_PASTE = [
  "Your e-ticket",
  `Passenger: ${GUEST}`,
  "Booking reference: QX7Z2P",
  "Flight VN 123  SGN → DAD",
  "Departure 07:45  Gate 12",
].join("\n");

function leaks(v: unknown): string[] {
  const s = JSON.stringify(v);
  return [GUEST, CONF, CARD, CARD.slice(-4), "QX7Z2P", "VN 123", "Lam Hoanh"].filter((x) => s.includes(x));
}

describe("§24 flight / hotel text (G159, lead ruling PR-D2-7)", () => {
  it("a hotel confirmation yields EXACTLY ONE item — the property name — and no other line is ever echoed", () => {
    const c = classifyPaste(HOTEL_PASTE);
    assert.equal(c.shape, "single", "an existing shape value");
    assert.equal(c.items.length, 1);
    assert.equal(c.items[0]!.query, "Sala Danang Beach Hotel");
    assert.equal(c.items[0]!.raw, "Sala Danang Beach Hotel", "the value only, not its line");
    assert.deepEqual(leaks(c), [], "guest, confirmation number, card digits and the address are dropped");
  });

  it("with no property name, the LABELLED ADDRESS is the one item", () => {
    const c = classifyPaste(HOTEL_PASTE.split("\n").filter((l) => !l.startsWith("Hotel:")).join("\n"));
    assert.equal(c.items.length, 1);
    // PR-D2-7b (b): the labelled value stops at its first secondary separator.
    assert.equal(c.items[0]!.query, "36-38 Lam Hoanh");
    assert.ok(!JSON.stringify(c).includes(GUEST) && !JSON.stringify(c).includes(CONF));
  });

  it("fail closed: a booking with neither a name nor an address is one unsupported item, never a guess", () => {
    const c = classifyPaste([`Reservation number: ${CONF}`, `Guest name: ${GUEST}`, "Check-in: Fri", "Check-out: Sun"].join("\n"));
    assert.equal(c.items.length, 1);
    assert.equal(c.items[0]!.query, null);
    assert.equal(c.items[0]!.unsupported, "booking_text");
    assert.equal(c.items[0]!.raw, "Hotel booking", "fixed copy");
    assert.deepEqual(leaks(c), []);
  });

  it("flight text yields ONE unsupported item with fixed copy and no query", () => {
    const c = classifyPaste(FLIGHT_PASTE);
    assert.equal(c.shape, "single");
    assert.equal(c.items.length, 1);
    assert.equal(c.items[0]!.query, null);
    assert.equal(c.items[0]!.unsupported, "flight_text");
    assert.equal(c.items[0]!.raw, "Flight details");
    assert.deepEqual(leaks(c), []);
  });

  it("a single line naming a hotel is a place, not a booking; an ordinary list is unchanged", () => {
    assert.equal(classifyTravelBooking(["Hotel Majestic Saigon"]), null);
    const c = classifyPaste("Hotel Majestic Saigon\nBen Thanh Market");
    assert.equal(c.shape, "list");
    assert.deepEqual(c.items.map((i) => i.query), ["Hotel Majestic Saigon", "Ben Thanh Market"]);
    // PR-D2-7b (c): ONE booking keyword ("Check-in") now makes a paste a booking,
    // read only for a property or address — here none, so one unsupported item.
    assert.equal(classifyTravelBooking(["Friday:", "Check-in at 3", "Dinner at 7"])?.unsupported, "booking_text");
  });

  it("through the route: only the property name is looked up; nothing else reaches the gateway, the geocoder or the response", async () => {
    // Record every value any read is filtered by, so "nothing else was looked up" is measured.
    const asked: string[] = [];
    const inner = makeFakeClient(STATE) as any;
    _setTestClient({
      ...inner,
      from: (table: string) => {
        const b = inner.from(table);
        const wrap = (name: string) => {
          const orig = b[name];
          if (typeof orig !== "function") return;
          b[name] = (...args: unknown[]) => { asked.push(args.map((x) => JSON.stringify(x)).join(" ")); return orig.apply(b, args); };
        };
        for (const m of ["eq", "ilike", "or", "in", "textSearch"]) wrap(m);
        return b;
      },
    } as any, true);
    const r = await extract({ context: "trip_destination", fieldId: "trip.destination", text: HOTEL_PASTE });
    assert.equal(r.status, 200);
    const body = (await r.json()) as any;
    // PR-D2-7c changed this (it was one echoed item): the property name was looked
    // up, matched nothing in a CITY field, and so is not in the answer at all.
    assert.equal(body.items.length, 0);
    assert.deepEqual(leaks(body), []);
    assert.equal(geocodeCalls.length, 0);
    assert.ok(asked.some((x) => /sala danang/i.test(x)), "premise: the property name WAS looked up");
    assert.deepEqual(leaks(asked), [], "no other line of the booking reached a read");

    const f = (await (await extract({ context: "trip_destination", fieldId: "trip.destination", text: FLIGHT_PASTE })).json()) as any;
    assert.equal(f.items.length, 1);
    assert.equal(f.items[0].status, "unsupported");
    assert.match(f.items[0].reason, /Flight details can’t be added/);
    assert.deepEqual(leaks(f), []);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Lead ruling PR-D2-7b (2026-10-08) — personal data is dropped BEFORE any lookup
//
// PR-D2-7 held line by line and not for what shares a line with the hotel, a
// one-line confirmation, or a confirmation with fewer than two signals
// (VERIFY-D2d F2–F4); and no rule kept an e-mail, card or phone line of an
// ordinary list from being looked up. Every verifier probe is pinned here, with
// adversarial pastes of our own, and the route-level proof records every value
// any read is filtered by.
//
// MUTATION LOG (each alone, restored):
//   B1 dropBeforeLookup → false                       → (a) list / segment / coords / route cases RED
//   B2 EMAIL removed                                  → e-mail cases RED
//   B3 LONG_DIGIT_RUN removed                         → reference / long-number cases RED
//   B4 CARD_TAIL removed                              → "ending 4242" / "**** 4242" RED
//   B5 PHONE removed                                  → phone cases RED
//   B6 LABEL_REFERENCE removed                        → "Ref: AB12345" RED
//   B7 VALUE_STOP removed (whole capture kept)        → every F2 probe RED
//   B8 keyword detection removed                      → F3 / F4 / "itinerary" RED
//   B9 the one-line guard restored                    → F3 RED
//   B10 segment check removed (textItems)             → "→" segment case RED
//   B11 link-stop check removed                       → map-link query case RED
//   B12 the F8 flight-word requirement removed        → F8 RED
//   B13 decimal fractions counted as a digit run      → coordinates control RED
//   (B5 PHONE removed is killed only by the dotted / "Tel:" shapes: every other
//    phone shape is also a six-digit run.)
// ═══════════════════════════════════════════════════════════════════════════════

const ADVERSARY = ["Jane Doe", "jane.doe@example.com", "4111 1111 1111 1111", "4242", "7781234", "123456", "AB12345", "4567", "Secretname"];
function personal(v: unknown): string[] {
  const s = JSON.stringify(v);
  return ADVERSARY.filter((x) => s.includes(x));
}
function oneItem(text: string) {
  const c = classifyPaste(text);
  assert.equal(c.items.length, 1, `${JSON.stringify(text)} → ${JSON.stringify(c.items)}`);
  return c.items[0]!;
}

describe("PR-D2-7b (b): a labelled value stops at its first separator or inner label (VERIFY-D2d F2)", () => {
  const cases: Array<[string, string]> = [
    ["Hotel: Majestic Saigon — Guest: Jane Doe\nCheck-in 12 Oct", "Majestic Saigon"],
    ["Property: Grand Hyatt Tokyo (contact jane.doe@example.com)\nCheck-out 14 Oct", "Grand Hyatt Tokyo"],
    ["Hotel: Majestic Saigon, paid with Visa 4111 1111 1111 1111\nCheck-in 12 Oct", "Majestic Saigon"],
    ["Property: Majestic Saigon; Guest: Jane Doe; Confirmation number: 123", "Majestic Saigon"],
    ["Address: 1 Dong Khoi, District 1, HCMC (Jane Doe)\nBooking confirmed", "1 Dong Khoi"],
    ["Hotel: Majestic Saigon | Name: Jane Doe\nReservation 2 nights", "Majestic Saigon"],
    ["Property: Majestic guest Jane Doe\nCheck-in", "Majestic"],
    ["Hotel: The Name Hotel\nCheck-in 12 Oct", "The Name Hotel"],
  ];
  for (const [text, want] of cases) {
    it(JSON.stringify(text.split("\n")[0]), () => {
      const item = oneItem(text);
      assert.equal(item.query, want);
      assert.equal(item.raw, want);
      assert.deepEqual(personal(item), []);
    });
  }
  it("a value that is itself personal is refused, never looked up", () => {
    const item = oneItem("Hotel: jane.doe@example.com\nCheck-in 12 Oct");
    assert.equal(item.query, null);
    assert.equal(item.unsupported, "booking_text");
    assert.equal(item.raw, "Hotel booking");
  });
});

describe("PR-D2-7b (c)/(d): any booking keyword, one line or many, reads ONLY the property (VERIFY-D2d F3, F4, F8)", () => {
  it("F3: a one-line SMS confirmation is one unsupported item — the line is never the query", () => {
    const item = oneItem("Hotel Majestic confirmation number 7781234 for guest Jane Doe, check-in 12 Oct, card ending 4242");
    assert.equal(item.query, null);
    assert.equal(item.unsupported, "booking_text");
    assert.deepEqual(personal(item), []);
  });
  it("F4: a confirmation with fewer than two of the old signals is never split line by line", () => {
    for (const text of [
      "Your reservation at Hotel Majestic\nReservation ID: 123456\nJane Doe\nVisa ending 4242\n12-14 Oct",
      "Hotel Majestic Saigon\nBooking confirmed\nName: Jane Doe\nConfirmation: 7781234\nArrival 12 Oct, departure 14 Oct",
    ]) {
      const item = oneItem(text);
      assert.equal(item.query, null, text);
      assert.equal(item.unsupported, "booking_text", text);
      assert.deepEqual(personal(item), [], text);
    }
  });
  it("one keyword is enough; 'itinerary' and 'guests' are NOT keywords (PR-D2-7c, VERIFY-D2e F6); a list without one is unchanged", () => {
    // PR-D2-7c changed these two (both were one unsupported booking item): the
    // ruling keeps itinerary / guests / check out as two-signal words.
    assert.deepEqual(classifyPaste("My itinerary\nDay 1: Hoi An\nDay 2: Hue").items.slice(-2).map((i) => i.query), ["Hoi An", "Hue"]);
    assert.equal(classifyPaste("Guest list for Hoi An").items[0]?.unsupported ?? null, null);
    assert.equal(oneItem("Booking for Hoi An").unsupported, "booking_text");
    const c = classifyPaste("Day 1: Hoi An\nDay 2: Hue");
    assert.equal(c.shape, "itinerary");
    assert.deepEqual(c.items.map((i) => i.query), ["Hoi An", "Hue"]);
    // A guesthouse is a place: the keyword is a whole word.
    assert.equal(classifyPaste("Hoa Guesthouse\nMy Son").shape, "list");
  });
  it("F8: a hotel booking whose reference looks like a flight number is a hotel booking", () => {
    const item = oneItem("Booking reference: HM 1234\nRoom type: Deluxe\nCheck-in 12 Oct\nHotel: Majestic");
    assert.equal(item.query, "Majestic");
    assert.equal(item.unsupported, null);
    // A real flight still yields fixed copy and no query.
    assert.equal(oneItem("Flight VN 123 SGN → DAD\nBoarding 07:15").unsupported, "flight_text");
  });
});

describe("PR-D2-7b (a): for EVERY paste, a personal line or segment is dropped before lookup", () => {
  it("an e-mail, phone, card or reference line of an ordinary list is dropped; the places stay", () => {
    for (const bad of ["jane.doe@example.com", "+84 90 123 4567", "+84.90.123.4567", "(028) 3829 4567", "090 123 4567", "090.123.4567", "Tel: 5551", "4111 1111 1111 1111", "Visa ending 4242", "**** 4242", "Ref: AB12345", "Account 123-456-789"]) {
      const c = classifyPaste(`Ben Thanh Market\n${bad}\nHoi An Old Town`);
      assert.deepEqual(c.items.map((i) => i.query), ["Ben Thanh Market", "Hoi An Old Town"], bad);
      assert.deepEqual(personal(c), [], bad);
    }
  });
  it("a personal SEGMENT is dropped and its siblings on the line stay", () => {
    const c = classifyPaste("Ben Thanh Market → call 0901234567 → Hoi An; jane.doe@example.com | Hue");
    assert.deepEqual(c.items.map((i) => i.query), ["Ben Thanh Market", "Hoi An", "Hue"]);
    assert.deepEqual(personal(c), []);
  });
  it("a single line that is personal yields nothing at all", () => {
    for (const bad of ["jane.doe@example.com", "Call me on +84 90 123 4567", "card ending 4242"]) {
      assert.deepEqual(classifyPaste(bad).items, [], bad);
    }
  });
  it("coordinates (decimal fractions) and map links are still read; a coordinate line carrying a phone is not (parseCoordinates reads only a whole-line pair, so the rest goes to the segment check)", () => {
    assert.equal(oneItem("16.054412, 108.202216").lat, 16.054412);
    const link = oneItem("https://www.google.com/maps/place/Hoi+An/@15.8801,108.338,15z/data=!3m1!4b1!4m6!3m5!1s0x31420dd4e1353a7b:0xae336435edfcca3!8m2!3d15.8800584!4d108.3380469");
    assert.equal(link.source, "map_link");
    assert.equal(link.query, "Hoi An");
    assert.deepEqual(classifyPaste("16.05, 108.20 call +84 90 123 4567").items, []);
  });
  it("a map link whose place query is personal yields no lookup of it", () => {
    const c = classifyPaste("https://www.google.com/maps/search/?api=1&query=jane.doe%40example.com");
    assert.ok(c.items.every((i) => i.query === null || !/jane|example/i.test(i.query)), JSON.stringify(c.items));
  });
  it("dates, prices, addresses and ordinary numbers are not personal", () => {
    for (const ok of ["36-38 Lam Hoanh", "1.500.000.000/night Da Nang", "Dinner 19:30", "12/10/2026 Hoi An", "Room 12 at Sala"]) {
      assert.equal(dropBeforeLookup(ok), false, ok);
    }
    assert.equal(safeLabelValue("1 Dong Khoi, District 1"), "1 Dong Khoi");
  });
});

describe("PR-D2-7b through the route: nothing dropped reaches a read, the geocoder or the response", () => {
  it("every verifier probe and an adversarial list: no read is filtered by personal text", async () => {
    const asked: string[] = [];
    const inner = makeFakeClient(STATE) as any;
    _setTestClient({
      ...inner,
      from: (table: string) => {
        const b = inner.from(table);
        for (const m of ["eq", "ilike", "or", "in", "textSearch"]) {
          const orig = b[m];
          if (typeof orig !== "function") continue;
          b[m] = (...args: unknown[]) => { asked.push(args.map((x) => JSON.stringify(x)).join(" ")); return orig.apply(b, args); };
        }
        return b;
      },
    } as any, true);
    const pastes = [
      "Hotel: Majestic Saigon — Guest: Jane Doe\nCheck-in 12 Oct",
      "Property: Grand Hyatt Tokyo (contact jane.doe@example.com)\nCheck-out 14 Oct",
      "Hotel: Majestic Saigon, paid with Visa 4111 1111 1111 1111\nCheck-in 12 Oct",
      "Hotel Majestic confirmation number 7781234 for guest Jane Doe, check-in 12 Oct, card ending 4242",
      "Your reservation at Hotel Majestic\nReservation ID: 123456\nJane Doe\nVisa ending 4242\n12-14 Oct",
      "Da Nang\njane.doe@example.com\n+84 90 123 4567\nRef: AB12345\nHoi An",
    ];
    for (const text of pastes) {
      const r = await extract({ context: "trip_destination", fieldId: "trip.destination", text });
      assert.equal(r.status, 200, text);
      const body = (await r.json()) as any;
      assert.deepEqual(personal(body), [], `${text} → response`);
    }
    assert.ok(asked.length > 0, "premise: the safe values WERE looked up");
    assert.deepEqual(personal(asked), [], "no read was filtered by dropped text");
    assert.equal(geocodeCalls.length, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Lead ruling PR-D2-7c (2026-10-08) — the structural belt over PR-D2-7b
//
//   (1) paste lookups query Portava's OWN catalog lanes only, never a
//       third-party provider: every outbound request a provider client could
//       make — `fetch`, `node:http(s)`, the OpenAI client — is stubbed and
//       COUNTED while every paste shape runs through the real route;
//   (2) only lines that resolve to a place are echoed back; an unmatched line is
//       dropped silently, a failed or unsupported one keeps fixed copy only;
//   (3) nothing from an unmatched line is ever LOGGED — a spy on the logger's
//       own output stream (every child shares it) and on the console, with the
//       logger at `trace`, including a database whose every error message
//       repeats the filter value it was given;
//   (4) the booking / label sets are localised for the launch languages (en, vi,
//       ja, th, de, es) — fullwidth colons, \p{Nd} digit folding, dotted groups,
//       name-label drops, narrow keywords (VERIFY-D2e F1–F4, F6, F7).
//
// MUTATION LOG (each alone, run red, restored byte-for-byte — see the lane report):
//   C1 resolvePaste: name a point through reverseGeocodeOutcome again          → (1) RED
//   C2 gateway: ignore `catalogOnly` (aiAssist passes through)               → (1) belt case RED
//   C3 resolvePaste: return `out` without echoOnlyResolved                    → (2) RED
//   C4 resolveOne: console.info the item's query                              → (3) RED (both cases)
//   C4b route: log the classified items' queries through the pino logger      → (3) RED (both cases)
//   C5 detectionForm → identity                                              → fullwidth / Arabic-Indic / ja RED
//   C6 NAME_LABEL never matches                                              → every name-label case RED
//   C7 CARD_TAIL: drop the card-brand alternative                            → "Visa x4242" RED
//   C8 EMAIL: ASCII-only domain again                                        → ".рф" RED
//   C9 CARD_GROUPS: no dot separator                                         → dotted card RED
//   C10 PHONE: drop the dotted local number                                  → "555.123.4567" RED
//   C11 isLabelledCode → false                                               → "Record locator ABC123" RED
//   C12 BARE_CODE never matches                                              → "X7K9P2" RED
//   C13 VALUE_STOP: drop " / " and " · "                                     → F4 separator cases RED
//   C14 VALUE_STOP: drop the honorifics                                      → "Mr Smith" RED
//   C15 safeLabelValue ignores needsDigit                                    → "Address: Jane Doe, 1 …" RED
//   C16 BOOKING_KEYWORD: drop the ja/th alternatives                         → ja / th fixtures RED
//   C17 BOOKING_KEYWORD: "itinerary" and "guests" back in                    → F6 RED
//   C18 classifyPaste: no skip after a bare "Guest:" header                  → "Guest:\nJane Doe" RED
//   C19 classifyTravelBooking: a label is not a signal                       → "Property: … / Check-out" RED
// ═══════════════════════════════════════════════════════════════════════════════

import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import pino from "pino";
import { logger } from "../lib/logger.js";
import { _setTestOpenAI } from "../lib/openai.js";
import { reverseGeocodeOutcome } from "../services/geocodingService.js";
import { generateSuggestions } from "../lib/inputAssistance/gateway.js";
import { resolvePolicy } from "../lib/inputAssistance/policyRegistry.js";
import { COMPASS_AI_WRITING_FLAG } from "../lib/inputAssistance/aiWriting.js";
import { detectionForm, echoOnlyResolved, isNameLabel, NEAREST_CITY_MAX_KM } from "../lib/inputAssistance/pasteExtraction.js";

/** Every provider client a paste could reach, stubbed and counted. */
const providerCalls: string[] = [];
function countingOpenAI(): any {
  const touch = (path: string): any => new Proxy(function () {}, {
    get: (_t, prop) => { providerCalls.push(`openai.${path}${String(prop)}`); return touch(`${path}${String(prop)}.`); },
    apply: () => { providerCalls.push(`openai.${path}()`); return Promise.reject(new Error("provider stub")); },
  });
  return touch("");
}
type ReqFn = (...a: any[]) => any;
const realHttp = { hr: http.request, hg: http.get, sr: https.request, sg: https.get };
function countHost(args: any[]): void {
  const a = args[0];
  const host = typeof a === "string" ? a : a instanceof URL ? a.href : (a?.hostname ?? a?.host ?? "");
  if (!/^(?:https?:\/\/)?(?:127\.0\.0\.1|localhost)(?:[:/]|$)/.test(String(host))) providerCalls.push(`http:${String(host)}`);
}
function stubProviders(): void {
  providerCalls.length = 0;
  geocodeCalls.length = 0;
  _setTestOpenAI(countingOpenAI());
  const wrap = (fn: ReqFn): ReqFn => (...args: any[]) => { countHost(args); return fn(...args); };
  (http as any).request = wrap(realHttp.hr); (http as any).get = wrap(realHttp.hg);
  (https as any).request = wrap(realHttp.sr); (https as any).get = wrap(realHttp.sg);
  syncBuiltinESMExports();
}
function restoreProviders(): void {
  _setTestOpenAI(null);
  (http as any).request = realHttp.hr; (http as any).get = realHttp.hg;
  (https as any).request = realHttp.sr; (https as any).get = realHttp.sg;
  syncBuiltinESMExports();
}
/** Every provider request seen: `fetch` to anything but this test's server, node:http(s), the model client. */
const allProviderCalls = () => [...geocodeCalls.map((u) => `fetch:${u}`), ...providerCalls];

const LOCALISED_BOOKINGS: Record<string, string> = {
  vi: "Khách sạn: Majestic Saigon\nKhách: Nguyễn Văn Bímật\nMã đặt phòng: 7781234\nNhận phòng: 12/10\nThẻ Visa đuôi 4242",
  ja: "ホテル：マジェスティック\n宿泊者：山田太郎\n予約番号：７７８１２３４\nチェックイン：10月12日",
  th: "โรงแรม: Majestic\nผู้เข้าพัก: สมชาย ใจดี\nหมายเลขการจอง: 7781234",
  de: "Hotel: Majestic Saigon\nGast: Jane Doe\nBuchungsnummer: 7781234\nAnreise: 12.10.2026\nVisa endet auf 4242",
  es: "Hotel: Majestic Saigon\nHuésped: Jane Doe\nNúmero de reserva: 7781234\nTarjeta terminada en 4242",
  en: HOTEL_PASTE,
};
const LOCALISED_PROPERTY: Record<string, string> = {
  vi: "Majestic Saigon", ja: "マジェスティック", th: "Majestic", de: "Majestic Saigon", es: "Majestic Saigon", en: "Sala Danang Beach Hotel",
};
/** Personal values the localised fixtures carry; none may ever be read, echoed or logged. */
const LOCAL_PERSONAL = ["Nguyễn Văn Bímật", "Bímật", "山田太郎", "สมชาย", "Jane Doe", "7781234", "７７８１２３４", "4242", GUEST, CONF];
function localLeaks(v: unknown): string[] {
  const s = JSON.stringify(v);
  return LOCAL_PERSONAL.filter((x) => s.includes(x));
}

const PROVIDER_BATTERY: Array<[string, string]> = [
  ["trip_destination", "16.0544, 108.2022"],
  ["trip_destination", "16°03'15.8\"N 108°12'07.9\"E"],
  ["city_picker", "0.0100, -140.0100"],
  ["trip_destination", "https://www.google.com/maps/place/Hoi+An/@15.8801,108.338,15z"],
  ["place_picker", "https://www.google.com/maps/@16.06,108.22,14z"],
  ["trip_stop_place", "https://maps.apple.com/?ll=10.82,106.63"],
  ["event_location", "https://www.openstreetmap.org/?mlat=16.06&mlon=108.22"],
  ["trip_destination", "geo:16.06,108.22"],
  ["trip_destination", "https://maps.app.goo.gl/AbCdEf123"],
  ["trip_destination", "danang\nhcmc\nAtlantis\nZzyzx Qqq"],
  ["trip_stop_place", "Day 1: Hoi An at 9am\nDay 2: Hue → My Son"],
  ["trip_destination", HOTEL_PASTE],
  ["trip_destination", FLIGHT_PASTE],
  ...Object.values(LOCALISED_BOOKINGS).map((t) => ["place_picker", t] as [string, string]),
];

describe("PR-D2-7c (1): no paste path reaches a third-party provider", () => {
  beforeEach(stubProviders);
  afterEach(restoreProviders);

  it("CONTROL: the counter SEES a provider call — the geocoder the paste path used to call is counted", async () => {
    geocoder = nominatim({ city: "Da Nang", country: "Vietnam", country_code: "vn" });
    await reverseGeocodeOutcome(16.0544, 108.2022);
    assert.ok(allProviderCalls().length >= 1, "premise: the stub counts the old path's request");
  });

  it("every paste shape, every paste context, through the real route: zero provider requests", async () => {
    const statuses: string[] = [];
    for (const [context, text] of PROVIDER_BATTERY) {
      const r = await extract({ context, text });
      assert.equal(r.status, 200, `${context} ${JSON.stringify(text).slice(0, 40)}`);
      const body = (await r.json()) as any;
      for (const i of body.items) statuses.push(`${i.source}:${i.status}`);
    }
    assert.deepEqual(allProviderCalls(), [], "a paste asked a third-party provider");
    // Premise: the battery really looked things up — names, links AND points resolved from the catalog.
    assert.ok(statuses.includes("coordinates:resolved"), statuses.join(","));
    assert.ok(statuses.includes("map_link:resolved"), statuses.join(","));
    assert.ok(statuses.includes("text:resolved"), statuses.join(","));
  });

  it("a point is named from the registry within the radius only — and the registry is the one thing read for it", async () => {
    const tables: string[] = [];
    const inner = makeFakeClient(STATE) as any;
    _setTestClient({ ...inner, from: (t: string) => { tables.push(t); return inner.from(t); } } as any, true);
    const body = (await (await extract({ context: "city_picker", text: "15.8801, 108.338" })).json()) as any;
    assert.equal(body.items[0].candidates[0].entityId, HOI_AN.id);
    assert.ok(tables.includes("canonical_locations"));
    assert.equal(NEAREST_CITY_MAX_KM, 40);
    assert.deepEqual(allProviderCalls(), []);
  });

  it("belt: the gateway refuses its model lane under `catalogOnly`, even when the request asks and everything else allows it", async () => {
    const sc = makeFakeClient({ ...STATE, feature_flags: [{ flag: COMPASS_AI_WRITING_FLAG, enabled: true }] }) as any;
    const policy = resolvePolicy("event_description")!;
    const ask = (catalogOnly: boolean) => generateSuggestions(sc, {
      context: "event_description", policy, text: "sunset meetup on the beach", userId: ME, limit: policy.maxSuggestions,
      lat: null, lng: null, city: null, aiAssist: true, tz: null, ...(catalogOnly ? { catalogOnly: true } : {}),
    });
    await ask(false);
    assert.ok(providerCalls.length > 0, "CONTROL: without catalogOnly the same request reaches the model client");
    providerCalls.length = 0;
    await ask(true);
    assert.deepEqual(providerCalls, [], "catalogOnly: the model client is never touched");
  });
});

describe("PR-D2-7c (2): only a line that resolved to a place is echoed back", () => {
  it("resolved lines as they are; unmatched dropped; unsupported links fixed copy — no host, no path, no token", async () => {
    const text = "Da Nang\nZzyzx Qqq\nhttps://maps.app.goo.gl/Secret123\nhttps://example.com/path/secret-token";
    const body = (await (await extract({ context: "trip_destination", text })).json()) as any;
    assert.deepEqual(body.items.map((i: any) => i.status), ["resolved", "unsupported", "unsupported"]);
    assert.equal(body.items[0].query, "Da Nang");
    assert.deepEqual(body.items.slice(1).map((i: any) => i.raw), ["Shortened map link", "Link"]);
    const s = JSON.stringify(body);
    for (const x of ["Zzyzx", "Secret123", "example.com", "secret-token", "goo.gl"]) assert.ok(!s.includes(x), x);
  });

  it("an unreadable registry: every line is a failed slot with fixed copy, none of the pasted text", async () => {
    _setTestClient(makeFakeClient(STATE, new Set(["canonical_locations", "countries"])) as any, true);
    const body = (await (await extract({ context: "city_picker", text: "Zzyzx Qqq\n16.0544, 108.2022\nDay 2: Zzqx Vale at 7pm" })).json()) as any;
    for (const it of body.items) {
      if (it.status === "resolved") continue;
      assert.equal(it.status, "failed", JSON.stringify(it));
      assert.equal(it.query, null); assert.equal(it.lat, null); assert.equal(it.dayLabel, null); assert.equal(it.timeHint, null);
      assert.ok(["Pasted line", "Pasted coordinates"].includes(it.raw), it.raw);
    }
    assert.ok(body.items.some((i: any) => i.status === "failed"), "premise: something failed");
    const s = JSON.stringify(body);
    for (const x of ["Zzyzx", "16.0544", "Day 2", "Zzqx", "7pm"]) assert.ok(!s.includes(x), x);
  });

  it("echoOnlyResolved (pure): resolved kept whole, no_match dropped, failed / unsupported reduced to fixed copy", () => {
    const base = { provider: null, lat: 1, lng: 2, timeHint: "7pm", dayLabel: "Friday", partial: true, candidates: [] as any[] };
    const out = echoOnlyResolved([
      { ...base, index: 0, raw: "Hoi An", source: "text", query: "Hoi An", unsupported: null, status: "resolved", reason: null, candidates: [{ id: "x" } as any] },
      { ...base, index: 1, raw: "Jane's place", source: "text", query: "Jane's place", unsupported: null, status: "no_match", reason: null },
      { ...base, index: 2, raw: "Zzyzx", source: "text", query: "Zzyzx", unsupported: null, status: "failed", reason: "We couldn’t check this one — the place lookup failed." },
      { ...base, index: 3, raw: "https://bit.ly/abc", source: "map_link", query: null, unsupported: "short_link", status: "unsupported", reason: "x" },
    ] as any);
    assert.deepEqual(out.map((i) => i.index), [0, 2, 3]);
    assert.equal(out[0]!.raw, "Hoi An");
    assert.deepEqual({ raw: out[1]!.raw, query: out[1]!.query, lat: out[1]!.lat, dayLabel: out[1]!.dayLabel, timeHint: out[1]!.timeHint }, { raw: "Pasted line", query: null, lat: null, dayLabel: null, timeHint: null });
    assert.equal(out[2]!.raw, "Shortened map link");
    assert.match(out[2]!.reason!, /Shortened map links/);
  });
});

describe("PR-D2-7c (3): nothing from an unmatched line is ever logged", () => {
  const streamSym = (pino as any).symbols.streamSym as symbol;
  let captured: string[] = [];
  let restore: (() => void) | null = null;
  beforeEach(() => {
    captured = [];
    const stream = (logger as any)[streamSym];
    const origWrite = stream.write;
    stream.write = function (chunk: unknown, ...rest: unknown[]) { captured.push(String(chunk)); return origWrite.call(this, chunk, ...rest); };
    const level = logger.level;
    logger.level = "trace";
    const cons = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
    for (const k of Object.keys(cons) as Array<keyof typeof cons>) {
      (console as any)[k] = (...a: unknown[]) => { captured.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x, Object.getOwnPropertyNames(x ?? {})))).join(" ")); };
    }
    restore = () => { stream.write = origWrite; logger.level = level; Object.assign(console, cons); };
  });
  afterEach(() => { restore?.(); restore = null; });

  const MARKERS = ["Qzxvmarker", "Wqpjunmatched"];
  // An ORDINARY list (no booking keyword): every line reaches the resolver, and two match nothing.
  const PASTE = "Da Nang\nQzxvmarker Street Cafe\nWqpjunmatched Lane 9\nGuest: Jane Doe\n+84 90 123 4567";

  it("a healthy registry: unmatched lines and bookings are logged as counts only — no marker, no personal value", async () => {
    const r = await extract({ context: "trip_destination", text: PASTE });
    assert.equal(r.status, 200);
    const body = (await r.json()) as any;
    assert.deepEqual(body.items.map((i: any) => i.query), ["Da Nang"], "premise: two lines matched nothing and were dropped");
    for (const text of Object.values(LOCALISED_BOOKINGS)) assert.equal((await extract({ context: "place_picker", text })).status, 200);
    assert.ok(captured.some((l) => l.includes("input-assistance/extract served")), "premise: the spy sees the route's own log line");
    const all = captured.join("\n");
    for (const x of [...MARKERS, ...LOCAL_PERSONAL]) assert.ok(!all.includes(x), `logged: ${x}`);
  });

  it("a database whose every error REPEATS the filter value it was given: still nothing pasted reaches a log", async () => {
    const inner = makeFakeClient(STATE) as any;
    const echoing = {
      ...inner,
      from: (table: string) => {
        if (table === "profiles") return inner.from(table);
        const seen: string[] = [];
        const b: any = {};
        for (const fn of ["select", "eq", "neq", "in", "not", "is", "ilike", "or", "gte", "lte", "lt", "gt", "order", "limit", "range", "textSearch", "filter", "match", "contains", "overlaps"]) {
          b[fn] = (...args: unknown[]) => { seen.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")); return b; };
        }
        const err = () => ({ data: null, error: { message: `simulated failure on ${table}: ${seen.join(" | ")}`, details: seen.join(" | "), hint: null, code: "XX000" } });
        b.maybeSingle = () => Promise.resolve(err()); b.single = b.maybeSingle;
        b.then = (onF: any, onR: any) => Promise.resolve(err()).then(onF, onR);
        return b;
      },
    };
    _setTestClient(echoing as any, true);
    const r = await extract({ context: "trip_destination", text: `${PASTE}\n16.0544, 108.2022` });
    assert.equal(r.status, 200);
    const body = (await r.json()) as any;
    assert.ok(body.items.some((i: any) => i.status === "failed"), "premise: the lookups really failed");
    for (const text of Object.values(LOCALISED_BOOKINGS)) assert.equal((await extract({ context: "place_picker", text })).status, 200);
    assert.ok(captured.length > 0, "premise: the spy is live");
    const all = captured.join("\n");
    for (const x of [...MARKERS, ...LOCAL_PERSONAL, "Majestic", "16.0544"]) assert.ok(!all.includes(x), `logged: ${x}`);
  });
});

describe("PR-D2-7c (4): localised booking and label sets (VERIFY-D2e F1–F4, F6, F7)", () => {
  for (const [lang, text] of Object.entries(LOCALISED_BOOKINGS)) {
    it(`F1 ${lang}: a hotel confirmation is ONE item — the property — and nothing personal is read`, () => {
      const item = oneItem(text);
      assert.equal(item.query, LOCALISED_PROPERTY[lang]);
      assert.deepEqual(localLeaks(item), []);
    });
  }

  it("F1: ONE booking keyword, any launch language, keeps an UNLABELLED name from ever being looked up", () => {
    for (const text of [
      "Booking confirmed\nJane Doe\nMajestic Saigon",
      "Đặt phòng thành công\nNguyễn Văn Bímật\nMajestic Saigon",
      "ご予約ありがとうございます\n山田太郎\nマジェスティック",
      "ยืนยันการจอง\nสมชาย ใจดี\nMajestic",
      "Ihre Buchung\nJane Doe\nMajestic Saigon",
      "Su reserva confirmada\nJane Doe\nMajestic Saigon",
    ]) {
      const item = oneItem(text);
      assert.equal(item.unsupported, "booking_text", text);
      assert.equal(item.query, null, text);
      assert.deepEqual(localLeaks(item), [], text);
    }
  });

  it("F1/F3: a NAME label, any launch language, is dropped from an ordinary list", () => {
    for (const bad of [
      "Khách: Nguyễn Văn Bímật", "Họ tên: Nguyễn Văn Bímật", "宿泊者：山田太郎", "氏名: 山田太郎", "ผู้เข้าพัก: สมชาย ใจดี", "ชื่อ-นามสกุล: สมชาย ใจดี",
      "Gast: Jane Doe", "Karteninhaber: Jane Doe", "Huésped: Jane Doe", "Titular: Jane Doe",
      "Host: Jane Doe", "Name: Jane Doe", "Traveler: Jane Doe", "Cardholder: Jane Doe", "Passenger: Jane Doe",
    ]) {
      assert.equal(isNameLabel(bad), true, bad);
      const c = classifyPaste(`Ben Thanh Market\n${bad}\nHoi An`);
      assert.deepEqual(c.items.map((i) => i.query), ["Ben Thanh Market", "Hoi An"], bad);
      assert.deepEqual(localLeaks(c), [], bad);
    }
    // A name label on its own line drops the line that follows it — the name.
    assert.deepEqual(classifyPaste("Guest:\nJane Doe\nHoi An").items.map((i) => i.query), ["Hoi An"]);
    // A property label is not a name label.
    for (const ok of ["Khách sạn: Rex", "ชื่อโรงแรม: Majestic", "Name der Unterkunft: Majestic", "Hostel: Mad Monkey"]) assert.equal(isNameLabel(ok), false, ok);
  });

  it("F1/F2: a card tail by brand word or 'ending' word, any launch language", () => {
    for (const bad of ["Visa x4242", "Visa 4242", "Thẻ Visa đuôi 4242", "Visa endet auf 4242", "Tarjeta terminada en 4242", "カード 末尾 4242", "บัตร ลงท้ายด้วย 4242", "Mastercard •••• 4242"]) {
      assert.equal(dropBeforeLookup(bad), true, bad);
    }
  });

  it("F2: digit shapes outside ASCII and outside spaces-or-dashes", () => {
    for (const bad of ["４１１１ １１１１ １１１１ １１１１", "٠٩٠١٢٣٤٥٦٧", "๐๙๐๑๒๓๔๕๖๗", "4111.1111.1111.1111", "555.123.4567", "jane@example.рф"]) {
      assert.equal(dropBeforeLookup(bad), true, bad);
      assert.deepEqual(classifyPaste(`Ben Thanh Market\n${bad}\nHoi An`).items.map((i) => i.query), ["Ben Thanh Market", "Hoi An"], bad);
    }
    // A fullwidth labelled code: dropped on its own, and its 予約 makes the whole paste a booking.
    assert.equal(dropBeforeLookup("予約番号：ＡＢ１２３４５"), true);
    assert.equal(oneItem("Ben Thanh Market\n予約番号：ＡＢ１２３４５").unsupported, "booking_text");
    assert.equal(detectionForm("予約番号：７７８１２３４ ๑๒๓ ٤٥"), "予約番号:7781234 123 45");
    // Still not personal: prices with dot groups, dates, coordinates, addresses.
    for (const ok of ["1.500.000.000/night Da Nang", "12.10.2026 Hoi An", "36-38 Lam Hoanh", "Room 12 at Sala", "Dinner 19:30"]) assert.equal(dropBeforeLookup(ok), false, ok);
    assert.equal(oneItem("16.054412, 108.202216").lat, 16.054412);
  });

  it("F3: a reference code with or without its colon, or with no label at all", () => {
    for (const bad of ["Record locator ABC123", "PNR QXZTPB", "Ref AB1234", "Conf ABCDEF", "X7K9P2", "QR1083"]) assert.equal(dropBeforeLookup(bad), true, bad);
    for (const ok of ["Reference Guide to Hanoi", "Hoi An", "Q1", "HCMC", "District 1"]) assert.equal(dropBeforeLookup(ok), false, ok);
    // "Reserved for …" on one line is a booking: nothing on it is looked up.
    const item = oneItem("Reserved for Jane Doe at Majestic Hotel 12-14 Oct");
    assert.equal(item.query, null);
    assert.deepEqual(personal(item), []);
  });

  it("F4/F7: a labelled value stops at /, ·, 'for', an honorific and a bare inner name label; an address must hold a digit", () => {
    const cases: Array<[string, string | null]> = [
      ["Hotel: Majestic Saigon / Jane Doe\nCheck-in 12 Oct", "Majestic Saigon"],
      ["Hotel: Majestic Saigon · Jane Doe\nCheck-in 12 Oct", "Majestic Saigon"],
      ["Hotel: Majestic Saigon for Jane Doe\nCheck-in 12 Oct", "Majestic Saigon"],
      ["Hotel: Majestic Saigon Mr Smith\nCheck-in 12 Oct", "Majestic Saigon"],
      ["Hotel: Majestic Saigon / Guest: Jane Doe\nCheck-in 12 Oct", "Majestic Saigon"],
      ["Hotel: Majestic Saigon Name: Jane Doe\nCheck-in 12 Oct", "Majestic Saigon"],
      ["Address: Jane Doe, 1 Dong Khoi, District 1\nCheck-in 12 Oct", null],
      ["Address: 1 Dong Khoi, District 1\nCheck-in 12 Oct", "1 Dong Khoi"],
    ];
    for (const [text, want] of cases) {
      const item = oneItem(text);
      assert.equal(item.query, want, text);
      assert.deepEqual(personal(item), [], text);
      if (want === null) assert.equal(item.unsupported, "booking_text", text);
    }
  });

  it("F6: 'itinerary', 'guests' and 'check out' alone never make an ordinary itinerary a booking", () => {
    const want = (text: string, places: string[]) => {
      const c = classifyPaste(text);
      assert.equal(c.shape, "itinerary", text);
      assert.deepEqual(c.items.map((i) => i.query).slice(-places.length), places, text);
    };
    want("Itinerary\nDay 1: Hoi An\nDay 2: Hue", ["Hoi An", "Hue"]);
    want("Day 1: Check out the Old Town\nDay 2: Hue", ["Check out the Old Town", "Hue"]);
    want("Day 1: Dinner for 2 guests at Sala\nDay 2: Hue", ["Dinner for 2 guests at Sala", "Hue"]);
    // Two of them together, or one beside a property label, still make a booking.
    assert.equal(oneItem("Itinerary\nCheck-out: 14 Oct\n2 guests").unsupported, "booking_text");
    assert.equal(oneItem("Property: Grand Hyatt Tokyo (contact jane.doe@example.com)\nCheck-out 14 Oct").query, "Grand Hyatt Tokyo");
    // A Spanish nature reserve is a place, not a reservation.
    assert.equal(classifyPaste("Reserva Natural Cabo Blanco\nTokyo Tower").shape, "list");
  });

  it("through the route: the localised fixtures look up only the property, and leak nothing", async () => {
    const asked: string[] = [];
    const inner = makeFakeClient(STATE) as any;
    _setTestClient({
      ...inner,
      from: (table: string) => {
        const b = inner.from(table);
        for (const m of ["eq", "ilike", "or", "in", "textSearch"]) {
          const orig = b[m];
          if (typeof orig !== "function") continue;
          b[m] = (...args: unknown[]) => { asked.push(args.map((x) => JSON.stringify(x)).join(" ")); return orig.apply(b, args); };
        }
        return b;
      },
    } as any, true);
    for (const [lang, text] of Object.entries(LOCALISED_BOOKINGS)) {
      const r = await extract({ context: "place_picker", text });
      assert.equal(r.status, 200, lang);
      assert.deepEqual(localLeaks(await r.json()), [], `${lang} → response`);
    }
    assert.ok(asked.some((x) => /majestic|マジェスティック/i.test(x)), "premise: the property names WERE looked up");
    assert.deepEqual(localLeaks(asked), [], "no read was filtered by a personal value");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// V-D2f F-A … F-D (lead, 2026-10-09) — every case through classifyPaste, the path a
// paste actually takes, not only the pure helpers.
// MUTATION-PROOF (each alone, restored):
//   N1 NAME_LABEL: the spaced-dash separator removed       → F-A dash case RED
//   N2 NAME_LABEL: the compound heads removed              → F-A compound cases RED
//   N3 dropBeforeLookup: INNER_NAME_LABEL removed          → F-B list case RED
//   N4 classifyTravelBooking: the property+name rule removed → F-B single-line case RED
//   N5 FLIGHT_SIGNALS[4] removed                            → F-C RED
//   N6 LABELLED_DATE / LOWER_REFERENCE_CODE removed         → F-D cases RED
// ═══════════════════════════════════════════════════════════════════════════════

describe("V-D2f: name labels with a dash or a compound head, inner name labels, lowercase flights, DOB and lower-case codes", () => {
  const lookedUp = (paste: string) => classifyPaste(paste).items.map((i) => i.query).filter((q): q is string => !!q);
  const inList = (line: string) => lookedUp(`Ben Thanh Market\n${line}\nHoi An`);

  it("F-A: a spaced-dash name label and compound name labels are never looked up (keyword-less list)", () => {
    for (const line of [
      "Guest – Jane Doe", "Host - Jane Doe", "Name of guest: Jane Doe", "Name des Gastes: Max Mustermann",
      "Nombre del huésped: Juan Pérez", "Tên của khách: Nguyễn Văn A",
    ]) {
      assert.deepEqual(inList(line), ["Ben Thanh Market", "Hoi An"], line);
    }
  });

  it("F-B: a name label INSIDE a line — the line is dropped from a list, and beside a property label it is a booking read for the property", () => {
    assert.deepEqual(inList("Majestic Saigon Name: Jane Doe"), ["Ben Thanh Market", "Hoi An"]);
    assert.deepEqual(lookedUp("Hotel: Majestic Saigon Name: Jane Doe"), ["Majestic Saigon"]);
    // CONTROL: the property's own "Hotel name:" label is not a person's name label.
    assert.deepEqual(lookedUp("Hotel name: Majestic Saigon\nCheck-in 12 Oct"), ["Majestic Saigon"]);
  });

  it("F-C: a lower-case flight number after a flight word makes the paste a flight — the passenger line is never read", () => {
    const c = classifyPaste("Flight vn123 Saigon to Hanoi\nPassenger Jane Doe\nSeat 12A");
    assert.equal(c.items.length, 1);
    assert.equal(c.items[0]!.unsupported, "flight_text");
    assert.equal(c.items[0]!.query, null);
    // CONTROL: a flight WORD with no flight number is still an ordinary line.
    assert.deepEqual(lookedUp("Flights of stairs at Hue citadel"), ["Flights of stairs at Hue citadel"]);
  });

  it("F-D: a date of birth, a lower-case locator, Vietnamese without diacritics and a colon-less Japanese label are dropped", () => {
    for (const line of ["DOB: 12/05/1990", "Date of birth: 12.05.1990", "Born: 12/05/1990", "Locator: abc123", "Khach: Nguyen Van A", "Ho va ten: Nguyen Van A", "宿泊者 山田太郎"]) {
      assert.deepEqual(inList(line), ["Ben Thanh Market", "Hoi An"], line);
    }
    // CONTROLS: ordinary place lines are still read.
    assert.deepEqual(inList("Guest house Saigon"), ["Ben Thanh Market", "Guest house Saigon", "Hoi An"]);
    assert.deepEqual(inList("Conference Hall"), ["Ben Thanh Market", "Conference Hall", "Hoi An"]);
  });
});
