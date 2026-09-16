/**
 * census-layover L82 — the traveller observation channel gets a submission
 * surface, and the surface does not weaken the rules that make a community
 * report safe to act on.
 *
 * The row's last parseable verdict: "The class exists and is confidence-weighted
 * the way the spec asks (trust × decay), with a corroboration floor above it.
 * There is NO SUBMISSION SURFACE — no route, no screen, nothing a traveller can
 * report from."
 *
 * A submission surface over a confidence-weighted channel is easy to build in a
 * way that quietly destroys the channel, and every case below is one of those
 * ways rather than a happy-path restatement:
 *
 *   1. the round trip — a report PERSISTS and is visible on a fresh read
 *      (this is the "see it after a reload" the build phase asks for);
 *   2. the corroboration floor still binds on a safety-critical fact, and the
 *      lone reporter is COUNTED rather than discarded;
 *   3. one traveller cannot corroborate THEMSELVES — the handle is stable, so
 *      two reports from one person are one voice, not two;
 *   4. the §23 rate limit binds through the route;
 *   5. a traveller cannot file a fact class that is not theirs;
 *   6. an unreadable corpus REFUSES instead of publishing "nobody reported
 *      anything" — the swallow census-layover has found four times here;
 *   7. an unreadable corpus also refuses the WRITE, because the rate limit is a
 *      property of the corpus and a write without it is an unscreened write;
 *   8. a retried report is idempotent rather than a second row;
 *   9. the handle is not a profiles id, which is migration 2860's CHECK.
 *
 * WHAT THIS DOES NOT PROVE. `airport_fact_observations` (migration 2860) and
 * its `submission_token` index (2982) are NOT APPLIED to any database, so every
 * case here runs against `fakeLayoverDb`. That double explicitly does not model
 * unique indexes — case 8 stages the 23505 rather than discovering it — and does
 * not model RLS. This suite is evidence that the SERVICE and ROUTE behave; it is
 * not evidence that the storage exists. See docs/BUILD-BACKLOG.md.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/services/layover/__tests__/layoverObservationSurface.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../../../lib/http.js";
import airportRouter from "../../../routes/airport.js";
import { makeLayoverDb, airportRow, sessionRow } from "../../../test/helpers/fakeLayoverDb.js";
import {
  TRAVELLER_SUBMITTABLE_FACT_TYPES,
  travellerObserverHandle,
} from "../LayoverObservationService.js";
import { MIN_COMMUNITY_CORROBORATION, OBSERVATION_RATE_LIMIT } from "../../airport/LayoverAirportTruth.js";

let server: http.Server;
let base: string;
const TOKEN = "observation-token";
const USER_ID = "user-1";

// The derivation refuses without a pepper, by design. SESSION_SECRET is in
// envValidation's REQUIRED_KEYS, so a booted server always has one; the test
// runner is not a booted server, so it is set here rather than left to chance.
process.env.SESSION_SECRET ??= "observation-suite-pepper";

type Reply = { status: number; body: any };

function call(method: "GET" | "POST", path: string, body?: unknown): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body === undefined ? null : JSON.stringify(body);
    const r = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname,
        method,
        headers: {
          authorization: `Bearer ${TOKEN}`,
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let p: any;
          try { p = JSON.parse(raw); } catch { p = raw; }
          resolve({ status: res.statusCode ?? 0, body: p });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function stage(
  opts: {
    observations?: Record<string, any>[];
    failures?: Record<string, { message: string; code?: string }>;
    users?: Record<string, string>;
  } = {},
) {
  const tables: Record<string, any[]> = {
    feature_flags: [{ flag: "airport_mode_enabled", enabled: true }],
    airport_profiles: [airportRow()],
    layover_sessions: [sessionRow({ user_id: USER_ID })],
    airport_fact_observations: opts.observations ?? [],
    layover_events: [],
    layover_plan_stops: [],
    trip_plan_items: [],
    blocks: [],
    profiles: [],
    location_preferences: [],
    trips: [],
  };
  _setTestClient(
    makeLayoverDb(tables, {
      users: opts.users ?? { [TOKEN]: USER_ID },
      failures: opts.failures ?? {},
    }),
    true,
  );
  return tables;
}

/** A stored row as the service writes one. */
function obsRow(over: Record<string, any> = {}): Record<string, any> {
  const now = Date.now();
  return {
    id: `obs-${Math.random().toString(16).slice(2)}`,
    airport_ref: "TPE",
    fact_type: "queue_report_minutes",
    fact_class: "TRAVELER_OBSERVATION",
    value: 30,
    observer_kind: "community",
    observer_id: "tv1-other-traveller-handle",
    observer_trust: null,
    source_ref: "portava:layover/traveller-report",
    observed_at: new Date(now - 60_000).toISOString(),
    expires_at: new Date(now + 40 * 60_000).toISOString(),
    submission_token: null,
    ...over,
  };
}

const OBS = "/api/airport/sessions/session-1/observations";

before(() => {
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => {
    r.log = { error() {}, info() {}, warn() {}, debug() {} };
    next();
  });
  app.use("/api", airportRouter);
  return new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${(server.address() as any).port}`;
      resolve();
    });
  });
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("L82 — the submission surface exists and persists", () => {
  it("a report is stored and is there on a fresh read", async () => {
    // `closure_reported` is the one traveller fact that is NOT in
    // SAFETY_CRITICAL_FACTS, so a single reporter is enough for the server to
    // publish a value. That makes it the honest end-to-end case: one person,
    // one press, a figure that survives a reload.
    const tables = stage();
    const post = await call("POST", OBS, {
      factType: "closure_reported",
      value: 1,
      submissionToken: "tok-closure-0001",
    });
    assert.equal(post.status, 200, JSON.stringify(post.body));
    assert.equal(post.body.ok, true);
    assert.equal(post.body.duplicate, false);

    // PERSISTED, not merely echoed.
    assert.equal(tables.airport_fact_observations.length, 1, "the report must reach the store");
    const row = tables.airport_fact_observations[0];
    assert.equal(row.fact_type, "closure_reported");
    assert.equal(row.observer_kind, "community", "a traveller is a community observer, never an official one");
    assert.equal(row.submission_token, "tok-closure-0001");
    assert.ok(row.expires_at > row.observed_at, "2860's ttl_forward CHECK");

    // AND VISIBLE ON A SEPARATE READ — this is the "reload" half.
    const get = await call("GET", OBS);
    assert.equal(get.status, 200, JSON.stringify(get.body));
    const closure = get.body.facts.find((f: any) => f.factType === "closure_reported");
    assert.ok(closure.truth, "a single closure report is publishable — no corroboration floor on it");
    assert.equal(closure.truth.value, 1);
    assert.equal(closure.corroboration.community, 1);
  });

  it("the GET publishes exactly the three TRAVELER_OBSERVATION facts", async () => {
    stage();
    const get = await call("GET", OBS);
    assert.equal(get.status, 200);
    assert.deepEqual(
      get.body.facts.map((f: any) => f.factType).sort(),
      [...TRAVELLER_SUBMITTABLE_FACT_TYPES].sort(),
    );
    for (const f of get.body.facts) {
      assert.equal(f.factClass, "TRAVELER_OBSERVATION", `${f.factType} is filed under the wrong class`);
    }
    assert.equal(get.body.airportRef, "TPE", "the ref is the IATA code, not the fallback UNK");
  });
});

describe("L82 — the surface does not weaken the channel", () => {
  it("the corroboration floor still binds, and the lone reporter is COUNTED not discarded", async () => {
    stage();
    const post = await call("POST", OBS, {
      factType: "queue_report_minutes",
      value: 30,
      submissionToken: "tok-queue-0001",
    });
    assert.equal(post.status, 200, JSON.stringify(post.body));

    // The report was accepted and stored, but `queue_report_minutes` IS
    // safety-critical, so one community voice may not move it.
    assert.equal(post.body.fact.truth, null,
      "one stranger must not move a safety-critical reading");
    // …and it must not be silently dropped either. The count is what lets the
    // client say "reported, waiting for one more" instead of "nothing here".
    assert.equal(post.body.fact.corroboration.community, 1);
    assert.ok(
      post.body.fact.rulesApplied.some((r: string) => r.includes("corroboration floor")),
      `expected the floor to be named in rulesApplied, got ${JSON.stringify(post.body.fact.rulesApplied)}`,
    );
  });

  it("a SECOND distinct traveller lifts it over the floor", async () => {
    // Positive control for the case above: prove the floor is a floor and not a
    // permanent refusal. Without this, a bug that never published anything
    // would pass the previous test.
    stage({ observations: [obsRow({ value: 25, observer_id: "tv1-someone-else" })] });
    const post = await call("POST", OBS, {
      factType: "queue_report_minutes",
      value: 30,
      submissionToken: "tok-queue-0002",
    });
    assert.equal(post.status, 200, JSON.stringify(post.body));
    assert.ok(post.body.fact.truth, "two distinct community observers clear the floor");
    assert.equal(post.body.fact.corroboration.community, MIN_COMMUNITY_CORROBORATION);
    // Rule 3: conservative. 30 and 25 disagree by 5, which is inside the
    // 10-minute tolerance for this fact, so this is agreement and the larger
    // (safer) value is taken silently.
    assert.equal(post.body.fact.truth.value, 30);
    assert.equal(post.body.fact.conflict ?? post.body.fact.truth.conflict, false);
  });

  it("one traveller cannot corroborate THEMSELVES", async () => {
    // THE CASE THE WHOLE HANDLE DESIGN EXISTS FOR. A random or per-submission
    // observer id would make these two reports two strangers agreeing, and the
    // floor would be satisfied by one person.
    const mine = travellerObserverHandle(USER_ID, "TPE");
    stage({ observations: [obsRow({ value: 25, observer_id: mine })] });
    const post = await call("POST", OBS, {
      factType: "queue_report_minutes",
      value: 30,
      submissionToken: "tok-queue-0003",
    });
    assert.equal(post.status, 200, JSON.stringify(post.body));
    assert.equal(post.body.fact.corroboration.community, 1,
      "two reports from one handle are ONE voice");
    assert.equal(post.body.fact.truth, null,
      "so the floor is still unmet and nothing is published");
  });

  it("the §23 rate limit binds through the route", async () => {
    const mine = travellerObserverHandle(USER_ID, "TPE");
    // Exactly the budget, already spent, inside the window.
    const spent = Array.from({ length: OBSERVATION_RATE_LIMIT.maxPerWindow }, (_, i) =>
      obsRow({
        value: 20,
        observer_id: mine,
        observed_at: new Date(Date.now() - (i + 1) * 60_000).toISOString(),
      }),
    );
    stage({ observations: spent });
    const post = await call("POST", OBS, {
      factType: "queue_report_minutes",
      value: 30,
      submissionToken: "tok-queue-0004",
    });
    assert.equal(post.status, 429, JSON.stringify(post.body));
    assert.equal(post.body.rejection, "rate_limited");
  });

  it("a traveller may not file a fact class that is not theirs", async () => {
    // `security_wait_minutes` is FAST_LIVE. Its 20-minute TTL and its place in
    // liveConditionsFrom were designed for an instrumented feed; a community
    // reading filed there reaches the safety buffer with a freshness it has not
    // earned.
    const tables = stage();
    for (const forbidden of ["security_wait_minutes", "lounge_hours", "terminal_topology", "not_a_fact"]) {
      const post = await call("POST", OBS, {
        factType: forbidden,
        value: 30,
        submissionToken: `tok-forbidden-${forbidden}`,
      });
      assert.equal(post.status, 400, `${forbidden} was accepted: ${JSON.stringify(post.body)}`);
    }
    assert.equal(tables.airport_fact_observations.length, 0, "nothing forbidden may reach the store");
  });

  it("an implausible value is refused rather than weighted down", async () => {
    const tables = stage();
    const post = await call("POST", OBS, {
      // PLAUSIBLE_RANGE for queue_report_minutes is 0..240.
      factType: "queue_report_minutes",
      value: 5000,
      submissionToken: "tok-implausible-01",
    });
    assert.equal(post.status, 400, JSON.stringify(post.body));
    assert.equal(tables.airport_fact_observations.length, 0);
  });
});

describe("L82 — an outage is not an empty airport", () => {
  it("an unreadable corpus REFUSES the read instead of publishing 'nobody reported anything'", async () => {
    stage({ failures: { "airport_fact_observations:select": { message: "relation unavailable" } } });
    const get = await call("GET", OBS);
    assert.notEqual(get.status, 200,
      "a failed read must not be served as a successful one");
    assert.equal(get.body.error, "degraded_unavailable", JSON.stringify(get.body));
  });

  it("…and refuses the WRITE too, because the rate limit lives in the corpus", async () => {
    const tables = stage({
      failures: { "airport_fact_observations:select": { message: "relation unavailable" } },
    });
    const post = await call("POST", OBS, {
      factType: "queue_report_minutes",
      value: 30,
      submissionToken: "tok-queue-0005",
    });
    assert.notEqual(post.status, 200);
    assert.equal(post.body.error, "degraded_unavailable", JSON.stringify(post.body));
    assert.equal(tables.airport_fact_observations.length, 0,
      "an unscreened write during an outage is the one moment abuse control must not be off");
  });

  it("a retried report is idempotent, and is reported as success", async () => {
    // fakeLayoverDb models no unique index (its own NOT MODELLED list says so),
    // so the 23505 is STAGED. What is under test is the route's handling: a
    // client shown an error here would retry a write that already succeeded.
    stage({
      observations: [obsRow({ submission_token: "tok-retry-0001" })],
      failures: { "airport_fact_observations:insert": { code: "23505", message: "duplicate key value violates unique constraint" } },
    });
    const post = await call("POST", OBS, {
      factType: "queue_report_minutes",
      value: 30,
      submissionToken: "tok-retry-0001",
    });
    assert.equal(post.status, 200, JSON.stringify(post.body));
    assert.equal(post.body.duplicate, true, "the retry is recognised, not re-recorded");
  });
});

describe("L82 — the identity boundary migration 2860 enforces", () => {
  it("the handle is not a profiles id, and cannot match 2860's UUID CHECK", async () => {
    const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    const h = travellerObserverHandle("11111111-2222-4333-8444-555555555555", "TPE");
    assert.ok(!UUID.test(h), `handle ${h} matches the shape 2860's CHECK forbids`);
    assert.ok(!h.includes("11111111"), "the user id must not be recoverable by reading the handle");
    assert.ok(h.startsWith("tv1-"), "the version prefix is what guarantees the non-UUID shape");
  });

  it("stable for one traveller, distinct between travellers and between airports", async () => {
    // Stability is what makes the rate limit and the anti-self-corroboration
    // rule work; distinctness is what makes corroboration mean two people.
    assert.equal(travellerObserverHandle("u1", "TPE"), travellerObserverHandle("u1", "TPE"));
    assert.notEqual(travellerObserverHandle("u1", "TPE"), travellerObserverHandle("u2", "TPE"));
    assert.notEqual(travellerObserverHandle("u1", "TPE"), travellerObserverHandle("u1", "HND"),
      "a handle must not follow a traveller between airports");
    // Canonicalisation: two spellings of one airport must not split one
    // traveller into two observers.
    assert.equal(travellerObserverHandle("u1", "TPE"), travellerObserverHandle("u1", " tpe "));
  });

  it("the stored row carries the handle and never the user id", async () => {
    const tables = stage();
    await call("POST", OBS, {
      factType: "closure_reported",
      value: 1,
      submissionToken: "tok-identity-0001",
    });
    const row = tables.airport_fact_observations[0];
    assert.ok(row, "expected a stored row");
    assert.notEqual(row.observer_id, USER_ID);
    assert.equal(row.observer_id, travellerObserverHandle(USER_ID, "TPE"));
    assert.equal(
      JSON.stringify(row).includes(USER_ID),
      false,
      "no field of the observation row may carry the reporter's user id",
    );
  });
});
