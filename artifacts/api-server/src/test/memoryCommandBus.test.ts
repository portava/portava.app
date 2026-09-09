/**
 * lib/memoryCommandBus.ts and services/memory/MemoryDomainService.ts — the §5
 * machine, the §17 vocabulary, the §19 envelope, the §23 capability table and
 * the §24 counter, exercised as units.
 *
 * Spec: docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt
 *   §4  MemoryLifecycleState's seven values (line 178)
 *   §5  the lifecycle diagram (207)
 *   §17 the seventeen commands and fourteen events (478)
 *   §19 server-side idempotency (539)
 *   §23 canEditMemory and the participant rule (596)
 *   §24 reason codes in operational output (612)
 *
 * These are pure: no HTTP, no client, no flag. The route-level proofs are in
 * src/test/memoryCommandRoutes.test.ts and the outbox proofs in
 * src/test/memoryOutbox.test.ts.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/memoryCommandBus.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  assertLifecycleTransition,
  lifecycleStateOf,
  readMemoryCommandEnvelope,
  readMemoryCommandRejectedTotal,
  _resetMemoryCommandRejectedTotal,
  executeMemoryCommand,
  COMMAND_CAPABILITY,
  COMMAND_EVENT,
  MEMORY_COMMAND_TYPES,
  MEMORY_COMMAND_TYPES_NOT_DECLARED,
  MEMORY_LIFECYCLE_STATES,
  MEMORY_STORED_STATES,
} from "../lib/memoryCommandBus.js";
import {
  authorizeParticipantCommand,
  commandTypeForPatch,
  guardLifecycle,
} from "../services/memory/MemoryDomainService.js";

// ── §4 / §5 vocabulary ───────────────────────────────────────────────────────

describe("§4 MemoryLifecycleState and its projection onto the stored column", () => {
  it("declares the spec's seven states verbatim", () => {
    assert.deepEqual([...MEMORY_LIFECYCLE_STATES],
      ["CANDIDATE", "CONFIRMED", "ACTIVE", "ARCHIVED", "REJECTED", "MERGED", "DELETED"]);
  });

  it("every stored value 0067_memories.sql permits has a spec state", () => {
    for (const s of MEMORY_STORED_STATES) {
      assert.ok(lifecycleStateOf(s), `${s} has no §4 lifecycle state`);
    }
    assert.equal(lifecycleStateOf("draft"), "CANDIDATE");
    assert.equal(lifecycleStateOf("published"), "ACTIVE");
    assert.equal(lifecycleStateOf("archived"), "ARCHIVED");
    assert.equal(lifecycleStateOf("deleted"), "DELETED");
    assert.equal(lifecycleStateOf("removed"), "DELETED");
  });

  it("an UNKNOWN stored value is null, not a plausible 'CANDIDATE'", () => {
    // The CHECK constraint makes this impossible today. It will not stay
    // impossible if someone widens it, and guessing here is exactly the
    // §28.11 failure — a schema surprise served as a confident answer.
    assert.equal(lifecycleStateOf("quarantined"), null);
    assert.equal(lifecycleStateOf(null), null);
    assert.equal(lifecycleStateOf(undefined), null);
  });
});

describe("§5 the transition table, arrow by arrow", () => {
  const ALLOW: Array<[string, string]> = [
    ["draft", "published"], ["draft", "deleted"], ["draft", "draft"],
    ["published", "archived"], ["published", "deleted"], ["published", "published"],
    ["archived", "published"], ["archived", "deleted"], ["archived", "archived"],
  ];
  for (const [f, t] of ALLOW) {
    it(`allows ${f} -> ${t}`, () => {
      const v = assertLifecycleTransition(f, t);
      assert.equal(v.ok, true, JSON.stringify(v));
    });
  }

  const REFUSE: Array<[string, string, string]> = [
    ["published", "draft", "MEMORY_LIFECYCLE_INVALID_TRANSITION"],
    ["archived", "draft", "MEMORY_LIFECYCLE_INVALID_TRANSITION"],
    ["published", "removed", "MEMORY_LIFECYCLE_INVALID_TRANSITION"],
    ["draft", "removed", "MEMORY_LIFECYCLE_INVALID_TRANSITION"],
    ["deleted", "published", "MEMORY_LIFECYCLE_TERMINAL"],
    ["deleted", "draft", "MEMORY_LIFECYCLE_TERMINAL"],
    ["removed", "published", "MEMORY_LIFECYCLE_TERMINAL"],
    ["removed", "archived", "MEMORY_LIFECYCLE_TERMINAL"],
    ["removed", "deleted", "MEMORY_LIFECYCLE_TERMINAL"],
  ];
  for (const [f, t, reason] of REFUSE) {
    it(`refuses ${f} -> ${t} with ${reason}`, () => {
      const v = assertLifecycleTransition(f, t);
      assert.equal(v.ok, false);
      assert.equal((v as any).reason, reason);
    });
  }

  it("a state outside the vocabulary refuses every transition and says which", () => {
    const v = assertLifecycleTransition("quarantined", "published");
    assert.equal(v.ok, false);
    assert.equal((v as any).reason, "MEMORY_LIFECYCLE_UNKNOWN_STATE");
    assert.equal((v as any).from, "quarantined");
  });

  it("a successful verdict carries the SPEC pair, which is what reaches the event payload", () => {
    const v = assertLifecycleTransition("draft", "published");
    assert.equal(v.ok, true);
    assert.equal((v as any).fromState, "CANDIDATE");
    assert.equal((v as any).toState, "ACTIVE");
  });

  it("guardLifecycle with no target state is a pass-through, not a refusal", () => {
    const g = guardLifecycle("published", undefined);
    assert.equal(g.ok, true);
    assert.equal((g as any).fromState, "ACTIVE");
  });
});

// ── §17 vocabulary completeness ──────────────────────────────────────────────

describe("§17 the seventeen commands are all accounted for — declared or explained", () => {
  const SPEC_17 = [
    "CREATE_MEMORY", "CONFIRM_MEMORY", "ARCHIVE_MEMORY", "DELETE_MEMORY",
    "MERGE_MEMORY", "SPLIT_MEMORY", "ADD_MEDIA", "REMOVE_MEDIA",
    "ADD_PERSON", "REMOVE_PERSON", "CHANGE_PLACE", "CHANGE_VISIBILITY",
    "PIN_HIGHLIGHT", "UNPIN_HIGHLIGHT", "PUBLISH_HIGHLIGHT", "HIDE_HIGHLIGHT",
    "SET_RESURFACING_POLICY",
  ];

  it("declared ∪ explained covers §17 exactly, with no overlap", () => {
    const declared = new Set<string>(MEMORY_COMMAND_TYPES);
    const notDeclared = new Set(Object.keys(MEMORY_COMMAND_TYPES_NOT_DECLARED));
    for (const name of SPEC_17) {
      assert.ok(declared.has(name) || notDeclared.has(name), `§17's ${name} is neither declared nor explained`);
      assert.ok(!(declared.has(name) && notDeclared.has(name)), `${name} is in both lists`);
    }
    // Nothing in the "not declared" list is invented: every entry is a §17 name.
    for (const n of notDeclared) assert.ok(SPEC_17.includes(n), `${n} is not a §17 command name`);
    // The one extension is marked as such by not being a §17 name.
    const extensions = [...declared].filter((d) => !SPEC_17.includes(d));
    assert.deepEqual(extensions, ["UPDATE_MEMORY"]);
  });

  /**
   * The census counted ELEVEN §17 commands as BUILT-BUT-WRONG. Two of those
   * eleven — PUBLISH_HIGHLIGHT (routes/stories.ts) and HIDE_HIGHLIGHT
   * (routes/highlights.ts) — belong to another lane and are in the
   * not-declared list with that reason. The remaining NINE are declared here,
   * plus CONFIRM_MEMORY, which the census counted as NOT-BUILT: ten §17 names.
   */
  it("ten §17 command names are declared: the nine memory-domain BBW rows plus CONFIRM_MEMORY", () => {
    const declaredSpecNames = MEMORY_COMMAND_TYPES.filter((t) => SPEC_17.includes(t));
    assert.equal(declaredSpecNames.length, 10);
    assert.deepEqual([...declaredSpecNames].sort(), [
      "ADD_MEDIA", "ADD_PERSON", "ARCHIVE_MEMORY", "CHANGE_PLACE", "CHANGE_VISIBILITY",
      "CONFIRM_MEMORY", "CREATE_MEMORY", "DELETE_MEMORY", "REMOVE_MEDIA", "REMOVE_PERSON",
    ]);
  });

  it("the capability and event tables are TOTAL over the declared commands", () => {
    for (const t of MEMORY_COMMAND_TYPES) {
      assert.ok(COMMAND_CAPABILITY[t], `${t} has no §23 capability`);
      assert.ok(COMMAND_EVENT[t], `${t} has no §17 event`);
    }
    assert.equal(Object.keys(COMMAND_CAPABILITY).length, MEMORY_COMMAND_TYPES.length);
    assert.equal(Object.keys(COMMAND_EVENT).length, MEMORY_COMMAND_TYPES.length);
  });

  it("only CREATE_MEMORY needs no existing Memory", () => {
    const none = MEMORY_COMMAND_TYPES.filter((t) => COMMAND_CAPABILITY[t] === "none");
    assert.deepEqual([...none], ["CREATE_MEMORY"]);
  });
});

// ── the PATCH -> command mapping ─────────────────────────────────────────────

describe("commandTypeForPatch — precedence is lifecycle > audience > place > field", () => {
  it("state wins over everything", () => {
    assert.equal(commandTypeForPatch({ state: "archived", visibility: "public", placeId: "p" }), "ARCHIVE_MEMORY");
    assert.equal(commandTypeForPatch({ state: "published" }), "CONFIRM_MEMORY");
    assert.equal(commandTypeForPatch({ state: "draft" }), "UPDATE_MEMORY");
  });
  it("audience next", () => {
    assert.equal(commandTypeForPatch({ visibility: "only_me", placeId: "p" }), "CHANGE_VISIBILITY");
    assert.equal(commandTypeForPatch({ hiddenUserIds: [] }), "CHANGE_VISIBILITY");
    assert.equal(commandTypeForPatch({ locationPrecision: "city" }), "CHANGE_VISIBILITY");
  });
  it("place next", () => {
    assert.equal(commandTypeForPatch({ placeId: "p" }), "CHANGE_PLACE");
    assert.equal(commandTypeForPatch({ locationLat: 1 }), "CHANGE_PLACE");
    assert.equal(commandTypeForPatch({ canonicalLocationId: "c" }), "CHANGE_PLACE");
  });
  it("everything else is the extension", () => {
    assert.equal(commandTypeForPatch({}), "UPDATE_MEMORY");
  });
});

// ── §17 REMOVE_PERSON / ADD_PERSON authorization, as a unit ──────────────────

describe("authorizeParticipantCommand — §23 canEditMemory vs §5 participant consent", () => {
  const OWNER = "owner", TAGGED = "tagged", OTHER = "other";

  it("REMOVE_PERSON: the OWNER may (Appendix A line 776)", () => {
    const r = authorizeParticipantCommand("REMOVE_PERSON", OWNER, OWNER, TAGGED);
    assert.equal(r.ok, true);
    assert.equal((r as any).actorRole, "owner");
  });
  it("REMOVE_PERSON: the TAGGED PERSON may (§5 line 226, consent withdrawal)", () => {
    const r = authorizeParticipantCommand("REMOVE_PERSON", TAGGED, OWNER, TAGGED);
    assert.equal(r.ok, true);
    assert.equal((r as any).actorRole, "participant");
  });
  it("REMOVE_PERSON: nobody else may", () => {
    const r = authorizeParticipantCommand("REMOVE_PERSON", OTHER, OWNER, TAGGED);
    assert.equal(r.ok, false);
    assert.equal((r as any).rejection.reason, "MEMORY_AUTH_NOT_OWNER");
  });
  it("ADD_PERSON (approve): ONLY the tagged person — an owner cannot manufacture consent", () => {
    assert.equal(authorizeParticipantCommand("ADD_PERSON", TAGGED, OWNER, TAGGED).ok, true);
    const asOwner = authorizeParticipantCommand("ADD_PERSON", OWNER, OWNER, TAGGED);
    assert.equal(asOwner.ok, false);
    assert.equal((asOwner as any).rejection.reason, "MEMORY_AUTH_NOT_PARTICIPANT");
    const asOther = authorizeParticipantCommand("ADD_PERSON", OTHER, OWNER, TAGGED);
    assert.equal(asOther.ok, false);
    assert.equal((asOther as any).rejection.reason, "MEMORY_AUTH_NOT_PARTICIPANT");
  });
  it("an owner who is also the tagged person is authorized as the participant", () => {
    const r = authorizeParticipantCommand("REMOVE_PERSON", OWNER, OWNER, OWNER);
    assert.equal(r.ok, true);
    assert.equal((r as any).actorRole, "participant");
  });
});

// ── §19 envelope ─────────────────────────────────────────────────────────────

describe("§19 Idempotency-Key envelope", () => {
  const req = (v?: string) => ({ get: (h: string) => (h.toLowerCase() === "idempotency-key" ? v : undefined) }) as any;

  it("absent header => a fresh key, marked as NOT client-generated", () => {
    const a = readMemoryCommandEnvelope(req());
    const b = readMemoryCommandEnvelope(req());
    assert.equal(a.ok, true);
    assert.equal((a as any).clientGenerated, false);
    assert.notEqual((a as any).idempotencyKey, (b as any).idempotencyKey,
      "two keyless requests must NOT collide — that would dedup unrelated writes");
  });
  it("a client key is trimmed and kept", () => {
    const r = readMemoryCommandEnvelope(req("  op-1  "));
    assert.equal((r as any).idempotencyKey, "op-1");
    assert.equal((r as any).clientGenerated, true);
  });
  it("over 200 characters is refused", () => {
    const r = readMemoryCommandEnvelope(req("k".repeat(201)));
    assert.equal(r.ok, false);
    assert.match((r as any).message, /1-200/);
  });
  it("a whitespace-only key is refused rather than silently becoming a random one", () => {
    const r = readMemoryCommandEnvelope(req("   "));
    assert.equal(r.ok, false);
  });
});

// ── §24 counter ──────────────────────────────────────────────────────────────

describe("§24 memory_command_rejected_total counts by reason", () => {
  beforeEach(() => { _resetMemoryCommandRejectedTotal(); });

  it("a structured rejection is counted under its reason", async () => {
    const sc = { rpc: async () => ({ data: { ok: false, reason: "MEMORY_AUTH_NOT_OWNER", contract_version: 1 }, error: null }) };
    const r = await executeMemoryCommand(sc, {
      commandId: "c1", memoryId: "m1", actorUserId: "u1", idempotencyKey: "k1",
      type: "ARCHIVE_MEMORY", payload: {},
    });
    assert.equal(r.ok, false);
    assert.deepEqual(readMemoryCommandRejectedTotal(), { MEMORY_AUTH_NOT_OWNER: 1 });
  });

  it("an RPC that RESOLVES with an error is MEMORY_KERNEL_UNAVAILABLE, not a success", async () => {
    const sc = { rpc: async () => ({ data: null, error: { message: "boom" } }) };
    const r = await executeMemoryCommand(sc, {
      commandId: "c1", memoryId: "m1", actorUserId: "u1", idempotencyKey: "k1",
      type: "ARCHIVE_MEMORY", payload: {},
    });
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "MEMORY_KERNEL_UNAVAILABLE");
    assert.equal((r as any).detail, "boom");
    assert.deepEqual(readMemoryCommandRejectedTotal(), { MEMORY_KERNEL_UNAVAILABLE: 1 });
  });

  it("an RPC returning NEITHER data nor error is unavailable too — a null body is not an empty success", async () => {
    const sc = { rpc: async () => ({ data: null, error: null }) };
    const r = await executeMemoryCommand(sc, {
      commandId: "c1", memoryId: "m1", actorUserId: "u1", idempotencyKey: "k1",
      type: "ARCHIVE_MEMORY", payload: {},
    });
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "MEMORY_KERNEL_UNAVAILABLE");
  });

  it("an rpc that THROWS is caught and counted rather than escaping as a 500", async () => {
    const sc = { rpc: async () => { throw new Error("transport"); } };
    const r = await executeMemoryCommand(sc, {
      commandId: "c1", memoryId: "m1", actorUserId: "u1", idempotencyKey: "k1",
      type: "ARCHIVE_MEMORY", payload: {},
    });
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "MEMORY_KERNEL_UNAVAILABLE");
  });

  it("a success is NOT counted, and the duplicate flag survives the round trip", async () => {
    const sc = { rpc: async () => ({ data: { ok: true, duplicate: true, memory_id: "m1", event_id: "e1", event_type: "memory.archived", result: { id: "m1" }, contract_version: 1 }, error: null }) };
    const r = await executeMemoryCommand(sc, {
      commandId: "c1", memoryId: "m1", actorUserId: "u1", idempotencyKey: "k1",
      type: "ARCHIVE_MEMORY", payload: {},
    });
    assert.equal(r.ok, true);
    assert.equal((r as any).duplicate, true);
    assert.equal((r as any).eventType, "memory.archived");
    assert.deepEqual(readMemoryCommandRejectedTotal(), {});
  });

  it("an event_type the kernel invents is replaced by the declared one, not passed through", async () => {
    const sc = { rpc: async () => ({ data: { ok: true, duplicate: false, memory_id: "m1", event_id: "e1", event_type: "memory.made_up", result: {}, contract_version: 1 }, error: null }) };
    const r = await executeMemoryCommand(sc, {
      commandId: "c1", memoryId: "m1", actorUserId: "u1", idempotencyKey: "k1",
      type: "ARCHIVE_MEMORY", payload: {},
    });
    assert.equal(r.ok, true);
    assert.equal((r as any).eventType, "memory.archived");
  });
});
