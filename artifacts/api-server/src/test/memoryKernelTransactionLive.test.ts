/**
 * Memory command kernel — LIVE DATABASE transactional certification.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS: A DOUBLE CANNOT PROVE A TRANSACTION
 * ══════════════════════════════════════════════════════════════════════════════
 * src/test/memoryOutbox.test.ts asserts §17's central claim — "canonical
 * mutation and event-outbox insert occur in one database transaction" — against
 * src/test/memoryCommandKernelFake.ts, an in-memory double. That suite is worth
 * having: it pins the SHAPE of the contract and it goes red if the TypeScript
 * around the RPC starts inventing answers. What it cannot do is prove the
 * claim. The fake rolls back because it was written to roll back. Ask what
 * would turn it red and the answer is "editing the fake", which is not a
 * property of the database.
 *
 * Everything below runs against the sanctioned CI Postgres, through the real
 * `public.memory_kernel_execute` and the real `src/lib/memoryCommandBus.ts` /
 * `src/lib/memoryOutbox.ts` — so a red here is a fact about the deployed
 * function, not about a mock.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE CANNOT REACH, AND WHERE THAT PROOF LIVES INSTEAD
 * ══════════════════════════════════════════════════════════════════════════════
 * Failure case 1 in its literal form — "the outbox INSERT fails, therefore the
 * canonical write rolls back" — needs a fault INSIDE the function's
 * transaction. Every constraint downstream of the canonical write is satisfied
 * by construction for a well-formed command, which is a good property of the
 * function and an inconvenient one for a certifier: there is no reachable
 * partial-failure path from a client. supabase-js issues no DDL and this
 * database exposes no exec-SQL RPC, so the fault cannot be injected from here.
 *
 * It was injected out of band against the CI project, and the SQL is recorded
 * here verbatim so the result is reproducible rather than merely reported:
 *
 *   create or replace function public.obxcert_fail_outbox() returns trigger
 *   language plpgsql as $f$ begin
 *     raise exception 'injected outbox failure' using errcode='raise_exception';
 *   end $f$;
 *   create trigger trg_obxcert_fail_outbox before insert
 *     on public.memory_event_outbox for each row
 *     execute function public.obxcert_fail_outbox();
 *   -- then, on a 'published' memory M with one prior event:
 *   --   select public.memory_kernel_execute('{... ARCHIVE_MEMORY on M ...}');
 *   -- MEASURED: the call RAISED (it did not return a rejection), and afterwards
 *   --   M.state                      = 'published'   (the UPDATE rolled back)
 *   --   events for M                 = 1             (the archived event is gone)
 *   --   outbox rows for M            = 1
 *   --   receipts for that key        = 0
 *   --   audit rows for that command  = 0
 *   -- CONTROL: drop the trigger, replay the IDENTICAL command — state becomes
 *   --   'archived', event #2 memory.archived appears, receipt and audit follow.
 *   --   Without that control the "unchanged" reading proves only inertness.
 *   -- CORROBORATION: memory_event_outbox.id skipped a value across the aborted
 *   --   attempt. An identity value is allocated at INSERT and not reclaimed on
 *   --   rollback, so the gap is the scar of an outbox insert that really was
 *   --   attempted and really was undone.
 *   drop trigger trg_obxcert_fail_outbox on public.memory_event_outbox;
 *   drop function public.obxcert_fail_outbox();
 *
 * The half of case 1 that IS reachable from here — a failure at the canonical
 * write itself, which must leave no event behind — is asserted below, because
 * that is the direction a fire-and-forget TypeScript emit would break.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * NOTE ON SKIPPING
 * ══════════════════════════════════════════════════════════════════════════════
 * `.github/scripts/run-live-suite.sh` scores a live suite on its OUTPUT (pass
 * > 0 AND skipped == 0), not on its exit code, so a run without credentials
 * fails the job rather than passing vacuously.
 *
 * Run: node --import tsx/esm --env-file-if-exists=.env --test \
 *        src/test/memoryKernelTransactionLive.test.ts
 *
 * The table names are NOT written out here. `MEMORY_EVENT_TABLE` and
 * `MEMORY_OUTBOX_TABLE` come from src/lib/memoryOutbox.ts, which
 * src/scripts/checkMemoryTableOwnership.ts designates as the one module allowed
 * to name the kernel's event log. Importing the constant rather than retyping
 * the string is the rule that check exists to enforce, so this file needs no
 * entry in its KERNEL_SIDE list — and must not be given one, since the
 * staleness pass rejects a classification for a file that names neither table.
 */
// FIRST import, deliberately: refuses to let this process reach an unsanctioned
// database before the Supabase client library is even loaded.
import "../lib/ciSupabaseGuard.mjs";

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { findUserByEmail, deleteFixtureUser, fixtureEmail, fixtureLabel } from "./liveFixtureUsers.js";
import {
  MEMORY_EVENT_TABLE,
  MEMORY_OUTBOX_TABLE,
  eventPayloadIsPrivacyFiltered,
  readUnpublishedOutbox,
} from "../lib/memoryOutbox.js";
import { executeMemoryCommand, MEMORY_KERNEL_FLAG, type MemoryCommand } from "../lib/memoryCommandBus.js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const CREDS = Boolean(SUPABASE_URL && SERVICE_ROLE_KEY);

const admin = (): SupabaseClient =>
  createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const TAG = "memkern_live_";
const EMAIL_OWNER = fixtureEmail(`${TAG}owner@portava-test.invalid`);
const EMAIL_OTHER = fixtureEmail(`${TAG}other@portava-test.invalid`);

/**
 * Every idempotency key this run writes starts with this. It is the ONLY handle
 * teardown has on `memory_command_audit`: that table deliberately holds no
 * foreign key to `memories` and none to `auth.users` (2710's header explains
 * why — the audit must outlive the Memory), so deleting the fixture user
 * cascades away the memories, the events, the outbox rows and the receipts and
 * leaves the audit rows standing. Sweeping them by key prefix is the cleanup.
 */
const KEY_PREFIX = `memkern-${randomUUID().slice(0, 8)}-`;
const key = (s: string): string => `${KEY_PREFIX}${s}`;

let sc: SupabaseClient;
let owner = "";
let other = "";

async function ensureUser(email: string, handle: string): Promise<string> {
  const { data: created, error } = await sc.auth.admin.createUser({
    email, password: `${TAG}Pw!23456`, email_confirm: true,
  });
  let id = created?.user?.id ?? "";
  if (error || !id) id = await findUserByEmail(sc, email);
  if (!id) throw new Error(`could not create or find test user ${email}`);
  const { error: pErr } = await sc.from("profiles").upsert({ id, handle, name: handle }, { onConflict: "id" });
  if (pErr) throw new Error(`could not upsert profile ${handle} for ${email}: ${pErr.message}`);
  return id;
}

/**
 * Read helper. supabase-js RESOLVES on a database error, so an unbound `error`
 * makes a failed read indistinguishable from an empty table — and every
 * assertion below is a count, i.e. exactly the shape that silently passes when
 * the read failed. `error` is therefore bound and THROWN on, in one place.
 */
async function rows(table: string, apply: (q: any) => any): Promise<any[]> {
  const { data, error } = await apply(sc.from(table).select("*"));
  if (error) throw new Error(`read ${table} failed: ${error.message}`);
  if (!Array.isArray(data)) throw new Error(`read ${table} returned a non-array body`);
  return data;
}

const eventsFor = (memoryId: string) => rows(MEMORY_EVENT_TABLE, (q: any) => q.eq("memory_id", memoryId).order("sequence", { ascending: true }));
const outboxFor = (memoryId: string) => rows(MEMORY_OUTBOX_TABLE, (q: any) => q.eq("memory_id", memoryId).order("id", { ascending: true }));
const receiptsFor = (k: string) => rows("memory_command_receipts", (q: any) => q.eq("idempotency_key", k));
const auditFor = (k: string) => rows("memory_command_audit", (q: any) => q.eq("idempotency_key", k).order("id", { ascending: true }));

async function memoryRow(id: string): Promise<any> {
  const found = await rows("memories", (q: any) => q.eq("id", id));
  assert.equal(found.length, 1, `expected exactly one memories row for ${id}`);
  return found[0];
}

function cmd(over: Partial<MemoryCommand> & Pick<MemoryCommand, "type" | "idempotencyKey">): MemoryCommand {
  return {
    commandId: randomUUID(),
    memoryId: null,
    actorUserId: owner,
    payload: {},
    ...over,
  } as MemoryCommand;
}

/** CREATE_MEMORY through the real bus; returns the new memory id. */
async function createMemory(k: string, title: string, state = "published"): Promise<string> {
  const r = await executeMemoryCommand(sc, cmd({
    type: "CREATE_MEMORY",
    idempotencyKey: key(k),
    payload: { write: { title, state, visibility: "friends_only" } },
  }));
  assert.equal(r.ok, true, `CREATE_MEMORY(${k}) failed: ${JSON.stringify(r)}`);
  return (r as any).memoryId as string;
}

before(async () => {
  if (!CREDS) return;
  sc = admin();
  owner = await ensureUser(EMAIL_OWNER, fixtureLabel(`${TAG}owner`));
  other = await ensureUser(EMAIL_OTHER, fixtureLabel(`${TAG}other`));
});

after(async () => {
  if (!CREDS) return;
  // Audit rows first: they have no FK and survive the cascade by design.
  const { error: aErr } = await sc.from("memory_command_audit").delete().like("idempotency_key", `${KEY_PREFIX}%`);
  if (aErr) console.error(`[memoryKernelTransactionLive] audit cleanup failed: ${aErr.message}`);
  // Deleting the users cascades memories -> events -> outbox -> receipts.
  for (const id of [owner, other]) if (id) await deleteFixtureUser(sc, id);
});

describe("kernel liveness — the function is here and the flag is not on", () => {
  it("the kernel tables and function exist on this database", async (t) => {
    if (!CREDS) return t.skip("no live credentials");
    const id = await createMemory("liveness", "memkern liveness");
    assert.match(id, /^[0-9a-f-]{36}$/);
    assert.equal((await eventsFor(id)).length, 1);
  });

  it("applying 2710/2711 did NOT turn the kernel on for routes/memories.ts", async (t) => {
    if (!CREDS) return t.skip("no live credentials");
    const flags = await rows("feature_flags", (q: any) => q.eq("flag", MEMORY_KERNEL_FLAG));
    assert.equal(flags.length, 1, "the kernel flag row is missing — 2710 seeds it");
    assert.equal(flags[0].enabled, false, "memory_kernel_enabled is TRUE on the CI project");
  });
});

describe("§17 atomicity — case 1, the direction a client can reach", () => {
  it("THE CANONICAL WRITE FAILS ⇒ no event, no outbox row, no receipt, no audit row", async (t) => {
    if (!CREDS) return t.skip("no live credentials");
    const id = await createMemory("atomic-a", "memkern atomic");
    const before = await memoryRow(id);
    const eventsBefore = (await eventsFor(id)).length;
    const outboxBefore = (await outboxFor(id)).length;

    // `memories_visibility_check` refuses this value, so the UPDATE inside
    // memory_kernel_execute raises. Nothing downstream of it may survive.
    const k = key("atomic-bad-visibility");
    const bad = await executeMemoryCommand(sc, cmd({
      type: "CHANGE_VISIBILITY",
      memoryId: id,
      idempotencyKey: k,
      payload: { patch: { visibility: "not-a-visibility-class" } },
    }));

    assert.equal(bad.ok, false, "a command whose canonical write violates a CHECK reported SUCCESS");
    assert.equal((bad as any).reason, "MEMORY_KERNEL_UNAVAILABLE",
      "a raised database failure must reach the bus as a failure, never as a rejection with a reason code");

    const after = await memoryRow(id);
    assert.equal(after.visibility, before.visibility, "the canonical row changed despite the failure");
    assert.equal((await eventsFor(id)).length, eventsBefore, "a failed canonical write emitted an event");
    assert.equal((await outboxFor(id)).length, outboxBefore, "a failed canonical write queued an outbox row");
    assert.equal((await receiptsFor(k)).length, 0, "a failed command left an idempotency receipt");
    assert.equal((await auditFor(k)).length, 0,
      "a failed command left an audit row — a FAILURE is not a REJECTION and must roll back with everything else");
  });

  it("CONTROL: the same command with a valid value does change the row — so the assertion above is not inertness", async (t) => {
    if (!CREDS) return t.skip("no live credentials");
    const id = await createMemory("atomic-b", "memkern atomic control");
    const before = await memoryRow(id);
    assert.notEqual(before.visibility, "only_me", "fixture precondition: start away from the target value");

    const k = key("atomic-good-visibility");
    const good = await executeMemoryCommand(sc, cmd({
      type: "CHANGE_VISIBILITY", memoryId: id, idempotencyKey: k,
      payload: { patch: { visibility: "only_me" } },
    }));
    assert.equal(good.ok, true, JSON.stringify(good));
    assert.equal((await memoryRow(id)).visibility, "only_me");
    assert.equal((await eventsFor(id)).length, 2);
    assert.equal((await outboxFor(id)).length, 2);
    assert.equal((await receiptsFor(k)).length, 1);
    assert.deepEqual((await auditFor(k)).map((r) => r.outcome), ["accepted"]);
    assert.equal((await eventsFor(id))[1].type, "memory.visibility_changed");
  });

  it("a REJECTED command is different from a FAILED one: it writes an audit row and no event", async (t) => {
    if (!CREDS) return t.skip("no live credentials");
    const id = await createMemory("reject", "memkern reject");
    const k = key("reject-not-owner");
    const r = await executeMemoryCommand(sc, cmd({
      type: "ARCHIVE_MEMORY", memoryId: id, actorUserId: other, idempotencyKey: k, payload: {},
    }));
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "MEMORY_AUTH_NOT_OWNER");
    assert.equal((await eventsFor(id)).length, 1, "a rejection emitted an event");
    assert.equal((await memoryRow(id)).state, "published");
    assert.deepEqual((await auditFor(k)).map((r2) => [r2.outcome, r2.reason]), [["rejected", "MEMORY_AUTH_NOT_OWNER"]],
      "§24 has nothing to count if refusals are not recorded");
  });
});

describe("§19 idempotency — case 4", () => {
  it("SAME key, DIFFERENT body ⇒ ONE effect, and the ORIGINAL response is returned", async (t) => {
    if (!CREDS) return t.skip("no live credentials");
    const id = await createMemory("idem", "memkern idem");
    const k = key("idem-1");

    const first = await executeMemoryCommand(sc, cmd({
      type: "UPDATE_MEMORY", memoryId: id, idempotencyKey: k,
      payload: { patch: { title: "FIRST-BODY", caption: "alpha" }, select: "id,title,caption" },
    }));
    const second = await executeMemoryCommand(sc, cmd({
      type: "UPDATE_MEMORY", memoryId: id, idempotencyKey: k,
      payload: { patch: { title: "SECOND-BODY", caption: "omega" }, select: "id,title,caption" },
    }));

    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(second.ok, true, JSON.stringify(second));
    const a = first as any, b = second as any;

    assert.equal(a.duplicate, false);
    assert.equal(b.duplicate, true, "the replay was applied as a new command");
    // The response body, not a recomputed one describing a different world.
    assert.deepEqual(b.result, a.result, "the replay returned a body the first call never produced");
    assert.equal(b.result.title, "FIRST-BODY");
    assert.equal(b.eventId, a.eventId, "the replay claimed a different event");
    assert.equal(b.eventType, a.eventType);

    // …and no second domain effect.
    const row = await memoryRow(id);
    assert.equal(row.title, "FIRST-BODY", "the second body was applied");
    assert.equal(row.caption, "alpha");
    assert.equal((await eventsFor(id)).length, 2, "the replay emitted a second event");
    assert.equal((await outboxFor(id)).length, 2, "the replay queued a second outbox row");
    assert.equal((await receiptsFor(k)).length, 1);
    assert.deepEqual((await auditFor(k)).map((r) => r.outcome), ["accepted", "duplicate"],
      "both attempts must be recorded, and distinguishably");
  });

  it("SAME key, DIFFERENT command type ⇒ refused, NOT handed the earlier answer", async (t) => {
    if (!CREDS) return t.skip("no live credentials");
    const id = await createMemory("idem-reuse", "memkern idem reuse");
    const k = key("idem-2");
    const first = await executeMemoryCommand(sc, cmd({
      type: "UPDATE_MEMORY", memoryId: id, idempotencyKey: k, payload: { patch: { title: "T1" } },
    }));
    assert.equal(first.ok, true);
    const reused = await executeMemoryCommand(sc, cmd({
      type: "ARCHIVE_MEMORY", memoryId: id, idempotencyKey: k, payload: {},
    }));
    assert.equal(reused.ok, false);
    assert.equal((reused as any).reason, "MEMORY_IDEMPOTENCY_KEY_REUSED");
    assert.equal((await memoryRow(id)).state, "published", "the reused key still archived the memory");
    assert.equal((await eventsFor(id)).length, 2);
  });

  it("CONCURRENT commands sharing one key produce at most ONE domain effect", async (t) => {
    if (!CREDS) return t.skip("no live credentials");
    // The receipt lookup is `SELECT ... FOR UPDATE` on a row that does not yet
    // exist, so it takes no lock: several concurrent callers can all miss it.
    // The PRIMARY KEY (actor_user_id, idempotency_key) is the only thing that
    // stops the second from applying, and it stops it by aborting the whole
    // transaction. Whatever mix of duplicate/unavailable comes back, the
    // invariant is that the world moved exactly once.
    // The setup's key label MUST differ from the race's. It did not, and this
    // test had never run in CI to say so: `createMemory(label)` issues
    // CREATE_MEMORY with `key(label)`, so `createMemory("idem-race")` CONSUMED
    // the very key the eight racers then reuse. Every one of them was refused
    // MEMORY_IDEMPOTENCY_KEY_REUSED — the case the test above this one pins —
    // and the three assertions below were satisfied by the CREATE's own receipt,
    // its own accepted audit row and its own event. Measured 2026-09-09, the
    // first time this suite was invoked by a workflow: `expected create +
    // exactly one update event, got 1`. The first two assertions passed by
    // COINCIDENCE, which is why the third is the one that caught it.
    const id = await createMemory("idem-race-setup", "memkern idem race");
    const k = key("idem-race");
    const N = 8;
    const results = await Promise.all(
      Array.from({ length: N }, () => executeMemoryCommand(sc, cmd({
        type: "UPDATE_MEMORY", memoryId: id, idempotencyKey: k,
        payload: { patch: { title: "RACE" }, select: "id,title" },
      }))),
    );

    const receipts = await receiptsFor(k);
    const events = await eventsFor(id);
    const audit = await auditFor(k);
    const accepted = audit.filter((r) => r.outcome === "accepted");

    assert.equal(receipts.length, 1, `expected exactly one receipt, got ${receipts.length}`);
    assert.equal(accepted.length, 1, `expected exactly one ACCEPTED audit row, got ${accepted.length}`);
    assert.equal(events.length, 2, `expected create + exactly one update event, got ${events.length}`);
    assert.equal((await outboxFor(id)).length, 2);
    // Every successful reply must name the one event that actually happened.
    for (const r of results) {
      if (r.ok) assert.equal((r as any).eventId, receipts[0].event_id,
        "a caller was told about an event that is not the one in the receipt");
    }
    // Not vacuous: at least one caller has to have been told something.
    assert.ok(results.some((r) => r.ok), `all ${N} concurrent callers failed: ${JSON.stringify(results[0])}`);
  });
});

describe("§17 ordering — case 6, per aggregate", () => {
  it("SEQUENTIAL commands give a contiguous, gap-free, unique sequence", async (t) => {
    if (!CREDS) return t.skip("no live credentials");
    const id = await createMemory("order-seq", "memkern order");
    for (let i = 1; i <= 5; i++) {
      const r = await executeMemoryCommand(sc, cmd({
        type: "UPDATE_MEMORY", memoryId: id, idempotencyKey: key(`order-seq-${i}`),
        payload: { patch: { title: `SEQ-${i}` }, select: "id,title" },
      }));
      assert.equal(r.ok, true, JSON.stringify(r));
    }
    const seqs = (await eventsFor(id)).map((e) => Number(e.sequence));
    assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6]);
  });

  it("CONCURRENT writers on ONE aggregate: no duplicate sequence, no gap, and the log agrees with the row", async (t) => {
    if (!CREDS) return t.skip("no live credentials");
    // Genuinely parallel HTTP, not a loop. Serialization — if it happens — is
    // the `SELECT ... FOR UPDATE` the function takes on the memories row before
    // it allocates `max(sequence) + 1`; the UNIQUE (memory_id, sequence)
    // constraint is what makes a failure of that lock loud rather than silent.
    const id = await createMemory("order-conc", "memkern order conc");
    const N = 8;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => executeMemoryCommand(sc, cmd({
        type: "UPDATE_MEMORY", memoryId: id, idempotencyKey: key(`order-conc-${i}`),
        payload: { patch: { title: `CONC-${i}` }, select: "id,title" },
      }))),
    );
    const okCount = results.filter((r) => r.ok).length;
    assert.equal(okCount, N,
      `${N - okCount} of ${N} concurrent commands on one aggregate failed — the row lock did not serialize them: ` +
      JSON.stringify(results.filter((r) => !r.ok)));

    const events = await eventsFor(id);
    const seqs = events.map((e) => Number(e.sequence));
    assert.equal(new Set(seqs).size, seqs.length, "a per-aggregate sequence was issued twice");
    assert.deepEqual(seqs, Array.from({ length: N + 1 }, (_, i) => i + 1), "the sequence has a gap");

    // The last event must describe the state the row actually holds. If the
    // sequence were allocated outside the lock, the highest-sequence event could
    // belong to a command that was overwritten by a lower-sequence one.
    const last = events[events.length - 1];
    const receipt = (await rows("memory_command_receipts", (q: any) => q.eq("event_id", last.event_id)))[0];
    assert.ok(receipt, "the highest-sequence event has no receipt");
    assert.equal((await memoryRow(id)).title, receipt.result_json.title,
      "the canonical row does not match the highest-sequence event's command");
  });

  it("aggregates are independent: each memory's sequence starts at 1", async (t) => {
    if (!CREDS) return t.skip("no live credentials");
    const a = await createMemory("indep-a", "memkern indep a");
    const b = await createMemory("indep-b", "memkern indep b");
    assert.deepEqual((await eventsFor(a)).map((e) => Number(e.sequence)), [1]);
    assert.deepEqual((await eventsFor(b)).map((e) => Number(e.sequence)), [1]);
  });
});

describe("§17 the log is append-only — case 3's precondition", () => {
  it("UPDATE on the event log is refused for the SERVICE role, not merely ungranted to clients", async (t) => {
    if (!CREDS) return t.skip("no live credentials");
    const id = await createMemory("append", "memkern append");
    const [event] = await eventsFor(id);
    // `.select()` is present on purpose: a write with no select cannot tell one
    // affected row from none, so without it a silently-refused UPDATE and a
    // successful one look identical.
    const { data, error } = await sc.from(MEMORY_EVENT_TABLE)
      .update({ type: "memory.deleted" }).eq("event_id", event.event_id).select();
    assert.ok(error, `the event log accepted an UPDATE: ${JSON.stringify(data)}`);
    assert.equal((await eventsFor(id))[0].type, "memory.created", "the event's type changed");
    // A redelivered event is therefore byte-identical to the first delivery,
    // which is what lets a consumer dedupe on event_id at all.
  });
});

describe("§17 outbox delivery surface — cases 2 and 5", () => {
  it("an unacked row is REDELIVERED: a consumer that crashes before publishing sees it again", async (t) => {
    if (!CREDS) return t.skip("no live credentials");
    const id = await createMemory("outbox-retry", "memkern outbox retry");
    const mine = () => outboxFor(id);

    const first = await mine();
    assert.equal(first.length, 1);
    assert.equal(first[0].published_at, null);
    // "Consumer crashes here" — no ack is written.
    const second = await mine();
    assert.deepEqual(second.map((r) => r.id), first.map((r) => r.id), "the row was not redelivered");
    assert.equal(second[0].attempts, 0,
      "attempts moved — which would mean something in this system is consuming the outbox; nothing does");

    // The reader the worker will use returns rows, not an empty batch.
    const read = await readUnpublishedOutbox(sc, 500);
    assert.equal(read.ok, true, JSON.stringify(read));
    assert.ok((read as any).rows.some((r: any) => r.memory_id === id), "readUnpublishedOutbox lost the row");
  });

  it("acking a row removes it from the reader's view, and only that row", async (t) => {
    if (!CREDS) return t.skip("no live credentials");
    const id = await createMemory("outbox-ack", "memkern outbox ack");
    await executeMemoryCommand(sc, cmd({
      type: "UPDATE_MEMORY", memoryId: id, idempotencyKey: key("outbox-ack-2"),
      payload: { patch: { title: "acked" } },
    }));
    const both = await outboxFor(id);
    assert.equal(both.length, 2);

    const { data: acked, error } = await sc.from(MEMORY_OUTBOX_TABLE)
      .update({ published_at: new Date().toISOString() }).eq("id", both[0].id).select();
    assert.equal(error, null, `ack failed: ${error?.message}`);
    assert.equal(acked?.length, 1, "the ack affected a number of rows other than one");

    const after = await outboxFor(id);
    assert.equal(after.filter((r) => r.published_at === null).length, 1);
    assert.equal(after.find((r) => r.id === both[1].id)?.published_at, null, "acking one row acked another");
  });

  it("a POISON row at the head is re-served first, forever — nothing ages it out", async (t) => {
    if (!CREDS) return t.skip("no live credentials");
    const id = await createMemory("outbox-poison", "memkern outbox poison");
    for (let i = 0; i < 3; i++) {
      await executeMemoryCommand(sc, cmd({
        type: "UPDATE_MEMORY", memoryId: id, idempotencyKey: key(`outbox-poison-${i}`),
        payload: { patch: { title: `P-${i}` } },
      }));
    }
    const heads: number[] = [];
    for (let pass = 0; pass < 3; pass++) {
      const unpublished = (await outboxFor(id)).filter((r) => r.published_at === null);
      heads.push(unpublished[0].id);
      // The "consumer" fails on the head row on every pass and acks nothing.
    }
    assert.equal(new Set(heads).size, 1, "the head row changed without being acked");
    const final = await outboxFor(id);
    assert.equal(final.every((r) => r.attempts === 0), true,
      "attempts was incremented — if that ever becomes true, this suite must also assert the backoff that reads it");
    // The unrelated rows behind it are still IN the batch, so a batch-parallel
    // consumer is not blocked; a strictly in-order one is, permanently. There is
    // no max-attempts, no dead letter and no lease column to change that.
    assert.equal(final.filter((r) => r.published_at === null).length, 4);
  });
});

describe("§18 projection rebuild — case 7", () => {
  it("the LIFECYCLE projection folds deterministically from the log and matches the canonical row", async (t) => {
    if (!CREDS) return t.skip("no live credentials");
    const id = await createMemory("fold", "memkern fold", "draft");
    for (const [type, k] of [["CONFIRM_MEMORY", "fold-confirm"], ["ARCHIVE_MEMORY", "fold-archive"]] as const) {
      const r = await executeMemoryCommand(sc, cmd({ type, memoryId: id, idempotencyKey: key(k), payload: {} }));
      assert.equal(r.ok, true, JSON.stringify(r));
    }
    const events = await eventsFor(id);
    assert.deepEqual(events.map((e) => e.type), ["memory.created", "memory.confirmed", "memory.archived"]);

    // Fold: each event's from_state must be the previous event's to_state.
    let cursor: string | null = null;
    for (const e of events) {
      const from = e.payload_json.from_state as string | null;
      if (cursor !== null) assert.equal(from, cursor, `chain break at sequence ${e.sequence}`);
      cursor = e.payload_json.to_state as string;
    }
    const spec: Record<string, string> = { draft: "CANDIDATE", published: "ACTIVE", archived: "ARCHIVED", deleted: "DELETED" };
    assert.equal(cursor, spec[(await memoryRow(id)).state],
      "the fold of the log disagrees with the canonical state");
    assert.equal(cursor, "ARCHIVED");
  });

  it("a CONTENT projection is NOT rebuildable from the log — §23 puts the filter in the event's shape", async (t) => {
    if (!CREDS) return t.skip("no live credentials");
    const id = await createMemory("filter", "a title that must not leak");
    await executeMemoryCommand(sc, cmd({
      type: "UPDATE_MEMORY", memoryId: id, idempotencyKey: key("filter-1"),
      payload: { patch: { title: "still must not leak", caption: "nor this", location_lat: 51.5, location_lng: -0.12 } },
    }));
    const events = await eventsFor(id);
    assert.equal(events.length, 2);
    for (const e of events) {
      assert.equal(eventPayloadIsPrivacyFiltered(e.payload_json), true,
        `event ${e.sequence} carries a forbidden key: ${JSON.stringify(e.payload_json)}`);
      const blob = JSON.stringify(e.payload_json);
      assert.ok(!blob.includes("must not leak"), "the Memory's title reached the event log");
      assert.ok(!blob.includes("51.5"), "the Memory's coordinates reached the event log");
      assert.deepEqual(Object.keys(e.payload_json).sort(),
        ["command_type", "from_state", "refs", "to_state", "visibility"]);
    }
    // Stated as the assertion it is: a rebuild of TITLE/CAPTION from this log is
    // impossible by construction, so §18's "rebuild disposable projections" holds
    // for lifecycle and for reference graphs, and NOT for content. A consumer
    // that needs the body must read the canonical row under its own authority.
  });
});
