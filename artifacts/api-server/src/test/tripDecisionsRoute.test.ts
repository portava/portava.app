/**
 * GET /trips/:tripId/decisions — §8's chain, end to end.
 *
 * WHAT WAS THERE BEFORE
 * =====================
 * trip_goals, trip_decision_tasks and trip_risks were created by migration
 * 2762 and written by nine kernel commands from 2766. Measured 2026-09-09: no
 * file in this server or in the app read ANY of them, and nothing anywhere
 * joined a proposal to a decision task, a risk to the plan element it
 * endangers, or a §7 verdict to the option it should disqualify. Six tables
 * and no chain is not §8.
 *
 * THE TWO PROPERTIES THIS FILE PROTECTS
 * =====================================
 * 1. A MISSING INPUT NEVER BECOMES A FAVOURABLE ONE. A proposal with no
 *    recorded feasibility verdict is not recommended on the grounds that
 *    nothing ruled it out, and a risk register that could not be READ refuses
 *    the whole response rather than producing a recommendation computed
 *    without it — an option blocked by a HIGH risk becomes the winner the
 *    instant the risks go missing.
 *
 * 2. THE SHAPE OF THE PAYLOAD IS NOT TRUSTED. `payload_json` is unconstrained
 *    jsonb. A malformed `affected_objects` must reach nothing, not something
 *    arbitrary.
 */
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";

import app from "../app.js";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";

const OWNER_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ID = "33333333-3333-3333-3333-333333333333";
const TRIP_ID  = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

type Row = Record<string, any>;

function makeClient(tables: Record<string, Row[]>, errorOn: string[] = []) {
  return {
    auth: {
      getUser: async (token: string) => {
        if (token === "owner-token") return { data: { user: { id: OWNER_ID } }, error: null };
        if (token === "other-token") return { data: { user: { id: OTHER_ID } }, error: null };
        return { data: { user: null }, error: { message: "invalid" } };
      },
    },
    /** trip_proposal_tally. `rpcFails` makes it resolve with an error, which is
     *  what a real failing RPC does — supabase-js RESOLVES rather than throws. */
    async rpc(fn: string, args: Record<string, any>) {
      if (errorOn.includes(`rpc:${fn}`)) {
        return { data: null, error: { message: `${fn} unavailable` } };
      }
      const p = (tables.trip_proposals ?? []).find((r) => r.id === args.p_proposal_id);
      if (!p) return { data: { found: false }, error: null };
      return {
        data: {
          found: true, decision_rule: p.decision_rule, electorate: 3,
          yes: 2, no: 0, abstain: 0, cast: 2,
          majority_met: true, unanimous_met: false,
        },
        error: null,
      };
    },
    from(table: string) {
      if (errorOn.includes(table)) {
        const f: any = {
          select: () => f, eq: () => f, in: () => f, order: () => f, limit: () => f,
          maybeSingle: async () => ({ data: null, error: { message: `${table} unavailable` } }),
          then: (onF: any, onR: any) =>
            Promise.resolve({ data: null, error: { message: `${table} unavailable` } }).then(onF, onR),
        };
        return f;
      }
      const filters: Array<(r: Row) => boolean> = [];
      let single = false;
      const settle = () => {
        const rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
        return { data: single ? rows[0] ?? null : rows, error: null };
      };
      const chain: any = {
        select: () => chain,
        eq: (c: string, v: any) => { filters.push((r) => r[c] === v); return chain; },
        in: (c: string, v: any[]) => { filters.push((r) => v.includes(r[c])); return chain; },
        order: () => chain, limit: () => chain,
        maybeSingle: async () => { single = true; return settle(); },
        single: async () => { single = true; return settle(); },
        then: (onF: any, onR: any) => Promise.resolve(settle()).then(onF, onR),
      };
      return chain;
    },
  };
}

const crew = [{ trip_id: TRIP_ID, user_id: OWNER_ID, status: "accepted", role: "owner" }];
const base = { trips: [{ id: TRIP_ID, owner_id: OWNER_ID }], trip_members: crew };

const goal = (o: Row = {}) => ({
  id: "g1", trip_id: TRIP_ID, type: "experience", priority: "normal",
  status: "open", evidence_json: {}, ...o,
});
const dtask = (o: Row = {}) => ({
  id: "t1", trip_id: TRIP_ID, type: "booking", deadline_at: null,
  consequence: null, assigned_user_id: null, status: "pending", ...o,
});
const risk = (o: Row = {}) => ({
  id: "r1", trip_id: TRIP_ID, likelihood: "medium", impact: "medium",
  status: "open", trigger_json: {}, mitigation_json: {}, ...o,
});
const prop = (o: Row = {}) => ({
  id: "p1", trip_id: TRIP_ID, proposal_type: "add_plan", status: "pending",
  expires_at: null, decision_rule: "host", proposed_by: OWNER_ID,
  payload_json: { decision_task_id: "t1" }, ...o,
});

let server: Server;
let port: number;
async function start(): Promise<void> {
  await new Promise<void>((r) => {
    server = createServer(app);
    server.listen(0, "127.0.0.1", () => { server.unref(); port = (server.address() as any).port; r(); });
  });
}
after(() => { server?.close(); });

// `res.json()` is typed `Promise<unknown>`, so without this annotation every
// `r.body.<field>` below is a TS18046 error. The response body of an HTTP
// route genuinely has no static type at the fetch boundary — the assertions
// in this file ARE the shape check. Same annotation as
// src/test/tripPresenceRoute.test.ts:110.
async function get(
  token = "owner-token",
): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/trips/${TRIP_ID}/decisions`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
function install(tables: Record<string, Row[]>, errorOn: string[] = []) {
  const c = makeClient({ ...base, ...tables }, errorOn);
  _setTestClient(c as any, true);
  _setTestServiceClient(c as any);
}

beforeEach(async () => { if (!server) await start(); });

describe("§8 — the chain is joined, and the recommendation comes out", () => {
  it("a proposal with a recorded FEASIBLE_UNVERIFIED verdict serving an open goal is recommended", async () => {
    install({
      trip_goals: [goal({ id: "g1" })],
      trip_decision_tasks: [dtask({ id: "t1" })],
      trip_risks: [],
      trip_proposals: [prop({
        id: "p1",
        payload_json: {
          decision_task_id: "t1",
          serves_goal_ids: ["g1"],
          feasibility_verdict: "FEASIBLE_UNVERIFIED",
        },
      })],
    });
    const r = await get();
    assert.equal(r.status, 200);
    assert.equal(r.body.recommendations.length, 1);
    assert.equal(r.body.recommendations[0].kind, "RECOMMEND");
    assert.equal(r.body.recommendations[0].proposalId, "p1");
    assert.ok(r.body.recommendations[0].reasons.includes("SERVES_GOAL"));
  });

  it("a proposal with NO recorded verdict is not recommended on 'nothing ruled it out'", async () => {
    // The whole point. An unevaluated option must not win by default.
    install({
      trip_goals: [goal()],
      trip_decision_tasks: [dtask()],
      trip_risks: [],
      trip_proposals: [prop({ payload_json: { decision_task_id: "t1", serves_goal_ids: ["g1"] } })],
    });
    const r = await get();
    assert.equal(r.body.recommendations[0].kind, "DO_NOT_RECOMMEND");
    assert.ok(r.body.recommendations[0].options[0].reasons.includes("FEASIBILITY_UNKNOWN"));
  });

  it("an UNRECOGNISED verdict string is treated as no verdict, not as a pass", async () => {
    install({
      trip_goals: [], trip_decision_tasks: [dtask()], trip_risks: [],
      trip_proposals: [prop({ payload_json: { decision_task_id: "t1", feasibility_verdict: "PROBABLY_FINE" } })],
    });
    const r = await get();
    assert.ok(r.body.recommendations[0].options[0].reasons.includes("FEASIBILITY_UNKNOWN"));
  });

  it("§8.4: a HIGH open risk on a touched element blocks the option and is reported", async () => {
    install({
      trip_goals: [], trip_decision_tasks: [dtask()],
      trip_risks: [risk({ id: "r1", impact: "high", likelihood: "low", trigger_json: { affects: ["e1"] } })],
      trip_proposals: [prop({
        payload_json: { decision_task_id: "t1", affected_objects: ["e1"], feasibility_verdict: "FEASIBLE_UNVERIFIED" },
      })],
    });
    const r = await get();
    assert.equal(r.body.recommendations[0].kind, "DO_NOT_RECOMMEND");
    assert.ok(r.body.recommendations[0].options[0].reasons.includes("BLOCKED_BY_HIGH_RISK"));
    // TR144: the propagation itself is served, not only its consequence.
    assert.deepEqual(r.body.elementRisks, [{
      elementId: "e1", riskIds: ["r1"], worstImpact: "high", worstLikelihood: "low",
    }]);
  });

  it("a MITIGATED risk propagates to nothing", async () => {
    install({
      trip_goals: [], trip_decision_tasks: [dtask()],
      trip_risks: [risk({ status: "mitigated", impact: "high", trigger_json: { affects: ["e1"] } })],
      trip_proposals: [prop({
        payload_json: { decision_task_id: "t1", affected_objects: ["e1"], feasibility_verdict: "FEASIBLE_UNVERIFIED" },
      })],
    });
    const r = await get();
    assert.deepEqual(r.body.elementRisks, []);
    assert.equal(r.body.recommendations[0].kind, "RECOMMEND");
  });
});

describe("§9.3 — the caller's own ballot, and nobody else's", () => {
  it("serves the caller's own vote", async () => {
    install({
      trip_goals: [], trip_decision_tasks: [dtask()], trip_risks: [],
      trip_proposals: [prop({ id: "p1" })],
      trip_proposal_votes: [
        { proposal_id: "p1", user_id: OWNER_ID, vote: "yes" },
        { proposal_id: "p1", user_id: "someone-else", vote: "no" },
      ],
    });
    const r = await get();
    assert.equal(r.body.proposals[0].myVote, "yes");
  });

  it("does NOT serve anyone else's ballot, anywhere in the response", async () => {
    // The narrow default for a privacy question. Widening it later is a
    // one-line change; narrowing it after people have seen each other's
    // ballots is not.
    install({
      trip_goals: [], trip_decision_tasks: [dtask()], trip_risks: [],
      trip_proposals: [prop({ id: "p1" })],
      trip_proposal_votes: [
        { proposal_id: "p1", user_id: OWNER_ID, vote: "yes" },
        { proposal_id: "p1", user_id: "someone-else", vote: "no" },
      ],
    });
    const r = await get();
    assert.ok(!JSON.stringify(r.body).includes("someone-else"),
      "another crew member's ballot reached the response");
  });

  it("NOT VOTED is null, and is not the same as 'abstain'", async () => {
    // 2774's own column comment: an abstention is a recorded decision not to
    // decide; a silence means nobody knows what it means. The unanimous rule
    // turns on exactly that difference.
    install({
      trip_goals: [], trip_decision_tasks: [dtask()], trip_risks: [],
      trip_proposals: [prop({ id: "p1" }), prop({ id: "p2" })],
      trip_proposal_votes: [{ proposal_id: "p2", user_id: OWNER_ID, vote: "abstain" }],
    });
    const r = await get();
    const p1 = r.body.proposals.find((p: any) => p.id === "p1");
    const p2 = r.body.proposals.find((p: any) => p.id === "p2");
    assert.equal(p1.myVote, null);
    assert.equal(p2.myVote, "abstain");
    assert.notEqual(p1.myVote, p2.myVote);
  });

  it("an unreadable votes table refuses the whole response", async () => {
    // A missing ballot reads as "you have not voted", which would send a crew
    // member to vote twice — and the kernel would then have to refuse them.
    install({
      trip_goals: [], trip_decision_tasks: [dtask()], trip_risks: [],
      trip_proposals: [prop({ id: "p1" })], trip_proposal_votes: [],
    }, ["trip_proposal_votes"]);
    const r = await get();
    assert.equal(r.status, 503);
    assert.equal(r.body.proposals, undefined);
  });
});

describe("§9.3 — a proposal arrives with its governance state, or with none at all", () => {
  it("each proposal carries the tally, passed through untouched", async () => {
    install({
      trip_goals: [], trip_decision_tasks: [dtask()], trip_risks: [],
      trip_proposals: [prop({ id: "p1", decision_rule: "majority" })],
    });
    const r = await get();
    assert.equal(r.body.proposals[0].tally.decision_rule, "majority");
    assert.equal(r.body.proposals[0].tally.electorate, 3);
    assert.equal(r.body.proposals[0].tally.majority_met, true);
    assert.equal(r.body.tallyFailures, 0);
  });

  it("a tally that could NOT be computed is null, and the failure is counted", async () => {
    // The forbidden shape: rendering a proposal whose electorate could not be
    // counted as 0 yes / 0 no, which invents a governance state.
    install({
      trip_goals: [], trip_decision_tasks: [dtask()], trip_risks: [],
      trip_proposals: [prop({ id: "p1" })],
    }, ["rpc:trip_proposal_tally"]);
    const r = await get();
    assert.equal(r.status, 200, "one unavailable tally must not refuse the whole trip");
    assert.equal(r.body.proposals[0].tally, null);
    assert.equal(r.body.tallyFailures, 1,
      "a null tally must be a visible absence, not something a reader infers");
  });
});

describe("§8 — unconstrained jsonb is not trusted", () => {
  it("a malformed affected_objects reaches nothing rather than something arbitrary", async () => {
    install({
      trip_goals: [], trip_decision_tasks: [dtask()],
      trip_risks: [risk({ impact: "high", trigger_json: { affects: ["e1"] } })],
      trip_proposals: [prop({
        payload_json: {
          decision_task_id: "t1",
          affected_objects: "e1",            // a string, not an array
          feasibility_verdict: "FEASIBLE_UNVERIFIED",
        },
      })],
    });
    const r = await get();
    // Not blocked: the malformed value produced NO element ids, rather than
    // being coerced into ["e1"] and matching the risk by accident.
    assert.equal(r.body.recommendations[0].options[0].worstRiskImpact, null);
  });

  it("a malformed risk trigger propagates to nothing", async () => {
    install({
      trip_goals: [], trip_decision_tasks: [dtask()],
      trip_risks: [risk({ impact: "high", trigger_json: { affects: { e1: true } } })],
      trip_proposals: [prop({ payload_json: { decision_task_id: "t1", feasibility_verdict: "FEASIBLE_UNVERIFIED" } })],
    });
    const r = await get();
    assert.deepEqual(r.body.elementRisks, []);
  });

  it("a non-string decision_task_id leaves the proposal unattached", async () => {
    install({
      trip_goals: [], trip_decision_tasks: [dtask()], trip_risks: [],
      trip_proposals: [prop({ payload_json: { decision_task_id: 7, feasibility_verdict: "FEASIBLE_UNVERIFIED" } })],
    });
    const r = await get();
    assert.deepEqual(r.body.recommendations[0].reasons, ["NO_PROPOSALS"]);
  });
});

describe("§8 — fail-closed: no partial recommendation", () => {
  // A recommendation computed with an input missing is not a weaker
  // recommendation, it is a DIFFERENT one. Each of these is a table whose
  // absence would flip an answer.
  for (const [table, why] of [
    ["trip_risks", "an option blocked by a HIGH risk becomes the winner"],
    ["trip_goals", "goal-priority ranking silently becomes a tie"],
    ["trip_proposals", "every task becomes NO_PROPOSALS"],
    ["trip_decision_tasks", "there is nothing to recommend about"],
  ] as const) {
    it(`an unreadable ${table} refuses the whole response — otherwise ${why}`, async () => {
      install({
        trip_goals: [goal()], trip_decision_tasks: [dtask()],
        trip_risks: [risk({ impact: "high", trigger_json: { affects: ["e1"] } })],
        trip_proposals: [prop({
          payload_json: { decision_task_id: "t1", affected_objects: ["e1"], serves_goal_ids: ["g1"], feasibility_verdict: "FEASIBLE_UNVERIFIED" },
        })],
      }, [table]);
      const r = await get();
      assert.equal(r.status, 503, `${table} did not refuse`);
      assert.equal(r.body.error, "degraded_unavailable");
      assert.equal(r.body.recommendations, undefined);
    });
  }

  it("a non-member is refused, not answered", async () => {
    install({ trip_goals: [], trip_decision_tasks: [], trip_risks: [], trip_proposals: [] });
    const r = await get("other-token");
    assert.equal(r.status, 403);
    assert.equal(r.body.recommendations, undefined);
  });

  it("an empty trip answers with empty lists — that IS an answer", async () => {
    install({ trip_goals: [], trip_decision_tasks: [], trip_risks: [], trip_proposals: [] });
    const r = await get();
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.recommendations, []);
    assert.deepEqual(r.body.elementRisks, []);
    assert.ok(typeof r.body.asOf === "string");
  });
});

describe("the route is reachable", () => {
  it("is registered in the router index", () => {
    const index = readFileSync(new URL("../routes/index.ts", import.meta.url), "utf8");
    assert.match(index, /import tripDecisionsRouter from "\.\/tripDecisions"/);
    assert.match(index, /router\.use\(tripDecisionsRouter\)/);
  });

  it("does not soften the engine's verdicts on the way out", () => {
    // The route reads, shapes and refuses. If it ever starts rewriting an
    // INSUFFICIENT_BASIS into something friendlier, this is where it shows.
    const route = readFileSync(new URL("../routes/tripDecisions.ts", import.meta.url), "utf8");
    assert.match(route, /recommendations,/);
    assert.ok(!/kind:\s*"RECOMMEND"/.test(route),
      "the route constructs a recommendation kind of its own");
    assert.ok(!/INSUFFICIENT_BASIS/.test(route.replace(/\/\*[\s\S]*?\*\//g, "")),
      "the route mentions a recommendation kind outside its header comment");
  });
});
