/**
 * The double-entry payment ledger EXECUTED on a real PostgreSQL — migrations
 * 3821, 3822, 3823 (`09` §4–§7, §10; tasks PAY-T05, PAY-T06, PAY-T07).
 *
 * Two doors are used on purpose. The table-level groups (A) write as the
 * harness superuser — the table owner — so each refusal is the TABLE's and
 * would hold for any writer. The posting, read and erasure groups (B–E) run the
 * real `services/payments/PaymentLedger.ts` over `creatorLedgerPsqlClient`,
 * i.e. as `service_role` through the SQL functions, exactly as the API does.
 *
 * SYNTHETIC DATA ONLY. Profiles are seeded by `seedUser`, every transaction is
 * under scope `test-payb-<run>`, platform and processor parties carry labels
 * `t_…_<run>`, and after() removes every row this suite wrote.
 *
 * NO MONEY MOVES AND NO PROVIDER EXISTS HERE: the ledger records figures it is
 * handed, `livemode` is CHECK-constrained false, and nothing in the suite
 * reaches a network.
 *
 *   A1–A16  the tables: I1 balanced at COMMIT, I2/I3 append-only, I4 single
 *           currency, I5 non-zero and account currency, I7 attribution and
 *           idempotency, the nine account types, idempotent account creation,
 *           the seal, two different accounts, the credited beneficiary, the
 *           original amount tied to the entries
 *   B1–B9   the posting function: one transaction, replay, differing replay,
 *           named refusals, the balance floor, reversals, the write boundary,
 *           a balance out of range
 *   C1–C4   concurrency: both land, one key lands once, one payout wins, no deadlock
 *   D1–D6   party-scoped reads: each side only its side
 *   E1–E8   pseudonymisation: an open balance refuses or is explicitly retained,
 *           identity removed, balances and invariants unchanged
 *   G1–G4   regressions for what the independent verification of #598 found:
 *           pg_temp type shadowing, identifiers that survived erasure, two users
 *           sharing one client key
 *   F1–F2   the flag row is FALSE; everything still balances
 *
 * THE SAME SUITE RUNS ON TWO KINDS OF DATABASE and must pass on both: one with
 * Supabase-style default privileges (every new function executable by
 * service_role) and a plain one where a function has only the grants its
 * migration states. B7 asserts the privileges are IDENTICAL on both.
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { HAVE_DB, currentDatabaseUrl, exec, jsonLiteral, psql, rows, scalar, seedUser } from "./localDb.js";
import { creatorPsqlClient, pgError } from "./creatorLedgerPsqlClient.js";
import { paymentLedgerPurgeSql } from "./paymentLedgerFixture.js";
import { bindIdempotencyKey } from "../../lib/idempotencyKey.js";
import {
  ensurePaymentAccount,
  postPaymentTransaction,
  readPartyLedger,
  removePaymentIdentity,
  type PostPaymentTransactionInput,
} from "../../services/payments/PaymentLedger.js";

const RUN = randomUUID().slice(0, 8);
const SCOPE = `test-payb-${RUN}`;
const PLATFORM = `t_platform_${RUN}`;
const PROCESSOR = `t_processor_${RUN}`;
const DIRECT = `t_direct_${RUN}`;
const OVERFLOW = `t_overflow_${RUN}`;
const sc = creatorPsqlClient();

let payer = "", payee = "", stranger = "", other = "", erased = "", hardDeleted = "";
const users: string[] = [];
let aPayer = "", aPayee = "", aPayeeEur = "", aRevenue = "", aClearing = "", aRefunds = "", aOther = "";
const accounts: string[] = [];
/** account id -> the payment party that owns it (the pseudonym a person is named by). */
const partyOf: Record<string, string> = {};
/** A committed, balanced transaction written in A1: what A8 tries to reopen. */
let sealedTx = "";
/**
 * Group A writes rows DIRECTLY, as the table owner, to prove what the tables
 * refuse. A direct write goes around the posting function and therefore around
 * the projection, so those rows live on two accounts of their own, kept out of
 * `accounts` — the set whose projection B–E assert is the fold of its entries.
 */
let aDirA = "", aDirB = "";
const directAccounts: string[] = [];

/** One script as the table owner, verbose errors. Not wrapped: the script says where it commits. */
function owner(script: string) {
  const r = psql(`\\set VERBOSITY verbose\n${script}`);
  return { status: r.status, stdout: r.stdout, error: r.status === 0 ? null : pgError(r.stderr), stderr: r.stderr };
}
/** One statement as a given role, in one transaction. */
function as(role: "service_role" | "authenticated" | "anon", script: string) {
  const r = psql(`\\set VERBOSITY verbose\nSET LOCAL ROLE ${role};\n${script}`, { single: true });
  return { status: r.status, stdout: r.stdout, error: r.status === 0 ? null : pgError(r.stderr) };
}

async function account(
  ownerSpec: { kind: "user"; profileId: string } | { kind: "platform" | "processor"; label: string },
  accountType: any,
  currency: string,
): Promise<string> {
  const r = await ensurePaymentAccount(sc, { owner: ownerSpec, accountType, currency });
  assert.equal(r.ok, true, JSON.stringify(r));
  if (!r.ok) throw new Error("unreachable");
  if (!accounts.includes(r.accountId)) accounts.push(r.accountId);
  partyOf[r.accountId] = r.partyId;
  return r.accountId;
}

let seq = 0;
/** A booking capture: the payer owes, the payee earns principal and a tip, the platform earns its fee. */
function capture(over: Partial<PostPaymentTransactionInput> = {}): PostPaymentTransactionInput {
  seq += 1;
  const booking = `booking-${RUN}-${seq}`;
  return {
    scope: SCOPE,
    idempotencyKey: `${booking}:capture`,
    kind: "capture",
    currency: "USD",
    originalCurrency: "USD",
    originalAmountMinor: 11000,
    attribution: {
      causeKind: "booking", causeId: booking, subjectKind: "booking", subjectId: booking,
      beneficiaryAccountId: aPayee, attributionVersion: "test-rules/v1",
    },
    occurredAt: new Date().toISOString(),
    entries: [
      { accountId: aPayer, amountMinor: -11000, entryReason: "principal" },
      { accountId: aPayee, amountMinor: 9000, entryReason: "principal" },
      { accountId: aPayee, amountMinor: 1000, entryReason: "tip" },
      { accountId: aRevenue, amountMinor: 1000, entryReason: "platform_fee" },
    ],
    ...over,
  };
}

function balance(accountId: string): number {
  return Number(scalar(`SELECT coalesce((SELECT balance_minor FROM public.payment_account_balances WHERE account_id = '${accountId}'), 0)`));
}
function fold(accountId: string): number {
  return Number(scalar(`SELECT coalesce(sum(amount_minor), 0) FROM public.payment_ledger_entries WHERE account_id = '${accountId}'`));
}
const inList = (ids: readonly string[]) => (ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]).map((x) => `'${x}'`).join(",");

/** Accounts of this suite whose projection is not the fold of their entries. */
function drift(): number {
  return Number(scalar(
    `SELECT count(*) FROM (
       SELECT a.id FROM public.payment_accounts a
         LEFT JOIN public.payment_account_balances b ON b.account_id = a.id
         LEFT JOIN (SELECT account_id, sum(amount_minor) AS s, count(*) AS n FROM public.payment_ledger_entries GROUP BY account_id) l ON l.account_id = a.id
        WHERE a.id IN (${inList(accounts)})
          AND (coalesce(b.balance_minor, 0) <> coalesce(l.s, 0) OR coalesce(b.entry_count, 0) <> coalesce(l.n, 0))) x`,
  ));
}
/** Transactions of this suite that do not sum to zero, or have fewer than two entries. */
function unbalanced(): number {
  return Number(scalar(
    `SELECT count(*) FROM (
       SELECT t.id FROM public.payment_transactions t
         LEFT JOIN public.payment_ledger_entries e ON e.transaction_id = t.id
        WHERE t.scope = '${SCOPE}'
        GROUP BY t.id HAVING coalesce(sum(e.amount_minor), 0) <> 0 OR count(e.id) < 2) x`,
  ));
}
function transactionCount(): number {
  return Number(scalar(`SELECT count(*) FROM public.payment_transactions WHERE scope = '${SCOPE}'`));
}
/** Every ledger row of this suite as text, for a byte-for-byte before/after. */
function ledgerSnapshot(): string[] {
  return rows<{ r: string }>(
    `SELECT r FROM (
       SELECT 'tx ' || to_jsonb(t)::text AS r FROM public.payment_transactions t WHERE t.scope = '${SCOPE}' UNION ALL
       SELECT 'en ' || to_jsonb(e)::text FROM public.payment_ledger_entries e WHERE e.account_id IN (${inList(accounts)}) UNION ALL
       SELECT 'ac ' || to_jsonb(a)::text FROM public.payment_accounts a WHERE a.id IN (${inList(accounts)}) UNION ALL
       SELECT 'ba ' || to_jsonb(b)::text FROM public.payment_account_balances b WHERE b.account_id IN (${inList(accounts)})) x ORDER BY r`,
  ).map((x) => x.r);
}
/** Payment rows, in any table and any column, that mention `id`. */
function mentions(id: string): number {
  return Number(scalar(
    ["payment_parties", "payment_accounts", "payment_transactions", "payment_ledger_entries",
     "payment_account_balances", "payment_balance_rules", "payment_retention_settings"]
      .map((t) => `(SELECT count(*) FROM public.${t} x WHERE to_jsonb(x)::text ~* '${id}')`).join(" + ")
      .replace(/^/, "SELECT "),
  ));
}

/** An envelope written directly, as the owner. `cols` overrides any column with raw SQL. */
function envelopeSql(id: string, cols: Record<string, string> = {}): string {
  const c: Record<string, string> = {
    id: `'${id}'`, kind: `'capture'`, scope: `'${SCOPE}'`, idempotency_key: `'direct-${id}'`,
    content_hash: `repeat('a', 64)`, currency: `'USD'`, livemode: `false`, original_currency: `'USD'`,
    original_amount_minor: `500`, cause_kind: `'booking'`, cause_id: `'direct'`, subject_kind: `'booking'`,
    subject_id: `'direct'`, beneficiary_account_id: `'${aDirA}'`, attribution_version: `'test-rules/v1'`,
    occurred_at: `now()`, ...cols,
  };
  const keys = Object.keys(c);
  return `INSERT INTO public.payment_transactions (${keys.join(", ")}) VALUES (${keys.map((k) => c[k]).join(", ")});`;
}
function entrySql(tx: string, accountId: string, amount: number, currency = "USD", reason = "principal"): string {
  return `INSERT INTO public.payment_ledger_entries (transaction_id, account_id, amount_minor, currency, livemode, entry_reason) ` +
    `VALUES ('${tx}', '${accountId}', ${amount}, '${currency}', false, '${reason}');`;
}

interface AsyncResult { status: number; stdout: string; stderr: string }
/** One psql process, NOT awaited by the caller until all are started: real concurrency. */
function psqlAsync(script: string): Promise<AsyncResult> {
  return new Promise((resolve) => {
    const child = spawn("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-At", currentDatabaseUrl()], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ status: code ?? -1, stdout, stderr }));
    child.stdin.end(script);
  });
}
function postSql(payload: Record<string, unknown>): string {
  return `\\set VERBOSITY verbose\nSET ROLE service_role;\nSELECT public.payment_post_transaction(${jsonLiteral(payload)})::text;`;
}
function rawPayload(key: string, kind: string, entries: Array<[string, number, string]>, beneficiary: string): Record<string, unknown> {
  return {
    scope: SCOPE, idempotency_key: key, kind, currency: "USD", livemode: false,
    // In one currency the original amount IS the total of the credit entries.
    original_currency: "USD", original_amount_minor: entries.filter(([, a]) => a > 0).reduce((sum, [, a]) => sum + a, 0),
    cause_kind: "booking", cause_id: key, subject_kind: "booking", subject_id: key,
    beneficiary_account_id: beneficiary, attribution_version: "test-rules/v1",
    occurred_at: new Date().toISOString(),
    entries: entries.map(([account_id, amount_minor, entry_reason]) => ({ account_id, amount_minor, entry_reason })),
  };
}

describe("the payment ledger on a real database (09 §4-§7, §10; migrations 3821-3823)", { skip: !HAVE_DB }, () => {
  before(async () => {
    payer = seedUser("paybpayer"); payee = seedUser("paybpayee"); stranger = seedUser("paybstranger");
    other = seedUser("paybother"); erased = seedUser("payberased"); hardDeleted = seedUser("paybhard");
    users.push(payer, payee, stranger, other, erased, hardDeleted);
    aPayer = await account({ kind: "user", profileId: payer }, "user_receivable", "USD");
    aPayee = await account({ kind: "user", profileId: payee }, "user_payable", "USD");
    aPayeeEur = await account({ kind: "user", profileId: payee }, "user_payable", "EUR");
    aOther = await account({ kind: "user", profileId: other }, "user_payable", "USD");
    aRevenue = await account({ kind: "platform", label: PLATFORM }, "platform_revenue", "USD");
    aRefunds = await account({ kind: "platform", label: PLATFORM }, "refund_liability", "USD");
    aClearing = await account({ kind: "processor", label: PROCESSOR }, "processor_clearing", "USD");
    for (const type of ["platform_revenue", "refund_liability"] as const) {
      const r = await ensurePaymentAccount(sc, { owner: { kind: "platform", label: DIRECT }, accountType: type, currency: "USD" });
      assert.equal(r.ok, true, JSON.stringify(r));
      if (r.ok) directAccounts.push(r.accountId);
    }
    [aDirA, aDirB] = directAccounts as [string, string];
  });

  after(() => {
    // The ledger refuses every DELETE — that refusal is what it is for — so the
    // suite removes its OWN synthetic rows as the harness superuser (see the fixture).
    exec(paymentLedgerPurgeSql({
      accountIds: [...accounts, ...directAccounts],
      profileIds: users,
      partyLabels: [PLATFORM, PROCESSOR, DIRECT, OVERFLOW],
      scope: SCOPE,
    }));
  });

  // ═══════════════════════════════════════════════════════════════════════════
  describe("A — the tables refuse, whoever writes", () => {
    test("A1. I1: an unbalanced transaction is refused at COMMIT (deferred), and nothing of it persists", () => {
      const tx = randomUUID();
      const r = owner(`BEGIN;\n${envelopeSql(tx)}\n${entrySql(tx, aDirA, 500)}\n${entrySql(tx, aDirB, -499)}\nSELECT 'reached the commit';\nCOMMIT;`);
      assert.notEqual(r.status, 0);
      assert.match(r.stdout, /reached the commit/, "both INSERTs were accepted: the check is deferred, not immediate");
      assert.equal(r.error!.code, "PL002", r.stderr);
      assert.match(r.error!.message, /payment_transaction_unbalanced/);
      // Observed from a SEPARATE connection, after the failed commit.
      assert.equal(scalar(`SELECT count(*) FROM public.payment_transactions WHERE id = '${tx}'`), "0");
      assert.equal(scalar(`SELECT count(*) FROM public.payment_ledger_entries WHERE transaction_id = '${tx}'`), "0");
      // The same rows, balanced, commit: the refusal was the residual and nothing else.
      const ok = owner(`BEGIN;\n${envelopeSql(tx)}\n${entrySql(tx, aDirA, 500)}\n${entrySql(tx, aDirB, -500)}\nCOMMIT;`);
      assert.equal(ok.status, 0, ok.stderr);
      assert.equal(scalar(`SELECT count(*) FROM public.payment_ledger_entries WHERE transaction_id = '${tx}'`), "2");
      sealedTx = tx;
    });

    test("A2. I1: an envelope with no entries, and one with a single entry, are refused at COMMIT", () => {
      const none = randomUUID();
      const r0 = owner(`BEGIN;\n${envelopeSql(none)}\nCOMMIT;`);
      assert.equal(r0.error?.code, "PL002", r0.stderr);
      const one = randomUUID();
      const r1 = owner(`BEGIN;\n${envelopeSql(one)}\n${entrySql(one, aDirA, 500)}\nCOMMIT;`);
      assert.equal(r1.error?.code, "PL002", r1.stderr);
      assert.equal(scalar(`SELECT count(*) FROM public.payment_transactions WHERE id IN ('${none}', '${one}')`), "0");
    });

    test("A3. I4/I5: a mixed-currency transaction is refused — by the transaction key and by the account key", () => {
      const tx = randomUUID();
      // An EUR entry under a USD envelope: the composite key to the TRANSACTION refuses it.
      const byTx = owner(`BEGIN;\n${envelopeSql(tx)}\n${entrySql(tx, aDirA, -500)}\n${entrySql(tx, aPayeeEur, 500, "EUR")}\nCOMMIT;`);
      assert.equal(byTx.error?.code, "23503", byTx.stderr);
      assert.match(byTx.error!.message, /ple_transaction_fk/);
      // A USD-labelled entry on an EUR account: the composite key to the ACCOUNT refuses it.
      const byAccount = owner(`BEGIN;\n${envelopeSql(tx)}\n${entrySql(tx, aDirA, -500)}\n${entrySql(tx, aPayeeEur, 500, "USD")}\nCOMMIT;`);
      assert.equal(byAccount.error?.code, "23503", byAccount.stderr);
      assert.match(byAccount.error!.message, /ple_account_fk/);
      // A beneficiary in another currency than the transaction is refused too.
      const byBeneficiary = owner(`BEGIN;\n${envelopeSql(tx, { beneficiary_account_id: `'${aPayeeEur}'` })}\nCOMMIT;`);
      assert.equal(byBeneficiary.error?.code, "23503", byBeneficiary.stderr);
      assert.match(byBeneficiary.error!.message, /ptx_beneficiary_fk/);
      assert.equal(scalar(`SELECT count(*) FROM public.payment_transactions WHERE id = '${tx}'`), "0");
    });

    test("A4. I5: a zero-amount entry is refused; amounts are bigint minor units", () => {
      const tx = randomUUID();
      const r = owner(`BEGIN;\n${envelopeSql(tx)}\n${entrySql(tx, aDirA, 0)}\nCOMMIT;`);
      assert.equal(r.error?.code, "23514", r.stderr);
      assert.match(r.error!.message, /ple_amount_non_zero/);
      assert.deepEqual(
        rows<{ column_name: string; data_type: string }>(
          `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public'
             AND ((table_name = 'payment_ledger_entries' AND column_name = 'amount_minor')
               OR (table_name = 'payment_transactions' AND column_name = 'original_amount_minor')
               OR (table_name = 'payment_account_balances' AND column_name = 'balance_minor')) ORDER BY 1`),
        [{ column_name: "amount_minor", data_type: "bigint" }, { column_name: "balance_minor", data_type: "bigint" },
         { column_name: "original_amount_minor", data_type: "bigint" }],
      );
    });

    test("A5. I7: an unattributed transaction is refused — NULL, empty, and outside the vocabulary", () => {
      const tx = randomUUID();
      for (const col of ["cause_kind", "cause_id", "subject_kind", "subject_id", "beneficiary_account_id", "attribution_version", "idempotency_key", "scope"]) {
        const r = owner(envelopeSql(tx, { [col]: "NULL" }));
        assert.equal(r.error?.code, "23502", `${col} NULL: ${r.stderr}`);
      }
      for (const col of ["cause_id", "subject_id"]) {
        const r = owner(envelopeSql(tx, { [col]: `'   '` }));
        assert.equal(r.error?.code, "23514", `${col} blank: ${r.stderr}`);
        assert.match(r.error!.message, /ptx_attribution_present/);
      }
      const cause = owner(envelopeSql(tx, { cause_kind: `'gift'` }));
      assert.match(cause.error!.message, /ptx_cause_kind_known/, cause.stderr);
      // The subject is never a person, and never "unknown".
      for (const kind of ["user", "profile", "unknown"]) {
        const subject = owner(envelopeSql(tx, { subject_kind: `'${kind}'` }));
        assert.match(subject.error!.message, /ptx_subject_kind_known/, subject.stderr);
      }
      const version = owner(envelopeSql(tx, { attribution_version: `'Not A Slug'` }));
      assert.match(version.error!.message, /ptx_attribution_version_shape/, version.stderr);
      const key = owner(envelopeSql(tx, { idempotency_key: `''` }));
      assert.match(key.error!.message, /ptx_idempotency_key_shape/, key.stderr);
      // A scope may not carry a PROFILE id: the row outlives the person's erasure.
      const scope = owner(envelopeSql(tx, { scope: `'http:tip:${payer}'` }));
      assert.equal(scope.error?.code, "PL422", scope.stderr);
      assert.match(scope.error!.message, /person_identifier — scope/, scope.stderr);
      assert.match(owner(envelopeSql(tx, { scope: `'Not A Slug'` })).error!.message, /ptx_scope_shape/);
      // A PARTY id is how a scope says whose key it is: it passes the door (and
      // this envelope, having no entries, is then refused by the balance check).
      const partyScope = owner(envelopeSql(tx, { scope: `'http:tip:${partyOf[aPayer]}'` }));
      assert.equal(partyScope.error?.code, "PL002", partyScope.stderr);
      assert.equal(scalar(`SELECT count(*) FROM public.payment_transactions WHERE id = '${tx}'`), "0");
    });

    test("A6. PAY-047: a duplicate (scope, idempotency_key) is refused by the index", () => {
      const first = randomUUID(), second = randomUUID();
      const key = `'dup-${first}'`;
      const ok = owner(`BEGIN;\n${envelopeSql(first, { idempotency_key: key })}\n${entrySql(first, aDirA, 500)}\n${entrySql(first, aDirB, -500)}\nCOMMIT;`);
      assert.equal(ok.status, 0, ok.stderr);
      const dup = owner(`BEGIN;\n${envelopeSql(second, { idempotency_key: key })}\n${entrySql(second, aDirA, 500)}\n${entrySql(second, aDirB, -500)}\nCOMMIT;`);
      assert.equal(dup.error?.code, "23505", dup.stderr);
      assert.match(dup.error!.message, /ptx_idempotency_once/);
      // The same key under ANOTHER scope is a different event.
      const elsewhere = owner(`BEGIN;\n${envelopeSql(second, { idempotency_key: key, scope: `'${SCOPE}-b'` })}\n${entrySql(second, aDirA, 500)}\n${entrySql(second, aDirB, -500)}\nCOMMIT;`);
      assert.equal(elsewhere.status, 0, elsewhere.stderr);
    });

    test("A7. I2: UPDATE, DELETE and TRUNCATE are refused for the table OWNER; service_role has no privilege at all", () => {
      const before = ledgerSnapshot();
      for (const [table, set] of [
        ["payment_ledger_entries", "amount_minor = amount_minor"],
        ["payment_transactions", "cause_id = 'rewritten'"],
        ["payment_accounts", "currency = currency"],
      ] as const) {
        const upd = owner(`UPDATE public.${table} SET ${set} WHERE id IN (SELECT id FROM public.${table} LIMIT 1);`);
        assert.equal(upd.error?.code, "PL001", `${table} UPDATE: ${upd.stderr}`);
        const del = owner(`DELETE FROM public.${table} WHERE id IN (SELECT id FROM public.${table} LIMIT 1);`);
        assert.equal(del.error?.code, "PL001", `${table} DELETE: ${del.stderr}`);
        const trunc = owner(`TRUNCATE public.${table} CASCADE;`);
        assert.equal(trunc.error?.code, "PL001", `${table} TRUNCATE: ${trunc.stderr}`);
        for (const stmt of [
          `UPDATE public.${table} SET ${set};`,
          `DELETE FROM public.${table};`,
          `TRUNCATE public.${table} CASCADE;`,
        ]) {
          assert.equal(as("service_role", stmt).error?.code, "42501", `service_role: ${stmt}`);
        }
      }
      assert.equal(as("service_role", `INSERT INTO public.payment_ledger_entries (transaction_id, account_id, amount_minor, currency, livemode, entry_reason) VALUES ('${randomUUID()}', '${aPayee}', 1, 'USD', false, 'adjustment');`).error?.code, "42501");
      assert.deepEqual(ledgerSnapshot(), before, "nothing changed");
    });

    test("A8. I1: a committed transaction is sealed — a later pair is refused, also behind ON CONFLICT DO NOTHING and behind a hand-written token", () => {
      const tx = sealedTx;
      assert.ok(tx, "A1 committed a transaction");
      const pair = `${entrySql(tx, aDirA, 700)}\n${entrySql(tx, aDirB, -700)}`;
      const r = owner(`BEGIN;\n${pair}\nCOMMIT;`);
      assert.equal(r.error?.code, "PL003", r.stderr);
      assert.match(r.error!.message, /payment_transaction_sealed/);
      // The verifier's reopen: re-INSERT the committed id behind ON CONFLICT (id) DO
      // NOTHING — nothing is inserted, and a BEFORE INSERT trigger would still have fired.
      const reinsert = envelopeSql(tx, { idempotency_key: `'reopen-${tx}'` }).replace(/;$/, " ON CONFLICT (id) DO NOTHING;");
      assert.match(reinsert, /ON CONFLICT \(id\) DO NOTHING;$/);
      const reopened = owner(`BEGIN;\n${reinsert}\n${pair}\nCOMMIT;`);
      assert.equal(reopened.error?.code, "PL003", reopened.stderr);
      // A token written by hand opens nothing: the envelope is another transaction's.
      const forged = owner(`BEGIN;\nSELECT set_config('portava.payment_open_transactions', '${tx},', true);\n${pair}\nCOMMIT;`);
      assert.equal(forged.error?.code, "PL003", forged.stderr);
      assert.equal(scalar(`SELECT count(*) FROM public.payment_ledger_entries WHERE transaction_id = '${tx}'`), "2", "the committed transaction still has its two entries");
      assert.equal(scalar(`SELECT sum(amount_minor) FILTER (WHERE amount_minor > 0) FROM public.payment_ledger_entries WHERE transaction_id = '${tx}'`), "500");
      // Half of the seal: created_at is the envelope's OWN transaction's clock, whatever a writer supplies.
      const backdated = randomUUID();
      const ok = owner(`BEGIN;\n${envelopeSql(backdated, { created_at: `'2020-01-01T00:00:00Z'` })}\n${entrySql(backdated, aDirA, 500)}\n${entrySql(backdated, aDirB, -500)}\nCOMMIT;`);
      assert.equal(ok.status, 0, ok.stderr);
      assert.equal(scalar(`SELECT created_at > now() - interval '5 minutes' FROM public.payment_transactions WHERE id = '${backdated}'`), "t");
    });

    test("A9. PAY-021/PAY-026: nine account types, each with its owner kind; test mode only; no currency is assumed", () => {
      const party = scalar(`SELECT owner_id FROM public.payment_accounts WHERE id = '${aRevenue}'`)!;
      const userParty = scalar(`SELECT owner_id FROM public.payment_accounts WHERE id = '${aPayee}'`)!;
      const ins = (kind: string, ownerId: string, type: string, extra = "'USD', false") =>
        owner(`INSERT INTO public.payment_accounts (owner_kind, owner_id, account_type, currency, livemode) VALUES ('${kind}', '${ownerId}', '${type}', ${extra});`);
      assert.match(ins("platform", party, "wallet").error!.message, /pa_account_type_known/);
      assert.match(ins("platform", party, "user_payable").error!.message, /pa_account_type_owner_kind/);
      assert.match(ins("user", userParty, "platform_revenue").error!.message, /pa_account_type_owner_kind/);
      assert.equal(ins("platform", userParty, "platform_revenue").error?.code, "23503", "owner_kind must be the party's kind");
      assert.match(ins("platform", party, "hold_reserve", "'USD', true").error!.message, /pa_test_mode_only/);
      assert.match(ins("platform", party, "hold_reserve", "'usd', false").error!.message, /pa_currency_shape/);
      assert.equal(owner(`INSERT INTO public.payment_accounts (owner_kind, owner_id, account_type, livemode) VALUES ('platform', '${party}', 'hold_reserve', false);`).error?.code, "23502", "no default currency");
      assert.equal(owner(envelopeSql(randomUUID(), { livemode: "true" })).error?.code, "23514");
      assert.deepEqual(
        rows<{ t: string }>(`SELECT unnest(ARRAY['user_payable','user_receivable','platform_revenue','platform_fee_expense','processor_clearing','payout_in_transit','hold_reserve','refund_liability','tax_withheld']) AS t ORDER BY 1`).map((x) => x.t),
        rows<{ t: string }>(`SELECT account_type AS t FROM public.payment_balance_rules ORDER BY 1`).map((x) => x.t),
        "the rules table names exactly the nine",
      );
      // PAY-038: an entry carries the account, the signed amount, the currency and the reason.
      assert.deepEqual(
        rows<{ c: string }>(`SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'payment_ledger_entries' ORDER BY 1`).map((x) => x.c),
        ["account_id", "amount_minor", "currency", "entry_reason", "id", "livemode", "transaction_id"],
      );
      // No payment table has a profile column except the one identity link.
      assert.deepEqual(
        rows<{ tbl: string; col: string }>(
          `SELECT conrelid::regclass::text AS tbl, (SELECT attname FROM pg_attribute WHERE attrelid = conrelid AND attnum = conkey[1]) AS col
             FROM pg_constraint WHERE contype = 'f' AND confrelid = 'public.profiles'::regclass AND conrelid::regclass::text LIKE 'payment%'`),
        [{ tbl: "payment_parties", col: "profile_id" }],
      );
    });

    test("A10. PAY-022: account creation is idempotent, also under concurrency; no row is seeded for a zero balance", async () => {
      const again = await ensurePaymentAccount(sc, { owner: { kind: "user", profileId: payee }, accountType: "user_payable", currency: "USD" });
      assert.deepEqual(again, { ok: true, accountId: aPayee, partyId: partyOf[aPayee], created: false });
      assert.equal(scalar(`SELECT owner_id FROM public.payment_accounts WHERE id = '${aPayee}'`), partyOf[aPayee], "partyId is the account's owner: the pseudonym, not the profile");
      assert.notEqual(partyOf[aPayee], payee);
      const payload = { owner_kind: "user", profile_id: stranger, account_type: "user_payable", currency: "USD" };
      const results = await Promise.all(Array.from({ length: 8 }, () =>
        psqlAsync(`SET ROLE service_role;\nSELECT public.payment_account_ensure(${jsonLiteral(payload)})->>'account_id';`)));
      assert.ok(results.every((r) => r.status === 0), results.map((r) => r.stderr).join("\n"));
      const ids = new Set(results.map((r) => r.stdout.trim()));
      assert.equal(ids.size, 1, "eight concurrent creations resolve to one account");
      accounts.push([...ids][0]!);
      assert.equal(scalar(`SELECT count(*) FROM public.payment_parties WHERE profile_id = '${stranger}'`), "1");
      assert.equal(scalar(`SELECT count(*) FROM public.payment_account_balances WHERE account_id = '${[...ids][0]}'`), "0", "a new account has no balance row: zero by construction");
      const bad = await ensurePaymentAccount(sc, { owner: { kind: "user", profileId: randomUUID() }, accountType: "user_payable", currency: "USD" });
      assert.equal(bad.ok, false);
      if (!bad.ok) { assert.equal(bad.reason, "invalid_request"); assert.match(bad.detail, /profile_not_found/); }
    });

    test("A11. 09 §6: the beneficiary must be an account the transaction touches (checked at COMMIT)", () => {
      const tx = randomUUID();
      const r = owner(`BEGIN;\n${envelopeSql(tx, { beneficiary_account_id: `'${aOther}'` })}\n${entrySql(tx, aDirA, 500)}\n${entrySql(tx, aDirB, -500)}\nCOMMIT;`);
      assert.equal(r.error?.code, "PL006", r.stderr);
      assert.equal(scalar(`SELECT count(*) FROM public.payment_transactions WHERE id = '${tx}'`), "0");
    });

    test("A12. currencies: the original currency and amount are always stored; a conversion is stated in full or not at all", () => {
      const tx = randomUUID();
      // Presented in JPY, booked in USD, and no rate: refused. A rate is never invented.
      const missing = owner(envelopeSql(tx, { original_currency: `'JPY'`, original_amount_minor: `75000` }));
      assert.match(missing.error!.message, /ptx_conversion_details/, missing.stderr);
      // … partly stated: refused.
      const partial = owner(envelopeSql(tx, { original_currency: `'JPY'`, original_amount_minor: `75000`, fx_rate: `0.0067` }));
      assert.match(partial.error!.message, /ptx_conversion_details/, partial.stderr);
      // Same currency WITH a rate: refused (a conversion that did not happen).
      const invented = owner(envelopeSql(tx, { fx_rate: `1`, fx_rate_source: `'x'`, fx_rate_at: `now()` }));
      assert.match(invented.error!.message, /ptx_conversion_details/, invented.stderr);
      // Stated in full: stored exactly.
      const ok = owner(
        `BEGIN;\n${envelopeSql(tx, { original_currency: `'JPY'`, original_amount_minor: `75000`, fx_rate: `0.0067`, fx_rate_source: `'processor'`, fx_rate_at: `'2026-10-04T08:00:00Z'` })}\n` +
        `${entrySql(tx, aDirA, 500)}\n${entrySql(tx, aDirB, -500)}\nCOMMIT;`);
      assert.equal(ok.status, 0, ok.stderr);
      assert.deepEqual(
        rows<any>(`SELECT currency::text, original_currency::text, original_amount_minor::text AS a, fx_rate::text AS r, fx_rate_source AS s FROM public.payment_transactions WHERE id = '${tx}'`),
        [{ currency: "USD", original_currency: "JPY", a: "75000", r: "0.0067", s: "processor" }],
      );
      for (const col of ["original_currency", "original_amount_minor", "currency"]) {
        assert.equal(owner(envelopeSql(randomUUID(), { [col]: "NULL" })).error?.code, "23502", col);
      }
    });

    test("A13. I3: no statement-level UPDATE/DELETE trigger — a statement that touches no row is not refused", () => {
      assert.equal(Number(scalar(
        `SELECT count(*) FROM pg_trigger g WHERE NOT g.tgisinternal AND (g.tgtype & 1) = 0 AND (g.tgtype & 32) = 0
           AND g.tgrelid::regclass::text LIKE 'payment%'`)), 0);
      for (const t of ["payment_ledger_entries", "payment_transactions", "payment_accounts", "payment_parties"]) {
        assert.equal(owner(`DELETE FROM public.${t} WHERE false; UPDATE public.${t} SET id = id WHERE false;`).status, 0, t);
      }
      // A profile with NO payment rows deletes untouched by any of this.
      const nobody = seedUser("paybnobody");
      exec(`DELETE FROM public.profiles WHERE id = '${nobody}'; DELETE FROM auth.users WHERE id = '${nobody}';`);
    });

    test("A14. I1: two entries on ONE account are not a movement — refused at COMMIT although they sum to zero", () => {
      const tx = randomUUID();
      const r = owner(`BEGIN;\n${envelopeSql(tx)}\n${entrySql(tx, aDirA, -500)}\n${entrySql(tx, aDirA, 500)}\nSELECT 'reached the commit';\nCOMMIT;`);
      assert.match(r.stdout, /reached the commit/);
      assert.equal(r.error?.code, "PL002", r.stderr);
      assert.match(r.error!.message, /names 1 account\(s\)/);
      assert.equal(scalar(`SELECT count(*) FROM public.payment_transactions WHERE id = '${tx}'`), "0");
    });

    test("A15. 09 §6: the beneficiary is the account CREDITED — an account the transaction debits is refused at COMMIT", () => {
      const tx = randomUUID();
      const r = owner(`BEGIN;\n${envelopeSql(tx, { beneficiary_account_id: `'${aDirB}'` })}\n${entrySql(tx, aDirA, 500)}\n${entrySql(tx, aDirB, -500)}\nCOMMIT;`);
      assert.equal(r.error?.code, "PL006", r.stderr);
      assert.match(r.error!.message, /payment_beneficiary_not_credited/);
      assert.equal(scalar(`SELECT count(*) FROM public.payment_transactions WHERE id = '${tx}'`), "0");
    });

    test("A16. the original amount is tied to the entries (one currency: the credits total it), and the rate's direction is written down", () => {
      const tx = randomUUID();
      const r = owner(`BEGIN;\n${envelopeSql(tx, { original_amount_minor: `499` })}\n${entrySql(tx, aDirA, 500)}\n${entrySql(tx, aDirB, -500)}\nCOMMIT;`);
      assert.equal(r.error?.code, "PL007", r.stderr);
      assert.match(r.error!.message, /payment_original_amount_mismatch/);
      assert.equal(scalar(`SELECT count(*) FROM public.payment_transactions WHERE id = '${tx}'`), "0");
      const comment = (col: string) => scalar(
        `SELECT col_description('public.payment_transactions'::regclass, (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.payment_transactions'::regclass AND attname = '${col}'))`)!;
      assert.match(comment("fx_rate"), /units of currency \(booked\) per ONE unit of original_currency/);
      assert.match(comment("original_amount_minor"), /equals the sum of the transaction's credit entries/);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  describe("B — the posting function: one transaction, exactly once", () => {
    let first: PostPaymentTransactionInput;
    let firstId = "";

    test("B1. one call writes the envelope, the entries and the balance delta; principal, tip and fee are separate entries", async () => {
      const startPayee = balance(aPayee), startPayer = balance(aPayer), startRevenue = balance(aRevenue);
      const n = transactionCount();
      first = capture({ externalRef: `pi_test_${RUN}` });
      const r = await postPaymentTransaction(sc, first);
      assert.equal(r.ok, true, JSON.stringify(r));
      if (!r.ok) return;
      firstId = r.transactionId;
      assert.equal(r.replayed, false);
      assert.equal(transactionCount(), n + 1);
      assert.deepEqual(
        rows<any>(`SELECT account_id, amount_minor::text AS a, currency::text AS c, entry_reason AS r FROM public.payment_ledger_entries WHERE transaction_id = '${firstId}' ORDER BY entry_reason, amount_minor`),
        [
          { account_id: aRevenue, a: "1000", c: "USD", r: "platform_fee" },
          { account_id: aPayer, a: "-11000", c: "USD", r: "principal" },
          { account_id: aPayee, a: "9000", c: "USD", r: "principal" },
          { account_id: aPayee, a: "1000", c: "USD", r: "tip" },
        ],
      );
      assert.equal(balance(aPayee), startPayee + 10000);
      assert.equal(balance(aPayer), startPayer - 11000);
      assert.equal(balance(aRevenue), startRevenue + 1000);
      // What the function RETURNED is what the projection holds, as strings.
      const returned = Object.fromEntries(r.balances.map((b) => [b.accountId, b.balanceMinor]));
      assert.equal(returned[aPayee], String(balance(aPayee)));
      assert.equal(returned[aPayer], String(balance(aPayer)));
      assert.equal(drift(), 0, "projection = fold of entries");
      assert.equal(unbalanced(), 0);
      const t = rows<any>(`SELECT kind, scope, idempotency_key, cause_kind, cause_id, subject_kind, beneficiary_account_id, attribution_version, external_ref, livemode, original_currency::text AS oc, original_amount_minor::text AS oa FROM public.payment_transactions WHERE id = '${firstId}'`)[0];
      assert.deepEqual(t, {
        kind: "capture", scope: SCOPE, idempotency_key: first.idempotencyKey, cause_kind: "booking",
        cause_id: first.attribution.causeId, subject_kind: "booking", beneficiary_account_id: aPayee,
        attribution_version: "test-rules/v1", external_ref: `pi_test_${RUN}`, livemode: false, oc: "USD", oa: "11000",
      });
    });

    test("B2. a replay returns the ORIGINAL transaction and writes nothing — also reordered, restamped, or with amounts as strings", async () => {
      const before = ledgerSnapshot();
      const same = await postPaymentTransaction(sc, first);
      assert.deepEqual(same, { ok: true, transactionId: firstId, replayed: true, balances: [] });
      const reshaped = await postPaymentTransaction(sc, {
        ...first,
        occurredAt: new Date(Date.now() + 60_000).toISOString(),
        entries: [...first.entries].reverse().map((e) => ({ ...e, amountMinor: String(e.amountMinor) })),
      });
      assert.deepEqual(reshaped, { ok: true, transactionId: firstId, replayed: true, balances: [] });
      assert.deepEqual(ledgerSnapshot(), before, "a replay changes no row and no balance");
    });

    test("B3. the same key over DIFFERENT content is a named conflict, never a success, and writes nothing", async () => {
      const before = ledgerSnapshot();
      const variants: Array<Partial<PostPaymentTransactionInput>> = [
        { originalAmountMinor: 12000, entries: [{ accountId: aPayer, amountMinor: -12000, entryReason: "principal" }, { accountId: aPayee, amountMinor: 12000, entryReason: "principal" }] },
        { entries: first.entries.map((e) => (e.entryReason === "tip" ? { ...e, entryReason: "principal" as const } : e)) },
        // What was presented is part of the content: the same entries, presented in another currency.
        { originalCurrency: "JPY", originalAmountMinor: 1650000, conversion: { rate: "0.0067", source: "processor", at: "2026-10-04T08:00:00Z" } },
        { externalRef: "pi_test_other" },
        { kind: "charge" },
        { attribution: { ...first.attribution, causeId: "another-booking" } },
        { attribution: { ...first.attribution, attributionVersion: "test-rules/v2" } },
      ];
      for (const v of variants) {
        const r = await postPaymentTransaction(sc, { ...first, ...v });
        assert.equal(r.ok, false, JSON.stringify(v));
        if (!r.ok) { assert.equal(r.reason, "idempotency_conflict", JSON.stringify(r)); assert.match(r.detail, /payment_idempotency_conflict/); }
      }
      assert.deepEqual(ledgerSnapshot(), before);
    });

    test("B4. each malformed request is refused by NAME and leaves nothing behind", async () => {
      const before = ledgerSnapshot();
      const n = transactionCount();
      const cases: Array<[string, Partial<PostPaymentTransactionInput>, string, RegExp]> = [
        ["unbalanced", { entries: [{ accountId: aPayer, amountMinor: -500, entryReason: "principal" }, { accountId: aPayee, amountMinor: 499, entryReason: "principal" }] }, "transaction_unbalanced", /sum to -1/],
        ["one entry", { entries: [{ accountId: aPayee, amountMinor: 500, entryReason: "principal" }] }, "invalid_request", /entries_too_few/],
        ["zero amount", { entries: [{ accountId: aPayer, amountMinor: 0, entryReason: "principal" }, { accountId: aPayee, amountMinor: 0, entryReason: "principal" }] }, "invalid_request", /zero_amount/],
        ["one account twice", { entries: [{ accountId: aPayee, amountMinor: -500, entryReason: "principal" }, { accountId: aPayee, amountMinor: 500, entryReason: "principal" }] }, "invalid_request", /entries_too_few/],
        ["original amount not the entries' total", { originalAmountMinor: 11001 }, "invalid_request", /original_amount_mismatch/],
        ["beneficiary debited", { attribution: { ...capture().attribution, beneficiaryAccountId: aPayer } }, "invalid_request", /beneficiary_not_credited/],
        ["unknown reason", { originalAmountMinor: 5, entries: [{ accountId: aPayer, amountMinor: -5, entryReason: "bonus" as any }, { accountId: aPayee, amountMinor: 5, entryReason: "principal" }] }, "invalid_request", /ple_entry_reason_known/],
        ["unknown account", { entries: [{ accountId: randomUUID(), amountMinor: -5, entryReason: "principal" }, { accountId: aPayee, amountMinor: 5, entryReason: "principal" }] }, "invalid_request", /account_not_found/],
        ["mixed currency", { entries: [{ accountId: aPayer, amountMinor: -5, entryReason: "principal" }, { accountId: aPayeeEur, amountMinor: 5, entryReason: "principal" }], attribution: { ...capture().attribution, beneficiaryAccountId: aPayer } }, "invalid_request", /currency_mismatch/],
        ["beneficiary not a party", { attribution: { ...capture().attribution, beneficiaryAccountId: aOther } }, "invalid_request", /beneficiary_not_a_party/],
        ["unknown kind", { kind: "gift" as any }, "invalid_request", /ptx_kind_known/],
        ["unknown cause", { attribution: { ...capture().attribution, causeKind: "gift" as any } }, "invalid_request", /ptx_cause_kind_known/],
        ["a person as subject", { attribution: { ...capture().attribution, subjectKind: "user" as any } }, "invalid_request", /ptx_subject_kind_known/],
        ["blank attribution", { attribution: { ...capture().attribution, causeId: "  " } }, "invalid_request", /missing_field/],
        ["currency shape", { currency: "usd" }, "invalid_request", /currency_shape/],
        ["conversion missing", { originalCurrency: "JPY" }, "invalid_request", /ptx_conversion_details/],
        ["scope with a profile id", { scope: `http:tip:${payer}` }, "invalid_request", /person_identifier — scope/],
        ["scope not a slug", { scope: "Tips For Sam" }, "invalid_request", /ptx_scope_shape/],
        ["rate source not a slug", { originalCurrency: "JPY", conversion: { rate: "0.0067", source: "Sam at the desk", at: "2026-10-04T08:00:00Z" } }, "invalid_request", /ptx_fx_rate_source_shape/],
      ];
      for (const [name, over, reason, detail] of cases) {
        const r = await postPaymentTransaction(sc, capture(over));
        assert.equal(r.ok, false, name);
        if (!r.ok) { assert.equal(r.reason, reason, `${name}: ${JSON.stringify(r)}`); assert.match(r.detail, detail, name); }
      }
      // Shapes the wrapper cannot produce, sent to the function itself.
      const raw = (over: Record<string, unknown>) =>
        as("service_role", `SELECT public.payment_post_transaction(${jsonLiteral({ ...rawPayload(`raw-${randomUUID()}`, "capture", [[aPayer, -5, "principal"], [aPayee, 5, "principal"]], aPayee), ...over })});`);
      assert.equal(raw({ livemode: true }).error?.code, "PL451");
      assert.match(raw({ amount: 5 }).error!.message, /unknown_field/);
      assert.match(raw({ entries: [{ account_id: aPayer, amount_minor: -5, entry_reason: "principal", memo: "x" }, { account_id: aPayee, amount_minor: 5, entry_reason: "principal" }] }).error!.message, /unknown_entry_field/);
      assert.match(raw({ entries: [{ account_id: aPayer, amount_minor: -12.5, entry_reason: "principal" }, { account_id: aPayee, amount_minor: 12.5, entry_reason: "principal" }] }).error!.message, /amount_not_an_integer/);
      assert.match(raw({ idempotency_key: null }).error!.message, /missing_field/);
      assert.equal(transactionCount(), n);
      assert.deepEqual(ledgerSnapshot(), before);
    });

    test("B5. I6: a payee's balance cannot be overdrawn by a payout; a chargeback may; the floor is checked in the function", async () => {
      const start = balance(aPayee);
      assert.ok(start > 0);
      const payout = (amount: number, key: string) => postPaymentTransaction(sc, capture({
        idempotencyKey: key, kind: "payout", originalAmountMinor: amount,
        attribution: { ...capture().attribution, beneficiaryAccountId: aClearing },
        entries: [{ accountId: aPayee, amountMinor: -amount, entryReason: "payout" }, { accountId: aClearing, amountMinor: amount, entryReason: "payout" }],
      }));
      const before = ledgerSnapshot();
      const over = await payout(start + 1, `payout-over-${RUN}`);
      assert.equal(over.ok, false);
      if (!over.ok) { assert.equal(over.reason, "insufficient_balance"); assert.match(over.detail, /user_payable/); }
      assert.deepEqual(ledgerSnapshot(), before, "the refused payout wrote nothing — no envelope, no entry, no balance change");
      // A refund and a reversal-shaped debit are refused the same way: only the listed kind may cross.
      const refund = await postPaymentTransaction(sc, capture({
        kind: "refund", originalAmountMinor: start + 1,
        attribution: { ...capture().attribution, beneficiaryAccountId: aRefunds },
        entries: [{ accountId: aPayee, amountMinor: -(start + 1), entryReason: "refund" }, { accountId: aRefunds, amountMinor: start + 1, entryReason: "refund" }],
      }));
      assert.equal(refund.ok === false && refund.reason, "insufficient_balance");

      const exact = await payout(start, `payout-exact-${RUN}`);
      assert.equal(exact.ok, true, JSON.stringify(exact));
      assert.equal(balance(aPayee), 0);

      // 09 §9.2: a chargeback arrives after the payout and drives the payee negative.
      const chargeback = await postPaymentTransaction(sc, capture({
        kind: "chargeback", originalAmountMinor: 4000,
        attribution: { ...capture().attribution, beneficiaryAccountId: aClearing },
        entries: [{ accountId: aPayee, amountMinor: -4000, entryReason: "chargeback" }, { accountId: aClearing, amountMinor: 4000, entryReason: "chargeback" }],
      }));
      assert.equal(chargeback.ok, true, JSON.stringify(chargeback));
      assert.equal(balance(aPayee), -4000);
      // While negative: a further payout is refused, an earning is accepted.
      const more = await payout(1, `payout-while-negative-${RUN}`);
      assert.equal(more.ok === false && more.reason, "insufficient_balance");
      const earning = await postPaymentTransaction(sc, capture());
      assert.equal(earning.ok, true, JSON.stringify(earning));
      assert.equal(balance(aPayee), 6000);
      assert.equal(drift(), 0);

      // The rule is DATA, read by the function: with its row gone the type is refused, not unconstrained.
      const noRule = psql(
        `\\set VERBOSITY verbose\nBEGIN;\nDELETE FROM public.payment_balance_rules WHERE account_type = 'platform_revenue';\n` +
        `SET LOCAL ROLE service_role;\nSELECT public.payment_post_transaction(${jsonLiteral(rawPayload(`norule-${RUN}`, "capture", [[aPayer, -5, "principal"], [aRevenue, 5, "platform_fee"]], aRevenue))});\nCOMMIT;`);
      assert.equal(pgError(noRule.stderr).code, "PL402", noRule.stderr);
      assert.match(noRule.stderr, /no balance rule/);
      assert.equal(scalar(`SELECT count(*) FROM public.payment_balance_rules`), "9", "the rolled-back probe left the rules intact");
    });

    test("B6. 09 §9.2: a reversal is a new transaction that negates the original exactly, once", async () => {
      const original = await postPaymentTransaction(sc, capture());
      assert.equal(original.ok, true);
      if (!original.ok) return;
      const payeeBefore = balance(aPayee) - 10000, payerBefore = balance(aPayer) + 11000;
      const reversal = (entries: PostPaymentTransactionInput["entries"], key: string) => postPaymentTransaction(sc, capture({
        idempotencyKey: key, kind: "reversal", reversesTransactionId: original.transactionId, entries,
        // The reversal credits the payer back: the payer's account is ITS beneficiary.
        attribution: { ...capture().attribution, beneficiaryAccountId: aPayer },
      }));
      const partial = await reversal(
        [{ accountId: aPayer, amountMinor: 11000, entryReason: "reversal" }, { accountId: aPayee, amountMinor: -11000, entryReason: "reversal" }],
        `rev-wrong-${RUN}`);
      assert.equal(partial.ok === false && partial.reason, "reversal_not_negation", JSON.stringify(partial));
      const negation: PostPaymentTransactionInput["entries"] = [
        { accountId: aPayer, amountMinor: 11000, entryReason: "reversal" },
        { accountId: aPayee, amountMinor: -10000, entryReason: "reversal" },
        { accountId: aRevenue, amountMinor: -1000, entryReason: "reversal" },
      ];
      const ok = await reversal(negation, `rev-${RUN}`);
      assert.equal(ok.ok, true, JSON.stringify(ok));
      assert.equal(balance(aPayee), payeeBefore);
      assert.equal(balance(aPayer), payerBefore);
      const twice = await reversal(negation, `rev-again-${RUN}`);
      assert.equal(twice.ok === false && twice.reason, "already_reversed", JSON.stringify(twice));
      // A reversal with no original, and an original named by a non-reversal, are refused.
      const unlinked = await postPaymentTransaction(sc, capture({ kind: "reversal" }));
      assert.equal(unlinked.ok === false && /ptx_reversal_is_linked/.test(unlinked.detail), true);
      assert.equal(scalar(`SELECT count(*) FROM public.payment_transactions WHERE id = '${original.transactionId}'`), "1", "the original is still there, unedited");
      assert.equal(drift(), 0);
      assert.equal(unbalanced(), 0);
    });

    test("B7. the write boundary: SECURITY DEFINER with a pinned search_path, EXECUTE for service_role only", () => {
      for (const fn of ["payment_post_transaction", "payment_account_ensure", "payment_party_remove_identity"]) {
        const f = rows<any>(`SELECT prosecdef AS d, proconfig::text AS c FROM pg_proc WHERE oid = 'public.${fn}(jsonb)'::regprocedure`)[0];
        assert.equal(f.d, true, fn);
        assert.equal(f.c, `{"search_path=pg_catalog, pg_temp"}`, fn);
      }
      // NONE of the payment functions is left on an empty search_path (which searches pg_temp first for types).
      assert.deepEqual(rows<any>(
        `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname IN ('public', 'authz') AND left(p.proname, 8) = 'payment_'
            AND p.proconfig::text IS DISTINCT FROM '{"search_path=pg_catalog, pg_temp"}'`), []);
      const names = (where: string) => rows<{ f: string }>(
        `SELECT p.proname AS f FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname IN ('public', 'authz') AND left(p.proname, 8) = 'payment_' AND (${where}) ORDER BY 1`).map((x) => x.f);
      // SECURITY DEFINER: the three doors, and the trigger functions that run outside them
      // (two balance checks and the beneficiary check at COMMIT, the scrub under a foreign-key action).
      assert.deepEqual(names("p.prosecdef"), [
        "payment_account_ensure", "payment_entry_transaction_balances", "payment_party_remove_identity",
        "payment_party_scrub_identifiers", "payment_post_transaction", "payment_transaction_beneficiary_is_party",
        "payment_transaction_has_balanced_entries",
      ]);
      // What service_role may execute is the same five functions on a database WITH Supabase's
      // default privileges and on one WITHOUT: nothing depends on an implicit grant.
      assert.deepEqual(names("has_function_privilege('service_role', p.oid, 'EXECUTE')"), [
        "payment_account_ensure", "payment_account_owned_by_profile", "payment_party_ledger",
        "payment_party_remove_identity", "payment_post_transaction",
      ]);
      assert.deepEqual(names("has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE')"), []);
      assert.equal(as("service_role", `SELECT public.payment_assert_transaction_balanced('${randomUUID()}');`).error?.code, "42501");
      assert.equal(as("service_role", `SELECT public.payment_scrub_profile_identifier('${randomUUID()}', '${randomUUID()}');`).error?.code, "42501");
      for (const role of ["anon", "authenticated"] as const) {
        for (const fn of ["payment_post_transaction", "payment_account_ensure", "payment_party_remove_identity", "payment_party_ledger"]) {
          assert.equal(as(role, `SELECT public.${fn}('{}'::jsonb);`).error?.code, "42501", `${role} ${fn}`);
        }
        for (const t of ["payment_parties", "payment_accounts", "payment_transactions", "payment_ledger_entries", "payment_account_balances", "payment_balance_rules", "payment_retention_settings"]) {
          assert.equal(as(role, `SELECT 1 FROM public.${t} LIMIT 1;`).error?.code, "42501", `${role} ${t}`);
        }
      }
      // service_role reads, and cannot write the projection or the rules around the function.
      assert.equal(as("service_role", `SELECT count(*) FROM public.payment_ledger_entries;`).status, 0);
      assert.equal(as("service_role", `UPDATE public.payment_account_balances SET balance_minor = 0;`).error?.code, "42501");
      assert.equal(as("service_role", `UPDATE public.payment_balance_rules SET floor_enforced = false;`).error?.code, "42501");
      assert.equal(as("service_role", `UPDATE public.payment_retention_settings SET retention_period = '1 day', decision_ref = 'x';`).error?.code, "42501");
      assert.equal(Number(scalar(`SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename LIKE 'payment%'`)), 0, "deny-all: no policy on any payment table");
      assert.equal(Number(scalar(`SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname LIKE 'payment%' AND c.relkind = 'r' AND NOT c.relrowsecurity`)), 0);
    });

    test("B8. fees and tips: a tip-only movement carries no fee entry, and a fee is its own entry with its own reason", async () => {
      const tip = await postPaymentTransaction(sc, capture({
        originalAmountMinor: 700,
        attribution: { ...capture().attribution, causeKind: "tip" },
        entries: [{ accountId: aPayer, amountMinor: -700, entryReason: "tip" }, { accountId: aPayee, amountMinor: 700, entryReason: "tip" }],
      }));
      assert.equal(tip.ok, true, JSON.stringify(tip));
      if (!tip.ok) return;
      assert.deepEqual(
        rows<any>(`SELECT entry_reason AS r, sum(amount_minor)::text AS s FROM public.payment_ledger_entries WHERE transaction_id = '${tip.transactionId}' GROUP BY 1`),
        [{ r: "tip", s: "0" }],
        "the whole tip reaches the payee: no platform_fee entry exists in a tip transaction unless a caller writes one",
      );
      // The fee earned on the first capture is readable on its own, apart from principal and tip.
      assert.equal(scalar(`SELECT sum(amount_minor) FROM public.payment_ledger_entries WHERE transaction_id = '${firstId}' AND entry_reason = 'platform_fee'`), "1000");
      assert.equal(scalar(`SELECT sum(amount_minor) FROM public.payment_ledger_entries WHERE transaction_id = '${firstId}' AND entry_reason = 'tip'`), "1000");
    });

    test("B9. a balance that would leave bigint is refused by NAME (amount_out_of_range) — not a bare 22003 — and writes nothing", async () => {
      const big = "999999999999999999";
      const aBig = await account({ kind: "platform", label: OVERFLOW }, "platform_revenue", "USD");
      const aBigContra = await account({ kind: "platform", label: OVERFLOW }, "refund_liability", "USD");
      const post = () => postPaymentTransaction(sc, capture({
        kind: "fee", originalAmountMinor: big,
        attribution: { ...capture().attribution, beneficiaryAccountId: aBig },
        entries: [{ accountId: aBig, amountMinor: big, entryReason: "adjustment" }, { accountId: aBigContra, amountMinor: `-${big}`, entryReason: "adjustment" }],
      }));
      for (let i = 0; i < 9; i++) {
        const r = await post();
        assert.equal(r.ok, true, `post ${i}: ${JSON.stringify(r)}`);
      }
      const held = () => scalar(`SELECT balance_minor::text FROM public.payment_account_balances WHERE account_id = '${aBig}'`);
      assert.equal(held(), "8999999999999999991");
      const before = ledgerSnapshot();
      const tenth = await post();
      assert.equal(tenth.ok, false);
      if (!tenth.ok) { assert.equal(tenth.reason, "amount_out_of_range", JSON.stringify(tenth)); assert.match(tenth.detail, /payment_amount_out_of_range/); }
      assert.deepEqual(ledgerSnapshot(), before, "nothing of the refused posting persists");
      assert.equal(held(), "8999999999999999991");
      assert.equal(drift(), 0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  describe("C — concurrency", () => {
    test("C1. twenty concurrent posts on ONE account all land, and the projection is their fold", async () => {
      const start = balance(aPayee), startCount = transactionCount();
      const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
        psqlAsync(postSql(rawPayload(`c1-${RUN}-${i}`, "capture", [[aPayer, -37, "principal"], [aPayee, 37, "principal"]], aPayee)))));
      assert.deepEqual(results.filter((r) => r.status !== 0).map((r) => r.stderr), [], "none was refused or deadlocked");
      assert.equal(transactionCount(), startCount + 20);
      assert.equal(balance(aPayee), start + 20 * 37, "no update was lost");
      assert.equal(balance(aPayee), fold(aPayee));
      assert.equal(drift(), 0);
      assert.equal(unbalanced(), 0);
    });

    test("C2. twelve concurrent posts of ONE key land exactly once; the rest are replays of it", async () => {
      const start = balance(aPayee), startCount = transactionCount();
      const payload = rawPayload(`c2-${RUN}`, "capture", [[aPayer, -501, "principal"], [aPayee, 501, "principal"]], aPayee);
      const results = await Promise.all(Array.from({ length: 12 }, () => psqlAsync(postSql(payload))));
      assert.deepEqual(results.filter((r) => r.status !== 0).map((r) => r.stderr), []);
      const parsed = results.map((r) => JSON.parse(r.stdout.trim()));
      assert.equal(parsed.filter((p) => p.replayed === false).length, 1, "exactly one wrote");
      assert.equal(parsed.filter((p) => p.replayed === true).length, 11);
      assert.equal(new Set(parsed.map((p) => p.transaction_id)).size, 1, "every caller was given the same transaction");
      assert.equal(transactionCount(), startCount + 1);
      assert.equal(balance(aPayee), start + 501, "booked once");
      assert.equal(drift(), 0);
    });

    test("C3. ten concurrent payouts of the whole balance: exactly one wins, nine are refused, the balance never goes below zero", async () => {
      const start = balance(aPayee);
      assert.ok(start > 0);
      const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
        psqlAsync(postSql(rawPayload(`c3-${RUN}-${i}`, "payout", [[aPayee, -start, "payout"], [aClearing, start, "payout"]], aClearing)))));
      const won = results.filter((r) => r.status === 0);
      const refused = results.filter((r) => r.status !== 0);
      assert.equal(won.length, 1, results.map((r) => r.stderr).join("\n"));
      assert.equal(refused.length, 9);
      assert.ok(refused.every((r) => pgError(r.stderr).code === "PL402"), refused.map((r) => r.stderr).join("\n"));
      assert.equal(balance(aPayee), 0);
      assert.equal(drift(), 0);
      assert.equal(unbalanced(), 0);
    });

    test("C4. opposite account orders do not deadlock: twenty concurrent posts over the same two accounts, half each way", async () => {
      const startRevenue = balance(aRevenue), startRefunds = balance(aRefunds);
      const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
        psqlAsync(postSql(i % 2 === 0
          ? rawPayload(`c4-${RUN}-${i}`, "fee", [[aRevenue, 3, "adjustment"], [aRefunds, -3, "adjustment"]], aRevenue)
          : rawPayload(`c4-${RUN}-${i}`, "fee", [[aRefunds, 3, "adjustment"], [aRevenue, -3, "adjustment"]], aRefunds)))));
      assert.deepEqual(results.filter((r) => r.status !== 0).map((r) => r.stderr), [], "no deadlock, no refusal");
      assert.equal(balance(aRevenue), startRevenue);
      assert.equal(balance(aRefunds), startRefunds);
      assert.equal(drift(), 0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  describe("D — each party reads only its side", () => {
    let booking = "", bookingTx = "";

    before(async () => {
      const req = capture({ externalRef: `pi_scoped_${RUN}` });
      booking = req.attribution.causeId;
      const r = await postPaymentTransaction(sc, req);
      assert.equal(r.ok, true, JSON.stringify(r));
      if (r.ok) bookingTx = r.transactionId;
    });

    test("D1. the payer reads the entries naming the payer's account, the payee theirs — disjoint, and never the platform's", async () => {
      const all = rows<any>(`SELECT id, account_id FROM public.payment_ledger_entries WHERE transaction_id = '${bookingTx}'`);
      assert.equal(all.length, 4);
      const asPayer = await readPartyLedger(sc, payer, { cause: { kind: "booking", id: booking } });
      const asPayee = await readPartyLedger(sc, payee, { cause: { kind: "booking", id: booking } });
      assert.equal(asPayer.ok && asPayee.ok, true);
      if (!asPayer.ok || !asPayee.ok) return;
      assert.deepEqual(asPayer.entries.map((e) => [e.accountId, e.amountMinor, e.entryReason]), [[aPayer, "-11000", "principal"]]);
      assert.deepEqual(
        asPayee.entries.map((e) => [e.accountId, e.amountMinor, e.entryReason]).sort(),
        [[aPayee, "1000", "tip"], [aPayee, "9000", "principal"]],
      );
      const seen = new Set([...asPayer.entries, ...asPayee.entries].map((e) => e.entryId));
      assert.equal(seen.size, 3, "disjoint");
      const unseen = all.filter((e) => !seen.has(e.id));
      assert.deepEqual(unseen.map((e) => e.account_id), [aRevenue], "the platform's fee entry is in neither read");
      assert.ok(asPayer.entries.every((e) => e.transactionId === bookingTx && e.causeId === booking && e.transactionKind === "capture"));
      // Accounts and balances are the caller's own too.
      assert.deepEqual(asPayer.accounts.map((a) => a.accountId), [aPayer]);
      assert.deepEqual(asPayee.accounts.map((a) => a.accountId).sort(), [aPayee, aPayeeEur].sort());
      assert.equal(asPayee.accounts.find((a) => a.accountId === aPayee)!.balanceMinor, String(balance(aPayee)));
      assert.equal(asPayee.accounts.find((a) => a.accountId === aPayeeEur)!.balanceMinor, "0", "an account with no entries reads as zero");
    });

    test("D2. a counterparty read returns nothing: a party not in the booking, and a profile with no party at all", async () => {
      const third = await readPartyLedger(sc, other, { cause: { kind: "booking", id: booking } });
      assert.equal(third.ok, true);
      if (third.ok) { assert.equal(third.hasParty, true); assert.deepEqual(third.entries, []); assert.deepEqual(third.accounts.map((a) => a.accountId), [aOther]); }
      const nobody = seedUser("paybnoparty");
      users.push(nobody);
      const none = await readPartyLedger(sc, nobody);
      assert.deepEqual(none, { ok: true, hasParty: false, accounts: [], entries: [], nextCursor: null });
      // The whole ledger of each side contains no entry on anyone else's account.
      for (const [who, mine] of [[payer, [aPayer]], [payee, [aPayee, aPayeeEur]], [other, [aOther]]] as const) {
        const r = await readPartyLedger(sc, who, { limit: 200 });
        assert.equal(r.ok, true);
        if (r.ok) assert.ok(r.entries.every((e) => (mine as readonly string[]).includes(e.accountId)), who);
      }
    });

    test("D3. nothing of the counterparty is in the response: no account id, no profile id, no processor reference, no key", () => {
      const asPayer = as("service_role", `SELECT public.payment_party_ledger(${jsonLiteral({ profile_id: payer, limit: 200 })})::text;`).stdout;
      for (const [what, needle] of [["payee account", aPayee], ["payee profile", payee], ["platform account", aRevenue],
                                    ["processor reference", `pi_scoped_${RUN}`], ["idempotency key", `${booking}:capture`], ["scope", SCOPE]] as const) {
        assert.equal(asPayer.includes(needle), false, `the payer's read contains the ${what}`);
      }
      assert.ok(asPayer.includes(aPayer), "it does contain the payer's own account");
      const asPayee = as("service_role", `SELECT public.payment_party_ledger(${jsonLiteral({ profile_id: payee, limit: 200 })})::text;`).stdout;
      for (const needle of [aPayer, payer, aRevenue, `pi_scoped_${RUN}`]) assert.equal(asPayee.includes(needle), false);
    });

    test("D4. pagination: newest first, a keyset cursor, every entry once", async () => {
      const whole = await readPartyLedger(sc, payee, { limit: 200 });
      assert.equal(whole.ok, true);
      if (!whole.ok) return;
      assert.ok(whole.entries.length >= 5);
      assert.equal(whole.nextCursor, null);
      const paged: string[] = [];
      let cursor: any = null;
      for (let i = 0; i < 100; i++) {
        const page = await readPartyLedger(sc, payee, { limit: 2, cursor });
        assert.equal(page.ok, true, JSON.stringify(page));
        if (!page.ok) return;
        assert.ok(page.entries.length <= 2);
        paged.push(...page.entries.map((e) => e.entryId));
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      assert.deepEqual(paged, whole.entries.map((e) => e.entryId), "the pages concatenate to the whole, in order, with no repeat");
      const times = whole.entries.map((e) => Date.parse(e.occurredAt));
      assert.deepEqual(times, [...times].sort((a, b) => b - a));
    });

    test("D5. a failed read is an error, never an empty list", async () => {
      const badCursor = await readPartyLedger(sc, payee, { cursor: { beforeOccurredAt: "not-a-time", beforeEntryId: randomUUID() } });
      assert.equal(badCursor.ok === false && badCursor.reason, "invalid_request");
      const halfCause = await readPartyLedger(sc, payee, { cause: { kind: "booking", id: undefined as any } });
      assert.equal(halfCause.ok === false && halfCause.reason, "invalid_request");
      const notAUuid = await readPartyLedger(sc, "not-a-profile");
      assert.equal(notAUuid.ok === false && notAUuid.reason, "invalid_request");
      const tooMany = await readPartyLedger(sc, payee, { limit: 201 });
      assert.equal(tooMany.ok === false && tooMany.reason, "invalid_request");
      // A role that may not read gets a permission error from the database — not `[]`.
      const denied = as("authenticated", `SELECT public.payment_party_ledger(${jsonLiteral({ profile_id: payee })});`);
      assert.equal(denied.error?.code, "42501");
    });

    test("D6. PAY-072: the ownership predicate is in authz, pinned, not a client's to call — and answers per account", () => {
      const f = rows<any>(
        `SELECT n.nspname AS s, p.prosecdef AS d, p.proconfig::text AS c FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE p.proname = 'payment_account_owned_by_profile'`);
      assert.deepEqual(f, [{ s: "authz", d: false, c: `{"search_path=pg_catalog, pg_temp"}` }]);
      const owned = (accountId: string, profileId: string) =>
        scalar(`SELECT authz.payment_account_owned_by_profile('${accountId}', '${profileId}')`);
      assert.equal(owned(aPayee, payee), "t");
      assert.equal(owned(aPayee, payer), "f", "the counterparty does not own the payee's account");
      assert.equal(owned(aPayer, payee), "f");
      assert.equal(owned(aRevenue, payee), "f", "nobody owns a platform account");
      assert.equal(scalar(`SELECT authz.payment_account_owned_by_profile('${aPayee}', NULL)`), "f");
      for (const role of ["anon", "authenticated"] as const) {
        assert.equal(as(role, `SELECT authz.payment_account_owned_by_profile('${aPayee}', '${payee}');`).error?.code, "42501", role);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  describe("E — pseudonymisation: the identity goes, the accounting stays", () => {
    let aErased = "", aErasedReceivable = "";
    let erasedTx = "";

    before(async () => {
      aErased = await account({ kind: "user", profileId: erased }, "user_payable", "USD");
      aErasedReceivable = await account({ kind: "user", profileId: erased }, "user_receivable", "USD");
      const earn = await postPaymentTransaction(sc, capture({
        externalRef: `pi_erased_${RUN}`,
        attribution: { ...capture().attribution, beneficiaryAccountId: aErased },
        entries: [
          { accountId: aPayer, amountMinor: -8000, entryReason: "principal" },
          { accountId: aErased, amountMinor: 7200, entryReason: "principal" },
          { accountId: aRevenue, amountMinor: 800, entryReason: "platform_fee" },
        ],
        originalAmountMinor: 8000,
      }));
      assert.equal(earn.ok, true, JSON.stringify(earn));
      if (earn.ok) erasedTx = earn.transactionId;
      const owe = await postPaymentTransaction(sc, capture({
        kind: "charge", originalAmountMinor: 300,
        attribution: { ...capture().attribution, beneficiaryAccountId: aPayee },
        entries: [{ accountId: aErasedReceivable, amountMinor: -300, entryReason: "principal" }, { accountId: aPayee, amountMinor: 300, entryReason: "principal" }],
      }));
      assert.equal(owe.ok, true, JSON.stringify(owe));
    });

    const openOnErased = () => [
      { accountId: aErased, accountType: "user_payable", currency: "USD", balanceMinor: "7200" },
      { accountId: aErasedReceivable, accountType: "user_receivable", currency: "USD", balanceMinor: "-300" },
    ];

    test("E1. an OPEN BALANCE refuses the removal by name, lists what is open, and changes nothing", async () => {
      const before = ledgerSnapshot();
      assert.equal(balance(aErased), 7200);
      assert.equal(balance(aErasedReceivable), -300);
      for (const options of [undefined, { onOpenBalance: "refuse" as const }]) {
        const r = await removePaymentIdentity(sc, erased, options);
        assert.equal(r.ok, false, JSON.stringify(r));
        if (r.ok) return;
        assert.equal(r.reason, "open_balance");
        assert.match(r.detail, /payment_open_balance/);
        assert.deepEqual(r.openBalances, openOnErased(), "what is owed, and what is owing, is named");
      }
      // The explicit argument has two values; anything else is not quietly treated as either.
      const unknown = await removePaymentIdentity(sc, erased, { onOpenBalance: "escheat" as any });
      assert.equal(unknown.ok === false && unknown.reason, "invalid_request", JSON.stringify(unknown));
      if (!unknown.ok) assert.match(unknown.detail, /on_open_balance/);
      // Refused means untouched: still linked, still readable by its owner, no row changed.
      assert.deepEqual(ledgerSnapshot(), before);
      assert.equal(scalar(`SELECT count(*) FROM public.payment_parties WHERE profile_id = '${erased}' AND identity_removed_at IS NULL`), "1");
      const mine = await readPartyLedger(sc, erased, { limit: 0 });
      assert.equal(mine.ok && mine.hasParty && mine.accounts.length === 2, true);
    });

    test("E2. retain: the identity goes, NO ledger row and NO balance changes, and the open balances stay addressable by party id", async () => {
      const before = ledgerSnapshot();
      const balances = Object.fromEntries(accounts.map((a) => [a, balance(a)]));
      assert.ok(mentions(erased) >= 1, "before: the party row links the profile");
      const partyId = scalar(`SELECT owner_id FROM public.payment_accounts WHERE id = '${aErased}'`)!;

      const r = await removePaymentIdentity(sc, erased, { onOpenBalance: "retain" });
      assert.equal(r.ok, true, JSON.stringify(r));
      if (!r.ok) return;
      assert.equal(r.removed, true);
      assert.equal(r.accounts, 2);
      assert.equal(r.entriesRetained, 2);
      assert.ok(r.identityRemovedAt);
      assert.equal(r.retentionPeriod, null, "the retention period is undecided");
      assert.equal(r.retainUntil, null);
      assert.equal(r.identifiersScrubbed, 0, "the door kept the profile id out of every transaction, so there was nothing to rewrite");
      assert.deepEqual(r.openBalances, openOnErased());
      assert.equal(r.partyId, partyId, "with a balance left open, the pseudonym is the handle on it");

      assert.deepEqual(ledgerSnapshot(), before, "every transaction, entry, account and balance row is byte-identical");
      for (const a of accounts) assert.equal(balance(a), balances[a], a);
      assert.equal(mentions(erased), 0, "no payment row, in any column, mentions the erased profile");
      assert.equal(mentions(erased.replace(/-/g, "")), 0);
      assert.equal(drift(), 0);
      assert.equal(unbalanced(), 0);
      const party = rows<any>(
        `SELECT pt.profile_id, pt.identity_removed_at IS NOT NULL AS stamped, pt.identity_removed_via AS via, pt.kind
           FROM public.payment_parties pt JOIN public.payment_accounts a ON a.owner_id = pt.id WHERE a.id = '${aErased}'`)[0];
      assert.deepEqual(party, { profile_id: null, stamped: true, via: "erasure_request", kind: "user" });
      // NOT ORPHANED: the party id returned finds the accounts and what stands on them, as service_role reads.
      const found = as("service_role",
        `SELECT a.id || '=' || b.balance_minor FROM public.payment_accounts a JOIN public.payment_account_balances b ON b.account_id = a.id
          WHERE a.owner_id = '${r.partyId}' ORDER BY a.account_type;`);
      assert.deepEqual(found.stdout.trim().split("\n"), [`${aErased}=7200`, `${aErasedReceivable}=-300`]);
      assert.equal(scalar(`SELECT count(*) FROM public.profiles WHERE id = '${erased}'`), "1", "the profile row itself is untouched (the tombstone is the deletion service's)");
    });

    test("E3. after removal: the erased profile reads nothing, the counterparty's read is unchanged, and the retained balance is still settled by account", async () => {
      const gone = await readPartyLedger(sc, erased, { limit: 200 });
      assert.deepEqual(gone, { ok: true, hasParty: false, accounts: [], entries: [], nextCursor: null });
      assert.equal(scalar(`SELECT authz.payment_account_owned_by_profile('${aErased}', '${erased}')`), "f");
      const payerSide = await readPartyLedger(sc, payer, { limit: 200 });
      assert.equal(payerSide.ok && payerSide.entries.some((e) => e.transactionId === erasedTx && e.amountMinor === "-8000"), true);
      // What is owed to the pseudonymous party is paid out by ACCOUNT: no identity is needed.
      const settle = await postPaymentTransaction(sc, capture({
        kind: "payout", originalAmountMinor: 7200,
        attribution: { ...capture().attribution, beneficiaryAccountId: aClearing },
        entries: [{ accountId: aErased, amountMinor: -7200, entryReason: "payout" }, { accountId: aClearing, amountMinor: 7200, entryReason: "payout" }],
      }));
      assert.equal(settle.ok, true, JSON.stringify(settle));
      assert.equal(balance(aErased), 0);
      // A late chargeback is addressed the same way and obeys the same rules.
      const late = await postPaymentTransaction(sc, capture({
        kind: "chargeback", originalAmountMinor: 8000, externalRef: `dp_erased_${RUN}`,
        attribution: { ...capture().attribution, beneficiaryAccountId: aClearing },
        entries: [{ accountId: aErased, amountMinor: -8000, entryReason: "chargeback" }, { accountId: aClearing, amountMinor: 8000, entryReason: "chargeback" }],
      }));
      assert.equal(late.ok, true, JSON.stringify(late));
      assert.equal(balance(aErased), -8000);
      assert.equal(drift(), 0);
      assert.equal(unbalanced(), 0);
    });

    test("E4. idempotent and irreversible: a second removal does nothing; the link cannot be restored or repointed", async () => {
      const again = await removePaymentIdentity(sc, erased, { onOpenBalance: "retain" });
      assert.deepEqual(again, {
        ok: true, removed: false, accounts: 0, entriesRetained: 0, identityRemovedAt: null, retentionPeriod: null, retainUntil: null,
        identifiersScrubbed: 0, openBalances: [],
      });
      const partyId = scalar(`SELECT owner_id FROM public.payment_accounts WHERE id = '${aErased}'`)!;
      for (const set of [`profile_id = '${erased}'`, `profile_id = '${payer}'`, `identity_removed_at = NULL`, `kind = 'platform'`, `label = 'x'`]) {
        const r = owner(`UPDATE public.payment_parties SET ${set} WHERE id = '${partyId}';`);
        assert.equal(r.error?.code, "PL005", `${set}: ${r.stderr}`);
      }
      assert.equal(owner(`DELETE FROM public.payment_parties WHERE id = '${partyId}';`).error?.code, "PL001");
      assert.equal(as("service_role", `UPDATE public.payment_parties SET profile_id = NULL WHERE id = '${partyId}';`).error?.code, "42501", "only the door removes a link");
      // A live party cannot be re-pointed at another person either.
      const live = scalar(`SELECT owner_id FROM public.payment_accounts WHERE id = '${aPayee}'`)!;
      assert.equal(owner(`UPDATE public.payment_parties SET profile_id = '${payer}' WHERE id = '${live}';`).error?.code, "PL005");
    });

    test("E5. a profile's hard deletion is neither blocked by its ledger rows nor deletes them: the link is removed, the records stay", async () => {
      const aHard = await account({ kind: "user", profileId: hardDeleted }, "user_payable", "USD");
      const earn = await postPaymentTransaction(sc, capture({
        attribution: { ...capture().attribution, beneficiaryAccountId: aHard }, originalAmountMinor: 500,
        entries: [{ accountId: aPayer, amountMinor: -500, entryReason: "principal" }, { accountId: aHard, amountMinor: 500, entryReason: "principal" }],
      }));
      assert.equal(earn.ok, true, JSON.stringify(earn));
      const before = ledgerSnapshot();
      // As service_role, the way an operator's delete would run: the cascade needs no grant.
      const del = as("service_role", `DELETE FROM public.profiles WHERE id = '${hardDeleted}';`);
      assert.equal(del.status, 0, JSON.stringify(del.error));
      assert.equal(scalar(`SELECT count(*) FROM public.profiles WHERE id = '${hardDeleted}'`), "0");
      assert.deepEqual(ledgerSnapshot(), before, "no ledger row changed");
      assert.equal(balance(aHard), 500);
      assert.equal(mentions(hardDeleted), 0);
      // The foreign key cannot refuse, so a balance open at that moment stays on a party that SAYS how it lost its link.
      assert.deepEqual(
        rows<any>(`SELECT pt.id, pt.profile_id, pt.identity_removed_via AS via, pt.identity_removed_at IS NOT NULL AS stamped FROM public.payment_parties pt JOIN public.payment_accounts a ON a.owner_id = pt.id WHERE a.id = '${aHard}'`),
        [{ id: partyOf[aHard], profile_id: null, via: "profile_deleted", stamped: true }],
      );
      assert.equal(drift(), 0);
    });

    test("E6. the retention period is ONE configurable value, undecided by default, and nothing deletes", () => {
      assert.deepEqual(rows<any>(`SELECT retention_period, decision_ref FROM public.payment_retention_settings`), [{ retention_period: null, decision_ref: null }]);
      // A period needs its decision recorded; a second row is impossible.
      assert.match(owner(`UPDATE public.payment_retention_settings SET retention_period = '7 years';`).error!.message, /prs_decision_recorded/);
      assert.equal(owner(`INSERT INTO public.payment_retention_settings (singleton) VALUES (false);`).error?.code, "23514");
      // With a period configured, the door reports when retention would end — and still deletes nothing.
      const probe = seedUser("paybretention");
      users.push(probe);
      const out = psql(
        `BEGIN;\nUPDATE public.payment_retention_settings SET retention_period = interval '7 years', decision_ref = 'test fixture';\n` +
        `SELECT public.payment_account_ensure(${jsonLiteral({ owner_kind: "user", profile_id: probe, account_type: "user_payable", currency: "USD" })})->>'created';\n` +
        `SELECT r->>'retention_period' || '|' || ((r->>'retain_until')::timestamptz = (r->>'identity_removed_at')::timestamptz + interval '7 years')::text\n` +
        `  FROM public.payment_party_remove_identity(${jsonLiteral({ profile_id: probe })}) AS r;\n` +
        `SELECT count(*) FROM public.payment_parties WHERE identity_removed_at IS NOT NULL AND profile_id IS NULL AND created_at > now() - interval '1 minute';\nROLLBACK;`);
      assert.equal(out.status, 0, out.stderr);
      const lines = out.stdout.trim().split("\n");
      assert.equal(lines[0], "true");
      assert.equal(lines[1], "7 years|true");
      assert.ok(Number(lines[2]) >= 1, "the party is retained after its identity is removed");
      assert.deepEqual(rows<any>(`SELECT retention_period FROM public.payment_retention_settings`), [{ retention_period: null }], "the fixture period was rolled back");
      // No deletion job: no function deletes a payment row, and no role but the owner holds DELETE.
      assert.equal(Number(scalar(`SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('public', 'authz') AND p.prosrc ~* 'delete\\s+from\\s+(public\\.)?payment_'`)), 0);
      for (const t of ["payment_parties", "payment_accounts", "payment_transactions", "payment_ledger_entries", "payment_account_balances"]) {
        assert.equal(scalar(`SELECT has_table_privilege('service_role', 'public.${t}', 'DELETE')`), "f", t);
      }
    });

    test("E7. the same profile transacting again gets a NEW party: the removed link is not quietly rebuilt, and the old balance is not lost with it", async () => {
      const oldParty = scalar(`SELECT owner_id FROM public.payment_accounts WHERE id = '${aErased}'`)!;
      const fresh = await account({ kind: "user", profileId: erased }, "user_payable", "USD");
      assert.notEqual(fresh, aErased);
      const newParty = scalar(`SELECT owner_id FROM public.payment_accounts WHERE id = '${fresh}'`)!;
      assert.notEqual(newParty, oldParty);
      assert.equal(scalar(`SELECT profile_id IS NULL FROM public.payment_parties WHERE id = '${oldParty}'`), "t");
      const r = await readPartyLedger(sc, erased, { limit: 200 });
      assert.equal(r.ok && r.hasParty && r.entries.length === 0 && r.accounts.length === 1, true, "the old records are not readable through the new party");
      // The old party's balances are where they were, under the id the retain call handed back.
      assert.equal(balance(aErased), -8000);
      assert.equal(balance(aErasedReceivable), -300);
      assert.equal(scalar(`SELECT count(*) FROM public.payment_accounts WHERE owner_id = '${oldParty}'`), "2");
    });

    test("E8. settle first: once every balance is zero the default removal succeeds, and hands back no pseudonym", async () => {
      const settled = seedUser("paybsettled");
      users.push(settled);
      const aSettled = await account({ kind: "user", profileId: settled }, "user_payable", "USD");
      const earn = await postPaymentTransaction(sc, capture({
        attribution: { ...capture().attribution, beneficiaryAccountId: aSettled }, originalAmountMinor: 10000,
        entries: [{ accountId: aPayer, amountMinor: -10000, entryReason: "principal" }, { accountId: aSettled, amountMinor: 10000, entryReason: "principal" }],
      }));
      assert.equal(earn.ok, true, JSON.stringify(earn));
      // The verifier's case: a payee with 10000 payable. It is no longer erasable by default …
      const refused = await removePaymentIdentity(sc, settled);
      assert.equal(refused.ok === false && refused.reason, "open_balance", JSON.stringify(refused));
      if (!refused.ok) assert.deepEqual(refused.openBalances, [{ accountId: aSettled, accountType: "user_payable", currency: "USD", balanceMinor: "10000" }]);
      // … so a re-ensure still resolves to the SAME party and account: nothing was orphaned.
      const same = await ensurePaymentAccount(sc, { owner: { kind: "user", profileId: settled }, accountType: "user_payable", currency: "USD" });
      assert.deepEqual(same, { ok: true, accountId: aSettled, partyId: partyOf[aSettled], created: false });
      const payout = await postPaymentTransaction(sc, capture({
        kind: "payout", originalAmountMinor: 10000,
        attribution: { ...capture().attribution, beneficiaryAccountId: aClearing },
        entries: [{ accountId: aSettled, amountMinor: -10000, entryReason: "payout" }, { accountId: aClearing, amountMinor: 10000, entryReason: "payout" }],
      }));
      assert.equal(payout.ok, true, JSON.stringify(payout));
      const r = await removePaymentIdentity(sc, settled);
      assert.equal(r.ok, true, JSON.stringify(r));
      if (!r.ok) return;
      assert.deepEqual(
        { removed: r.removed, accounts: r.accounts, entriesRetained: r.entriesRetained, open: r.openBalances, scrubbed: r.identifiersScrubbed },
        { removed: true, accounts: 1, entriesRetained: 2, open: [], scrubbed: 0 });
      assert.equal("partyId" in r, false, "with nothing left open, the pseudonym is not handed to a caller who holds the profile id");
      assert.equal(mentions(settled), 0);
      assert.equal(drift(), 0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  describe("G — what the independent verification of #598 found, kept as regressions", () => {
    /** A jsonb literal that names its type by schema: the session's own casts must not meet a pg_temp shadow. */
    const j = (v: unknown) => jsonLiteral(v).replace(/::jsonb$/, "::pg_catalog.jsonb");

    test("G1. pg_temp cannot shadow a type inside a payment function: the verifier's CREATE DOMAIN pg_temp.uuid … CHECK (pg_temp.evil()) never runs", () => {
      const floor = () => scalar(`SELECT floor_enforced::text || '/' || overdraft_kinds::text FROM public.payment_balance_rules WHERE account_type = 'user_payable'`);
      assert.equal(floor(), "true/{chargeback}");
      const variants: Array<[string, string]> = [
        // The verifier's payload: as the table owner this UPDATE succeeds, and I6 is switched off for every payee.
        ["flips the balance rule", `UPDATE public.payment_balance_rules SET floor_enforced = false WHERE account_type = 'user_payable';`],
        // Any invocation at all, under any role, fails the statement that caused it.
        ["raises", `RAISE EXCEPTION 'pg_temp.evil() ran as %', current_user;`],
      ];
      for (const [name, body] of variants) {
        const probe = seedUser("paybtemp");
        users.push(probe);
        const key = `temp-${RUN}-${randomUUID().slice(0, 8)}`;
        const script =
          `\\set VERBOSITY verbose\nSET LOCAL ROLE service_role;\n` +
          `CREATE FUNCTION pg_temp.evil() RETURNS boolean LANGUAGE plpgsql AS $evil$ BEGIN ${body} RETURN true; END $evil$;\n` +
          ["uuid", "text", "jsonb", "timestamptz", "numeric", "int8", "int4", "bool", "interval"]
            .map((t) => `CREATE DOMAIN pg_temp.${t} AS pg_catalog.${t} CHECK (pg_temp.evil());`).join("\n") + "\n" +
          `SELECT public.payment_account_ensure(${j({ owner_kind: "user", profile_id: probe, account_type: "user_payable", currency: "USD" })})->>'account_id';\n` +
          `SELECT public.payment_post_transaction(${j(rawPayload(key, "capture", [[aPayer, -9, "principal"], [aPayee, 9, "principal"]], aPayee))})->>'replayed';\n` +
          `SELECT public.payment_party_ledger(${j({ profile_id: probe, limit: 5 })})->>'has_party';\n` +
          `SELECT public.payment_party_remove_identity(${j({ profile_id: probe })})->>'removed';\n`;
        const r = psql(script, { single: true });
        assert.equal(r.status, 0, `${name}: ${r.stderr}`);
        const out = r.stdout.trim().split("\n");
        assert.match(out[0]!, /^[0-9a-f-]{36}$/, name);
        accounts.push(out[0]!);
        assert.deepEqual(out.slice(1), ["false", "true", "true"], `${name}: all four doors answered`);
        assert.equal(floor(), "true/{chargeback}", `${name}: the balance rule is what it was`);
        assert.equal(scalar(`SELECT count(*) FROM public.payment_transactions WHERE scope = '${SCOPE}' AND idempotency_key = '${key}'`), "1", "the post committed: the deferred checks ran too");
      }
      assert.equal(drift(), 0);
    });

    test("G2. no envelope names a person: the verifier's inputs — a profile id as key, cause and subject, an email as the processor reference — are refused at the door", async () => {
      const before = ledgerSnapshot();
      const n = transactionCount();
      const noParty = seedUser("paybnamed");
      users.push(noParty);
      const at = () => capture().attribution;
      const cases: Array<[string, Partial<PostPaymentTransactionInput>, RegExp]> = [
        ["profile id as the idempotency key", { idempotencyKey: payee }, /person_identifier — idempotency_key/],
        ["profile id as the cause", { attribution: { ...at(), causeId: payee } }, /person_identifier — cause_id/],
        ["profile id as the subject", { attribution: { ...at(), subjectId: payee } }, /person_identifier — subject_id/],
        ["an email as the processor reference", { externalRef: "a.traveller@example.test" }, /ptx_external_ref_shape/],
        // … and the same thing spelled other ways, or about other people.
        ["profile id inside a key", { idempotencyKey: `tip:${payee}:1` }, /person_identifier — idempotency_key/],
        ["dashless", { idempotencyKey: `tip:${payee.replace(/-/g, "")}:1` }, /person_identifier — idempotency_key/],
        ["upper case", { attribution: { ...at(), causeId: `USER-${payee.toUpperCase()}` } }, /person_identifier — cause_id/],
        ["the payer's profile id (a party the transaction debits)", { attribution: { ...at(), subjectId: payer } }, /person_identifier — subject_id/],
        ["the profile of someone the transaction does not touch", { attribution: { ...at(), causeId: stranger } }, /person_identifier — cause_id/],
        ["the profile of someone with no payment party at all", { attribution: { ...at(), subjectId: noParty } }, /person_identifier — subject_id/],
        ["a profile id in the scope", { scope: `http:tip:${payee}` }, /person_identifier — scope/],
        ["a profile id as the processor reference", { externalRef: `pi_${payee}` }, /person_identifier — external_ref/],
        ["an email as the cause", { attribution: { ...at(), causeId: "a.traveller@example.test" } }, /ptx_no_contact_details/],
        ["an email inside a key", { idempotencyKey: "tip:a.traveller@example.test:1" }, /ptx_no_contact_details/],
        ["a phone number as the subject", { attribution: { ...at(), subjectId: "+1 415 555 0100" } }, /ptx_no_contact_details/],
        ["a phone number inside a key", { idempotencyKey: "tip:+14155550100:1" }, /ptx_no_contact_details/],
        ["a bare number as the cause", { attribution: { ...at(), causeId: "4155550100" } }, /ptx_no_contact_details/],
        ["free text as the processor reference", { externalRef: "paid in cash to Sam" }, /ptx_external_ref_shape/],
      ];
      for (const [name, over, detail] of cases) {
        const r = await postPaymentTransaction(sc, capture(over));
        assert.equal(r.ok, false, name);
        if (!r.ok) { assert.equal(r.reason, "invalid_request", `${name}: ${JSON.stringify(r)}`); assert.match(r.detail, detail, name); }
      }
      assert.equal(transactionCount(), n);
      assert.deepEqual(ledgerSnapshot(), before, "nothing of any refused request persists");
      // The door is the TABLE's, so it holds for the owner too …
      const direct = owner(envelopeSql(randomUUID(), { cause_id: `'${payee}'` }));
      assert.equal(direct.error?.code, "PL422", direct.stderr);
      assert.match(owner(envelopeSql(randomUUID(), { external_ref: `'a.traveller@example.test'` })).error!.message, /ptx_external_ref_shape/);
      // … and a person IS nameable — by payment party id, the ledger's pseudonym; a numbered thing by what it is.
      const byParty = await postPaymentTransaction(sc, capture({ attribution: { ...at(), causeId: `party:${partyOf[aPayee]}`, subjectId: "booking:4155550100" } }));
      assert.equal(byParty.ok, true, JSON.stringify(byParty));
      assert.equal(drift(), 0);
    });

    test("G3. what was written AROUND the door is scrubbed when the identity is removed — by the erasure door and by the foreign key — and the scrub is the only UPDATE an envelope admits", async () => {
      const target = seedUser("paybscrub");
      users.push(target);
      const aTarget = await account({ kind: "user", profileId: target }, "user_payable", "USD");
      const party = partyOf[aTarget]!;
      const dashless = (id: string) => id.replace(/-/g, "");
      const ids = [randomUUID(), randomUUID(), randomUUID()].sort();
      const plant = (id: string, cols: Record<string, string>) => `${envelopeSql(id, cols)}\n${entrySql(id, aDirA, 500)}\n${entrySql(id, aDirB, -500)}\n`;
      // Only a superuser can do this: with triggers off, the door (ptx_admit) does not run.
      exec(
        "SET session_replication_role = replica;\n" +
        // The verifier's exact inputs: the profile uuid as idempotency_key, cause_id and subject_id.
        plant(ids[0]!, { idempotency_key: `'${target}'`, cause_id: `'${target}'`, subject_id: `'${target}'` }) +
        plant(ids[1]!, { scope: `'${SCOPE}-x-${target}'`, idempotency_key: `'planted-${RUN}'`, external_ref: `'pi_${dashless(target)}'` }) +
        plant(ids[2]!, { cause_id: `'user:${target.toUpperCase()}'` }) +
        "SET session_replication_role = origin;");
      assert.ok(mentions(target) >= 3);
      assert.ok(mentions(dashless(target)) >= 1);
      const money = () => rows<any>(
        `SELECT (to_jsonb(t) - 'scope' - 'idempotency_key' - 'cause_id' - 'subject_id' - 'attribution_version' - 'external_ref' - 'fx_rate_source')::text AS t,
                (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id)::text FROM public.payment_ledger_entries e WHERE e.transaction_id = t.id) AS e
           FROM public.payment_transactions t WHERE t.id IN (${inList(ids)}) ORDER BY t.id`);
      const before = money();
      const projection = ledgerSnapshot().filter((r) => r.startsWith("ba "));

      // The scrub is the ONLY update an envelope admits. A token written by hand admits nothing else …
      const guarded = (token: string, set: string) =>
        owner(`BEGIN;\nSELECT set_config('portava.payment_identity_scrub', '${token}', true);\nUPDATE public.payment_transactions SET ${set} WHERE id = '${ids[0]}';\nCOMMIT;`);
      for (const set of [`cause_id = 'rewritten'`, `original_amount_minor = 1`, `beneficiary_account_id = '${aDirB}'`, `occurred_at = now()`]) {
        assert.equal(guarded(`${randomUUID()}:${randomUUID()}`, set).error?.code, "PL001", set);
      }
      // … not even alongside the rewrite the token names.
      assert.equal(guarded(`${target}:${party}`, `cause_id = '${party}', subject_id = '${party}', idempotency_key = 'scrubbed:${ids[0]}', original_amount_minor = 1`).error?.code, "PL001");
      assert.equal(guarded(`${target}:${party}`, `cause_id = '${party}'`).error?.code, "PL001", "a partial rewrite is not the scrub either");
      assert.equal(mentions(target) >= 3, true, "nothing was changed by any of those");

      const r = await removePaymentIdentity(sc, target);
      assert.equal(r.ok, true, JSON.stringify(r));
      if (!r.ok) return;
      assert.equal(r.removed, true);
      assert.equal(r.identifiersScrubbed, 3);
      assert.equal(mentions(target), 0, "no payment row mentions the profile id, in any case");
      assert.equal(mentions(dashless(target)), 0, "… or its dashless spelling");
      assert.deepEqual(
        rows<any>(`SELECT id, scope, idempotency_key AS k, cause_id AS c, subject_id AS s, external_ref AS x FROM public.payment_transactions WHERE id IN (${inList(ids)}) ORDER BY id`),
        [
          { id: ids[0], scope: SCOPE, k: `scrubbed:${ids[0]}`, c: party, s: party, x: null },
          { id: ids[1], scope: `${SCOPE}-x-${party}`, k: `scrubbed:${ids[1]}`, c: "direct", s: "direct", x: `pi_${dashless(party)}` },
          { id: ids[2], scope: SCOPE, k: `direct-${ids[2]}`, c: `user:${party}`, s: "direct", x: null },
        ],
        "the person is now named by party id, and a key that carried them is a tombstone",
      );
      assert.deepEqual(money(), before, "amounts, accounts, currency, kind, beneficiary, timestamps and every entry are untouched");
      assert.deepEqual(ledgerSnapshot().filter((x) => x.startsWith("ba ")), projection, "no balance moved");
      assert.equal(unbalanced(), 0);

      // The foreign key's removal (a profile row deleted outright) scrubs the same way.
      const hard = seedUser("paybscrubhard");
      users.push(hard);
      const aHard = await account({ kind: "user", profileId: hard }, "user_payable", "USD");
      const planted = randomUUID();
      exec("SET session_replication_role = replica;\n" + plant(planted, { cause_id: `'${hard}'`, subject_id: `'trip:${dashless(hard)}'` }) + "SET session_replication_role = origin;");
      assert.equal(as("service_role", `DELETE FROM public.profiles WHERE id = '${hard}';`).status, 0);
      assert.equal(mentions(hard) + mentions(dashless(hard)), 0);
      assert.deepEqual(
        rows<any>(`SELECT cause_id AS c, subject_id AS s FROM public.payment_transactions WHERE id = '${planted}'`),
        [{ c: partyOf[aHard], s: `trip:${dashless(partyOf[aHard]!)}` }]);
    });

    test("G4. two users, ONE Idempotency-Key: the scope names the actor, so neither is told 'conflict' for the other's request, and each one's retry is a replay", async () => {
      const KEY = `client-chosen-key-${RUN}`;
      const operation = `test_tip_${RUN}`;
      const aStrangerReceivable = await account({ kind: "user", profileId: stranger }, "user_receivable", "USD");
      const userA = bindIdempotencyKey(KEY, { operation, actorPartyId: partyOf[aPayer]! });
      const userB = bindIdempotencyKey(KEY, { operation, actorPartyId: partyOf[aStrangerReceivable]! });
      assert.equal(userA.ok && userB.ok, true);
      if (!userA.ok || !userB.ok) return;
      assert.equal(userA.idempotencyKey, userB.idempotencyKey, "the same client key …");
      assert.notEqual(userA.scope, userB.scope, "… under two scopes");
      const tip = (bound: { scope: string; idempotencyKey: string }, from: string, amount: number) => capture({
        scope: bound.scope, idempotencyKey: bound.idempotencyKey, originalAmountMinor: amount,
        attribution: { ...capture().attribution, causeKind: "tip" },
        entries: [{ accountId: from, amountMinor: -amount, entryReason: "tip" }, { accountId: aPayee, amountMinor: amount, entryReason: "tip" }],
      });
      const fromA = tip(userA, aPayer, 700), fromB = tip(userB, aStrangerReceivable, 300);
      const start = balance(aPayee);
      const a1 = await postPaymentTransaction(sc, fromA);
      const b1 = await postPaymentTransaction(sc, fromB);
      assert.equal(a1.ok && !a1.replayed, true, JSON.stringify(a1));
      assert.equal(b1.ok && !b1.replayed, true, `user B's different tip under user A's key: ${JSON.stringify(b1)}`);
      if (!a1.ok || !b1.ok) return;
      assert.notEqual(a1.transactionId, b1.transactionId);
      assert.equal(balance(aPayee), start + 1000, "both tips were booked");
      // Each user's retry replays THEIR transaction.
      assert.deepEqual(await postPaymentTransaction(sc, fromA), { ok: true, transactionId: a1.transactionId, replayed: true, balances: [] });
      assert.deepEqual(await postPaymentTransaction(sc, fromB), { ok: true, transactionId: b1.transactionId, replayed: true, balances: [] });
      assert.equal(balance(aPayee), start + 1000, "and booked nothing again");
      // Within ONE user the key still protects: the same key over different money is a conflict.
      const changed = await postPaymentTransaction(sc, { ...tip(userA, aPayer, 701) });
      assert.equal(changed.ok === false && changed.reason, "idempotency_conflict");
      // What the namespace prevents — the same two requests under one route-wide scope: B is refused for good.
      const shared = { scope: SCOPE, idempotencyKey: `${KEY}-shared` };
      assert.equal((await postPaymentTransaction(sc, { ...fromA, ...shared })).ok, true);
      const collided = await postPaymentTransaction(sc, { ...fromB, ...shared });
      assert.equal(collided.ok === false && collided.reason, "idempotency_conflict");
      // The namespace is a PARTY id. A route that passed the profile id instead is stopped by the ledger.
      const wrong = bindIdempotencyKey(KEY, { operation, actorPartyId: payer });
      assert.equal(wrong.ok, true);
      if (!wrong.ok) return;
      const refused = await postPaymentTransaction(sc, tip(wrong, aPayer, 700));
      assert.equal(refused.ok === false && refused.reason, "invalid_request");
      if (!refused.ok) assert.match(refused.detail, /person_identifier — scope/);
      assert.equal(drift(), 0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  test("F1. the read flag is seeded FALSE, and this suite never turned it on", () => {
    assert.deepEqual(rows<any>(`SELECT enabled FROM public.feature_flags WHERE flag = 'payment_ledger_reads_enabled'`), [{ enabled: false }]);
  });

  test("F2. at the end of every flow above: every transaction balances and every projection is its fold", () => {
    assert.ok(transactionCount() > 40);
    assert.equal(unbalanced(), 0);
    assert.equal(drift(), 0);
    assert.equal(Number(scalar(`SELECT count(*) FROM public.payment_transactions WHERE scope LIKE '${SCOPE}%' AND livemode`)), 0);
  });
});
