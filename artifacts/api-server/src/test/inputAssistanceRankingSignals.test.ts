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
  spamRisk,
  applySpamRisk,
  SPAM_MAX_PENALTY,
  applyDiversity,
  diversitySignature,
  DIVERSITY_STEP,
  DIVERSITY_MAX_PENALTY,
  applyFeasibility,
  applyTripFit,
  INFEASIBLE_DEMOTION,
  TRIP_FIT_BOOST,
  handleSignature,
  applyImpersonationRisk,
  IMPERSONATION_DEMOTION,
} from "../lib/inputAssistance/rankingSignals.js";
import {
  resolveTaskConstraint,
  classifyFeasibility,
  isEmptyConstraint,
  EMPTY_TASK_CONSTRAINT,
} from "../lib/inputAssistance/taskContext.js";
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

// ═══════════════════════════════════════════════════════════════════════════════
// 5. §15 SpamRisk (G106) + §36 keyword-stuffing resistance (G231)
//
// Both rows read "no signal anywhere in the layer" — no term-frequency,
// repetition or stuffing heuristic existed in `lib/inputAssistance/` or in the
// searchers it calls, so a listing that repeated its keywords ranked exactly
// like one that did not.
// ═══════════════════════════════════════════════════════════════════════════════

describe("§15 SpamRisk (G106) / §36 keyword stuffing (G231) — the term itself", () => {
  it("scores a stuffed string above a clean one of the same length", () => {
    // MUTATION-PROOF: make spamRisk() return 0 unconditionally → RED.
    const stuffed = spamRisk("bangkok tour bangkok tour bangkok tour bangkok");
    const clean = spamRisk("Bangkok street food walking tour with a local guide");
    assert.ok(stuffed > 0.2, `expected a repetition signal, got ${stuffed}`);
    assert.equal(clean, 0, `ordinary prose must score zero, got ${clean}`);
    assert.ok(stuffed > clean);
  });

  it("catches keyword banners and separator chains, not ordinary names", () => {
    assert.ok(spamRisk("BEST CHEAP TOURS BANGKOK NOW") > 0, "an all-caps keyword banner");
    assert.ok(spamRisk("tours | bangkok | cheap | best | guide") > 0, "a separator chain");
    assert.equal(spamRisk("BBQ"), 0, "a short name is never spam");
    assert.equal(spamRisk("Sky36 Rooftop Bar"), 0);
    assert.equal(spamRisk("Bún Chả Hương Liên"), 0);
  });

  it("demotes, never removes, and is the identity on a clean row", () => {
    const base = 0.85;
    assert.equal(applySpamRisk(base, "Sky36 Rooftop Bar"), base, "clean rows are byte-identical");
    const demoted = applySpamRisk(base, "bangkok tour bangkok tour bangkok tour bangkok");
    assert.ok(demoted < base);
    assert.ok(demoted >= base - SPAM_MAX_PENALTY, "the penalty is bounded");
    assert.ok(demoted > 0, "a demotion is never a deletion");
  });
});

describe("§36 keyword stuffing end-to-end (G231) — a stuffed place loses to a clean one", () => {
  it("the clean listing outranks the stuffed listing on the same query", async () => {
    // RED BEFORE THE FIX: with no SpamRisk term both rows scored the same match
    // tier and input order decided — and the stuffed row is seeded FIRST here
    // for exactly that reason.
    setup({
      discovery_places: [
        { id: "p-stuffed", name: "Bangkok Tour Bangkok Tour Bangkok Tour Bangkok", city: "Bangkok",
          blurb: null, image_url: null, header_image_source: null, image_source_type: null,
          image_accuracy_status: null, category: "tour", primary_category: "tour",
          lat: 13.7, lng: 100.5, canonical_location_id: null, created_at: "2026-01-01T00:00:00Z",
          submitted_by: null, status: "active", saved_count: 0 },
        { id: "p-clean", name: "Bangkok Tour Collective", city: "Bangkok",
          blurb: null, image_url: null, header_image_source: null, image_source_type: null,
          image_accuracy_status: null, category: "tour", primary_category: "tour",
          lat: 13.7, lng: 100.5, canonical_location_id: null, created_at: "2026-01-01T00:00:00Z",
          submitted_by: null, status: "active", saved_count: 0 },
      ],
      blocks: [], user_privacy_settings: [], canonical_locations: [],
    });
    const r = await suggest({ context: "place_picker", text: "bangkok tour" });
    const body = await r.json() as any;
    const places = body.suggestions.filter((s: any) => s.entityType === "place");
    assert.equal(places.length, 2, "both rows are still RETURNED — this is a ranking term, not a filter");
    assert.equal(places[0].entityId, "p-clean", "the clean listing must lead");
    assert.ok((places[0].confidence ?? 0) > (places[1].confidence ?? 0));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. §15 Diversity (G102) — a score term, not a side effect of slot allocation
// ═══════════════════════════════════════════════════════════════════════════════

describe("§15 Diversity (G102) — repeats within one type are spread", () => {
  it("demotes each repeat of a display signature, progressively and with a cap", () => {
    // MUTATION-PROOF: return `rows` unchanged from applyDiversity → RED.
    const rows = [
      { type: "entity", label: "Street Food Tour", subtitle: "Bangkok", confidence: 0.9 },
      { type: "entity", label: "street food tour", subtitle: "Bangkok", confidence: 0.9 },
      { type: "entity", label: "The Street Food Tour", subtitle: "Bangkok", confidence: 0.9 },
      { type: "entity", label: "Rooftop Bar", subtitle: "Bangkok", confidence: 0.9 },
    ];
    const out = applyDiversity(rows);
    assert.equal(out[0]!.confidence, 0.9, "the first of a run keeps its score");
    assert.ok(Math.abs(out[1]!.confidence! - (0.9 - DIVERSITY_STEP)) < 1e-9);
    assert.ok(Math.abs(out[2]!.confidence! - (0.9 - 2 * DIVERSITY_STEP)) < 1e-9);
    assert.equal(out[3]!.confidence, 0.9, "a different signature is untouched");
    assert.ok(2 * DIVERSITY_STEP <= DIVERSITY_MAX_PENALTY);
  });

  it("never lets one assistance type suppress another (§9 order is untouched)", () => {
    const rows = [
      { type: "entity", label: "Bangkok", confidence: 0.9 },
      { type: "recent", label: "Bangkok", confidence: 0.7 },
    ];
    const out = applyDiversity(rows);
    assert.equal(out[1]!.confidence, 0.7, "a recent row is not a repeat of an entity row");
  });

  it("is byte-identical on a list with no repeats", () => {
    const rows = [{ type: "entity", label: "A", confidence: 0.5 }, { type: "entity", label: "B", confidence: 0.5 }];
    assert.equal(applyDiversity(rows), rows, "the identity case returns the SAME array");
    assert.equal(diversitySignature("The Rooftop", "Bangkok"), diversitySignature("rooftop", "bangkok"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. §18 task feasibility (G122/G124/G125) + §15 TripFit (G96) + §16 carryover (G107)
//
// `filterInfeasibleCandidates` had exactly ONE caller — duplicate candidates in
// creation contexts. The main pipeline never called it, so "remove or demote
// infeasible options", "outside Trip date/time window" and "outside selected
// city/area" had no effect on an ordinary suggestion list, and the whole of
// carryover was an exact-cityId reorder.
// ═══════════════════════════════════════════════════════════════════════════════

const TRIP_ID = "ee000000-0000-4000-a000-000000000009";
const BKK_ID = "canon-bangkok";

/**
 * THE TRIP WINDOW IS AHEAD OF THE CLOCK, ALWAYS.
 *
 * This Trip is "upcoming" and the suggestion pipeline serves only events that
 * have not started, so the window and the two events have to be ahead of
 * whatever clock the suite runs on. Pinned to 2026-12-01..10 they were, until
 * 2026-12-10 — after which the event search returns nothing, `events.length`
 * is 0 instead of 2, and the failure reads as "the G124 demotion stopped
 * demoting" rather than "the fixture expired". Same failure mode as the three
 * bombs of 2026-09-15, in a file carrying no `2026-09-1x` date.
 *
 * Derived from the clock the assertions are judged against, keeping the only
 * structure they depend on: the OUT-of-window event is EARLIER than the
 * in-window one (the underlying search orders by `starts_at` ascending, so the
 * wrong row leads on its own and the demotion is a reordering the test can
 * see), and both are still in the future.
 */
const DAY_MS = 24 * 60 * 60 * 1_000;
const tripDay = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10);
/** The Trip's window: opens in 90 days, closes in 99. */
const TRIP_WINDOW_START = tripDay(90);
const TRIP_WINDOW_END = tripDay(99);
/** Inside the window; and outside it but still ahead of the clock. */
const EVENT_INSIDE_ISO = `${tripDay(94)}T12:00:00.000Z`;
const EVENT_OUTSIDE_ISO = `${tripDay(30)}T12:00:00.000Z`;

function bkkTripState(extra: FakeState = {}): FakeState {
  return {
    trips: [{
      id: TRIP_ID, destination_city: "Bangkok", destination_country: "Thailand",
      start_date: TRIP_WINDOW_START, end_date: TRIP_WINDOW_END, status: "upcoming",
      destination_lat: 13.7563, destination_lng: 100.5018,
    }],
    canonical_locations: [{
      id: BKK_ID, kind: "city", name: "Bangkok", normalized_name: "bangkok", search_key: "bangkok",
      display_name: "Bangkok, Thailand", city: null, region: null, country: "Thailand",
      country_code: "TH", postal_code: null, lat: 13.7563, lng: 100.5018, provider_ids: {}, aliases: [],
    }],
    blocks: [], user_privacy_settings: [], profiles: [{ id: HOST, account_status: "active" }],
    event_rsvps: [],
    ...extra,
  };
}

describe("§16/§18 task constraint (G107/G122/G125) — the pure resolver", () => {
  it("reads the Trip's city and date window from the session context", async () => {
    const sc = makeFakeClient(bkkTripState()) as any;
    const c = await resolveTaskConstraint(sc, { tripId: TRIP_ID });
    assert.equal(c.city, "Bangkok");
    assert.equal(c.windowStart, TRIP_WINDOW_START);
    assert.equal(c.windowEnd, `${TRIP_WINDOW_END}T23:59:59.999Z`, "the Trip's LAST evening is inside the window");
    assert.ok(!isEmptyConstraint(c));
  });

  it("a session with no task issues no query and constrains nothing", async () => {
    const sc = makeFakeClient(bkkTripState()) as any;
    const c = await resolveTaskConstraint(sc, undefined);
    assert.deepEqual(c, EMPTY_TASK_CONSTRAINT);
    assert.ok(isEmptyConstraint(c));
    assert.equal(classifyFeasibility([result({ id: "x", type: "places", title: "X" })], c).demotedIds.size, 0);
  });

  it("classifies out-of-city and out-of-window rows, and never a city row", () => {
    const c = {
      cityId: null, city: "Bangkok", country: "Thailand", tripId: TRIP_ID,
      windowStart: "2026-12-01", windowEnd: "2026-12-10T23:59:59.999Z",
    };
    const rows = [
      result({ id: "in-city", type: "places", title: "Rooftop", locationPreview: "Bangkok" }),
      result({ id: "out-city", type: "places", title: "Rooftop", locationPreview: "Da Nang" }),
      result({ id: "in-window", type: "events", title: "Party", locationPreview: "Bangkok, Thailand", startsAt: "2026-12-05T19:00:00Z" }),
      result({ id: "out-window", type: "events", title: "Party", locationPreview: "Bangkok, Thailand", startsAt: "2027-06-05T19:00:00Z" }),
      result({ id: "a-city", type: "cities", title: "Da Nang", locationPreview: "Vietnam" }),
    ];
    const v = classifyFeasibility(rows, c);
    assert.ok(!v.demotedIds.has("in-city"));
    assert.ok(v.demotedIds.has("out-city"), "§18: outside the selected city → demoted");
    assert.ok(!v.demotedIds.has("in-window"));
    assert.ok(v.demotedIds.has("out-window"), "§18: outside the Trip date window → demoted");
    assert.ok(!v.demotedIds.has("a-city"), "a CITY row is never demoted for being another city");
    assert.ok(v.tripFitIds.has("in-city"), "§15 TripFit: a candidate in the Trip city");
    assert.ok(!v.tripFitIds.has("out-city"));
  });

  it("the terms themselves demote and boost within bounds", () => {
    assert.equal(applyFeasibility(0.9, false), 0.9);
    assert.ok(Math.abs(applyFeasibility(0.9, true) - (0.9 - INFEASIBLE_DEMOTION)) < 1e-9);
    assert.equal(applyFeasibility(0.1, true), 0, "never negative");
    assert.equal(applyTripFit(0.5, false), 0.5);
    assert.ok(Math.abs(applyTripFit(0.5, true) - (0.5 + TRIP_FIT_BOOST)) < 1e-9);
    assert.ok(applyTripFit(0.99, true) <= 0.99, "TripFit cannot pull an exact match DOWN");
  });
});

describe("§18 task feasibility end-to-end (G122/G124/G125/G96/G107)", () => {
  it("a place outside the Trip's city is DEMOTED, not removed", async () => {
    // RED BEFORE THE FIX: the main pipeline never called filterInfeasibleCandidates,
    // so both rows scored identically and the out-of-city row — seeded FIRST —
    // led the list.
    setup(bkkTripState({
      discovery_places: [
        { id: "p-far", name: "Rooftop Bar One", city: "Da Nang", blurb: null, image_url: null,
          header_image_source: null, image_source_type: null, image_accuracy_status: null,
          category: "bar", primary_category: "bar", lat: 16.0, lng: 108.2,
          canonical_location_id: null, created_at: "2026-01-01T00:00:00Z", submitted_by: null,
          status: "active", saved_count: 0 },
        { id: "p-near", name: "Rooftop Bar Two", city: "Bangkok", blurb: null, image_url: null,
          header_image_source: null, image_source_type: null, image_accuracy_status: null,
          category: "bar", primary_category: "bar", lat: 13.7, lng: 100.5,
          canonical_location_id: null, created_at: "2026-01-01T00:00:00Z", submitted_by: null,
          status: "active", saved_count: 0 },
      ],
    }));
    const r = await suggest({
      context: "place_picker", text: "rooftop bar",
      sessionContext: { tripId: TRIP_ID },
    });
    const body = await r.json() as any;
    const places = body.suggestions.filter((s: any) => s.entityType === "place");
    assert.equal(places.length, 2, "§18 says demote — the far row must still be reachable");
    assert.equal(places[0].entityId, "p-near", "the Trip-city row must lead");
    assert.ok((places[0].confidence ?? 0) > (places[1].confidence ?? 0));
  });

  it("the SAME request without a Trip leaves the two rows indistinguishable (the control)", async () => {
    setup(bkkTripState({
      discovery_places: [
        { id: "p-far", name: "Rooftop Bar One", city: "Da Nang", blurb: null, image_url: null,
          header_image_source: null, image_source_type: null, image_accuracy_status: null,
          category: "bar", primary_category: "bar", lat: 16.0, lng: 108.2,
          canonical_location_id: null, created_at: "2026-01-01T00:00:00Z", submitted_by: null,
          status: "active", saved_count: 0 },
        { id: "p-near", name: "Rooftop Bar Two", city: "Bangkok", blurb: null, image_url: null,
          header_image_source: null, image_source_type: null, image_accuracy_status: null,
          category: "bar", primary_category: "bar", lat: 13.7, lng: 100.5,
          canonical_location_id: null, created_at: "2026-01-01T00:00:00Z", submitted_by: null,
          status: "active", saved_count: 0 },
      ],
    }));
    const r = await suggest({ context: "place_picker", text: "rooftop bar" });
    const body = await r.json() as any;
    const places = body.suggestions.filter((s: any) => s.entityType === "place");
    assert.equal(places.length, 2);
    assert.equal(
      places[0].confidence, places[1].confidence,
      "with no task context the two rows must be identical — otherwise the test above proves nothing",
    );
  });

  it("an event outside the Trip's date window is demoted (§18 G124)", async () => {
    setup(bkkTripState({
      events: [
        // Seeded first AND earliest, so the underlying event search (which orders
        // by starts_at ascending) puts the OUT-OF-WINDOW row first on its own.
        { id: "evt-outside", title: "Riverside Bazaar Autumn", host_id: HOST, city: "Bangkok", country: "Thailand",
          starts_at: EVENT_OUTSIDE_ISO, visibility: "public", state: "published", created_at: "2026-01-01T00:00:00Z" },
        { id: "evt-inside", title: "Riverside Bazaar Winter", host_id: HOST, city: "Bangkok", country: "Thailand",
          starts_at: EVENT_INSIDE_ISO, visibility: "public", state: "published", created_at: "2026-01-01T00:00:00Z" },
      ],
    }));
    const r = await suggest({
      context: "global_search", text: "riverside bazaar",
      sessionContext: { tripId: TRIP_ID },
    });
    const body = await r.json() as any;
    const events = body.suggestions.filter((s: any) => s.entityType === "event");
    assert.equal(events.length, 2, "demoted, not filtered");
    assert.equal(events[0].entityId, "evt-inside", "the in-window event must lead");
    assert.ok(
      (events[0].confidence ?? 0) > (events[1].confidence ?? 0),
      "and it must lead BECAUSE of the window demotion, not by input order",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. §36 Impersonation (G233) — a confusable-handle demotion
//
// What existed was `account_status` filtering (a different fact about a
// different account) and, since Phase 9, the verified/official BADGES — which
// tell a reader what the genuine account looks like and do nothing to the copy.
// A handle built to be misread as a verified account's ranked exactly like any
// other substring match.
//
// G233 STAYS BUILT-BUT-WRONG after this, deliberately, and the last two tests
// here are what that costs: an impersonator that appears without its target is
// untouched, and BUSINESSES are not covered at all because no venue row carries
// a verification flag to be impersonated against.
// ═══════════════════════════════════════════════════════════════════════════════

describe("§36 impersonation (G233) — the confusable signature", () => {
  it("folds the substitutions an impersonating handle actually uses", () => {
    // MUTATION-PROOF: delete any one `.replace(...)` in handleSignature → the
    // corresponding equality below goes RED.
    const real = handleSignature("@portava");
    assert.equal(handleSignature("@p0rtava"), real, "digit-for-letter");
    assert.equal(handleSignature("@portavaa"), real, "a doubled letter");
    assert.equal(handleSignature("@port_ava"), real, "a separator");
    assert.equal(handleSignature("PORTAVA"), real, "case");
    assert.equal(handleSignature("@po" + "rn" + "ava"), handleSignature("@pomava"), "rn → m");
  });

  it("does NOT collapse two genuinely different handles", () => {
    // The narrowness IS the design: an edit-distance rule would fire on two
    // real people with similar names, and nothing here could tell those apart
    // from an impersonation.
    assert.notEqual(handleSignature("@sarah_travels"), handleSignature("@sara_travels"));
    assert.notEqual(handleSignature("@bangkok_eats"), handleSignature("@bangkok_beats"));
    assert.equal(handleSignature("@ab"), "", "too short to be a handle");
    assert.equal(handleSignature(null), "");
    assert.equal(handleSignature("@___"), "", "nothing survives the fold");
  });

  it("demotes the unverified twin, never the verified one, and never removes a row", () => {
    // MUTATION-PROOF: return `rows` unchanged from applyImpersonationRisk → RED.
    const rows = [
      { entityType: "user", subtitle: "@p0rtava", confidence: 0.9 },
      { entityType: "user", subtitle: "@portava", confidence: 0.85, verified: true },
    ];
    const out = applyImpersonationRisk(rows);
    assert.equal(out.length, 2, "a suspicion is not a moderation verdict — both rows survive");
    assert.ok(Math.abs(out[0]!.confidence! - (0.9 - IMPERSONATION_DEMOTION)) < 1e-9);
    assert.equal(out[1]!.confidence, 0.85, "the genuine account is untouched");
    assert.ok(out[0]!.confidence! < out[1]!.confidence!, "and the genuine account now leads");
    assert.ok(out[0]!.confidence! > 0, "a demotion is never a deletion");
  });

  it("is byte-identical when nothing in the answer is verified", () => {
    const rows = [
      { entityType: "user", subtitle: "@p0rtava", confidence: 0.9 },
      { entityType: "user", subtitle: "@portava", confidence: 0.85 },
    ];
    assert.equal(applyImpersonationRisk(rows), rows, "the identity case returns the SAME array");
  });

  it("never fires on a row that is not a person, whatever its subtitle says", () => {
    const rows = [
      { entityType: "place", subtitle: "@portava", confidence: 0.9 },
      { entityType: "user", subtitle: "@portava", confidence: 0.85, official: true },
    ];
    const out = applyImpersonationRisk(rows);
    assert.equal(out[0]!.confidence, 0.9, "a venue is not an impersonating handle");
  });
});

describe("§36 impersonation end-to-end (G233) — through POST /input-assistance/suggest", () => {
  const REAL = "bb000000-0000-4000-a000-000000000002";
  const FAKE = "cc000000-0000-4000-a000-000000000003";

  function person(id: string, handle: string, name: string, verified: boolean) {
    return {
      id, handle, username: handle, name, display_name: name, avatar_url: null,
      is_private: false, home_city: null, home_country: null, account_status: "active",
      verified, is_official: false, show_profile_picture_publicly: true,
    };
  }

  it("the verified account leads its confusable copy on the query they both match", async () => {
    // RED BEFORE THE FIX: with no impersonation term the two rows scored the
    // same match tier (both titles are "Portava Travel"), order fell back to
    // input order, and the FAKE — seeded first for exactly this reason — led.
    setup({
      profiles: [
        person(FAKE, "p0rtava", "Portava Travel", false),
        person(REAL, "portava", "Portava Travel", true),
      ],
      profile_privacy_settings: [
        { user_id: FAKE, show_real_name: true, allow_profile_discovery: true },
        { user_id: REAL, show_real_name: true, allow_profile_discovery: true },
      ],
      blocks: [], user_privacy_settings: [], user_follows: [], friend_requests: [],
      user_friendships: [], canonical_locations: [],
    });

    const r = await suggest({ context: "global_search", text: "Portava Travel" });
    const body = await r.json() as any;
    const people = body.suggestions.filter((s: any) => s.entityType === "user");
    assert.equal(people.length, 2, "both rows are still RETURNED — a demotion, not a removal");
    assert.equal(people[0].entityId, REAL, "the verified account must lead");
    assert.equal(people[0].verified, true, "and the reader is told which one it is (§28 G180)");
    assert.ok(
      (people[0].confidence ?? 0) > (people[1].confidence ?? 0),
      "and it must lead BECAUSE of confidence, not by luck of input order",
    );
  });

  it("CONTROL: two unrelated handles are left at an identical score", async () => {
    // Without this the test above could pass for a reason that has nothing to
    // do with the term — the trust boost alone would also lift the verified row.
    // Here NEITHER row is verified, so nothing may move.
    setup({
      profiles: [
        person(FAKE, "sara_travels", "Sara Travel", false),
        person(REAL, "sarah_travels", "Sara Travel", false),
      ],
      profile_privacy_settings: [
        { user_id: FAKE, show_real_name: true, allow_profile_discovery: true },
        { user_id: REAL, show_real_name: true, allow_profile_discovery: true },
      ],
      blocks: [], user_privacy_settings: [], user_follows: [], friend_requests: [],
      user_friendships: [], canonical_locations: [],
    });

    const r = await suggest({ context: "global_search", text: "Sara Travel" });
    const body = await r.json() as any;
    const people = body.suggestions.filter((s: any) => s.entityType === "user");
    assert.equal(people.length, 2);
    assert.equal(
      people[0].confidence, people[1].confidence,
      "two similar but unverified handles must stay indistinguishable",
    );
  });

  it("THE HOLE, pinned: an impersonator ALONE in the answer is not demoted (why G233 stays W)", async () => {
    // This is not a wish — it is the boundary of the rule, asserted so nobody
    // reads the term as broader coverage than it has. No verified twin is in
    // this answer, so there is nothing to compare against and the copy ranks
    // exactly as it did before. Closing it needs a handle index the suggestion
    // path does not have.
    setup({
      profiles: [person(FAKE, "p0rtava", "Portava Travel", false)],
      profile_privacy_settings: [{ user_id: FAKE, show_real_name: true, allow_profile_discovery: true }],
      blocks: [], user_privacy_settings: [], user_follows: [], friend_requests: [],
      user_friendships: [], canonical_locations: [],
    });

    const r = await suggest({ context: "global_search", text: "Portava Travel" });
    const body = await r.json() as any;
    const people = body.suggestions.filter((s: any) => s.entityType === "user");
    assert.equal(people.length, 1);
    const alone = people[0].confidence ?? 0;

    // The same row, with its target present, IS demoted — so the number above
    // is the undemoted score and this comparison is not vacuous.
    setup({
      profiles: [
        person(FAKE, "p0rtava", "Portava Travel", false),
        person(REAL, "portava", "Portava Travel", true),
      ],
      profile_privacy_settings: [
        { user_id: FAKE, show_real_name: true, allow_profile_discovery: true },
        { user_id: REAL, show_real_name: true, allow_profile_discovery: true },
      ],
      blocks: [], user_privacy_settings: [], user_follows: [], friend_requests: [],
      user_friendships: [], canonical_locations: [],
    });
    const r2 = await suggest({ context: "global_search", text: "Portava Travel" });
    const body2 = await r2.json() as any;
    const withTarget = body2.suggestions.find((s: any) => s.entityId === FAKE);
    assert.ok(
      (withTarget.confidence ?? 0) < alone,
      "co-occurrence is the whole trigger — that is the coverage G233 still lacks",
    );
  });
});
