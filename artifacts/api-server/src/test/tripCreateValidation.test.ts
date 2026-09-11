/**
 * census-trips TR51 — `POST /trips` validates its body.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * TR51 ("Command service validates schema") was recorded C, and the row's own
 * testable half is the sentence "every trip write parses a zod schema first".
 * Measured 2026-09-11 across the three files TR51 cites: **53 write endpoints, 8
 * of which read `req.body` with no schema at all** — `POST /trips` among them,
 * the primary create. It destructured twelve fields straight off the body and
 * validated exactly one thing, that startDate <= endDate.
 *
 * TR51 moved C -> W on that measurement. This file closes the flagship endpoint.
 *
 * ── WHAT THE ABSENCE ACTUALLY COST, stated precisely ─────────────────────────
 * Not authorization: `requireUser` runs first and is the only place the
 * ban/suspend gate is applied, and `check:route-auth-gate` guards that
 * independently. What was missing is TYPE validation, so a malformed payload
 * reached PostgREST and came back as a 500 where a 400 belongs, and the accepted
 * shape of the endpoint was written down nowhere.
 *
 * ── THE SCHEMA IS DELIBERATELY NOT STRICTER THAN PATCH ───────────────────────
 * Every field mirrors `PatchTripSchema`, which this same router has enforced on
 * `PATCH /trips/:tripId` all along. A client able to PATCH a field can therefore
 * create with it, so this cannot reject a payload the API already accepted
 * elsewhere. Unknown keys are stripped rather than rejected — zod's default, and
 * equivalent to the destructuring it replaces.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/tripCreateValidation.test.ts
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

const TOKEN = "trip-create-validation-token";
const USER_ID = "aaaaaaaa-0000-0000-0000-bbbbbbbbbbbb";

function buildFakeClient() {
  const trips: any[] = [];
  const passthrough = () => {
    const b: any = {
      select: () => b, eq: () => b, is: () => b, or: () => b, in: () => b,
      insert: () => b, update: () => b, delete: () => b, order: () => b, limit: () => b,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      single: () => Promise.resolve({ data: null, error: null }),
      then: (onF: any, onR: any) => Promise.resolve({ data: [], error: null }).then(onF, onR),
    };
    return b;
  };
  function tripsTable() {
    const b: any = {
      select() { return b; },
      eq() { return b; },
      insert(payload: any) { const row = { id: "new-trip-id", ...payload }; trips.push(row); b._i = row; return b; },
      single() { return Promise.resolve({ data: b._i ?? null, error: null }); },
      maybeSingle() { return Promise.resolve({ data: b._i ?? null, error: null }); },
      then: (onF: any, onR: any) => Promise.resolve({ data: trips, error: null }).then(onF, onR),
    };
    return b;
  }
  return {
    auth: {
      getUser: async (t: string) =>
        t === TOKEN
          ? { data: { user: { id: USER_ID } }, error: null }
          : { data: { user: null }, error: { message: "invalid" } },
    },
    from(table: string) {
      // trust_restrictions: empty => unrestricted, so the route reaches the body.
      if (table === "trips") return tripsTable();
      return passthrough();
    },
  };
}

function post(body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL("/api/trips", base);
    const payload = JSON.stringify(body);
    const r = http.request(
      {
        hostname: url.hostname, port: Number(url.port), path: url.pathname, method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          authorization: `Bearer ${TOKEN}`,
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed: any; try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    r.write(payload);
    r.end();
  });
}

describe("TR51 — POST /trips rejects a malformed body with 400, not a database 500", () => {
  before(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api", tripsRouter);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
    _setTestClient(buildFakeClient() as any, true);
  });

  after(async () => {
    _setTestClient({} as any, true);
    _setTestServiceClient(null as any);
    server.close();
    await new Promise<void>((r) => server.once("close", () => r()));
  });

  it("POSITIVE CONTROL: a well-formed draft is still accepted", async () => {
    // Without this, a bug that rejected everything would make the cases below
    // pass for the wrong reason. Drafts with no title/city are supported, so the
    // emptiest legal body must still work.
    const r = await post({ title: "Cebu", destinationCity: "Cebu City" });
    assert.ok(r.status < 400, `well-formed create rejected: ${r.status} ${JSON.stringify(r.body)}`);
  });

  it("a title of the wrong TYPE is rejected as invalid_payload", async () => {
    const r = await post({ title: { nope: true }, destinationCity: "Cebu City" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_payload");
  });

  it("an unknown visibility is rejected here, not by the database enum", async () => {
    const r = await post({ title: "Cebu", destinationCity: "Cebu City", visibility: "everyone" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_payload");
  });

  it("a malformed date is rejected before it reaches the column", async () => {
    const r = await post({ title: "Cebu", destinationCity: "Cebu City", startDate: "not-a-date" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_payload");
  });

  it("a non-boolean showHeaderPublicly is rejected rather than silently coerced", async () => {
    // The old code read `typeof showHeaderPublicly === "boolean" ? … : derived`,
    // so "false" (a string) silently became the DERIVED value instead of being
    // refused — a visibility setting quietly not doing what was asked.
    const r = await post({ title: "Cebu", destinationCity: "Cebu City", showHeaderPublicly: "false" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_payload");
  });

  it("a cover URL that is not a URL at all is rejected", async () => {
    const r = await post({ title: "Cebu", destinationCity: "Cebu City", coverUrl: "not a url" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_payload");
  });

  it("PINNED AS CURRENT BEHAVIOUR: a javascript: cover URL is ACCEPTED by z.url()", async () => {
    // Not an endorsement — a finding, pinned so closing it is a deliberate diff
    // rather than a side effect. zod's .url() accepts any well-formed URI,
    // `javascript:` included, and this schema mirrors PatchTripSchema exactly so
    // that a client able to PATCH a field can create with it. Restricting the
    // scheme to http/https is the right fix and belongs on BOTH endpoints at
    // once; doing it here alone would make create stricter than patch and leave
    // the same value reachable through the other door. Recorded in census-trips
    // §38. When it is closed, this test flips and that is the point of it.
    const r = await post({ title: "Cebu", destinationCity: "Cebu City", coverUrl: "javascript:alert(1)" });
    assert.ok(r.status < 400,
      "z.url() has started rejecting javascript: — good; update this test and PatchTripSchema together");
  });

  it("the pre-existing date-order rule still fires, and still as invalid_payload", async () => {
    const r = await post({ title: "Cebu", destinationCity: "Cebu City", startDate: "2026-02-10", endDate: "2026-02-01" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_payload");
  });

  it("unknown keys are stripped, not rejected — the destructuring it replaces did the same", async () => {
    const r = await post({ title: "Cebu", destinationCity: "Cebu City", somethingTheClientSends: 1 });
    assert.ok(r.status < 400, `an extra key must not break a create: ${r.status}`);
  });
});
