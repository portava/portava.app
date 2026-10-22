/**
 * PATCH /me/language-settings accepts Chinese (Traditional).
 *
 * THE DEFECT
 * ==========
 * messaging.ts validated `preferred_message_language` / `preferred_language`
 * against its own LANGUAGE_CODES, which listed `zh` but not `zh-TW`. The profile
 * route (SUPPORTED_LANGUAGE_CODES) and the translator (lib/translation.ts,
 * COMPACT_SCRIPT_LANGS) both support `zh-TW`, and the app offers it — so choosing
 * Chinese (Traditional) for messages answered 400 and the setting never saved.
 *
 * Run: node --import tsx/esm --test src/test/messagingLanguageZhTw.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import messagingRouter from "../routes/messaging.js";

const ME = "aaaaaaaa-5555-4000-8000-000000000001";

function makeClient(profile: Record<string, any>, updates: Array<Record<string, any>>) {
  function from(table: string) {
    let patch: Record<string, any> | null = null;
    const answer = () => {
      if (table !== "profiles") return { data: null, error: null };
      if (patch) { updates.push(patch); Object.assign(profile, patch); }
      return { data: { ...profile }, error: null };
    };
    const b: any = {
      select: () => b, eq: () => b,
      update: (p: Record<string, any>) => { patch = p; return b; },
      single: async () => answer(),
      maybeSingle: async () => answer(),
      then: (f: any, r: any) => Promise.resolve(answer()).then(f, r),
    };
    return b;
  }
  return {
    from,
    rpc: async () => ({ data: null, error: null }),
    auth: { getUser: async (tok: string) => tok === "tok" ? { data: { user: { id: ME } }, error: null } : { data: { user: null }, error: { message: "bad" } } },
  };
}

let server: Server; let base = "";
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.log = { info() {}, warn() {}, error() {}, debug() {} }; next(); });
  app.use("/api", messagingRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}/api`;
});
after(async () => { _setTestClient(null as any, false); await new Promise<void>((r) => server.close(() => r())); });

async function patchSettings(body: unknown) {
  const res = await fetch(`${base}/me/language-settings`, { method: "PATCH", headers: { authorization: "Bearer tok", "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe("PATCH /me/language-settings — zh-TW", () => {
  it("saves zh-TW as the message language and the display language", async () => {
    const updates: Array<Record<string, any>> = [];
    // auto_translate off: no retranslation sweep is fired, so nothing else is read.
    _setTestClient(makeClient({ id: ME, preferred_language: "en", preferred_message_language: "en", auto_translate_messages: false }, updates) as any, true);
    const r = await patchSettings({ preferred_message_language: "zh-TW", preferred_language: "zh-TW" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(updates[0]?.preferred_message_language, "zh-TW");
    assert.equal(updates[0]?.preferred_language, "zh-TW");
  });

  it("still refuses a code nothing supports", async () => {
    _setTestClient(makeClient({ id: ME, preferred_language: "en" }, []) as any, true);
    const r = await patchSettings({ preferred_message_language: "xx-YY" });
    assert.equal(r.status, 400, JSON.stringify(r.body));
  });
});
