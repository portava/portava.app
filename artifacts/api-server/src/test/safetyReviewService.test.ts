/**
 * safetyReviewService.test.ts
 *
 * Certifies the review station — the authorized principal behind a safety
 * assertion, and the audit trail that makes an activation explainable later.
 *
 * WHY THIS IS A SEPARATE SERVICE FROM approveClaim. IntelCaptureService.
 * approveClaim already promotes candidate -> active under requireAdmin, and it
 * is correct for ordinary intel. It is not sufficient for a safety assertion:
 * it consults no safety policy (it would activate an unsafe_density claim
 * exactly as it activates a queue.wait claim), and its provenance is
 * `promotion_source = 'admin'` — a literal, not an identity. For "how busy is
 * this bar" that is proportionate. For "people here are in danger" it is not.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  reviewSafetyClaim,
  canReviewSafety,
  PERMITTED_TRANSITIONS,
  SAFETY_REVIEW_POLICY_REF,
} from "../services/intel/SafetyReviewService.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = resolve(HERE, "../migrations/2311_intel_claim_reviews.sql");

const PLACE    = "11111111-1111-4111-8111-111111111111";
const CLAIM    = "22222222-2222-4222-8222-222222222222";
const REVIEWER = "33333333-3333-4333-8333-333333333333";

const safetyClaim = (over: Record<string, unknown> = {}) => ({
  id: CLAIM, claim_type: "crowd.level", value: { level: "unsafe_density" },
  status: "candidate", subject_id: PLACE, ...over,
});

/** Fake client with real compare-and-set semantics on intel_claims. */
function makeDb(claim: any | null, opts: { claimReadError?: boolean; auditError?: boolean } = {}) {
  const reviews: any[] = [];
  const client: any = {
    from(table: string) {
      const conds: Record<string, unknown> = {};
      let patch: any = null;
      let inserting: any = null;
      const self: any = {
        select: () => self,
        eq: (c: string, v: unknown) => { conds[c] = v; return self; },
        update: (p: any) => { patch = p; return self; },
        insert: (rows: any) => { inserting = rows; return self; },
        maybeSingle: async () => {
          if (table === "intel_claims") {
            if (opts.claimReadError && !patch) return { data: null, error: { message: "permission denied" } };
            if (patch) {
              // CAS: every condition must match the CURRENT row.
              const matches = claim && Object.entries(conds).every(([k, v]) => (claim as any)[k] === v);
              if (!matches) return { data: null, error: null };
              Object.assign(claim, patch);
              return { data: { id: claim.id, status: claim.status }, error: null };
            }
            const found = claim && conds["id"] === claim.id ? claim : null;
            return { data: found, error: null };
          }
          if (table === "intel_claim_reviews") {
            if (opts.auditError) return { data: null, error: { message: "audit denied" } };
            const row = { id: `rev-${reviews.length + 1}`, ...inserting };
            reviews.push(row);
            return { data: row, error: null };
          }
          return { data: null, error: null };
        },
      };
      return self;
    },
  };
  return { client, reviews };
}

// ── AUTHORIZATION ────────────────────────────────────────────────────────────

describe("safety review — authorization is enforced in the service", () => {
  it("only admin and owner may review", () => {
    assert.equal(canReviewSafety("admin"), true);
    assert.equal(canReviewSafety("owner"), true);
    for (const role of ["user", "", null, undefined, "moderator", "safety_reviewer"]) {
      assert.equal(canReviewSafety(role as any), false,
        `'${role}' must not review safety. v1 reuses the existing admin identity; ` +
        `a role that merely SOUNDS like a reviewer is not one.`);
    }
  });

  it("an ordinary user cannot approve", async () => {
    const { client, reviews } = makeDb(safetyClaim());
    const r = await reviewSafetyClaim(client, {
      claimId: CLAIM, reviewerId: REVIEWER, reviewerRole: "user", action: "approve",
    });
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "not_authorized");
    assert.equal(reviews.length, 0, "an unauthorized attempt writes no audit row");
  });

  it("an ordinary user cannot retract", async () => {
    const { client } = makeDb(safetyClaim({ status: "active" }));
    const r = await reviewSafetyClaim(client, {
      claimId: CLAIM, reviewerId: REVIEWER, reviewerRole: "user", action: "retract",
    });
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "not_authorized");
  });

  it("an authorized role with NO identity is still refused", async () => {
    const { client } = makeDb(safetyClaim());
    const r = await reviewSafetyClaim(client, {
      claimId: CLAIM, reviewerId: "", reviewerRole: "admin", action: "approve",
    });
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "not_authorized",
      "a transition with no attributable principal cannot be audited, so it is not permitted");
  });
});

// ── TRANSITIONS ──────────────────────────────────────────────────────────────

describe("safety review — only explicitly permitted transitions", () => {
  it("approves candidate -> active", async () => {
    const claim = safetyClaim();
    const { client, reviews } = makeDb(claim);
    const r = await reviewSafetyClaim(client, {
      claimId: CLAIM, reviewerId: REVIEWER, reviewerRole: "admin", action: "approve", reason: "verified on site",
    });
    assert.equal(r.ok, true);
    assert.equal(claim.status, "active");
    assert.equal(reviews.length, 1);
  });

  it("REFUSES conflicting -> active: a disputed hazard cannot be force-published", async () => {
    const { client } = makeDb(safetyClaim({ status: "conflicting" }));
    const r = await reviewSafetyClaim(client, {
      claimId: CLAIM, reviewerId: REVIEWER, reviewerRole: "admin", action: "approve",
    });
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "transition_not_permitted");
    assert.equal(
      PERMITTED_TRANSITIONS.approve["conflicting"], undefined,
      "There is deliberately no conflicting -> active entry. Ordinary intel serves a " +
      "conflicting claim at a lowered band; a safety claim in dispute must not be flipped " +
      "to active, which would lose the dispute. Resolving one means SUPERSEDING it with a " +
      "new reviewed claim, leaving both the old assertion and the decision inspectable.",
    );
  });

  it("allows conflicting -> superseded and conflicting -> retracted", () => {
    assert.equal(PERMITTED_TRANSITIONS.supersede["conflicting"], "superseded");
    assert.equal(PERMITTED_TRANSITIONS.retract["conflicting"], "retracted");
  });

  it("refuses approving an already-active claim", async () => {
    const { client } = makeDb(safetyClaim({ status: "active" }));
    const r = await reviewSafetyClaim(client, {
      claimId: CLAIM, reviewerId: REVIEWER, reviewerRole: "admin", action: "approve",
    });
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "transition_not_permitted");
  });

  it("refuses to govern a non-safety claim", async () => {
    const { client } = makeDb(safetyClaim({ claim_type: "queue.wait", value: { minutes: 20 } }));
    const r = await reviewSafetyClaim(client, {
      claimId: CLAIM, reviewerId: REVIEWER, reviewerRole: "admin", action: "approve",
    });
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "not_a_safety_claim",
      "routing an ordinary claim through the safety station would quietly give it " +
      "safety semantics it never earned");
  });
});

// ── POLICY INTEGRATION ───────────────────────────────────────────────────────

describe("safety review — the policy still governs publication", () => {
  it("refuses to activate an assertion with no canonical place", async () => {
    const { client } = makeDb(safetyClaim({ subject_id: null }));
    const r = await reviewSafetyClaim(client, {
      claimId: CLAIM, reviewerId: REVIEWER, reviewerRole: "admin", action: "approve",
    });
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "policy_refused");
    assert.equal((r as any).detail, "no_canonical_place",
      "v1 is place-anchored; review does not let a hazard be coerced onto a venue");
  });

  it("a reviewer's approval carries admin_review authority, never official", async () => {
    // Proven by consequence: the review path activates, and the authenticated-
    // authority lane is closed, so if review were claiming official authority
    // this would have been refused as authority_lane_unavailable.
    const claim = safetyClaim();
    const { client } = makeDb(claim);
    const r = await reviewSafetyClaim(client, {
      claimId: CLAIM, reviewerId: REVIEWER, reviewerRole: "admin", action: "approve",
    });
    assert.equal(r.ok, true, "admin_review is its own authority and is sufficient on its own");
    assert.equal(claim.status, "active");
  });
});

// ── AUDIT / PROVENANCE ───────────────────────────────────────────────────────

describe("safety review — the decision is attributable", () => {
  it("records who, what, the exact transition, the reason and the policy", async () => {
    const { client, reviews } = makeDb(safetyClaim());
    await reviewSafetyClaim(client, {
      claimId: CLAIM, reviewerId: REVIEWER, reviewerRole: "admin",
      action: "approve", reason: "corroborated by venue staff",
    });
    assert.equal(reviews.length, 1);
    const rev = reviews[0];
    assert.equal(rev.reviewer_id, REVIEWER, "WHICH admin, not the literal 'admin'");
    assert.equal(rev.action, "approve");
    assert.equal(rev.prior_status, "candidate");
    assert.equal(rev.new_status, "active");
    assert.equal(rev.reason, "corroborated by venue staff");
    assert.equal(rev.policy_ref, SAFETY_REVIEW_POLICY_REF,
      "so an activation stays explainable even after the policy changes");
  });

  it("cannot fabricate provenance — the reviewer id comes from the caller's resolved identity", async () => {
    const { client, reviews } = makeDb(safetyClaim());
    await reviewSafetyClaim(client, {
      claimId: CLAIM, reviewerId: REVIEWER, reviewerRole: "admin", action: "approve",
    });
    // There is no input by which a caller supplies a source class, an authority
    // tier, or an 'official' label. The only identity written is the reviewer's.
    assert.equal(reviews[0].reviewer_id, REVIEWER);
    assert.ok(!("source_class" in reviews[0]), "review cannot assert a source class");
    assert.ok(!("authority" in reviews[0]), "review cannot assert a stronger authority tier");
  });

  it("a failed audit write is surfaced, not swallowed, and reviewId is null", async () => {
    const claim = safetyClaim();
    const { client } = makeDb(claim, { auditError: true });
    const r = await reviewSafetyClaim(client, {
      claimId: CLAIM, reviewerId: REVIEWER, reviewerRole: "admin", action: "approve",
    });
    assert.equal(r.ok, true, "the transition really did happen; pretending otherwise would be worse");
    assert.equal((r as any).reviewId, null,
      "but the caller must be able to see the trail is incomplete rather than assume it is not");
  });
});

// ── FAILURE SEMANTICS ────────────────────────────────────────────────────────

describe("safety review — a failure is never an absence", () => {
  it("a claim READ failure is db_error, not claim_not_found", async () => {
    const { client } = makeDb(safetyClaim(), { claimReadError: true });
    const r = await reviewSafetyClaim(client, {
      claimId: CLAIM, reviewerId: REVIEWER, reviewerRole: "admin", action: "approve",
    });
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "db_error",
      "permission failure != 'no such claim'. Collapsing those gives a system that " +
      "cannot say whether silence means safety or ignorance.");
  });

  it("a concurrent transition reports conflict, not success", async () => {
    // The claim moves out of 'candidate' between read and write.
    const claim = safetyClaim();
    const { client } = makeDb(claim);
    claim.status = "candidate";
    const original = client.from;
    let firstRead = true;
    client.from = (t: string) => {
      const chain = original.call(client, t);
      if (t === "intel_claims" && firstRead) { firstRead = false; }
      else if (t === "intel_claims") { claim.status = "rejected"; }
      return chain;
    };
    const r = await reviewSafetyClaim(client, {
      claimId: CLAIM, reviewerId: REVIEWER, reviewerRole: "admin", action: "approve",
    });
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "conflict");
  });
});

// ── MIGRATION / RLS CONTRACT ─────────────────────────────────────────────────
//
// Contract assertions over the migration text: this suite has no database, so
// the behavioural weight sits with the migration's own apply-time postconditions
// and the live-DB CI tier. Saying so is part of the guard.

describe("intel_claim_reviews — restricted by construction", () => {
  const sql = () => readFileSync(MIGRATION, "utf8");

  it("enables RLS and grants NOTHING to anon or authenticated", () => {
    const s = sql();
    assert.match(s, /ENABLE ROW LEVEL SECURITY/);
    assert.match(s, /REVOKE ALL ON public\.intel_claim_reviews FROM anon/);
    assert.match(s, /REVOKE ALL ON public\.intel_claim_reviews FROM authenticated/);
    assert.ok(
      !/CREATE POLICY[\s\S]*?TO (anon|authenticated)/.test(s),
      "this table carries reviewer identity and free-text moderation reasons; " +
      "a single anon/authenticated policy would leak both into reach of a projection",
    );
  });

  it("its postconditions refuse the migration if that posture regresses", () => {
    const s = sql();
    assert.match(s, /POSTCONDITION FAILED[\s\S]*RLS is not enabled/);
    assert.match(s, /POSTCONDITION FAILED[\s\S]*anon\/authenticated policy/);
  });

  it("constrains both ends of every transition to the real lifecycle vocabulary", () => {
    const s = sql();
    for (const st of ["candidate", "active", "conflicting", "superseded", "expired", "retracted", "rejected"]) {
      assert.ok(s.includes(`'${st}'`), `lifecycle value '${st}' must be admitted`);
    }
    assert.match(s, /intel_claim_reviews_transition_check/,
      "a review that changes nothing is not a review — reconfirm is the one honest exception");
  });

  it("does not introduce a second status enum", () => {
    const s = sql();
    assert.ok(
      !/CREATE TYPE/.test(s),
      "the claim lifecycle already covers every transition the product needs; a parallel " +
      "vocabulary would let the two drift",
    );
  });
});
