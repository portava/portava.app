/**
 * Hand-rolled bearer verification must not bypass the account-state gate.
 *
 * THE DEFECT
 * ----------
 * `optionalUser` / `requireUser` (lib/http.ts) are where a banned or suspended
 * account is refused: they read `profiles.account_status` after verifying the
 * token. Eleven route sites outside PR #530's zone did NOT call either — they
 * called `sc.auth.getUser(token)` themselves and used the id directly — so a
 * banned account's still-valid token (nothing in this system revokes sessions)
 * kept its full signed-in standing there:
 *
 *   GET /telegraph/stream                 REQUIRED auth, hand-rolled for the
 *                                         `?token=` EventSource path: a banned
 *                                         account kept a LIVE feed of its
 *                                         message threads, plus history resume.
 *   GET /stamps/profile/:username         owner context: revoked and hidden stamps.
 *   GET /passport/:handle/memories|stamps owner / circle context (passportStamps.ts).
 *   GET /users/:id/followers|following    viewer for private-profile visibility.
 *   GET /users/:id/passport, by-handle    caller for the block check / own view.
 *   profileTabs.ts (5 routes), passport.ts (7 routes), og.ts (2 routes)
 *                                         the optional viewer for visibility.
 *
 * They now resolve the token through `optionalUserFromToken` (optional) or
 * `requireUserFromToken` (required, telegraph stream), the same gate as the
 * shared helpers.
 *
 * THE STRUCTURAL PIN. A source scan asserts that no file in src/ outside
 * lib/http.ts and lib/accountStateGate.ts calls `.auth.getUser(` — so the next hand-rolled verification
 * fails here instead of quietly re-opening the bypass. The four sites in PR
 * #530's zone (discovery.ts ×3, hiddenGems.ts ×1) cannot be edited by this
 * change; they are pinned as KNOWN OPEN with an at-most count, so they may only
 * go down.
 *
 * SINCE 2026-10-03 (owner decision, moderation lane): a ban or suspension is a
 * `user_account_states` row — embedded on the gate's one `profiles` read — not
 * a `profiles.account_status` value (its CHECK cannot hold either), and an
 * OPTIONAL-auth site refuses a banned / suspended caller with 403 instead of
 * serving them as anonymous. The fixtures below express a ban as that row.
 *
 * Synthetic: in-memory supabase-js shaped fakes that RESOLVE `{ data: null,
 * error }` on failure, as the real client does.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import * as httpLib from "../lib/http.js";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { globalErrorHandler } from "../lib/errorEnvelope.js";
import telegraphStreamRouter from "../routes/telegraphStream.js";
import stampsRouter from "../routes/stamps.js";

interface TableBehaviour {
  rows?: Array<Record<string, any>>;
  error?: { message?: string; code?: string };
}

function makeClient(opts: { user?: { id: string } | null; tables?: Record<string, TableBehaviour>; authThrows?: boolean }): any {
  const tables = opts.tables ?? {};
  return {
    auth: {
      async getUser(token: string) {
        if (opts.authThrows) throw new Error("fetch failed");
        if (token === "bad") return { data: { user: null }, error: { message: "invalid JWT" } };
        return { data: { user: opts.user ?? null }, error: null };
      },
    },
    from(table: string) {
      const behaviour = tables[table] ?? { rows: [] };
      const filters: Array<(r: any) => boolean> = [];
      const result = () => behaviour.error
        ? { data: null, error: behaviour.error }
        : { data: (behaviour.rows ?? []).filter((r) => filters.every((f) => f(r))), error: null };
      const builder: any = {
        select: () => builder,
        eq: (col: string, val: any) => { filters.push((r) => r[col] === val); return builder; },
        neq: () => builder,
        in: (col: string, vals: any[]) => { filters.push((r) => vals.includes(r[col])); return builder; },
        is: () => builder,
        or: () => builder,
        gt: () => builder,
        gte: () => builder,
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

const USER = { id: "11111111-1111-4111-8111-111111111111" };
/** A profile row as the gate's read returns it: banned / suspended are an embedded user_account_states row. */
const profileRow = (state: string) => (state === "banned" || state === "suspended"
  ? { id: USER.id, username: "owner", account_status: "active", passport_visibility: "public", user_account_states: [{ state, expires_at: null }] }
  : { id: USER.id, username: "owner", account_status: state, passport_visibility: "public" });
const UNREADABLE: TableBehaviour = { error: { message: "permission denied for table profiles", code: "42501" } };

async function withServer<T>(router: any, fn: (port: number) => Promise<T>): Promise<T> {
  const app = express();
  app.use("/api", router);
  app.use(globalErrorHandler);
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn((server.address() as any).port);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}

/** Status + content-type + (JSON body if not a stream). Aborts an SSE stream once headers arrive. */
function open(port: number, p: string, token: string | null): Promise<{ status: number; type: string; body: any }> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: "127.0.0.1", port, path: p, method: "GET", headers: token ? { authorization: `Bearer ${token}` } : {} },
      (res) => {
        const type = String(res.headers["content-type"] ?? "");
        if (type.includes("text/event-stream")) {
          resolve({ status: res.statusCode ?? 0, type, body: null });
          r.destroy();
          return;
        }
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let body: any = raw;
          try { body = JSON.parse(raw); } catch { /* not JSON */ }
          resolve({ status: res.statusCode ?? 0, type, body });
        });
      },
    );
    r.on("error", (e: any) => (e?.code === "ECONNRESET" ? undefined : reject(e)));
    r.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────

describe("structural — no hand-rolled bearer verification outside lib/http.ts + lib/accountStateGate.ts", () => {
  const SRC = path.resolve(import.meta.dirname, "..");
  // PR #530's zone: not editable by this change. At-most counts; may only fall.
  const KNOWN_OPEN_PR530: Record<string, number> = {
    "routes/discovery.ts": 3,
    "routes/hiddenGems.ts": 1,
  };

  function walk(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "test" && e.name !== "node_modules") walk(p, out); }
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
    }
    return out;
  }

  it("every `.auth.getUser(` call lives in lib/http.ts or lib/accountStateGate.ts (or is a pinned PR #530 site)", () => {
    const offenders: string[] = [];
    const counts: Record<string, number> = {};
    for (const file of walk(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join("/");
      if (rel === "lib/http.ts" || rel === "lib/accountStateGate.ts") continue;
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        const t = line.trim();
        if (t.startsWith("//") || t.startsWith("*")) return;
        if (/\.auth\.getUser\(/.test(line)) {
          counts[rel] = (counts[rel] ?? 0) + 1;
          if (!(rel in KNOWN_OPEN_PR530)) offenders.push(`${rel}:${i + 1}`);
        }
      });
    }
    assert.deepEqual(offenders, [],
      "these sites verify a bearer token without the account-state gate — use optionalUserFromToken / " +
      "optionalUser / requireUser / requireUserFromToken from lib/http.ts");
    for (const [rel, max] of Object.entries(KNOWN_OPEN_PR530)) {
      assert.ok((counts[rel] ?? 0) <= max, `${rel}: ${counts[rel]} hand-rolled sites, pinned at most ${max}`);
    }
  });
});

describe("structural — sites that caught an Auth throw keep that behaviour", () => {
  // These five wrapped `sc.auth.getUser` in a try/catch that made a THROWING
  // Auth call anonymous. The conversion keeps exactly that and no more, via
  // `authThrowIsAnonymous` (the option never covers the account-state read —
  // pinned in the helper tests below). Dropping it would turn an Auth network
  // blip into a 500 on these public pages, a behaviour change this fix does
  // not intend.
  const SRC = path.resolve(import.meta.dirname, "..");
  const EXPECTED: Record<string, number> = {
    "routes/og.ts": 1,
    "routes/profileTabs.ts": 1,
    "routes/passport.ts": 1,
    "routes/follows.ts": 2,
  };
  for (const [rel, n] of Object.entries(EXPECTED)) {
    it(`${rel} passes authThrowIsAnonymous at ${n} site(s)`, () => {
      const src = fs.readFileSync(path.join(SRC, rel), "utf8");
      const got = (src.match(/optionalUserFromToken\([^)]*authThrowIsAnonymous: true/g) ?? []).length;
      assert.equal(got, n);
    });
  }
});

describe("optionalUserFromToken — the gate for a site that extracts its own token", () => {
  afterEach(() => _clearTestClient());
  const fn = (httpLib as any).optionalUserFromToken as
    ((c: any, t: string, o?: any) => Promise<{ id: string } | null>) | undefined;

  it("is exported", () => assert.equal(typeof fn, "function"));

  for (const s of ["banned", "suspended"]) {
    it(`${s} → REFUSED (throws 403 forbidden, reason account_${s}), never anonymous`, async () => {
      const c = makeClient({ user: USER, tables: { profiles: { rows: [profileRow(s)] } } });
      await assert.rejects(() => fn!(c, "tok"), (e: any) => e?.status === 403 && e?.code === "forbidden" && e?.reason === `account_${s}`);
      // authThrowIsAnonymous covers a THROWING Auth call only, never a confirmed restriction.
      await assert.rejects(() => fn!(c, "tok", { authThrowIsAnonymous: true }), (e: any) => e?.status === 403);
    });
  }

  it("deleted → anonymous (null): a tombstone, not a moderation restriction (unchanged)", async () => {
    const c = makeClient({ user: USER, tables: { profiles: { rows: [profileRow("deleted")] } } });
    assert.equal(await fn!(c, "tok"), null);
  });

  it("unreadable → throws AccountStatusUnavailableError (503), never a user", async () => {
    const c = makeClient({ user: USER, tables: { profiles: UNREADABLE } });
    await assert.rejects(() => fn!(c, "tok"), (e: any) => e?.status === 503 && e?.code === "degraded_unavailable");
  });

  it("unreadable is NOT swallowed even when an auth transport throw is to be treated as anonymous", async () => {
    const c = makeClient({ user: USER, tables: { profiles: UNREADABLE } });
    await assert.rejects(() => fn!(c, "tok", { authThrowIsAnonymous: true }), (e: any) => e?.status === 503);
  });

  it("an auth transport throw is anonymous only when the site opted in, and propagates otherwise", async () => {
    const c = makeClient({ user: USER, authThrows: true });
    assert.equal(await fn!(c, "tok", { authThrowIsAnonymous: true }), null);
    await assert.rejects(() => fn!(c, "tok"), /fetch failed/);
  });

  it("CONTROL — active / no row → the user; invalid token → null", async () => {
    assert.equal((await fn!(makeClient({ user: USER, tables: { profiles: { rows: [profileRow("active")] } } }), "tok"))?.id, USER.id);
    assert.equal((await fn!(makeClient({ user: USER, tables: { profiles: { rows: [] } } }), "tok"))?.id, USER.id);
    assert.equal(await fn!(makeClient({ user: USER }), "bad"), null);
  });
});

describe("GET /api/telegraph/stream — REQUIRED auth, hand-rolled for ?token=", () => {
  afterEach(() => _clearTestClient());
  const world = (p: TableBehaviour) => makeClient({ user: USER, tables: { profiles: p } });

  it("a banned account is refused 403 and gets NO stream (header token)", async () => {
    _setTestClient(world({ rows: [profileRow("banned")] }), true);
    const r = await withServer(telegraphStreamRouter, (port) => open(port, "/api/telegraph/stream", "tok"));
    assert.equal(r.status, 403, `got ${r.status} ${r.type}`);
    assert.ok(!r.type.includes("event-stream"));
    assert.equal(r.body.error, "forbidden");
  });

  it("a banned account is refused 403 on the ?token= EventSource path too", async () => {
    _setTestClient(world({ rows: [profileRow("banned")] }), true);
    const r = await withServer(telegraphStreamRouter, (port) => open(port, "/api/telegraph/stream?token=tok", null));
    assert.equal(r.status, 403, `got ${r.status} ${r.type}`);
  });

  it("a suspended account is refused 403", async () => {
    _setTestClient(world({ rows: [profileRow("suspended")] }), true);
    const r = await withServer(telegraphStreamRouter, (port) => open(port, "/api/telegraph/stream", "tok"));
    assert.equal(r.status, 403);
  });

  it("an unreadable account state is 503 degraded_unavailable, retryable — not a stream", async () => {
    _setTestClient(world(UNREADABLE), true);
    const r = await withServer(telegraphStreamRouter, (port) => open(port, "/api/telegraph/stream", "tok"));
    assert.equal(r.status, 503, `got ${r.status} ${r.type}`);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.equal(r.body.retryable, true);
  });

  it("CONTROL — an active account opens the stream", async () => {
    _setTestClient(world({ rows: [profileRow("active")] }), true);
    const r = await withServer(telegraphStreamRouter, (port) => open(port, "/api/telegraph/stream", "tok"));
    assert.equal(r.status, 200);
    assert.ok(r.type.includes("text/event-stream"), r.type);
  });
});

describe("GET /api/stamps/profile/:username — owner context", () => {
  afterEach(() => _clearTestClient());
  const STAMPS = [
    { id: "s-pub", user_id: USER.id, is_revoked: false, display_on_passport: true, visibility: "public", earned_at: "2026-01-01" },
    { id: "s-hidden", user_id: USER.id, is_revoked: true, display_on_passport: false, visibility: "private", earned_at: "2026-01-02" },
  ];
  const world = (p: TableBehaviour) => makeClient({
    user: USER,
    tables: {
      profiles: p,
      user_stamps: { rows: STAMPS },
      feature_flags: { rows: [{ flag: "stamp_system_v2_enabled", enabled: true }] },
    },
  });
  // The route's own profile lookup and the gate's account-state read are the
  // same table; the fake serves both from one row set.
  const ids = (b: any) => (b?.stamps ?? []).map((s: any) => s.id).sort();

  it("a banned owner's token is REFUSED 403 — neither the owner view of revoked/hidden stamps nor an anonymous view", async () => {
    _setTestClient(world({ rows: [profileRow("banned")] }), true);
    const r = await withServer(stampsRouter, (port) => open(port, "/api/stamps/profile/owner", "tok"));
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.error, "forbidden");
    assert.equal(r.body.reason, "account_banned");
    assert.equal(r.body.stamps, undefined, "no stamps are served to a refused caller");
  });

  it("CONTROL — an active owner still gets the owner view", async () => {
    _setTestClient(world({ rows: [profileRow("active")] }), true);
    const r = await withServer(stampsRouter, (port) => open(port, "/api/stamps/profile/owner", "tok"));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(ids(r.body), ["s-hidden", "s-pub"]);
  });

  it("CONTROL — an anonymous caller gets the public view", async () => {
    _setTestClient(world({ rows: [profileRow("active")] }), true);
    const r = await withServer(stampsRouter, (port) => open(port, "/api/stamps/profile/owner", null));
    assert.deepEqual(ids(r.body), ["s-pub"]);
  });
});

describe("parity — requireUserFromToken answers exactly what requireUser answers, state by state", () => {
  afterEach(() => _clearTestClient());
  // requireUser and requireUserFromToken both answer through enforceAccountState
  // (lib/accountStateGate.ts) since 2026-10-03; this holds them together.
  const cases: Array<[string, TableBehaviour]> = [
    ["banned", { rows: [profileRow("banned")] }],
    ["suspended", { rows: [profileRow("suspended")] }],
    ["deleted", { rows: [profileRow("deleted")] }],
    ["deactivated", { rows: [profileRow("deactivated")] }],
    ["active", { rows: [profileRow("active")] }],
    ["no row", { rows: [] }],
    ["unreadable", UNREADABLE],
  ];
  function sink() {
    const out: { status: number | null; body: any } = { status: null, body: null };
    const res: any = { status(c: number) { out.status = c; return res; }, json(b: any) { out.body = b; return res; } };
    return { res, out };
  }
  for (const [label, profiles] of cases) {
    it(label, async () => {
      const client = makeClient({ user: USER, tables: { profiles } });
      _setTestClient(client, true);
      const a = sink();
      const viaRequire = await httpLib.requireUser({ headers: { authorization: "Bearer tok" } } as any, a.res);
      const b = sink();
      const viaToken = await (httpLib as any).requireUserFromToken({ headers: {} } as any, b.res, client, "tok");
      assert.equal(viaRequire === null, viaToken === null, "served vs refused must agree");
      assert.deepEqual(b.out, a.out, "the written response must be identical");
    });
  }
});
