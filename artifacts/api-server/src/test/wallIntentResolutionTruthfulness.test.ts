/**
 * W71 — the Wall must never report an OUTAGE as a fact about the user.
 *
 * WHAT THIS FILE IS ABOUT
 * =======================
 * `census-wall.md` W71 records that "the Wall cannot tell a transcription
 * failure from silence". The speech-capture half of that sentence has no
 * producer anywhere in this repository (see the scope note at the bottom of this
 * header, and the W71 block in `wallSessionIntent.test.ts`). The DOWNSTREAM half
 * is Wall-owned, is reachable from the shipping UI today, and had exactly the
 * defect the row names:
 *
 *   `WallSessionIntentService.parseIntent` wrapped its `generateSuggestions`
 *   call in a `try { … } catch { suggestions = [] }`. A thrown gateway — the
 *   shared Global Input Intelligence engine being down, rate-limited, or
 *   erroring — produced a StructuredIntent with `filters: []`, which is the
 *   BYTE-FOR-BYTE SAME VALUE as "the engine ran fine and your words matched no
 *   canonical entity". `POST /wall/session-intent` then answered 200 with it and
 *   the client rendered zero chips. An outage was rendered as a finding about
 *   what the user said.
 *
 * The same collapse ran the other way at the top of the function: `if (!text)
 * return empty` produced that same value for "the user typed/said nothing",
 * so silence, a no-match, and an engine outage were three different events with
 * one indistinguishable representation. A caller could not act on any of them.
 *
 * THE CONTRACT THIS FILE PINS
 * ===========================
 * `parseIntent` now returns a DISCRIMINATED `resolution` alongside the filters,
 * and every state is separately reachable and separately named:
 *
 *   "resolved"             the engine ran and returned at least one canonical
 *                          entity — a real finding about real text
 *   "resolved_no_entities" the engine ran and found nothing canonical — also a
 *                          real finding, and a DIFFERENT one
 *   "no_text"              there was nothing to parse (empty/blank input —
 *                          the silence case). NOT a finding about words.
 *   "engine_unavailable"   the shared engine threw or was absent. An OUTAGE.
 *                          Never to be reported as either of the two findings.
 *
 * Steering is unchanged and still fail-soft: an outage still yields a
 * keyword-only intent and the Wall still renders (spec §34). What changed is
 * that the caller is now TOLD which of the four happened, instead of being
 * handed a shape that cannot say.
 *
 * MUTATION PROOFS — each of these turns a named test in this file RED:
 *   M1  hardcode `resolution: "resolved"` at the return of parseIntent
 *       → collapses all four into one. Kills "…distinct from", "no_text" and
 *         "engine_unavailable" tests.
 *   M2  make the probe verdict unconditional — `resolution =
 *       "resolved_no_entities"` regardless of `probe.ok`/`probe.failed`
 *       → THE ORIGINAL DEFECT: an outage reported as a fact about the user.
 *         Kills "an engine outage is never reported as a fact about the user",
 *         "the four states are pairwise distinct" and "an outage and a no-match
 *         are not merely different labels on the same object".
 *   M3  make the empty-text early return use "resolved_no_entities"
 *       → silence reported as "we looked and found nothing".
 *         Kills "silence is reported as silence, not as a no-match".
 *   M5  delete the `probeClient(sc, probe)` wrapper and pass `sc` straight
 *       through → the Wall loses its only view of the engine's health and every
 *       outage reads as a clean no-match.
 *         Kills the same three tests as M2.
 *   M4  drop `resolution` from the POST /wall/session-intent response body
 *       → the shipping caller cannot act on any of it.
 *         Kills "the shipping route hands the resolution to the client".
 *
 * SCOPE — WHAT THIS FILE DELIBERATELY DOES NOT CLAIM
 * ==================================================
 * Two of W71's five outcomes — an OS microphone PERMISSION DENIAL and a
 * TRANSCRIPTION FAILURE — are properties of a speech-capture surface. No such
 * surface exists in this repository: there is no speech-to-text dependency in
 * any package.json, and every microphone reference in the client tree belongs to
 * WebRTC voice CALLING (`src/components/calls/**`), which produces no transcript.
 * This file therefore does not model them, and inventing an ingress for them
 * would be a capability nothing calls. W71 stays open on that half; this file
 * closes the half that ships.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseIntent, intentIsOutage } from "../services/wall/WallSessionIntentService.js";

/**
 * A supabase fake whose queries all SUCCEED and return nothing — the "engine is
 * healthy, your words matched no canonical entity" case. `rows` lets one table
 * answer with real data so the canonical-entity path can also be exercised.
 */
function healthyClient(rows: Record<string, any[]> = {}): any {
  function builder(table: string) {
    const payload = () => ({ data: rows[table] ?? [], error: null });
    const b: any = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "then") {
            return (onF: any, onR: any) => Promise.resolve(payload()).then(onF, onR);
          }
          if (prop === "maybeSingle" || prop === "single") {
            return () => Promise.resolve({ data: (rows[table] ?? [])[0] ?? null, error: null });
          }
          return () => b;
        },
      },
    );
    return b;
  }
  return { from: builder, rpc: () => Promise.resolve({ data: [], error: null }) };
}

/** One canonical city row, shaped as `lib/canonicalLocations` reads it. */
const BANGKOK_ROW = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "city",
  name: "Bangkok",
  normalized_name: "bangkok",
  search_key: "bangkok",
  display_name: "Bangkok, Thailand",
  city: "Bangkok",
  region: null,
  country: "Thailand",
  country_code: "TH",
  postal_code: null,
  lat: 13.7563,
  lng: 100.5018,
};

/**
 * A client whose every query FAILS. This is what a total outage of the shared
 * engine's data plane looks like from the Wall's side of the boundary.
 *
 * IT DOES NOT MAKE `generateSuggestions` THROW, and that is the point: the
 * gateway catches every one of its own data-plane failures and returns `[]`, so
 * a thrown-exception fake would test a branch production cannot reach. This fake
 * reproduces the REAL failure mode — every query errors, the gateway swallows
 * each one, and `[]` comes back looking exactly like a clean no-match.
 */
function totalOutageClient(): any {
  const err = { message: "input-intelligence data plane is down", code: "57P01" };
  function builder(_table: string) {
    const b: any = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "then") {
            return (onF: any, onR: any) => Promise.resolve({ data: null, error: err }).then(onF, onR);
          }
          if (prop === "maybeSingle" || prop === "single") {
            return () => Promise.resolve({ data: null, error: err });
          }
          return () => b;
        },
      },
    );
    return b;
  }
  return { from: builder, rpc: () => Promise.resolve({ data: null, error: err }) };
}

describe("W71 — the Wall's four intent-resolution states are distinct and truthful", () => {
  it("silence is reported as silence, not as a no-match (kills M3)", async () => {
    const intent = await parseIntent(healthyClient(), "u1", "   ");
    assert.equal(
      intent.resolution,
      "no_text",
      "empty input must report that there was nothing to parse — not that a search came back empty",
    );
    assert.deepEqual(intent.filters, []);
  });

  it("a healthy engine that matches nothing canonical says so (kills M1)", async () => {
    const intent = await parseIntent(
      healthyClient(),
      "u1",
      "zzqqx nonsense that matches nothing",
    );
    assert.equal(
      intent.resolution,
      "resolved_no_entities",
      "the engine ran and found nothing — that is a finding, and it is not silence",
    );
  });

  it("a healthy engine that resolves a canonical entity says resolved (kills M1)", async () => {
    // The gateway resolves geography without a database round trip for canonical
    // cities, so a real entity filter comes back over the empty fake.
    const intent = await parseIntent(healthyClient({ canonical_locations: [BANGKOK_ROW] }), "u1", "Bangkok");
    assert.equal(
      intent.resolution,
      "resolved",
      `expected a canonical resolution; got ${intent.resolution} with filters ` +
        JSON.stringify(intent.filters),
    );
    assert.ok(
      intent.filters.some((f) => f.entityId),
      "a 'resolved' verdict must be backed by at least one canonical entity filter",
    );
  });

  it("an engine outage is never reported as a fact about the user (kills M2)", async () => {
    const intent = await parseIntent(totalOutageClient(), "u1", "bangkok nightlife");
    assert.equal(
      intent.resolution,
      "engine_unavailable",
      "a thrown shared engine is an OUTAGE — reporting it as 'we found nothing' states " +
        "something about the user's words that was never established",
    );
    // …and it is still fail-soft: the Wall still steers and still renders (§34).
    assert.deepEqual(intent.filters, []);
    assert.ok(
      intent.keywords.includes("bangkok"),
      "an outage must still degrade to a keyword-only steer, not to nothing",
    );
  });

  it("the four states are pairwise distinct — no two collapse (kills M1, M2, M3)", async () => {
    const seen = [
      (await parseIntent(healthyClient(), "u1", "")).resolution,
      (await parseIntent(healthyClient(), "u1", "zzqqx nonsense that matches nothing"))
        .resolution,
      (await parseIntent(healthyClient({ canonical_locations: [BANGKOK_ROW] }), "u1", "Bangkok")).resolution,
      (await parseIntent(totalOutageClient(), "u1", "bangkok nightlife")).resolution,
    ];
    assert.equal(
      new Set(seen).size,
      4,
      `the four outcomes must be four values; got ${JSON.stringify(seen)}`,
    );
  });

  it("an outage and a no-match are not merely different labels on the same object (kills M2)", async () => {
    // The point of the row: a caller must be able to BRANCH. Two states that
    // differ only in a field nobody can reach are not two states.
    const outage = await parseIntent(totalOutageClient(), "u1", "museums");
    const noMatch = await parseIntent(healthyClient(), "u1", "museums");
    assert.notEqual(outage.resolution, noMatch.resolution);
    assert.equal(
      intentIsOutage(outage),
      true,
      "the exported predicate must classify the outage as an outage",
    );
    assert.equal(
      intentIsOutage(noMatch),
      false,
      "a healthy empty result must NOT be classified as an outage",
    );
  });
});

describe("W71 — the engine-side half, pinned rather than asserted", () => {
  it("generateSuggestions does NOT throw on a total data-plane outage — it returns []", async () => {
    // This is the fact that makes the probe necessary, and it belongs to the
    // Global Input Intelligence lane, not to the Wall. Every data-plane call in
    // lib/inputAssistance/gateway.ts is wrapped in `.catch(() => [])`, so from
    // the Wall's side a dead database and a clean no-match are the same value.
    // If this test ever goes red because the gateway started propagating its
    // failures, the Wall's probe becomes belt-and-braces rather than the only
    // signal — and that would be an improvement, not a regression. Read the
    // failure that way before "fixing" it.
    const { generateSuggestions } = await import("../lib/inputAssistance/gateway.js");
    const { resolvePolicy } = await import("../lib/inputAssistance/policyRegistry.js");
    const policy = resolvePolicy("global_search");
    assert.ok(policy, "global_search policy must exist");
    const out = await generateSuggestions(totalOutageClient(), {
      context: "global_search",
      policy: policy!,
      text: "bangkok nightlife",
      userId: "u1",
      limit: policy!.maxSuggestions,
      lat: null,
      lng: null,
      city: null,
    });
    assert.ok(Array.isArray(out), "the gateway swallowed the outage and returned an array");
    assert.deepEqual(
      out.filter((s: any) => s.entityId),
      [],
      "a total outage must not somehow produce entity rows",
    );
  });
});

describe("W71 — the shipping route hands the resolution to the client (kills M4)", () => {
  it("POST /wall/session-intent echoes the resolution in its response body", async () => {
    const { readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const route = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "routes", "wall.ts"),
      "utf8",
    );
    // COMMENTS ARE STRIPPED FIRST, and that is not fussiness. The first version
    // of this assertion matched the whole handler text, and the explanatory
    // comment above the response line contains the word `intentResolution` — so
    // deleting the field itself left the test GREEN. A mutation that a test
    // cannot see is a test that is not testing anything.
    const code = route
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !/^\s*\/\//.test(l))
      .join("\n");
    const at = code.indexOf('router.post(\n  "/wall/session-intent"');
    assert.ok(at >= 0, "the POST /wall/session-intent handler must be found");
    const handler = code.slice(at, at + 2500);
    assert.match(
      handler,
      /res\.status\(200\)\.json\(\{[^}]*intentResolution:/,
      "the 200 response must carry the resolution — a state the client cannot see " +
        "is a state the product does not have",
    );
  });
});
