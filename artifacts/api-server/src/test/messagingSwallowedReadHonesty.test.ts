/**
 * messagingSwallowedReadHonesty — four reads in routes/messaging.ts whose error
 * was destructured away, and the one that told a person the WRONG THING about
 * someone else's decision.
 *
 * ── THE CLASS ────────────────────────────────────────────────────────────────
 * supabase-js RESOLVES on a database failure. It does not throw. So
 *
 *     const { data: x } = await sc.from('t').select(...)...
 *
 * binds `x = null` on an outage in exactly the same way it binds `x = null` on a
 * genuinely absent row, and the caller cannot tell the two apart. Every case
 * below forces the read to FAIL and asserts that the caller CAN now tell.
 *
 * ── THE FOUR SITES ───────────────────────────────────────────────────────────
 * 1. ACCEPT, CAS-LOSS STATUS READ (:943) — the serious one. After losing the
 *    compare-and-swap the handler re-read the request's status and said
 *    `Request is already ${status ?? 'accepted'}`. On a failed read that
 *    fallback asserts THE OTHER PARTY'S DECISION out of a read that never
 *    happened, and the decision it most often hides is `declined`: the request
 *    left 'pending' — that is why the swap matched nothing — and 'declined' is
 *    one of the two ways it can do so. Telling a person their request was
 *    accepted when it was refused is not a degraded answer, it is a false one.
 *    THE CASE BELOW ASSERTS THE WORD 'accepted' IS ABSENT FROM THE RESPONSE.
 *
 * 2. LANGUAGE SETTINGS, PRIOR-LANGUAGE READ (:411) — the prior
 *    `preferred_language` is what the retranslate gate diffs against. A failed
 *    read bound `before = null`, so `oldLanguage` was `null`, so any non-null
 *    new language read as A CHANGE, so every failing save fired a sweep of up
 *    to 200 messages through the PAID translation provider. The bill is real
 *    and it is charged for a change nobody made.
 *
 * 3. ACCEPT, PREVIEW-MESSAGE INSERT (:1112) — the 200 has already been sent
 *    when this runs, so the log is the ONLY record this write can leave. With
 *    the error dropped, a preview that never landed left no record anywhere:
 *    the thread exists, the accept succeeded, the first message is missing and
 *    nothing says why.
 *
 * 4. UNREAD BADGE, HIGHLIGHTS COUNT (:1563) — the last unbound read in a block
 *    whose two neighbours (the block set and the circle read) already log. It
 *    is the narrowest of the four: the badge under-reports either way, and the
 *    log is the whole difference between a known gap and a silent one.
 *
 * ── WHAT ELSE COULD HAVE MADE THESE PASS ─────────────────────────────────────
 *  * A crash. An unhandled throw yields no `error` code in the body, so every
 *    refusal case asserts the exact HTTP status AND the JSON `error` code.
 *  * A handler that simply stopped working. EVERY failure case is paired with a
 *    POSITIVE CONTROL on the same fixture with the read succeeding, which must
 *    still produce the old, correct behaviour — the 400 naming the real status,
 *    the sweep firing on a real change, the count arriving.
 *  * A fake that cannot express the failure. `failReads` injects a resolved
 *    `{ data: null, error: … }`, which is what the client actually does; it
 *    never throws, because a throw is the one shape this defect is not.
 *
 * MUTATION-TESTED: each case was re-run with its swallow restored and each one
 * FAILED. See the PR body for the per-site results.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx --test src/test/messagingSwallowedReadHonesty.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import messagingRouter from "../routes/messaging.js";

const TOKEN_RECIPIENT = "swallow-recipient-token";
const SENDER_ID    = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const RECIPIENT_ID = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const REQUEST_ID   = "cccccccc-3333-4333-8333-cccccccccccc";
const THREAD_ID    = "dddddddd-4444-4444-8444-dddddddddddd";
const CIRCLE_ID    = "eeeeeeee-5555-4555-8555-eeeeeeeeeeee";

let server: http.Server;
let base: string;

interface LogLine { level: string; obj: any; msg: string }

interface State {
  logs: LogLine[];
  /** Every table `from()` was called on, in order. The retranslate sweep's
   *  first statement is a `from('message_translations')`, evaluated
   *  SYNCHRONOUSLY before its first await, so this observes a fire-and-forget
   *  call without racing it. */
  touched: string[];
  /** Keys that resolve with an error instead of data. See `resolve()`. */
  failReads: Set<string>;
  /** Rows the accept-path compare-and-swap matches. 0 = the race was lost. */
  casMatches: number;
  /** Status the post-CAS re-read reports, when it is readable at all. */
  currentStatus: string;
  /** profiles.preferred_language as the prior-language read sees it. */
  priorLanguage: string | null;
  /** highlights count when the count query is readable. */
  highlightsCount: number;
}

let state: State;

/** A resolved PostgREST-shaped failure — never a throw. */
function dbError(what: string) {
  return { message: `permission denied for ${what}`, code: "42501", details: null, hint: null };
}

function makeClient() {
  function table(t: string) {
    const self: any = {
      _cols: "",
      _op: "select" as "select" | "insert" | "update" | "delete",
      _single: false,
      _selected: false,
      _count: false,
      select(cols?: string, opts?: any) {
        self._selected = true;
        if (typeof cols === "string") self._cols = cols;
        if (opts?.count) self._count = true;
        return self;
      },
      insert() { self._op = "insert"; return self; },
      update() { self._op = "update"; return self; },
      delete() { self._op = "delete"; return self; },
      upsert() { self._op = "insert"; return self; },
      eq() { return self; },
      neq() { return self; },
      in() { return self; },
      is() { return self; },
      gt() { return self; },
      gte() { return self; },
      lt() { return self; },
      lte() { return self; },
      or() { return self; },
      order() { return self; },
      limit() { return self; },
      range() { return self; },
      maybeSingle() { self._single = true; return self; },
      single() { self._single = true; return self; },
      then(res: (v: any) => void, rej?: (e: unknown) => void) {
        return Promise.resolve(self._resolve()).then(res, rej);
      },
      _rows(rows: any[]) {
        if (self._count) return { data: null, count: rows.length, error: null };
        if (self._single) return { data: rows[0] ?? null, error: null };
        return { data: rows, count: rows.length, error: null };
      },
      _fail(key: string) {
        return self._count
          ? { data: null, count: null, error: dbError(key) }
          : { data: self._single ? null : null, error: dbError(key) };
      },
      _resolve(): any {
        switch (t) {
          case "message_requests": {
            if (self._op === "update") {
              const hit = Array.from({ length: state.casMatches }, () => ({ id: REQUEST_ID }));
              if (!self._selected) return { data: null, error: null };
              return self._single ? { data: hit[0] ?? null, error: null } : { data: hit, error: null };
            }
            // Two different reads land here and only the SECOND is the site
            // under test. They are told apart by their own column list, which
            // is what the handler actually writes, not by call order.
            if (self._cols === "status") {
              if (state.failReads.has("request_status")) return self._fail("request status");
              return self._rows([{ status: state.currentStatus }]);
            }
            if (self._count) return self._rows([]);
            return self._rows([{
              id: REQUEST_ID,
              sender_id: SENDER_ID,
              recipient_id: RECIPIENT_ID,
              status: "pending",
              preview_text: "hello there",
            }]);
          }
          case "profiles": {
            if (self._op !== "select" && !self._selected) return { data: null, error: null };
            if (self._cols === "preferred_language") {
              if (state.failReads.has("prior_language")) return self._fail("prior language");
              return self._rows([{ preferred_language: state.priorLanguage }]);
            }
            if (self._cols.includes("preferred_message_language") && self._cols.includes("translation_updated_at")) {
              // The UPDATE's returning row. Unrelated to the four sites.
              return self._rows([{
                preferred_message_language: "es",
                preferred_language: "es",
                auto_translate_messages: true,
                show_original_messages: false,
                translation_updated_at: new Date().toISOString(),
              }]);
            }
            return self._rows([{
              id: SENDER_ID,
              preferred_language: "en",
              preferred_message_language: "en",
              notifications_inbox_viewed_at: null,
              highlights_last_viewed_at: null,
            }]);
          }
          case "messages": {
            if (self._op === "insert") {
              if (state.failReads.has("preview_insert")) return self._fail("preview insert");
              return self._rows([{ id: "ffffffff-6666-4666-8666-ffffffffffff" }]);
            }
            return self._rows([]);
          }
          case "message_threads": {
            if (self._op === "insert") return self._rows([{ id: THREAD_ID }]);
            if (self._op === "update") return { data: null, error: null };
            if (self._cols === "is_e2ee") return self._rows([{ is_e2ee: false }]);
            return self._rows([]);
          }
          case "highlights": {
            if (state.failReads.has("highlights_count")) return self._fail("highlights count");
            return self._count
              ? { data: null, count: state.highlightsCount, error: null }
              : self._rows([]);
          }
          case "circle_memberships":
            return self._rows([{ other_id: CIRCLE_ID }]);
          default:
            return self._rows([]);
        }
      },
    };
    return self;
  }
  return {
    from: (t: string) => { state.touched.push(t); return table(t); },
    auth: {
      // eslint-disable-next-line @typescript-eslint/require-await
      getUser: async (token: string) =>
        token === TOKEN_RECIPIENT
          ? { data: { user: { id: RECIPIENT_ID } }, error: null }
          : { data: { user: null }, error: { message: "invalid token" } },
    },
  };
}

function request(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port: Number(new URL(base).port),
        path,
        method,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TOKEN_RECIPIENT}`,
          ...(payload ? { "content-length": Buffer.byteLength(payload) } : {}),
        },
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
    if (payload) r.write(payload);
    r.end();
  });
}

const accept = () => request("POST", `/api/message-requests/${REQUEST_ID}/accept`);

/** The 200 is sent BEFORE the preview insert runs, so the tail of the handler
 *  is still executing when the response arrives. Poll instead of guessing a
 *  sleep; the timeout is a failure, not a pass. */
async function waitForLog(pred: (l: LogLine) => boolean, tries = 200): Promise<LogLine | null> {
  for (let i = 0; i < tries; i++) {
    const hit = state.logs.find(pred);
    if (hit) return hit;
    await new Promise((r) => setImmediate(r));
  }
  return null;
}

/** Every table the handler touched after the response — same reason as above. */
async function settle(): Promise<void> {
  for (let i = 0; i < 200; i++) await new Promise((r) => setImmediate(r));
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    const push = (level: string) => (obj: any, msg?: any) =>
      state.logs.push({ level, obj: typeof obj === "object" ? obj : {}, msg: String(msg ?? obj ?? "") });
    req.log = { info: push("info"), warn: push("warn"), error: push("error"), debug: push("debug") };
    next();
  });
  app.use("/api", messagingRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => {
  server.close();
  _setTestClient(null as any, false);
  _setTestServiceClient(null);
});

beforeEach(() => {
  state = {
    logs: [],
    touched: [],
    failReads: new Set<string>(),
    casMatches: 1,
    currentStatus: "declined",
    priorLanguage: "en",
    highlightsCount: 3,
  };
  const c = makeClient();
  _setTestClient(c as any, true);
  _setTestServiceClient(c as any);
});

/* ─── SITE 1 ──────────────────────────────────────────────────────────────── */

describe("SITE 1 (:943) — an unreadable status must not be reported as 'accepted'", () => {
  it("THE POINT: the status read FAILS and the response does NOT claim the request was accepted", async () => {
    state.casMatches = 0;             // the swap matched nothing: the race was lost
    state.failReads.add("request_status");

    const r = await accept();
    const body = JSON.stringify(r.body);

    assert.ok(
      !/accepted/i.test(body),
      `the response must not name a status it could not read — got ${body}`,
    );
    assert.equal(
      r.body?.error, "degraded_unavailable",
      `an express crash also fails, but with no 'error' field — the code is what distinguishes them; got ${body}`,
    );
    assert.equal(r.status, 503, "degraded_unavailable is 503 in lib/http.ts and is the only retryable code");
  });

  it("the failure is LOGGED, so an outage here is a known gap rather than a silent one", async () => {
    state.casMatches = 0;
    state.failReads.add("request_status");
    await accept();
    const hit = await waitForLog((l) => l.level === "error" && /status/i.test(l.msg));
    assert.ok(hit, `expected an error log about the unreadable status; got ${JSON.stringify(state.logs)}`);
  });

  it("POSITIVE CONTROL: a READABLE 'declined' still gets the old 400 and is still named", async () => {
    state.casMatches = 0;
    state.currentStatus = "declined";
    const r = await accept();
    assert.equal(r.status, 400);
    assert.equal(r.body?.error, "invalid_payload");
    assert.match(String(r.body?.message ?? JSON.stringify(r.body)), /declined/);
  });

  it("POSITIVE CONTROL: a READABLE 'accepted' is still named 'accepted' — the word is not banned, the GUESS is", async () => {
    state.casMatches = 0;
    state.currentStatus = "accepted";
    const r = await accept();
    assert.equal(r.status, 400);
    assert.equal(r.body?.error, "invalid_payload");
    assert.match(String(r.body?.message ?? JSON.stringify(r.body)), /accepted/);
  });

  it("POSITIVE CONTROL: winning the swap still accepts and still returns a thread", async () => {
    const r = await accept();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body?.status, "accepted");
    assert.equal(r.body?.requestId, REQUEST_ID);
  });
});

/* ─── SITE 2 ──────────────────────────────────────────────────────────────── */

describe("SITE 2 (:411) — an unreadable prior language must not bill a provider sweep", () => {
  const patch = () => request("PATCH", "/api/me/language-settings", { preferred_language: "es", auto_translate_messages: true });

  it("THE POINT: the prior-language read FAILS and NO retranslation sweep is fired", async () => {
    state.failReads.add("prior_language");
    const r = await patch();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await settle();
    assert.ok(
      !state.touched.includes("message_translations"),
      "a failed read is not evidence of a change, and the sweep it triggers is charged at the translation provider",
    );
  });

  it("the failure is LOGGED, so a save that quietly skips its sweep is visible", async () => {
    state.failReads.add("prior_language");
    await patch();
    const hit = await waitForLog((l) => l.level === "warn" && /language/i.test(l.msg));
    assert.ok(hit, `expected a warn about the unreadable prior language; got ${JSON.stringify(state.logs)}`);
  });

  it("POSITIVE CONTROL: a READABLE prior language that really changed still fires the sweep", async () => {
    state.priorLanguage = "en";        // update sets 'es' — a real change
    const r = await patch();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(
      state.touched.includes("message_translations"),
      "the fix must not disable the feature; a genuine change must still sweep",
    );
  });

  it("POSITIVE CONTROL: a READABLE prior language that did not change still fires nothing", async () => {
    state.priorLanguage = "es";        // update sets 'es' — no change
    const r = await patch();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await settle();
    assert.ok(!state.touched.includes("message_translations"));
  });
});

/* ─── SITE 3 ──────────────────────────────────────────────────────────────── */

describe("SITE 3 (:1112) — a preview message that never landed must leave a record", () => {
  it("THE POINT: the insert FAILS after the 200 is sent, and the failure is logged", async () => {
    state.failReads.add("preview_insert");
    const r = await accept();
    assert.equal(r.status, 200, "the accept itself succeeded and must still answer 200");

    const hit = await waitForLog((l) => l.level === "error" && /preview/i.test(l.msg));
    assert.ok(
      hit,
      `the response is already sent, so the log is the ONLY record this write can leave; got ${JSON.stringify(state.logs)}`,
    );
  });

  it("POSITIVE CONTROL: a successful insert logs no such failure", async () => {
    const r = await accept();
    assert.equal(r.status, 200);
    await settle();
    assert.ok(
      !state.logs.some((l) => l.level === "error" && /preview/i.test(l.msg)),
      "a handler that logs unconditionally proves nothing",
    );
  });
});

/* ─── SITE 4 ──────────────────────────────────────────────────────────────── */

describe("SITE 4 (:1563) — the highlights count is the last unbound read in its block", () => {
  const counts = () => request("GET", "/api/me/unread-counts");

  it("THE POINT: the count query FAILS, the badge reports 0, and it SAYS SO", async () => {
    state.failReads.add("highlights_count");
    const r = await counts();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body?.newHighlights, 0, "the narrow honest answer here is 0, as its two neighbours already choose");

    const hit = await waitForLog((l) => l.level === "warn" && /highlight/i.test(l.msg));
    assert.ok(
      hit,
      `its two neighbours in this block already log; this one did not, and 0-by-failure is indistinguishable from 0-by-fact without it; got ${JSON.stringify(state.logs)}`,
    );
  });

  it("POSITIVE CONTROL: a readable count still arrives and logs nothing", async () => {
    state.highlightsCount = 3;
    const r = await counts();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body?.newHighlights, 3);
    assert.ok(!state.logs.some((l) => l.level === "warn" && /highlight/i.test(l.msg)));
  });
});
