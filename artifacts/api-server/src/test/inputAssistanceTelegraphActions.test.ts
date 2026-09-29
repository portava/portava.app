/**
 * §21 / §54 Smart action suggestions in a Telegraph message (GII-F10, WP-19).
 *
 * Run: node --import tsx/esm --test src/test/inputAssistanceTelegraphActions.test.ts
 *
 * Spec §54, verbatim: User types "meet at" → Context = telegraph_message → No
 * aggressive text autocomplete → Action candidates: Share meeting point / Share
 * Trip stop / Share current Place → Eligibility checks → User taps action →
 * Structured entity share inserted into message composer.
 *
 * Proven here through the REAL suggest route and the REAL gateway (only the
 * Supabase client — the database's wire — is faked):
 *   G362  "meet at …" in `telegraph_message` produces the three §54 candidates,
 *         and NOTHING ELSE — no entity/text completion rows (§54 "no aggressive
 *         text autocomplete").
 *   G133  meeting point resolves the typed place through the place picker's own
 *         gateway serve (same privacy gate, same ranking), and carries a
 *         structured LOCATION draft the composer inserts.
 *         Trip stop reads the VIEWER'S OWN Trips only (non-invited membership).
 *   ELIGIBILITY  a viewer with no Trip stops gets an INELIGIBLE candidate with a
 *         reason (not a missing one); current Place is marked as needing the
 *         device's location, which only the device can check.
 *   FAILURE HONESTY  an unreadable Trip read is a coverage refusal on the
 *         envelope, never "you have no Trip stops".
 *   §48  a client that cannot resolve `set_structured_value` is served none.
 *   Nothing is written.
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import inputAssistanceRouter from "../routes/inputAssistance.js";
import { parseMeetAt } from "../lib/inputAssistance/telegraphActions.js";

const ME = "aa000000-0000-4000-a000-000000000001";
const OTHER = "bb000000-0000-4000-a000-000000000002";
const ME_TOK = "tok-me";

interface FakeState { [key: string]: any[] | undefined }
const writes: string[] = [];

function makeFakeClient(state: FakeState, tableErrors: Set<string> = new Set()) {
  const errorBuilder: any = {};
  for (const fn of ["select","eq","neq","in","not","is","ilike","or","gte","lt","order","limit","range","maybeSingle"]) {
    errorBuilder[fn] = () => errorBuilder;
  }
  errorBuilder.then = (onF: any, onR: any) =>
    Promise.resolve({ data: null, error: { message: "simulated DB error" } }).then(onF, onR);
  const likeRe = (pat: string) =>
    new RegExp("^" + pat.replace(/\\([%_])/g, "$1").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$", "i");

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
        ilike(c: string, pat: string) { const re = likeRe(pat); filters.push((r) => re.test(String(r[c] ?? ""))); return builder; },
        or(expr: string) {
          const parts = expr.split(",").map((p) => p.trim().match(/^(\w+)\.(\w+)\.(.+)$/)).filter(Boolean) as RegExpMatchArray[];
          filters.push((r) => parts.some((m) => {
            const cell = String(r[m[1]!] ?? "");
            return m[2]!.toLowerCase() === "ilike" ? likeRe(m[3]!).test(cell) : m[2] === "eq" ? cell === m[3] : false;
          }));
          return builder;
        },
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

function place(id: string, name: string, city: string) {
  return {
    id, name, city, blurb: null, image_url: null, header_image_source: null,
    image_source_type: null, image_accuracy_status: null, category: "landmark",
    primary_category: "landmark", lat: 16.06, lng: 108.22, canonical_location_id: null,
    created_at: "2026-01-01T00:00:00Z", submitted_by: null, status: "active", saved_count: 3,
  };
}

const TRIP = { id: "trip-1", owner_id: ME, title: "Central Vietnam", status: "upcoming", start_date: "2026-10-10", destination_city: "Da Nang", destination_country: "Vietnam" };
const NOT_MINE = { id: "trip-2", owner_id: OTHER, title: "Someone else's", status: "upcoming", start_date: "2026-10-12", destination_city: "Hue", destination_country: "Vietnam" };
const STATE: FakeState = {
  profiles: [{ id: ME, account_status: "active" }],
  blocks: [], user_privacy_settings: [], profile_privacy_settings: [], canonical_locations: [],
  discovery_places: [place("place-dragon", "Dragon Bridge", "Da Nang")],
  trip_members: [
    { trip_id: "trip-1", user_id: ME, role: "owner" },
    { trip_id: "trip-2", user_id: ME, role: "invited" },
  ],
  trips: [TRIP, NOT_MINE],
  trip_destinations: [
    { id: "dest-1", trip_id: "trip-1", city: "Hoi An", country: "Vietnam", place_id: null, position: 1 },
    { id: "dest-2", trip_id: "trip-2", city: "Hue", country: "Vietnam", place_id: null, position: 1 },
  ],
};

const COMPOSER_CLIENT = { schemaVersion: 1, suggestionTypes: ["action"], actionTypes: ["set_structured_value"] };

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
});
after(() => server.close());
beforeEach(() => { _resetRateLimit(); writes.length = 0; _setTestClient(makeFakeClient(STATE) as any, true); });
afterEach(() => assert.deepEqual(writes, [], "suggesting an action must never write"));

async function suggest(text: string, client: unknown = COMPOSER_CLIENT) {
  const r = await fetch(`${base}/input-assistance/suggest`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${ME_TOK}` },
    body: JSON.stringify({ context: "telegraph_message", fieldId: "telegraph.message", text, client }),
  });
  assert.equal(r.status, 200);
  return (await r.json()) as any;
}

const shareOf = (s: any) => s.structuredValue?.telegraphShare;

describe("parseMeetAt — the phrase §54 names", () => {
  it("finds the place text after 'meet at', and ignores a time", () => {
    assert.deepEqual(parseMeetAt("ok let's meet at Dragon Bridge"), { placeText: "Dragon Bridge" });
    assert.deepEqual(parseMeetAt("meet me outside Han Market at 8pm"), { placeText: "Han Market" });
    assert.deepEqual(parseMeetAt("meet at 7"), { placeText: "" });
    assert.deepEqual(parseMeetAt("Meet at"), { placeText: "" });
    assert.equal(parseMeetAt("see you there"), null);
    assert.equal(parseMeetAt("the meeting at noon went well"), null);
  });
});

describe("POST /suggest (telegraph_message) — §54 action candidates (G362/G133)", () => {
  it("'meet at Dragon Bridge' offers the three shares, with the typed place resolved", async () => {
    const body = await suggest("meet at Dragon Bridge");
    const shares = body.suggestions.map(shareOf);
    assert.ok(shares.includes("meeting_point"));
    assert.ok(shares.includes("trip_stop"));
    assert.ok(shares.includes("current_place"));
    // §54 "no aggressive text autocomplete": every row is an ACTION.
    for (const s of body.suggestions) {
      assert.equal(s.type, "action");
      assert.equal(s.action.type, "set_structured_value");
    }
    const meet = body.suggestions.find((s: any) => shareOf(s) === "meeting_point");
    assert.equal(meet.structuredValue.eligible, true);
    assert.deepEqual(meet.structuredValue.draft, { label: "Dragon Bridge", placeId: "place-dragon", precision: "venue" });
    assert.equal(body.refusal, undefined, "everything was readable");
  });

  it("Trip stops are the viewer's OWN (an invitation is not a membership)", async () => {
    const body = await suggest("meet at");
    const stops = body.suggestions.filter((s: any) => shareOf(s) === "trip_stop");
    assert.deepEqual(stops.map((s: any) => s.structuredValue.draft?.label).sort(), ["Da Nang", "Hoi An"]);
    assert.ok(stops.every((s: any) => s.structuredValue.eligible === true));
    assert.ok(!JSON.stringify(body).includes("Hue"), "a Trip the viewer is only invited to is not theirs to share");
  });

  it("no Trip stops → an INELIGIBLE candidate with a reason, not a missing one", async () => {
    _setTestClient(makeFakeClient({ ...STATE, trip_members: [], trips: [] }) as any, true);
    const body = await suggest("meet at");
    const stop = body.suggestions.find((s: any) => shareOf(s) === "trip_stop");
    assert.ok(stop, "the candidate is shown");
    assert.equal(stop.structuredValue.eligible, false);
    assert.match(stop.structuredValue.ineligibleReason, /no upcoming trip/i);
  });

  it("an UNREADABLE Trip read is a refusal, never 'you have no Trip stops'", async () => {
    _setTestClient(makeFakeClient(STATE, new Set(["trip_members"])) as any, true);
    const body = await suggest("meet at");
    assert.ok(body.refusal, "the envelope says a source was unreadable");
    assert.deepEqual(body.refusal.failedSources, ["trip_stops"]);
    const stop = body.suggestions.find((s: any) => shareOf(s) === "trip_stop");
    assert.equal(stop, undefined, "no ineligible 'you have none' row is invented from a failed read");
  });

  it("current Place is offered as needing the DEVICE's location — the server cannot grant it", async () => {
    const body = await suggest("meet at");
    const here = body.suggestions.find((s: any) => shareOf(s) === "current_place");
    assert.equal(here.structuredValue.requires, "device_location");
    assert.equal(here.structuredValue.draft, null, "the server never invents where the sender is");
  });

  it("a message that is not 'meet at' gets no action takeover", async () => {
    const body = await suggest("running late, sorry");
    assert.ok(!body.suggestions.some((s: any) => shareOf(s)));
  });

  it("§48: a client that cannot resolve set_structured_value is served none of them", async () => {
    const body = await suggest("meet at Dragon Bridge", { schemaVersion: 1, actionTypes: ["open_entity"] });
    assert.ok(!body.suggestions.some((s: any) => shareOf(s)));
    assert.ok(body.capabilities.withheldForClient > 0);
  });
});
