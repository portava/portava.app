/**
 * census-layover L100, L102–L113, L268 and census-compass CL-02 — the Layover
 * Compass assistant (services/airport/LayoverCompassAssistant.ts), under the
 * owner's decision of 2026-10-18 (lead rulings L-CL02a/c/d superseded; CL-02's
 * invariant kept: "hard safety cannot be overridden by Compass prose").
 *
 * NO REAL MODEL IS CALLED. Every case installs a deterministic double through
 * `_setTestOpenAI` that returns the tool calls and prose the case scripts —
 * including ADVERSARIAL prose that tries to widen the envelope, claim visa-free
 * entry, move the deadline or invent operational state.
 *
 *   1. The twelve tools: schema, argument validation, certified-only source,
 *      privacy scrub — one block per tool, plus a sweep over every tool and
 *      every certified state.
 *   2. The detector (enforceCompassEnvelope, hardened) and the admission gate
 *      (closed vocabulary): each adversarial sentence is caught.
 *   3. The assisted answer: the certified text leads; adversarial prose never
 *      reaches the traveller and is reported; innocent prose does reach them.
 *   4. §12.1: one question, the decisive one, including "the top plan".
 *   5. Fail closed: outage, timeout, empty reply, rate limit, endless tools,
 *      a certification that does not match.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/services/airport/__tests__/layoverCompassAssistant.test.ts
 */
import { describe, it, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _setTestOpenAI } from "../../../lib/openai.js";
import { _resetRateLimit } from "../../../lib/rateLimit.js";
import { certifySessionFeasibility, certificationHeader } from "../LayoverFeasibility.js";
import { certifiedPlanFit } from "../LayoverConstraints.js";
import { formatLocalTime } from "../AirportTime.js";
import { answerLayoverQuestion, certifiedLayoverText, layoverModelMayAnswer, valueOfInformation } from "../LayoverCompassService.js";
import type { EntryEligibility } from "../layoverEntryGate.js";
import type { CompassCrewCandidates } from "../../layover/LayoverCrewVisibility.js";
import { makeLayoverDb } from "../../../test/helpers/fakeLayoverDb.js";
import {
  ASSISTANT_CONTENT_NOUNS,
  ASSISTANT_VOCABULARY,
  LAYOVER_TOOL_NAMES,
  LAYOVER_TOOL_SCHEMAS,
  REPORT_FLIGHT_CHANGE_SENTENCE,
  admitModelSentence,
  answerLayoverQuestionWithAssistant,
  enforceCompassEnvelope,
  inSafetyLexicon,
  planAwareClarifications,
  runLayoverTool,
  runNamedLayoverTool,
  scrubForModel,
  toolSources, readLayoverOpportunities,
  validateToolArgs,
  type LayoverToolContext,
  type LayoverToolName,
  type LayoverToolSources,
  type ToolRecommendation,
  type ToolStop,
} from "../LayoverCompassAssistant.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const NOW = Date.UTC(2026, 9, 18, 16, 0, 0); // 09:00 in Los Angeles: every deadline below is the same local day
const MIN = 60_000;

const AP = {
  id: "ap-1", iataCode: "LAX", name: "Los Angeles International", city: "Los Angeles",
  country: "United States", countryCode: "US", timezone: "America/Los_Angeles",
  lat: 33.9416, lng: -118.4085, verified: true, terminalInfo: null,
  domesticBufferMin: 60, domesticBufferMax: 90, internationalBufferMin: 120, internationalBufferMax: 180,
  immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20,
} as never as Parameters<typeof certifySessionFeasibility>[0] & { name: string; iataCode: string; timezone: string; terminalInfo: unknown };

const PERMITTED: EntryEligibility = { state: "permitted", corridor: { passportCountry: "US", destinationCountry: "US" }, status: "visa_free" } as EntryEligibility;

function session(departInMin: number, over: Record<string, unknown> = {}) {
  return {
    id: "s1", userId: "u1", airportId: "ap-1", tripId: null,
    arrivalTime: new Date(NOW - 30 * MIN).toISOString(),
    departureTime: new Date(NOW + departInMin * MIN).toISOString(),
    boardingTime: null, layoverMinutes: departInMin + 30, flightType: "international",
    immigrationRequired: true, checkedBags: false, loungeAccess: false, wantsToLeave: true,
    comfortLevel: "moderate", vibeChips: ["food"], manualAirportName: null, manualCity: null,
    manualCountry: null, manualIata: null, canonicalCityId: null, shareCityStatus: false,
    returnReminderAt: null, status: "active", createdAt: "", updatedAt: "", ...over,
  } as never as import("../LayoverSessionService.js").LayoverSession;
}

/** Every certified state the door can be in, as (session, entry). The precondition block proves each. */
const STATES = [
  { name: "yes", verdict: "yes", session: () => session(600), entry: PERMITTED as EntryEligibility | null },
  { name: "no (no usable time)", verdict: "no", session: () => session(150), entry: PERMITTED },
  { name: "tight", verdict: "tight", session: () => session(270), entry: PERMITTED },
  { name: "entry_unverified", verdict: "entry_unverified", session: () => session(600), entry: null },
  { name: "stay_airside", verdict: "stay_airside", session: () => session(600, { wantsToLeave: false }), entry: PERMITTED },
  { name: "no (corridor refused)", verdict: "no", session: () => session(600), entry: { state: "refused", status: "visa_required", corridor: { passportCountry: "US", destinationCountry: "US" } } as EntryEligibility },
];
/** Landside CLOSED with a window to spare: the gate, not the clock, refuses a landside card. */
const REFUSED = STATES[5]!;
const YES = STATES[0]!;
const NOT_YES = STATES.slice(1);

const RECS: ToolRecommendation[] = [
  { id: "r-air", title: "Ramen Bar", recType: "food", insideAirport: true, activityTimeMin: 45, travelTimeMin: 0, safetyLabel: "Safe", warningReason: null },
  { id: "r-land", title: "Night Market Dumplings", recType: "food", insideAirport: false, activityTimeMin: 60, travelTimeMin: 30, safetyLabel: null, warningReason: null },
  { id: "r-spa", title: "Terminal Spa Retreat", recType: "relax", insideAirport: true, activityTimeMin: 900, travelTimeMin: 0, safetyLabel: null, warningReason: null },
];
const STOPS: ToolStop[] = [{ id: "st-1", title: "Lounge nap", durationMin: 60, travelMin: 0, insideAirport: true }];

/** Coordinates and identities planted in every source, so the scrub is load-bearing rather than vacuous. */
const POISON_COORD = "33.9425771, -118.4080123";
const OTHER_USER = "u-other-traveller-7";
function poisonedSources(over: Partial<LayoverToolSources> = {}): LayoverToolSources {
  const crew: CompassCrewCandidates = {
    ok: true,
    value: { inCrew: true, crew: { title: "Dumpling run", meetingPointLabel: "Food hall", meetingPointWithheld: [], expiresAt: new Date(NOW + 120 * MIN).toISOString(), memberCount: 3, maxMembers: 6, youAreOwner: false, crewId: "crew-9", members: [{ userId: OTHER_USER }], lat: 33.9425771 } },
  } as unknown as CompassCrewCandidates;
  return {
    recommendations: async () => ({ ok: true, value: RECS.map((r) => ({ ...r, lat: 33.9425771, lng: -118.4080123, placeId: "place-1", userId: OTHER_USER }) as never) }),
    stops: async () => ({ ok: true, value: STOPS.map((s) => ({ ...s, lat: 33.9425771, lng: -118.4080123 }) as never) }),
    crew: async () => crew,
    disruption: async () => ({ ok: true, value: { status: "known", state: "CONNECTION", reportedBy: "traveller", userId: OTHER_USER, coordinates: [33.9425771, -118.4080123] } }),
    opportunities: async () => ({ ok: true, value: [{ title: "Your layover options changed", why: `usable time fell by 45 minutes near ${POISON_COORD}`, priority: "important", at: new Date(NOW - MIN).toISOString() }] }),
    ...over,
  };
}

function ctxFor(s = YES.session(), entry: EntryEligibility | null = PERMITTED, sources: LayoverToolSources = poisonedSources(), db: unknown = null): LayoverToolContext {
  const airport = { ...(AP as object), terminalInfo: { T1: { label: `Gate area at ${POISON_COORD}`, lat: 33.9425771, lng: -118.4080123 } } } as never;
  const record = certifySessionFeasibility(airport, s, { nowMs: NOW, entry });
  return { db: db as never, session: s, airport, record, usableMinutes: record.envelope.usableMinutes, entry, nowMs: NOW, sources: toolSources(sources) };
}

/** A model double that records every request and replays a script of turns. */
function scripted(turns: Array<{ content?: string | null; tool_calls?: unknown[] } | "throw" | "hang">) {
  const seen: any[] = [];
  let i = 0;
  _setTestOpenAI({ chat: { completions: { create: async (req: unknown) => {
    seen.push(JSON.parse(JSON.stringify(req)));
    const t = turns[Math.min(i, turns.length - 1)]!;
    i += 1;
    if (t === "throw") throw new Error("upstream 503");
    if (t === "hang") return new Promise(() => {});
    return { choices: [{ message: { role: "assistant", content: t.content ?? null, tool_calls: t.tool_calls } }] };
  } } } } as never);
  return seen;
}
const call = (id: string, name: string, args: Record<string, unknown> | string) => ({ id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } });
const reply = (r: string, compare: Array<{ planRef: string; why: string }> = [], clarify: string | null = null) => ({ content: JSON.stringify({ reply: r, compare, clarify }) });

async function ask(state = YES, script: Parameters<typeof scripted>[0], over: Record<string, unknown> = {}) {
  const seen = scripted(script);
  const s = state.session();
  const a = await answerLayoverQuestionWithAssistant(null, {
    question: "What should I do with my layover?", session: s, airport: AP as never, entry: state.entry, nowMs: NOW,
    userId: "u1", sources: poisonedSources(), limits: { ratePerMinute: 1000 }, ...over,
  });
  const base = await answerLayoverQuestion({} as never, { question: "x", session: s, airport: AP as never, entry: state.entry, nowMs: NOW });
  return { a, seen, base };
}

beforeEach(() => _resetRateLimit());
afterEach(() => _setTestOpenAI(null));

// ── 0. preconditions ─────────────────────────────────────────────────────────

describe("precondition: every state certifies what its name says, on one local day", () => {
  for (const st of STATES) {
    it(`${st.name} certifies ${st.verdict}`, () => {
      const r = certifySessionFeasibility(AP, st.session(), { nowMs: NOW, entry: st.entry });
      assert.equal(r.verdict, st.verdict);
      assert.equal(layoverModelMayAnswer(r, r.envelope.usableMinutes), st.verdict === "yes");
    });
  }
  it("the yes deadline is later today in Los Angeles (so clocks are comparable)", () => {
    const r = certifySessionFeasibility(AP, YES.session(), { nowMs: NOW, entry: PERMITTED });
    const local = formatLocalTime(AP.timezone, r.deadline.hardReturnTime);
    assert.match(local, /^1[0-9]:[0-5]\d$/, local);
  });
});

// ── 1. The twelve tools ──────────────────────────────────────────────────────

describe("§12 the twelve tools: declarations and argument validation (L102–L113)", () => {
  it("the twelve names, in the spec's own order (§12 'Compass tools:')", () => {
    const spec = readFileSync(join(HERE, "../../../../../../docs/specs/Portava_Layover_Development_Architecture_Spec_v3.txt"), "utf8");
    const block = spec.slice(spec.indexOf("Compass tools:"), spec.indexOf("12.1 Value-of-information rule"));
    const names = [...block.matchAll(/^([a-zA-Z]+)\(/gm)].map((m) => m[1]);
    assert.deepEqual([...LAYOVER_TOOL_NAMES], names);
    assert.equal(names.length, 12);
  });
  it("each declaration is a strict function schema: sessionId required, every property required, nothing extra", () => {
    assert.equal(LAYOVER_TOOL_SCHEMAS.length, 12);
    for (const s of LAYOVER_TOOL_SCHEMAS) {
      const p = s.function.parameters as any;
      assert.equal(s.type, "function");
      assert.equal(s.function.strict, true, s.function.name);
      assert.equal(p.type, "object");
      assert.equal(p.additionalProperties, false, s.function.name);
      assert.deepEqual([...p.required].sort(), Object.keys(p.properties).sort(), s.function.name);
      assert.deepEqual(p.properties.sessionId, { type: "string" });
      assert.ok(typeof s.function.description === "string" && s.function.description.length > 20);
    }
    const props = (n: string) => Object.keys((LAYOVER_TOOL_SCHEMAS.find((s) => s.function.name === n)!.function.parameters as any).properties).sort();
    assert.deepEqual(props("simulatePlan"), ["candidateSet", "sessionId"]);
    assert.deepEqual(props("requestConstraintClarification"), ["field", "sessionId"]);
    assert.deepEqual(props("replan"), ["payload", "sessionId", "trigger"]);
    assert.deepEqual(props("explainDecision"), ["recommendationId", "sessionId", "snapshotId"]);
  });
  it("arguments: another session's id, an unknown key, a wrong type, a missing sessionId and an out-of-enum field are refused by name", () => {
    assert.deepEqual(validateToolArgs("getTimeWallet", { sessionId: "someone-else" }, "s1"), { ok: false, reason: "session_not_in_scope" });
    assert.deepEqual(validateToolArgs("getTimeWallet", { sessionId: "s1", userId: "u2" }, "s1"), { ok: false, reason: "unexpected_argument:userId" });
    assert.deepEqual(validateToolArgs("simulatePlan", { sessionId: "s1", candidateSet: "all" }, "s1"), { ok: false, reason: "invalid_argument:candidateSet" });
    assert.deepEqual(validateToolArgs("getTimeWallet", {}, "s1"), { ok: false, reason: "missing_argument:sessionId" });
    assert.deepEqual(validateToolArgs("requestConstraintClarification", { sessionId: "s1", field: "favouriteCuisine" }, "s1"), { ok: false, reason: "invalid_argument:field" });
    assert.deepEqual(validateToolArgs("replan", { sessionId: "s1", trigger: "flight.teleported", payload: null }, "s1"), { ok: false, reason: "invalid_argument:trigger" });
    assert.deepEqual(validateToolArgs("explainDecision", { sessionId: "s1" }, "s1"), { ok: true, args: { sessionId: "s1", snapshotId: null, recommendationId: null } });
  });
  it("a model-chosen call: an invented name, unparseable JSON and an array are refused, never thrown", async () => {
    const ctx = ctxFor();
    assert.deepEqual(await runNamedLayoverTool("bookMeAFlight", ctx, "{}"), { ok: false, tool: "bookMeAFlight", unavailable: true, reason: "unknown_tool:bookMeAFlight" });
    assert.equal(((await runNamedLayoverTool("getTimeWallet", ctx, "{not json")) as any).reason, "malformed_tool_arguments");
    assert.equal(((await runNamedLayoverTool("getTimeWallet", ctx, "[1]")) as any).reason, "malformed_tool_arguments");
    assert.equal(((await runNamedLayoverTool("getTimeWallet", ctx, JSON.stringify({ sessionId: "s2" }))) as any).reason, "session_not_in_scope");
    assert.equal((await runNamedLayoverTool("getTimeWallet", ctx, JSON.stringify({ sessionId: "s1" }))).ok, true);
  });
});

/** Every key anywhere in a value. */
function keysDeep(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.push(k); keysDeep(x, out); }
  return out;
}
const FORBIDDEN_KEY = /^(lat|lng|lon|latitude|longitude|coords|coordinates|geometry|centre|center|userid|user_id|crewid|crew_id|placeid|place_id|members|memberids)$/i;
function assertScrubbed(label: string, data: unknown) {
  const json = JSON.stringify(data);
  for (const k of keysDeep(data)) assert.ok(!FORBIDDEN_KEY.test(k), `${label}: key "${k}" reached the model`);
  assert.doesNotMatch(json, /-?\d{1,3}\.\d{4,}/, `${label}: a coordinate reached the model: ${json.slice(0, 300)}`);
  assert.ok(!json.includes(OTHER_USER), `${label}: another traveller's id reached the model`);
}

const ARGS: Record<LayoverToolName, Record<string, unknown>> = {
  getLayoverContext: { sessionId: "s1" },
  getConnectionState: { sessionId: "s1" },
  getTimeWallet: { sessionId: "s1" },
  getSafeEnvelope: { sessionId: "s1" },
  getReachableExperiences: { sessionId: "s1" },
  simulatePlan: { sessionId: "s1", candidateSet: null },
  getReturnContract: { sessionId: "s1" },
  getAirportState: { sessionId: "s1" },
  getCrewCandidates: { sessionId: "s1" },
  requestConstraintClarification: { sessionId: "s1", field: null },
  replan: { sessionId: "s1", trigger: "flight.departure_delayed", payload: { delayMinutes: 120, newDepartureTime: null, waitMinutes: null, extraMinutes: null, gate: null, condition: null, checkpoint: null } },
  explainDecision: { sessionId: "s1", snapshotId: null, recommendationId: null },
};

/** Every value a tool may NOT originate: the certified deadline and window, wherever they appear (outside `hypothetical`). */
function certifiedFieldsOf(data: unknown, path = ""): Array<{ path: string; key: string; value: unknown }> {
  const out: Array<{ path: string; key: string; value: unknown }> = [];
  if (Array.isArray(data)) data.forEach((x, i) => out.push(...certifiedFieldsOf(x, `${path}[${i}]`)));
  else if (data && typeof data === "object") {
    for (const [k, v] of Object.entries(data)) {
      if (k === "hypothetical" || k === "hypotheticalDiff") continue;
      if (["hardReturnTime", "backByTime", "hardReturnLocal", "usableMinutes"].includes(k)) out.push({ path: `${path}.${k}`, key: k, value: v });
      out.push(...certifiedFieldsOf(v, `${path}.${k}`));
    }
  }
  return out;
}

describe("§12 certified-only source: no tool, on any certified state, with any argument, emits a deadline or window that is not the record's", () => {
  for (const st of STATES) {
    for (const tool of LAYOVER_TOOL_NAMES) {
      it(`${st.name} / ${tool}`, async () => {
        const ctx = ctxFor(st.session(), st.entry);
        const r = await runLayoverTool(tool, ctx, ARGS[tool]);
        assert.equal(r.ok, true, JSON.stringify(r));
        const data = (r as any).data;
        for (const f of certifiedFieldsOf(data)) {
          if (f.key === "hardReturnTime" || f.key === "backByTime") assert.equal(f.value, ctx.record.deadline.hardReturnTime.toISOString(), `${tool}${f.path}`);
          if (f.key === "hardReturnLocal") assert.equal(f.value, formatLocalTime(AP.timezone, ctx.record.deadline.hardReturnTime), `${tool}${f.path}`);
          if (f.key === "usableMinutes") assert.equal(f.value, ctx.record.envelope.usableMinutes, `${tool}${f.path}`);
        }
        assertScrubbed(`${st.name}/${tool}`, data);
      });
    }
  }
  it("a model-supplied candidate set cannot borrow a certified plan's ref with smaller figures: refs resolve to the SERVER's figures", async () => {
    const ctx = ctxFor();
    const viaRef = await runLayoverTool("simulatePlan", ctx, { sessionId: "s1", candidateSet: [{ ref: "rec:r-spa", durationMin: 5, travelMin: 0, insideAirport: true }] });
    assert.equal((viaRef as any).data.fit, "over", "the spa's 900 stated minutes, not the model's 5");
    assert.equal((viaRef as any).data.modelSuppliedFigures, false);
    const unknown = await runLayoverTool("simulatePlan", ctx, { sessionId: "s1", candidateSet: [{ ref: "rec:invented", durationMin: 5, travelMin: 0, insideAirport: true }] });
    assert.deepEqual(unknown, { ok: false, tool: "simulatePlan", unavailable: true, reason: "unknown_plan_ref:rec:invented" });
    const omitted = await runLayoverTool("simulatePlan", ctxFor(NOT_YES[3]!.session(), null), { sessionId: "s1", candidateSet: [{ ref: null, durationMin: 30, travelMin: 10, insideAirport: null }] });
    assert.notEqual((omitted as any).data.fit, "fits", "an omitted insideAirport is landside, and the border is unconfirmed");
    assert.equal((await runLayoverTool("simulatePlan", ctx, { sessionId: "s1", candidateSet: Array(13).fill({ ref: null, durationMin: 1, travelMin: 0, insideAirport: true }) }) as any).reason, "too_many_candidates");
  });
});

describe("each tool: what it returns, read off the certified record (L102–L113)", () => {
  it("getLayoverContext (L102): the session and airport WITHOUT coordinates, and the record's certification header", async () => {
    const ctx = ctxFor();
    const d = ((await runLayoverTool("getLayoverContext", ctx, ARGS.getLayoverContext)) as any).data;
    assert.equal(d.sessionId, "s1");
    assert.deepEqual(d.certification, certificationHeader(ctx.record));
    assert.deepEqual(Object.keys(d.airport).sort(), ["city", "country", "iataCode", "name", "timezone", "verified"]);
    assert.deepEqual(d.interests, ["food"]);
  });
  it("getConnectionState (L103): status, live, return state from the record; disruption and OpportunityEvents with their read OUTCOME (L268)", async () => {
    const ctx = ctxFor();
    const d = ((await runLayoverTool("getConnectionState", ctx, ARGS.getConnectionState)) as any).data;
    assert.equal(d.returnState, ctx.record.envelope.returnState);
    assert.equal(d.live, true);
    assert.equal(d.disruption.state, "CONNECTION");
    assert.equal(d.latestOpportunities[0].title, "Your layover options changed");
    assert.match(d.latestOpportunities[0].why, /\[location hidden\]/);
    assert.doesNotMatch(d.latestOpportunities[0].why, /33\.9|118\.4/);
    const failing = ctxFor(YES.session(), PERMITTED, poisonedSources({ disruption: async () => ({ ok: false, reason: "ledger_unreadable" }), opportunities: async () => { throw new Error("boom"); } }));
    const f = ((await runLayoverTool("getConnectionState", failing, ARGS.getConnectionState)) as any).data;
    assert.equal(f.disruption, null);
    assert.equal(f.disruptionUnavailableReason, "ledger_unreadable");
    assert.equal(f.latestOpportunities, null, "an unreadable opportunity read is not 'no opportunities'");
    assert.equal(f.opportunitiesUnavailableReason, "layover_opportunities_unreadable");
  });
  it("getTimeWallet (L104) and getSafeEnvelope (L105): the record's figures; no geometry handed over", async () => {
    const ctx = ctxFor();
    const w = ((await runLayoverTool("getTimeWallet", ctx, ARGS.getTimeWallet)) as any).data;
    assert.deepEqual([w.totalMinutes, w.exitDelayMin, w.returnBufferMin, w.usableMinutes], [ctx.record.envelope.totalMinutes, ctx.record.envelope.exitDelayMin, ctx.record.envelope.returnBufferMin, ctx.record.envelope.usableMinutes]);
    const e = ((await runLayoverTool("getSafeEnvelope", ctx, ARGS.getSafeEnvelope)) as any).data;
    assert.equal(e.hardReturnTime, ctx.record.deadline.hardReturnTime.toISOString());
    assert.equal(e.landside.status, "open");
    assert.equal(e.geometry, undefined);
    assert.equal(e.geometryWithheldReason, "coordinates_are_not_shared_with_the_assistant");
  });
  it("getReachableExperiences (L106): each card with its CERTIFIED fit; a blocked one stays listed as unavailable; an unreadable read is refused, not []", async () => {
    const no = ctxFor(REFUSED.session(), REFUSED.entry);
    const d = ((await runLayoverTool("getReachableExperiences", no, ARGS.getReachableExperiences)) as any).data;
    assert.equal(d.experiences.length, 3);
    const land = d.experiences.find((x: any) => x.ref === "rec:r-land");
    assert.equal(land.available, false);
    assert.match(land.status, /^not available: the certified check does not allow leaving the airport/);
    for (const x of d.experiences) assert.equal(x.fit, certifiedPlanFit(no.record, [{ durationMin: RECS.find((r) => `rec:${r.id}` === x.ref)!.activityTimeMin, travelMin: RECS.find((r) => `rec:${r.id}` === x.ref)!.travelTimeMin, insideAirport: x.insideAirport }]).fit);
    assert.equal(d.reranked, false);
    const failing = ctxFor(YES.session(), PERMITTED, poisonedSources({ recommendations: async () => ({ ok: false, reason: "layover_recommendations_unreadable" }) }));
    assert.deepEqual(await runLayoverTool("getReachableExperiences", failing, ARGS.getReachableExperiences), { ok: false, tool: "getReachableExperiences", unavailable: true, reason: "layover_recommendations_unreadable" });
    const absent = ctxFor(YES.session(), PERMITTED, {});
    assert.equal(((await runLayoverTool("getReachableExperiences", absent, ARGS.getReachableExperiences)) as any).reason, "layover_recommendations_not_read");
  });
  it("simulatePlan (L107): the stored plan through certifiedPlanFit over the SAME record; an unreadable plan is refused, never 'fits'", async () => {
    const ctx = ctxFor();
    const d = ((await runLayoverTool("simulatePlan", ctx, ARGS.simulatePlan)) as any).data;
    assert.equal(d.fit, certifiedPlanFit(ctx.record, STOPS).fit);
    assert.equal(d.backByTime, ctx.record.deadline.hardReturnTime.toISOString());
    const failing = ctxFor(YES.session(), PERMITTED, poisonedSources({ stops: async () => ({ ok: false, reason: "layover_plan_stops_unreadable" }) }));
    assert.equal(((await runLayoverTool("simulatePlan", failing, ARGS.simulatePlan)) as any).reason, "layover_plan_stops_unreadable");
  });
  it("getReturnContract (L108): the record's deadline, airport-local; no invented route", async () => {
    const ctx = ctxFor();
    const d = ((await runLayoverTool("getReturnContract", ctx, ARGS.getReturnContract)) as any).data;
    assert.equal(d.hardReturnLocal, formatLocalTime(AP.timezone, ctx.record.deadline.hardReturnTime));
    assert.equal(d.bufferMinutes, ctx.record.deadline.breakdown.totalBuffer);
    assert.equal(d.route, null);
  });
  it("getAirportState (L109): curation and buffers; NO live operational state; curated terminal info scrubbed", async () => {
    const d = ((await runLayoverTool("getAirportState", ctxFor(), ARGS.getAirportState)) as any).data;
    assert.equal(d.liveOperationalState, null);
    assert.equal(d.liveUnavailableReason, "no_certified_operational_feed");
    assert.deepEqual(d.terminalInfo, { T1: { label: "Gate area at[location hidden]" } });
  });
  it("getCrewCandidates (L110): the crew card's read — no crew id, no member, no coordinate; a refusal keeps its reason", async () => {
    const d = ((await runLayoverTool("getCrewCandidates", ctxFor(), ARGS.getCrewCandidates)) as any).data;
    assert.equal(d.inCrew, true);
    assert.deepEqual(Object.keys(d.crew).sort(), ["expiresAt", "maxMembers", "meetingPointLabel", "meetingPointWithheld", "memberCount", "title", "youAreOwner"]);
    const offered = ctxFor(YES.session(), PERMITTED, poisonedSources({ crew: async () => ({ ok: true, value: { inCrew: false, city: "Los Angeles", candidates: [{ crewId: "crew-7", title: "Coffee crawl", meetingPointLabel: "Gate 40", maxMembers: 4, expiresAt: "2026-10-18T20:00:00.000Z" }], reason: null, meetWithheld: [] } }) }));
    const o = ((await runLayoverTool("getCrewCandidates", offered, ARGS.getCrewCandidates)) as any).data;
    assert.deepEqual(o.candidates, [{ title: "Coffee crawl", meetingPointLabel: "Gate 40", maxMembers: 4, expiresAt: "2026-10-18T20:00:00.000Z" }]);
    const gated = ctxFor(YES.session(), PERMITTED, poisonedSources({ crew: async () => ({ ok: true, value: { inCrew: false, city: "Los Angeles", candidates: [], reason: "safety_gate_not_passed", meetWithheld: ["safety_gate"] as never } }) }));
    assert.equal(((await runLayoverTool("getCrewCandidates", gated, ARGS.getCrewCandidates)) as any).data.reason, "safety_gate_not_passed");
    const unreadable = ctxFor(YES.session(), PERMITTED, poisonedSources({ crew: async () => ({ ok: false, reason: "layover_crew_unreadable" }) }));
    assert.equal(((await runLayoverTool("getCrewCandidates", unreadable, ARGS.getCrewCandidates)) as any).reason, "layover_crew_unreadable");
    assert.equal(((await runLayoverTool("getCrewCandidates", ctxFor(YES.session(), PERMITTED, {}), ARGS.getCrewCandidates)) as any).reason, "crew_candidates_not_read");
  });
  it("requestConstraintClarification (L111): asks, never writes; a field that moves nothing is not worth asking", async () => {
    const ctx = ctxFor();
    const all = ((await runLayoverTool("requestConstraintClarification", ctx, ARGS.requestConstraintClarification)) as any).data;
    assert.equal(all.writes, false);
    assert.deepEqual(all.asked, all.questions[0] ?? null);
    const noCtx = ctxFor(NOT_YES[0]!.session(), PERMITTED);
    const bags = ((await runLayoverTool("requestConstraintClarification", noCtx, { sessionId: "s1", field: "checkedBags" })) as any).data;
    assert.equal(bags.worthAsking, false, "no usable time either way: the bag answer moves nothing");
    assert.equal(bags.writes, false);
    const through = ((await runLayoverTool("requestConstraintClarification", ctx, { sessionId: "s1", field: "baggageThrough" })) as any).data;
    assert.match(through.unrepresentable.reason, /boolean/);
  });
  it("replan (L112): the server's §11.1 pipeline as a PREVIEW — current = the record, the event's effect under `hypothetical`, nothing applied", async () => {
    const ctx = ctxFor();
    const d = ((await runLayoverTool("replan", ctx, ARGS.replan)) as any).data;
    assert.equal(d.preview, true);
    assert.equal(d.applied, false);
    assert.equal(d.current.usableMinutes, ctx.record.envelope.usableMinutes);
    assert.ok(d.hypothetical.usableMinutes > d.current.usableMinutes, "a 120-minute departure delay widens only the HYPOTHETICAL window");
    assert.deepEqual(d.affectedNodes, ["session.departureTime", "session.boardingTime"]);
    assert.equal(((await runLayoverTool("replan", ctx, { sessionId: "s1", trigger: "flight.departure_delayed", payload: { delayMinutes: null, newDepartureTime: null, waitMinutes: null, extraMinutes: null, gate: null, condition: null, checkpoint: null } })) as any).reason, "event_rejected:bad_payload");
    assert.equal(((await runLayoverTool("replan", ctx, { sessionId: "s1", trigger: "flight.teleported", payload: null })) as any).reason, "unknown_trigger");
    const unreadable = ctxFor(YES.session(), PERMITTED, poisonedSources({ stops: async () => ({ ok: false, reason: "layover_plan_stops_unreadable" }) }));
    assert.equal(((await runLayoverTool("replan", unreadable, ARGS.replan)) as any).reason, "layover_plan_stops_unreadable");
    const returning = ((await runLayoverTool("replan", ctxFor(session(600, { status: "returning" })), ARGS.replan)) as any).data;
    assert.equal(returning.impacted, 0);
    assert.equal(returning.applied, false);
  });
  it("explainDecision (L113): the current record without a read; a stored snapshot only through the ledger door; an unknown card is refused", async () => {
    const ctx = ctxFor();
    const cur = ((await runLayoverTool("explainDecision", ctx, ARGS.explainDecision)) as any).data;
    assert.equal(cur.kind, "current_record");
    assert.deepEqual(cur.reasons, ctx.record.reasons);
    assert.equal(cur.verdict, ctx.record.verdict);
    const rec = ((await runLayoverTool("explainDecision", ctx, { sessionId: "s1", snapshotId: null, recommendationId: "rec:r-air" })) as any).data;
    assert.equal(rec.kind, "recommendation");
    assert.equal(rec.status, "inside the airport; fits your certified window");
    assert.equal(((await runLayoverTool("explainDecision", ctx, { sessionId: "s1", snapshotId: null, recommendationId: "r-unknown" })) as any).reason, "recommendation_not_in_certified_set");
    assert.equal(((await runLayoverTool("explainDecision", ctx, { sessionId: "s1", snapshotId: "snap:nothex", recommendationId: null })) as any).reason, "invalid_snapshot_id");
    const ledgerOff = ctxFor(YES.session(), PERMITTED, poisonedSources(), makeLayoverDb({ feature_flags: [] }));
    assert.equal(((await runLayoverTool("explainDecision", ledgerOff, { sessionId: "s1", snapshotId: `snap:${"a".repeat(32)}`, recommendationId: null })) as any).reason, "persistence_disabled");
  });
});

describe("the privacy scrub is load-bearing (every tool result passes through it)", () => {
  it("scrubForModel drops coordinate and identity keys at any depth and hides coordinates inside strings", () => {
    const out = scrubForModel({ a: { lat: 1.2345678, nested: [{ userId: "x", ok: `at ${POISON_COORD}` }] }, crewId: "c", keep: 1 });
    assert.deepEqual(out, { a: { nested: [{ ok: "at[location hidden]" }] }, keep: 1 });
  });
});

// ── 2. The detector and the gate ─────────────────────────────────────────────

/** Adversarial prose, by what it tries to widen. Census-compass §54.2's eight first. */
const ADVERSARIAL: Array<{ text: string; widens: "deadline" | "window" | "entry" | "risk" | "operational" | "vague" }> = [
  { text: "You've got until 19:45 before you need to think about security.", widens: "deadline" },
  { text: "Be back by quarter to eight and you will be fine.", widens: "deadline" },
  { text: "Just be back by 1945.", widens: "deadline" },
  { text: "Head back around 19.45 at the latest.", widens: "deadline" },
  { text: "You have the whole evening — about fifteen hours.", widens: "window" },
  { text: "Make sure you're back at security by 21:30.", widens: "deadline" },
  { text: "That gives you 9000 usable minutes, so go.", widens: "window" },
  { text: "You have about ten hours to play with.", widens: "window" },
  { text: "You won't need a visa for a short visit, so head into the city.", widens: "entry" },
  { text: "US passports are visa-free here, so entry is fine.", widens: "entry" },
  { text: "You don't need a visa, but double-check with the airline.", widens: "entry" },
  { text: "Immigration will be a breeze for you.", widens: "entry" },
  { text: "You don't need a visa here, though you can check the entry requirements to be sure.", widens: "entry" },
  { text: "It's safe to leave the airport.", widens: "risk" },
  { text: "The cathedral is a short cab away.", widens: "risk" },
  { text: "Rather than staying in, head into the city.", widens: "risk" },
  { text: "Don't stay inside, but explore the city!", widens: "risk" },
  { text: "Take a taxi downtown for dinner.", widens: "risk" },
  { text: "The night market is worth a visit.", widens: "risk" },
  { text: "Security is quick right now.", widens: "operational" },
  { text: "Your flight is delayed by an hour.", widens: "operational" },
  { text: "The SkyTrain between terminals is running.", widens: "operational" },
  { text: "Your gate is B12.", widens: "operational" },
  { text: "The queues are short today.", widens: "operational" },
  { text: "You have more than you think.", widens: "vague" },
  { text: "Plenty of room to wander about.", widens: "vague" },
  { text: "Puedes salir a la ciudad, tienes tiempo de sobra.", widens: "vague" },
  { text: "街に出かけても大丈夫です。", widens: "vague" },
  { text: "Din Tai Fung downtown is great.", widens: "vague" },
  { text: "You can get there and back easily.", widens: "vague" },
  { text: "Your plans look great, enjoy them.", widens: "vague" },
];

function envelopeFor(st: (typeof STATES)[number]) {
  const r = certifySessionFeasibility(AP, st.session(), { nowMs: NOW, entry: st.entry });
  const yes = layoverModelMayAnswer(r, r.envelope.usableMinutes);
  return { r, ctx: { airport: AP, hardReturnTime: r.deadline.hardReturnTime, usableMinutes: r.envelope.usableMinutes, verdict: r.verdict, explicitYes: yes, safeBand: yes && r.envelope.usableMinutes >= 60, nowMs: NOW } };
}

describe("layer 3 — enforceCompassEnvelope catches every widening it is for, on a not-yes verdict", () => {
  const { ctx } = envelopeFor(NOT_YES[0]!);
  for (const a of ADVERSARIAL.filter((x) => x.widens !== "vague")) {
    it(`${a.widens}: ${a.text}`, () => {
      const v = enforceCompassEnvelope(a.text, ctx);
      assert.equal(v.ok, false, a.text);
      const want = ({ deadline: "return_deadline_widened", window: "usable_time_widened", entry: "entry_status_asserted", risk: "risk_band_widened", operational: "operational_state_asserted" } as Record<string, string>)[a.widens];
      assert.ok(v.violations.some((x) => x.kind === want), `${a.text}: ${JSON.stringify(v.violations)}`);
    });
  }
  it("talking the band DOWN, admitting not knowing, and the server's own certified sentences pass", () => {
    for (const ok of ["It is not safe to leave the airport on this layover.", "We can't confirm whether you need a visa.", "Stay inside and enjoy the lounge."]) {
      assert.deepEqual(enforceCompassEnvelope(ok, ctx).violations, [], ok);
    }
    const y = envelopeFor(YES);
    const text = certifiedLayoverText({ record: y.r, usableMin: y.r.envelope.usableMinutes, bufferMin: y.r.deadline.breakdown.totalBuffer, hardReturnLocal: formatLocalTime(AP.timezone, y.r.deadline.hardReturnTime) });
    assert.deepEqual(enforceCompassEnvelope(text, y.ctx).violations, [], "a guard the server cannot satisfy is not a guard");
  });
  it("a deadline on another local day is not comparable: every clock time is refused (it used to be skipped)", () => {
    const late = { ...ctx, hardReturnTime: new Date(NOW + 20 * 60 * MIN) };
    assert.equal(enforceCompassEnvelope("Back by 06:00.", late).ok, false);
  });
});

describe("layer 4 — the closed vocabulary admits taste, and nothing else", () => {
  it("no vocabulary word is in the safety lexicon, and every content noun is in the vocabulary", () => {
    const clash = [...ASSISTANT_VOCABULARY].filter((w) => inSafetyLexicon(w));
    assert.deepEqual(clash, []);
    for (const n of ASSISTANT_CONTENT_NOUNS) assert.ok(ASSISTANT_VOCABULARY.has(n), n);
  });
  for (const a of ADVERSARIAL) {
    it(`withheld: ${a.text}`, () => {
      assert.equal(admitModelSentence(a.text, ["Ramen Bar", "Los Angeles International"]).ok, false);
    });
  }
  it("admitted: taste-led sentences about certified names and airside amenities", () => {
    for (const ok of ["Since you love food, the Ramen Bar is a great pick.", "The lounge offers a calm spot to recharge.", "If you prefer something sweet, a pastry with coffee could suit you."]) {
      assert.deepEqual(admitModelSentence(ok, ["Ramen Bar"]), { ok: true }, ok);
    }
  });
  it("a question is never admitted — §12.1's question is the server's", () => {
    assert.deepEqual(admitModelSentence("Would you like some coffee?", []), { ok: false, reason: "question" });
  });
});

// ── 3. The assisted answer ───────────────────────────────────────────────────

describe("CL-02 through the assisted answer: adversarial prose never reaches the traveller, on ANY certified state", () => {
  for (const st of STATES) {
    for (const a of ADVERSARIAL) {
      it(`${st.name}: ${a.text}`, async () => {
        const { a: ans, base } = await ask(st, [reply(a.text, [{ planRef: "rec:r-air", why: a.text }])]);
        assert.ok(ans.answer.startsWith(base.answer), `the certified text must lead: ${ans.answer}`);
        assert.ok(!ans.answer.includes(a.text.split(/[,.—!]/)[0]!.trim()), `the model's words reached the traveller: ${ans.answer}`);
        assert.ok(!JSON.stringify(ans).includes(a.text.split(/[,.—!]/)[0]!.trim()), "the model's words are nowhere in the response, diagnostics included");
        assert.equal(ans.safetyNote, base.safetyNote);
        assert.equal(ans.hardReturnTime, base.hardReturnTime);
        assert.deepEqual(ans.certification, base.certification);
        if (a.widens !== "vague" && !(st.verdict === "yes" && a.widens === "risk")) {
          assert.ok(ans.boundaryViolations.length > 0, `the attempt must be reported: ${a.text}`);
          assert.equal(ans.assistant.fallbackReason, "boundary_violation");
          assert.equal(ans.answer, base.answer, "a detected widening withdraws EVERYTHING the model wrote");
        }
      });
    }
  }
});

describe("L100 — the model orchestrates and explains: tools invoked, plans compared from the certified record, wording personalised", () => {
  it("tools are offered, chosen, run; the certified text leads; admitted wording follows; the comparison is the SERVER's certified fit", async () => {
    const { a, seen, base } = await ask(YES, [
      { tool_calls: [call("c1", "getReachableExperiences", { sessionId: "s1" }), call("c2", "getReturnContract", { sessionId: "s1" })] },
      reply("Since you love food, the Ramen Bar is a great pick.", [
        { planRef: "rec:r-air", why: "A hearty bowl of ramen suits your mood." },
        { planRef: "rec:r-spa", why: "The spa offers a calm treat." },
        { planRef: "rec:invented", why: "A lovely bar." },
      ]),
    ]);
    assert.equal(seen.length, 2);
    assert.deepEqual(seen[0].tools.map((t: any) => t.function.name), [...LAYOVER_TOOL_NAMES]);
    const toolMsgs = seen[1].messages.filter((m: any) => m.role === "tool").map((m: any) => JSON.parse(m.content));
    assert.equal(toolMsgs[1].data.hardReturnTime, base.hardReturnTime, "the model READ the certified deadline from the tool");
    assert.deepEqual(a.toolsConsulted, ["getReachableExperiences", "getReturnContract"]);
    assert.ok(a.answer.startsWith(base.answer));
    assert.match(a.answer, /Since you love food, the Ramen Bar is a great pick\./);
    assert.deepEqual(a.planComparison.map((l) => [l.planRef, l.available, l.status]), [
      ["rec:r-air", true, "inside the airport; fits your certified window"],
      ["rec:r-spa", false, "does not fit your certified window"],
    ], "an invented plan is not compared; an overflowing one says so in the server's words");
    assert.equal(a.planComparison[0]!.note, "A hearty bowl of ramen suits your mood.");
    assert.equal(a.planComparison[1]!.note, null, "an unavailable plan never carries a model endorsement");
    assert.match(a.answer, /Comparing your options: Ramen Bar — inside the airport; fits your certified window\. A hearty bowl/);
    assert.deepEqual(a.modelProse.mode, "confined");
    assert.equal(a.modelConsulted, true);
    assert.deepEqual(a.assistant, { enabled: true, status: "answered", fallbackReason: null, model: "gpt-5-mini" });
    assert.deepEqual(a.boundaryViolations, []);
  });
  it("on a NOT-yes layover the landside card is compared as unavailable, and the model may not even NAME it", async () => {
    const { a } = await ask(REFUSED, [reply("Night Market Dumplings is a lovely choice.", [{ planRef: "rec:r-land", why: "Night Market Dumplings is a tasty pick." }])]);
    assert.ok(!/lovely choice|tasty pick/.test(a.answer), a.answer);
    assert.equal(a.planComparison[0]!.available, false);
    assert.match(a.planComparison[0]!.status, /^not available/);
    assert.equal(a.planComparison[0]!.note, null);
  });
  it("the model's requests carry no coordinate and no other traveller's identity", async () => {
    const { seen } = await ask(YES, [
      { tool_calls: LAYOVER_TOOL_NAMES.map((n, i) => call(`c${i}`, n, ARGS[n])) },
      reply("The lounge offers a calm spot to recharge."),
    ], { limits: { ratePerMinute: 1000, maxToolCallsPerRound: 12 } });
    const json = JSON.stringify(seen);
    assert.doesNotMatch(json, /33\.94\d{2,}|-118\.40\d{2,}/, "a coordinate reached the model");
    assert.ok(!json.includes(OTHER_USER));
    assert.doesNotMatch(json, /"(lat|lng|userId|crewId|placeId)"/);
  });
  it("replan on a flight change: the server's 'report it' sentence, never the hypothetical figures", async () => {
    const { a } = await ask(YES, [{ tool_calls: [call("c1", "replan", ARGS.replan)] }, reply("The lounge offers a calm spot to recharge.")]);
    assert.ok(a.answer.includes(REPORT_FLIGHT_CHANGE_SENTENCE));
    assert.deepEqual(a.toolsConsulted, ["replan"]);
  });
});

// ── 4. §12.1 ─────────────────────────────────────────────────────────────────

describe("§12.1 — the clarifying question is the minimum one that changes eligibility, safety, risk band or the top plan (L111/L114)", () => {
  it("never a field whose answer moves nothing, at most one, and it is the highest-value one", async () => {
    const st = NOT_YES[0]!;
    const all = planAwareClarifications(AP, st.session(), NOW, st.entry, []);
    assert.ok(!all.some((q) => q.field === "checkedBags"), "no usable time either way: bags move nothing");
    const { a } = await ask(st, [reply("The lounge offers a calm spot to recharge.")]);
    assert.deepEqual(a.clarifyingQuestion?.field ?? null, all[0]?.field ?? null);
  });
  it("THE TOP PLAN: a flip that moves neither verdict nor band but changes which plan fits first gains a decisive score, and outranks a bigger minute change", () => {
    const s = session(600, { checkedBags: false, immigrationRequired: true });
    const base = certifySessionFeasibility(AP, s, { nowMs: NOW, entry: PERMITTED });
    const usable = base.envelope.usableMinutes;
    // A plan that needs exactly the window: it fits now and stops fitting the moment a bag adds its 15 minutes.
    const plans = [
      { ref: "rec:exact", title: "Chef's counter", stops: [{ durationMin: usable, travelMin: 0, insideAirport: true }] },
      { ref: "rec:short", title: "Coffee", stops: [{ durationMin: 20, travelMin: 0, insideAirport: true }] },
    ];
    const plain = valueOfInformation(AP, s, NOW, PERMITTED);
    const aware = planAwareClarifications(AP, s, NOW, PERMITTED, plans);
    const bags = aware.find((q) => q.field === "checkedBags")!;
    assert.equal(bags.impact.topPlanChanges, true);
    assert.equal(bags.impact.verdictChanges, false);
    assert.equal(bags.impact.riskBandChanges, false);
    assert.equal(bags.valueOfInformation, (plain.find((q) => q.field === "checkedBags")?.valueOfInformation ?? 0) + 100);
    const rank = (list: Array<{ field: string }>, f: string) => list.findIndex((q) => q.field === f);
    assert.ok(rank(plain, "immigrationRequired") < rank(plain, "checkedBags"), `fixture: the minute change alone ranks immigration first ${JSON.stringify(plain.map((q) => [q.field, q.valueOfInformation]))}`);
    assert.ok(rank(aware, "checkedBags") < rank(aware, "immigrationRequired"), `the top-plan change outranks it ${JSON.stringify(aware.map((q) => [q.field, q.valueOfInformation]))}`);
    assert.equal(aware[0]!.field, "wantsToLeave", "the verdict-flipping question is still the one asked: one question, the decisive one");
    const withoutPlans = planAwareClarifications(AP, s, NOW, PERMITTED, []);
    assert.deepEqual(withoutPlans.map((q) => [q.field, q.valueOfInformation]), plain.map((q) => [q.field, q.valueOfInformation]), "no plans: exactly the measured four-noun ranking");
  });
  it("the model cannot add a question, nor swap in a weaker one", async () => {
    const st = YES;
    const { a } = await ask(st, [reply("Do you have checked bags? What cuisine do you like? The lounge offers a calm spot to recharge.", [], "wantsToLeave")]);
    assert.ok(!/\?/.test(a.answer.slice(a.answer.indexOf("The lounge"))), a.answer);
    const expected = planAwareClarifications(AP, st.session(), NOW, st.entry, [
      { ref: "plan:stored", title: "Your saved plan", stops: STOPS },
      ...RECS.map((r) => ({ ref: `rec:${r.id}`, title: r.title, stops: [{ durationMin: r.activityTimeMin, travelMin: r.travelTimeMin, insideAirport: r.insideAirport }] })),
    ])[0] ?? null;
    assert.deepEqual(a.clarifyingQuestion?.field ?? null, expected?.field ?? null);
    assert.ok(a.modelProse.droppedSentences >= 2);
  });
});

// ── 5. Fail closed ───────────────────────────────────────────────────────────

describe("fail closed: every model failure answers with the certified text alone, and says why", () => {
  it("an outage (the client throws)", async () => {
    const { a, base } = await ask(YES, ["throw"]);
    assert.equal(a.answer, base.answer);
    assert.deepEqual([a.assistant.status, a.assistant.fallbackReason, a.modelConsulted], ["fallback", "model_error", true]);
  });
  it("a timeout (the client never answers) — bounded by the per-call limit, not by the traveller's patience", async () => {
    const t0 = Date.now();
    const { a, base } = await ask(YES, ["hang"], { limits: { ratePerMinute: 1000, perCallTimeoutMs: 60 } });
    assert.ok(Date.now() - t0 < 3000);
    assert.equal(a.answer, base.answer);
    assert.equal(a.assistant.fallbackReason, "model_timeout");
  });
  it("an empty reply", async () => {
    const { a, base } = await ask(YES, [{ content: "" }]);
    assert.equal(a.answer, base.answer);
    assert.equal(a.assistant.fallbackReason, "model_empty");
  });
  it("a model that never stops calling tools: bounded rounds, then a tool-less final round", async () => {
    const { a, seen } = await ask(YES, [{ tool_calls: [call("c1", "getTimeWallet", { sessionId: "s1" })] }]);
    assert.equal(seen.length, 5, "four tool rounds and one forced final round");
    assert.equal(seen[4].tools, undefined, "the final round offers no tools");
    assert.equal(a.assistant.status, "fallback");
  });
  it("the rate limit: over it, no model call at all", async () => {
    const first = await ask(YES, [reply("The lounge offers a calm spot to recharge.")], { limits: { ratePerMinute: 1 } });
    assert.equal(first.a.assistant.status, "answered");
    const second = await ask(YES, [reply("The lounge offers a calm spot to recharge.")], { limits: { ratePerMinute: 1 } });
    assert.equal(second.seen.length, 0);
    assert.deepEqual([second.a.assistant.fallbackReason, second.a.modelConsulted, second.a.answer], ["rate_limited", false, second.base.answer]);
  });
  it("a certification that does not match the answer's: no model call", async () => {
    const other = await answerLayoverQuestion({} as never, { question: "x", session: session(300), airport: AP as never, entry: PERMITTED, nowMs: NOW });
    const { a, seen } = await ask(YES, [reply("The lounge offers a calm spot to recharge.")], { base: other });
    assert.equal(seen.length, 0);
    assert.equal(a.assistant.fallbackReason, "certification_mismatch");
  });
  it("invented tools and unparseable arguments are refused results the model can read, never a throw", async () => {
    const { a, seen } = await ask(YES, [{ tool_calls: [call("c1", "bookMeAFlight", {}), call("c2", "getTimeWallet", "{not json")] }, reply("The lounge offers a calm spot to recharge.")]);
    const results = seen[1].messages.filter((m: any) => m.role === "tool").map((m: any) => JSON.parse(m.content).reason);
    assert.deepEqual(results, ["unknown_tool:bookMeAFlight", "malformed_tool_arguments"]);
    assert.deepEqual(a.toolsConsulted, []);
    assert.equal(a.assistant.status, "answered");
  });
});

// Independent-review regressions: each input previously bypassed a different boundary.
describe("resumed review — assistant admissions cannot endorse unavailable plans or invent permission", () => {
  it("a refused title made entirely of admitted vocabulary is withheld in replies and comparison notes", async () => {
    const recs = RECS.map((r) => r.id === "r-land" ? { ...r, title: "Local Food Spot" } : r);
    const sentence = "Local Food Spot is the best pick for you.";
    const { a } = await ask(REFUSED, [reply(sentence, [
      { planRef: "rec:r-land", why: sentence },
      { planRef: "rec:r-air", why: sentence },
    ])], { sources: poisonedSources({ recommendations: async () => ({ ok: true, value: recs }) }) });
    assert.ok(!a.answer.includes(sentence), a.answer);
    assert.equal(a.planComparison[0]!.available, false);
    assert.equal(a.planComparison[0]!.note, null);
    assert.equal(a.planComparison[1]!.note, null, "an available comparison must not endorse a refused neighbor");
    assert.match(a.planComparison[0]!.status, /^not available/);
  });
  for (const text of ["Enjoy the ramen 2330.", "Enjoy the food ★.", "You have much more than you think \u0001."]) {
    it(`isolates the admission rule for ${JSON.stringify(text)}`, () => {
      assert.equal(admitModelSentence(text, ["Ramen Bar"]).ok, false);
    });
  }
  for (const text of [
    "You have much more than you think, so enjoy the food.",
    "You may have the famous local food; it is the best choice on this layover.",
    "You have the layover to enjoy the food, so take the local place.",
  ]) {
    it(`a food noun does not admit implied permission: ${text}`, async () => {
      assert.equal(admitModelSentence(text, ["Ramen Bar"]).ok, false);
      const { a, base } = await ask(REFUSED, [reply(text)]);
      assert.equal(a.answer, base.answer);
    });
  }
  it("opportunities are restricted to both the viewer and the exact session", async () => {
    const event = { event_type: "compass.layover.opportunity", body: "Changed", priority: "normal", created_at: new Date(NOW).toISOString() };
    const db = makeLayoverDb({ notifications: [
      { ...event, id: "n-own", user_id: "u1", action_url: "/airport/sessions/s1", title: "Own" },
      { ...event, id: "n-other-user", user_id: "u2", action_url: "/airport/sessions/s1", title: "Private" },
      { ...event, id: "n-other-session", user_id: "u1", action_url: "/airport/sessions/s2", title: "Other session" },
    ] });
    const result = await readLayoverOpportunities(db as never, "u1", "s1");
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.value.map((v) => v.title), ["Own"]);
  });
});

describe("resumed review — load-bearing blocked-name and marker checks", () => {
  for (const title of ["Coffee Spot", "Coffee  Spot", "coffee-spot"]) {
    it(`cannot endorse the refused Coffee Spot as ${title}`, async () => {
      const sentence = `${title} is a great pick.`;
      const recs = RECS.map((r) => r.id === "r-land" ? { ...r, title: "Coffee Spot" } : r);
      const { a, base } = await ask(REFUSED, [reply(sentence)], { sources: poisonedSources({ recommendations: async () => ({ ok: true, value: recs }) }) });
      assert.equal(a.answer, base.answer);
    });
  }
  it("a raw name marker cannot manufacture a subject using otherwise admitted words", () => {
    assert.equal(admitModelSentence("Lovely \u0001.", []).ok, false);
  });
});

// B2-LIVE: the assistant and its counterfactual questions must retain the live input of the base answer.
describe("Compass live-input continuity", () => {
  const live = { securityWaitExtraMin: 120, immigrationWaitExtraMin: 0, groundTransportExtraMin: 0, reasonCodes: ["SECURITY_WAIT_HIGH" as const], observedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 10 * MIN).toISOString() };
  it("uses the supplied live record for both certified text and the assistant tools", async () => {
    const s = YES.session();
    const record = certifySessionFeasibility(AP, s, { nowMs: NOW, entry: PERMITTED, liveConditions: live });
    const normal = certifySessionFeasibility(AP, s, { nowMs: NOW, entry: PERMITTED });
    assert.equal(normal.deadline.hardReturnTime.getTime() - record.deadline.hardReturnTime.getTime(), 120 * MIN);
    const { a } = await ask(YES, [reply("The lounge offers a calm spot to recharge.")], { certifiedRecord: record });
    assert.equal(a.hardReturnTime, record.deadline.hardReturnTime.toISOString());
    assert.equal(a.certification.inputHash, certificationHeader(record).inputHash);
    assert.notEqual(a.assistant.fallbackReason, "certification_mismatch");
  });
  it("asks about top-plan changes only under the same live queue penalty", () => {
    const s = session(600, { checkedBags: false });
    const record = certifySessionFeasibility(AP, s, { nowMs: NOW, entry: PERMITTED, liveConditions: live });
    const plans = [{ ref: "rec:live-bound", title: "Lounge", stops: [{ durationMin: record.envelope.usableMinutes, travelMin: 0, insideAirport: true }] }];
    const staticBags = planAwareClarifications(AP, s, NOW, PERMITTED, plans).find((q) => q.field === "checkedBags");
    const liveBags = planAwareClarifications(AP, s, NOW, PERMITTED, plans, live).find((q) => q.field === "checkedBags");
    assert.equal(staticBags?.impact.topPlanChanges, false, "fixture has room under the obsolete static input");
    assert.equal(liveBags?.impact.topPlanChanges, true, "the current live window loses this plan when baggage adds time");
  });
});
