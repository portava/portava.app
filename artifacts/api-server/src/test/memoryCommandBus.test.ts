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
import { readFileSync } from "node:fs";
import { logger } from "../lib/logger.js";
import {
  auditCommand,
  authorizeParticipantCommand,
  commandTypeForPatch,
  failureClassOf,
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
    // The extensions are marked as such by not being §17 names, and the list is
    // PINNED so a third one cannot arrive without this assertion being read.
    //
    // UNHIDE_HIGHLIGHT joined UPDATE_MEMORY in this lane. §17 lists
    // HIDE_HIGHLIGHT and names no inverse of it, but §21 requires Archive to be
    // REVERSIBLE and §17's first sentence requires every canonical write to
    // cross this boundary — so the un-archive is a command whether or not §17
    // named it. What shipped before was a direct `.update({ archived_at: null })`
    // that emitted nothing, leaving the event log permanently disagreeing with
    // the row (src/test/highlightEventReplay.test.ts makes that executable).
    const extensions = [...declared].filter((d) => !SPEC_17.includes(d));
    assert.deepEqual(extensions, ["UPDATE_MEMORY", "UNHIDE_HIGHLIGHT"]);
  });

  /**
   * WAS TEN, IS NOW THIRTEEN, and the three that moved say what changed.
   *
   * The census counted ELEVEN §17 commands as BUILT-BUT-WRONG. Ten §17 names
   * were declared here; PUBLISH_HIGHLIGHT and HIDE_HIGHLIGHT sat in the
   * not-declared list with the reason "routes/stories.ts / routes/highlights.ts
   * belong to another lane", and PIN/UNPIN_HIGHLIGHT with the same. THAT
   * REASON WAS AN OWNERSHIP FACT, NOT A TECHNICAL ONE, and it expired.
   *
   * PIN_HIGHLIGHT, UNPIN_HIGHLIGHT and HIDE_HIGHLIGHT are now declared and
   * routed through public.highlight_kernel_execute (migration 2993), which
   * writes the event, the outbox row, the receipt and the audit row in one
   * transaction with the column change.
   *
   * PUBLISH_HIGHLIGHT is STILL not declared, and the reason in
   * MEMORY_COMMAND_TYPES_NOT_DECLARED is no longer about ownership: there is
   * no storable "published" state. That entry is asserted below, because a
   * reason that drifts back into being false is the exact failure this block
   * exists to catch.
   */
  it("thirteen §17 command names are declared: the ten memory-domain names plus the three buildable Highlight commands", () => {
    const declaredSpecNames = MEMORY_COMMAND_TYPES.filter((t) => SPEC_17.includes(t));
    assert.equal(declaredSpecNames.length, 13);
    assert.deepEqual([...declaredSpecNames].sort(), [
      "ADD_MEDIA", "ADD_PERSON", "ARCHIVE_MEMORY", "CHANGE_PLACE", "CHANGE_VISIBILITY",
      "CONFIRM_MEMORY", "CREATE_MEMORY", "DELETE_MEMORY", "HIDE_HIGHLIGHT",
      "PIN_HIGHLIGHT", "REMOVE_MEDIA", "REMOVE_PERSON", "UNPIN_HIGHLIGHT",
    ]);
  });

  it("no not-declared reason blames another lane — an ownership reason is not a technical one", () => {
    for (const [name, reason] of Object.entries(MEMORY_COMMAND_TYPES_NOT_DECLARED)) {
      assert.ok(
        !/another lane|owned by|belongs? to/i.test(reason),
        `${name}'s reason is an ownership fact, not a reason the command cannot be built: ${reason}`,
      );
    }
  });

  it("PUBLISH_HIGHLIGHT's reason names the schema fact, not a lane", () => {
    const reason = MEMORY_COMMAND_TYPES_NOT_DECLARED.PUBLISH_HIGHLIGHT as string;
    assert.match(reason, /published_at/);
    assert.match(reason, /lifecycle_state/);
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

// ── §24 the operational log's field set ──────────────────────────────────────
//
// Spec §24 (.txt:640): "Operational logs must include memoryId, commandId,
// eventId, source version, engine version, reason codes, projection name, and
// failure class."
//
// census-highlights-memories H223 measured five of the eight: memoryId,
// commandId, eventId, reason and engineVersion. The doc comment above
// auditCommand QUOTED all eight while the object below it carried five, which
// is the shape of claim this census exists to catch — in the file that cites
// the census.
//
// `projectionName` stays null and H223 stays BUILT-BUT-WRONG because of it: a
// command log has no projection, and the projection log that would carry the
// eighth field is services/memoryProjections/derivativeRegistry.ts, whose
// storage is migration 2730 — written, unapplied, never run outside a test.
describe("§24 failure class — the category of a refusal, not its reason code", () => {
  it("is null for anything that was not a refusal", () => {
    assert.equal(failureClassOf({ outcome: "accepted", reason: undefined }), null);
    assert.equal(failureClassOf({ outcome: "duplicate", reason: undefined }), null,
      "a replay answered from the receipt is a success, not a failure");
  });

  it("sorts every declared kernel reason into a class, and none into unclassified", () => {
    const expected: Record<string, string> = {
      MEMORY_COMMAND_MALFORMED: "validation",
      MEMORY_COMMAND_UNKNOWN_TYPE: "validation",
      MEMORY_NOT_FOUND: "not_found",
      MEMORY_ITEM_NOT_FOUND: "not_found",
      MEMORY_TAG_NOT_FOUND: "not_found",
      MEMORY_AUTH_NOT_OWNER: "authorization",
      MEMORY_AUTH_NOT_PARTICIPANT: "authorization",
      MEMORY_AUTH_IDEMPOTENCY_KEY_FOREIGN: "authorization",
      MEMORY_IDEMPOTENCY_KEY_REUSED: "idempotency",
      MEMORY_LIFECYCLE_TERMINAL: "lifecycle",
      MEMORY_LIFECYCLE_INVALID_TRANSITION: "lifecycle",
      MEMORY_LIFECYCLE_UNKNOWN_STATE: "lifecycle",
      MEMORY_KERNEL_UNAVAILABLE: "infrastructure",
    };
    for (const [reason, cls] of Object.entries(expected)) {
      assert.equal(failureClassOf({ outcome: "rejected", reason }), cls, `${reason} is ${cls}`);
    }
  });

  it("keeps authorization apart from not_found — the two refusals a reader must not confuse", () => {
    assert.notEqual(
      failureClassOf({ outcome: "rejected", reason: "MEMORY_AUTH_NOT_OWNER" }),
      failureClassOf({ outcome: "rejected", reason: "MEMORY_NOT_FOUND" }),
      "a spike in 'you may not' and a spike in 'there is no such thing' are different mornings",
    );
    assert.notEqual(
      failureClassOf({ outcome: "rejected", reason: "MEMORY_KERNEL_UNAVAILABLE" }),
      failureClassOf({ outcome: "rejected", reason: "MEMORY_LIFECYCLE_TERMINAL" }),
      "a broken deployment and a user editing a deleted Memory must not share a class",
    );
  });

  it("classifies the legacy path's http codes too — the path that actually runs today", () => {
    // memory_kernel_enabled has no row in production, so every refusal a user
    // meets comes through the legacy branch with an http code, not a kernel
    // reason. A classifier that only knew the kernel's vocabulary would answer
    // "unclassified" for 100% of production refusals.
    assert.equal(failureClassOf({ outcome: "rejected", reason: "forbidden" }), "authorization");
    assert.equal(failureClassOf({ outcome: "rejected", reason: "not_found" }), "not_found");
    assert.equal(failureClassOf({ outcome: "rejected", reason: "invalid_payload" }), "validation");
    assert.equal(failureClassOf({ outcome: "rejected", reason: "db_error" }), "infrastructure");
  });

  it("REFUSES to guess: an unknown reason is 'unclassified', not folded into the nearest class", () => {
    assert.equal(failureClassOf({ outcome: "rejected", reason: "MEMORY_SOMETHING_NEW" }), "unclassified");
    assert.equal(failureClassOf({ outcome: "rejected", reason: undefined }), "unclassified");
  });

  it("every MemoryKernelReason the bus declares has a class — the sets cannot drift apart silently", () => {
    // The union is a type, so it is read from the file rather than retyped: a
    // reason added to lib/memoryCommandBus.ts and not sorted here would answer
    // "unclassified" in production and nothing would say so.
    const src = readFileSync(new URL("../lib/memoryCommandBus.ts", import.meta.url), "utf8");
    const union = src.match(/export type MemoryKernelReason =([\s\S]*?);\n/)?.[1] ?? "";
    const reasons = [...union.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]!);
    assert.ok(reasons.length >= 13, `expected the declared union, read ${reasons.length}`);
    for (const reason of reasons) {
      assert.notEqual(failureClassOf({ outcome: "rejected", reason }), "unclassified",
        `${reason} is declared by the command bus and sorted into no failure class`);
    }
  });
});

describe("§24 the audit LINE, not just the classifier", () => {
  // FOUND BY A SURVIVING MUTATION. Replacing `failureClass: failureClassOf(a)`
  // with `failureClass: null` in auditCommand broke nothing: every assertion
  // was on the classifier, and none on the line it is supposed to appear on.
  // A field that is computed and then not logged is not a log field.
  function capture(fn: () => void): Array<Record<string, unknown>> {
    const lines: Array<Record<string, unknown>> = [];
    const realInfo = logger.info.bind(logger);
    const realWarn = logger.warn.bind(logger);
    (logger as any).info = (obj: any) => { lines.push(obj); };
    (logger as any).warn = (obj: any) => { lines.push(obj); };
    try { fn(); } finally {
      (logger as any).info = realInfo;
      (logger as any).warn = realWarn;
    }
    return lines;
  }

  /** §24 .txt:640, in the spec's own order. */
  const SECTION_24_FIELDS = [
    "memoryId", "commandId", "eventId", "sourceVersion",
    "engineVersion", "reason", "projectionName", "failureClass",
  ] as const;

  it("an ACCEPTED command logs all eight §24 field names", () => {
    const [line] = capture(() => auditCommand({
      commandId: "cmd-1", commandType: "CHANGE_VISIBILITY", memoryId: "mem-1",
      actorUserId: "user-1", idempotencyKey: "key-1", outcome: "accepted",
      eventId: "evt-1", durable: false, sourceVersion: "2026-09-13T00:00:00.000Z",
    }));
    assert.ok(line, "auditCommand emitted no line at all");
    for (const f of SECTION_24_FIELDS) {
      assert.ok(f in line!, `§24 field ${f} is missing from the operational log line`);
    }
    assert.equal(line!.sourceVersion, "2026-09-13T00:00:00.000Z");
    assert.equal(line!.failureClass, null, "an accepted command has no failure class");
    assert.equal(line!.projectionName, null,
      "a command is not a projection — the key is present and empty on purpose");
    assert.equal(line!.engineVersion, "memory-kernel/1");
  });

  it("a REJECTED command logs the failure class beside the reason code", () => {
    const [line] = capture(() => auditCommand({
      commandId: "cmd-2", commandType: "ARCHIVE_MEMORY", memoryId: "mem-2",
      actorUserId: "user-2", idempotencyKey: "key-2", outcome: "rejected",
      reason: "MEMORY_LIFECYCLE_TERMINAL", durable: false, sourceVersion: null,
    }));
    assert.equal(line!.reason, "MEMORY_LIFECYCLE_TERMINAL", "the reason code is what the client switches on");
    assert.equal(line!.failureClass, "lifecycle", "the class is what an operator reads on a dashboard");
    assert.equal(line!.sourceVersion, null, "null is a state, not a missing key");
    assert.ok("sourceVersion" in line!);
  });

  it("does not log the Memory's body — §24's second sentence", () => {
    const [line] = capture(() => auditCommand({
      commandId: "cmd-3", commandType: "UPDATE_MEMORY", memoryId: "mem-3",
      actorUserId: "user-3", idempotencyKey: "key-3", outcome: "accepted", durable: false,
    }));
    for (const forbidden of ["title", "caption", "patch", "payload", "allowedUserIds", "hiddenUserIds", "locationLat", "locationLng"]) {
      assert.equal(forbidden in line!, false, `${forbidden} must never reach an operational log`);
    }
  });
});
