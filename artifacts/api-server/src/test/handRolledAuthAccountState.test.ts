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
 * THE STRUCTURAL PINS. Source scans assert that
 *   (1) no file in src/ outside lib/http.ts and lib/accountStateGate.ts calls
 *       `.auth.getUser(` — so the next hand-rolled verification fails here
 *       instead of quietly re-opening the bypass. There is NO exemption any
 *       more: the four sites in routes/discovery.ts (×3) and routes/hiddenGems.ts
 *       (×1) that an earlier revision pinned as "known open" still served a
 *       banned token (independent verification, 2026-10-03) and now go through
 *       `getGatedUser` / `optionalUserFromToken`;
 *   (2) no call that can THROW the gate's refusal sits inside a `try` whose
 *       `catch` swallows it — routes/passport.ts answered a confirmed ban as 500
 *       `db_error` that way, and routes/og.ts as the generic card;
 *   (3) only lib/supabase.ts builds a client that reads the database (the one
 *       other builder, lib/telegraphBroadcast.ts, only opens a Realtime
 *       channel), which is what lets the gate treat a profile row that lacks
 *       the restriction embed as unreadable for every client that can reach
 *       PostgREST.
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
import ts from "typescript";
import * as httpLib from "../lib/http.js";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { globalErrorHandler } from "../lib/errorEnvelope.js";
import telegraphStreamRouter from "../routes/telegraphStream.js";
import stampsRouter from "../routes/stamps.js";
import discoveryRouter from "../routes/discovery.js";
import hiddenGemsRouter from "../routes/hiddenGems.js";
import followsRouter from "../routes/follows.js";
import passportRouter from "../routes/passport.js";
import passportStampsRouter from "../routes/passportStamps.js";
import profileTabsRouter from "../routes/profileTabs.js";
import ogRouter from "../routes/og.js";

interface TableBehaviour {
  rows?: Array<Record<string, any>>;
  error?: { message?: string; code?: string };
}

function makeClient(opts: { user?: { id: string } | null; tables?: Record<string, TableBehaviour>; authThrows?: boolean; authError?: { message: string; code?: string; status?: number }; authCalls?: { n: number } }): any {
  const tables = opts.tables ?? {};
  return {
    auth: {
      async getUser(token: string) {
        if (opts.authCalls) opts.authCalls.n++;
        if (opts.authThrows) throw new Error("fetch failed");
        if (opts.authError) return { data: { user: null }, error: opts.authError };
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
        ilike: (col: string, val: any) => { filters.push((r) => String(r[col] ?? "").toLowerCase() === String(val).toLowerCase()); return builder; },
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
      // Any other PostgREST filter a route chains (not, lte, contains, …) narrows nothing here.
      const chain: any = new Proxy(builder, {
        get: (target, prop) => (prop in target ? target[prop] : typeof prop === "symbol" ? undefined : () => chain),
      });
      for (const k of Object.keys(builder)) {
        if (k === "maybeSingle" || k === "then") continue;
        const fn = builder[k];
        builder[k] = (...args: any[]) => { fn(...args); return chain; };
      }
      return chain;
    },
    rpc: async () => ({ data: null, error: null }),
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

  function walk(dir: string, out: string[] = [], skip: string[] = ["test", "node_modules"]): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!skip.includes(e.name)) walk(p, out, skip); }
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
    }
    return out;
  }
  const relOf = (file: string) => path.relative(SRC, file).split(path.sep).join("/");

  it("every `.auth.getUser(` call lives in lib/http.ts or lib/accountStateGate.ts — no exemption", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = relOf(file);
      if (rel === "lib/http.ts" || rel === "lib/accountStateGate.ts") continue;
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        const t = line.trim();
        if (t.startsWith("//") || t.startsWith("*")) return;
        if (/\.auth\.getUser\(/.test(line)) offenders.push(`${rel}:${i + 1}`);
      });
    }
    assert.deepEqual(offenders, [],
      "these sites verify a bearer token without the account-state gate — use optionalUserFromToken / " +
      "getGatedUser / optionalUser / requireUser / requireUserFromToken from lib/http.ts");
  });

  // ── (2) a refusal the gate THROWS must reach the global error handler ──────
  // optionalUser, optionalUserFromToken and getGatedUser refuse by throwing
  // (403 restricted, 503 state unreadable). A `try { … } catch { degrade }`
  // around one of them — or around a local helper that calls one — turns the
  // refusal into whatever the catch does: an anonymous view, a generic card, a
  // 500 db_error. The scan finds every function that can throw the refusal
  // (to a fixed point, by name) and every call to one that sits in a `try`
  // whose catch does not hand the error to rethrowAccountGateRefusal /
  // isAccountGateRefusal.
  it("no call that can throw the gate's refusal sits in a try whose catch swallows it", () => {
    const files = walk(SRC, [], ["test", "__tests__", "node_modules", "scripts"]);
    const parsed = files.map((f) => ({ rel: relOf(f), sf: ts.createSourceFile(f, fs.readFileSync(f, "utf8"), ts.ScriptTarget.Latest, true) }));
    const isFn = (n: ts.Node) => ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n);
    const calleeName = (c: ts.CallExpression): string | null =>
      ts.isIdentifier(c.expression) ? c.expression.text : ts.isPropertyAccessExpression(c.expression) ? c.expression.name.text : null;
    const hands = (text: string) => /rethrowAccountGateRefusal\(|isAccountGateRefusal\(/.test(text);
    const swallowedBy = (call: ts.Node): ts.Node | null => {
      const p = call.parent;
      if (p && ts.isPropertyAccessExpression(p) && p.name.text === "catch" && ts.isCallExpression(p.parent) && !hands(p.parent.getText())) return p.parent;
      for (let n = call.parent, child: ts.Node = call; n; child = n, n = n.parent) {
        if (isFn(n)) return null;
        if (ts.isTryStatement(n) && n.tryBlock === child && n.catchClause && !hands(n.catchClause.block.getText())) return n;
      }
      return null;
    };
    const namedEnclosingFn = (node: ts.Node): string | null => {
      for (let n = node.parent; n; n = n.parent) {
        if (ts.isFunctionDeclaration(n) && n.name) return n.name.text;
        if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && n.parent && ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name)) return n.parent.name.text;
        if (isFn(n)) return null;
      }
      return null;
    };
    const throwing = new Set(["optionalUser", "optionalUserFromToken", "getGatedUser"]);
    const eachCall = (fn: (rel: string, sf: ts.SourceFile, call: ts.CallExpression, name: string) => void) => {
      for (const { rel, sf } of parsed) {
        const visit = (node: ts.Node): void => {
          if (ts.isCallExpression(node)) { const name = calleeName(node); if (name && throwing.has(name)) fn(rel, sf, node, name); }
          ts.forEachChild(node, visit);
        };
        visit(sf);
      }
    };
    for (let changed = true; changed;) {
      changed = false;
      eachCall((_rel, _sf, call) => {
        const fn = namedEnclosingFn(call);
        if (fn && !throwing.has(fn) && !swallowedBy(call)) { throwing.add(fn); changed = true; }
      });
    }
    const offenders: string[] = [];
    eachCall((rel, sf, call, name) => {
      if (rel === "lib/accountStateGate.ts") return;
      if (swallowedBy(call)) offenders.push(`${rel}:${sf.getLineAndCharacterOfPosition(call.getStart()).line + 1} ${name}`);
    });
    assert.ok(throwing.has("getOptionalViewerId") && throwing.has("resolveCallerId"), "the scan must see through the routes' own viewer helpers");
    assert.deepEqual(offenders, [],
      "a catch around these calls swallows the account gate's 403 / 503 — call rethrowAccountGateRefusal(err) first in the catch");
  });

  // ── (3) one place builds Supabase clients ─────────────────────────────────
  it("only lib/supabase.ts builds a client that reads the database (so every PostgREST-backed client is known to the gate)", () => {
    // The ONE other builder: lib/telegraphBroadcast.ts opens a dedicated long-lived client for the
    // cross-instance Realtime channel. It is never handed to a route and never reads a table — pinned
    // just below — so the gate never sees it.
    const REALTIME_ONLY = "lib/telegraphBroadcast.ts";
    const realtimeSource = fs.readFileSync(path.join(SRC, REALTIME_ONLY), "utf8");
    assert.equal((realtimeSource.match(/\brealtimeClient\.\w+/g) ?? []).filter((u) => u !== "realtimeClient.channel").length, 0,
      "the Realtime client may only open its channel; a table read through it would bypass the gate's record of PostgREST-backed clients");
    assert.ok(!/\brealtimeClient\b[^;]*\bexport\b|\bexport\b[^;]*\brealtimeClient\b|return\s+realtimeClient\b/.test(realtimeSource), "the Realtime client must not leave its module");

    const offenders: string[] = [];
    for (const file of walk(SRC, [], ["test", "__tests__", "node_modules", "scripts"])) {
      const rel = relOf(file);
      if (rel === "lib/supabase.ts" || rel === REALTIME_ONLY) continue;
      const text = fs.readFileSync(file, "utf8");
      // Any VALUE import that can reach the package's createClient — by name, under an alias, or
      // through a namespace / default import. `import type …` and `type X` specifiers cannot.
      const importRe = /import\s+(type\s+)?([^;]*?)\s+from\s+["']@supabase\/supabase-js["']/g;
      let m: RegExpExecArray | null;
      while ((m = importRe.exec(text)) !== null) {
        if (m[1]) continue;
        const clause = m[2]!.trim();
        const named = /\{([^}]*)\}/.exec(clause);
        const outsideBraces = clause.replace(/\{[^}]*\}/, "").replace(/,/g, "").trim();
        const reaches = outsideBraces !== "" ||
          (named?.[1] ?? "").split(",").some((spec) => /^\s*createClient\b/.test(spec));
        if (reaches) offenders.push(rel);
      }
    }
    assert.deepEqual(offenders, [], "build clients through getServiceClient (lib/supabase.ts), which records them for the account-state gate");
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

// ─────────────────────────────────────────────────────────────────────────────
// The sites the independent verification of 9dd3aafc2 found still open
// ─────────────────────────────────────────────────────────────────────────────

const UNTIL = new Date(Date.now() + 3_600_000).toISOString();
type StateRow = { state: string; expires_at: string | null };
/** A profile row with the gate's embed and a handle, for the passport routes. `states: null` is an embed that is not a row list. */
const gatedRow = (id: string, states: StateRow[] | null, extra: Record<string, any> = {}) =>
  ({ id, username: "owner", handle: "owner", account_status: "active", passport_visibility: "public", user_account_states: states, ...extra });
const BANNED_AUTH = { message: "User is banned", code: "user_banned", status: 403 };
const brief = (r: { status: number; body: any }) => `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`;

describe("getGatedUser — a drop-in for auth.getUser that applies the gate", () => {
  const fn = (httpLib as any).getGatedUser as (c: any, t: string, o?: any) => Promise<{ data: { user: { id: string } | null }; error: any }>;

  it("is exported from lib/http.ts", () => assert.equal(typeof fn, "function"));

  for (const s of ["banned", "suspended"]) {
    it(`${s} → THROWS 403 forbidden (reason account_${s}), carrying the restriction's kind and end`, async () => {
      const until = s === "suspended" ? UNTIL : null;
      const c = makeClient({ user: USER, tables: { profiles: { rows: [gatedRow(USER.id, [{ state: s, expires_at: until }])] } } });
      await assert.rejects(() => fn(c, "tok"), (e: any) =>
        e?.status === 403 && e?.code === "forbidden" && e?.reason === `account_${s}` &&
        e?.restriction?.kind === s && e?.restriction?.until === until);
    });
  }

  it("the auth service's banned refusal (GoTrue user_banned) → THROWS 403 account_restricted, not `{ user: null }`", async () => {
    const c = makeClient({ user: USER, authError: BANNED_AUTH });
    await assert.rejects(() => fn(c, "tok"), (e: any) => e?.status === 403 && e?.reason === "account_restricted");
  });

  it("an unreadable account state → THROWS 503 degraded_unavailable", async () => {
    const c = makeClient({ user: USER, tables: { profiles: UNREADABLE } });
    await assert.rejects(() => fn(c, "tok"), (e: any) => e?.status === 503 && e?.code === "degraded_unavailable");
  });

  it("an expired suspension and a revoked ban are signed in", async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const c = makeClient({ user: USER, tables: { profiles: { rows: [gatedRow(USER.id, [{ state: "suspended", expires_at: past }, { state: "banned", expires_at: past }])] } } });
    assert.equal((await fn(c, "tok")).data.user?.id, USER.id);
  });

  it("CONTROL — otherwise it answers what auth.getUser answers: the user; a rejected token's error; a deleted account as no user", async () => {
    const ok = await fn(makeClient({ user: USER, tables: { profiles: { rows: [gatedRow(USER.id, [])] } } }), "tok");
    assert.equal(ok.data.user?.id, USER.id);
    assert.equal(ok.error, null);
    const bad = await fn(makeClient({ user: USER }), "bad");
    assert.equal(bad.data.user, null);
    assert.equal(bad.error?.message, "invalid JWT", "the site still sees WHY the token was refused");
    const gone = await fn(makeClient({ user: USER, tables: { profiles: { rows: [gatedRow(USER.id, [], { account_status: "deleted" })] } } }), "tok");
    assert.deepEqual(gone, { data: { user: null }, error: null });
  });

  it("an Auth call that itself throws still throws what it threw (the site's own 'viewer unresolved' handling keeps working)", async () => {
    await assert.rejects(() => fn(makeClient({ user: USER, authThrows: true }), "tok"), /fetch failed/);
  });

  it("rethrowAccountGateRefusal rethrows the gate's two refusals and nothing else", () => {
    const rethrow = (httpLib as any).rethrowAccountGateRefusal as (e: unknown) => void;
    const Restricted = (httpLib as any).AccountRestrictedError;
    const Unavailable = (httpLib as any).AccountStatusUnavailableError;
    assert.throws(() => rethrow(new Restricted("account_banned", "x")), (e: any) => e?.status === 403);
    assert.throws(() => rethrow(new Unavailable("down")), (e: any) => e?.status === 503);
    assert.doesNotThrow(() => rethrow(new Error("fetch failed")));
    assert.doesNotThrow(() => rethrow({ status: 403, reason: "account_banned" }), "a look-alike object is not the gate's refusal");
    assert.doesNotThrow(() => rethrow(undefined));
  });
});

describe("routes/discovery.ts and routes/hiddenGems.ts — the four sites that still served a banned token", () => {
  afterEach(() => { _clearTestClient(); _setTestServiceClient(null as any); });

  const install = (opts: Parameters<typeof makeClient>[0]) => {
    const c = makeClient({ ...opts, tables: { feature_flags: { rows: [{ flag: "hidden_gems_enabled", enabled: true }] }, ...(opts.tables ?? {}) } });
    _setTestClient(c, true);
    _setTestServiceClient(c);
  };
  // Each path reaches its viewer lookup before it reads anything it would serve.
  const SITES: Array<[string, any, string]> = [
    ["GET /discovery", discoveryRouter, "/api/discovery?destination=Lisbon"],
    ["GET /discovery/feed", discoveryRouter, "/api/discovery/feed?lat=38.72&lng=-9.14"],
    ["GET /discovery/community", discoveryRouter, "/api/discovery/community?city=Lisbon"],
    ["GET /hidden-gems", hiddenGemsRouter, "/api/hidden-gems"],
    ["GET /hidden-gems/:id", hiddenGemsRouter, "/api/hidden-gems/22222222-2222-4222-8222-222222222222"],
  ];

  for (const [name, router, url] of SITES) {
    it(`${name}: a banned token is REFUSED 403 account_banned — not served, not anonymous`, async () => {
      install({ user: USER, tables: { profiles: { rows: [gatedRow(USER.id, [{ state: "banned", expires_at: null }])] } } });
      const r = await withServer(router, (port) => open(port, url, "tok"));
      assert.equal(r.status, 403, brief(r));
      assert.equal(r.body.error, "forbidden");
      assert.equal(r.body.reason, "account_banned");
      assert.deepEqual(r.body.restriction, { kind: "banned", until: null });
    });

    it(`${name}: an in-force suspension is REFUSED 403 account_suspended, naming its end`, async () => {
      install({ user: USER, tables: { profiles: { rows: [gatedRow(USER.id, [{ state: "suspended", expires_at: UNTIL }])] } } });
      const r = await withServer(router, (port) => open(port, url, "tok"));
      assert.equal(r.status, 403, brief(r));
      assert.equal(r.body.reason, "account_suspended");
      assert.deepEqual(r.body.restriction, { kind: "suspended", until: UNTIL });
    });

    it(`${name}: the auth service's banned refusal is 403 account_restricted, not an anonymous request`, async () => {
      install({ user: USER, authError: BANNED_AUTH });
      const r = await withServer(router, (port) => open(port, url, "tok"));
      assert.equal(r.status, 403, brief(r));
      assert.equal(r.body.reason, "account_restricted");
    });

    it(`${name}: an unreadable account state is 503 degraded_unavailable, retryable`, async () => {
      install({ user: USER, tables: { profiles: UNREADABLE } });
      const r = await withServer(router, (port) => open(port, url, "tok"));
      assert.equal(r.status, 503, brief(r));
      assert.equal(r.body.error, "degraded_unavailable");
      assert.equal(r.body.retryable, true);
    });

    it(`${name}: CONTROL — a rejected (invalid) token is an anonymous request, not a refusal by the gate`, async () => {
      install({ user: USER, tables: { profiles: { rows: [gatedRow(USER.id, [{ state: "banned", expires_at: null }])] } } });
      const r = await withServer(router, (port) => open(port, url, "bad"));
      assert.notEqual(r.status, 403, `an invalid token is not a restricted account: ${brief(r)}`);
      assert.notEqual(r.body?.reason, "account_banned");
    });
  }
});

describe("CONTROL — an active viewer is served by the converted sites, for ONE Auth round trip", () => {
  afterEach(() => { _clearTestClient(); _setTestServiceClient(null as any); });
  // GET /discovery/community resolves a presented token before it serves. The lookup is memoised, so
  // that must stay the one round trip the request was already going to make, not a second.
  // `null`: whatever the route answers over this minimal double, it is not the gate's refusal.
  const CASES: Array<[string, any, string, number | null]> = [
    ["GET /discovery (no destination: the request is then refused for its payload, not by the gate)", discoveryRouter, "/api/discovery", 400],
    ["GET /discovery/community", discoveryRouter, "/api/discovery/community?city=Lisbon", null],
    ["GET /discovery/community?ageFilter=open_to_me (a second consumer of the same lookup)", discoveryRouter, "/api/discovery/community?city=Lisbon&ageFilter=open_to_me", null],
    ["GET /hidden-gems", hiddenGemsRouter, "/api/hidden-gems", null],
  ];
  for (const [name, router, url, expected] of CASES) {
    it(name, async () => {
      const authCalls = { n: 0 };
      const c = makeClient({
        user: USER,
        authCalls,
        tables: { profiles: { rows: [gatedRow(USER.id, [])] }, feature_flags: { rows: [{ flag: "hidden_gems_enabled", enabled: true }] } },
      });
      _setTestClient(c, true);
      _setTestServiceClient(c);
      const r = await withServer(router, (port) => open(port, url, "tok"));
      if (expected !== null) assert.equal(r.status, expected, brief(r));
      assert.ok(r.status !== 403 && r.status !== 503, `an active viewer met the gate's refusal: ${brief(r)}`);
      assert.equal(authCalls.n, 1, "exactly one auth.getUser per request");
    });
  }
});

describe("routes/passport.ts — a confirmed ban is the gate's 403, an unreadable state its 503; neither is 500 db_error", () => {
  afterEach(() => { _clearTestClient(); _setTestServiceClient(null as any); });
  const install = (opts: Parameters<typeof makeClient>[0]) => { const c = makeClient(opts); _setTestClient(c, true); _setTestServiceClient(c); };
  const PATHS = ["projection", "shared-context", "journeys", "contributions"];

  for (const p of PATHS) {
    it(`GET /passport/:userId/${p}: a banned viewer → 403 account_banned (was 500 db_error)`, async () => {
      install({ user: USER, tables: { profiles: { rows: [gatedRow(USER.id, [{ state: "banned", expires_at: null }])] } } });
      const r = await withServer(passportRouter, (port) => open(port, `/api/passport/${USER.id}/${p}`, "tok"));
      assert.equal(r.status, 403, brief(r));
      assert.equal(r.body.error, "forbidden");
      assert.equal(r.body.reason, "account_banned");
    });

    it(`GET /passport/:userId/${p}: the auth service's banned refusal → 403 account_restricted (was 500 db_error)`, async () => {
      install({ user: USER, authError: BANNED_AUTH, tables: { profiles: { rows: [gatedRow(USER.id, [])] } } });
      const r = await withServer(passportRouter, (port) => open(port, `/api/passport/${USER.id}/${p}`, "tok"));
      assert.equal(r.status, 403, brief(r));
      assert.equal(r.body.reason, "account_restricted");
    });

    it(`GET /passport/:userId/${p}: an account state that cannot be read → 503 degraded_unavailable, retryable (was 500 db_error)`, async () => {
      // The viewer's embed is present but is not a row list — not a shape a
      // to-many embed can take, so nothing is known about the viewer's state.
      install({ user: USER, tables: { profiles: { rows: [gatedRow(USER.id, null)] } } });
      const r = await withServer(passportRouter, (port) => open(port, `/api/passport/${USER.id}/${p}`, "tok"));
      assert.equal(r.status, 503, brief(r));
      assert.equal(r.body.error, "degraded_unavailable");
      assert.equal(r.body.retryable, true);
    });
  }
});

describe("routes/follows.ts — GET /users/:userId and /users/by-handle/:handle do not serve a banned user's passport", () => {
  afterEach(() => { _clearTestClient(); _setTestServiceClient(null as any); });
  const TARGET = "44444444-4444-4444-8444-444444444444";
  const install = (states: StateRow[] | null) => {
    const c = makeClient({ user: USER, tables: { profiles: { rows: [gatedRow(TARGET, states, { handle: "target", username: "target" })] } } });
    _setTestClient(c, true);
    _setTestServiceClient(c);
  };
  const ROUTES: Array<[string, string]> = [["by id", `/api/users/${TARGET}`], ["by handle", "/api/users/by-handle/target"]];

  for (const [how, url] of ROUTES) {
    it(`${how}: a banned target → the unavailable sentinel (404), to an anonymous caller`, async () => {
      // profiles.account_status is 'active' — it always is for a banned user: its CHECK cannot hold 'banned'.
      install([{ state: "banned", expires_at: null }]);
      const r = await withServer(followsRouter, (port) => open(port, url, null));
      assert.equal(r.status, 404, brief(r));
      assert.deepEqual(r.body, { unavailable: true, reason: "deleted" });
    });

    it(`${how}: a target under an in-force suspension → the unavailable sentinel`, async () => {
      install([{ state: "suspended", expires_at: UNTIL }]);
      const r = await withServer(followsRouter, (port) => open(port, url, null));
      assert.equal(r.status, 404, brief(r));
      assert.equal(r.body.unavailable, true);
    });

    it(`${how}: a target whose moderation state cannot be read → 503, never the profile`, async () => {
      install(null);
      const r = await withServer(followsRouter, (port) => open(port, url, null));
      assert.equal(r.status, 503, brief(r));
      assert.equal(r.body.error, "degraded_unavailable");
      assert.equal(r.body.id, undefined);
    });

    it(`${how}: CONTROL — a revoked ban and an ended suspension do not hide the profile`, async () => {
      const past = new Date(Date.now() - 1000).toISOString();
      install([{ state: "banned", expires_at: past }, { state: "suspended", expires_at: past }]);
      const r = await withServer(followsRouter, (port) => open(port, url, null));
      assert.equal(r.status, 200, brief(r));
      assert.equal(r.body.unavailable, undefined);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Every other route that resolves its own optional viewer
// ─────────────────────────────────────────────────────────────────────────────
// The conversions above the line were pinned structurally and through two
// routes (the Telegraph stream and GET /stamps/profile/:username). Each of the
// remaining sites is exercised here over HTTP, so "every auth path refuses a
// restricted account" is a statement about the routes and not only about the
// helper they share.

describe("every remaining optional-viewer route refuses a banned token (403) and an unreadable state (503)", () => {
  afterEach(() => { _clearTestClient(); _setTestServiceClient(null as any); });
  const install = (opts: Parameters<typeof makeClient>[0]) => {
    // The passport routes answer an empty list before they look at the caller while their flag is off.
    const flags = ["stamp_system_v2_enabled", "passport_memories_enabled", "passport_stamps_enabled"].map((flag) => ({ flag, enabled: true }));
    const c = makeClient({ ...opts, tables: { feature_flags: { rows: flags }, ...(opts.tables ?? {}) } });
    _setTestClient(c, true);
    _setTestServiceClient(c);
  };
  const TRIP = "55555555-5555-4555-8555-555555555555";
  const ROUTES: Array<[string, any, string]> = [
    ["passport.ts  GET /users/:username/passport", passportRouter, "/api/users/owner/passport"],
    ["passport.ts  GET /users/:username/passport/postcards", passportRouter, "/api/users/owner/passport/postcards"],
    ["passport.ts  GET /users/:username/profile", passportRouter, "/api/users/owner/profile"],
    ["passportStamps.ts  GET /users/:username/passport/memories", passportStampsRouter, "/api/users/owner/passport/memories"],
    ["passportStamps.ts  GET /users/:username/passport/stamps", passportStampsRouter, "/api/users/owner/passport/stamps"],
    ["profileTabs.ts  GET /users/:username/posts", profileTabsRouter, "/api/users/owner/posts"],
    ["profileTabs.ts  GET /users/:username/stamps", profileTabsRouter, "/api/users/owner/stamps"],
    ["profileTabs.ts  GET /users/:username/trips", profileTabsRouter, "/api/users/owner/trips"],
    ["profileTabs.ts  GET /users/:username/events", profileTabsRouter, "/api/users/owner/events"],
    ["profileTabs.ts  GET /users/:username/circles", profileTabsRouter, "/api/users/owner/circles"],
    ["follows.ts  GET /users/:userId/followers", followsRouter, `/api/users/${USER.id}/followers`],
    ["follows.ts  GET /users/:userId/following", followsRouter, `/api/users/${USER.id}/following`],
    ["follows.ts  GET /users/:userId", followsRouter, `/api/users/${USER.id}`],
    ["follows.ts  GET /users/by-handle/:handle", followsRouter, "/api/users/by-handle/owner"],
    ["og.ts  GET /og/:type/:id", ogRouter, `/api/og/trip/${TRIP}`],
    ["og.ts  GET /og/:type/:id/image.png", ogRouter, `/api/og/trip/${TRIP}/image.png`],
  ];

  for (const [name, router, url] of ROUTES) {
    it(`${name}: banned → 403 account_banned`, async () => {
      install({ user: USER, tables: { profiles: { rows: [gatedRow(USER.id, [{ state: "banned", expires_at: null }])] } } });
      const r = await withServer(router, (port) => open(port, url, "tok"));
      assert.equal(r.status, 403, brief(r));
      assert.equal(r.body.error, "forbidden");
      assert.equal(r.body.reason, "account_banned");
    });

    it(`${name}: the auth service's banned refusal → 403 account_restricted`, async () => {
      install({ user: USER, authError: BANNED_AUTH, tables: { profiles: { rows: [gatedRow(USER.id, [])] } } });
      const r = await withServer(router, (port) => open(port, url, "tok"));
      assert.equal(r.status, 403, brief(r));
      assert.equal(r.body.reason, "account_restricted");
    });

    it(`${name}: account state unreadable → 503 degraded_unavailable`, async () => {
      // The viewer's embed is not a row list: nothing is known about the viewer's state.
      install({ user: USER, tables: { profiles: { rows: [gatedRow(USER.id, null)] } } });
      const r = await withServer(router, (port) => open(port, url, "tok"));
      assert.equal(r.status, 503, brief(r));
      assert.equal(r.body.error, "degraded_unavailable");
    });
  }
});
