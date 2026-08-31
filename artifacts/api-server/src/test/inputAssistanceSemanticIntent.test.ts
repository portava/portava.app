/**
 * Phase 6 — Semantic Intent (§18/§19/§21): natural-language → structured intent,
 * fed into the Phase-1 gateway for the search-like contexts.
 *
 * Run: node --import tsx/esm --test src/test/inputAssistanceSemanticIntent.test.ts
 *
 * Proves the §18/§19/§21 contract, DETERMINISTICALLY (no model call):
 *   - "rooftop bar near my hotel tonight" parses to
 *       {category:rooftop_bar, relationship:near, anchor:current_hotel, temporal:tonight}.
 *   - "food then somewhere busy" → staged {stage_1:food, stage_2:busy, sequence:true}.
 *   - The temporal / geographic / experience / sequence / relationship operators
 *     each parse (representative phrases from the §18 operator-class table).
 *   - §2/§19 LOW-confidence ⇒ the RAW query is preserved, never auto-replaced.
 *     Mutation-proved two ways: (a) the pure gate `buildStructuredSearchRow`
 *     returns null below MEDIUM confidence — forcing `shouldProjectStructured`
 *     true (auto-replace on low confidence) makes the null assertion RED; and
 *     (b) end-to-end, a low-confidence query returns EXACTLY the raw "SEARCH FOR"
 *     completion (its query === the user's text) and NO structured row — the same
 *     mutation adds a second submit_search whose query differs → RED.
 *   - "add Bangkok to my trip" → an add_to_trip action on the resolved city (§21).
 *   - A parse never outranks a strong canonical entity (§9): semantic rows are
 *     `action`/`ai_suggestion` types and sort AFTER entities.
 *
 * Reuses the fake-Supabase harness shape from inputAssistanceGlobalSearch.test.ts
 * (pure-logic, dead service-client host).
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
  parseSemanticIntent,
  parseSmartAction,
  extractTemporal,
  extractGeo,
  shouldProjectStructured,
  confidenceBand,
  SEMANTIC_MIN_CONFIDENCE,
} from "../lib/inputAssistance/semanticParser.js";
import {
  buildStructuredSearchRow,
  buildSequencedRows,
} from "../lib/inputAssistance/semanticIntent.js";
import { orderSuggestions } from "../lib/inputAssistance/projection.js";
import type { InputSuggestion } from "../lib/inputAssistance/types.js";

// ── Stable test UUIDs ──────────────────────────────────────────────────────────

const ME = "aa000000-0000-4000-a000-000000000001";
const ME_TOK = "tok-me";

// ── Fake Supabase client (harness shape shared with the gateway tests) ─────────

interface FakeState {
  [key: string]: any[] | undefined;
}

function makeFakeClient(state: FakeState, tableErrors: Set<string> = new Set()) {
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
    from: (table: string) => {
      if (tableErrors.has(table)) return errorBuilder;

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
        or() { return builder; },
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

function canonicalCity(id: string, name: string, normalized: string, country = "Thailand", code = "TH") {
  return {
    id,
    kind: "city",
    name,
    normalized_name: normalized,
    display_name: `${name}, ${country}`,
    city: null, region: null, country, country_code: code,
    postal_code: null, lat: 13.75, lng: 100.5, provider_ids: {}, aliases: [],
  };
}

// ── 1. The canonical §18 examples parse to structure ────────────────────────────

describe("§18 — canonical examples parse to structured intent", () => {
  it('"rooftop bar near my hotel tonight" → category/relationship/anchor/temporal', () => {
    const p = parseSemanticIntent("rooftop bar near my hotel tonight");
    assert.equal(p.category, "rooftop_bar");
    assert.equal(p.relationship, "near");
    assert.equal(p.anchor?.kind, "current_hotel");
    assert.equal(p.temporal?.type, "tonight");
    assert.equal(p.sequence, false);
    assert.ok(p.confidence >= SEMANTIC_MIN_CONFIDENCE, "a full four-operator parse is confident");
    // The raw text is preserved verbatim on the parse (§2).
    assert.equal(p.raw, "rooftop bar near my hotel tonight");
  });

  it('"food then somewhere busy" → staged {stage_1:food, stage_2:busy, sequence:true}', () => {
    const p = parseSemanticIntent("food then somewhere busy");
    assert.equal(p.sequence, true);
    assert.equal(p.stages.length, 2);
    assert.equal(p.stages[0]!.category, "food");
    assert.ok(
      p.stages[1]!.experienceQualifiers.includes("busy"),
      "stage 2 must carry the 'busy' experience qualifier",
    );
    assert.ok(p.confidence >= SEMANTIC_MIN_CONFIDENCE);
  });
});

// ── 2. Each §18 operator class parses ───────────────────────────────────────────

describe("§18 — temporal operators", () => {
  it("tonight / tomorrow morning / Friday after dinner / in two hours / when we arrive", () => {
    assert.equal(parseSemanticIntent("bars tonight").temporal?.type, "tonight");

    const morning = parseSemanticIntent("coffee tomorrow morning").temporal;
    assert.equal(morning?.type, "tomorrow_morning");
    assert.ok(morning?.startsAfter && morning?.startsBefore, "a morning window is normalized");
    assert.ok(new Date(morning!.startsAfter!) < new Date(morning!.startsBefore!));

    const friday = parseSemanticIntent("dinner friday after dinner").temporal;
    assert.equal(friday?.type, "weekday");
    assert.match(friday!.label, /Friday/);

    const inHours = parseSemanticIntent("food in two hours").temporal;
    assert.equal(inHours?.type, "in_hours");
    assert.ok(inHours?.startsAfter, "a relative-hours window has a lower bound");

    const arrival = parseSemanticIntent("somewhere to eat when we arrive").temporal;
    assert.equal(arrival?.type, "on_arrival");
    assert.equal(arrival?.deferred, true);
    assert.equal(arrival?.startsAfter, null, "an on-arrival time is not yet knowable");
  });

  it("extractTemporal strips the temporal expression from the query", () => {
    const { intent, stripped } = extractTemporal("rooftop bar tonight");
    assert.equal(intent?.type, "tonight");
    assert.equal(stripped, "rooftop bar");
  });
});

describe("§18 — geographic operators (relationship + anchor)", () => {
  it("near me / near my hotel / between us / along the way / close to airport / meeting point", () => {
    const nearMe = parseSemanticIntent("coffee near me");
    assert.equal(nearMe.relationship, "near");
    assert.equal(nearMe.anchor?.kind, "current_location");

    const hotel = parseSemanticIntent("bar near my hotel");
    assert.equal(hotel.anchor?.kind, "current_hotel");

    const between = parseSemanticIntent("food between us");
    assert.equal(between.relationship, "between");

    const along = parseSemanticIntent("coffee along the way");
    assert.equal(along.relationship, "along");

    const airport = parseSemanticIntent("hotel close to airport");
    assert.equal(airport.anchor?.kind, "airport");

    const meeting = parseSemanticIntent("drinks near our meeting point");
    assert.equal(meeting.anchor?.kind, "meeting_point");
  });

  it("a free-text place anchor is captured for the orchestrator to resolve", () => {
    const g = extractGeo("bars near da nang");
    assert.equal(g.relationship, "near");
    assert.equal(g.anchor?.kind, "place");
    assert.equal((g.anchor as any).text, "da nang");
    assert.equal(g.stripped, "bars");
  });
});

describe("§18 — relationship operators (crew / followed)", () => {
  it("with my Trip Crew / people I follow", () => {
    assert.equal(parseSemanticIntent("dinner with my trip crew").relationship, "with_crew");
    assert.equal(parseSemanticIntent("places i follow").relationship, "followed");
  });
});

describe("§18 — experience qualifiers", () => {
  it("quiet/social/luxury/cheap/local/hidden/busy/romantic/high-energy each parse", () => {
    const cases: Array<[string, string]> = [
      ["quiet cafe", "quiet"],
      ["social bar", "social"],
      ["luxury restaurant", "luxury"],
      ["cheap eats", "cheap"],
      ["local spot", "local"],
      ["a hidden gem", "hidden"],
      ["somewhere busy", "busy"],
      ["romantic dinner", "romantic"],
      ["high energy club", "high_energy"],
    ];
    for (const [text, qualifier] of cases) {
      const p = parseSemanticIntent(text);
      const all = new Set(p.stages.flatMap((s) => s.experienceQualifiers));
      assert.ok(all.has(qualifier as any), `"${text}" should parse experience "${qualifier}"`);
    }
  });
});

describe("§18 — sequence operators", () => {
  it("then / before split a query into ordered stages", () => {
    const then = parseSemanticIntent("drinks then dancing");
    assert.equal(then.sequence, true);
    assert.equal(then.stages.length, 2);

    const before = parseSemanticIntent("coffee before lunch");
    assert.equal(before.sequence, true);
    assert.equal(before.stages.length, 2);
  });
});

// ── 3. §2/§19 — LOW confidence preserves the raw query, never auto-replaces ──────

describe("§2/§19 — low confidence preserves the raw query", () => {
  // PURE mutation-proof of the gate. A lone experience qualifier ("somewhere
  // busy") is a LOW-confidence parse: a structured row must NOT be produced.
  //
  // Mutation-proof: forcing `shouldProjectStructured` to return true
  // unconditionally (auto-replace on low confidence) makes `buildStructuredSearchRow`
  // return a row here instead of null → the `=== null` assertion goes RED.
  it("buildStructuredSearchRow returns null below MEDIUM confidence", () => {
    const low = parseSemanticIntent("somewhere busy");
    assert.ok(
      ["low", "very_low"].includes(confidenceBand(low.confidence)),
      "a lone qualifier is below MEDIUM — a raw-preserving band",
    );
    assert.equal(shouldProjectStructured(low), false, "the §19 gate is closed below MEDIUM confidence");
    assert.equal(
      buildStructuredSearchRow("global_search", "test", low),
      null,
      "no structured row may be produced at low confidence (raw is preserved)",
    );

    // Sanity: the SAME builder DOES produce a row for a confident parse, so the
    // null above is the gate at work, not a builder that never returns anything.
    const high = parseSemanticIntent("rooftop bar near my hotel tonight");
    assert.ok(shouldProjectStructured(high));
    assert.notEqual(buildStructuredSearchRow("global_search", "test", high), null);
  });

  // END-TO-END: a low-confidence query returns EXACTLY the raw "SEARCH FOR"
  // completion — its query is the user's text verbatim — and NO structured row.
  //
  // Mutation-proof: the same auto-replace mutation adds a structured
  // submit_search whose query is the parsed residual ("busy"), not the raw text,
  // so BOTH assertions below (exactly one search affordance; its query === raw)
  // go RED, and the "no :semantic: row" assertion also fails.
  it("global_search keeps the raw query prominent and adds no structured row", async () => {
    setup({ canonical_locations: [], blocks: [], user_privacy_settings: [] });
    const raw = "somewhere busy";
    const r = await post({ context: "global_search", text: raw });
    assert.equal(r.status, 200);
    const body = (await r.json()) as any;
    const suggestions = body.suggestions as InputSuggestion[];

    const searchRows = suggestions.filter((s) => (s.action as any)?.type === "submit_search");
    assert.equal(searchRows.length, 1, "exactly one search affordance — the raw one");
    assert.equal((searchRows[0]!.action as any).query, raw, "the raw query is preserved verbatim (§2)");

    const semantic = suggestions.filter((s) => s.id.includes(":semantic:"));
    assert.equal(semantic.length, 0, "no structured semantic row at low confidence (§19)");
  });
});

// ── 4. §21 — smart action recognition ("add Bangkok to my trip") ────────────────

describe("§21 — smart action recognition", () => {
  it("parseSmartAction extracts the add-to-trip destination", () => {
    const sa = parseSmartAction("add Bangkok to my trip");
    assert.equal(sa?.kind, "add_to_trip");
    assert.equal(sa?.destinationText, "Bangkok");
  });

  it('"add Bangkok to my trip" → an add_to_trip action on the resolved city', async () => {
    const BKK = "canon-bangkok";
    setup({
      canonical_locations: [canonicalCity(BKK, "Bangkok", "bangkok")],
      blocks: [], user_privacy_settings: [],
    });
    const r = await post({ context: "global_search", text: "add Bangkok to my trip" });
    assert.equal(r.status, 200);
    const body = (await r.json()) as any;
    const suggestions = body.suggestions as InputSuggestion[];

    const addRow = suggestions.find((s) => (s.action as any)?.type === "add_to_trip");
    assert.ok(addRow, "an add_to_trip action must be surfaced");
    assert.equal((addRow!.action as any).entityId, BKK, "resolved to the canonical Bangkok city id");
    assert.equal(addRow!.entityType, "city");
    // The raw search affordance is still present — the action AUGMENTS it.
    assert.ok(
      suggestions.some((s) => (s.action as any)?.type === "submit_search"),
      "the raw search row remains alongside the smart action",
    );
  });

  it("proposes no add_to_trip when the destination does not resolve to a city", async () => {
    setup({ canonical_locations: [], blocks: [], user_privacy_settings: [] });
    const r = await post({ context: "global_search", text: "add Zzzznowhere to my trip" });
    const body = (await r.json()) as any;
    const suggestions = body.suggestions as InputSuggestion[];
    assert.ok(
      !suggestions.some((s) => (s.action as any)?.type === "add_to_trip"),
      "an unresolved destination yields no action (every accepted suggestion resolves, §2)",
    );
  });
});

// ── 5. §9 — a parse never outranks a strong canonical entity ─────────────────────

describe("§9 — a parse never outranks a canonical entity", () => {
  // Semantic rows are `action` / `ai_suggestion` types, which sort AFTER `entity`
  // rows in the projection ranker regardless of confidence. This is the same
  // §9-trust-order guarantee the suite proves for AI rows.
  //
  // Mutation-proof: giving a semantic row `type:"entity"` (or a rank above
  // entity) would let the parse lead — the entity-first assertion goes RED.
  it("orderSuggestions ranks a semantic action below a real entity even at higher confidence", () => {
    const semantic = buildStructuredSearchRow(
      "global_search",
      "test",
      parseSemanticIntent("rooftop bar near my hotel tonight"),
    )!;
    assert.ok(semantic, "expected a structured semantic row");
    assert.ok((semantic.confidence ?? 0) >= 0.9, "the parse is highly confident");

    const entity: InputSuggestion = {
      id: "e:1", type: "entity", context: "global_search", label: "Bangkok",
      entityType: "city", entityId: "c1",
      action: { type: "open_entity", entityType: "city", entityId: "c1" },
      confidence: 0.4, source: "canonical", policyVersion: "test",
    };

    const ordered = orderSuggestions([semantic, entity], 10);
    assert.equal(ordered[0]!.type, "entity", "a canonical entity must lead");
    assert.equal(ordered[1]!.type, "action", "the parse must sort below the entity (§9)");
  });
});

// ── 6. §18 — sequenced query → sequenced suggestions through the gateway ─────────

describe("§18 — sequenced query yields sequenced suggestions", () => {
  it('global_search returns ordered stage rows for "food then somewhere busy"', async () => {
    setup({ canonical_locations: [], blocks: [], user_privacy_settings: [] });
    const r = await post({ context: "global_search", text: "food then somewhere busy" });
    const body = (await r.json()) as any;
    const suggestions = body.suggestions as InputSuggestion[];

    const stageRows = suggestions.filter((s) => s.id.includes(":semantic:stage:"));
    assert.ok(stageRows.length >= 2, "expected one row per stage");
    const first = stageRows.find((s) => (s.structuredValue as any)?.stageIndex === 1);
    const second = stageRows.find((s) => (s.structuredValue as any)?.stageIndex === 2);
    assert.equal((first!.structuredValue as any).category, "food", "stage 1 is food");
    assert.ok(
      (second!.structuredValue as any).experienceQualifiers.includes("busy"),
      "stage 2 is busy",
    );
    for (const s of stageRows) assert.equal((s.structuredValue as any).sequence, true);

    // Pure builder check: the stage rows are `action` type (never entity).
    const built = buildSequencedRows("global_search", "test", parseSemanticIntent("food then somewhere busy"));
    assert.ok(built.every((s) => s.type === "action"));
  });
});

// ── 7. compass_prompt — structured interpretation is editable (§22) ─────────────

describe("§18/§22 — compass_prompt gets an editable structured interpretation", () => {
  it("returns an ai_suggestion carrying open_compass, with the raw text editable", async () => {
    setup({ canonical_locations: [] });
    const raw = "rooftop bar near my hotel tonight";
    const r = await post({ context: "compass_prompt", text: raw });
    const body = (await r.json()) as any;
    const suggestions = body.suggestions as InputSuggestion[];

    const semantic = suggestions.find((s) => s.id.includes(":semantic:compass"));
    assert.ok(semantic, "a structured compass interpretation must be offered");
    assert.equal(semantic!.type, "ai_suggestion");
    assert.equal((semantic!.action as any).type, "open_compass");
    // §22: the field is never silently replaced — the raw text stays editable.
    assert.equal(semantic!.replacementText, raw);
  });
});
