/**
 * §7 `structured_value` (census-input-intelligence G46) — deterministic values
 * parsed from what was typed, offered as `set_structured_value` rows on the
 * event title field, behind `input_structured_values_enabled` (3690, seeded FALSE).
 *
 * Run: node --import tsx/esm --test src/test/inputAssistanceStructuredValues.test.ts
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
  parseStructuredValues,
  structuredValueLabel,
  policyAdmitsStructuredValues,
  INPUT_STRUCTURED_VALUES_FLAG,
} from "../lib/inputAssistance/structuredValues.js";
import { resolvePolicy } from "../lib/inputAssistance/policyRegistry.js";

// Thursday 8 October 2026, 10:00 in Asia/Ho_Chi_Minh (03:00 UTC).
const NOW = new Date("2026-10-08T03:00:00Z");
const TZ = "Asia/Ho_Chi_Minh";
const parse = (t: string) => parseStructuredValues(t, { tz: TZ, now: NOW });

describe("G46 — the deterministic parse", () => {
  it("a weekday and a time window become one event_time value (start inherits the end's meridiem)", () => {
    assert.deepEqual(parse("Rooftop drinks Fri 8-11pm"), [
      { kind: "event_time", date: "2026-10-09", startTime: "20:00", endDate: "2026-10-09", endTime: "23:00" },
    ]);
  });

  it("a month-day, a single time and a duration compose start and end", () => {
    assert.deepEqual(parse("Sunset hike Oct 12 at 5pm for 2 hours"), [
      { kind: "event_time", date: "2026-10-12", startTime: "17:00", endDate: "2026-10-12", endTime: "19:00" },
    ]);
  });

  it("a window that runs past midnight ends the next day", () => {
    assert.deepEqual(parse("Club night saturday 10pm-2am"), [
      { kind: "event_time", date: "2026-10-10", startTime: "22:00", endDate: "2026-10-11", endTime: "02:00" },
    ]);
  });

  it("party size is read only with a people word, and stands alone", () => {
    assert.deepEqual(parse("Dinner for 6 people"), [{ kind: "party_size", count: 6 }]);
    assert.deepEqual(parse("Group of 12 tomorrow"), [
      { kind: "event_time", date: "2026-10-09", startTime: null, endDate: null, endTime: null },
      { kind: "party_size", count: 12 },
    ]);
  });

  it("REFUSES what it cannot know: a bare number, '8:30' without a meridiem, 'in 2 hours', 13pm, 31 Feb", () => {
    // MUTATION: accept a meridiem-less single time → "Bus 7" yields a time → RED.
    assert.deepEqual(parse("Bus 7 to Hoi An"), []);
    assert.deepEqual(parse("Drinks at 8"), []);
    assert.deepEqual(parse("Drinks 8:30"), []);
    assert.deepEqual(parse("Meet in 2 hours"), []);
    assert.deepEqual(parse("Party 13pm"), []);
    assert.deepEqual(parse("Feb 31 party"), []);
    assert.deepEqual(parse("Beach and sun, we sat by the sea"), []);
  });

  it("REFUSES ambiguity: two dates or two time windows give no value of that kind (§19)", () => {
    // MUTATION: take the first date instead of refusing → RED.
    assert.deepEqual(parse("Friday or saturday 8pm"), []);
    assert.deepEqual(parse("Tomorrow 8pm or 9pm"), []);
    assert.deepEqual(parse("Tomorrow 8pm or 9pm for 4 people"), [{ kind: "party_size", count: 4 }]);
  });

  it("V-IN F8: a wrap past midnight longer than 12 h, or a bare 'm', is refused; 12am is midnight", () => {
    // MUTATION: drop the wrap rule → "8pm-7pm" becomes a 23 h window → RED.
    assert.deepEqual(parse("Drinks fri 8pm-7pm"), []);
    assert.deepEqual(parse("Run 5 m"), []);
    // MUTATION: 12am → noon → RED.
    assert.deepEqual(parse("Party tomorrow 12am-2am"), [
      { kind: "event_time", date: "2026-10-09", startTime: "00:00", endDate: "2026-10-09", endTime: "02:00" },
    ]);
    // A long SAME-day window is still fine.
    assert.deepEqual(parse("Festival saturday 10am-11pm"), [
      { kind: "event_time", date: "2026-10-10", startTime: "10:00", endDate: "2026-10-10", endTime: "23:00" },
    ]);
  });

  it("a 24-hour clock and a duration alone", () => {
    assert.deepEqual(parse("Run club 06:30"), [{ kind: "event_time", date: null, startTime: "06:30", endDate: null, endTime: null }]);
    assert.deepEqual(parse("Walking tour 90 min"), [{ kind: "duration", minutes: 90 }]);
  });

  it("labels say what the tap will set", () => {
    assert.deepEqual(structuredValueLabel({ kind: "event_time", date: "2026-10-10", startTime: "20:00", endDate: "2026-10-10", endTime: "23:00" }), {
      label: "Sat 10 Oct · 8:00 PM – 11:00 PM", subtitle: "Set as the date and time",
    });
    assert.equal(structuredValueLabel({ kind: "party_size", count: 1 }).label, "1 person");
  });
});

// ── Through the route ─────────────────────────────────────────────────────────

const ME = "aa000000-0000-4000-a000-000000000001";
function fake(flags: any[]) {
  return {
    auth: { getUser: async () => ({ data: { user: { id: ME } }, error: null }) },
    rpc: async (name: string) => { writes.push(`rpc:${name}`); return { data: null, error: null }; },
    from: (table: string) => {
      const rows = table === "feature_flags" ? flags : [];
      const filters: Array<(r: any) => boolean> = [];
      const b: any = {
        select() { return b; }, eq(c: string, v: any) { filters.push((r) => r[c] === v); return b; },
        neq() { return b; }, in() { return b; }, not() { return b; }, is() { return b; }, ilike() { return b; },
        or() { return b; }, gte() { return b; }, lt() { return b; }, lte() { return b; }, gt() { return b; },
        order() { return b; }, range() { return b; }, limit() { return b; }, ...Object.fromEntries(["insert", "update", "upsert", "delete"].map((verb) => [verb, () => { writes.push(`${verb}:${table}`); return b; }])),
        maybeSingle() { return Promise.resolve({ data: rows.filter((r) => filters.every((f) => f(r)))[0] ?? null, error: null }); },
        single() { return b.maybeSingle(); },
        then(onF: any, onR: any) { return Promise.resolve({ data: rows.filter((r) => filters.every((f) => f(r))), error: null }).then(onF, onR); },
      };
      return b;
    },
  };
}

let base: string;
let server: Server;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = { info() {}, warn() {}, error() {}, debug() {} }; next(); });
  app.use("/api", inputAssistanceRouter);
  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});
after(() => server.close());
beforeEach(() => { _resetRateLimit(); writes.length = 0; });

async function suggest(flags: any[], body: any) {
  _setTestClient(fake(flags) as any, true);
  const r = await fetch(`${base}/input-assistance/suggest`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: "Bearer t" },
    body: JSON.stringify(body),
  });
  return (await r.json()) as any;
}
const sv = (body: any) => (body.suggestions ?? []).filter((s: any) => s.type === "structured_value");

describe("G46 — served on the event title field", () => {
  const ON = [{ flag: INPUT_STRUCTURED_VALUES_FLAG, enabled: true }];

  it("emits set_structured_value rows carrying the parsed value", async () => {
    // MUTATION: drop the buildStructuredValueRows call from gateway.ts → RED.
    const body = await suggest(ON, { context: "event_title", text: "Rooftop drinks Fri 8-11pm for 6 people", tz: TZ });
    const rows = sv(body);
    assert.equal(rows.length, 2);
    const time = rows.find((r: any) => r.structuredValue.kind === "event_time");
    assert.equal(time.action.type, "set_structured_value");
    assert.deepEqual(time.action.value, time.structuredValue);
    assert.equal(time.source, "local");
    const size = rows.find((r: any) => r.structuredValue.kind === "party_size");
    assert.deepEqual(size.structuredValue, { kind: "party_size", count: 6 });
  });

  it("FLAG OFF or absent (the seed) — no structured value is served", async () => {
    // MUTATION: drop the isFlagEnabled check → RED.
    assert.equal(sv(await suggest([{ flag: INPUT_STRUCTURED_VALUES_FLAG, enabled: false }], { context: "event_title", text: "Drinks Fri 8pm", tz: TZ })).length, 0);
    assert.equal(sv(await suggest([], { context: "event_title", text: "Drinks Fri 8pm", tz: TZ })).length, 0);
  });

  it("only where the SERVER policy declares the type and a screen applies it", async () => {
    // MUTATION: remove 'structured_value' from event_title's policy → the first assertion is RED.
    assert.equal(policyAdmitsStructuredValues("event_title", resolvePolicy("event_title")!), true);
    // trip_title has no applier on its screen.
    assert.equal(policyAdmitsStructuredValues("trip_title", { ...resolvePolicy("trip_title")!, allowedSuggestionTypes: ["structured_value"] }), false);
    const body = await suggest([{ flag: INPUT_STRUCTURED_VALUES_FLAG, enabled: true }], { context: "global_search", text: "drinks fri 8pm" });
    assert.equal(sv(body).length, 0);
  });
});

import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { _setTestOpenAI } from "../lib/openai.js";

const writes: string[] = [];
const INVALID_CAPACITIES = [
  "Dinner for -6 people", "Dinner for +6 people", "Dinner for −6 people",
  "Dinner for 1.5 people", "Tour for 1,500 people", "Table of 1.5", "Table of 1,500",
  "Group of -6", "Party of 6.5", "Tour for 1500 people", "Table of 1500",
  ".5 people", "Dinner for .5 people", "Dinner for -.5 people", "Dinner for +.5 people",
  "(.5 people)", "Dinner for ,5 people", "Dinner for −.5 people",
];

describe("G46 — capacity uses the whole numeric token", () => {
  it("preserves ordinary punctuation before a capacity", () => {
    for (const title of ["Dinner,6 people", "Dinner.6 people", "Dinner,for 6 people"]) {
      assert.deepEqual(parse(title), [{ kind: "party_size", count: 6 }], title);
    }
  });

  it("withholds capacities that remain ambiguous across punctuation", () => {
    for (const title of ["Dinner for 6 people,8 people", "6 people.8 guests", "6 people,for 8 people", "6 people ,8 people", "6 people and .5 people"]) {
      assert.equal(parse(title).some((value) => value.kind === "party_size"), false, title);
    }
  });

  for (const title of INVALID_CAPACITIES) {
    it(`refuses the capacity in ${title} while preserving an independent date and time`, () => {
      assert.equal(parse(title).some((value) => value.kind === "party_size"), false);
      assert.deepEqual(parse(`${title} tomorrow at 8pm`), [
        { kind: "event_time", date: "2026-10-09", startTime: "20:00", endDate: null, endTime: null },
      ]);
    });
  }

  it("preserves whole integers, supported people words, punctuation and the existing range", () => {
    for (const count of [1, 6, 500]) {
      for (const title of [`${count} people`, `${count} guests`, `${count} ppl`, `party of ${count}`, `group of ${count}`, `table of ${count}.`, `Table of ${count}, please`, `(${count} friends)`]) {
        assert.deepEqual(parse(title), [{ kind: "party_size", count }], title);
      }
    }
    for (const count of [0, 501]) {
      assert.deepEqual(parse(`${count} people`), []);
      assert.deepEqual(parse(`Table of ${count}`), []);
    }
  });

  it("serves only whole-token capacity actions, without changing the gate or writing", async (context) => {
    const providerCalls: string[] = [];
    const realFetch = globalThis.fetch;
    context.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith(`${base}/`)) return realFetch(input, init);
      providerCalls.push(url);
      throw new Error("outbound provider denied");
    });
    for (const transport of [http, https]) for (const method of ["request", "get"] as const) {
      context.mock.method(transport, method, () => { providerCalls.push(method); throw new Error("outbound provider denied"); });
    }
    syncBuiltinESMExports();
    context.after(() => { context.mock.restoreAll(); syncBuiltinESMExports(); _setTestOpenAI(null); });
    const provider = new Proxy(function () {}, {
      get: () => { providerCalls.push("openai"); return provider; },
      apply: () => { providerCalls.push("openai"); throw new Error("provider denied"); },
    });
    _setTestOpenAI(provider as any);
    const flags = [{ flag: INPUT_STRUCTURED_VALUES_FLAG, enabled: true }];
    for (const title of INVALID_CAPACITIES) {
      _resetRateLimit();
      const rows = sv(await suggest(flags, { context: "event_title", text: `${title} tomorrow at 8pm`, tz: TZ }));
      assert.equal(rows.some((entry: any) => entry.action.value.kind === "party_size"), false, title);
      assert.equal(rows.find((entry: any) => entry.action.value.kind === "event_time")?.action.value.startTime, "20:00");
    }
    for (const count of [1, 6, 500]) {
      const rows = sv(await suggest(flags, { context: "event_title", text: `Table of ${count}`, tz: TZ }));
      assert.deepEqual(rows.map((entry: any) => entry.action.value), [{ kind: "party_size", count }]);
    }
    _resetRateLimit();
    const separated = sv(await suggest(flags, { context: "event_title", text: "Dinner,6 people", tz: TZ }));
    assert.deepEqual(separated.map((entry: any) => entry.action.value), [{ kind: "party_size", count: 6 }]);
    const ambiguous = sv(await suggest(flags, { context: "event_title", text: "Dinner for 6 people,8 people", tz: TZ }));
    assert.equal(ambiguous.some((entry: any) => entry.action.value.kind === "party_size"), false);
    for (const flags of [[], [{ flag: INPUT_STRUCTURED_VALUES_FLAG, enabled: false }]]) {
      assert.deepEqual(sv(await suggest(flags, { context: "event_title", text: "Dinner for 6 people tomorrow at 8pm", tz: TZ })), []);
    }
    assert.deepEqual(writes, []);
    assert.deepEqual(providerCalls, []);
  });
});
