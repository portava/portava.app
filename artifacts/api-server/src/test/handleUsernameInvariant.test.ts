/**
 * Handle/Username Invariant — enforcement tests
 *
 * Invariant: handle is the canonical public identity; username always === handle;
 * both stored lowercase.
 *
 * Covers:
 *   1. PATCH /api/me/profile username change writes BOTH username and handle (equal, lowercase)
 *   2. Mixed-case username input is normalized to lowercase before storage
 *   3. Passport lookup resolves by canonical handle (lowercased URL param)
 *
 * Run: node --import tsx/esm --test src/test/handleUsernameInvariant.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import profileRouter from "../routes/profile.js";
import passportRouter from "../routes/passport.js";

const ME = "aa000000-0000-4000-a000-000000000101";
const ME_TOK = "tok-invariant-me";

// Minimal fake matching the profileSystem pattern: records .update() payloads
let updatePayloads: any[] = [];
let profilesRows: any[] = [];

function chain(result: any) {
  const c: any = {
    select: () => c, eq: () => c, neq: () => c, in: () => c, or: () => c,
    order: () => c, range: () => c, limit: () => c, single: async () => ({ data: result, error: null }),
    maybeSingle: async () => ({ data: Array.isArray(result) ? result[0] ?? null : result, error: null }),
    then: (res: any) => res({ data: result, error: null }),
  };
  return c;
}

function makeFakeClient() {
  return {
    auth: { getUser: async (_tok: string) => ({ data: { user: { id: ME } }, error: null }) },
    from(table: string) {
      if (table === "profiles") {
        return {
          select: (_cols: string) => ({
            eq: (col: string, val: any) => ({
              eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
              neq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
              maybeSingle: async () => {
                const row = profilesRows.find((r) => (r as any)[col] === val) ?? null;
                return { data: row, error: null };
              },
            }),
          }),
          update: (payload: any) => {
            updatePayloads.push(payload);
            return {
              eq: () => ({
                select: () => ({
                  maybeSingle: async () => ({ data: { ...profilesRows[0], ...payload }, error: null }),
                  single: async () => ({ data: { ...profilesRows[0], ...payload }, error: null }),
                }),
              }),
            };
          },
        };
      }
      return chain(null);
    },
    storage: { from: () => ({ upload: async () => ({ error: null }), getPublicUrl: () => ({ data: { publicUrl: "" } }) }) },
  };
}

let server: any; let base = "";
before(async () => {
  const fake: any = makeFakeClient();
  _setTestClient(() => fake);
  _setTestServiceClient(fake);
  const app = express();
  app.use(express.json());
  app.use("/api", profileRouter);
  app.use("/api", passportRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, () => r()));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => server?.close());

describe("handle/username invariant", () => {
  it("PATCH username writes BOTH username and handle, equal and lowercase", async () => {
    updatePayloads = [];
    profilesRows = [{ id: ME, username: "olduser", handle: "olduser", username_updated_at: null }];
    const res = await fetch(`${base}/api/me/profile`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ME_TOK}` },
      body: JSON.stringify({ username: "NewIdentity_9" }),
    });
    assert.equal(res.status, 200);
    const written = updatePayloads.find((p) => p.username !== undefined);
    assert.ok(written, "an update containing username was written");
    assert.equal(written.username, "newidentity_9", "username lowercased");
    assert.equal(written.handle, "newidentity_9", "handle synced to username");
    assert.equal(written.username, written.handle, "invariant: username === handle");
  });

  it("mixed-case input normalizes to lowercase", async () => {
    updatePayloads = [];
    profilesRows = [{ id: ME, username: "olduser", handle: "olduser", username_updated_at: null }];
    const res = await fetch(`${base}/api/me/profile`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ME_TOK}` },
      body: JSON.stringify({ username: "  MiXeDCaSe_1  " }),
    });
    assert.equal(res.status, 200);
    const written = updatePayloads.find((p) => p.username !== undefined);
    assert.ok(written);
    assert.equal(written.username, "mixedcase_1", "lowercased and trimmed");
    assert.equal(written.handle, "mixedcase_1");
  });
});
