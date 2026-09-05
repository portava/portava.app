/**
 * GET /passport/:userId/yearbook — the §9 Phase 9 Yearbook endpoint.
 *
 * The yearbook is OWNER-PRIVATE: aggregating a year makes a traveller's shape
 * legible at a glance, and the owner never opted into showing that to anyone
 * else. So this route's contract is:
 *
 *   • no bearer token            → 401 unauthenticated (never an anonymous read)
 *   • the caller's own id / "me" → 200 with the yearbook
 *   • ANY other traveller's id   → { yearbook: null, restricted: true }
 *   • a malformed ?year=         → 400 invalid_payload (never a silent all-years read)
 *   • §31 caching                → `private` static-tier max-age + weak ETag + 304
 *
 * Run: node --import tsx/esm --test src/test/passportYearbookRoute.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { makePassportDb } from "./helpers/fakePassportDb.js";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { PASSPORT_STATIC_MAX_AGE } from "../services/passport/PassportProjectionService.js";
import passportRouter from "../routes/passport.js";

const OWNER = "44444444-4444-4444-8444-444444444444";
const OTHER = "55555555-5555-4555-8555-555555555555";
const T_VN = "trip-yb-vn";

/** Bearer token → user id. The route's requireUser resolves through this. */
const TOKENS: Record<string, string> = {
  "owner-token": OWNER,
  "other-token": OTHER,
};

function db() {
  const client = makePassportDb({
    profiles: [
      { id: OWNER, handle: "yearbookowner", display_name: "Owner", account_status: "active", created_at: "2023-01-01" },
      { id: OTHER, handle: "someoneelse", display_name: "Other", account_status: "active", created_at: "2023-01-01" },
    ],
    trip_members: [{ trip_id: T_VN, user_id: OWNER, role: "owner", status: "accepted" }],
    trips: [
      { id: T_VN, owner_id: OWNER, title: "30 Days in Vietnam", destination_city: "Da Nang", destination_country: "Vietnam", start_date: "2025-03-01", end_date: "2025-03-30", status: "completed", visibility: "public", show_on_profile: true, show_exact_dates: true },
    ],
    passport_memories: [
      { id: "m-yb", user_id: OWNER, status: "active", title: "Beach day", city: "Da Nang", country: "Vietnam", trip_id: T_VN, visibility: "public", earned_at: "2025-03-05" },
    ],
    user_stamps: [
      { id: "s-yb", user_id: OWNER, source_type: "trips", source_id: T_VN, city: "Da Nang", country: "Vietnam", is_revoked: false, earned_at: "2025-03-30", catalog_id: "c-yb", stamp_definitions: { name: "Da Nang", stamp_type: "city" } },
    ],
    passport_stamps: [],
  });
  client.auth = {
    getUser: async (token: string) => {
      const id = TOKENS[token];
      return id ? { data: { user: { id } }, error: null } : { data: { user: null }, error: { message: "bad token" } };
    },
  };
  return client;
}

describe("GET /passport/:userId/yearbook", () => {
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
        const addr = server.address() as { port: number };
        baseUrl = `http://127.0.0.1:${addr.port}`;
        server.unref();
        resolve();
      });
    });
  });

  after(async () => {
    _clearTestClient();
    await new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
  });

  function get(path: string, headers: Record<string, string> = {}) {
    return new Promise<{ status: number; headers: http.IncomingHttpHeaders; json: any }>((resolve, reject) => {
      const url = new URL(baseUrl + path);
      const req = http.request(
        { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: "GET", headers },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c as Buffer));
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let json: any = null;
            try { json = raw ? JSON.parse(raw) : null; } catch { json = raw; }
            resolve({ status: res.statusCode ?? 0, headers: res.headers, json });
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  const asOwner = { authorization: "Bearer owner-token" };
  const asOther = { authorization: "Bearer other-token" };

  it("refuses an anonymous read — a yearbook is never public", async () => {
    const res = await get(`/passport/${OWNER}/yearbook`);
    assert.equal(res.status, 401);
    assert.equal(res.json.error, "unauthenticated");
    assert.equal(res.json.yearbook, undefined);
  });

  it("serves the owner their own yearbook by uuid", async () => {
    const res = await get(`/passport/${OWNER}/yearbook`, asOwner);
    assert.equal(res.status, 200);
    assert.ok(res.json.yearbook, "yearbook body present");
    assert.equal(res.json.yearbook.userId, OWNER);
    assert.equal(res.json.restricted, undefined);
    const y2025 = res.json.yearbook.years.find((y: any) => y.year === 2025);
    assert.ok(y2025, "2025 present");
    assert.ok(y2025.lines.length > 0);
    for (const line of y2025.lines) {
      assert.ok(Array.isArray(line.evidence) && line.evidence.length > 0, `${line.key} unexplained`);
    }
  });

  it("accepts the literal 'me' as the owner's own id", async () => {
    const res = await get(`/passport/me/yearbook`, asOwner);
    assert.equal(res.status, 200);
    assert.equal(res.json.yearbook.userId, OWNER);
  });

  it("withholds another traveller's yearbook from a signed-in viewer", async () => {
    const res = await get(`/passport/${OWNER}/yearbook`, asOther);
    assert.equal(res.status, 200);
    assert.equal(res.json.yearbook, null, "no yearbook body for a non-owner");
    assert.equal(res.json.restricted, true);
    assert.equal(res.json.reason, "owner_private");
    // Nothing about the owner's travel leaks through the refusal.
    const blob = JSON.stringify(res.json);
    assert.ok(!blob.includes("Vietnam"));
    assert.ok(!blob.includes("Beach day"));
    assert.ok(!blob.includes(T_VN));
  });

  it("withholds the owner's yearbook by @handle too — the gate is on identity, not on the id shape", async () => {
    const res = await get(`/passport/yearbookowner/yearbook`, asOther);
    assert.equal(res.status, 200);
    assert.equal(res.json.yearbook, null);
    assert.equal(res.json.restricted, true);
  });

  it("serves a single requested year", async () => {
    const res = await get(`/passport/me/yearbook?year=2025`, asOwner);
    assert.equal(res.status, 200);
    assert.equal(res.json.yearbook.years.length, 1);
    assert.equal(res.json.yearbook.years[0].year, 2025);
  });

  it("returns an honest empty entry for a requested year with nothing in it", async () => {
    const res = await get(`/passport/me/yearbook?year=2019`, asOwner);
    assert.equal(res.status, 200);
    assert.equal(res.json.yearbook.years.length, 1);
    assert.equal(res.json.yearbook.years[0].year, 2019);
    assert.equal(res.json.yearbook.years[0].empty, true);
    assert.deepEqual(res.json.yearbook.years[0].lines, []);
    assert.equal(res.json.yearbook.empty, true);
  });

  it("rejects a malformed year instead of silently serving every year", async () => {
    for (const bad of ["abc", "0", "12", "3000"]) {
      const res = await get(`/passport/me/yearbook?year=${bad}`, asOwner);
      assert.equal(res.status, 400, `year=${bad} must be rejected`);
      assert.equal(res.json.error, "invalid_payload");
    }
  });

  it("caches privately on the static tier and revalidates with an ETag (§31)", async () => {
    const first = await get(`/passport/me/yearbook`, asOwner);
    assert.equal(first.headers["cache-control"], `private, max-age=${PASSPORT_STATIC_MAX_AGE}`);
    assert.match(String(first.headers["etag"]), /^W\/"[0-9a-f]{40}"$/, "weak sha1 ETag");

    const etag = String(first.headers["etag"]);
    const second = await get(`/passport/me/yearbook`, { ...asOwner, "if-none-match": etag });
    assert.equal(second.status, 304);
    assert.equal(second.json, null, "304 carries no body");

    const stale = await get(`/passport/me/yearbook`, { ...asOwner, "if-none-match": 'W/"deadbeef"' });
    assert.equal(stale.status, 200);
    assert.ok(stale.json.yearbook);
  });

  it("404s an unknown traveller rather than inventing an empty yearbook", async () => {
    const res = await get(`/passport/nosuchhandle/yearbook`, asOwner);
    assert.equal(res.status, 404);
    assert.equal(res.json.error, "not_found");
  });
});
