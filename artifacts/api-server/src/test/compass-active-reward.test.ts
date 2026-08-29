/**
 * Compass — GET /api/compass/me/active-reward badge derivation tests
 *
 * Badges are derived from eligible, non-expired rows in
 * compass_active_user_badges (written by CompassActiveUserRewardEngine),
 * not from a badge_eligibility column (which never existed live).
 *
 * Runtime: node:test (no vitest, no real DB)
 * Run: node --import tsx/esm --test src/test/compass-active-reward.test.ts
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import compassRouter from "../routes/compass.js";
import { computeActiveUserScore } from "../compass/CompassActiveUserRewardEngine.js";

const ALICE_ID = "00000000-0000-0000-0000-0000000000a1";

interface FakeState {
  users: Record<string, { id: string } | null>;
  compass_active_user_scores: any[];
  compass_active_user_badges: any[];
  badgeReadError?: { message: string } | null;
}

function makeFakeClient(state: FakeState) {
  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    const b: any = {
      select() { return b; },
      eq(col: string, val: any) { filters.push((r: any) => r[col] === val); return b; },
      maybeSingle() { return resolveOne(); },
      single() { return resolveOne(); },
      then(onF: any, onR: any) { return resolveList().then(onF, onR); },
    };
    const src = (): any[] => (state as any)[table] ?? [];
    const rows = () => src().filter((r: any) => filters.every((f) => f(r)));
    const resolveOne = async () => ({ data: rows()[0] ?? null, error: null });
    const resolveList = async () => {
      if (table === "compass_active_user_badges" && state.badgeReadError) {
        return { data: null, error: state.badgeReadError };
      }
      return { data: rows(), error: null };
    };
    return b;
  }
  return {
    from,
    auth: {
      getUser: async (token: string) => {
        const u = state.users[token];
        if (!u) return { data: { user: null }, error: { message: "invalid" } };
        return { data: { user: u }, error: null };
      },
    },
  };
}

function makeState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    users: { "alice-tok": { id: ALICE_ID } },
    compass_active_user_scores: [],
    compass_active_user_badges: [],
    ...overrides,
  };
}

/**
 * Richer fake for exercising CompassActiveUserRewardEngine.computeActiveUserScore:
 * supports the engine's read chains and the badge upsert/update(not-in) writes.
 * Tables other than events/badges resolve empty (profiles, trust_caps, scores…).
 */
function makeEngineFakeClient(state: { events: any[]; badges: any[] }) {
  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let updatePatch: any = null;
    const src = (): any[] =>
      table === "compass_active_user_events" ? state.events :
      table === "compass_active_user_badges" ? state.badges : [];
    const rows = () => src().filter((r) => filters.every((f) => f(r)));
    const b: any = {
      select() { return b; },
      eq(col: string, val: any) { filters.push((r) => r[col] === val); return b; },
      gt(col: string, val: any) { filters.push((r) => r[col] > val); return b; },
      is() { return b; },
      or() { return b; },
      limit() { return b; },
      order() { return b; },
      not(col: string, _op: string, val: string) {
        const set = new Set(
          String(val).slice(1, -1).split(",").filter(Boolean)
            .map((s) => s.replace(/^"|"$/g, "")),
        );
        filters.push((r) => !set.has(r[col]));
        return b;
      },
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      insert: () => ({ then: (f: any, r: any) => Promise.resolve({ error: null }).then(f, r) }),
      upsert(row: any) {
        if (table === "compass_active_user_badges") {
          const existing = state.badges.find(
            (r) => r.user_id === row.user_id && r.badge_type === row.badge_type,
          );
          if (existing) Object.assign(existing, row);
          else state.badges.push({ expires_at: null, ...row });
        }
        return { then: (f: any, r: any) => Promise.resolve({ error: null }).then(f, r) };
      },
      update(patch: any) { updatePatch = patch; return b; },
      then(onF: any, onR: any) {
        if (updatePatch !== null && table === "compass_active_user_badges") {
          for (const r of state.badges) {
            if (filters.every((f) => f(r))) Object.assign(r, updatePatch);
          }
          return Promise.resolve({ data: null, error: null }).then(onF, onR);
        }
        return Promise.resolve({ data: rows(), error: null }).then(onF, onR);
      },
    };
    return b;
  }
  return { from };
}

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

async function startApp(state: FakeState): Promise<number> {
  _setTestClient(makeFakeClient(state) as any, true);
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.log = { info: () => {}, error: () => {}, warn: () => {} };
    next();
  });
  app.use("/api", compassRouter);
  return new Promise((resolve) => {
    const server = createServer(app);
    servers.push(server);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as any).port));
  });
}

async function getReward(port: number) {
  const res = await fetch(`http://127.0.0.1:${port}/api/compass/me/active-reward`, {
    headers: { Authorization: "Bearer alice-tok" },
  });
  return { status: res.status, body: await res.json() };
}

describe("GET /api/compass/me/active-reward — badge derivation", () => {
  it("returns eligible, non-expired badges from compass_active_user_badges", async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const port = await startApp(makeState({
      compass_active_user_scores: [
        { user_id: ALICE_ID, tier: "local_guide", boost_visibility_enabled: true },
      ],
      compass_active_user_badges: [
        { user_id: ALICE_ID, badge_type: "trusted_guide", eligible: true, expires_at: future },
        { user_id: ALICE_ID, badge_type: "safety_champion", eligible: true, expires_at: null },
      ],
    }));
    const { status, body } = await getReward(port);
    assert.equal(status, 200);
    assert.deepEqual([...body.badges].sort(), ["safety_champion", "trusted_guide"]);
    assert.equal(body.tier, "local_guide");
    assert.equal(body.tierLabel, "Local Guide");
    // visibilityMessage should reflect the highest-priority badge
    assert.match(body.visibilityMessage, /safety-first/);
  });

  it("excludes ineligible, expired, and other users' badge rows", async () => {
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const port = await startApp(makeState({
      compass_active_user_scores: [
        { user_id: ALICE_ID, tier: "city_connector", boost_visibility_enabled: true },
      ],
      compass_active_user_badges: [
        { user_id: ALICE_ID, badge_type: "trusted_guide", eligible: false, expires_at: null },
        { user_id: ALICE_ID, badge_type: "consistent_explorer", eligible: true, expires_at: past },
        { user_id: "someone-else", badge_type: "social_connector", eligible: true, expires_at: null },
      ],
    }));
    const { status, body } = await getReward(port);
    assert.equal(status, 200);
    assert.deepEqual(body.badges, []);
    // Falls back to tier-based message
    assert.match(body.visibilityMessage, /reaching more travelers/);
  });

  it("dedupes duplicate badge_type rows", async () => {
    const port = await startApp(makeState({
      compass_active_user_scores: [
        { user_id: ALICE_ID, tier: "local_guide", boost_visibility_enabled: true },
      ],
      compass_active_user_badges: [
        { user_id: ALICE_ID, badge_type: "trusted_guide", eligible: true, expires_at: null },
        { user_id: ALICE_ID, badge_type: "trusted_guide", eligible: true, expires_at: null },
      ],
    }));
    const { body } = await getReward(port);
    assert.deepEqual(body.badges, ["trusted_guide"]);
  });

  it("returns empty badges and default tier when no rows exist at all", async () => {
    const port = await startApp(makeState());
    const { status, body } = await getReward(port);
    assert.equal(status, 200);
    assert.equal(body.tier, "active_traveler");
    assert.deepEqual(body.badges, []);
    assert.equal(body.boostEnabled, true);
  });

  it("revokes a previously-awarded badge when the user no longer qualifies", async () => {
    const now = new Date().toISOString();
    const engineState = {
      events: Array.from({ length: 5 }, () => ({
        user_id: ALICE_ID, event_type: "review_posted", weight: 1, city: null, category: null, created_at: now,
      })),
      badges: [] as any[],
    };
    const db = makeEngineFakeClient(engineState) as any;

    // Earn the badge
    const r1 = await computeActiveUserScore(db, ALICE_ID);
    await new Promise((r) => setImmediate(r)); // flush fire-and-forget writes
    assert.ok(r1, "first compute returned null");
    assert.ok(r1.badgeEligibility.includes("trusted_guide"));
    assert.ok(
      engineState.badges.some((b) => b.badge_type === "trusted_guide" && b.eligible === true),
      "trusted_guide row not upserted eligible",
    );

    // Activity drops off — recompute without qualification
    engineState.events = [];
    const r2 = await computeActiveUserScore(db, ALICE_ID);
    await new Promise((r) => setImmediate(r));
    assert.ok(r2, "second compute returned null");
    assert.ok(!r2.badgeEligibility.includes("trusted_guide"));
    const row = engineState.badges.find((b) => b.badge_type === "trusted_guide");
    assert.ok(row, "badge row should still exist");
    assert.equal(row.eligible, false, "badge should be marked ineligible");

    // The endpoint no longer returns the revoked badge
    const port = await startApp(makeState({
      compass_active_user_scores: [
        { user_id: ALICE_ID, tier: "active_traveler", boost_visibility_enabled: true },
      ],
      compass_active_user_badges: engineState.badges.map((b) => ({ expires_at: null, ...b })),
    }));
    const { status, body } = await getReward(port);
    assert.equal(status, 200);
    assert.ok(!body.badges.includes("trusted_guide"));
  });

  it("keeps still-qualifying badges eligible while revoking only the lapsed ones", async () => {
    const now = new Date().toISOString();
    const reviewEvents = Array.from({ length: 5 }, () => ({
      user_id: ALICE_ID, event_type: "review_posted", weight: 1, city: null, category: null, created_at: now,
    }));
    const engineState = { events: reviewEvents, badges: [] as any[] };
    const db = makeEngineFakeClient(engineState) as any;

    await computeActiveUserScore(db, ALICE_ID);
    await new Promise((r) => setImmediate(r));
    assert.ok(engineState.badges.some((b) => b.badge_type === "trusted_guide" && b.eligible));
    assert.ok(engineState.badges.some((b) => b.badge_type === "safety_champion" && b.eligible));

    // Old events (91 days ago) — trusted_guide still holds (lifetime review count),
    // but consistent_explorer (24h score) lapses.
    const old = new Date(Date.now() - 91 * 86_400_000).toISOString();
    engineState.events = reviewEvents.map((e) => ({ ...e, created_at: old }));
    const r2 = await computeActiveUserScore(db, ALICE_ID);
    await new Promise((r) => setImmediate(r));
    assert.ok(r2);
    assert.ok(r2.badgeEligibility.includes("trusted_guide"));
    assert.ok(!r2.badgeEligibility.includes("consistent_explorer"));
    const trusted = engineState.badges.find((b) => b.badge_type === "trusted_guide");
    const explorer = engineState.badges.find((b) => b.badge_type === "consistent_explorer");
    assert.equal(trusted?.eligible, true, "still-qualifying badge must stay eligible");
    assert.equal(explorer?.eligible, false, "lapsed badge must be revoked");
  });

  it("returns db_error when the badge read fails — not a silently empty list", async () => {
    const port = await startApp(makeState({
      compass_active_user_scores: [
        { user_id: ALICE_ID, tier: "local_guide", boost_visibility_enabled: true },
      ],
      badgeReadError: { message: "boom" },
    }));
    const { status, body } = await getReward(port);
    assert.equal(status, 500);
    assert.equal(body.error, "db_error");
  });
});
