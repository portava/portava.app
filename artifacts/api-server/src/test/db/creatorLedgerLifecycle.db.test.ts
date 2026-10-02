/**
 * The creator ledger, END TO END on PostgreSQL 16 — census-discovery §52.
 *
 * Runs the REAL service functions (CreatorAttributionService,
 * CreatorLedgerOperations, CreatorLedgerReader, CreatorAttributionProducers,
 * CanonicalShareReader) over `creatorLedgerPsqlClient`, against 2920, 2921,
 * 2930 and this lane's 3385/3386/3387 as the harness replays them. Nothing is
 * mocked below the client: every CHECK, trigger, unique index and deferred
 * constraint decides for itself.
 *
 * CONTROLLED DATA ONLY. The rule versions carrying percentages are TEST
 * FIXTURES (`…/v901`, `…/v902`, noted as such on the row) inserted by this
 * suite and deleted after it. No migration seeds one, and the seeded lineages
 * keep 2920's `{}` params. The flag is answered IN MEMORY by the client; the
 * harness's `creator_attribution_enabled` row stays FALSE and R1 asserts it.
 *
 *   L1  DV-64  the share is computed from the SAME ledger: creator_earning_entries
 *              reaches creator_share_ledger, reversals and superseded rows included,
 *              and CanonicalShareReader reconciles all three partitions both ways
 *   L2  DV-26/67  a recommendation is BOUND to the converting viewer's own exposure
 *   L3  DV-26  a Trail attribution: trail_id + recommendation_id + contributors + confidence
 *   L4  DV-56  the travel_partner producer attributes completed bookings only, once
 *   L5  DV-57/58  earnings under a PUBLISHED version; stale/unpublished/empty refused
 *   L6  one earning, one ledger: a booking already in rent_buddy_earnings_entries
 *   L7  DV-59/74  hold → audited → earning refused and read as held → release
 *   L8  DV-60  recompute: superseded, reversed, rebooked, history still readable
 *   L9  a payload that fails on its LAST row leaves NO half-ledger
 *   L10 concurrent recomputations: one wins, the other is refused whole
 *   L11 a hold racing a booking is serialised
 *   L12 DV-68  reversal is an exact negation, once
 *   L13 DC-23  the creator's own reads; cross-creator denial; flag off
 *   L14 DV-65/66  every balance reconstructs from entries; no stored total exists
 *   L15 account erasure of a creator with a ledger is REFUSED while C-11 is undecided (3510)
 *   L16 a view that predates 3385 makes the creator's read refuse, not under-report
 *   R1  the flag row was never turned on
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { HAVE_DB, LOCAL_DB_URL, creatorLedgerPurgeSql, exec, psql, rows, scalar, seedUser } from "./localDb.js";
import { creatorPsqlClient, lit } from "./creatorLedgerPsqlClient.js";
import {
  bookCreatorEarningUnderRule,
  recordCreatorAttribution,
  recordCreatorAttributionUnderRule,
  recordCreatorEarning,
  resolveServedRecommendation,
  appendToLedger,
} from "../../services/creators/CreatorAttributionService.js";
import {
  placeCreatorHold,
  readCreatorLedgerAuditTrail,
  recomputeCreatorAttribution,
  releaseCreatorHold,
  reverseCreatorTransaction,
} from "../../services/creators/CreatorLedgerOperations.js";
import { readMyCreatorLedger } from "../../services/creators/CreatorLedgerReader.js";
import { attributeCompletedTravelPartnerBookings } from "../../services/creators/CreatorAttributionProducers.js";
import {
  computeCreatorShares,
  reconcileCanonicalAgainstSources,
} from "../../services/ledger/CanonicalShareReader.js";
import { mintServeExposure, servedRecommendationId } from "../../lib/discoveryRecommendationRecord.js";
import { historicalCreatorBalanceAt, type CreatorLedgerEntry } from "../../lib/creatorLedgerEntries.js";
import { attributionModelFromRow, planRecompute, planHold, type DoorPayload } from "../../lib/creatorLedgerPlans.js";
import type { AttributionRow, EarningEntryRow } from "../../lib/creatorLedgerStatus.js";

const FLAG = "creator_attribution_enabled";
const on = () => creatorPsqlClient({ flags: { [FLAG]: true } });
const off = () => creatorPsqlClient({ flags: {} });
const ADMIN = { kind: "admin" as const, userId: "" };

const TP_V901 = "creator-rules/travel-partner/v901";
const TP_V902 = "creator-rules/travel-partner/v902";
const LE_V901 = "creator-rules/local-expert/v901";
const TB_V1 = "creator-rules/trail-builder/v1";

let creatorA = "", creatorB = "", viewerV = "", viewerW = "", admin = "";
const users: string[] = [];
const bookings: string[] = [];
let buddyProfileA = "", buddyProfileB = "";

function psqlAsync(script: string): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-At", LOCAL_DB_URL]);
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => resolve({ status: status ?? -1, stdout, stderr }));
    p.stdin.end(script);
  });
}

/** Publish a TEST-ONLY rule version, effective just now. */
function publish(type: string, version: string, params: Record<string, unknown>, ago = "1 second"): void {
  exec(
    `INSERT INTO public.creator_rule_versions (creator_type, rule_version, params, effective_from, note) VALUES ` +
    `(${lit(type)}, ${lit(version)}, ${lit(params)}::jsonb, now() - interval '${ago}', ` +
    `'TEST FIXTURE (census-discovery §52 harness suite) — not a production rule; deleted after the suite')`,
  );
}

/** A completed booking of `buddyProfile` for `traveler`. */
function seedBooking(buddyProfile: string, traveler: string, status: string): string {
  const id = randomUUID();
  exec(
    `INSERT INTO public.rent_buddy_bookings (id, buddy_id, traveler_id, booking_date, duration_h, city, category, status) ` +
    `VALUES ('${id}', '${buddyProfile}', '${traveler}', current_date, 2, 'Lisbon', 'local_guide', '${status}');`,
  );
  bookings.push(id);
  return id;
}

/** A signed-in viewer's served exposure, stamped with P3's contract. */
function seedExposure(viewer: string, itemId: string, servedAt = new Date(Date.now() - 60_000)): string {
  const e = mintServeExposure(viewer, randomUUID(), servedAt);
  const rid = servedRecommendationId(e, 0, itemId);
  exec(
    `INSERT INTO public.rank_events (user_id, item_id, item_kind, position, outcome, served_at, surface, session_id, recommendation_id) ` +
    `VALUES ('${viewer}', ${lit(itemId)}, 'place', 0, 'tap', ${lit(e.servedAt)}, 'discovery', '${e.sessionId}', ${lit(rid)});`,
  );
  return rid;
}

async function recordedTravelPartner(creator: string, gross: number, extra: Record<string, unknown> = {}) {
  const subject = randomUUID();
  const r = await recordCreatorAttributionUnderRule(on(), {
    creatorType: "travel_partner", subjectId: subject, valueEventId: subject, beneficiaryUserId: creator,
    weight: 1, confidence: 1, grossRevenueMinor: gross, fraudHold: false, fraudHoldReason: null, ...extra,
  } as any);
  assert.equal(r.ok, true, JSON.stringify(r));
  if (!r.ok) throw new Error("unreachable");
  return { id: r.value.id, subject };
}

const entriesOf = (attributionIds: string[]): EarningEntryRow[] =>
  rows<EarningEntryRow>(`SELECT * FROM public.creator_earning_entries WHERE attribution_id IN (${attributionIds.map(lit).join(",")}) ORDER BY occurred_at, idempotency_key`);

describe("the creator ledger, end to end (census-discovery §52)", { skip: !HAVE_DB }, () => {
  before(() => {
    creatorA = seedUser("p10creatorA"); creatorB = seedUser("p10creatorB");
    viewerV = seedUser("p10viewerV"); viewerW = seedUser("p10viewerW"); admin = seedUser("p10admin");
    users.push(creatorA, creatorB, viewerV, viewerW, admin);
    ADMIN.userId = admin;
    exec(`UPDATE public.profiles SET role = 'admin' WHERE id = '${admin}';`);
    buddyProfileA = scalar(`INSERT INTO public.rent_buddy_profiles (user_id, city) VALUES ('${creatorA}', 'Lisbon') RETURNING id`)!;
    buddyProfileB = scalar(`INSERT INTO public.rent_buddy_profiles (user_id, city) VALUES ('${creatorB}', 'Lisbon') RETURNING id`)!;
    publish("travel_partner", TP_V901, { creator_share_ppm: 700000, platform_fee_ppm: 200000 });
    publish("local_expert", LE_V901, { creator_share_ppm: 500000, platform_fee_ppm: 100000 });
  });

  after(() => {
    // Superuser cleanup of THIS suite's rows. Account erasure is itself under
    // test in L15; here the profiles go last so their cascades clean the rest.
    exec(
      // 3510 refuses every ledger DELETE while C-11 is open; the harness purge
      // (superuser, replica mode) removes this suite's own synthetic rows.
      `${creatorLedgerPurgeSql(users, bookings)}\n` +
      `DELETE FROM public.rent_buddy_bookings WHERE id IN (${(bookings.length ? bookings : [randomUUID()]).map(lit).join(",")});\n` +
      `DELETE FROM public.rent_buddy_profiles WHERE user_id IN (${users.map(lit).join(",")});\n` +
      `DELETE FROM public.intel_reward_ledger WHERE actor_id IN (${users.map(lit).join(",")});\n` +
      `DELETE FROM public.rank_events WHERE user_id IN (${users.map(lit).join(",")});\n` +
      `DELETE FROM public.creator_rule_versions WHERE note LIKE 'TEST FIXTURE (census-discovery §52%';\n` +
      `DELETE FROM public.profiles WHERE id IN (${users.map(lit).join(",")});\n` +
      `DELETE FROM auth.users WHERE id IN (${users.map(lit).join(",")});`,
    );
  });

  // ── L2 / L3 — the recommendation, bound ───────────────────────────────────
  test("L2. a recommendation is bound to the CONVERTING viewer's own exposure — never another's, never unknown, never later", async () => {
    const rid = seedExposure(viewerV, "node/l2-place");
    const ridW = seedExposure(viewerW, "node/l2-place");
    const later = seedExposure(viewerV, "node/l2-later", new Date(Date.now() + 3_600_000));
    const now = new Date().toISOString();

    const bound = await resolveServedRecommendation(on(), { viewerUserId: viewerV, recommendationId: rid, itemId: "node/l2-place", occurredAt: now });
    assert.equal(bound.ok, true, JSON.stringify(bound));

    const cross = await resolveServedRecommendation(on(), { viewerUserId: viewerV, recommendationId: ridW, occurredAt: now });
    assert.deepEqual([cross.ok, !cross.ok && cross.reason], [false, "recommendation_not_found"], "another viewer's id must bind nothing");
    const unknown = await resolveServedRecommendation(on(), { viewerUserId: viewerV, recommendationId: "ZZZZZZZZZZZZZZZZZZZZZZ", occurredAt: now });
    assert.deepEqual([unknown.ok, !unknown.ok && unknown.reason], [false, "recommendation_not_found"]);
    const malformed = await resolveServedRecommendation(on(), { viewerUserId: viewerV, recommendationId: "x'; DROP TABLE rank_events;--" });
    assert.deepEqual([malformed.ok, !malformed.ok && malformed.reason], [false, "malformed_recommendation_id"]);
    const wrongItem = await resolveServedRecommendation(on(), { viewerUserId: viewerV, recommendationId: rid, itemId: "node/other" });
    assert.deepEqual([wrongItem.ok, !wrongItem.ok && wrongItem.reason], [false, "recommendation_item_mismatch"]);
    const stale = await resolveServedRecommendation(on(), { viewerUserId: viewerV, recommendationId: later, occurredAt: now });
    assert.deepEqual([stale.ok, !stale.ok && stale.reason], [false, "recommendation_served_after_conversion"]);
    const disabled = await resolveServedRecommendation(off(), { viewerUserId: viewerV, recommendationId: rid });
    assert.deepEqual([disabled.ok, !disabled.ok && disabled.reason], [false, "disabled"]);
    if (!bound.ok) return;

    // Recorded with the BOUND id; a replay is a replay; the same event claimed
    // with a DIFFERENT recommendation is a conflict, not a success.
    const subject = randomUUID();
    const input = {
      creatorType: "travel_partner" as const, subjectId: subject, valueEventId: subject, beneficiaryUserId: creatorA,
      weight: 1, confidence: 1, grossRevenueMinor: 0, provisionalShareMinor: 0, fraudHold: false, fraudHoldReason: null,
    };
    const first = await recordCreatorAttribution(on(), { ...input, recommendation: bound.value });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(scalar(`SELECT recommendation_id FROM public.creator_attributions WHERE subject_id = '${subject}'`), rid);
    const replay = await recordCreatorAttribution(on(), { ...input, recommendation: bound.value });
    assert.equal(replay.ok && replay.replayed, true, "an identical replay is a replay");
    const other = await resolveServedRecommendation(on(), { viewerUserId: viewerV, recommendationId: seedExposure(viewerV, "node/l2-b") });
    assert.equal(other.ok, true);
    if (!other.ok) return;
    const conflict = await recordCreatorAttribution(on(), { ...input, recommendation: other.value });
    assert.deepEqual([conflict.ok, !conflict.ok && conflict.reason], [false, "conflicting_replay"]);
    assert.equal(scalar(`SELECT count(*) FROM public.creator_attributions WHERE subject_id = '${subject}'`), "1");

    // The database refuses an unserved id from ANY writer, not only this service.
    const direct = await (on().from("creator_attributions").insert({
      creator_type: "trail_builder", subject_kind: "trail", subject_id: randomUUID(), value_event: "route_completion",
      value_event_id: null, attribution_basis: "seam_no_producer", beneficiary_user_id: creatorA,
      rule_version: TB_V1, idempotency_key: `l2-direct-${randomUUID()}`, recommendation_id: "AAAAAAAAAAAAAAAAAAAAAA",
    }).select().single());
    assert.equal(direct.error?.code, "23503", JSON.stringify(direct.error));
    assert.match(direct.error!.message, /names no served exposure/);
  });

  test("L3. DV-26 — a Trail attribution carries trail_id + recommendation_id + each contributor + confidence; the revenue event is the one absent fact", async () => {
    const trail = randomUUID();
    const rid = seedExposure(viewerV, `trail/${trail}`);
    const bound = await resolveServedRecommendation(on(), { viewerUserId: viewerV, recommendationId: rid, itemId: `trail/${trail}` });
    assert.equal(bound.ok, true);
    if (!bound.ok) return;
    for (const [contributor, confidence] of [[creatorA, 0.6], [creatorB, 0.3]] as const) {
      const r = await recordCreatorAttribution(on(), {
        creatorType: "trail_builder", subjectId: trail, valueEventId: null, beneficiaryUserId: contributor,
        weight: 0, confidence, grossRevenueMinor: 0, provisionalShareMinor: 0, fraudHold: false, fraudHoldReason: null,
        recommendation: bound.value,
      });
      assert.equal(r.ok, true, JSON.stringify(r));
    }
    const got = rows<any>(`SELECT beneficiary_user_id, confidence::float8 AS confidence, recommendation_id, value_event_id, attribution_basis FROM public.creator_attributions WHERE subject_kind = 'trail' AND subject_id = '${trail}' ORDER BY confidence DESC`);
    assert.equal(got.length, 2, "one row per contributor");
    assert.deepEqual(got.map((g) => [g.beneficiary_user_id, g.confidence, g.recommendation_id]),
      [[creatorA, 0.6, rid], [creatorB, 0.3, rid]]);
    // 02 §17's fifth fact: no Trail value event has a producer, so 2920's honesty
    // constraint keeps the downstream revenue event NULL on a seam.
    assert.ok(got.every((g) => g.value_event_id === null && g.attribution_basis === "seam_no_producer"));
  });

  // ── L4 — the producer ─────────────────────────────────────────────────────
  test("L4. DV-56 — the travel_partner producer attributes each traveller-confirmed booking once, and nothing else", async () => {
    const done = seedBooking(buddyProfileA, viewerV, "completed");
    const pendingConfirm = seedBooking(buddyProfileA, viewerV, "completed_pending_traveler_confirmation");
    const pending = seedBooking(buddyProfileB, viewerV, "pending");

    const disabled = await attributeCompletedTravelPartnerBookings(off());
    assert.deepEqual([disabled.ok, !disabled.ok && disabled.reason], [false, "disabled"]);
    assert.equal(scalar(`SELECT count(*) FROM public.creator_attributions WHERE subject_id = '${done}'`), "0", "flag off: nothing written");

    const first = await attributeCompletedTravelPartnerBookings(on());
    assert.equal(first.ok, true, JSON.stringify(first));
    const a = rows<any>(`SELECT creator_type, subject_kind, value_event, value_event_id, beneficiary_user_id, attribution_basis, rule_version, weight::float8 AS weight FROM public.creator_attributions WHERE subject_id = '${done}'`);
    assert.equal(a.length, 1);
    assert.deepEqual(a[0], {
      creator_type: "travel_partner", subject_kind: "booking", value_event: "verified_booking", value_event_id: done,
      beneficiary_user_id: creatorA, attribution_basis: "recorded_value_event", rule_version: TP_V901, weight: 1,
    });
    for (const b of [pendingConfirm, pending]) {
      assert.equal(scalar(`SELECT count(*) FROM public.creator_attributions WHERE subject_id = '${b}'`), "0", `status of ${b} is not a verified booking`);
    }
    const second = await attributeCompletedTravelPartnerBookings(on());
    assert.equal(second.ok, true);
    if (second.ok) assert.equal(second.value.attributed, 0, "a second pass attributes nothing new");
    assert.equal(scalar(`SELECT count(*) FROM public.creator_attributions WHERE subject_id = '${done}'`), "1");
  });

  // ── L5 / L6 — earnings under a published version ──────────────────────────
  test("L5. DV-57/58 — an earning is computed from a PUBLISHED version, booked balanced with no settlement; stale, unpublished and empty versions are refused", async () => {
    const { id } = await recordedTravelPartner(creatorA, 10_000);
    assert.equal(scalar(`SELECT rule_version || ':' || provisional_share_minor FROM public.creator_attributions WHERE id = '${id}'`), `${TP_V901}:7000`);
    const booked = await bookCreatorEarningUnderRule(on(), id, { revenueSource: "booking_commission" });
    assert.equal(booked.ok, true, JSON.stringify(booked));
    const e = entriesOf([id]);
    assert.deepEqual(e.map((x) => [x.account, Number(x.amount_minor)]).sort(),
      [["creator_payable", 7000], ["platform_revenue", 2000], ["traveler_receivable", -2000], ["traveler_receivable", -7000]].sort());
    assert.ok(e.every((x) => Number(x.cash_settled_minor) === 0 && x.provider === "none"), "no entry records a settlement or a provider");
    const replay = await bookCreatorEarningUnderRule(on(), id, { revenueSource: "booking_commission" });
    assert.equal(replay.ok && replay.value.booking, "already_booked");

    const subject = randomUUID();
    const base = { creatorType: "travel_partner" as const, subjectId: subject, valueEventId: subject, beneficiaryUserId: creatorA,
      weight: 1, confidence: 1, grossRevenueMinor: 0, provisionalShareMinor: 0, fraudHold: false, fraudHoldReason: null };
    const stale = await recordCreatorAttribution(on(), { ...base, ruleVersion: "creator-rules/travel-partner/v1" });
    assert.deepEqual([stale.ok, !stale.ok && stale.reason], [false, "stale_rule_version"], "a version older than the one in force");
    const unpublished = await recordCreatorAttribution(on(), { ...base, ruleVersion: "creator-rules/travel-partner/v999" });
    assert.deepEqual([unpublished.ok, !unpublished.ok && unpublished.reason], [false, "unpublished_rule_version"]);
    // `experience_host` keeps 2920's seeded `{}`: no percentage is published, nothing is computed.
    const empty = await recordCreatorAttributionUnderRule(on(), {
      creatorType: "experience_host", subjectId: randomUUID(), valueEventId: null, beneficiaryUserId: creatorA,
      weight: 1, confidence: 1, grossRevenueMinor: 10_000, fraudHold: false, fraudHoldReason: null,
    } as any);
    assert.deepEqual([empty.ok, !empty.ok && empty.reason], [false, "rule_params_incomplete"]);
    assert.equal(scalar(`SELECT count(*) FROM public.creator_attributions WHERE subject_id = '${subject}'`), "0");
  });

  test("L6. one earning, one ledger — a booking already booked in rent_buddy_earnings_entries cannot be booked again", async () => {
    const booking = seedBooking(buddyProfileA, viewerV, "completed");
    exec(
      `INSERT INTO public.rent_buddy_earnings_entries (transaction_key, booking_id, account, entry_reason, amount_minor, currency, cash_settled_minor, rule_version, attribution_kind, attribution_id, beneficiary_user_id, provider, idempotency_key) VALUES ` +
      `('booking:${booking}:booking_gross:rent-buddy-fee-schedule/v1', '${booking}', 'traveler_receivable', 'booking_gross', -5000, 'USD', 0, 'rent-buddy-fee-schedule/v1', 'booking', '${booking}', NULL, 'none', 'l6-${booking}-0'),` +
      `('booking:${booking}:booking_gross:rent-buddy-fee-schedule/v1', '${booking}', 'buddy_payable', 'booking_gross', 5000, 'USD', 0, 'rent-buddy-fee-schedule/v1', 'booking', '${booking}', '${creatorA}', 'none', 'l6-${booking}-1');`,
    );
    const a = await recordCreatorAttributionUnderRule(on(), {
      creatorType: "travel_partner", subjectId: booking, valueEventId: booking, beneficiaryUserId: creatorA,
      weight: 1, confidence: 1, grossRevenueMinor: 5_000, fraudHold: false, fraudHoldReason: null,
    } as any);
    assert.equal(a.ok, true, JSON.stringify(a));
    if (!a.ok) return;
    const b = await bookCreatorEarningUnderRule(on(), a.value.id);
    assert.deepEqual([b.ok, !b.ok && b.reason], [false, "booked_in_subsystem_ledger"]);
    assert.equal(entriesOf([a.value.id]).length, 0);
  });

  // ── L7 — holds ────────────────────────────────────────────────────────────
  test("L7. DV-59/74 — a hold is recorded, explained, audited, blocks booking, reads as held; the release is audited with its own reason", async () => {
    const { id } = await recordedTravelPartner(creatorB, 20_000);
    assert.equal((await bookCreatorEarningUnderRule(on(), id)).ok, true);

    const unexplained = await placeCreatorHold(on(), { attributionId: id, reason: "   ", actor: ADMIN });
    assert.deepEqual([unexplained.ok, !unexplained.ok && unexplained.reason], [false, "unexplained"]);
    const disabled = await placeCreatorHold(off(), { attributionId: id, reason: "circular_transactions", actor: ADMIN });
    assert.deepEqual([disabled.ok, !disabled.ok && disabled.reason], [false, "disabled"]);

    const held = await placeCreatorHold(on(), { attributionId: id, reason: "circular_transactions", actor: ADMIN });
    assert.equal(held.ok, true, JSON.stringify(held));
    if (!held.ok) return;
    const heldId = held.value.resultingAttributionId!;
    const audit = rows<any>(`SELECT action, actor_kind, actor_user_id, reason, resulting_attribution_id FROM public.creator_ledger_audit_events WHERE attribution_id = '${id}'`);
    assert.deepEqual(audit, [{ action: "hold_placed", actor_kind: "admin", actor_user_id: admin, reason: "circular_transactions", resulting_attribution_id: heldId }]);

    const again = await placeCreatorHold(on(), { attributionId: id, reason: "paid_engagement", actor: ADMIN });
    assert.deepEqual([again.ok, !again.ok && again.reason], [false, "already_held"], "naming the ORIGINAL row acts on the chain's head");

    // Nothing can be earned against it: not the original, not the held head.
    const original = rows<AttributionRow>(`SELECT * FROM public.creator_attributions WHERE id = '${id}'`)[0]!;
    const viaOriginal = await recordCreatorEarning(on(), id, { ...attributionModelFromRow(original), id: `l7-${randomUUID()}` }, { grossRevenueMinor: 100, creatorShareMinor: 70, platformFeeMinor: 20 });
    assert.deepEqual([viaOriginal.ok, !viaOriginal.ok && viaOriginal.reason], [false, "attribution_not_current"]);
    const viaHead = await bookCreatorEarningUnderRule(on(), heldId);
    assert.equal(viaHead.ok, false, "the model refuses a held attribution before the database is asked");

    const ledger = await readMyCreatorLedger(on(), creatorB);
    assert.equal(ledger.ok, true);
    if (ledger.ok) {
      const cee = ledger.value.earnings.buckets.find((b) => b.sourceLedger === "creator_earning_entries")!;
      assert.equal(cee.held, 14_000, "the held earning is rendered HELD");
      assert.equal(cee.available, 0, "and never as payable");
    }

    const release = await releaseCreatorHold(on(), { attributionId: id, reason: "false positive: bookings verified by support", actor: ADMIN });
    assert.equal(release.ok, true, JSON.stringify(release));
    const trail = await readCreatorLedgerAuditTrail(on(), id);
    assert.equal(trail.ok, true);
    if (trail.ok) {
      assert.deepEqual(trail.value.audit.map((a: any) => [a.action, a.reason]),
        [["hold_placed", "circular_transactions"], ["hold_released", "false positive: bookings verified by support"]]);
      assert.equal(trail.value.chain.length, 3, "original → held → released, never an edit");
      assert.equal(trail.value.unbalancedTransactions.length, 0);
    }
    const after = await readMyCreatorLedger(on(), creatorB);
    if (after.ok) {
      const cee = after.value.earnings.buckets.find((b) => b.sourceLedger === "creator_earning_entries")!;
      assert.deepEqual([cee.provisional, cee.held], [14_000, 0], "released: provisional again");
    }
  });

  // ── L8 — recomputation ────────────────────────────────────────────────────
  test("L8. DV-60 — recomputation supersedes, reverses and rebooks in one transaction; the old version's answer stays readable", async () => {
    const { id } = await recordedTravelPartner(creatorA, 10_000);
    assert.equal((await bookCreatorEarningUnderRule(on(), id)).ok, true);
    publish("travel_partner", TP_V902, { creator_share_ppm: 650000, platform_fee_ppm: 250000 }, "0 seconds");

    const r = await recomputeCreatorAttribution(on(), { attributionId: id, reason: "fee schedule v902 published", actor: ADMIN });
    assert.equal(r.ok, true, JSON.stringify(r));
    if (!r.ok) return;
    const head = rows<AttributionRow>(`SELECT * FROM public.creator_attributions WHERE id = '${r.value.resultingAttributionId}'`)[0]!;
    assert.deepEqual([head.rule_version, Number(head.provisional_share_minor), head.supersedes_id], [TP_V902, 6500, id]);

    const all = entriesOf([id, head.id]);
    const model: CreatorLedgerEntry[] = all.map((e) => ({
      entryId: e.id, transactionKey: e.transaction_key, creatorType: e.creator_type as any, attributionId: e.attribution_id,
      account: e.account as any, amountMinor: Number(e.amount_minor), currency: e.currency, entryReason: e.entry_reason as any,
      revenueSource: null, cashSettledMinor: 0, ruleVersion: e.rule_version, beneficiaryUserId: e.beneficiary_user_id,
      reversesEntryId: e.reverses_entry_id, provider: "none", externalRef: null, idempotencyKey: e.idempotency_key,
    }));
    assert.equal(historicalCreatorBalanceAt(model, TP_V901).creator_payable, 7000, "what v901 said is still readable");
    assert.equal(historicalCreatorBalanceAt(model, TP_V902).creator_payable, 6500);
    const net = all.filter((e) => e.account === "creator_payable").reduce((s, e) => s + Number(e.amount_minor), 0);
    assert.equal(net, 6500, "the live balance is the new version's, with the old reversed rather than edited");
    assert.equal(all.filter((e) => e.entry_reason === "reversal").length, 4, "every old leg negated");

    const same = await recomputeCreatorAttribution(on(), { attributionId: id, reason: "again", actor: ADMIN });
    assert.deepEqual([same.ok, !same.ok && same.reason], [false, "same_rule_version"]);
    const held = await placeCreatorHold(on(), { attributionId: id, reason: "refund_abuse", actor: ADMIN });
    assert.equal(held.ok, true);
    exec(`DELETE FROM public.creator_rule_versions WHERE rule_version = '${TP_V902}'`); // v901 back in force
    publish("travel_partner", "creator-rules/travel-partner/v903", { creator_share_ppm: 600000, platform_fee_ppm: 300000 }, "0 seconds");
    const whileHeld = await recomputeCreatorAttribution(on(), { attributionId: id, reason: "v903", actor: ADMIN });
    assert.deepEqual([whileHeld.ok, !whileHeld.ok && whileHeld.reason], [false, "recompute_while_held"]);
    exec(`DELETE FROM public.creator_rule_versions WHERE rule_version = 'creator-rules/travel-partner/v903'`);
  });

  // ── L9 / L10 / L11 — atomicity and races ─────────────────────────────────
  test("L9. a payload that fails on its LAST row leaves no half-ledger — no successor, no reversal, no audit", async () => {
    const { id } = await recordedTravelPartner(creatorA, 10_000);
    assert.equal((await bookCreatorEarningUnderRule(on(), id)).ok, true);
    const head = rows<AttributionRow>(`SELECT * FROM public.creator_attributions WHERE id = '${id}'`)[0]!;
    const plan = planHold(head, "synthetic_accounts", ADMIN);
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    const live = entriesOf([id]);
    const broken: DoorPayload = {
      ...plan.payload,
      entries: [
        // a lawful reversal of the first live leg…
        { ...live[0]!, amount_minor: -Number(live[0]!.amount_minor), entry_reason: "reversal", reverses_entry_id: live[0]!.id,
          transaction_key: `l9:${randomUUID()}`, idempotency_key: `l9-${randomUUID()}`, attribution_id: id, provider: "none", external_ref: null } as any,
        // …whose transaction is unbalanced: the LAST row is what fails.
      ],
    };
    const r = await appendToLedger(on(), broken);
    assert.deepEqual([r.ok, !r.ok && r.reason], [false, "transaction_unbalanced"]);
    assert.equal(scalar(`SELECT count(*) FROM public.creator_attributions WHERE supersedes_id = '${id}'`), "0", "no successor survived");
    assert.equal(scalar(`SELECT count(*) FROM public.creator_earning_entries WHERE reverses_entry_id = '${live[0]!.id}'`), "0", "no reversal survived");
    assert.equal(scalar(`SELECT count(*) FROM public.creator_ledger_audit_events WHERE attribution_id = '${id}'`), "0", "no audit row survived");
  });

  test("L10. two recomputations of one head, raced: exactly one supersedes it; the other is refused whole", async () => {
    const { id } = await recordedTravelPartner(creatorA, 10_000);
    assert.equal((await bookCreatorEarningUnderRule(on(), id)).ok, true);
    publish("travel_partner", "creator-rules/travel-partner/v904", { creator_share_ppm: 600000, platform_fee_ppm: 300000 }, "0 seconds");
    publish("travel_partner", "creator-rules/travel-partner/v905", { creator_share_ppm: 550000, platform_fee_ppm: 300000 }, "0 seconds");
    const head = rows<AttributionRow>(`SELECT * FROM public.creator_attributions WHERE id = '${id}'`)[0]!;
    const live = entriesOf([id]);
    const payloadFor = (v: string, share: number) => {
      const p = planRecompute([head], live, head,
        { ruleVersion: v, figures: { grossRevenueMinor: 10_000, creatorShareMinor: share, platformFeeMinor: 3000 } }, `race ${v}`, ADMIN);
      assert.equal(p.ok, true, JSON.stringify(p));
      return p.ok ? p.payload : null;
    };
    const call = (p: DoorPayload) => `SET ROLE service_role;\nSELECT public.creator_ledger_append(${lit(p)}::jsonb);`;
    // A recomputation row need only name a PUBLISHED, effective version (3387);
    // both are, so what decides the race is the supersession index alone.
    const a = psqlAsync(`BEGIN;\n${call(payloadFor("creator-rules/travel-partner/v904", 6000)!)}\nSELECT pg_sleep(0.6);\nCOMMIT;`);
    await new Promise((res) => setTimeout(res, 150));
    const b = psqlAsync(`BEGIN;\n${call(payloadFor("creator-rules/travel-partner/v905", 5500)!)}\nCOMMIT;`);
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.status, 0, ra.stderr);
    assert.notEqual(rb.status, 0, "the second recomputation must be refused");
    assert.match(rb.stderr, /ca_one_supersede_per_row/);
    assert.equal(scalar(`SELECT count(*) FROM public.creator_attributions WHERE supersedes_id = '${id}'`), "1");
    const residual = rows<any>(`SELECT transaction_key, sum(amount_minor)::bigint AS s FROM public.creator_earning_entries WHERE attribution_id IN (SELECT id FROM public.creator_attributions WHERE subject_id = '${head.subject_id}') GROUP BY 1 HAVING sum(amount_minor) <> 0`);
    assert.deepEqual(residual, [], "no transaction is left unbalanced by the loser");
    exec(`DELETE FROM public.creator_rule_versions WHERE rule_version IN ('creator-rules/travel-partner/v904', 'creator-rules/travel-partner/v905')`);
  });

  test("L11. a hold racing a booking is serialised: the booking waits, then is refused against the held chain", async () => {
    const { id } = await recordedTravelPartner(creatorA, 10_000);
    const head = rows<AttributionRow>(`SELECT * FROM public.creator_attributions WHERE id = '${id}'`)[0]!;
    const plan = planHold(head, "collusive_groups", ADMIN);
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    const holdA = psqlAsync(`BEGIN;\nSET LOCAL ROLE service_role;\nSELECT public.creator_ledger_append(${lit(plan.payload)}::jsonb);\nSELECT pg_sleep(0.6);\nCOMMIT;`);
    await new Promise((res) => setTimeout(res, 150));
    const tk = `creator:${head.idempotency_key}:revenue_share:${TP_V901}`;
    const bookB = psqlAsync(
      `BEGIN;\nSET LOCAL ROLE service_role;\nINSERT INTO public.creator_earning_entries (transaction_key, creator_type, attribution_id, account, entry_reason, amount_minor, rule_version, beneficiary_user_id, idempotency_key) VALUES ` +
      `('${tk}', 'travel_partner', '${id}', 'traveler_receivable', 'revenue_share', -7000, '${TP_V901}', NULL, '${tk}#0'), ` +
      `('${tk}', 'travel_partner', '${id}', 'creator_payable', 'revenue_share', 7000, '${TP_V901}', '${creatorA}', '${tk}#1');\nCOMMIT;`,
    );
    const [ra, rb] = await Promise.all([holdA, bookB]);
    assert.equal(ra.status, 0, ra.stderr);
    assert.notEqual(rb.status, 0, "the booking that waited must see the hold");
    assert.match(rb.stderr, /attribution_not_current/);
    assert.equal(entriesOf([id]).length, 0);
  });

  // ── L12 — reversal ────────────────────────────────────────────────────────
  test("L12. DV-68 — a reversal is the exact negation, audited, once; a non-negating 'reversal' is refused", async () => {
    const { id } = await recordedTravelPartner(creatorB, 30_000);
    assert.equal((await bookCreatorEarningUnderRule(on(), id)).ok, true);
    const tk = entriesOf([id]).find((e) => e.entry_reason === "revenue_share")!.transaction_key;
    const r = await reverseCreatorTransaction(on(), { transactionKey: tk, reason: "refund issued", actor: ADMIN });
    assert.equal(r.ok, true, JSON.stringify(r));
    const pair = entriesOf([id]).filter((e) => e.transaction_key === tk || e.transaction_key === `reversal:${tk}`);
    assert.equal(pair.reduce((s, e) => s + Number(e.amount_minor), 0), 0);
    assert.equal(pair.length, 4);
    const twice = await reverseCreatorTransaction(on(), { transactionKey: tk, reason: "refund issued", actor: ADMIN });
    assert.deepEqual([twice.ok, !twice.ok && twice.reason], [false, "already_reversed"]);

    const fee = entriesOf([id]).find((e) => e.entry_reason === "platform_fee" && e.account === "platform_revenue")!;
    const bad = await (on().from("creator_earning_entries").insert([{
      transaction_key: `l12-bad-${randomUUID()}`, creator_type: "travel_partner", attribution_id: id, account: "platform_revenue",
      entry_reason: "reversal", amount_minor: -1, rule_version: TP_V901, reverses_entry_id: fee.id, idempotency_key: `l12-bad-${randomUUID()}`,
    }]).select());
    assert.match(String(bad.error?.message), /reversal_is_not_a_negation/);
  });

  // ── L1 — the same ledger ──────────────────────────────────────────────────
  test("L1. DV-64 — creator_earning_entries reaches creator_share_ledger; the share reconciles over all three partitions, both ways", async () => {
    // One row in each of the other two ledgers, so the third partition is proved
    // not to disturb them.
    exec(`INSERT INTO public.intel_reward_ledger (actor_id, source, qiu, earned_units, cash_amount, ledger_version) VALUES ('${creatorA}', 'served', 0.25, 25, 0, 'intel-reward/v1');`);
    const sums = rows<any>(
      `SELECT (SELECT coalesce(sum(amount_minor),0)::bigint FROM public.creator_earning_entries) AS base,
              (SELECT coalesce(sum(amount),0)::bigint FROM public.creator_share_ledger WHERE source_ledger = 'creator_earning_entries') AS view,
              (SELECT count(*) FROM public.creator_earning_entries) AS base_n,
              (SELECT count(*) FROM public.creator_share_ledger WHERE source_ledger = 'creator_earning_entries') AS view_n,
              (SELECT count(*) FROM public.creator_earning_entries WHERE entry_reason = 'reversal') AS reversals,
              (SELECT count(*) FROM public.creator_earning_entries e JOIN public.creator_attributions a ON a.id = e.attribution_id
                WHERE EXISTS (SELECT 1 FROM public.creator_attributions s WHERE s.supersedes_id = a.id)) AS on_superseded`,
    )[0];
    assert.ok(Number(sums.base_n) > 0 && Number(sums.reversals) > 0 && Number(sums.on_superseded) > 0,
      `the reconciliation must cover live, reversed AND superseded rows to mean anything: ${JSON.stringify(sums)}`);
    assert.equal(sums.view, sums.base, "sum over the base ledger == sum over the canonical view");
    assert.equal(sums.view_n, sums.base_n);
    for (const c of rows<any>(`SELECT creator_id, sum(amount)::bigint AS v FROM public.creator_share_ledger WHERE source_ledger = 'creator_earning_entries' AND party_role = 'creator' GROUP BY 1`)) {
      const base = scalar(`SELECT coalesce(sum(amount_minor),0)::bigint FROM public.creator_earning_entries WHERE account = 'creator_payable' AND beneficiary_user_id = '${c.creator_id}'`);
      assert.equal(String(c.v), base, `per-creator share for ${c.creator_id}`);
    }

    const rec = await reconcileCanonicalAgainstSources(on(), { pageSize: 7 });
    assert.equal(rec.ok, true, JSON.stringify(rec));
    if (rec.ok) {
      assert.equal(rec.value.ok, true, JSON.stringify(rec.value.canonicalVsPerLedger.differences.slice(0, 5)));
      assert.ok(rec.value.canonicalVsPerLedger.compared.entries >= Number(sums.base_n) + 2, "all three partitions compared");
    }
    const shares = await computeCreatorShares(on(), { pageSize: 7 });
    assert.equal(shares.ok, true);
    if (shares.ok) {
      const a = shares.value.find((s) => s.creatorId === creatorA && s.sourceLedger === "creator_earning_entries");
      assert.ok(a && a.basis === "double_entry" && a.sharePpm !== null, JSON.stringify(a));
    }
  });

  // ── L13 — the creator's own reads ─────────────────────────────────────────
  test("L13. DC-23 — the reads are the caller's own, computed server-side; another creator's rows never appear; flag off is not an empty ledger", async () => {
    const a = await readMyCreatorLedger(on(), creatorA);
    const b = await readMyCreatorLedger(on(), creatorB);
    assert.equal(a.ok && b.ok, true);
    if (!a.ok || !b.ok) return;
    const aIds = new Set(rows<any>(`SELECT id FROM public.creator_attributions WHERE beneficiary_user_id = '${creatorA}'`).map((r) => r.id));
    for (const c of b.value.conversions) assert.ok(!aIds.has(c.attributionId), "creator B sees none of creator A's attributions");
    for (const e of b.value.entries) assert.equal(e.creatorId, creatorB);
    assert.ok(a.value.impact.outcomes.some((o) => o.valueEvent === "verified_booking" && o.attributed > 0));
    assert.ok(a.value.impact.seams >= 1, "the Trail seam is counted as a seam, not as value");
    for (const bucket of [...a.value.earnings.buckets, ...b.value.earnings.buckets]) {
      assert.equal(bucket.available, 0);
      assert.equal(bucket.lifetimeNet, bucket.provisional + bucket.held + bucket.reversedNet);
    }
    const disabled = await readMyCreatorLedger(off(), creatorA);
    assert.deepEqual([disabled.ok, !disabled.ok && disabled.reason], [false, "disabled"]);
  });

  // ── L14 — reconstruction ──────────────────────────────────────────────────
  test("L14. DV-65/66 — every balance reconstructs from entries alone; no ledger table stores a total", () => {
    const stored = rows<any>(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'
      AND table_name IN ('creator_attributions', 'creator_earning_entries', 'creator_ledger_audit_events')
      AND column_name ~ '(balance|total|lifetime|payable_amount|available)'`);
    assert.deepEqual(stored, [], "a stored total would be a second, mutable answer");
    const unbalanced = rows<any>(`SELECT transaction_key, currency, sum(amount_minor)::bigint FROM public.creator_earning_entries GROUP BY 1, 2 HAVING sum(amount_minor) <> 0`);
    assert.deepEqual(unbalanced, []);
    // Every entry names an attribution that names a type, subject, value event and rule version.
    const orphans = scalar(`SELECT count(*) FROM public.creator_earning_entries e LEFT JOIN public.creator_attributions a ON a.id = e.attribution_id WHERE a.id IS NULL OR a.rule_version IS NULL`);
    assert.equal(orphans, "0");
  });

  // ── L15 — erasure ─────────────────────────────────────────────────────────
  // CHANGED by census-discovery §107. This test used to assert that deleting
  // the profile CASCADES the creator's whole ledger away — i.e. it pinned
  // "delete on erasure", the answer to C-11 the owner has not given. 3510
  // refuses instead, and the two answers are each tested in their own fixture
  // database (creatorLedgerErasurePolicy.db.test.ts, fixtures A and B).
  test("L15. account erasure of a creator with a ledger is REFUSED while C-11 is undecided: chains, entries, reversals and audit rows all survive, unchanged", async () => {
    const doomed = seedUser("p10doomed");
    users.push(doomed);
    const { id } = await recordedTravelPartner(doomed, 10_000);
    assert.equal((await bookCreatorEarningUnderRule(on(), id)).ok, true);
    assert.equal((await placeCreatorHold(on(), { attributionId: id, reason: "fake_visits", actor: ADMIN })).ok, true);
    assert.equal((await releaseCreatorHold(on(), { attributionId: id, reason: "cleared", actor: ADMIN })).ok, true);
    const tk = entriesOf([id]).find((e) => e.entry_reason === "platform_fee")!.transaction_key;
    assert.equal((await reverseCreatorTransaction(on(), { transactionKey: tk, reason: "refund", actor: ADMIN })).ok, true);
    const snapshot = () => rows(
      `SELECT 'a' AS t, to_jsonb(a)::text AS r FROM public.creator_attributions a WHERE beneficiary_user_id = '${doomed}' UNION ALL ` +
      `SELECT 'e', to_jsonb(e)::text FROM public.creator_earning_entries e WHERE attribution_id IN (SELECT id FROM public.creator_attributions WHERE beneficiary_user_id = '${doomed}') UNION ALL ` +
      `SELECT 'u', to_jsonb(u)::text FROM public.creator_ledger_audit_events u WHERE attribution_id IN (SELECT id FROM public.creator_attributions WHERE beneficiary_user_id = '${doomed}') ORDER BY 1, 2`);
    const before = snapshot();
    assert.ok(before.length >= 8, `the creator must have chains, entries and audit rows (${before.length})`);
    // As the deletion service would: as service_role, on profiles.
    const r = psql(`\\set VERBOSITY verbose\nSET LOCAL ROLE service_role;\nDELETE FROM public.profiles WHERE id = '${doomed}';`, { single: true });
    assert.notEqual(r.status, 0, "the erasure must be refused");
    assert.match(r.stderr, /CL451/);
    assert.match(r.stderr, /creator_ledger_erasure_policy_undecided/);
    assert.deepEqual(snapshot(), before, "nothing of the ledger changed");
    assert.equal(scalar(`SELECT count(*) FROM public.profiles WHERE id = '${doomed}'`), "1", "the profile is untouched too");
  });

  test("L16. on a database whose view predates 3385, the creator's read REFUSES rather than under-reporting", async () => {
    // Rolled back and re-applied inside this test, on the throwaway harness only.
    const REPO = new URL("../../../../../", import.meta.url);
    const sqlOf = (rel: string) => readFileSync(new URL(rel, REPO), "utf8");
    assert.ok(Number(scalar(`SELECT count(*) FROM public.creator_earning_entries WHERE beneficiary_user_id = '${creatorB}'`)) > 0,
      "creator B must have creator_earning_entries legs for this to mean anything");
    exec(sqlOf("db/rollback/2026-09-27-3385-creator-share-ledger-includes-creator-entries-rollback.sql"));
    try {
      const r = await readMyCreatorLedger(on(), creatorB);
      assert.deepEqual([r.ok, !r.ok && r.reason], [false, "degraded_unavailable"],
        "a fold missing a whole ledger is a WRONG balance that looks like a real one");
    } finally {
      exec(sqlOf("artifacts/api-server/src/migrations/3385_creator_share_ledger_includes_creator_entries.sql"));
    }
    assert.equal(scalar(`SELECT count(*) FROM public.creator_share_ledger WHERE source_ledger = 'creator_earning_entries'`),
      scalar(`SELECT count(*) FROM public.creator_earning_entries`), "3385 re-applied");
  });

  test("R1. the flag row exists as 2922 seeded it and was never turned on: every flag-ON path above ran on an in-memory answer", () => {
    // Existence first, or `false` below would be satisfied by an absent row.
    assert.equal(scalar(`SELECT count(*) FROM public.feature_flags WHERE flag = '${FLAG}'`), "1", "2922's seed row is missing");
    assert.equal(scalar(`SELECT enabled::text FROM public.feature_flags WHERE flag = '${FLAG}'`), "false");
  });
});
