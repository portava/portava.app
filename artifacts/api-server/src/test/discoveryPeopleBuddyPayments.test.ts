import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import discoverySearchRouter, { invalidateBuddyLaunchGateCache } from "../routes/discoverySearch.js";
import { NO_BUDDY_ASK, readBuddyEligibility } from "../lib/discoveryPeopleBuddy.js";
import { invalidateSearchProtectionFlagCache } from "../lib/discoverySearchProtection.js";
import { invalidateDiscoveryTripProjectionFlagCache } from "../lib/discoveryTripProjectionConsumer.js";
import { paymentsReadiness } from "../services/payments/readiness.js";
import { emptyCalls, emptyState, installKit, kitGet, makeKitClient, startKitServer, VIEWER, type KitState } from "./discoverySearchTestKit.js";

const BUDDY = "d1000000-0000-4000-a000-000000000001";
const GATE = "discovery_buddy_launch_gate_enabled";
const savedEnv = { ...process.env };
const originalFetch = globalThis.fetch;
let hostedCalls = 0;
let base: string;
let server: Server;

function configure() {
  process.env.NODE_ENV = "test";
  process.env.PAYMENT_PROVIDER = "fake";
  process.env.TAX_PROVIDER = "fake";
  process.env.PAYMENTS_ENABLED_MARKETS = "US";
  process.env.PAYMENTS_ALLOW_LIVE = "false";
  process.env.IDENTITY_PROVIDER = "mock";
  delete process.env.REPLIT_DEPLOYMENT;
}

before(async () => {
  configure();
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== "127.0.0.1") {
      hostedCalls++;
      throw new Error("Hosted I/O forbidden in Discovery eligibility tests");
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  ({ base, server } = await startKitServer(discoverySearchRouter));
});

after(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  invalidateBuddyLaunchGateCache();
  server.close();
  assert.equal(hostedCalls, 0);
});

function world(): KitState {
  return emptyState({
    flags: { [GATE]: true, rent_buddy_enabled: true },
    rows: {
      profiles: [VIEWER, BUDDY].map((id) => ({
        id, handle: id === BUDDY ? "zork_buddy" : "viewer", username: "zork_buddy", name: "Zork Buddy",
        account_status: "active", is_private: false, verification_level: "id_verified",
        buddy_verified_at: id === BUDDY ? "2026-01-01T00:00:00Z" : null,
      })),
      rent_buddy_profiles: [{
        id: "buddy-profile", user_id: BUDDY, status: "active", admin_status: "active",
        categories: ["city"], country: "US", risk_hold: false,
      }],
      identity_verifications: [{
        id: "identity-1", user_id: BUDDY, provider: "sumsub", provider_mode: "live",
        status: "verified", is_over_18: true, document_country: "US", created_at: "2026-01-01T00:00:00Z",
      }],
      payment_parties: [{ id: "party-1", profile_id: BUDDY }],
      rent_buddy_payment_recipients: [{
        party_id: "party-1", provider: "fake", recipient_ref: "acct_verified",
        country: "US", settlement_currency: "USD", onboarding: "verified",
        charges_enabled: true, payouts_enabled: true, requirements_due: [],
      }],
    },
  });
}

async function read(state = world()) {
  const calls = emptyCalls();
  const result = await readBuddyEligibility(makeKitClient(state, calls), [BUDDY], NO_BUDDY_ASK);
  assert.deepEqual(calls.writes, [], "Discovery must not create payment parties, onboard, or write state");
  return { result, calls };
}

function multiCandidateWorld() {
  const state = world();
  const userIds = Array.from({ length: 9 }, (_, index) => `d1000000-0000-4000-a000-${String(index + 1).padStart(12, "0")}`);
  const template = world().rows;
  state.rows.profiles = userIds.map((id) => ({ ...template.profiles![1], id }));
  state.rows.rent_buddy_profiles = userIds.map((userId) => ({ ...template.rent_buddy_profiles![0], id: `buddy-${userId}`, user_id: userId }));
  state.rows.identity_verifications = userIds.map((userId) => ({ ...template.identity_verifications![0], id: `identity-${userId}`, user_id: userId }));
  state.rows.payment_parties = userIds.map((userId) => ({ id: `party-${userId}`, profile_id: userId }));
  state.rows.rent_buddy_payment_recipients = userIds.map((userId) => ({ ...template.rent_buddy_payment_recipients![0], party_id: `party-${userId}` }));
  return { state, userIds };
}

function install(state = world()) {
  invalidateBuddyLaunchGateCache();
  invalidateSearchProtectionFlagCache();
  invalidateDiscoveryTripProjectionFlagCache();
  return installKit(state);
}

describe("B03 payment eligibility consumes the domain without hosted I/O", () => {
  it("runs at most four candidate pipelines and refills a slot only after recipient completion", async () => {
    configure();
    const { state, userIds } = multiCandidateWorld();
    const calls = emptyCalls();
    const client = makeKitClient(state, calls);
    const started: string[] = [];
    const active = new Set<string>();
    const releases = new Map<string, () => void>();
    let peak = 0;
    let draining = false;
    const from = client.from.bind(client);
    client.from = (table: string) => {
      const builder = from(table);
      if (table !== "identity_verifications" && table !== "rent_buddy_payment_recipients") return builder;
      let userId = "";
      const eq = builder.eq.bind(builder);
      builder.eq = (column: string, value: string) => {
        userId = table === "identity_verifications" ? value : value.slice("party-".length);
        return eq(column, value);
      };
      const maybeSingle = builder.maybeSingle.bind(builder);
      builder.maybeSingle = async () => {
        if (table === "identity_verifications") {
          started.push(userId);
          active.add(userId);
          peak = Math.max(peak, active.size);
        }
        if (!draining) await new Promise<void>((resolve) => { releases.set(`${table}:${userId}`, resolve); });
        const result = await maybeSingle();
        if (table === "rent_buddy_payment_recipients") active.delete(userId);
        return result;
      };
      return builder;
    };
    const pending = readBuddyEligibility(client, [...userIds, userIds[0]!], NO_BUDDY_ASK);
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(started, userIds.slice(0, 4));
      releases.get(`identity_verifications:${userIds[0]}`)!();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.ok(releases.has(`rent_buddy_payment_recipients:${userIds[0]}`));
      assert.equal(started.length, 4, "a pending recipient still occupies its candidate slot");
      releases.get(`rent_buddy_payment_recipients:${userIds[0]}`)!();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(started, userIds.slice(0, 5), "refill without waiting for the other three candidates");
    } finally {
      draining = true;
      for (const release of releases.values()) release();
      await pending;
    }
    assert.deepEqual(await pending, { ok: true, ineligible: new Map() });
    assert.deepEqual(started, userIds, "each distinct candidate is checked exactly once");
    assert.equal(peak, 4);
    assert.equal(active.size, 0);
    assert.equal(calls.tables.filter((table) => table === "rent_buddy_payment_recipients").length, userIds.length);
    assert.deepEqual(calls.writes, []);
  });

  it("preserves mixed candidate verdicts and fails the whole read on a later worker's resolved or rejected error", async () => {
    configure();
    for (const failure of [null, "resolved", "rejected"] as const) {
      const { state, userIds } = multiCandidateWorld();
      state.rows.identity_verifications![1].is_over_18 = false;
      state.rows.rent_buddy_payment_recipients![2].payouts_enabled = false;
      const calls = emptyCalls();
      const client = makeKitClient(state, calls);
      const from = client.from.bind(client);
      client.from = (table: string) => {
        const builder = from(table);
        if (table !== "rent_buddy_payment_recipients") return builder;
        let partyId = "";
        const eq = builder.eq.bind(builder);
        builder.eq = (column: string, value: string) => { partyId = value; return eq(column, value); };
        const maybeSingle = builder.maybeSingle.bind(builder);
        builder.maybeSingle = async () => {
          if (failure && partyId === `party-${userIds[5]}`) {
            if (failure === "rejected") throw new Error("recipient read rejected");
            return { data: null, error: { code: "42P01", message: "missing relation" } };
          }
          return maybeSingle();
        };
        return builder;
      };
      const result = await readBuddyEligibility(client, userIds, NO_BUDDY_ASK);
      if (failure) {
        assert.ok(!result.ok, failure);
        assert.equal(result.relation, "rent_buddy_payment_recipients");
      } else {
        assert.deepEqual(result, { ok: true, ineligible: new Map([
          [userIds[1], "identity_not_verified"], [userIds[2], "payment_not_ready"],
        ]) });
      }
      assert.deepEqual(calls.writes, []);
    }
  });

  it("enabled accepts a verified adult with an onboarded payable recipient", async () => {
    configure();
    assert.equal(paymentsReadiness().operational, true);
    const { result, calls } = await read();
    assert.deepEqual(result, { ok: true, ineligible: new Map() });
    for (const table of ["payment_parties", "rent_buddy_payment_recipients", "identity_verifications", "trust_restrictions"]) {
      assert.ok(calls.tables.includes(table), table);
    }
    assert.equal(calls.tables.filter((table) => table === "rent_buddy_payment_recipients").length, 1);
  });

  it("disabled, absent or unreadable gate preserves legacy behavior without identity/payment/schema reads", async () => {
    configure();
    for (const enabled of [false, undefined, "error"] as const) {
      const state = world();
      if (enabled === undefined) delete state.flags[GATE]; else state.flags[GATE] = enabled;
      state.missingColumns.add("rent_buddy_profiles.country");
      for (const table of ["identity_verifications", "payment_parties", "rent_buddy_payment_recipients", "trust_restrictions"]) {
        state.errorTables[table] = { code: "42P01", message: "missing relation" };
      }
      const { result, calls } = await read(state);
      assert.deepEqual(result, { ok: true, ineligible: new Map() });
      assert.ok(!calls.tables.includes("payment_parties"));
      assert.ok(!calls.tables.includes("identity_verifications"));
      assert.ok(!calls.selects.some(({ cols }) => cols.includes("country")));
    }
  });

  it("refuses provider mismatch, incomplete onboarding, missing parties and disabled payouts", async () => {
    configure();
    const mutations: Array<(state: KitState) => void> = [
      (state) => { state.rows.payment_parties = []; },
      (state) => { state.rows.rent_buddy_payment_recipients = []; },
      ...[
        { provider: "stripe" }, { onboarding: "pending" }, { onboarding: "rejected" },
        { charges_enabled: false }, { payouts_enabled: false }, { recipient_ref: "" },
        { country: "ZZ" }, { country: "JP" }, { settlement_currency: "ZZZ" },
      ].map((patch) => (state: KitState) => { Object.assign(state.rows.rent_buddy_payment_recipients![0], patch); }),
      (state) => { state.rows.rent_buddy_profiles![0].country = null; },
      (state) => { state.rows.rent_buddy_profiles![0].country = "ZZ"; },
    ];
    for (const mutate of mutations) {
      const state = world(); mutate(state);
      const { result } = await read(state);
      assert.ok(result.ok && result.ineligible.has(BUDDY), JSON.stringify(state.rows));
    }
  });

  it("requires current real adult identity and clear hosting standing, not a Buddy badge", async () => {
    configure();
    for (const patch of [
      { status: "failed" }, { provider_mode: "test" }, { provider_mode: null },
      { is_over_18: false }, { is_over_18: null },
    ]) {
      const state = world(); Object.assign(state.rows.identity_verifications![0], patch);
      const { result } = await read(state);
      assert.ok(result.ok && result.ineligible.get(BUDDY) === "identity_not_verified");
    }
    for (const mutate of [
      (state: KitState) => { state.rows.identity_verifications = []; },
      (state: KitState) => { state.rows.profiles![1].verification_level = "buddy_verified"; },
      (state: KitState) => { state.rows.trust_restrictions = [{ user_id: BUDDY, restriction_type: "hosting", lifted_at: null, expires_at: null }]; },
    ]) {
      const state = world(); mutate(state);
      const { result } = await read(state);
      assert.ok(result.ok && result.ineligible.has(BUDDY));
    }
    for (const restriction of [
      { restriction_type: "hosting", lifted_at: null, expires_at: "2000-01-01T00:00:00Z" },
      { restriction_type: "hosting", lifted_at: "2026-01-01T00:00:00Z", expires_at: null },
      { restriction_type: "messaging", lifted_at: null, expires_at: null },
    ]) {
      const state = world(); state.rows.trust_restrictions = [{ user_id: BUDDY, ...restriction }];
      assert.deepEqual((await read(state)).result, { ok: true, ineligible: new Map() });
    }
  });

  it("requires direct-charge support even for an enabled provider market", async () => {
    configure();
    process.env.PAYMENTS_ENABLED_MARKETS = "US,JP";
    assert.equal(paymentsReadiness().operational, true);
    const state = world();
    Object.assign(state.rows.rent_buddy_payment_recipients![0], { country: "JP", settlement_currency: "JPY" });
    const { result } = await read(state);
    assert.ok(result.ok && result.ineligible.get(BUDDY) === "payment_not_ready");
    configure();
  });

  it("missing schema and rejected reads are unavailable, including the domain's fail-open restriction fallback", async () => {
    configure();
    for (const table of ["payment_parties", "rent_buddy_payment_recipients", "identity_verifications", "trust_restrictions"]) {
      for (const mode of ["missing", "reject"]) {
        const state = world();
        if (mode === "missing") state.errorTables[table] = { code: "42P01", message: "missing relation" };
        else state.throwTables.add(table);
        const { result } = await read(state);
        assert.ok(!result.ok, `${table} ${mode}`);
        assert.equal(result.relation, table);
      }
    }
    for (const column of ["rent_buddy_profiles.country", "profiles.verification_level", "identity_verifications.provider_mode", "rent_buddy_payment_recipients.payouts_enabled"]) {
      const state = world(); state.missingColumns.add(column);
      assert.equal((await read(state)).result.ok, false, column);
    }
  });

  it("domain readiness refuses disabled, uncertified Stripe test-mode, tax-unready and identity-unready configurations", async () => {
    for (const patch of [
      { PAYMENT_PROVIDER: "none" },
      { PAYMENT_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_test_discovery_no_network" },
      { PAYMENT_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_live_discovery_refused" },
      { TAX_PROVIDER: "none" }, { PAYMENTS_ENABLED_MARKETS: "" }, { PAYMENTS_ENABLED_MARKETS: "ZZ" },
      { IDENTITY_PROVIDER: "sumsub" },
    ]) {
      configure(); Object.assign(process.env, patch);
      const { result } = await read();
      assert.ok(result.ok && result.ineligible.has(BUDDY), JSON.stringify(patch));
    }
    configure();
  });

  it("search, all and suggest use the same gate, preserve travelers and report unreadable sources", async () => {
    configure();
    const { state, calls } = install();
    const search = () => kitGet(base, "/discovery/search?q=zork&type=buddies&limit=50");
    assert.ok((await search()).body.results.some((entry: any) => entry.id === BUDDY));
    state.rows.rent_buddy_payment_recipients![0].payouts_enabled = false;
    assert.deepEqual((await search()).body.results, []);
    const all = await kitGet(base, "/discovery/search?q=zork&type=all&limit=50");
    assert.ok(all.body.results.some((entry: any) => entry.id === BUDDY && entry.type === "travelers"));
    assert.ok(!all.body.results.some((entry: any) => entry.type === "buddies"));
    const suggest = await kitGet(base, "/discovery/suggest?q=zork");
    assert.ok(!suggest.body.groups.some((group: any) => group.type === "buddies" && group.items.length));
    state.rows.rent_buddy_payment_recipients![0].payouts_enabled = true;
    assert.ok((await search()).body.results.some((entry: any) => entry.id === BUDDY));
    state.errorTables.rent_buddy_payment_recipients = { code: "42P01", message: "missing relation" };
    assert.equal((await search()).body.refusal?.coverage, "nothing");
    assert.ok((await kitGet(base, "/discovery/search?q=zork&type=all")).body.refusal?.failedSources.includes("buddies"));
    assert.ok((await kitGet(base, "/discovery/suggest?q=zork")).body.refusal?.failedSources.includes("buddies"));
    assert.ok(!calls.writes.some(({ table }) => /payment|identity|trust_restrictions/.test(table)));
    state.flags[GATE] = false;
    invalidateBuddyLaunchGateCache();
    assert.ok((await search()).body.results.some((entry: any) => entry.id === BUDDY));
    state.flags[GATE] = true;
    state.flags.rent_buddy_enabled = false;
    invalidateBuddyLaunchGateCache();
    assert.deepEqual((await search()).body.results, []);
  });

  it("Discovery uses read-only domain seams and never payment operations", () => {
    const source = readFileSync(new URL("../lib/discoveryPeopleBuddy.ts", import.meta.url), "utf8");
    assert.ok(source.includes("readBuddyPaymentReadiness("));
    assert.ok(source.includes("paymentsReadiness()"));
    const bookingStore = readFileSync(new URL("../services/payments/bookingPayments/supabaseStore.ts", import.meta.url), "utf8");
    assert.ok(bookingStore.includes('currency: "USD"'), "Discovery's supported charge currency must follow booking pricing");
    assert.ok(!/\.(?:insert|update|upsert|delete|rpc|validateRecipient|createRecipient|createPaymentIntent|requestPayout|ensureUserParty)\(/.test(source));
    assert.equal(hostedCalls, 0);
  });
});
