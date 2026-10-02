/**
 * census-discovery §63 (DV-76, hunk H2 of §62.7) — the permission engine speaks
 * the vocabulary `profiles.tag_permission` is written in.
 *
 * THE DEFECT. `resolveInteractionPermissions` switched on
 * `who_can_tag ?? profiles.tag_permission` over {everyone, friends, friends_only,
 * followers, no_one, approval_required} with `default: canTag = true`. The column
 * is the enum tag_permission_level {anyone, interacted, friends_only, nobody}
 * (baseline; 0044), and PATCH /me/tag-permission and PATCH /me/profile write
 * only those four. So `nobody` and `interacted` fell to the default and ALLOWED:
 * POST /api/tags tagged a user who chose "Nobody", approved (P12/P15's harness
 * pin, db/discoveryVerifyPhase03 P4).
 *
 * WHAT IS PINNED, over the engine itself (no route, so a crash cannot pass for a
 * refusal):
 *   T1  every enum value × every relationship, as a table: anyone allows all;
 *       interacted = a follow either way, or a friendship; friends_only = a
 *       friendship; nobody refuses all — the friend and the mutual follower too.
 *   T2  the scale is ordered: for every relationship, what a stricter setting
 *       admits a looser one admits (anyone ⊇ interacted ⊇ friends_only ⊇ nobody).
 *   T3  an unknown value REFUSES. `who_can_tag` is free text the target may write
 *       on their own row (authenticated holds ALL on user_privacy_settings, and
 *       the policy is own-row), so an unmapped label is a shape production can
 *       hold; before §63 it allowed.
 *   T4  `who_can_tag`, when set, is read before the profile's value, and its
 *       older labels keep their meaning; NULL falls through to the profile.
 *   T5  cross-viewer: B's `nobody` refuses EVERY viewer, and A's relationship to
 *       some third user C does not leak into A→B.
 *   T6  revocation: B changes the setting; the very next resolution sees it (the
 *       engine caches nothing).
 *   T7  retry: the same question twice gives the same answer.
 *   T8  a failed follow read under `interacted` refuses and says it is degraded.
 *   T9  allow_tagging=false and a suspended viewer still refuse `anyone`.
 *
 * Run: node --import tsx/esm --test src/test/tagPermissionVocabulary.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveInteractionPermissions } from "../services/interactionPermissions.js";

const A = "aaaaaaaa-0000-4000-8000-0000000000a1";   // the tagger in most cases
const B = "bbbbbbbb-0000-4000-8000-0000000000b2";   // the person being tagged
const C = "cccccccc-0000-4000-8000-0000000000c3";   // a third party

/** The enum, exactly as baseline/20260819_baseline_structure.sql declares tag_permission_level. */
const ENUM = ["anyone", "interacted", "friends_only", "nobody"] as const;
type Perm = (typeof ENUM)[number];

type Rows = Record<string, any[]>;
const DB_ERROR = { code: "XX000", message: "internal error: relation unavailable" };

/**
 * A minimal PostgREST double: filters are applied (eq / in / is / the
 * `and(a.eq.x,b.eq.y)` form of `or`), so a read that forgot its viewer
 * predicate would return a third party's rows here too. `errors[table]` RESOLVES
 * `{ data: null, error }`, the way supabase-js delivers a database failure.
 */
function makeClient(rows: Rows, errors: Record<string, typeof DB_ERROR> = {}) {
  const db: Rows = {
    profiles: [], blocks: [], trust_restrictions: [], moderation_actions: [],
    user_account_states: [], user_privacy_settings: [], profile_privacy_settings: [],
    user_friendships: [], friend_requests: [], user_follows: [],
    user_message_settings: [], user_interaction_cooldowns: [], user_mutes: [],
    user_restrictions: [], trip_members: [], circle_memberships: [], rent_buddy_bookings: [],
    ...rows,
  };
  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let limit: number | null = null;
    const err = errors[table] ?? null;
    const matched = () => {
      const m = (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
      return limit === null ? m : m.slice(0, limit);
    };
    const b: any = {
      select() { return b; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return b; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return b; },
      in(c: string, vs: any[]) { filters.push((r) => vs.includes(r[c])); return b; },
      is(c: string, v: any) { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return b; },
      gt() { return b; }, gte() { return b; }, lt() { return b; }, lte() { return b; }, order() { return b; },
      limit(n: number) { limit = n; return b; },
      or(expr: string) {
        const clauses = expr.match(/and\(([^)]*)\)/g) ?? [];
        const ms = clauses.map((cl) => {
          const terms = cl.slice(4, -1).split(",").map((t) => /^(\w+)\.eq\.(.+)$/.exec(t)!);
          return (r: any) => terms.every(([, col, val]) => String(r[col!]) === val);
        });
        if (ms.length > 0) filters.push((r) => ms.some((f) => f(r)));
        return b;
      },
      async maybeSingle() { return err ? { data: null, error: err } : { data: matched()[0] ?? null, error: null }; },
      async single() { return b.maybeSingle(); },
      then(onF: any, onR: any) {
        return Promise.resolve(err ? { data: null, error: err } : { data: matched(), error: null }).then(onF, onR);
      },
    };
    return b;
  }
  return { from } as any;
}

type Rel = "stranger" | "viewer_follows" | "target_follows" | "mutual_follow" | "friend";
const RELS: Rel[] = ["stranger", "viewer_follows", "target_follows", "mutual_follow", "friend"];

function relRows(viewer: string, target: string, rel: Rel): Rows {
  const f = (from: string, to: string) => ({ follower_id: from, following_id: to });
  const [ua, ub] = viewer < target ? [viewer, target] : [target, viewer];
  switch (rel) {
    case "stranger":       return {};
    case "viewer_follows": return { user_follows: [f(viewer, target)] };
    case "target_follows": return { user_follows: [f(target, viewer)] };
    case "mutual_follow":  return { user_follows: [f(viewer, target), f(target, viewer)] };
    // Accepting a friend request writes user_friendships ONLY (routes/friends.ts) — no follow rows.
    case "friend":         return { user_friendships: [{ user_a: ua, user_b: ub }] };
  }
}

function world(opts: { perm: Perm; rel: Rel; whoCanTag?: string | null; viewer?: string; extra?: Rows }): Rows {
  const viewer = opts.viewer ?? A;
  const base: Rows = {
    profiles: [
      { id: A, is_private: false, tag_permission: "anyone" },
      { id: B, is_private: false, tag_permission: opts.perm },
      { id: C, is_private: false, tag_permission: "anyone" },
    ],
    ...relRows(viewer, B, opts.rel),
  };
  if (opts.whoCanTag !== undefined) {
    base.user_privacy_settings = [{ user_id: B, age_restriction_enabled: false, profile_visibility: null, who_can_tag: opts.whoCanTag }];
  }
  for (const [t, rs] of Object.entries(opts.extra ?? {})) base[t] = [...(base[t] ?? []), ...rs];
  return base;
}

const tagVerdict = async (rows: Rows, viewer = A, errors: Record<string, typeof DB_ERROR> = {}) => {
  const p = await resolveInteractionPermissions(makeClient(rows, errors), viewer, B);
  return { canTag: p.canTag, canTagPending: p.canTagPending, degraded: p.degraded === true, relationshipLabel: p.relationshipLabel };
};

/** The table the product's four settings are meant to draw. */
const EXPECTED: Record<Perm, Record<Rel, boolean>> = {
  anyone:       { stranger: true,  viewer_follows: true,  target_follows: true,  mutual_follow: true,  friend: true  },
  interacted:   { stranger: false, viewer_follows: true,  target_follows: true,  mutual_follow: true,  friend: true  },
  friends_only: { stranger: false, viewer_follows: false, target_follows: false, mutual_follow: false, friend: true  },
  nobody:       { stranger: false, viewer_follows: false, target_follows: false, mutual_follow: false, friend: false },
};

let exercised = 0;

describe("T1 — every enum value × every relationship (census-discovery §63, DV-76)", () => {
  for (const perm of ENUM) {
    for (const rel of RELS) {
      it(`${perm} × ${rel} → ${EXPECTED[perm][rel] ? "may tag" : "REFUSED"}`, async () => {
        const v = await tagVerdict(world({ perm, rel }));
        exercised++;
        assert.equal(v.canTag, EXPECTED[perm][rel], `${perm} × ${rel}: ${JSON.stringify(v)}`);
        assert.equal(v.canTagPending, false, "no profile value is approval_required, so nothing is pending");
        assert.equal(v.degraded, false, "every read succeeded — the verdict is an observation, not a floor");
      });
    }
  }
  it("the relationship fixtures are the relationships they claim (the engine labels them)", async () => {
    const labels = await Promise.all(RELS.map(async (rel) => (await tagVerdict(world({ perm: "anyone", rel }))).relationshipLabel));
    assert.deepEqual(labels, ["stranger", "following", "follower", "mutual_follow", "friend"]);
  });
});

describe("T2 — the settings are an ordered scale", () => {
  it("for every relationship, a looser setting admits whatever a stricter one admits", async () => {
    for (const rel of RELS) {
      const got: boolean[] = [];
      for (const perm of ENUM) got.push((await tagVerdict(world({ perm, rel }))).canTag);
      for (let i = 1; i < got.length; i++) {
        assert.ok(!got[i] || got[i - 1], `${rel}: ${ENUM[i]} admits a tagger ${ENUM[i - 1]} refuses — ${JSON.stringify(got)}`);
      }
      exercised++;
    }
  });
});

describe("T3 — a value the switch does not know REFUSES (it used to allow)", () => {
  for (const label of ["mystery", "", "NOBODY", "Anyone", "public"]) {
    it(`who_can_tag = ${JSON.stringify(label)} → refused, for a stranger and for a friend`, async () => {
      for (const rel of ["stranger", "friend"] as Rel[]) {
        const v = await tagVerdict(world({ perm: "anyone", rel, whoCanTag: label }));
        assert.equal(v.canTag, false, `${JSON.stringify(label)} × ${rel} was allowed`);
        assert.equal(v.canTagPending, false);
      }
      exercised++;
    });
  }
});

describe("T4 — who_can_tag is read first; its older labels keep their meaning; NULL falls through", () => {
  const cases: Array<[string | null, Rel, boolean, boolean]> = [
    // label,               rel,              canTag, canTagPending
    ["everyone",            "stranger",       true,   false],
    ["no_one",              "friend",         false,  false],
    ["friends",             "friend",         true,   false],
    ["friends",             "mutual_follow",  false,  false],
    ["followers",           "viewer_follows", true,   false],
    ["followers",           "target_follows", false,  false],
    ["approval_required",   "stranger",       false,  true],
    ["nobody",              "friend",         false,  false],   // overrides the profile's 'anyone'
  ];
  for (const [label, rel, canTag, pending] of cases) {
    it(`who_can_tag=${label} × ${rel} → canTag ${canTag}, pending ${pending} (profile says 'anyone')`, async () => {
      const v = await tagVerdict(world({ perm: "anyone", rel, whoCanTag: label }));
      assert.deepEqual([v.canTag, v.canTagPending], [canTag, pending]);
      exercised++;
    });
  }
  it("who_can_tag NULL → the profile's own value decides ('nobody' refuses a friend)", async () => {
    const v = await tagVerdict(world({ perm: "nobody", rel: "friend", whoCanTag: null }));
    assert.deepEqual([v.canTag, v.canTagPending], [false, false]);
    exercised++;
  });
});

describe("T5 — cross-viewer: the setting is the TARGET's, and binds every viewer", () => {
  it("B chose nobody: A (a stranger), C (B's friend) and a mutual follower are all refused", async () => {
    const stranger = await tagVerdict(world({ perm: "nobody", rel: "stranger" }), A);
    const friend   = await tagVerdict(world({ perm: "nobody", rel: "friend", viewer: C }), C);
    const mutual   = await tagVerdict(world({ perm: "nobody", rel: "mutual_follow" }), A);
    assert.deepEqual([stranger.canTag, friend.canTag, mutual.canTag], [false, false, false]);
    exercised++;
  });
  it("interacted: C's follow of B admits C and does NOT admit A", async () => {
    const rows = world({ perm: "interacted", rel: "stranger", extra: { user_follows: [{ follower_id: C, following_id: B }] } });
    assert.equal((await tagVerdict(rows, C)).canTag, true, "C follows B");
    assert.equal((await tagVerdict(rows, A)).canTag, false, "someone else's follow is not A's interaction");
    exercised++;
  });
  it("interacted: A's follow of C and C's friendship with B do not make A→B an interaction", async () => {
    const [ua, ub] = C < B ? [C, B] : [B, C];
    const rows = world({ perm: "interacted", rel: "stranger", extra: {
      user_follows: [{ follower_id: A, following_id: C }], user_friendships: [{ user_a: ua, user_b: ub }],
    } });
    assert.equal((await tagVerdict(rows, A)).canTag, false);
    exercised++;
  });
});

describe("T6 — revocation: B's own settings change is seen on the next attempt", () => {
  it("anyone → nobody refuses the next resolution; nobody → anyone admits again", async () => {
    const rows = world({ perm: "anyone", rel: "stranger" });
    const client = makeClient(rows);
    assert.equal((await resolveInteractionPermissions(client, A, B)).canTag, true, "before: B allows anyone");
    rows.profiles!.find((p) => p.id === B)!.tag_permission = "nobody";
    assert.equal((await resolveInteractionPermissions(client, A, B)).canTag, false, "after: the very next check refuses");
    rows.profiles!.find((p) => p.id === B)!.tag_permission = "anyone";
    assert.equal((await resolveInteractionPermissions(client, A, B)).canTag, true, "and a change back is seen too — nothing was latched");
    exercised++;
  });
  it("interacted: B unfollowing A revokes A (target_follows was A's only interaction)", async () => {
    const rows = world({ perm: "interacted", rel: "target_follows" });
    const client = makeClient(rows);
    assert.equal((await resolveInteractionPermissions(client, A, B)).canTag, true);
    rows.user_follows!.splice(0);   // in place: the client holds this array
    assert.equal((await resolveInteractionPermissions(client, A, B)).canTag, false);
    exercised++;
  });
});

describe("T7 — retry: the same question twice gives the same answer", () => {
  it("each enum value, stranger, twice over one client", async () => {
    for (const perm of ENUM) {
      const client = makeClient(world({ perm, rel: "stranger" }));
      const first = await resolveInteractionPermissions(client, A, B);
      const second = await resolveInteractionPermissions(client, A, B);
      assert.deepEqual([second.canTag, second.canTagPending], [first.canTag, first.canTagPending], perm);
    }
    exercised++;
  });
});

describe("T8 — a failed read is not an interaction", () => {
  it("interacted with user_follows unreadable: REFUSED and marked degraded; readable twin admits", async () => {
    const failed = await tagVerdict(world({ perm: "interacted", rel: "mutual_follow" }), A, { user_follows: DB_ERROR });
    assert.equal(failed.canTag, false, "an unreadable follow is not a follow");
    assert.equal(failed.degraded, true, "and the caller is told the verdict is a floor");
    const readable = await tagVerdict(world({ perm: "interacted", rel: "mutual_follow" }), A);
    assert.equal(readable.canTag, true, "PAIR: the same rows, readable, admit — so the refusal above is the failure's");
    exercised++;
  });
  it("nobody with user_follows unreadable: still refused (no read can widen it)", async () => {
    const v = await tagVerdict(world({ perm: "nobody", rel: "mutual_follow" }), A, { user_follows: DB_ERROR });
    assert.equal(v.canTag, false);
    exercised++;
  });
});

describe("T9 — the overrides still hold over `anyone`", () => {
  it("allow_tagging=false refuses anyone; a suspended viewer is refused", async () => {
    const optedOut = await tagVerdict(world({ perm: "anyone", rel: "friend", extra: {
      profile_privacy_settings: [{ user_id: B, allow_follow: true, allow_friend_requests: true, allow_tagging: false }],
    } }));
    assert.equal(optedOut.canTag, false);
    const suspended = await tagVerdict(world({ perm: "anyone", rel: "friend", extra: {
      user_account_states: [{ user_id: A, state: "suspended" }],
    } }));
    assert.equal(suspended.canTag, false);
    exercised++;
  });
});

describe("non-vacuity", () => {
  it("every block above ran its scenarios", () => {
    assert.ok(exercised >= ENUM.length * RELS.length + 18, `only ${exercised} scenarios ran`);
  });
});
