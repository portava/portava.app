/**
 * POST /api/wall/telemetry — the §32 ingest that did not exist.
 *
 * WHAT THIS FILE IS PROVING
 * -------------------------
 * The Wall client has always POSTed its analytics to `/api/wall/telemetry`
 * (`features/wall/services/wallAnalyticsTransport.ts`, wired at app boot). There
 * was no such route. The transport swallows transport errors by design, so every
 * feed-open, mode-select, live-shown/opened, context-thread shown/acted/ignored,
 * follow-from-feed, handoff, caught-up, not-interested and real-world-outcome
 * event 404'd in silence — and the client's own test asserted the URL string
 * against itself, so it passed vacuously.
 *
 * These tests drive the REAL route over HTTP and assert the row that reaches the
 * store, so a missing or renamed route cannot pass.
 *
 * MUTATION PROOF (each verified by reverting production, watching it go RED,
 * restoring, watching it go GREEN):
 *   • unregister wallTelemetryRouter in routes/index.ts   → every ingest test
 *     404s (this is the pre-fix state of main, reproduced).
 *   • drop the per-event allow-list and store `req.body` verbatim → "raw typed
 *     content never reaches the store" and "a client-supplied actor cannot be
 *     smuggled in" go RED.
 *   • remove the `checkRateLimit` call → the 429 test goes RED.
 *   • remove the `isFlagEnabled` gate → the flag-off test goes RED.
 *   • stamp `viewer_id` from the body instead of the token → the actor test
 *     goes RED.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { checkRateLimit, _resetRateLimit } from "../lib/rateLimit.js";
import wallTelemetryRouter, {
  WALL_TELEMETRY_EVENT_NAMES,
  WALL_TELEMETRY_RATE_LIMIT,
  sanitizeWallEvent,
  containsDisallowedKey,
} from "../routes/wallTelemetry.js";

const __dir = dirname(fileURLToPath(import.meta.url));
/** The client transport, read as text — see the cross-boundary contract test. */
const CLIENT_TRANSPORT = resolve(
  __dir,
  "../../../../travel-buddy-standalone/src/features/wall/services/wallAnalyticsTransport.ts",
);

const TOKEN = "tok";
const VIEWER = "viewer-1";

interface Inserted {
  table: string;
  rows: any[];
}

function fakeClient(flags: Record<string, boolean>, inserted: Inserted[], insertError?: any) {
  function builder(table: string) {
    const eqs: Record<string, any> = {};
    const b: any = {
      select: () => b,
      eq: (c: string, v: any) => {
        eqs[c] = v;
        return b;
      },
      insert: (rows: any) => {
        inserted.push({ table, rows: Array.isArray(rows) ? rows : [rows] });
        return Promise.resolve({ error: insertError ?? null });
      },
      maybeSingle: () =>
        Promise.resolve(
          table === "feature_flags"
            ? { data: { enabled: !!flags[String(eqs.flag)] }, error: null }
            : { data: null, error: null },
        ),
      then: (onF: any, onR: any) =>
        Promise.resolve(
          table === "feature_flags"
            ? { data: { enabled: !!flags[String(eqs.flag)] }, error: null }
            : { data: [], error: null },
        ).then(onF, onR),
    };
    return b;
  }
  return {
    from: builder,
    auth: {
      getUser: async (token: string) =>
        token === TOKEN
          ? { data: { user: { id: VIEWER } }, error: null }
          : { data: { user: null }, error: { message: "invalid" } },
    },
  };
}

let server: http.Server;
let baseUrl = "";

function post(
  path: string,
  body: unknown,
  token: string | null = TOKEN,
): Promise<{ status: number; json: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const payload = Buffer.from(JSON.stringify(body));
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "content-length": String(payload.length),
    };
    if (token) headers.authorization = `Bearer ${token}`;
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: "POST", headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let json: any = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch {
            json = raw;
          }
          resolve({ status: res.statusCode ?? 0, json, headers: res.headers });
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ── The router is actually mounted ───────────────────────────────────────────

describe("wall/telemetry — registration", () => {
  it("POST /wall/telemetry exists in the app's real route tree", async () => {
    // The suites below mount `wallTelemetryRouter` directly, which proves the
    // handler but NOT that anything reaches it. A route file that is never
    // `router.use`d in routes/index.ts is exactly the shape of the original
    // defect: a client POSTing forever into a 404. So walk the aggregate
    // router that app.ts mounts and assert the path is really there.
    const { default: apiRouter } = await import("../routes/index.js");
    const paths: string[] = [];
    const walk = (stack: any[], depth = 0): void => {
      for (const layer of stack) {
        if (layer.route?.path) paths.push(String(layer.route.path));
        else if (layer.handle?.stack && depth < 3) walk(layer.handle.stack, depth + 1);
      }
    };
    walk((apiRouter as any).stack);
    assert.ok(
      paths.includes("/wall/telemetry"),
      "routes/index.ts must mount the Wall telemetry router — the client has always POSTed here",
    );
    // Control: the walker really does find Wall routes, so the assertion above
    // cannot pass or fail for reasons unrelated to registration.
    assert.ok(paths.includes("/wall/impression"));
  });

  it("serves the exact path the client transport posts to", () => {
    // The client's own test for this asserted the URL string against itself
    // (`expect(url).toBe('/api/wall/telemetry')` against the same default it
    // had just passed in), so it stayed green through the entire period when
    // nothing served that path. The only assertion that can catch that is a
    // cross-boundary one: read the CLIENT's default and compare it against
    // where the SERVER actually listens. Both halves must move together.
    const client = readFileSync(CLIENT_TRANSPORT, "utf8");
    const m = client.match(/opts\.path \?\? '([^']+)'/);
    assert.ok(m, "could not read the transport's default path — has it been renamed?");
    assert.equal(
      m![1],
      "/api/wall/telemetry",
      "the client posts somewhere this server does not listen",
    );
  });
});

// ── The allow-list must not drift from the client union ──────────────────────

describe("wall/telemetry — the §32 event set", () => {
  it("matches WallAnalyticsEvent['type'] exactly", () => {
    // Transcribed from travel-buddy-standalone/src/features/wall/services/
    // wallAnalytics.ts. Kept as a literal so the server allow-list and the
    // client union cannot silently diverge — an event the client emits and the
    // server drops is invisible data loss, which is the exact failure this whole
    // route exists to end.
    const CLIENT_UNION = [
      "wall_feed_open",
      "wall_mode_select",
      "wall_impression",
      "wall_action",
      "wall_engagement",
      "wall_live_shown",
      "wall_live_open",
      "wall_context_shown",
      "wall_context_acted",
      "wall_context_ignored",
      "wall_follow_from_feed",
      "wall_handoff",
      "wall_caught_up",
      "wall_not_interested",
      "wall_real_world_outcome",
    ];
    assert.deepEqual([...WALL_TELEMETRY_EVENT_NAMES].sort(), [...CLIENT_UNION].sort());
  });

  it("every allow-listed name is actually reachable through sanitizeWallEvent", () => {
    // A name in the list that no branch can produce would be a dead allow-list
    // entry — the row could never be written and nobody would notice.
    const sample: Record<string, any> = {
      wall_feed_open: { type: "wall_feed_open", mode: "for_you" },
      wall_mode_select: { type: "wall_mode_select", mode: "following" },
      wall_caught_up: { type: "wall_caught_up", mode: "for_you" },
      wall_impression: { type: "wall_impression", objectId: "o1", objectType: "social_post" },
      wall_action: { type: "wall_action", objectId: "o1", objectType: "video", action: "open" },
      wall_engagement: { type: "wall_engagement", objectId: "o1", objectType: "video", kind: "save" },
      wall_live_shown: { type: "wall_live_shown", count: 3 },
      wall_live_open: { type: "wall_live_open", subjectId: "p1", liveObjectType: "hidden_gem" },
      wall_context_shown: { type: "wall_context_shown", kind: "live_place" },
      wall_context_acted: { type: "wall_context_acted", kind: "buddy" },
      wall_context_ignored: { type: "wall_context_ignored", kind: "memory" },
      wall_follow_from_feed: {
        type: "wall_follow_from_feed", objectId: "o1", objectType: "discovery", fromDiscovery: true,
      },
      wall_handoff: { type: "wall_handoff", objectId: "o1", objectType: "postcard", surface: "map" },
      wall_not_interested: { type: "wall_not_interested", objectId: "o1", objectType: "social_post" },
      wall_real_world_outcome: {
        type: "wall_real_world_outcome", objectId: "o1", objectType: "social_post", outcome: "see_place",
      },
    };
    for (const name of WALL_TELEMETRY_EVENT_NAMES) {
      const out = sanitizeWallEvent(sample[name]);
      assert.ok(out, `no sanitizer branch produces ${name}`);
      assert.equal(out!.name, name);
      assert.equal(
        containsDisallowedKey(out!.payload),
        false,
        `${name} builds a payload its own backstop rejects`,
      );
    }
  });
});

// ── The rebuild ───────────────────────────────────────────────────────────────

describe("wall/telemetry — sanitizeWallEvent rebuilds rather than trusts", () => {
  it("drops an unknown event type outright", () => {
    assert.equal(sanitizeWallEvent({ type: "wall_secret_exfil", objectId: "o1" }), null);
    assert.equal(sanitizeWallEvent({ objectId: "o1" }), null);
    assert.equal(sanitizeWallEvent(null), null);
    assert.equal(sanitizeWallEvent(["wall_feed_open"]), null);
  });

  it("does not let an extra field ride along on a known event", () => {
    const out = sanitizeWallEvent({
      type: "wall_impression",
      objectId: "o1",
      objectType: "social_post",
      // Everything below is what §32 forbids. None of it is in the allow-list.
      text: "the private post body",
      lat: 16.05,
      lng: 108.2,
      authorHandle: "@someone",
      user_id: "somebody-else",
    });
    assert.deepEqual(out, {
      name: "wall_impression",
      payload: { objectId: "o1", objectType: "social_post" },
    });
  });

  it("rejects a free-text real-world outcome (§32: coarse enum only)", () => {
    const base = { type: "wall_real_world_outcome", objectId: "o1", objectType: "social_post" };
    assert.equal(sanitizeWallEvent({ ...base, outcome: "went there with Ana at 8pm" }), null);
    assert.ok(sanitizeWallEvent({ ...base, outcome: "book_buddy" }));
  });

  it("rejects an out-of-union enum instead of storing it", () => {
    assert.equal(sanitizeWallEvent({ type: "wall_feed_open", mode: "explore" }), null);
    assert.equal(
      sanitizeWallEvent({ type: "wall_action", objectId: "o", objectType: "t", action: "purchase" }),
      null,
    );
    assert.equal(sanitizeWallEvent({ type: "wall_context_shown", kind: "gossip" }), null);
  });

  it("bounds ids and counts so prose cannot be stored as an id", () => {
    const long = "x".repeat(500);
    assert.equal(
      sanitizeWallEvent({ type: "wall_impression", objectId: long, objectType: "social_post" }),
      null,
    );
    assert.equal(sanitizeWallEvent({ type: "wall_live_shown", count: -1 }), null);
    assert.equal(sanitizeWallEvent({ type: "wall_live_shown", count: "many" }), null);
  });
});

// ── The route ─────────────────────────────────────────────────────────────────

describe("POST /api/wall/telemetry", () => {
  let inserted: Inserted[] = [];

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use((r: any, _res: any, next: any) => {
      r.log = { error() {}, info() {}, warn() {}, debug() {} };
      next();
    });
    app.use("/api", wallTelemetryRouter);
    await new Promise<void>((resolve) => {
      server = http.createServer(app);
      server.listen(0, "127.0.0.1", () => {
        baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        server.unref();
        resolve();
      });
    });
  });

  after(async () => {
    _clearTestClient();
    await new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  });

  beforeEach(() => {
    inserted = [];
    _resetRateLimit();
  });

  it("accepts the batch-of-one envelope the client actually sends", async () => {
    _setTestClient(fakeClient({ wall_enabled: true }, inserted), true);
    // Byte-for-byte the body createWallAnalyticsTransport builds.
    const res = await post("/api/wall/telemetry", {
      events: [{ type: "wall_feed_open", mode: "for_you" }],
    });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.accepted, 1);
    assert.equal(res.json.dropped, 0);
    const write = inserted.find((i) => i.table === "wall_telemetry_events");
    assert.ok(write, "the event must reach wall_telemetry_events");
    assert.equal(write!.rows.length, 1);
    assert.equal(write!.rows[0].event_name, "wall_feed_open");
    assert.deepEqual(write!.rows[0].payload, { mode: "for_you" });
  });

  it("stamps viewer_id from the bearer token, never from the body", async () => {
    _setTestClient(fakeClient({ wall_enabled: true }, inserted), true);
    const res = await post("/api/wall/telemetry", {
      events: [
        {
          type: "wall_handoff",
          objectId: "o1",
          objectType: "postcard",
          surface: "trip",
          viewer_id: "someone-else",
          userId: "someone-else",
        },
      ],
    });
    assert.equal(res.status, 200);
    const row = inserted.find((i) => i.table === "wall_telemetry_events")!.rows[0];
    assert.equal(row.viewer_id, VIEWER, "actor must come from the token");
    assert.deepEqual(row.payload, { objectId: "o1", objectType: "postcard", surface: "trip" });
  });

  it("never stores raw typed content, even when the client sends it", async () => {
    _setTestClient(fakeClient({ wall_enabled: true }, inserted), true);
    const SECRET = "meet me at 8 behind the noodle place";
    const res = await post("/api/wall/telemetry", {
      events: [
        {
          type: "wall_engagement",
          objectId: "o1",
          objectType: "social_post",
          kind: "comment",
          text: SECRET,
          message: SECRET,
          caption: SECRET,
        },
      ],
    });
    assert.equal(res.status, 200);
    const stored = JSON.stringify(inserted);
    assert.ok(!stored.includes(SECRET), "raw content reached the store");
    assert.equal(res.json.accepted, 1);
  });

  it("drops the unknown events in a mixed batch and keeps the rest", async () => {
    _setTestClient(fakeClient({ wall_enabled: true }, inserted), true);
    const res = await post("/api/wall/telemetry", {
      events: [
        { type: "wall_caught_up", mode: "following" },
        { type: "not_a_wall_event", mode: "following" },
        { type: "wall_live_shown", count: 4 },
      ],
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.accepted, 2);
    assert.equal(res.json.dropped, 1);
  });

  it("is dark until wall_enabled is pressed, and says so without erroring", async () => {
    _setTestClient(fakeClient({ wall_enabled: false }, inserted), true);
    const res = await post("/api/wall/telemetry", {
      events: [{ type: "wall_feed_open", mode: "for_you" }],
    });
    assert.equal(res.status, 200, "a disabled flag must never look like a transport failure");
    assert.equal(res.json.enabled, false);
    assert.equal(res.json.accepted, 0);
    assert.equal(
      inserted.filter((i) => i.table === "wall_telemetry_events").length,
      0,
      "nothing may be collected while the Wall is dark",
    );
  });

  it("answers 200 on a write failure so the client does not retry forever", async () => {
    _setTestClient(
      fakeClient({ wall_enabled: true }, inserted, { message: "constraint violation" }),
      true,
    );
    const res = await post("/api/wall/telemetry", {
      events: [{ type: "wall_feed_open", mode: "for_you" }],
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.accepted, 0);
  });

  it("requires authentication", async () => {
    _setTestClient(fakeClient({ wall_enabled: true }, inserted), true);
    const res = await post(
      "/api/wall/telemetry",
      { events: [{ type: "wall_feed_open", mode: "for_you" }] },
      "not-the-token",
    );
    assert.equal(res.status, 401);
    assert.equal(inserted.filter((i) => i.table === "wall_telemetry_events").length, 0);
  });

  it("rejects a malformed envelope", async () => {
    _setTestClient(fakeClient({ wall_enabled: true }, inserted), true);
    const res = await post("/api/wall/telemetry", { nope: true });
    assert.equal(res.status, 400);
  });

  it("rate-limits at the ingest ceiling and sets Retry-After (§37)", async () => {
    _setTestClient(fakeClient({ wall_enabled: true }, inserted), true);
    const { id, limit, windowMs } = WALL_TELEMETRY_RATE_LIMIT;
    // Positive control first: one request under the ceiling is accepted, so a
    // 429 below cannot be an artefact of a bucket that was already full.
    const ok = await post("/api/wall/telemetry", {
      events: [{ type: "wall_feed_open", mode: "for_you" }],
    });
    assert.equal(ok.status, 200);
    // Fill the REST of this viewer's window through the same limiter the route
    // consults — derived from the route's own exported constant, never a literal.
    for (let i = 1; i < limit; i++) checkRateLimit(id, VIEWER, limit, windowMs);
    const res = await post("/api/wall/telemetry", {
      events: [{ type: "wall_feed_open", mode: "for_you" }],
    });
    assert.equal(res.status, 429);
    assert.equal(res.json.error, "rate_limited");
    assert.ok(res.headers["retry-after"], "a 429 must tell the client when to come back");
  });
});
