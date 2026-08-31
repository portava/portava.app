/**
 * Phase 8 — Personalization (Global Input Intelligence, §35/§15/§14).
 *
 * Run: node --import tsx/esm --test src/test/inputAssistancePersonalization.test.ts
 *
 * Proves the per-user Selection Memory behind POST /input-assistance/suggest and
 * the explicit recording path POST /input-assistance/select:
 *   §15  a user's REPEATED explicit selection boosts that entity in THEIR rank.
 *   §35  owner-scoped — user B's history never affects user A.
 *   §35  a user-specific abbreviation maps to a canonical entity FOR THAT USER
 *        only, without changing the canonical entity or affecting anyone else.
 *   §14  zero-character returns the user's recent explicit selections.
 *   §2/§9 personalization AUGMENTS rank; it never overrides a strong canonical
 *        exact match.
 *   cold-start — a user with no history gets today's behaviour exactly.
 *   recording — explicit-only + owner-scoped: recorded from the session id, and
 *        refused (nothing written) for a personalization-disabled context.
 *
 * MUTATION-PROOFS (documented inline):
 *   - Make applyPriorSelectionBoost return `suggestions` unchanged →
 *     "repeated selection ranks higher" (confidence assertion) goes RED.
 *   - Drop the `.eq("user_id", …)` owner filter in fetchSelectionMemory (make the
 *     boost global) → the "owner-scoped: no boost for user A" assertion goes RED.
 *   - Make buildLearnedGeoInjections return [] → the abbreviation-mapping
 *     assertion goes RED.
 *   - Make buildSelectionRecents return [] → the zero-char recents assertion
 *     goes RED.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import inputAssistanceRouter from "../routes/inputAssistance.js";
import { searchKey, normalizeLocationName } from "../lib/canonicalLocations.js";
import { selectionQueryKey } from "../lib/inputAssistance/personalization.js";

// ── Stable test UUIDs ──────────────────────────────────────────────────────────
const USER_A = "aa000000-0000-4000-a000-0000000000a1";
const USER_B = "bb000000-0000-4000-a000-0000000000b2";
const A_TOK = "tok-a";
const B_TOK = "tok-b";

// ── Fake Supabase client (geoCore harness + rpc capture) ────────────────────────
interface FakeState { [key: string]: any[] | undefined; }
interface RpcCall { name: string; args: any; }

function makeFakeClient(state: FakeState, rpcLog: RpcCall[] = []) {
  return {
    auth: {
      getUser: async (tok: string) =>
        tok === A_TOK
          ? { data: { user: { id: USER_A } }, error: null }
          : tok === B_TOK
            ? { data: { user: { id: USER_B } }, error: null }
            : { data: { user: null }, error: { message: "bad token" } },
    },
    rpc: async (name: string, args: any) => {
      rpcLog.push({ name, args });
      return { data: null, error: null };
    },
    from: (table: string) => {
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

// ── Fixtures ────────────────────────────────────────────────────────────────────
function canonCity(
  name: string,
  opts: { country?: string; countryCode?: string; region?: string; lat?: number; lng?: number; id?: string } = {},
) {
  const key = searchKey(name);
  return {
    id: opts.id ?? `canon-${(key || "x").replace(/\s+/g, "-")}`,
    kind: "city",
    name,
    normalized_name: normalizeLocationName(name),
    search_key: key,
    display_name: opts.country ? `${name}, ${opts.country}` : name,
    city: null,
    region: opts.region ?? null,
    country: opts.country ?? null,
    country_code: opts.countryCode ?? null,
    postal_code: null,
    lat: opts.lat ?? null,
    lng: opts.lng ?? null,
    provider_ids: {},
    aliases: [],
  };
}

// Two same-tier ("Sant…") prefix cities — neither is a 3-letter IATA code, so the
// airport/disambiguation path never fires and both come back as plain entities at
// the same base confidence. The personalization boost is the only thing that can
// separate them.
const SANTA_ANA = canonCity("Santa Ana", { country: "United States", countryCode: "US", id: "canon-santa-ana" });
const SANTA_ROSA = canonCity("Santa Rosa", { country: "United States", countryCode: "US", lat: 38.44, lng: -122.71, id: "canon-santa-rosa" });
// For the abbreviation-mapping case. "bkok" is a user-INVENTED abbreviation the
// global alias dictionary does not know (unlike the real airport code BKK), so it
// resolves to Bangkok ONLY through this user's learned selection memory.
const BANGKOK = canonCity("Bangkok", { country: "Thailand", countryCode: "TH", lat: 13.7563, lng: 100.5018, id: "canon-bangkok" });
// For augment-not-override: an exact match vs a heavily-personalized substring.
const ROSA = canonCity("Rosa", { country: "Spain", countryCode: "ES", id: "canon-rosa" });

function selRow(o: {
  user: string; context: string; entityType: string; entityId: string;
  queryKey?: string; count?: number; label?: string; at?: string;
}) {
  return {
    user_id: o.user,
    context: o.context,
    entity_type: o.entityType,
    entity_id: o.entityId,
    query_key: o.queryKey ?? "",
    label: o.label ?? null,
    selection_count: o.count ?? 1,
    last_selected_at: o.at ?? "2026-08-31T00:00:00.000Z",
  };
}

// ── Server ───────────────────────────────────────────────────────────────────────
let base: string;
let server: Server;
let rpcLog: RpcCall[] = [];

function setup(state: FakeState) {
  rpcLog = [];
  _setTestClient(makeFakeClient(state, rpcLog) as any, true);
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
beforeEach(() => { _resetRateLimit(); });

function suggest(body: any, tok: string | null = A_TOK) {
  return fetch(`${base}/input-assistance/suggest`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    body: JSON.stringify(body),
  });
}
function select(body: any, tok: string | null = A_TOK) {
  return fetch(`${base}/input-assistance/select`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    body: JSON.stringify(body),
  });
}

const cityOf = (body: any, id: string) => body.suggestions.find((s: any) => s.entityId === id);

// ── 1. Repeated selection boosts that entity in the user's rank (§15) ───────────

describe("POST /suggest — repeated selection boosts the entity (§15)", () => {
  it("a repeatedly-selected city outranks an equal-tier city the user never picked", async () => {
    // MUTATION-PROOF: make applyPriorSelectionBoost return its input unchanged and
    // the confidence assertion below goes RED (both cities tie at 0.85).
    setup({
      canonical_locations: [SANTA_ANA, SANTA_ROSA],
      input_selection_history: [
        selRow({ user: USER_A, context: "city_picker", entityType: "city", entityId: SANTA_ROSA.id, count: 3 }),
      ],
    });
    const r = await suggest({ context: "city_picker", text: "sant" }, A_TOK);
    const body = await r.json() as any;
    const ana = cityOf(body, SANTA_ANA.id);
    const rosa = cityOf(body, SANTA_ROSA.id);
    assert.ok(ana && rosa, `both cities expected; got ${JSON.stringify(body.suggestions.map((s: any) => s.label))}`);
    // The user has selected Santa Rosa before → it must rank strictly higher.
    assert.ok(rosa.confidence > ana.confidence,
      `expected Santa Rosa (${rosa.confidence}) > Santa Ana (${ana.confidence}) after the prior-selection boost`);
    // And it leads the list.
    const idxRosa = body.suggestions.findIndex((s: any) => s.entityId === SANTA_ROSA.id);
    const idxAna = body.suggestions.findIndex((s: any) => s.entityId === SANTA_ANA.id);
    assert.ok(idxRosa < idxAna, "the repeatedly-selected city must sort ahead of the untouched one");
  });
});

// ── 2. Owner-scoped — user B's history never affects user A (§35) ───────────────

describe("POST /suggest — personalization is owner-scoped (§35)", () => {
  it("user B's repeated selection does NOT boost the same entity for user A", async () => {
    // MUTATION-PROOF: drop the `.eq("user_id", …)` filter in fetchSelectionMemory
    // (make the boost global) and user A inherits B's boost → this goes RED.
    setup({
      canonical_locations: [SANTA_ANA, SANTA_ROSA],
      input_selection_history: [
        selRow({ user: USER_B, context: "city_picker", entityType: "city", entityId: SANTA_ROSA.id, count: 5 }),
      ],
    });
    // User A has NO history → the two equal-tier cities stay tied.
    const ra = await suggest({ context: "city_picker", text: "sant" }, A_TOK);
    const ba = await ra.json() as any;
    const anaA = cityOf(ba, SANTA_ANA.id);
    const rosaA = cityOf(ba, SANTA_ROSA.id);
    assert.ok(anaA && rosaA);
    assert.equal(rosaA.confidence, anaA.confidence,
      "user A must see NO boost — the two cities tie exactly");
    assert.ok(!ba.suggestions.some((s: any) => s.source === "memory" || s.type === "personalized"),
      "user A must see no personalized rows from user B's memory");

    // User B DOES see the boost — proving the history exists and is B-scoped.
    _resetRateLimit();
    const rb = await suggest({ context: "city_picker", text: "sant" }, B_TOK);
    const bb = await rb.json() as any;
    const anaB = cityOf(bb, SANTA_ANA.id);
    const rosaB = cityOf(bb, SANTA_ROSA.id);
    assert.ok(rosaB.confidence > anaB.confidence, "user B (the owner) sees the boost");
  });
});

// ── 3. Abbreviation → canonical FOR THAT USER only (§35) ────────────────────────

describe("POST /suggest — learned abbreviation maps to canonical, per user (§35)", () => {
  it("'bkok' surfaces Bangkok for the user who taught it, without changing the entity", async () => {
    // MUTATION-PROOF: make buildLearnedGeoInjections return [] → Bangkok is not
    // surfaced for 'bkok' → this goes RED.
    setup({
      canonical_locations: [BANGKOK],
      input_selection_history: [
        selRow({ user: USER_B, context: "city_picker", entityType: "city", entityId: BANGKOK.id, queryKey: "bkok", count: 3, label: "Bangkok" }),
      ],
    });
    const r = await suggest({ context: "city_picker", text: "bkok" }, B_TOK);
    const body = await r.json() as any;
    const hit = cityOf(body, BANGKOK.id);
    assert.ok(hit, `expected Bangkok surfaced for the learned abbreviation; got ${JSON.stringify(body.suggestions.map((s: any) => [s.label, s.type]))}`);
    assert.equal(hit.type, "personalized");
    assert.equal(hit.source, "memory");
    // The canonical entity is UNCHANGED — its name is still "Bangkok" for everyone.
    assert.equal(hit.label, "Bangkok");
    assert.equal(hit.entityType, "city");
  });

  it("the same abbreviation surfaces NOTHING for a different user", async () => {
    setup({
      canonical_locations: [BANGKOK],
      input_selection_history: [
        selRow({ user: USER_B, context: "city_picker", entityType: "city", entityId: BANGKOK.id, queryKey: "bkok", count: 3, label: "Bangkok" }),
      ],
    });
    const r = await suggest({ context: "city_picker", text: "bkok" }, A_TOK);
    const body = await r.json() as any;
    assert.ok(!cityOf(body, BANGKOK.id),
      "user A never taught 'bkok' → the mapping must not leak from user B");
  });
});

// ── 4. Zero-character recents from the user's own selections (§14) ──────────────

describe("POST /suggest — zero-character recents (§14)", () => {
  it("an empty field returns the user's recently-selected city", async () => {
    // MUTATION-PROOF: make buildSelectionRecents return [] → this goes RED.
    setup({
      canonical_locations: [SANTA_ROSA],
      input_selection_history: [
        selRow({ user: USER_A, context: "city_picker", entityType: "city", entityId: SANTA_ROSA.id, count: 2, label: "Santa Rosa", at: "2026-08-31T10:00:00.000Z" }),
      ],
    });
    const r = await suggest({ context: "city_picker", text: "" }, A_TOK);
    const body = await r.json() as any;
    const hit = cityOf(body, SANTA_ROSA.id);
    assert.ok(hit, `expected the recent selection at zero characters; got ${JSON.stringify(body.suggestions.map((s: any) => s.label))}`);
    assert.equal(hit.type, "recent");
    assert.equal(hit.source, "memory");
    assert.equal(hit.reason, "Recently selected");
  });

  it("an empty field with NO history returns nothing (cold-start unchanged)", async () => {
    setup({ canonical_locations: [SANTA_ROSA], input_selection_history: [] });
    const r = await suggest({ context: "city_picker", text: "" }, A_TOK);
    const body = await r.json() as any;
    assert.equal(body.suggestions.length, 0);
  });
});

// ── 5. Augment, never override (§2/§9) ──────────────────────────────────────────

describe("POST /suggest — personalization augments but never overrides (§9)", () => {
  it("a strong canonical exact match still leads a heavily-personalized weaker match", async () => {
    setup({
      canonical_locations: [ROSA, SANTA_ROSA],
      input_selection_history: [
        // Santa Rosa is only a SUBSTRING match for 'rosa', but picked 10x.
        selRow({ user: USER_A, context: "city_picker", entityType: "city", entityId: SANTA_ROSA.id, queryKey: "rosa", count: 10 }),
      ],
    });
    const r = await suggest({ context: "city_picker", text: "rosa" }, A_TOK);
    const body = await r.json() as any;
    const rosa = cityOf(body, ROSA.id);          // exact match
    const santa = cityOf(body, SANTA_ROSA.id);   // boosted substring match
    assert.ok(rosa && santa);
    // The exact canonical match is not displaced by the personalized weaker one.
    assert.ok(rosa.confidence > santa.confidence,
      `exact match Rosa (${rosa.confidence}) must stay ahead of boosted Santa Rosa (${santa.confidence})`);
    const idxRosa = body.suggestions.findIndex((s: any) => s.entityId === ROSA.id);
    const idxSanta = body.suggestions.findIndex((s: any) => s.entityId === SANTA_ROSA.id);
    assert.ok(idxRosa < idxSanta, "the exact canonical entity must still lead");
  });
});

// ── 6. Cold-start identical to today ────────────────────────────────────────────

describe("POST /suggest — cold-start is identical to today", () => {
  it("a user with no history sees the base ranking, no memory rows", async () => {
    setup({ canonical_locations: [SANTA_ANA, SANTA_ROSA], input_selection_history: [] });
    const r = await suggest({ context: "city_picker", text: "sant" }, A_TOK);
    const body = await r.json() as any;
    const ana = cityOf(body, SANTA_ANA.id);
    const rosa = cityOf(body, SANTA_ROSA.id);
    assert.ok(ana && rosa);
    // No boost applied → both at their base prefix confidence, no memory/personalized rows.
    assert.equal(ana.confidence, rosa.confidence);
    assert.equal(ana.confidence, 0.85);
    assert.ok(!body.suggestions.some((s: any) => s.source === "memory" || s.type === "personalized"));
  });
});

// ── 7. Recording — explicit-only + owner-scoped (§35) ───────────────────────────

describe("POST /select — records explicit selections, owner-scoped", () => {
  it("records a city_picker selection under the SESSION user id, with the query key", async () => {
    setup({ canonical_locations: [SANTA_ROSA], input_selection_history: [] });
    const r = await select({
      context: "city_picker", entityType: "city", entityId: SANTA_ROSA.id, query: "Sant", label: "Santa Rosa",
    }, A_TOK);
    const body = await r.json() as any;
    assert.equal(r.status, 200);
    assert.equal(body.recorded, true);
    // Exactly one write, and it is owner-scoped to the SESSION user, not the body.
    const calls = rpcLog.filter((c) => c.name === "input_record_selection");
    assert.equal(calls.length, 1, "one explicit selection must be recorded");
    const a = calls[0]!.args;
    assert.equal(a.p_user_id, USER_A, "owner-scoped: recorded under the session user id");
    assert.equal(a.p_context, "city_picker");
    assert.equal(a.p_entity_type, "city");
    assert.equal(a.p_entity_id, SANTA_ROSA.id);
    // The stored query key is the folded query — the per-user abbreviation mapping.
    assert.equal(a.p_query_key, selectionQueryKey("Sant"));
    assert.equal(a.p_label, "Santa Rosa");
  });

  it("refuses to record for a personalization-disabled context (username), writing nothing", async () => {
    // username has allowPersonalization:false — a private/identity context is
    // never tracked. This is the explicit-only + privacy gate on the write path.
    setup({ profiles: [], input_selection_history: [] });
    const r = await select({
      context: "username", entityType: "user", entityId: USER_B, query: "wanderer",
    }, A_TOK);
    const body = await r.json() as any;
    assert.equal(r.status, 200);
    assert.equal(body.recorded, false, "username selections must not be recorded");
    assert.equal(rpcLog.filter((c) => c.name === "input_record_selection").length, 0,
      "no write may happen for a personalization-disabled context");
  });
});
