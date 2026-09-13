/**
 * Phase 9 — §15 ranking signals that had no producer, and the §20 display
 * fields they need.
 *
 * Run: node --import tsx/esm --test src/test/inputAssistanceRankingSignals.test.ts
 *
 * WHAT WAS MISSING (census-input-intelligence §4, rows G97/G101/G180/G181)
 * ----------------------------------------------------------------------
 *   G97  TemporalFit    — `semanticParser.extractTemporal` computed a real ISO
 *                         window; the window was projected into a search STRING
 *                         and discarded. Nothing ranked on it.
 *   G101 TrustConfidence— `searchTravelers` selects `verified` / `is_official`
 *                         and the §42 projection whitelist dropped both.
 *   G180 verification   — same drop: no suggestion could carry the badge, so a
 *                         verified traveler and a stranger rendered identically.
 *   G181 gem protection — `gemSearchPosition` decides whether a gem may carry a
 *                         centroid and writes it to `metadata.coordsPrecision`;
 *                         the whole metadata bag was dropped, so a protected
 *                         gem looked exactly like an unprotected one.
 *
 * EVERY TEST BELOW NAMES ITS MUTATION, and each was applied and watched go RED
 * before being written down. A test whose mutation leaves it green is recorded
 * as worthless rather than kept.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import inputAssistanceRouter from "../routes/inputAssistance.js";
import { projectSearchResult, orderSuggestions } from "../lib/inputAssistance/projection.js";
import {
  temporalFit,
  applyTemporalFit,
  applyTrustConfidence,
  trustConfidence,
  gemLocationPrecision,
  SIGNAL_CEILING,
} from "../lib/inputAssistance/rankingSignals.js";
import { extractTemporal } from "../lib/inputAssistance/semanticParser.js";
import { POLICY_VERSION } from "../lib/inputAssistance/policyRegistry.js";
import type { SearchResult } from "../routes/discoverySearch.js";
// The client half of §20: the row's badge words. Imported across the package
// boundary on purpose — a second copy of this list on the server would be a
// second source of truth for a user-facing string.
import { suggestionBadges } from "../../../../travel-buddy-standalone/src/platform/input-assistance/components/suggestionBadges.ts";

const ME = "aa000000-0000-4000-a000-000000000001";
const HOST = "dd000000-0000-4000-a000-000000000004";
const ME_TOK = "tok-me";

// ── Fake Supabase client (same harness shape as inputAssistanceGateway.test.ts) ─
interface FakeState { [key: string]: any[] | undefined; }

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
      const sourceRows: any[] = [...(state[table] ?? [])];
      const filters: Array<(r: any) => boolean> = [];
      let _rangeStart = 0;
      let _rangeEnd = Infinity;
      let _limitN = Infinity;
      const builder: any = {
        select() { return builder; },
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
          const matched = sourceRows.filter((r) => filters.every((f) => f(r)));
          return Promise.resolve({ data: matched[0] ?? null, error: null });
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
beforeEach(() => { _resetRateLimit(); setup({}); });

function suggest(body: any) {
  return fetch(`${base}/input-assistance/suggest`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${ME_TOK}` },
    body: JSON.stringify(body),
  });
}

/** A minimal SearchResult; callers override only what the test is about. */
function result(over: Partial<SearchResult> & Pick<SearchResult, "id" | "type" | "title">): SearchResult {
  return {
    subtitle: null, avatarUrl: null, imageUrl: null, fallbackInitials: null,
    locationPreview: null, matchedReason: null, actionState: null, privacyState: null,
    accessState: null, destinationRoute: null, metadata: null, createdAt: null, startsAt: null,
    ...over,
  } as SearchResult;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. §15 TemporalFit — the term itself
// ═══════════════════════════════════════════════════════════════════════════════

describe("§15 TemporalFit (G97) — the parsed window is finally a ranking input", () => {
  const WINDOW = { startsAfter: "2026-05-01T00:00:00.000Z", startsBefore: "2026-05-02T00:00:00.000Z" };

  it("classifies inside / outside / no-time-dimension as fit / miss / neutral", () => {
    assert.equal(temporalFit("2026-05-01T19:00:00.000Z", WINDOW), "fit");
    assert.equal(temporalFit("2026-04-30T23:59:59.000Z", WINDOW), "miss", "before the lower bound is a miss");
    assert.equal(temporalFit("2026-05-02T00:00:00.000Z", WINDOW), "miss", "the upper bound is EXCLUSIVE");
    // The load-bearing one: a place, a city, a user has no start time at all and
    // must never be demoted by a time signal.
    assert.equal(temporalFit(null, WINDOW), "neutral");
    assert.equal(temporalFit(undefined, WINDOW), "neutral");
    assert.equal(temporalFit("not-a-date", WINDOW), "neutral");
    // No window ⇒ every row is neutral, which is what keeps a query with no time
    // operator byte-identical to its pre-Phase-9 behaviour.
    assert.equal(temporalFit("2026-05-01T19:00:00.000Z", null), "neutral");
    assert.equal(temporalFit("2026-05-01T19:00:00.000Z", { startsAfter: null, startsBefore: null }), "neutral");
  });

  it("boosts a fit, demotes a miss, and leaves a neutral row untouched", () => {
    const base = 0.85;
    assert.ok(applyTemporalFit(base, "2026-05-01T19:00:00.000Z", WINDOW) > base, "a fit must rise");
    assert.ok(applyTemporalFit(base, "2099-01-01T00:00:00.000Z", WINDOW) < base, "a miss must fall");
    assert.equal(applyTemporalFit(base, null, WINDOW), base, "a row with no start time is untouched");
    assert.equal(applyTemporalFit(base, "2026-05-01T19:00:00.000Z", null), base, "no window ⇒ untouched");
  });

  it("never lifts a row to the exact-match band, and never below zero", () => {
    // §9: a boosted row must not tie or beat a canonical exact match (0.99).
    assert.ok(applyTemporalFit(0.99, "2026-05-01T19:00:00.000Z", WINDOW) <= 0.99);
    assert.ok(applyTemporalFit(0.97, "2026-05-01T19:00:00.000Z", WINDOW) <= SIGNAL_CEILING);
    assert.ok(applyTemporalFit(0.99, "2026-05-01T19:00:00.000Z", WINDOW) >= 0.99, "the clamp must never DEMOTE a fit");
    assert.equal(applyTemporalFit(0.02, "2099-01-01T00:00:00.000Z", WINDOW), 0);
  });

  it("the window the gateway resolves comes from the parser that was already computing it", () => {
    // Not a re-test of extractTemporal — a statement that the two ends agree on
    // the shape, which is what makes the wiring in gateway.ts type-check into a
    // TemporalWindow at all.
    const t = extractTemporal("jazz tomorrow", "UTC").intent;
    assert.ok(t, "the parser must still recognise 'tomorrow'");
    assert.ok(typeof t!.startsAfter === "string" && typeof t!.startsBefore === "string");
    assert.equal(temporalFit(t!.startsAfter, { startsAfter: t!.startsAfter, startsBefore: t!.startsBefore }), "fit");
  });

  it("a symbolic 'when we arrive' carries no bounds, so it ranks nothing", () => {
    const t = extractTemporal("dinner when we arrive", "UTC").intent;
    assert.ok(t, "the parser recognises the deferred operator");
    assert.equal(t!.startsAfter, null);
    assert.equal(t!.startsBefore, null);
    // …and a bound-less window is dropped by the gateway before it reaches the
    // projection, which this asserts through the term itself.
    assert.equal(temporalFit("2026-05-01T19:00:00.000Z", { startsAfter: null, startsBefore: null }), "neutral");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. §15 TrustConfidence + §20 verification display
// ═══════════════════════════════════════════════════════════════════════════════

describe("§15 TrustConfidence (G101) and §20 verification display (G180)", () => {
  it("weights official above verified, and weights an ordinary row at zero", () => {
    assert.equal(trustConfidence(false, false), 0);
    assert.equal(trustConfidence(undefined, undefined), 0);
    assert.ok(trustConfidence(true, false) > 0);
    assert.ok(trustConfidence(false, true) > trustConfidence(true, false), "official is the stronger claim");
    assert.ok(trustConfidence(true, true) > trustConfidence(false, true), "both flags compound");
  });

  it("a verified prefix match outranks an unverified one at the same match tier", () => {
    // MUTATION-PROOF: in projection.ts drop the `applyTrustConfidence(...)`
    // wrapper (leave `tierConfidence(matchTier(...))` bare). Both rows then score
    // 0.85, orderSuggestions falls back to input order, and the unverified row —
    // seeded FIRST on purpose — leads. RED.
    const unverified = projectSearchResult(
      result({ id: "u-plain", type: "travelers", title: "Sam Rivers" }),
      "global_search", POLICY_VERSION, "Sam",
    );
    const verified = projectSearchResult(
      result({ id: "u-verified", type: "travelers", title: "Sam Rivera", verified: true }),
      "global_search", POLICY_VERSION, "Sam",
    );
    assert.ok((verified.confidence ?? 0) > (unverified.confidence ?? 0));
    const ordered = orderSuggestions([unverified, verified], 10);
    assert.equal(ordered[0]!.entityId, "u-verified");
  });

  it("the badge fields are projected, and ONLY when true", () => {
    // MUTATION-PROOF: delete `if (r.verified === true) suggestion.verified = true;`
    // from projection.ts → the first assertion goes RED.
    const v = projectSearchResult(
      result({ id: "u1", type: "travelers", title: "Ana", verified: true, isOfficial: true }),
      "global_search", POLICY_VERSION, "Ana",
    );
    assert.equal(v.verified, true);
    assert.equal(v.official, true);
    // An absent key is "not applicable", never a negative claim about a person.
    const plain = projectSearchResult(
      result({ id: "u2", type: "travelers", title: "Ben", verified: false, isOfficial: false }),
      "global_search", POLICY_VERSION, "Ben",
    );
    assert.equal("verified" in plain, false);
    assert.equal("official" in plain, false);
    const city = projectSearchResult(result({ id: "c1", type: "cities", title: "Da Nang" }), "global_search", POLICY_VERSION, "Da");
    assert.equal("verified" in city, false, "a city is not an unverified person");
  });

  it("trust never lifts a weaker match to or past a canonical exact match (§9)", () => {
    // The exact band, DERIVED from the projector rather than pinned.
    const exact = projectSearchResult(result({ id: "e", type: "cities", title: "Rosa" }), "global_search", POLICY_VERSION, "Rosa");
    const band = exact.confidence!;
    const trustedSubstring = projectSearchResult(
      result({ id: "t", type: "travelers", title: "Santa Rosa Collective", verified: true, isOfficial: true }),
      "global_search", POLICY_VERSION, "Rosa",
    );
    const untrustedSubstring = projectSearchResult(
      result({ id: "u", type: "travelers", title: "Santa Rosa Collective" }),
      "global_search", POLICY_VERSION, "Rosa",
    );
    // Without this the ceiling assertion below is VACUOUS — it would also hold
    // if the trust term did nothing at all, which is the state this whole file
    // exists to end. (Measured: removing the term leaves the `< band` assertion
    // green and only this line red.)
    assert.ok(
      (trustedSubstring.confidence ?? 0) > (untrustedSubstring.confidence ?? 0),
      "the trust boost must actually apply — otherwise the ceiling assertion proves nothing",
    );
    assert.ok(
      (trustedSubstring.confidence ?? 0) < band,
      `an official+verified weaker match (${trustedSubstring.confidence}) must stay strictly below the exact band (${band})`,
    );
  });

  it("the row's badge words come from the shared helper, so display and announcement cannot drift", () => {
    // MUTATION-PROOF: in suggestionBadges.ts drop the `official` branch → RED.
    assert.deepEqual(suggestionBadges({ official: true, verified: true }), [
      { id: "official", label: "Official" },
      { id: "verified", label: "Verified" },
    ]);
    assert.deepEqual(suggestionBadges({}), [], "an ordinary row renders no badge at all");
    assert.deepEqual(suggestionBadges({ locationPrecision: "hidden" }), [
      { id: "protected", label: "Protected location" },
    ]);
    assert.deepEqual(suggestionBadges({ locationPrecision: "approximate" }), [
      { id: "approximate", label: "Approx. location" },
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. §20/§24 Hidden Gem protection label
// ═══════════════════════════════════════════════════════════════════════════════

describe("§20 Hidden Gem protection label (G181)", () => {
  it("reads the gem search's own precision word and nothing else", () => {
    assert.equal(gemLocationPrecision({ coordsPrecision: "hidden" }), "hidden");
    assert.equal(gemLocationPrecision({ coordsPrecision: "approximate" }), "approximate");
    // "exact" is not producible by gemSearchPosition and must not be inventable here.
    assert.equal(gemLocationPrecision({ coordsPrecision: "exact" }), undefined);
    assert.equal(gemLocationPrecision(null), undefined);
    assert.equal(gemLocationPrecision({}), undefined);
  });

  it("a protected gem and a placeable gem no longer project identically", () => {
    // MUTATION-PROOF: delete the `if (precision) suggestion.locationPrecision = …`
    // line in projection.ts → both rows carry no label and the inequality is RED.
    const protectedGem = projectSearchResult(
      result({ id: "g1", type: "hidden_gems", title: "Secret Cove", metadata: { coordsPrecision: "hidden", lat: null, lng: null } }),
      "global_search", POLICY_VERSION, "Secret",
    );
    const placeable = projectSearchResult(
      result({ id: "g2", type: "hidden_gems", title: "Secret Steps", metadata: { coordsPrecision: "approximate", lat: 16.0, lng: 108.0 } }),
      "global_search", POLICY_VERSION, "Secret",
    );
    assert.equal(protectedGem.locationPrecision, "hidden");
    assert.equal(placeable.locationPrecision, "approximate");
    assert.notEqual(protectedGem.locationPrecision, placeable.locationPrecision);
  });

  it("the label carries no coordinate, and no non-gem row gets one", () => {
    const gem = projectSearchResult(
      result({ id: "g3", type: "hidden_gems", title: "Cove", metadata: { coordsPrecision: "approximate", lat: 16.123456, lng: 108.654321 } }),
      "global_search", POLICY_VERSION, "Cove",
    );
    const serialised = JSON.stringify(gem);
    assert.ok(!serialised.includes("16.123456"), "the label must not drag the centroid along");
    assert.ok(!serialised.includes("108.654321"));
    // A place carries coordsPrecision in metadata too on some paths; the label is
    // a HIDDEN GEM protection label and must not appear on anything else.
    const place = projectSearchResult(
      result({ id: "p1", type: "places", title: "Cove Cafe", metadata: { coordsPrecision: "approximate" } }),
      "global_search", POLICY_VERSION, "Cove",
    );
    assert.equal(place.locationPrecision, undefined);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. END TO END — the window reaches the projection through the real gateway
// ═══════════════════════════════════════════════════════════════════════════════

describe("§15 TemporalFit end-to-end through POST /input-assistance/suggest", () => {
  /** Local midnight + 30h ⇒ inside tomorrow's window on any run date. */
  function tomorrowAfternoonIso(): string {
    const now = new Date();
    const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    return new Date(midnight + 30 * 3600_000).toISOString();
  }

  it("an event inside the parsed window leads one outside it, on the same match tier", async () => {
    // MUTATION-PROOF: in gateway.ts replace the resolved `temporalWindow` with a
    // literal `null` (or drop `{ temporalWindow }` from the projectSearchResult
    // call). Both events then score the same tier, ordering falls back to input
    // order, and `evt-far` — seeded FIRST for exactly this reason — leads. RED.
    setup({
      events: [
        // Seeded FIRST so a broken signal is visible as "input order won".
        { id: "evt-far", title: "Tomorrow Land", host_id: HOST, city: "Da Nang", country: "Vietnam",
          starts_at: "2099-01-01T00:00:00.000Z", visibility: "public", state: "published", created_at: "2026-01-01T00:00:00Z" },
        { id: "evt-near", title: "Tomorrow Lane", host_id: HOST, city: "Da Nang", country: "Vietnam",
          starts_at: tomorrowAfternoonIso(), visibility: "public", state: "published", created_at: "2026-01-01T00:00:00Z" },
      ],
      profiles: [{ id: HOST, account_status: "active" }],
      event_rsvps: [], blocks: [], user_privacy_settings: [], canonical_locations: [],
    });

    const r = await suggest({ context: "global_search", text: "tomorrow", tz: "UTC" });
    const body = await r.json() as any;
    const events = body.suggestions.filter((s: any) => s.entityType === "event");
    assert.equal(events.length, 2, "both events must still be RETURNED — this is a ranking term, not a filter");
    assert.equal(events[0].entityId, "evt-near", "the event inside the window must lead");
    assert.ok(
      (events[0].confidence ?? 0) > (events[1].confidence ?? 0),
      "and it must lead BECAUSE of confidence, not by luck of input order",
    );
  });

  it("the same query with no time operator leaves both events at an identical score", async () => {
    // The control. Without this the test above could pass for a reason that has
    // nothing to do with the window (e.g. a title-length tiebreak).
    setup({
      events: [
        { id: "evt-far", title: "Harbour Land", host_id: HOST, city: "Da Nang", country: "Vietnam",
          starts_at: "2099-01-01T00:00:00.000Z", visibility: "public", state: "published", created_at: "2026-01-01T00:00:00Z" },
        { id: "evt-near", title: "Harbour Lane", host_id: HOST, city: "Da Nang", country: "Vietnam",
          starts_at: tomorrowAfternoonIso(), visibility: "public", state: "published", created_at: "2026-01-01T00:00:00Z" },
      ],
      profiles: [{ id: HOST, account_status: "active" }],
      event_rsvps: [], blocks: [], user_privacy_settings: [], canonical_locations: [],
    });

    const r = await suggest({ context: "global_search", text: "harbour", tz: "UTC" });
    const body = await r.json() as any;
    const events = body.suggestions.filter((s: any) => s.entityType === "event");
    assert.equal(events.length, 2);
    assert.equal(
      events[0].confidence, events[1].confidence,
      "with no time operator the two events must be indistinguishable — otherwise the test above proves nothing",
    );
  });
});
