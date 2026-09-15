/**
 * Media v2 Phase 10 (Human Network) — Request-a-View, contributor reputation,
 * coverage-gap awareness.
 *
 * Proves, with mutation levers called out inline:
 *   • a view-request creates a targeted coverage task in the EXISTING mission
 *     store (intel_mission_candidates), NON-CASH, trigger 'request_a_view';
 *   • OPT-IN ONLY: a non-opted-in / ineligible / blocked contributor is NEVER
 *     asked (drop the filter ⇒ RED);
 *   • THROTTLE: a per-viewer flood is blocked (drop the throttle ⇒ RED), and a
 *     near-duplicate open request is deduped;
 *   • SAFETY: a request that would pinpoint a restrictive/protected location is
 *     refused, and an undetermined gem lookup is refused (fail-closed);
 *   • REPUTATION is intelligence-trust, NOT social popularity (fold a follower/
 *     stamp term in ⇒ RED);
 *   • empty coverage / no contributors ⇒ graceful, non-erroring.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  selectEligibleRecipients,
  isDuplicateOpenRequest,
  requestSafetyDecision,
  type ContributorOptIn,
} from "../lib/mediaViewRequest.js";
import {
  computeContributorReputation,
  contributorReliability,
  liveAccuracy,
  placeExpertise,
} from "../lib/mediaContributorReputation.js";
import { formatAgo, buildVisualCoverage, readVisualCoverage } from "../lib/mediaVisualFreshness.js";
import { invalidateFreshnessPolicyCache } from "../lib/freshnessPolicy.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import { createViewRequest } from "../services/media/MediaViewRequestService.js";
import { readContributorReputation } from "../services/media/MediaContributorReputationService.js";
import { VIEW_REQUEST_PER_VIEWER_LIMIT } from "../lib/mediaViewRequest.js";

// ── Fake Supabase client (builder-based, covers the shapes this slice uses) ────
function makeDb(cfg: {
  flags?: Record<string, boolean>;
  tables?: Record<string, any[]>;
  errorTables?: string[]; // return { error } on select
  /**
   * Fail READS on these tables only — inserts/upserts still succeed. `errorTables`
   * fails every statement, which cannot express "the dedupe ledger could not be
   * READ but the request could still be recorded" — the exact shape of the
   * swallowed-read defect createViewRequest carried.
   */
  errorReads?: string[];
  throwTables?: string[]; // throw synchronously
}) {
  const inserted: Record<string, any[]> = {};
  const upserted: Record<string, any[]> = {};
  let seq = 0;
  function from(name: string) {
    const st: any = { op: "select", payload: null, filters: {} as Record<string, any>, ors: null, single: false };
    const b: any = {
      select() { if (st.op === "insert") st.op = "insert_select"; return b; },
      insert(rows: any) { st.op = "insert"; st.payload = rows; return b; },
      upsert(rows: any) { st.op = "upsert"; st.payload = rows; return b; },
      eq(k: string, v: any) { st.filters[k] = v; return b; },
      in(k: string, v: any) { st.filters["in:" + k] = v; return b; },
      or(expr: string) { st.ors = expr; return b; },
      order() { return b; },
      limit() { return b; },
      maybeSingle() { st.single = true; return Promise.resolve(run()); },
      single() { st.single = true; return Promise.resolve(run()); },
      then(res: (r: any) => any) { return Promise.resolve(run()).then(res); },
    };
    function run() {
      if (name === "feature_flags") {
        const flag = st.filters["flag"];
        return { data: { enabled: Boolean(cfg.flags?.[flag]) }, error: null };
      }
      if (cfg.throwTables?.includes(name)) throw new Error("boom");
      if (cfg.errorTables?.includes(name)) return { data: null, error: { message: "boom" } };
      if (st.op === "insert" || st.op === "insert_select") {
        const rows = (Array.isArray(st.payload) ? st.payload : [st.payload]).map((r: any) => ({ id: `row-${++seq}`, ...r }));
        (inserted[name] ??= []).push(...rows);
        if (st.op === "insert_select") return { data: st.single ? rows[0] : rows, error: null };
        return { data: null, error: null };
      }
      if (st.op === "upsert") {
        const rows = Array.isArray(st.payload) ? st.payload : [st.payload];
        (upserted[name] ??= []).push(...rows);
        return { data: null, error: null };
      }
      if (cfg.errorReads?.includes(name)) {
        return { data: null, error: { message: "server closed the connection unexpectedly", code: "08006" } };
      }
      let rows = (cfg.tables?.[name] ?? []).slice();
      for (const [k, v] of Object.entries(st.filters)) {
        if (k === "flag") continue;
        if (k.startsWith("in:")) { const c = k.slice(3); rows = rows.filter((r: any) => (v as any[]).includes(r[c])); }
        else rows = rows.filter((r: any) => r[k] === v);
      }
      if (st.ors) {
        const clauses = String(st.ors).split(",").map((c) => {
          const m = c.match(/^(\w+)\.eq\.(.+)$/);
          return m ? { col: m[1], val: m[2] } : null;
        }).filter(Boolean) as { col: string; val: string }[];
        rows = rows.filter((r: any) => clauses.some((cl) => String(r[cl.col]) === cl.val));
      }
      if (st.single) return { data: rows[0] ?? null, error: null };
      return { data: rows, error: null };
    }
    return b;
  }
  return { from, _inserted: inserted, _upserted: upserted } as any;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. OPT-IN-ONLY recipient selection (pure — the primary opt-in mutation-proof)
// ═══════════════════════════════════════════════════════════════════════════
describe("selectEligibleRecipients — opt-in-only, fail-closed", () => {
  const candidates: ContributorOptIn[] = [
    { contributorId: "opted_eligible", optedIn: true, eligible: true },
    { contributorId: "not_opted_in", optedIn: false, eligible: true },
    { contributorId: "ineligible", optedIn: true, eligible: false },
    { contributorId: "blocked_one", optedIn: true, eligible: true },
    { contributorId: "the_requester", optedIn: true, eligible: true },
  ];

  it("asks ONLY the opted-in + eligible + un-blocked contributor", () => {
    const out = selectEligibleRecipients({
      candidates,
      requesterId: "the_requester",
      blocked: new Set(["blocked_one"]),
    });
    // MUTATION LEVER: drop the `optedIn !== true` / `eligible !== true` guards in
    // selectEligibleRecipients and these three assertions go RED — a non-opted-in
    // or ineligible contributor would appear in the ask set.
    assert.deepEqual(out, ["opted_eligible"]);
    assert.ok(!out.includes("not_opted_in"), "a contributor who did NOT opt in is never asked");
    assert.ok(!out.includes("ineligible"), "an ineligible contributor is never asked");
    assert.ok(!out.includes("blocked_one"), "a blocked contributor is never asked");
    assert.ok(!out.includes("the_requester"), "the requester is never asked to fulfil their own request");
  });

  it("asks NOBODY when block state is unreadable (fail-closed)", () => {
    const out = selectEligibleRecipients({ candidates, requesterId: "the_requester", blocked: null });
    assert.deepEqual(out, [], "null block set ⇒ ask no one, never everyone");
  });

  it("is empty when there are no contributors at all (graceful pre-launch)", () => {
    assert.deepEqual(selectEligibleRecipients({ candidates: [], requesterId: "v", blocked: new Set() }), []);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Dedupe + safety (pure)
// ═══════════════════════════════════════════════════════════════════════════
describe("isDuplicateOpenRequest — near-duplicate open requests", () => {
  const open = [{ subjectId: "p1", claimFamily: "crowd.level", status: "open" }];
  it("flags a second OPEN request for the same place + family", () => {
    assert.equal(isDuplicateOpenRequest(open, { subjectId: "p1", claimFamily: "Crowd.Level" }), true);
  });
  it("does not flag a different family, place, or a closed request", () => {
    assert.equal(isDuplicateOpenRequest(open, { subjectId: "p1", claimFamily: "queue.length" }), false);
    assert.equal(isDuplicateOpenRequest(open, { subjectId: "p2", claimFamily: "crowd.level" }), false);
    const fulfilled = [{ subjectId: "p1", claimFamily: "crowd.level", status: "fulfilled" }];
    assert.equal(isDuplicateOpenRequest(fulfilled, { subjectId: "p1", claimFamily: "crowd.level" }), false);
  });
});

describe("requestSafetyDecision — refuse protected / undetermined", () => {
  it("is safe only when the gem check ran AND found no restrictive gem", () => {
    assert.deepEqual(requestSafetyDecision({ gemCeiling: null, gemDetermined: true }), { safe: true, reason: "ok" });
  });
  it("refuses when a restrictive gem constrains the place", () => {
    assert.equal(requestSafetyDecision({ gemCeiling: "city", gemDetermined: true }).safe, false);
  });
  it("refuses (fail-closed) when the gem check could not be determined", () => {
    assert.equal(requestSafetyDecision({ gemCeiling: null, gemDetermined: false }).safe, false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Contributor reputation is INTELLIGENCE-TRUST, not social popularity
// ═══════════════════════════════════════════════════════════════════════════
describe("computeContributorReputation — intel-trust, not popularity", () => {
  it("reliability is EXACTLY accepted/total (no social term)", () => {
    // MUTATION LEVER: fold a follower/stamp term into contributorReliability
    // (e.g. (accepted + stamps)/total) and this exact equality goes RED.
    assert.equal(contributorReliability(3, 4), 0.75);
    assert.equal(contributorReliability(0, 0), 0, "no observations ⇒ 0, never a popularity fallback");
  });

  it("ignores social fields entirely — popularity cannot move the score", () => {
    const intelOnly = {
      acceptedObservations: 3,
      totalObservations: 4,
      placeAcceptedObservations: 2,
      corroboratedObservations: 1,
      corroborationOpportunities: 2,
    };
    const withPopularityLeak = {
      ...intelOnly,
      // These are the social-popularity signals §25 forbids from trust. The
      // function has no parameter for them; if a mutation made it read one of
      // these, the deepEqual below breaks.
      followerCount: 1_000_000,
      stampCount: 5000,
      likes: 99999,
    } as any;
    assert.deepEqual(
      computeContributorReputation(withPopularityLeak),
      computeContributorReputation(intelOnly),
      "a contributor's audience/stamps must NOT change intelligence trust",
    );
    assert.equal(computeContributorReputation(intelOnly).basis, "intelligence_trust");
  });

  it("live accuracy = corroborated/opportunities; place expertise saturates", () => {
    assert.equal(liveAccuracy(1, 2), 0.5);
    assert.equal(liveAccuracy(0, 0), 0, "no corroboration opportunities ⇒ unproven, not trusted");
    assert.equal(placeExpertise(0), 0);
    assert.equal(placeExpertise(8), 1);
    assert.ok(placeExpertise(1) > 0 && placeExpertise(1) < 1, "one accepted observation is thin, not full, expertise");
  });

  it("empty signals ⇒ isEmpty, all zero (graceful pre-launch)", () => {
    const rep = computeContributorReputation({
      acceptedObservations: 0, totalObservations: 0, corroboratedObservations: 0, corroborationOpportunities: 0,
    });
    assert.equal(rep.isEmpty, true);
    assert.equal(rep.contributorReliability, 0);
    assert.equal(rep.placeExpertise, 0);
    assert.equal(rep.liveAccuracy, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Visual freshness / coverage-gap awareness (pure + gated read)
// ═══════════════════════════════════════════════════════════════════════════
describe("formatAgo / buildVisualCoverage", () => {
  it('formats "Nm ago" / "Nh ago" and null for no observation', () => {
    assert.equal(formatAgo(28 * 60_000), "28m ago");
    assert.equal(formatAgo(3 * 3_600_000), "3h ago");
    assert.equal(formatAgo(null), null);
  });
  it("no observation ⇒ noCoverage + stale, no fabricated label", () => {
    const c = buildVisualCoverage({ lastObservedAt: null, stale: false, nowMs: Date.now() });
    assert.equal(c.noCoverage, true);
    assert.equal(c.stale, true, "no observation is treated as a gap, never as fresh");
    assert.equal(c.lastUpdateLabel, null);
  });
});

describe("readVisualCoverage — staleness via the GATED freshness policy", () => {
  beforeEach(() => invalidateFreshnessPolicyCache());

  it("a recent visual observation is fresh with an 'Nm ago' label", async () => {
    const now = new Date("2026-08-31T20:00:00.000Z").getTime();
    const db = makeDb({
      tables: {
        freshness_policies: [{ claim_type: "crowd", ttl_seconds: 900, note: null }],
        intel_observations: [
          { subject_id: "p1", claim_type: "crowd", capture_surface: "moment", observed_at: new Date(now - 5 * 60_000).toISOString() },
        ],
      },
    });
    const c = await readVisualCoverage(db, { subjectId: "p1", claimFamily: "crowd", nowMs: now });
    assert.equal(c.noCoverage, false);
    assert.equal(c.stale, false, "5 min < 15 min TTL ⇒ not stale");
    assert.equal(c.lastUpdateLabel, "5m ago");
  });

  it("a place with no visual observation is a graceful coverage void", async () => {
    const db = makeDb({ tables: {} });
    const c = await readVisualCoverage(db, { subjectId: "p1", claimFamily: "crowd" });
    assert.equal(c.noCoverage, true);
    assert.equal(c.stale, true);
    assert.equal(c.lastObservedAt, null);
  });

  it("an unknown claim family (no policy) ⇒ stale, fail-closed (never live)", async () => {
    const now = Date.now();
    const db = makeDb({
      tables: {
        freshness_policies: [{ claim_type: "crowd", ttl_seconds: 900, note: null }],
        intel_observations: [{ subject_id: "p1", claim_type: "mystery", capture_surface: "moment", observed_at: new Date(now - 60_000).toISOString() }],
      },
    });
    const c = await readVisualCoverage(db, { subjectId: "p1", claimFamily: "mystery", nowMs: now });
    assert.equal(c.stale, true, "no freshness policy ⇒ never presented as live");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. createViewRequest service — the four controls + reuse of the mission store
// ═══════════════════════════════════════════════════════════════════════════
const ON = { flags: { media_request_a_view_enabled: true } };

const baseInput = () => ({
  requesterId: "viewer1",
  subjectId: "place1",
  claimFamily: "crowd.level",
  question: "Is the entrance still busy?",
  city: "Da Nang",
});

describe("createViewRequest — creates a targeted coverage task in the EXISTING mission store", () => {
  beforeEach(() => _resetRateLimit());

  it("inserts a NON-CASH intel_mission_candidates row + a ledger row", async () => {
    const db = makeDb({
      ...ON,
      tables: {
        media_view_request_optins: [
          { contributor_id: "c1", opted_in: true, eligible: true, city: "Da Nang" },
          { contributor_id: "c2", opted_in: true, eligible: true, city: "Da Nang" },
        ],
        blocks: [],
      },
    });
    const out = await createViewRequest(db, baseInput());
    assert.equal(out.ok, true);

    const candidates = db._inserted.intel_mission_candidates ?? [];
    assert.equal(candidates.length, 1, "exactly one coverage task created in the EXISTING store");
    const cand = candidates[0];
    assert.equal(cand.trigger, "request_a_view");
    assert.equal(cand.cash_amount, 0, "reused buildMissionCandidate keeps the NON-CASH invariant");
    assert.equal(cand.budget_committed, false);
    assert.equal(cand.status, "candidate");
    assert.equal(cand.subject_id, "place1");

    const ledger = db._inserted.media_view_requests ?? [];
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].mission_candidate_id, cand.id, "ledger references the mission candidate it created");
    assert.equal(ledger[0].recipient_count, 2, "both opted-in eligible contributors are recipients");
    assert.equal(out.recipientCount, 2);
  });

  it("OPT-IN ONLY end-to-end: a blocked eligible contributor is excluded from recipients", async () => {
    const db = makeDb({
      ...ON,
      tables: {
        media_view_request_optins: [
          { contributor_id: "c1", opted_in: true, eligible: true, city: "Da Nang" },
          { contributor_id: "cBlocked", opted_in: true, eligible: true, city: "Da Nang" },
        ],
        blocks: [{ blocker_id: "viewer1", blocked_id: "cBlocked" }],
      },
    });
    const out = await createViewRequest(db, baseInput());
    assert.equal(out.ok, true);
    assert.deepEqual(out.recipients, ["c1"], "the blocked contributor is never asked");
    assert.equal(out.recipientCount, 1);
  });
});

describe("createViewRequest — throttle + anti-spam", () => {
  beforeEach(() => _resetRateLimit());

  it("blocks a per-viewer FLOOD once the window limit is exceeded", async () => {
    const db = makeDb({ ...ON, tables: { media_view_request_optins: [], blocks: [] } });
    // Distinct places so neither the per-place limit nor dedupe fire first — this
    // isolates the PER-VIEWER throttle.
    let lastReason: string | undefined;
    for (let i = 0; i < VIEW_REQUEST_PER_VIEWER_LIMIT; i++) {
      const r = await createViewRequest(db, { ...baseInput(), subjectId: `place_${i}` });
      assert.equal(r.ok, true, `request ${i} within the limit is allowed`);
    }
    const flooded = await createViewRequest(db, { ...baseInput(), subjectId: "place_flood" });
    lastReason = flooded.reason;
    // MUTATION LEVER: remove the `if (!viewerGate.allowed) return rate_limited`
    // guard in createViewRequest and this assertion goes RED — the flood succeeds.
    assert.equal(flooded.ok, false);
    assert.equal(lastReason, "rate_limited");
  });

  it("dedupes a near-duplicate OPEN request for the same place + family", async () => {
    const db = makeDb({
      ...ON,
      tables: {
        media_view_request_optins: [],
        blocks: [],
        // an already-open request for the same (place, family)
        media_view_requests: [{ subject_id: "place1", claim_family: "crowd.level", status: "open" }],
      },
    });
    const out = await createViewRequest(db, baseInput());
    assert.equal(out.ok, false);
    assert.equal(out.reason, "duplicate");
    assert.equal((db._inserted.intel_mission_candidates ?? []).length, 0, "no coverage task created for a duplicate");
  });
});

describe("createViewRequest — safety (protected / undetermined locations)", () => {
  beforeEach(() => _resetRateLimit());

  it("refuses a request that would pinpoint a restrictive Hidden Gem", async () => {
    const db = makeDb({
      ...ON,
      tables: {
        media_view_request_optins: [{ contributor_id: "c1", opted_in: true, eligible: true, city: "Da Nang" }],
        blocks: [],
        hidden_gems: [
          { canonical_place_id: "place1", sensitivity_level: "protected", status: "active", latitude: null, longitude: null, approx_latitude: null, approx_longitude: null, city: "Da Nang" },
        ],
      },
    });
    const out = await createViewRequest(db, baseInput());
    assert.equal(out.ok, false);
    assert.equal(out.reason, "protected_location");
    assert.equal((db._inserted.intel_mission_candidates ?? []).length, 0, "no coverage task created for a protected place");
  });

  it("refuses (fail-closed) when the gem cross-check cannot be determined", async () => {
    const db = makeDb({ ...ON, tables: { media_view_request_optins: [], blocks: [] }, throwTables: ["hidden_gems"] });
    const out = await createViewRequest(db, baseInput());
    assert.equal(out.ok, false);
    assert.equal(out.reason, "safety_undetermined", "an unreadable gem check refuses, never guesses");
  });
});

describe("createViewRequest — gating + graceful empty", () => {
  beforeEach(() => _resetRateLimit());

  it("refuses when the feature flag is OFF (fail-closed)", async () => {
    const db = makeDb({ flags: { media_request_a_view_enabled: false }, tables: {} });
    const out = await createViewRequest(db, baseInput());
    assert.equal(out.ok, false);
    assert.equal(out.reason, "disabled");
  });

  it("no eligible contributors ⇒ the request is still recorded, recipientCount 0 (graceful)", async () => {
    const db = makeDb({ ...ON, tables: { media_view_request_optins: [], blocks: [] } });
    const out = await createViewRequest(db, baseInput());
    assert.equal(out.ok, true, "pre-launch empty is normal, not an error");
    assert.equal(out.recipientCount, 0);
    assert.equal((db._inserted.intel_mission_candidates ?? []).length, 1, "the coverage task is still created");
  });
});

describe("createViewRequest — a read that did not run is not one of the four controls passing", () => {
  beforeEach(() => _resetRateLimit());

  /**
   * THE DEDUPE GATE WAS THE ONE THAT FAILED OPEN.
   *
   * `lib/mediaViewRequest`'s header states the contract for all four controls:
   * "a missing/ambiguous input excludes a contributor or refuses a request,
   * never the reverse". `readOpenRequests` returned `[]` on a failed read, and
   * `isDuplicateOpenRequest([])` is `false` — so an unreadable
   * `media_view_requests` was spent as "this is NOT a duplicate" and the request
   * was created. That is the reverse: the only control of the four whose read
   * failure opened it. The inventory's "not one is a fail-OPEN" does not hold
   * here, because the restrictive answer for a DEDUPE gate is the non-empty one.
   */
  it("refuses when the dedupe ledger cannot be READ (the gate must not pass on a failed read)", async () => {
    const db = makeDb({
      ...ON,
      tables: { media_view_requests: [], media_view_request_optins: [], blocks: [] },
      errorReads: ["media_view_requests"],
    });

    const out = await createViewRequest(db, baseInput());

    assert.equal(out.ok, false, "an unreadable dedupe ledger must not read as 'not a duplicate'");
    assert.equal(out.reason, "db_error");
    assert.equal(
      (db._inserted.intel_mission_candidates ?? []).length, 0,
      "and nothing is written: the coverage task the gate might have refused is not created",
    );
  });

  it("a ledger that READS as empty is still a real 'not a duplicate' — the request proceeds", async () => {
    const db = makeDb({
      ...ON,
      tables: { media_view_requests: [], media_view_request_optins: [], blocks: [] },
    });

    const out = await createViewRequest(db, baseInput());

    assert.equal(out.ok, true, "an empty ledger that was actually read is a genuine answer");
    assert.equal((db._inserted.intel_mission_candidates ?? []).length, 1);
  });

  /**
   * The opt-in registry is the OTHER direction. `[]` there is already the
   * fail-closed answer — ask nobody — and it is also the normal pre-launch
   * answer, so refusing the whole request over it would throw away a coverage
   * task for no safety gain. What must not happen is the RESULT claiming the
   * graceful outcome: `recipientCount: 0` with nothing to say it was not
   * measured. `recipientsDetermined` is that discriminator.
   */
  it("an unreadable opt-in registry still asks nobody, but says the count was not measured", async () => {
    const db = makeDb({
      ...ON,
      tables: { media_view_requests: [], media_view_request_optins: [], blocks: [] },
      errorReads: ["media_view_request_optins"],
    });

    const out = await createViewRequest(db, baseInput());

    assert.equal(out.ok, true, "the coverage task is still worth creating");
    assert.equal(out.recipientCount, 0, "fail-closed direction is unchanged: nobody is asked");
    assert.equal(
      out.recipientsDetermined, false,
      "'0 people asked' must not read as '0 people were eligible' when the registry was unreadable",
    );
  });

  it("a genuinely empty registry reports the SAME zero with recipientsDetermined true", async () => {
    const db = makeDb({ ...ON, tables: { media_view_requests: [], media_view_request_optins: [], blocks: [] } });

    const out = await createViewRequest(db, baseInput());

    assert.equal(out.ok, true);
    assert.equal(out.recipientCount, 0);
    assert.equal(out.recipientsDetermined, true, "pre-launch empty is a measured zero");
  });

  it("the two zeroes are not the same value", async () => {
    const failed = await createViewRequest(
      makeDb({ ...ON, tables: { media_view_requests: [], media_view_request_optins: [], blocks: [] }, errorReads: ["media_view_request_optins"] }),
      baseInput(),
    );
    const genuine = await createViewRequest(
      makeDb({ ...ON, tables: { media_view_requests: [], media_view_request_optins: [], blocks: [] } }),
      baseInput(),
    );

    assert.notEqual(
      failed.recipientsDetermined, genuine.recipientsDetermined,
      "the read failed and there genuinely are none must be distinguishable by the caller",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. readContributorReputation service — derived from intel tables, not social
// ═══════════════════════════════════════════════════════════════════════════
describe("readContributorReputation — intel-derived, never reads social tables", () => {
  it("reflects accepted/total observations and independent corroboration", async () => {
    const db = makeDb({
      tables: {
        intel_observations: [
          { actor_id: "c1", subject_id: "place1", claim_type: "crowd", moderation_state: "allowed" },
          { actor_id: "c1", subject_id: "place1", claim_type: "vibe", moderation_state: "allowed" },
          { actor_id: "c1", subject_id: "place2", claim_type: "crowd", moderation_state: "pending" },
        ],
        intel_state_snapshots: [
          { subject_id: "place1", claim_type: "crowd", distinct_actors: 3, privacy_eligible: true }, // corroborated cell
          { subject_id: "place1", claim_type: "vibe", distinct_actors: 1, privacy_eligible: true },  // opportunity, not corroborated
        ],
        // A huge social presence that the service MUST NOT read:
        passport_stamps: Array.from({ length: 500 }, (_, i) => ({ user_id: "c1", id: i })),
      },
    });
    const rep = await readContributorReputation(db, { contributorId: "c1", subjectId: "place1" });
    // 2 accepted of 3 total ⇒ exactly 2/3. If the service folded the 500 stamps
    // into trust, this exact value would change ⇒ RED.
    assert.equal(rep.contributorReliability, 2 / 3);
    assert.equal(rep.placeExpertise, placeExpertise(2), "2 accepted observations at place1");
    assert.equal(rep.liveAccuracy, 0.5, "1 corroborated of 2 served-snapshot opportunities");
    assert.equal(rep.basis, "intelligence_trust");
  });

  it("empty intel ⇒ graceful empty reputation", async () => {
    const db = makeDb({ tables: {} });
    const rep = await readContributorReputation(db, { contributorId: "nobody" });
    assert.equal(rep.isEmpty, true);
    assert.equal(rep.contributorReliability, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. THE LAST MILE — POST /v1/media/view-requests puts the discriminator on the wire
// ═══════════════════════════════════════════════════════════════════════════
//
// §5 above proves the SERVICE can tell "nobody was eligible" from "the opt-in
// registry could not be read". That is only half a fix while the route drops the
// flag: this handler enumerates its response fields (it does not spread the
// service result the way routes/mediaActions.ts does for `planGateDetermined`),
// so the two zeroes arrived at the client as the same body — and the client
// renders a bare zero as the positive claim "No contributors are nearby yet".
//
// MUTATION: delete `recipientsDetermined` from the 201 body in
// routes/mediaViewRequest.ts — the three tests below go RED.
//
// MUTATION THAT SURVIVES, recorded rather than hidden: swapping `=== true` for
// `!== false` changes nothing, because the service's ok:true path always sets a
// real boolean and `undefined` is unreachable from here. The stricter spelling
// is a deliberate defensive choice with no test behind it, and saying so is
// worth more than a test that cannot fail.
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import mediaViewRequestRouter from "../routes/mediaViewRequest.js";

const ROUTE_USER = "11111111-1111-4111-8111-111111111111";
const ROUTE_PLACE = "22222222-2222-4222-8222-222222222222";

/** makeDb + the `auth.getUser` seam requireUser needs. */
function routeClient(db: any) {
  return {
    from: db.from,
    _inserted: db._inserted,
    auth: { getUser: async () => ({ data: { user: { id: ROUTE_USER } }, error: null }) },
  };
}

async function postViewRequest(db: any): Promise<{ status: number; body: any }> {
  _resetRateLimit();
  _setTestClient(routeClient(db), true);
  const app = express();
  app.use(express.json());
  app.use(mediaViewRequestRouter);
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/media/view-requests`, {
      method: "POST",
      headers: { Authorization: "Bearer test.token", "Content-Type": "application/json" },
      body: JSON.stringify({
        subjectId: ROUTE_PLACE,
        claimFamily: "crowd.level",
        question: "Is the entrance still busy?",
        city: "Da Nang",
      }),
    });
    return { status: res.status, body: await res.json() };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    _setTestClient(null, false);
  }
}

const emptyRegistry = () => ({
  ...ON,
  tables: {
    media_view_requests: [],
    media_view_request_optins: [],
    blocks: [],
    profiles: [],
    hidden_gems: [],
  },
});

describe("POST /v1/media/view-requests — the recipient count's provenance reaches the client", () => {
  it("a genuinely empty contributor registry serves recipientsDetermined true", async () => {
    const { status, body } = await postViewRequest(makeDb(emptyRegistry()));
    assert.equal(status, 201);
    assert.equal(body.recipientCount, 0);
    assert.equal(body.recipientsDetermined, true, "a measured zero is a real answer");
  });

  it("an unreadable contributor registry serves the SAME zero with recipientsDetermined false", async () => {
    const { status, body } = await postViewRequest(
      makeDb({ ...emptyRegistry(), errorReads: ["media_view_request_optins"] }),
    );
    assert.equal(status, 201, "the coverage task is still created — nothing failed for the traveller");
    assert.equal(body.recipientCount, 0, "fail-closed direction unchanged: nobody was asked");
    assert.equal(
      body.recipientsDetermined, false,
      "a zero that was never counted must not be served as a zero that was",
    );
  });

  it("the two bodies are not byte-identical — which is the whole point", async () => {
    const measured = await postViewRequest(makeDb(emptyRegistry()));
    const unread = await postViewRequest(
      makeDb({ ...emptyRegistry(), errorReads: ["media_view_request_optins"] }),
    );
    assert.equal(measured.body.recipientCount, unread.body.recipientCount, "same count …");
    assert.notEqual(
      measured.body.recipientsDetermined, unread.body.recipientsDetermined,
      "… and the client can still tell the two apart",
    );
  });

  it("recipient ids are never on the wire (a view request must not reveal who was asked)", async () => {
    const { body } = await postViewRequest(makeDb(emptyRegistry()));
    assert.equal("recipients" in body, false);
  });
});
