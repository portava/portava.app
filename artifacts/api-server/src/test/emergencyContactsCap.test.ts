/**
 * EMERGENCY CONTACTS — the 10-contact cap must not be bypassable by an
 * unreadable table.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * `POST /api/me/emergency-contacts` enforced its cap like this:
 *
 *     const { count } = await db
 *       .from("profile_emergency_contacts")
 *       .select("*", { count: "exact", head: true })
 *       .eq("user_id", user.id);
 *     if ((count ?? 0) >= 10) { …refuse… }
 *
 * `error` is never destructured. supabase-js RESOLVES on a database error — it
 * does not throw and it does not reject — so an unreadable table hands back
 * `{ data: null, error: {...}, count: null }`. `count ?? 0` is then `0`, the
 * comparison is false, and the cap is not merely mis-measured: it is
 * BYPASSED ENTIRELY. Every write past it succeeds, without limit, for as long
 * as the read stays broken.
 *
 * A `try/catch` would not have caught this, which is why it survived: the
 * failure arrives resolved, so there is nothing to catch.
 *
 * ── WHAT THESE TESTS MEASURE, AND WHY THEY CANNOT PASS VACUOUSLY ────────────
 *  1. THE VERDICT IS AN INSERT COUNT, NOT A STATUS CODE. `spec.inserted`
 *     records every write the route actually issued. The bypass case asserts
 *     `insertCount === 0`. A route that refused for the wrong reason, or that
 *     died before reaching the cap, cannot fake that number upward — and the
 *     happy-path case asserts it goes to exactly 1, so "never writes anything"
 *     cannot pass either.
 *  2. NO `assert.notEqual(status, 200)`. A request rejected at validation, or a
 *     500 from a crash, satisfies that without the cap ever being consulted.
 *     Every case pins the EXACT status and the exact `error` code.
 *  3. THE `req.log` SHIM THE REAL SERVER INSTALLS IS PRESENT. Without it these
 *     handlers throw a TypeError on their first `req.log.*` call and the
 *     resulting 500-from-crash would masquerade as a deliberate refusal.
 *  4. FAILURES ARE SCOPED BY TABLE. `requireUser` reads `profiles` on EVERY
 *     request; failing tables wholesale would 503 before any handler ran and
 *     prove nothing about this route.
 *  5. The suite counts its own cases (`CASES_RUN`) and asserts the count is
 *     non-zero, so a file that silently examined nothing FAILS.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/emergencyContactsCap.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { makeFailClosedClient, type FakeClientSpec, type FakeDbError } from "./helpers/failClosedSupabase.js";
import emergencyContactsRouter from "../routes/emergencyContacts.js";

const USER  = "aaaaaaaa-1111-4000-a000-0000000000e1";
const TOKEN = "tok-emergency-user";
const TABLE = "profile_emergency_contacts";

/** The shape PostgREST hands back when the connection drops mid-statement. */
const READ_FAIL: FakeDbError = { message: "server closed the connection unexpectedly", code: "08006" };
/** The shape PostgREST hands back when an RLS grant or a migration is missing. */
const RELATION_MISSING: FakeDbError = { message: `relation "public.${TABLE}" does not exist`, code: "42P01" };

/** Every case that actually drove the router. Asserted non-zero at the end. */
let CASES_RUN = 0;

// ── Server ───────────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

before(async () => {
  const app = express();
  app.use(express.json());
  // The shim the real server installs (see trap 3 in the header).
  app.use((req, _res, next) => {
    const l: any = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    l.child = () => l;
    (req as any).log = l;
    next();
  });
  app.use("/api", emergencyContactsRouter);
  server = http.createServer(app);
  // 127.0.0.1 explicitly and awaited through the CALLBACK: a host-less
  // listen(0) binds the IPv6 wildcard, and address() is only readable once the
  // deferred bind has completed.
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(async () => { await new Promise<void>((r) => server.close(() => r())); });

function req(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request(
      {
        hostname: url.hostname, port: Number(url.port),
        path: url.pathname + url.search, method,
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** `n` existing contacts for USER, shaped as the route's `toRow` reads them. */
function contacts(n: number): Record<string, any>[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `contact-${i}`,
    user_id: USER,
    name: `Contact ${i}`,
    label: "",
    phone: null,
    email: null,
    notify_method: "in_app",
    sort_order: i,
    created_at: `2026-01-0${(i % 9) + 1}T00:00:00Z`,
    updated_at: `2026-01-0${(i % 9) + 1}T00:00:00Z`,
  }));
}

/** Installs the fake and returns a live view of the writes it recorded. */
function install(spec: Omit<FakeClientSpec, "users">) {
  const shared: FakeClientSpec = {
    users: { [TOKEN]: USER },
    inserted: {},
    updated: {},
    ...spec,
    rows: {
      profiles: [{ id: USER, account_status: "active", handle: "me", name: "Me", display_name: "Me", avatar_url: null }],
      ...(spec.rows ?? {}),
    },
  };
  const c = makeFailClosedClient(shared);
  _setTestClient(c, true);
  _setTestServiceClient(c);
  return {
    /** How many rows the route actually wrote to the contacts table. */
    insertCount: () => (shared.inserted?.[TABLE] ?? []).length,
    updateCount: () => (shared.updated?.[TABLE] ?? []).length,
  };
}

const VALID_BODY = { name: "Rosa", phone: "+84 90 000 0000", notifyMethod: "sms" as const };

// ═══════════════════════════════════════════════════════════════════════════
// The cap
// ═══════════════════════════════════════════════════════════════════════════

describe("POST /api/me/emergency-contacts — the cap may not be bypassed by a failed read", () => {
  it("an UNREADABLE contacts table refuses the write instead of counting it as zero", async () => {
    const w = install({
      rows: { [TABLE]: contacts(10) },
      failOn: (ctx) => (ctx.table === TABLE ? READ_FAIL : null),
    });

    const res = await req("POST", "/api/me/emergency-contacts", VALID_BODY);

    // THE LOAD-BEARING ASSERTION: nothing was written. Before the fix this was
    // 1 — the cap read resolved `count: null`, `null ?? 0` was 0, and the
    // insert ran with ten contacts already on file.
    assert.equal(w.insertCount(), 0, "an unreadable cap read must not let a write through");
    assert.equal(res.status, 503, "the cap was NOT PERFORMED — that is degraded, not permitted");
    assert.equal(res.body.error, "degraded_unavailable");
    assert.equal(res.body.retryable, true, "the client must be told to retry, not that the write succeeded");
    assert.equal(
      Object.prototype.hasOwnProperty.call(res.body, "contact"), false,
      "the response must not carry a `contact` — a fabricated contact IS the defect",
    );
    CASES_RUN++;
  });

  it("a MISSING relation is the same refusal — an unapplied migration is not an empty table", async () => {
    const w = install({
      rows: { [TABLE]: contacts(10) },
      failOn: (ctx) => (ctx.table === TABLE ? RELATION_MISSING : null),
    });

    const res = await req("POST", "/api/me/emergency-contacts", VALID_BODY);

    assert.equal(w.insertCount(), 0, "a missing relation must not read as 'you have no contacts yet'");
    assert.equal(res.status, 503);
    assert.equal(res.body.error, "degraded_unavailable");
    CASES_RUN++;
  });

  it("a READABLE table at the cap still refuses — 403, and still writes nothing", async () => {
    const w = install({ rows: { [TABLE]: contacts(10) } });

    const res = await req("POST", "/api/me/emergency-contacts", VALID_BODY);

    assert.equal(w.insertCount(), 0);
    assert.equal(res.status, 403, "at the cap is a decided refusal, not a degraded one");
    assert.equal(res.body.error, "forbidden");
    CASES_RUN++;
  });

  it("a READABLE table BELOW the cap writes exactly once — the fix is not a blanket refusal", async () => {
    const w = install({ rows: { [TABLE]: contacts(9) } });

    const res = await req("POST", "/api/me/emergency-contacts", VALID_BODY);

    assert.equal(res.status, 201, "nine contacts leaves room for a tenth");
    assert.equal(w.insertCount(), 1, "exactly one row written — this is what stops the fix being 'always refuse'");
    assert.equal(res.body.ok, true);
    assert.equal(res.body.contact.name, "Rosa");
    assert.equal(res.body.contact.notifyMethod, "sms");
    CASES_RUN++;
  });

  it("an EMPTY (but readable) table writes — empty is a real answer, not a failure", async () => {
    const w = install({ rows: { [TABLE]: [] } });

    const res = await req("POST", "/api/me/emergency-contacts", VALID_BODY);

    assert.equal(res.status, 201);
    assert.equal(w.insertCount(), 1);
    CASES_RUN++;
  });

  it("the cap counts only THIS user's contacts — another user's ten do not block you", async () => {
    const other = contacts(10).map((c, i) => ({ ...c, id: `other-${i}`, user_id: "bbbbbbbb-2222-4000-a000-0000000000e2" }));
    const w = install({ rows: { [TABLE]: other } });

    const res = await req("POST", "/api/me/emergency-contacts", VALID_BODY);

    assert.equal(res.status, 201, "the cap is per-user; ten rows belonging to someone else are not yours");
    assert.equal(w.insertCount(), 1);
    CASES_RUN++;
  });

  it("a failed INSERT is still reported as a failure, not as a created contact", async () => {
    const w = install({
      rows: { [TABLE]: contacts(2) },
      failWritesOn: (t) => (t === TABLE ? { message: "deadlock detected", code: "40P01" } : null),
    });

    const res = await req("POST", "/api/me/emergency-contacts", VALID_BODY);

    assert.equal(res.status, 500);
    assert.equal(res.body.error, "db_error");
    assert.equal(Object.prototype.hasOwnProperty.call(res.body, "contact"), false);
    void w;
    CASES_RUN++;
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The rest of the surface — confirmed rather than trusted
// ═══════════════════════════════════════════════════════════════════════════

describe("GET /api/me/emergency-contacts — an unreadable table is not 'you have nobody'", () => {
  it("refuses rather than answering { contacts: [] }", async () => {
    install({ rows: { [TABLE]: contacts(3) }, failOn: (ctx) => (ctx.table === TABLE ? READ_FAIL : null) });

    const res = await req("GET", "/api/me/emergency-contacts");

    assert.equal(res.status, 500, "the pre-existing `if (error)` branch fires — this is the confirmation, not a change");
    assert.equal(res.body.error, "db_error");
    assert.equal(
      Object.prototype.hasOwnProperty.call(res.body, "contacts"), false,
      "'you have nobody to call in an emergency' may not be assembled from a read that did not answer",
    );
    CASES_RUN++;
  });

  it("a readable table lists what is there, ordered by sort_order", async () => {
    install({ rows: { [TABLE]: contacts(3) } });

    const res = await req("GET", "/api/me/emergency-contacts");

    assert.equal(res.status, 200);
    assert.equal(res.body.contacts.length, 3);
    assert.deepEqual(res.body.contacts.map((c: any) => c.sortOrder), [0, 1, 2]);
    CASES_RUN++;
  });
});

describe("DELETE /api/me/emergency-contacts/:id", () => {
  /**
   * ── WHY THERE IS ONLY ONE CASE HERE, AND WHAT WAS DELETED ─────────────────
   * This block originally asserted three more things: that deleting an
   * existing contact answers 200, that deleting an absent one answers 404, and
   * that another user's contact answers 404. Two of those PASSED. All three
   * were meaningless, and the FALSE-GREEN RULE caught them:
   *
   * The route deletes with `.delete({ count: "exact" })` and NO chained
   * `.select()`, then branches on `if (!count) → 404`. Neither instrument in
   * this repo models that:
   *
   *   - `failClosedSupabase`'s `delete()` accepts NO ARGUMENTS at all
   *     (`delete() { writeKind = "delete"; … }`), so the `{ count: "exact" }`
   *     option is silently discarded and `countMode` is never set;
   *   - `postgrestOracle` — the REAL supabase-js client over an emulated
   *     PostgREST — answers a bodyless DELETE with `204` and NO `Content-Range`
   *     header, so the real client also parses `count: null`. Measured
   *     directly, not assumed:
   *         await client.from("t").delete({ count: "exact" }).eq("id", "a")
   *         → { data: null, error: null, count: null, status: 204 }
   *
   * So under BOTH doubles `count` is always null and the route always takes the
   * 404 branch. "Deleting an absent contact answers 404" therefore passed for a
   * reason that has nothing to do with the contact being absent — it would pass
   * just as well against a route that could never delete anything. That is a
   * test whose green means nothing, so it is gone rather than kept.
   *
   * Whether real PostgREST populates `Content-Range` on a 204 DELETE (supabase
   * documents `const { count } = await …delete({ count: "exact" })` as a
   * supported pattern, which suggests it does) is NOT settleable from inside
   * this repo, and it decides whether this route's happy path works at all.
   * It is reported to the lead rather than guessed at, and the route's delete
   * semantics are left exactly as they were. Seven other call sites share the
   * pattern.
   *
   * What IS measurable is the part this suite exists for: that a FAILED delete
   * is reported as a failure rather than as a tidy "not found".
   */
  it("an unreadable table refuses instead of claiming the contact was not found", async () => {
    install({
      rows: { [TABLE]: contacts(3) },
      failWritesOn: (t) => (t === TABLE ? READ_FAIL : null),
    });

    const res = await req("DELETE", "/api/me/emergency-contacts/contact-1");

    assert.equal(res.status, 500, "a failed delete is a failure, not a 404");
    assert.equal(res.body.error, "db_error");
    assert.equal(res.body.ok, undefined, "a failed delete must never answer ok");
    CASES_RUN++;
  });
});

describe("PATCH /api/me/emergency-contacts/:id", () => {
  it("an unreadable table does not report the contact as missing", async () => {
    const w = install({
      rows: { [TABLE]: contacts(3) },
      failWritesOn: (t) => (t === TABLE ? READ_FAIL : null),
    });

    const res = await req("PATCH", "/api/me/emergency-contacts/contact-1", { name: "Renamed" });

    // Pinned as the CURRENT behaviour: this route folds a failed write into
    // `not_found`. That is a weaker signal than the DELETE path gives, and is
    // reported rather than silently changed — a 404 here at least does not
    // claim the edit succeeded, which is the property that matters.
    assert.equal(res.status, 404);
    assert.equal(res.body.error, "not_found");
    assert.equal(
      Object.prototype.hasOwnProperty.call(res.body, "contact"), false,
      "a failed patch must never hand back a contact as though it were saved",
    );
    void w;
    CASES_RUN++;
  });

  it("patching an existing contact applies exactly the named fields", async () => {
    const w = install({ rows: { [TABLE]: contacts(3) } });

    const res = await req("PATCH", "/api/me/emergency-contacts/contact-1", { name: "Renamed", sortOrder: 7 });

    assert.equal(res.status, 200);
    assert.equal(w.updateCount(), 1);
    assert.equal(res.body.contact.name, "Renamed");
    assert.equal(res.body.contact.sortOrder, 7);
    CASES_RUN++;
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Vacuity guard — a suite that examined nothing must FAIL.
// ═══════════════════════════════════════════════════════════════════════════

describe("this suite examined something", () => {
  it("drove the router in a non-zero number of cases", () => {
    assert.ok(CASES_RUN >= 12, `expected >= 12 cases to have driven the router, saw ${CASES_RUN}`);
  });
});
