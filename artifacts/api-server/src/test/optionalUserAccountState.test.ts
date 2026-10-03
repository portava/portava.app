/**
 * optionalUser applies the SAME account-state gate requireUser applies.
 *
 * THE DEFECT
 * ----------
 * requireUser (lib/http.ts) reads `profiles.account_status` on every request
 * through `readAccountStatus`, refuses `banned` / `suspended` with 403, and
 * answers 503 `degraded_unavailable` when the status cannot be read at all.
 * optionalUser — the optional-auth path behind seven public routes — verified
 * the bearer token and returned `{ client, user }` WITHOUT reading the account
 * state. A banned or suspended account's still-valid token (there is no session
 * revocation anywhere in this system) was therefore SIGNED IN on every
 * optional-auth route: on GET /trips/:tripId it got the owner's / member's full
 * authorized view of a PRIVATE trip; on the place-living pages it got the owner
 * bypass for its own non-public content; on reviews and votes it got viewer
 * personalisation.
 *
 * THE POSTURE, per state of the read
 * ----------------------------------
 *   banned / suspended → REFUSED: THROW AccountRestrictedError (403 `forbidden`,
 *       reason account_banned / account_suspended, via the global handler).
 *       PR #580 first mapped these to anonymous; the owner's ruling of
 *       2026-10-03 reverses that — an optional-auth route must not silently
 *       treat an identified, restricted caller as a visitor (that is the
 *       restriction not applying). A ban is a `user_account_states` row,
 *       embedded on the gate's profiles read; `profiles.account_status` cannot
 *       hold 'banned' or 'suspended' (its CHECK), so the fixtures use the row.
 *   deleted → ANONYMOUS (null), unchanged: a tombstone, not a restriction.
 *   unreadable → THROW AccountStatusUnavailableError (503 degraded_unavailable,
 *       retryable, via the global handler). NOT anonymous: an ordinary signed-in
 *       user whose state merely could not be read would silently lose their
 *       block filter (rent-a-buddy list, trip detail, place reviews) and see
 *       their own vote reported as "none" — a failed read presented as an
 *       answer. And never signed-in: that treats an unread ban as "not banned".
 *   active / deactivated / pending_deletion / no row → SIGNED IN, exactly as
 *       requireUser admits them (parity; a control below pins each).
 *
 * Synthetic: every test runs against an in-memory supabase-js shaped fake that
 * RESOLVES `{ data: null, error }` on failure, as the real client does.
 *
 * Runtime: node:test + node:assert/strict. Registered in package.json `test`.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import type { Request } from "express";
import { _setTestClient, _clearTestClient, optionalUser } from "../lib/http.js";
import { globalErrorHandler } from "../lib/errorEnvelope.js";
import tripsExpansionRouter from "../routes/trips-expansion.js";
import reviewsRouter from "../routes/reviews.js";

interface TableBehaviour {
  rows?: Array<Record<string, any>>;
  error?: { message?: string; code?: string };
}

function makeClient(opts: {
  user?: { id: string } | null;
  tables?: Record<string, TableBehaviour>;
  reads?: string[];
}): any {
  const tables = opts.tables ?? {};
  return {
    auth: {
      async getUser(token: string) {
        if (token === "bad") return { data: { user: null }, error: { message: "invalid JWT" } };
        return { data: { user: opts.user ?? null }, error: null };
      },
    },
    from(table: string) {
      opts.reads?.push(table);
      const behaviour = tables[table] ?? { rows: [] };
      const filters: Array<(r: any) => boolean> = [];
      const result = () => behaviour.error
        ? { data: null, error: behaviour.error }
        : { data: (behaviour.rows ?? []).filter((r) => filters.every((f) => f(r))), error: null };
      const builder: any = {
        select: () => builder,
        eq: (col: string, val: any) => { filters.push((r) => r[col] === val); return builder; },
        in: (col: string, vals: any[]) => { filters.push((r) => vals.includes(r[col])); return builder; },
        is: () => builder,
        or: () => builder,
        order: () => builder,
        limit: () => builder,
        range: () => builder,
        maybeSingle: async () => {
          const r = result();
          return r.error ? r : { data: (r.data as any[])[0] ?? null, error: null };
        },
        then: (onF: any, onR: any) => Promise.resolve(result()).then(onF, onR),
      };
      return builder;
    },
  };
}

function req(token: string | null = "tok"): Request {
  return { headers: token === null ? {} : { authorization: `Bearer ${token}` } } as unknown as Request;
}

const USER = { id: "11111111-1111-4111-8111-111111111111" };
/** The gate's profiles read: banned / suspended are an embedded user_account_states row (in force: no end). */
const profiles = (state: string): TableBehaviour => (state === "banned" || state === "suspended"
  ? { rows: [{ id: USER.id, account_status: "active", user_account_states: [{ state, expires_at: null }] }] }
  : { rows: [{ id: USER.id, account_status: state }] });
const UNREADABLE: TableBehaviour = { error: { message: "permission denied for table profiles", code: "42501" } };

describe("optionalUser — the account-state gate", () => {
  afterEach(() => _clearTestClient());

  for (const status of ["banned", "suspended"]) {
    it(`a ${status} account's valid token is REFUSED 403 — neither signed in nor anonymous`, async () => {
      _setTestClient(makeClient({ user: USER, tables: { profiles: profiles(status) } }), true);
      await assert.rejects(
        () => optionalUser(req()),
        (err: any) => {
          assert.equal(err?.status, 403, "the global handler reads `status` off the error");
          assert.equal(err?.code, "forbidden");
          assert.equal(err?.reason, `account_${status}`);
          assert.equal(err?.name, "AccountRestrictedError");
          return true;
        },
        `a ${status} account must be refused on an optional route, not downgraded to a visitor`,
      );
    });
  }

  it("a deleted account's valid token is ANONYMOUS (a tombstone, not a restriction — unchanged)", async () => {
    _setTestClient(makeClient({ user: USER, tables: { profiles: profiles("deleted") } }), true);
    assert.equal(await optionalUser(req()), null);
  });

  it("an UNREADABLE account state is refused with a 503 degraded_unavailable error, never signed in", async () => {
    _setTestClient(makeClient({ user: USER, tables: { profiles: UNREADABLE } }), true);
    await assert.rejects(
      () => optionalUser(req()),
      (err: any) => {
        assert.equal(err?.status, 503, "the global handler reads `status` off the error");
        assert.equal(err?.code, "degraded_unavailable");
        assert.equal(err?.name, "AccountStatusUnavailableError");
        return true;
      },
      "an unread ban must never be treated as 'not banned'",
    );
  });

  it("a transport-level rejection of the profiles read is refused the same way", async () => {
    const client = makeClient({ user: USER });
    const realFrom = client.from.bind(client);
    client.from = (t: string) => {
      if (t !== "profiles") return realFrom(t);
      const b: any = { select: () => b, eq: () => b, maybeSingle: async () => { throw new Error("ECONNRESET"); } };
      return b;
    };
    _setTestClient(client, true);
    await assert.rejects(() => optionalUser(req()), (err: any) => err?.status === 503);
  });

  for (const status of ["active", "deactivated", "pending_deletion"]) {
    it(`CONTROL — a ${status} account is signed in (requireUser admits it too)`, async () => {
      _setTestClient(makeClient({ user: USER, tables: { profiles: profiles(status) } }), true);
      const out = await optionalUser(req());
      assert.ok(out, `${status} must stay signed in`);
      assert.equal(out!.user.id, USER.id);
    });
  }

  it("CONTROL — no profile row yet (the signup window) is signed in, not refused", async () => {
    _setTestClient(makeClient({ user: USER, tables: { profiles: { rows: [] } } }), true);
    assert.ok(await optionalUser(req()));
  });

  it("CONTROL — no header and an invalid token are anonymous, and read no account state", async () => {
    const reads: string[] = [];
    _setTestClient(makeClient({ user: USER, tables: { profiles: UNREADABLE }, reads }), true);
    assert.equal(await optionalUser(req(null)), null);
    assert.equal(await optionalUser(req("bad")), null);
    assert.deepEqual(reads, [], "an anonymous caller never depends on the profiles read");
  });
});

// ── Route level: what a banned token actually obtained ──────────────────────

async function call(router: any, path: string, token: string | null): Promise<{ status: number; body: any }> {
  const app = express();
  app.use(express.json());
  app.use("/api", router);
  app.use(globalErrorHandler);
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const port = (server.address() as any).port;
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
    });
    return { status: r.status, body: await r.json() };
  } finally {
    server.close();
  }
}

const TRIP_ID = "22222222-2222-4222-8222-222222222222";
const PRIVATE_TRIP = {
  id: TRIP_ID, owner_id: USER.id, title: "Secret itinerary", destination: "Kyoto",
  visibility: "private", status: "planning", start_date: "2026-11-01", end_date: "2026-11-09",
};

function tripWorld(profilesB: TableBehaviour) {
  return makeClient({
    user: USER,
    tables: { profiles: profilesB, trips: { rows: [PRIVATE_TRIP] }, blocks: { rows: [] }, trip_members: { rows: [] } },
  });
}

describe("GET /api/trips/:tripId — a banned owner's token on a PRIVATE trip", () => {
  afterEach(() => _clearTestClient());

  it("a banned owner is REFUSED 403 account_banned — neither the authorized view nor the anonymous preview", async () => {
    _setTestClient(tripWorld(profiles("banned")), true);
    const r = await call(tripsExpansionRouter, `/api/trips/${TRIP_ID}`, "tok");
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.error, "forbidden");
    assert.equal(r.body.reason, "account_banned");
    assert.equal(r.body.title, undefined, "no trip content may leak");
    assert.equal(r.body.locked, undefined, "not served as an anonymous visitor either");
  });

  it("an unreadable account state answers 503 degraded_unavailable, retryable, with no trip content", async () => {
    _setTestClient(tripWorld(UNREADABLE), true);
    const r = await call(tripsExpansionRouter, `/api/trips/${TRIP_ID}`, "tok");
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.error, "degraded_unavailable");
    assert.equal(r.body.retryable, true);
    assert.equal(r.body.title, undefined);
  });

  it("CONTROL — an active owner still gets the full authorized view", async () => {
    _setTestClient(tripWorld(profiles("active")), true);
    const r = await call(tripsExpansionRouter, `/api/trips/${TRIP_ID}`, "tok");
    assert.equal(r.status, 200);
    assert.notEqual(r.body.locked, true, JSON.stringify(r.body));
    assert.equal(r.body.title, "Secret itinerary");
  });

  it("CONTROL — an anonymous caller still gets the locked preview even while profiles is unreadable", async () => {
    _setTestClient(tripWorld(UNREADABLE), true);
    const r = await call(tripsExpansionRouter, `/api/trips/${TRIP_ID}`, null);
    assert.equal(r.status, 200);
    assert.equal(r.body.locked, true);
  });
});

describe("GET /api/places/:id/votes — viewer personalisation", () => {
  afterEach(() => _clearTestClient());
  const PLACE = "33333333-3333-4333-8333-333333333333";
  const votesWorld = (p: TableBehaviour) => makeClient({
    user: USER,
    tables: { profiles: p, place_votes: { rows: [{ vote: "worth_it", user_id: USER.id, entity_type: "place", entity_id: PLACE }] } },
  });

  it("an unreadable account state is a 503, not a served myVote", async () => {
    _setTestClient(votesWorld(UNREADABLE), true);
    const r = await call(reviewsRouter, `/api/places/${PLACE}/votes`, "tok");
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.error, "degraded_unavailable");
  });

  it("a banned token is REFUSED 403 — not served the anonymous tallies", async () => {
    _setTestClient(votesWorld(profiles("banned")), true);
    const r = await call(reviewsRouter, `/api/places/${PLACE}/votes`, "tok");
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.reason, "account_banned");
    assert.equal(r.body.worthItCount, undefined);
  });

  it("CONTROL — an active viewer still sees their own vote", async () => {
    _setTestClient(votesWorld(profiles("active")), true);
    const r = await call(reviewsRouter, `/api/places/${PLACE}/votes`, "tok");
    assert.equal(r.status, 200);
    assert.equal(r.body.myVote, "worth_it");
  });
});
