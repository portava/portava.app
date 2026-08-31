/**
 * POST /api/input-assistance/suggest — Global Input Intelligence gateway (Phase 1)
 *
 * Run: node --import tsx/esm --test src/test/inputAssistanceGateway.test.ts
 *
 * Proves the Phase-1 spine:
 *   - Context → policy resolution (city_picker allows entity/recent, not
 *     ai_suggestion; compass_prompt allows ai_suggestion). [pure]
 *   - §8-shaped suggestions carry policyVersion and a resolvable action/entity
 *     for EVERY row — no dead rows (§13).
 *   - POLICY GATE (§6): a context only ever emits its policy's declared entity
 *     types (city_picker never returns a `user`), and only its declared
 *     assistance types (only compass_prompt emits ai_suggestion).
 *   - PRIVACY fail-closed (§29): a null block-set ⇒ people suppressed.
 *   - minChars / maxSuggestions / limit honored.
 *   - No live label is fabricated when freshness is unavailable (§31).
 *
 * Mutation-proofs (documented inline at each test): the privacy fail-closed
 * guard and the policy entity-gate each go RED when broken.
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
  resolvePolicy,
  isKnownContext,
  KNOWN_CONTEXTS,
  POLICY_VERSION,
} from "../lib/inputAssistance/policyRegistry.js";

// ── Stable test UUIDs ──────────────────────────────────────────────────────────

const ME    = "aa000000-0000-4000-a000-000000000001";
const ALICE = "bb000000-0000-4000-a000-000000000002";
const BOB   = "cc000000-0000-4000-a000-000000000003"; // ME blocked BOB
const ME_TOK = "tok-me";

// ── Fake Supabase client (same harness shape as discoverySearch.test.ts) ───────

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

// A canonical city row that suggestCanonicalLocations will return.
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

// ── 1. Context → policy resolution (pure) ──────────────────────────────────────

describe("policy registry — context resolution", () => {
  it("resolves every §5 context to a policy (29 registered)", () => {
    assert.equal(KNOWN_CONTEXTS.length, 29);
    for (const c of KNOWN_CONTEXTS) {
      const p = resolvePolicy(c);
      assert.ok(p, `context ${c} must resolve`);
      assert.equal(p!.context, c);
    }
  });

  it("city_picker allows entity + recent but NOT ai_suggestion", () => {
    const p = resolvePolicy("city_picker")!;
    assert.ok(p.allowedSuggestionTypes.includes("entity"));
    assert.ok(p.allowedSuggestionTypes.includes("recent"));
    assert.ok(!p.allowedSuggestionTypes.includes("ai_suggestion"));
    assert.equal(p.allowAI, false);
    assert.deepEqual(p.entityTypes, ["city", "country"]);
  });

  it("compass_prompt allows ai_suggestion and allowAI", () => {
    const p = resolvePolicy("compass_prompt")!;
    assert.ok(p.allowedSuggestionTypes.includes("ai_suggestion"));
    assert.equal(p.allowAI, true);
  });

  it("unknown context does not resolve", () => {
    assert.equal(isKnownContext("not_a_context"), false);
    assert.equal(resolvePolicy("not_a_context" as any), null);
  });
});

// ── 2. Auth + validation ───────────────────────────────────────────────────────

describe("POST /input-assistance/suggest — auth + validation", () => {
  it("401 without a token", async () => {
    const r = await post({ context: "global_search", text: "da" }, null);
    assert.equal(r.status, 401);
  });

  it("400 on unknown context", async () => {
    const r = await post({ context: "bogus", text: "da" });
    assert.equal(r.status, 400);
    const body = await r.json() as any;
    assert.equal(body.error, "invalid_payload");
  });

  it("200 envelope carries requestId + policyVersion + context", async () => {
    const r = await post({ context: "global_search", text: "da" });
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.ok(typeof body.requestId === "string" && body.requestId.length > 0);
    assert.equal(body.policyVersion, POLICY_VERSION);
    assert.equal(body.context, "global_search");
    assert.ok(Array.isArray(body.suggestions));
  });
});

// ── 3. §8 shape + no dead rows ─────────────────────────────────────────────────

describe("POST /input-assistance/suggest — §8 projection contract", () => {
  it("every row is §8-shaped with policyVersion + a resolvable action/entity, no live label", async () => {
    setup({
      canonical_locations: [canonicalCity("Da Nang", "da nang"), canonicalCity("Da Lat", "da lat")],
      blocks: [], user_privacy_settings: [],
    });
    const r = await post({ context: "global_search", text: "da" });
    const body = await r.json() as any;
    assert.ok(body.suggestions.length > 0, "should return canonical city suggestions");
    for (const s of body.suggestions) {
      assert.equal(s.policyVersion, POLICY_VERSION);
      assert.equal(s.context, "global_search");
      assert.ok(typeof s.label === "string" && s.label.length > 0);
      assert.ok(typeof s.type === "string");
      assert.ok(typeof s.source === "string");
      // No dead rows (§13): each row resolves via an action OR a canonical
      // destination/entity.
      const resolvable = s.action != null || s.entityId != null || s.destination != null;
      assert.ok(resolvable, `suggestion ${s.id} must resolve to an action/entity`);
      // §31: never a fabricated live label when freshness is unavailable.
      assert.equal(s.freshness, undefined, "Phase 1 must not emit a live label");
    }
  });

  it("projection strips internal metadata (no ownerId/hostId/accessState leak, §42)", async () => {
    setup({
      canonical_locations: [canonicalCity("Da Nang", "da nang")],
      blocks: [], user_privacy_settings: [],
    });
    const r = await post({ context: "city_picker", text: "da" });
    const body = await r.json() as any;
    const s = body.suggestions.find((x: any) => x.entityType === "city");
    assert.ok(s, "canonical city should project");
    // The UI-ready projection must not carry raw internal fields.
    for (const forbidden of ["privacyState", "accessState", "actionState", "metadata", "avatarUrl"]) {
      assert.ok(!(forbidden in s), `projection must not expose ${forbidden}`);
    }
  });
});

// ── 4. POLICY GATE — entity-type filter ────────────────────────────────────────

describe("POST /input-assistance/suggest — policy entity gate (§6)", () => {
  // Mutation-proof: replacing the gateway's `policy.entityTypes` with a full
  // entity list (bypassing the policy) makes this test RED — the traveler leaks
  // into a city_picker.
  it("city_picker never returns a user/traveler even when one matches", async () => {
    setup({
      profiles: [traveler(ALICE, "paris_guide", "Paris Person")],
      profile_privacy_settings: [{ user_id: ALICE, show_real_name: true, allow_profile_discovery: true }],
      canonical_locations: [canonicalCity("Paris", "paris", "France")],
      blocks: [], user_privacy_settings: [], user_follows: [], friend_requests: [], user_friendships: [],
    });
    const r = await post({ context: "city_picker", text: "paris" });
    const body = await r.json() as any;
    const types = new Set(body.suggestions.map((s: any) => s.entityType));
    assert.ok(!types.has("user"), "city_picker must not surface a user");
    assert.ok(types.has("city"), "city_picker should surface the canonical city");
  });

  it("global_search (which allows users) DOES surface the same matching traveler", async () => {
    setup({
      profiles: [traveler(ALICE, "paris_guide", "Paris Person")],
      profile_privacy_settings: [{ user_id: ALICE, show_real_name: true, allow_profile_discovery: true }],
      blocks: [], user_privacy_settings: [], user_follows: [], friend_requests: [], user_friendships: [],
    });
    const r = await post({ context: "global_search", text: "paris" });
    const body = await r.json() as any;
    const hasUser = body.suggestions.some((s: any) => s.entityType === "user" && s.entityId === ALICE);
    assert.ok(hasUser, "global_search should surface the traveler (proves the gate above is real)");
  });
});

// ── 5. POLICY GATE — ai_suggestion (compass) ───────────────────────────────────

describe("POST /input-assistance/suggest — AI lane gate (§56)", () => {
  it("compass_prompt emits ai_suggestion starters with an editable replace_text action", async () => {
    setup({ blocks: [], user_privacy_settings: [] });
    const r = await post({ context: "compass_prompt", text: "where" });
    const body = await r.json() as any;
    const ai = body.suggestions.filter((s: any) => s.type === "ai_suggestion");
    assert.ok(ai.length > 0, "compass_prompt should return starter prompts");
    for (const s of ai) {
      assert.equal(s.action.type, "replace_text", "AI text must never be silently inserted (§22)");
      assert.equal(s.source, "ai");
    }
  });

  it("city_picker emits ZERO ai_suggestion rows for the same text", async () => {
    setup({ blocks: [], user_privacy_settings: [], canonical_locations: [] });
    const r = await post({ context: "city_picker", text: "where" });
    const body = await r.json() as any;
    const ai = body.suggestions.filter((s: any) => s.type === "ai_suggestion");
    assert.equal(ai.length, 0, "city_picker must not emit ai_suggestion");
  });
});

// ── 6. PRIVACY fail-closed (§29) ───────────────────────────────────────────────

describe("POST /input-assistance/suggest — privacy fail-closed (§29)", () => {
  // Positive control: with a readable (empty) block set, the traveler appears.
  it("telegraph_recipient surfaces a matching person when block state is known", async () => {
    setup({
      profiles: [traveler(ALICE, "paris_guide", "Paris Person")],
      profile_privacy_settings: [{ user_id: ALICE, show_real_name: true, allow_profile_discovery: true }],
      blocks: [], user_privacy_settings: [], user_follows: [], friend_requests: [], user_friendships: [],
    });
    const r = await post({ context: "telegraph_recipient", text: "paris" });
    const body = await r.json() as any;
    assert.ok(body.suggestions.some((s: any) => s.entityId === ALICE), "person should appear");
  });

  // Mutation-proof: coalescing a null block-set to an empty Set() (fail-open)
  // and passing it into dispatchSearch makes this RED — the person leaks.
  it("suppresses people entirely when the blocks table errors (null block-set ⇒ show nobody)", async () => {
    setup(
      {
        profiles: [traveler(ALICE, "paris_guide", "Paris Person")],
        profile_privacy_settings: [{ user_id: ALICE, show_real_name: true, allow_profile_discovery: true }],
        user_privacy_settings: [], user_follows: [], friend_requests: [], user_friendships: [],
      },
      ["blocks"], // blocks read fails → fetchBlockedSet returns null → fail-closed
    );
    const r = await post({ context: "telegraph_recipient", text: "paris" });
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.suggestions.length, 0, "fail-closed: no people when block state is unknown");
  });
});

// ── 7. minChars / maxSuggestions / limit ───────────────────────────────────────

describe("POST /input-assistance/suggest — minChars / maxSuggestions / limit", () => {
  it("returns empty below the policy's minChars (global_search minChars=2)", async () => {
    setup({ blocks: [], user_privacy_settings: [], canonical_locations: [canonicalCity("Da Nang", "da nang")] });
    const r = await post({ context: "global_search", text: "d" });
    const body = await r.json() as any;
    assert.equal(body.suggestions.length, 0, "1 char is below minChars");
  });

  it("never exceeds the policy's maxSuggestions", async () => {
    // 12 matching canonical cities; city_picker maxSuggestions = 8.
    const many = Array.from({ length: 12 }, (_, i) => canonicalCity(`Datown ${i}`, `datown ${i}`));
    setup({ blocks: [], user_privacy_settings: [], canonical_locations: many });
    const r = await post({ context: "city_picker", text: "datown", limit: 100 });
    const body = await r.json() as any;
    assert.ok(body.suggestions.length <= 8, `expected ≤ 8, got ${body.suggestions.length}`);
  });

  it("honors a request limit smaller than maxSuggestions", async () => {
    const many = Array.from({ length: 12 }, (_, i) => canonicalCity(`Datown ${i}`, `datown ${i}`));
    setup({ blocks: [], user_privacy_settings: [], canonical_locations: many });
    const r = await post({ context: "city_picker", text: "datown", limit: 3 });
    const body = await r.json() as any;
    assert.ok(body.suggestions.length <= 3, `expected ≤ 3, got ${body.suggestions.length}`);
  });
});

// ── 8. Rate limiting ───────────────────────────────────────────────────────────

describe("POST /input-assistance/suggest — rate limiting", () => {
  it("429 after 90 requests in the window", async () => {
    setup({ blocks: [], user_privacy_settings: [] });
    for (let i = 0; i < 90; i++) {
      const r = await post({ context: "global_search", text: "da" });
      assert.equal(r.status, 200, `request ${i + 1} should pass`);
    }
    const limited = await post({ context: "global_search", text: "da" });
    assert.equal(limited.status, 429);
  });
});
