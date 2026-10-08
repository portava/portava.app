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
 *   Failure honesty: an unreadable canonical registry or a failed reverse
 *   geocode is an item that FAILED, never an item with "no match".
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
  for (const fn of ["select","eq","neq","in","not","is","ilike","or","gte","lt","order","limit","range","maybeSingle"]) {
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
        gte() { return builder; },
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

// ── fetch: the local server passes through; the geocoder is faked ─────────────
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
  it("a pasted list resolves each stop to its CANONICAL city and reports an honest no-match", async () => {
    const r = await extract({ context: "trip_destination", fieldId: "trip.destination", text: "danang\nhcmc\nAtlantis" });
    assert.equal(r.status, 200);
    const body = (await r.json()) as any;
    assert.equal(body.mutated, false);
    assert.equal(body.shape, "list");
    const [a, b, c] = body.items;
    assert.equal(a.status, "resolved");
    assert.equal(a.candidates[0].entityId, DA_NANG.id, "the stroke fold resolved 'danang'");
    assert.equal(a.candidates[0].structuredValue.city, "Đà Nẵng");
    assert.equal(b.status, "resolved");
    assert.equal(b.candidates[0].entityId, HCMC.id, "the alias table resolved 'hcmc'");
    assert.equal(c.status, "no_match");
    assert.deepEqual(c.candidates, []);
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
    // The countries source still answered "Da Nang" (Vietnam) — so the answer
    // is marked PARTIAL: the review screen says the city lookup was down and
    // does not pre-tick it. It is never presented as a complete answer.
    assert.equal(daNang.status, "resolved");
    assert.equal(daNang.partial, true);
    assert.ok(!daNang.candidates.some((c: any) => c.entityId === DA_NANG.id));
  });

  it("coordinates are reverse-geocoded and then resolved like typed text (G157)", async () => {
    geocoder = nominatim({ city: "Da Nang", country: "Vietnam", country_code: "vn" }, "Hai Chau, Da Nang, Vietnam");
    const r = await extract({ context: "trip_destination", text: "16.0544, 108.2022" });
    const body = (await r.json()) as any;
    assert.equal(body.shape, "coordinates");
    const [item] = body.items;
    assert.equal(item.status, "resolved");
    assert.equal(item.lat, 16.0544);
    assert.equal(item.candidates[0].entityId, DA_NANG.id);
    assert.equal(geocodeCalls.length, 1);
  });

  it("a FAILED reverse geocode is a failed item, not 'nothing here'", async () => {
    geocoder = async () => new Response("upstream down", { status: 503 });
    const r = await extract({ context: "trip_destination", text: "16.0544, 108.2022" });
    const [item] = ((await r.json()) as any).items;
    assert.equal(item.status, "failed");
    assert.match(item.reason, /geocod/i);
  });

  it("a point the geocoder ANSWERED with no place is an honest no-match", async () => {
    geocoder = async () => new Response(JSON.stringify({ error: "Unable to geocode" }), { status: 200 });
    const r = await extract({ context: "trip_destination", text: "0.0100, -140.0100" });
    const [item] = ((await r.json()) as any).items;
    assert.equal(item.status, "no_match");
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
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].query, "Sala Danang Beach Hotel");
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
  it("one keyword is enough, the word 'itinerary' included; a list without one is unchanged", () => {
    assert.equal(oneItem("My itinerary\nDay 1: Hoi An\nDay 2: Hue").unsupported, "booking_text");
    assert.equal(oneItem("Guest list for Hoi An").unsupported, "booking_text");
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
