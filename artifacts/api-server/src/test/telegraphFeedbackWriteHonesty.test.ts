/**
 * telegraphFeedbackWriteHonesty — 201 `{ ok: true }` must mean the preference
 * profile was actually written.
 *
 * ── THE DEFECT ───────────────────────────────────────────────────────────────
 * POST /telegraph/recommendations/:id/feedback ended with
 *
 *     await client.from("user_preference_profiles").update({ … }).eq("user_id", …);
 *     res.status(201).json({ ok: true, … });
 *
 * — no `.select()`, no `{ error }`. supabase-js RESOLVES on a database error, so
 * an UPDATE that never landed was indistinguishable from one that did, and the
 * route reported "your feedback was applied" for a profile nobody wrote to. The
 * signal is not queued anywhere and the client has no reason to resend it, so it
 * is simply gone: the next recommendation is scored off the unchanged profile
 * and the user watches the thing they just said "less like this" about come
 * back. The same handler already REFUSES when this row cannot be READ (so it is
 * not clobbered with defaults) — the care was one-sided.
 *
 * NOT COVERED HERE, and open: the same silent loss also happens when the UPDATE
 * matches NO row (the best-effort blank-profile insert failed, so there is
 * nothing to update). Catching it needs `.select("user_id")` and a row-count
 * branch, which src/test/intelligence.test.ts's fake client cannot express — its
 * user_preference_profiles insert is never persisted into the fake state, so
 * every one of its feedback cases would report zero rows. That fixture is out of
 * this change's scope, so the row-count half is reported, not landed.
 *
 * ── WHAT ELSE COULD HAVE MADE THIS PASS ──────────────────────────────────────
 *  * `db_error` is HTTP 500, which an express crash also produces. Both failure
 *    cases assert the JSON body carries `error: 'db_error'`; a crash cannot.
 *  * "Not 201" would be satisfied by a handler that stopped working, so the
 *    positive control asserts 201 AND that the stored JSON really changed.
 *  * The failure is keyed on the UPDATE against user_preference_profiles, not on
 *    the table: the same handler READS that table first, and failing the table
 *    wholesale would trip the pre-existing read guard instead and prove nothing
 *    about the write.
 *
 * Run: node --import tsx/esm --test src/test/telegraphFeedbackWriteHonesty.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import feedbackRouter from "../routes/telegraphFeedback.js";
import { defaultInferred } from "../lib/preferenceLearning.js";

const TOKEN   = "tg-feedback-token";
const USER_ID = "44444444-4444-4444-8444-444444444444";
const REC_ID  = "rec-abc-123";

let server: http.Server;
let base: string;

interface State {
  /** The single user_preference_profiles row, or null when absent. */
  profile: { user_id: string; inferred_preferences_json: string; updated_at?: string } | null;
  failProfileUpdate: { message: string } | null;
  failBlankInsert: { message: string; code?: string } | null;
  updatesAttempted: number;
  events: any[];
}

let state: State;

/**
 * A real, well-formed starting profile: applyEvent reads its category weights,
 * so a placeholder object would make the handler throw and every "not 201"
 * assertion below would pass for the wrong reason.
 */
const ORIGINAL_JSON = JSON.stringify(defaultInferred());

function makeClient() {
  function table(t: string) {
    const self: any = {
      _filters: [] as Array<[string, string, any]>,
      _update: null as any,
      _insert: null as any,
      _single: false,
      select() { return self; },
      insert(d: any) { self._insert = d; return self; },
      update(d: any) { self._update = d; return self; },
      eq(c: string, v: any) { self._filters.push(["eq", c, v]); return self; },
      maybeSingle() { self._single = true; return self; },
      single() { self._single = true; return self; },
      order() { return self; },
      limit() { return self; },
      then(resolve: (v: any) => void, reject?: (e: unknown) => void) {
        return Promise.resolve(self._resolve()).then(resolve, reject);
      },
      _resolve(): any {
        if (t === "user_preference_events") {
          if (self._insert) { state.events.push(self._insert); return { data: null, error: null }; }
          return { data: [], error: null };
        }
        if (t === "user_preference_profiles") {
          if (self._insert) {
            if (state.failBlankInsert) return { data: null, error: state.failBlankInsert };
            state.profile = { user_id: USER_ID, inferred_preferences_json: (self._insert as any).inferred_preferences_json };
            return { data: null, error: null };
          }
          if (self._update !== null) {
            state.updatesAttempted += 1;
            // Scoped to the WRITE: the READ of this same table still answers.
            if (state.failProfileUpdate) return { data: null, error: state.failProfileUpdate };
            const matches = state.profile
              && self._filters.every(([, c, v]: any) => (state.profile as any)[c] === v);
            if (!matches) return { data: [], error: null };
            Object.assign(state.profile as any, self._update);
            return { data: [{ user_id: USER_ID }], error: null };
          }
          if (self._single) return { data: state.profile, error: null };
          return { data: state.profile ? [state.profile] : [], error: null };
        }
        return self._single ? { data: null, error: null } : { data: [], count: 0, error: null };
      },
    };
    return self;
  }
  return {
    from: (t: string) => table(t),
    auth: {
      getUser: async (token: string) =>
        token === TOKEN
          ? { data: { user: { id: USER_ID } }, error: null }
          : { data: { user: null }, error: { message: "invalid token" } },
    },
  };
}

function sendFeedback(): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ category: "nightlife", signal: "less_like_this" });
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port: Number(new URL(base).port),
        path: `/api/telegraph/recommendations/${REC_ID}/feedback`,
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = { _raw: raw }; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    r.write(payload);
    r.end();
  });
}

before(async () => {
  const app = express();
  app.use(express.json());
  // Keeps an unhandled throw from masquerading as the handler's own 500.
  app.use((req: any, _res, next) => {
    req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    next();
  });
  app.use("/api", feedbackRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => {
  server.close();
  _setTestClient(null as any, false);
  _setTestServiceClient(null);
});

beforeEach(() => {
  state = {
    profile: { user_id: USER_ID, inferred_preferences_json: ORIGINAL_JSON },
    failProfileUpdate: null,
    failBlankInsert: null,
    updatesAttempted: 0,
    events: [],
  };
  const c = makeClient();
  _setTestClient(c as any, true);
  _setTestServiceClient(c as any);
});

describe("POST /telegraph/recommendations/:id/feedback — 'applied' must mean stored", () => {
  it("refuses with db_error when the profile UPDATE fails, instead of answering 201 ok", async () => {
    state.failProfileUpdate = { message: "canceling statement due to statement timeout" };
    const r = await sendFeedback();

    assert.equal(state.updatesAttempted, 1, "fixture check: the handler must have attempted the UPDATE");
    assert.equal(r.status, 500, `expected the db_error status, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(
      r.body?.error, "db_error",
      `the body must carry the handler's own error code — an express crash also answers 500 ` +
      `but with no 'error' field. Got ${JSON.stringify(r.body)}`,
    );
    assert.notEqual(r.body?.ok, true, "the route must not report the feedback as applied");
    assert.equal(
      state.profile!.inferred_preferences_json, ORIGINAL_JSON,
      "the profile is unchanged — that is the state the response must reflect",
    );
  });

  it("positive control: a healthy write answers 201 and the stored profile really changes", async () => {
    const r = await sendFeedback();
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body?.ok, true);
    assert.notEqual(
      state.profile!.inferred_preferences_json, ORIGINAL_JSON,
      "the fix must not turn a working write into a refusal — the profile must actually be updated",
    );
    assert.equal(state.events.length, 1, "the preference event is still recorded on the healthy path");
  });
});
