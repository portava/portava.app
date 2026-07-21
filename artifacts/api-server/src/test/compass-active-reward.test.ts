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
    server.listen(0, () => resolve((server.address() as any).port));
  });
}

async function getReward(port: number) {
  const res = await fetch(`http://localhost:${port}/api/compass/me/active-reward`, {
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
