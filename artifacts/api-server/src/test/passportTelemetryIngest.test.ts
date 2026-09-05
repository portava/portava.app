/**
 * POST /api/passport/telemetry — the §32 client telemetry ingest route.
 *
 * WHAT THIS PROVES
 * ================
 * The app's live §32 sink (`features/passport/passportTelemetryTransport.ts`,
 * installed at `app/_layout.tsx:127`) has been POSTing batches to
 * `/api/passport/telemetry` with no route mounted at that path — every batch
 * 404'd and was dropped by the transport's own 404 branch. These tests are the
 * contract for the route that closes it:
 *
 *   1. an anonymous batch is rejected 401 — telemetry is never anonymous ingest;
 *   2. a canonical batch is accepted and lands one row per event;
 *   3. the ACTOR comes from the bearer token, and a forged `actor_id` in the
 *      body cannot overwrite it (a client must not be able to attribute an
 *      event to another traveller);
 *   4. a non-canonical event name is rejected, not stored as "unknown";
 *   5. the payload goes through the SAME allow-list every server emitter uses,
 *      so a coordinate- or identity-shaped key cannot reach the store even
 *      though the client is the one that sent it;
 *   6. the client's camelCase keys land under the store's vocabulary rather
 *      than being projected away to {};
 *   7. the flag is still the collection decision: with
 *      `passport_telemetry_enabled` OFF nothing is written, and the route still
 *      answers 202.
 *
 * MUTATION PROOFS (each performed, each RED):
 *   • delete the whole `router.post("/passport/telemetry", …)` block → every
 *     test 404s;
 *   • move `actorId: user.id` before the payload spread in recordPassportEvent
 *     (i.e. let the body win) → the forged-actor test goes RED;
 *   • drop the `normalizeClientPayload` call → the vocabulary test goes RED;
 *   • remove the `PASSPORT_TELEMETRY_EVENTS.includes` guard → the
 *     non-canonical-name test goes RED.
 *
 * Run: node --import tsx/esm --test src/test/passportTelemetryIngest.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import passportRouter from "../routes/passport.js";
import {
  ALLOWED_PAYLOAD_KEYS,
  FORBIDDEN_KEY_FRAGMENTS,
  PASSPORT_TELEMETRY_FLAG,
  sanitizePassportPayload,
} from "../lib/passportTelemetry.js";

const CALLER = "77777777-7777-4777-8777-777777777777";
const OTHER = "88888888-8888-4888-8888-888888888888";

const TOKENS: Record<string, string> = { "caller-token": CALLER };

let inserted: Array<Record<string, any>> = [];
let flagEnabled = true;

/** Minimal service-client surface: the flag read + the telemetry insert. */
function db() {
  const client: any = {
    from(table: string) {
      const b: any = {
        select() { return b; },
        eq() { return b; },
        insert(row: any) { if (table === "passport_telemetry_events") inserted.push(row); return b; },
        maybeSingle: async () =>
          table === "feature_flags"
            ? { data: { enabled: flagEnabled }, error: null }
            : { data: null, error: null },
        then: (onF: any, onR: any) => Promise.resolve({ data: [], error: null }).then(onF, onR),
      };
      return b;
    },
    auth: {
      getUser: async (token: string) => {
        const id = TOKENS[token];
        return id ? { data: { user: { id } }, error: null } : { data: { user: null }, error: { message: "bad token" } };
      },
    },
  };
  return client;
}

describe("POST /passport/telemetry — §32 client ingest", () => {
  let server: http.Server;
  let baseUrl = "";

  before(async () => {
    _setTestClient(db(), true);
    const app = express();
    app.use(express.json());
    app.use((req: any, _res: any, next: any) => { req.log = { error: () => {}, info: () => {}, warn: () => {} }; next(); });
    app.use("/", passportRouter);
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
    await new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
  });

  beforeEach(() => { inserted = []; flagEnabled = true; });

  function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    return new Promise<{ status: number; json: any }>((resolve, reject) => {
      const raw = JSON.stringify(body);
      const url = new URL(baseUrl + path);
      const req = http.request(
        {
          hostname: url.hostname, port: url.port, path: url.pathname, method: "POST",
          headers: { "content-type": "application/json", "content-length": Buffer.byteLength(raw), ...headers },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c as Buffer));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let json: any = null;
            try { json = text ? JSON.parse(text) : null; } catch { json = text; }
            resolve({ status: res.statusCode ?? 0, json });
          });
        },
      );
      req.on("error", reject);
      req.end(raw);
    });
  }

  const asCaller = { authorization: "Bearer caller-token" };

  const batch = (events: any[]) => ({ schemaVersion: "1", events, meta: { dropped: 0 } });

  it("is mounted at all — a canonical batch is accepted and stored", async () => {
    const r = await post(
      "/passport/telemetry",
      batch([{ name: "passport_viewed", ts: 1, seq: 1, payload: { subjectId: OTHER } }]),
      asCaller,
    );
    assert.equal(r.status, 202, "a 404 here means the route is not mounted — the original defect");
    assert.equal(r.json.accepted, 1);
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0].event_name, "passport_viewed");
  });

  it("refuses an anonymous batch (401) — telemetry ingest is never open", async () => {
    const r = await post("/passport/telemetry", batch([{ name: "passport_viewed", payload: {} }]));
    assert.equal(r.status, 401);
    assert.equal(inserted.length, 0);

    // POSITIVE CONTROL: the identical batch WITH a token is accepted, so the
    // 401 above is the auth gate and not a malformed body.
    const ok = await post("/passport/telemetry", batch([{ name: "passport_viewed", payload: {} }]), asCaller);
    assert.equal(ok.status, 202);
    assert.equal(inserted.length, 1);
  });

  it("stamps the actor from the token and ignores a forged actor_id in the body", async () => {
    await post(
      "/passport/telemetry",
      batch([{ name: "passport_viewed", payload: { actor_id: OTHER, subjectId: OTHER } }]),
      asCaller,
    );
    assert.equal(inserted.length, 1);
    assert.equal(
      inserted[0].payload.actor_id,
      CALLER,
      "the body's actor_id must never win — that would let a client attribute an event to someone else",
    );
    assert.equal(inserted[0].payload.subject_id, OTHER, "the subject still rides through");
  });

  it("rejects a non-canonical event name instead of storing it", async () => {
    const r = await post(
      "/passport/telemetry",
      batch([
        { name: "totally_made_up", payload: {} },
        { name: "stamp_viewed", payload: { stampId: "s-1", kind: "city", verification: "verified" } },
      ]),
      asCaller,
    );
    assert.equal(r.status, 202);
    assert.equal(r.json.accepted, 1);
    assert.equal(r.json.rejected, 1);
    assert.deepEqual(inserted.map((i) => i.event_name), ["stamp_viewed"]);
  });

  it("puts a client payload through the same allow-list as a server emitter", async () => {
    await post(
      "/passport/telemetry",
      batch([{
        name: "my_world_opened",
        payload: {
          // Every one of these must be gone: coordinate- and identity-shaped
          // keys, and anything simply outside the allow-list.
          lat: 16.06, lng: 108.22, display_name: "Real Name", email: "a@b.c",
          device_id: "dev-1", countryCount: 4, cityCount: 9,
          // These two ARE allow-listed and must survive.
          city: "Da Nang", country: "Vietnam",
        },
      }]),
      asCaller,
    );
    assert.equal(inserted.length, 1);
    const p = inserted[0].payload;
    for (const forbidden of ["lat", "lng", "display_name", "email", "device_id", "countryCount", "cityCount"]) {
      assert.ok(!(forbidden in p), `${forbidden} reached the telemetry store`);
    }
    assert.equal(p.city, "Da Nang");
    assert.equal(p.country, "Vietnam");
    assert.equal(p.surface, "client", "client provenance is recorded");
  });

  it("translates the client's key vocabulary instead of projecting it away", async () => {
    await post(
      "/passport/telemetry",
      batch([{
        name: "stamp_viewed",
        payload: { subjectId: OTHER, kind: "city", verification: "verified", viewerContext: "public" },
      }]),
      asCaller,
    );
    const p = inserted[0].payload;
    assert.equal(p.stamp_type, "city", "`kind` must land as stamp_type, not be dropped");
    assert.equal(p.viewer_tier, "public", "`viewerContext` must land as viewer_tier");
    assert.equal(p.verification, "verified");
    assert.equal(p.subject_id, OTHER);
  });

  it("writes nothing when passport_telemetry_enabled is OFF, and still answers 202", async () => {
    flagEnabled = false;
    const r = await post("/passport/telemetry", batch([{ name: "passport_viewed", payload: {} }]), asCaller);
    assert.equal(r.status, 202, "telemetry must never fail a Passport screen");
    assert.equal(inserted.length, 0, "the flag is the collection decision, fail-closed");

    // POSITIVE CONTROL: the same batch with the flag ON does write.
    flagEnabled = true;
    await post("/passport/telemetry", batch([{ name: "passport_viewed", payload: {} }]), asCaller);
    assert.equal(inserted.length, 1);
  });

  it("gates on the same flag name the emitter does", () => {
    // The route spells the flag as a LITERAL so check:flag-polarity can resolve
    // it statically. This is what stops the literal and the exported constant
    // drifting apart into two different gates.
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "../routes/passport.ts"),
      "utf8",
    );
    const call = src.slice(src.indexOf('router.post("/passport/telemetry"'));
    assert.ok(
      call.includes(`isFlagEnabled(sc, "${PASSPORT_TELEMETRY_FLAG}")`),
      `the ingest route must gate on "${PASSPORT_TELEMETRY_FLAG}" as a literal`,
    );
  });

  it("rejects a malformed batch with 400 rather than storing a partial one", async () => {
    const r = await post("/passport/telemetry", { schemaVersion: "2", events: [] }, asCaller);
    assert.equal(r.status, 400);
    assert.equal(inserted.length, 0);
  });
});

/**
 * The allow-list and the forbidden-fragment strip are two gates on the SAME
 * key, run in that order (strip first, allow-list second), and the database
 * runs a third with the same fragment list. A key that appears in the allow-list
 * but contains a forbidden fragment is therefore unwritable — it reads as a
 * permitted field and is silently deleted by the gate above it.
 *
 * `viewer_relationship` was exactly that: "re-LAT-ionship" contains `lat`. It
 * has been renamed to `viewer_tier`; this test is what stops the next one.
 */
describe("passportTelemetry allow-list — every permitted key is actually writable", () => {
  const MIGRATION = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../migrations/2287_passport_telemetry_events.sql",
  );

  /** The fragment list the DATABASE checks, read out of migration 2287. */
  function dbFragments(): string[] {
    const sql = fs.readFileSync(MIGRATION, "utf8");
    const m = /SIMILAR TO\s*\n?\s*'%\(([^)]+)\)%'/.exec(sql);
    assert.ok(m, "could not read the payload-clean fragment list from migration 2287");
    return m[1].split("|").map((s) => s.trim());
  }

  it("no allow-listed key contains a forbidden fragment (the emitter's own gate)", () => {
    for (const key of ALLOWED_PAYLOAD_KEYS) {
      const hit = FORBIDDEN_KEY_FRAGMENTS.find((f) => key.toLowerCase().includes(f));
      assert.equal(
        hit,
        undefined,
        `allow-listed key '${key}' contains forbidden fragment '${hit}' — the strip ` +
          `runs BEFORE the allow-list, so this key can never be persisted`,
      );
    }
  });

  it("no allow-listed key would be rejected by the database CHECK either", () => {
    const fragments = dbFragments();
    for (const key of ALLOWED_PAYLOAD_KEYS) {
      const hit = fragments.find((f) => key.toLowerCase().includes(f));
      assert.equal(
        hit,
        undefined,
        `allow-listed key '${key}' matches DB fragment '${hit}' — ` +
          `passport_telemetry_payload_is_clean would reject the row 23514`,
      );
    }
  });

  it("every allow-listed key actually survives sanitizePassportPayload", () => {
    const probe = Object.fromEntries(ALLOWED_PAYLOAD_KEYS.map((k) => [k, `v-${k}`]));
    const out = sanitizePassportPayload(probe);
    assert.deepEqual(
      ALLOWED_PAYLOAD_KEYS.filter((k) => !(k in out)),
      [],
      "an allow-listed key was dropped by the sanitizer",
    );
  });
});
