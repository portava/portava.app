/**
 * Migrations 3385, 3386 and 3387, read as text and held against the modules
 * that depend on them — plus the wiring that makes the creator ledger reachable
 * (census-discovery §52). The executable half is `db/creatorLedgerLifecycle`;
 * this is the half a database cannot see: what the files SAY they do, and that
 * the TypeScript twins agree with the SQL.
 *
 *   M1  3385 re-creates the view with a THIRD partition and nothing else, and its
 *       account CASE is exactly CREATOR_ACCOUNT_PARTY_ROLE, total, no ELSE
 *   M2  3385 keeps every 2930 guarantee: security_invoker, SELECT-only grant,
 *       no write path, per-ledger reconciliation over three partitions
 *   M3  3386 admits exactly P3's recommendation-id shape, and checks existence on
 *       ORIGINALS only
 *   M4  3387's door is SECURITY INVOKER, executable by service_role only, and no
 *       append-only creator table keeps a SET NULL foreign key
 *   M5  every file has a rollback under db/rollback that undoes it, in order
 *   M6  the ledger is REACHABLE: routes registered, scheduler started, both on
 *       lines that moved no line-number citation
 *
 * Run: node --import tsx/esm --test src/test/creatorLedgerMigrationShape3385.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CREATOR_ACCOUNT_PARTY_ROLE, ACCOUNT_PARTY_ROLE } from "../lib/creatorShareCanonical.js";
import { RECOMMENDATION_ID_SHAPE } from "../lib/rankEventsProvenance.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const M = join(HERE, "../migrations");
const REPO = join(HERE, "../../../..");
const read = (f: string) => readFileSync(join(M, f), "utf8");
const statementsOf = (f: string) => read(f).split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

const M3385 = "3385_creator_share_ledger_includes_creator_entries.sql";
const M3386 = "3386_creator_attribution_recommendation_link.sql";
const M3387 = "3387_creator_ledger_integrity_and_audit.sql";

describe("M — 3385/3386/3387 say what the code depends on", () => {
  it("M1. 3385 adds the third partition, and its CASE is exactly the module's 2921 mapping — total, no ELSE", () => {
    const sql = statementsOf(M3385);
    assert.match(sql, /CREATE OR REPLACE VIEW public\.creator_share_ledger/);
    assert.equal([...sql.matchAll(/FROM public\.intel_reward_ledger irl/g)].length, 2);
    assert.equal([...sql.matchAll(/FROM public\.rent_buddy_earnings_entries e\b/g)].length, 1);
    assert.equal([...sql.matchAll(/FROM public\.creator_earning_entries c;/g)].length, 1, "the third partition is missing");
    const block = sql.slice(sql.indexOf("CASE c.account"));
    const cCase = block.slice(0, block.indexOf("END"));
    const whens = [...cCase.matchAll(/WHEN '(\w+)'\s+THEN '(\w+)'/g)].map((m) => [m[1]!, m[2]!]);
    assert.deepEqual(Object.fromEntries(whens), CREATOR_ACCOUNT_PARTY_ROLE,
      "3385's CASE and CREATOR_ACCOUNT_PARTY_ROLE disagree about whose money a leg is");
    assert.ok(!/\bELSE\b/.test(cCase), "an ELSE would silently give an unmapped future account somebody's money");
    // 2930's own mapping is untouched and still pinned against 2930 elsewhere.
    assert.equal(ACCOUNT_PARTY_ROLE.buddy_payable, "creator");
    for (const verb of [/(^|\n)\s*ALTER\s+TABLE\b/i, /(^|\n)\s*INSERT\s+INTO\b/i, /(^|\n)\s*UPDATE\s+\w/i,
                        /(^|\n)\s*DELETE\s+FROM\b/i, /(^|\n)\s*DROP\s+TABLE\b/i, /CREATE TABLE/i]) {
      assert.ok(!verb.test(sql), `3385 contains ${verb}; it must write no row and alter no table`);
    }
  });

  it("M2. 3385 keeps 2930's guarantees and reconciles three partitions per ledger", () => {
    const sql = statementsOf(M3385);
    assert.match(sql, /WITH \(security_invoker = true\)/);
    assert.deepEqual(sql.split("\n").filter((l) => /^\s*GRANT\b/.test(l)).map((l) => l.trim()),
      ["GRANT SELECT ON public.creator_share_ledger TO service_role;"]);
    assert.match(sql, /pg_relation_is_updatable\('public\.creator_share_ledger'::regclass, true\) <> 0/);
    assert.match(sql, /n_canon <> \(2 \* n_irl \+ n_rbee \+ n_cee\)/);
    assert.match(sql, /can_rbee <> src_rbee OR can_cee <> src_cee/, "the two currency partitions must reconcile separately");
    assert.match(read(M3385), /VACUOUS \(all three ledgers empty\)/);
  });

  it("M3. 3386 admits exactly P3's id shape, and checks existence on originals only", () => {
    const sql = statementsOf(M3386);
    const shape = /recommendation_id ~ '(\^[^']+\$)'/.exec(sql)?.[1];
    assert.equal(shape, RECOMMENDATION_ID_SHAPE.source, "3386's CHECK and rankEventsProvenance's shape have drifted apart");
    assert.match(sql, /ADD COLUMN IF NOT EXISTS recommendation_id text NULL/);
    assert.match(sql, /IF NEW\.recommendation_id IS NULL OR NEW\.supersedes_id IS NOT NULL THEN\s+RETURN NEW;/,
      "a hold on an old attribution must not depend on its exposure row surviving retention");
    assert.match(sql, /USING ERRCODE = 'foreign_key_violation'/);
  });

  it("M4. 3387's door is SECURITY INVOKER, service_role only; no append-only creator table keeps a SET NULL foreign key", () => {
    const sql = statementsOf(M3387);
    const door = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.creator_ledger_append"));
    assert.match(door.slice(0, 300), /SECURITY INVOKER/);
    assert.ok(!/(^|\n)\s*SECURITY DEFINER\b/.test(sql), "nothing in 3387 may run as its owner");
    assert.match(sql, /REVOKE ALL ON FUNCTION public\.creator_ledger_append\(jsonb\) FROM anon, authenticated;/);
    assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.creator_ledger_append\(jsonb\) TO service_role;/);
    assert.ok(!/ON DELETE SET NULL/.test(sql), "a SET NULL is an UPDATE, which an append-only table refuses — erasure would block");
    assert.match(sql, /actor_user_id\s+uuid\s+NULL,/, "the audit actor is a fact, not a SET NULL reference");
    assert.match(sql, /CREATE CONSTRAINT TRIGGER cee_transaction_balances[\s\S]{0,120}DEFERRABLE INITIALLY DEFERRED/);
    assert.match(sql, /SET CONSTRAINTS public\.cee_transaction_balances IMMEDIATE;/);
    for (const t of ["ca_rule_version_is_published", "ca_supersession_is_lawful", "cee_attribution_is_current", "clae_no_update"]) {
      assert.match(sql, new RegExp(`CREATE TRIGGER ${t}\\b`), t);
    }
    for (const f of [M3385, M3386, M3387]) {
      assert.ok(!/(INSERT\s+INTO|UPDATE)\s+public\.creator_rule_versions/i.test(statementsOf(f)),
        `${f} seeds or changes a rule version — no percentage may be decided by a migration in this lane`);
      assert.ok(!/feature_flags/.test(statementsOf(f)), `${f} touches feature_flags; no flag is turned on here`);
    }
  });

  it("M5. each file has a rollback that undoes it, and the rollbacks enforce their order", () => {
    const rb = (n: string) => join(REPO, "db/rollback", n);
    const r85 = rb("2026-09-27-3385-creator-share-ledger-includes-creator-entries-rollback.sql");
    const r86 = rb("2026-09-27-3386-creator-attribution-recommendation-link-rollback.sql");
    const r87 = rb("2026-09-27-3387-creator-ledger-integrity-and-audit-rollback.sql");
    for (const f of [r85, r86, r87]) assert.ok(existsSync(f), f);
    const t85 = readFileSync(r85, "utf8"), t86 = readFileSync(r86, "utf8"), t87 = readFileSync(r87, "utf8");
    assert.ok(!/creator_earning_entries c\b/.test(t85), "3385's rollback must restore the two-partition view");
    assert.match(t86, /ROLLBACK REFUSED \(3386\): 3387 is still applied/);
    assert.match(t86, /DROP COLUMN IF EXISTS recommendation_id/);
    assert.match(t87, /DROP FUNCTION IF EXISTS public\.creator_ledger_append\(jsonb\)/);
    assert.match(t87, /ROLLBACK REFUSED \(3387\): public\.creator_ledger_audit_events holds/);
    assert.match(t87, /ON DELETE SET NULL/, "the rollback restores 2921's beneficiary FK exactly");
    for (const t of [t85, t86, t87]) assert.match(t, /DELETE FROM public\.schema_migration_ledger/);
  });

  it("M6. the ledger is reachable: both routers registered and the producer scheduled, on lines that shifted no citation", () => {
    const routes = readFileSync(join(HERE, "../routes/index.ts"), "utf8").split("\n");
    const idx = readFileSync(join(HERE, "../index.ts"), "utf8").split("\n");
    assert.match(routes[79]!, /^import rentABuddyMarketplaceRouter from "\.\/rentABuddyMarketplace"; import creatorEconomyRouter from "\.\/creatorEconomy"; import adminCreatorLedgerRouter from "\.\/adminCreatorLedger";/);
    assert.match(routes[246]!, /^router\.use\(rentABuddyMarketplaceRouter\); router\.use\(creatorEconomyRouter\); router\.use\(adminCreatorLedgerRouter\);/);
    assert.match(idx[34]!, /import \{ startCreatorAttributionScheduler \} from "\.\/lib\/creatorAttributionScheduler";/);
    assert.match(idx[292]!, /^\s+startCreatorActivityScoreScheduler\(\); startCreatorAttributionScheduler\(\);/);
    assert.equal(routes.length, 439, "routes/index.ts changed length; census-telegraph cites its lines");
    assert.equal(idx.length, 443, "index.ts changed length; five censuses cite its lines");
  });
});
