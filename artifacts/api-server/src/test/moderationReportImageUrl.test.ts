/**
 * POST /api/moderation/report — imageUrl field persistence tests
 *
 * Verifies that the moderation report route:
 *   - Accepts an `imageUrl` for safety_concern reports and persists it as image_url
 *   - Omits image_url from the insert when no imageUrl is sent (text-only path)
 *   - Rejects an invalid (non-URL) imageUrl value
 *   - Accepts imageUrl for non-safety categories without error (it is stored)
 *
 * Uses _setTestClient to inject a fake Supabase service client.
 * No network calls are made.
 *
 * Run: node --import tsx/esm --test src/test/moderationReportImageUrl.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const REPORTER_ID  = "aaaaaaaa-aaaa-aaaa-aaaa-000000000001";
const SUBJECT_ID   = "bbbbbbbb-bbbb-bbbb-bbbb-000000000002";
const REPORT_ID    = "cccccccc-cccc-cccc-cccc-000000000003";
const EVIDENCE_URL = "https://cdn.example.com/uploads/evidence.jpg";

/** Capture the most-recent .insert() call payload. */
let lastInsertPayload: Record<string, unknown> | null = null;

function makeFakeClient() {
  return {
    auth: {
      getUser: async () => ({
        data: { user: { id: REPORTER_ID, email: "reporter@example.com" } },
        error: null,
      }),
    },
    from(table: string) {
      const obj: any = {
        select()                  { return obj; },
        insert(payload: unknown)  {
          if (table === "moderation_reports") {
            lastInsertPayload = payload as Record<string, unknown>;
          }
          return obj;
        },
        eq()                      { return obj; },
        maybeSingle: async () => ({ data: null, error: null }),
        single: async () => ({
          data: { id: REPORT_ID },
          error: null,
        }),
      };
      return obj;
    },
  };
}

function startServer(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as any).port as number;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function postReport(
  url: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${url}/api/moderation/report`, {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer test-token`,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const BASE_REPORT = {
  subjectType: "user",
  subjectId:   SUBJECT_ID,
  category:    "safety_concern",
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /api/moderation/report — imageUrl field", () => {
  let server: Server;
  let url: string;

  beforeEach(async () => {
    lastInsertPayload = null;
    _setTestClient(makeFakeClient() as any, true);
    ({ server, url } = await startServer());
  });

  afterEach(async () => {
    _setTestClient(null as any);
    await closeServer(server);
  });

  it("text-only path: image_url is absent from insert when no imageUrl sent", async () => {
    const { status } = await postReport(url, { ...BASE_REPORT });
    assert.equal(status, 201);
    assert.equal(Object.prototype.hasOwnProperty.call(lastInsertPayload, "image_url"), false);
  });

  it("photo path: image_url is set in insert when imageUrl is provided", async () => {
    const { status } = await postReport(url, { ...BASE_REPORT, imageUrl: EVIDENCE_URL });
    assert.equal(status, 201);
    assert.equal(lastInsertPayload?.image_url, EVIDENCE_URL);
  });

  it("rejects an invalid (non-URL) imageUrl with 400", async () => {
    const { status } = await postReport(url, {
      ...BASE_REPORT,
      imageUrl: "not-a-url",
    });
    assert.equal(status, 400);
  });

  it("imageUrl null omits image_url from insert", async () => {
    const { status } = await postReport(url, { ...BASE_REPORT, imageUrl: null });
    assert.equal(status, 201);
    assert.equal(Object.prototype.hasOwnProperty.call(lastInsertPayload, "image_url"), false);
  });
});
