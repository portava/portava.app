/**
 * §9.3 proposal governance (census-trips TR88), and the resolution recorded in
 * docs/architecture/blocker-ledger.md under PROPOSAL_DECISION_RULE.
 *
 * The rules below are the ones that would be indefensible to get wrong. The
 * arithmetic — who counts, what a majority is, whether an abstention blocks — is
 * exercised against real rows by db/harness/probe_proposal_governance.sql.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { TRIP_EVENT_TYPES } from "../lib/tripKernel.js";

const gov = readFileSync(new URL("../migrations/2774_trip_proposal_governance.sql", import.meta.url), "utf8");
const kern = readFileSync(new URL("../migrations/2775_trip_kernel_proposal_governance_and_apply.sql", import.meta.url), "utf8");
const ts = readFileSync(new URL("../lib/tripKernel.ts", import.meta.url), "utf8");
const ledger = readFileSync(new URL("../../../../docs/architecture/blocker-ledger.md", import.meta.url), "utf8");

describe("§9.3 — the vocabulary is the spec's", () => {
  it("carries all four decision rules and no others", () => {
    const m = gov.match(/decision_rule IN \(([^)]*)\)/);
    assert.ok(m, "no decision_rule vocabulary");
    const got = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
    assert.deepEqual(got, ["anyone", "host", "majority", "unanimous"]);
  });

  it("carries the three vote values", () => {
    const m = gov.match(/vote IN \(([^)]*)\)/);
    assert.ok(m);
    assert.deepEqual([...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]).sort(),
      ["abstain", "no", "yes"]);
  });

  it("VOTE_ON_PROPOSAL and its event are declared in TypeScript", () => {
    assert.ok(ts.includes('"VOTE_ON_PROPOSAL"'));
    assert.ok((TRIP_EVENT_TYPES as readonly string[]).includes("trip.proposal_voted"));
    for (const r of ["TRIP_PROPOSAL_VOTE_NOT_MET", "TRIP_PROPOSAL_PAYLOAD_INVALID",
                     "TRIP_PROPOSAL_RULE_UNKNOWN"]) {
      assert.ok(ts.includes(`"${r}"`), `${r} is returned by SQL and missing from TripKernelReason`);
    }
  });
});

describe("the default widens nothing", () => {
  it("the column defaults to the NARROWEST rule", () => {
    // A migration that silently widened who may decide would retroactively
    // legitimise decisions the narrower rule refused. The reverse is safe.
    assert.match(gov, /decision_rule text NOT NULL DEFAULT 'host'/);
  });

  it("and refuses to apply if any existing proposal got something else", () => {
    assert.match(gov, /existing proposal\(s\) were given a rule other than host/);
  });

  it("CREATE_PROPOSAL defaults the same way", () => {
    assert.match(kern, /coalesce\(v_payload->>'decision_rule', 'host'\)/);
  });
});

describe("the electorate is the accepted crew, and only them", () => {
  it("excludes 'invited' explicitly", () => {
    // Someone who has not joined cannot be counted as abstaining from a
    // decision nobody told them about.
    assert.match(gov, /role IN \('owner', 'co_host', 'member', 'viewer'\)/);
    assert.ok(!/'invited'/.test(gov.slice(gov.indexOf("trip_proposal_electorate"),
                                          gov.indexOf("COMMENT ON FUNCTION public.trip_proposal_electorate"))),
      "the electorate query mentions 'invited'");
  });

  it("counts only votes from CURRENT crew", () => {
    // Someone who voted and then left has not withdrawn their opinion, but
    // they are no longer part of the group the rule is about.
    assert.match(gov, /v\.user_id IN \(SELECT public\.trip_proposal_electorate\(p\.trip_id\)\)/);
  });

  it("does not assume the proposer voted for their own proposal", () => {
    // §9.3 gives proposing and deciding different verbs. A unanimous rule that
    // counted the author would pass on one real vote out of two.
    const tally = gov.slice(gov.indexOf("CREATE OR REPLACE FUNCTION public.trip_proposal_tally"),
                            gov.indexOf("COMMENT ON FUNCTION public.trip_proposal_tally"));
    assert.ok(!/proposed_by/.test(tally),
      "the tally reads proposed_by; creating a proposal is not voting for it");
  });
});

describe("the arithmetic is the conservative reading", () => {
  it("majority is of the ELECTORATE, not of those who voted", () => {
    // "Half of those who voted" lets two people carry a crew of nine.
    assert.match(gov, /'majority_met', n_yes \* 2 > n_elect/);
  });

  it("unanimity needs everyone to have voted, none against, at least one yes", () => {
    assert.match(gov, /'unanimous_met', n_elect > 0 AND \(n_yes \+ n_abs\) = n_elect AND n_no = 0 AND n_yes > 0/);
  });

  it("an empty electorate cannot be unanimous", () => {
    // n_elect > 0 is the guard. Without it, a trip with no crew would satisfy
    // "everyone agreed" vacuously.
    assert.match(gov, /n_elect > 0 AND/);
  });
});

describe("the vote decides, not whoever closes it", () => {
  it("ACCEPT_PROPOSAL checks the tally under a counted rule", () => {
    assert.match(kern, /IF v_decision_rule IN \('majority', 'unanimous'\) THEN[\s\S]*?TRIP_PROPOSAL_VOTE_NOT_MET/);
  });

  it("2768's unconditional host gating is GONE, not merely supplemented", () => {
    // A surviving unconditional check would silently outrank every other rule.
    assert.match(kern, /ACCEPT_PROPOSAL is still unconditionally host-gated/);
    assert.match(kern, /WHEN 'ACCEPT_PROPOSAL' THEN 'proposal_rule'/);
  });

  it("an unknown rule fails closed", () => {
    assert.match(kern, /'reason', 'TRIP_PROPOSAL_RULE_UNKNOWN'/);
    assert.match(kern, /an unknown decision_rule does not fail closed/);
  });

  it("voting is self-only: no user_id key exists to send", () => {
    // Sliced from the $branches$ block — the code the migration AUTHORS.
    // Outside it, the same command names appear as ANCHORS.
    const authored = kern.match(/\$branches\$([\s\S]*?)\$branches\$/);
    assert.ok(authored, "no authored branch block");
    assert.ok(!/v_payload->>'user_id'/.test(authored[1]));
    assert.match(authored[1], /VALUES \(v_proposal_id, v_actor, v_vote\)/);
  });

  it("a decided proposal takes no further votes", () => {
    const authored = kern.match(/\$branches\$([\s\S]*?)\$branches\$/);
    assert.ok(authored);
    assert.match(authored[1], /TRIP_PROPOSAL_NOT_PENDING/);
  });
});

describe("acceptance APPLIES — the difference between governance and a voting UI", () => {
  it("mutates canonical state in the same transaction", () => {
    assert.match(kern, /INSERT INTO public\.trip_plan_items/);
    assert.match(kern, /SET status = 'cancelled', version = version \+ 1/);
    assert.match(kern, /'effect', 'plan_moved'/);
  });

  it("says so when a proposal type has no canonical effect", () => {
    // Inventing an effect for `other` would be inventing product behaviour out
    // of a vocabulary entry. Saying so keeps "accepted" from reading as "done".
    assert.match(kern, /'status', 'NOT_APPLICABLE',\s*\n?\s*'reason', 'PROPOSAL_TYPE_HAS_NO_CANONICAL_EFFECT'/);
  });

  it("refuses a proposal it cannot carry out, leaving it pending", () => {
    // A decision that never took effect is not a decision.
    assert.match(kern, /'reason', 'TRIP_PROPOSAL_PAYLOAD_INVALID'/);
    const accept = kern.slice(kern.indexOf("Under a counted rule the VOTE decides"));
    const invalidBeforeUpdate =
      accept.indexOf("TRIP_PROPOSAL_PAYLOAD_INVALID") <
      accept.indexOf("UPDATE public.trip_proposals SET status = 'accepted'");
    assert.ok(invalidBeforeUpdate,
      "the status is set to accepted before the payload is validated");
  });

  it("derives visibility from privacy_scope on the applied insert, keeping 2770's tie", () => {
    assert.match(kern, /THEN 'public' ELSE 'members' END\)\n\s*RETURNING id INTO v_item_id/);
  });

  it("does not recurse into trip_kernel_execute", () => {
    // The aggregate is already locked. A recursive call would take it twice.
    const accept = kern.slice(kern.indexOf("Under a counted rule the VOTE decides"),
                              kern.indexOf("$a$);", kern.indexOf("Under a counted rule the VOTE decides")));
    assert.ok(!/trip_kernel_execute\(/.test(accept),
      "acceptance recurses into the kernel and would deadlock on the aggregate lock");
  });
});

describe("the ledger records the resolution rather than the blocker", () => {
  it("PROPOSAL_DECISION_RULE names the split and the superseding migration", () => {
    assert.match(ledger, /PROPOSAL_DECISION_RULE/);
    assert.match(ledger, /Superseded by \*\*`2774`\*\*/,
      "the ledger does not point at the migration that resolves it");
    assert.match(ledger, /`2775`/,
      "the ledger does not name the kernel half of the resolution");
  });
});
