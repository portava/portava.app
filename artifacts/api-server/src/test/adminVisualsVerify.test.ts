/**
 * Admin visuals — verify endpoint tests
 *
 * Routes under test:
 *   POST /admin/visuals/:id/verify       — marks a visual verified (sets accepted_at)
 *   GET  /admin/visuals/pending-review   — returns place visuals with accepted_at IS NULL
 *
 * Source: artifacts/api-server/src/routes/adminVisuals.ts
 *
 * Invariants tested:
 *   1. After verifying a place visual, re-fetching the pending-review list no
 *      longer includes that visual (accepted_at filter excludes it).
 *   2. A DB error on the update is surfaced as a non-2xx response — the endpoint
 *      does not silently return 200 when the write failed.
 *
 * Run: node --import tsx/esm --test src/test/adminVisualsVerify.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import adminVisualsRouter from "../routes/adminVisuals.js";

// ── Constants ──────────────────────────────────────────────────────────────────

const ADMIN_USER_ID = "aaaaaaaa-2608-0000-0001-000000000001";
const VISUAL_ID     = "bbbbbbbb-2608-0000-0001-000000000001";
const PLACE_ID      = "cccccccc-2608-0000-0001-000000000001";

// ── Test server ────────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

before(async () => {
  const app = express();
  app.use(express.json());
  // Shim req.log — adminVisuals doesn't use it but asyncHandler may log errors
  app.use((r: any, _res: any, next: any) => {
    r.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    next();
  });
  app.use(adminVisualsRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(() => server.close());

// ── Request helper ─────────────────────────────────────────────────────────────

function req(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url     = new URL(path, base);
    const payload = body ? JSON.stringify(body) : undefined;
    const r = http.request(
      {
        hostname: url.hostname,
        port:     Number(url.port),
        path:     url.pathname + url.search,
        method,
        headers: {
          "content-type":  "application/json",
          "authorization": "Bearer fake-admin-token",
        },
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

// ── Fake client factory ────────────────────────────────────────────────────────
//
// opts.updateError: when true the generated_visuals UPDATE returns a DB error.

function makeFakeClient(opts: { updateError?: boolean } = {}) {
  const { updateError = false } = opts;

  // Mutable row — shared between the verify POST and the pending-review GET so
  // the state mutation done by POST is visible to the subsequent GET.
  const visualRow: Record<string, any> = {
    id:                VISUAL_ID,
    entity_type:       "place",
    entity_id:         PLACE_ID,
    purpose:           "header",
    status:            "ready",
    style:             "vivid",
    source_image_url:  null,
    thumbnail_path:    null,
    card_path:         null,
    hero_path:         null,
    moderation_status: null,
    attempt_count:     1,
    generated_at:      "2025-01-01T00:00:00.000Z",
    created_at:        "2025-01-01T00:00:00.000Z",
    accepted_at:       null,
  };

  const db: Record<string, any[]> = {
    profiles: [
      { id: ADMIN_USER_ID, role: "admin", display_name: "Test Admin", username: null, handle: null },
    ],
    feature_flags: [
      { flag: "ai_visual_admin_review_enabled", enabled: true },
    ],
    generated_visuals: [visualRow],
    discovery_places: [
      { id: PLACE_ID, name: "Test Place", category: "cafe" },
    ],
  };

  function chain(tableName: string) {
    // Each chain() call gets its own working set, but mutations go back to the
    // shared visualRow so that a subsequent chain() call sees them.
    const allRows: any[] = db[tableName] ?? [];
    let filters: Array<(r: any) => boolean> = [];
    let pendingUpdate: Record<string, any> | null = null;
    let countRequested = false;

    const b: any = {
      select(_cols?: string, opts?: any) {
        if (opts && (opts as any).count === "exact") countRequested = true;
        return b;
      },
      update(patch: Record<string, any>) {
        pendingUpdate = patch;
        return b;
      },
      eq(col: string, val: any) {
        filters.push((r: any) => r[col] === val);
        return b;
      },
      neq(col: string, val: any) {
        filters.push((r: any) => r[col] !== val);
        return b;
      },
      is(col: string, val: any) {
        filters.push((r: any) =>
          val === null ? r[col] == null : r[col] === val,
        );
        return b;
      },
      in(col: string, vals: any[]) {
        filters.push((r: any) => vals.includes(r[col]));
        return b;
      },
      order() { return b; },
      range() { return b; },
      limit() { return b; },
      maybeSingle() {
        const matched = allRows.filter((r: any) => filters.every((f) => f(r)));
        if (pendingUpdate !== null) {
          if (updateError) {
            return Promise.resolve({ data: null, error: { message: "simulated DB write error" } });
          }
          // Apply the patch to the first matched row in-place so the shared
          // visualRow sees the update on the next chain() call.
          const target = matched[0];
          if (target) Object.assign(target, pendingUpdate);
          const result = target ? { ...target } : null;
          return Promise.resolve({ data: result, error: null });
        }
        return Promise.resolve({ data: matched[0] ?? null, error: null });
      },
      then(onF: any, onR: any) {
        const matched = allRows.filter((r: any) => filters.every((f) => f(r)));
        if (pendingUpdate !== null) {
          if (updateError) {
            return Promise.resolve({ data: null, error: { message: "simulated DB write error" } }).then(onF, onR);
          }
          for (const target of matched) Object.assign(target, pendingUpdate);
          return Promise.resolve({ data: matched.map((r: any) => ({ ...r })), error: null }).then(onF, onR);
        }
        const result = { data: matched.map((r: any) => ({ ...r })), error: null, count: matched.length };
        return Promise.resolve(result).then(onF, onR);
      },
    };
    return b;
  }

  const fakeClient = {
    from: (tableName: string) => chain(tableName),
    auth: {
      getUser: (_token?: string) =>
        Promise.resolve({ data: { user: { id: ADMIN_USER_ID } }, error: null }),
    },
  };

  return fakeClient;
}

function setClient(client: ReturnType<typeof makeFakeClient>) {
  _setTestClient(client as any, true);
  _setTestServiceClient(client as any);
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("POST /admin/visuals/:id/verify → GET /admin/visuals/pending-review", () => {
  it("removes a verified visual from the pending-review list", async () => {
    setClient(makeFakeClient());

    // 1. Confirm the visual is in the pending list before verification.
    const before = await req("GET", "/admin/visuals/pending-review");
    assert.equal(
      before.status, 200,
      `Expected 200 from pending-review, got ${before.status}: ${JSON.stringify(before.body)}`,
    );
    const beforeVisuals: any[] = before.body.visuals ?? [];
    const inQueue = beforeVisuals.some((v: any) => v.id === VISUAL_ID);
    assert.ok(
      inQueue,
      `Expected VISUAL_ID to be in the pending-review list before verification, got: ${JSON.stringify(beforeVisuals.map((v: any) => v.id))}`,
    );

    // 2. Verify the visual.
    const verify = await req("POST", `/admin/visuals/${VISUAL_ID}/verify`);
    assert.equal(
      verify.status, 200,
      `Expected 200 from verify, got ${verify.status}: ${JSON.stringify(verify.body)}`,
    );
    assert.ok(
      verify.body.visual?.verifiedAt,
      `Expected verifiedAt to be set after verification, got: ${JSON.stringify(verify.body)}`,
    );

    // 3. Re-fetch the pending list — the verified visual must be absent.
    const after = await req("GET", "/admin/visuals/pending-review");
    assert.equal(
      after.status, 200,
      `Expected 200 from pending-review after verification, got ${after.status}: ${JSON.stringify(after.body)}`,
    );
    const afterVisuals: any[] = after.body.visuals ?? [];
    const stillInQueue = afterVisuals.some((v: any) => v.id === VISUAL_ID);
    assert.ok(
      !stillInQueue,
      `Expected VISUAL_ID to be absent from pending-review after verification, but it was still present`,
    );
  });
});

describe("POST /admin/visuals/:id/verify — DB error handling", () => {
  it("returns a non-2xx response when the DB update fails — does not silently succeed", async () => {
    setClient(makeFakeClient({ updateError: true }));

    const result = await req("POST", `/admin/visuals/${VISUAL_ID}/verify`);
    assert.ok(
      result.status >= 400,
      `Expected a non-2xx status when the DB update errors, got ${result.status}: ${JSON.stringify(result.body)}`,
    );
    // The body must carry an error field so callers can distinguish the failure.
    assert.ok(
      result.body.error,
      `Expected an error field in the response body, got: ${JSON.stringify(result.body)}`,
    );
  });
});
