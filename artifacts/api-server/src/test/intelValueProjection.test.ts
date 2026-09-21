/**
 * intel_observations.value — the key allow-list, and the drift guard that keeps
 * it honest.
 *
 * THE MEASUREMENT THIS FILE STARTS FROM. lib/quickSignal's validators check the
 * keys they NAME; not one of them rejects an extra key. That is asserted here
 * against the shipped validators, not asserted about them — if a future edit
 * makes the validators reject extra keys, the first test goes red and this whole
 * projection can be reconsidered.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/intelValueProjection.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CLAIM_VALUE_KEYS,
  FORBIDDEN_VALUE_KEYS,
  projectClaimValue,
  hasClaimValueKeys,
} from "../lib/intelValueProjection.js";
import { VALUE_VALIDATORS, validateClaimValue } from "../lib/quickSignal.js";
import { TRAIL_VALUE_VALIDATORS } from "../lib/trailFollowup.js";
import { writeObservation } from "../services/intel/IntelCaptureService.js";

/** One canonical, validator-passing value per claim type. */
const CANONICAL: Record<string, Record<string, unknown>> = {
  "crowd.level": { level: "busy" },
  "crowd.trajectory": { trajectory: "building" },
  "queue.wait": { minMinutes: 5, maxMinutes: 10 },
  "access.walk_in": { accepted: true },
  "vibe.state": { state: "social" },
  "event.status": { status: "under_way" },
  "closure.state": { state: "open" },
  "crowd.direction": { direction: "arriving" },
  "music.current": { genre: "house", confidence: 0.8 },
  "access.reservation": { reservation: "recommended" },
  "access.dress": { policy: "smart casual", enforced: true, qualifiers: ["no trainers"] },
  "price.cover": { amount: 10, currency: "GBP", accessType: "general" },
  "crowd.mix": { mix: "mixed" },
  "inventory.status": { item: "oysters", status: "limited" },
  "service.wait": { serviceType: "table", minMinutes: 5, maxMinutes: 20 },
  "transit.condition": { routeOrMode: "N1 bus", condition: "delayed" },
  "experience.next_move": { destinationArea: "Soho", timeWindow: "soon", strength: 0.5 },
  "experience.exit_reason": { reason: "too_crowded" },
};

describe("the premise: the validators accept keys they never named", () => {
  it("an extra key rides a VALID crowd.level — including a raw coordinate", () => {
    assert.equal(validateClaimValue("crowd.level", { level: "busy", note: "met Alice at 9pm" }), true,
      "the validators now reject extra keys — re-derive whether this projection is still needed");
    assert.equal(validateClaimValue("queue.wait", { minMinutes: 5, maxMinutes: 10, lat: 51.5, lng: -0.1 }), true);
  });
});

describe("CLAIM_VALUE_KEYS mirrors the validators — in BOTH directions", () => {
  const validatorTypes = [...Object.keys(VALUE_VALIDATORS), ...Object.keys(TRAIL_VALUE_VALIDATORS)];

  it("the corpus is non-empty (vacuity guard)", () => {
    assert.ok(validatorTypes.length >= 17, `only ${validatorTypes.length} validators found`);
    assert.ok(Object.keys(CLAIM_VALUE_KEYS).length >= 17);
  });

  it("every claim type with a validator has a key set", () => {
    for (const t of validatorTypes) {
      assert.ok(hasClaimValueKeys(t), `'${t}' validates but has no CLAIM_VALUE_KEYS entry — its value would be refused at capture`);
    }
  });

  it("every key set names a claim type that actually validates", () => {
    for (const t of Object.keys(CLAIM_VALUE_KEYS)) {
      assert.ok(validatorTypes.includes(t), `'${t}' has a key set but no validator`);
    }
  });

  it("a canonical value round-trips BYTE-IDENTICALLY for every claim type", () => {
    let checked = 0;
    for (const t of Object.keys(CLAIM_VALUE_KEYS)) {
      const canonical = CANONICAL[t];
      assert.ok(canonical, `no canonical fixture for '${t}' — this test would silently skip it`);
      const validator = (VALUE_VALIDATORS as any)[t] ?? (TRAIL_VALUE_VALIDATORS as any)[t];
      assert.equal(validator(canonical), true, `the fixture for '${t}' does not pass its own validator`);
      const projected = projectClaimValue(t, canonical);
      assert.deepEqual(projected, canonical, `'${t}' lost a key its validator requires`);
      assert.equal(validator(projected), true, `'${t}' projected to something its validator rejects`);
      checked++;
    }
    assert.equal(checked, Object.keys(CLAIM_VALUE_KEYS).length);
    assert.ok(checked > 0, "inspected nothing");
  });
});

describe("what the projection removes", () => {
  it("drops an unnamed key and keeps the named one", () => {
    assert.deepEqual(
      projectClaimValue("crowd.level", { level: "busy", note: "met Alice at 9pm", email: "a@b.c" }),
      { level: "busy" },
    );
  });

  it("drops every raw-GPS key, even where the value space would otherwise be fine", () => {
    const out = projectClaimValue("queue.wait", { minMinutes: 5, maxMinutes: 10, lat: 51.5, lng: -0.1, accuracy: 3 });
    assert.deepEqual(out, { minMinutes: 5, maxMinutes: 10 });
    for (const k of FORBIDDEN_VALUE_KEYS) assert.equal(k in (out as object), false);
  });

  it("strips a coordinate NESTED inside a named object-valued key", () => {
    // No shipped value space has an object-valued key; this is the guard for the
    // one that eventually does, and mirrors lib/canonicalEvents' deep strip.
    const out = projectClaimValue("access.dress", {
      policy: "smart casual", enforced: true,
      qualifiers: [{ note: "x", lat: 51.5 } as any],
    });
    assert.deepEqual((out as any).qualifiers, [{ note: "x" }]);
  });

  it("an unknown claim type projects to null — a refusal, never an empty value", () => {
    assert.equal(projectClaimValue("crowd.teleport", { level: "busy" }), null);
    assert.equal(projectClaimValue("", {}), null);
  });

  it("a non-object value projects to null", () => {
    assert.equal(projectClaimValue("crowd.level", "busy"), null);
    assert.equal(projectClaimValue("crowd.level", ["busy"]), null);
    assert.equal(projectClaimValue("crowd.level", null), null);
  });

  it("an absent optional key stays absent — it is never materialised as undefined", () => {
    const out = projectClaimValue("music.current", { genre: "house" })!;
    assert.deepEqual(out, { genre: "house" });
    assert.equal("confidence" in out, false);
  });
});

// ── End to end: what actually lands in the row ───────────────────────────────

const ACTOR = "11111111-1111-4111-8111-111111111111";
const PLACE = "22222222-2222-4222-8222-222222222222";
const OBSERVED = new Date(Date.now() - 5 * 60_000).toISOString();

/** The minimum fake the capture service's chains need. */
function makeDb() {
  const observations: any[] = [];
  let seq = 0;
  function from(table: string) {
    let op: "select" | "insert" | "insert_select" = "select";
    let payload: any = null;
    let single = false;
    const filters: [string, any][] = [];
    function run() {
      if (table === "feature_flags") return { data: { enabled: true }, error: null };
      if (table === "places") return { data: { id: PLACE }, error: null };
      if (table === "intel_contribution_consent") return { data: { enabled: true, withdrawn_at: null }, error: null };
      if (op === "insert" || op === "insert_select") {
        const row = { id: `row-${++seq}`, schema_version: 1, ...payload };
        if (table === "intel_observations") observations.push(row);
        return { data: op === "insert_select" ? row : null, error: null };
      }
      return { data: single ? null : [], error: null };
    }
    const b: any = {
      select() { op = op === "insert" ? "insert_select" : "select"; return b; },
      insert(row: any) { op = "insert"; payload = row; return b; },
      eq(c: string, v: any) { filters.push([c, v]); return b; },
      in() { return b; },
      is() { return b; },
      gte() { return b; },
      order() { return b; },
      limit() { return Promise.resolve(run()); },
      maybeSingle() { single = true; return Promise.resolve(run()); },
      single() { single = true; return Promise.resolve(run()); },
      then(resolve: (r: any) => any) { return Promise.resolve(run()).then(resolve); },
    };
    return b;
  }
  return { from, _observations: observations };
}

describe("writeObservation stores the PROJECTED value, not the client's object", () => {
  it("a validated crowd.level carrying free text and coordinates lands as { level } alone", async () => {
    const db = makeDb();
    const r = await writeObservation(db as any, ACTOR, {
      subjectId: PLACE,
      claimType: "crowd.level",
      // Every one of these extra keys passes lib/quickSignal's validator today.
      value: { level: "busy", note: "met Alice at 9pm", lat: 51.5074, lng: -0.1278, email: "a@b.c" },
      observedAt: OBSERVED,
      idempotencyKey: "obs-projection-1",
    } as any);
    assert.equal(r.ok, true, `capture refused: ${JSON.stringify(r)}`);
    assert.equal(db._observations.length, 1, "vacuity guard: nothing was stored, so nothing was proven");
    const stored = db._observations[0].value;
    assert.deepEqual(stored, { level: "busy" },
      "the client's unnamed keys reached intel_observations.value — and 2174's promote copies that verbatim into intel_claims.value, which lib/dataRights classifies redistributable");
    assert.equal(JSON.stringify(stored).includes("Alice"), false);
    assert.equal(JSON.stringify(stored).includes("51.5074"), false);
  });

  it("a clean value is stored unchanged — the projection is not a rewrite", async () => {
    const db = makeDb();
    const r = await writeObservation(db as any, ACTOR, {
      subjectId: PLACE, claimType: "queue.wait",
      value: { minMinutes: 5, maxMinutes: 15 },
      observedAt: OBSERVED, idempotencyKey: "obs-projection-2",
    } as any);
    assert.equal(r.ok, true, `capture refused: ${JSON.stringify(r)}`);
    assert.deepEqual(db._observations[0].value, { minMinutes: 5, maxMinutes: 15 });
  });
});
