/**
 * census-discovery §81 (lane W10-S2) — DV-76: `approval_required` made reachable
 * (§62.7 Q3, register D-W10S2-8) and the settings copy's definitions built
 * behind their flag for the owner's consent decision (§63.7 Q5, D-W10S2-9,
 * APPROVAL REQUIRED).
 *
 * node:test + node:assert. The engine over the §63 PostgREST double (copied,
 * not imported: importing a test file runs its suites), and the real
 * `routes/tags.ts` router over a table-backed fake for the two routes.
 *
 * WHAT IS PINNED
 *   Q1  engine, default reading: byte-identical to §63's table (the flag-off
 *       path passes no option, and `{}` reads the same as no option).
 *   Q2  engine, `consent_copy`: interacted = the tagged user follows the tagger;
 *       friends_only = a mutual follow; a friendship alone, or the tagger
 *       following, admits nobody the copy does not name. The scale stays ordered.
 *   Q3  `approval_required` on the profile: never `canTag`, always `canTagPending`
 *       for a viewer who is not blocked — a tag lands pending.
 *   Q4  PATCH /me/tag-permission: flag OFF refuses 'approval_required' with the
 *       exact body it always did; flag ON stores it.
 *   Q5  POST /tags/:id/approve: flag OFF `feature_disabled`; ON the tagged user
 *       approves their own pending tag once; a stranger gets the same 404 as a
 *       missing tag; a removed tag is not revived; an approved one is idempotent.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/tagPermissionApprovalRequired.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { resolveInteractionPermissions } from "../services/interactionPermissions.js";
import { _setTestClient } from "../lib/http.js";
import tagsRouter, { TAG_PERMISSION_APPROVAL_REQUIRED_FLAG } from "../routes/tags.js";
import { makeLayoverDb } from "./helpers/fakeLayoverDb.js";

const A = "aaaaaaaa-0000-4000-8000-0000000000a1";   // the tagger in most cases
const B = "bbbbbbbb-0000-4000-8000-0000000000b2";   // the person being tagged
const C = "cccccccc-0000-4000-8000-0000000000c3";   // a third party

/** The enum, exactly as baseline/20260819_baseline_structure.sql declares tag_permission_level. */
const ENUM = ["anyone", "interacted", "friends_only", "nobody", "approval_required"] as const;
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


const verdict = async (rows: Rows, opts: Parameters<typeof resolveInteractionPermissions>[3] = undefined) => {
  const p = await resolveInteractionPermissions(makeClient(rows), A, B, opts);
  return { canTag: p.canTag, canTagPending: p.canTagPending };
};

/** §63's table, unchanged, for the engine's own reading. */
const ENGINE: Record<"anyone" | "interacted" | "friends_only" | "nobody", Record<Rel, boolean>> = {
  anyone:       { stranger: true,  viewer_follows: true,  target_follows: true,  mutual_follow: true,  friend: true  },
  interacted:   { stranger: false, viewer_follows: true,  target_follows: true,  mutual_follow: true,  friend: true  },
  friends_only: { stranger: false, viewer_follows: false, target_follows: false, mutual_follow: false, friend: true  },
  nobody:       { stranger: false, viewer_follows: false, target_follows: false, mutual_follow: false, friend: false },
};

/** The copy's words, on the arms the engine observes (the message and circle arms refuse). */
const COPY: typeof ENGINE = {
  anyone:       { stranger: true,  viewer_follows: true,  target_follows: true,  mutual_follow: true,  friend: true  },
  interacted:   { stranger: false, viewer_follows: false, target_follows: true,  mutual_follow: true,  friend: false },
  friends_only: { stranger: false, viewer_follows: false, target_follows: false, mutual_follow: true,  friend: false },
  nobody:       { stranger: false, viewer_follows: false, target_follows: false, mutual_follow: false, friend: false },
};

describe("Q1 — the engine's own reading is unchanged (the flag-off path)", () => {
  for (const perm of ["anyone", "interacted", "friends_only", "nobody"] as const) {
    for (const rel of RELS) {
      it(`${perm} × ${rel}: no option and {} both read §63's table`, async () => {
        const rows = world({ perm, rel });
        assert.equal((await verdict(rows)).canTag, ENGINE[perm][rel]);
        assert.equal((await verdict(rows, {})).canTag, ENGINE[perm][rel]);
      });
    }
  }
});

describe("Q2 — consent_copy: the settings copy's definitions", () => {
  for (const perm of ["anyone", "interacted", "friends_only", "nobody"] as const) {
    for (const rel of RELS) {
      it(`${perm} × ${rel}`, async () => {
        assert.equal((await verdict(world({ perm, rel }), { tagDefinitions: "consent_copy" })).canTag, COPY[perm][rel]);
      });
    }
  }
  it("the scale stays ordered: what a stricter setting admits, a looser one admits", () => {
    const order = ["nobody", "friends_only", "interacted", "anyone"] as const;
    for (const rel of RELS) {
      for (let i = 0; i + 1 < order.length; i++) {
        if (COPY[order[i]!][rel]) assert.ok(COPY[order[i + 1]!][rel], `${order[i]} admits ${rel} but ${order[i + 1]} does not`);
      }
    }
  });
});

describe("Q3 — approval_required on the profile: pending, never approved", () => {
  for (const rel of RELS) {
    it(rel, async () => {
      const v = await verdict(world({ perm: "approval_required", rel }));
      assert.equal(v.canTag, false);
      assert.equal(v.canTagPending, true);
    });
  }
});

// ── the two routes ───────────────────────────────────────────────────────────

let server: http.Server;
let base = "";
let tables: Record<string, Array<Record<string, unknown>>> = {};

function stage(flag: boolean, over: Record<string, Array<Record<string, unknown>>> = {}, failures: Record<string, { message: string }> = {}) {
  tables = {
    feature_flags: flag ? [{ flag: TAG_PERMISSION_APPROVAL_REQUIRED_FLAG, enabled: true }] : [],
    profiles: [{ id: B, tag_permission: "anyone" }, { id: A, tag_permission: "anyone" }],
    tags: [],
    ...over,
  };
  _setTestClient(makeLayoverDb(tables, { users: { [A]: A, [B]: B }, failures }), true);
}

function send(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; raw: string; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(`/api${path}`, base);
    const raw = body === undefined ? null : JSON.stringify(body);
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (raw !== null) { headers["content-type"] = "application/json"; headers["content-length"] = String(Buffer.byteLength(raw)); }
    const r = http.request({ hostname: url.hostname, port: Number(url.port), path: url.pathname, method, headers }, (res) => {
      let acc = ""; res.setEncoding("utf8");
      res.on("data", (c) => { acc += c; });
      res.on("end", () => { let parsed: any; try { parsed = acc ? JSON.parse(acc) : null; } catch { parsed = acc; } resolve({ status: res.statusCode ?? 0, raw: acc, body: parsed }); });
    });
    r.on("error", reject);
    if (raw !== null) r.write(raw);
    r.end();
  });
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((r, _res, next) => { Object.assign(r, { log: { error() {}, info() {}, warn() {}, debug() {} } }); next(); });
  app.use("/api", tagsRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${addr !== null && typeof addr === "object" ? addr.port : 0}`;
});
after(() => { server?.close(); _setTestClient(null, false); });

describe("Q4 — PATCH /me/tag-permission", () => {
  it("flag OFF: 'approval_required' is refused with exactly the body a table with no flag row gives", async () => {
    stage(false);
    const off = await send(B, "PATCH", "/me/tag-permission", { tagPermission: "approval_required" });
    const absent = await (async () => { stage(false, { feature_flags: [] }); return send(B, "PATCH", "/me/tag-permission", { tagPermission: "approval_required" }); })();
    assert.equal(off.status, 400);
    assert.equal(off.raw, absent.raw);
    assert.match(off.raw, /Expected 'anyone' \| 'interacted' \| 'friends_only' \| 'nobody', received/, "the four-value schema, exactly as before");
    assert.equal(tables.profiles!.find((p) => p.id === B)!.tag_permission, "anyone");
  });

  it("flag OFF: the four existing values still store", async () => {
    stage(false);
    const r = await send(B, "PATCH", "/me/tag-permission", { tagPermission: "nobody" });
    assert.equal(r.status, 200, r.raw);
  });

  it("flag ON: 'approval_required' stores", async () => {
    stage(true);
    const r = await send(B, "PATCH", "/me/tag-permission", { tagPermission: "approval_required" });
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.tagPermission, "approval_required");
  });
});

describe("Q5 — POST /tags/:id/approve", () => {
  const TAG = "dddddddd-0000-4000-8000-0000000000d4";
  const pending = () => ({ id: TAG, source_type: "post", source_id: C, tagger_id: A, tagged_user_id: B, status: "pending", suppressed: false });

  it("flag OFF: feature_disabled, and the tag stays pending", async () => {
    stage(false, { tags: [pending()] });
    const r = await send(B, "POST", `/tags/${TAG}/approve`);
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "feature_disabled");
    assert.equal(tables.tags![0]!.status, "pending");
  });

  it("flag ON: the tagged user approves once; a second approval is idempotent", async () => {
    stage(true, { tags: [pending()] });
    const r = await send(B, "POST", `/tags/${TAG}/approve`);
    assert.equal(r.status, 200, r.raw);
    assert.equal(tables.tags![0]!.status, "approved");
    const again = await send(B, "POST", `/tags/${TAG}/approve`);
    assert.equal(again.status, 200);
    assert.equal(again.body.alreadyApproved, true);
  });

  it("the TAGGER cannot approve on the tagged user's behalf — the same 404 as a missing tag", async () => {
    stage(true, { tags: [pending()] });
    const r = await send(A, "POST", `/tags/${TAG}/approve`);
    const missing = await send(A, "POST", `/tags/eeeeeeee-0000-4000-8000-0000000000e5/approve`);
    assert.equal(r.status, 404);
    assert.equal(r.raw, missing.raw);
    assert.equal(tables.tags![0]!.status, "pending");
  });

  it("a removed (suppressed) tag is not revived", async () => {
    stage(true, { tags: [{ ...pending(), suppressed: true }] });
    const r = await send(B, "POST", `/tags/${TAG}/approve`);
    assert.equal(r.status, 409);
    assert.equal(tables.tags![0]!.status, "pending");
  });

  it("an unreadable tags table refuses and changes nothing", async () => {
    stage(true, { tags: [pending()] }, { "tags:select": { message: "down" } });
    const r = await send(B, "POST", `/tags/${TAG}/approve`);
    assert.ok(r.status >= 500, r.raw);
    assert.equal(tables.tags![0]!.status, "pending");
  });
});
