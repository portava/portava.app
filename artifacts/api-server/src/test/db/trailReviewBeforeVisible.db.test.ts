/**
 * 3977 on a real database (lead ruling D-66; census-discovery §122): a person's
 * new Trail is pending, visible to its creator only, until an admin decides.
 *
 *   D1  trail_propose writes a person's Trail as 'pending' and a system
 *       proposal (no proposer) as 'approved';
 *   D2  a signed-in client who did not create it reads nothing of it; its
 *       creator reads it (the restrictive policy on top of 3390's);
 *   D3  trail_review_decide: a rejection without a reason is refused and
 *       changes nothing; with one it is 'rejected' and keeps the reason; a
 *       decided Trail cannot be decided again;
 *   D4  approval makes it 'approved', activates a 'proposed' lifecycle, and
 *       every client can read it;
 *   D5  no client role can call trail_review_decide.
 *
 * Skips without LOCAL_DB_URL (scripts/local-db/run-tests.sh refuses skipped > 0,
 * so CI's api-server-local-db job runs every case).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { HAVE_DB, asUser, deleteUser, exec, psql, scalar, seedUser } from "./localDb.ts";

const SKIP = HAVE_DB ? false : "LOCAL_DB_URL not set — scripts/local-db/up.sh provides one";

describe("3977: review before a Trail is visible", { skip: SKIP }, () => {
  let creator = "";
  /** A second person who starts Trails: 3975 allows one person three a day, and D1–D3 use `creator`'s three. */
  let creator2 = "";
  let other = "";
  let admin = "";
  const tag = `d66${randomUUID().slice(0, 8)}`;
  const made: string[] = [];

  function propose(title: string, by: string | null): string {
    const out = exec(
      `SET LOCAL ROLE service_role;\nSELECT public.trail_propose('${title}', '${tag}-dest', NULL, NULL, ${by ? `'${by}'` : "NULL"})::text;`,
      { single: true },
    );
    const r = JSON.parse(out.at(-1)!);
    assert.equal(r.outcome, "created", JSON.stringify(r));
    made.push(r.trail.id);
    return r.trail.id as string;
  }
  function decide(id: string, decision: string, reason: string | null): any {
    const out = exec(
      `SET LOCAL ROLE service_role;\nSELECT public.trail_review_decide('${id}', '${admin}', '${decision}', ${reason === null ? "NULL" : `'${reason}'`})::text;`,
      { single: true },
    );
    return JSON.parse(out.at(-1)!);
  }
  const state = (id: string) => scalar(`SELECT review_state || '|' || lifecycle_status || '|' || coalesce(review_reason, '') FROM public.trails WHERE id = '${id}'`);
  const sees = (who: string, id: string) => Number(asUser(who, `SELECT count(*) FROM public.trails WHERE id = '${id}';`).at(-1));

  before(() => {
    creator = seedUser("d66_creator");
    creator2 = seedUser("d66_creator2");
    other = seedUser("d66_other");
    admin = seedUser("d66_admin");
  });
  after(() => {
    if (made.length) exec(`DELETE FROM public.trails WHERE id IN (${made.map((x) => `'${x}'`).join(",")});`);
    for (const u of [creator, creator2, other, admin]) if (u) deleteUser(u);
  });

  it("D1. a person's Trail is pending; a system proposal is approved", () => {
    const mine = propose(`${tag} Azulejo Night Walk`, creator);
    assert.equal(state(mine), "pending|proposed|");
    const sys = propose(`${tag} Harbour Ferry Loop`, null);
    assert.equal(state(sys), "approved|proposed|");
  });

  it("D2. THE POINT: another signed-in client reads nothing of a pending Trail; its creator reads it", () => {
    const id = propose(`${tag} Tram Twenty Eight`, creator);
    assert.equal(sees(other, id), 0, "a pending Trail reached another client");
    assert.equal(sees(creator, id), 1, "the creator cannot read their own pending Trail");
  });

  it("D3. a rejection needs a reason; with one it is kept; a decided Trail is not decided again", () => {
    const id = propose(`${tag} Miradouro Sunset Route`, creator);
    assert.equal(decide(id, "reject", null).outcome, "invalid");
    assert.equal(state(id), "pending|proposed|", "a refused decision changed nothing");
    assert.equal(decide(id, "reject", "Please add places first").outcome, "decided");
    assert.equal(state(id), "rejected|proposed|Please add places first");
    assert.equal(sees(other, id), 0, "a rejected Trail reached another client");
    assert.equal(decide(id, "approve", null).outcome, "not_pending");
  });

  it("D4. approval publishes it and activates the proposed lifecycle", () => {
    const id = propose(`${tag} Pastel Bakery Crawl`, creator2);
    assert.equal(decide(id, "approve", null).outcome, "decided");
    assert.equal(state(id), "approved|active|");
    assert.equal(sees(other, id), 1);
  });

  it("D5. no client role can call trail_review_decide", () => {
    const id = propose(`${tag} Alfama Stairs Climb`, creator2);
    const r = psql(
      [
        `SELECT set_config('request.jwt.claim.sub', '${creator2}', true);`,
        `SET LOCAL ROLE authenticated;`,
        `SELECT public.trail_review_decide('${id}', '${creator2}', 'approve', NULL);`,
      ].join("\n"),
      { single: true },
    );
    assert.notEqual(r.status, 0, "an authenticated client decided a review");
    assert.match(r.stderr, /permission denied/);
    assert.equal(state(id), "pending|proposed|");
  });
});
