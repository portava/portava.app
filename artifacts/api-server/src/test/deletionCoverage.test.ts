/**
 * check:deletion-coverage — proves the guard actually bites.
 *
 * The property that matters is not "the manifest parses". It is that a NEW
 * user-keyed table cannot be added without someone stating what happens to it on
 * account deletion — and that the pre-existing backlog is never a hiding place
 * for one.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BASELINE_PATH } from "../scripts/parseBaselineSchema.js";
import {
  userKeyedTablesFromBaseline,
  computeProblems,
  openDecisionProblems,
} from "../scripts/checkDeletionCoverage.js";
import {
  ERASED_BY_CASCADE,
  ANONYMISED_FK_NULLED,
  DELETION_FLOW_TABLES,
  RETAINED_WITH_REASON,
  AWAITING_OWNER_DECISION,
  UNCLASSIFIED_BACKLOG,
  DENOMINATOR_CORRECTION_BACKLOG,
  POST_BASELINE_TABLES,
} from "../lib/deletionDispositions.js";

const BASELINE = readFileSync(BASELINE_PATH, "utf8");

describe("deletion coverage — the manifest matches the baseline", () => {
  it("parses a non-empty set of user-keyed tables", () => {
    const t = userKeyedTablesFromBaseline(BASELINE);
    assert.ok(t.size > 200, `expected the baseline to carry many user-keyed tables, got ${t.size}`);
  });

  it("is currently clean — every baseline table is classified exactly once", () => {
    const problems = computeProblems(userKeyedTablesFromBaseline(BASELINE));
    assert.deepEqual(problems, [], `manifest is out of sync:\n${problems.map((p) => `${p.kind}: ${p.table}`).join("\n")}`);
  });

  it("no table appears in two buckets", () => {
    const seen = new Map<string, string>();
    const add = (name: string, bucket: string) => {
      assert.ok(!seen.has(name), `${name} is in both ${seen.get(name)} and ${bucket}`);
      seen.set(name, bucket);
    };
    for (const t of ERASED_BY_CASCADE) add(t, "ERASED_BY_CASCADE");
    for (const t of ANONYMISED_FK_NULLED) add(t, "ANONYMISED_FK_NULLED");
    for (const t of DELETION_FLOW_TABLES) add(t, "DELETION_FLOW_TABLES");
    for (const r of RETAINED_WITH_REASON) add(r.table, "RETAINED_WITH_REASON");
    for (const r of AWAITING_OWNER_DECISION) add(r.table, "AWAITING_OWNER_DECISION");
    for (const t of UNCLASSIFIED_BACKLOG) add(t, "UNCLASSIFIED_BACKLOG");
    for (const t of DENOMINATOR_CORRECTION_BACKLOG) add(t, "DENOMINATOR_CORRECTION_BACKLOG");
  });
});

describe("deletion coverage — the guard bites", () => {
  it("FAILS when a new user-keyed table is added and left unclassified", () => {
    const withNew = new Map(userKeyedTablesFromBaseline(BASELINE));
    // A name that is deliberately in NO bucket. (intel_observations was used
    // here until IG-02 classified it — which is the guard working, not failing.)
    withNew.set("future_unclassified_table", ["actor_id"]);
    const problems = computeProblems(withNew);
    const hit = problems.find((p) => p.table === "future_unclassified_table");
    assert.ok(hit, "a new user-keyed table passed unclassified — the guard does not bite");
    assert.equal(hit!.kind, "UNCLASSIFIED NEW TABLE");
    assert.match(hit!.detail, /Do NOT add it to UNCLASSIFIED_BACKLOG/,
      "the failure must steer a new table away from the pre-existing-debt list");
  });

  it("FLAGS a stale entry when a listed table leaves the baseline", () => {
    const shrunk = new Map(userKeyedTablesFromBaseline(BASELINE));
    // Must be an entry that IS in the baseline — post-baseline tables are
    // deliberately exempt from the stale check until recapture.
    const victim = ERASED_BY_CASCADE.find((t) => !POST_BASELINE_TABLES.includes(t))!;
    assert.ok(victim, "expected at least one baseline-resident erased table");
    shrunk.delete(victim);
    const problems = computeProblems(shrunk);
    assert.ok(problems.some((p) => p.table === victim && p.kind === "STALE ENTRY"),
      "a manifest entry for a table that no longer exists went unreported");
  });

  it("the backlog is a dated record of debt, not a decision", () => {
    // If this ever reaches zero the program is done with D6; until then the
    // number is the honest measure of how much survives account deletion.
    assert.ok(UNCLASSIFIED_BACKLOG.length > 0);
    // Updated deliberately THREE times, each decision named so a fourth cannot
    // arrive as a silent count bump:
    //   * IG unit I1, migration 2273: the append-only projection history, which
    //     has no actor column — retained because nothing in it is a person's
    //     row, not because a person's row was ruled kept;
    //   * migration 2920's creator_rule_versions: the creator rule catalogue,
    //     seeded before any account exists, with no beneficiary and no actor;
    //   * OD-PAY-8 (C-11 answer B, migration 3600): the four creator /
    //     Rent-a-Buddy ledgers — the FIRST retentions where a person's own rows
    //     are ruled KEPT. They carry a heavier burden of proof, asserted below:
    //     each reason must name the lawful basis AND say the person is removed
    //     from the row the row is kept, AND state the period honestly.
    //   * migration 3931's payment_webhook_events (lane B, 2026-10-05): the
    //     provider webhook dedup log — event id, type, endpoint, timestamps,
    //     outcome; no party, no profile, no payload, no amount.
    //   * the four 3931 payment money tables (2026-10-06, lead ruling matching
    //     lane P's #592): OD-PAY-8 / C-11 answer B decided pseudonymised
    //     retention; the period is the owner's default pending legal confirmation.
    // Any further entry must come with the same kind of written reason.
    assert.equal(RETAINED_WITH_REASON.length, 11,
      "once retentions are decided, update this expectation deliberately");
    assert.deepEqual(
      RETAINED_WITH_REASON.map((r) => r.table).sort(),
      [
        "creator_attributions",
        "creator_earning_entries",
        "creator_ledger_audit_events",
        "creator_rule_versions",
        "intel_state_snapshot_versions",
        "payment_webhook_events",
        "rent_buddy_booking_payments",
        "rent_buddy_earnings_entries",
        "rent_buddy_monthly_payouts",
        "rent_buddy_payment_recipients",
        "rent_buddy_payment_refunds",
      ],
    );
    // Asserted for EVERY entry, not just the first: indexing by [0] let a second
    // entry arrive with no reason at all and still pass.
    for (const r of RETAINED_WITH_REASON) {
      assert.ok(r.reason.length > 40, `${r.table}: a retention needs a reason a user could be shown`);
    }
    const byTable = new Map(RETAINED_WITH_REASON.map((r) => [r.table, r.reason]));
    assert.match(byTable.get("intel_state_snapshot_versions")!, /no actor column/);
    assert.match(byTable.get("creator_rule_versions")!, /No beneficiary, no actor and no personal data/);
    for (const t of LEDGERS) {
      const reason = byTable.get(t);
      assert.ok(reason, `${t}: C-11 was answered "retain, pseudonymised"; the manifest must say so`);
      assert.match(reason!, /GDPR Art\. 17\(3\)\(b\)\/\(e\)/, `${t}: the lawful basis for keeping it must be named`);
      assert.match(reason!, /severed/, `${t}: the reason must say the identity link is removed, not just that rows are kept`);
      assert.match(reason!, /pseudonym/, `${t}: the reason must say what replaces the identity`);
      assert.match(reason!, /migration 3600/, `${t}: the reason must name the migration that implements it`);
      // THE PERIOD IS STATED AS WHAT IT IS: the owner's default, unconfirmed,
      // and not enforced — never as a confirmed statutory period, and never as
      // something already purging rows.
      assert.match(reason!, /seven years after fiscal year-end/, `${t}: state the owner's default period`);
      assert.match(reason!, /jurisdiction-specific legal period/, `${t}: and that a jurisdiction's legal period overrides it`);
      assert.match(reason!, /pending legal confirmation/, `${t}: and that it is not legally confirmed`);
      assert.match(reason!, /no purge enforces it yet, so nothing is erased early/, `${t}: and that nothing deletes early`);
      assert.ok(POST_BASELINE_TABLES.includes(t),
        `${t} is post-baseline, so the coverage gate only governs it through a hand registration`);
    }
    assert.match(byTable.get("payment_webhook_events")!, /No person, no account and no amount/);
  });
});

const LEDGERS = [
  "rent_buddy_earnings_entries",
  "creator_attributions",
  "creator_earning_entries",
  "creator_ledger_audit_events",
] as const;

/** The well-formed open-decision entry the live bucket carried until C-11 was answered, kept as a fixture. */
const C11_AS_IT_WAS_HELD = {
  table: "creator_attributions",
  decision:
    "C-11 / W10D-B0 (question 22(a); census-discovery §107): delete the earning records on erasure, or retain them pseudonymised? Answers held at reconciliation-staging/3511 (A) and 3512 (B).",
  heldOpenBy:
    "migration 3510's row-level BEFORE DELETE refusal (SQLSTATE CL451). Without it 2920's beneficiary_user_id ON DELETE CASCADE would silently delete a creator's whole ledger on erasure — answer A, taken by default rather than chosen.",
};

describe("an open owner decision is recorded, then resolved by its answer (C-11)", () => {
  it("C-11 is ANSWERED: the four ledgers left AWAITING_OWNER_DECISION for RETAINED_WITH_REASON, and nothing erases them", () => {
    // The bucket's own header: "Entries leave this list when the owner answers:
    // the chosen migration is promoted ... and the table moves to
    // ERASED_BY_CASCADE (answer A) or to RETAINED_WITH_REASON (answer B)".
    // OD-PAY-8 is answer B, promoted as 3600 and wired into AccountDeletionService.
    const awaiting = new Set(AWAITING_OWNER_DECISION.map((r) => r.table));
    const erased = new Set(ERASED_BY_CASCADE);
    const retained = new Set(RETAINED_WITH_REASON.map((r) => r.table));
    for (const t of LEDGERS) {
      assert.ok(!awaiting.has(t), `${t} is still AWAITING an owner decision that has been answered`);
      assert.ok(!erased.has(t), `${t} is in ERASED_BY_CASCADE, which is answer A — the owner chose B`);
      assert.ok(retained.has(t), `${t} must be RETAINED_WITH_REASON under answer B`);
    }
    // Stated per table rather than as "the bucket is empty": other tables may
    // await their own named decision here (lane B's 3931 payment tables do, on
    // its branch), and that is not what this test is about.
  });

  it("every entry names the decision, where it is written, and what holds it open", () => {
    // The live bucket is empty since C-11 was answered, so the same assertions
    // run over the entry exactly as it was held, keeping the shape the bucket
    // demands under test rather than vacuous.
    for (const r of [...AWAITING_OWNER_DECISION, C11_AS_IT_WAS_HELD]) {
      assert.match(r.decision, /C-11/, `${r.decision ? r.table : r.table}: the decision must carry its identifier`);
      assert.match(r.decision, /22\(a\)/, `${r.table}: the decision must say where it is written down`);
      assert.match(r.decision, /3511/, `${r.table}: the decision must name the held answer A`);
      assert.match(r.decision, /3512/, `${r.table}: the decision must name the held answer B`);
      // A bucket whose rows are governed only by whatever the cascades already
      // do has recorded nothing: the default IS an answer.
      assert.match(r.heldOpenBy, /3510/, `${r.table}: name the migration that refuses the DELETE meanwhile`);
      assert.match(r.heldOpenBy, /CL451/, `${r.table}: name the SQLSTATE the refusal raises`);
    }
    assert.deepEqual(AWAITING_OWNER_DECISION.filter((x) => !CREATOR_LEDGER_TABLES.includes(x.table)), [],
      "every entry is a creator-ledger table: the 3931 payment tables are RETAINED_WITH_REASON (OD-PAY-8), asserted below");
  });

  it("REJECTS an entry that names no decision, and one that nothing holds open", () => {
    const vague = openDecisionProblems([
      { table: "fx_ledger", decision: "someone should decide", heldOpenBy: "migration 9999 refuses every DELETE with SQLSTATE XX999, by every path" },
    ]);
    assert.deepEqual(vague.map((p) => p.kind), ["UNNAMED DECISION"]);

    const unheld = openDecisionProblems([
      { table: "fx_ledger", decision: "C-11 / W10D-B0 (question 22(a); census §107): delete the earning records on erasure, or retain them pseudonymised?", heldOpenBy: "" },
    ]);
    assert.deepEqual(unheld.map((p) => p.kind), ["NOTHING HOLDS IT OPEN"]);

    // And the well-formed live manifest produces neither, nor does the entry as it was held.
    assert.deepEqual(openDecisionProblems(AWAITING_OWNER_DECISION), []);
    assert.deepEqual(openDecisionProblems([C11_AS_IT_WAS_HELD]), []);
  });

  it("FLAGS a stale entry in the new bucket as it does in every other", () => {
    // AWAITING_OWNER_DECISION must not be the one bucket the staleness check
    // skips — that is how an entry outlives the table it describes.
    // The live bucket is empty (C-11 answered), so the entry as it was held is
    // injected: the property is that THIS bucket is checked for staleness, and
    // an empty live list would make that unobservable.
    const tables = new Map(userKeyedTablesFromBaseline(BASELINE));
    const victim = C11_AS_IT_WAS_HELD.table;
    assert.ok(POST_BASELINE_TABLES.includes(victim),
      `${victim} is post-baseline, so the stale check only reaches it through POST_BASELINE_TABLES`);
    // Drop it from BOTH the denominator and the post-baseline exemption, which is
    // the state a deleted table would really leave behind — it is in the
    // denominator ONLY because POST_BASELINE_TABLES carries it there.
    tables.delete(victim);
    const problems = computeProblems(tables, POST_BASELINE_TABLES.filter((t) => t !== victim), [C11_AS_IT_WAS_HELD]);
    assert.ok(problems.some((p) => p.table === victim && p.kind === "STALE ENTRY"),
      `a stale AWAITING_OWNER_DECISION entry for ${victim} went unreported`);
  });
});

/** The four tables whose C-11 answers are held at reconciliation-staging/3511 and 3512 and whose DELETE 3510 refuses. */
const CREATOR_LEDGER_TABLES: readonly string[] = ["rent_buddy_earnings_entries", "creator_attributions", "creator_earning_entries", "creator_ledger_audit_events"];

// ── The 3931 payment money tables: retained under OD-PAY-8 / C-11 answer B (lead ruling 2026-10-06, matching #592) ──
describe("the four 3931 payment tables are RETAINED_WITH_REASON with the decided basis and the unconfirmed period", () => {
  const PAYMENT_MONEY_TABLES = ["rent_buddy_booking_payments", "rent_buddy_monthly_payouts", "rent_buddy_payment_recipients", "rent_buddy_payment_refunds"];
  it("each is retained, none awaits a decision, none is erased", () => {
    const retained = new Map(RETAINED_WITH_REASON.map((r) => [r.table, r.reason]));
    const awaiting = new Set(AWAITING_OWNER_DECISION.map((r) => r.table));
    const erased = new Set(ERASED_BY_CASCADE);
    for (const t of PAYMENT_MONEY_TABLES) {
      assert.ok(retained.has(t), `${t} retained`);
      assert.ok(!awaiting.has(t), `${t} no longer awaits C-11`);
      assert.ok(!erased.has(t), `${t} is not erased`);
    }
  });
  it("each reason states the ruling, the lawful basis, the pseudonym, the DEFAULT period as unconfirmed, no purge, and the unwired deletion step", () => {
    const retained = new Map(RETAINED_WITH_REASON.map((r) => [r.table, r.reason]));
    for (const t of PAYMENT_MONEY_TABLES) {
      const r = retained.get(t)!;
      assert.match(r, /OD-PAY-8/, `${t}: the owner ruling`);
      assert.match(r, /C-11 answer B/, `${t}: the answer`);
      assert.match(r, /17\(3\)\(b\)/, `${t}: legal obligation`);
      assert.match(r, /17\(3\)\(e\)/, `${t}: legal claims`);
      assert.match(r, /payment party id/, `${t}: named by pseudonym, never profile`);
      assert.match(r, /seven years after fiscal year-end/, `${t}: the owner's default period`);
      assert.match(r, /jurisdiction-specific/, `${t}: overridden by jurisdiction`);
      assert.match(r, /PENDING LEGAL CONFIRMATION/, `${t}: not approved`);
      assert.doesNotMatch(r, /legally confirmed|approved period/i, `${t}: never claims legal approval`);
      assert.match(r, /No purge/, `${t}: nothing erases early`);
      assert.match(r, /NOT DELETE/, `${t}: the grant that refuses DELETE`);
      assert.match(r, /does not call removePaymentIdentity/, `${t}: account deletion does not yet pseudonymise`);
    }
  });
});
