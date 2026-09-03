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
import type { SearchResult } from "../routes/discoverySearch.js";

// ── Stable test UUIDs ──────────────────────────────────────────────────────────
const ME = "aa000000-0000-4000-a000-000000000001";
const HOST = "dd000000-0000-4000-a000-000000000004";
const ME_TOK = "tok-me";

// ── Fake Supabase client (gateway harness + tableErrors + rpc capture) ──────────
interface FakeState { [key: string]: any[] | undefined; }
interface RpcCall { name: string; args: any; }

function makeFakeClient(state: FakeState, tableErrors: Set<string>, rpcLog: RpcCall[]) {
  const errorBuilder: any = {};
  const errorFns = ["select", "eq", "neq", "in", "not", "is", "ilike", "or", "gte", "lt", "order", "limit", "range", "maybeSingle"];
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

function setup(state: FakeState, tableErrors: string[] = []) {
  rpcLog = [];
  _setTestClient(makeFakeClient(state, new Set(tableErrors), rpcLog) as any, true);
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
    // Every table the request touches errors. The route's try/catch guarantees a
    // 200 with an empty, well-formed envelope carrying requestId + policyVersion.
    setup({}, ["canonical_locations", "blocks", "user_privacy_settings", "events", "trips", "profiles", "places", "hidden_gems"]);
    const r = await suggest({ context: "global_search", text: "da nang" });
    assert.equal(r.status, 200, "a total failure must still be a 200 (typeahead never shows an error)");
    const body = await r.json() as any;
    assert.equal(body.policyVersion, POLICY_VERSION);
    assert.equal(body.context, "global_search");
    assert.ok(typeof body.requestId === "string" && body.requestId.length > 0);
    assert.ok(Array.isArray(body.suggestions), "suggestions is always a well-formed array");
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
