/**
 * The payment ledger's SHAPE, read off the files — no database. These are the
 * properties a later edit could remove while every database suite stayed green
 * for want of a database: `09` §3.2, §5.3 I2/I3, §8, §10; tasks PAY-T05–T07.
 *
 *   SH1  the three migrations exist in the payments band, each with a rollback that refuses to drop data
 *   SH2  I3: no statement-level UPDATE/DELETE trigger in any of them (TRUNCATE-level only)
 *   SH3  deny-default: REVOKE before GRANT, SELECT-only for service_role, nothing for a client, no policy
 *   SH4  every SECURITY DEFINER function pins an empty search_path and is executable by service_role only
 *   SH5  the nine account types and eight kinds, exactly; no currency default; test mode CHECKed
 *   SH6  each file is one BEGIN … COMMIT with a $pre$ block (the applier's shape)
 *   SH7  PaymentLedger.ts: rpc only — no table access, no provider, no money arithmetic, no fallback
 *   SH8  routes/payments.ts: GET only, requireUser, and no identity taken from the request
 *   SH9  the predicate that trusts an identity parameter is in authz, never public
 *
 * Run: node --import tsx/esm --test src/test/paymentLedgerShape.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(SRC, "../../..");
const read = (rel: string) => readFileSync(join(REPO, rel), "utf8");

const MIGRATIONS = [
  ["3821_payment_ledger.sql", "2026-10-04-3821-payment-ledger-rollback.sql"],
  ["3822_payment_posting_and_balances.sql", "2026-10-04-3822-payment-posting-and-balances-rollback.sql"],
  ["3823_payment_attribution_and_scoped_reads.sql", "2026-10-04-3823-payment-attribution-and-scoped-reads-rollback.sql"],
] as const;
const TABLES = [
  "payment_parties", "payment_accounts", "payment_transactions", "payment_ledger_entries",
  "payment_account_balances", "payment_balance_rules", "payment_retention_settings",
];
const DEFINER_FUNCTIONS = ["payment_account_ensure", "payment_post_transaction", "payment_party_remove_identity"];

/** SQL with `--` comments removed, so prose about a thing is not the thing. */
function sqlCode(sql: string): string {
  return sql.split("\n").map((l) => {
    const i = l.indexOf("--");
    return i === -1 ? l : l.slice(0, i);
  }).join("\n");
}
/** TypeScript with block and line comments removed. */
function tsCode(ts: string): string {
  return ts.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/^\s*\/\/.*$/, "").replace(/\s\/\/ .*$/, "")).join("\n");
}

const forward = MIGRATIONS.map(([f]) => sqlCode(read(`artifacts/api-server/src/migrations/${f}`)));
const all = forward.join("\n");

describe("payment ledger shape (09 §3.2, §5.3, §8, §10)", () => {
  it("SH1. three migrations in the payments band (3820-3859), each with a rollback that refuses rather than drops data", () => {
    for (const [f, rb] of MIGRATIONS) {
      const prefix = Number(f.slice(0, 4));
      assert.ok(prefix >= 3820 && prefix <= 3859, f);
      const raw = read(`artifacts/api-server/src/migrations/${f}`);
      assert.match(raw, /POST-CUTOVER CANONICAL FORWARD MIGRATION \(3000-3999 band/);
      assert.ok(raw.includes(`db/rollback/${rb}`), `${f} names its rollback`);
      assert.ok(existsSync(join(REPO, "db/rollback", rb)), rb);
      const rollback = sqlCode(read(`db/rollback/${rb}`));
      assert.match(rollback, /ROLLBACK REFUSED/, rb);
      assert.ok(rollback.includes(`DELETE FROM public.schema_migration_ledger WHERE filename = '${f}'`), `${rb} removes ${f}'s ledger row`);
      assert.doesNotMatch(rollback, /\bCASCADE\b/, `${rb} drops nothing it did not name`);
    }
    // The ledger's rollback refuses while ANY of its four tables holds a row.
    const r3821 = sqlCode(read(`db/rollback/${MIGRATIONS[0][1]}`));
    for (const t of TABLES.slice(0, 4)) assert.ok(r3821.includes(`'${t}'`), t);
  });

  it("SH2. I3: FOR EACH STATEMENT appears only on TRUNCATE triggers; UPDATE/DELETE guards are row-level", () => {
    const triggers = [...all.matchAll(/CREATE (?:CONSTRAINT )?TRIGGER\s+(\w+)\s+([\s\S]*?);/g)];
    assert.ok(triggers.length >= 14, `found ${triggers.length} triggers`);
    for (const [, name, body] of triggers) {
      if (/FOR EACH STATEMENT/.test(body!)) {
        assert.match(body!, /BEFORE TRUNCATE ON/, `${name} is statement-level and is not a TRUNCATE guard`);
        assert.doesNotMatch(body!, /\b(UPDATE|DELETE|INSERT)\b/, `${name} is statement-level on a row operation`);
      } else {
        assert.match(body!, /FOR EACH ROW/, name);
      }
    }
    // I2: the row guard covers UPDATE and DELETE on entries, transactions and accounts.
    for (const t of ["payment_ledger_entries", "payment_transactions", "payment_accounts"]) {
      assert.match(all, new RegExp(`BEFORE UPDATE OR DELETE ON public\\.${t}\\s+FOR EACH ROW EXECUTE FUNCTION public\\.payment_ledger_append_only\\(\\)`), t);
      assert.match(all, new RegExp(`BEFORE TRUNCATE ON public\\.${t}\\s+FOR EACH STATEMENT`), t);
    }
    // I1: both balance checks are deferred constraint triggers.
    for (const name of ["ple_transaction_balances", "ptx_has_balanced_entries", "ptx_has_beneficiary_entry"]) {
      assert.match(all, new RegExp(`CREATE CONSTRAINT TRIGGER ${name}\\s+AFTER INSERT ON public\\.\\w+\\s+DEFERRABLE INITIALLY DEFERRED\\s+FOR EACH ROW`), name);
    }
  });

  it("SH3. deny-default: RLS on, REVOKE (incl. service_role) before GRANT, SELECT only, no client grant, no policy", () => {
    for (const t of TABLES) {
      assert.match(all, new RegExp(`ALTER TABLE public\\.${t}\\s+ENABLE ROW LEVEL SECURITY`), `${t} RLS`);
      const revoke = all.search(new RegExp(`REVOKE ALL ON public\\.${t}\\s+FROM PUBLIC, anon, authenticated, service_role;`));
      const grant = all.search(new RegExp(`GRANT [A-Z, ]+ ON public\\.${t}\\s+TO`));
      assert.ok(revoke !== -1, `${t}: the unconditional revoke, naming service_role (2093)`);
      assert.ok(grant > revoke, `${t}: the revoke comes first`);
      const grants = [...all.matchAll(new RegExp(`GRANT ([A-Z, ]+) ON public\\.${t}\\s+TO ([a-z_, ]+);`, "g"))];
      assert.deepEqual(grants.map((g) => [g[1], g[2]]), [["SELECT", "service_role"]], `${t}: SELECT for service_role and nothing else`);
    }
    assert.doesNotMatch(all, /GRANT[^;]*\bTO\b[^;]*\b(anon|authenticated|PUBLIC)\b/, "nothing is granted to a client role");
    assert.doesNotMatch(all, /CREATE POLICY/, "no policy: the tables are deny-all by design");
    assert.doesNotMatch(all, /\bGRANT (ALL|INSERT|UPDATE|DELETE|TRUNCATE)\b/);
  });

  it("SH4. each SECURITY DEFINER function pins search_path to '' and is executable by service_role only", () => {
    const functions = [...all.matchAll(/CREATE OR REPLACE FUNCTION (\w+)\.(\w+)\(([^)]*)\)\s+RETURNS[\s\S]*?AS \$fn\$/g)];
    assert.ok(functions.length >= 12, `found ${functions.length} functions`);
    const definers: string[] = [];
    for (const [head, schema, name] of functions) {
      assert.match(head!, /SET search_path TO ''/, `${schema}.${name} pins an empty search_path`);
      if (/SECURITY DEFINER/.test(head!)) definers.push(name!);
    }
    assert.deepEqual(definers.sort(), [...DEFINER_FUNCTIONS].sort(), "exactly the three write doors are SECURITY DEFINER");
    for (const name of [...DEFINER_FUNCTIONS, "payment_party_ledger"]) {
      assert.match(all, new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\(jsonb\\) FROM PUBLIC;`), name);
      assert.match(all, new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\(jsonb\\) FROM anon, authenticated;`), name);
      assert.match(all, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\(jsonb\\) TO service_role;`), name);
    }
    // Every other object a definer body names is schema-qualified: nothing resolves through a path.
    assert.doesNotMatch(all, /\b(FROM|JOIN|INTO|UPDATE)\s+payment_/, "an unqualified payment table reference");
  });

  it("SH5. vocabularies and money columns: nine account types, eight kinds, bigint minor units, no currency default, test mode only", () => {
    const m = /CONSTRAINT pa_account_type_known CHECK \(account_type IN \(([\s\S]*?)\)\)/.exec(forward[0]!);
    assert.deepEqual([...m![1]!.matchAll(/'(\w+)'/g)].map((x) => x[1]).sort(), [
      "hold_reserve", "payout_in_transit", "platform_fee_expense", "platform_revenue", "processor_clearing",
      "refund_liability", "tax_withheld", "user_payable", "user_receivable",
    ]);
    const k = /CONSTRAINT ptx_kind_known CHECK \(kind IN \(([\s\S]*?)\)\)/.exec(forward[0]!);
    assert.deepEqual([...k![1]!.matchAll(/'(\w+)'/g)].map((x) => x[1]).sort(),
      ["capture", "charge", "chargeback", "fee", "fx", "payout", "refund", "reversal"]);
    assert.match(forward[0]!, /amount_minor\s+bigint\s+NOT NULL/);
    assert.match(forward[0]!, /original_amount_minor\s+bigint\s+NOT NULL/);
    assert.match(forward[0]!, /original_currency\s+char\(3\)\s+NOT NULL/);
    assert.doesNotMatch(all, /currency\s+char\(3\)[^,\n]*DEFAULT/i, "no currency is assumed");
    assert.doesNotMatch(all, /DEFAULT 'USD'/);
    assert.doesNotMatch(all, /\b(numeric|decimal)\(\d+,\s*2\)|\bfloat\b|\bdouble precision\b|\breal\b/i, "no fractional money type");
    assert.match(forward[0]!, /CONSTRAINT pa_test_mode_only CHECK \(livemode = false\)/);
    assert.match(forward[0]!, /CONSTRAINT ptx_test_mode_only CHECK \(livemode = false\)/);
    assert.match(forward[0]!, /CONSTRAINT ptx_idempotency_once UNIQUE \(scope, idempotency_key\)/);
    assert.match(forward[0]!, /CONSTRAINT ple_amount_non_zero CHECK \(amount_minor <> 0\)/);
    // The one identity link, and its action.
    const profileKeys = [...all.matchAll(/REFERENCES public\.profiles\(id\)\s*([A-Z ]*)/g)];
    assert.deepEqual(profileKeys.map((x) => x[1]!.trim()), ["ON DELETE SET NULL"], "one key to profiles, on payment_parties, SET NULL");
  });

  it("SH6. each migration is one BEGIN … COMMIT with a $pre$ block, and names no provider", () => {
    MIGRATIONS.forEach(([f], i) => {
      const code = forward[i]!;
      assert.equal((code.match(/^BEGIN;$/gm) ?? []).length, 1, `${f}: one BEGIN`);
      assert.equal((code.match(/^COMMIT;$/gm) ?? []).length, 1, `${f}: one COMMIT`);
      assert.match(code, /DO \$pre\$/, `${f}: a precondition block`);
      assert.match(code, /DO \$post\$/, `${f}: a postcondition block`);
      assert.doesNotMatch(code, /^\s*(ROLLBACK|SAVEPOINT|ABORT)\b/m, `${f}: nothing the applier refuses`);
      assert.doesNotMatch(code, /CONCURRENTLY/, f);
      assert.doesNotMatch(code, /stripe|adyen|paypal|braintree/i, `${f}: no provider is named`);
    });
  });

  it("SH7. PaymentLedger.ts calls four functions by rpc and does nothing else: no table access, no provider, no arithmetic", () => {
    const raw = read("artifacts/api-server/src/services/payments/PaymentLedger.ts");
    const code = tsCode(raw);
    assert.deepEqual(
      [...code.matchAll(/^import .* from "([^"]+)";$/gm)].map((x) => x[1]),
      ["../../lib/featureFlags.js"],
      "one import: the flag reader. No provider, no SDK, no supabase-js.",
    );
    assert.deepEqual(
      [...code.matchAll(/call\(sc, "(\w+)"/g)].map((x) => x[1]).sort(),
      ["payment_account_ensure", "payment_party_ledger", "payment_party_remove_identity", "payment_post_transaction"],
    );
    assert.equal((code.match(/\.rpc\(/g) ?? []).length, 1, "one rpc call site");
    assert.doesNotMatch(code, /\.(from|insert|update|upsert|delete|select)\(/, "no table access: there is no read-modify-write path and no fallback");
    assert.doesNotMatch(code, /stripe|PaymentProvider|fetch\(|https?:/i, "no provider");
    // No money arithmetic. Template literals and regexes are text, so they are removed first.
    const noText = code
      .replace(/`[^`]*`/g, '""')
      .replace(/"[^"\n]*"/g, '""')
      .replace(/\/(?:\\.|[^/\n\\])+\/[a-z]*(?=\.test\(|;)/g, "RE");
    const ARITHMETIC =
      /\+=|-=|\*=|\/=|%=|\*\*|\+\+|--|Math\.|parseFloat|parseInt|Number\(|BigInt\(|\.reduce\(|[\w)\]]\s*[*%]\s*[\w(]|[\w)\]]\s+[+\-/]\s+[\w(]|[=(,:?]\s*-\s*[A-Za-z_(]/;
    // The detector must be able to fire: each of these is the arithmetic it exists to catch.
    for (const sample of ["total = a + b;", "x = amount * 2;", "sum += e.amount;", "n = -amount;", "Number(v)", "entries.reduce(f)", "fee = gross / 10;", "a - b"]) {
      assert.match(sample, ARITHMETIC, `the detector misses: ${sample}`);
    }
    assert.doesNotMatch(noText, ARITHMETIC, "an arithmetic operator appeared in PaymentLedger.ts");
    assert.match(code, /livemode: false/);
    assert.doesNotMatch(code, /livemode: true/);
  });

  it("SH8. routes/payments.ts is read-only, authenticated first, and takes no identity from the request", () => {
    const code = tsCode(read("artifacts/api-server/src/routes/payments.ts"));
    assert.deepEqual([...code.matchAll(/router\.(\w+)\("([^"]+)"/g)].map((x) => [x[1], x[2]]),
      [["get", "/payments/me/accounts"], ["get", "/payments/me/entries"]]);
    assert.doesNotMatch(code, /router\.(post|put|patch|delete|all)\(/);
    const handlers = code.split("router.get(").slice(1);
    for (const h of handlers) {
      const gateAt = h.indexOf("await gate(req, res)");
      assert.ok(gateAt !== -1, "every handler passes the gate");
      const firstQuery = h.indexOf("req.query");
      assert.ok(firstQuery === -1 || gateAt < firstQuery, "the gate runs before any parameter is read");
    }
    assert.match(code, /const auth = await requireUser\(req, res\);/);
    assert.match(code, /profileId: auth\.user\.id/);
    assert.doesNotMatch(code, /req\.(params|body)/, "no path parameter and no body");
    assert.doesNotMatch(code, /req\.query\.(profile|user|account|party)/i, "no identity in the query");
    assert.match(code, /paymentLedgerReadsEnabled\(sc\)/);
    const index = read("artifacts/api-server/src/routes/index.ts");
    assert.match(index, /import paymentsRouter from "\.\/payments";/);
    assert.match(index, /router\.use\(paymentsRouter\);/);
  });

  it("SH9. the ownership predicate trusts a parameter, so it lives in authz with a pinned search_path — never in public", () => {
    const m3 = forward[2]!;
    assert.match(m3, /CREATE SCHEMA IF NOT EXISTS authz;/);
    assert.match(m3, /CREATE OR REPLACE FUNCTION authz\.payment_account_owned_by_profile\(p_account_id uuid, p_profile_id uuid\)[\s\S]*?SECURITY INVOKER\s+SET search_path TO ''/);
    assert.doesNotMatch(all, /CREATE OR REPLACE FUNCTION public\.payment_account_owned_by/);
    assert.match(m3, /REVOKE ALL ON FUNCTION authz\.payment_account_owned_by_profile\(uuid, uuid\) FROM anon, authenticated;/);
    assert.doesNotMatch(m3, /GRANT USAGE ON SCHEMA authz TO[^;]*(anon|authenticated)/);
    // The flag ships OFF.
    assert.match(m3, /'payment_ledger_reads_enabled',\s+false,/);
  });
});
