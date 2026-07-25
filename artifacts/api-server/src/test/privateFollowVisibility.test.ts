/**
 * SEC-01 regression — a raw (unapproved) follow must NOT unlock a PRIVATE
 * profile's content. Only an accepted friendship does. The softer
 * "followers_only" tier still lets a follow grant access.
 *
 * Unit-tests resolveProfileVisibility directly with a minimal fake Supabase
 * client (no HTTP / no live DB).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveProfileVisibility } from "../lib/profileVisibility.ts";

const VIEWER = "11111111-1111-4111-8111-111111111111";
const TARGET = "22222222-2222-4222-8222-222222222222";

interface FakeState {
  privacy?: Record<string, any>;      // user_id -> profile_privacy_settings row
  accountState?: Record<string, string>; // user_id -> state
  blocks?: any[];
  friendships?: Array<{ user_a: string; user_b: string }>;
  follows?: Array<{ follower_id: string; following_id: string }>;
}

function makeSc(state: FakeState) {
  const resolveSingle = (table: string, eqs: Record<string, string>, inq: any) => {
    switch (table) {
      case "profile_privacy_settings":
        return { data: state.privacy?.[eqs.user_id] ?? null, error: null };
      case "user_account_states": {
        const st = state.accountState?.[eqs.user_id];
        return { data: st && inq?.vals?.includes(st) ? { state: st } : null, error: null };
      }
      case "user_friendships": {
        const found = (state.friendships ?? []).some((f) => f.user_a === eqs.user_a && f.user_b === eqs.user_b);
        return { data: found ? { user_a: eqs.user_a } : null, error: null };
      }
      case "user_follows": {
        const found = (state.follows ?? []).some((f) => f.follower_id === eqs.follower_id && f.following_id === eqs.following_id);
        return { data: found ? { follower_id: eqs.follower_id } : null, error: null };
      }
      default:
        return { data: null, error: null };
    }
  };
  const resolveMany = (table: string) =>
    table === "blocks" ? { data: state.blocks ?? [], error: null } : { data: [], error: null };

  return {
    from(table: string) {
      const eqs: Record<string, string> = {};
      let inq: any = null;
      const chain: any = {
        select() { return chain; },
        eq(c: string, v: string) { eqs[c] = v; return chain; },
        in(_c: string, vals: string[]) { inq = { vals }; return chain; },
        or() { return chain; },
        maybeSingle() { return Promise.resolve(resolveSingle(table, eqs, inq)); },
        then(onF: any, onR: any) { return Promise.resolve(resolveMany(table)).then(onF, onR); },
      };
      return chain;
    },
  };
}

test("SEC-01: private profile — a mere FOLLOWER gets limited_preview (no access)", async () => {
  const sc = makeSc({ follows: [{ follower_id: VIEWER, following_id: TARGET }], friendships: [] });
  const r = await resolveProfileVisibility(sc, VIEWER, TARGET, { is_private: true });
  assert.equal(r.visibility, "limited_preview", "an unapproved follow must NOT unlock a private profile");
});

test("SEC-01: private profile — an accepted FRIEND gets followers_only", async () => {
  const [ua, ub] = VIEWER < TARGET ? [VIEWER, TARGET] : [TARGET, VIEWER];
  const sc = makeSc({ friendships: [{ user_a: ua, user_b: ub }], follows: [] });
  const r = await resolveProfileVisibility(sc, VIEWER, TARGET, { is_private: true });
  assert.equal(r.visibility, "followers_only", "an approved friendship unlocks a private profile");
});

test("followers_only tier — a FOLLOWER still gets followers_only (tier preserved)", async () => {
  const sc = makeSc({
    privacy: { [TARGET]: { profile_visibility: "followers_only" } },
    follows: [{ follower_id: VIEWER, following_id: TARGET }],
    friendships: [],
  });
  const r = await resolveProfileVisibility(sc, VIEWER, TARGET, { is_private: false });
  assert.equal(r.visibility, "followers_only", "the softer followers_only tier still lets a follow grant access");
});

test("public profile — full", async () => {
  const sc = makeSc({});
  const r = await resolveProfileVisibility(sc, VIEWER, TARGET, { is_private: false });
  assert.equal(r.visibility, "full");
});

test("private profile — unauthenticated viewer gets limited_preview", async () => {
  const sc = makeSc({});
  const r = await resolveProfileVisibility(sc, null, TARGET, { is_private: true });
  assert.equal(r.visibility, "limited_preview");
});
