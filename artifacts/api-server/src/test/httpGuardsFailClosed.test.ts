/**
 * The shared HTTP guards must not turn an unreadable row into a confident answer.
 *
 * WHAT THIS FILE PROVES
 * ---------------------
 * Three defects from `docs/architecture/11_API_Specification.md`
 * §"Authorization guards fail closed; the shared user/trip helpers do not",
 * registered as A1, A4 and A2 in `12` §3.2:
 *
 *   A1  requireUser's ban gate read `profiles.account_status`, DISCARDED
 *       `error`, and defaulted to "active" — so a failed read admitted a banned
 *       user. Banning writes `account_status` and nothing else; there is no
 *       session revocation anywhere in this system, so this is the ONLY ban
 *       enforcement point that exists.
 *   A4  requireTripMember returned null on error (indistinguishable from "not a
 *       member"), tripExists returned false (a real trip 404s), and canEditPlan
 *       did not bind `error` at all (an unreadable trips row read as "trip not
 *       found").
 *   A2  the global handler emitted a NESTED `{ error: { code, message } }`
 *       while all 4159 sendError call sites emit a FLAT `{ error, message }`.
 *
 * WHY EVERY POSITIVE TEST IS PAIRED WITH A CONTROL
 * ------------------------------------------------
 * A fail-closed change is trivially "passed" by breaking the feature: a guard
 * that refuses everything satisfies every failure assertion here. So each
 * refusal test is paired with a control asserting that the ORDINARY answer —
 * a member is a member, a missing trip is missing, an unbanned user is served,
 * an account with no profile row yet is served — still comes back as an answer
 * and never as a failure. `absent` and `unavailable` must stay distinguishable
 * in both directions.
 *
 * Runtime: node:test + node:assert/strict (NOT vitest — see
 * .agents/memory/api-server-testing.md). Registered in the api-server
 * package.json `test` script; an unregistered file never runs.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import type { Request, Response } from "express";
import {
  _setTestClient,
  _clearTestClient,
  requireUser,
  readAccountStatus,
  requireTripMember,
  isAcceptedTripMember,
  tripExists,
  canEditPlan,
  TripAccessUnavailableError,
} from "../lib/http.js";
import { globalErrorHandler } from "../lib/errorEnvelope.js";

// ── A minimal supabase-js shaped fake ────────────────────────────────────────
// Deliberately models the property the whole defect class rests on: a failed
// query RESOLVES `{ data: null, error }`, it does not throw. A fake that threw
// would make every one of these tests pass against the unfixed code.

interface TableBehaviour {
  rows?: Array<Record<string, any>>;
  error?: { message?: string; code?: string };
}

function makeClient(opts: {
  user?: { id: string } | null;
  authError?: { message: string } | null;
  tables?: Record<string, TableBehaviour>;
}): any {
  const tables = opts.tables ?? {};
  return {
    auth: {
      async getUser(_token: string) {
        if (opts.authError) return { data: { user: null }, error: opts.authError };
        return { data: { user: opts.user ?? null }, error: null };
      },
    },
    from(table: string) {
      const behaviour = tables[table] ?? { rows: [] };
      const filters: Array<(r: any) => boolean> = [];
      const builder: any = {
        select: () => builder,
        eq: (col: string, val: any) => { filters.push((r) => r[col] === val); return builder; },
        in: (col: string, vals: any[]) => { filters.push((r) => vals.includes(r[col])); return builder; },
        is: () => builder,
        or: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: async () => {
          if (behaviour.error) return { data: null, error: behaviour.error };
          const matched = (behaviour.rows ?? []).filter((r) => filters.every((f) => f(r)));
          return { data: matched[0] ?? null, error: null };
        },
        then: (onF: any, onR: any) => {
          const result = behaviour.error
            ? { data: null, error: behaviour.error }
            : { data: (behaviour.rows ?? []).filter((r) => filters.every((f) => f(r))), error: null };
          return Promise.resolve(result).then(onF, onR);
        },
      };
      return builder;
    },
  };
}

function makeReq(token = "tok"): Request {
  const logged: Array<{ obj: any; msg: string }> = [];
  return {
    headers: { authorization: `Bearer ${token}` },
    log: { error: (obj: any, msg: string) => logged.push({ obj, msg }) },
    _logged: logged,
  } as unknown as Request;
}

function makeRes() {
  const sink: { statusCode: number | null; body: any } = { statusCode: null, body: null };
  const res = {
    status(code: number) { sink.statusCode = code; return res; },
    json(body: any) { sink.body = body; return res; },
  };
  return { res: res as unknown as Response, sink };
}

const USER = { id: "user-1" };

// ─────────────────────────────────────────────────────────────────────────────
// A1 — the ban gate
// ─────────────────────────────────────────────────────────────────────────────

describe("A1 — readAccountStatus is a three-state read", () => {
  it("ok: a real status is returned as a measurement", async () => {
    const client = makeClient({ tables: { profiles: { rows: [{ id: USER.id, account_status: "banned" }] } } });
    const read = await readAccountStatus(client, USER.id);
    assert.deepEqual(read, { state: "ok", status: "banned" });
  });

  it("absent: no profile row is a SUCCESSFUL read that found no ban state", async () => {
    const client = makeClient({ tables: { profiles: { rows: [] } } });
    const read = await readAccountStatus(client, USER.id);
    assert.deepEqual(read, { state: "absent" });
  });

  it("unavailable: a failed read is NOT collapsed into absent", async () => {
    const client = makeClient({ tables: { profiles: { error: { message: "connection reset" } } } });
    const read = await readAccountStatus(client, USER.id);
    assert.equal(read.state, "unavailable", "a failed read must not read as 'absent'");
    assert.match((read as any).reason, /connection reset/);
  });
});

describe("A1 — requireUser refuses to serve a request whose ban check did not run", () => {
  // `_setTestClient` is the established injection hook (lib/http.ts) — it also
  // redirects getServiceClient(), so it must be cleared or later suites in the
  // same process inherit this fake.
  afterEach(() => _clearTestClient());

  it("an unreadable account_status answers 503 degraded_unavailable and serves nothing", async () => {
    // THE DEFECT, DIRECTLY: this read used to be `const { data: profile } = ...`
    // with `?? "active"`, so this exact client produced a fully served request
    // for a user whose ban state was never established.
    const client = makeClient({
      user: USER,
      tables: { profiles: { error: { message: "permission denied for table profiles" } } },
    });
    _setTestClient(client, true);
    const req = makeReq();
    const { res, sink } = makeRes();

    const out = await requireUser(req, res);

    assert.equal(out, null, "the request must not be served");
    assert.equal(sink.statusCode, 503, `expected 503, got ${sink.statusCode}`);
    assert.equal(sink.body.error, "degraded_unavailable",
      "the honest code is 'the check was not performed', not 'forbidden' and not 'unauthenticated'");
    assert.equal(sink.body.retryable, true, "a client must be told to retry, not to re-authenticate");
    assert.notEqual(sink.statusCode, 401,
      "a 401 would make every mobile client discard its session — a blip must not become a mass logout");
    assert.match(String(sink.body.message), /account status/i);
    assert.equal((req as any)._logged.length, 1, "the failure must be loud, not silent");
  });

  it("CONTROL — a banned account is still refused with 403", async () => {
    const client = makeClient({
      user: USER,
      tables: { profiles: { rows: [{ id: USER.id, account_status: "banned" }] } },
    });
    _setTestClient(client, true);
    const { res, sink } = makeRes();
    const out = await requireUser(makeReq(), res);
    assert.equal(out, null);
    assert.equal(sink.statusCode, 403);
    assert.equal(sink.body.error, "forbidden");
  });

  it("CONTROL — a suspended account is still refused with 403", async () => {
    const client = makeClient({
      user: USER,
      tables: { profiles: { rows: [{ id: USER.id, account_status: "suspended" }] } },
    });
    _setTestClient(client, true);
    const { res, sink } = makeRes();
    const out = await requireUser(makeReq(), res);
    assert.equal(out, null);
    assert.equal(sink.statusCode, 403);
  });

  it("CONTROL — an active account is served, and nothing is written to the response", async () => {
    const client = makeClient({
      user: USER,
      tables: { profiles: { rows: [{ id: USER.id, account_status: "active" }] } },
    });
    _setTestClient(client, true);
    const { res, sink } = makeRes();
    const out = await requireUser(makeReq(), res);
    assert.ok(out, "an unbanned user must still be served");
    assert.equal(out!.user.id, USER.id);
    assert.equal(sink.statusCode, null, "no error response may be written on the happy path");
  });

  it("CONTROL — an account with NO profile row yet is served (the signup window)", async () => {
    // `absent` must stay distinct from `unavailable` in this direction too: the
    // auth user exists before the profile row does, and folding absent into the
    // refusal would lock every new account out of its first request.
    const client = makeClient({ user: USER, tables: { profiles: { rows: [] } } });
    _setTestClient(client, true);
    const { res, sink } = makeRes();
    const out = await requireUser(makeReq(), res);
    assert.ok(out, "a missing profile row is a successful read, not a failed one");
    assert.equal(sink.statusCode, null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A4 — the three shared trip guards
// ─────────────────────────────────────────────────────────────────────────────

const TRIP = "trip-1";

describe("A4 — requireTripMember", () => {
  it("throws TripAccessUnavailableError when trip_members cannot be read", async () => {
    const client = makeClient({ tables: { trip_members: { error: { code: "57014", message: "canceling statement" } } } });
    await assert.rejects(
      () => requireTripMember(client as any, TRIP, USER.id),
      (e: any) => e instanceof TripAccessUnavailableError && e.input === "trip_members" && e.status === 503,
      "'the membership read failed' must not be returned as 'not a member'",
    );
  });

  it("throws when the OWNER fallback read of trips fails", async () => {
    // No membership row, so the owner fallback runs. Its `trips` read used to
    // discard `error` too, so an unreadable trips row denied the trip's owner.
    const client = makeClient({
      tables: { trip_members: { rows: [] }, trips: { error: { message: "connection reset" } } },
    });
    await assert.rejects(
      () => requireTripMember(client as any, TRIP, USER.id),
      (e: any) => e instanceof TripAccessUnavailableError && e.input === "trips",
    );
  });

  it("CONTROL — a genuine non-member still returns null", async () => {
    const client = makeClient({ tables: { trip_members: { rows: [] }, trips: { rows: [{ id: TRIP, owner_id: "someone-else" }] } } });
    assert.equal(await requireTripMember(client as any, TRIP, USER.id), null);
  });

  it("CONTROL — a real member still returns their role", async () => {
    const client = makeClient({
      tables: { trip_members: { rows: [{ trip_id: TRIP, user_id: USER.id, role: "member", status: "accepted" }] } },
    });
    assert.deepEqual(await requireTripMember(client as any, TRIP, USER.id), { role: "member" });
  });

  it("CONTROL — the owner with no membership row is still recognised", async () => {
    const client = makeClient({
      tables: { trip_members: { rows: [] }, trips: { rows: [{ id: TRIP, owner_id: USER.id }] } },
    });
    assert.deepEqual(await requireTripMember(client as any, TRIP, USER.id), { role: "owner" });
  });

  it("isAcceptedTripMember propagates the refusal — a bare boolean has no room for 'unknown'", async () => {
    const client = makeClient({ tables: { trip_members: { error: { message: "denied" } } } });
    await assert.rejects(() => isAcceptedTripMember(client as any, TRIP, USER.id), TripAccessUnavailableError);
  });
});

describe("A4 — tripExists", () => {
  it("throws rather than reporting a real trip as absent", async () => {
    const client = makeClient({ tables: { trips: { error: { message: "denied" } } } });
    await assert.rejects(
      () => tripExists(client as any, TRIP),
      (e: any) => e instanceof TripAccessUnavailableError && e.input === "trips",
      "returning false here 404s a trip that exists",
    );
  });

  it("CONTROL — a genuinely absent trip is still false, an existing one still true", async () => {
    assert.equal(await tripExists(makeClient({ tables: { trips: { rows: [] } } }) as any, TRIP), false);
    assert.equal(await tripExists(makeClient({ tables: { trips: { rows: [{ id: TRIP }] } } }) as any, TRIP), true);
  });
});

describe("A4 — canEditPlan", () => {
  it("throws rather than reporting an unreadable trips row as 'trip not found'", async () => {
    const client = makeClient({ tables: { trips: { error: { message: "denied" } } } });
    await assert.rejects(
      () => canEditPlan(client as any, TRIP, USER.id),
      (e: any) => e instanceof TripAccessUnavailableError && e.input === "trips",
    );
  });

  it("throws when the plan_editors read fails under specific_members", async () => {
    const client = makeClient({
      tables: {
        trips: { rows: [{ id: TRIP, owner_id: "owner-9", plan_edit_permission: "specific_members" }] },
        trip_members: { rows: [{ trip_id: TRIP, user_id: USER.id, role: "member", status: "accepted" }] },
        plan_editors: { error: { message: "denied" } },
      },
    });
    await assert.rejects(
      () => canEditPlan(client as any, TRIP, USER.id),
      (e: any) => e instanceof TripAccessUnavailableError && e.input === "plan_editors",
      "an unreadable editor list must not read as 'not an editor'",
    );
  });

  it("CONTROL — a genuinely missing trip still returns null", async () => {
    const client = makeClient({ tables: { trips: { rows: [] } } });
    assert.equal(await canEditPlan(client as any, TRIP, USER.id), null);
  });

  it("CONTROL — the owner is still permitted, a non-member still refused", async () => {
    const owned = makeClient({ tables: { trips: { rows: [{ id: TRIP, owner_id: USER.id, plan_edit_permission: "owner_only" }] } } });
    assert.equal(await canEditPlan(owned as any, TRIP, USER.id), true);

    const stranger = makeClient({
      tables: {
        trips: { rows: [{ id: TRIP, owner_id: "owner-9", plan_edit_permission: "all_members" }] },
        trip_members: { rows: [] },
      },
    });
    assert.equal(await canEditPlan(stranger as any, TRIP, USER.id), false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A2 — one envelope
// ─────────────────────────────────────────────────────────────────────────────

function startServer(app: express.Express): Promise<http.Server> {
  return new Promise((resolve) => {
    const srv = http.createServer(app);
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

function get(server: http.Server, path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const { port } = server.address() as { port: number };
    const req = http.request({ hostname: "127.0.0.1", port, path, method: "GET" }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        let body: any;
        try { body = JSON.parse(raw); } catch { body = raw; }
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    // A guard that stops refusing does not answer WRONGLY — it returns from the
    // handler having sent nothing, and the socket simply never replies. Without
    // this timeout a hand-revert of the fix makes the test HANG rather than
    // fail, and a test that can hang instead of failing is not proof of
    // anything (.agents/memory/prove-the-test-fails-before-trusting-it.md).
    req.setTimeout(5_000, () => {
      req.destroy(new Error("no response within 5s — the handler answered nothing"));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("A2 — the global handler emits the SAME envelope every route emits", () => {
  it("a plain unhandled throw is flat { error: <code>, message } — never a nested object", async () => {
    const app = express();
    app.get("/throw", (_req: Request, _res: Response, next) => next(new Error("deliberate")));
    app.use(globalErrorHandler);
    const server = await startServer(app);
    try {
      const r = await get(server, "/throw");
      assert.equal(r.status, 500);
      assert.equal(typeof r.body.error, "string",
        "a client reading body.error as a code must get a code, not an object");
      assert.equal(r.body.error, "INTERNAL_ERROR");
      assert.equal(typeof r.body.message, "string");
      assert.equal(r.body.error?.code, undefined, "the nested shape must be gone, not merely accompanied");
    } finally {
      server.close();
    }
  });

  it("A4's refusal reaches the client as the canonical 503 envelope, with no route change", async () => {
    // The composition proof: Express 5 forwards a rejected async handler to the
    // error handler, which reads `status` and `code` off the error. So a guard
    // that throws produces exactly what the route would have sent by hand.
    const app = express();
    app.get("/trip", async (_req: Request, _res: Response) => {
      const client = makeClient({ tables: { trips: { error: { message: "denied" } } } });
      await tripExists(client as any, TRIP);
    });
    app.use(globalErrorHandler);
    const server = await startServer(app);
    try {
      const r = await get(server, "/trip");
      assert.equal(r.status, 503, `expected 503, got ${r.status}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error, "degraded_unavailable");
      assert.equal(r.body.retryable, true);
    } finally {
      server.close();
    }
  });

  it("CONTROL — a custom status on the error is still honoured", async () => {
    const app = express();
    app.get("/custom", (_req: Request, _res: Response, next) => {
      const err: any = new Error("resource not found");
      err.status = 404;
      err.code = "NOT_FOUND";
      next(err);
    });
    app.use(globalErrorHandler);
    const server = await startServer(app);
    try {
      const r = await get(server, "/custom");
      assert.equal(r.status, 404);
      assert.equal(r.body.error, "NOT_FOUND");
      assert.equal(r.body.retryable, undefined, "only retryable codes carry the flag");
    } finally {
      server.close();
    }
  });
});
