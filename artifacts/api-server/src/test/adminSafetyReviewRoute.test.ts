/**
 * The review station's PRODUCTION DOOR — POST /api/admin/intel/safety-review
 * (routes/adminSafetyCandidates.ts) over the fake PostgREST double the Map
 * gateway suites use.
 *
 * WHY THIS SUITE EXISTS SEPARATELY FROM safetyReviewService.test.ts. That suite
 * certifies the service's own decisions. This one certifies that the decisions
 * are REACHABLE — that a safety transition has an authorized way into
 * production at all, and that the way in cannot supply its own principal.
 * `reviewSafetyClaim` with no caller is a policy nobody can apply, and the
 * audit table with no writer was exactly that; this file is the guard that it
 * stays wired.
 *
 * WHY THIS ROUTE FILE. adminSafetyCandidates.ts's own header describes the
 * chain as "evidence / anomaly -> SAFETY CANDIDATE -> the EXISTING safety
 * review -> the canonical assertion", and owns the first two stages. The review
 * is the next stage over the same subjects, for the same operators, behind the
 * same admin guard. A new admin surface would have been a second door onto the
 * same room.
 *
 * WHAT IS PROVED HERE, AND WHAT IS NOT. The double below implements the writes
 * the service issues; the CHECK constraints, the foreign keys and the RLS
 * posture of `intel_claim_reviews` are NOT modelled by it. Those are proved on
 * a real database by src/test/db/safetyReview.db.test.ts, and by migration
 * 2311's own postconditions. Nothing here should be read as a claim about the
 * table's constraints.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import adminSafetyCandidatesRouter from "../routes/adminSafetyCandidates.js";
import { SAFETY_REVIEW_POLICY_REF, reviewSafetyClaim } from "../services/intel/SafetyReviewService.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { makeFakeMapDb, mountRouterApp, type FakeState, type ProjectionApp } from "./helpers/fakeMapDb.js";

const ADMIN = "77777777-aaaa-4aaa-8aaa-777777777777";
const OWNER = "55555555-aaaa-4aaa-8aaa-555555555555";
const MEMBER = "66666666-aaaa-4aaa-8aaa-666666666666";
const IMPOSTOR = "44444444-aaaa-4aaa-8aaa-444444444444";
const PLACE = "88888888-bbbb-4bbb-8bbb-888888888888";
const CLAIM = "22222222-2222-4222-8222-222222222222";
const TOKEN = "safety-review-token";

function safetyClaim(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CLAIM,
    subject_kind: "place",
    subject_id: PLACE,
    claim_type: "crowd.level",
    value: { level: "unsafe_density" },
    status: "candidate",
    ...over,
  };
}

function world(claim: Record<string, unknown>): FakeState {
  return {
    profiles: [
      { id: ADMIN, role: "admin", handle: "ops" },
      { id: OWNER, role: "owner", handle: "founder" },
      { id: MEMBER, role: "member", handle: "someone" },
      { id: IMPOSTOR, role: "moderator", handle: "nearly" },
    ],
    intel_claims: [claim],
    intel_claim_reviews: [],
  };
}

interface Writes {
  reviews: Array<Record<string, unknown>>;
}

/**
 * fakeMapDb is a READ double — every write verb throws there, deliberately, so
 * a write assertion cannot be made against it by accident. This wrapper gives
 * exactly two tables a write path: the compare-and-set on intel_claims that the
 * service issues, and the audit insert. Reads still go to the double.
 */
function writable(base: any, claim: Record<string, unknown>, writes: Writes): any {
  return {
    ...base,
    auth: base.auth,
    from(table: string) {
      const q = base.from(table);
      if (table === "intel_claims") {
        return {
          ...q,
          update(patch: Record<string, unknown>) {
            const conds: Record<string, unknown> = {};
            const self: any = {
              eq: (c: string, v: unknown) => {
                conds[c] = v;
                return self;
              },
              select: () => self,
              maybeSingle: async () => {
                const matches = Object.entries(conds).every(([k, v]) => claim[k] === v);
                if (!matches) return { data: null, error: null };
                Object.assign(claim, patch);
                return { data: { id: claim["id"], status: claim["status"] }, error: null };
              },
            };
            return self;
          },
        };
      }
      if (table === "intel_claim_reviews") {
        return {
          ...q,
          insert(row: Record<string, unknown>) {
            const self: any = {
              select: () => self,
              maybeSingle: async () => {
                const stored = { id: `rev-${writes.reviews.length + 1}`, ...row };
                writes.reviews.push(stored);
                return { data: { id: stored.id }, error: null };
              },
            };
            return self;
          },
        };
      }
      return q;
    },
  };
}

async function mount(
  claim: Record<string, unknown>,
  userId: string,
  writes: Writes,
): Promise<ProjectionApp> {
  const base = makeFakeMapDb(world(claim), { token: TOKEN, userId });
  const client = writable(base, claim, writes);
  _setTestServiceClient(client);
  return mountRouterApp(adminSafetyCandidatesRouter, client, { token: TOKEN, userId });
}

async function post(app: ProjectionApp, body: unknown, token = TOKEN) {
  const r = await fetch(`${app.baseUrl}/api/admin/intel/safety-review`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as any };
}

let app: ProjectionApp | null = null;
afterEach(async () => {
  if (app) await app.close();
  app = null;
  _setTestServiceClient(null);
});

describe("POST /api/admin/intel/safety-review — the review has a production caller", () => {
  it("an admin's approval moves the claim AND writes the audit row", async () => {
    const claim = safetyClaim();
    const writes: Writes = { reviews: [] };
    app = await mount(claim, ADMIN, writes);
    const r = await post(app, { claimId: CLAIM, action: "approve", reason: "verified on site" });

    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.equal(r.body.priorStatus, "candidate");
    assert.equal(r.body.newStatus, "active");
    assert.equal(claim["status"], "active", "the claim really moved");

    assert.equal(writes.reviews.length, 1, "exactly one audit row per decision");
    const rev = writes.reviews[0]!;
    assert.equal(rev["claim_id"], CLAIM);
    assert.equal(rev["action"], "approve");
    assert.equal(rev["prior_status"], "candidate");
    assert.equal(rev["new_status"], "active");
    assert.equal(rev["reason"], "verified on site");
    assert.equal(rev["policy_ref"], SAFETY_REVIEW_POLICY_REF);
    assert.equal(r.body.reviewId, rev["id"], "the caller is told which record holds the decision");
  });

  it("the reviewer is the AUTHENTICATED admin, never a body field", async () => {
    const claim = safetyClaim();
    const writes: Writes = { reviews: [] };
    app = await mount(claim, ADMIN, writes);
    const r = await post(app, {
      claimId: CLAIM,
      action: "approve",
      reviewerId: IMPOSTOR,
      reviewer_id: IMPOSTOR,
    });

    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(
      writes.reviews[0]!["reviewer_id"],
      ADMIN,
      "a caller that could name the reviewer could forge the whole audit trail",
    );
  });

  it("an owner may review — the door admits exactly the capability the service does", async () => {
    const claim = safetyClaim();
    const writes: Writes = { reviews: [] };
    app = await mount(claim, OWNER, writes);
    const r = await post(app, { claimId: CLAIM, action: "approve" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(writes.reviews[0]!["reviewer_id"], OWNER);
  });
});

describe("POST /api/admin/intel/safety-review — reviewer eligibility", () => {
  it("an ordinary member is refused, and nothing is written", async () => {
    const claim = safetyClaim();
    const writes: Writes = { reviews: [] };
    app = await mount(claim, MEMBER, writes);
    const r = await post(app, { claimId: CLAIM, action: "approve" });

    assert.equal(r.status, 403);
    assert.equal(claim["status"], "candidate", "an unauthorized attempt moves nothing");
    assert.equal(writes.reviews.length, 0, "and records nothing");
  });

  it("a role that merely sounds like a reviewer is refused", async () => {
    const claim = safetyClaim();
    const writes: Writes = { reviews: [] };
    app = await mount(claim, IMPOSTOR, writes);
    const r = await post(app, { claimId: CLAIM, action: "approve" });
    assert.equal(r.status, 403);
    assert.equal(writes.reviews.length, 0);
  });

  it("no session, no review", async () => {
    const claim = safetyClaim();
    const writes: Writes = { reviews: [] };
    app = await mount(claim, ADMIN, writes);
    const r = await post(app, { claimId: CLAIM, action: "approve" }, "not-the-token");
    assert.equal(r.status, 401);
    assert.equal(writes.reviews.length, 0);
  });

  it(
    "ELIGIBILITY IS ENFORCED IN THE SERVICE, not only at the door: the same client, " +
      "reached directly with an ineligible role, still refuses",
    async () => {
      const claim = safetyClaim();
      const writes: Writes = { reviews: [] };
      app = await mount(claim, ADMIN, writes);
      // The exact client the route hands the service, called the way a caller
      // that had passed some OTHER admin gate would call it.
      const out = await reviewSafetyClaim(app.client, {
        claimId: CLAIM,
        reviewerId: MEMBER,
        reviewerRole: "moderator",
        action: "approve",
      });
      assert.equal(out.ok, false);
      assert.equal((out as any).reason, "not_authorized");
      assert.equal(claim["status"], "candidate");
      assert.equal(writes.reviews.length, 0);
    },
  );
});

describe("POST /api/admin/intel/safety-review — refusals stay distinguishable", () => {
  it("a disputed hazard cannot be force-published through the route either", async () => {
    const claim = safetyClaim({ status: "conflicting" });
    const writes: Writes = { reviews: [] };
    app = await mount(claim, ADMIN, writes);
    const r = await post(app, { claimId: CLAIM, action: "approve" });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "invalid_state_transition");
    assert.equal(claim["status"], "conflicting");
    assert.equal(writes.reviews.length, 0);
  });

  it("an ordinary claim is not governed here", async () => {
    const claim = safetyClaim({ claim_type: "queue.wait", value: { minutes: 20 } });
    const writes: Writes = { reviews: [] };
    app = await mount(claim, ADMIN, writes);
    const r = await post(app, { claimId: CLAIM, action: "approve" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_payload");
    assert.equal(writes.reviews.length, 0);
  });

  it("an assertion with no canonical place is refused by the POLICY, distinctly", async () => {
    const claim = safetyClaim({ subject_id: null });
    const writes: Writes = { reviews: [] };
    app = await mount(claim, ADMIN, writes);
    const r = await post(app, { claimId: CLAIM, action: "approve" });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "review_not_eligible");
    assert.match(String(r.body.message), /no_canonical_place/);
    assert.equal(writes.reviews.length, 0);
  });

  it("an unknown claim is not_found, and an unknown action never reaches the service", async () => {
    const claim = safetyClaim();
    const writes: Writes = { reviews: [] };
    app = await mount(claim, ADMIN, writes);

    const missing = await post(app, {
      claimId: "11111111-1111-4111-8111-111111111111",
      action: "approve",
    });
    assert.equal(missing.status, 404);

    const bogus = await post(app, { claimId: CLAIM, action: "publish" });
    assert.equal(bogus.status, 400);
    assert.equal(bogus.body.error, "invalid_payload");
    assert.equal(writes.reviews.length, 0);
  });
});
