/**
 * TV-4b — a banned or suspended account keeps its appeal, its data export, its
 * own deletion request and a safety report (OD-TRUST-5: "preserve access to
 * appeals and permitted data exports"), and is told what is restricted, until
 * when and how to appeal (OD-TRUST-4). Everything else stays refused.
 *
 *   RA1  each allow-listed route admits a suspended account (requireUser
 *        returns the user; nothing is written to the response)
 *   RA2  the same for a banned account
 *   RA3  everything else is refused with the STRUCTURED 403: kind, until,
 *        what is restricted, what is still available, how to appeal, and that
 *        the moderation reason is not shared — prefixes, other methods and
 *        neighbouring paths included
 *   RA4  an unreadable account state is still a 503 on an allow-listed route
 *        (an unknown restriction is not an admission)
 *   RA5  an unrestricted account is unaffected
 *   RA6  every allow-listed entry is a real mounted route that authenticates
 *        through requireUser (so the list cannot drift from the routers)
 *
 * Run: node --import tsx/esm --test src/test/restrictedAccountAccess.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { _setTestClient, requireUser } from "../lib/http.js";
import { RESTRICTED_ACCOUNT_ROUTES } from "../lib/restrictedAccountAccess.js";

const USER = "bb000000-0000-4000-a000-000000000001";
const FUTURE = "2099-01-01T00:00:00.000Z";

function client(rows: Array<{ state: string; expires_at: string | null }> | "unreadable") {
  return {
    auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) },
    from(table: string) {
      const q: any = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => {
          if (table !== "profiles") return { data: null, error: null };
          if (rows === "unreadable") return { data: null, error: { message: "permission denied for table user_account_states", code: "42501" } };
          return { data: { account_status: "active", user_account_states: rows }, error: null };
        },
      };
      return q;
    },
  };
}

function res() {
  const r: any = { statusCode: 0, body: undefined as any };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: unknown) => { r.body = b; return r; };
  return r;
}

const reqFor = (method: string, originalUrl: string): any => ({ method, originalUrl, url: originalUrl, headers: { authorization: "Bearer tok" }, log: { error() {}, warn() {}, info() {} } });

const suspended = [{ state: "suspended", expires_at: FUTURE }];
const banned = [{ state: "banned", expires_at: null }];

afterEach(() => { _setTestClient(null as any, false); });

describe("TV-4b — what a restricted account may still reach", () => {
  for (const r of RESTRICTED_ACCOUNT_ROUTES) {
    it(`RA1 a SUSPENDED account reaches ${r.method} ${r.path}`, async () => {
      _setTestClient(client(suspended) as any, true);
      const out = res();
      const auth = await requireUser(reqFor(r.method, r.path), out);
      assert.ok(auth, `refused: ${JSON.stringify(out.body)}`);
      assert.equal(auth?.user.id, USER);
      assert.equal(out.statusCode, 0, "nothing written to the response");
    });
    it(`RA2 a BANNED account reaches ${r.method} ${r.path}`, async () => {
      _setTestClient(client(banned) as any, true);
      const out = res();
      assert.ok(await requireUser(reqFor(r.method, r.path), out), JSON.stringify(out.body));
    });
  }

  it("RA1 a query string or a trailing slash does not change the answer", async () => {
    _setTestClient(client(suspended) as any, true);
    assert.ok(await requireUser(reqFor("GET", "/api/appeals/me?page=2"), res()));
    assert.ok(await requireUser(reqFor("POST", "/api/appeals/"), res()));
  });

  for (const [method, path] of [
    ["POST", "/api/posts"],
    ["GET", "/api/me/profile"],
    ["GET", "/api/appeals"], // the ADMIN list, not the appellant's
    ["POST", "/api/appeals/x"],
    ["GET", "/api/appeals/restorations/pending"],
    ["GET", "/api/compass/me/memory/export/extra"],
    ["PATCH", "/api/me/delete-request"],
    ["POST", "/api/reports/123/notes"],
    ["POST", "/api/rent-a-buddy/bookings"],
  ] as const) {
    it(`RA3 ${method} ${path} is refused with the structured 403`, async () => {
      _setTestClient(client(suspended) as any, true);
      const out = res();
      assert.equal(await requireUser(reqFor(method, path), out), null);
      assert.equal(out.statusCode, 403);
      const b = out.body;
      assert.equal(b.error, "forbidden");
      assert.equal(b.reason, "account_suspended");
      assert.deepEqual(b.restriction, { kind: "suspended", until: FUTURE });
      assert.equal(b.restricted.scope, "account");
      assert.ok(typeof b.restricted.summary === "string" && b.restricted.summary.length > 0);
      assert.deepEqual(b.restricted.stillAvailable, RESTRICTED_ACCOUNT_ROUTES.map((x) => ({ method: x.method, path: x.path })));
      assert.deepEqual([b.appeal.method, b.appeal.path, b.appeal.statusPath], ["POST", "/api/appeals", "/api/appeals/me"]);
      assert.equal(b.why.shared, false, "the moderator's free-text reason is never sent");
    });
  }

  it("RA3 a banned account's refusal names the ban, with no end", async () => {
    _setTestClient(client(banned) as any, true);
    const out = res();
    assert.equal(await requireUser(reqFor("GET", "/api/me/profile"), out), null);
    assert.equal(out.statusCode, 403);
    assert.equal(out.body.reason, "account_banned");
    assert.deepEqual(out.body.restriction, { kind: "banned", until: null });
    assert.match(out.body.restricted.summary, /banned/);
  });

  it("RA4 an UNREADABLE account state is still a 503 on an allow-listed route", async () => {
    _setTestClient(client("unreadable") as any, true);
    const out = res();
    assert.equal(await requireUser(reqFor("POST", "/api/appeals"), out), null);
    assert.equal(out.statusCode, 503);
    assert.equal(out.body.error, "degraded_unavailable");
  });

  it("RA5 an unrestricted account is unaffected, listed route or not", async () => {
    _setTestClient(client([]) as any, true);
    assert.ok(await requireUser(reqFor("POST", "/api/posts"), res()));
    assert.ok(await requireUser(reqFor("POST", "/api/appeals"), res()));
  });
});

describe("RA6 — every allow-listed entry is a real route that authenticates through requireUser", () => {
  const routesDir = join(dirname(fileURLToPath(import.meta.url)), "../routes");
  const sources = readdirSync(routesDir).filter((f) => f.endsWith(".ts")).map((f) => readFileSync(join(routesDir, f), "utf8"));
  for (const r of RESTRICTED_ACCOUNT_ROUTES) {
    it(`${r.method} ${r.path}`, () => {
      const local = r.path.replace(/^\/api/, "");
      const decl = `router.${r.method.toLowerCase()}("${local}"`;
      const src = sources.find((s) => s.includes(decl));
      assert.ok(src, `no router declares ${decl}`);
      const body = src!.slice(src!.indexOf(decl), src!.indexOf(decl) + 400);
      assert.match(body, /await requireUser\(req, res\)/, `${decl} does not authenticate through requireUser`);
      assert.ok(r.why.length > 10, "each entry says why");
    });
  }
});
