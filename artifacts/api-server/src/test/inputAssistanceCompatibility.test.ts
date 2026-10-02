/**
 * §48 Versioning and Compatibility — the response-schema version and the
 * capability handshake (census G341, G343).
 *
 * Run: node --import tsx/esm --test src/test/inputAssistanceCompatibility.test.ts
 *
 * THE TWO ROWS THIS FILE IS THE EVIDENCE FOR
 * ------------------------------------------
 * G341 was BUILT-BUT-WRONG — "the response carries `policyVersion` only …
 * a policy bump and a shape bump are indistinguishable to a client".
 * G343 was NOT-BUILT — "no handshake in either direction … the server keeps
 * spending work on rows it will never see used".
 *
 * THE ASSERTION THIS FILE EXISTS FOR, AND IT IS THE NEGATIVE ONE. A capability
 * declaration is a place where a client tells the server what to do, and the
 * obvious way to get it wrong is to let it WIDEN a field's allowance —
 * "I support ai_suggestion" turning on AI rows for a field whose §6 policy
 * forbids them would be §48 quietly overruling §6. `negotiateSuggestionTypes`
 * is an intersection with the policy as the left operand, and the test named
 * "cannot talk its way into a type the policy forbids" is the one that would
 * catch a union.
 *
 * WHAT IS *NOT* PROVEN HERE: that a real deployment ever bumps
 * `SUGGESTION_SCHEMA_VERSION`, or that a shipped older client degrades the way
 * the client-side half says it will. The first is a future event; the second is
 * asserted on the client, in
 * `travel-buddy-standalone/src/platform/input-assistance/services/__tests__/suggestResponse.test.ts`.
 *
 * MUTATION LOG (each applied, watched go red, reverted, `cmp` byte-identical):
 *   - negotiateSuggestionTypes: return the union instead of the intersection
 *     → "cannot talk its way into a type the policy forbids" goes RED.
 *   - negotiateSuggestionTypes: ignore the client list
 *     → "narrows to what the client declared" goes RED.
 *   - parseClientCapabilities: return [] instead of null for an
 *     all-unrecognised list → "a vocabulary this server does not know narrows
 *     nothing" goes RED.
 *   - dropUnresolvableActionRows: drop rows that have NO action
 *     → "a row with no action is never withheld" goes RED.
 *   - dropUnresolvableActionRows: ignore the declaration
 *     → "withholds the rows the client said it cannot resolve" goes RED.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SUGGESTION_SCHEMA_VERSION,
  parseClientCapabilities,
  negotiateSuggestionTypes,
  dropUnresolvableActionRows,
} from "../lib/inputAssistance/compatibility.js";
import { POLICY_VERSION, resolvePolicy } from "../lib/inputAssistance/policyRegistry.js";
import type { AssistanceType, InputSuggestion } from "../lib/inputAssistance/types.js";

function row(id: string, action?: InputSuggestion["action"]): InputSuggestion {
  return {
    id,
    type: action ? "action" : "entity",
    context: "global_search",
    label: id,
    source: "canonical",
    policyVersion: POLICY_VERSION,
    ...(action ? { action } : {}),
  } as InputSuggestion;
}

describe("§48 — the response schema version is NOT the policy version (G341)", () => {
  it("is a separate value with a separate type", () => {
    assert.equal(typeof SUGGESTION_SCHEMA_VERSION, "number");
    assert.equal(typeof POLICY_VERSION, "string");
    assert.ok(SUGGESTION_SCHEMA_VERSION >= 1);
    // The defect was that ONE value carried two facts. This is the assertion
    // that the two are now distinguishable at all: a reader of the envelope can
    // tell a policy bump from a shape bump because they are different fields of
    // different types that move for different reasons.
    assert.notEqual(String(SUGGESTION_SCHEMA_VERSION), POLICY_VERSION);
  });
});

describe("§48 — the capability handshake narrows and only narrows (G343)", () => {
  const searchPolicy = resolvePolicy("global_search")!;

  it("a request with no `client` block is served exactly as before", () => {
    assert.equal(parseClientCapabilities(undefined), null);
    assert.equal(parseClientCapabilities(null), null);
    assert.equal(parseClientCapabilities("nonsense"), null);
    assert.deepEqual(
      negotiateSuggestionTypes(searchPolicy.allowedSuggestionTypes, null),
      [...searchPolicy.allowedSuggestionTypes],
    );
  });

  it("narrows to what the client declared", () => {
    const caps = parseClientCapabilities({ schemaVersion: 1, suggestionTypes: ["entity"] });
    assert.ok(caps);
    const negotiated = negotiateSuggestionTypes(searchPolicy.allowedSuggestionTypes, caps);
    assert.deepEqual(negotiated, ["entity"]);
    // Not vacuous: the policy really does allow more than one type, so a
    // no-op implementation could not produce this answer.
    assert.ok(searchPolicy.allowedSuggestionTypes.length > 1);
  });

  it("a client cannot talk its way into a type the policy forbids", () => {
    // `global_search` does not allow `ai_suggestion` (§6/§22 — AI writing is a
    // different set of contexts). A declaration naming it must change nothing.
    assert.equal(searchPolicy.allowedSuggestionTypes.includes("ai_suggestion"), false, "precondition");
    const caps = parseClientCapabilities({
      schemaVersion: 1,
      suggestionTypes: ["entity", "ai_suggestion"] as AssistanceType[],
    });
    const negotiated = negotiateSuggestionTypes(searchPolicy.allowedSuggestionTypes, caps);
    assert.deepEqual(negotiated, ["entity"], "§48 is a compatibility mechanism, never an authority one");
    assert.equal(negotiated.includes("ai_suggestion"), false);
  });

  it("a vocabulary this server does not know narrows nothing", () => {
    // A NEWER client naming types this build has never heard of. Narrowing to
    // the empty set would blank the field for the newest clients first, which
    // is the opposite of what a compatibility mechanism is for.
    const caps = parseClientCapabilities({ schemaVersion: 2, suggestionTypes: ["quantum_row"] });
    assert.equal(caps!.suggestionTypes, null);
    assert.deepEqual(
      negotiateSuggestionTypes(searchPolicy.allowedSuggestionTypes, caps),
      [...searchPolicy.allowedSuggestionTypes],
    );
  });

  it("an unknown name inside a KNOWN list is dropped, not fatal", () => {
    const caps = parseClientCapabilities({
      schemaVersion: 1,
      suggestionTypes: ["entity", "quantum_row", "recent"],
    });
    assert.deepEqual(caps!.suggestionTypes, ["entity", "recent"]);
  });

  it("the declared list is bounded and deduplicated", () => {
    const caps = parseClientCapabilities({
      schemaVersion: 1,
      suggestionTypes: ["entity", "entity", "entity"],
    });
    assert.deepEqual(caps!.suggestionTypes, ["entity"]);
    const flood = parseClientCapabilities({
      schemaVersion: 1,
      suggestionTypes: new Array(500).fill("entity"),
    });
    assert.deepEqual(flood!.suggestionTypes, ["entity"]);
  });

  it("withholds the rows the client said it cannot resolve", () => {
    // Exactly the global search bar's case: it dispatches `add_to_trip` and
    // drops `open_compass` on arrival.
    const caps = parseClientCapabilities({
      schemaVersion: 1,
      actionTypes: ["open_entity", "submit_search", "add_to_trip"],
    });
    const rows = [
      row("plain"),
      row("trip", { type: "add_to_trip", entityId: "c1" }),
      row("compass", { type: "open_compass", context: {} }),
      row("pin", { type: "drop_pin" }),
    ];
    const { rows: kept, dropped } = dropUnresolvableActionRows(rows, caps);
    assert.deepEqual(kept.map((r) => r.id), ["plain", "trip"]);
    assert.equal(dropped, 2);
  });

  it("a row with no action is never withheld", () => {
    // "Which actions can you dispatch" says nothing about an entity row, and a
    // filter that answered it anyway would empty the list.
    const caps = parseClientCapabilities({ schemaVersion: 1, actionTypes: ["add_to_trip"] });
    const { rows: kept, dropped } = dropUnresolvableActionRows([row("a"), row("b")], caps);
    assert.equal(kept.length, 2);
    assert.equal(dropped, 0);
  });

  it("an undeclared client keeps every row, action or not", () => {
    const rows = [row("compass", { type: "open_compass", context: {} })];
    const { rows: kept, dropped } = dropUnresolvableActionRows(rows, null);
    assert.equal(kept.length, 1);
    assert.equal(dropped, 0);
  });

  it("a client that DOES declare open_compass still gets the row", () => {
    // The producer is untouched (census G137). What changed is who is told
    // about it — so this asserts the handshake did not quietly delete a
    // feature while claiming to save work.
    const caps = parseClientCapabilities({ schemaVersion: 1, actionTypes: ["open_compass"] });
    const rows = [row("compass", { type: "open_compass", context: {} })];
    const { rows: kept } = dropUnresolvableActionRows(rows, caps);
    assert.deepEqual(kept.map((r) => r.id), ["compass"]);
  });

  it("a missing or junk schemaVersion falls back to this server's, never to 0", () => {
    assert.equal(parseClientCapabilities({ suggestionTypes: ["entity"] })!.schemaVersion, SUGGESTION_SCHEMA_VERSION);
    assert.equal(parseClientCapabilities({ schemaVersion: -3, suggestionTypes: ["entity"] })!.schemaVersion, SUGGESTION_SCHEMA_VERSION);
    assert.equal(parseClientCapabilities({ schemaVersion: "2", suggestionTypes: ["entity"] })!.schemaVersion, SUGGESTION_SCHEMA_VERSION);
  });
});
