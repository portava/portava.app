/**
 * S112 — the revocation lineage reach has a PRODUCTION caller, and it is the
 * account-deletion run, before `erase_intel_for_actor`.
 *
 * census-sensing §22.2 measured `sessionRevocationReach`'s only importer as a
 * test. These cases pin the caller that changes that measurement, and — as
 * important — pin what the caller HONESTLY cannot know: exact snapshot
 * provenance does not exist (2130 records none), so the reach is at SUBJECT
 * granularity and over-inclusive — unless 3311's provenance makes it exact;
 * and, since 3314, the MEMORY stage has a persisted store: another account's
 * session memory whose `claim_refs` name an affected snapshot is reached, and
 * after the erase its references to WITHDRAWN snapshots are removed while its
 * references to snapshots that still stand are kept. Without 3314 the store
 * cannot be asked, and the outcome says `column_absent` rather than "nothing
 * reached".
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
  /** Simulate a database without 3314: the overlap read on memory_projections.claim_refs fails. */
  pre3314?: boolean;
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
      _payload: null as Row | null,
      _limit: undefined as number | undefined,
      _single: false,
      select() { q._op = "select"; return q; },
      delete() { q._op = "delete"; return q; },
      update(patch?: Row) { q._op = "update"; q._payload = patch ?? null; return q; },
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
        // A pre-3314 database: PostgREST does not know memory_projections.claim_refs.
        if (q._op === "select" && opts.pre3314 && q._filters.some((f: any[]) => f[0] === "overlaps" && f[1] === "claim_refs")) {
          return Promise.resolve({ data: null, error: { code: "42703", message: "column memory_projections.claim_refs does not exist" } });
        }
        // UPDATE applies its patch to the rows its filters select, so a later
        // read sees what an earlier step wrote — the erasure's effect is read
        // back, not assumed.
        if (q._op === "update" && q._payload) {
          const target = (rows[table] ?? []).filter((r) =>
            q._filters.every((f: any[]) => (f[0] === "eq" ? r[f[1]] === f[2] : f[0] === "in" ? (f[2] as any[]).includes(r[f[1]]) : true)),
          );
          for (const r of target) Object.assign(r, q._payload);
          return Promise.resolve({ data: null, error: null });
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
const MEM_HIT = "99999999-9999-4999-8999-999999999991";
const MEM_MISS = "99999999-9999-4999-8999-999999999992";
const MEM_P3 = "99999999-9999-4999-8999-999999999993";
const MEM_OWN = "99999999-9999-4999-8999-999999999994";
const SERVING = { privacy_eligible: true, expires_at: new Date(NOW + 24 * 3_600_000).toISOString() };

function fixtureRows(): Record<string, Row[]> {
  return {
    intel_observations: [
      { id: "obs-1", actor_id: TOKEN, subject_id: PLACE_P },
      { id: "obs-2", actor_id: TOKEN, subject_id: PLACE_P },
      { id: "obs-3", actor_id: TOKEN, subject_id: null }, // S111: an `unknown` subject
      { id: "obs-9", actor_id: OTHER, subject_id: PLACE_Q }, // somebody else's
    ],
    intel_state_snapshots: [
      // 3311 provenance: which observations each snapshot rested on. Every one
      // is serving before the erase (eligible, unexpired).
      { id: SNAP_P1, subject_id: PLACE_P, zone_id: "", claim_type: "crowd.level", input_observation_ids: ["obs-1"], ...SERVING },
      { id: SNAP_P2, subject_id: PLACE_P, zone_id: "", claim_type: "queue.wait", input_observation_ids: ["obs-2", "obs-9"], ...SERVING },
      // Of P, but resting on OTHER's evidence only — the subject fallback reaches it; exact provenance does not.
      { id: SNAP_P3, subject_id: PLACE_P, zone_id: "z1", claim_type: "crowd.level", input_observation_ids: ["obs-9"], ...SERVING },
      { id: SNAP_Q1, subject_id: PLACE_Q, zone_id: "", claim_type: "crowd.level", input_observation_ids: ["obs-9"], ...SERVING },
    ],
    // 3314: session memories and the snapshots they rested on.
    memory_projections: [
      // OTHER's memory resting on P2 (erased evidence) AND Q1 (untouched) — reached; after the erase only Q1 remains.
      { id: MEM_HIT, user_id: OTHER, subject_type: "experience_session", claim_refs: [SNAP_P2, SNAP_Q1], provenance: { derivation: "experience_session" } },
      // OTHER's memory resting on Q1 only — never read by the overlap.
      { id: MEM_MISS, user_id: OTHER, subject_type: "experience_session", claim_refs: [SNAP_Q1], provenance: {} },
      // OTHER's memory resting on P3 — reached only under the subject fallback.
      { id: MEM_P3, user_id: OTHER, subject_type: "experience_session", claim_refs: [SNAP_P3], provenance: {} },
      // USER's own memory — excluded and counted; erase_memory_for_user removes it.
      { id: MEM_OWN, user_id: USER, subject_type: "experience_session", claim_refs: [SNAP_P1], provenance: {} },
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
    assert.deepEqual(out.stagesReached, ["raw", "aggregate", "inference", "session", "memory"]);
    assert.equal(out.memoryStore, "persisted");
    assert.equal(out.memoriesConsidered, 1, "MEM_HIT only: MEM_MISS does not overlap, MEM_P3 rests on P3 (outside the exact set), MEM_OWN is USER's");
    assert.equal(out.memoriesReached, 1);
    assert.equal(out.ownMemoriesExcluded, 1, "USER's own memory is erased by erase_memory_for_user, not counted as reached");
    assert.deepEqual(out.affectedMemories, [{ id: MEM_HIT, claimRefs: [SNAP_P2, SNAP_Q1] }]);
    assert.equal(JSON.stringify(out.affectedMemories).includes(OTHER), false, "the reach carries no memory owner");
  });

  it("the memory stage is claimed only when a STORED memory rests on the evidence", async () => {
    const rows = fixtureRows();
    rows.memory_projections = rows.memory_projections!.filter((m) => m.id !== MEM_HIT && m.id !== MEM_P3);
    const out = await enumerateSensingRevocationReach(makeFake({ rows }), USER, readAll);
    assert.equal(out.stagesReached.includes("memory"), false);
    assert.equal(out.memoriesReached, 0);
    assert.equal(out.memoryStore, "persisted", "the store was asked and answered: nothing rests on it");
  });

  it("a pre-3314 database reports column_absent — nothing can have been persisted with refs — and claims no memory stage", async () => {
    const out = await enumerateSensingRevocationReach(makeFake({ rows: fixtureRows(), pre3314: true }), USER, readAll);
    assert.equal(out.memoryStore, "column_absent");
    assert.equal(out.stagesReached.includes("memory"), false);
    assert.deepEqual(out.affectedMemories, []);
  });

  it("any OTHER failure of the memory read still throws — only the missing column is a fallback", async () => {
    const sc = makeFake({ rows: fixtureRows(), failSelect: { memory_projections: "server closed the connection unexpectedly" } });
    await assert.rejects(() => enumerateSensingRevocationReach(sc, USER, readAll), /server closed the connection unexpectedly/);
  });

  it("a pre-3311 database falls back to SUBJECT granularity — over-inclusive, never 'rested on nothing'", async () => {
    const sc = makeFake({ rows: fixtureRows(), pre3311: true });
    const out = await enumerateSensingRevocationReach(sc, USER, readAll);
    assert.equal(out.provenance, "subject");
    assert.equal(out.snapshotsExact, 3, "equals the subject set under fallback");
    assert.deepEqual(out.affected.map((a) => a.id).sort(), [SNAP_P1, SNAP_P2, SNAP_P3].sort());
    assert.equal(out.sessionsReached, 2, "SID_P3 is reached too — the fallback over-includes rather than under-includes");
    assert.equal(out.memoriesReached, 2, "MEM_P3 too, for the same reason");
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

  it("AFTER the recompute, the reached memory is RETAINED and its references to WITHDRAWN snapshots are removed — its reference to a standing one is kept", async () => {
    const rows: Record<string, Row[]> = { posts: [], ...fixtureRows() };
    const sc = makeFake({ rows });
    const out = await executeAccountDeletion(sc as any, USER, { actorId: null } as any);
    const step = out.steps.find((s) => s.step === "prune_memory_lineage_after_erase");
    assert.ok(step, `no memory lineage step: ${out.steps.map((s) => s.step).join(", ")}`);
    assert.equal(step!.ok, true, step!.error);
    assert.equal(step!.count, 1, "one reference removed (P2)");
    const recomputeAt = sc._ops.findIndex((o) => o.table === "intel_state_snapshots" && o.op === "update");
    const pruneAt = sc._ops.findIndex((o) => o.table === "memory_projections" && o.op === "update");
    assert.ok(recomputeAt >= 0 && pruneAt > recomputeAt, `the lineage pass (${pruneAt}) must FOLLOW the snapshot retraction (${recomputeAt})`);
    const hit = rows.memory_projections!.find((m) => m.id === MEM_HIT)!;
    assert.deepEqual(hit.claim_refs, [SNAP_Q1], "P2 was retracted by the erase; Q1 still stands");
    assert.equal(hit.subject_type, "experience_session", "the memory itself is retained — it is OTHER's record of their own evening");
    const lineage = (hit.provenance as any).lineage;
    assert.deepEqual(lineage.map((e: any) => [e.event, e.refs_removed]), [["input_erased", 1]]);
    assert.equal(JSON.stringify(hit.provenance).includes(USER), false, "the record never names whose erasure changed it");
    assert.equal(JSON.stringify(hit.provenance).includes(SNAP_P2), false, "nor which snapshot was withdrawn");
    // Untouched: the memory that did not overlap, and USER's own (the memory erasure handles it).
    assert.deepEqual(rows.memory_projections!.find((m) => m.id === MEM_MISS)!.claim_refs, [SNAP_Q1]);
    assert.equal(sc._ops.filter((o) => o.table === "memory_projections" && o.op === "update").length, 1);
    assert.ok(!out.warnings.some((w) => w.includes("memories")), out.warnings.join(" | "));
  });

  it("an unreadable snapshot state fails CLOSED: every affected reference is removed", async () => {
    const rows: Record<string, Row[]> = { posts: [], ...fixtureRows() };
    const sc = makeFake({ rows });
    // Let the reach and recompute read snapshots, then make the lineage pass's read fail.
    const base = sc.from;
    let snapshotReads = 0;
    (sc as any).from = (table: string) => {
      const q = base(table);
      if (table !== "intel_state_snapshots") return q;
      const origSelect = q.select;
      q.select = (...a: any[]) => {
        snapshotReads += 1;
        const r = origSelect.apply(q, a);
        const isLineageRead = typeof a[0] === "string" && a[0].includes("input_observation_ids") && a[0].includes("expires_at") && !a[0].includes("confidence");
        if (isLineageRead) {
          r._run = () => Promise.resolve({ data: null, error: { code: "08006", message: "lineage read failed" } });
        }
        return r;
      };
      return q;
    };
    const out = await executeAccountDeletion(sc as any, USER, { actorId: null } as any);
    const step = out.steps.find((s) => s.step === "prune_memory_lineage_after_erase");
    assert.ok(step && step.ok, step?.error);
    assert.ok(snapshotReads > 0);
    assert.deepEqual(rows.memory_projections!.find((m) => m.id === MEM_HIT)!.claim_refs, [], "blind ⇒ every affected reference removed");
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
