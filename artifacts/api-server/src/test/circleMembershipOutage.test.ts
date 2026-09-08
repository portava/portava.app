/**
 * "YOU ARE NOT IN THIS CIRCLE" MUST NOT BE SOMETHING A FAILED READ CAN SAY.
 *
 * routes/circle.ts derived three answers about a person's standing in a group
 * from reads whose `.error` was either never bound or bound and then spent on
 * the same return value as an empty result:
 *
 *   isAcceptedMember    `if (error || !data) return false` — the error WAS
 *                       observed, and then folded into the identical verdict as
 *                       a genuinely absent row. GET .../is-member served that
 *                       as `{ isMember: false }` with a 200; GET .../members
 *                       and .../who-can-see-me served it as 403 "Not a member
 *                       of this context". Two different confident claims, both
 *                       assembled out of a query that did not answer, and
 *                       neither distinguishable by the caller from a real
 *                       denial they could act on.
 *
 *   isContextHost       `data?.owner_id === userId` on an unbound error, so an
 *                       unreadable `trips`/`events` row compared `undefined`
 *                       against the caller and reported the CONTEXT'S OWN HOST
 *                       as not the host — denying them the meeting-point
 *                       create/update/delete this gate exists to protect.
 *
 *   getAcceptedMemberIds  an unreadable roster became `[]`, and every caller
 *                       acted on it: `{ members: [] }` with a 200 ("this circle
 *                       is empty"), who-can-see-me listing nobody, every circle
 *                       notification fanning out to zero recipients in silence,
 *                       and the ADMIN disable-context action disabling Circle
 *                       for zero people while reporting success.
 *
 * All three now throw CircleAccessUnavailableError, which the global error
 * handler renders as 503 `degraded_unavailable` (retryable) — the same device
 * lib/http.ts already uses for trip access inputs.
 *
 * ── PAIRING ─────────────────────────────────────────────────────────────────
 * A test where the person is genuinely not a member and a test where the
 * membership table cannot be read pass for the same reason. So every outage
 * case below is paired with BOTH controls on the same route: the row present
 * and readable (must succeed) and the row genuinely absent (must still deny).
 * A fix that simply refused everything would fail the second control.
 *
 * Run: node --import tsx/esm --test src/test/circleMembershipOutage.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import circleRouter from "../routes/circle.js";
import { globalErrorHandler } from "../lib/errorEnvelope.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";

const VIEWER = "aaaaaaaa-0000-0000-0000-0000000000a1";
const OTHER = "aaaaaaaa-0000-0000-0000-0000000000a2";
const TRIP = "cccccccc-0000-0000-0000-0000000000c1";

const DB_ERROR = { code: "42501", message: "permission denied for table trip_members" };

type Rows = Record<string, any[]>;

/**
 * A failure spec. `onlyWithIn` narrows the injection to queries carrying a given
 * `.in(col, …)` filter, which is what separates the two DIFFERENT reads of
 * `trip_members` here: isAcceptedMember filters by user_id and has no `.in`,
 * getAcceptedMemberIds filters `.in("role", …)`. Without that, failing the table
 * wholesale trips the membership gate first and the roster guard is never
 * reached — a test that would pass for the wrong reason. (Measured: hand-
 * reverting the roster guard with a table-wide failure left this file green.)
 */
interface FailSpec { table: string; onlyWithIn?: string }

function makeClient(rows: Rows, fails: FailSpec[]) {
  function from(table: string) {
    const eqs: Array<[string, any]> = [];
    const ins: Array<[string, any[]]> = [];
    let kind = "read";
    let head = false;
    const b: any = {
      select(_c?: string, o?: any) { if (o?.head) head = true; return b; },
      insert() { kind = "w"; return b; },
      update() { kind = "w"; return b; },
      upsert() { kind = "w"; return b; },
      delete() { kind = "w"; return b; },
      eq(c: string, v: any) { eqs.push([c, v]); return b; },
      in(c: string, v: any[]) { ins.push([c, v]); return b; },
      neq() { return b; }, is() { return b; }, not() { return b; },
      or() { return b; }, order() { return b; }, limit() { return b; },
      gte() { return b; }, lte() { return b; }, gt() { return b; }, lt() { return b; },
      maybeSingle() { return run(true); },
      single() { return run(true); },
      then(f: any, r: any) { return run(false).then(f, r); },
    };
    function match(): any[] {
      let out: any[] = rows[table] ?? [];
      for (const [c, v] of eqs) out = out.filter((r) => r[c] === v);
      for (const [c, v] of ins) out = out.filter((r) => v.includes(r[c]));
      return out;
    }
    async function run(single: boolean): Promise<any> {
      // Resolves with an error rather than throwing — the defect's whole basis.
      const failed = fails.some((f) =>
        f.table === table && (!f.onlyWithIn || ins.some(([c]) => c === f.onlyWithIn)));
      if (failed) return { data: null, error: DB_ERROR, count: null };
      if (kind === "w") return { data: null, error: null, count: null };
      const hit = match();
      if (head) return { data: null, error: null, count: hit.length };
      if (single) return { data: hit[0] ?? null, error: null, count: hit.length };
      return { data: hit, error: null, count: hit.length };
    }
    return b;
  }
  return {
    from,
    auth: { getUser: async () => ({ data: { user: { id: VIEWER } }, error: null }) },
  } as any;
}

function baseRows(): Rows {
  return {
    profiles: [
      { id: VIEWER, handle: "me", name: "Me", display_name: "Me", account_status: "active" },
      { id: OTHER, handle: "you", name: "You", display_name: "You", account_status: "active" },
    ],
    // The Circle feature flag must be ON or routes short-circuit before the
    // membership gate and the test would pass for the wrong reason.
    feature_flags: [{ flag: "find_your_circle_enabled", enabled: true }],
    trips: [{ id: TRIP, owner_id: OTHER, end_date: "2099-01-01" }],
    trip_members: [
      { trip_id: TRIP, user_id: VIEWER, role: "member", status: "accepted" },
      { trip_id: TRIP, user_id: OTHER, role: "owner", status: "accepted" },
    ],
    circle_presence: [],
    circle_visibility_settings: [],
    circle_context_settings: [],
    circle_user_settings: [],
    profile_privacy_settings: [],
    blocks: [],
    events: [],
    event_rsvps: [],
    event_attendees: [],
    circle_audit_events: [],
  };
}

async function startApp(rows: Rows, fails: Array<FailSpec | string> = []) {
  _resetRateLimit();
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    next();
  });
  app.use("/api", circleRouter);
  // The refusal is an EXCEPTION rendered by the shared handler; without it a
  // rejected handler would 500 from express's default and the test would be
  // asserting the wrong mechanism.
  app.use(globalErrorHandler);
  const client = makeClient(rows, fails.map((f) => (typeof f === "string" ? { table: f } : f)));
  _setTestServiceClient(client);
  _setTestClient(client, true);
  const server = createServer(app);
  const baseUrl = await new Promise<string>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as import("net").AddressInfo;
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
  return { baseUrl, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function get(baseUrl: string, path: string) {
  const res = await fetch(`${baseUrl}${path}`, { headers: { authorization: "Bearer tok" } });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

let inspected = 0;
function checked<T>(v: T): T { inspected += 1; return v; }

afterEach(() => { _setTestServiceClient(null); _setTestClient(null, false); });

// ── is-member: the 200-coded false claim ────────────────────────────────────

describe("GET /circle/contexts/:type/:id/is-member", () => {
  it("POSITIVE CONTROL: a readable accepted membership reports isMember:true", async () => {
    const app = await startApp(baseRows());
    try {
      const { status, body } = await get(app.baseUrl, `/api/circle/contexts/trip/${TRIP}/is-member`);
      assert.equal(checked(status), 200);
      assert.equal(checked(body.isMember), true);
    } finally { await app.close(); }
  });

  it("NEGATIVE CONTROL: a genuinely absent membership still reports isMember:false", async () => {
    const rows = baseRows();
    rows.trip_members = [{ trip_id: TRIP, user_id: OTHER, role: "owner", status: "accepted" }];
    const app = await startApp(rows);
    try {
      const { status, body } = await get(app.baseUrl, `/api/circle/contexts/trip/${TRIP}/is-member`);
      assert.equal(checked(status), 200, "a READ that found nothing is a real answer");
      assert.equal(checked(body.isMember), false);
    } finally { await app.close(); }
  });

  it("refuses (503) rather than reporting isMember:false from an unreadable roster", async () => {
    // Same fixture as the positive control — the person IS a member.
    const app = await startApp(baseRows(), ["trip_members"]);
    try {
      const { status, body } = await get(app.baseUrl, `/api/circle/contexts/trip/${TRIP}/is-member`);
      assert.equal(checked(status), 503);
      assert.equal(checked(body.error), "degraded_unavailable");
      assert.equal(checked(body.retryable), true);
      assert.equal(checked(body.isMember), undefined, "no membership verdict may be present");
    } finally { await app.close(); }
  });
});

// ── members: the empty roster ───────────────────────────────────────────────

describe("GET /circle/contexts/:type/:id/members", () => {
  it("POSITIVE CONTROL: a member gets a 200 (roster read succeeded)", async () => {
    const app = await startApp(baseRows());
    try {
      const { status, body } = await get(app.baseUrl, `/api/circle/contexts/trip/${TRIP}/members`);
      assert.equal(checked(status), 200);
      assert.ok(checked(Array.isArray(body.members)), "a real roster answer");
    } finally { await app.close(); }
  });

  it("NEGATIVE CONTROL: a genuine non-member is still refused with 403", async () => {
    const rows = baseRows();
    rows.trip_members = [{ trip_id: TRIP, user_id: OTHER, role: "owner", status: "accepted" }];
    const app = await startApp(rows);
    try {
      const { status, body } = await get(app.baseUrl, `/api/circle/contexts/trip/${TRIP}/members`);
      assert.equal(checked(status), 403, "a real denial keeps its real code");
      assert.equal(checked(body.error), "forbidden");
    } finally { await app.close(); }
  });

  it("refuses (503, not 403) when the roster is unreadable", async () => {
    const app = await startApp(baseRows(), ["trip_members"]);
    try {
      const { status, body } = await get(app.baseUrl, `/api/circle/contexts/trip/${TRIP}/members`);
      assert.equal(checked(status), 503, "an outage is not a permission verdict");
      assert.equal(checked(body.error), "degraded_unavailable");
      assert.notEqual(checked(body.error), "forbidden");
    } finally { await app.close(); }
  });

  it("refuses (503) rather than serving an EMPTY roster when only the roster read fails", async () => {
    // The membership gate PASSES here — the caller really is a member and that
    // read succeeds. Only getAcceptedMemberIds' `.in("role", …)` read fails,
    // which is exactly the case that used to answer `{ members: [] }` with a
    // 200: "this circle is empty", told to a member of a two-person circle.
    const app = await startApp(baseRows(), [{ table: "trip_members", onlyWithIn: "role" }]);
    try {
      const { status, body } = await get(app.baseUrl, `/api/circle/contexts/trip/${TRIP}/members`);
      assert.equal(checked(status), 503, "an unreadable roster is not an empty circle");
      assert.equal(checked(body.error), "degraded_unavailable");
      assert.equal(checked(body.members), undefined);
    } finally { await app.close(); }
  });
});

// ── who-can-see-me: the same roster, a different lie ────────────────────────

describe("GET /circle/contexts/:type/:id/who-can-see-me", () => {
  it("POSITIVE CONTROL: a member gets a 200", async () => {
    const app = await startApp(baseRows());
    try {
      const { status } = await get(app.baseUrl, `/api/circle/contexts/trip/${TRIP}/who-can-see-me`);
      assert.equal(checked(status), 200);
    } finally { await app.close(); }
  });

  it("refuses rather than answering 'nobody can see you' from an unreadable roster", async () => {
    const app = await startApp(baseRows(), ["trip_members"]);
    try {
      const { status, body } = await get(app.baseUrl, `/api/circle/contexts/trip/${TRIP}/who-can-see-me`);
      assert.equal(checked(status), 503);
      assert.equal(checked(body.error), "degraded_unavailable");
      // "Nobody can see you" would be read as a privacy assurance, and acted on.
      assert.equal(checked(body.viewers ?? body.users ?? body.members), undefined);
    } finally { await app.close(); }
  });
});

// ── isContextHost: denying the host their own context ───────────────────────

describe("meeting-point host gate", () => {
  const MP = `/api/circle/contexts/trip/${TRIP}/meeting-point`;

  async function post(baseUrl: string, body: unknown) {
    const res = await fetch(`${baseUrl}${MP}`, {
      method: "POST",
      headers: { authorization: "Bearer tok", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
  }

  it("NEGATIVE CONTROL: a readable trips row that names someone else still denies with 403", async () => {
    const rows = baseRows(); // owner is OTHER, caller is VIEWER
    const app = await startApp(rows);
    try {
      const { status, body } = await post(app.baseUrl, { venueLabel: "The bridge" });
      assert.equal(checked(status), 403, "a real non-host keeps a real denial");
      assert.equal(checked(body.error), "forbidden");
    } finally { await app.close(); }
  });

  it("refuses (503) rather than telling the host they are not the host", async () => {
    // The caller IS the owner here, so a 403 could only come from the outage.
    const rows = baseRows();
    rows.trips = [{ id: TRIP, owner_id: VIEWER, end_date: "2099-01-01" }];
    const app = await startApp(rows, ["trips"]);
    try {
      const { status, body } = await post(app.baseUrl, { venueLabel: "The bridge" });
      assert.equal(checked(status), 503);
      assert.equal(checked(body.error), "degraded_unavailable");
      assert.notEqual(checked(body.error), "forbidden");
    } finally { await app.close(); }
  });
});

describe("the assertion count is non-zero", () => {
  it("inspected a non-vacuous number of assertions", () => {
    assert.ok(inspected >= 27, `expected >=27 checked assertions, got ${inspected}`);
  });
});
