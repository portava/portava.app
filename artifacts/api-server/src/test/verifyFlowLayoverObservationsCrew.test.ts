/**
 * VERIFICATION LANE V3 — FLOW 4: THE LAYOVER LANE'S TWO NEW WRITE SURFACES,
 * SUBMITTED AND READ BACK.
 *
 * The layover lane added two families of route to `routes/airport.ts`:
 *
 *   POST /api/airport/sessions/:id/observations   → GET .../observations
 *   POST /api/airport/sessions/:id/crew           → GET .../crew
 *        + .../crew/:crewId/join, .../crew/leave
 *
 * Both are WRITE-THEN-READ, and both had their services unit-tested before
 * they had routes. This file drives the ROUTES over HTTP against a
 * table-backed in-memory double (`test/helpers/fakeLayoverDb.ts`), so a write
 * made by one request is read by the next through the real handler chain —
 * including `requireOwnedSession`'s ownership gate, the `airport_mode_enabled`
 * flag, and the reconciliation the read performs.
 *
 * ── WHY "IT ROUND-TRIPS" IS NOT THE INTERESTING ASSERTION ───────────────────
 * The interesting assertions are the ones about what the traveller is TOLD:
 *
 *   • ONE report does not move the reading. `reconcile` has a corroboration
 *     floor, so a single stranger's queue report publishes `truth: null` —
 *     and `null` is an ANSWER ("no reading"), not a loading state and not a
 *     zero. A surface that rendered it as `0 minutes` would put a made-up
 *     number into a safety buffer. The write SUCCEEDING while the reading
 *     stays null is the correct and non-obvious outcome, and it is pinned.
 *   • The rate limit is a property of the CORPUS, so it only works if the read
 *     and the write share a store. Three reports then a fourth is the case
 *     that distinguishes a wired limit from an unwired one.
 *   • The idempotency key (migration 2982) is the client's, and a retry must
 *     answer `duplicate: true` rather than an error — a client shown an error
 *     retries a write that already succeeded.
 *   • A crew's `sharedReturnBy` is `min(required_return_by)` over the WHOLE
 *     crew, certified server-side. The client is explicitly forbidden from
 *     deriving it. So the route must publish it, and must publish `null`
 *     rather than a later time when a member cannot be certified.
 *
 * ── WHAT IS NOT EXERCISED ──────────────────────────────────────────────────
 * The double models no CHECK constraints and no unique indexes, so migration
 * 2982's `airport_fact_obs_submission_token_uidx` cannot be DISCOVERED here —
 * the duplicate case stages the 23505 the way `fakeLayoverDb`'s own header
 * says to. It also models no RLS, so migration 2860's "authenticated may SELECT
 * and nothing else" is not observable; the write path being service-role-only
 * is a property of the deployment, not of this test.
 *
 * SHOWN RED BEFORE GREEN — see the mutation log at the foot of this file.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      SESSION_SECRET=verify-lane-v3 \
 *      node --import tsx/esm --test src/test/verifyFlowLayoverObservationsCrew.test.ts
 */
// The observer handle is an HMAC and refuses to derive without a pepper — by
// design, because a guessable pepper forges corroboration. Set before the
// service module is imported.
process.env.SESSION_SECRET ??= "verify-lane-v3-session-secret";

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import airportRouter from "../routes/airport.js";
import { makeLayoverDb, airportRow, sessionRow } from "./helpers/fakeLayoverDb.js";
import {
  OBSERVATION_TABLE,
  TRAVELLER_SUBMITTABLE_FACT_TYPES,
  travellerObserverHandle,
} from "../services/layover/LayoverObservationService.js";
import { CREW_TABLE, CREW_MEMBER_TABLE } from "../services/layover/LayoverCrewStore.js";

const TOKEN = "layover-flow-token";
const USER = "layover-flow-user-1";
const MATE_TOKEN = "layover-flow-mate-token";
const MATE = "layover-flow-user-2";

const SESSION = "session-1";
const MATE_SESSION = "session-2";
const AIRPORT_REF = "TPE";

const OBS = `/api/airport/sessions/${SESSION}/observations`;
const CREW = `/api/airport/sessions/${SESSION}/crew`;

let server: http.Server;
let base = "";
let tables: Record<string, any[]> = {};

function request(
  method: "GET" | "POST",
  path: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; body: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body === undefined ? null : JSON.stringify(body);
    const r = http.request(
      {
        hostname: url.hostname, port: Number(url.port),
        path: url.pathname + url.search, method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { raw += c; });
        res.on("end", () => {
          let parsed: any;
          try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed, raw });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

/**
 * Stage the world. `failures` is `fakeLayoverDb`'s injection map — the only way
 * to express "this table could not be read", which is the shape supabase-js
 * actually produces and the one every honesty assertion below turns on.
 */
function stage(opts: {
  observations?: any[];
  crews?: any[];
  crewMembers?: any[];
  failures?: Record<string, { message: string; code?: string }>;
  mateDepartureMs?: number;
} = {}) {
  const now = Date.now();
  tables = {
    feature_flags: [
      { flag: "airport_mode_enabled", enabled: true },
      { flag: "layover_plans_enabled", enabled: true },
    ],
    airport_profiles: [airportRow()],
    layover_sessions: [
      sessionRow({ id: SESSION, user_id: USER }),
      sessionRow({
        id: MATE_SESSION,
        user_id: MATE,
        // The mate leaves EARLIER, so they bind the shared deadline. A crew
        // whose shared return is the viewer's own time would be a crew that
        // silently ignored the person with the tighter connection.
        departure_time: new Date(now + (opts.mateDepartureMs ?? 5 * 3_600_000)).toISOString(),
      }),
    ],
    layover_recommendations: [],
    layover_plan_stops: [],
    layover_events: [],
    location_preferences: [],
    trip_crew_location_preferences: [],
    blocks: [],
    profiles: [
      { id: USER, handle: "traveller", name: "Traveller", avatar_url: null, show_name_publicly: true },
      { id: MATE, handle: "mate", name: "Mate", avatar_url: null, show_name_publicly: true },
    ],
    [OBSERVATION_TABLE]: opts.observations ?? [],
    [CREW_TABLE]: opts.crews ?? [],
    [CREW_MEMBER_TABLE]: opts.crewMembers ?? [],
  };
  _setTestClient(
    makeLayoverDb(tables, {
      users: { [TOKEN]: USER, [MATE_TOKEN]: MATE },
      failures: opts.failures,
    }) as any,
    true,
  );
  return tables;
}

/** A stored, already-screened observation from somebody who is not the viewer. */
function storedObservation(over: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    id: `obs-${Math.random().toString(16).slice(2)}`,
    airport_ref: AIRPORT_REF,
    fact_type: "queue_report_minutes",
    fact_class: "TRAVELER_OBSERVATION",
    value: 20,
    observer_kind: "community",
    observer_id: `tv1-${"a".repeat(40)}`,
    observer_trust: null,
    source_ref: "portava:layover/traveller-report",
    observed_at: new Date(now - 60_000).toISOString(),
    expires_at: new Date(now + 60 * 60_000).toISOString(),
    submission_token: `seed-${Math.random().toString(16).slice(2)}`,
    ...over,
  };
}

function report(over: Record<string, unknown> = {}) {
  return {
    factType: "queue_report_minutes",
    value: 22,
    submissionToken: `tok-${Math.random().toString(16).slice(2)}0000`,
    ...over,
  };
}

const factOf = (body: any, type: string) =>
  (body?.facts ?? []).find((f: any) => f.factType === type);

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

after(() => { server?.close(); _setTestClient(null as any, false); });

beforeEach(() => { stage(); });

// ── FLOW 4a: an observation, submitted and read back ─────────────────────────

describe("FLOW 4a — a traveller's report is screened, stored, and reconciled back", () => {
  it("POST persists a row, and the row carries everything a reader needs to weigh it", async () => {
    const r = await request("POST", OBS, TOKEN, report({ value: 22 }));
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.airportRef, AIRPORT_REF);
    assert.equal(r.body.duplicate, false);

    const rows = tables[OBSERVATION_TABLE];
    assert.equal(rows.length, 1, "the report did not reach the store");
    const row = rows[0];
    assert.equal(row.airport_ref, AIRPORT_REF, "the report must be filed under the airport the session is at");
    assert.equal(row.fact_type, "queue_report_minutes");
    assert.equal(row.value, 22);
    assert.equal(row.observer_kind, "community");
    // `observer_trust` NULL and not 0: "absent" and "rated zero" are different
    // claims, and the reconciler reads absent as the kind's floor.
    assert.equal(row.observer_trust, null);
    assert.ok(row.expires_at, "a traveller observation must carry its own TTL");
  });

  it("the observer id is a PSEUDONYM, and the traveller's user id appears nowhere in the row", async () => {
    // Migration 2860's whole point: the observation store must not be a second
    // place from which "this person was at this airport" can be reconstructed.
    await request("POST", OBS, TOKEN, report());
    const row = tables[OBSERVATION_TABLE][0];
    assert.equal(row.observer_id, travellerObserverHandle(USER, AIRPORT_REF));
    assert.ok(row.observer_id.startsWith("tv1-"), "the handle must carry its version prefix");
    assert.ok(
      !JSON.stringify(row).includes(USER),
      `the traveller's user id is in the stored row: ${JSON.stringify(row)}`,
    );
  });

  it("the layover event trail records the report WITHOUT the observer handle beside the user id", async () => {
    // `layover_events.user_id` is NOT NULL, so writing the handle here would
    // reconstruct, in a second table, exactly the link 2860 keeps out of the
    // first one.
    await request("POST", OBS, TOKEN, report());
    const ev = tables.layover_events.find((e: any) => e.event_type === "airport_observation_reported");
    assert.ok(ev, "a consequential layover action was not recorded");
    assert.ok(
      !JSON.stringify(ev).includes("tv1-"),
      `the observer handle was written beside the user id: ${JSON.stringify(ev)}`,
    );
  });

  it("ONE report does not move the reading — the corroboration floor holds, and the write still succeeds", async () => {
    // The non-obvious, load-bearing outcome. `truth: null` here means "no
    // reading", NOT "your report failed" and NOT "0 minutes". A client that
    // rendered null as a number would put one stranger's guess into a safety
    // buffer.
    const r = await request("POST", OBS, TOKEN, report({ value: 22 }));
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.fact.truth, null, "a single uncorroborated report was published as a reading");
    assert.equal(tables[OBSERVATION_TABLE].length, 1, "the report was nevertheless stored");

    const read = await request("GET", OBS, TOKEN);
    assert.equal(read.status, 200, read.raw);
    assert.equal(
      factOf(read.body, "queue_report_minutes").truth, null,
      "the READ disagrees with the WRITE's own answer about the same corpus",
    );
  });

  it("with corroboration already in the corpus, the reading IS published and the traveller sees it", async () => {
    // The positive control. Without it every assertion above would pass against
    // a reconciler that returns null for everything.
    stage({ observations: [storedObservation({ value: 20 }), storedObservation({ value: 21, observer_id: `tv1-${"b".repeat(40)}` })] });
    const read = await request("GET", OBS, TOKEN);
    assert.equal(read.status, 200, read.raw);
    const fact = factOf(read.body, "queue_report_minutes");
    assert.ok(fact.truth, "two corroborating reports still published no reading — the floor is unreachable");
    assert.equal(typeof fact.truth.value, "number");
    assert.ok(
      fact.truth.sourceRefs.includes("portava:layover/traveller-report"),
      "the published reading does not say it came from travellers",
    );
  });

  it("the GET publishes EVERY submittable fact type, so an absent one is absence and not omission", async () => {
    const read = await request("GET", OBS, TOKEN);
    assert.deepEqual(
      read.body.facts.map((f: any) => f.factType).sort(),
      [...TRAVELLER_SUBMITTABLE_FACT_TYPES].sort(),
    );
    assert.deepEqual(read.body.submittableFactTypes, TRAVELLER_SUBMITTABLE_FACT_TYPES);
  });

  it("the submittable set is EXACTLY the three the client hard-codes", () => {
    // The cross-tree seam. The server DERIVES this set by filtering
    // `AIRPORT_FACT_TYPES` on the TRAVELER_OBSERVATION class; the client
    // (`travel-buddy-standalone/src/services/layover.ts#TravellerFactType`)
    // spells it out as a union, because `travel-buddy-standalone` is not in
    // `pnpm-workspace.yaml` and cannot import it. A fact type added to the
    // vocabulary under that class becomes submittable on the server with NO
    // edit here — and the client's union would refuse to compile a call for it,
    // so the entry would exist and be unreachable. The literal below is that
    // union, transcribed.
    assert.deepEqual(
      [...TRAVELLER_SUBMITTABLE_FACT_TYPES].sort(),
      ["checkpoint_timing_minutes", "closure_reported", "queue_report_minutes"],
      "the server's submittable set has drifted from the client's TravellerFactType union",
    );
  });

  it("the RATE LIMIT is enforced from the STORED corpus — the fourth report in the window is refused", async () => {
    // `OBSERVATION_RATE_LIMIT` is 3 per 15 minutes per observer per fact type,
    // and it is counted against the bag of accepted rows. It therefore only
    // works if the write and the read share a store, which is the property this
    // whole file exists to check.
    const before = tables[OBSERVATION_TABLE].length;
    for (let i = 0; i < 3; i++) {
      const ok = await request("POST", OBS, TOKEN, report({ value: 20 + i }));
      assert.equal(ok.status, 200, `report ${i + 1} should have been accepted: ${ok.raw}`);
    }
    assert.equal(tables[OBSERVATION_TABLE].length, before + 3);

    const fourth = await request("POST", OBS, TOKEN, report({ value: 23 }));
    assert.equal(fourth.status, 429, `the fourth report was not rate-limited: ${fourth.raw}`);
    assert.equal(
      tables[OBSERVATION_TABLE].length, before + 3,
      "a rate-limited report was written anyway — the table would hold unscreened rows",
    );
    assert.ok(
      String(fourth.body.message).includes("3"),
      "the refusal must say what the allowance is, not merely that there is one",
    );
  });

  it("an IMPLAUSIBLE value is refused with a sentence, and is not stored", async () => {
    const r = await request("POST", OBS, TOKEN, report({ value: 100_000 }));
    assert.equal(r.status, 400, r.raw);
    assert.equal(r.body.error, "invalid_payload");
    assert.deepEqual(tables[OBSERVATION_TABLE], []);
  });

  it("a fact type travellers do not own is refused BY NAME, and names what is allowed", async () => {
    // `security_wait_minutes` is FAST_LIVE and belongs to an instrumented feed.
    // A traveller report filed under it would reach the safety buffer wearing a
    // freshness it has not earned.
    const r = await request("POST", OBS, TOKEN, report({ factType: "security_wait_minutes" }));
    assert.equal(r.status, 400, r.raw);
    assert.ok(
      String(r.body.message).includes("queue_report_minutes"),
      `the refusal must name the types that ARE allowed: ${r.raw}`,
    );
    assert.deepEqual(tables[OBSERVATION_TABLE], []);
  });

  it("an UNREADABLE corpus refuses the write rather than storing an UNSCREENED report", async () => {
    // The limit is a property of the corpus, so a write without the corpus is a
    // write without the limit. An outage must not become the one moment the
    // abuse control is off.
    stage({ failures: { [`${OBSERVATION_TABLE}:select`]: { message: "corpus unavailable" } } });
    const r = await request("POST", OBS, TOKEN, report());
    assert.equal(r.status, 503, r.raw);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.deepEqual(tables[OBSERVATION_TABLE], [], "an unscreened report was stored during an outage");
  });

  it("an UNREADABLE corpus refuses the READ too — an outage is not an airport nobody has reported on", async () => {
    stage({ failures: { [`${OBSERVATION_TABLE}:select`]: { message: "corpus unavailable" } } });
    const r = await request("GET", OBS, TOKEN);
    assert.equal(r.status, 503, r.raw);
    assert.equal(r.body.error, "degraded_unavailable");
  });

  it("a RETRY of the same report answers duplicate:true, not an error", async () => {
    // Migration 2982's idempotency key. A client shown an error here retries a
    // write that has already succeeded. The 23505 is STAGED because the double
    // models no unique index — see this file's header and fakeLayoverDb's.
    stage({
      observations: [storedObservation({ submission_token: "retry-token-0001" })],
      failures: { [`${OBSERVATION_TABLE}:insert`]: { message: "duplicate key", code: "23505" } },
    });
    const r = await request("POST", OBS, TOKEN, report({ submissionToken: "retry-token-0001" }));
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.duplicate, true, "a retry was reported as a failure");
  });

  it("a session that is NOT the caller's is refused, and nothing is written to it", async () => {
    const r = await request("POST", `/api/airport/sessions/${MATE_SESSION}/observations`, TOKEN, report());
    assert.ok(r.status === 403 || r.status === 404, `expected an ownership refusal, got ${r.status}: ${r.raw}`);
    assert.deepEqual(tables[OBSERVATION_TABLE], []);
  });
});

// ── FLOW 4b: a crew, formed and read back ────────────────────────────────────

describe("FLOW 4b — a crew is formed, joined, certified and read back", () => {
  it("POST /crew persists the crew AND the owner's membership, and GET reads both back", async () => {
    const created = await request("POST", CREW, TOKEN, { title: "Ramen run", maxMembers: 4 });
    assert.equal(created.status, 200, created.raw);
    assert.equal(created.body.inCrew, true);
    assert.equal(created.body.crew.title, "Ramen run");
    assert.equal(created.body.crew.youAreOwner, true);
    assert.equal(created.body.crew.memberCount, 1);

    assert.equal(tables[CREW_TABLE].length, 1, "the crew row was not written");
    assert.equal(
      tables[CREW_MEMBER_TABLE].length, 1,
      "a crew was created with no membership row — the owner would not be in their own crew",
    );

    const read = await request("GET", CREW, TOKEN);
    assert.equal(read.status, 200, read.raw);
    assert.equal(read.body.inCrew, true);
    assert.equal(read.body.crew.id, created.body.crew.id);
  });

  it("the crew is CERTIFIED server-side: sharedReturnBy is published, and it is the EARLIEST member's", async () => {
    // §14.1, and the client is explicitly forbidden from deriving this. The
    // mate departs three hours earlier, so they bind the deadline; a crew that
    // published the owner's own return time would strand the person with the
    // tighter connection.
    const created = await request("POST", CREW, TOKEN, { title: "Ramen run" });
    const crewId = created.body.crew.id;

    const joined = await request("POST", `/api/airport/sessions/${MATE_SESSION}/crew/${crewId}/join`, MATE_TOKEN);
    assert.equal(joined.status, 200, joined.raw);
    assert.equal(joined.body.crew.memberCount, 2);

    const read = await request("GET", CREW, TOKEN);
    const sol = read.body.solution;
    assert.ok(sol, "the crew read published no certified solution at all");
    assert.equal(sol.members.length, 2, "the solution does not fold in every member");
    assert.ok(sol.sharedReturnBy, "sharedReturnBy is null with two certified members");

    const mine = sol.members.find((m: any) => m.userId === USER);
    const theirs = sol.members.find((m: any) => m.userId === MATE);
    assert.ok(mine?.requiredReturnBy && theirs?.requiredReturnBy, "a member was left uncertified");
    const earliest = [mine.requiredReturnBy, theirs.requiredReturnBy]
      .sort((a: string, b: string) => Date.parse(a) - Date.parse(b))[0];
    assert.equal(
      sol.sharedReturnBy, earliest,
      "the shared deadline is not the minimum over the crew — a later one strands the binding member",
    );
    assert.ok(
      sol.bindingMemberIds.includes(MATE),
      "the member who actually binds the deadline is not named, so nobody can be told why",
    );
  });

  it("a second crew for the same traveller is REFUSED, and the first survives", async () => {
    await request("POST", CREW, TOKEN, { title: "Ramen run" });
    const second = await request("POST", CREW, TOKEN, { title: "Another run" });
    assert.equal(second.status, 400, second.raw);
    assert.equal(tables[CREW_TABLE].length, 1, "a traveller ended up in two crews at once");
  });

  it("a NON-OWNER leaving removes only themselves; the crew and its other member survive", async () => {
    const created = await request("POST", CREW, TOKEN, { title: "Ramen run" });
    const crewId = created.body.crew.id;
    await request("POST", `/api/airport/sessions/${MATE_SESSION}/crew/${crewId}/join`, MATE_TOKEN);

    const left = await request("POST", `/api/airport/sessions/${MATE_SESSION}/crew/leave`, MATE_TOKEN);
    assert.equal(left.status, 200, left.raw);
    assert.equal(left.body.inCrew, false);
    assert.equal(left.body.disbanded, false, "a member leaving must not take the crew with them");

    const mateRead = await request("GET", `/api/airport/sessions/${MATE_SESSION}/crew`, MATE_TOKEN);
    assert.equal(mateRead.body.inCrew, false, "the member who left is still reported as in the crew");

    const ownerRead = await request("GET", CREW, TOKEN);
    assert.equal(ownerRead.body.inCrew, true, "the owner was removed from their own crew by somebody else leaving");
    assert.equal(
      ownerRead.body.crew.memberCount, 1,
      "the member count still includes somebody who left — they would keep binding the shared deadline",
    );
    assert.equal(
      ownerRead.body.solution.members.length, 1,
      "the certified solution still folds in a member who left",
    );
  });

  it("the OWNER leaving DISBANDS the crew, and every other member reads inCrew:false", async () => {
    // Documented behaviour, pinned rather than assumed: `leaveCrew` refuses to
    // reassign ownership, because whose deadline binds is §14.1's question and
    // not a property of whoever happens to hold the crew. What must NOT happen
    // is the halfway state — the owner out, the crew still advertised as open —
    // so the disband and the departure are asserted together.
    const created = await request("POST", CREW, TOKEN, { title: "Ramen run" });
    const crewId = created.body.crew.id;
    await request("POST", `/api/airport/sessions/${MATE_SESSION}/crew/${crewId}/join`, MATE_TOKEN);

    const left = await request("POST", `${CREW}/leave`, TOKEN);
    assert.equal(left.status, 200, left.raw);
    assert.equal(left.body.inCrew, false);
    assert.equal(left.body.disbanded, true, "the owner left and the crew was left standing without one");

    assert.equal(
      tables[CREW_TABLE][0].status, "disbanded",
      "an ownerless crew is still advertised as open",
    );

    const mateRead = await request("GET", `/api/airport/sessions/${MATE_SESSION}/crew`, MATE_TOKEN);
    assert.equal(
      mateRead.body.inCrew, false,
      "a member of a disbanded crew still reads as in it — they would wait for a crew that no longer exists",
    );
    assert.ok(
      !(mateRead.body.crews ?? []).some((c: any) => c.id === crewId),
      "a disbanded crew is still offered to join",
    );
  });

  it("an UNREADABLE crew membership table refuses — it does not answer 'you are in no crew'", async () => {
    // The sentence the route's own comment gives: "a traveller told that walks
    // away from people who are waiting for them."
    stage({ failures: { [`${CREW_MEMBER_TABLE}:select`]: { message: "crew members unavailable" } } });
    const r = await request("GET", CREW, TOKEN);
    assert.equal(r.status, 503, r.raw);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.notEqual(r.body.inCrew, false, "an outage was reported as 'you are in no crew'");
  });

  it("a crew cannot be formed from somebody else's session", async () => {
    const r = await request("POST", `/api/airport/sessions/${MATE_SESSION}/crew`, TOKEN, { title: "Not mine" });
    assert.ok(r.status === 403 || r.status === 404, `expected an ownership refusal, got ${r.status}: ${r.raw}`);
    assert.deepEqual(tables[CREW_TABLE], []);
  });
});

/**
 * MUTATIONS RUN, WITH THE COUNTS THEY PRODUCED. Baseline 21/21. Every mutant
 * was applied to the tree, the suite re-run, and the file restored from a
 * byte-for-byte copy; `git status` was clean of source changes at the end.
 *
 *   • `LayoverObservationService.ts` — the candidate screened ALONE
 *     (`screenObservations([candidate], …)`) instead of appended to the stored
 *     corpus → 20/1, on the rate-limit case. This is the mutation that turns a
 *     wired rate limit into an unwired one: one row is never more than three,
 *     so the limit silently stops existing while every unit test of
 *     `screenObservations` stays green.
 *   • `LayoverObservationService.ts` — a failed corpus read treated as an EMPTY
 *     corpus instead of `unavailable` → 20/1, on the unreadable-corpus write
 *     case. An outage becomes the one moment the abuse control is off, and the
 *     table starts holding unscreened rows.
 *   • `LayoverObservationService.ts` — `observer_id` written as the real
 *     `input.userId` instead of the HMAC handle → 19/2: the pseudonymity case
 *     and the handle-shape case. Migration 2860's whole purpose, undone in one
 *     token.
 *   • `routes/airport.ts` — `travellerObserverHandle(user.id, airportRef)`
 *     added to the `layover_events` payload (with its import), so the audit
 *     trail carries the handle beside a NOT NULL `user_id` → 20/1. The store
 *     stays pseudonymous and the LINK is reconstructible from the second table,
 *     which is the subtler half of the same defect.
 *   • `routes/airport.ts` — the `isTravellerSubmittableFactType` guard bypassed
 *     → 20/1. A traveller's guess lands under a FAST_LIVE type and reaches the
 *     safety buffer wearing a freshness it has not earned.
 *   • `LayoverCrewService.ts` — `sharedReturnBy` taking the LATEST member
 *     deadline instead of the earliest → 20/1. A crew that strands the member
 *     with the tighter connection, and nothing in the shape of the response
 *     would look wrong.
 *   • `LayoverCrewStore.ts` — the owner-leaves branch returning
 *     `disbanded: false` without disbanding → 20/1. An ownerless crew stays
 *     advertised as open and its members keep waiting for it.
 *
 * NOT MUTATED, and named rather than implied: the ownership gate
 * (`requireOwnedSession`) is covered by two cases here but was not separately
 * mutated — it is the shared entry point for forty routes in this file and is
 * already mutation-covered by `src/test/layoverPresenceRouteGate.test.ts` and
 * `src/test/layoverSessionEdit.test.ts`.
 */
