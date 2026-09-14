/**
 * Phase 10 — CERTIFICATION (Global Input Intelligence, §49 Testing & Certification
 * Matrix). Closes the SAFETY-load-bearing coverage holes the nine phase suites did
 * not already lock, WITHOUT re-testing what they cover. Each test below is a
 * mutation-proof lock on a §49 dimension that was previously unproven:
 *
 *   PRIVACY (§29/§49) — precise-location leakage:
 *     A projected suggestion for a place/gem/event NEVER carries a coordinate,
 *     even when the internal SearchResult's metadata does. City-center coordinates
 *     in a picker binding are the intended PUBLIC §17/§53 value and are allowed;
 *     everything else is stripped at the projection boundary (§42).
 *
 *   PRIVACY (§29/§49) — private Trip/Event exclusion THROUGH the gateway:
 *     The unification layer delegates to dispatchSearch and does not bypass its
 *     visibility gate: a non-public (private) event is never surfaced by
 *     global_search, while a public one is. (discoverySearch.test.ts proves the
 *     gate itself; this proves the gateway preserves it end-to-end.)
 *
 *   FAILURE (§49) — provider/API error + partial degradation:
 *     A candidate-source table erroring never 500s the endpoint: the request still
 *     returns a well-formed 200 envelope, surviving sources still project (partial
 *     degradation), and a total data-layer failure degrades to an empty envelope
 *     (typeahead never surfaces an error mid-keystroke).
 *
 *   TELEMETRY (§44/§49) — no prohibited raw private-text capture:
 *     The explicit /select write records NOTHING for the private-text contexts
 *     (caption / comment / telegraph_message) — extends the existing username case
 *     to the fields that actually carry private prose — and every private-message /
 *     sensitive / viewer-scoped policy declares logRawText:false.
 *
 * Run: node --import tsx/esm --test src/test/inputAssistanceCertification.test.ts
 *
 * MUTATION-PROOFS (documented inline at each test).
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import inputAssistanceRouter from "../routes/inputAssistance.js";
import {
  projectSearchResult,
  projectCanonicalCity,
} from "../lib/inputAssistance/projection.js";
import { KNOWN_CONTEXTS, resolvePolicy, POLICY_VERSION } from "../lib/inputAssistance/policyRegistry.js";
import {
  rebuildTelemetryEvent,
  INPUT_TELEMETRY_EVENT_NAMES,
  TELEMETRY_EVENT_PROPS,
} from "../lib/inputAssistance/telemetry.js";
import type { SearchResult } from "../routes/discoverySearch.js";

// ── Stable test UUIDs ──────────────────────────────────────────────────────────
const ME = "aa000000-0000-4000-a000-000000000001";
const HOST = "dd000000-0000-4000-a000-000000000004";
const ME_TOK = "tok-me";

// ── Fake Supabase client (gateway harness + tableErrors + rpc capture) ──────────
interface FakeState { [key: string]: any[] | undefined; }
interface RpcCall { name: string; args: any; }
interface InsertCall { table: string; rows: any[]; }

function makeFakeClient(state: FakeState, tableErrors: Set<string>, rpcLog: RpcCall[], insertLog: InsertCall[]) {
  const errorBuilder: any = {};
  const errorFns = ["select", "eq", "neq", "in", "not", "is", "ilike", "or", "gte", "lt", "order", "limit", "range", "maybeSingle", "insert"];
  for (const fn of errorFns) errorBuilder[fn] = () => errorBuilder;
  errorBuilder.then = (onF: any, onR: any) =>
    Promise.resolve({ data: null, error: { message: "simulated DB error" } }).then(onF, onR);

  return {
    auth: {
      getUser: async (tok: string) =>
        tok === ME_TOK
          ? { data: { user: { id: ME } }, error: null }
          : { data: { user: null }, error: { message: "bad token" } },
    },
    rpc: async (name: string, args: any) => {
      rpcLog.push({ name, args });
      if (tableErrors.has(`rpc:${name}`)) return { data: null, error: { message: "simulated rpc error" } };
      return { data: null, error: null };
    },
    from: (table: string) => {
      if (tableErrors.has(table)) return errorBuilder;
      const sourceRows: any[] = [...(state[table] ?? [])];
      const filters: Array<(r: any) => boolean> = [];
      let _rangeStart = 0;
      let _rangeEnd = Infinity;
      let _limitN = Infinity;
      let profileCols: string[] | null = null;
      function project(rowsIn: any[]): any[] {
        if (table !== "profiles" || !profileCols) return rowsIn;
        return rowsIn.map((r) => Object.fromEntries(profileCols!.filter((c) => c in r).map((c) => [c, r[c]])));
      }
      const builder: any = {
        select(cols?: string) {
          if (table === "profiles" && typeof cols === "string" && cols !== "*") {
            profileCols = cols.split(",").map((c) => c.trim());
          }
          return builder;
        },
        eq(col: string, val: any) { filters.push((r) => r[col] === val); return builder; },
        neq(col: string, val: any) { filters.push((r) => r[col] !== val); return builder; },
        in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return builder; },
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
        lt(col: string, val: any) { filters.push((r) => r[col] != null && r[col] < val); return builder; },
        order() { return builder; },
        limit(n: number) { _limitN = n; return builder; },
        range(start: number, end: number) { _rangeStart = start; _rangeEnd = end; return builder; },
        maybeSingle() {
          const matched = project(sourceRows.filter((r) => filters.every((f) => f(r))));
          return Promise.resolve({ data: matched[0] ?? null, error: null });
        },
        // Writes. The §44 serve log is the first write path in this suite that
        // is not an RPC, so the fake needed an `insert`: rows land in
        // `insertLog` so a test can assert the SHAPE that was persisted, which
        // is the whole question for a telemetry table.
        insert(rows: any) {
          const arr = Array.isArray(rows) ? rows : [rows];
          insertLog.push({ table, rows: arr });
          state[table] = [...(state[table] ?? []), ...arr];
          return {
            then: (onF: any, onR: any) => Promise.resolve({ data: null, error: null }).then(onF, onR),
          };
        },
        then(onF: any, onR: any) {
          const matched = project(sourceRows
            .filter((r) => filters.every((f) => f(r)))
            .slice(_rangeStart, _rangeEnd < Infinity ? _rangeEnd + 1 : _limitN < Infinity ? _limitN : undefined));
          return Promise.resolve({ data: matched, error: null }).then(onF, onR);
        },
      };
      return builder;
    },
  };
}

// ── Deep coordinate scanner ─────────────────────────────────────────────────────
// Recursively walks a projected suggestion and returns every "path" that either
// (a) uses a coordinate-shaped key with a numeric value, or (b) holds a value
// exactly equal to one of the secret precise coordinates seeded below. A
// non-empty result means a precise location leaked.
const COORD_KEY = /(^|_)(lat|lng|latitude|longitude|coord|coordinates|geo)($|_)/i;
function findCoordLeaks(obj: unknown, secrets: number[], path = "$"): string[] {
  const hits: string[] = [];
  const walk = (v: unknown, p: string) => {
    if (v == null) return;
    if (typeof v === "number") {
      if (secrets.includes(v)) hits.push(`${p} == secret ${v}`);
      return;
    }
    if (typeof v === "string") {
      for (const s of secrets) if (v.includes(String(s))) hits.push(`${p} contains secret ${s}`);
      return;
    }
    if (Array.isArray(v)) { v.forEach((el, i) => walk(el, `${p}[${i}]`)); return; }
    if (typeof v === "object") {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (COORD_KEY.test(k) && typeof val === "number") hits.push(`${p}.${k} (coord-shaped key = ${val})`);
        walk(val, `${p}.${k}`);
      }
    }
  };
  walk(obj, path);
  return hits;
}

// ── Server + helpers ────────────────────────────────────────────────────────────
let base: string;
let server: Server;
let rpcLog: RpcCall[] = [];
let insertLog: InsertCall[] = [];

function setup(state: FakeState, tableErrors: string[] = []) {
  rpcLog = [];
  insertLog = [];
  _setTestClient(makeFakeClient(state, new Set(tableErrors), rpcLog, insertLog) as any, true);
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
beforeEach(() => { _resetRateLimit(); setup({}); });

function suggest(body: any, tok: string | null = ME_TOK) {
  return fetch(`${base}/input-assistance/suggest`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    body: JSON.stringify(body),
  });
}
function select(body: any, tok: string | null = ME_TOK) {
  return fetch(`${base}/input-assistance/select`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    body: JSON.stringify(body),
  });
}

function canonicalCity(name: string, normalized: string, opts: { lat?: number; lng?: number } = {}) {
  return {
    id: `canon-${normalized.replace(/\s+/g, "-")}`,
    kind: "city", name, normalized_name: normalized, display_name: `${name}, Vietnam`,
    city: null, region: null, country: "Vietnam", country_code: "VN",
    postal_code: null, lat: opts.lat ?? 16.06, lng: opts.lng ?? 108.22, provider_ids: {}, aliases: [],
  };
}

// The far-future ISO keeps events past the "upcoming-first" cutoff.
const UPCOMING = "2099-01-01T00:00:00.000Z";

// ═══════════════════════════════════════════════════════════════════════════════
// 1. PRIVACY — precise-location leakage (§29/§49). Projection boundary lock.
// ═══════════════════════════════════════════════════════════════════════════════

describe("§49 Privacy — precise location never leaks through the projection (§29/§42)", () => {
  // A hidden_gem SearchResult whose internal metadata carries an EXACT private
  // coordinate + street address. The projection must copy none of it.
  const SECRET_LAT = 16.123456;
  const SECRET_LNG = 108.654321;
  const gemResult: SearchResult = {
    id: "gem-1",
    type: "hidden_gems",
    title: "Secret Cove",
    subtitle: "Hidden Gem",
    avatarUrl: null,
    imageUrl: null,
    fallbackInitials: "SC",
    locationPreview: "Đà Nẵng",
    matchedReason: "name match",
    actionState: null,
    privacyState: { isPrivate: true },
    accessState: { canAccess: true },
    destinationRoute: "/gem/gem-1",
    // Adversarial: precise coords + address hidden inside internal metadata.
    metadata: { lat: SECRET_LAT, lng: SECRET_LNG, exactAddress: "12 Secret Alley", ownerId: HOST },
    createdAt: null,
    startsAt: null,
  };

  it("a hidden_gem projection carries NO coordinate or precise metadata (only display-safe fields)", () => {
    const s = projectSearchResult(gemResult, "global_search", POLICY_VERSION, "secret");
    // MUTATION-PROOF: make projectSearchResult copy `r.metadata` (or r.metadata.lat)
    // onto the suggestion and this deep scan finds the secret coordinate → RED.
    const leaks = findCoordLeaks(s, [SECRET_LAT, SECRET_LNG]);
    assert.deepEqual(leaks, [], `precise location must not leak: ${leaks.join("; ")}`);
    // The internal metadata object itself must never ride along (§42).
    assert.equal((s as any).metadata, undefined, "raw internal metadata must be dropped");
    assert.equal((s as any).exactAddress, undefined);
    assert.equal((s as any).accessState, undefined);
    assert.equal((s as any).privacyState, undefined);
    // But the row still resolves (§13): it opens the canonical entity.
    assert.equal(s.entityId, "gem-1");
    assert.ok(s.action, "row must still be actionable");
  });

  it("a place projection is coordinate-free even with coords in metadata", () => {
    const placeResult: SearchResult = { ...gemResult, id: "place-1", type: "places", destinationRoute: "/place/place-1" };
    const s = projectSearchResult(placeResult, "place_picker", POLICY_VERSION, "secret");
    assert.deepEqual(findCoordLeaks(s, [SECRET_LAT, SECRET_LNG]), []);
  });

  it("a city picker binding carries ONLY the public city-center coordinate (the intended §17/§53 value)", () => {
    // City-center coordinates are PUBLIC geography and ARE the binding the field
    // stores on selection. This documents the boundary: the ONLY coordinate a
    // suggestion may carry is a canonical city's public center, never a private
    // place/gem's precise location.
    const row = canonicalCity("Da Nang", "da nang", { lat: 16.0678, lng: 108.2208 });
    const s = projectCanonicalCity(row as any, "city_picker", POLICY_VERSION, "da");
    const binding = s.structuredValue as any;
    assert.ok(binding, "a picker city binds a structured value");
    assert.equal(binding.lat, 16.0678, "binding carries the PUBLIC city-center lat");
    assert.equal(binding.lng, 108.2208);
    // And it is the public city center — never a hidden precise coordinate.
    assert.equal(s.entityType, "city");
  });

  it("gateway response: no suggestion leaks a private coordinate for an event search", async () => {
    setup({
      events: [{
        id: "evt-pub", title: "Riverside Night Market", host_id: HOST, city: "Da Nang",
        country: "Vietnam", starts_at: UPCOMING, visibility: "public", state: "published",
        // Adversarial: a precise coord smuggled into the row — must never reach the client.
        lat: 16.111222, lng: 108.333444, created_at: "2026-01-01T00:00:00Z",
      }],
      profiles: [{ id: HOST, account_status: "active" }],
      event_rsvps: [], blocks: [], user_privacy_settings: [], canonical_locations: [],
    });
    const r = await suggest({ context: "global_search", text: "Riverside Night" });
    const body = await r.json() as any;
    const evt = body.suggestions.find((s: any) => s.entityId === "evt-pub");
    assert.ok(evt, "the public event should surface");
    assert.deepEqual(
      findCoordLeaks(body.suggestions, [16.111222, 108.333444]),
      [],
      "no event coordinate may reach the client",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. PRIVACY — private Trip/Event exclusion THROUGH the gateway (§29/§49).
// ═══════════════════════════════════════════════════════════════════════════════

describe("§49 Privacy — the gateway preserves dispatchSearch's visibility gate (§29)", () => {
  it("global_search surfaces a PUBLIC event but never a stranger's PRIVATE event", async () => {
    setup({
      events: [
        { id: "evt-pub", title: "Paris Jazz Festival", host_id: HOST, city: "Paris", country: "France", starts_at: UPCOMING, visibility: "public", state: "published", created_at: "2026-01-01T00:00:00Z" },
        { id: "evt-priv", title: "Paris Jazz Afterparty", host_id: HOST, city: "Paris", country: "France", starts_at: UPCOMING, visibility: "private", state: "published", created_at: "2026-01-01T00:00:00Z" },
      ],
      profiles: [{ id: HOST, account_status: "active" }],
      event_rsvps: [], blocks: [], user_privacy_settings: [], canonical_locations: [],
    });
    const r = await suggest({ context: "global_search", text: "Paris Jazz" });
    const body = await r.json() as any;
    const ids = new Set(body.suggestions.map((s: any) => s.entityId));
    // MUTATION-PROOF: drop the `.eq("visibility","public")` filter in searchEvents
    // and the private event surfaces → this assertion goes RED.
    assert.ok(ids.has("evt-pub"), "the public event must surface through the gateway");
    assert.ok(!ids.has("evt-priv"), "a private event must NEVER surface through the gateway");
  });

  it("global_search surfaces a PUBLIC trip but never a stranger's PRIVATE trip", async () => {
    setup({
      trips: [
        { id: "trip-pub", title: "Bali Getaway", owner_id: HOST, destination_city: "Bali", destination_country: "Indonesia", start_date: "2099-01-01", status: "planning", visibility: "public", show_in_discovery: true, created_at: "2026-01-01T00:00:00Z" },
        { id: "trip-priv", title: "Bali Honeymoon", owner_id: HOST, destination_city: "Bali", destination_country: "Indonesia", start_date: "2099-01-01", status: "planning", visibility: "private", show_in_discovery: false, created_at: "2026-01-01T00:00:00Z" },
      ],
      profiles: [{ id: HOST, account_status: "active" }],
      blocks: [], user_privacy_settings: [], canonical_locations: [],
    });
    const r = await suggest({ context: "global_search", text: "Bali" });
    const body = await r.json() as any;
    const ids = new Set(body.suggestions.map((s: any) => s.entityId));
    assert.ok(ids.has("trip-pub"), "the public trip must surface through the gateway");
    assert.ok(!ids.has("trip-priv"), "a private trip must NEVER surface through the gateway");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. FAILURE — provider/API error + partial degradation (§49).
// ═══════════════════════════════════════════════════════════════════════════════

describe("§49 Failure — the endpoint never 500s mid-keystroke; degrades gracefully", () => {
  it("partial degradation: one candidate source erroring still returns the surviving sources (200)", async () => {
    // A matching canonical city resolves, but the `events` table is hard-erroring.
    // The per-source .catch keeps the city; the endpoint is a healthy 200.
    setup(
      {
        canonical_locations: [canonicalCity("Da Nang", "da nang")],
        blocks: [], user_privacy_settings: [],
      },
      ["events"], // events table errors
    );
    const r = await suggest({ context: "global_search", text: "da nang" });
    assert.equal(r.status, 200, "a failing source must not 500 the request");
    const body = await r.json() as any;
    assert.ok(Array.isArray(body.suggestions));
    assert.ok(
      body.suggestions.some((s: any) => s.entityType === "city"),
      "the surviving canonical-city source must still project (partial degradation)",
    );
  });

  it("total data-layer failure degrades to a well-formed EMPTY 200 envelope (never an error mid-keystroke)", async () => {
    // Every SUGGESTION SOURCE the request touches errors. The route's try/catch
    // guarantees a 200 with an empty, well-formed envelope carrying requestId +
    // policyVersion.
    //
    // `profiles` was in this list and has been moved to the test below. It is
    // not a suggestion source: it is `requireUser`'s ban gate (lib/http.ts), and
    // since A1 an unreadable `account_status` is refused before the route body
    // runs. Erroring it here conflated two layers and would have let a change to
    // the AUTH gate pass or fail this DATA-layer certification by accident. The
    // data-layer guarantee is unchanged and is what this test still asserts.
    setup({}, ["canonical_locations", "blocks", "user_privacy_settings", "events", "trips", "places", "hidden_gems"]);
    const r = await suggest({ context: "global_search", text: "da nang" });
    assert.equal(r.status, 200, "a total failure must still be a 200 (typeahead never shows an error)");
    const body = await r.json() as any;
    assert.equal(body.policyVersion, POLICY_VERSION);
    assert.equal(body.context, "global_search");
    assert.ok(typeof body.requestId === "string" && body.requestId.length > 0);
    assert.ok(Array.isArray(body.suggestions), "suggestions is always a well-formed array");
  });

  it("an unreadable `profiles` is the BAN GATE failing, and outranks the never-error rule", async () => {
    // The one exception to "typeahead never shows an error", stated on purpose
    // rather than inherited from the list above. `profiles.account_status` is
    // the only ban enforcement point in the system — there is no session
    // revocation anywhere — so a request whose ban check did not run may not be
    // served, not even an empty list. The answer is the retryable
    // `degraded_unavailable`, which means "the check was not performed", not
    // "you are banned" and not "there is nothing here".
    setup({}, ["profiles"]);
    const r = await suggest({ context: "global_search", text: "da nang" });
    assert.equal(r.status, 503, "an unchecked ban gate must not be served a 200");
    const body = await r.json() as any;
    assert.equal(body.error, "degraded_unavailable");
    assert.equal(body.retryable, true, "the client must retry, not re-authenticate");
  });

  it("empty result: a no-match query returns a clean 200 with an empty (or completion-only) list", async () => {
    setup({ canonical_locations: [], blocks: [], user_privacy_settings: [] });
    const r = await suggest({ context: "city_picker", text: "zzzznowheresville" });
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.ok(Array.isArray(body.suggestions));
    // city_picker has no `completion` type → a genuine no-match is simply empty,
    // never a dead/fabricated row.
    assert.equal(body.suggestions.length, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. TELEMETRY — no prohibited raw private-text capture (§44/§49).
// ═══════════════════════════════════════════════════════════════════════════════

describe("§49 Telemetry — the /select write never captures raw private text (§44)", () => {
  // The private-text contexts: fields whose typed content is private prose. None
  // allow personalization, so recordSelection must refuse and write NOTHING —
  // there is no path by which a caption/comment/DM body reaches persistence.
  for (const context of ["caption", "comment", "telegraph_message"] as const) {
    it(`/select records NOTHING for a private-text context (${context})`, async () => {
      setup({ profiles: [], input_selection_history: [] });
      const r = await select({
        context,
        entityType: "user",
        entityId: HOST,
        // A raw private phrase in the query — must never be persisted.
        query: "meet me at my private address tonight",
        label: "someone",
      });
      const body = await r.json() as any;
      assert.equal(r.status, 200);
      // MUTATION-PROOF: remove the `if (!policy.allowPersonalization) return …`
      // gate in recordSelection and one of these contexts records → RED.
      assert.equal(body.recorded, false, `${context} must not be recorded`);
      const writes = rpcLog.filter((c) => c.name === "input_record_selection");
      assert.equal(writes.length, 0, `${context}: no raw-text-bearing write may occur`);
    });
  }

  it("every private-message / sensitive / viewer-scoped policy declares logRawText:false (§44)", () => {
    // The declared invariant behind the write-path gate: fields that could carry
    // private text never opt into raw-text logging.
    for (const context of KNOWN_CONTEXTS) {
      const p = resolvePolicy(context)!;
      if (["private_message", "sensitive_location", "viewer_scoped"].includes(p.privacyClass)) {
        assert.equal(
          p.telemetryPolicy.logRawText,
          false,
          `${context} (${p.privacyClass}) must declare logRawText:false`,
        );
      }
    }
    // And no registered policy anywhere opts into raw-text logging in Phase-1..10.
    for (const context of KNOWN_CONTEXTS) {
      assert.equal(resolvePolicy(context)!.telemetryPolicy.logRawText, false,
        `${context}: no field may log raw text`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. TELEMETRY — the DESTINATION (§40 SuggestionTelemetryService, §44, §57).
//
// Census G292 graded the server-side telemetry service NOT-BUILT with the
// sentence "There is no server-side telemetry service, no serve log, no
// impression record and no analytics write anywhere in lib/inputAssistance/",
// and G263/G306/G355/G365/G366/G367 all name the same blocker: the client
// emits nine §44 events into a sink that is `() => {}`.
//
// These tests are about the half that can be settled from the server: a real
// ingest endpoint, a payload REBUILT from a per-event allow-list rather than
// accepted, the field's own telemetryPolicy enforced at ingest, and — the rule
// this repo keeps relearning — a bound write error answered as a RETRYABLE
// REFUSAL rather than as a successful empty result.
// ═══════════════════════════════════════════════════════════════════════════════

function telemetry(body: any, tok: string | null = ME_TOK) {
  return fetch(`${base}/input-assistance/telemetry`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    body: JSON.stringify(body),
  });
}

const TELEMETRY_TABLE = "input_assistance_telemetry_events";
// Recent by construction: the service CLAMPS a timestamp more than seven days
// from the server's clock (a sleeping device's clock corrupts every window
// query silently), so a hard-coded literal would rot into that branch.
const NOW_ISH = Date.now() - 1_000;
function telemetryRows() {
  return insertLog.filter((c) => c.table === TELEMETRY_TABLE).flatMap((c) => c.rows);
}

describe("§44 telemetry ingest — the serve log the client had no destination for", () => {
  it("accepts an allowlisted event and persists it to the serve log", async () => {
    setup({ [TELEMETRY_TABLE]: [] });
    const r = await telemetry({
      sessionId: "sess-abc",
      events: [
        {
          name: "suggestion_rendered",
          context: "global_search",
          fieldId: "global_search",
          at: NOW_ISH,
          requestId: "req-1",
          props: { count: 5, types: "entity,recent" },
        },
      ],
    });
    const body = (await r.json()) as any;
    assert.equal(r.status, 200, "an accepted batch answers 200");
    assert.equal(body.ok, true);
    assert.equal(body.accepted, 1, "the event was accepted");
    assert.equal(body.rejected, 0);

    const rows = telemetryRows();
    assert.equal(rows.length, 1, "exactly one row was written");
    assert.equal(rows[0].event_name, "suggestion_rendered");
    assert.equal(rows[0].session_id, "sess-abc");
    assert.equal(rows[0].request_id, "req-1", "§44 action/result linkage: the serve's requestId travels");
    assert.equal(rows[0].context, "global_search");
    assert.equal(rows[0].props.count, 5);
    assert.equal(rows[0].props.types, "entity,recent");
    assert.equal(typeof rows[0].policy_version, "string");
    assert.equal(rows[0].occurred_at, new Date(NOW_ISH).toISOString());
  });

  it("REBUILDS the props from an allow-list — an unknown key cannot ride along", async () => {
    setup({ [TELEMETRY_TABLE]: [] });
    // THE CONTEXT HERE IS LOAD-BEARING and the first draft of this test got it
    // wrong. It used `telegraph_message`, whose policy does not declare
    // `suggestion_rendered` at all — so the event was refused by the POLICY
    // gate, nothing was ever written, and every assertion below ran over an
    // EMPTY array. The test passed with the rebuild replaced by a wholesale
    // `{...incoming}` copy, which is precisely the mutation it exists to catch.
    // `global_search` declares the event, so the row IS written and the rebuild
    // is the only thing standing between these props and the table. The
    // `rows.length === 1` assertion below is what keeps it that way.
    const r = await telemetry({
      sessionId: "sess-abc",
      events: [
        {
          name: "suggestion_rendered",
          context: "global_search",
          fieldId: "global_search",
          at: NOW_ISH,
          props: {
            count: 2,
            // Every one of these is a key the allow-list for this event does
            // not name. A denylist would have to be complete to stop them; a
            // rebuild stops them because they are simply never copied.
            query: "meet me at my private address tonight",
            message: "see you at 9",
            label: "Alice Nguyen",
            userId: "aa000000-0000-4000-a000-000000000001",
            note: "anything at all",
          },
        },
      ],
    });
    const body = (await r.json()) as any;
    assert.equal(r.status, 200);
    assert.equal(body.accepted, 1, "the event must be ACCEPTED — otherwise the assertions below are vacuous");
    const rows = telemetryRows();
    assert.equal(rows.length, 1, "exactly one row must have been written for this test to mean anything");
    assert.equal(rows[0].props.count, 2, "the allowlisted prop survives");
    const persisted = JSON.stringify(rows);
    for (const forbidden of ["private address", "see you at 9", "Alice Nguyen", "anything at all"]) {
      assert.ok(!persisted.includes(forbidden), `raw content "${forbidden}" reached the serve log`);
    }
    for (const row of rows) {
      for (const k of ["query", "message", "label", "userId", "note", "text", "rawText"]) {
        assert.ok(!(k in row.props), `prop key "${k}" survived the rebuild`);
      }
    }
  });

  it("enforces the FIELD'S OWN telemetryPolicy — an undeclared event is refused, not stored", async () => {
    setup({ [TELEMETRY_TABLE]: [] });
    // telegraph_message declares METADATA_ONLY_TELEMETRY: it participates in
    // suggestion_request_completed / suggestion_selected / action_completed and
    // nothing else. §44 says a private-message field prefers metadata events;
    // an impression of a RECIPIENT LIST is a list of people and this field did
    // not opt into it.
    const r = await telemetry({
      sessionId: "sess-abc",
      events: [
        { name: "suggestion_rendered", context: "telegraph_message", fieldId: "telegraph_message", at: NOW_ISH, props: { count: 3 } },
        { name: "suggestion_selected", context: "telegraph_message", fieldId: "telegraph_message", at: NOW_ISH + 1, props: { suggestionType: "entity" } },
      ],
    });
    const body = (await r.json()) as any;
    assert.equal(r.status, 200);
    assert.equal(body.accepted, 1, "only the declared event is accepted");
    assert.equal(body.rejected, 1, "the undeclared event is REFUSED, not silently dropped from the count");
    const names = telemetryRows().map((x) => x.event_name);
    assert.deepEqual(names, ["suggestion_selected"]);
  });

  it("refuses an unknown event name and an unknown context", async () => {
    setup({ [TELEMETRY_TABLE]: [] });
    const r = await telemetry({
      sessionId: "sess-abc",
      events: [
        { name: "not_an_event", context: "global_search", fieldId: "global_search", at: NOW_ISH },
        { name: "input_opened", context: "not_a_context", fieldId: "x", at: NOW_ISH },
      ],
    });
    const body = (await r.json()) as any;
    assert.equal(body.accepted, 0);
    assert.equal(body.rejected, 2);
    assert.equal(telemetryRows().length, 0, "nothing is written when nothing is valid");
  });

  it("a BOUND write error answers a RETRYABLE refusal — never ok:true with accepted:0", async () => {
    // THE DEFECT CLASS THIS LOCKS. supabase-js RESOLVES on a database error
    // rather than throwing, so a discarded `error` is byte-identical to "the
    // write succeeded and there was nothing to do". A telemetry route that
    // answers `{ok:true, accepted:0}` on a failed insert is indistinguishable
    // from one whose table is simply empty, and migration 2950 is NOT APPLIED
    // to any database — so this is the state the route is actually in today.
    setup({ [TELEMETRY_TABLE]: [] }, [TELEMETRY_TABLE]);
    const r = await telemetry({
      sessionId: "sess-abc",
      events: [{ name: "input_opened", context: "global_search", fieldId: "global_search", at: NOW_ISH }],
    });
    const body = (await r.json()) as any;
    assert.equal(r.status, 503, "a failed write is a refusal, not a success");
    assert.equal(body.ok, false);
    assert.equal(body.retryable, true, "the caller is told the refusal is retryable");
    assert.notEqual(body.accepted, 1);
  });

  it("an unauthenticated caller cannot write to the serve log", async () => {
    setup({ [TELEMETRY_TABLE]: [] });
    const r = await telemetry({ sessionId: "s", events: [{ name: "input_opened", context: "global_search", fieldId: "global_search", at: 1 }] }, null);
    assert.ok(r.status === 401 || r.status === 403, `expected a refusal, got ${r.status}`);
    assert.equal(telemetryRows().length, 0);
  });

  it("the batch is bounded — an oversized batch is refused whole", async () => {
    setup({ [TELEMETRY_TABLE]: [] });
    const events = Array.from({ length: 200 }, (_, i) => ({
      name: "input_opened", context: "global_search", fieldId: "global_search", at: NOW_ISH + i,
    }));
    const r = await telemetry({ sessionId: "sess-abc", events });
    assert.equal(r.status, 400, "an unbounded batch is a payload error, not a partial success");
    assert.equal(telemetryRows().length, 0);
  });

  it("a device clock days out of step is CLAMPED, not trusted", async () => {
    // A sleeping or misconfigured device reports an `at` from another year. Left
    // alone it would corrupt every window query in a way nothing reports, and
    // refusing the event would throw away a real impression over a bad clock.
    setup({ [TELEMETRY_TABLE]: [] });
    const before = Date.now();
    const r = await telemetry({
      sessionId: "sess-abc",
      events: [{ name: "input_opened", context: "global_search", fieldId: "global_search", at: 1757000000000 }],
    });
    assert.equal(r.status, 200);
    const rows = telemetryRows();
    assert.equal(rows.length, 1, "the event is kept — only its timestamp is not trusted");
    const stored = Date.parse(rows[0].occurred_at);
    assert.ok(stored >= before - 1000 && stored <= Date.now() + 1000,
      `clamped timestamp expected near now, got ${rows[0].occurred_at}`);
  });

  it("a STANDARD field's policy admits the whole funnel SmartInput actually emits", async () => {
    // WHY THIS TEST EXISTS. `STANDARD_TELEMETRY` named five of §44's fourteen
    // events while nothing read it. Now that the ingest route enforces it, a
    // five-name list would SILENTLY DISCARD nine of the arms SmartInput emits —
    // the ignored arm, the edited arm, the validation impression, both §10/§19
    // acceptance events — which is the very gap Phase 11 built those call sites
    // to close, reintroduced one layer down.
    //
    // Narrowing the list back is a mutation that nothing else here catches:
    // every other assertion in this block is about REFUSAL, so a policy that
    // refuses more passes them all. This is the counterweight.
    setup({ [TELEMETRY_TABLE]: [] });
    const emitted = [
      "input_opened",
      "query_length_changed",
      "suggestion_request_started",
      "suggestion_request_completed",
      "suggestion_rendered",
      "suggestion_selected",
      "suggestion_dismissed",
      "raw_search_submitted",
      "manual_value_kept",
      "validation_shown",
      "correction_accepted",
      "disambiguation_selected",
      "action_completed",
      "downstream_task_completed",
    ];
    const r = await telemetry({
      sessionId: "sess-abc",
      events: emitted.map((name, i) => ({
        name, context: "global_search", fieldId: "global_search", at: NOW_ISH + i,
      })),
    });
    const body = (await r.json()) as any;
    assert.equal(r.status, 200);
    assert.equal(body.rejected, 0, "a standard field must not refuse an arm its own SmartInput emits");
    assert.equal(body.accepted, emitted.length);
    assert.deepEqual(telemetryRows().map((x) => x.event_name), emitted);
  });

  // ── The vocabulary gate, tested where the policy gate cannot mask it ────────
  //
  // WHY THESE TWO ARE UNIT TESTS AND THE REST ARE ROUTE TESTS. The first draft
  // proved the event-name check through the endpoint, and the check SURVIVED
  // being deleted: an unknown name is also a name no policy declares, so the
  // POLICY gate refused it first and the route's counts were identical either
  // way. The name gate's real job only becomes visible when a policy DOES
  // declare a name the §44 vocabulary does not have — which is exactly the
  // drift that would put a row past the application and into migration 2950's
  // `iate_event_name_known` CHECK, where it fails the whole insert batch.

  it("refuses a name outside the §44 vocabulary EVEN IF a field policy declares it", () => {
    const base = resolvePolicy("global_search")!;
    const drifted = {
      ...base,
      telemetryPolicy: { logRawText: false, events: ["not_an_event"] },
    };
    const out = rebuildTelemetryEvent(
      { name: "not_an_event", context: "global_search", fieldId: "global_search", at: Date.now() },
      "sess-abc",
      drifted,
      POLICY_VERSION,
      Date.now(),
    );
    // MUTATION-PROOF: replace the KNOWN_EVENT_NAMES check with a
    // `name.length === 0` check and this goes red (it throws on the missing
    // TELEMETRY_EVENT_PROPS entry instead of refusing cleanly).
    assert.equal(out.ok, false, "a name outside the vocabulary must never be rebuilt");
    assert.equal((out as { reason: string }).reason, "unknown_event_name");
  });

  it("every event name any registered policy declares is in the §44 vocabulary", () => {
    // The drift ratchet between policyRegistry.ts and migration 2950's
    // `iate_event_name_known` CHECK. A name declared by a policy but absent
    // from the vocabulary would be accepted by the policy gate and then
    // rejected by the DATABASE, failing the whole batch — the loudest possible
    // place to discover a one-word typo.
    const vocabulary = new Set<string>(INPUT_TELEMETRY_EVENT_NAMES);
    for (const context of KNOWN_CONTEXTS) {
      for (const name of resolvePolicy(context)!.telemetryPolicy.events) {
        assert.ok(vocabulary.has(name), `${context} declares "${name}", which §44 does not name`);
      }
    }
    // And the vocabulary and the prop allow-list are the same set, so no name
    // can reach the rebuild without a declared prop shape.
    assert.deepEqual(
      [...INPUT_TELEMETRY_EVENT_NAMES].sort(),
      Object.keys(TELEMETRY_EVENT_PROPS).sort(),
    );
  });

  it("the suggest envelope carries SERVER TIMING (census G372 — 'the response carries no server timing')", async () => {
    setup({ profiles: [] });
    const r = await suggest({ context: "global_search", text: "bangkok" });
    const body = (await r.json()) as any;
    assert.equal(r.status, 200);
    assert.equal(typeof body.serverMs, "number", "the serve's own latency must travel with the serve");
    assert.ok(body.serverMs >= 0 && body.serverMs < 60_000);
  });
});
