/**
 * T235 (§17.8) / T400 (§30A.7) — an active precise location is DEVICE-SPECIFIC
 * and must not automatically or silently transfer to a newly authenticated
 * device.
 *
 * The scenario, end to end through the route:
 *
 *   phone A publishes a fix carrying its registered device id   → A is bound
 *   phone A reads its own location state                        → PRECISE
 *   phone B (same account, registered, freshly signed in) reads → APPROXIMATE,
 *                                                                 reason
 *                                                                 device_mismatch
 *   a caller with no device id at all reads                     → APPROXIMATE
 *   phone B then publishes its own fix                          → B is bound,
 *   phone A reads again                                         → APPROXIMATE
 *
 * The last step is the one a partial implementation misses: binding on publish
 * without REBINDING on the next publish leaves phone A reading phone B's
 * position precisely.
 *
 * "Not silently" is asserted too: the answer names `coordsPrecision` and
 * `coordsPrecisionReason`, so a client can say why the pin is coarse instead of
 * quietly showing a worse one.
 *
 * Run: node --import tsx/esm --test src/test/preciseLocationDeviceBinding.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";

import app from "../app.js";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { makeFailClosedClient } from "./helpers/failClosedSupabase.js";
import {
  BINDING_TTL_MS,
  DEVICE_ID_HEADER,
  _resetPreciseShareBindings,
  activeBinding,
  bindPreciseShare,
  clearPreciseShare,
  precisionForDevice,
  presentedDeviceId,
  verifyDeviceForUser,
} from "../lib/preciseLocationDevice.js";

const USER = "11111111-1111-4111-8111-111111111111";
const PHONE_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const PHONE_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const STRANGER_DEVICE = "cccccccc-3333-4333-8333-cccccccccccc";
const LAT = 41.157944;
const LNG = -8.629105;

// ── The pure policy ───────────────────────────────────────────────────────────

describe("precisionForDevice — precise in exactly one case", () => {
  const binding = { userId: USER, deviceId: PHONE_A, boundAtMs: 1_000 };

  it("the bound device, presented and registered, gets precise", () => {
    assert.deepEqual(
      precisionForDevice({ binding, presentedDeviceId: PHONE_A, deviceState: "registered" }),
      { precision: "precise", reason: "bound_device" },
    );
  });

  it("A DIFFERENT DEVICE gets approximate — this is the requirement", () => {
    assert.deepEqual(
      precisionForDevice({ binding, presentedDeviceId: PHONE_B, deviceState: "registered" }),
      { precision: "approximate", reason: "device_mismatch" },
    );
  });

  it("no device presented → approximate", () => {
    assert.deepEqual(
      precisionForDevice({ binding, presentedDeviceId: null, deviceState: "unknown" }),
      { precision: "approximate", reason: "no_device_presented" },
    );
  });

  it("a device that is not this user's → approximate", () => {
    assert.deepEqual(
      precisionForDevice({ binding, presentedDeviceId: STRANGER_DEVICE, deviceState: "unknown" }),
      { precision: "approximate", reason: "device_not_registered" },
    );
  });

  it("an UNREADABLE device registry → approximate, and says so", () => {
    assert.deepEqual(
      precisionForDevice({ binding, presentedDeviceId: PHONE_A, deviceState: "unreadable" }),
      { precision: "approximate", reason: "device_registry_unreadable" },
    );
  });

  it("no binding at all → approximate, even for a registered device", () => {
    assert.deepEqual(
      precisionForDevice({ binding: null, presentedDeviceId: PHONE_A, deviceState: "registered" }),
      { precision: "approximate", reason: "no_active_binding" },
    );
  });
});

describe("the binding registry", () => {
  beforeEach(() => _resetPreciseShareBindings());

  it("binds, reads back, and ages out at the TTL", () => {
    bindPreciseShare(USER, PHONE_A, 1_000);
    assert.equal(activeBinding(USER, 1_000)?.deviceId, PHONE_A);
    assert.equal(activeBinding(USER, 1_000 + BINDING_TTL_MS)?.deviceId, PHONE_A);
    assert.equal(activeBinding(USER, 1_001 + BINDING_TTL_MS), null, "an aged binding is no binding");
  });

  it("a later bind REPLACES the earlier one — the share follows the publisher", () => {
    bindPreciseShare(USER, PHONE_A, 1_000);
    bindPreciseShare(USER, PHONE_B, 2_000);
    assert.equal(activeBinding(USER, 2_000)?.deviceId, PHONE_B);
  });

  it("clearing revokes precision for everyone, including the device that set it", () => {
    bindPreciseShare(USER, PHONE_A, 1_000);
    clearPreciseShare(USER);
    assert.equal(activeBinding(USER, 1_000), null);
  });

  it("an unseen user has no binding, and an inherited key is not a binding", () => {
    assert.equal(activeBinding("someone-else", 1_000), null);
    assert.equal(activeBinding("constructor", 1_000), null);
    assert.equal(activeBinding("toString", 1_000), null);
  });
});

describe("presentedDeviceId", () => {
  it("accepts a uuid header and refuses anything else", () => {
    assert.equal(presentedDeviceId({ [DEVICE_ID_HEADER]: PHONE_A }), PHONE_A);
    assert.equal(presentedDeviceId({ [DEVICE_ID_HEADER]: ` ${PHONE_A} ` }), PHONE_A);
    assert.equal(presentedDeviceId({}), null);
    assert.equal(presentedDeviceId({ [DEVICE_ID_HEADER]: "not-a-uuid" }), null);
    assert.equal(presentedDeviceId({ [DEVICE_ID_HEADER]: 42 }), null);
  });
});

describe("verifyDeviceForUser consults the devices registry", () => {
  it("a row for this user is registered; another user's row is not", async () => {
    const db = makeFailClosedClient({
      rows: { devices: [{ id: PHONE_A, user_id: USER }, { id: STRANGER_DEVICE, user_id: "someone" }] },
    });
    assert.equal(await verifyDeviceForUser(db, USER, PHONE_A), "registered");
    assert.equal(await verifyDeviceForUser(db, USER, STRANGER_DEVICE), "unknown");
    assert.equal(await verifyDeviceForUser(db, USER, null), "unknown");
  });

  it("an unreadable registry is its own answer, not 'not your device'", async () => {
    const db = makeFailClosedClient({
      rows: { devices: [{ id: PHONE_A, user_id: USER }] },
      failOn: (ctx) => (ctx.table === "devices" ? { message: "down", code: "57P01" } : null),
    });
    assert.equal(await verifyDeviceForUser(db, USER, PHONE_A), "unreadable");
  });
});

// ── Through the route ─────────────────────────────────────────────────────────

type Row = Record<string, any>;

/** A fake that honours the filters these two handlers use. */
function makeClient(state: { loc: Row | null }) {
  const devices: Row[] = [
    { id: PHONE_A, user_id: USER },
    { id: PHONE_B, user_id: USER },
  ];
  return {
    auth: {
      getUser: async (token: string) =>
        token === "tok"
          ? { data: { user: { id: USER } }, error: null }
          : { data: { user: null }, error: { message: "invalid" } },
    },
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      const chain: any = {
        select: () => chain,
        eq: (col: string, val: unknown) => { filters.push([col, val]); return chain; },
        order: () => chain,
        limit: () => chain,
        maybeSingle: async () => {
          if (table === "user_location_state") return { data: state.loc, error: null };
          if (table === "devices") {
            const row = devices.find((d) => filters.every(([c, v]) => d[c] === v)) ?? null;
            return { data: row, error: null };
          }
          return { data: null, error: null }; // feature_flags: no stop configured
        },
        single: async () => ({ data: null, error: null }),
        upsert: (patch: Row) => {
          if (table === "user_location_state") state.loc = { ...(state.loc ?? {}), ...patch };
          return { then: (f: any) => Promise.resolve({ data: null, error: null }).then(f) };
        },
        insert: () => ({ then: (f: any) => Promise.resolve({ data: null, error: null }).then(f) }),
        then: (f: any, r: any) => Promise.resolve({ data: [], error: null }).then(f, r),
      };
      return chain;
    },
    rpc: async () => ({ data: null, error: null }),
    storage: {
      createBucket: async () => ({ error: null }),
      from: () => ({ upload: async () => ({ error: null }), getPublicUrl: () => ({ data: { publicUrl: "" } }) }),
    },
  };
}

let server: Server;
let port = 0;
const state: { loc: Row | null } = { loc: null };

async function post(deviceId: string | null): Promise<any> {
  const headers: Record<string, string> = {
    Authorization: "Bearer tok",
    "content-type": "application/json",
  };
  if (deviceId) headers[DEVICE_ID_HEADER] = deviceId;
  const res = await fetch(`http://127.0.0.1:${port}/api/me/location-state`, {
    method: "POST",
    headers,
    body: JSON.stringify({ source: "gps", coords: { lat: LAT, lng: LNG, accuracyMeters: 8 } }),
  });
  return res.json();
}

async function get(deviceId: string | null): Promise<any> {
  const headers: Record<string, string> = { Authorization: "Bearer tok" };
  if (deviceId) headers[DEVICE_ID_HEADER] = deviceId;
  const res = await fetch(`http://127.0.0.1:${port}/api/me/location-state`, { headers });
  const body = (await res.json()) as { locationState: any };
  return body.locationState;
}

describe("GET /api/me/location-state — the precise fix does not follow the account", () => {
  before(() => new Promise<void>((resolve) => {
    server = createServer(app);
    server.listen(0, "127.0.0.1", () => { port = (server.address() as any).port; resolve(); });
  }));
  after(() => new Promise<void>((resolve) => {
    _setTestClient(null as any, false);
    _setTestServiceClient(null as any);
    server.close(() => resolve());
  }));
  beforeEach(() => {
    _resetPreciseShareBindings();
    state.loc = null;
    _setTestClient(makeClient(state) as any, true);
  });

  it("the publishing device reads its own fix precisely", async () => {
    const written = await post(PHONE_A);
    assert.deepEqual(written.preciseShare, { deviceBound: true, reason: "bound_device" });
    const read = await get(PHONE_A);
    assert.equal(read.coordsPrecision, "precise");
    assert.equal(read.coordsPrecisionReason, "bound_device");
    assert.equal(read.coords.lat, LAT);
    assert.equal(read.coords.lng, LNG);
    assert.equal(read.coords.accuracyMeters, 8);
  });

  it("A NEWLY AUTHENTICATED DEVICE ON THE SAME ACCOUNT GETS A COARSE POINT, AND IS TOLD", async () => {
    await post(PHONE_A);
    const read = await get(PHONE_B);
    assert.equal(read.coordsPrecision, "approximate");
    assert.equal(read.coordsPrecisionReason, "device_mismatch");
    assert.notEqual(read.coords.lat, LAT, "the precise latitude transferred to a second device");
    assert.notEqual(read.coords.lng, LNG, "the precise longitude transferred to a second device");
    assert.equal(read.coords.accuracyMeters, null, "an accuracy beside a coarse point claims precision it lacks");
    assert.ok(read.coordsCellKm >= 2, "the coarse point names the cell it was snapped into");
  });

  it("…but the city is still there, so a new device is not left locationless", async () => {
    state.loc = { user_id: USER, lat: LAT, lng: LNG, city: "Porto", country: "Portugal", last_known_at: new Date().toISOString() };
    const read = await get(PHONE_B);
    assert.equal(read.coordsPrecision, "approximate");
    assert.equal(read.place.city, "Porto");
    assert.ok(read.coords, "a coarse point, not nothing at all");
  });

  it("a caller presenting no device id gets a coarse point", async () => {
    await post(PHONE_A);
    const read = await get(null);
    assert.equal(read.coordsPrecision, "approximate");
    assert.equal(read.coordsPrecisionReason, "no_device_presented");
  });

  it("THE BINDING MOVES WITH THE PUBLISHER: after B publishes, A is coarse", async () => {
    await post(PHONE_A);
    const bound = await post(PHONE_B);
    assert.deepEqual(bound.preciseShare, { deviceBound: true, reason: "bound_device" });
    const readA = await get(PHONE_A);
    assert.equal(readA.coordsPrecision, "approximate");
    assert.equal(readA.coordsPrecisionReason, "device_mismatch");
    const readB = await get(PHONE_B);
    assert.equal(readB.coordsPrecision, "precise");
  });

  it("a publish with NO device id clears the binding, so the old device loses precision too", async () => {
    await post(PHONE_A);
    const anon = await post(null);
    assert.deepEqual(anon.preciseShare, { deviceBound: false, reason: "no_device_presented" });
    const read = await get(PHONE_A);
    assert.equal(read.coordsPrecision, "approximate");
    assert.equal(read.coordsPrecisionReason, "no_active_binding");
  });

  it("a row with no coordinate answers null precision rather than inventing one", async () => {
    state.loc = { user_id: USER, lat: null, lng: null, city: "Porto" };
    const read = await get(PHONE_A);
    assert.equal(read.coords, null);
    assert.equal(read.coordsPrecision, null);
    assert.equal(read.coordsPrecisionReason, null);
  });
});
