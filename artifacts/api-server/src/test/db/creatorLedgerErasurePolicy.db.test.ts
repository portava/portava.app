/**
 * The creator ledger END TO END on synthetic accounts, and C-11's erasure
 * question answered THREE ways in three separate databases — census-discovery §107.
 *
 * WHY THREE DATABASES. Whether a person's earning records are deleted or kept
 * with the identity removed when their account is erased is an open owner
 * decision (C-11 / W10D-B0). The canonical chain carries only 3510, which
 * refuses every ledger DELETE until the owner decides. The two answers are
 * complete migrations HELD in reconciliation-staging/ and are mutually
 * exclusive, so each runs in its own throwaway clone of the harness database
 * (CREATE DATABASE … TEMPLATE), never beside the other and never against
 * portava-ci or travel-buddy:
 *
 *   MAIN  the harness itself: the chain, 3510 included — C-11 UNDECIDED
 *   A     a clone + reconciliation-staging/3511 — DELETE ON ERASURE
 *   B     a clone + reconciliation-staging/3512 — RETAIN, PSEUDONYMISED
 *
 * SYNTHETIC DATA ONLY, MARKED AS SUCH. Every account this suite creates has an
 * id starting `c11e5e00`, a handle starting `c11syn_`, the display name
 * `SYNTHETIC C-11 FIXTURE …` and an address at `synthetic-c11.invalid`
 * (RFC 2606: can never be delivered). Bookings are in the city `SYNTHETIC-C11`.
 * The rule versions carrying percentages (`…/v951`, `…/v952`) are TEST
 * FIXTURES noted as such on the row. S1 asserts, in every fixture, that no
 * ledger row belongs to anything else.
 *
 * NO MONEY MOVES. Every ledger row records `provider = 'none'` and no
 * settlement (CHECK-enforced by 2901/2920/2921). The payout provider resolves to
 * `none` only, and its operations answer `payouts_disabled`. fetch, http, https,
 * net, tls and dns are trapped for the whole suite; F7 asserts none was reached.
 * The database is reached only by `psql` child processes on the loopback harness.
 *
 * THE FLAG IS NEVER TURNED ON IN A DATABASE: `creator_attribution_enabled` is
 * answered in memory by creatorLedgerPsqlClient (R1 re-reads the row: FALSE).
 *
 *   F1–F7  the ledger flows (MAIN): earnings, refund/reversal, attribution to a
 *          served recommendation, hold and release, recompute, folds and
 *          summaries, the payout boundary
 *   G1–G6  C-11 undecided (MAIN, 3510): every erasure path is refused and changes nothing
 *   A1–A7  answer A (fixture A): delete on the beneficiary's erasure, whole transactions
 *   B1–B9  answer B (fixture B): identity removed, rows retained, pseudonymised-not-anonymous pinned
 *   S1     separation: every ledger row in every fixture belongs to a synthetic account
 *   R1     the flag row is FALSE in every fixture
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";
import { HAVE_DB, LOCAL_DB_URL, exec, psql, rows, scalar, useDatabase } from "./localDb.js";
import { creatorPsqlClient, lit } from "./creatorLedgerPsqlClient.js";
import {
  bookCreatorEarningUnderRule,
  recordCreatorAttributionUnderRule,
  resolveServedRecommendation,
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
import { reconcileCanonicalAgainstSources } from "../../services/ledger/CanonicalShareReader.js";
import { NONE_PAYOUT_PROVIDER, resolvePayoutProvider } from "../../services/creators/PayoutProvider.js";
import { mintServeExposure, servedRecommendationId } from "../../lib/discoveryRecommendationRecord.js";
import { buildBookingEntries, buildReversal, type LedgerEntry } from "../../lib/creatorLedgerEntries.js";
import { RENT_BUDDY_FEE_RULE_VERSION, toEarningsEntryRow } from "../../lib/creatorLedgerRows.js";

const FLAG = "creator_attribution_enabled";
const on = () => creatorPsqlClient({ flags: { [FLAG]: true } });

const REPO = new URL("../../../../../", import.meta.url);
const sqlFile = (rel: string) => readFileSync(new URL(rel, REPO), "utf8");
const A_FORWARD = "reconciliation-staging/3511_creator_ledger_erasure_delete_on_erasure.sql";
const A_ROLLBACK = "reconciliation-staging/2026-09-30-3511-creator-ledger-erasure-delete-on-erasure-rollback.sql";
const B_FORWARD = "reconciliation-staging/3512_creator_ledger_erasure_retain_pseudonymised.sql";
const B_ROLLBACK = "reconciliation-staging/2026-09-30-3512-creator-ledger-erasure-retain-pseudonymised-rollback.sql";
const G_FORWARD = "artifacts/api-server/src/migrations/3510_creator_ledger_erasure_policy_undecided.sql";
const G_ROLLBACK = "db/rollback/2026-09-30-3510-creator-ledger-erasure-policy-undecided-rollback.sql";

// ── Synthetic identity ───────────────────────────────────────────────────────
const SYN = "c11e5e00";
const TEST_NOTE = "TEST FIXTURE (C-11 synthetic ledger, census-discovery §107) — not a production rule";
const TP_V951 = "creator-rules/travel-partner/v951";
const TP_V952 = "creator-rules/travel-partner/v952";

function synId(): string { return SYN + randomUUID().slice(8); }
function seedSynthetic(role: string): { id: string; handle: string } {
  const id = synId();
  const handle = `c11syn_${role}_${id.slice(9, 13)}`;
  exec(
    `INSERT INTO auth.users (id, email) VALUES ('${id}', '${handle}@synthetic-c11.invalid');\n` +
    `INSERT INTO public.profiles (id, handle, name) VALUES ('${id}', '${handle}', 'SYNTHETIC C-11 FIXTURE ${role}');`,
  );
  return { id, handle };
}

// ── The network trap: every primitive records and throws ─────────────────────
const reached: string[] = [];
const saved: Array<[any, string, any]> = [];
function trap(obj: any, key: string, label: string) {
  saved.push([obj, key, obj[key]]);
  obj[key] = (..._a: unknown[]) => { reached.push(label); throw new Error(`network primitive reached: ${label}`); };
}

/** psql as a given role, one transaction, verbose errors — so SQLSTATEs can be read. */
function attempt(script: string, role: "service_role" | "superuser" = "service_role") {
  return psql(`\\set VERBOSITY verbose\n${role === "service_role" ? "SET LOCAL ROLE service_role;\n" : ""}${script}`, { single: true });
}
function applyFile(rel: string): void {
  const r = psql(sqlFile(rel));
  if (r.status !== 0) throw new Error(`${rel} failed:\n${r.stderr}`);
}

/** Every row of the four ledgers, as text, for a before/after equality. */
function ledgerSnapshot(where = "true"): string[] {
  return rows<{ r: string }>(
    `SELECT r FROM (
       SELECT to_jsonb(t)::text AS r FROM public.rent_buddy_earnings_entries t WHERE ${where} UNION ALL
       SELECT to_jsonb(t)::text FROM public.creator_attributions t WHERE ${where} UNION ALL
       SELECT to_jsonb(t)::text FROM public.creator_earning_entries t WHERE ${where} UNION ALL
       SELECT to_jsonb(t)::text FROM public.creator_ledger_audit_events t WHERE ${where}) x ORDER BY r`,
  ).map((x) => x.r);
}
/** Ledger rows that mention `id` anywhere, in any column, any case. */
function mentions(id: string): number {
  return Number(scalar(
    `SELECT (SELECT count(*) FROM public.rent_buddy_earnings_entries t WHERE to_jsonb(t)::text ~* '${id}')
          + (SELECT count(*) FROM public.creator_attributions t WHERE to_jsonb(t)::text ~* '${id}')
          + (SELECT count(*) FROM public.creator_earning_entries t WHERE to_jsonb(t)::text ~* '${id}')
          + (SELECT count(*) FROM public.creator_ledger_audit_events t WHERE to_jsonb(t)::text ~* '${id}')`,
  ));
}
function unbalanced(): number {
  return Number(scalar(
    `SELECT (SELECT count(*) FROM (SELECT 1 FROM public.rent_buddy_earnings_entries GROUP BY transaction_key, currency HAVING sum(amount_minor) <> 0) a)
          + (SELECT count(*) FROM (SELECT 1 FROM public.creator_earning_entries GROUP BY transaction_key, currency HAVING sum(amount_minor) <> 0) b)`,
  ));
}

// ── The flows, run once per fixture database ─────────────────────────────────
interface World {
  C: string; Chandle: string; D: string; E: string; T: string; V: string; ADM: string;
  buddyC: string; bookingK: string; rid: string; item: string;
  c1: string; c1Head: string; c2: string; c2Head: string; d1: string; e1: string;
  c2FeeTx: string; rbeeGrossTx: string;
  users: string[];
}

function publish(version: string, params: Record<string, unknown>, ago: string): void {
  exec(
    `INSERT INTO public.creator_rule_versions (creator_type, rule_version, params, effective_from, note) VALUES ` +
    `('travel_partner', ${lit(version)}, ${lit(params)}::jsonb, now() - interval '${ago}', ${lit(TEST_NOTE)})`,
  );
}

async function recorded(beneficiary: string, gross: number, extra: Record<string, unknown> = {}): Promise<string> {
  const subject = synId();
  const r = await recordCreatorAttributionUnderRule(on(), {
    creatorType: "travel_partner", subjectId: subject, valueEventId: subject, beneficiaryUserId: beneficiary,
    weight: 1, confidence: 1, grossRevenueMinor: gross, fraudHold: false, fraudHoldReason: null, ...extra,
  } as any);
  assert.equal(r.ok, true, JSON.stringify(r));
  if (!r.ok) throw new Error("unreachable");
  return r.value.id;
}

async function runSyntheticLedger(): Promise<World> {
  const c = seedSynthetic("creator");
  const w = {
    C: c.id, Chandle: c.handle, D: seedSynthetic("control").id, E: seedSynthetic("creatorE").id,
    T: seedSynthetic("traveller").id, V: seedSynthetic("viewer").id, ADM: seedSynthetic("admin").id,
  } as World;
  w.users = [w.C, w.D, w.E, w.T, w.V, w.ADM];
  exec(`UPDATE public.profiles SET role = 'admin' WHERE id = '${w.ADM}';`);
  const admin = { kind: "admin" as const, userId: w.ADM };
  publish(TP_V951, { creator_share_ppm: 700000, platform_fee_ppm: 200000 }, "10 seconds");

  // ── Rent-a-Buddy: a completed booking, its double-entry legs, a refund ──
  w.buddyC = scalar(`INSERT INTO public.rent_buddy_profiles (user_id, city) VALUES ('${w.C}', 'SYNTHETIC-C11') RETURNING id`)!;
  w.bookingK = synId();
  exec(
    `INSERT INTO public.rent_buddy_bookings (id, buddy_id, traveler_id, booking_date, duration_h, city, category, status) ` +
    `VALUES ('${w.bookingK}', '${w.buddyC}', '${w.T}', current_date, 2, 'SYNTHETIC-C11', 'local_guide', 'completed');`,
  );
  const built = buildBookingEntries({
    bookingId: w.bookingK, beneficiaryUserId: w.C, ruleVersion: RENT_BUDDY_FEE_RULE_VERSION,
    totalUsd: 120, tipUsd: 10, platformFeeUsd: 24, travelerServiceFeeUsd: 0, collectedMinor: 0,
  });
  assert.equal(built.status, "built");
  if (built.status !== "built") throw new Error("unreachable");
  const rbeeRows = built.entries.map((e) => toEarningsEntryRow(e, w.bookingK));
  for (let i = 0; i < 2; i++) { // the writer's own call shape; the second is a replay
    const { error } = await on().from("rent_buddy_earnings_entries").upsert(rbeeRows, { onConflict: "idempotency_key", ignoreDuplicates: true });
    assert.equal(error, null, JSON.stringify(error));
  }
  w.rbeeGrossTx = built.entries.find((e) => e.entryReason === "booking_gross")!.transactionKey;
  // The refund: buildReversal's negation, its entry ids resolved to the rows' uuids.
  const rev = buildReversal(built.entries, { transactionKey: w.rbeeGrossTx });
  assert.equal(rev.status, "reversed");
  if (rev.status !== "reversed") throw new Error("unreachable");
  const idOf = new Map(rows<{ id: string; idempotency_key: string }>(
    `SELECT id, idempotency_key FROM public.rent_buddy_earnings_entries WHERE booking_id = '${w.bookingK}'`).map((r) => [r.idempotency_key, r.id]));
  const revRows = rev.entries.map((e: LedgerEntry) => ({ ...toEarningsEntryRow({ ...e, reversesEntryId: null }, w.bookingK), reverses_entry_id: idOf.get(e.reversesEntryId!) }));
  const { error: revErr } = await on().from("rent_buddy_earnings_entries").upsert(revRows, { onConflict: "idempotency_key", ignoreDuplicates: true });
  assert.equal(revErr, null, JSON.stringify(revErr));

  // ── The Travel Partner producer attributes the completed booking (DV-56) ──
  const tally = await attributeCompletedTravelPartnerBookings(on());
  assert.equal(tally.ok, true, JSON.stringify(tally));

  // ── A served recommendation, bound to the converting viewer (3386) ──
  w.item = `node/c11syn-${w.C.slice(9, 13)}`;
  const e = mintServeExposure(w.V, randomUUID(), new Date(Date.now() - 60_000));
  w.rid = servedRecommendationId(e, 0, w.item);
  exec(
    `INSERT INTO public.rank_events (user_id, item_id, item_kind, position, outcome, served_at, surface, session_id, recommendation_id) ` +
    `VALUES ('${w.V}', ${lit(w.item)}, 'place', 0, 'tap', ${lit(e.servedAt)}, 'discovery', '${e.sessionId}', ${lit(w.rid)});`,
  );
  const bound = await resolveServedRecommendation(on(), { viewerUserId: w.V, recommendationId: w.rid, itemId: w.item, occurredAt: new Date().toISOString() });
  assert.equal(bound.ok, true, JSON.stringify(bound));
  if (!bound.ok) throw new Error("unreachable");

  // ── Earnings: C twice (one linked to the recommendation), D, E ──
  w.c1 = await recorded(w.C, 10_000, { recommendation: bound.value });
  assert.equal((await bookCreatorEarningUnderRule(on(), w.c1)).ok, true);
  w.c2 = await recorded(w.C, 4_000);
  w.d1 = await recorded(w.D, 5_000);
  assert.equal((await bookCreatorEarningUnderRule(on(), w.d1)).ok, true);
  w.e1 = await recorded(w.E, 3_000);
  assert.equal((await bookCreatorEarningUnderRule(on(), w.e1)).ok, true);

  // ── Hold, a refused booking, release, then the booking (DV-59) ──
  const hold = await placeCreatorHold(on(), { attributionId: w.c2, reason: `SYNTHETIC: suspected fake visits by ${w.Chandle}`, actor: admin });
  assert.equal(hold.ok, true, JSON.stringify(hold));
  const whileHeld = await bookCreatorEarningUnderRule(on(), hold.ok ? hold.value.resultingAttributionId! : "");
  assert.equal(whileHeld.ok, false, "nothing is earned against a held attribution");
  const rel = await releaseCreatorHold(on(), { attributionId: w.c2, reason: "SYNTHETIC: cleared on review", actor: admin });
  assert.equal(rel.ok, true, JSON.stringify(rel));
  w.c2Head = rel.ok ? rel.value.resultingAttributionId! : "";
  assert.equal((await bookCreatorEarningUnderRule(on(), w.c2Head)).ok, true);
  const eHold = await placeCreatorHold(on(), { attributionId: w.e1, reason: "SYNTHETIC: E hold", actor: admin });
  assert.equal(eHold.ok, true);
  assert.equal((await releaseCreatorHold(on(), { attributionId: w.e1, reason: "SYNTHETIC: E release", actor: admin })).ok, true);

  // ── A refund on the creator ledger: the platform-fee transaction, reversed ──
  w.c2FeeTx = scalar(`SELECT transaction_key FROM public.creator_earning_entries WHERE attribution_id = '${w.c2Head}' AND entry_reason = 'platform_fee' LIMIT 1`)!;
  assert.equal((await reverseCreatorTransaction(on(), { transactionKey: w.c2FeeTx, reason: "SYNTHETIC: refund", actor: admin })).ok, true);

  // ── Recompute c1 under a newer published version (DV-60) ──
  publish(TP_V952, { creator_share_ppm: 600000, platform_fee_ppm: 250000 }, "1 second");
  const rc = await recomputeCreatorAttribution(on(), { attributionId: w.c1, reason: "SYNTHETIC: rule v952 published", actor: admin });
  assert.equal(rc.ok, true, JSON.stringify(rc));
  w.c1Head = rc.ok ? rc.value.resultingAttributionId! : "";
  return w;
}

/** Folds of a set of ledger rows, keyed so a before/after comparison is exact. */
function foldsWhere(creatorWhere: string, rbeeWhere: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows<{ k: string; v: string }>(
    `SELECT 'cee|' || account || '|' || entry_reason || '|' || rule_version AS k, sum(amount_minor)::text AS v
       FROM public.creator_earning_entries WHERE ${creatorWhere} GROUP BY 1
     UNION ALL
     SELECT 'rbee|' || account || '|' || entry_reason, sum(amount_minor)::text
       FROM public.rent_buddy_earnings_entries WHERE ${rbeeWhere} GROUP BY 1`,
  )) out[r.k] = r.v;
  return out;
}

// ═════════════════════════════════════════════════════════════════════════════
const fixtures: Record<"A" | "B", string> = { A: "", B: "" };
const cloneName = (k: string) => `c11_fixture_${k.toLowerCase()}_${process.pid}`;
function urlFor(db: string): string { const u = new URL(LOCAL_DB_URL); u.pathname = `/${db}`; return u.toString(); }

describe("the creator ledger on synthetic accounts, and C-11 answered three ways (census-discovery §107)", { skip: !HAVE_DB }, () => {
  before(() => {
    trap(globalThis, "fetch", "fetch");
    trap(http, "request", "http.request"); trap(http, "get", "http.get");
    trap(https, "request", "https.request"); trap(https, "get", "https.get");
    trap(net, "connect", "net.connect"); trap(net, "createConnection", "net.createConnection");
    trap(tls, "connect", "tls.connect"); trap(dns, "lookup", "dns.lookup");
    // Two clones of the harness taken BEFORE any row of this suite exists.
    const main = new URL(LOCAL_DB_URL).pathname.slice(1);
    useDatabase(urlFor("postgres"));
    for (const k of ["A", "B"] as const) {
      exec(`DROP DATABASE IF EXISTS "${cloneName(k)}";`);
      exec(`CREATE DATABASE "${cloneName(k)}" TEMPLATE "${main}";`);
      fixtures[k] = urlFor(cloneName(k));
    }
    useDatabase(null);
  });

  after(() => {
    useDatabase(urlFor("postgres"));
    for (const k of ["A", "B"] as const) exec(`DROP DATABASE IF EXISTS "${cloneName(k)}";`);
    useDatabase(null);
    for (const [o, k, v] of saved.reverse()) o[k] = v;
  });

  // ── MAIN: the flows, then C-11 undecided ───────────────────────────────────
  describe("MAIN — the harness chain, 3510 applied: C-11 undecided", () => {
    let w: World;
    before(async () => { useDatabase(null); w = await runSyntheticLedger(); });
    // By the synthetic PREFIX, not by `w`: a flow that fails half-way must not
    // leave its rows behind for the next suite (or the next fixture clone).
    after(() => exec(purgeSyntheticSql()));

    test("F1. earnings are recorded as balanced double entry, provider 'none', no settlement, on both ledgers", () => {
      const cee = rows<any>(`SELECT account, amount_minor::bigint AS a, provider, cash_settled_minor::bigint AS s, external_ref FROM public.creator_earning_entries WHERE attribution_id = '${w.d1}' AND entry_reason <> 'reversal' ORDER BY account, amount_minor`);
      assert.deepEqual(cee.map((r) => [r.account, Number(r.a)]), [["creator_payable", 3500], ["platform_revenue", 1000], ["traveler_receivable", -3500], ["traveler_receivable", -1000]]);
      assert.ok(cee.every((r) => r.provider === "none" && Number(r.s) === 0 && r.external_ref === null));
      const rbee = rows<any>(`SELECT account, entry_reason, sum(amount_minor)::bigint AS a FROM public.rent_buddy_earnings_entries WHERE booking_id = '${w.bookingK}' AND entry_reason <> 'reversal' GROUP BY 1, 2 ORDER BY 2, 1`);
      assert.ok(rbee.length >= 4, JSON.stringify(rbee));
      assert.equal(Number(scalar(`SELECT count(*) FROM public.rent_buddy_earnings_entries WHERE booking_id = '${w.bookingK}' AND (provider <> 'none' OR cash_settled_minor <> 0)`)), 0);
      assert.equal(Number(scalar(`SELECT count(*) FROM public.rent_buddy_earnings_entries WHERE booking_id = '${w.bookingK}'`)),
        Number(scalar(`SELECT count(DISTINCT idempotency_key) FROM public.rent_buddy_earnings_entries WHERE booking_id = '${w.bookingK}'`)), "the replayed append wrote nothing twice");
      assert.equal(unbalanced(), 0, "every transaction sums to zero per currency");
    });

    test("F2. a refund is a negation appended ONCE, on both ledgers; a second, and a non-negating one, are refused", async () => {
      const cee = rows<any>(`SELECT o.amount_minor::bigint AS o, r.amount_minor::bigint AS r FROM public.creator_earning_entries r JOIN public.creator_earning_entries o ON o.id = r.reverses_entry_id WHERE o.transaction_key = ${lit(w.c2FeeTx)}`);
      assert.ok(cee.length === 2 && cee.every((x) => Number(x.r) === -Number(x.o)), JSON.stringify(cee));
      const again = await reverseCreatorTransaction(on(), { transactionKey: w.c2FeeTx, reason: "SYNTHETIC: again", actor: { kind: "admin", userId: w.ADM } });
      assert.deepEqual([again.ok, !again.ok && again.reason], [false, "already_reversed"]);
      const rbee = rows<any>(`SELECT o.amount_minor::bigint AS o, r.amount_minor::bigint AS r FROM public.rent_buddy_earnings_entries r JOIN public.rent_buddy_earnings_entries o ON o.id = r.reverses_entry_id WHERE o.transaction_key = ${lit(w.rbeeGrossTx)}`);
      assert.ok(rbee.length >= 2 && rbee.every((x) => Number(x.r) === -Number(x.o)), JSON.stringify(rbee));
      const orig = rows<any>(`SELECT * FROM public.rent_buddy_earnings_entries WHERE transaction_key = ${lit(w.rbeeGrossTx)} LIMIT 1`)[0];
      const twice = attempt(`INSERT INTO public.rent_buddy_earnings_entries (transaction_key, booking_id, account, entry_reason, amount_minor, rule_version, attribution_kind, attribution_id, reverses_entry_id, idempotency_key) VALUES ('c11syn-again', '${w.bookingK}', ${lit(orig.account)}, 'reversal', ${-Number(orig.amount_minor)}, ${lit(orig.rule_version)}, 'booking', '${w.bookingK}', '${orig.id}', 'c11syn-again#0');`);
      assert.match(twice.stderr, /23505/, "a second reversal of one entry is refused");
      const origC = rows<any>(`SELECT * FROM public.creator_earning_entries WHERE attribution_id = '${w.d1}' AND account = 'creator_payable' LIMIT 1`)[0];
      const partial = attempt(`INSERT INTO public.creator_earning_entries (transaction_key, creator_type, attribution_id, account, entry_reason, amount_minor, rule_version, beneficiary_user_id, reverses_entry_id, idempotency_key) VALUES ('c11syn-partial', 'travel_partner', '${w.d1}', 'creator_payable', 'reversal', -1, ${lit(origC.rule_version)}, '${w.D}', '${origC.id}', 'c11syn-partial#0');`);
      assert.match(partial.stderr, /reversal_is_not_a_negation/);
    });

    test("F3. attribution to a served recommendation: the bound id is stored and carried through the recompute; another viewer's id binds nothing", async () => {
      assert.equal(scalar(`SELECT recommendation_id FROM public.creator_attributions WHERE id = '${w.c1}'`), w.rid);
      assert.equal(scalar(`SELECT recommendation_id FROM public.creator_attributions WHERE id = '${w.c1Head}'`), w.rid);
      const cross = await resolveServedRecommendation(on(), { viewerUserId: w.D, recommendationId: w.rid });
      assert.deepEqual([cross.ok, !cross.ok && cross.reason], [false, "recommendation_not_found"]);
      assert.equal(Number(scalar(`SELECT count(*) FROM public.creator_attributions WHERE subject_id = '${w.bookingK}' AND beneficiary_user_id = '${w.C}' AND creator_type = 'travel_partner'`)), 1, "the producer attributed the completed booking to its buddy");
    });

    test("F4. a hold and its release are audited with actor and reason; nothing was earned while held", async () => {
      const trail = await readCreatorLedgerAuditTrail(on(), w.c2);
      assert.equal(trail.ok, true);
      if (!trail.ok) return;
      assert.deepEqual(trail.value.audit.map((a: any) => [a.action, a.actor_user_id]), [["hold_placed", w.ADM], ["hold_released", w.ADM], ["reversed", w.ADM]]);
      assert.ok(trail.value.audit.every((a: any) => String(a.reason).startsWith("SYNTHETIC:")));
      const held = trail.value.chain.find((r) => r.fraud_hold === true)!;
      assert.equal(Number(scalar(`SELECT count(*) FROM public.creator_earning_entries WHERE attribution_id = '${held.id}'`)), 0);
      assert.deepEqual(trail.value.unbalancedTransactions, []);
    });

    test("F5. recompute: superseded under v951, every live leg reversed exactly, rebooked under v952; the v951 answer stays readable", () => {
      const by = rows<any>(`SELECT rule_version, entry_reason, sum(amount_minor)::bigint AS s FROM public.creator_earning_entries WHERE attribution_id IN ('${w.c1}', '${w.c1Head}') AND account = 'creator_payable' GROUP BY 1, 2 ORDER BY 1, 2`);
      assert.deepEqual(by.map((r) => [r.rule_version, r.entry_reason, Number(r.s)]),
        [[TP_V951, "revenue_share", 7000], [TP_V951, "reversal", -7000], [TP_V952, "revenue_share", 6000]]);
      assert.equal(scalar(`SELECT supersedes_id FROM public.creator_attributions WHERE id = '${w.c1Head}'`), w.c1);
    });

    test("F6. folds and summaries: the creator's server-side summary equals an independent SQL fold of the canonical view, and both ledgers reconcile both ways", async () => {
      const mine = await readMyCreatorLedger(on(), w.C);
      assert.equal(mine.ok, true, JSON.stringify(mine));
      if (!mine.ok) return;
      for (const b of mine.value.earnings.buckets) {
        const sql = scalar(`SELECT coalesce(sum(amount), 0)::bigint FROM public.creator_share_ledger WHERE creator_id = '${w.C}' AND party_role = 'creator' AND source_ledger = ${lit(b.sourceLedger)} AND unit_code = ${lit(b.unitCode)}`);
        assert.equal(String(b.lifetimeNet), sql, `${b.sourceLedger} lifetime fold`);
        assert.equal(b.available, 0, "nothing is ever payable");
      }
      const cee = mine.value.earnings.buckets.find((b) => b.sourceLedger === "creator_earning_entries")!;
      // 7000 − 7000 (recomputed away) + 6000 (v952) + 2800 (c2) = 8800, all provisional after the release.
      assert.deepEqual([cee.provisional, cee.held, cee.reversedNet, cee.lifetimeNet], [8800, 0, 0, 8800]);
      assert.ok(mine.value.earnings.buckets.some((b) => b.sourceLedger === "rent_buddy_earnings_entries"), "the Rent-a-Buddy legs reach the creator's summary");
      const rec = await reconcileCanonicalAgainstSources(on(), { pageSize: 7 });
      assert.equal(rec.ok && rec.value.ok, true, JSON.stringify(rec));
    });

    test("F7. no money moves: the only payout provider is 'none', it answers payouts_disabled, and no network primitive was reached by any flow", async () => {
      const p = resolvePayoutProvider(process.env["CREATOR_PAYOUT_PROVIDER"]);
      assert.equal(p.ok && p.provider.id, "none");
      assert.equal(resolvePayoutProvider("stripe").ok, false, "no real provider can be selected");
      const payout = await NONE_PAYOUT_PROVIDER.requestPayout({ creatorId: w.C, amountMinor: 8800, currency: "USD", idempotencyKey: "c11syn-payout" });
      assert.deepEqual([payout.ok, !payout.ok && payout.reason], [false, "payouts_disabled"]);
      assert.deepEqual(reached, [], "no network primitive was reached");
    });

    test("G1. C-11 undecided: erasing a creator (hard DELETE of the profile, as service_role) is refused CL451 and changes nothing", () => {
      const before = ledgerSnapshot();
      const r = attempt(`DELETE FROM public.profiles WHERE id = '${w.E}';`);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /CL451/);
      assert.match(r.stderr, /creator_ledger_erasure_policy_undecided/);
      assert.deepEqual(ledgerSnapshot(), before);
      assert.equal(scalar(`SELECT count(*) FROM public.profiles WHERE id = '${w.E}'`), "1");
    });

    test("G2. a TRAVELLER's erasure cascades through their booking into the buddy's earning entries — refused CL451, nothing changed", () => {
      const before = ledgerSnapshot();
      const r = attempt(`DELETE FROM public.profiles WHERE id = '${w.T}';`);
      assert.match(r.stderr, /CL451/);
      assert.match(r.stderr, /rent_buddy_earnings_entries/);
      assert.deepEqual(ledgerSnapshot(), before);
    });

    test("G3. a direct DELETE of any ledger row is refused CL451, as service_role and as the superuser, on all four tables", () => {
      for (const t of ["rent_buddy_earnings_entries", "creator_attributions", "creator_earning_entries", "creator_ledger_audit_events"]) {
        for (const role of ["service_role", "superuser"] as const) {
          const r = attempt(`DELETE FROM public.${t} WHERE id = (SELECT id FROM public.${t} LIMIT 1);`, role);
          assert.match(r.stderr, /CL451/, `${t} as ${role}`);
        }
      }
    });

    test("G4. the guard is ROW-level: a person with no ledger row is erased normally, and a DELETE that matches no row succeeds", () => {
      const nobody = seedSynthetic("noledger").id;
      const r = attempt(`DELETE FROM public.profiles WHERE id = '${nobody}';`);
      assert.equal(r.status, 0, r.stderr);
      exec(`DELETE FROM auth.users WHERE id = '${nobody}';`);
      assert.equal(attempt(`DELETE FROM public.creator_attributions WHERE false;`).status, 0);
    });

    test("G5. 2901's SET NULL is gone: no key from a ledger table to profiles is SET NULL / SET DEFAULT (that would be an UPDATE the ledger refuses)", () => {
      assert.equal(scalar(
        `SELECT count(*) FROM pg_constraint WHERE contype = 'f' AND confdeltype IN ('n', 'd') AND conrelid IN
          ('public.rent_buddy_earnings_entries'::regclass, 'public.creator_attributions'::regclass, 'public.creator_earning_entries'::regclass, 'public.creator_ledger_audit_events'::regclass)`), "0");
    });

    test("G6. 3510's rollback REFUSES while ledger rows exist, and changes nothing", () => {
      const before = ledgerSnapshot();
      const r = psql(sqlFile(G_ROLLBACK));
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /ROLLBACK REFUSED \(3510\)/);
      assert.equal(scalar(`SELECT count(*) FROM pg_trigger WHERE tgfoid = 'public.creator_ledger_erasure_policy_undecided()'::regprocedure`), "4");
      assert.deepEqual(ledgerSnapshot(), before);
    });

    test("S1. separation: every ledger row in MAIN belongs to a synthetic account", () => {
      assertOnlySynthetic();
    });
  });

  // ── A: delete on erasure ───────────────────────────────────────────────────
  describe("FIXTURE A — its own database, 3511 applied: delete on the beneficiary's erasure", () => {
    let w: World;
    before(async () => {
      useDatabase(fixtures.A);
      // Rehearse 3510 and 3511 in this database while the ledgers are empty:
      // 3510 rollback -> re-apply; 3511 apply -> re-apply -> rollback -> re-apply.
      applyFile(G_ROLLBACK);
      assert.equal(scalar(`SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.rent_buddy_earnings_entries'::regclass AND contype = 'f' AND confrelid = 'public.profiles'::regclass AND confdeltype = 'n'`), "1", "3510's rollback restores 2901 exactly");
      applyFile(G_FORWARD);
      applyFile(A_FORWARD); applyFile(A_FORWARD); applyFile(A_ROLLBACK);
      assert.equal(scalar(`SELECT count(*) FROM pg_trigger WHERE tgfoid = 'public.creator_ledger_erasure_policy_undecided()'::regprocedure`), "4", "A's rollback re-installs 3510's guard");
      applyFile(A_FORWARD);
      w = await runSyntheticLedger();
    });
    after(() => useDatabase(null));

    test("A1. no direct DELETE: service_role no longer holds DELETE on any ledger table", () => {
      for (const t of ["rent_buddy_earnings_entries", "creator_attributions", "creator_earning_entries", "creator_ledger_audit_events"]) {
        const r = attempt(`DELETE FROM public.${t} WHERE true;`);
        assert.match(r.stderr, /42501/, t);
      }
    });

    test("A2. a counterparty's erasure is not the beneficiary's: the TRAVELLER's hard delete is refused and the buddy's entries stay", () => {
      const before = ledgerSnapshot();
      const r = attempt(`DELETE FROM public.profiles WHERE id = '${w.T}';`);
      assert.match(r.stderr, /creator_ledger_not_an_erasure/);
      assert.deepEqual(ledgerSnapshot(), before);
    });

    test("A3. erasing the creator through the door deletes every record whose beneficiary they are — whole transactions, reversals, chains and audit rows — and nothing of anyone else's", async () => {
      const dBefore = ledgerSnapshot(`to_jsonb(t)::text ~* '${w.D}'`);
      const dShares = foldsWhere(`beneficiary_user_id = '${w.D}'`, "false");
      assert.ok(mentions(w.C) > 0);
      const r = attempt(`SELECT public.creator_ledger_erase_beneficiary('${w.C}', 'admin', '${w.ADM}', 'SYNTHETIC: account erasure');`);
      assert.equal(r.status, 0, r.stderr);
      const counts = JSON.parse(r.stdout.trim().split("\n").pop()!);
      assert.ok(counts.rent_buddy_earnings_entries > 0 && counts.creator_attributions > 0 && counts.creator_earning_entries > 0 && counts.creator_ledger_audit_events > 0, JSON.stringify(counts));
      assert.equal(mentions(w.C), 0, "no ledger row names the erased creator anywhere");
      assert.equal(Number(scalar(`SELECT count(*) FROM public.rent_buddy_earnings_entries WHERE booking_id = '${w.bookingK}'`)), 0, "the platform and traveller legs went with the buddy leg");
      assert.equal(unbalanced(), 0, "no half-transaction was left behind");
      assert.deepEqual(ledgerSnapshot(`to_jsonb(t)::text ~* '${w.D}'`), dBefore, "another creator's records are untouched");
      assert.deepEqual(foldsWhere(`beneficiary_user_id = '${w.D}'`, "false"), dShares);
      assert.equal(Number(scalar(`SELECT count(*) FROM public.creator_share_ledger WHERE creator_id = '${w.C}'`)), 0);
      const receipt = rows<any>(`SELECT to_jsonb(r)::text AS r FROM public.creator_ledger_erasures r`);
      assert.equal(receipt.length, 1);
      assert.doesNotMatch(receipt[0].r, new RegExp(w.C, "i"), "the receipt names no subject");
      const rec = await reconcileCanonicalAgainstSources(on(), { pageSize: 7 });
      assert.equal(rec.ok && rec.value.ok, true, JSON.stringify(rec));
    });

    test("A4. the hard-delete path: deleting a creator's profile cascades their whole creator ledger away, audit rows included", () => {
      assert.ok(mentions(w.E) > 0);
      const r = attempt(`DELETE FROM public.profiles WHERE id = '${w.E}';`);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(mentions(w.E), 0);
      assert.equal(unbalanced(), 0);
    });

    test("A5. what A-erasure does NOT reach, pinned: the booking row (Rent-a-Buddy's) still names the erased buddy's profile and the traveller", () => {
      assert.equal(scalar(`SELECT p.user_id FROM public.rent_buddy_bookings b JOIN public.rent_buddy_profiles p ON p.id = b.buddy_id WHERE b.id = '${w.bookingK}'`), w.C);
    });

    test("A6. the erase door refuses a missing reason or an unknown actor kind, and no client role can execute it", () => {
      assert.match(attempt(`SELECT public.creator_ledger_erase_beneficiary('${w.D}', 'admin', '${w.ADM}', ' ');`).stderr, /a reason is required/);
      assert.match(attempt(`SELECT public.creator_ledger_erase_beneficiary('${w.D}', 'robot', '${w.ADM}', 'x');`).stderr, /actor_kind/);
      assert.equal(scalar(`SELECT has_function_privilege('authenticated', 'public.creator_ledger_erase_beneficiary(uuid,text,uuid,text)', 'EXECUTE')::text`), "false");
      assert.ok(mentions(w.D) > 0, "the refusals erased nothing");
    });

    test("A7. no path leaves a half-transaction: legs whose beneficiary is hard-deleted take their platform and traveller siblings, and their reversal, with them", async () => {
      // The ledger does not tie a leg's beneficiary to the booking's buddy, so a
      // beneficiary with no buddy profile of their own can be hard-deleted; that
      // cascade reaches only the beneficiary legs, and 3511 must finish the job.
      const x = seedSynthetic("orphanbeneficiary").id;
      const k2 = synId();
      exec(`INSERT INTO public.rent_buddy_bookings (id, buddy_id, traveler_id, booking_date, duration_h, city, category, status) VALUES ('${k2}', '${w.buddyC}', '${w.T}', current_date, 1, 'SYNTHETIC-C11', 'local_guide', 'completed');`);
      const b = buildBookingEntries({ bookingId: k2, beneficiaryUserId: x, ruleVersion: RENT_BUDDY_FEE_RULE_VERSION, totalUsd: 50, tipUsd: 0, platformFeeUsd: 10, travelerServiceFeeUsd: 0, collectedMinor: 0 });
      if (b.status !== "built") throw new Error("unreachable");
      assert.equal((await on().from("rent_buddy_earnings_entries").upsert(b.entries.map((e) => toEarningsEntryRow(e, k2)), { onConflict: "idempotency_key", ignoreDuplicates: true })).error, null);
      const tk = b.entries.find((e) => e.entryReason === "booking_gross")!.transactionKey;
      const rv = buildReversal(b.entries, { transactionKey: tk });
      if (rv.status !== "reversed") throw new Error("unreachable");
      const ids = new Map(rows<{ id: string; idempotency_key: string }>(`SELECT id, idempotency_key FROM public.rent_buddy_earnings_entries WHERE booking_id = '${k2}'`).map((r) => [r.idempotency_key, r.id]));
      assert.equal((await on().from("rent_buddy_earnings_entries").upsert(rv.entries.map((e) => ({ ...toEarningsEntryRow({ ...e, reversesEntryId: null }, k2), reverses_entry_id: ids.get(e.reversesEntryId!) })), { onConflict: "idempotency_key", ignoreDuplicates: true })).error, null);
      assert.ok(Number(scalar(`SELECT count(*) FROM public.rent_buddy_earnings_entries WHERE booking_id = '${k2}' AND beneficiary_user_id IS NULL`)) > 0, "platform/traveller legs name nobody");
      const r = attempt(`DELETE FROM public.profiles WHERE id = '${x}';`);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(Number(scalar(`SELECT count(*) FROM public.rent_buddy_earnings_entries WHERE booking_id = '${k2}'`)), 0);
      assert.equal(unbalanced(), 0);
    });

    test("S1. separation: every ledger row in fixture A belongs to a synthetic account", () => {
      assertOnlySynthetic();
    });
  });

  // ── B: retain, pseudonymised ───────────────────────────────────────────────
  describe("FIXTURE B — its own database, 3512 applied: retain, identity removed", () => {
    let w: World;
    let cFoldsBefore: Record<string, string>;
    let cRowsBefore = 0;
    before(async () => {
      useDatabase(fixtures.B);
      applyFile(B_FORWARD); applyFile(B_FORWARD); applyFile(B_ROLLBACK);
      assert.equal(scalar(`SELECT count(*) FROM pg_trigger WHERE tgfoid = 'public.creator_ledger_erasure_policy_undecided()'::regprocedure`), "4", "B's rollback re-installs 3510's guard");
      applyFile(B_FORWARD);
      w = await runSyntheticLedger();
      cFoldsBefore = foldsWhere(
        `attribution_id IN (SELECT id FROM public.creator_attributions WHERE beneficiary_user_id = '${w.C}')`,
        `booking_id = '${w.bookingK}'`);
      cRowsBefore = mentions(w.C);
    });
    after(() => useDatabase(null));

    test("B1. retention: erasing the creator's profile, and any direct DELETE, is refused CL452 with the identity-removal hint", () => {
      const before = ledgerSnapshot();
      const r = attempt(`DELETE FROM public.profiles WHERE id = '${w.E}';`);
      assert.match(r.stderr, /CL452/);
      assert.match(r.stderr, /creator_ledger_remove_identity/);
      assert.match(attempt(`DELETE FROM public.creator_earning_entries WHERE id = (SELECT id FROM public.creator_earning_entries LIMIT 1);`, "superuser").stderr, /CL452/);
      assert.deepEqual(ledgerSnapshot(), before);
    });

    test("B2. identity removal: the creator's id is gone from every column of every ledger row, every row is retained under ONE fresh pseudonym, the folds are unchanged and every transaction still balances", () => {
      const total = ledgerSnapshot().length;
      const dBefore = ledgerSnapshot(`to_jsonb(t)::text ~* '${w.D}'`);
      const r = attempt(`SELECT public.creator_ledger_remove_identity('${w.C}', 'admin', '${w.ADM}', 'SYNTHETIC: account erasure');`);
      assert.equal(r.status, 0, r.stderr);
      const counts = JSON.parse(r.stdout.trim().split("\n").pop()!);
      assert.ok(counts.rent_buddy_earnings_entries > 0 && counts.creator_attributions > 0 && counts.creator_earning_entries > 0, JSON.stringify(counts));
      assert.equal(mentions(w.C), 0, "no column of any ledger row carries the creator's id, in any case");
      assert.equal(ledgerSnapshot().length, total, "every row is retained");
      const ps = rows<{ p: string }>(
        `SELECT DISTINCT beneficiary_pseudonym::text AS p FROM (
           SELECT beneficiary_pseudonym FROM public.creator_attributions UNION ALL
           SELECT beneficiary_pseudonym FROM public.creator_earning_entries UNION ALL
           SELECT beneficiary_pseudonym FROM public.rent_buddy_earnings_entries) x WHERE beneficiary_pseudonym IS NOT NULL`);
      assert.equal(ps.length, 1, "one pseudonym for the one person");
      const P = ps[0]!.p;
      assert.ok(!P.startsWith(SYN), "the pseudonym is fresh, not derived from the id");
      assert.equal(Number(scalar(`SELECT count(*) FROM public.creator_attributions WHERE beneficiary_pseudonym = '${P}' AND beneficiary_user_id IS NOT NULL`)), 0);
      assert.deepEqual(foldsWhere(
        `attribution_id IN (SELECT id FROM public.creator_attributions WHERE beneficiary_pseudonym = '${P}')`,
        `booking_id = '${w.bookingK}'`), cFoldsBefore, "the retained record says exactly what it said");
      assert.equal(mentions(P), cRowsBefore, "every row that named the person now names the pseudonym instead");
      assert.equal(unbalanced(), 0);
      assert.deepEqual(ledgerSnapshot(`to_jsonb(t)::text ~* '${w.D}'`), dBefore, "another creator's records are untouched");
      const receipt = rows<any>(`SELECT to_jsonb(r)::text AS r FROM public.creator_ledger_identity_removals r`);
      assert.equal(receipt.length, 1);
      assert.doesNotMatch(receipt[0].r, new RegExp(`${w.C}|${P}`, "i"), "the receipt names neither the person nor the pseudonym");
    });

    test("B3. PSEUDONYMISED, NOT ANONYMOUS — pinned: the retained rows still lead back to the person", () => {
      const P = scalar(`SELECT beneficiary_pseudonym::text FROM public.rent_buddy_earnings_entries WHERE beneficiary_pseudonym IS NOT NULL LIMIT 1`)!;
      // (1) booking_id -> rent_buddy_bookings -> rent_buddy_profiles.user_id: the person, outright.
      assert.equal(scalar(
        `SELECT DISTINCT p.user_id FROM public.rent_buddy_earnings_entries e JOIN public.rent_buddy_bookings b ON b.id = e.booking_id
           JOIN public.rent_buddy_profiles p ON p.id = b.buddy_id WHERE e.beneficiary_pseudonym = '${P}'`), w.C);
      // (2) the Travel Partner attribution's subject is the same booking.
      assert.equal(scalar(
        `SELECT DISTINCT p.user_id FROM public.creator_attributions a JOIN public.rent_buddy_bookings b ON b.id = a.subject_id
           JOIN public.rent_buddy_profiles p ON p.id = b.buddy_id WHERE a.beneficiary_pseudonym = '${P}'`), w.C);
      // (3) free text is scrubbed of the id only: the handle typed into a hold reason survives.
      assert.equal(Number(scalar(`SELECT count(*) FROM public.creator_attributions WHERE beneficiary_pseudonym = '${P}' AND fraud_hold_reason LIKE '%${w.Chandle}%'`)), 1);
      // (4) the served recommendation still joins to the viewer's exposure of the item.
      assert.equal(scalar(`SELECT r.user_id FROM public.creator_attributions a JOIN public.rank_events r ON r.recommendation_id = a.recommendation_id WHERE a.beneficiary_pseudonym = '${P}' LIMIT 1`), w.V);
      // (5) the tombstone profile keeps the same id the bookings name.
      assert.equal(scalar(`SELECT count(*) FROM public.profiles WHERE id = '${w.C}'`), "1");
    });

    test("B4. a pseudonymised record is frozen: no hold, no reversal, no entry, and nothing is inserted already pseudonymised", async () => {
      const head = scalar(`SELECT id FROM public.creator_attributions a WHERE beneficiary_pseudonym IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.creator_attributions s WHERE s.supersedes_id = a.id) AND creator_type = 'travel_partner' AND gross_revenue_minor > 0 LIMIT 1`)!;
      const before = ledgerSnapshot();
      const hold = await placeCreatorHold(on(), { attributionId: head, reason: "SYNTHETIC: after erasure", actor: { kind: "admin", userId: w.ADM } });
      assert.equal(hold.ok, false, JSON.stringify(hold));
      const tk = scalar(`SELECT transaction_key FROM public.creator_earning_entries WHERE attribution_id = '${head}' AND entry_reason = 'revenue_share' AND NOT EXISTS (SELECT 1 FROM public.creator_earning_entries r WHERE r.reverses_entry_id = creator_earning_entries.id) LIMIT 1`)!;
      const rev = await reverseCreatorTransaction(on(), { transactionKey: tk, reason: "SYNTHETIC: late refund", actor: { kind: "admin", userId: w.ADM } });
      assert.equal(rev.ok, false, JSON.stringify(rev));
      const direct = attempt(`INSERT INTO public.creator_attributions (creator_type, subject_kind, subject_id, value_event, value_event_id, attribution_basis, beneficiary_pseudonym, rule_version, idempotency_key) VALUES ('trail_builder', 'trail', gen_random_uuid(), 'route_completion', NULL, 'seam_no_producer', gen_random_uuid(), 'creator-rules/trail-builder/v1', 'c11syn-pseudo');`);
      assert.match(direct.stderr, /creator_ledger_pseudonym_on_insert/);
      assert.deepEqual(ledgerSnapshot(), before);
    });

    test("B5. the only UPDATE is the declared substitution: service_role has none, an undeclared one is append-only, a declared one that changes an amount is refused", () => {
      const id = scalar(`SELECT id FROM public.creator_earning_entries LIMIT 1`)!;
      assert.match(attempt(`UPDATE public.creator_earning_entries SET provider = 'none' WHERE id = '${id}';`).stderr, /42501/);
      assert.match(attempt(`UPDATE public.creator_earning_entries SET provider = 'none' WHERE id = '${id}';`, "superuser").stderr, /append-only/);
      const u = scalar(`SELECT coalesce(beneficiary_user_id, '${w.D}')::text FROM public.creator_earning_entries WHERE id = '${id}'`)!;
      const forged = attempt(
        `SELECT set_config('portava.creator_ledger_identity_removal', '${u}|${randomUUID()}', true);\n` +
        `UPDATE public.creator_earning_entries SET amount_minor = amount_minor + 1 WHERE id = '${id}';`, "superuser");
      assert.match(forged.stderr, /changes_more_than_identity/);
    });

    test("B6. after identity removal the profile can be erased and the retained rows stay; a second person gets a DIFFERENT pseudonym", () => {
      const n = mentions(w.E);
      assert.ok(n > 0);
      assert.equal(attempt(`SELECT public.creator_ledger_remove_identity('${w.E}', 'system', NULL, 'SYNTHETIC: account erasure');`).status, 0);
      const r = attempt(`DELETE FROM public.profiles WHERE id = '${w.E}';`);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(mentions(w.E), 0);
      assert.equal(Number(scalar(`SELECT count(DISTINCT beneficiary_pseudonym) FROM public.creator_attributions WHERE beneficiary_pseudonym IS NOT NULL`)), 2);
    });

    test("B7. 3512's rollback REFUSES while any row is pseudonymised", () => {
      const r = psql(sqlFile(B_ROLLBACK));
      assert.match(r.stderr, /ROLLBACK REFUSED \(3512\)/);
    });

    test("B8. the door refuses an actor who is the subject, and a missing reason", () => {
      assert.match(attempt(`SELECT public.creator_ledger_remove_identity('${w.D}', 'admin', '${w.D}', 'x');`).stderr, /actor may not be the subject/);
      assert.match(attempt(`SELECT public.creator_ledger_remove_identity('${w.D}', 'admin', '${w.ADM}', '');`).stderr, /a reason is required/);
      assert.ok(mentions(w.D) > 0);
    });

    test("S1. separation: every ledger row in fixture B belongs to a synthetic account (or to a pseudonym that replaced one)", () => {
      assertOnlySynthetic();
    });
  });

  test("R1. the flag row is FALSE in MAIN and in both fixtures: every flag-ON path ran on an in-memory answer", () => {
    for (const url of [null, fixtures.A, fixtures.B]) {
      useDatabase(url);
      assert.equal(scalar(`SELECT enabled::text FROM public.feature_flags WHERE flag = '${FLAG}'`), "false");
    }
    useDatabase(null);
  });
});

/**
 * Remove EVERYTHING this suite could have created, by the synthetic prefix, as
 * the harness superuser. The ledger rows need replica mode (3510 refuses their
 * deletion — see creatorLedgerPurgeSql); the rest is deleted children first.
 */
function purgeSyntheticSql(): string {
  const syn = `LIKE '${SYN}%'`;
  return [
    "SET session_replication_role = replica;",
    `DELETE FROM public.creator_ledger_audit_events WHERE attribution_id IN (SELECT id FROM public.creator_attributions WHERE beneficiary_user_id::text ${syn} OR subject_id::text ${syn});`,
    `DELETE FROM public.creator_earning_entries WHERE beneficiary_user_id::text ${syn} OR attribution_id IN (SELECT id FROM public.creator_attributions WHERE beneficiary_user_id::text ${syn} OR subject_id::text ${syn});`,
    `DELETE FROM public.creator_attributions WHERE beneficiary_user_id::text ${syn} OR subject_id::text ${syn};`,
    `DELETE FROM public.rent_buddy_earnings_entries WHERE booking_id::text ${syn} OR beneficiary_user_id::text ${syn};`,
    "SET session_replication_role = origin;",
    `DELETE FROM public.rent_buddy_bookings WHERE id::text ${syn};`,
    `DELETE FROM public.rent_buddy_profiles WHERE user_id::text ${syn};`,
    `DELETE FROM public.rank_events WHERE user_id::text ${syn};`,
    `DELETE FROM public.creator_rule_versions WHERE note = ${lit(TEST_NOTE)};`,
    `DELETE FROM public.profiles WHERE id::text ${syn};`,
    `DELETE FROM auth.users WHERE id::text ${syn};`,
  ].join("\n");
}

/** Every identified row belongs to a synthetic account; no other account's id appears anywhere. */
function assertOnlySynthetic(): void {
  const foreign = rows<any>(
    `SELECT 'rbee' AS t, beneficiary_user_id::text AS who FROM public.rent_buddy_earnings_entries WHERE beneficiary_user_id::text NOT LIKE '${SYN}%'
     UNION ALL SELECT 'rbee-booking', booking_id::text FROM public.rent_buddy_earnings_entries WHERE booking_id::text NOT LIKE '${SYN}%'
     UNION ALL SELECT 'ca', beneficiary_user_id::text FROM public.creator_attributions WHERE beneficiary_user_id::text NOT LIKE '${SYN}%'
     UNION ALL SELECT 'cee', beneficiary_user_id::text FROM public.creator_earning_entries WHERE beneficiary_user_id::text NOT LIKE '${SYN}%'
     UNION ALL SELECT 'clae', actor_user_id::text FROM public.creator_ledger_audit_events WHERE actor_user_id::text NOT LIKE '${SYN}%'`,
  );
  assert.deepEqual(foreign, [], "a ledger row names a non-synthetic account");
  assert.ok(Number(scalar(`SELECT count(*) FROM public.creator_attributions`)) > 0, "vacuous: the fixture holds no ledger row");
}
