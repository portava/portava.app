/**
 * Privacy settings propagation tests
 *
 * GET  /api/me/privacy  — fetch current settings (or defaults)
 * PATCH /api/me/privacy — update settings; verify propagation
 *
 * Covers:
 *   1. GET returns defaults when no row exists yet
 *   2. GET returns persisted settings when a row exists
 *   3. PATCH saves profile_visibility and allow_profile_discovery
 *   4. PATCH with profile_visibility=private propagates to user_privacy_settings
 *   5. PATCH with empty body returns 400
 *   6. PATCH requires auth
 *
 * Run: node --import tsx/esm --test src/test/privacySettings.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import profileRouter from "../routes/profile.js";

let server: http.Server;
let base: string;

const FAKE_TOKEN = "privacy-test-token";
const USER_ID    = "cccccccc-cccc-cccc-cccc-cccccccccccc";

function buildFakeClient(opts: {
  hasExistingSettings?: boolean;
} = {}) {
  const privacyRows: any[] = opts.hasExistingSettings
    ? [{
        user_id: USER_ID,
        profile_visibility: "public",
        show_current_city: true,
        show_upcoming_trips: true,
        allow_messages_from: "everyone",
        allow_friend_requests: true,
        allow_follow: true,
        allow_tagging: true,
        allow_profile_discovery: true,
        show_stamps: true,
        show_friends: true,
        updated_at: "2025-01-01T00:00:00Z",
      }]
    : [];

  const userPrivacyRows: any[] = [];
  const upsertedPrivacy: any[] = [];
  const upsertedUserPrivacy: any[] = [];

  function from(table: string) {
    let rows: any[] = [];
    if (table === "profile_privacy_settings") rows = privacyRows;
    else if (table === "user_privacy_settings") rows = userPrivacyRows;
    else if (table === "profiles") rows = [{ id: USER_ID, is_private: false }];

    const filters: Array<(r: any) => boolean> = [];
    let _singleMode = false;
    let pendingUpsert: any = null;

    const b: any = {
      select() { return b; },
      insert(row: any) { return b; },
      update(patch: any) { return b; },
      delete() { return b; },
      upsert(row: any) {
        pendingUpsert = row;
        if (table === "profile_privacy_settings") upsertedPrivacy.push({ ...row });
        if (table === "user_privacy_settings")    upsertedUserPrivacy.push({ ...row });
        return b;
      },
      eq(col: string, val: any) { filters.push((r) => r[col] === val); return b; },
      neq(col: string, val: any) { return b; },
      order() { return b; },
      limit() { return b; },
      maybeSingle() { return resolveOne(true); },
      single() {
        _singleMode = true;
        return resolveOneSingle();
      },
      then(onF: any, onR: any) { return resolveList().then(onF, onR); },
    };

    function filtered() {
      return rows.filter((r: any) => filters.every((f) => f(r)));
    }

    async function resolveList() {
      return { data: filtered(), error: null };
    }

    async function resolveOne(maybe: boolean) {
      const data = filtered();
      return { data: data[0] ?? null, error: null };
    }

    async function resolveOneSingle() {
      if (pendingUpsert) {
        return { data: { ...pendingUpsert }, error: null };
      }
      const data = filtered();
      return { data: data[0] ?? null, error: null };
    }

    return b;
  }

  return {
    _upsertedPrivacy: upsertedPrivacy,
    _upsertedUserPrivacy: upsertedUserPrivacy,
    auth: {
      getUser: async (token: string) => {
        if (token === FAKE_TOKEN) return { data: { user: { id: USER_ID } }, error: null };
        return { data: { user: null }, error: { message: "invalid" } };
      },
    },
    from,
  };
}

function req(
  method: string,
  path: string,
  body?: unknown,
  token: string = FAKE_TOKEN,
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
        headers: {
          "content-type": "application/json",
          "authorization": token ? `Bearer ${token}` : "",
          ...(payload ? { "content-length": Buffer.byteLength(payload).toString() } : {}),
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

describe("Privacy settings endpoints", () => {
  before(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api", profileRouter);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    const addr = server.address() as any;
    base = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    server.close();
    _setTestClient(null as any, false);
    _setTestServiceClient(null as any);
  });

  describe("GET /api/me/privacy", () => {
    it("returns defaults when no settings row exists", async () => {
      const fc = buildFakeClient({ hasExistingSettings: false });
      _setTestClient(fc as any, true);
      _setTestServiceClient(fc as any);

      const r = await req("GET", "/api/me/privacy");
      assert.equal(r.status, 200);
      assert.ok(r.body.user_id !== undefined || r.body.profile_visibility !== undefined,
        "should return privacy settings shape");
    });

    it("returns persisted settings when row exists", async () => {
      const fc = buildFakeClient({ hasExistingSettings: true });
      _setTestClient(fc as any, true);
      _setTestServiceClient(fc as any);

      const r = await req("GET", "/api/me/privacy");
      assert.equal(r.status, 200);
      assert.equal(r.body.profile_visibility, "public");
      assert.equal(r.body.allow_profile_discovery, true);
    });

    it("returns 401 without token", async () => {
      const fc = buildFakeClient();
      _setTestClient(fc as any, true);
      _setTestServiceClient(fc as any);

      const r = await req("GET", "/api/me/privacy", undefined, "");
      assert.equal(r.status, 401);
    });
  });

  describe("PATCH /api/me/privacy", () => {
    it("saves profile_visibility setting", async () => {
      const fc = buildFakeClient({ hasExistingSettings: true });
      _setTestClient(fc as any, true);
      _setTestServiceClient(fc as any);

      const r = await req("PATCH", "/api/me/privacy", { profile_visibility: "private" });
      assert.equal(r.status, 200, `unexpected status: ${JSON.stringify(r.body)}`);
      assert.ok(
        fc._upsertedPrivacy.some((row: any) => row.profile_visibility === "private"),
        "should upsert profile_privacy_settings with profile_visibility=private",
      );
    });

    it("propagates profile_visibility=private to user_privacy_settings", async () => {
      const fc = buildFakeClient({ hasExistingSettings: true });
      _setTestClient(fc as any, true);
      _setTestServiceClient(fc as any);

      await req("PATCH", "/api/me/privacy", { profile_visibility: "private" });
      await new Promise((r) => setTimeout(r, 50));
      assert.ok(
        fc._upsertedUserPrivacy.some((row: any) => row.profile_visibility === "private"),
        "should sync profile_visibility=private to user_privacy_settings",
      );
    });

    it("saves allow_profile_discovery=false (discovery opt-out)", async () => {
      const fc = buildFakeClient({ hasExistingSettings: true });
      _setTestClient(fc as any, true);
      _setTestServiceClient(fc as any);

      const r = await req("PATCH", "/api/me/privacy", { allow_profile_discovery: false });
      assert.equal(r.status, 200, `unexpected status: ${JSON.stringify(r.body)}`);
      assert.ok(
        fc._upsertedPrivacy.some((row: any) => row.allow_profile_discovery === false),
        "should upsert with allow_profile_discovery=false",
      );
    });

    it("returns 400 for empty body", async () => {
      const fc = buildFakeClient();
      _setTestClient(fc as any, true);
      _setTestServiceClient(fc as any);

      const r = await req("PATCH", "/api/me/privacy", {});
      assert.equal(r.status, 400);
    });

    it("returns 400 for invalid profile_visibility value", async () => {
      const fc = buildFakeClient();
      _setTestClient(fc as any, true);
      _setTestServiceClient(fc as any);

      const r = await req("PATCH", "/api/me/privacy", { profile_visibility: "secret" });
      assert.equal(r.status, 400);
    });

    it("returns 401 without token", async () => {
      const fc = buildFakeClient();
      _setTestClient(fc as any, true);
      _setTestServiceClient(fc as any);

      const r = await req("PATCH", "/api/me/privacy", { profile_visibility: "private" }, "");
      assert.equal(r.status, 401);
    });

    it("syncs profiles.is_private=true when profile_visibility=private (discovery exclusion)", async () => {
      const profilesUpdated: any[] = [];
      const fc = buildFakeClient({ hasExistingSettings: true });
      const origFrom = fc.from.bind(fc);
      (fc as any).from = (table: string) => {
        const b = origFrom(table);
        if (table === "profiles") {
          const origUpdate = b.update.bind(b);
          b.update = (patch: any) => {
            profilesUpdated.push(patch);
            return origUpdate(patch);
          };
        }
        return b;
      };
      _setTestClient(fc as any, true);
      _setTestServiceClient(fc as any);

      const r = await req("PATCH", "/api/me/privacy", { profile_visibility: "private" });
      assert.equal(r.status, 200, `unexpected status: ${JSON.stringify(r.body)}`);
      await new Promise((res) => setTimeout(res, 80));
      assert.ok(
        profilesUpdated.some((p: any) => p.is_private === true),
        "profiles.is_private must be set to true when profile_visibility=private so discovery search excludes the user",
      );
    });

    it("syncs profiles.is_private=false when profile_visibility=public (re-enables discovery)", async () => {
      const profilesUpdated: any[] = [];
      const fc = buildFakeClient({ hasExistingSettings: true });
      const origFrom = fc.from.bind(fc);
      (fc as any).from = (table: string) => {
        const b = origFrom(table);
        if (table === "profiles") {
          const origUpdate = b.update.bind(b);
          b.update = (patch: any) => {
            profilesUpdated.push(patch);
            return origUpdate(patch);
          };
        }
        return b;
      };
      _setTestClient(fc as any, true);
      _setTestServiceClient(fc as any);

      const r = await req("PATCH", "/api/me/privacy", { profile_visibility: "public" });
      assert.equal(r.status, 200, `unexpected status: ${JSON.stringify(r.body)}`);
      await new Promise((res) => setTimeout(res, 80));
      assert.ok(
        profilesUpdated.some((p: any) => p.is_private === false),
        "profiles.is_private must be set to false when profile_visibility=public",
      );
    });
  });
});
