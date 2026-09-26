/**
 * S112 — the revocation lineage reach has a PRODUCTION caller, and it is the
 * account-deletion run, before `erase_intel_for_actor`.
 *
 * census-sensing §22.2 measured `sessionRevocationReach`'s only importer as a
 * test. These cases pin the caller that changes that measurement, and — as
 * important — pin what the caller HONESTLY cannot know: exact snapshot
 * provenance does not exist (2130 records none), so the reach is at SUBJECT
 * granularity and over-inclusive; and the memory half has no persisted store
 * (`provenance_json.claim_refs` is never written anywhere), so it is declared
 * `none_persisted` rather than reported as an empty "nothing reached".
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/accountDeletionSensingRevocationReach.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  enumerateSensingRevocationReach,
  type PagedRead,
} from "../services/accountDeletion/sensingRevocationReach.js";
import { executeAccountDeletion } from "../services/accountDeletion/AccountDeletionService.js";
import { resetContributorIdentityShapeMemo } from "../lib/intelConsent.js";
import { openExperienceSession, closeExperienceSession, SESSION_OPEN_VERB } from "../lib/experienceSession.js";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const TOKEN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PLACE_P = "33333333-3333-4333-8333-333333333333"; // observed by USER
const PLACE_Q = "44444444-4444-4444-8444-444444444444"; // never observed by USER
const SNAP_P1 = "55555555-5555-4555-8555-555555555551";
const SNAP_P2 = "55555555-5555-4555-8555-555555555552";
const SNAP_Q1 = "66666666-6666-4666-8666-666666666661";
const NOW = Date.parse("2026-09-26T07:00:00.000Z");

type Row = Record<string, any>;

interface FakeOpts {
  /** Simulate a database without 3311: the overlap read on the provenance column fails. */
  pre3311?: boolean;
  rows?: Record<string, Row[]>;
  /** table -> error message, injected on select. */
  failSelect?: Record<string, string>;
  /** "bridge" answers the 3310 rpcs; "account" makes both rpcs absent (pre-3002). */
  shape?: "bridge" | "account";
  tokens?: string[];
}

/**
 * A supabase-js stand-in that actually FILTERS on eq/in, so the reach's
 * queries are exercised rather than echoed. Records every operation so a
 * test can assert order (the reach must precede the erase).
 */
function makeFake(opts: FakeOpts = {}) {
  const rows = opts.rows ?? {};
  const ops: Array<{ table: string; op: string; filters: any[] }> = [];
  const shape = opts.shape ?? "bridge";
  function builder(table: string) {
    const q: any = {
      _op: "select",
      _filters: [] as any[],
      _range: null as null | [number, number],
      _limit: undefined as number | undefined,
      _single: false,
      select() { q._op = "select"; return q; },
      delete() { q._op = "delete"; return q; },
      update() { q._op = "update"; return q; },
      upsert() { q._op = "upsert"; return q; },
      insert() { q._op = "insert"; return q; },
      eq(c: string, v: any) { q._filters.push(["eq", c, v]); return q; },
      neq(c: string, v: any) { q._filters.push(["neq", c, v]); return q; },
      not(c: string, op: string, v: any) { q._filters.push(["not", c, op, v]); return q; },
      lte(c: string, v: any) { q._filters.push(["lte", c, v]); return q; },
      in(c: string, v: any[]) { q._filters.push(["in", c, v]); return q; },
      overlaps(c: string, v: any[]) { q._filters.push(["overlaps", c, v]); return q; },
      is(c: string, v: any) { q._filters.push(["is", c, v]); return q; },
      or(expr: string) { q._filters.push(["or", expr]); return q; },
      order() { return q; },
      limit(n: number) { q._limit = n; return q; },
      range(a: number, b: number) { q._range = [a, b]; return q; },
      maybeSingle() { q._single = true; return q._run(); },
      then(resolve: any, reject: any) { return q._run().then(resolve, reject); },
      _run() {
        ops.push({ table, op: q._op, filters: q._filters });
        if (q._op === "select" && opts.failSelect?.[table]) {
          return Promise.resolve({ data: null, error: { message: opts.failSelect[table], code: "08006" } });
        }
        // A pre-3311 database: PostgREST does not know the provenance column.
        if (q._op === "select" && opts.pre3311 && q._filters.some((f: any[]) => f[0] === "overlaps" && f[1] === "input_observation_ids")) {
          return Promise.resolve({ data: null, error: { code: "42703", message: "column intel_state_snapshots.input_observation_ids does not exist" } });
        }
        let data: Row[] = rows[table] ?? [];
        if (q._op === "select") {
          for (const f of q._filters) {
            if (f[0] === "eq") data = data.filter((r) => r[f[1]] === f[2]);
            if (f[0] === "in") data = data.filter((r) => (f[2] as any[]).includes(r[f[1]]));
            if (f[0] === "overlaps") data = data.filter((r) => Array.isArray(r[f[1]]) && (r[f[1]] as any[]).some((x) => (f[2] as any[]).includes(x)));
          }
          if (q._range) data = data.slice(q._range[0], q._range[1] + 1);
          else if (q._limit) data = data.slice(0, q._limit);
        }
        if (q._single) return Promise.resolve({ data: data[0] ?? null, error: null });
        return Promise.resolve({ data, error: null });
      },
    };
    return q;
  }
  const absent = { data: null, error: { code: "PGRST202", message: "Could not find the function" } };
  const sc = {
    _ops: ops,
    from: builder,
    rpc: async (fn: string, args: Record<string, unknown>) => {
      ops.push({ table: `rpc:${fn}`, op: "rpc", filters: [args] });
      if (fn === "intel_consented_contributor_tokens") return shape === "bridge" ? { data: [], error: null } : absent;
      if (fn === "intel_contributor_token") return absent;
      if (fn === "intel_contributor_tokens_for_actor") {
        return shape === "bridge" ? { data: opts.tokens ?? [TOKEN], error: null } : absent;
      }
      return { data: null, error: null };
    },
    storage: { from: () => ({ remove: async () => ({ data: null, error: null }) }) },
    auth: { admin: { deleteUser: async () => ({ data: null, error: null }) } },
  };
  return sc;
}

/** The one pager contract, reduced: range-paged, fresh builder per page. */
const readAll: PagedRead = async (build, consume) => {
  let collected = 0;
  let offset = 0;
  for (let page = 0; page < 50; page += 1) {
    const { data, error } = await build().range(offset, offset + 499);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as any[];
    collected += consume(rows);
    if (rows.length < 500) return collected;
    offset += rows.length;
  }
  return collected;
};

function sessionEvent(actorId: string, subjectId: string, sessionId: string, claimRefs: string[], close: boolean) {
  const o = openExperienceSession(actorId, { sessionId, subjectId, opportunityKind: "go_now", claimRefs }, NOW - 3_600_000);
  assert.ok(o.ok, "fixture session must open");
  const events: Row[] = [{
    id: `${sessionId}-open`, actor_id: actorId, verb: SESSION_OPEN_VERB, subject_kind: "place", subject_id: subjectId,
    payload: { experience_session: o.envelope }, occurred_at: o.envelope.opened_at,
  }];
  if (close) {
    const c = closeExperienceSession(o.envelope, actorId, { outcome: "better" }, NOW - 60_000);
    assert.ok(c.ok, "fixture session must close");
    events.push({
      id: `${sessionId}-close`, actor_id: actorId, verb: "completion", subject_kind: "place", subject_id: subjectId,
      payload: { experience_session: c.envelope }, occurred_at: c.envelope.closed_at,
    });
  }
  return events;
}

const SID_HIT = "77777777-7777-4777-8777-777777777771";
const SID_MISS = "77777777-7777-4777-8777-777777777772";
const SID_OWN = "77777777-7777-4777-8777-777777777773";
const SID_Q = "77777777-7777-4777-8777-777777777774";
const SID_P3 = "77777777-7777-4777-8777-777777777775";
const SNAP_P3 = "88888888-8888-4888-8888-888888888883";

function fixtureRows(): Record<string, Row[]> {
  return {
    intel_observations: [
      { id: "obs-1", actor_id: TOKEN, subject_id: PLACE_P },
      { id: "obs-2", actor_id: TOKEN, subject_id: PLACE_P },
      { id: "obs-3", actor_id: TOKEN, subject_id: null }, // S111: an `unknown` subject
      { id: "obs-9", actor_id: OTHER, subject_id: PLACE_Q }, // somebody else's
    ],
    intel_state_snapshots: [
      // 3311 provenance: which observations each snapshot rested on.
      { id: SNAP_P1, subject_id: PLACE_P, zone_id: "", claim_type: "crowd.level", input_observation_ids: ["obs-1"] },
      { id: SNAP_P2, subject_id: PLACE_P, zone_id: "", claim_type: "queue.wait", input_observation_ids: ["obs-2", "obs-9"] },
      // Of P, but resting on OTHER's evidence only — the subject fallback reaches it; exact provenance does not.
      { id: SNAP_P3, subject_id: PLACE_P, zone_id: "z1", claim_type: "crowd.level", input_observation_ids: ["obs-9"] },
      { id: SNAP_Q1, subject_id: PLACE_Q, zone_id: "", claim_type: "crowd.level", input_observation_ids: ["obs-9"] },
    ],
    canonical_events: [
      // OTHER's session on P, resting on SNAP_P2 — reached.
      ...sessionEvent(OTHER, PLACE_P, SID_HIT, [SNAP_P2], true),
      // OTHER's session on P that rests on Q's snapshot only — on the subject, but unaffected.
      ...sessionEvent(OTHER, PLACE_P, SID_MISS, [SNAP_Q1], false),
      // USER's own session on P — excluded, the deletion handles it.
      ...sessionEvent(USER, PLACE_P, SID_OWN, [SNAP_P1], true),
      // OTHER's session on Q — never read (USER did not observe Q).
      ...sessionEvent(OTHER, PLACE_Q, SID_Q, [SNAP_Q1], true),
      // OTHER's session on P resting ONLY on P3 — reached under the subject fallback, not under exact provenance.
      ...sessionEvent(OTHER, PLACE_P, SID_P3, [SNAP_P3], true),
    ],
  };
}

describe("S112 — the reach is enumerated at subject granularity, before the erase", () => {
  beforeEach(() => resetContributorIdentityShapeMemo());

  it("reaches the other account's session that rests on a snapshot of an observed subject", async () => {
    const sc = makeFake({ rows: fixtureRows() });
    const out = await enumerateSensingRevocationReach(sc, USER, readAll);
    assert.equal(out.via, "token_rpc");
    assert.equal(out.identities, 2, "the account id plus one live-epoch token");
    assert.equal(out.observations, 3, "USER's rows under the token, including the subjectless one");
    assert.equal(out.subjects, 1, "a null subject feeds no snapshot");
    assert.equal(out.snapshots, 3, "every snapshot of P — the over-inclusive set, still counted");
    assert.equal(out.provenance, "exact", "3311's provenance was readable");
    assert.equal(out.snapshotsExact, 2, "P1 and P2 rest on USER's observations; P3 rests on OTHER's only");
    assert.deepEqual(out.observationIds, ["obs-1", "obs-2", "obs-3"], "the evidence the erase is about to remove");
    assert.deepEqual(
      out.affected.map((a) => a.id).sort(),
      [SNAP_P1, SNAP_P2].sort(),
      "the recompute acts on the exact set",
    );
    assert.deepEqual(out.affected.find((a) => a.id === SNAP_P2), { id: SNAP_P2, subjectId: PLACE_P, zoneId: "", claimType: "queue.wait" });
    assert.equal(out.sessionsConsidered, 3, "SID_HIT, SID_MISS and SID_P3; SID_OWN excluded; SID_Q never read");
    assert.equal(out.sessionsReached, 1, "SID_HIT rests on P2; SID_P3 rests on P3, which USER's evidence never fed");
    assert.equal(out.ownSessionsExcluded, 2, "USER's open and close events for SID_OWN");
    assert.deepEqual(out.stagesReached, ["raw", "aggregate", "inference", "session"]);
    assert.equal(out.memoryStore, "none_persisted");
  });

  it("the memory stage is never claimed — nothing persists claim_refs, and the outcome says so", async () => {
    const sc = makeFake({ rows: fixtureRows() });
    const out = await enumerateSensingRevocationReach(sc, USER, readAll);
    assert.equal(out.stagesReached.includes("memory"), false);
    assert.equal(out.memoryStore, "none_persisted");
  });

  it("a pre-3311 database falls back to SUBJECT granularity — over-inclusive, never 'rested on nothing'", async () => {
    const sc = makeFake({ rows: fixtureRows(), pre3311: true });
    const out = await enumerateSensingRevocationReach(sc, USER, readAll);
    assert.equal(out.provenance, "subject");
    assert.equal(out.snapshotsExact, 3, "equals the subject set under fallback");
    assert.deepEqual(out.affected.map((a) => a.id).sort(), [SNAP_P1, SNAP_P2, SNAP_P3].sort());
    assert.equal(out.sessionsReached, 2, "SID_P3 is reached too — the fallback over-includes rather than under-includes");
  });

  it("any OTHER failure of the provenance read still throws — only the missing column is a fallback", async () => {
    const sc = makeFake({ rows: fixtureRows(), failSelect: { intel_state_snapshots: "server closed the connection unexpectedly" } });
    await assert.rejects(() => enumerateSensingRevocationReach(sc, USER, readAll), /server closed the connection unexpectedly/);
  });

  it("a pre-3002 store derives identities from the account id alone", async () => {
    const rows = fixtureRows();
    // obs-2 is what SNAP_P2 (and so SID_HIT) rests on under 3311's provenance.
    rows.intel_observations = [{ id: "obs-2", actor_id: USER, subject_id: PLACE_P }];
    const sc = makeFake({ rows, shape: "account" });
    const out = await enumerateSensingRevocationReach(sc, USER, readAll);
    assert.equal(out.via, "account_id");
    assert.equal(out.identities, 1);
    assert.equal(out.subjects, 1);
    assert.equal(out.sessionsReached, 1);
  });

  it("no observations means nothing is reached and no stage is claimed", async () => {
    const rows = fixtureRows();
    rows.intel_observations = [];
    const sc = makeFake({ rows });
    const out = await enumerateSensingRevocationReach(sc, USER, readAll);
    assert.equal(out.subjects, 0);
    assert.equal(out.snapshots, 0);
    assert.equal(out.sessionsConsidered, 0);
    assert.deepEqual(out.stagesReached, []);
    // And the snapshot / session tables were never queried for an empty subject list.
    assert.equal(sc._ops.some((o) => o.table === "intel_state_snapshots"), false);
    assert.equal(sc._ops.some((o) => o.table === "canonical_events"), false);
  });

  it("an unreadable observations read THROWS — it never answers 'reached nothing'", async () => {
    const sc = makeFake({ rows: fixtureRows(), failSelect: { intel_observations: "server closed the connection unexpectedly" } });
    await assert.rejects(
      () => enumerateSensingRevocationReach(sc, USER, readAll),
      /server closed the connection unexpectedly/,
    );
  });
});

describe("S112 — the account-deletion run is the production caller", () => {
  beforeEach(() => resetContributorIdentityShapeMemo());

  it("runs the reach step BEFORE erase_intel_for_actor and records its count", async () => {
    const sc = makeFake({ rows: { posts: [], ...fixtureRows() } });
    const out = await executeAccountDeletion(sc as any, USER, { actorId: null } as any);
    const step = out.steps.find((s) => s.step === "sensing_revocation_reach");
    assert.ok(step, `no sensing_revocation_reach step: ${out.steps.map((s) => s.step).join(", ")}`);
    assert.equal(step!.ok, true, step!.error);
    assert.equal(step!.count, 1, "one other-account session rested on the erased evidence");
    const reachAt = sc._ops.findIndex((o) => o.table === "intel_observations" && o.op === "select");
    const eraseAt = sc._ops.findIndex((o) => o.table === "rpc:erase_intel_for_actor");
    assert.ok(reachAt >= 0 && eraseAt >= 0, "both the reach read and the erase must have run");
    assert.ok(reachAt < eraseAt, `the reach (${reachAt}) must precede the erase (${eraseAt})`);
    assert.ok(!out.warnings.some((w) => w.includes("sensing lineage reach")), out.warnings.join(" | "));
  });

  it("AFTER the erase, the affected snapshots are recomputed, and those still resting on erased evidence are RETRACTED", async () => {
    const sc = makeFake({ rows: { posts: [], ...fixtureRows() } });
    const out = await executeAccountDeletion(sc as any, USER, { actorId: null } as any);
    const step = out.steps.find((s) => s.step === "recompute_intel_snapshots_after_erase");
    assert.ok(step, `no recompute step: ${out.steps.map((s) => s.step).join(", ")}`);
    assert.equal(step!.ok, true, step!.error);
    const eraseAt = sc._ops.findIndex((o) => o.table === "rpc:erase_intel_for_actor");
    const claimsAt = sc._ops.findIndex((o) => o.table === "intel_claims" && o.op === "select");
    assert.ok(claimsAt > eraseAt, `the recompute (${claimsAt}) must FOLLOW the erase (${eraseAt})`);
    // This fake neither projects (no flag row) nor forgets: the rows still name
    // obs-1 / obs-2 after the recompute, so both exact-set snapshots are retracted.
    const retractions = sc._ops.filter((o) => o.table === "intel_state_snapshots" && o.op === "update");
    assert.deepEqual(
      retractions.map((o) => o.filters.find((f: any[]) => f[0] === "eq" && f[1] === "id")?.[2]).sort(),
      [SNAP_P1, SNAP_P2].sort(),
      "exactly the snapshots that rested on the erased evidence — P3 is untouched",
    );
    assert.equal(sc._ops.filter((o) => o.table === "intel_state_snapshot_versions" && o.op === "insert").length, 2, "one retraction version per retracted row");
    assert.equal(step!.count, 2);
  });

  it("an unreadable precondition fails the step and warns, and the erase still runs", async () => {
    const sc = makeFake({
      rows: { posts: [], ...fixtureRows() },
      failSelect: { intel_state_snapshots: "server closed the connection unexpectedly" },
    });
    const out = await executeAccountDeletion(sc as any, USER, { actorId: null } as any);
    const step = out.steps.find((s) => s.step === "sensing_revocation_reach");
    assert.ok(step);
    assert.equal(step!.ok, false);
    assert.match(step!.error ?? "", /server closed the connection unexpectedly/);
    assert.ok(out.warnings.some((w) => w.includes("sensing lineage reach")), out.warnings.join(" | "));
    assert.ok(sc._ops.some((o) => o.table === "rpc:erase_intel_for_actor"), "the erase is not held hostage by the enumeration");
  });
});
