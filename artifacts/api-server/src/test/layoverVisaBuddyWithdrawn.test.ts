/**
 * census-layover L274 — "Visa Buddy — human assistance path for complex
 * visa/entry questions". Lead ruling D-41 (docs/ops/lead-rulings-20261007-media.md,
 * "### D-41"): **NO.** "No Layover path through Rent-a-Buddy offers visa help."
 * Rationale: visa help is already classed as a scam signal
 * (`travelScamSignals.ts` family `VISA_HELP`).
 *
 * THIS IS THE RULING'S ACCEPTANCE TEST, in the way census-passport made
 * `passportProjection.test.ts` P59's: it goes red if any Layover → Rent-a-Buddy
 * path offers visa or entry help. "Path" means everything a traveller on the
 * layover surface can reach Rent-a-Buddy through, and there is exactly one:
 *
 *   GET /api/airport/sessions/:id/buddies (routes/airport.ts)
 *     → the layover People card (LayoverPeopleSection.tsx), which shows the list
 *     → a tap opens that buddy's ordinary Rent-a-Buddy profile
 *       (app/layover/[id].tsx `router.push('/(rent-a-buddy)/buddy/<id>')`).
 *
 * WHAT IS PINNED
 *   A. THE VOCABULARY. The categories the layover path admits name no visa or
 *      entry service, and neither does Rent-a-Buddy's own category type or the
 *      copy that describes its one airport category ("Arrival Support").
 *   B. THE SERVED LIST. A profile that offers visa or entry help — by a declared
 *      category, or in its own words (display name, tagline or bio; the bio is
 *      what the tap opens) — is not on the layover list. `PATCH
 *      /rent-a-buddy/dashboard/offer` writes categories, tagline and bio
 *      UNVALIDATED, so a buddy can declare `visa_assistance` beside `city`;
 *      before this test such a profile passed `filterLayoverCompatible` (it
 *      matches on ANY compatible category) and was served. Positive controls
 *      keep the list from passing by being empty.
 *   C. NOTHING PORTAVA WRITES ON THE PATH OFFERS IT. The route's buddies
 *      handler, the layover buddy gate and the People card carry no
 *      visa/entry-help copy, and no "Visa Buddy" capability exists anywhere.
 *   D. THE RULING'S PREMISE STANDS. Every `VISA_HELP` scam sample is also
 *      withheld by the layover screen — the two readings cannot drift apart.
 *
 * Run: node --import tsx/esm --test src/test/layoverVisaBuddyWithdrawn.test.ts
 */
import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import airportRouter from "../routes/airport.js";
import * as AirportRoutes from "../routes/airport.js";
import { makeLayoverDb, airportRow, sessionRow } from "./helpers/fakeLayoverDb.js";
import { LAYOVER_COMPATIBLE_BUDDY_CATEGORIES } from "../services/airport/LayoverBuddyGate.js";
import { detectTravelScamSignals } from "../domain/telegraph/policies/travelScamSignals.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_SRC = path.resolve(HERE, "..");
const REPO = path.resolve(API_SRC, "../../..");
const CLIENT = path.join(REPO, "travel-buddy-standalone");
const read = (p: string) => readFileSync(p, "utf8");

/** Visa or entry help, in any wording this suite treats as an OFFER of it. */
const VISA_OR_ENTRY = /\b(e-?visas?|visas?|immigration|embass(y|ies)|consulates?|entry\s+(permits?|requirements?|paperwork|help|assistance)|border\s+(help|assistance))\b/i;

const TOKEN = "visa-buddy-token";
const USER = "user-1";
const DAY = Date.parse("2026-09-13T02:00:00.000Z");
let server: http.Server;
let base = "";

function get(p: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(p, base);
    const r = http.request(
      { hostname: url.hostname, port: Number(url.port), path: url.pathname, method: "GET", headers: { authorization: `Bearer ${TOKEN}` } },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => { let b: any; try { b = JSON.parse(raw); } catch { b = raw; } resolve({ status: res.statusCode ?? 0, body: b }); });
      },
    );
    r.on("error", reject);
    r.end();
  });
}

const profile = (id: string, over: Record<string, unknown>) => ({
  // A neutral name, so each case below trips the screen through the ONE field it is about.
  id, user_id: `buddy-${id}`, display_name: "Local buddy", city: "Taoyuan", status: "active", review_count: 1,
  verified: true, buddy_level: "trusted", categories: ["city"], tagline: null, bio: null, ...over,
});

/** The profiles a buddy can write today through PATCH /rent-a-buddy/dashboard/offer. */
const OFFERS_VISA_HELP = [
  profile("declared-category", { categories: ["city", "visa_assistance"], tagline: "Food walks near the airport" }),
  profile("declared-entry", { categories: ["arrival", "entry_help"] }),
  profile("tagline-scam", { categories: ["arrival"], tagline: "Guaranteed visa approval, I fast-track it for a fee" }),
  profile("tagline-plain", { categories: ["arrival"], tagline: "I help with immigration forms at arrivals" }),
  profile("bio-embassy", { categories: ["language"], tagline: "Translator", bio: "Embassy contact — I can sort your entry paperwork in an hour." }),
  profile("name", { categories: ["city"], display_name: "Visa Fixer Tom" }),
];
const CLEAN = [
  profile("clean-city", { categories: ["city"], tagline: "Night market walks", bio: "Born in Taoyuan." }),
  profile("clean-arrival", { categories: ["arrival"], tagline: "Airport pickup and a SIM card" }),
];

function stage(rows: unknown[]) {
  const tables: Record<string, any[]> = {
    feature_flags: [
      { flag: "airport_mode_enabled", enabled: true },
      { flag: "rent_buddy_enabled", enabled: true },
    ],
    airport_profiles: [airportRow()],
    layover_sessions: [sessionRow({ user_id: USER }, { nowMs: DAY })],
    rent_buddy_profiles: rows as any[],
    rent_buddy_availability: [],
    blocks: [],
  };
  _setTestClient(projecting(makeLayoverDb(tables, { users: { [TOKEN]: USER } }), "rent_buddy_profiles"), true);
}

/**
 * PostgREST returns only the columns a SELECT names; `fakeLayoverDb` returns
 * every column it holds. For the one table whose column list matters here — the
 * bio is screened only if the route ASKS for it — answer the way the wire does.
 */
function projecting(db: any, table: string): any {
  return {
    ...db,
    from(t: string) {
      const b = db.from(t);
      if (t !== table) return b;
      let cols: string[] | null = null;
      const proxy: any = new Proxy(b, {
        get(target, prop) {
          if (prop === "select") return (c: string, o?: unknown) => { cols = String(c).split(",").map((x) => x.trim()).filter(Boolean); target.select(c, o); return proxy; };
          if (prop === "then") {
            return (onF: any, onR: any) => target.then((r: any) => onF(cols && Array.isArray(r?.data)
              ? { ...r, data: r.data.map((row: any) => Object.fromEntries(cols!.map((k) => [k, row[k]]))) }
              : r), onR);
          }
          const v = target[prop];
          return typeof v === "function" ? (...a: unknown[]) => { const out = v.apply(target, a); return out === target ? proxy : out; } : v;
        },
      });
      return proxy;
    },
  };
}

before(() => {
  mock.timers.enable({ apis: ["Date"], now: DAY });
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => { r.log = { error() {}, info() {}, warn() {}, debug() {} }; next(); });
  app.use("/api", airportRouter);
  return new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => { base = `http://127.0.0.1:${(server.address() as any).port}`; resolve(); });
  });
});
after(() => { mock.timers.reset(); return new Promise<void>((resolve) => server.close(() => resolve())); });

describe("A. the vocabulary of the layover → Rent-a-Buddy path names no visa or entry service", () => {
  it("A1. the layover-compatible categories are city/language/arrival/shopping and none is a visa or entry service", () => {
    assert.deepEqual([...LAYOVER_COMPATIBLE_BUDDY_CATEGORIES], ["city", "language", "arrival", "shopping"]);
    for (const c of LAYOVER_COMPATIBLE_BUDDY_CATEGORIES) assert.doesNotMatch(c.replace(/_/g, " "), VISA_OR_ENTRY, c);
  });

  it("A2. Rent-a-Buddy's own category type has no visa or entry member", () => {
    const src = read(path.join(CLIENT, "src/services/rentABuddy.ts"));
    const m = src.match(/export type BuddyCategory\s*=([^;]+);/);
    assert.ok(m, "BuddyCategory type not found — the vocabulary moved; re-point this test");
    const members = [...m![1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
    assert.ok(members.includes("arrival") && members.includes("city"), `positive control: ${members.join(",")}`);
    for (const c of members) assert.doesNotMatch(c, VISA_OR_ENTRY, c);
  });

  it("A3. 'Arrival Support' — the one airport category — is described as pickup, SIM and orientation, not entry help", () => {
    for (const rel of ["app/(rent-a-buddy)/become/index.tsx", "app/(rent-a-buddy)/buddy-dashboard/offer.tsx"]) {
      const src = read(path.join(CLIENT, rel));
      const lines = src.split("\n").filter((l) => /Arrival Support/.test(l));
      assert.ok(lines.length > 0, `${rel}: positive control — the category's copy is here`);
      for (const l of lines) assert.doesNotMatch(l, VISA_OR_ENTRY, `${rel}: ${l.trim()}`);
    }
  });
});

describe("B. the served layover list never offers a buddy who offers visa or entry help", () => {
  it("B1. positive control: clean layover-compatible profiles are served", async () => {
    stage(CLEAN);
    const r = await get("/api/airport/sessions/session-1/buddies");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.buddies.map((b: any) => b.id).sort(), ["clean-arrival", "clean-city"]);
  });

  for (const offer of OFFERS_VISA_HELP) {
    it(`B2. "${offer.id}" is withheld, and the clean profiles beside it are still served`, async () => {
      stage([...CLEAN, offer]);
      const r = await get("/api/airport/sessions/session-1/buddies");
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const ids = r.body.buddies.map((b: any) => b.id);
      assert.ok(!ids.includes(offer.id), `a buddy offering visa/entry help was offered on the layover path: ${JSON.stringify(r.body.buddies.find((b: any) => b.id === offer.id))}`);
      assert.deepEqual(ids.sort(), ["clean-arrival", "clean-city"]);
    });
  }

  it("B3. nothing on the served wire names visa or entry help, and the bio screened for it is never served", async () => {
    stage([...CLEAN, ...OFFERS_VISA_HELP]);
    const r = await get("/api/airport/sessions/session-1/buddies");
    assert.equal(r.status, 200);
    assert.equal(r.body.buddies.length, CLEAN.length, "positive control: the clean profiles survive");
    assert.doesNotMatch(JSON.stringify(r.body), VISA_OR_ENTRY);
    for (const b of r.body.buddies) assert.equal(b.bio, undefined, "the bio is read to screen it, never to serve it");
  });
});

describe("C. nothing Portava writes on the path offers it, and no Visa Buddy capability exists", () => {
  it("C1. the buddies handler, the layover buddy gate and the People card carry no visa/entry-help copy", () => {
    const airport = read(path.join(API_SRC, "routes/airport.ts"));
    const start = airport.indexOf('router.get("/airport/sessions/:id/buddies"');
    const end = airport.indexOf("router.get(\"/airport/pulse\"", start);
    assert.ok(start > 0 && end > start, "the buddies handler moved; re-point this test");
    const handler = airport.slice(start, end);
    assert.match(handler, /filterLayoverCompatible/, "positive control: this is the handler");
    // Code may NAME the screen and comments may cite the ruling; neither is
    // served. What is left — string literals and code — may not offer the help.
    const prose = handler.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "").replace(/buddyOffersVisaOrEntryHelp/g, "");
    assert.doesNotMatch(prose, VISA_OR_ENTRY);
    assert.doesNotMatch(read(path.join(API_SRC, "services/airport/LayoverBuddyGate.ts")), VISA_OR_ENTRY);
    assert.doesNotMatch(read(path.join(CLIENT, "src/components/layover/LayoverPeopleSection.tsx")), VISA_OR_ENTRY);
  });

  it("C2. no 'Visa Buddy' capability exists in the server or client trees (the ruling withdrew it)", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name.startsWith(".") || name === "__tests__" || name === "test") continue;
        const p = path.join(dir, name);
        const s = statSync(p);
        if (s.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && /canProvideVisaBuddyService|VisaBuddy|visa_buddy/.test(read(p))) hits.push(path.relative(REPO, p));
      }
    };
    walk(API_SRC);
    walk(path.join(CLIENT, "src"));
    walk(path.join(CLIENT, "app"));
    assert.deepEqual(hits, []);
  });
});

describe("D. the ruling's premise: visa help is a scam signal, and the layover screen reads it the same way", () => {
  const SCAM_SAMPLES = [
    "Guaranteed visa, 100% approval",
    "I can fast-track your visa today",
    "My visa agent connection, small fee in cash",
    "Embassy insider, no queue",
    "Visa on arrival? Pay me and skip it",
  ];

  it("D1. every sample is a live VISA_HELP signal", () => {
    for (const s of SCAM_SAMPLES) {
      assert.ok(detectTravelScamSignals(s).some((x) => x.family === "VISA_HELP"), `not a VISA_HELP signal any more: "${s}"`);
    }
  });

  it("D2. every VISA_HELP sample, as a buddy's tagline, is withheld by the layover screen", () => {
    const screen = (AirportRoutes as Record<string, unknown>).buddyOffersVisaOrEntryHelp as ((row: Record<string, unknown>) => boolean) | undefined;
    assert.equal(typeof screen, "function", "routes/airport.ts exports no buddyOffersVisaOrEntryHelp");
    for (const s of SCAM_SAMPLES) assert.equal(screen!({ categories: ["city"], tagline: s }), true, s);
    assert.equal(screen!({ categories: ["city"], tagline: "Night market walks" }), false, "positive control: a clean tagline passes");
  });
});
