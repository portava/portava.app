/**
 * Phase 7 — Compass + AI backend (Compass prompt assistance §56 + opt-in
 * AI-assisted writing §22), wired through the Phase-1 gateway.
 *
 * Run: node --import tsx/esm --test src/test/inputAssistanceCompassAI.test.ts
 *
 * Style: direct calls into the gateway + the aiWriting module with an injected
 * fake Supabase client (for the dedicated `compass_ai_writing_enabled` flag) and an injected
 * fake Compass AI client (_setTestOpenAI — the EXISTING LLM path, no new
 * provider). Proves:
 *   - §56 compass_prompt returns CONTEXTUAL (surface/Trip-aware) deterministic
 *     starters that CARRY STRUCTURED REFS (not a raw string);
 *   - §22 an opt-in AI writing suggestion is source:'ai' + type 'ai_suggestion',
 *     editable (replace_text), and creates NO canonical fact;
 *   - §9 an AI suggestion NEVER outranks a canonical entity;
 *   - the path is GATED: flag off / no opt-in / model unavailable ⇒ NO model
 *     ai_suggestion, while deterministic starters still return;
 *   - §29 the AI context excludes precise/private data (coords, address);
 *   - §47 model output is screened; a variant that fails is dropped.
 *
 * MUTATION-PROOFS (documented inline):
 *   A. aiWriting.buildAiAssistedWriting flag gate — deleting the
 *      `if (!enabled) return []` chokepoint makes the "no AI when the flag is
 *      off" assertion RED (AI rows appear with the flag off).
 *   B. projection.TYPE_RANK ai-last — ranking ai_suggestion (rank 9) above
 *      entity (rank 0) makes the "AI never outranks a canonical entity" test RED.
 *   C. aiWriting.sanitizeSuggestedText §47 screen — making it return the raw
 *      text instead of null on a private-location match makes the "unsafe
 *      variant dropped" test RED.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { generateSuggestions } from "../lib/inputAssistance/gateway.js";
import { resolvePolicy, POLICY_VERSION } from "../lib/inputAssistance/policyRegistry.js";
import { orderSuggestions } from "../lib/inputAssistance/projection.js";
import {
  buildAiAssistedWriting,
  buildPermittedWritingContext,
  sanitizeSuggestedText,
  isAiWritingContext,
  COMPASS_AI_WRITING_FLAG,
} from "../lib/inputAssistance/aiWriting.js";
import { _setTestOpenAI } from "../lib/openai.js";
import type { InputContext, InputSuggestion } from "../lib/inputAssistance/types.js";

const ME = "aa000000-0000-4000-a000-000000000001";

// ── Minimal fake Supabase client (feature_flags + blocks are all the AI paths
//    below touch; every other table returns []). ─────────────────────────────────
function makeClient(state: Record<string, any[]>) {
  return {
    from(table: string) {
      const rows = [...(state[table] ?? [])];
      const filters: Array<(r: any) => boolean> = [];
      const b: any = {
        select() { return b; },
        eq(c: string, v: any) { filters.push((r) => r[c] === v); return b; },
        neq(c: string, v: any) { filters.push((r) => r[c] !== v); return b; },
        in(c: string, vs: any[]) { filters.push((r) => vs.includes(r[c])); return b; },
        not() { return b; },
        is(c: string, v: any) { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return b; },
        ilike() { return b; },
        or() { return b; },
        gte() { return b; }, lt() { return b; }, gt() { return b; },
        order() { return b; }, limit() { return b; }, range() { return b; },
        maybeSingle() {
          const m = rows.filter((r) => filters.every((f) => f(r)));
          return Promise.resolve({ data: m[0] ?? null, error: null });
        },
        then(onF: any, onR: any) {
          const m = rows.filter((r) => filters.every((f) => f(r)));
          return Promise.resolve({ data: m, error: null }).then(onF, onR);
        },
      };
      return b;
    },
  };
}

/** State with the reused compass AI flag set to `enabled`. */
function flagState(enabled: boolean, extra: Record<string, any[]> = {}) {
  return {
    feature_flags: [{ flag: COMPASS_AI_WRITING_FLAG, enabled }],
    blocks: [],
    ...extra,
  };
}

// ── Fake Compass AI (the EXISTING getOpenAI path) ────────────────────────────────
function llmReturning(content: string, capture?: (opts: any) => void) {
  return {
    chat: {
      completions: {
        create: async (opts: any) => {
          capture?.(opts);
          return { choices: [{ message: { role: "assistant", content } }] };
        },
      },
    },
  } as any;
}
function llmThrowing() {
  return {
    chat: { completions: { create: async () => { throw new Error("model unavailable"); } } },
  } as any;
}

afterEach(() => { _setTestOpenAI(null); });

async function gen(
  sc: any,
  context: InputContext,
  text: string,
  opts: {
    aiAssist?: boolean;
    city?: string | null;
    draft?: Record<string, unknown>;
    sessionContext?: { tripId?: string; cityId?: string };
  } = {},
): Promise<InputSuggestion[]> {
  const policy = resolvePolicy(context)!;
  return generateSuggestions(sc, {
    context,
    policy,
    text,
    userId: ME,
    limit: policy.maxSuggestions,
    lat: null,
    lng: null,
    city: opts.city ?? null,
    draft: opts.draft as any,
    sessionContext: opts.sessionContext,
    aiAssist: opts.aiAssist ?? false,
    tz: null,
  });
}

const aiRows = (s: InputSuggestion[]) => s.filter((x) => x.type === "ai_suggestion");
const modelRows = (s: InputSuggestion[]) =>
  s.filter((x) => x.type === "ai_suggestion" && (x.reason ?? "").startsWith("AI-suggested"));
const starterRows = (s: InputSuggestion[]) =>
  s.filter((x) => x.type === "ai_suggestion" && x.reason === "Suggested prompt");

// ── 1. §56 Compass prompt assistance — contextual starters + structured refs ────

describe("§56 compass_prompt — contextual starters carrying structured refs", () => {
  it("returns deterministic starters that carry structured refs (not a raw string)", async () => {
    const sc = makeClient(flagState(true));
    const out = await gen(sc, "compass_prompt", "", {
      city: "Da Nang",
      sessionContext: { cityId: "city-danang", tripId: "trip-1" },
    });
    const starters = starterRows(out);
    assert.ok(starters.length > 0, "compass_prompt must return starter prompts");

    // Every starter carries a STRUCTURED value (refs), not merely raw text.
    for (const s of starters) {
      assert.ok(s.structuredValue && typeof s.structuredValue === "object",
        "a starter must carry structured refs, not just a raw string");
      const v = s.structuredValue as Record<string, unknown>;
      assert.equal(v.kind, "compass_prompt");
      assert.equal(v.surface, "compass");
      assert.equal(v.cityId, "city-danang");
      assert.equal(v.tripId, "trip-1");
      // §29: structured refs are coordinate-free.
      assert.ok(!("lat" in v) && !("lng" in v), "structured refs must not carry coordinates");
      // deterministic starters need no model → always an editable replace_text.
      assert.equal(s.action?.type, "replace_text");
    }

    // Contextual: at least one starter is tailored to the surface city.
    assert.ok(starters.some((s) => s.label.includes("Da Nang")),
      "starters should be tailored to the current surface/Trip city");
  });

  it("starters are DETERMINISTIC — present even with the AI flag OFF and no model", async () => {
    _setTestOpenAI(llmThrowing()); // model unavailable — must not matter for starters
    const sc = makeClient(flagState(false)); // AI flag OFF
    const out = await gen(sc, "compass_prompt", "", { city: "Tokyo" });
    assert.ok(starterRows(out).length > 0,
      "deterministic starters must not depend on the AI flag or model");
  });
});

// ── 2. §22 opt-in AI-assisted writing — a proposal, provenance-marked ───────────

describe("§22 AI-assisted writing — opt-in, editable, provenance-marked", () => {
  it("event_description with opt-in + flag on returns a source:'ai' ai_suggestion", async () => {
    _setTestOpenAI(llmReturning("Join us for a sunset rooftop meetup with fellow travelers."));
    const sc = makeClient(flagState(true));
    const out = await gen(sc, "event_description", "sunset meetup", {
      aiAssist: true,
      draft: { city: "Da Nang", category: "social" },
    });
    const model = modelRows(out);
    assert.equal(model.length, 1, "one AI writing suggestion should be proposed");
    const s = model[0]!;
    assert.equal(s.type, "ai_suggestion");
    assert.equal(s.source, "ai", "AI output must be provenance-marked source:'ai' (§8)");
    // §22: a PROPOSAL — editable replace_text, never auto-applied/published.
    assert.equal(s.action?.type, "replace_text");
    assert.equal(s.replacementText, s.label);
    assert.equal(s.reason, "AI-suggested draft");
    // Creates NO canonical fact — no entity binding of any kind.
    assert.equal(s.entityId, undefined, "an AI suggestion must not resolve to a canonical entity");
    assert.equal(s.entityType, undefined);
    assert.equal(s.policyVersion, POLICY_VERSION);
  });

  it("compass_prompt continuation carries structured refs and is editable", async () => {
    _setTestOpenAI(llmReturning("Where can I find a quiet dinner in Da Nang tonight?"));
    const sc = makeClient(flagState(true));
    const out = await gen(sc, "compass_prompt", "where eat", {
      aiAssist: true,
      city: "Da Nang",
      sessionContext: { cityId: "city-danang", tripId: "trip-1" },
    });
    const model = modelRows(out);
    assert.ok(model.length >= 1, "an opt-in AI continuation should be proposed");
    const s = model.find((r) => r.reason === "AI-suggested continuation")!;
    assert.ok(s, "compass_prompt continuation should be marked as such");
    assert.equal(s.source, "ai");
    assert.equal(s.action?.type, "replace_text"); // editable, never silently inserted
    const v = s.structuredValue as Record<string, unknown>;
    assert.ok(v && v.kind === "compass_prompt", "continuation must carry structured refs");
    assert.equal(v.cityId, "city-danang");
    assert.ok(!("lat" in v) && !("lng" in v));
  });
});

// ── 3. §9 AI never outranks a canonical entity (MUTATION-PROOF B) ───────────────

describe("§9 AI suggestion sorts AFTER a canonical entity", () => {
  it("an AI writing row never outranks a canonical entity regardless of confidence", async () => {
    _setTestOpenAI(llmReturning("A perfect spot for the evening."));
    const sc = makeClient(flagState(true));
    const built = await buildAiAssistedWriting(sc, {
      context: "caption",
      policy: resolvePolicy("caption")!,
      text: "great night",
      city: "Da Nang",
      policyVersion: POLICY_VERSION,
      max: 1,
    });
    assert.equal(built.length, 1);
    const ai = { ...built[0]!, confidence: 0.99 }; // even at max confidence…

    const entity: InputSuggestion = {
      id: "caption:place:p1",
      type: "entity",
      context: "caption",
      label: "Real Canonical Place",
      entityType: "place",
      entityId: "p1",
      action: { type: "open_entity", entityType: "place", entityId: "p1" },
      confidence: 0.1, // …and even at low confidence, the entity still leads.
      source: "canonical",
      policyVersion: POLICY_VERSION,
    };

    const ordered = orderSuggestions([ai, entity], 10);
    assert.equal(ordered[0]!.type, "entity", "a canonical entity must outrank AI (§9)");
    assert.equal(ordered[ordered.length - 1]!.type, "ai_suggestion", "AI sorts last");
  });
});

// ── 4. Gating — no model AI when flag off / no opt-in / model unavailable ────────

describe("AI writing is gated (flag + opt-in + availability) — MUTATION-PROOF A", () => {
  it("flag OFF ⇒ NO ai_suggestion for a writing context (even with opt-in + model)", async () => {
    _setTestOpenAI(llmReturning("This would be an AI caption."));
    const sc = makeClient(flagState(false)); // flag OFF
    const out = await gen(sc, "event_description", "sunset meetup", { aiAssist: true });
    assert.equal(aiRows(out).length, 0, "no AI suggestion may be produced when the flag is off");
  });

  it("flag OFF ⇒ compass_prompt keeps deterministic starters but NO model continuation", async () => {
    // "where" matches the canned starters AND is length >= 1, so the model
    // continuation WOULD run if the flag were on — proving the gate, not absence.
    _setTestOpenAI(llmReturning("Where can I eat tonight?"));
    const sc = makeClient(flagState(false));
    const out = await gen(sc, "compass_prompt", "where", { aiAssist: true, city: "Da Nang" });
    assert.ok(starterRows(out).length > 0, "deterministic starters still returned when gated");
    assert.equal(modelRows(out).length, 0, "no model continuation when the flag is off");
  });

  it("NO opt-in ⇒ NO model ai_suggestion even with the flag on", async () => {
    _setTestOpenAI(llmReturning("This would be an AI caption."));
    const sc = makeClient(flagState(true));
    const out = await gen(sc, "event_description", "sunset meetup", { aiAssist: false });
    assert.equal(aiRows(out).length, 0, "AI writing is opt-in — off by default");
  });

  it("model unavailable ⇒ degrades to no AI (never errors, never fabricates)", async () => {
    _setTestOpenAI(llmThrowing());
    const sc = makeClient(flagState(true));
    const out = await gen(sc, "event_description", "sunset meetup", { aiAssist: true });
    assert.equal(aiRows(out).length, 0, "an unavailable model degrades to no AI suggestion");
  });

  it("buildAiAssistedWriting returns [] directly when the flag is off (chokepoint)", async () => {
    _setTestOpenAI(llmReturning("An AI caption."));
    const sc = makeClient(flagState(false));
    const rows = await buildAiAssistedWriting(sc, {
      context: "caption",
      policy: resolvePolicy("caption")!,
      text: "great night",
      city: "Da Nang",
      policyVersion: POLICY_VERSION,
      max: 1,
    });
    assert.equal(rows.length, 0);
  });
});

// ── 5. §29 minimum context — AI never receives precise/private data ─────────────

describe("§29 AI context excludes precise/private data", () => {
  it("buildPermittedWritingContext keeps coarse city but drops coords + address", () => {
    const permitted = buildPermittedWritingContext({
      text: "great sunset",
      city: null,
      draft: {
        city: "Da Nang",
        country: "Vietnam",
        category: "food",
        lat: 12.3456,
        lng: 98.7654,
        address: "42 Hidden Alley, Apartment 9",
      } as any,
    });
    assert.equal(permitted.fields.city, "Da Nang");
    assert.equal(permitted.fields.country, "Vietnam");
    assert.ok(!("lat" in permitted.fields), "precise latitude must never reach the model");
    assert.ok(!("lng" in permitted.fields), "precise longitude must never reach the model");
    assert.ok(!("address" in permitted.fields), "a precise address must never reach the model");
  });

  it("the prompt sent to the model contains coarse city but NOT coords/address", async () => {
    let captured: any = null;
    _setTestOpenAI(llmReturning("A lovely evening out.", (opts) => { captured = opts; }));
    const sc = makeClient(flagState(true));
    await gen(sc, "event_description", "sunset meetup", {
      aiAssist: true,
      draft: { city: "Da Nang", lat: 12.3456, lng: 98.7654, address: "42 Hidden Alley" },
    });
    assert.ok(captured, "the model should have been called");
    const promptText = JSON.stringify(captured.messages);
    assert.ok(promptText.includes("Da Nang"), "coarse city context should flow to the model");
    assert.ok(!promptText.includes("12.3456"), "precise latitude must not appear in the prompt");
    assert.ok(!promptText.includes("98.7654"), "precise longitude must not appear in the prompt");
    assert.ok(!promptText.includes("42 Hidden Alley"), "a precise address must not appear in the prompt");
  });
});

// ── 6. §47 output moderation — an unsafe variant is dropped (MUTATION-PROOF C) ──

describe("§47 AI output passes the same moderation user text passes", () => {
  it("sanitizeSuggestedText drops a private-location variant, keeps a clean one", () => {
    assert.equal(sanitizeSuggestedText("Come to my room later tonight"), null,
      "a private-location proposal must be dropped");
    assert.equal(sanitizeSuggestedText("Meet me for an escort service"), null,
      "a policy-violating proposal must be dropped");
    const clean = sanitizeSuggestedText('"A cozy sunset spot downtown"');
    assert.equal(clean, "A cozy sunset spot downtown", "a clean variant is kept + de-quoted");
  });

  it("buildAiAssistedWriting drops an unsafe model variant and surfaces only the safe one", async () => {
    // Two variants: the first fails the §47 screen, the second is clean.
    _setTestOpenAI(llmReturning("Come to my room\nA relaxed evening downtown"));
    const sc = makeClient(flagState(true));
    const rows = await buildAiAssistedWriting(sc, {
      context: "caption",
      policy: resolvePolicy("caption")!,
      text: "night out",
      city: "Da Nang",
      policyVersion: POLICY_VERSION,
      max: 2,
    });
    assert.equal(rows.length, 1, "the unsafe variant must be dropped");
    assert.equal(rows[0]!.label, "A relaxed evening downtown");
  });
});

// ── 7. Registry sanity — the §22 writing contexts allow AI ─────────────────────

describe("§22 writing contexts are AI-eligible in the policy registry", () => {
  it("each AI writing context has allowAI + the ai_suggestion type", () => {
    for (const ctx of ["caption", "event_title", "event_description", "trip_title", "plan_title"] as InputContext[]) {
      assert.ok(isAiWritingContext(ctx), `${ctx} should be an AI writing context`);
      const p = resolvePolicy(ctx)!;
      assert.ok(p.allowAI, `${ctx} policy must allow AI`);
      assert.ok(p.allowedSuggestionTypes.includes("ai_suggestion"), `${ctx} must allow ai_suggestion`);
    }
  });
});
