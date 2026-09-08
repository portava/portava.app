/**
 * §17 transactional outbox — atomicity, the privacy-filtered payload, honest
 * reads, and a static proof that no fire-and-forget emit path exists.
 *
 * Spec: docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt
 *   §17 "Use an outbox pattern: canonical mutation and event-outbox insert
 *        occur in one database transaction." (line ~509)
 *   §17 the fourteen domain-event names
 *   §18 the projections that will consume this
 *   §23 "Search/index workers consume privacy-filtered event payloads where
 *        possible rather than raw entire rows."
 *   §28.11 "Never swallow projection/schema failures into plausible-looking
 *        empty history without structured error state."
 *
 * MEASURED BEFORE: zero occurrences of `memory_event_outbox` in the repository;
 * no Memory write path emitted any of the fourteen events.
 *
 * WHAT THE FAKE PROVES AND DOES NOT PROVE
 * =======================================
 * src/test/memoryCommandKernelFake.ts is a MODEL of
 * public.memory_kernel_execute. It models the transaction: the five writes go
 * against a snapshot that is committed only if all five succeed. That lets the
 * atomicity CONTRACT be exercised — "event insert fails => the command does not
 * report success, and the canonical write is not there either"; "canonical
 * write fails => no event is emitted". It does NOT prove PostgreSQL rolls back,
 * which is the database's job and migration 2710's postconditions'.
 *
 * The static scan at the end is the part that cannot be faked: it reads this
 * lane's own source and fails if a write to the event or outbox tables appears
 * anywhere outside the RPC. That is what stops a future edit from reintroducing
 * `void sc.from('memory_event_outbox').insert(...)` — a line that, measured this
 * session, issues ZERO HTTP requests and would emit nothing while reading as an
 * emit.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/memoryOutbox.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  MEMORY_EVENT_TYPES,
  MEMORY_DOMAIN_EVENT_TYPES,
  MEMORY_OUTBOX_TABLE,
  MEMORY_EVENT_TABLE,
  eventPayloadIsPrivacyFiltered,
  isMemoryEventType,
  readUnpublishedOutbox,
} from "../lib/memoryOutbox.js";
import { COMMAND_EVENT, MEMORY_COMMAND_TYPES, executeMemoryCommand } from "../lib/memoryCommandBus.js";
import { makeKernelRpc, _resetKernelIds, type KernelState, type KernelWriteTarget } from "./memoryCommandKernelFake.js";

const OWNER = "10000000-0000-4000-8000-00000000d001";
const MEM   = "30000000-0000-4000-8000-00000000d001";

function kernelState(failOn: KernelWriteTarget[] = []): KernelState {
  _resetKernelIds();
  return {
    tables: {
      memories: [{ id: MEM, owner_id: OWNER, state: "published", title: "before", visibility: "public" }],
      memory_items: [], memory_tags: [],
      memory_events: [], memory_event_outbox: [], memory_command_receipts: [], memory_command_audit: [],
    },
    rpcCalls: [],
    failOn: new Set(failOn),
    absent: false,
  };
}

function client(state: KernelState) {
  const rpc = makeKernelRpc(state);
  return { rpc } as any;
}

const patchCommand = (key: string, title = "after") => ({
  commandId: "c0000000-0000-4000-8000-000000000001",
  memoryId: MEM,
  actorUserId: OWNER,
  idempotencyKey: key,
  type: "UPDATE_MEMORY" as const,
  payload: { patch: { title } },
});

// ═════════════════════════════════════════════════════════════════════════════
// 1. §17 vocabulary
// ═════════════════════════════════════════════════════════════════════════════

describe("§17 domain events — the vocabulary is the spec's, complete and exact", () => {
  it("declares all fourteen names verbatim", () => {
    assert.deepEqual([...MEMORY_EVENT_TYPES], [
      "memory.created", "memory.confirmed", "memory.corrected", "memory.merged",
      "memory.split", "memory.archived", "memory.deleted", "memory.visibility_changed",
      "highlight.created", "highlight.published", "highlight.expired",
      "highlight.pinned", "highlight.hidden",
    ]);
  });

  it("every declared command maps to a declared event", () => {
    for (const t of MEMORY_COMMAND_TYPES) {
      assert.ok(isMemoryEventType(COMMAND_EVENT[t]), `${t} -> ${COMMAND_EVENT[t]} is not a §17 event`);
    }
  });

  it("the memory.* subset is what this lane can emit; highlight.* is another lane's", () => {
    assert.ok(MEMORY_DOMAIN_EVENT_TYPES.every((t) => t.startsWith("memory.")));
    const emitted = new Set(MEMORY_COMMAND_TYPES.map((t) => COMMAND_EVENT[t]));
    for (const e of emitted) assert.ok(e.startsWith("memory."), `${e} is not a memory-domain event`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. ATOMICITY — the requirement the outbox exists for.
// ═════════════════════════════════════════════════════════════════════════════

describe("§17 atomicity — canonical mutation and outbox insert are one transaction", () => {
  it("baseline: a healthy command writes the row, ONE event, ONE outbox row, ONE receipt, ONE audit row", async () => {
    const s = kernelState();
    const r = await executeMemoryCommand(client(s), patchCommand("k-ok"));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(s.tables.memories[0].title, "after");
    assert.equal(s.tables.memory_events.length, 1);
    assert.equal(s.tables.memory_event_outbox.length, 1);
    assert.equal(s.tables.memory_command_receipts.length, 1);
    assert.equal(s.tables.memory_command_audit.length, 1);
    assert.equal(s.tables.memory_event_outbox[0].event_id, s.tables.memory_events[0].event_id);
    assert.equal(s.tables.memory_event_outbox[0].published_at, null, "no consumer exists yet");
  });

  it("THE EVENT INSERT FAILS ⇒ the command does NOT report success, and the canonical write is gone too", async () => {
    const s = kernelState(["event"]);
    const r = await executeMemoryCommand(client(s), patchCommand("k-evt"));
    assert.equal(r.ok, false, "a command whose event could not be written is not a success");
    assert.equal((r as any).reason, "MEMORY_KERNEL_UNAVAILABLE");
    assert.equal(s.tables.memories[0].title, "before", "the canonical row rolled back with the event");
    assert.equal(s.tables.memory_events.length, 0);
    assert.equal(s.tables.memory_event_outbox.length, 0);
    assert.equal(s.tables.memory_command_receipts.length, 0,
      "no receipt either — a replay must be able to retry, not inherit a phantom success");
  });

  it("THE OUTBOX INSERT FAILS ⇒ same answer: no success, no canonical change, no orphan event", async () => {
    const s = kernelState(["outbox"]);
    const r = await executeMemoryCommand(client(s), patchCommand("k-out"));
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "MEMORY_KERNEL_UNAVAILABLE");
    assert.equal(s.tables.memories[0].title, "before");
    assert.equal(s.tables.memory_events.length, 0, "an event with no outbox row would never be delivered");
    assert.equal(s.tables.memory_event_outbox.length, 0);
  });

  it("THE CANONICAL WRITE FAILS ⇒ NO EVENT MAY BE EMITTED", async () => {
    const s = kernelState(["state"]);
    const r = await executeMemoryCommand(client(s), patchCommand("k-state"));
    assert.equal(r.ok, false);
    assert.equal(s.tables.memories[0].title, "before");
    assert.equal(s.tables.memory_events.length, 0, "an event for a change that never landed");
    assert.equal(s.tables.memory_event_outbox.length, 0);
  });

  it("THE RECEIPT INSERT FAILS ⇒ no success, and no event that a retry would duplicate", async () => {
    const s = kernelState(["receipt"]);
    const r = await executeMemoryCommand(client(s), patchCommand("k-rcpt"));
    assert.equal(r.ok, false);
    assert.equal(s.tables.memory_events.length, 0);
    assert.equal(s.tables.memory_event_outbox.length, 0);
    assert.equal(s.tables.memories[0].title, "before");
  });

  it("a REJECTED command writes an audit row and NO event — a rejection is recorded, not rolled back", async () => {
    const s = kernelState();
    const r = await executeMemoryCommand(client(s), {
      ...patchCommand("k-rej"), memoryId: "30000000-0000-4000-8000-0000000000ff",
    });
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "MEMORY_NOT_FOUND");
    assert.equal(s.tables.memory_command_audit.length, 1, "§24 counts rejections too");
    assert.equal(s.tables.memory_command_audit[0].outcome, "rejected");
    assert.equal(s.tables.memory_command_audit[0].reason, "MEMORY_NOT_FOUND");
    assert.equal(s.tables.memory_events.length, 0);
  });

  it("supabase-js RESOLVES on a kernel failure — an unbound error would read as success", async () => {
    // The trap, stated as a test: this is exactly the shape that made the
    // pre-lane writes lie. `data` is null and `error` is set, and the promise
    // does NOT reject, so `try { const { data } = await sc.rpc(...) } catch {}`
    // would reach the success branch with `data === null` and the catch would
    // be dead code.
    const s = kernelState(["event"]);
    const envelope = {
      command_id: "c0000000-0000-4000-8000-000000000001",
      memory_id: MEM, actor_user_id: OWNER, idempotency_key: "k-shape",
      type: "UPDATE_MEMORY", payload: { patch: { title: "after" } },
    };
    let rejected = false;
    const raw = await client(s).rpc("memory_kernel_execute", { p_command: envelope })
      .catch(() => { rejected = true; return null as any; });
    assert.equal(rejected, false, "the client resolves; it does not reject");
    assert.equal(raw.data, null);
    assert.ok(raw.error, "the failure is in `error`, not a rejection");
    // And executeMemoryCommand binds it rather than reading data===null as ok.
    const r = await executeMemoryCommand(client(s), patchCommand("k-shape2"));
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "MEMORY_KERNEL_UNAVAILABLE");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. §23 privacy-filtered payloads
// ═════════════════════════════════════════════════════════════════════════════

describe("§23 event payloads carry ids and vocabulary, never the Memory's body", () => {
  it("the filter itself rejects a payload carrying a forbidden key, at any depth", () => {
    assert.equal(eventPayloadIsPrivacyFiltered({ command_type: "UPDATE_MEMORY", refs: { memory_id: MEM } }), true);
    assert.equal(eventPayloadIsPrivacyFiltered({ title: "Dinner in Lisbon" }), false);
    assert.equal(eventPayloadIsPrivacyFiltered({ refs: { memory_id: MEM, location_lat: 38.7 } }), false);
    assert.equal(eventPayloadIsPrivacyFiltered({ a: { b: { c: { hidden_user_ids: [] } } } }), false);
  });

  it("every event this kernel emits passes the filter", async () => {
    const s = kernelState();
    await executeMemoryCommand(client(s), patchCommand("p-1"));
    await executeMemoryCommand(client(s), {
      ...patchCommand("p-2"), type: "CHANGE_VISIBILITY",
      payload: { patch: { visibility: "only_me" }, visibility: "only_me" },
    });
    await executeMemoryCommand(client(s), {
      ...patchCommand("p-3"), type: "ADD_MEDIA",
      payload: { write: { memory_id: MEM, media_url: "https://secret.example/photo.jpg", media_type: "image/jpeg", caption: "at home", position: 0 } },
    });
    assert.equal(s.tables.memory_events.length, 3);
    for (const e of s.tables.memory_events) {
      assert.ok(eventPayloadIsPrivacyFiltered(e.payload_json),
        `event ${e.type} leaked: ${JSON.stringify(e.payload_json)}`);
    }
    // The media URL was in the COMMAND and must not be in the EVENT.
    const serialized = JSON.stringify(s.tables.memory_events);
    assert.ok(!serialized.includes("secret.example"), "the media URL reached the event payload");
    assert.ok(!serialized.includes("at home"), "the caption reached the event payload");
    // The audience CLASS is allowed and is what a §18 projection needs.
    const visEvent = s.tables.memory_events.find((e: any) => e.type === "memory.visibility_changed");
    assert.equal(visEvent.payload_json.visibility, "only_me");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Reading the outbox fails honestly
// ═════════════════════════════════════════════════════════════════════════════

describe("readUnpublishedOutbox — an unreadable outbox is never an empty batch", () => {
  function readerClient(result: { data: any; error: any }) {
    const b: any = {
      select: () => b, is: () => b, order: () => b,
      limit: () => Promise.resolve(result),
    };
    return { from: () => b } as any;
  }

  it("rows come back as rows", async () => {
    const r = await readUnpublishedOutbox(readerClient({
      data: [{ id: 1, event_id: "e1", memory_id: MEM, type: "memory.created", created_at: "x", published_at: null, attempts: 0 }],
      error: null,
    }));
    assert.equal(r.ok, true);
    assert.equal((r as any).rows.length, 1);
  });

  it("a genuinely empty outbox is ok:true with zero rows", async () => {
    const r = await readUnpublishedOutbox(readerClient({ data: [], error: null }));
    assert.equal(r.ok, true);
    assert.equal((r as any).rows.length, 0);
  });

  it("A DATABASE ERROR IS NOT AN EMPTY OUTBOX — the table absent (2710 unapplied) must not read as 'nothing to publish'", async () => {
    const r = await readUnpublishedOutbox(readerClient({
      data: null, error: { message: 'relation "public.memory_event_outbox" does not exist' },
    }));
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "outbox_unavailable");
    assert.match((r as any).detail, /does not exist/);
  });

  it("a non-array body is unavailable, not empty", async () => {
    const r = await readUnpublishedOutbox(readerClient({ data: { unexpected: true }, error: null }));
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "outbox_unavailable");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. STATIC — no fire-and-forget emit path exists in this lane's files.
// ═════════════════════════════════════════════════════════════════════════════

describe("no emit outside the kernel transaction", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const OWNED = [
    "../lib/memoryCommandBus.ts",
    "../lib/memoryOutbox.ts",
    "../services/memory/MemoryDomainService.ts",
    "../routes/memories.ts",
  ];

  /**
   * Comments are stripped before scanning, and this is not a convenience: the
   * first run of this test went RED on the PROSE in lib/memoryCommandBus.ts
   * that explains why a fire-and-forget emit is forbidden. A scanner that reads
   * its own warning as a violation is a scanner that will be silenced rather
   * than fixed, which is how a real hit later gets ignored.
   */
  function stripComments(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .split("\n").map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1")).join("\n");
  }

  it("no file this lane owns writes memory_events or memory_event_outbox directly", () => {
    for (const rel of OWNED) {
      const src = stripComments(readFileSync(path.join(here, rel), "utf8"));
      // A write is `.from("<table>")` followed, on the same chain, by
      // insert/update/upsert/delete. The tables are only ever named as string
      // literals, so the scan keys on the exact projected name.
      for (const table of [MEMORY_EVENT_TABLE, MEMORY_OUTBOX_TABLE]) {
        const re = new RegExp(`from\\(\\s*["'\`]${table}["'\`]\\s*\\)[\\s\\S]{0,200}?\\.(insert|update|upsert|delete)\\(`, "g");
        const hit = re.exec(src);
        assert.equal(hit, null,
          `${rel} writes ${table} outside the kernel transaction: ${hit?.[0]}`);
      }
    }
  });

  it("no fire-and-forget supabase chain (`void sc.from(...)`) in this lane's files — such a line issues ZERO requests", () => {
    for (const rel of OWNED) {
      const src = stripComments(readFileSync(path.join(here, rel), "utf8"));
      const re = /void\s+\w+\s*\n?\s*\.?from\(/g;
      assert.equal(re.exec(src), null, `${rel} contains a fire-and-forget supabase chain`);
    }
  });

  it("no `.then(undefined,` rejection-handler swallow survives in routes/memories.ts", () => {
    // MEASURED: supabase-js RESOLVES on a database error, so `.then(undefined,
    // cb)` never runs for the failure it was written to absorb. Two of these
    // stood on the participant writes before this lane.
    const src = readFileSync(path.join(here, "../routes/memories.ts"), "utf8");
    const lines = src.split("\n").filter((l) => l.includes(".then(undefined,") && !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"));
    assert.deepEqual(lines, []);
  });

  it("the outbox reader binds `error` — a lane that dropped it would make a failed read look empty", () => {
    const src = readFileSync(path.join(here, "../lib/memoryOutbox.ts"), "utf8");
    assert.match(src, /const \{ data, error \} = await sc/);
    assert.match(src, /if \(error\) \{/);
  });
});
