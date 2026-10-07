/**
 * Account deletion — the creator / Rent-a-Buddy ledgers are PSEUDONYMISED, not
 * deleted and not left naming the person (owner decision C-11 / W10D-B0,
 * migration 3600, census-discovery §107).
 *
 * Under test: services/accountDeletion/AccountDeletionService.ts, step
 * `pseudonymise_creator_ledger`.
 *
 * THE OWNER'S DECISION, verbatim: "Pseudonymize accounting entries, removing
 * direct identifiers and the identity link when deletion is requested. Keep
 * only the records needed for tax, accounting, disputes, or legal claims, with a
 * defined retention period and access controls. GDPR, for example, permits
 * exceptions to erasure where processing is needed to meet a legal obligation or
 * establish or defend legal claims. [GDPR Article 17]"
 *
 * THE GAP THIS CLOSES. 3510's header says it outright: this service keeps an
 * anonymised TOMBSTONE profile and never deletes a `profiles` row, so no key
 * hanging off profiles(id) ever fires and the service names no ledger table at
 * all. Every departed creator's and buddy's uuid therefore sat in four
 * append-only financial tables indefinitely, and the guard that was supposed to
 * decide their fate was never even reached.
 *
 * WHAT IS PROVEN HERE, and each one is mutation-proven (see the matrix in the
 * PR body — reverting any single assertion's cause turns that test RED):
 *
 *   P1  an erasure PSEUDONYMISES rather than deletes: the rows are all still
 *       there, no DELETE is issued on any of the four tables, and the amounts
 *       are untouched
 *   P2  the identity LINK is severed — asserted on the COLUMN, not on a row
 *       count: beneficiary_user_id / actor_user_id are NULL afterwards, the
 *       pseudonym column carries a value that is not derived from the user id,
 *       and the uuid appears nowhere in any column of any row
 *   P3  one pseudonym per person, and another account's rows are untouched
 *   P4  a user with NO ledger row deletes cleanly and the door is never called
 *       (3510's header: a statement-level trigger once made such users
 *       undeletable, which is the failure mode this must never reproduce)
 *   P5  a FAILED READ REFUSES. supabase-js resolves `{data, error}`, so every
 *       unreadable shape — an error envelope, and a `data: null` with no error
 *       at all — must abort the deletion rather than read as an empty ledger
 *   P6  a failed removal refuses: an RPC error, a missing door while rows still
 *       name the account, and a removal that leaves the identity behind
 *   P7  absence that IS an answer: a database without the ledger tables (42P01 /
 *       PGRST205) deletes cleanly
 *   P8  no per-person row count is recorded on the step or persisted on the
 *       request receipt (3600: a count per person is a fingerprint)
 *   P9  the manifest says all four are a decided retention, with a reason
 *   P10 the ledger is passed AGAIN after the tombstone (3600 (4b), review of
 *       PR #592): a row written between the first pass and the anonymise —
 *       the producer, a booking route, an admin hold — is pseudonymised before
 *       the auth user goes; with nothing new the second pass calls nothing; and
 *       it is FATAL like the first
 *
 * In every refusing case the test also asserts the deletion stopped BEFORE the
 * profile was anonymised and before the auth user was removed: the request stays
 * pending and retryable, which is the only safe outcome when the ledger may
 * still name the person.
 *
 * Run: node --import tsx/esm --test src/test/accountDeletionCreatorLedger.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  executeAccountDeletion,
  CREATOR_LEDGER_IDENTITY_COLUMNS,
  CREATOR_LEDGER_REMOVAL_REASON,
} from "../services/accountDeletion/AccountDeletionService.js";
import { RETAINED_WITH_REASON, POST_BASELINE_TABLES } from "../lib/deletionDispositions.js";

const USER_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ID = "22222222-2222-2222-2222-222222222222";
const ADMIN_ID = "33333333-3333-3333-3333-333333333333";

const LEDGERS = ["rent_buddy_earnings_entries", "creator_attributions", "creator_earning_entries", "creator_ledger_audit_events"] as const;

/** The pseudonym column each ledger carries, as 3600 adds them. */
const PSEUDONYM_COLUMN: Record<string, string> = {
  rent_buddy_earnings_entries: "beneficiary_pseudonym",
  creator_attributions: "beneficiary_pseudonym",
  creator_earning_entries: "beneficiary_pseudonym",
  creator_ledger_audit_events: "actor_pseudonym",
};

interface Op { table: string; op: string; filters: any[]; values?: any }

/**
 * The ledger as four tables of real rows: one person's double-entry legs, their
 * reversal, their audit trail, and a second person's rows that must not move.
 * The idempotency keys embed the beneficiary's uuid exactly as 2920/2921 build
 * them, so "the uuid is gone from EVERY column" has something to be wrong about.
 */
function seedLedger(): Record<string, any[]> {
  return {
    rent_buddy_earnings_entries: [
      { id: "rbee-gross", booking_id: "bk-1", beneficiary_user_id: USER_ID, beneficiary_pseudonym: null, account: "buddy_payable", amount_minor: 9600, entry_reason: "booking_gross", idempotency_key: `rbee:bk-1:booking_gross:${USER_ID}` },
      { id: "rbee-fee", booking_id: "bk-1", beneficiary_user_id: null, beneficiary_pseudonym: null, account: "platform_revenue", amount_minor: 2400, entry_reason: "platform_fee", idempotency_key: "rbee:bk-1:platform_fee" },
      { id: "rbee-rev", booking_id: "bk-1", beneficiary_user_id: USER_ID, beneficiary_pseudonym: null, account: "buddy_payable", amount_minor: -9600, entry_reason: "reversal", idempotency_key: `rbee:bk-1:reversal:${USER_ID}` },
      { id: "rbee-other", booking_id: "bk-2", beneficiary_user_id: OTHER_ID, beneficiary_pseudonym: null, account: "buddy_payable", amount_minor: 5000, entry_reason: "booking_gross", idempotency_key: `rbee:bk-2:booking_gross:${OTHER_ID}` },
    ],
    creator_attributions: [
      { id: "ca-1", beneficiary_user_id: USER_ID, beneficiary_pseudonym: null, subject_id: "trail-7", rule_version: "creator-rules/trail-builder/v1", fraud_hold_reason: null, idempotency_key: `creator-attr:trail_builder:trail-7:route_completion:${USER_ID}` },
      { id: "ca-other", beneficiary_user_id: OTHER_ID, beneficiary_pseudonym: null, subject_id: "trail-9", rule_version: "creator-rules/trail-builder/v1", fraud_hold_reason: null, idempotency_key: `creator-attr:trail_builder:trail-9:route_completion:${OTHER_ID}` },
    ],
    creator_earning_entries: [
      { id: "cee-share", attribution_id: "ca-1", beneficiary_user_id: USER_ID, beneficiary_pseudonym: null, account: "creator_payable", amount_minor: 700, entry_reason: "revenue_share", transaction_key: `cee:ca-1:${USER_ID}` },
      { id: "cee-plat", attribution_id: "ca-1", beneficiary_user_id: null, beneficiary_pseudonym: null, account: "platform_revenue", amount_minor: 200, entry_reason: "platform_fee", transaction_key: `cee:ca-1:${USER_ID}` },
      { id: "cee-trav", attribution_id: "ca-1", beneficiary_user_id: null, beneficiary_pseudonym: null, account: "traveler_receivable", amount_minor: -900, entry_reason: "revenue_share", transaction_key: `cee:ca-1:${USER_ID}` },
    ],
    creator_ledger_audit_events: [
      // The erased person acted as the ADMIN here: the audit row names them in
      // actor_user_id, which is a different identity column from the three above.
      { id: "clae-1", attribution_id: "ca-1", actor_user_id: USER_ID, actor_pseudonym: null, action: "hold_placed", reason: "suspected fake visits" },
      { id: "clae-2", attribution_id: "ca-other", actor_user_id: ADMIN_ID, actor_pseudonym: null, action: "hold_released", reason: "cleared on review" },
    ],
  };
}

interface ClientOptions {
  seed?: Record<string, any[]>;
  /** Tables whose SELECT resolves with an error envelope. */
  readError?: Record<string, { code?: string; message: string }>;
  /** Tables whose SELECT resolves `{ data: null, error: null }` — the `data ?? []` trap. */
  readNull?: readonly string[];
  /** `creator_ledger_remove_identity` resolves with this error instead of running. */
  rpcError?: { code?: string; message: string };
  /** The door resolves ok but changes nothing — a removal that did not remove. */
  rpcNoop?: boolean;
  /** Runs when the tombstone UPDATE arrives, before it applies: a ledger write that committed just ahead of it. */
  beforeTombstone?: (store: Record<string, any[]>) => void;
  /** Every ledger read AFTER the tombstone resolves with an error envelope. */
  failLedgerReadsAfterTombstone?: boolean;
}

/**
 * A fake supabase client that APPLIES what it is told, so the properties proven
 * are about rows and columns rather than about calls. `rpc` runs 3600's
 * substitution: every occurrence of the user's id in every column becomes ONE
 * fresh pseudonym, and the identity columns move to the pseudonym column.
 */
function makeClient(opts: ClientOptions = {}) {
  const store: Record<string, any[]> = {};
  for (const [t, rows] of Object.entries(opts.seed ?? {})) store[t] = rows.map((r) => ({ ...r }));
  const ops: Op[] = [];
  const authDeleted: string[] = [];
  const rpcCalls: Array<{ fn: string; args: any }> = [];
  let pseudonym: string | null = null;
  let tombstoned = false;

  function matches(row: any, filters: any[]): boolean {
    return filters.every((f) => (f[0] === "eq" ? row[f[1]] === f[2] : true));
  }

  function builder(table: string) {
    const q: any = {
      _op: "select",
      _filters: [] as any[],
      _values: undefined as any,
      _single: false,
      _limit: undefined as number | undefined,
      select() { q._op = "select"; return q; },
      delete() { q._op = "delete"; return q; },
      update(v: any) { q._op = "update"; q._values = v; return q; },
      upsert(v: any) { q._op = "upsert"; q._values = v; return q; },
      insert(v: any) { q._op = "insert"; q._values = v; return q; },
      eq(c: string, v: any) { q._filters.push(["eq", c, v]); return q; },
      neq(c: string, v: any) { q._filters.push(["neq", c, v]); return q; },
      not(c: string, op: string, v: any) { q._filters.push(["not", c, op, v]); return q; },
      lte(c: string, v: any) { q._filters.push(["lte", c, v]); return q; },
      in(c: string, v: any[]) { q._filters.push(["in", c, v]); return q; },
      or(expr: string) { q._filters.push(["or", expr]); return q; },
      order() { return q; },
      limit(n: number) { q._limit = n; return q; },
      maybeSingle() { q._single = true; return q._run(); },
      then(resolve: any, reject: any) { return q._run().then(resolve, reject); },
      _run() {
        ops.push({ table, op: q._op, filters: q._filters, values: q._values });
        if (table === "profiles" && q._op === "update" && q._values?.account_status === "deleted") {
          opts.beforeTombstone?.(store);
          tombstoned = true;
        }
        if (q._op === "select" && tombstoned && opts.failLedgerReadsAfterTombstone && (LEDGERS as readonly string[]).includes(table)) {
          return Promise.resolve({ data: null, error: { code: "57014", message: `canceling statement due to statement timeout (${table})` } });
        }
        if (q._op === "select" && opts.readError?.[table]) {
          return Promise.resolve({ data: null, error: opts.readError[table] });
        }
        if (q._op === "select" && (opts.readNull ?? []).includes(table)) {
          // The shape that makes `data ?? []` a defect: no rows, and no error
          // saying why.
          return Promise.resolve({ data: null, error: null });
        }
        const rows = store[table] ?? [];
        if (q._op === "update") {
          for (const row of rows) if (matches(row, q._filters)) Object.assign(row, q._values);
        }
        if (q._op === "delete") {
          store[table] = rows.filter((row) => !matches(row, q._filters));
        }
        let data: any = q._op === "select" ? rows.filter((row) => matches(row, q._filters)) : rows;
        if (q._limit) data = data.slice(0, q._limit);
        if (q._single) data = data.length > 0 ? data[0] : null;
        return Promise.resolve({ data, error: null });
      },
    };
    return q;
  }

  /** 3600's substitution, as the database performs it, applied to the store. */
  function removeIdentity(user: string): Record<string, number> {
    pseudonym = pseudonym ?? "99999999-9999-9999-9999-999999999999";
    const counts: Record<string, number> = {};
    for (const table of LEDGERS) {
      const pcol = PSEUDONYM_COLUMN[table]!;
      let n = 0;
      for (const row of store[table] ?? []) {
        const names = Object.values(row).some((v) => typeof v === "string" && v.toLowerCase().includes(user.toLowerCase()));
        if (!names) continue;
        for (const [k, v] of Object.entries(row)) {
          if (typeof v === "string" && v.toLowerCase().includes(user.toLowerCase())) {
            row[k] = v.replace(new RegExp(user, "gi"), pseudonym!);
          }
        }
        for (const { table: t, column } of CREATOR_LEDGER_IDENTITY_COLUMNS) {
          if (t === table && row[column] === pseudonym) { row[column] = null; row[pcol] = pseudonym; }
        }
        n += 1;
      }
      counts[table] = n;
    }
    return counts;
  }

  return {
    _ops: ops,
    _store: store,
    _authDeleted: authDeleted,
    _rpcCalls: rpcCalls,
    _pseudonym: () => pseudonym,
    from: (t: string) => builder(t),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      ops.push({ table: `rpc:${fn}`, op: "rpc", filters: [], values: args });
      if (fn === "creator_ledger_remove_identity") {
        if (opts.rpcError) return { data: null, error: opts.rpcError };
        if (opts.rpcNoop) return { data: {}, error: null };
        return { data: removeIdentity(args["p_user"] as string), error: null };
      }
      return { data: null, error: null };
    },
    storage: {
      from: () => ({ remove: async (paths: string[]) => ({ data: paths.map((p) => ({ name: p })), error: null }) }),
    },
    auth: {
      admin: {
        deleteUser: async (id: string) => { authDeleted.push(id); return { data: {}, error: null }; },
      },
    },
  };
}

const stepOf = (out: any, name: string) => out.steps.find((s: any) => s.step === name);
const ledgerOps = (c: any, op: string) => c._ops.filter((o: Op) => (LEDGERS as readonly string[]).includes(o.table) && o.op === op);
/** Every column of every ledger row, as one string — so "nowhere" can be asserted. */
const ledgerText = (c: any) => JSON.stringify(LEDGERS.map((t) => c._store[t] ?? []));

describe("executeAccountDeletion — creator-ledger pseudonymisation (C-11 answer B, migration 3600)", () => {
  it("P1/P2/P3. pseudonymises rather than deletes: the accounting rows survive, the identity link is severed, one pseudonym per person, another account untouched", async () => {
    const c = makeClient({ seed: seedLedger() });
    const before = Object.fromEntries(LEDGERS.map((t) => [t, (c._store[t] ?? []).length]));

    const out = await executeAccountDeletion(c, USER_ID, { actorId: ADMIN_ID });
    assert.equal(out.ok, true, JSON.stringify(out.steps.filter((s: any) => !s.ok)));
    assert.ok(stepOf(out, "pseudonymise_creator_ledger")?.ok, "the step must run and succeed");

    // P1. RETAINED: every row is still there, and no DELETE was ever issued.
    for (const t of LEDGERS) {
      assert.equal((c._store[t] ?? []).length, before[t], `${t}: the accounting rows must be RETAINED, not deleted`);
    }
    assert.deepEqual(ledgerOps(c, "delete"), [], "no DELETE may be issued on a retained ledger table");

    // P2. The identity LINK is severed — on the column, not inferred from a count.
    const P = c._pseudonym()!;
    const rbee = (c._store.rent_buddy_earnings_entries as any[]).find((r) => r.id === "rbee-gross")!;
    assert.equal(rbee.beneficiary_user_id, null, "beneficiary_user_id (the FK to profiles) must be NULL");
    assert.equal(rbee.beneficiary_pseudonym, P, "and replaced by the pseudonym");
    assert.equal(rbee.amount_minor, 9600, "the amount is the accounting record — it must not change");
    const ca = (c._store.creator_attributions as any[]).find((r) => r.id === "ca-1")!;
    assert.equal(ca.beneficiary_user_id, null);
    assert.equal(ca.beneficiary_pseudonym, P);
    const cee = (c._store.creator_earning_entries as any[]).find((r) => r.id === "cee-share")!;
    assert.equal(cee.beneficiary_user_id, null);
    assert.equal(cee.beneficiary_pseudonym, P);
    assert.equal(cee.amount_minor, 700);
    const clae = (c._store.creator_ledger_audit_events as any[]).find((r) => r.id === "clae-1")!;
    assert.equal(clae.actor_user_id, null, "the audit row's ACTOR identity column must be severed too");
    assert.equal(clae.actor_pseudonym, P);
    assert.equal(clae.reason, "suspected fake visits", "the audit reason is part of the record and is kept");

    // P2 (continued). The uuid is gone from EVERY column, including the
    // idempotency and transaction keys that embed it.
    assert.doesNotMatch(ledgerText(c), new RegExp(USER_ID, "i"),
      "the erased account's uuid must appear in no column of any retained ledger row");
    assert.notEqual(P, USER_ID, "the pseudonym must not be the user id");

    // P3. ONE pseudonym for the person; the other account is byte-identical.
    for (const row of [rbee, ca, cee, clae]) {
      const p = row.beneficiary_pseudonym ?? row.actor_pseudonym;
      assert.equal(p, P, "every row of one person carries the SAME pseudonym");
    }
    const other = (c._store.rent_buddy_earnings_entries as any[]).find((r) => r.id === "rbee-other")!;
    assert.deepEqual(other, seedLedger().rent_buddy_earnings_entries.find((r) => r.id === "rbee-other"),
      "another account's ledger row must be untouched");
    const otherAttr = (c._store.creator_attributions as any[]).find((r) => r.id === "ca-other")!;
    assert.equal(otherAttr.beneficiary_user_id, OTHER_ID);
    const otherAudit = (c._store.creator_ledger_audit_events as any[]).find((r) => r.id === "clae-2")!;
    assert.equal(otherAudit.actor_user_id, ADMIN_ID, "an admin who is not the subject keeps their identity");

    // The platform / traveller legs that name nobody are untouched as well.
    const platform = (c._store.rent_buddy_earnings_entries as any[]).find((r) => r.id === "rbee-fee")!;
    assert.equal(platform.beneficiary_pseudonym, null, "a leg that named nobody gains no pseudonym");

    // The deletion completed: profile anonymised, auth user gone.
    assert.deepEqual(c._authDeleted, [USER_ID]);
  });

  it("P1. the door is called once, through the audited SECURITY DEFINER function, with an actor who is not the subject and a reason", async () => {
    const c = makeClient({ seed: seedLedger() });
    await executeAccountDeletion(c, USER_ID, { actorId: ADMIN_ID });
    const calls = c._rpcCalls.filter((r: any) => r.fn === "creator_ledger_remove_identity");
    assert.equal(calls.length, 1, "exactly one identity removal per deletion");
    assert.deepEqual(calls[0]!.args, {
      p_user: USER_ID,
      p_actor_kind: "admin",
      p_actor_user_id: ADMIN_ID,
      p_reason: CREATOR_LEDGER_REMOVAL_REASON,
    });
    assert.doesNotMatch(CREATOR_LEDGER_REMOVAL_REASON, new RegExp(USER_ID, "i"),
      "the reason lands on a receipt that may not name the subject");

    // The scheduler and worker pass actorId: null — that is 'system', not a
    // missing admin, and 3600 refuses an actor who is the subject, so a caller
    // that passed the subject must also arrive as 'system'.
    for (const actorId of [null, USER_ID]) {
      const s = makeClient({ seed: seedLedger() });
      await executeAccountDeletion(s, USER_ID, { actorId });
      const args = s._rpcCalls.find((r: any) => r.fn === "creator_ledger_remove_identity")!.args;
      assert.deepEqual([args.p_actor_kind, args.p_actor_user_id], ["system", null], `actorId=${actorId}`);
    }
  });

  it("P4. a user with NO ledger row deletes cleanly and the door is never called", async () => {
    // 3510's header explains why this case has its own test: a statement-level
    // append-only trigger once refused the erasure of users who had no rows at
    // all, making them undeletable. The step must be a no-op for them, and must
    // not depend on 3600 being applied to be one.
    const c = makeClient({ seed: { rent_buddy_earnings_entries: [], creator_attributions: [], creator_earning_entries: [], creator_ledger_audit_events: [] } });
    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });
    assert.equal(out.ok, true, JSON.stringify(out.steps.filter((s: any) => !s.ok)));
    assert.ok(stepOf(out, "pseudonymise_creator_ledger")?.ok);
    assert.deepEqual(c._rpcCalls.filter((r: any) => r.fn === "creator_ledger_remove_identity"), [],
      "a person with no ledger row gets no identity removal and no receipt written about them");
    assert.deepEqual(c._authDeleted, [USER_ID]);

    // The same for a user whose rows all belong to someone else.
    const d = makeClient({ seed: seedLedger() });
    const outOther = await executeAccountDeletion(d, "44444444-4444-4444-4444-444444444444", { actorId: null });
    assert.equal(outOther.ok, true);
    assert.deepEqual(d._rpcCalls.filter((r: any) => r.fn === "creator_ledger_remove_identity"), []);
    assert.equal(ledgerText(d), ledgerText(makeClient({ seed: seedLedger() })), "nobody else's rows moved");
  });

  it("P5. a FAILED READ refuses: an error envelope aborts the deletion before the profile is anonymised", async () => {
    const c = makeClient({
      seed: seedLedger(),
      readError: { creator_earning_entries: { code: "42501", message: "permission denied for table creator_earning_entries" } },
    });
    const out = await executeAccountDeletion(c, USER_ID, { actorId: ADMIN_ID });

    assert.equal(out.ok, false, "an erasure that cannot read the ledger must REFUSE");
    const s = stepOf(out, "pseudonymise_creator_ledger");
    assert.equal(s?.ok, false, "the failing step must be recorded");
    assert.match(s!.error!, /could not be read/);
    assert.match(s!.error!, /must refuse, not report success/);
    assert.ok(out.warnings.some((w: string) => w.includes("creator-ledger")), JSON.stringify(out.warnings));
    // FATAL: it stopped before the tombstone was anonymised and before the email
    // went, so the request stays pending and a retry is safe.
    assert.equal(stepOf(out, "anonymise_profile"), undefined, "the deletion must not continue past the refusal");
    assert.deepEqual(c._authDeleted, [], "the auth user must survive a refused erasure");
    assert.equal(stepOf(out, "mark_request_completed"), undefined);
    // And nothing was half-done to the ledger.
    assert.deepEqual(c._rpcCalls.filter((r: any) => r.fn === "creator_ledger_remove_identity"), []);
  });

  it("P5. `data: null` with NO error is not an empty ledger either", async () => {
    // The literal `data ?? []` defect: supabase-js resolves rather than throws,
    // so this shape reaches the caller as a successful read of nothing.
    const c = makeClient({ seed: seedLedger(), readNull: ["creator_attributions"] });
    const out = await executeAccountDeletion(c, USER_ID, { actorId: ADMIN_ID });
    assert.equal(out.ok, false);
    const s = stepOf(out, "pseudonymise_creator_ledger");
    assert.equal(s?.ok, false);
    assert.match(s!.error!, /instead of rows/);
    assert.match(s!.error!, /an unanswered read is not an empty ledger/);
    assert.deepEqual(c._authDeleted, []);
  });

  it("P6. a failed removal refuses: an RPC error, a missing door while rows still name the account, and a removal that left the identity behind", async () => {
    // (a) the door errors
    const a = makeClient({ seed: seedLedger(), rpcError: { code: "P0001", message: "creator_ledger_remove_identity: a reason is required" } });
    const outA = await executeAccountDeletion(a, USER_ID, { actorId: ADMIN_ID });
    assert.equal(outA.ok, false);
    assert.match(stepOf(outA, "pseudonymise_creator_ledger")!.error!, /creator_ledger_remove_identity failed/);
    assert.deepEqual(a._authDeleted, []);

    // (b) 3600 is not applied here AND the ledger names this person. There is no
    // other way to sever the link — the tables are append-only, service_role has
    // no UPDATE, and 3510's guard refuses every DELETE — so it must say which
    // tables and refuse.
    const b = makeClient({ seed: seedLedger(), rpcError: { code: "PGRST202", message: "Could not find the function public.creator_ledger_remove_identity" } });
    const outB = await executeAccountDeletion(b, USER_ID, { actorId: ADMIN_ID });
    assert.equal(outB.ok, false);
    const errB = stepOf(outB, "pseudonymise_creator_ledger")!.error!;
    assert.match(errB, /is absent on this database/);
    assert.match(errB, /migration 3600 must be applied/);
    assert.match(errB, /rent_buddy_earnings_entries\.beneficiary_user_id/);
    assert.match(errB, /creator_ledger_audit_events\.actor_user_id/);
    assert.deepEqual(b._authDeleted, []);

    // (c) the door reports success and changes nothing. The function's own
    // residual scan would have aborted its transaction; this is the check that
    // does not take the thing under test at its word.
    const d = makeClient({ seed: seedLedger(), rpcNoop: true });
    const outD = await executeAccountDeletion(d, USER_ID, { actorId: ADMIN_ID });
    assert.equal(outD.ok, false);
    assert.match(stepOf(outD, "pseudonymise_creator_ledger")!.error!, /the identity link survived the removal/);
    assert.match(stepOf(outD, "pseudonymise_creator_ledger")!.error!, /permanent record of an erased person/);
    assert.deepEqual(d._authDeleted, []);
  });

  it("P7. a database where the ledger tables do not exist deletes cleanly: a missing relation IS the absence of rows", async () => {
    // 2901 / 2920 / 2921 / 3387 are unapplied on some environments. A relation
    // that does not exist holds no rows, which is the one unreadable-looking
    // answer that really is an answer — unlike every shape in P5.
    for (const code of ["42P01", "PGRST205"]) {
      const c = makeClient({
        seed: seedLedger(),
        readError: Object.fromEntries(LEDGERS.map((t) => [t, { code, message: `relation "public.${t}" does not exist` }])),
      });
      const out = await executeAccountDeletion(c, USER_ID, { actorId: null });
      assert.equal(out.ok, true, `${code}: ${JSON.stringify(out.steps.filter((s: any) => !s.ok))}`);
      assert.ok(stepOf(out, "pseudonymise_creator_ledger")?.ok);
      assert.deepEqual(c._rpcCalls.filter((r: any) => r.fn === "creator_ledger_remove_identity"), []);
      assert.deepEqual(c._authDeleted, [USER_ID]);
    }
  });

  it("P8. no per-person ledger row count is recorded on the step or persisted on the request receipt", async () => {
    // 3600's door returns counts and its comment forbids logging them beside the
    // user id: how many ledger rows a person had is a fingerprint that could be
    // matched to a pseudonym's rows later. `deleted_counts` IS persisted on
    // user_deletion_requests, so the ledger must contribute to neither.
    const c = makeClient({ seed: seedLedger() });
    const out = await executeAccountDeletion(c, USER_ID, { actorId: ADMIN_ID });
    assert.equal(out.ok, true);
    assert.deepEqual(Object.keys(stepOf(out, "pseudonymise_creator_ledger")!), ["step", "ok"],
      "the step must record no count");
    for (const t of LEDGERS) {
      assert.equal(Object.prototype.hasOwnProperty.call(out.deletedCounts, t), false, `${t} must not appear in deletedCounts`);
      assert.equal(Object.prototype.hasOwnProperty.call(out.tombstonedCounts, t), false, `${t} must not appear in tombstonedCounts`);
    }
    const completed = c._ops.find((o: Op) => o.table === "user_deletion_requests" && o.op === "update");
    assert.ok(completed, "the request is marked completed");
    assert.doesNotMatch(JSON.stringify(completed!.values), /rent_buddy_earnings_entries|creator_attributions|creator_earning_entries|creator_ledger_audit_events/,
      "the persisted receipt must carry no ledger counts");
  });

  it("P1. the step is FATAL and placed before the tombstone is anonymised, not after", async () => {
    const c = makeClient({ seed: seedLedger() });
    const out = await executeAccountDeletion(c, USER_ID, { actorId: ADMIN_ID });
    const order = out.steps.map((s: any) => s.step);
    const ledger = order.indexOf("pseudonymise_creator_ledger");
    assert.ok(ledger >= 0);
    assert.ok(ledger < order.indexOf("anonymise_profile"),
      "the ledger must be pseudonymised while the deletion can still be refused");
    assert.ok(ledger < order.indexOf("auth_delete_user"));
    // contentOnly stops before the identity steps: the account still exists, so
    // its identity link must stay.
    const only = makeClient({ seed: seedLedger() });
    const outOnly = await executeAccountDeletion(only, USER_ID, { actorId: ADMIN_ID, contentOnly: true });
    assert.equal(stepOf(outOnly, "pseudonymise_creator_ledger"), undefined);
    assert.equal(ledgerText(only), ledgerText(makeClient({ seed: seedLedger() })), "content-only touches no ledger row");
  });

  it("P10. a ledger row written between the first pass and the tombstone is pseudonymised by the second pass, before the auth user goes", async () => {
    // The Travel Partner producer attributed the buddy's completed booking in
    // the gap: the row names the person, and the first pass has already run.
    const late = {
      id: "ca-late", beneficiary_user_id: USER_ID, beneficiary_pseudonym: null, subject_id: "bk-late",
      rule_version: "creator-rules/travel-partner/v1", fraud_hold_reason: null,
      idempotency_key: `creator-attr:travel_partner:bk-late:verified_booking:${USER_ID}`,
    };
    const c = makeClient({ seed: seedLedger(), beforeTombstone: (store) => { store.creator_attributions!.push({ ...late }); } });
    const out = await executeAccountDeletion(c, USER_ID, { actorId: ADMIN_ID });
    assert.equal(out.ok, true, JSON.stringify(out.steps.filter((s: any) => !s.ok)));

    const row = (c._store.creator_attributions as any[]).find((r) => r.id === "ca-late")!;
    assert.equal(row.beneficiary_user_id, null, "the late row's identity link is severed");
    assert.equal(row.beneficiary_pseudonym, c._pseudonym(), "and it carries the pseudonym");
    assert.doesNotMatch(ledgerText(c), new RegExp(USER_ID, "i"),
      "no retained ledger row names the erased account, including one written during the erasure");

    const order = out.steps.map((s: any) => s.step);
    const second = order.indexOf("pseudonymise_creator_ledger_after_tombstone");
    assert.ok(second > order.indexOf("anonymise_profile"), "the second pass runs after the tombstone");
    assert.ok(second < order.indexOf("auth_delete_user"), "and before the auth user is removed");
    assert.equal(c._rpcCalls.filter((r: any) => r.fn === "creator_ledger_remove_identity").length, 2,
      "the door is called again only because a row named the person again");
    assert.deepEqual(Object.keys(stepOf(out, "pseudonymise_creator_ledger_after_tombstone")!), ["step", "ok"],
      "the second pass records no count either (P8)");
    assert.deepEqual(c._authDeleted, [USER_ID]);
  });

  it("P10. with nothing written after the first pass, the second pass reads and calls nothing", async () => {
    const c = makeClient({ seed: seedLedger() });
    const out = await executeAccountDeletion(c, USER_ID, { actorId: ADMIN_ID });
    assert.equal(out.ok, true);
    assert.ok(stepOf(out, "pseudonymise_creator_ledger_after_tombstone")?.ok);
    assert.equal(c._rpcCalls.filter((r: any) => r.fn === "creator_ledger_remove_identity").length, 1);
  });

  it("P10. the second pass is FATAL: a ledger it cannot read stops the deletion before the auth user is removed", async () => {
    const c = makeClient({ seed: seedLedger(), failLedgerReadsAfterTombstone: true });
    const out = await executeAccountDeletion(c, USER_ID, { actorId: ADMIN_ID });
    assert.equal(out.ok, false, "an erasure that cannot see whether the ledger names the person again must refuse");
    assert.ok(stepOf(out, "pseudonymise_creator_ledger")?.ok, "the first pass succeeded");
    const s2 = stepOf(out, "pseudonymise_creator_ledger_after_tombstone");
    assert.equal(s2?.ok, false);
    assert.match(s2!.error!, /could not be read/);
    assert.ok(out.warnings.some((w: string) => w.includes("written while the account was being erased")), JSON.stringify(out.warnings));
    assert.equal(stepOf(out, "auth_delete_user"), undefined);
    assert.deepEqual(c._authDeleted, [], "the auth user survives, so the request stays pending and retryable");
    assert.equal(stepOf(out, "mark_request_completed"), undefined);
  });

  it("P9. all four ledgers are a DECIDED retention in the deletion-coverage manifest, with a reason", () => {
    const byTable = new Map(RETAINED_WITH_REASON.map((r) => [r.table, r.reason]));
    for (const { table, column } of CREATOR_LEDGER_IDENTITY_COLUMNS) {
      assert.ok(byTable.has(table), `${table} must be classified RETAINED_WITH_REASON (C-11)`);
      assert.match(byTable.get(table)!, /GDPR Art\. 17\(3\)\(b\)\/\(e\)/, `${table}: the lawful basis must be named`);
      assert.match(byTable.get(table)!, /3600/, `${table}: the reason must name the migration that implements it`);
      assert.ok(POST_BASELINE_TABLES.includes(table), `${table} is post-baseline and must be hand-registered`);
      assert.ok(column === "beneficiary_user_id" || column === "actor_user_id", `${table}: unexpected identity column ${column}`);
    }
    assert.equal(CREATOR_LEDGER_IDENTITY_COLUMNS.length, 4, "four ledgers, four identity columns");
  });
});
