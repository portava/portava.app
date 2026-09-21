/**
 * discoveryCountryRegistry — B05 / GII G277 "CountryResolver".
 *
 * Run: node --import tsx/esm --test src/test/discoveryCountryRegistry.test.ts
 *
 * THE DEFECT THIS PINS
 * ====================
 * `searchCountries` aggregated `profiles.home_country` and nothing else, so the
 * set of countries that EXIST as a suggestion was a function of who had signed
 * up. Iceland was not a country on this surface until an Icelander was. That is
 * not a privacy leak — the read was opt-out filtered, and census-discovery B05
 * says so — it is a construction defect: a country picker resolving against the
 * user table.
 *
 * WHAT CLOSES IT, AND WHY IT IS NOT A NEW REGISTRY
 * ===============================================
 * `lib/countryCodes.ts` already carries ISO-3166-1 alpha-2 with canonical
 * English names, an alias index (`holland` → NL, `bali` → ID) and a
 * diacritic-insensitive fold. It is pure data with no I/O, in this package,
 * and `lib/stamps/countryLookup.ts` already consumes it. Discovery consumes the
 * same module rather than growing a second list — the rule C32 and DC-24 exist
 * to enforce, applied to country names instead of ranking.
 *
 * WHAT THIS SUITE DELIBERATELY ALSO ASSERTS
 * =========================================
 * The registry leg is viewer-independent and carries no user linkage, so the
 * obvious next mistake is to let it ANSWER when the privacy reads refused. It
 * must not: a registry-only page is missing every free-text country that only
 * `profiles` knows, and serving it as a complete answer is exactly the D11
 * masquerade — "we did not look" rendered as "we looked and this is all there
 * is". R8/R9 pin the refusal in both directions.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import discoverySearchRouter from "../routes/discoverySearch.js";
import { searchCountryRegistry, toCountryCode } from "../lib/countryCodes.js";

const ME = "aa000000-0000-4000-a000-000000000001";
const ALICE = "bb000000-0000-4000-a000-000000000002";
const ME_TOK = "tok-me";

interface FakeState { [table: string]: any[] | undefined }

function makeFakeClient(state: FakeState, tableErrors: Set<string>) {
  const errorBuilder: any = {};
  for (const fn of ["select", "eq", "neq", "in", "not", "is", "ilike", "or", "gte", "lt", "order", "limit", "range", "maybeSingle"]) {
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
    from: (table: string) => {
      if (tableErrors.has(table)) return errorBuilder;
      const sourceRows: any[] = [...(state[table] ?? [])];
      const filters: Array<(r: any) => boolean> = [];
      let _limitN = Infinity;
      let _rangeStart = 0;
      let _rangeEnd = Infinity;
      const builder: any = {
        select() { return builder; },
        eq(col: string, val: any) { filters.push((r) => r[col] === val); return builder; },
        neq(col: string, val: any) { filters.push((r) => r[col] !== val); return builder; },
        in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return builder; },
        not(col: string, op: string, val: any) {
          if (op === "is") { filters.push((r) => r[col] !== val && r[col] != null); return builder; }
          throw new Error(`fake client: unmodelled .not(${col}, "${op}", …)`);
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
        or() { return builder; },
        gte() { return builder; },
        lt() { return builder; },
        order() { return builder; },
        limit(n: number) { _limitN = n; return builder; },
        range(s: number, e: number) { _rangeStart = s; _rangeEnd = e; return builder; },
        maybeSingle() {
          const m = sourceRows.filter((r) => filters.every((f) => f(r)));
          return Promise.resolve({ data: m[0] ?? null, error: null });
        },
        then(onF: any, onR: any) {
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

function setup(state: FakeState = {}, tableErrors: string[] = []) {
  const full: FakeState = {
    profiles: [], blocks: [], profile_privacy_settings: [], canonical_locations: [],
    ...state,
  };
  _setTestClient(makeFakeClient(full, new Set(tableErrors)) as any, true);
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    next();
  });
  app.use("/api", discoverySearchRouter);
  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});

after(() => server.close());
beforeEach(() => { _resetRateLimit(); setup({}); });

function get(path: string, tok = ME_TOK) {
  return fetch(`${base}${path}`, { headers: tok ? { Authorization: `Bearer ${tok}` } : {} });
}

async function countries(q: string): Promise<any[]> {
  const r = await get(`/discovery/search?q=${encodeURIComponent(q)}&type=countries`);
  assert.equal(r.status, 200, `expected 200 for q=${q}`);
  const body = await r.json() as any;
  return body.results as any[];
}

const titles = (rows: any[]) => rows.map((r) => r.title as string);

// ── The registry itself, as a pure function ───────────────────────────────────

describe("searchCountryRegistry — the resolver G277 names", () => {
  it("U1 — a blank or whitespace query resolves to nothing, never to everything", () => {
    assert.deepEqual(searchCountryRegistry(""), []);
    assert.deepEqual(searchCountryRegistry("   "), []);
    assert.deepEqual(searchCountryRegistry(null), []);
    assert.deepEqual(searchCountryRegistry(undefined), []);
  });

  it("U2 — an ISO2 code resolves, and ranks ahead of the names it is a substring of", () => {
    const rows = searchCountryRegistry("in");
    assert.equal(rows[0]?.code, "IN", "IN is the code for India and must lead");
    assert.equal(rows[0]?.name, "India");
    assert.equal(rows[0]?.via, "code");
    // "in" is also a substring of Argentina, Finland, Singapore…
    assert.ok(rows.length > 1, "substring matches still resolve behind the code hit");
  });

  it("U3 — an alias resolves to the CANONICAL name, never to the alias string", () => {
    const holland = searchCountryRegistry("holland");
    assert.deepEqual(titles(holland.map((r) => ({ title: r.name }))), ["Netherlands"]);
    assert.equal(holland[0]?.via, "alias");
    const bali = searchCountryRegistry("bali");
    assert.equal(bali[0]?.name, "Indonesia");
    assert.equal(bali[0]?.code, "ID");
  });

  it("U4 — one row per country: an alias and its canonical name do not double", () => {
    const rows = searchCountryRegistry("united states");
    const codes = rows.map((r) => r.code);
    assert.equal(new Set(codes).size, codes.length, "no duplicate ISO codes");
    assert.ok(codes.includes("US"));
  });

  it("U5 — diacritics fold in both directions", () => {
    assert.equal(searchCountryRegistry("curaçao")[0]?.code, "CW");
    assert.equal(searchCountryRegistry("curacao")[0]?.code, "CW");
    assert.equal(searchCountryRegistry("réunion")[0]?.code, "RE");
  });

  it("U6 — prefix matches lead substring matches, and the order is stable across calls", () => {
    const a = searchCountryRegistry("ran");
    const b = searchCountryRegistry("ran");
    assert.deepEqual(a, b, "the resolver is pure — same query, same order");
    const names = a.map((r) => r.name);
    assert.ok(names.includes("France"), "France matches 'ran' as a substring");
    // Every prefix match must precede every non-prefix match.
    const isPrefix = (n: string) => n.toLowerCase().startsWith("ran");
    let seenNonPrefix = false;
    for (const n of names) {
      if (!isPrefix(n)) seenNonPrefix = true;
      else assert.equal(seenNonPrefix, false, `prefix match ${n} came after a substring match`);
    }
  });

  it("U7 — the limit is honoured and never exceeded", () => {
    assert.equal(searchCountryRegistry("a", 3).length, 3);
    assert.equal(searchCountryRegistry("a", 0).length, 0);
  });

  it("U8 — an EXACT alias outranks a name that merely starts with the query", () => {
    // Found by R6 going red, not by reasoning. `UK` is not an ISO code — the
    // United Kingdom is `GB` — so the code rung declines it, and "Ukraine"
    // starts with the same two letters. Ranking alias-prefix below name-prefix
    // put Ukraine first for the single most-typed colloquial country name in
    // the table.
    const uk = searchCountryRegistry("uk");
    assert.equal(uk[0]?.code, "GB", "'uk' means the United Kingdom, not Ukraine");
    assert.equal(uk[0]?.via, "alias");
    assert.ok(uk.some((r) => r.code === "UA"), "Ukraine still matches, behind it");
    // The same rule the other way round: an exact NAME beats an exact alias
    // only when they disagree, and "japan" is exact on the canonical table.
    assert.equal(searchCountryRegistry("japan")[0]?.via, "name");
  });
});

// ── The route ─────────────────────────────────────────────────────────────────

describe("GET /discovery/search?type=countries — a country exists without a resident", () => {
  it("R1 — a country resolves with ZERO profiles in the database", async () => {
    setup({ profiles: [] });
    const rows = await countries("japan");
    assert.deepEqual(titles(rows), ["Japan"]);
  });

  it("R2 — a country with no users in it still exists as a suggestion", async () => {
    setup({
      profiles: [{
        id: ALICE, handle: "alice", name: "Alice", avatar_url: null, is_private: false,
        home_city: "Tokyo", home_country: "Japan", account_status: "active",
      }],
    });
    const rows = await countries("iceland");
    assert.deepEqual(titles(rows), ["Iceland"]);
  });

  it("R3 — a country that IS populated appears exactly once, under its canonical name", async () => {
    setup({
      profiles: [
        { id: ALICE, handle: "a", name: "A", avatar_url: null, is_private: false, home_city: "Tokyo", home_country: "japan", account_status: "active" },
        { id: "cc000000-0000-4000-a000-000000000003", handle: "b", name: "B", avatar_url: null, is_private: false, home_city: "Osaka", home_country: "Japan", account_status: "active" },
      ],
    });
    const rows = await countries("japan");
    assert.deepEqual(titles(rows), ["Japan"], "canonical spelling, one row, not two");
  });

  it("R4 — a free-text country the registry cannot resolve is NOT dropped", async () => {
    setup({
      profiles: [{
        id: ALICE, handle: "a", name: "A", avatar_url: null, is_private: false,
        home_city: null, home_country: "Wakanda", account_status: "active",
      }],
    });
    const rows = await countries("wakanda");
    assert.deepEqual(titles(rows), ["Wakanda"]);
    assert.equal(rows[0].metadata.source, "profile", "an unresolvable name keeps its profile provenance");
  });

  it("R5 — an ISO2 code typed as the query resolves", async () => {
    setup({ profiles: [] });
    const rows = await countries("jp");
    assert.equal(rows[0]?.title, "Japan");
  });

  it("R6 — a colloquial name resolves to the canonical country", async () => {
    setup({ profiles: [] });
    assert.equal((await countries("holland"))[0]?.title, "Netherlands");
    assert.equal((await countries("uk"))[0]?.title, "United Kingdom");
  });

  it("R7 — the result carries the §27 position keys and its own provenance", async () => {
    setup({ profiles: [] });
    const [row] = await countries("iceland");
    assert.ok(row, "Iceland resolves");
    assert.equal(row.type, "countries");
    assert.equal(row.id, "country:iceland");
    assert.equal(row.destinationRoute, "/country/iceland");
    assert.ok("lat" in row.metadata && "lng" in row.metadata, "§27: position keys always present");
    assert.equal(row.metadata.lat, null);
    assert.equal(row.metadata.source, "registry");
    assert.equal(row.metadata.countryCode, "IS");
  });

  it("R8 — an unreadable blocks table still REFUSES; the registry does not answer over it", async () => {
    setup({ profiles: [] }, ["blocks"]);
    const r = await get("/discovery/search?q=japan&type=countries");
    const body = await r.json() as any;
    assert.deepEqual(body.results, [], "a refusal serves nothing");
    assert.ok(body.refusal, "and it SAYS it is a refusal");
    assert.equal(body.refusal.coverage, "nothing");
  });

  it("R9 — an unreadable opt-out table REFUSES; it does not serve a registry-only page", async () => {
    // This is the hazard the registry leg CREATES. Before it, a failed
    // `profile_privacy_settings` read left nothing to serve, so refusing was
    // the only option the code had. Now there IS something to serve — a public
    // ISO list that needed no privacy read at all — and serving it would hand
    // the caller a page missing every free-text country only `profiles` knows,
    // in a body indistinguishable from a complete one. D11's masquerade.
    setup({
      profiles: [{
        id: ALICE, handle: "a", name: "A", avatar_url: null, is_private: false,
        home_city: null, home_country: "Japan", account_status: "active",
      }],
    }, ["profile_privacy_settings"]);
    const r = await get("/discovery/search?q=japan&type=countries");
    const body = await r.json() as any;
    assert.deepEqual(body.results ?? [], [], JSON.stringify(body));
    assert.ok(body.refusal, `an unknown opt-out state is not an empty country list: ${JSON.stringify(body)}`);
    assert.equal(body.refusal.coverage, "nothing");
  });

  it("R10 — the registry leg is viewer-independent: identical answer with and without users", async () => {
    setup({ profiles: [] });
    const empty = await countries("iceland");
    setup({
      profiles: [{
        id: ALICE, handle: "a", name: "A", avatar_url: null, is_private: false,
        home_city: "Reykjavik", home_country: "Iceland", account_status: "active",
      }],
      profile_privacy_settings: [{ user_id: ALICE, allow_profile_discovery: false }],
    });
    const optedOut = await countries("iceland");
    assert.deepEqual(optedOut, empty,
      "an opted-out resident neither adds to nor subtracts from a public ISO name");
  });

  it("R12 — a typed SPELLING folds into the canonical row, not beside it", async () => {
    // ADDED AFTER A MUTANT SURVIVED. Deleting the ISO-code fold left R3 green,
    // because R3's fixture types the country the same way the registry spells
    // it and the lowercase-name fold catches that on its own. The code fold is
    // the only thing that catches a DIFFERENT spelling of the same country, so
    // that is what this asserts: "Holland" and "Netherlands" are one country
    // and must be one row, or a picker offers the traveller the same place
    // twice under two names.
    setup({
      profiles: [{
        id: ALICE, handle: "a", name: "A", avatar_url: null, is_private: false,
        home_city: null, home_country: "Holland", account_status: "active",
      }],
    });
    assert.deepEqual(titles(await countries("holland")), ["Netherlands"]);

    // The same fold, through the two-letter path. `UK` is not an ISO code, so
    // `toCountryCode` used to answer null for it and the picker offered both
    // "United Kingdom" and a bare "UK" — see that function's own note.
    setup({
      profiles: [{
        id: ALICE, handle: "a", name: "A", avatar_url: null, is_private: false,
        home_city: null, home_country: "UK", account_status: "active",
      }],
    });
    const uk = titles(await countries("uk"));
    assert.equal(uk[0], "United Kingdom");
    assert.equal(uk.filter((t) => t === "UK").length, 0, "the typed spelling does not list beside the canonical one");
    assert.equal(toCountryCode("UK"), "GB");
  });

  it("R11 — several countries match one query, and paging stays honest", async () => {
    setup({ profiles: [] });
    const r = await get("/discovery/search?q=united&type=countries&limit=2");
    const body = await r.json() as any;
    assert.equal(body.results.length, 2, "limit is respected");
    assert.equal(body.hasMore, true, "United Arab Emirates / Kingdom / States is more than two");
    assert.ok(body.nextCursor, "a next page is offered");
    const page2 = await get(`/discovery/search?q=united&type=countries&limit=2&cursor=${encodeURIComponent(body.nextCursor)}`);
    const body2 = await page2.json() as any;
    const all = [...titles(body.results), ...titles(body2.results)];
    assert.equal(new Set(all).size, all.length, "no row is served on two pages");
    assert.ok(all.includes("United States"));
    assert.ok(all.includes("United Kingdom"));
    assert.ok(all.includes("United Arab Emirates"));
  });
});
