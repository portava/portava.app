/**
 * 2311 / intel_claim_reviews — a safety review EXECUTED on a real database.
 *
 * WHAT THIS SUITE IS FOR. Every other suite in this lane runs the review over a
 * hand-written double, and a double cannot answer the question the audit table
 * exists for: does an actual review produce an actual row that the actual table
 * accepts? A CHECK constraint, a foreign key and an RLS policy are not text to
 * be grepped — they either admit the row the service writes or they do not.
 * Migration 2311 shipped with no writer at all, so until this suite ran, the
 * shape of the row the service builds had never met the table.
 *
 * WHAT IS EXECUTED HERE. `reviewSafetyClaim` itself, unmodified, over a
 * PostgREST-shaped adapter that issues the same statements to `psql` as the
 * service role. The adapter implements only the operators the service uses and
 * THROWS on anything else, so a future call shape cannot slip past unproven.
 * The claim transition, the compare-and-set, the audit insert, the CHECK
 * constraints, both foreign keys and the RLS posture are the database's.
 *
 * WHAT IT DOES NOT CLAIM. Nothing about production's rows: this harness holds
 * no real data, and the review it performs is over a claim this suite seeded
 * and deletes again. It does not exercise the HTTP route (see
 * src/test/adminSafetyReviewRoute.test.ts for the door).
 *
 * Skips without LOCAL_DB_URL exactly as the other db tests do.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { HAVE_DB, exec, jsonLiteral, psql, rows, scalar, seedUser, deleteUser } from "./localDb.ts";
import {
  SAFETY_REVIEW_POLICY_REF,
  reviewSafetyClaim,
  type SafetyReviewResult,
} from "../../services/intel/SafetyReviewService.js";

const SKIP = !HAVE_DB;

function lit(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "object") return jsonLiteral(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

/**
 * The operator subset `reviewSafetyClaim` issues, over psql as service_role.
 *
 * Deliberately tiny and deliberately loud: anything the service might start
 * doing that is not modelled here THROWS, so this suite can never quietly stop
 * covering a statement. `maybeSingle` returns PostgREST's resolved shape —
 * `{ data, error }`, never a throw — because that is what the service handles.
 */
function psqlSupabase(): any {
  return {
    from(table: string) {
      const eqs: Array<[string, unknown]> = [];
      let mode: "select" | "update" | "insert" = "select";
      let patch: Record<string, unknown> = {};
      let row: Record<string, unknown> = {};
      let returning = "*";

      const where = () =>
        eqs.length === 0
          ? ""
          : ` WHERE ${eqs.map(([c, v]) => (v === null ? `${c} IS NULL` : `${c} = ${lit(v)}`)).join(" AND ")}`;

      const self: any = {
        // Both the projection of a SELECT and the RETURNING of a write; the
        // service spells them with the same call, and so does PostgREST.
        select(cols?: string) {
          returning = cols && cols.trim() !== "" ? cols : "*";
          return self;
        },
        eq(col: string, value: unknown) {
          eqs.push([col, value]);
          return self;
        },
        update(p: Record<string, unknown>) {
          mode = "update";
          patch = p;
          return self;
        },
        insert(r: Record<string, unknown>) {
          mode = "insert";
          row = r;
          return self;
        },
        async maybeSingle() {
          let sql: string;
          if (mode === "select") {
            sql = `SELECT ${returning} FROM public.${table}${where()} LIMIT 2`;
          } else if (mode === "update") {
            const set = Object.entries(patch)
              .map(([c, v]) => `${c} = ${lit(v)}`)
              .join(", ");
            sql = `UPDATE public.${table} SET ${set}${where()} RETURNING ${returning}`;
          } else {
            const cols = Object.keys(row);
            sql = `INSERT INTO public.${table} (${cols.join(", ")}) VALUES (${cols
              .map((c) => lit(row[c]))
              .join(", ")}) RETURNING ${returning}`;
          }
          // A data-modifying statement cannot sit in a FROM subquery, so every
          // shape goes through the same CTE and the adapter stays uniform.
          const script =
            `SET LOCAL ROLE service_role;\n` +
            `WITH w AS (${sql}) SELECT COALESCE(json_agg(t), '[]'::json)::text FROM w t;`;
          const r = psql(script, { single: true });
          if (r.status !== 0) {
            // PostgREST resolves on a database error; so does supabase-js. The
            // service is written for that shape, so the adapter must not throw.
            return { data: null, error: { message: r.stderr.trim().split("\n")[0] ?? "error" } };
          }
          const parsed = JSON.parse(r.stdout.trim() || "[]") as Array<Record<string, unknown>>;
          if (parsed.length > 1) {
            return {
              data: null,
              error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" },
            };
          }
          return { data: parsed[0] ?? null, error: null };
        },
        then() {
          throw new Error("psqlSupabase: awaiting the builder is not modelled; the service always ends in maybeSingle()");
        },
      };
      for (const op of ["in", "gt", "gte", "lt", "lte", "not", "order", "limit", "single", "upsert", "delete"]) {
        self[op] = () => {
          throw new Error(`psqlSupabase: '${op}' is not modelled — add it here rather than assuming it works`);
        };
      }
      return self;
    },
  };
}

describe("2311 / intel_claim_reviews — a safety review on a real database", { skip: SKIP }, () => {
  let reviewer = "";
  let stranger = "";
  let placeId = "";
  const claimId = randomUUID();
  const otherClaimId = randomUUID();

  before(() => {
    reviewer = seedUser("safety_reviewer");
    stranger = seedUser("safety_stranger");
    placeId = randomUUID();
    // intel_claims.subject_id is a real FK to places(id) — the spine keys every
    // subject to a canonical place (2130), and safetyPolicy v1 requires one.
    exec(
      `SET LOCAL ROLE service_role;\n` +
        `INSERT INTO public.places (id, name, normalized_name) ` +
        `VALUES ('${placeId}', 'Safety Review Fixture', 'safety review fixture');\n` +
        `INSERT INTO public.intel_claims (id, subject_kind, subject_id, claim_type, value, status, observed_at) ` +
        `VALUES ('${claimId}', 'place', '${placeId}', 'crowd.level', ${jsonLiteral({ level: "unsafe_density" })}, 'candidate', now());\n` +
        `INSERT INTO public.intel_claims (id, subject_kind, subject_id, claim_type, value, status, observed_at) ` +
        `VALUES ('${otherClaimId}', 'place', '${placeId}', 'queue.wait', ${jsonLiteral({ minutes: 20 })}, 'candidate', now());`,
      { single: true },
    );
  });

  after(() => {
    // Cleanup runs as the harness superuser: service_role holds SELECT/INSERT on
    // intel_claim_reviews by design (2311) and no DELETE, which is the posture
    // this suite must not relax in order to tidy up after itself.
    exec(
      `DELETE FROM public.intel_claim_reviews WHERE claim_id IN ('${claimId}', '${otherClaimId}');\n` +
        `DELETE FROM public.intel_claims WHERE id IN ('${claimId}', '${otherClaimId}');\n` +
        `DELETE FROM public.places WHERE id = '${placeId}';`,
      { single: true },
    );
    if (reviewer) deleteUser(reviewer);
    if (stranger) deleteUser(stranger);
  });

  it("2311: the table exists with RLS on and NO anon/authenticated policy", () => {
    assert.equal(scalar(`SELECT to_regclass('public.intel_claim_reviews')::text`), "intel_claim_reviews");
    assert.equal(
      scalar(`SELECT relrowsecurity::text FROM pg_class WHERE oid = 'public.intel_claim_reviews'::regclass`),
      "true",
    );
    assert.equal(
      scalar(
        `SELECT count(*)::text FROM pg_policies WHERE schemaname = 'public' AND tablename = 'intel_claim_reviews' ` +
          `AND ('anon' = ANY(roles) OR 'authenticated' = ANY(roles))`,
      ),
      "0",
      "reviewer identity and free-text moderation reasons must not be reachable by a client role",
    );
  });

  it("AN INELIGIBLE REVIEWER WRITES NOTHING — the service refuses before any statement", async () => {
    const out = await reviewSafetyClaim(psqlSupabase(), {
      claimId,
      reviewerId: stranger,
      reviewerRole: "moderator",
      action: "approve",
    });
    assert.equal(out.ok, false);
    assert.equal((out as { ok: false; reason: string }).reason, "not_authorized");
    assert.equal(
      scalar(`SELECT status FROM public.intel_claims WHERE id = '${claimId}'`),
      "candidate",
      "the claim did not move",
    );
    assert.equal(
      scalar(`SELECT count(*)::text FROM public.intel_claim_reviews WHERE claim_id = '${claimId}'`),
      "0",
      "and no audit row was written",
    );
  });

  it("an authorized role with no attributable principal writes nothing either", async () => {
    const out = await reviewSafetyClaim(psqlSupabase(), {
      claimId,
      reviewerId: "",
      reviewerRole: "admin",
      action: "approve",
    });
    assert.equal(out.ok, false);
    assert.equal((out as { ok: false; reason: string }).reason, "not_authorized");
    assert.equal(scalar(`SELECT status FROM public.intel_claims WHERE id = '${claimId}'`), "candidate");
    assert.equal(
      scalar(`SELECT count(*)::text FROM public.intel_claim_reviews WHERE claim_id = '${claimId}'`),
      "0",
    );
  });

  it("AN ACTUAL REVIEW PRODUCES THE INTENDED AUDIT RECORD", async () => {
    const out: SafetyReviewResult = await reviewSafetyClaim(psqlSupabase(), {
      claimId,
      reviewerId: reviewer,
      reviewerRole: "admin",
      action: "approve",
      reason: "corroborated by venue staff",
    });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal((out as { ok: true; newStatus: string }).newStatus, "active");

    assert.equal(
      scalar(`SELECT status FROM public.intel_claims WHERE id = '${claimId}'`),
      "active",
      "the claim really moved in the database",
    );

    const audit = rows<{
      claim_id: string;
      reviewer_id: string;
      action: string;
      prior_status: string;
      new_status: string;
      reason: string | null;
      policy_ref: string | null;
      id: string;
    }>(`SELECT * FROM public.intel_claim_reviews WHERE claim_id = '${claimId}'`);
    assert.equal(audit.length, 1, "exactly one row, written by the review and by nothing else");
    const rev = audit[0]!;
    assert.equal(rev.claim_id, claimId);
    assert.equal(rev.reviewer_id, reviewer, "WHICH principal, not the literal 'admin'");
    assert.equal(rev.action, "approve");
    assert.equal(rev.prior_status, "candidate");
    assert.equal(rev.new_status, "active");
    assert.equal(rev.reason, "corroborated by venue staff");
    assert.equal(rev.policy_ref, SAFETY_REVIEW_POLICY_REF);
    assert.equal(
      (out as { ok: true; reviewId: string | null }).reviewId,
      rev.id,
      "the caller is handed the id of the record that actually exists",
    );
  });

  it("the second approval of the same claim is refused, and adds no second row", async () => {
    const out = await reviewSafetyClaim(psqlSupabase(), {
      claimId,
      reviewerId: reviewer,
      reviewerRole: "admin",
      action: "approve",
    });
    assert.equal(out.ok, false);
    assert.equal((out as { ok: false; reason: string }).reason, "transition_not_permitted");
    assert.equal(
      scalar(`SELECT count(*)::text FROM public.intel_claim_reviews WHERE claim_id = '${claimId}'`),
      "1",
    );
  });

  it("an ordinary claim is not governed here, and leaves no trace", async () => {
    const out = await reviewSafetyClaim(psqlSupabase(), {
      claimId: otherClaimId,
      reviewerId: reviewer,
      reviewerRole: "admin",
      action: "approve",
    });
    assert.equal(out.ok, false);
    assert.equal((out as { ok: false; reason: string }).reason, "not_a_safety_claim");
    assert.equal(scalar(`SELECT status FROM public.intel_claims WHERE id = '${otherClaimId}'`), "candidate");
    assert.equal(
      scalar(`SELECT count(*)::text FROM public.intel_claim_reviews WHERE claim_id = '${otherClaimId}'`),
      "0",
    );
  });

  it("a retraction is recorded as its own decision over the same claim", async () => {
    const out = await reviewSafetyClaim(psqlSupabase(), {
      claimId,
      reviewerId: reviewer,
      reviewerRole: "owner",
      action: "retract",
      reason: "venue disputed it",
    });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(scalar(`SELECT status FROM public.intel_claims WHERE id = '${claimId}'`), "retracted");
    const trail = rows<{ action: string; prior_status: string; new_status: string }>(
      `SELECT action, prior_status, new_status FROM public.intel_claim_reviews WHERE claim_id = '${claimId}' ORDER BY created_at`,
    );
    assert.equal(trail.length, 2, "the history of decisions accumulates; it does not overwrite");
    assert.deepEqual(trail[1], { action: "retract", prior_status: "active", new_status: "retracted" });
  });

  it("the table itself refuses a review that changes nothing, and an unknown action", () => {
    const noMove = exec(
      `SET LOCAL ROLE service_role;\n` +
        `DO $$ BEGIN\n` +
        `  BEGIN\n` +
        `    INSERT INTO public.intel_claim_reviews (claim_id, reviewer_id, action, prior_status, new_status) ` +
        `    VALUES ('${claimId}', '${reviewer}', 'approve', 'active', 'active');\n` +
        `    RAISE EXCEPTION 'UNEXPECTED: the transition CHECK admitted a no-op approval';\n` +
        `  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'refused';\n` +
        `  END;\n` +
        `  BEGIN\n` +
        `    INSERT INTO public.intel_claim_reviews (claim_id, reviewer_id, action, prior_status, new_status) ` +
        `    VALUES ('${claimId}', '${reviewer}', 'publish', 'candidate', 'active');\n` +
        `    RAISE EXCEPTION 'UNEXPECTED: the action CHECK admitted an action outside the vocabulary';\n` +
        `  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'refused';\n` +
        `  END;\n` +
        `END $$;\n` +
        `SELECT count(*)::text FROM public.intel_claim_reviews WHERE claim_id = '${claimId}';`,
      { single: true },
    );
    assert.equal(noMove.at(-1), "2", "neither refused insert left a row behind");
  });
});
