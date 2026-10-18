/**
 * census-trust (wave 5, 2026-10-18) — the admin user detail's openReports is
 * never 0 from a count nobody measured.
 *
 * Run: env -i PATH="$PATH" HOME=$TMPDIR TMPDIR=$TMPDIR TZ=UTC \
 *      SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/adminUserDetailOpenReports.test.ts
 * The route cases listen on 127.0.0.1 (run with loopback allowed).
 *
 * THE DEFECT. GET /admin/users (?email=… | ?handle=…, routes/admin.ts) is the
 * user detail an operator opens before acting on an account. It read `reports`
 * inline — a HEAD read with `{ count: "exact" }`, target_id = the user,
 * status = 'open' — and rendered `openReports: reportCountRes.count ?? 0`. The
 * route's own convention for an unreadable moderation fact is to REFUSE the
 * record with db_error naming the field ("Moderation record incomplete: … This
 * is NOT a clean account"), and it did name openReports, but only for a
 * RETURNED error. An answer with no error and no count (or a count that is not
 * a count) rendered "no open reports" — or -1, 1.5, "3" — on a user whose
 * reports were never counted, and a THROWN read was a bare 500.
 *
 * THE FIX. lib/moderationCounts.ts countOpenReportsAgainst: the same read, every
 * failure ok:false (the count form lib/exclusionSet.ts countRestrictRows set for
 * the dossier's restrictCount, census-telegraph T220d). The route maps ok:false
 * into the `{ count, error }` shape failedModerationReads reads, so a count-less,
 * failed or thrown answer refuses the record naming openReports — the existing
 * refusal, now reached by every way the count can be missing.
 *
 * DOUBLES. The healthy cases run on schemaStrictSupabase (every column the route
 * names is checked against the live schema; 42703 otherwise). The failure cases
 * run on the SAME schema-strict world with only the `reports` read's answer
 * replaced — every other read in the route stays schema-strict. Each case says
 * whether it was RED or GREEN on the code before this change (2d1a35878).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { countOpenReportsAgainst } from "../lib/moderationCounts.js";
import { makeSchemaStrictClient, type Seed } from "./helpers/schemaStrictSupabase.js";
import adminRouter from "../routes/admin.js";

const ADMIN  = "a1111111-1111-4111-8111-11111110a0e0";
const TARGET = "ab000000-0000-4000-a000-00000000a0e0";
const OTHER  = "ac000000-0000-4000-a000-00000000a0e0";
const REPORTER = "ad000000-0000-4000-a000-00000000a0e0";
const TARGET_EMAIL = "target@example.invalid";
const RERR = { message: "simulated reports failure", code: "57014" };

type Call = [string, unknown[]];
type ReportsMode =
  | { kind: "strict" }
  | { kind: "error"; count?: unknown }
  | { kind: "throw" }
  | { kind: "count"; count: unknown };

function profile(id: string, handle: string, extra: Record<string, unknown> = {}) {
  return {
    id, handle, username: handle, name: `${handle} name`, display_name: `${handle} display`,
    bio: null, avatar_url: null, role: "user", verified: false, account_status: "active",
    created_at: "2026-09-01T00:00:00.000Z", ...extra,
  };
}

function report(id: string, targetId: string, status: string) {
  return {
    id, reporter_id: REPORTER, target_type: "user", target_id: targetId, reason_code: "spam",
    reason_detail: null, severity: "normal", status, created_at: "2026-10-01T00:00:00.000Z",
  };
}

/** 3 open against TARGET, 1 resolved against TARGET, 2 open against someone else: openReports is 3. */
function world(reports = [
  report("r-1", TARGET, "open"), report("r-2", TARGET, "open"), report("r-3", TARGET, "open"),
  report("r-4", TARGET, "resolved"), report("r-5", OTHER, "open"), report("r-6", OTHER, "open"),
]): Seed {
  return {
    profiles: [profile(ADMIN, "admin", { role: "admin" }), profile(TARGET, "target"), profile(OTHER, "other")],
    user_account_states: [],
    compass_settings: [{ user_id: TARGET, onboarding_completed: true, onboarding_completed_at: "2026-09-02T00:00:00.000Z" }],
    reports,
    admin_access_log: [],
  };
}

/**
 * The schema-strict client, with `auth` (the admin's token, and the email →
 * id lookup the route makes through auth.admin.listUsers) and the `reports`
 * read's calls recorded. In any mode but "strict" only that read's ANSWER is
 * replaced; its select list and filters are still checked against the live
 * schema first.
 */
function install(seed: Seed, mode: ReportsMode = { kind: "strict" }) {
  const strict = makeSchemaStrictClient(seed);
  const reportReads: Call[][] = [];
  const from = (table: string) => {
    const b = strict.from(table);
    if (table !== "reports") return b;
    const calls: Call[] = [];
    reportReads.push(calls);
    for (const m of ["select", "eq", "neq", "in", "is", "not", "gt", "gte", "lt", "lte", "order", "limit", "ilike"]) {
      const orig = b[m];
      b[m] = (...args: unknown[]) => { calls.push([m, args]); return orig(...args); };
    }
    if (mode.kind !== "strict") {
      const then = b.then;
      b.then = (onF: any, onR: any) => then(() => {
        if (mode.kind === "throw") throw new Error("simulated thrown reports read");
        if (mode.kind === "error") return { data: null, error: RERR, count: mode.count ?? null };
        return { data: null, error: null, count: mode.count };
      }).then(onF, onR);
    }
    return b;
  };
  const client = {
    from,
    rpc: strict.rpc,
    auth: {
      getUser: async () => ({ data: { user: { id: ADMIN } }, error: null }),
      admin: {
        listUsers: async () => ({
          data: { users: [{ id: ADMIN, email: "admin@example.invalid" }, { id: TARGET, email: TARGET_EMAIL }, { id: OTHER, email: "other@example.invalid" }] },
          error: null,
        }),
      },
    },
  };
  _setTestClient(client, true);
  _setTestServiceClient(client as any);
  return { strict, reportReads, client };
}

let server: http.Server;
let base = "";
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.log = { error() {}, warn() {}, info() {}, debug() {} }; next(); });
  app.use(adminRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  _setTestClient(null, false);
  _setTestServiceClient(null);
});

async function detail(): Promise<{ status: number; body: any; raw: string }> {
  const r = await fetch(`${base}/admin/users?email=${encodeURIComponent(TARGET_EMAIL)}`, { headers: { authorization: "Bearer fake.jwt.token" } });
  const raw = await r.text();
  let body: any; try { body = JSON.parse(raw); } catch { body = raw; }
  return { status: r.status, body, raw };
}

/** The one reports read the user detail makes: a HEAD exact count of the user's OPEN reports. */
const COUNT_READ: Call[] = [
  ["select", ["id", { count: "exact", head: true }]],
  ["eq", ["target_id", TARGET]],
  ["in", ["status", ["open", "in_review"]]], // wave 5 (report status, 2026-10-18): the UNRESOLVED states, lib/moderationCounts.ts; was eq "open"
];

const REFUSAL = "Moderation record incomplete: openReports could not be read. This is NOT a clean account -- retry before acting.";

const show = (v: unknown) => (typeof v === "string" ? JSON.stringify(v) : String(v));
const COUNTLESS: unknown[] = [null, undefined, -1, 1.5, "3", Number.NaN, Number.POSITIVE_INFINITY];

describe("schema-strict: the admin user detail counts the user's open reports", () => {
  it("GREEN before (CONTROL): a real count renders — 3 open reports against the user, not the resolved one, not another user's", async () => {
    const { strict, reportReads } = install(world());
    const r = await detail();
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(strict.deadColumnErrors, [], "every column the route names is a live column");
    assert.deepEqual(Object.keys(r.body).sort(), ["accountStates", "onboardingStatus", "openReports", "profile"]);
    assert.equal(r.body.profile.id, TARGET);
    assert.equal(r.body.openReports, 3);
    assert.deepEqual(r.body.onboardingStatus, { completed: true, completedAt: "2026-09-02T00:00:00.000Z" });
    assert.deepEqual(reportReads, [COUNT_READ], "one HEAD exact count, the same filters as before");
  });

  it("GREEN before (CONTROL): no open reports is a measured 0", async () => {
    install(world([report("r-4", TARGET, "resolved"), report("r-5", OTHER, "open")]));
    const r = await detail();
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.openReports, 0);
  });
});

describe("the admin user detail: a count-less, failed or thrown openReports read refuses the record — never 0", () => {
  it("GREEN before: a returned error refuses the record, naming openReports", async () => {
    install(world(), { kind: "error" });
    const r = await detail();
    assert.equal(r.status, 500, r.raw);
    assert.deepEqual(r.body, { error: "db_error", message: REFUSAL });
  });

  it("a returned error refuses the record even when the answer also carries a count", async () => {
    install(world(), { kind: "error", count: 0 });
    const r = await detail();
    assert.equal(r.body?.error, "db_error", r.raw);
    assert.equal(r.body?.openReports, undefined, "no count is shown at all");
  });

  for (const count of COUNTLESS) {
    it(`RED before: a HEAD answer with count ${show(count)} and no error refuses the record, naming openReports — it rendered ${count == null ? "openReports 0" : "a count nothing measured"}`, async () => {
      install(world(), { kind: "count", count });
      const r = await detail();
      assert.notEqual(r.status, 200, `a count-less reports answer rendered a record: ${r.raw}`);
      assert.equal(r.body?.openReports, undefined, "no count is shown at all");
      assert.deepEqual(r.body, { error: "db_error", message: REFUSAL });
    });
  }

  it("RED before: a THROWN reports read is the same named refusal — not a bare 500", async () => {
    install(world(), { kind: "throw" });
    const r = await detail();
    assert.equal(r.status, 500, r.raw);
    assert.deepEqual(r.body, { error: "db_error", message: REFUSAL });
  });
});

describe("countOpenReportsAgainst — the count's definition of record", () => {
  it("one HEAD exact count of the OPEN reports naming the user as target", async () => {
    const { reportReads, client } = install(world());
    assert.deepEqual(await countOpenReportsAgainst(client, TARGET), { ok: true, count: 3 });
    assert.deepEqual(reportReads, [COUNT_READ]);
  });

  it("a measured 0 is ok:true, count 0", async () => {
    const { client } = install(world([]));
    assert.deepEqual(await countOpenReportsAgainst(client, TARGET), { ok: true, count: 0 });
  });

  const failures: ReportsMode[] = [
    { kind: "error" }, { kind: "error", count: 4 }, { kind: "throw" },
    ...COUNTLESS.map((count) => ({ kind: "count", count }) as ReportsMode),
  ];
  for (const mode of failures) {
    const label = mode.kind === "count" ? `a count of ${show(mode.count)}`
      : mode.kind === "throw" ? "a thrown read"
      : mode.kind === "error" && mode.count !== undefined ? "a returned error carrying a count" : "a returned error";
    it(`${label} → ok:false (never rejects, never 0)`, async () => {
      const { client } = install(world(), mode);
      const r = await countOpenReportsAgainst(client, TARGET);
      assert.equal(r.ok, false, JSON.stringify(r));
      assert.equal((r as any).count, undefined);
    });
  }

  it("no client or no user → ok:false, and nothing is read", async () => {
    const { client, reportReads } = install(world());
    assert.equal((await countOpenReportsAgainst(null, TARGET)).ok, false);
    assert.equal((await countOpenReportsAgainst(client, "")).ok, false);
    assert.deepEqual(reportReads, []);
  });
});
