/**
 * THE CONSENT BRIDGE — "nobody consented" must never be how "we could not tell"
 * comes out.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * Migration 3002 stops storing an account id in
 * intel_observations/intel_evidence/intel_confirmations.actor_id and stores a
 * ROTATING CONTRIBUTOR TOKEN instead, assigned by a BEFORE INSERT trigger and
 * derived from a per-epoch pepper held in a table with RLS on and ZERO GRANTS —
 * service_role included. Nothing outside the database can map a token back to
 * an account, which is the point.
 *
 * Four readers still joined that column to an account. Three of them fail
 * closed. THE FOURTH FABRICATES:
 *
 *   lib/intelProjectionAggregator  .in("user_id", actorIds) on
 *                                  intel_contribution_consent matches NOTHING
 *                                  post-3002 — and an empty filter result is
 *                                  NOT an error, so `evidenceComplete` (which is
 *                                  lowered only on an error) stayed TRUE. The
 *                                  cohort collapses to zero actors, the privacy
 *                                  gate refuses, and THAT REFUSAL IS PUBLISHED:
 *                                  "no live intelligence" asserted as a measured
 *                                  fact over a venue a consenting cohort had
 *                                  just described.
 *
 * This file pins the repair, and the property that makes it a repair rather than
 * a different empty: A MEASURED EMPTY AND AN UNESTABLISHED ANSWER MUST NOT BE
 * THE SAME VALUE. Section D asserts that as an inequality between two runs, so
 * the day someone collapses them the assertion has nothing left to compare.
 *
 * ── THE THREE SCHEMAS EXERCISED ─────────────────────────────────────────────
 *   pre3002        no 3002, no 3310. actor_id IS the account id. THIS IS
 *                  PRODUCTION TODAY (3002 is in the tree, unapplied, and
 *                  intel_capture_quick_signal is TRUE), so every case here is
 *                  live code, not a fossil.
 *   tokenised      3002 applied, 3310 NOT. The store is tokenised and there is
 *                  no bridge. THE DANGEROUS MIDDLE. Every call site must
 *                  withhold — distinguishably.
 *   bridged        3002 and 3310 both applied. The bridge answers.
 *
 * ── WHAT IS AND IS NOT PROVEN HERE ──────────────────────────────────────────
 * Section A is a STATIC CONTRACT test over 3310's SQL text, in the house idiom
 * of intelSqlFunctionContracts.test.ts: it cannot prove Postgres semantics and
 * does not claim to. Sections B-G are behaviour, against fakes that emulate
 * 3002's trigger (the account id never reaches storage) and 3310's functions.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  readConsentedContributors,
  readOwnContributorIdentities,
  resolveContributorIdentityShape,
  resetContributorIdentityShapeMemo,
  CONSENTED_CONTRIBUTORS_RPC,
  CONTRIBUTOR_TOKENS_FOR_ACTOR_RPC,
  CONTRIBUTOR_TOKEN_MARKER_RPC,
} from "../lib/intelConsent.js";
import { assembleClaimInput, type ClaimRow } from "../lib/intelProjectionAggregator.js";
import { readCrowdFlowSignals } from "../lib/crowdFlowProducer.js";
import { attachMediaEvidence } from "../lib/intelEvidenceCapture.js";
import { readContributorReputation } from "../services/media/MediaContributorReputationService.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(HERE, "../migrations");
const ROLLBACKS = resolve(HERE, "../../../../db/rollback");

const BRIDGE_MIGRATION = "3310_intel_consent_contributor_bridge.sql";
const BRIDGE_ROLLBACK = "2026-09-25-3310-intel-consent-contributor-bridge-rollback.sql";

// ═══════════════════════════════════════════════════════════════════════════
// A. THE MIGRATION — the bridge may only ever hand back a subset of its input
// ═══════════════════════════════════════════════════════════════════════════

const bridgeSql = (): string => readFileSync(resolve(MIGRATIONS, BRIDGE_MIGRATION), "utf8");

/** Comment-stripped, whitespace-collapsed — so prose about a rule is not the rule. */
function code(sql: string): string {
  return sql
    .split("\n")
    .map((l) => (/^\s*--/.test(l) ? "" : l))
    .join("\n")
    .replace(/\s+/g, " ");
}

/** The body of `CREATE OR REPLACE FUNCTION public.<name>` up to its `$fn$;` close. */
function fnBody(sql: string, name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  assert.ok(start >= 0, `${name} is not created by ${BRIDGE_MIGRATION}`);
  const end = sql.indexOf("$fn$;", start);
  assert.ok(end > start, `${name}'s body is not delimited by $fn$`);
  return sql.slice(start, end);
}

describe("3310 — the migration that bridges a contributor token to a consent row", () => {
  it("exists, is a single guarded transaction, and RAISEs if it did not achieve its goal", () => {
    const sql = bridgeSql();
    assert.match(sql, /^-- 3310_intel_consent_contributor_bridge\.sql/);
    assert.ok(code(sql).includes("BEGIN;"), "no BEGIN — a half-applied bridge is a store with no consent answer");
    assert.ok(code(sql).includes("COMMIT;"), "no COMMIT");
    const post = sql.slice(sql.indexOf("DO $post$"), sql.indexOf("$post$;"));
    assert.ok(post.length > 200, "no DO $post$ postcondition block");
    assert.ok(
      (post.match(/RAISE EXCEPTION/g) ?? []).length >= 8,
      "the postcondition does not RAISE EXCEPTION on enough of its goals to be one",
    );
  });

  it("refuses to apply before 3002 — a bridge over an un-tokenised store would answer from an empty pepper table", () => {
    const c = code(bridgeSql());
    assert.ok(c.includes("to_regclass('public.intel_contributor_pepper') IS NULL"));
    assert.ok(c.includes("to_regprocedure('public.intel_contributor_token_for_pepper(uuid, integer, text)') IS NULL"));
    // The marker the TypeScript probes to tell pre-3002 from tokenised MUST exist,
    // or the callers cannot distinguish the two states at all.
    assert.ok(c.includes("to_regprocedure('public.intel_contributor_token(uuid, timestamptz)') IS NULL"));
  });

  it("the consent bridge returns uuid[] — there is no column an account id could ride out on", () => {
    const body = fnBody(bridgeSql(), "intel_consented_contributor_tokens");
    assert.match(body, /RETURNS uuid\[\]/, "a row type could carry a user_id column to the caller");
    assert.ok(!/RETURNS TABLE/i.test(body), "RETURNS TABLE would let a second column out");
    assert.match(body, /SECURITY DEFINER/, "without it the pepper is unreadable and it answers 'nobody' to everyone");
    assert.match(body, /SET search_path = ''/);
    assert.match(body, /\bSTABLE\b/, "a read path must not be VOLATILE — it would be able to mint an epoch pepper");
    // The postcondition asserts the same thing against the live catalogue.
    assert.ok(code(bridgeSql()).includes("v_rettype <> 'uuid[]'"));
  });

  it("BOTH arms are constrained to the caller's own input, so the answer is a subset of it", () => {
    const body = code(fnBody(bridgeSql(), "intel_consented_contributor_tokens"));
    const arms = body.split("UNION");
    assert.equal(arms.length, 2, "expected exactly two arms (account-id shape UNION token shape)");
    for (const [i, arm] of arms.entries()) {
      assert.ok(
        /= ANY \(v_in\)/.test(arm),
        `arm ${i} is not constrained to the supplied ids — it could return a contributor the caller never asked about`,
      );
    }
    // Consent is consent: both arms require it, and neither may drop the
    // withdrawal clause (2174 carries the same two predicates).
    assert.equal((body.match(/c\.enabled = true/g) ?? []).length, 2);
    assert.equal((body.match(/c\.withdrawn_at IS NULL/g) ?? []).length, 2);
  });

  it("the token arm considers EVERY live epoch — one account holds one token per epoch", () => {
    const body = code(fnBody(bridgeSql(), "intel_consented_contributor_tokens"));
    assert.ok(
      /CROSS JOIN public\.intel_contributor_pepper p/.test(body),
      "the token arm does not scan the pepper table, so it can only answer for one epoch",
    );
    assert.ok(
      !/p\.epoch\s*=/.test(body),
      "the token arm pins an epoch — contributions from any other live epoch would read as unconsented",
    );
    assert.ok(/intel_contributor_token_for_pepper\(c\.user_id, p\.epoch, p\.pepper\)/.test(body));
  });

  it("the actor-token sibling runs account -> tokens only, over every epoch, and mints nothing", () => {
    const body = fnBody(bridgeSql(), "intel_contributor_tokens_for_actor");
    assert.match(body, /RETURNS uuid\[\]/);
    assert.match(body, /\bSTABLE\b/, "VOLATILE would let a read path mint a pepper for an epoch nobody contributed in");
    assert.ok(!/INSERT INTO/i.test(body), "a read path must not write");
    assert.match(code(body), /FROM public\.intel_contributor_pepper p/);
  });

  it("exposes both functions to service_role ONLY", () => {
    const c = code(bridgeSql());
    for (const sig of ["public.intel_consented_contributor_tokens(uuid[])", "public.intel_contributor_tokens_for_actor(uuid)"]) {
      for (const role of ["PUBLIC", "anon", "authenticated"]) {
        assert.ok(
          c.includes(`REVOKE ALL ON FUNCTION ${sig} FROM ${role};`),
          `${sig} is not revoked from ${role} — every public function is POST /rpc/<name> on the internet`,
        );
      }
      assert.ok(c.includes(`GRANT EXECUTE ON FUNCTION ${sig} TO service_role;`), `${sig} is unreachable by the api-server`);
    }
    // And the postcondition proves it against the catalogue rather than the text.
    assert.ok(c.includes("has_function_privilege('anon', 'public.intel_consented_contributor_tokens(uuid[])', 'EXECUTE')"));
  });

  it("does NOT widen the pepper — the bridge exists BECAUSE nothing outside the database may read it", () => {
    const c = code(bridgeSql());
    assert.ok(
      !/GRANT\s+[A-Z, ]*\bON\s+(TABLE\s+)?public\.intel_contributor_pepper\b/i.test(c),
      "3310 grants something on intel_contributor_pepper — that would make every stored token reversible",
    );
    assert.ok(
      c.includes("has_table_privilege('service_role', 'public.intel_contributor_pepper', 'SELECT')"),
      "the postcondition does not re-check that the pepper stayed unreadable",
    );
  });

  it("ships with its rollback, named like its neighbours", () => {
    const path = resolve(ROLLBACKS, BRIDGE_ROLLBACK);
    assert.ok(existsSync(path), `db/rollback/${BRIDGE_ROLLBACK} is missing — the pair is what "reviewed migration" means`);
    const sql = readFileSync(path, "utf8");
    assert.match(sql, /DROP FUNCTION IF EXISTS public\.intel_consented_contributor_tokens\(uuid\[\]\);/);
    assert.match(sql, /DROP FUNCTION IF EXISTS public\.intel_contributor_tokens_for_actor\(uuid\);/);
    // It must NOT quietly restore the broken join as a "fix".
    assert.ok(
      /DO NOT "restore service"/.test(sql),
      "the rollback does not warn that re-pointing the readers at the account column re-creates the defect",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Fakes — a store in one of the three schemas
// ═══════════════════════════════════════════════════════════════════════════

type Schema = "pre3002" | "tokenised" | "bridged";

const ACCOUNT = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** 3002's derivation, emulated: distinct per (account, epoch), one way. */
const TOKEN = (account: string, epoch: number) => `ffff${epoch}fff-0000-4000-8000-${account.slice(-12)}`;
/** Two live epochs, so "one account has several live tokens" is exercised, not assumed. */
const EPOCHS = [2870, 2871];

interface StoreConfig {
  schema: Schema;
  /** Accounts with enabled, un-withdrawn consent. */
  consented?: string[];
  /** Observation rows, written with ACCOUNT ids; the fake tokenises them like 3002's trigger. */
  observations?: Array<Record<string, any>>;
  evidence?: Array<Record<string, any>>;
  snapshots?: Array<Record<string, any>>;
  /** Make the bridge RPC fail (it exists; it just could not answer). */
  bridgeError?: { code?: string; message: string };
  /** Make the account-column consent read fail. */
  consentReadError?: boolean;
}

interface FakeStore {
  client: SupabaseClient & { _rpcCalls: Array<{ fn: string; args: any }>; _tables: Record<string, any[]> };
  /** What actor_id a row written by `account` actually carries in this schema. */
  stored: (account: string, epoch?: number) => string;
}

function makeStore(cfg: StoreConfig): FakeStore {
  const tokenised = cfg.schema !== "pre3002";
  const stored = (account: string, epoch = EPOCHS[0]!) => (tokenised ? TOKEN(account, epoch) : account);

  const tables: Record<string, any[]> = {
    // 3002's BEFORE INSERT trigger, emulated: the account id never reaches storage.
    intel_observations: (cfg.observations ?? []).map((o) => ({
      moderation_state: "allowed",
      presence_level: "P0",
      source_class: "firsthand_unverified",
      expires_at: null,
      ...o,
      actor_id: o.actor_id == null ? null : stored(o.actor_id, o.epoch ?? EPOCHS[0]),
    })),
    intel_contribution_consent: (cfg.consented ?? []).map((id) => ({ user_id: id, enabled: true, withdrawn_at: null })),
    intel_evidence: cfg.evidence ?? [],
    intel_confirmations: [],
    intel_state_snapshots: cfg.snapshots ?? [],
    freshness_policies: [{ claim_type: "crowd.level", ttl_seconds: 2700, note: null }],
  };

  const rpcCalls: Array<{ fn: string; args: any }> = [];

  const missingFn = (fn: string) => ({
    data: null,
    error: { code: "PGRST202", message: `Could not find the function public.${fn} in the schema cache` },
  });

  const client: any = {
    _rpcCalls: rpcCalls,
    _tables: tables,
    from(table: string) {
      const eqs: Array<[string, any]> = [];
      let inF: [string, any[]] | null = null;
      let insertPayload: any = null;
      const rows = () =>
        (tables[table] ?? []).filter(
          (r) => eqs.every(([c, v]) => r[c] === v) && (!inF || inF[1].includes(r[inF[0]!])),
        );
      const run = () => {
        if (table === "feature_flags") return { data: { enabled: true }, error: null };
        if (table === "intel_contribution_consent" && cfg.consentReadError) {
          return { data: null, error: { code: "08006", message: "server closed the connection unexpectedly" } };
        }
        if (insertPayload) {
          const row = { id: `ev-${(tables.intel_evidence ?? []).length + 1}`, ...insertPayload };
          (tables[table] ??= []).push(row);
          return { data: row, error: null };
        }
        return { data: rows(), error: null };
      };
      const b: any = {
        select() { return b; },
        insert(payload: any) { insertPayload = payload; return b; },
        eq(c: string, v: any) { eqs.push([c, v]); return b; },
        is(c: string, v: any) { eqs.push([c, v]); return b; },
        in(c: string, v: any[]) { inF = [c, v]; return b; },
        gte() { return b; },
        limit() { return b; },
        maybeSingle() { const r = run(); return Promise.resolve({ data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error }); },
        single() { return Promise.resolve(run()); },
        then(res: (r: any) => any) { return Promise.resolve(run()).then(res); },
      };
      return b;
    },
    async rpc(fn: string, args: any) {
      rpcCalls.push({ fn, args });
      if (fn === CONTRIBUTOR_TOKEN_MARKER_RPC) {
        // 3002's function. Present iff the store is tokenised. NULL short-circuits.
        if (!tokenised) return missingFn(fn);
        return { data: args?.p_actor_id == null ? null : TOKEN(String(args.p_actor_id), EPOCHS[0]!), error: null };
      }
      if (fn === CONSENTED_CONTRIBUTORS_RPC) {
        if (cfg.schema !== "bridged") return missingFn(fn);
        if (cfg.bridgeError) return { data: null, error: { code: cfg.bridgeError.code ?? "42501", message: cfg.bridgeError.message } };
        const supplied: string[] = Array.isArray(args?.p_tokens) ? args.p_tokens : [];
        const answer = new Set<string>();
        for (const account of cfg.consented ?? []) {
          // arm (a) — the pre-3002 / out-of-scope shape
          if (supplied.includes(account)) answer.add(account);
          // arm (b) — every live epoch
          for (const epoch of EPOCHS) {
            const t = TOKEN(account, epoch);
            if (supplied.includes(t)) answer.add(t);
          }
        }
        return { data: [...answer], error: null };
      }
      if (fn === CONTRIBUTOR_TOKENS_FOR_ACTOR_RPC) {
        if (cfg.schema !== "bridged") return missingFn(fn);
        if (cfg.bridgeError) return { data: null, error: { code: cfg.bridgeError.code ?? "42501", message: cfg.bridgeError.message } };
        const account = args?.p_actor_id;
        if (!account) return { data: [], error: null };
        return { data: EPOCHS.map((e) => TOKEN(String(account), e)), error: null };
      }
      return missingFn(fn);
    },
  };
  return { client, stored };
}

beforeEach(() => resetContributorIdentityShapeMemo());

// ═══════════════════════════════════════════════════════════════════════════
// B. THE SHAPE PROBE — the dangerous middle must not read as the safe end
// ═══════════════════════════════════════════════════════════════════════════

describe("resolveContributorIdentityShape", () => {
  it("a client with no .rpc at all reads as pre-3002 — every fake in this repo, and production today", async () => {
    const shape = await resolveContributorIdentityShape({ from: () => ({}) });
    assert.equal(shape, "account");
  });

  it("both functions absent = pre-3002", async () => {
    assert.equal(await resolveContributorIdentityShape(makeStore({ schema: "pre3002" }).client), "account");
  });

  it("3002 applied, 3310 NOT = unreadable — NOT 'account', which is the shape that answers empty", async () => {
    assert.equal(await resolveContributorIdentityShape(makeStore({ schema: "tokenised" }).client), "unreadable");
  });

  it("both applied = bridge", async () => {
    assert.equal(await resolveContributorIdentityShape(makeStore({ schema: "bridged" }).client), "bridge");
  });

  it("a PERMISSION DENIAL on the bridge is not an absence — the function is there and the answer is unknown", async () => {
    const store = makeStore({ schema: "bridged", bridgeError: { code: "42501", message: "permission denied for function" } });
    assert.equal(await resolveContributorIdentityShape(store.client), "unreadable");
  });

  it("the marker probe cannot mint a pepper: it is called with a NULL actor", async () => {
    const store = makeStore({ schema: "tokenised" });
    await resolveContributorIdentityShape(store.client);
    const marker = store.client._rpcCalls.find((c) => c.fn === CONTRIBUTOR_TOKEN_MARKER_RPC);
    assert.ok(marker, "the marker was never probed, so pre-3002 and tokenised are indistinguishable");
    assert.equal(marker!.args.p_actor_id, null, "probing with a real actor id would mint an epoch pepper from a read");
  });

  it("the verdict is memoized PER CLIENT, so one store's answer cannot be served for another", async () => {
    const pre = makeStore({ schema: "pre3002" }).client;
    const bridged = makeStore({ schema: "bridged" }).client;
    assert.equal(await resolveContributorIdentityShape(pre), "account");
    assert.equal(await resolveContributorIdentityShape(bridged), "bridge");
    const before = pre._rpcCalls.length;
    assert.equal(await resolveContributorIdentityShape(pre), "account");
    assert.equal(pre._rpcCalls.length, before, "the memo did not hold — the probe re-ran");
  });

  it("an 'unreadable' verdict is NEVER memoized — a transient fault must not pin the process into withholding", async () => {
    const store = makeStore({ schema: "tokenised" });
    await resolveContributorIdentityShape(store.client);
    const after = store.client._rpcCalls.length;
    await resolveContributorIdentityShape(store.client);
    assert.ok(store.client._rpcCalls.length > after, "the unreadable verdict was cached");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. readConsentedContributors — the two empties are different values
// ═══════════════════════════════════════════════════════════════════════════

describe("readConsentedContributors", () => {
  it("pre-3002: the account column is authoritative and is used", async () => {
    const store = makeStore({ schema: "pre3002", consented: [ACCOUNT(1)] });
    const answer = await readConsentedContributors(store.client, [ACCOUNT(1), ACCOUNT(2)]);
    assert.equal(answer.ok, true);
    assert.ok(answer.ok && answer.via === "account_column");
    assert.deepEqual(answer.ok && [...answer.consented], [ACCOUNT(1)]);
  });

  it("bridged: a token is resolved to its consent WITHOUT the caller ever seeing an account", async () => {
    const store = makeStore({ schema: "bridged", consented: [ACCOUNT(1)] });
    const mine = TOKEN(ACCOUNT(1), EPOCHS[0]!);
    const theirs = TOKEN(ACCOUNT(2), EPOCHS[0]!);
    const answer = await readConsentedContributors(store.client, [mine, theirs]);
    assert.equal(answer.ok, true);
    assert.deepEqual(answer.ok && [...answer.consented], [mine]);
    assert.ok(answer.ok && !answer.consented.has(ACCOUNT(1)), "an account id came back from the bridge");
  });

  it("bridged: a contributor's OTHER live epoch resolves too — a token is epoch-scoped", async () => {
    const store = makeStore({ schema: "bridged", consented: [ACCOUNT(1)] });
    const lastWeek = TOKEN(ACCOUNT(1), EPOCHS[1]!);
    const answer = await readConsentedContributors(store.client, [lastWeek]);
    assert.ok(answer.ok && answer.consented.has(lastWeek), "last epoch's token read as unconsented");
  });

  it("THE DISTINCTION: a measured 'nobody' and an unestablished answer are different values", async () => {
    // Measured: the bridge is there, it was asked, it said nobody.
    const measured = await readConsentedContributors(
      makeStore({ schema: "bridged", consented: [] }).client,
      [TOKEN(ACCOUNT(1), EPOCHS[0]!)],
    );
    // Unestablished: 3002 applied, no bridge. Nothing in this process can tell.
    const unestablished = await readConsentedContributors(
      makeStore({ schema: "tokenised" }).client,
      [TOKEN(ACCOUNT(1), EPOCHS[0]!)],
    );

    assert.equal(measured.ok, true);
    assert.equal(measured.ok && measured.consented.size, 0);
    assert.equal(unestablished.ok, false);
    assert.notEqual(
      measured.ok,
      unestablished.ok,
      "the two collapsed into one value — 'we could not tell' is being reported as 'nobody consented'",
    );
    assert.equal(unestablished.ok === false && unestablished.reason, "bridge_unavailable");
  });

  it("a failing bridge withholds; it does not degrade to the account column", async () => {
    const store = makeStore({
      schema: "bridged",
      consented: [ACCOUNT(1)],
      bridgeError: { code: "57014", message: "canceling statement due to statement timeout" },
    });
    const answer = await readConsentedContributors(store.client, [TOKEN(ACCOUNT(1), EPOCHS[0]!)]);
    assert.equal(answer.ok, false);
  });

  it("pre-3002, a failing consent read withholds too", async () => {
    const store = makeStore({ schema: "pre3002", consented: [ACCOUNT(1)], consentReadError: true });
    const answer = await readConsentedContributors(store.client, [ACCOUNT(1)]);
    assert.equal(answer.ok, false);
    assert.equal(answer.ok === false && answer.reason, "consent_read_failed");
  });

  it("no contributor ids at all is a complete answer, and asks the database nothing", async () => {
    const store = makeStore({ schema: "tokenised" });
    const answer = await readConsentedContributors(store.client, []);
    assert.ok(answer.ok && answer.via === "no_contributors");
    assert.equal(store.client._rpcCalls.length, 0);
  });

  it("NO ACCOUNT ID IS EVER SENT TO THE BRIDGE — only the stored ids the caller already holds", async () => {
    const store = makeStore({ schema: "bridged", consented: [ACCOUNT(1)] });
    const mine = TOKEN(ACCOUNT(1), EPOCHS[0]!);
    await readConsentedContributors(store.client, [mine]);
    const call = store.client._rpcCalls.find((c) => c.fn === CONSENTED_CONTRIBUTORS_RPC && c.args.p_tokens?.length);
    assert.deepEqual(call!.args.p_tokens, [mine]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D. THE AGGREGATOR — the call site that would have published the fabrication
// ═══════════════════════════════════════════════════════════════════════════

const NOW = new Date("2026-09-25T12:00:00.000Z");
const T = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();

const obs = (account: string, over: Record<string, unknown> = {}) => ({
  id: `o-${account}-${String(over.epoch ?? EPOCHS[0])}`,
  actor_id: account,
  subject_id: "place-1",
  claim_type: "crowd.level",
  value: { level: "busy" },
  observed_at: T(5),
  group_key: `g-${account}`,
  ...over,
});

const CLAIM: ClaimRow = {
  id: "c1", subject_id: "place-1", zone_id: null, claim_type: "crowd.level",
  value: { level: "busy" }, status: "active", observed_at: T(30),
};

describe("assembleClaimInput — a cohort of consenting contributors survives 3002", () => {
  it("pre-3002 (production today): the cohort is counted and the evidence is complete", async () => {
    const store = makeStore({
      schema: "pre3002",
      consented: [ACCOUNT(1), ACCOUNT(2)],
      observations: [obs(ACCOUNT(1)), obs(ACCOUNT(2))],
    });
    const input = await assembleClaimInput(store.client, CLAIM, NOW);
    assert.equal(input.distinctActors, 2);
    assert.equal(input.evidenceComplete, true);
  });

  it("bridged: the SAME cohort, now stored as tokens, is still counted — across two epochs", async () => {
    const store = makeStore({
      schema: "bridged",
      consented: [ACCOUNT(1), ACCOUNT(2)],
      observations: [obs(ACCOUNT(1), { epoch: EPOCHS[0] }), obs(ACCOUNT(2), { epoch: EPOCHS[1] })],
    });
    const input = await assembleClaimInput(store.client, CLAIM, NOW);
    assert.equal(input.distinctActors, 2, "a token from the older epoch was dropped from the cohort");
    assert.equal(input.evidenceComplete, true);
  });

  it("bridged: a contributor who WITHDREW is dropped, and the rest still count", async () => {
    const store = makeStore({
      schema: "bridged",
      consented: [ACCOUNT(1)],
      observations: [obs(ACCOUNT(1)), obs(ACCOUNT(2))],
    });
    const input = await assembleClaimInput(store.client, CLAIM, NOW);
    assert.equal(input.distinctActors, 1);
    assert.equal(input.evidenceComplete, true);
  });

  it("THE DEFECT, PINNED: 3002 applied and no bridge WITHHOLDS — it does not publish an empty cohort as a fact", async () => {
    const store = makeStore({
      schema: "tokenised",
      consented: [ACCOUNT(1), ACCOUNT(2)],
      observations: [obs(ACCOUNT(1)), obs(ACCOUNT(2))],
    });
    const input = await assembleClaimInput(store.client, CLAIM, NOW);
    assert.equal(input.distinctActors, 0, "nothing can be counted — the tokens cannot be resolved");
    assert.equal(
      input.evidenceComplete,
      false,
      "the cohort emptied and the claim was still marked complete — this is the published suppression",
    );
  });

  it("AND THE TWO EMPTIES STAY APART: a genuinely unconsented cohort is a COMPLETE answer", async () => {
    const genuinely = await assembleClaimInput(
      makeStore({ schema: "bridged", consented: [], observations: [obs(ACCOUNT(1)), obs(ACCOUNT(2))] }).client,
      CLAIM, NOW,
    );
    const unreadable = await assembleClaimInput(
      makeStore({ schema: "tokenised", consented: [ACCOUNT(1), ACCOUNT(2)], observations: [obs(ACCOUNT(1)), obs(ACCOUNT(2))] }).client,
      CLAIM, NOW,
    );
    assert.equal(genuinely.distinctActors, 0);
    assert.equal(unreadable.distinctActors, 0);
    // Same cohort size, opposite meanings. If this assertion has nothing to
    // compare, the two have been collapsed and the fabrication is back.
    assert.equal(genuinely.evidenceComplete, true, "a measured 'nobody consented' must stay publishable as the refusal it is");
    assert.equal(unreadable.evidenceComplete, false);
    assert.notEqual(genuinely.evidenceComplete, unreadable.evidenceComplete);
  });

  it("the aggregator hands the bridge stored ids only, and gets no account id back", async () => {
    const store = makeStore({
      schema: "bridged",
      consented: [ACCOUNT(1), ACCOUNT(2)],
      observations: [obs(ACCOUNT(1)), obs(ACCOUNT(2))],
    });
    await assembleClaimInput(store.client, CLAIM, NOW);
    const asked = store.client._rpcCalls.filter((c) => c.fn === CONSENTED_CONTRIBUTORS_RPC && c.args?.p_tokens?.length);
    assert.equal(asked.length, 1, "vacuity guard: the bridge was never asked, so this proves nothing about what it was sent");
    const accounts = new Set([ACCOUNT(1), ACCOUNT(2)]);
    for (const call of store.client._rpcCalls) {
      for (const supplied of call.args?.p_tokens ?? []) {
        assert.ok(!accounts.has(supplied), `an ACCOUNT id was sent to ${call.fn}`);
      }
      assert.ok(!accounts.has(call.args?.p_actor_id), `an ACCOUNT id was sent to ${call.fn}`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// E. crowdFlowProducer — the family refuses rather than reporting nobody
// ═══════════════════════════════════════════════════════════════════════════

const flowObs = (account: string, epoch = EPOCHS[0]!) => ({
  actor_id: account,
  epoch,
  subject_id: "p1",
  zone_id: "zone-A",
  claim_type: "experience.next_move",
  value: { destinationArea: "An Thuong" },
  group_key: `g-${account}`,
  observed_at: T(5),
  expires_at: null,
});

const FLOW_OPTS = {
  now: NOW,
  wired: ["next_stop_contribution", "arrival"] as any,
  resolveZoneId: (k: string, key: string) => (k === "destination_area" ? "zone-B" : key),
};

describe("readCrowdFlowSignals — next_stop_contribution", () => {
  it("bridged: a consenting contributor's next-move signal still lands, from either epoch", async () => {
    const store = makeStore({
      schema: "bridged",
      consented: [ACCOUNT(1)],
      observations: [flowObs(ACCOUNT(1), EPOCHS[1]!), flowObs(ACCOUNT(2))],
    });
    const r = await readCrowdFlowSignals(store.client as any, FLOW_OPTS);
    assert.equal(r.signals.length, 1);
    assert.equal(r.familyRefusals.next_stop_contribution, null);
  });

  it("3002 applied, no bridge: the family REFUSES with consent_unreadable and feeds nothing", async () => {
    const store = makeStore({
      schema: "tokenised",
      consented: [ACCOUNT(1)],
      observations: [flowObs(ACCOUNT(1))],
    });
    const r = await readCrowdFlowSignals(store.client as any, FLOW_OPTS);
    assert.deepEqual(r.signals, []);
    assert.equal(r.familyRefusals.next_stop_contribution, "consent_unreadable");
    assert.notEqual(r.familyRefusals.next_stop_contribution, null, "silence would read as a measured empty cohort");
    assert.notEqual(r.familyRefusals.next_stop_contribution, "read_failed", "the observations read fine; consent did not");
  });

  it("a genuinely unconsented cohort reports NO refusal — the two empties stay apart here too", async () => {
    const store = makeStore({ schema: "bridged", consented: [], observations: [flowObs(ACCOUNT(1))] });
    const r = await readCrowdFlowSignals(store.client as any, FLOW_OPTS);
    assert.deepEqual(r.signals, []);
    assert.equal(r.familyRefusals.next_stop_contribution, null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F. intelEvidenceCapture — a contributor must still own their own observation
// ═══════════════════════════════════════════════════════════════════════════

// A real wall-clock instant and an own-bucket storage key: the other five gates
// in attachMediaEvidence must PASS so the only thing under test is ownership.
const EVIDENCE_INPUT = {
  observationId: "obs-1",
  subjectId: "place-1",
  mediaKind: "photo" as const,
  mediaUri: `post-media/${ACCOUNT(1)}/1756600000000.jpg`,
  observedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
};

function evidenceStore(schema: Schema, ownerEpoch = EPOCHS[0]!) {
  return makeStore({
    schema,
    consented: [ACCOUNT(1)],
    observations: [
      { id: "obs-1", actor_id: ACCOUNT(1), epoch: ownerEpoch, subject_id: "place-1", claim_type: "crowd.level" },
      { id: "obs-2", actor_id: ACCOUNT(2), subject_id: "place-1", claim_type: "crowd.level" },
    ],
  });
}

describe("attachMediaEvidence — ownership after 3002", () => {
  it("pre-3002: unchanged, the owner's own observation accepts the evidence", async () => {
    const store = evidenceStore("pre3002");
    const r = await attachMediaEvidence(store.client as any, ACCOUNT(1), EVIDENCE_INPUT);
    assert.equal(r.ok, true, `refused: ${JSON.stringify(r)}`);
  });

  it("bridged: the owner is recognised through their token — including last epoch's", async () => {
    for (const epoch of EPOCHS) {
      const store = evidenceStore("bridged", epoch);
      const r = await attachMediaEvidence(store.client as any, ACCOUNT(1), EVIDENCE_INPUT);
      assert.equal(r.ok, true, `epoch ${epoch} refused: ${JSON.stringify(r)}`);
    }
  });

  it("bridged: someone ELSE's observation is still refused as unknown_observation", async () => {
    const store = evidenceStore("bridged");
    const r = await attachMediaEvidence(store.client as any, ACCOUNT(1), { ...EVIDENCE_INPUT, observationId: "obs-2" });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, "unknown_observation");
  });

  it("an observation that does not exist gives the SAME answer — the existence oracle stays closed", async () => {
    const store = evidenceStore("bridged");
    const r = await attachMediaEvidence(store.client as any, ACCOUNT(1), { ...EVIDENCE_INPUT, observationId: "obs-nope" });
    assert.equal(!r.ok && r.reason, "unknown_observation");
  });

  it("3002 applied, no bridge: db_error (retryable), NEVER unknown_observation", async () => {
    const store = evidenceStore("tokenised");
    const r = await attachMediaEvidence(store.client as any, ACCOUNT(1), EVIDENCE_INPUT);
    assert.equal(r.ok, false);
    assert.equal(
      !r.ok && r.reason,
      "db_error",
      "ownership was UNKNOWN and was reported as 'not yours' — a client told that will not retry",
    );
  });

  it("the identity lookup runs BEFORE the observation is read, so a failure reveals nothing about any id", async () => {
    const store = evidenceStore("tokenised");
    await attachMediaEvidence(store.client as any, ACCOUNT(1), { ...EVIDENCE_INPUT, observationId: "obs-nope" });
    // Same refusal for an id that exists and one that does not: still db_error.
    const r = await attachMediaEvidence(store.client as any, ACCOUNT(1), EVIDENCE_INPUT);
    assert.equal(!r.ok && r.reason, "db_error");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// G. MediaContributorReputationService
// ═══════════════════════════════════════════════════════════════════════════

describe("readContributorReputation — a contributor's own rows after 3002", () => {
  const rows = (account: string) => [
    { actor_id: account, epoch: EPOCHS[0], subject_id: "place1", claim_type: "crowd", moderation_state: "allowed" },
    { actor_id: account, epoch: EPOCHS[1], subject_id: "place1", claim_type: "vibe", moderation_state: "allowed" },
  ];

  it("pre-3002: the query is still an .eq on the account id", async () => {
    const store = makeStore({ schema: "pre3002", observations: rows(ACCOUNT(1)) });
    const rep = await readContributorReputation(store.client as any, { contributorId: ACCOUNT(1) });
    assert.equal(rep.isEmpty, false);
    assert.equal(rep.contributorReliability, 1);
  });

  it("bridged: the contributor's rows are found under their tokens, across epochs", async () => {
    const store = makeStore({ schema: "bridged", observations: rows(ACCOUNT(1)) });
    const rep = await readContributorReputation(store.client as any, { contributorId: ACCOUNT(1) });
    assert.equal(rep.isEmpty, false, "the contributor's own contributions read as none — .eq on an account id post-3002");
    assert.equal(rep.contributorReliability, 1);
  });

  it("bridged: another contributor's rows are NOT theirs", async () => {
    const store = makeStore({ schema: "bridged", observations: rows(ACCOUNT(2)) });
    const rep = await readContributorReputation(store.client as any, { contributorId: ACCOUNT(1) });
    assert.equal(rep.isEmpty, true);
  });

  it("3002 applied, no bridge: degrades to the empty reputation, never an inflated one", async () => {
    const store = makeStore({ schema: "tokenised", observations: rows(ACCOUNT(1)) });
    const rep = await readContributorReputation(store.client as any, { contributorId: ACCOUNT(1) });
    assert.equal(rep.isEmpty, true);
    assert.equal(rep.contributorReliability, 0);
  });
});
