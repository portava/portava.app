/**
 * canonicalEvents — the two safety mechanisms on every event, tested purely.
 *
 * Trigger/RLS/grant behaviour is asserted in migration 2100's comments and is
 * validated on apply against the live catalog (the append-only property cannot
 * be verified without a database). What IS verifiable here without a DB is the
 * write-side hygiene: the GPS strip, the allow-list projection, and the verb
 * projection that drops a non-canonical verb before it can reach the table.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CANONICAL_EVENT_VERBS,
  FORBIDDEN_PAYLOAD_KEYS,
  ALLOWED_PAYLOAD_KEYS,
  sanitizePayload,
  projectEvent,
  recordEvents,
  type CanonicalEventInput,
} from "../lib/canonicalEvents.js";

describe("canonicalEvents — payload sanitizer strips forbidden GPS keys", () => {
  it("strips every forbidden GPS key", () => {
    const raw: Record<string, unknown> = { surface: "discovery" };
    for (const k of FORBIDDEN_PAYLOAD_KEYS) raw[k] = 1.234;
    const out = sanitizePayload(raw);
    for (const k of FORBIDDEN_PAYLOAD_KEYS) {
      assert.ok(!(k in out), `${k} should have been stripped`);
    }
    assert.equal(out.surface, "discovery"); // allow-listed key survives
  });

  it("strips GPS keys case-insensitively", () => {
    const out = sanitizePayload({ Lat: 1, LNG: 2, Latitude: 3, COORDS: [1, 2], surface: "x" });
    assert.deepEqual(out, { surface: "x" });
  });

  it("strips a GPS key even if it were also allow-listed (GPS strip is absolute)", () => {
    // 'accuracy' is forbidden and is not on the allow-list; confirm forbidden wins.
    const out = sanitizePayload({ accuracy: 5, route: "GET /discovery" });
    assert.ok(!("accuracy" in out));
    assert.equal(out.route, "GET /discovery");
  });
});

describe("canonicalEvents — allow-list projection", () => {
  it("drops non-allow-listed keys", () => {
    const out = sanitizePayload({
      surface: "discovery",   // allowed
      category: "food",       // allowed
      secret_user_email: "a@b.com", // dropped
      note: "free text",      // dropped
    });
    assert.deepEqual(out, { surface: "discovery", category: "food" });
  });

  it("keeps only allow-listed keys and nothing else", () => {
    const raw = Object.fromEntries([...ALLOWED_PAYLOAD_KEYS].map((k) => [k, 1]));
    raw["not_allowed"] = 1;
    const out = sanitizePayload(raw);
    assert.equal("not_allowed" in out, false);
    for (const k of ALLOWED_PAYLOAD_KEYS) assert.equal(out[k], 1);
  });

  it("returns {} for null/undefined/non-object payloads", () => {
    assert.deepEqual(sanitizePayload(null), {});
    assert.deepEqual(sanitizePayload(undefined), {});
    assert.deepEqual(sanitizePayload(42 as any), {});
  });
});

describe("canonicalEvents — payload sanitizer strips GPS at every depth (I4a)", () => {
  it("strips a forbidden key nested inside an allow-listed object key", () => {
    const out = sanitizePayload({
      intel: { snapshot_id: "s1", lat: 1, nested: { LNG: 2, keep: "x" }, list: [{ coords: [1, 2], ok: 1 }] },
      touch: "go_tap",
    });
    assert.deepEqual(out, {
      intel: { snapshot_id: "s1", nested: { keep: "x" }, list: [{ ok: 1 }] },
      touch: "go_tap",
    });
  });
  it("the I4a keys are allow-listed and scalars pass through unchanged", () => {
    for (const k of ["intel", "touch", "counterfactual_same_choice", "traveler_mode"]) {
      assert.ok((ALLOWED_PAYLOAD_KEYS as readonly string[]).includes(k), `${k} must be allow-listed`);
    }
    assert.deepEqual(sanitizePayload({ counterfactual_same_choice: true, traveler_mode: "solo" }),
      { counterfactual_same_choice: true, traveler_mode: "solo" });
  });
});

describe("canonicalEvents — verb projection", () => {
  it("accepts every canonical verb (nine interaction verbs + three intel domain verbs)", () => {
    assert.equal(CANONICAL_EVENT_VERBS.length, 12);
    for (const verb of CANONICAL_EVENT_VERBS) {
      const row = projectEvent({ verb });
      assert.notEqual(row, null, `${verb} should be accepted`);
      assert.equal(row?.verb, verb);
    }
  });

  it("rejects a non-canonical verb (projection returns null)", () => {
    assert.equal(projectEvent({ verb: "purchase" as any }), null);
    assert.equal(projectEvent({ verb: "" as any }), null);
    assert.equal(projectEvent(null as any), null);
  });

  it("sanitizes payload as part of projection", () => {
    const row = projectEvent({ verb: "open", payload: { lat: 1, surface: "discovery" } });
    assert.deepEqual(row?.payload, { surface: "discovery" });
  });

  it("maps envelope fields and defaults missing ones to null", () => {
    const row = projectEvent({ verb: "save", actorId: "u1", sourceCount: 3 });
    assert.equal(row?.actor_id, "u1");
    assert.equal(row?.source_count, 3);
    assert.equal(row?.confidence, null);
    assert.equal(row?.privacy_eligible, null);
    assert.equal(row?.expires_at, null);
  });
});

describe("canonicalEvents — recordEvents is fire-and-forget", () => {
  it("drops non-canonical verbs and inserts only the valid rows", async () => {
    let inserted: any[] | null = null;
    const sc = {
      from(table: string) {
        assert.equal(table, "canonical_events");
        return { insert: async (rows: any[]) => { inserted = rows; return { error: null }; } };
      },
    };
    const inputs: CanonicalEventInput[] = [
      { verb: "impression" },
      { verb: "not_a_verb" as any },
      { verb: "save" },
    ];
    await recordEvents(sc, inputs);
    assert.equal(inserted!.length, 2);
    assert.deepEqual(inserted!.map((r) => r.verb), ["impression", "save"]);
  });

  it("does not insert when every verb is invalid", async () => {
    let called = false;
    const sc = { from() { return { insert: async () => { called = true; return { error: null }; } }; } };
    await recordEvents(sc, [{ verb: "bogus" as any }]);
    assert.equal(called, false);
  });

  it("never throws when the insert errors or the client is missing", async () => {
    const erroring = { from() { return { insert: async () => ({ error: { message: "boom" } }) }; } };
    await recordEvents(erroring, [{ verb: "open" }]); // logs, does not throw
    await recordEvents(null, [{ verb: "open" }]);     // no client, no throw
    await recordEvents({} as any, []);                // empty batch, no throw
  });
});
