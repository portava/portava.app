/**
 * S112's memory stage, EXECUTED — migration 3314 against a real PostgreSQL.
 *
 * The TypeScript suites prove the writer, the reach and the erasure pass over
 * fakes. What only a database can prove is what 3314's SQL actually does:
 *
 *   1. `claim_refs` is uuid[] NOT NULL — a NULL and a non-id are refused;
 *   2. the reach's overlap query finds a memory by one of its refs;
 *   3. the SQL projector's support watermark (`project_user_memory_with_retraction`)
 *      still retracts a stale projector row, and does NOT retract a session
 *      memory — the one predicate 3314 adds;
 *   4. `erase_memory_for_user` removes the owner's session memory with the rest;
 *   5. the rollback REFUSES while a session memory exists.
 *
 * RED WHEN 3314's predicate is removed (case 3 fails: the session memory is
 * retracted), the column loses NOT NULL or its type (case 1), or the rollback
 * stops refusing (case 5). Skipped without LOCAL_DB_URL, like every db suite;
 * scripts/local-db/run-tests.sh refuses a run where anything is skipped.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HAVE_DB, exec, psql, rows, scalar, seedUser, deleteUser } from "./localDb.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROLLBACK = readFileSync(
  path.resolve(HERE, "../../../../../db/rollback/2026-09-26-3314-memory-projection-claim-refs-rollback.sql"),
  "utf8",
);

const SNAP_A = "3a3a3a3a-0000-4000-8000-00000000000a";
const SNAP_B = "3a3a3a3a-0000-4000-8000-00000000000b";
const SNAP_OTHER = "3a3a3a3a-0000-4000-8000-0000000000ff";
const SESSION = "5e55e55e-0000-4000-8000-000000000001";

let U = "";

function cleanup(): void {
  exec(`
    DELETE FROM public.memory_projections WHERE user_id = '${U}';
    DELETE FROM public.memory_events      WHERE user_id = '${U}';
  `);
}

describe("S112 memory stage — 3314 executed against a real database", { skip: !HAVE_DB }, () => {
  before(() => {
    U = seedUser("s112_memory_owner");
    cleanup();
    // A session memory, as sessionMemoryStore writes it, and a stale projector
    // row (an episodic city memory whose graph edge no longer exists) as the
    // control that proves the watermark still retracts what it should.
    exec(`
      INSERT INTO public.memory_projections
        (user_id, memory_type, subject_type, subject_id, content, confidence, provenance,
         retention_class, visibility, state, valid_from, last_supported_at, last_projected_at, claim_refs)
      VALUES
        ('${U}', 'episodic', 'experience_session', '${SESSION}', 'Went out on a live suggestion; it was better than expected', 0.8,
         '{"derivation":"experience_session"}'::jsonb, 'durable_fact', 'private', 'active',
         now() - interval '2 days', now() - interval '2 days', now() - interval '1 day',
         ARRAY['${SNAP_A}','${SNAP_B}']::uuid[]),
        ('${U}', 'episodic', 'city', 'Nowhere', 'Visited Nowhere', 0.7,
         '{"derivation":"compass_graph_edges:visited"}'::jsonb, 'durable_fact', 'private', 'active',
         now() - interval '9 days', now() - interval '9 days', now() - interval '1 day',
         '{}'::uuid[]);
    `);
  });

  after(() => {
    if (!U) return;
    cleanup();
    deleteUser(U);
  });

  it("claim_refs is uuid[] NOT NULL: a NULL and a non-id are both refused", () => {
    const nul = psql(
      `INSERT INTO public.memory_projections (user_id, memory_type, subject_type, subject_id, content, claim_refs)
       VALUES ('${U}', 'episodic', 'experience_session', 'x-null', 'x', NULL);`,
    );
    assert.notEqual(nul.status, 0, "a NULL claim_refs was accepted");
    assert.match(nul.stderr, /null value in column "claim_refs"/);

    const bad = psql(
      `INSERT INTO public.memory_projections (user_id, memory_type, subject_type, subject_id, content, claim_refs)
       VALUES ('${U}', 'episodic', 'experience_session', 'x-bad', 'x', ARRAY['not-a-snapshot-id']::uuid[]);`,
    );
    assert.notEqual(bad.status, 0, "a non-uuid claim ref was accepted");
    assert.match(bad.stderr, /invalid input syntax for type uuid/);
  });

  it("the reach's overlap query finds the memory by ONE of its refs, and not by a ref it does not hold", () => {
    const hit = rows<{ subject_id: string }>(
      `SELECT subject_id FROM public.memory_projections WHERE user_id = '${U}' AND claim_refs && ARRAY['${SNAP_B}']::uuid[]`,
    );
    assert.deepEqual(hit.map((r) => r.subject_id), [SESSION]);
    const miss = rows(
      `SELECT 1 FROM public.memory_projections WHERE user_id = '${U}' AND claim_refs && ARRAY['${SNAP_OTHER}']::uuid[]`,
    );
    assert.equal(miss.length, 0);
  });

  it("the projector's watermark still retracts a stale projector row, and does NOT retract the session memory", () => {
    exec(`SELECT * FROM public.project_user_memory_with_retraction('${U}', false);`);
    const state = Object.fromEntries(
      rows<{ subject_type: string; state: string }>(
        `SELECT subject_type, state FROM public.memory_projections WHERE user_id = '${U}'`,
      ).map((r) => [r.subject_type, r.state]),
    );
    assert.equal(state["city"], "retracted", "the control: a projector row with no support must still be retracted");
    assert.equal(state["experience_session"], "active", "3314's predicate: a session memory is not the projector's to retract");
  });

  it("the rollback REFUSES while a session memory exists, and leaves the column in place", () => {
    const r = psql(ROLLBACK);
    assert.notEqual(r.status, 0, "the rollback proceeded with a session memory present");
    assert.match(r.stderr, /ROLLBACK REFUSED/);
    assert.equal(
      scalar(`SELECT count(*) FROM information_schema.columns WHERE table_name = 'memory_projections' AND column_name = 'claim_refs'`),
      "1",
    );
  });

  it("erase_memory_for_user removes the owner's session memory with everything else", () => {
    exec(`SELECT public.erase_memory_for_user('${U}');`);
    assert.equal(scalar(`SELECT count(*) FROM public.memory_projections WHERE user_id = '${U}'`), "0");
  });
});
