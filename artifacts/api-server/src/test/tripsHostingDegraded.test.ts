/**
 * POST /trips — hosting restriction vs degraded-read wiring.
 *
 * getRestrictionState's `degraded` flag is set in BOTH directions: fail-open
 * (trust_restrictions table missing — not a restriction) and fail-closed (a
 * real query error — the check could not be performed, so canHost/canMessage
 * are set false as a precaution). Before this wiring, both looked identical
 * to a caller checking only `canHost` — a transient DB hiccup on this route
 * showed the user "Your account is currently restricted from creating
 * trips," which is false. This file proves the three required outcomes at
 * the actual HTTP boundary:
 *   - fail-open:   the user sees nothing — the trip is created normally.
 *   - fail-closed: the user sees the exact retry message, never the
 *                  restriction message.
 *   - normal:      an unrestricted user's trip is created normally.
 *
 * Run: node --import tsx/esm --test src/test/tripsHostingDegraded.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import tripsRouter from "../routes/trips.js";

let server: http.Server;
let base: string;

const VIEWER_TOKEN = "hosting-degraded-viewer-token";
const VIEWER_ID    = "aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa";

type RestrictionMode = "empty" | "restricted" | "missing_table" | "read_error";

/** Builds a fake service client whose trust_restrictions read behaves per `mode`. */
function buildFakeClient(mode: RestrictionMode) {
  const trips: any[] = [];

  function restrictionQuery() {
    const b: any = {
      select: () => b,
      eq:     () => b,
      is:     () => b,
      or:     () => b,
      then(onF: any, onR: any) {
        let p: Promise<any>;
        switch (mode) {
          case "restricted":
            p = Promise.resolve({ data: [{ restriction_type: "hosting" }], error: null });
            break;
          case "missing_table":
            p = Promise.resolve({
              data: null,
              error: { code: "42P01", message: 'relation "trust_restrictions" does not exist' },
            });
            break;
          case "read_error":
            p = Promise.resolve({
              data: null,
              error: { code: "57014", message: "canceling statement due to statement timeout" },
            });
            break;
          default:
            p = Promise.resolve({ data: [], error: null });
        }
        return p.then(onF, onR);
      },
    };
    return b;
  }

  function tripsTable() {
    const filters: Array<(r: any) => boolean> = [];
    const b: any = {
      select()  { return b; },
      eq(col: string, val: any) { filters.push((r) => r[col] === val); return b; },
      insert(payload: any) {
        const row = { id: "new-trip-id", ...payload };
        trips.push(row);
        b._insert = row;
        return b;
      },
      single()      { return Promise.resolve({ data: b._insert ?? null, error: null }); },
      maybeSingle() { return Promise.resolve({ data: b._insert ?? null, error: null }); },
      then(onF: any, onR: any) {
        return Promise.resolve({ data: trips.filter((r) => filters.every((f) => f(r))), error: null }).then(onF, onR);
      },
    };
    return b;
  }

  return {
    auth: {
      getUser: async (token: string) => {
        if (token === VIEWER_TOKEN) return { data: { user: { id: VIEWER_ID } }, error: null };
        return { data: { user: null }, error: { message: "invalid" } };
      },
    },
    from(table: string) {
      if (table === "trust_restrictions") return restrictionQuery();
      if (table === "trips") return tripsTable();
      // Anything else this route might touch on the happy path (e.g.
      // downstream stamp/notification bookkeeping) — return empty, no-op.
      const empty: any = {
        select: () => empty, eq: () => empty, insert: () => empty, or: () => empty,
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        single: () => Promise.resolve({ data: null, error: null }),
        then: (onF: any) => Promise.resolve({ data: [], error: null }).then(onF),
      };
      return empty;
    },
  };
}

function req(body: any, token = VIEWER_TOKEN): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL("/api/trips", base);
    const payload = JSON.stringify(body);
    const r = http.request(
      {
        hostname: url.hostname, port: Number(url.port), path: url.pathname, method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
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
    r.write(payload);
    r.end();
  });
}

async function withMode<T>(mode: RestrictionMode, fn: () => Promise<T>): Promise<T> {
  // POST /trips now authenticates through requireUser, which resolves its client
  // from _testClient (lib/http.ts:204) — not from getServiceClient(). The fake
  // therefore has to be injected on that seam too, otherwise requireUser reads
  // the `{}` placeholder set in before() and dies on `{}.auth.getUser`.
  //
  // The route was changed because hand-rolling auth.getUser() skipped the
  // account ban/suspend gate, which requireUser is the only place that applies.
  // _setTestClient also sets the service client, so one call covers both.
  _setTestClient(buildFakeClient(mode) as any, true);
  try {
    return await fn();
  } finally {
    _setTestClient({} as any, true);
    _setTestServiceClient(null as any);
  }
}

describe("POST /trips — hosting restriction vs degraded-read wiring", () => {
  before(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api", tripsRouter);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    const addr = server.address() as any;
    base = `http://127.0.0.1:${addr.port}`;
    _setTestClient({} as any, true);
  });

  after(async () => {
    server.close();
    _setTestClient(null as any, false);
  });

  it("normal-allowed: an unrestricted user creates a trip normally", async () => {
    const r = await withMode("empty", () => req({ title: "Lisbon" }));
    assert.equal(r.status, 201);
    assert.equal(r.body.error, undefined);
  });

  it("a real hosting restriction is enforced with the restriction message", async () => {
    const r = await withMode("restricted", () => req({ title: "Lisbon" }));
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "trust_restriction");
    assert.equal(r.body.message, "Your account is currently restricted from creating trips.");
  });

  it("fail-open-silent: a missing trust_restrictions table creates the trip normally — no message at all", async () => {
    const r = await withMode("missing_table", () => req({ title: "Lisbon" }));
    assert.equal(r.status, 201, "fail-open must not block trip creation");
    assert.equal(r.body.error, undefined, "fail-open must show no error/restriction to the user");
  });

  it("fail-closed-message: a read error shows the exact retry string, never the restriction message", async () => {
    const r = await withMode("read_error", () => req({ title: "Lisbon" }));
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.equal(
      r.body.message,
      "We could not verify your permissions right now. Please try again shortly.",
      "must show exactly this string — never the restriction message, never an improvised one",
    );
    assert.equal(r.body.retryable, true, "must carry a retry signal for the client to act on");
    assert.notEqual(r.body.error, "trust_restriction", "must never mislabel an infrastructure failure as a user restriction");
  });
});
