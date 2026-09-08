/**
 * notificationPrivacyGuardReachability — is the privacy guard on EVERY path
 * that can emit a notification, or only on some of them?
 *
 * ── WHY REACHABILITY IS THE QUESTION ─────────────────────────────────────────
 * NotificationPrivacyGuard is well tested as a UNIT (notifications.test.ts
 * covers GPS stripping, Ghost Mode, removed members, pending members). None of
 * that says anything about whether a given producer ever calls it. A guard
 * nothing calls is not a guard, and there is no type, lint rule or migration
 * that forces a producer through `NotificationService.create`: writing
 * `sc.from("notifications").insert({...})` compiles, runs, and skips every rule
 * in the guard.
 *
 * ── THE PROBE ────────────────────────────────────────────────────────────────
 * Rule 1 of the guard (strip GPS coordinates) is the only rule that applies to
 * EVERY category unconditionally, which makes it the universal witness: send a
 * notification whose body carries a literal coordinate pair and look at what
 * was PERSISTED. If the row still contains "13.7563, 100.5018", that path did
 * not pass through the guard. This is a property of the persisted row, not of
 * the code — a path rewired to bypass the guard fails here even if it still
 * imports it.
 *
 * Part 3 is a SOURCE LEDGER for the paths that legitimately cannot be probed
 * from here because they belong to other route files: direct
 * `.from("notifications").insert(...)` calls that skip the service entirely.
 * They are enumerated, not tolerated silently, and a NEW one fails this test.
 *
 * Run: node --import tsx/esm --test src/test/notificationPrivacyGuardReachability.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { makeFailClosedClient } from "./helpers/failClosedSupabase.js";
import notificationsRouter from "../routes/notifications.js";
import { NotificationService } from "../services/notifications/NotificationService.js";

const USER_ID   = "cc000000-0000-4000-8000-000000000001";
const ADMIN_ID  = "cc000000-0000-4000-8000-000000000009";
const USER_TOK  = "guard-reach-user-token";
const ADMIN_TOK = "guard-reach-admin-token";
const SECRET    = "guard-reach-internal-secret";

/** The literal a guarded path must never persist. */
const RAW_COORDS = "13.7563, 100.5018";
const BODY_WITH_COORDS = `Meet me at ${RAW_COORDS} tonight.`;

let server: http.Server;
let base: string;
let inserted: Record<string, any[]>;
/** Emit paths actually exercised — the vacuity witness for part 1. */
let pathsProbed = 0;

function makeClient() {
  inserted = {};
  return makeFailClosedClient({
    rows: {
      profiles: [
        { id: USER_ID,  role: "user" },
        { id: ADMIN_ID, role: "admin" },
      ],
      notifications: [],
      notification_preferences: [],
      notification_category_preferences: [],
      notification_devices: [],
      location_preferences: [],
      trip_members: [],
      feature_flags: [{ flag: "push_notifications_enabled", enabled: false }],
    },
    inserted,
    users: { [USER_TOK]: USER_ID, [ADMIN_TOK]: ADMIN_ID },
  });
}

function request(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body ? JSON.stringify(body) : undefined;
    const r = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname + url.search,
        method,
        headers: { "content-type": "application/json", ...headers },
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

/** The notification rows written since the last reset. */
function persisted(): any[] { return inserted["notifications"] ?? []; }

before(async () => {
  process.env.INTERNAL_API_SECRET = SECRET;
  const app = express();
  app.use(express.json());
  // WITHOUT this shim the route crashes on req.log and a 500-from-crash would
  // masquerade as a blocked notification.
  app.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, info: () => {}, warn: () => {}, debug: () => {} };
    next();
  });
  app.use("/api", notificationsRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", () => resolve()); });
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => new Promise<void>((r) => { server.close(() => r()); }));

// ─────────────────────────────────────────────────────────────────────────────
// 1. EVERY EMIT PATH IN routes/notifications.ts GOES THROUGH THE GUARD
// ─────────────────────────────────────────────────────────────────────────────

describe("privacy guard reachability — emit paths", () => {
  it("POST /internal/notifications strips coordinates before persisting", async () => {
    const client = makeClient();
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await request("POST", "/api/internal/notifications", {
      userId:    USER_ID,
      eventType: "location.geofence_triggered",
      title:     "Checkpoint",
      body:      BODY_WITH_COORDS,
      category:  "location",
    }, { "x-internal-secret": SECRET });

    assert.equal(r.status, 201, `expected the notification to be created; got ${r.status} ${JSON.stringify(r.body)}`);
    const rows = persisted();
    assert.equal(rows.length, 1, "exactly one notification row must be written");
    assert.ok(!rows[0].body.includes(RAW_COORDS), `raw coordinates were persisted: ${rows[0].body}`);
    assert.ok(rows[0].body.includes("[location]"), "the guard's placeholder must be present");
    pathsProbed += 1;
  });

  it("POST /internal/notifications/send strips coordinates before persisting", async () => {
    const client = makeClient();
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await request("POST", "/api/internal/notifications/send", {
      userId:    USER_ID,
      eventType: "location.geofence_triggered",
      title:     "Checkpoint",
      body:      BODY_WITH_COORDS,
      category:  "location",
    }, { "x-internal-secret": SECRET });

    assert.equal(r.status, 201, `expected the notification to be created; got ${r.status} ${JSON.stringify(r.body)}`);
    const rows = persisted();
    assert.equal(rows.length, 1);
    assert.ok(!rows[0].body.includes(RAW_COORDS), `raw coordinates were persisted: ${rows[0].body}`);
    pathsProbed += 1;
  });

  it("POST /admin/notifications/account-notice strips coordinates before persisting", async () => {
    const client = makeClient();
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await request("POST", "/api/admin/notifications/account-notice", {
      userId:  USER_ID,
      subject: "Account notice",
      body:    BODY_WITH_COORDS,
    }, { authorization: `Bearer ${ADMIN_TOK}` });

    assert.equal(r.status, 201, `expected the notice to be created; got ${r.status} ${JSON.stringify(r.body)}`);
    const rows = persisted();
    assert.equal(rows.length, 1);
    assert.ok(!rows[0].body.includes(RAW_COORDS), `raw coordinates were persisted: ${rows[0].body}`);
    pathsProbed += 1;
  });

  it("NotificationService.create — the shared choke point — strips coordinates", async () => {
    const client = makeClient();
    const row = await new NotificationService(client).create({
      userId:    USER_ID,
      eventType: "location.geofence_triggered",
      title:     "Checkpoint",
      body:      BODY_WITH_COORDS,
      category:  "location",
    });
    assert.ok(row, "the notification must be created");
    assert.ok(!row!.body.includes(RAW_COORDS));
    pathsProbed += 1;
  });

  it("the probe is capable of FAILING — an unguarded direct insert keeps the coordinates", async () => {
    const client = makeClient();
    // Exactly the shape a producer that skips the service writes.
    await client.from("notifications").insert({
      user_id: USER_ID, category: "location", event_type: "x", title: "t", body: BODY_WITH_COORDS,
    });
    const rows = persisted();
    assert.equal(rows.length, 1);
    assert.ok(
      rows[0].body.includes(RAW_COORDS),
      "if this fails, the double is sanitising for us and every assertion above is vacuous",
    );
  });

  it("probed a non-zero number of emit paths", () => {
    assert.ok(pathsProbed >= 4, `only ${pathsProbed} emit paths were probed`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE PUSH-PREVIEW ORACLE
// ─────────────────────────────────────────────────────────────────────────────

describe("privacy guard — live-share push previews", () => {
  it("redacts a live-share body for an eventType that has NO template", async () => {
    // No template -> renderTemplate returns null -> the caller-supplied
    // `channels` stays undefined. isPushPreview used to be read off that, so
    // it was falsy and the live-share rule never fired — while the ROUTER's
    // fallback for an unknown template is ['in_app','push'], i.e. it pushes.
    const client = makeClient();
    const row = await new NotificationService(client).create({
      userId:      USER_ID,
      eventType:   "location.custom_live_ping",   // deliberately not in TEMPLATES
      title:       "Live location",
      body:        "Anna is on Rua Garrett, outside number 14",
      category:    "location",
      isLiveShare: true,
    });
    assert.ok(row, "the notification must still be created");
    assert.equal(
      row!.body, "Live location active — open the app to view.",
      "an untemplated live-share notification is pushed, so its body must be redacted",
    );
  });

  it("redacts a live-share body when the caller asked for channels: ['in_app']", async () => {
    // `channels` does not restrict delivery — nothing downstream reads it — so
    // it must never NARROW the push-preview assumption.
    const client = makeClient();
    const row = await new NotificationService(client).create({
      userId:      USER_ID,
      eventType:   "location.live_share_started",  // template channels: in_app + push
      title:       "Live location",
      body:        "Anna is on Rua Garrett, outside number 14",
      category:    "location",
      channels:    ["in_app"],
      isLiveShare: true,
    });
    assert.ok(row);
    assert.equal(row!.body, "Live location active — open the app to view.");
  });

  it("leaves the body alone when the event genuinely cannot be pushed", async () => {
    // location.arrived_destination is in_app only — no push, no preview, no
    // redaction. Without this case the two above would pass on a guard that
    // simply redacts every live-share body unconditionally.
    const client = makeClient();
    const row = await new NotificationService(client).create({
      userId:      USER_ID,
      eventType:   "location.arrived_destination",  // template channels: ['in_app']
      title:       "Arrived",
      body:        "Anna is on Rua Garrett, outside number 14",
      category:    "location",
      isLiveShare: true,
    });
    assert.ok(row);
    assert.equal(row!.body, "Anna is on Rua Garrett, outside number 14");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. SOURCE LEDGER — producers that write `notifications` directly
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Files outside services/notifications/ that INSERT into `notifications`
 * without going through NotificationService, and therefore without the privacy
 * guard, the dedupe ledger or the delivery-attempt trail.
 *
 * This ledger is a CEILING, not an inventory to keep in sync: removing a bypass
 * never fails this test, adding one always does. Each entry is a known defect
 * owned by that route's lane, not an endorsement.
 */
const KNOWN_DIRECT_INSERT_FILES = new Set<string>([
  "src/routes/events.ts",     // event.review_prompt fan-out
  "src/routes/appeals.ts",    // appeal.approved / appeal.denied
  "src/routes/memories.ts",   // trip.memory_tagged
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === "test" || name === "__tests__" || name === "node_modules") continue;
      walk(p, out);
    } else if (name.endsWith(".ts")) {
      out.push(p);
    }
  }
  return out;
}

describe("privacy guard reachability — producers that bypass the service", () => {
  const SRC = join(fileURLToPath(new URL(".", import.meta.url)), "..");

  it("no NEW file inserts into `notifications` outside NotificationService", () => {
    const files = walk(SRC);
    assert.ok(files.length > 100, `only ${files.length} source files scanned — the walk is broken`);

    // `.from("notifications")` … `.insert(` within the same statement.
    const PATTERN = /\.from\(\s*["'`]notifications["'`]\s*\)\s*(?:\r?\n\s*)*\.insert\(/g;
    const offenders: string[] = [];
    let scanned = 0;
    for (const abs of files) {
      const rel = relative(join(SRC, ".."), abs).replace(/\\/g, "/");
      if (rel.startsWith("src/services/notifications/")) continue;
      scanned += 1;
      const src = readFileSync(abs, "utf8");
      PATTERN.lastIndex = 0;
      if (PATTERN.test(src)) offenders.push(rel);
    }
    assert.ok(scanned > 100, `only ${scanned} files were actually examined`);

    const unexpected = offenders.filter((f) => !KNOWN_DIRECT_INSERT_FILES.has(f));
    assert.deepEqual(
      unexpected, [],
      "these files write the notifications table directly, skipping the privacy guard, " +
      "the dedupe ledger and the delivery-attempt trail. Route them through " +
      "NotificationService.create, or add them to KNOWN_DIRECT_INSERT_FILES with a reason.",
    );
  });

  it("the detector actually finds the known bypasses — otherwise the case above is vacuous", () => {
    const PATTERN = /\.from\(\s*["'`]notifications["'`]\s*\)\s*(?:\r?\n\s*)*\.insert\(/;
    let found = 0;
    for (const rel of KNOWN_DIRECT_INSERT_FILES) {
      const abs = join(SRC, "..", rel);
      let src: string;
      try { src = readFileSync(abs, "utf8"); } catch { continue; }
      if (PATTERN.test(src)) found += 1;
    }
    assert.ok(
      found >= 1,
      "the regex matched none of the ledgered bypass files; a detector that finds " +
      "nothing would report an empty offender list forever",
    );
  });
});
