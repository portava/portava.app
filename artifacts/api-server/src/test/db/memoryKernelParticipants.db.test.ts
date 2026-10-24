/**
 * memoryKernelParticipants.db.test.ts — the §17 writes that used to happen
 * AFTER memory_kernel_execute returned, now inside it (migration 3911), driven
 * through the REAL routers over HTTP on the full chain scripts/local-db/up.sh
 * replays. census-highlights-memories §CB.
 *
 * WHAT WAS WRONG (census §CA.4, found in batch 1). With `memory_kernel_enabled`
 * ON in production, four canonical writes still bypassed the kernel:
 *   - POST /me/memory-drafts (Telegraph §10.2) inserted the Memory directly;
 *   - POST /memories and POST /trips/:tripId/memory inserted the participants'
 *     memory_tags rows after the kernel returned;
 *   - every type / occurrence-name write went through a direct UPDATE after the
 *     kernel (memoryCanonicalFields.reconcileCanonicalFields);
 *   - POST /memories/:id/items/from-post linked the source post by a follow-up UPDATE.
 * Each of those writes had no domain event, no receipt and no outbox row.
 *
 * HOW THIS FILE PROVES THE FIX. Every route below runs over
 * ./memoryPostgrestBridge.ts as service_role, and the bridge logs every
 * statement it issues. A case asserts BOTH:
 *   - the canonical rows exist, written by the SAME transaction as the
 *     memory_domain_events row (equal `xmin` — PostgreSQL's own record of
 *     which transaction last wrote a row), and
 *   - the route issued no canonical write of its own: the only statement that
 *     touches memories / memory_tags / memory_items is the kernel RPC.
 * P11 then installs 2711's function (the production definition before 3911,
 * from the rollback file), shows the routes still tag and type correctly
 * against it — the "code first, migration later" order — and restores 3911.
 *
 * FLAGS are answered in memory with production's values (2026-10-23); the
 * bridge never writes feature_flags. `memory_from_own_media_enabled` is OFF in
 * production (owner decision applied 22:29Z, audit id 217); P7/P8 turn it on IN
 * MEMORY ONLY to prove the code behind that switch.
 *
 *   P1  POST /memories: participants, type and occurrence text written by the kernel's transaction
 *   P2  the same Idempotency-Key replayed: one Memory, one tag, one event
 *   P3  POST /trips/:tripId/memory: the crew tagged and TRIP typed by the kernel's transaction
 *   P4  PATCH /memories/:id memoryType: the type written by UPDATE_MEMORY itself; other events keep 2711's refs shape
 *   P5  POST /me/memory-drafts, kernel ON: CREATE_MEMORY, no direct insert
 *   P6  POST /me/memory-drafts, kernel OFF: the legacy insert, and no event claimed
 *   P7  POST /memories/:id/items/from-post: the source link in the kernel's own INSERT
 *   P8  a source post that is not the owner's: 3999's guard refuses inside the kernel and NOTHING is written
 *   P9  a malformed participant list is refused by name before any write
 *   P10 the actor and an id with no profile are never tagged
 *   P11 against 2711 the routes still tag and type (the compat arms), then 3911 is restored byte for byte
 *   P12 a refusal on the draft's kernel path keeps its own answer (400), and nothing is written
 *   Q1–Q10 every other Memory command through its own route — CONFIRM, CHANGE_VISIBILITY, CHANGE_PLACE,
 *       ADD_MEDIA, REMOVE_MEDIA, ADD_PERSON, REMOVE_PERSON, ARCHIVE (memory_kernel_execute) and MERGE,
 *       SPLIT (memory_graph_kernel_execute): its event, in the transaction that wrote its rows, and no
 *       canonical write by the route
 *
 * Run: bash scripts/local-db/run-tests.sh (after up.sh), or with LOCAL_DB_URL set:
 *   node --import tsx/esm --test src/test/db/memoryKernelParticipants.db.test.ts
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { HAVE_DB, exec, psql, rows, scalar, seedUser } from "./localDb.js";
import { memoryBridge } from "./memoryPostgrestBridge.js";
import { _setTestClient } from "../../lib/http.js";
import { dispatchMemoryCommand } from "../../services/memory/MemoryDomainService.js";
import { runMemoryOutboxDrainPass } from "../../services/memoryProjections/outboxDrainRunner.js";
import memoriesRouter from "../../routes/memories.js";
import telegraphMemoryRouter from "../../routes/telegraphMemory.js";
import memoryGraphRouter from "../../routes/memoryGraph.js";
// The kernel's event log and outbox are named through lib/memoryOutbox.ts, the one module check:memory-table-ownership lets name them.
import { MEMORY_EVENT_TABLE as EVENTS, MEMORY_OUTBOX_TABLE as OUTBOX } from "../../lib/memoryOutbox.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION_3911 = resolve(HERE, "../../migrations/3911_memory_kernel_create_participants_and_canonical_fields.sql");
const ROLLBACK_3911 = resolve(HERE, "../../../../../db/rollback/2026-10-23-3911-memory-kernel-create-participants-rollback.sql");

/** Production's values for every flag these routes read (feature_flags, 2026-10-23). */
const PROD_FLAGS: Record<string, boolean> = {
  memory_kernel_enabled: true,
  memory_location_precision_enabled: true,
  memory_type_enabled: true,
  memory_place_occurrence_name_enabled: true,
  memory_from_own_media_enabled: false,
  memory_merge_split_enabled: true,
};

const TAG = `mkp${randomUUID().slice(0, 8)}`;
let owner = "";
let viewer = "";
const TOKEN = `tok-${TAG}`;
const VIEWER_TOKEN = `tok-${TAG}-v`;
let flags: Record<string, boolean> = { ...PROD_FLAGS };
let log: string[] = [];
let server: http.Server | null = null;
let base = "";

function install(): void {
  log = [];
  _setTestClient(memoryBridge({ flags, log, tokens: { [TOKEN]: owner, [VIEWER_TOKEN]: viewer } }), true);
}

function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolvePromise, reject) => {
    const url = new URL(path, base);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request({
      hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method, agent: false, // a fresh connection each call: a kept-alive socket the server closed while O1 drained is an ECONNRESET, not a finding
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...headers },
    }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => { let b: any; try { b = JSON.parse(raw); } catch { b = raw; } resolvePromise({ status: res.statusCode ?? 0, body: b }); });
    });
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

/** The statements that WROTE something (the bridge's reads are all `SELECT COALESCE(json_agg(t.*) …`). */
const writes = (): string[] => log.filter((s) => !s.startsWith("SELECT COALESCE(json_agg(t.*)") && !s.startsWith("SELECT json_build_array(count(*))"));
/** A write that names one of the Memory aggregate's canonical tables. */
const CANONICAL_WRITE = /^(WITH w AS \()?(INSERT INTO|UPDATE|DELETE FROM) public\.(memories|memory_tags|memory_items)\b/;
const KERNEL_RPC = /^SELECT json_build_array\(public\.memory_kernel_execute\(/;

function assertOnlyTheKernelWroteTheMemory(label: string, kernel: RegExp = KERNEL_RPC): void {
  const w = writes();
  assert.equal(w.filter((s) => kernel.test(s)).length, 1, `${label}: exactly one kernel call:\n${w.join("\n")}`);
  const direct = w.filter((s) => CANONICAL_WRITE.test(s));
  assert.deepEqual(direct, [], `${label}: the route wrote the Memory aggregate itself, outside the kernel`);
}

/** xmin of a row: the id of the transaction that last wrote it. */
const xminOf = (table: string, where: string): string | null => scalar(`SELECT xmin::text FROM public.${table} WHERE ${where}`);

/** Every statement of a migration-shaped file, run as the harness superuser (the lead's apply role). */
function applyFile(path: string): void {
  const r = psql(readFileSync(path, "utf8"));
  assert.equal(r.status, 0, `${path} did not apply:\n${r.stderr}`);
}
/** memory_kernel_execute as production and portava-ci run it today (2711), read-only 2026-10-23. */
const PRODUCTION_2711_MD5 = "542cc3a256e7452a5629cc5d87e7a45f";
const kernelDefMd5 = (): string | null => scalar(`SELECT md5(pg_get_functiondef('public.memory_kernel_execute(jsonb)'::regprocedure))`);

describe("§17: a Memory's participants, type, occurrence text and source post are written by the kernel's own transaction (3911)", { skip: !HAVE_DB }, () => {
  before(async () => {
    owner = seedUser(`${TAG}o`);
    viewer = seedUser(`${TAG}v`);
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => { req.log = { error: () => {}, warn: () => {}, info: () => {}, child: () => req.log }; next(); });
    app.use("/api", memoriesRouter);
    app.use("/api", telegraphMemoryRouter);
    app.use("/api", memoryGraphRouter);
    server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server!.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
    assert.ok((kernelDefMd5() ?? "").length === 32, "memory_kernel_execute exists");
    assert.equal(scalar(`SELECT position('INSERT INTO public.memory_tags' IN pg_get_functiondef('public.memory_kernel_execute(jsonb)'::regprocedure)) > 0`), "t", "the chain carries 3911's kernel");
  });
  after(async () => {
    await new Promise((r) => (server ? server.close(() => r(null)) : r(null)));
    for (const id of [owner, viewer].filter(Boolean)) {
      exec(`DELETE FROM public.${OUTBOX} WHERE memory_id IN (SELECT id FROM public.memories WHERE owner_id = '${id}');
            DELETE FROM public.${EVENTS} WHERE actor_user_id = '${id}';
            DELETE FROM public.memory_command_audit WHERE actor_user_id = '${id}';
            DELETE FROM public.memory_command_receipts WHERE actor_user_id = '${id}';
            DELETE FROM public.notifications WHERE user_id = '${id}' OR actor_id = '${id}';
            DELETE FROM public.saved_messages WHERE user_id = '${id}';
            DELETE FROM public.memories WHERE owner_id = '${id}';
            DELETE FROM public.trips WHERE owner_id = '${id}';
            DELETE FROM public.posts WHERE author_id = '${id}';
            DELETE FROM public.messages WHERE sender_id = '${id}';
            DELETE FROM public.message_thread_members WHERE user_id = '${id}';
            DELETE FROM public.profiles WHERE id = '${id}';
            DELETE FROM auth.users WHERE id = '${id}';`);
    }
    exec(`DELETE FROM public.message_threads t WHERE NOT EXISTS (SELECT 1 FROM public.message_thread_members m WHERE m.thread_id = t.id) AND NOT EXISTS (SELECT 1 FROM public.messages x WHERE x.thread_id = t.id) AND t.created_at > now() - interval '1 hour' AND t.id IN (SELECT unnest(ARRAY[${threads.map((t) => `'${t}'::uuid`).join(", ") || "NULL::uuid"}]));`);
  });
  const threads: string[] = [];

  let p1Memory = "";
  const p1Key = randomUUID();

  test("P1 POST /memories: the participants, the type and the occurrence text are written by the kernel's transaction, and the route writes none of them", async () => {
    flags = { ...PROD_FLAGS }; install();
    const res = await call("POST", "/api/memories", {
      title: `${TAG} P1`, visibility: "only_me", taggedUserIds: [viewer, owner],
      memoryType: "PLACE", placeId: `prov:${TAG}`, placeDisplayNameAtOccurrence: "Cafe P1",
    }, { "idempotency-key": p1Key });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    p1Memory = String(res.body.memory.id);
    assert.equal(res.body.memory.memoryType, "PLACE");
    assert.equal(res.body.memory.placeDisplayNameAtOccurrence, "Cafe P1");

    assert.deepEqual(rows(`SELECT tagged_user_id, status FROM public.memory_tags WHERE memory_id = '${p1Memory}'`),
      [{ tagged_user_id: viewer, status: "pending" }], "the viewer is tagged PENDING and the actor never tags themself");
    assert.deepEqual(rows(`SELECT memory_type, place_display_name_at_occurrence FROM public.memories WHERE id = '${p1Memory}'`),
      [{ memory_type: "PLACE", place_display_name_at_occurrence: "Cafe P1" }]);
    const ev = rows<{ type: string; refs: any }>(`SELECT type, payload_json->'refs' AS refs FROM public.${EVENTS} WHERE memory_id = '${p1Memory}' ORDER BY sequence`);
    assert.equal(ev.length, 1);
    assert.equal(ev[0]!.type, "memory.created");
    assert.deepEqual(ev[0]!.refs.tagged_user_ids, [viewer], "memory.created names the participants it tagged, as ids");

    const evX = xminOf(EVENTS, `memory_id = '${p1Memory}'`);
    assert.ok(evX);
    assert.equal(xminOf("memories", `id = '${p1Memory}'`), evX, "the Memory row's last writer is the event's transaction");
    assert.equal(xminOf("memory_tags", `memory_id = '${p1Memory}'`), evX, "the tag was written by the event's transaction");
    assert.equal(scalar(`SELECT count(*) FROM public.${OUTBOX} o JOIN public.${EVENTS} e ON e.event_id = o.event_id WHERE e.memory_id = '${p1Memory}'`), "1");

    assertOnlyTheKernelWroteTheMemory("P1");
    assert.equal(scalar(`SELECT count(*) FROM public.notifications WHERE user_id = '${viewer}' AND action_url = '/memory/${p1Memory}'`), "1",
      "the tagged person is still told, for exactly the tag the kernel wrote");
  });

  test("P2 the same Idempotency-Key replayed: the receipt answers, and no second tag, event or Memory is written", async () => {
    flags = { ...PROD_FLAGS }; install();
    const res = await call("POST", "/api/memories", {
      title: `${TAG} P1`, visibility: "only_me", taggedUserIds: [viewer, owner],
      memoryType: "PLACE", placeId: `prov:${TAG}`, placeDisplayNameAtOccurrence: "Cafe P1",
    }, { "idempotency-key": p1Key });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(String(res.body.memory.id), p1Memory, "the original Memory, from the receipt");
    assert.equal(scalar(`SELECT count(*) FROM public.memories WHERE owner_id = '${owner}' AND title = '${TAG} P1'`), "1");
    assert.equal(scalar(`SELECT count(*) FROM public.memory_tags WHERE memory_id = '${p1Memory}'`), "1");
    assert.equal(scalar(`SELECT count(*) FROM public.${EVENTS} WHERE memory_id = '${p1Memory}'`), "1");
    assertOnlyTheKernelWroteTheMemory("P2");
  });

  test("P3 POST /trips/:tripId/memory: the crew is tagged and the TRIP type written by the kernel's transaction; taggedCount is what it wrote", async () => {
    flags = { ...PROD_FLAGS };
    const tripId = randomUUID();
    exec(`INSERT INTO public.trips (id, owner_id, title, destination_city, status, start_date, end_date)
            VALUES ('${tripId}', '${owner}', '${TAG} trip', 'Da Nang', 'completed', '2026-09-01', '2026-09-05');
          INSERT INTO public.trip_members (trip_id, user_id, role) VALUES ('${tripId}', '${viewer}', 'member');`);
    install();
    const res = await call("POST", `/api/trips/${tripId}/memory`, {});
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.taggedCount, 1);
    const mid = String(res.body.memory.id);
    assert.deepEqual(rows(`SELECT tagged_user_id, status FROM public.memory_tags WHERE memory_id = '${mid}'`), [{ tagged_user_id: viewer, status: "pending" }]);
    assert.equal(scalar(`SELECT memory_type FROM public.memories WHERE id = '${mid}'`), "TRIP");
    const evX = xminOf(EVENTS, `memory_id = '${mid}'`);
    assert.equal(xminOf("memories", `id = '${mid}'`), evX);
    assert.equal(xminOf("memory_tags", `memory_id = '${mid}'`), evX);
    assert.deepEqual(JSON.parse(scalar(`SELECT payload_json->'refs'->'tagged_user_ids' FROM public.${EVENTS} WHERE memory_id = '${mid}'`) ?? "null"), [viewer]);
    assert.deepEqual(rows(`SELECT entity_type, entity_id, relation_type FROM public.memory_entity_links WHERE memory_id = '${mid}' ORDER BY entity_type`),
      [{ entity_type: "TRIP", entity_id: tripId, relation_type: "RELATED" }], "the graph mirror links the Memory to its trip; a PENDING tag is not an edge");
    assertOnlyTheKernelWroteTheMemory("P3");
  });

  test("P4 PATCH /memories/:id memoryType: UPDATE_MEMORY writes the type in its own transaction; its event keeps 2711's refs shape", async () => {
    flags = { ...PROD_FLAGS }; install();
    const res = await call("PATCH", `/api/memories/${p1Memory}`, { memoryType: "EVENT" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.memory.memoryType, "EVENT");
    assert.equal(scalar(`SELECT memory_type FROM public.memories WHERE id = '${p1Memory}'`), "EVENT");
    const ev = rows<{ type: string; sequence: number; refs: any }>(`SELECT type, sequence, payload_json->'refs' AS refs FROM public.${EVENTS} WHERE memory_id = '${p1Memory}' ORDER BY sequence`);
    assert.equal(ev.length, 2);
    assert.equal(ev[1]!.type, "memory.corrected");
    assert.deepEqual(Object.keys(ev[1]!.refs).sort(), ["actor_user_id", "item_id", "memory_id", "tagged_user_id"],
      "an edit's refs are exactly 2711's keys: 3911 adds tagged_user_ids only to a create that named participants");
    assert.equal(xminOf("memories", `id = '${p1Memory}'`), xminOf(EVENTS, `memory_id = '${p1Memory}' AND sequence = 2`),
      "the type change and memory.corrected are one transaction");
    assertOnlyTheKernelWroteTheMemory("P4");
  });

  test("O1 the outbox drain claims the kernel's events through 2994's functions, consumes each payload, and acks it once", async () => {
    flags = { ...PROD_FLAGS }; install();
    const pending = Number(scalar(`SELECT count(*) FROM public.${OUTBOX} WHERE published_at IS NULL`));
    assert.ok(pending >= 3, `P1–P4 left their outbox rows pending (${pending})`);
    const first = await runMemoryOutboxDrainPass({ client: memoryBridge({ flags, log }) });
    assert.equal(first.reason, null, JSON.stringify(first));
    assert.equal(first.claimed, pending, "every pending event is claimed");
    assert.equal(first.acked, pending, "and acked");
    assert.equal(scalar(`SELECT count(*) FROM public.${OUTBOX} WHERE published_at IS NULL`), "0");
    assert.ok(log.some((x) => /public\.memory_outbox_claim\(/.test(x)) && log.some((x) => /public\.memory_outbox_ack\(/.test(x)), "through 2994's claim and ack");
    const payloadReads = log.filter((x) => x.includes(`FROM public.${EVENTS} WHERE event_id = `) && x.includes("payload_json"));
    assert.ok(payloadReads.length >= pending, `each claimed event's privacy-filtered payload is read (${payloadReads.length} reads for ${pending} events)`);
    const again = await runMemoryOutboxDrainPass({ client: memoryBridge({ flags }) });
    assert.deepEqual([again.reason, again.claimed, again.acked], [null, 0, 0], "a second pass finds nothing: each event is consumed once");
  });

  function seedMessage(body: string): string {
    const thread = randomUUID();
    const msg = randomUUID();
    threads.push(thread);
    exec(`INSERT INTO public.message_threads (id) VALUES ('${thread}');
          INSERT INTO public.message_thread_members (thread_id, user_id) VALUES ('${thread}', '${owner}');
          INSERT INTO public.messages (id, thread_id, sender_id, body) VALUES ('${msg}', '${thread}', '${owner}', '${body.replace(/'/g, "''")}');`);
    return msg;
  }

  test("P5 POST /me/memory-drafts with the kernel ON: the private draft is a CREATE_MEMORY — event, receipt and outbox row in its transaction, no direct insert", async () => {
    flags = { ...PROD_FLAGS }; install();
    const msg = seedMessage(`${TAG} sunset at the pier`);
    const res = await call("POST", "/api/me/memory-drafts", { messageId: msg });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const draft = res.body.draft;
    assert.deepEqual([draft.state, draft.visibility, draft.ownerId, draft.fromMessageId], ["draft", "only_me", owner, msg]);
    const id = String(draft.id);
    assert.deepEqual(rows(`SELECT state, visibility, owner_id FROM public.memories WHERE id = '${id}'`), [{ state: "draft", visibility: "only_me", owner_id: owner }]);
    const ev = rows<{ type: string; to_state: string; visibility: string }>(`SELECT type, payload_json->>'to_state' AS to_state, payload_json->>'visibility' AS visibility FROM public.${EVENTS} WHERE memory_id = '${id}'`);
    assert.deepEqual(ev, [{ type: "memory.created", to_state: "CANDIDATE", visibility: "only_me" }]);
    assert.equal(xminOf("memories", `id = '${id}'`), xminOf(EVENTS, `memory_id = '${id}'`));
    assert.equal(scalar(`SELECT count(*) FROM public.memory_command_receipts WHERE memory_id = '${id}' AND command_type = 'CREATE_MEMORY'`), "1");
    assert.equal(scalar(`SELECT count(*) FROM public.${OUTBOX} o JOIN public.${EVENTS} e ON e.event_id = o.event_id WHERE e.memory_id = '${id}'`), "1");
    assertOnlyTheKernelWroteTheMemory("P5");
    assert.equal(scalar(`SELECT count(*) FROM public.saved_messages WHERE user_id = '${owner}' AND message_id = '${msg}'`), "1", "the save is still recorded");
  });

  test("P6 POST /me/memory-drafts with the kernel OFF: the legacy insert runs, and no event is claimed for it", async () => {
    flags = { ...PROD_FLAGS, memory_kernel_enabled: false }; install();
    const msg = seedMessage(`${TAG} legacy draft`);
    const res = await call("POST", "/api/me/memory-drafts", { messageId: msg });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const id = String(res.body.draft.id);
    assert.equal(scalar(`SELECT state || '/' || visibility FROM public.memories WHERE id = '${id}'`), "draft/only_me");
    assert.equal(scalar(`SELECT count(*) FROM public.${EVENTS} WHERE memory_id = '${id}'`), "0");
    const w = writes();
    assert.equal(w.filter((s) => KERNEL_RPC.test(s)).length, 0, "no kernel call with the kernel off");
    assert.equal(w.filter((s) => /^WITH w AS \(INSERT INTO public\.memories /.test(s)).length, 1, "the original direct insert, once");
  });

  test("P12 a refusal on the kernel path keeps its own answer: an over-long Idempotency-Key is 400 and writes nothing", async () => {
    flags = { ...PROD_FLAGS }; install();
    const msg = seedMessage(`${TAG} refused draft`);
    const res = await call("POST", "/api/me/memory-drafts", { messageId: msg }, { "idempotency-key": "k".repeat(201) });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.error, "invalid_payload");
    assert.equal(writes().filter((s) => KERNEL_RPC.test(s) || CANONICAL_WRITE.test(s)).length, 0, "no command and no direct write");
    assert.equal(scalar(`SELECT count(*) FROM public.saved_messages WHERE user_id = '${owner}' AND message_id = '${msg}'`), "0", "a refused draft records no save");
  });

  let ownPost = "";
  test("P7 POST /memories/:id/items/from-post (switch ON in memory only): the source link is in the kernel's own INSERT; no follow-up UPDATE", async () => {
    flags = { ...PROD_FLAGS, memory_from_own_media_enabled: true }; install();
    ownPost = randomUUID();
    exec(`INSERT INTO public.posts (id, author_id, content, media_urls) VALUES ('${ownPost}', '${owner}', '${TAG}', ARRAY['https://example.test/${TAG}.jpg']);`);
    const res = await call("POST", `/api/memories/${p1Memory}/items/from-post`, { postId: ownPost }, { "idempotency-key": randomUUID() });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const itemId = String(res.body.item.id);
    assert.equal(res.body.item.sourcePostId, ownPost);
    assert.equal(scalar(`SELECT source_post_id::text FROM public.memory_items WHERE id = '${itemId}'`), ownPost);
    assert.equal(xminOf("memory_items", `id = '${itemId}'`), xminOf(EVENTS, `memory_id = '${p1Memory}' AND sequence = 3`),
      "the linked item and its memory.corrected are one transaction");
    assertOnlyTheKernelWroteTheMemory("P7");
  });

  test("P8 ADD_MEDIA naming someone else's post: 3999's guard refuses INSIDE the kernel, and no item, event or receipt is left", async () => {
    flags = { ...PROD_FLAGS, memory_from_own_media_enabled: true }; install();
    const theirs = randomUUID();
    exec(`INSERT INTO public.posts (id, author_id, content, media_urls) VALUES ('${theirs}', '${viewer}', '${TAG}', ARRAY['https://example.test/${TAG}-v.jpg']);`);
    const before = scalar(`SELECT count(*) FROM public.${EVENTS} WHERE memory_id = '${p1Memory}'`);
    const key = randomUUID();
    const out = await dispatchMemoryCommand<any>({
      sc: memoryBridge({ flags }), commandType: "ADD_MEDIA", memoryId: p1Memory, actorUserId: owner, idempotencyKey: key,
      payload: { media_type: "image/jpeg", position: 1, write: { memory_id: p1Memory, media_url: `https://example.test/${TAG}-v.jpg`, media_type: "image/jpeg", caption: null, position: 1, source_post_id: theirs } },
      legacy: async () => { throw new Error("the legacy write must not run with memory_kernel_enabled ON"); },
    });
    assert.equal(out.ok, false);
    assert.equal(scalar(`SELECT count(*) FROM public.memory_items WHERE source_post_id = '${theirs}'`), "0");
    assert.equal(scalar(`SELECT count(*) FROM public.${EVENTS} WHERE memory_id = '${p1Memory}'`), before, "no event for a refused copy");
    assert.equal(scalar(`SELECT count(*) FROM public.memory_command_receipts WHERE actor_user_id = '${owner}' AND idempotency_key = '${key}'`), "0");
  });

  test("P9 a malformed participant list is refused BY NAME before anything is written", async () => {
    flags = { ...PROD_FLAGS };
    for (const [label, list] of [["a non-uuid", [viewer, "not-a-uuid"]], ["over the bound", Array.from({ length: 1001 }, () => randomUUID())], ["not a list", viewer]] as const) {
      const title = `${TAG} P9 ${label}`;
      const out = await dispatchMemoryCommand<any>({
        sc: memoryBridge({ flags }), commandType: "CREATE_MEMORY", memoryId: null, actorUserId: owner, idempotencyKey: randomUUID(),
        payload: { to_state: "CANDIDATE", visibility: "only_me", tagged_user_ids: list, write: { title, visibility: "only_me", state: "draft" }, select: "id" },
        legacy: async () => { throw new Error("legacy must not run"); },
      });
      assert.equal(out.ok, false, label);
      if (out.ok || !("rejection" in out)) { assert.fail(`${label}: expected a kernel rejection, got ${JSON.stringify(out)}`); }
      assert.equal(out.rejection.reason, "MEMORY_COMMAND_MALFORMED", label);
      assert.equal(scalar(`SELECT count(*) FROM public.memories WHERE owner_id = '${owner}' AND title = '${title.replace(/'/g, "''")}'`), "0", `${label}: no Memory`);
    }
    assert.equal(scalar(`SELECT count(*) FROM public.memory_command_audit WHERE actor_user_id = '${owner}' AND command_type = 'CREATE_MEMORY' AND outcome = 'rejected' AND reason = 'MEMORY_COMMAND_MALFORMED'`), "3",
      "each refusal is audited");
  });

  test("P10 the actor and an id with no profile are never tagged, and the kernel reports exactly whom it tagged", async () => {
    flags = { ...PROD_FLAGS };
    const ghost = randomUUID();
    const out = await dispatchMemoryCommand<any>({
      sc: memoryBridge({ flags }), commandType: "CREATE_MEMORY", memoryId: null, actorUserId: owner, idempotencyKey: randomUUID(),
      payload: { to_state: "CANDIDATE", visibility: "only_me", tagged_user_ids: [owner, ghost, viewer, viewer], write: { title: `${TAG} P10`, visibility: "only_me", state: "draft" }, select: "id" },
      legacy: async () => { throw new Error("legacy must not run"); },
    });
    assert.equal(out.ok, true, JSON.stringify(out));
    if (!out.ok) return;
    assert.deepEqual(out.taggedUserIds, [viewer]);
    const id = String(out.body.id);
    assert.deepEqual(rows(`SELECT tagged_user_id FROM public.memory_tags WHERE memory_id = '${id}'`), [{ tagged_user_id: viewer }]);
    // A command that names no participants reports none (null), so a caller that never sent the key is never told "the kernel decided".
    const bare = await dispatchMemoryCommand<any>({
      sc: memoryBridge({ flags }), commandType: "CREATE_MEMORY", memoryId: null, actorUserId: owner, idempotencyKey: randomUUID(),
      payload: { to_state: "CANDIDATE", visibility: "only_me", write: { title: `${TAG} P10 bare`, visibility: "only_me", state: "draft" }, select: "id" },
      legacy: async () => { throw new Error("legacy must not run"); },
    });
    assert.equal(bare.ok, true);
    if (bare.ok) assert.equal(bare.taggedUserIds, null);
  });

  test("P11 against 2711 (the definition before 3911) the routes still tag and type through their compat arms; 3911 is then restored byte for byte", async () => {
    const with3911 = kernelDefMd5();
    applyFile(ROLLBACK_3911);
    try {
      assert.notEqual(kernelDefMd5(), with3911, "2711 is installed");
      flags = { ...PROD_FLAGS }; install();
      const res = await call("POST", "/api/memories", { title: `${TAG} P11`, visibility: "only_me", taggedUserIds: [viewer], memoryType: "PERSON" });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const id = String(res.body.memory.id);
      assert.equal(res.body.memory.memoryType, "PERSON");
      assert.deepEqual(rows(`SELECT tagged_user_id, status FROM public.memory_tags WHERE memory_id = '${id}'`), [{ tagged_user_id: viewer, status: "pending" }]);
      assert.equal(scalar(`SELECT memory_type FROM public.memories WHERE id = '${id}'`), "PERSON");
      assert.equal(scalar(`SELECT payload_json->'refs' ? 'tagged_user_ids' FROM public.${EVENTS} WHERE memory_id = '${id}'`), "f", "2711's event names no participants");
      const w = writes();
      assert.equal(w.filter((s) => /^WITH w AS \(INSERT INTO public\.memory_tags /.test(s)).length, 1, "the route's own tag insert ran (2711 tagged nobody)");
      assert.equal(w.filter((s) => /^WITH w AS \(UPDATE public\.memories SET memory_type = /.test(s)).length, 1, "the reconcile wrote the type (2711's INSERT took the DEFAULT)");
    } finally {
      applyFile(MIGRATION_3911);
    }
    assert.equal(kernelDefMd5(), with3911, "3911 restored exactly");
  });
  // ── Q: every other §17 Memory command, through its own route, on 3911 ──────
  // Run TWICE: on production's kernel today (2711, installed from the rollback file) and on 3911.
  for (const kernel of ["2711", "3911"] as const) describe(`Q (${kernel}) — CONFIRM, CHANGE_VISIBILITY, CHANGE_PLACE, ADD_MEDIA, REMOVE_MEDIA, ADD_PERSON, REMOVE_PERSON, ARCHIVE, MERGE and SPLIT each cross a kernel with their event`, () => {
    let with3911: string | null = null;
    before(() => { with3911 = kernelDefMd5(); if (kernel === "2711") { applyFile(ROLLBACK_3911); assert.equal(kernelDefMd5(), PRODUCTION_2711_MD5, "production's definition is installed"); } });
    after(() => { if (kernel === "2711") { applyFile(MIGRATION_3911); assert.equal(kernelDefMd5(), with3911, "3911 restored exactly"); } });
    let m = "";
    let item = "";
    const evAt = (memoryId: string, seq: number) => rows<{ type: string; command_type: string; xmin: string }>(
      `SELECT type, payload_json->>'command_type' AS command_type, xmin::text AS xmin FROM public.${EVENTS} WHERE memory_id = '${memoryId}' AND sequence = ${seq}`)[0];
    const lastSeq = (memoryId: string) => Number(scalar(`SELECT coalesce(max(sequence), 0) FROM public.${EVENTS} WHERE memory_id = '${memoryId}'`));

    test(`Q1[${kernel}] PATCH state → published is CONFIRM_MEMORY: memory.confirmed, written with the state change`, async () => {
      flags = { ...PROD_FLAGS }; install();
      const created = await call("POST", "/api/memories", { title: `${TAG} Q`, visibility: "only_me", state: "draft", taggedUserIds: [viewer], placeId: `prov:${TAG}-q1`, placeDisplayNameAtOccurrence: "Q Place One" });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      m = String(created.body.memory.id);
      install();
      const res = await call("PATCH", `/api/memories/${m}`, { state: "published" }, { "idempotency-key": randomUUID() });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const ev = evAt(m, 2)!;
      assert.deepEqual([ev.type, ev.command_type], ["memory.confirmed", "CONFIRM_MEMORY"]);
      assert.equal(scalar(`SELECT state FROM public.memories WHERE id = '${m}'`), "published");
      assert.equal(xminOf("memories", `id = '${m}'`), ev.xmin);
      assertOnlyTheKernelWroteTheMemory("Q1");
    });

    test(`Q2[${kernel}] PATCH visibility is CHANGE_VISIBILITY: memory.visibility_changed, written with the audience`, async () => {
      flags = { ...PROD_FLAGS }; install();
      const res = await call("PATCH", `/api/memories/${m}`, { visibility: "friends_only" }, { "idempotency-key": randomUUID() });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const ev = evAt(m, 3)!;
      assert.deepEqual([ev.type, ev.command_type], ["memory.visibility_changed", "CHANGE_VISIBILITY"]);
      assert.equal(scalar(`SELECT visibility FROM public.memories WHERE id = '${m}'`), "friends_only");
      assert.equal(xminOf("memories", `id = '${m}'`), ev.xmin);
      assertOnlyTheKernelWroteTheMemory("Q2");
    });

    test(`Q3[${kernel}] PATCH placeId is CHANGE_PLACE: memory.corrected, with the new place; on 3911 its occurrence text is in the same UPDATE, on 2711 it is the route's own write`, async () => {
      flags = { ...PROD_FLAGS }; install();
      const res = await call("PATCH", `/api/memories/${m}`, { placeId: `prov:${TAG}-q3`, placeDisplayNameAtOccurrence: "Q Place Three" }, { "idempotency-key": randomUUID() });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const ev = evAt(m, 4)!;
      assert.deepEqual([ev.type, ev.command_type], ["memory.corrected", "CHANGE_PLACE"]);
      assert.deepEqual(rows(`SELECT place_id, place_display_name_at_occurrence FROM public.memories WHERE id = '${m}'`),
        [{ place_id: `prov:${TAG}-q3`, place_display_name_at_occurrence: "Q Place Three" }], "a changed place never keeps the old place's text");
      if (kernel === "3911") {
        assert.equal(xminOf("memories", `id = '${m}'`), ev.xmin);
        assertOnlyTheKernelWroteTheMemory("Q3");
      } else {
        // 2711, production today: the kernel moves the place, then the route writes the text itself — the §CA.4 hole 3911 closes.
        assert.equal(writes().filter((x) => /^WITH w AS \(UPDATE public\.memories SET place_display_name_at_occurrence = /.test(x)).length, 1, "on 2711 the occurrence text is a direct write after the kernel");
      }
    });

    test(`Q4[${kernel}] POST /memories/:id/items is ADD_MEDIA: memory.corrected, written with the item`, async () => {
      flags = { ...PROD_FLAGS }; install();
      const res = await call("POST", `/api/memories/${m}/items`, { mediaUrl: `https://example.test/${TAG}-q4.jpg`, mediaType: "image/jpeg", position: 0 }, { "idempotency-key": randomUUID() });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      item = String(res.body.item?.id ?? res.body.id);
      const ev = evAt(m, 5)!;
      assert.deepEqual([ev.type, ev.command_type], ["memory.corrected", "ADD_MEDIA"]);
      assert.equal(xminOf("memory_items", `id = '${item}'`), ev.xmin);
      assertOnlyTheKernelWroteTheMemory("Q4");
    });

    test(`Q5[${kernel}] DELETE /memories/:id/items/:itemId is REMOVE_MEDIA: memory.corrected, and the item is gone with it`, async () => {
      flags = { ...PROD_FLAGS }; install();
      const res = await call("DELETE", `/api/memories/${m}/items/${item}`, undefined, { "idempotency-key": randomUUID() });
      assert.ok(res.status === 200 || res.status === 204, JSON.stringify(res));
      const ev = evAt(m, 6)!;
      assert.deepEqual([ev.type, ev.command_type], ["memory.corrected", "REMOVE_MEDIA"]);
      assert.equal(scalar(`SELECT count(*) FROM public.memory_items WHERE id = '${item}'`), "0");
      assertOnlyTheKernelWroteTheMemory("Q5");
    });

    test(`Q6[${kernel}] the tagged person approving is ADD_PERSON: memory.corrected, written with the consent`, async () => {
      flags = { ...PROD_FLAGS }; install();
      const res = await call("PATCH", `/api/memories/${m}/tags/${viewer}`, { action: "approve" }, { authorization: `Bearer ${VIEWER_TOKEN}`, "idempotency-key": randomUUID() });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const ev = evAt(m, 7)!;
      assert.deepEqual([ev.type, ev.command_type], ["memory.corrected", "ADD_PERSON"]);
      assert.equal(scalar(`SELECT status FROM public.memory_tags WHERE memory_id = '${m}' AND tagged_user_id = '${viewer}'`), "approved");
      assert.equal(xminOf("memory_tags", `memory_id = '${m}' AND tagged_user_id = '${viewer}'`), ev.xmin);
      assert.equal(scalar(`SELECT count(*) FROM public.memory_entity_links WHERE memory_id = '${m}' AND entity_type = 'PERSON' AND entity_id = '${viewer}'`), "1", "consent makes the person an edge");
      assertOnlyTheKernelWroteTheMemory("Q6");
    });

    test(`Q7[${kernel}] the owner removing the person is REMOVE_PERSON: memory.corrected, written with the removal`, async () => {
      flags = { ...PROD_FLAGS }; install();
      const res = await call("PATCH", `/api/memories/${m}/tags/${viewer}`, { action: "remove" }, { "idempotency-key": randomUUID() });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const ev = evAt(m, 8)!;
      assert.deepEqual([ev.type, ev.command_type], ["memory.corrected", "REMOVE_PERSON"]);
      assert.equal(scalar(`SELECT status FROM public.memory_tags WHERE memory_id = '${m}' AND tagged_user_id = '${viewer}'`), "removed");
      assert.equal(xminOf("memory_tags", `memory_id = '${m}' AND tagged_user_id = '${viewer}'`), ev.xmin);
      assert.equal(scalar(`SELECT count(*) FROM public.memory_entity_links WHERE memory_id = '${m}' AND entity_type = 'PERSON'`), "0", "a removed person is no longer an edge");
      assertOnlyTheKernelWroteTheMemory("Q7");
    });

    test(`Q8[${kernel}] PATCH state → archived is ARCHIVE_MEMORY: memory.archived, written with the state change`, async () => {
      flags = { ...PROD_FLAGS }; install();
      const res = await call("PATCH", `/api/memories/${m}`, { state: "archived" }, { "idempotency-key": randomUUID() });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const ev = evAt(m, 9)!;
      assert.deepEqual([ev.type, ev.command_type], ["memory.archived", "ARCHIVE_MEMORY"]);
      assert.equal(scalar(`SELECT state FROM public.memories WHERE id = '${m}'`), "archived");
      assert.equal(xminOf("memories", `id = '${m}'`), ev.xmin);
      assertOnlyTheKernelWroteTheMemory("Q8");
    });

    const GRAPH_RPC = /^SELECT json_build_array\(public\.memory_graph_kernel_execute\(/;
    test(`Q9[${kernel}] POST /memories/merge is MERGE_MEMORY: memory.merged on the survivor, the absorbed Memory deleted and redirected, in the graph kernel's transaction`, async () => {
      flags = { ...PROD_FLAGS }; install();
      const a = await call("POST", "/api/memories", { title: `${TAG} Q9 survivor`, visibility: "only_me" });
      const b = await call("POST", "/api/memories", { title: `${TAG} Q9 absorbed`, visibility: "only_me" });
      assert.equal(a.status, 201); assert.equal(b.status, 201);
      const survivor = String(a.body.memory.id), absorbed = String(b.body.memory.id);
      install();
      const res = await call("POST", "/api/memories/merge", { survivorId: survivor, absorbedIds: [absorbed] }, { "idempotency-key": randomUUID() });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const ev = evAt(survivor, lastSeq(survivor))!;
      assert.deepEqual([ev.type, ev.command_type], ["memory.merged", "MERGE_MEMORY"]);
      assert.equal(scalar(`SELECT state FROM public.memories WHERE id = '${absorbed}'`), "deleted");
      assert.equal(scalar(`SELECT new_memory_id::text FROM public.memory_id_redirects WHERE old_memory_id = '${absorbed}'`), survivor);
      assert.equal(xminOf("memory_id_redirects", `old_memory_id = '${absorbed}'`), ev.xmin, "the redirect and memory.merged are one transaction");
      assert.equal(scalar(`SELECT count(*) FROM public.${OUTBOX} WHERE event_id = (SELECT event_id FROM public.${EVENTS} WHERE memory_id = '${survivor}' AND type = 'memory.merged')`), "1");
      assertOnlyTheKernelWroteTheMemory("Q9", GRAPH_RPC);
    });

    test(`Q10[${kernel}] POST /memories/:id/split is SPLIT_MEMORY: memory.split on both streams, the item moved, in the graph kernel's transaction`, async () => {
      flags = { ...PROD_FLAGS }; install();
      const c = await call("POST", "/api/memories", { title: `${TAG} Q10`, visibility: "only_me" });
      assert.equal(c.status, 201);
      const src = String(c.body.memory.id);
      const items: string[] = [];
      for (const n of [1, 2]) {
        const r = await call("POST", `/api/memories/${src}/items`, { mediaUrl: `https://example.test/${TAG}-q10-${n}.jpg`, position: n }, { "idempotency-key": randomUUID() });
        assert.equal(r.status, 201, JSON.stringify(r.body));
        items.push(String(r.body.item?.id ?? r.body.id));
      }
      install();
      const res = await call("POST", `/api/memories/${src}/split`, { itemIds: [items[1]] }, { "idempotency-key": randomUUID() });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const fresh = String(res.body.newMemoryId);
      const evSrc = evAt(src, lastSeq(src))!;
      const evNew = evAt(fresh, lastSeq(fresh))!;
      assert.deepEqual([evSrc.type, evNew.type], ["memory.split", "memory.split"]);
      assert.equal(scalar(`SELECT memory_id::text FROM public.memory_items WHERE id = '${items[1]}'`), fresh);
      assert.equal(evSrc.xmin, evNew.xmin, "both streams' events are one transaction");
      assert.equal(xminOf("memory_items", `id = '${items[1]}'`), evSrc.xmin, "the moved item is that transaction's");
      assert.deepEqual(rows(`SELECT source_id::text AS source_id, target_id, relation_type FROM public.memory_relations WHERE target_type = 'MEMORY' AND (source_id = '${fresh}' OR target_id = '${fresh}')`),
        [{ source_id: fresh, target_id: src, relation_type: "DERIVED_FROM" }], "the split's lineage is a Memory-to-Memory edge");
      assertOnlyTheKernelWroteTheMemory("Q10", GRAPH_RPC);
    });
  });
  // ── K: the kernel's own refusals and writes, called straight, on 2711 AND the tree's kernel ──
  // The independent verifier's three survivors (#784): mutants the route-level cases
  // above could not see, because the routes never send these commands this way.
  for (const kernel of ["2711", "tree"] as const) describe(`K (${kernel}) — the kernel, called directly`, () => {
    // Saved and put back EXACTLY (raw psql output), so this group leaves whatever kernel it found.
    const rawDef = (): string => { const r = psql(`SELECT pg_get_functiondef('public.memory_kernel_execute(jsonb)'::regprocedure);`); assert.equal(r.status, 0, r.stderr); return r.stdout.replace(/\n$/, ""); };
    const commentMd5 = () => scalar(`SELECT md5(obj_description('public.memory_kernel_execute(jsonb)'::regprocedure, 'pg_proc'))`);
    let saved = ""; let savedMd5: string | null = null; let savedComment = ""; let savedCommentMd5: string | null = null;
    before(() => { savedMd5 = kernelDefMd5(); saved = rawDef(); savedCommentMd5 = commentMd5(); const c = psql(`SELECT obj_description('public.memory_kernel_execute(jsonb)'::regprocedure, 'pg_proc');`); savedComment = c.stdout.replace(/\n$/, ""); if (kernel === "2711") { applyFile(ROLLBACK_3911); assert.equal(kernelDefMd5(), PRODUCTION_2711_MD5, "production's definition is installed"); } });
    after(() => {
      if (kernel === "2711") {
        const r = psql(`${saved};\nCOMMENT ON FUNCTION public.memory_kernel_execute(jsonb) IS $kc$${savedComment}$kc$;\nREVOKE ALL ON FUNCTION public.memory_kernel_execute(jsonb) FROM PUBLIC, anon, authenticated;\nGRANT EXECUTE ON FUNCTION public.memory_kernel_execute(jsonb) TO service_role;`);
        assert.equal(r.status, 0, r.stderr);
        assert.equal(kernelDefMd5(), savedMd5, "the tree's kernel restored exactly");
        assert.equal(commentMd5(), savedCommentMd5, "and its comment");
      }
    });
    const direct = (type: string, memoryId: string | null, actor: string, payload: Record<string, unknown>) => dispatchMemoryCommand<any>({
      sc: memoryBridge({ flags: PROD_FLAGS }), commandType: type as any, memoryId, actorUserId: actor, idempotencyKey: randomUUID(), payload,
      legacy: async () => { throw new Error("legacy must not run"); },
    });

    test(`K1[${kernel}] REMOVE_PERSON from someone who is neither the owner nor the tagged person is refused MEMORY_AUTH_NOT_OWNER, and the tag stands`, async () => {
      const stranger = seedUser(`${TAG}k${kernel}`);
      try {
        const m = randomUUID();
        exec(`INSERT INTO public.memories (id, owner_id, title, visibility, state) VALUES ('${m}', '${owner}', '${TAG} K1 ${kernel}', 'only_me', 'published');
              INSERT INTO public.memory_tags (memory_id, tagged_user_id, status) VALUES ('${m}', '${viewer}', 'approved');`);
        const out = await direct("REMOVE_PERSON", m, stranger, { tagged_user_id: viewer, status: "removed" });
        assert.equal(out.ok, false);
        if (!out.ok && "rejection" in out) assert.equal(out.rejection.reason, "MEMORY_AUTH_NOT_OWNER"); else assert.fail(JSON.stringify(out));
        assert.equal(scalar(`SELECT status FROM public.memory_tags WHERE memory_id = '${m}' AND tagged_user_id = '${viewer}'`), "approved");
        assert.equal(scalar(`SELECT count(*) FROM public.${EVENTS} WHERE memory_id = '${m}'`), "0");
        // ADD_PERSON from the same stranger is refused one check earlier: only the tagged person consents.
        const add = await direct("ADD_PERSON", m, stranger, { tagged_user_id: viewer, status: "approved" });
        assert.equal(add.ok, false);
        if (!add.ok && "rejection" in add) assert.equal(add.rejection.reason, "MEMORY_AUTH_NOT_PARTICIPANT"); else assert.fail(JSON.stringify(add));
      } finally {
        exec(`DELETE FROM public.memory_command_audit WHERE actor_user_id = '${stranger}'; DELETE FROM public.profiles WHERE id = '${stranger}'; DELETE FROM auth.users WHERE id = '${stranger}';`);
      }
    });

    test(`K2[${kernel}] a CREATE that names no memory_type gets the column's DEFAULT, MOMENT`, async () => {
      const out = await direct("CREATE_MEMORY", null, owner, { to_state: "CANDIDATE", visibility: "only_me", write: { title: `${TAG} K2 ${kernel}`, visibility: "only_me", state: "draft" }, select: "id" });
      assert.equal(out.ok, true, JSON.stringify(out));
      if (out.ok) assert.equal(scalar(`SELECT memory_type FROM public.memories WHERE id = '${String(out.body.id)}'`), "MOMENT");
    });

    if (kernel === "tree") test("K3[tree] memory.created's refs.tagged_user_ids names only the people actually tagged: never a requested id with no profile", async () => {
      const ghost = randomUUID();
      const out = await direct("CREATE_MEMORY", null, owner, { to_state: "CANDIDATE", visibility: "only_me", tagged_user_ids: [ghost, viewer, owner], write: { title: `${TAG} K3`, visibility: "only_me", state: "draft" }, select: "id" });
      assert.equal(out.ok, true, JSON.stringify(out));
      if (!out.ok) return;
      const refs = JSON.parse(scalar(`SELECT payload_json->'refs'->'tagged_user_ids' FROM public.${EVENTS} WHERE memory_id = '${String(out.body.id)}'`) ?? "null");
      assert.deepEqual(refs, [viewer], "the ghost was requested and not written, so the event does not name it");
    });
  });
});
