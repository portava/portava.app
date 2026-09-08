/**
 * POST /circle/contexts/:type/:id/need-help — the emergency alert could reach
 * nobody, and nothing anywhere said so.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * The host-alert block resolved the context host with two data-only reads and
 * ended in a bare `catch {}`:
 *
 *     const { data: trip } = await sc.from("trips").select("owner_id")…
 *     hostId = (trip as any)?.owner_id ?? null;
 *     …
 *     if (hostId && hostId !== user.id) { await sendCircleNotifications(…) }
 *     } catch { /* non-fatal — safety alert must never silently break … *␘/ }
 *
 * supabase-js RESOLVES on a database error, so an unreadable `trips` (or
 * `events`) produced `hostId = null`, the `if` skipped the alert entirely, and
 * the `catch` recorded nothing — it could not, because nothing was thrown. The
 * host alert for a member who pressed "I need help" vanished, and the only
 * artefact of the whole thing was a 200 saying "Your circle has been notified."
 * The comment claimed the alert must never break the response SILENTLY; the
 * silence was the bug.
 *
 * ── WHAT IS AND IS NOT FIXED HERE ──────────────────────────────────────────
 * The fire-and-forget POSTURE is unchanged on purpose: this is an emergency
 * path and the response must not wait on a push. The `circle_presence` row
 * (needs_help = true) is written and error-checked BEFORE the response, so the
 * circle can still see the state; what changes is that a failed host lookup now
 * raises, lands in the file's own `logCircleFanoutFailure`, and is recorded at
 * ERROR instead of evaporating.
 *
 * ── WHAT MAKES THESE ASSERTIONS MEAN SOMETHING ──────────────────────────────
 *   - The alert is DETACHED, so the assertion cannot be made on the response.
 *     The test captures the request logger's calls and polls to a deadline; the
 *     readable case asserts that NO fan-out failure is logged, so "a log line
 *     appeared" cannot be satisfied by unrelated noise.
 *   - Both cases assert the response is an unchanged 200 `acknowledged: true`:
 *     the direction must NOT change, and a fix that started refusing would be
 *     wrong.
 *   - The `trips` read is failed on its own; `circle_presence` and
 *     `trip_members` keep working, so the 200 above proves the handler ran its
 *     real path and the log came from the host lookup specifically.
 *   - `profiles` is never failed wholesale (requireUser's account_status read).
 *
 * Runtime: node:test. The verdict is the exit code.
 * Run: node --import tsx/esm --test src/test/circleNeedHelpAlertSilence.test.ts
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";

const USER = "aaaaaaaa-0f0f-0f0f-0f0f-0f0f0f0f0f0f";
const TRIP = "bbbbbbbb-0f0f-0f0f-0f0f-0f0f0f0f0f0f";
const HOST = "cccccccc-0f0f-0f0f-0f0f-0f0f0f0f0f0f";

const DB_ERROR = { code: "XX000", message: "internal error: relation unavailable" };

/** Every `req.log.error(...)` message seen since the last reset. */
let errorLogs: string[] = [];

function makeClient(o: { failReads?: string[] }) {
  const failReads = new Set(o.failReads ?? []);
  const builder = (table: string): any => {
    let op = "select";
    const settle = () => {
      if (op !== "select") return { data: null, error: null };
      if (failReads.has(table)) return { data: null, error: DB_ERROR };
      if (table === "profiles") return { data: { id: USER, account_status: "active", handle: "u", name: null, display_name: null }, error: null };
      if (table === "trip_members") return { data: { user_id: USER, role: "member", status: "accepted", trip_id: TRIP }, error: null };
      if (table === "trips") return { data: { owner_id: HOST, title: "Trip" }, error: null };
      return { data: null, error: null };
    };
    const b: any = new Proxy({}, {
      get(_t, prop) {
        if (typeof prop === "symbol") return undefined;
        if (prop === "then") return (res: any, rej: any) => Promise.resolve(settle()).then(res, rej);
        if (prop === "maybeSingle" || prop === "single") return () => Promise.resolve(settle());
        if (prop === "insert" || prop === "update" || prop === "upsert" || prop === "delete") {
          return (..._a: any[]) => { op = String(prop); return b; };
        }
        return (..._a: any[]) => b;
      },
    });
    return b;
  };
  return {
    auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) },
    from: (table: string) => builder(table),
  } as any;
}

function install(o: { failReads?: string[] }) {
  const c = makeClient(o);
  _setTestClient(c, true);
  _setTestServiceClient(c);
}

let server: http.Server;
let baseUrl: string;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.log = {
      error: (...args: any[]) => { errorLogs.push(args.map((a) => (typeof a === "string" ? a : "")).join(" ")); },
      warn: () => {}, info: () => {}, debug: () => {},
    };
    next();
  });
  const { default: circleRouter } = await import("../routes/circle.js");
  app.use(circleRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => { server.close(); _clearTestClient(); _setTestServiceClient(null); });

beforeEach(() => { errorLogs = []; });

function post(path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = "{}";
    const req = http.request(
      `${baseUrl}${path}`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer t",
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(payload)),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => { raw += c; });
        res.on("end", () => {
          let parsed: any = null;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

/** The alert is detached from the response, so poll rather than assume timing. */
async function waitForLog(match: RegExp, ms = 1500): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (errorLogs.some((l) => match.test(l))) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

const PATH = `/circle/contexts/trip/${TRIP}/need-help`;

describe("POST /circle/contexts/trip/:id/need-help — the host alert", () => {
  it("host readable: 200 acknowledged and NO fan-out failure is logged", async () => {
    install({});
    const r = await post(PATH);
    assert.equal(r.status, 200);
    assert.equal(r.body.acknowledged, true);
    // Give the detached block the same amount of time the failing case gets,
    // then assert silence. Without this, "a log line appeared" in the next test
    // could be ambient noise rather than the new signal.
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(errorLogs.some((l) => /need-help host alert/i.test(l)), false, errorLogs.join(" | "));
  });

  it("trips read FAILS: response is unchanged, but the lost alert IS recorded", async () => {
    install({ failReads: ["trips"] });
    const r = await post(PATH);
    // Direction unchanged: the presence row committed and the caller is still
    // acknowledged. The log is the only thing that can distinguish this from a
    // successful alert — which is exactly what did not exist before.
    assert.equal(r.status, 200);
    assert.equal(r.body.acknowledged, true);
    assert.equal(await waitForLog(/need-help host alert FAILED/i), true, errorLogs.join(" | "));
  });
});
