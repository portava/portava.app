/**
 * S112's memory stage — the WRITER. A closed session becomes a memory WITH its
 * claim refs, or it becomes nothing, and every "nothing" has a name.
 *
 * RED WHEN: the writer drops `claim_refs` from the row; writes a memory whose
 * refs it could not persist (the pre-3314 case); writes while
 * `memory_projection` is off; or writes for an outcome the section-6 gate
 * refuses (`did_not_go` asserts PLANNED, `could_not_enter` proves no visit).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  persistSessionMemory,
  sessionMemoryClaimRefs,
  SESSION_MEMORY_SUBJECT_TYPE,
} from "../services/memoryProjections/sessionMemoryStore.js";
import {
  openExperienceSession,
  closeExperienceSession,
  type ExperienceSessionEnvelope,
} from "../lib/experienceSession.js";
import type { IntelOutcome } from "../lib/intelOutcomes.js";

const OWNER = "0a0a0a0a-1111-4111-8111-111111111111";
const PLACE = "0b0b0b0b-2222-4222-8222-222222222222";
const SESSION = "0c0c0c0c-3333-4333-8333-333333333333";
const SNAP_1 = "0d0d0d0d-4444-4444-8444-444444444441";
const SNAP_2 = "0d0d0d0d-4444-4444-8444-444444444442";
const NOW = Date.parse("2026-09-26T18:00:00.000Z");

function closed(outcome: IntelOutcome, claimRefs: readonly string[] = [SNAP_2, SNAP_1, SNAP_1]): ExperienceSessionEnvelope {
  const o = openExperienceSession(OWNER, { sessionId: SESSION, subjectId: PLACE, opportunityKind: "go_now", claimRefs }, NOW - 60 * 60_000);
  assert.ok(o.ok, "fixture session must open");
  const c = closeExperienceSession(o.envelope, OWNER, { outcome }, NOW - 5 * 60_000);
  assert.ok(c.ok, "fixture session must close");
  return c.envelope;
}

interface FakeOpts {
  flag?: boolean | "unreadable";
  upsertError?: { code?: string; message: string };
}

function fakeDb(opts: FakeOpts = {}) {
  const upserts: Array<{ row: Record<string, any>; options: any }> = [];
  const tables: string[] = [];
  const sc = {
    from(table: string) {
      tables.push(table);
      if (table === "feature_flags") {
        const q: any = {
          select: () => q,
          eq: () => q,
          maybeSingle: async () =>
            opts.flag === "unreadable"
              ? { data: null, error: { message: "relation unreadable" } }
              : { data: opts.flag === undefined ? null : { enabled: opts.flag }, error: null },
        };
        return q;
      }
      if (table === "memory_projections") {
        return {
          upsert: async (row: Record<string, any>, options: any) => {
            upserts.push({ row, options });
            return opts.upsertError ? { data: null, error: opts.upsertError } : { data: null, error: null };
          },
        };
      }
      throw new Error(`the session memory writer touched ${table}`);
    },
  };
  return { sc, upserts, tables };
}

describe("S112 memory stage — the writer persists a closed session's memory WITH its lineage", () => {
  it("memory_projection ON, an OCCURRED outcome: one row, keyed on the session, carrying every claim ref (deduplicated, sorted)", async () => {
    const db = fakeDb({ flag: true });
    const out = await persistSessionMemory(db.sc, OWNER, closed("better"), NOW);
    assert.deepEqual(out, { recorded: true, claimRefs: 2 });
    assert.equal(db.upserts.length, 1);
    const { row, options } = db.upserts[0]!;
    assert.deepEqual(row.claim_refs, [SNAP_1, SNAP_2], "the lineage IS the row — dropping it silently severs revocation");
    assert.equal(row.user_id, OWNER);
    assert.equal(row.memory_type, "episodic");
    assert.equal(row.subject_type, SESSION_MEMORY_SUBJECT_TYPE);
    assert.equal(row.subject_id, SESSION);
    assert.equal(row.visibility, "private");
    assert.equal(row.state, "active");
    assert.equal(options.onConflict, "user_id,memory_type,subject_type,subject_id", "a replay is an upsert, never a second memory");
    assert.equal(row.provenance.place_id, PLACE);
    assert.equal(row.provenance.outcome, "better");
    assert.equal("claim_refs" in row.provenance, false, "one source of truth for the lineage: the column");
    // Names no one but the owner, and the owner only as the row's own key.
    assert.equal(JSON.stringify(row.provenance).includes(OWNER), false);
  });

  it("a DISAPPOINTING evening is still a memory — `worse` is as strong an occurrence as `better`", async () => {
    const db = fakeDb({ flag: true });
    const out = await persistSessionMemory(db.sc, OWNER, closed("worse"), NOW);
    assert.equal(out.recorded, true);
    assert.match(db.upserts[0]!.row.content, /worse than expected/);
  });

  for (const outcome of ["did_not_go", "could_not_enter"] as const) {
    it(`\`${outcome}\` is refused by the EXISTING gate and nothing is written`, async () => {
      const db = fakeDb({ flag: true });
      const out = await persistSessionMemory(db.sc, OWNER, closed(outcome), NOW);
      assert.equal(out.recorded, false);
      assert.equal(out.recorded === false && out.refusal, "not_eligible");
      assert.equal(db.upserts.length, 0);
    });
  }

  for (const flag of [false, undefined, "unreadable"] as const) {
    it(`memory_projection ${flag === undefined ? "ABSENT" : String(flag).toUpperCase()} → memory_projection_off, and the store is never touched`, async () => {
      const db = fakeDb({ flag });
      const out = await persistSessionMemory(db.sc, OWNER, closed("better"), NOW);
      assert.deepEqual(out, { recorded: false, refusal: "memory_projection_off" });
      assert.equal(db.tables.includes("memory_projections"), false);
    });
  }

  it("a database WITHOUT 3314 → claim_refs_unavailable, and NO retry without the column", async () => {
    const db = fakeDb({
      flag: true,
      upsertError: { code: "PGRST204", message: "Could not find the 'claim_refs' column of 'memory_projections' in the schema cache" },
    });
    const out = await persistSessionMemory(db.sc, OWNER, closed("better"), NOW);
    assert.deepEqual(out, { recorded: false, refusal: "claim_refs_unavailable" });
    assert.equal(db.upserts.length, 1, "exactly one attempt — a memory written without its refs could never be reached by an erasure");
  });

  it("any other write error is write_failed, reported and not thrown", async () => {
    const db = fakeDb({ flag: true, upsertError: { code: "08006", message: "connection lost" } });
    const out = await persistSessionMemory(db.sc, OWNER, closed("same"), NOW);
    assert.equal(out.recorded, false);
    assert.equal(out.recorded === false && out.refusal, "write_failed");
  });

  it("a claim ref that is not a uuid refuses the whole write rather than dropping the ref", async () => {
    const db = fakeDb({ flag: true });
    const out = await persistSessionMemory(db.sc, OWNER, closed("better", [SNAP_1, "not-a-snapshot"]), NOW);
    assert.deepEqual(out, { recorded: false, refusal: "claim_ref_not_uuid" });
    assert.equal(db.upserts.length, 0);
    assert.equal(sessionMemoryClaimRefs(closed("better", [SNAP_1, "nope"])), null);
  });

  it("a session with NO claim refs is still a memory, with an empty lineage — it rests on no world evidence", async () => {
    const db = fakeDb({ flag: true });
    const out = await persistSessionMemory(db.sc, OWNER, closed("same", []), NOW);
    assert.deepEqual(out, { recorded: true, claimRefs: 0 });
    assert.deepEqual(db.upserts[0]!.row.claim_refs, []);
  });

  it("an OPEN session is not a memory", async () => {
    const db = fakeDb({ flag: true });
    const o = openExperienceSession(OWNER, { sessionId: SESSION, subjectId: PLACE, opportunityKind: "go_now", claimRefs: [SNAP_1] }, NOW - 60_000);
    assert.ok(o.ok);
    const out = await persistSessionMemory(db.sc, OWNER, o.envelope, NOW);
    assert.deepEqual(out, { recorded: false, refusal: "session_open" });
    assert.equal(db.upserts.length, 0);
  });

  it("no client → no_client", async () => {
    assert.deepEqual(await persistSessionMemory(null, OWNER, closed("better"), NOW), { recorded: false, refusal: "no_client" });
  });
});
