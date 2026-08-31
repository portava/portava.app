/**
 * Phase 3 — Global Search (§13): the global_search InputContext returns a
 * complete mixed-entity typeahead through the Phase-1 gateway.
 *
 * Run: node --import tsx/esm --test src/test/inputAssistanceGlobalSearch.test.ts
 *
 * Proves the §13 contract on top of the Phase-1 gateway:
 *   - A query returns MIXED typed groups — place + person + hidden gem + a
 *     "SEARCH FOR" query completion — each carrying a RESOLVABLE §43 action
 *     (open_entity for entities, submit_search for the completion). §13/§43.
 *   - NO dead rows: every returned suggestion resolves. Mutation-proved on the
 *     server's `dropDeadRows` net (inject a row with neither action/entity/
 *     destination → it is dropped; a no-op net leaves it in → RED).
 *   - The "SEARCH FOR" completion survives a full page of entity matches — it
 *     is never capped out by §9 trust order. Mutation-proved: swap the reserving
 *     ranker back to a plain cap and the completion vanishes → RED.
 *   - §9 trust order across the mixed set: a strong canonical entity outranks a
 *     query completion, and AI never outranks a real entity.
 *   - Privacy fail-closed (§29): a blocked person is suppressed.
 *
 * Reuses the fake-Supabase harness shape from inputAssistanceGateway.test.ts /
 * discoverySearch.test.ts (pure-logic, dead service-client host).
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
  isResolvable,
  dropDeadRows,
  orderSuggestions,
  orderSuggestionsReserving,
} from "../lib/inputAssistance/projection.js";
import type { InputSuggestion } from "../lib/inputAssistance/types.js";

// ── Stable test UUIDs ──────────────────────────────────────────────────────────

const ME    = "aa000000-0000-4000-a000-000000000001";
const SKY    = "bb000000-0000-4000-a000-000000000002"; // @skylar, discoverable
const BLOCKED = "cc000000-0000-4000-a000-000000000003"; // ME <-> BLOCKED block
const GEM_OWNER = "dd000000-0000-4000-a000-000000000004"; // active gem submitter
const ME_TOK = "tok-me";

// ── Fake Supabase client (harness shape shared with the gateway test) ──────────

interface FakeState {
  [key: string]: any[] | undefined;
}

function makeFakeClient(state: FakeState, tableErrors: Set<string> = new Set()) {
  const errorBuilder: any = {};
  const errorFns = ["select","eq","neq","in","not","is","ilike","or","gte","lt","order","limit","range","maybeSingle"];
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

// ── Server + helpers ────────────────────────────────────────────────────────────

let base: string;
let server: Server;

function setup(state: FakeState, tableErrors: string[] = []) {
  _setTestClient(makeFakeClient(state, new Set(tableErrors)) as any, true);
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

beforeEach(() => {
  _resetRateLimit();
  setup({});
});

function post(body: any, tok: string | null = ME_TOK) {
  return fetch(`${base}/input-assistance/suggest`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

// ── Row builders (match the shapes each per-type searcher reads) ────────────────

function canonicalCity(name: string, normalized: string, country = "Vietnam") {
  return {
    id: `canon-${normalized.replace(/\s+/g, "-")}`,
    kind: "city",
    name,
    normalized_name: normalized,
    display_name: `${name}, ${country}`,
    city: null, region: null, country, country_code: "VN",
    postal_code: null, lat: 16.06, lng: 108.22, provider_ids: {}, aliases: [],
  };
}

function traveler(id: string, handle: string, name: string) {
  return {
    id, handle, username: handle, name, avatar_url: null, is_private: false,
    home_city: null, home_country: null, account_status: "active",
    verified: false, is_official: false, show_profile_picture_publicly: true,
  };
}

function discoveryPlace(id: string, name: string, city = "Da Nang") {
  return {
    id, name, city, blurb: null, image_url: null, header_image_source: null,
    image_source_type: null, image_accuracy_status: null, category: "nightlife",
    primary_category: "nightlife", lat: 16.06, lng: 108.22,
    canonical_location_id: null, created_at: "2026-01-01T00:00:00Z",
    status: "active", saved_count: 5,
  };
}

function hiddenGem(id: string, name: string, submittedBy: string, city = "Son Tra") {
  return {
    id, name, city, country: "Vietnam", submitted_by: submittedBy,
    category: "viewpoint", status: "approved", created_at: "2026-01-01T00:00:00Z",
  };
}

// A discoverable person + their privacy settings row.
function discoverablePerson(id: string, handle: string, name: string) {
  return {
    profile: traveler(id, handle, name),
    privacy: { user_id: id, show_real_name: true, allow_profile_discovery: true },
  };
}

// ── 1. Mixed typed groups, each resolvable (§13/§43) ────────────────────────────

describe("global_search — mixed typed result (§13)", () => {
  it("returns place + person + hidden gem + a SEARCH FOR completion, each resolvable", async () => {
    const sky = discoverablePerson(SKY, "skylar", "Sky Larsson");
    setup({
      // person
      profiles: [sky.profile, traveler(GEM_OWNER, "gemowner", "Gem Owner")],
      profile_privacy_settings: [sky.privacy],
      // place
      discovery_places: [discoveryPlace("place-sky36", "Sky36 Rooftop")],
      // hidden gem (+ active submitter already in profiles above)
      hidden_gems: [hiddenGem("gem-sky", "Sky Hidden Rooftop", GEM_OWNER)],
      // canonical city
      canonical_locations: [canonicalCity("Skopje", "skopje", "North Macedonia")],
      // privacy gates readable
      blocks: [], user_privacy_settings: [], user_follows: [], friend_requests: [], user_friendships: [],
    });

    const r = await post({ context: "global_search", text: "sky" });
    assert.equal(r.status, 200);
    const body = await r.json() as any;

    const byType = new Map<string, any[]>();
    for (const s of body.suggestions as any[]) {
      // NO dead rows: every row must resolve to an action / entity / destination.
      assert.ok(isResolvable(s), `row ${s.id} (${s.type}) must be resolvable`);
      const key = s.type === "completion" ? "completion" : String(s.entityType);
      (byType.get(key) ?? byType.set(key, []).get(key)!).push(s);
    }

    // Mixed entity classes present.
    assert.ok(byType.has("place"), "expected a PLACES row");
    assert.ok(byType.has("user"), "expected a PEOPLE row");
    assert.ok(byType.has("hidden_gem"), "expected a HIDDEN GEMS row");
    assert.ok(byType.has("completion"), "expected a SEARCH FOR completion row");

    // Entities open/resolve; the completion submits a search (§43).
    const place = byType.get("place")![0];
    assert.equal(place.action.type, "open_entity");
    assert.equal(place.action.entityType, "place");
    assert.equal(place.action.entityId, "place-sky36");

    const person = byType.get("user")![0];
    assert.equal(person.action.type, "open_entity");
    assert.equal(person.action.entityId, SKY);

    const completion = byType.get("completion")![0];
    assert.equal(completion.action.type, "submit_search");
    assert.equal(completion.action.query, "sky");
  });
});

// ── 2. The SEARCH FOR completion survives a full page of entities (§13) ─────────

describe("global_search — completion is never capped out by entities (§13)", () => {
  // Fill the 8-slot cap with entity matches across four types (2 each), so the
  // completion — which sorts AFTER every entity under §9 trust order — would be
  // dropped by a plain cap. The reserving ranker must keep it.
  //
  // Mutation-proof: replacing `orderSuggestionsReserving(...)` with a plain
  // `orderSuggestions(biased, cap)` in gateway.ts makes this assertion RED (the
  // completion vanishes behind 8 entity rows).
  it("keeps the submittable-search row present even when 8+ entities match", async () => {
    const p1 = discoverablePerson(SKY, "skyone", "Sky One");
    const p2 = discoverablePerson("bb000000-0000-4000-a000-000000000012", "skytwo", "Sky Two");
    setup({
      profiles: [
        p1.profile, p2.profile,
        traveler(GEM_OWNER, "gemowner", "Gem Owner"),
      ],
      profile_privacy_settings: [p1.privacy, p2.privacy],
      discovery_places: [discoveryPlace("place-sky-a", "Sky Alpha"), discoveryPlace("place-sky-b", "Sky Beta")],
      hidden_gems: [
        hiddenGem("gem-sky-a", "Sky Cave", GEM_OWNER),
        hiddenGem("gem-sky-b", "Sky Ridge", GEM_OWNER),
      ],
      canonical_locations: [canonicalCity("Sky City", "sky city"), canonicalCity("Skyville", "skyville")],
      blocks: [], user_privacy_settings: [], user_follows: [], friend_requests: [], user_friendships: [],
    });

    const r = await post({ context: "global_search", text: "sky", limit: 8 });
    const body = await r.json() as any;
    const suggestions = body.suggestions as any[];

    assert.ok(suggestions.length <= 8, `must not exceed maxSuggestions, got ${suggestions.length}`);
    const entityCount = suggestions.filter((s) => s.type === "entity").length;
    assert.ok(entityCount >= 6, `expected the page to be entity-heavy, got ${entityCount} entities`);
    const completion = suggestions.find((s) => s.type === "completion");
    assert.ok(completion, "SEARCH FOR completion must survive a full page of entities");
    assert.equal(completion.action.type, "submit_search");
  });
});

// ── 3. §9 trust order across the mixed set ──────────────────────────────────────

describe("global_search — §9 trust order across the mixed set", () => {
  it("a strong canonical entity outranks the query completion", async () => {
    setup({
      canonical_locations: [canonicalCity("Sky", "sky", "Norway")], // exact match → tier 3
      blocks: [], user_privacy_settings: [],
    });
    const r = await post({ context: "global_search", text: "sky" });
    const body = await r.json() as any;
    const suggestions = body.suggestions as any[];

    const entityIdx = suggestions.findIndex((s) => s.type === "entity");
    const completionIdx = suggestions.findIndex((s) => s.type === "completion");
    assert.ok(entityIdx >= 0, "expected an entity row");
    assert.ok(completionIdx >= 0, "expected the completion row");
    assert.ok(
      entityIdx < completionIdx,
      "a real canonical entity must rank above the generic query completion (§9)",
    );
  });

  // Unit-level §9 proof: AI must never outrank a real entity match, even when
  // the AI row carries a higher confidence.
  it("orderSuggestions ranks ai_suggestion below entity regardless of confidence", () => {
    const rows: InputSuggestion[] = [
      {
        id: "ai:1", type: "ai_suggestion", context: "global_search", label: "AI idea",
        action: { type: "replace_text", text: "AI idea" }, confidence: 0.99,
        source: "ai", policyVersion: "test",
      },
      {
        id: "e:1", type: "entity", context: "global_search", label: "Real Place",
        entityType: "place", entityId: "p1", action: { type: "open_entity", entityType: "place", entityId: "p1" },
        confidence: 0.4, source: "canonical", policyVersion: "test",
      },
    ];
    const ordered = orderSuggestions(rows, 10);
    assert.equal(ordered[0]!.type, "entity", "entity must lead");
    assert.equal(ordered[1]!.type, "ai_suggestion", "AI must never outrank a real entity (§9)");
  });
});

// ── 4. NO dead rows — the server-side net (§13) ─────────────────────────────────

describe("global_search — no dead rows net (§13)", () => {
  // Mutation-proof: making `dropDeadRows` a pass-through (return input) makes the
  // length + resolvable assertions below go RED — the injected dead row survives.
  it("dropDeadRows removes a row with no action / entity / destination", () => {
    const good: InputSuggestion = {
      id: "e:good", type: "entity", context: "global_search", label: "Sky36",
      entityType: "place", entityId: "p1", action: { type: "open_entity", entityType: "place", entityId: "p1" },
      source: "canonical", policyVersion: "test",
    };
    const dead: InputSuggestion = {
      id: "x:dead", type: "entity", context: "global_search", label: "Nothing here",
      source: "canonical", policyVersion: "test",
      // deliberately: no action, no entityId, no destination
    };
    assert.equal(isResolvable(good), true);
    assert.equal(isResolvable(dead), false, "a row with neither action/entity/destination is NOT resolvable");

    const cleaned = dropDeadRows([good, dead]);
    assert.equal(cleaned.length, 1, "dead row must be dropped");
    assert.ok(cleaned.every(isResolvable), "no dead rows may survive");
    assert.equal(cleaned[0]!.id, "e:good");
  });

  it("orderSuggestionsReserving keeps entities leading AND reserves a completion slot", () => {
    // 9 entity rows + 1 completion, cap 8 → plain cap would drop the completion.
    const rows: InputSuggestion[] = [];
    for (let i = 0; i < 9; i++) {
      rows.push({
        id: `e:${i}`, type: "entity", context: "global_search", label: `Place ${i}`,
        entityType: "place", entityId: `p${i}`,
        action: { type: "open_entity", entityType: "place", entityId: `p${i}` },
        confidence: 0.9, source: "canonical", policyVersion: "test",
      });
    }
    rows.push({
      id: "c:1", type: "completion", context: "global_search", label: 'Search "x"',
      action: { type: "submit_search", query: "x" }, confidence: 0.3, source: "local", policyVersion: "test",
    });
    const out = orderSuggestionsReserving(rows, 8, new Set(["completion"]), 1);
    assert.equal(out.length, 8, "cap respected");
    assert.equal(out[0]!.type, "entity", "entities still lead (§9)");
    assert.ok(out.some((s) => s.type === "completion"), "a completion slot is reserved");
  });
});

// ── 5. Privacy fail-closed (§29) ────────────────────────────────────────────────

describe("global_search — privacy (§29)", () => {
  // A person ME has blocked must not appear in the mixed result.
  it("suppresses a blocked person while still returning other entities", async () => {
    const sky = discoverablePerson(SKY, "skylar", "Sky Larsson");
    const blocked = discoverablePerson(BLOCKED, "skyblock", "Sky Blocked");
    setup({
      profiles: [sky.profile, blocked.profile],
      profile_privacy_settings: [sky.privacy, blocked.privacy],
      canonical_locations: [canonicalCity("Skopje", "skopje", "North Macedonia")],
      blocks: [{ blocker_id: ME, blocked_id: BLOCKED }],
      user_privacy_settings: [], user_follows: [], friend_requests: [], user_friendships: [],
    });
    const r = await post({ context: "global_search", text: "sky" });
    const body = await r.json() as any;
    const ids = new Set((body.suggestions as any[]).map((s) => s.entityId));
    assert.ok(!ids.has(BLOCKED), "blocked person must be suppressed");
    assert.ok(ids.has(SKY), "non-blocked person should still appear (proves the block filter is real)");
  });

  // Fail-closed: when the blocks table is unreadable, no people are returned at
  // all — mirrors the /discovery/suggest fail-closed gate.
  it("returns no people when the blocks table errors (null block-set ⇒ show nobody)", async () => {
    const sky = discoverablePerson(SKY, "skylar", "Sky Larsson");
    setup(
      {
        profiles: [sky.profile],
        profile_privacy_settings: [sky.privacy],
        user_privacy_settings: [], user_follows: [], friend_requests: [], user_friendships: [],
      },
      ["blocks"],
    );
    const r = await post({ context: "global_search", text: "sky" });
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    const hasPerson = (body.suggestions as any[]).some((s) => s.entityType === "user");
    assert.equal(hasPerson, false, "fail-closed: no people when block state is unknown");
  });
});
