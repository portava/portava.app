/**
 * discoveryVerifyPhase03.db.test.ts — census-discovery §59 (verification lane
 * P12), DV-76: `12` Phase 0.3 *"Complete privacy/tagging Phase 0. Fix: pending
 * tag visibility, friends-only notification leak, `disable_tagging` fail-open,
 * other catalogued Phase 0 findings"*
 * (docs/specs/discovery-v1/12_Claude_Code_Implementation.md:20).
 *
 * The three named items were fixed at the ROUTE and SERVICE layer (tagging
 * Phase 0 #2, #8 and #3; docs/security/phase0-tagging-privacy-state.md) and
 * their unit tests pass (src/test/tagging.test.ts). This suite asks the
 * question those unit tests cannot: does the DATABASE hold the same line for a
 * client that never calls the route? `public.tags` is granted to
 * `authenticated`, and PostgREST is a door the route does not stand in.
 *
 *   P1  DEFECT, pinned: a signed-in client inserts a tag DIRECTLY, naming a
 *       user whose tag_permission is 'nobody', on a post it does not own —
 *       accepted, and `status` defaults to 'approved'. Phase 0 #1 (unauthorized
 *       tagging), the approval gate #2 depends on, the hourly cap and the
 *       `disable_tagging` stop (#3) are all enforced only in routes/tags.ts.
 *   P2  what DOES hold at the database: a third party cannot read a pending
 *       tag (tags_select / tags_read_own are the parties only); the tagger
 *       cannot promote its own pending tag (no client UPDATE policy); anon
 *       cannot insert at all.
 *
 * Every row is created inside a transaction that is ROLLED BACK.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { HAVE_DB, psql } from "./localDb.js";

/** One rolled-back script: three users, then `body` (which may SET LOCAL ROLE). */
function inRolledBackTx(ids: { x: string; y: string; z: string }, body: string): { status: number; stdout: string; stderr: string } {
  const seed = [
    `INSERT INTO auth.users (id, email) VALUES ('${ids.x}', 'p12x-${ids.x.slice(0, 8)}@local.test'), ('${ids.y}', 'p12y-${ids.y.slice(0, 8)}@local.test'), ('${ids.z}', 'p12z-${ids.z.slice(0, 8)}@local.test');`,
    `INSERT INTO public.profiles (id, handle, name) VALUES ('${ids.x}', 'p12x_${ids.x.slice(0, 8)}', 'x'), ('${ids.y}', 'p12y_${ids.y.slice(0, 8)}', 'y'), ('${ids.z}', 'p12z_${ids.z.slice(0, 8)}', 'z');`,
    `UPDATE public.profiles SET tag_permission = 'nobody' WHERE id = '${ids.z}';`,
  ].join("\n");
  return psql(`\\set VERBOSITY verbose\nBEGIN;\n${seed}\n${body}\nROLLBACK;\n`);
}
const asRole = (role: "authenticated" | "anon", sub: string | null) =>
  `SELECT set_config('request.jwt.claim.sub', '${sub ?? ""}', true);\nSELECT set_config('request.jwt.claim.role', '${role}', true);\nSET LOCAL ROLE ${role};`;
const fresh = () => ({ x: randomUUID(), y: randomUUID(), z: randomUUID() });

describe("DV-76 — Phase 0.3 at the database, for a client that skips the route (census-discovery §59)", { skip: !HAVE_DB }, () => {
  test("P1. DEFECT, pinned: a direct client insert tags a 'nobody' user on a stranger's post, and lands APPROVED", () => {
    const ids = fresh();
    const r = inRolledBackTx(ids, [
      asRole("authenticated", ids.x),
      `INSERT INTO public.tags (source_type, source_id, tagger_id, tagged_user_id) VALUES ('post', '${randomUUID()}', '${ids.x}', '${ids.z}') RETURNING 'p1:' || status;`,
      `RESET ROLE;`,
      `SELECT 'p1-count:' || count(1) FROM public.tags WHERE tagger_id = '${ids.x}';`,
    ].join("\n"));
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes("p1:approved"), `the database accepts it and defaults it to approved:\n${r.stdout}`);
    assert.ok(r.stdout.includes("p1-count:1"));
  });

  test("P2. what holds: parties-only reads of a pending tag, no client promotion of it, and no anonymous insert", () => {
    const ids = fresh();
    const pendingId = randomUUID();
    const r = inRolledBackTx(ids, [
      `INSERT INTO public.tags (id, source_type, source_id, tagger_id, tagged_user_id, status) VALUES ('${pendingId}', 'post', '${randomUUID()}', '${ids.x}', '${ids.z}', 'pending');`,
      asRole("authenticated", ids.y),
      `SELECT 'p2-third-party-sees:' || count(1) FROM public.tags WHERE id = '${pendingId}';`,
      `RESET ROLE;`,
      asRole("authenticated", ids.z),
      `SELECT 'p2-tagged-sees:' || count(1) FROM public.tags WHERE id = '${pendingId}';`,
      `RESET ROLE;`,
      asRole("authenticated", ids.x),
      `WITH u AS (UPDATE public.tags SET status = 'approved' WHERE id = '${pendingId}' RETURNING 1) SELECT 'p2-tagger-promoted:' || count(1) FROM u;`,
      `RESET ROLE;`,
      `SELECT 'p2-status:' || status FROM public.tags WHERE id = '${pendingId}';`,
      `SAVEPOINT anon_try;`,
      asRole("anon", null),
      `INSERT INTO public.tags (source_type, source_id, tagger_id, tagged_user_id) VALUES ('post', '${randomUUID()}', '${ids.x}', '${ids.z}');`,
    ].join("\n"));
    // The last statement must be refused, so the script exits non-zero there;
    // everything before it printed.
    assert.notEqual(r.status, 0, "an anonymous insert is refused");
    assert.match(r.stderr, /row-level security|violates row-level security policy/i, r.stderr);
    for (const line of ["p2-third-party-sees:0", "p2-tagged-sees:1", "p2-tagger-promoted:0", "p2-status:pending"]) {
      assert.ok(r.stdout.includes(line), `${line}\n${r.stdout}`);
    }
  });
});
