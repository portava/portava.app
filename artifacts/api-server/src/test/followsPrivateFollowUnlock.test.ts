/**
 * Tests for PRIV-2 — GET /users/:userId must not unlock a private profile on a
 * raw follow edge.
 *
 * buildPassportResponse (routes/follows.ts) redacted a private profile only when
 * the viewer was NOT following. But a private profile is approval-required: a
 * raw user_follows edge is inserted by POST /follow with no owner consent, so a
 * user who followed an account while it was public, then the account went
 * private, could still read its rich passport (bio, current city, home country,
 * interests, counts). The canonical resolveProfileVisibility grants private
 * access on an accepted friendship only. The fix gates the unlock on friendship.
 *
 * Injects a fake service client (../lib/supabase _setTestServiceClient, the
 * client these routes read) with a private target the viewer FOLLOWS but is NOT
 * friends with, and asserts the rich fields are redacted; the positive control
 * (an accepted friendship) still returns them. Mutation-proven.
 *
 * Run: node --import tsx/esm --test src/test/followsPrivateFollowUnlock.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http, { createServer } from "node:http";
import express from "express";
import followsRouter from "../routes/follows.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _setTestClient } from "../lib/http.js";

const VIEWER = "11111111-1111-1111-1111-111111111111";
const TARGET = "22222222-2222-2222-2222-222222222222";

interface State { profiles: any[]; user_follows: any[]; user_friendships: any[]; blocks: any[]; profile_privacy_settings: any[]; }

function makeClient(state: State) {
  function from(table: string) {
    const eqs: Array<[string, any]> = [];
    const ins: Array<[string, any[]]> = [];
    let head = false;
    const b: any = {
      select(_c?: string, opts?: any) { if (opts?.head) head = true; return b; },
      eq(c: string, v: any) { eqs.push([c, v]); return b; },
      in(c: string, v: any[]) { ins.push([c, v]); return b; },
      order() { return b; },
      limit() { return b; },
      maybeSingle() { return resolve(true); },
      single() { return resolve(true); },
      then(f: any, r: any) { return resolve(false).then(f, r); },
    };
    function match(): any[] {
      let rows: any[] = (state as any)[table] ?? [];
      for (const [c, v] of eqs) rows = rows.filter((r) => r[c] === v);
      for (const [c, v] of ins) rows = rows.filter((r) => v.includes(r[c]));
      return rows;
    }
    async function resolve(single: boolean): Promise<any> {
      const rows = match();
      if (head) return { data: null, error: null, count: rows.length };
      if (single) return { data: rows[0] ?? null, error: null, count: null };
      return { data: rows, error: null, count: rows.length };
    }
    return b;
  }
  return {
    from,
    auth: { getUser: async (_t: string) => ({ data: { user: { id: VIEWER } }, error: null }) },
  };
}

function baseState(): State {
  return {
    profiles: [{
      id: TARGET, handle: "ghost", name: "Ghost", avatar_url: "a.jpg",
      bio: "Secret traveler", home_city: "Osaka", home_country: "Japan",
      current_city: "Kyoto", interests: ["ramen"], is_private: true,
      passport_visibility: "private", account_status: "active",
      created_at: "2026-01-01T00:00:00.000Z",
    }],
    // The viewer FOLLOWS the target (a raw, unapproved edge)...
    user_follows: [{ follower_id: VIEWER, following_id: TARGET }],
    // ...but is NOT an accepted friend.
    user_friendships: [],
    blocks: [],
    profile_privacy_settings: [],
  };
}

function startApp(state: State) {
  const app = express();
  app.use(express.json());
  app.use("/api", followsRouter);
  const server = createServer(app);
  _setTestServiceClient(makeClient(state) as any);
  _setTestClient(makeClient(state) as any, true);
  return new Promise<{ baseUrl: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as import("net").AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

async function getUser(baseUrl: string) {
  const res = await fetch(`${baseUrl}/api/users/${TARGET}`, { headers: { authorization: `Bearer tok-viewer` } });
  return { status: res.status, body: (await res.json()) as any };
}

describe("PRIV-2 — a raw follow must not unlock a private profile", () => {
  afterEach(() => { _setTestServiceClient(null); _setTestClient(null, false); });

  it("redacts the rich passport for a follower who is not an accepted friend", async () => {
    const app = await startApp(baseState());
    try {
      const { status, body } = await getUser(app.baseUrl);
      assert.equal(status, 200);
      assert.equal(body.isPrivate, true, "target is private");
      assert.equal(body.isFollowing, true, "viewer is indeed following (field stays accurate)");
      // The rich fields must NOT be present in the locked preview.
      assert.equal(body.bio, undefined, "bio must be redacted for a non-friend follower");
      assert.equal(body.currentCity, undefined, "currentCity must be redacted");
      assert.equal(body.homeCountry, undefined, "homeCountry must be redacted");
      assert.equal(body.avatarUrl, null, "avatar must be null in the locked preview");
      assert.equal(body.followersCount, null, "counts must be withheld in the locked preview");
    } finally { await app.close(); }
  });

  it("still returns the rich passport for an accepted friend (positive control)", async () => {
    const state = baseState();
    // Accepted friendship keyed by the sorted pair.
    const ua = VIEWER < TARGET ? VIEWER : TARGET;
    const ub = VIEWER < TARGET ? TARGET : VIEWER;
    state.user_friendships = [{ user_a: ua, user_b: ub }];
    const app = await startApp(state);
    try {
      const { status, body } = await getUser(app.baseUrl);
      assert.equal(status, 200);
      assert.equal(body.isPrivate, true);
      assert.equal(body.bio, "Secret traveler", "an accepted friend sees the rich passport");
    } finally { await app.close(); }
  });
});
