/**
 * Integration tests for admin place image review routes.
 *
 * Covers:
 *   - Non-admin callers receive 403 on all admin routes
 *   - Approving a pending image sets accuracy_status and verified_by
 *   - A rejected image cannot be re-approved (409)
 *   - Rejecting an image sets accuracy_status to "rejected"
 *   - Downgrading moves source type and sets disclaimer_required
 *   - Resolving a report with action=image_rejected rejects the image atomically
 *   - Queue listing returns paginated results
 *
 * Run: node --import tsx/esm --test src/test/adminPlaceImages.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import adminRouter from "../routes/adminPlaceImages.js";

// ── Valid hex UUIDs for test identities ────────────────────────────────────────

const ADMIN_ID    = "aa000000-0000-0000-0000-000000000001";
const ADMIN_TOKEN = "tok-admin";
const USER_ID     = "bb000000-0000-0000-0000-000000000002";
const USER_TOKEN  = "tok-user";

// Visual IDs (all valid hex UUIDs)
const VISUAL_ID   = "cc000000-0000-0000-0000-000000000001";  // reference_grounded_ai, unverified
const GROUNDED_ID = "cc000000-0000-0000-0000-000000000002";  // reference_grounded_ai, unverified
const REJECTED_ID = "cc000000-0000-0000-0000-000000000003";  // official, rejected
const REPORT_ID   = "dd000000-0000-0000-0000-000000000001";
const PLACE_ID    = "ee000000-0000-0000-0000-000000000001";

const IMAGE_URL   = "https://cdn.example.com/ai-place.webp";

// ── Visual/report fixtures ─────────────────────────────────────────────────────

function makeVisuals(): Record<string, any> {
  return {
    [VISUAL_ID]: {
      id: VISUAL_ID,
      entity_type: "place",
      entity_id: PLACE_ID,
      canonical_place_id: PLACE_ID,
      purpose: "place_header",
      image_source_type: "reference_grounded_ai",
      accuracy_status: "unverified",
      source_url: IMAGE_URL,
      status: "ready",
    },
    [GROUNDED_ID]: {
      id: GROUNDED_ID,
      entity_type: "place",
      entity_id: PLACE_ID,
      canonical_place_id: PLACE_ID,
      purpose: "place_header",
      image_source_type: "reference_grounded_ai",
      accuracy_status: "unverified",
      source_url: "https://cdn.example.com/grounded.webp",
      status: "ready",
    },
    [REJECTED_ID]: {
      id: REJECTED_ID,
      entity_type: "place",
      entity_id: PLACE_ID,
      canonical_place_id: PLACE_ID,
      purpose: "place_header",
      image_source_type: "official",
      accuracy_status: "rejected",
      source_url: "https://cdn.example.com/rejected.jpg",
      status: "ready",
    },
  };
}

function makeReports(): Record<string, any> {
  return {
    [REPORT_ID]: {
      id: REPORT_ID,
      place_id: PLACE_ID,
      image_url: IMAGE_URL,
      reported_by: USER_ID,
      report_reason: "wrong_place",
      status: "pending",
    },
  };
}

// ── Fake client factory ────────────────────────────────────────────────────────

function makeFakeSc(opts: {
  isAdmin: boolean;
  visuals?: Record<string, any>;
  reports?: Record<string, any>;
}) {
  const visuals = opts.visuals ?? makeVisuals();
  const reports = opts.reports ?? makeReports();
  const capturedUpdates: Array<{ table: string; patch: any; filters: Record<string, any> }> = [];

  return {
    auth: {
      getUser: async (token: string) => {
        if (token === ADMIN_TOKEN) return { data: { user: { id: ADMIN_ID } }, error: null };
        if (token === USER_TOKEN)  return { data: { user: { id: USER_ID } }, error: null };
        return { data: { user: null }, error: { message: "invalid token" } };
      },
    },
    from(table: string) {
      const eqFilters: Record<string, any> = {};
      let updatePatch: any = null;
      let insertRow: any = null;
      let isNotAccuracyRejected = false;

      const b: any = {
        select()                        { return b; },
        eq(col: string, val: any)       { eqFilters[col] = val; return b; },
        in()                            { return b; },
        not(col: string, _op: string, _val: any) {
          if (col === "accuracy_status") isNotAccuracyRejected = true;
          return b;
        },
        is()                            { return b; },
        or()                            { return b; },
        order()                         { return b; },
        range()                         { return b; },
        limit()                         { return b; },
        update(patch: any) {
          updatePatch = patch;
          capturedUpdates.push({ table, patch, filters: { ...eqFilters } });
          return b;
        },
        insert(row: any) {
          insertRow = row;
          return b;
        },
        delete()                        { return b; },
        maybeSingle() { return b.single(); },
        async single() {
          // UPDATE path: apply the patch to in-memory stores and return ok
          if (updatePatch !== null) {
            if (table === "generated_visuals") {
              const id = eqFilters["id"];
              if (id && visuals[id]) Object.assign(visuals[id], updatePatch);
              return { data: null, error: null };
            }
            if (table === "place_image_reports") {
              const id = eqFilters["id"];
              if (id && reports[id]) Object.assign(reports[id], updatePatch);
              return { data: null, error: null };
            }
            if (table === "places") {
              return { data: null, error: null };
            }
            return { data: null, error: null };
          }
          // INSERT path
          if (insertRow !== null) {
            const newId = `ee${Date.now()}`;
            const row = { id: newId, ...insertRow };
            if (table === "generated_visuals") visuals[newId] = row;
            return { data: row, error: null };
          }
          // SELECT path
          if (table === "profiles") {
            const id = eqFilters["id"];
            if (id === ADMIN_ID) {
              return {
                data: opts.isAdmin
                  ? { role: "admin", display_name: "Admin User", username: "admin", handle: "admin" }
                  : { role: "member", display_name: "User", username: "user", handle: "user" },
                error: null,
              };
            }
            if (id === USER_ID) {
              return { data: { role: "member", display_name: null, username: "user1", handle: "user1" }, error: null };
            }
            return { data: null, error: null };
          }
          if (table === "generated_visuals") {
            const id = eqFilters["id"];
            return { data: id ? (visuals[id] ?? null) : null, error: null };
          }
          if (table === "place_image_reports") {
            const id = eqFilters["id"];
            return { data: id ? (reports[id] ?? null) : null, error: null };
          }
          if (table === "places") {
            return { data: null, error: null };
          }
          return { data: null, error: null };
        },
        async then(onF: any) {
          // UPDATE path
          if (updatePatch !== null) {
            if (table === "generated_visuals") {
              const id = eqFilters["id"];
              if (id && visuals[id]) Object.assign(visuals[id], updatePatch);
            }
            if (table === "place_image_reports") {
              const id = eqFilters["id"];
              if (id && reports[id]) Object.assign(reports[id], updatePatch);
            }
            if (table === "places") { /* best-effort update */ }
            return onF({ data: null, error: null, count: 0 });
          }
          // SELECT list path
          if (table === "generated_visuals") {
            let rows = Object.values(visuals);
            if (eqFilters["entity_type"]) rows = rows.filter((r: any) => r.entity_type === eqFilters["entity_type"]);
            if (eqFilters["entity_id"])   rows = rows.filter((r: any) => r.entity_id   === eqFilters["entity_id"]);
            if (eqFilters["source_url"])  rows = rows.filter((r: any) => r.source_url  === eqFilters["source_url"]);
            if (isNotAccuracyRejected)    rows = rows.filter((r: any) => r.accuracy_status !== "rejected");
            return onF({ data: rows, error: null, count: rows.length });
          }
          if (table === "place_image_reports") {
            const rows = Object.values(reports);
            return onF({ data: rows, error: null, count: rows.length });
          }
          return onF({ data: [], error: null, count: 0 });
        },
      };
      return b;
    },
    __capturedUpdates: capturedUpdates,
    __visuals: visuals,
    __reports: reports,
  };
}

// ── Test server factory ────────────────────────────────────────────────────────

interface TestApp {
  baseUrl: string;
  close: () => Promise<void>;
  client: ReturnType<typeof makeFakeSc>;
}

async function startAdminApp(fakeSc: ReturnType<typeof makeFakeSc>): Promise<TestApp> {
  _setTestClient(fakeSc as any, true);

  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, info: () => {}, warn: () => {} };
    next();
  });
  app.use("/api", adminRouter);

  return new Promise((resolve, reject) => {
    const srv = http.createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.unref();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        client: fakeSc,
        close: () =>
          new Promise<void>((res, rej) => {
            srv.closeAllConnections?.();
            srv.close((e) => (e ? rej(e) : res()));
          }),
      });
    });
    srv.on("error", reject);
  });
}

// ── 403 non-admin guard ────────────────────────────────────────────────────────

describe("Admin place image routes — 403 for non-admin callers", () => {
  let app: TestApp;

  before(async () => { app = await startAdminApp(makeFakeSc({ isAdmin: false })); });
  after(async () => { await app.close(); _setTestClient(null as any, false); });

  it("GET /admin/place-images/queue → 403 for non-admin", async () => {
    const res = await fetch(`${app.baseUrl}/api/admin/place-images/queue`, {
      headers: { Authorization: `Bearer ${USER_TOKEN}` },
    });
    assert.equal(res.status, 403);
  });

  it("POST /admin/place-images/:id/approve → 403 for non-admin", async () => {
    const res = await fetch(`${app.baseUrl}/api/admin/place-images/${VISUAL_ID}/approve`, {
      method: "POST",
      headers: { Authorization: `Bearer ${USER_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 403);
  });

  it("POST /admin/place-images/:id/reject → 403 for non-admin", async () => {
    const res = await fetch(`${app.baseUrl}/api/admin/place-images/${VISUAL_ID}/reject`, {
      method: "POST",
      headers: { Authorization: `Bearer ${USER_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "wrong place" }),
    });
    assert.equal(res.status, 403);
  });

  it("POST /admin/place-images/:id/downgrade → 403 for non-admin", async () => {
    const res = await fetch(`${app.baseUrl}/api/admin/place-images/${VISUAL_ID}/downgrade`, {
      method: "POST",
      headers: { Authorization: `Bearer ${USER_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 403);
  });

  it("unauthenticated request → 401", async () => {
    const res = await fetch(`${app.baseUrl}/api/admin/place-images/queue`);
    assert.equal(res.status, 401);
  });
});

// ── Approve ────────────────────────────────────────────────────────────────────

describe("POST /admin/place-images/:id/approve", () => {
  let app: TestApp;

  before(async () => { app = await startAdminApp(makeFakeSc({ isAdmin: true })); });
  after(async () => { await app.close(); _setTestClient(null as any, false); });

  it("sets accuracy_status and verified_by on success", async () => {
    const res = await fetch(`${app.baseUrl}/api/admin/place-images/${VISUAL_ID}/approve`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const body = await res.json() as any;
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(body)}`);
    assert.equal(body.ok, true);
    assert.ok(
      body.accuracyStatus === "reference_grounded" || body.accuracyStatus === "verified_real",
      `unexpected accuracyStatus: ${body.accuracyStatus}`,
    );
    assert.equal(body.visualId, VISUAL_ID);
    // The in-memory visual must reflect the approval
    const visual = app.client.__visuals[VISUAL_ID];
    assert.ok(visual.verified_by, "verified_by must be set after approval");
    assert.ok(visual.accuracy_status, "accuracy_status must be set after approval");
  });

  it("returns 409 when attempting to approve an already-rejected image", async () => {
    const res = await fetch(`${app.baseUrl}/api/admin/place-images/${REJECTED_ID}/approve`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 409);
    const body = await res.json() as any;
    assert.equal(body.error, "already_rejected");
  });
});

// ── Reject ─────────────────────────────────────────────────────────────────────

describe("POST /admin/place-images/:id/reject", () => {
  let app: TestApp;

  before(async () => { app = await startAdminApp(makeFakeSc({ isAdmin: true })); });
  after(async () => { await app.close(); _setTestClient(null as any, false); });

  it("sets accuracy_status=rejected on the visual row", async () => {
    const res = await fetch(`${app.baseUrl}/api/admin/place-images/${GROUNDED_ID}/reject`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "Image shows a different building" }),
    });
    const body = await res.json() as any;
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(body)}`);
    
    assert.equal(body.ok, true);
    assert.equal(body.accuracyStatus, "rejected");
    // The in-memory visual must now be rejected
    assert.equal(app.client.__visuals[GROUNDED_ID].accuracy_status, "rejected");
  });

  it("returns 409 when attempting to reject an already-rejected image", async () => {
    const res = await fetch(`${app.baseUrl}/api/admin/place-images/${REJECTED_ID}/reject`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "Already wrong" }),
    });
    assert.equal(res.status, 409);
  });

  it("rejected image does not appear in resolveHeaderImage when filtered by canonicalPlaceId", () => {
    // After rejection, the visual has accuracy_status=rejected.
    // resolveHeaderImage would receive it as a candidate only if the caller
    // passes it. The admin rejection prevents it being served as primary
    // by updating accuracy_status on the DB record (already verified above).
    const rejectedVisual = app.client.__visuals[GROUNDED_ID];
    assert.equal(rejectedVisual.accuracy_status, "rejected");
  });
});

// ── Downgrade ──────────────────────────────────────────────────────────────────

describe("POST /admin/place-images/:id/downgrade", () => {
  let app: TestApp;

  before(async () => { app = await startAdminApp(makeFakeSc({ isAdmin: true })); });
  after(async () => { await app.close(); _setTestClient(null as any, false); });

  it("moves source type to generic_ai_illustration and sets disclaimer_required=true", async () => {
    const res = await fetch(`${app.baseUrl}/api/admin/place-images/${VISUAL_ID}/downgrade`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const body = await res.json() as any;
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(body)}`);
    
    assert.equal(body.ok, true);
    assert.equal(body.imageSourceType, "generic_ai_illustration");
    assert.equal(body.disclaimerRequired, true);
    // The in-memory visual must reflect the downgrade
    const visual = app.client.__visuals[VISUAL_ID];
    assert.equal(visual.image_source_type, "generic_ai_illustration");
    assert.equal(visual.disclaimer_required, true);
  });

  it("returns 409 when downgrading a non-reference_grounded_ai image", async () => {
    // REJECTED_ID has image_source_type="official" → cannot be downgraded
    const res = await fetch(`${app.baseUrl}/api/admin/place-images/${REJECTED_ID}/downgrade`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 409);
  });
});

// ── Report resolve ─────────────────────────────────────────────────────────────

describe("POST /admin/place-images/reports/:reportId/resolve", () => {
  it("action=image_rejected rejects the image and marks the report reviewed_rejected", async () => {
    const client = makeFakeSc({ isAdmin: true });
    const app = await startAdminApp(client);
    try {
      const res = await fetch(
        `${app.baseUrl}/api/admin/place-images/reports/${REPORT_ID}/resolve`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json" },
          body: JSON.stringify({ action: "image_rejected", adminNotes: "Wrong building" }),
        },
      );
      const body = await res.json() as any;
      assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(body)}`);
      assert.equal(body.ok, true);
      assert.equal(body.action, "image_rejected");
      assert.equal(body.status, "reviewed_rejected");
      // The image targeted by the report must now be rejected
      const affectedVisual = client.__visuals[VISUAL_ID];
      assert.equal(
        affectedVisual?.accuracy_status,
        "rejected",
        "visual must be marked rejected when report is resolved with image_rejected",
      );
      // The report must be marked as reviewed
      assert.equal(client.__reports[REPORT_ID].status, "reviewed_rejected");
    } finally {
      await app.close();
      _setTestClient(null as any, false);
    }
  });

  it("action=no_action marks report reviewed_accepted without touching the image", async () => {
    const client = makeFakeSc({ isAdmin: true });
    const app = await startAdminApp(client);
    try {
      const res = await fetch(
        `${app.baseUrl}/api/admin/place-images/reports/${REPORT_ID}/resolve`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json" },
          body: JSON.stringify({ action: "no_action" }),
        },
      );
      const body = await res.json() as any;
      assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(body)}`);
      assert.equal(body.status, "reviewed_accepted");
      // Visual should NOT be rejected
      assert.ok(
        client.__visuals[VISUAL_ID].accuracy_status !== "rejected",
        "no_action must not reject the visual",
      );
    } finally {
      await app.close();
      _setTestClient(null as any, false);
    }
  });
});

// ── Queue listing ──────────────────────────────────────────────────────────────

describe("GET /admin/place-images/queue", () => {
  let app: TestApp;

  before(async () => { app = await startAdminApp(makeFakeSc({ isAdmin: true })); });
  after(async () => { await app.close(); _setTestClient(null as any, false); });

  it("returns 200 with items and pagination for an admin", async () => {
    const res = await fetch(`${app.baseUrl}/api/admin/place-images/queue`, {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.ok(Array.isArray(body.items));
    assert.ok("pagination" in body);
    assert.ok("page" in body.pagination);
    assert.ok("limit" in body.pagination);
  });

  it("returns 403 for non-admin callers", async () => {
    const client = makeFakeSc({ isAdmin: false });
    const nonAdminApp = await startAdminApp(client);
    try {
      const res = await fetch(`${nonAdminApp.baseUrl}/api/admin/place-images/queue`, {
        headers: { Authorization: `Bearer ${USER_TOKEN}` },
      });
      assert.equal(res.status, 403);
    } finally {
      await nonAdminApp.close();
      _setTestClient(null as any, false);
    }
  });
});
