/**
 * Passport §32 telemetry emitter + StampAwardEngine emission.
 *
 * Verifies:
 *   • projectPassportEvent drops non-§32 events and folds actor/subject into the
 *     payload; sanitizePassportPayload strips coordinate/identity-shaped keys at
 *     every depth and projects to the allow-list;
 *   • recordPassportEvent is fail-closed on the flag (no write when OFF), writes
 *     one row when ON, and never throws — even when the insert errors;
 *   • a successful StampAwardEngine award emits stamp_issued AND (for a
 *     verified-provenance source) stamp_verified through the sink; a
 *     self-reported source emits only stamp_issued.
 *
 * Run: node --import tsx/esm --test src/test/passportTelemetry.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  projectPassportEvent,
  sanitizePassportPayload,
  recordPassportEvent,
} from "../lib/passportTelemetry.js";
import { awardStamp } from "../services/passport/StampAwardEngine.js";
import { makePassportDb } from "./helpers/fakePassportDb.js";

const TELEMETRY_FLAG = "passport_telemetry_enabled";

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 15));
}

describe("passportTelemetry — projection + sanitizer", () => {
  it("drops a non-§32 event", () => {
    assert.equal(projectPassportEvent({ event: "not_a_real_event" as any }), null);
  });

  it("folds actor/subject into the payload for a canonical event", () => {
    const row = projectPassportEvent({
      event: "stamp_issued",
      actorId: "u-1",
      subjectId: "us-9",
      payload: { source: "trips", verification: "verified" },
    })!;
    assert.equal(row.event_name, "stamp_issued");
    assert.equal(row.payload.actor_id, "u-1");
    assert.equal(row.payload.subject_id, "us-9");
    assert.equal(row.payload.source, "trips");
    assert.equal(row.payload.verification, "verified");
  });

  it("strips coordinate/identity-shaped keys and projects to the allow-list", () => {
    const clean = sanitizePassportPayload({
      source: "events",          // allow-listed → kept
      city: "Da Nang",           // allow-listed → kept
      lat: 16.06,                // forbidden fragment → dropped
      lng: 108.2,                // forbidden fragment → dropped
      email: "x@y.z",            // forbidden fragment → dropped
      display_name: "Nguyen",    // forbidden fragment → dropped
      random_extra: "nope",      // not allow-listed → dropped
    });
    assert.deepEqual(clean, { source: "events", city: "Da Nang" });
  });

  it("strips a forbidden key nested inside an allow-listed object value", () => {
    const row = projectPassportEvent({
      event: "stamp_issued",
      payload: { source: { kind: "trips", lat: 1, address: "x" } as any },
    })!;
    assert.deepEqual(row.payload.source, { kind: "trips" });
  });
});

describe("recordPassportEvent — fail-closed, single write, never throws", () => {
  it("writes nothing when the flag is OFF (default)", async () => {
    const tables: Record<string, any[]> = { feature_flags: [], passport_telemetry_events: [] };
    const db = makePassportDb(tables);
    await recordPassportEvent(db, { event: "stamp_issued", actorId: "u-1", subjectId: "us-1" });
    await flush();
    assert.equal(tables.passport_telemetry_events.length, 0, "flag off ⇒ no write");
  });

  it("writes exactly one row when the flag is ON", async () => {
    const tables: Record<string, any[]> = {
      feature_flags: [{ flag: TELEMETRY_FLAG, enabled: true }],
      passport_telemetry_events: [],
    };
    const db = makePassportDb(tables);
    await recordPassportEvent(db, { event: "stamp_issued", actorId: "u-1", subjectId: "us-1", payload: { source: "trips" } });
    await flush();
    assert.equal(tables.passport_telemetry_events.length, 1);
    assert.equal(tables.passport_telemetry_events[0].event_name, "stamp_issued");
    assert.equal(tables.passport_telemetry_events[0].payload.actor_id, "u-1");
  });

  it("drops a non-§32 event without touching the flag or the table", async () => {
    const tables: Record<string, any[]> = {
      feature_flags: [{ flag: TELEMETRY_FLAG, enabled: true }],
      passport_telemetry_events: [],
    };
    const db = makePassportDb(tables);
    await recordPassportEvent(db, { event: "totally_made_up" as any });
    await flush();
    assert.equal(tables.passport_telemetry_events.length, 0);
  });

  it("never throws when the insert errors", async () => {
    const throwingDb: any = {
      from() {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle: async () => ({ data: { enabled: true }, error: null }),
          insert: async () => ({ data: null, error: { message: "boom" } }),
        };
      },
    };
    // Must resolve, not reject.
    await recordPassportEvent(throwingDb, { event: "stamp_issued", actorId: "u-1" });
    assert.ok(true, "did not throw");
  });
});

// ── StampAwardEngine emission ──────────────────────────────────────────────────
const ALICE = "aaaaaaaa-0000-4000-8000-000000000011";
const DEF_ID = "dddddddd-0000-4000-8000-000000000022";

function awardTables(telemetryOn: boolean): Record<string, any[]> {
  return {
    feature_flags: [
      { flag: "stamp_system_v2_enabled", enabled: true },
      { flag: TELEMETRY_FLAG, enabled: telemetryOn },
    ],
    stamp_definitions: [{
      id: DEF_ID, slug: "danang_city", name: "Da Nang", stamp_type: "city",
      is_active: true, is_repeatable: false, max_awards_per_user: null,
      visibility_default: "public", criteria_type: "automatic",
    }],
    user_stamps: [],
    stamp_award_events: [],
    stamp_progress: [],
    stamp_milestones: [],
    profiles: [{ id: ALICE, expo_push_token: null }],
    passport_telemetry_events: [],
  };
}

describe("StampAwardEngine — §32 stamp_issued / stamp_verified emission", () => {
  it("a verified-provenance award emits BOTH stamp_issued and stamp_verified", async () => {
    const tables = awardTables(true);
    const db = makePassportDb(tables) as any;
    const res = await awardStamp(db, {
      userId: ALICE, definitionSlug: "danang_city", sourceType: "system", sourceId: "none",
      city: "Da Nang", country: "Vietnam",
    });
    assert.equal(res.awarded, true, `award should succeed (got ${res.reason})`);
    await flush();
    const events = tables.passport_telemetry_events.map((e) => e.event_name).sort();
    assert.deepEqual(events, ["stamp_issued", "stamp_verified"]);
    const issued = tables.passport_telemetry_events.find((e) => e.event_name === "stamp_issued")!;
    assert.equal(issued.payload.actor_id, ALICE);
    assert.equal(issued.payload.verification, "verified");
    assert.equal(issued.payload.stamp_type, "city");
    assert.equal(issued.payload.city, "Da Nang");
  });

  it("does not emit when the telemetry flag is OFF, even on a successful award", async () => {
    const tables = awardTables(false);
    const db = makePassportDb(tables) as any;
    const res = await awardStamp(db, {
      userId: ALICE, definitionSlug: "danang_city", sourceType: "system", sourceId: "none",
      city: "Da Nang", country: "Vietnam",
    });
    assert.equal(res.awarded, true, `award should succeed (got ${res.reason})`);
    await flush();
    assert.equal(tables.passport_telemetry_events.length, 0, "flag off ⇒ no telemetry");
  });

  it("a self-reported source emits stamp_issued only (not verified)", async () => {
    const tables = awardTables(true);
    const db = makePassportDb(tables) as any;
    const res = await awardStamp(db, {
      userId: ALICE, definitionSlug: "danang_city", sourceType: "self_reported", sourceId: "none",
      city: "Da Nang", country: "Vietnam",
    });
    assert.equal(res.awarded, true, `award should succeed (got ${res.reason})`);
    await flush();
    const events = tables.passport_telemetry_events.map((e) => e.event_name).sort();
    assert.deepEqual(events, ["stamp_issued"], "self-reported is not a verified travel fact");
  });
});
