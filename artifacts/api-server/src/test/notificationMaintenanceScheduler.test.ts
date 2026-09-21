/**
 * notificationMaintenanceScheduler — the driver for the notification pipeline's
 * two scheduled jobs, and the proof that it is actually STARTED.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `NotificationDigestService.runForAllUsers()` and
 * `NotificationService.expireOldNotifications()` were both written and tested,
 * and both documented as "called by the scheduled cleanup/job infrastructure".
 * No such infrastructure existed: the only references anywhere were their own
 * definitions, two `/internal/...` routes nothing called, and a unit test. So
 * no digest was ever built on a running server, and `notifications.expires_at`
 * was honoured by every reader and acted on by nothing.
 *
 * A scheduler nothing calls is exactly that defect again, one level up, so the
 * first describe() block below reads src/index.ts through the TypeScript AST
 * and fails if the registration is removed — a guard whose whole point is that
 * deleting one line in index.ts turns this suite RED.
 *
 * WHAT IS MEASURED, NOT ASSUMED
 * -----------------------------
 * The stub client counts SETTLED QUERIES (`then()` calls on the builder), so
 * "the delete was not attempted" is a counted request, not an inference. The
 * counter matters because PostgrestBuilder is a THENABLE: a builder nobody
 * awaits issues no HTTP request at all, and a test that asserted only on return
 * values could not tell a skipped query from a dead one.
 *
 * TRAPS DELIBERATELY AVOIDED
 * --------------------------
 *   - Every stub read models BOTH `data` and `error`. A fake that only ever
 *     returns `{ error: null }` cannot exercise the branch this whole file is
 *     about, because supabase-js RESOLVES on a database error.
 *   - Timer tests advance mock timers and drain microtasks. Starting a
 *     scheduler and asserting on a timer handle proves nothing about whether a
 *     pass ever runs.
 *   - Vacuity: each behavioural test asserts a non-zero count of the queries it
 *     believes it exercised.
 *
 * Runtime: node:test + node:assert/strict (NOT vitest).
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/notificationMaintenanceScheduler.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import {
  runNotificationMaintenance,
  tickOnce,
  stopNotificationMaintenanceScheduler,
  getNotificationMaintenanceStatus,
  localDayKey,
  _resetStatus,
} from "../lib/notificationMaintenanceScheduler.js";
import { _setTestServiceClient } from "../lib/supabase.js";

// ═══════════════════════════════════════════════════════════════════════════
// 1. REGISTRATION GUARD — src/index.ts really starts it
// ═══════════════════════════════════════════════════════════════════════════

const INDEX_TS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "index.ts",
);

function indexSource(): ts.SourceFile {
  return ts.createSourceFile(
    "index.ts",
    readFileSync(INDEX_TS, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
}

/** Does src/index.ts import this name from a ./lib module? */
function importsName(sf: ts.SourceFile, name: string): boolean {
  let found = false;
  sf.forEachChild((node) => {
    if (!ts.isImportDeclaration(node)) return;
    const bindings = node.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) return;
    for (const el of bindings.elements) {
      if (el.name.text === name) found = true;
    }
  });
  return found;
}

/**
 * Is `name()` called inside the callback src/index.ts passes to `app.listen`?
 *
 * Not "does the identifier appear somewhere in the file" — an import alone is
 * not a registration, and a call in dead code is not one either. The call must
 * live inside the listen callback, which is the only place the server actually
 * reaches at boot.
 */
function startedInListenCallback(sf: ts.SourceFile, name: string): boolean {
  let listenBody: ts.Node | null = null;

  const findListen = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "listen"
    ) {
      for (const arg of node.arguments) {
        if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) listenBody = arg.body;
      }
    }
    ts.forEachChild(node, findListen);
  };
  findListen(sf);
  if (listenBody === null) return false;

  let called = false;
  const findCall = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    ) {
      called = true;
    }
    ts.forEachChild(node, findCall);
  };
  findCall(listenBody);
  return called;
}

describe("registration guard: src/index.ts starts the notification maintenance scheduler", () => {
  it("imports startNotificationMaintenanceScheduler", () => {
    assert.equal(
      importsName(indexSource(), "startNotificationMaintenanceScheduler"),
      true,
      "src/index.ts must import startNotificationMaintenanceScheduler",
    );
  });

  it("CALLS it inside the app.listen callback (this is the whole defect)", () => {
    assert.equal(
      startedInListenCallback(indexSource(), "startNotificationMaintenanceScheduler"),
      true,
      "startNotificationMaintenanceScheduler() must be called in the app.listen callback — " +
        "a scheduler nothing calls is the defect this file exists to prevent",
    );
  });

  it("the finder is not vacuous: a scheduler that does not exist is NOT found", () => {
    // Without this, a broken finder that answered `true` for everything would
    // make the assertion above meaningless.
    assert.equal(
      startedInListenCallback(indexSource(), "startSchedulerThatDoesNotExist"),
      false,
    );
    assert.equal(importsName(indexSource(), "startSchedulerThatDoesNotExist"), false);
  });

  it("the finder is not vacuous in the other direction either: it finds a known sibling", () => {
    // A finder that answered `false` for everything would also make the
    // assertion above pass for the wrong reason if it were inverted.
    assert.equal(startedInListenCallback(indexSource(), "startTrustMaintenanceScheduler"), true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. STUB CLIENT — counts settled queries, models data AND error
// ═══════════════════════════════════════════════════════════════════════════

interface Settled {
  table: string;
  ops: string[];
}

type Resolver = (table: string, ops: string[]) => { data: any; error: any; count?: number | null };

function stubClient(resolve: Resolver) {
  /** Every query that actually SETTLED. A builder nobody awaits never lands here. */
  const settled: Settled[] = [];

  function builder(table: string, ops: string[]): any {
    const b: any = {};
    for (const op of [
      "select", "insert", "update", "delete", "upsert",
      "eq", "neq", "lt", "lte", "gt", "gte", "in", "is", "limit", "order", "not",
    ]) {
      b[op] = (...args: any[]) => {
        const label = op === "select" && args[1]?.count ? "select:count" : op;
        return builder(table, [...ops, label]);
      };
    }
    b.maybeSingle = () => builder(table, [...ops, "maybeSingle"]);
    b.single = () => builder(table, [...ops, "single"]);
    // PostgrestBuilder is a thenable: the request only happens here.
    b.then = (onOk: any, onErr: any) => {
      settled.push({ table, ops: [...ops] });
      const r = resolve(table, ops);
      return Promise.resolve({ count: null, ...r }).then(onOk, onErr);
    };
    return b;
  }

  return {
    settled,
    countFor(table: string, opIncludes: string) {
      return settled.filter((s) => s.table === table && s.ops.includes(opIncludes)).length;
    },
    from(table: string) {
      return builder(table, []);
    },
    rpc() {
      throw new Error("no notification maintenance path may call rpc()");
    },
  } as any;
}

/** Let queued microtasks (the async pass) settle after advancing timers. */
async function drain() {
  for (let i = 0; i < 40; i += 1) await Promise.resolve();
  await new Promise((r) => setImmediate(r));
}

const DB_ERROR = { message: "relation does not exist", code: "42P01" };

beforeEach(() => {
  _resetStatus();
  delete process.env["NOTIFICATION_MAINTENANCE_DISABLED"];
});

afterEach(() => {
  stopNotificationMaintenanceScheduler();
  _setTestServiceClient(null as any);
  _resetStatus();
  delete process.env["NOTIFICATION_MAINTENANCE_DISABLED"];
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. DIGEST — "could not read the recipient list" is not "nobody opted in"
// ═══════════════════════════════════════════════════════════════════════════

describe("digest half", () => {
  it("an UNREADABLE recipient list is a FAILED pass, and the day is NOT closed", async () => {
    const c = stubClient((table) => {
      if (table === "notification_preferences") return { data: null, error: DB_ERROR };
      return { data: [], error: null };
    });

    const r = await runNotificationMaintenance({ client: c, runDigest: true });

    assert.equal(r.digestAttempted, true);
    assert.equal(r.digestRecipientsUnreadable, true);
    assert.equal(r.ok, false, "a pass that could not read its recipients is NOT a success");
    assert.ok(r.failures.includes("digest_recipients_unreadable"), r.failures.join(","));
    assert.equal(
      getNotificationMaintenanceStatus().lastDigestDay,
      null,
      "the day must stay open so the next tick retries it",
    );
    assert.ok(
      c.countFor("notification_preferences", "eq") >= 1,
      "vacuity check: the recipient query must actually have been issued",
    );
  });

  it("a READABLE but empty recipient list is a real success and DOES close the day", async () => {
    const c = stubClient(() => ({ data: [], error: null }));

    const r = await runNotificationMaintenance({ client: c, runDigest: true });

    assert.equal(r.digestRecipientsUnreadable, false);
    assert.equal(r.digestUsersProcessed, 0);
    assert.equal(r.ok, true);
    assert.equal(getNotificationMaintenanceStatus().lastDigestDay, localDayKey());
  });

  it("the digest runs on the FIRST pass of a day and not again the same day", async () => {
    const c = stubClient(() => ({ data: [], error: null }));

    const first = await runNotificationMaintenance({ client: c });
    assert.equal(first.digestAttempted, true, "first pass of the day must attempt the digest");

    const second = await runNotificationMaintenance({ client: c });
    assert.equal(second.digestAttempted, false, "same day — no second digest pass");

    const prefQueries = c.countFor("notification_preferences", "eq");
    assert.equal(prefQueries, 1, `expected exactly one recipient query, saw ${prefQueries}`);
  });

  it("a day whose digest FAILED is retried on the next pass", async () => {
    let readable = false;
    const c = stubClient((table) => {
      if (table === "notification_preferences") {
        return readable ? { data: [], error: null } : { data: null, error: DB_ERROR };
      }
      return { data: [], error: null };
    });

    const first = await runNotificationMaintenance({ client: c });
    assert.equal(first.ok, false);

    readable = true;
    const second = await runNotificationMaintenance({ client: c });
    assert.equal(second.digestAttempted, true, "a failed day must be retried, not closed");
    assert.equal(second.ok, true);
    assert.equal(c.countFor("notification_preferences", "eq"), 2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. EXPIRY — the probe is what makes an unmeasurable service measurable
// ═══════════════════════════════════════════════════════════════════════════

describe("expiry half", () => {
  it("an unreadable notifications table FAILS the pass and does NOT attempt the delete", async () => {
    const c = stubClient((table, ops) => {
      if (table === "notifications" && ops.includes("limit")) {
        return { data: null, error: DB_ERROR };
      }
      return { data: [], error: null };
    });

    const r = await runNotificationMaintenance({ client: c, runDigest: false });

    assert.equal(r.expiryUnreadable, true);
    assert.equal(r.ok, false);
    assert.ok(r.failures.includes("expiry_unreadable"), r.failures.join(","));

    const probes = c.countFor("notifications", "limit");
    assert.equal(probes, 1, `vacuity check: expected 1 probe, saw ${probes}`);
    const deletes = c.countFor("notifications", "delete");
    assert.equal(
      deletes,
      0,
      "the DELETE must NOT be issued against a table we could not even read",
    );
  });

  it("no expired rows: deleted 0 is a REAL answer and the pass succeeds", async () => {
    const c = stubClient((table, ops) => {
      if (table === "notifications" && ops.includes("limit")) return { data: [], error: null };
      if (table === "notifications" && ops.includes("delete")) {
        return { data: null, error: null, count: 0 };
      }
      return { data: [], error: null };
    });

    const r = await runNotificationMaintenance({ client: c, runDigest: false });

    assert.equal(r.expiryUnreadable, false);
    assert.equal(r.expiryBacklogSeen, false);
    assert.equal(r.expiredDeleted, 0);
    assert.equal(r.expiryZeroDespiteBacklog, false);
    assert.equal(r.ok, true);
    assert.equal(c.countFor("notifications", "limit"), 1);
  });

  it("a backlog the delete reported as 0 is a FAILURE, not an empty sweep", async () => {
    // `expireOldNotifications` returns 0 both for "nothing expired" and for a
    // failed delete (it logs and returns 0). The probe is the only way to tell
    // those apart from outside that service.
    const c = stubClient((table, ops) => {
      if (table === "notifications" && ops.includes("limit")) {
        return { data: [{ id: "n1" }], error: null };
      }
      if (table === "notifications" && ops.includes("delete")) {
        return { data: null, error: DB_ERROR, count: null };
      }
      return { data: [], error: null };
    });

    const r = await runNotificationMaintenance({ client: c, runDigest: false });

    assert.equal(r.expiryBacklogSeen, true);
    assert.equal(r.expiredDeleted, 0);
    assert.equal(r.expiryZeroDespiteBacklog, true);
    assert.equal(r.ok, false);
    assert.ok(r.failures.includes("expiry_zero_despite_backlog"), r.failures.join(","));
    assert.equal(c.countFor("notifications", "delete"), 1, "the delete WAS attempted");
  });

  it("a backlog the delete actually cleared is a success", async () => {
    const c = stubClient((table, ops) => {
      if (table === "notifications" && ops.includes("limit")) {
        return { data: [{ id: "n1" }], error: null };
      }
      if (table === "notifications" && ops.includes("delete")) {
        return { data: null, error: null, count: 3 };
      }
      return { data: [], error: null };
    });

    const r = await runNotificationMaintenance({ client: c, runDigest: false });

    assert.equal(r.expiredDeleted, 3);
    assert.equal(r.expiryZeroDespiteBacklog, false);
    assert.equal(r.ok, true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. HEALTH COUNTERS — reset only on a pass that genuinely succeeded
// ═══════════════════════════════════════════════════════════════════════════

describe("consecutiveFailures", () => {
  it("climbs across failing passes and does NOT reset just because nothing threw", async () => {
    const c = stubClient((table) => {
      if (table === "notification_preferences") return { data: null, error: DB_ERROR };
      return { data: [], error: null };
    });
    _setTestServiceClient(c);

    await tickOnce();
    await tickOnce();
    const s = getNotificationMaintenanceStatus();

    assert.equal(s.consecutiveFailures, 2, "two failing passes must count as two failures");
    assert.equal(s.lastSuccessAt, null, "no pass succeeded, so there is no last success");
    assert.notEqual(s.lastRunAt, null, "a pass WAS attempted — attempted and succeeded differ");
  });

  it("resets to zero only after a pass with no failures at all", async () => {
    let broken = true;
    const c = stubClient((table) => {
      if (table === "notification_preferences" && broken) return { data: null, error: DB_ERROR };
      return { data: [], error: null };
    });
    _setTestServiceClient(c);

    await tickOnce();
    assert.equal(getNotificationMaintenanceStatus().consecutiveFailures, 1);

    broken = false;
    await tickOnce();
    const s = getNotificationMaintenanceStatus();
    assert.equal(s.consecutiveFailures, 0);
    assert.notEqual(s.lastSuccessAt, null);
  });

  it("no service client counts as a failure, not as a quiet pass", async () => {
    // `client: null` explicitly, not `_setTestServiceClient(null)`: the suite
    // runs with SUPABASE_URL and a service key set, so clearing the injected
    // client makes getServiceClient() build a REAL one and open a socket.
    await tickOnce({ client: null });
    const s = getNotificationMaintenanceStatus();
    assert.equal(s.lastSkippedReason, "no_service_client");
    assert.equal(s.consecutiveFailures, 1);
  });
});
