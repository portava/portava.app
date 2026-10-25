/**
 * memoryTagBlockGate.db.test.ts — census-highlights-memories §CD: nobody the
 * owner has blocked, and nobody who has blocked the owner, is tagged in a
 * Memory, consents to a tag on one, or is told about one — through the REAL
 * routers over HTTP, on every kernel production can be running, on the full
 * chain scripts/local-db/up.sh replays.
 *
 * WHAT WAS WRONG (found in §CB, raised by the independent verifier of #784).
 * POST /memories, POST /trips/:tripId/memory and the kernel's CREATE_MEMORY
 * (3911) tagged whoever the caller named, and notifyTagged then wrote that
 * person an in-app notification and sent them a push — "<owner> tagged you in a
 * memory" — whether or not either of the two had blocked the other. A tagged
 * person could also approve a tag across a block.
 *
 * THE RULE, AND WHY IT IS SILENT. public.blocks (blocker_id, blocked_id) is the
 * platform's block relation, read the canonical way (lib/exclusionSet.ts
 * readBlockExclusions, both directions, fail CLOSED). A block is never revealed:
 * TRIP_AUTH_BLOCKED and TELEGRAPH_AUTH_BLOCKED are internal-only reasons
 * (domain/trips/contracts/tripReasonCodes.ts, domain/telegraph/contracts/
 * telegraphReasonCodes.ts). So a blocked person named in a create is SKIPPED
 * (the create succeeds and tags the others), and a consent across a block is
 * answered byte for byte as a tag that does not exist.
 *
 *   G1  POST /memories: only the unblocked person is tagged, notified and pushed — both block directions
 *   G2  POST /trips/:tripId/memory: a crew member blocked either way is not tagged, notified or pushed
 *   G3  a consent (ADD_PERSON) across a block, both directions: the answer is a missing tag's, byte for byte, and nothing changes
 *   G4  removing a tag across a block is never gated (owner, and the tagged person)
 *   R1  notifyTagged's own gate: a block made between the tag and the notification stops the notification and the push
 *   F1–F4 an unreadable blocks table: the create, the trip memory and the consent refuse BEFORE any write; notifyTagged notifies nobody
 *   K1–K3 3913's kernel, called directly: CREATE skips both directions, ADD_PERSON is refused MEMORY_AUTH_BLOCKED (audited), REMOVE_PERSON is not gated
 *   H1  the kernel's MEMORY_AUTH_BLOCKED is written to the wire exactly as the route's own "Tag not found"
 *
 * G, R and F run FOUR times: on production's kernel today (2711, from 3911's
 * rollback file), on 3911 (3912's rollback), on 3912 (3913's rollback) and on
 * the tree's kernel (3913) — the API ships first and must hold the rule alone.
 * Each group puts back exactly the definition and comment it found.
 *
 * FLAGS are answered in memory with production's values (read-only,
 * 2026-10-24); the bridge never writes feature_flags. Pushes go to a stub
 * (lib/push.ts _setTestFetch); nothing leaves the machine.
 *
 * Run: bash scripts/local-db/run-tests.sh (after up.sh), or with LOCAL_DB_URL set:
 *   node --import tsx/esm --test src/test/db/memoryTagBlockGate.db.test.ts
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
import { _setTestClient, sendError } from "../../lib/http.js";
import { _setTestFetch } from "../../lib/push.js";
import { sendMemoryCommandRejection } from "../../lib/memoryCommandBus.js";
import { dispatchMemoryCommand } from "../../services/memory/MemoryDomainService.js";
import memoriesRouter from "../../routes/memories.js";
// The kernel's event log and outbox are named through lib/memoryOutbox.ts, the one module check:memory-table-ownership lets name them.
import { MEMORY_EVENT_TABLE as EVENTS, MEMORY_OUTBOX_TABLE as OUTBOX } from "../../lib/memoryOutbox.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const RB = (f: string) => resolve(HERE, "../../../../../db/rollback", f);
/** The rollback file that installs each earlier kernel (each re-creates the definition before it, verbatim). */
const INSTALL: Record<"2711" | "3911" | "3912", string> = {
  "2711": RB("2026-10-23-3911-memory-kernel-create-participants-rollback.sql"),
  "3911": RB("2026-10-24-3912-memory-kernel-item-visibility-and-moderation-restore-rollback.sql"),
  "3912": RB("2026-10-24-3913-memory-kernel-tag-block-gate-rollback.sql"),
};
/** md5(pg_get_functiondef) of each, measured: 2711 is production's (read-only, 2026-10-23). */
const MD5_PREFIX: Record<"2711" | "3911" | "3912", string> = { "2711": "542cc3a2", "3911": "5e42fd46", "3912": "207e80ff" };

/** Production's values for every flag these routes read (feature_flags, read-only 2026-10-24). */
const PROD_FLAGS: Record<string, boolean> = {
  memory_kernel_enabled: true,
  memory_location_precision_enabled: true,
  memory_type_enabled: true,
  memory_place_occurrence_name_enabled: true,
  memory_from_own_media_enabled: false,
  memory_merge_split_enabled: true,
  push_notifications_enabled: true,
};

const TAG = `mtb${randomUUID().slice(0, 8)}`;
let owner = "";
/** The owner has blocked this person. */
let blockedByOwner = "";
/** This person has blocked the owner. */
let blocksOwner = "";
/** No block either way. */
let clear = "";
const seeded: string[] = [];
const tokens: Record<string, string> = {};
const tok = (id: string) => `tok-${id}`;
const pushTokenOf = (id: string) => `ExponentPushToken[${id}]`;
let log: string[] = [];
let failOn: (table: string, op: string) => boolean = () => false;
let server: http.Server | null = null;
let base = "";
/** Every push the API sent, by recipient token and the Memory it named. */
const pushes: Array<{ to: string; memoryId: string | null }> = [];

function install(): void {
  log = [];
  _setTestClient(memoryBridge({ flags: PROD_FLAGS, log, tokens, failOn: (t, op) => failOn(t, op) }), true);
}

function person(label: string): string {
  const id = seedUser(`${TAG}${label}`);
  exec(`UPDATE public.profiles SET expo_push_token = '${pushTokenOf(id)}' WHERE id = '${id}';`);
  tokens[tok(id)] = id;
  seeded.push(id);
  return id;
}

function call(method: string, path: string, body: unknown, as: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any; raw: string }> {
  return new Promise((resolvePromise, reject) => {
    const url = new URL(path, base);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request({
      hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method, agent: false,
      headers: { "content-type": "application/json", authorization: `Bearer ${tok(as)}`, ...headers },
    }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => { let b: any; try { b = JSON.parse(raw); } catch { b = raw; } resolvePromise({ status: res.statusCode ?? 0, body: b, raw }); });
    });
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, label: string, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) assert.fail(`timed out waiting for ${label}`); await sleep(50); }
}

const tagsOf = (m: string) => rows<{ tagged_user_id: string; status: string }>(`SELECT tagged_user_id, status FROM public.memory_tags WHERE memory_id = '${m}' ORDER BY tagged_user_id`);
const notifiedOn = (m: string) => rows<{ user_id: string }>(`SELECT user_id FROM public.notifications WHERE actor_id = '${owner}' AND metadata->>'memoryId' = '${m}' ORDER BY user_id`).map((r) => r.user_id);
const pushedOn = (m: string) => pushes.filter((p) => p.memoryId === m).map((p) => p.to).sort();
/** Did the API read this person's push token (notifyTagged's first step towards a push)? */
const pushTokenRead = (l: string[], id: string) => l.some((s) => s.includes("FROM public.profiles") && s.includes("expo_push_token") && s.includes(`'${id}'`));
const sorted = (ids: string[]) => [...ids].sort();

/** notifyTagged runs after the answer (fire and forget): wait until each expected person's notification has landed, then a margin for any that should not. */
async function settled(m: string, expected: string[]): Promise<void> {
  await until(() => sorted(notifiedOn(m)).join() === sorted(expected).join() || notifiedOn(m).length > expected.length, `the notifications on ${m}`);
  await sleep(400);
}

const kernelDefMd5 = (): string | null => scalar(`SELECT md5(pg_get_functiondef('public.memory_kernel_execute(jsonb)'::regprocedure))`);
const commentMd5 = (): string | null => scalar(`SELECT md5(obj_description('public.memory_kernel_execute(jsonb)'::regprocedure, 'pg_proc'))`);
/** The installed kernel's definition AND comment, as raw psql output (exec() drops blank lines, which would change the body). */
const kernelDef = (): string => { const r = psql(`SELECT pg_get_functiondef('public.memory_kernel_execute(jsonb)'::regprocedure);`); assert.equal(r.status, 0, r.stderr); const c = psql(`SELECT obj_description('public.memory_kernel_execute(jsonb)'::regprocedure, 'pg_proc');`); assert.equal(c.status, 0, c.stderr); return `${r.stdout.replace(/\n$/, "")};\nCOMMENT ON FUNCTION public.memory_kernel_execute(jsonb) IS $kc$${c.stdout.replace(/\n$/, "")}$kc$`; };
const restoreKernel = (def: string): void => { const r = psql(`${def};\nREVOKE ALL ON FUNCTION public.memory_kernel_execute(jsonb) FROM PUBLIC, anon, authenticated;\nGRANT EXECUTE ON FUNCTION public.memory_kernel_execute(jsonb) TO service_role;`); assert.equal(r.status, 0, `the saved kernel did not re-apply:\n${r.stderr}`); };
function applyFile(path: string): void { const r = psql(readFileSync(path, "utf8")); assert.equal(r.status, 0, `${path} did not apply:\n${r.stderr}`); }
/** The chain's kernel is LATER than 3912: none of the three earlier definitions, and it carries 3912's commands. Deliberately not a 3913 marker, so a mutant that removes the gate still runs every case (and K1/K2 say what it broke). */
const treeIsAfter3912 = () => !Object.values(MD5_PREFIX).some((p) => (kernelDefMd5() ?? "").startsWith(p)) && scalar(`SELECT position('CHANGE_ITEM_VISIBILITY' IN pg_get_functiondef('public.memory_kernel_execute(jsonb)'::regprocedure)) > 0`) === "t";

function seedMemoryWithTags(label: string, tagged: string[]): string {
  const m = randomUUID();
  exec(`INSERT INTO public.memories (id, owner_id, title, visibility, state) VALUES ('${m}', '${owner}', '${TAG} ${label}', 'friends_only', 'published');
        ${tagged.map((t) => `INSERT INTO public.memory_tags (memory_id, tagged_user_id, status) VALUES ('${m}', '${t}', 'pending');`).join("\n")}`);
  return m;
}
const block = (blocker: string, blocked: string) => exec(`INSERT INTO public.blocks (blocker_id, blocked_id) VALUES ('${blocker}', '${blocked}');`);

describe("§CD H1: the kernel's MEMORY_AUTH_BLOCKED reaches the wire exactly as the route's own missing tag", () => {
  test("H1 sendMemoryCommandRejection(MEMORY_AUTH_BLOCKED) writes the status and bytes of sendError(not_found, \"Tag not found\")", () => {
    const capture = () => { const out = { status: 0, body: "" }; const res: any = { status(s: number) { out.status = s; return res; }, json(b: unknown) { out.body = JSON.stringify(b); return res; } }; return { out, res }; };
    const a = capture(); sendMemoryCommandRejection(a.res, { ok: false, reason: "MEMORY_AUTH_BLOCKED", contractVersion: 1 } as any);
    const b = capture(); sendError(b.res, "not_found", "Tag not found");
    assert.deepEqual(a.out, b.out, "a block must not be distinguishable from a tag that does not exist");
    assert.ok(!a.out.body.includes("BLOCK") && !a.out.body.includes("block"), "the word never reaches the wire");
  });
});

describe("§CD: nobody blocked either way is tagged in, consents to, or is told about a Memory", { skip: !HAVE_DB }, () => {
  before(async () => {
    owner = person("o"); blockedByOwner = person("a"); blocksOwner = person("b"); clear = person("c");
    block(owner, blockedByOwner);
    block(blocksOwner, owner);
    _setTestFetch((async (_url: any, init: any) => {
      const messages = JSON.parse(init.body);
      for (const msg of messages) pushes.push({ to: msg.to, memoryId: msg.data?.memoryId ?? null });
      return { ok: true, status: 200, json: async () => ({ data: messages.map(() => ({ status: "ok", id: "t" })) }) } as any;
    }) as any);
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => { req.log = { error: () => {}, warn: () => {}, info: () => {}, child: () => req.log }; next(); });
    app.use("/api", memoriesRouter);
    server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server!.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
    assert.ok(treeIsAfter3912(), "the chain carries a kernel after 3912 (3913)");
  });
  after(async () => {
    _setTestFetch(null);
    await sleep(300); // a notifyTagged still in flight
    await new Promise((r) => (server ? server.close(() => r(null)) : r(null)));
    for (const id of seeded) {
      exec(`DELETE FROM public.${OUTBOX} WHERE memory_id IN (SELECT id FROM public.memories WHERE owner_id = '${id}');
            DELETE FROM public.${EVENTS} WHERE actor_user_id = '${id}' OR memory_id IN (SELECT id FROM public.memories WHERE owner_id = '${id}');
            DELETE FROM public.memory_command_audit WHERE actor_user_id = '${id}';
            DELETE FROM public.memory_command_receipts WHERE actor_user_id = '${id}';
            DELETE FROM public.notifications WHERE user_id = '${id}' OR actor_id = '${id}';
            DELETE FROM public.memory_tags WHERE tagged_user_id = '${id}';
            DELETE FROM public.memories WHERE owner_id = '${id}';
            DELETE FROM public.trip_members WHERE user_id = '${id}';
            DELETE FROM public.trips WHERE owner_id = '${id}';
            DELETE FROM public.blocks WHERE blocker_id = '${id}' OR blocked_id = '${id}';
            DELETE FROM public.profiles WHERE id = '${id}';
            DELETE FROM auth.users WHERE id = '${id}';`);
    }
  });

  for (const kernel of ["2711", "3911", "3912", "tree"] as const) describe(`G/R/F (${kernel})`, () => {
    let saved = ""; let savedMd5: string | null = null; let savedComment: string | null = null;
    before(() => {
      savedMd5 = kernelDefMd5(); savedComment = commentMd5(); saved = kernelDef();
      if (kernel !== "tree") { applyFile(INSTALL[kernel]); assert.ok((kernelDefMd5() ?? "").startsWith(MD5_PREFIX[kernel]), `${kernel}'s definition is installed`); }
    });
    after(() => {
      failOn = () => false;
      if (kernel !== "tree") { restoreKernel(saved); assert.equal(kernelDefMd5(), savedMd5, "the tree's kernel restored exactly"); assert.equal(commentMd5(), savedComment, "and its comment"); }
    });

    test(`G1[${kernel}] POST /memories naming a person the owner blocked, a person who blocked the owner and a third: only the third is tagged, notified and pushed`, async () => {
      failOn = () => false; install();
      const res = await call("POST", "/api/memories", { title: `${TAG} G1 ${kernel}`, visibility: "friends_only", taggedUserIds: [blockedByOwner, blocksOwner, clear] }, owner);
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const m = String(res.body.memory.id);
      const l = log;
      assert.deepEqual(tagsOf(m), [{ tagged_user_id: clear, status: "pending" }], "neither blocked person is tagged; the create still succeeds");
      await settled(m, [clear]);
      assert.deepEqual(notifiedOn(m), [clear], "only the unblocked person has an in-app notification");
      assert.deepEqual(pushedOn(m), [pushTokenOf(clear)], "only the unblocked person is pushed");
      assert.ok(pushTokenRead(l, clear), "control: the API did read the unblocked person's push token");
      for (const id of [blockedByOwner, blocksOwner]) assert.equal(pushTokenRead(l, id), false, "a blocked person's push token is never even read");
      if (kernel !== "2711") assert.deepEqual(JSON.parse(scalar(`SELECT payload_json->'refs'->'tagged_user_ids' FROM public.${EVENTS} WHERE memory_id = '${m}'`) ?? "null"), [clear], "memory.created names only the person tagged");
    });

    test(`G2[${kernel}] POST /trips/:tripId/memory: a crew member blocked either way is not tagged, notified or pushed; taggedCount counts the rest`, async () => {
      const tripId = randomUUID();
      exec(`INSERT INTO public.trips (id, owner_id, title, destination_city, status, start_date, end_date)
              VALUES ('${tripId}', '${owner}', '${TAG} trip ${kernel}', 'Da Nang', 'completed', '2026-09-01', '2026-09-05');
            INSERT INTO public.trip_members (trip_id, user_id, role) VALUES ('${tripId}', '${blockedByOwner}', 'member'), ('${tripId}', '${blocksOwner}', 'member'), ('${tripId}', '${clear}', 'member');`);
      failOn = () => false; install();
      const res = await call("POST", `/api/trips/${tripId}/memory`, {}, owner);
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.taggedCount, 1);
      const m = String(res.body.memory.id);
      const l = log;
      assert.deepEqual(tagsOf(m), [{ tagged_user_id: clear, status: "pending" }]);
      await settled(m, [clear]);
      assert.deepEqual(notifiedOn(m), [clear]);
      assert.deepEqual(pushedOn(m), [pushTokenOf(clear)]);
      for (const id of [blockedByOwner, blocksOwner]) assert.equal(pushTokenRead(l, id), false);
    });

    let consentMemory = ""; let d1 = ""; let d2 = "";
    test(`G3[${kernel}] a consent across a block, either direction, is answered byte for byte as a tag that does not exist, and changes nothing`, async () => {
      d1 = person(`d1${kernel}`); d2 = person(`d2${kernel}`); const nobody = person(`e${kernel}`);
      consentMemory = seedMemoryWithTags(`G3 ${kernel}`, [d1, d2]); // tagged first; the blocks come after, as they do in life
      block(owner, d1);
      block(d2, owner);
      failOn = () => false; install();
      const missing = await call("PATCH", `/api/memories/${consentMemory}/tags/${nobody}`, { action: "approve" }, nobody, { "idempotency-key": randomUUID() });
      assert.equal(missing.status, 404, missing.raw);
      for (const d of [d1, d2]) {
        install();
        const r = await call("PATCH", `/api/memories/${consentMemory}/tags/${d}`, { action: "approve" }, d, { "idempotency-key": randomUUID() });
        assert.equal(r.status, missing.status);
        assert.equal(r.raw, missing.raw, "the same bytes as a missing tag: the block is never told");
      }
      assert.deepEqual(tagsOf(consentMemory), sorted([d1, d2]).map((t) => ({ tagged_user_id: t, status: "pending" })), "neither consent landed");
      assert.equal(scalar(`SELECT count(*) FROM public.${EVENTS} WHERE memory_id = '${consentMemory}'`), "0", "no event");
      assert.equal(scalar(`SELECT count(*) FROM public.memory_command_receipts WHERE memory_id = '${consentMemory}'`), "0", "no receipt");
    });

    test(`G4[${kernel}] removing a tag across a block is never gated: the owner removes one, the tagged person removes the other`, async () => {
      failOn = () => false; install();
      const byOwner = await call("PATCH", `/api/memories/${consentMemory}/tags/${d1}`, { action: "remove" }, owner, { "idempotency-key": randomUUID() });
      assert.equal(byOwner.status, 200, byOwner.raw);
      install();
      const bySelf = await call("PATCH", `/api/memories/${consentMemory}/tags/${d2}`, { action: "remove" }, d2, { "idempotency-key": randomUUID() });
      assert.equal(bySelf.status, 200, bySelf.raw);
      assert.deepEqual(tagsOf(consentMemory), sorted([d1, d2]).map((t) => ({ tagged_user_id: t, status: "removed" })));
    });

    test(`R1[${kernel}] notifyTagged's own gate: a block made between the tag and the notification (either direction) stops the notification and the push`, async () => {
      const r1 = person(`r1${kernel}`); const r2 = person(`r2${kernel}`); const r3 = person(`r3${kernel}`);
      let sawKernel = false; let raced = false;
      failOn = (table, op) => {
        if (op === "rpc" && table === "memory_kernel_execute") sawKernel = true;
        if (table === "blocks" && op === "select" && sawKernel && !raced) { raced = true; block(owner, r1); block(r2, owner); }
        return false;
      };
      install();
      const res = await call("POST", "/api/memories", { title: `${TAG} R1 ${kernel}`, visibility: "friends_only", taggedUserIds: [r1, r2, r3] }, owner);
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const m = String(res.body.memory.id);
      const l = log;
      assert.deepEqual(tagsOf(m).map((t) => t.tagged_user_id), sorted([r1, r2, r3]), "all three were tagged: the blocks came after the tag");
      await settled(m, [r3]);
      assert.equal(raced, true, "the race happened: a blocks read after the kernel call");
      assert.deepEqual(notifiedOn(m), [r3], "a person blocked in the meantime gets no notification");
      assert.deepEqual(pushedOn(m), [pushTokenOf(r3)], "and no push");
      for (const id of [r1, r2]) assert.equal(pushTokenRead(l, id), false);
      failOn = () => false;
    });

    test(`F1[${kernel}] POST /memories with the blocks table unreadable refuses BEFORE any write (fail closed)`, async () => {
      failOn = (table, op) => table === "blocks" && op === "select"; install();
      const title = `${TAG} F1 ${kernel}`;
      const res = await call("POST", "/api/memories", { title, visibility: "friends_only", taggedUserIds: [clear] }, owner);
      assert.equal(res.status, 503, res.raw);
      assert.equal(res.body.error, "degraded_unavailable");
      assert.equal(scalar(`SELECT count(*) FROM public.memories WHERE title = '${title}'`), "0", "nothing was created");
      assert.equal(log.some((s) => s.includes("memory_kernel_execute")), false, "the kernel was never called");
      failOn = () => false;
    });

    test(`F2[${kernel}] POST /trips/:tripId/memory with the blocks table unreadable refuses BEFORE any write`, async () => {
      const tripId = randomUUID();
      exec(`INSERT INTO public.trips (id, owner_id, title, destination_city, status, start_date, end_date)
              VALUES ('${tripId}', '${owner}', '${TAG} F2 ${kernel}', 'Da Nang', 'completed', '2026-09-01', '2026-09-05');
            INSERT INTO public.trip_members (trip_id, user_id, role) VALUES ('${tripId}', '${clear}', 'member');`);
      failOn = (table, op) => table === "blocks" && op === "select"; install();
      const res = await call("POST", `/api/trips/${tripId}/memory`, {}, owner);
      assert.equal(res.status, 503, res.raw);
      assert.equal(scalar(`SELECT count(*) FROM public.memories WHERE owner_id = '${owner}' AND title LIKE '%${TAG} F2 ${kernel}%'`), "0");
      assert.equal(log.some((s) => s.includes("memory_kernel_execute")), false);
      failOn = () => false;
    });

    test(`F3[${kernel}] a consent with the blocks table unreadable refuses, and the tag stays pending`, async () => {
      const m = seedMemoryWithTags(`F3 ${kernel}`, [clear]);
      failOn = (table, op) => table === "blocks" && op === "select"; install();
      const res = await call("PATCH", `/api/memories/${m}/tags/${clear}`, { action: "approve" }, clear, { "idempotency-key": randomUUID() });
      assert.equal(res.status, 503, res.raw);
      assert.deepEqual(tagsOf(m), [{ tagged_user_id: clear, status: "pending" }]);
      failOn = () => false;
    });

    test(`F4[${kernel}] notifyTagged with the blocks table unreadable notifies and pushes nobody`, async () => {
      let sawKernel = false; let gateReads = 0;
      failOn = (table, op) => {
        if (op === "rpc" && table === "memory_kernel_execute") sawKernel = true;
        if (table === "blocks" && op === "select" && sawKernel) { gateReads += 1; return true; }
        return false;
      };
      install();
      const res = await call("POST", "/api/memories", { title: `${TAG} F4 ${kernel}`, visibility: "friends_only", taggedUserIds: [clear] }, owner);
      assert.equal(res.status, 201, res.raw);
      const m = String(res.body.memory.id);
      const l = log;
      assert.deepEqual(tagsOf(m), [{ tagged_user_id: clear, status: "pending" }]);
      await until(() => gateReads > 0, "notifyTagged's blocks read");
      await sleep(400);
      assert.deepEqual(notifiedOn(m), [], "an unknown block is treated as a block");
      assert.deepEqual(pushedOn(m), []);
      assert.equal(pushTokenRead(l, clear), false);
      failOn = () => false;
    });
  });

  // ── K: 3913's kernel, called straight — the rule held by the database for every caller ──
  describe("K (tree) — 3913's kernel, called directly", () => {
    const direct = (type: string, memoryId: string | null, actor: string, payload: Record<string, unknown>) => dispatchMemoryCommand<any>({
      sc: memoryBridge({ flags: PROD_FLAGS }), commandType: type as any, memoryId, actorUserId: actor, idempotencyKey: randomUUID(), payload,
      legacy: async () => { throw new Error("legacy must not run"); },
    });
    const reasonOf = (out: any) => (!out.ok && "rejection" in out ? out.rejection.reason : JSON.stringify(out));

    test("K1 CREATE_MEMORY naming both blocked people and a third tags, reports and records only the third", async () => {
      const out = await direct("CREATE_MEMORY", null, owner, { to_state: "CANDIDATE", visibility: "friends_only", tagged_user_ids: [blockedByOwner, blocksOwner, clear], write: { title: `${TAG} K1`, visibility: "friends_only", state: "draft" }, select: "id" });
      assert.equal(out.ok, true, JSON.stringify(out));
      if (!out.ok) return;
      const m = String(out.body.id);
      assert.deepEqual(tagsOf(m), [{ tagged_user_id: clear, status: "pending" }]);
      assert.deepEqual(out.taggedUserIds, [clear], "the kernel's answer names only the person tagged");
      assert.deepEqual(JSON.parse(scalar(`SELECT payload_json->'refs'->'tagged_user_ids' FROM public.${EVENTS} WHERE memory_id = '${m}'`) ?? "null"), [clear]);
    });

    test("K2 ADD_PERSON across a block, either direction, is refused MEMORY_AUTH_BLOCKED and audited; the tag stays pending; an unblocked consent lands", async () => {
      const k1 = person("k1"); const k2 = person("k2"); const k3 = person("k3");
      const m = seedMemoryWithTags("K2", [k1, k2, k3]);
      block(owner, k1);
      block(k2, owner);
      for (const k of [k1, k2]) {
        const out = await direct("ADD_PERSON", m, k, { tagged_user_id: k, status: "approved" });
        assert.equal(reasonOf(out), "MEMORY_AUTH_BLOCKED");
        assert.equal(scalar(`SELECT outcome || ':' || reason FROM public.memory_command_audit WHERE memory_id = '${m}' AND actor_user_id = '${k}'`), "rejected:MEMORY_AUTH_BLOCKED");
      }
      const ok = await direct("ADD_PERSON", m, k3, { tagged_user_id: k3, status: "approved" });
      assert.equal(ok.ok, true, JSON.stringify(ok));
      assert.deepEqual(tagsOf(m), [
        { tagged_user_id: k1, status: "pending" }, { tagged_user_id: k2, status: "pending" }, { tagged_user_id: k3, status: "approved" },
      ].sort((a, b) => a.tagged_user_id.localeCompare(b.tagged_user_id)));
    });

    test("K3 REMOVE_PERSON across a block is not gated: the owner removes, the tagged person removes", async () => {
      const k4 = person("k4"); const k5 = person("k5");
      const m = seedMemoryWithTags("K3", [k4, k5]);
      block(owner, k4);
      block(k5, owner);
      const a = await direct("REMOVE_PERSON", m, owner, { tagged_user_id: k4, status: "removed", actor_role: "owner" });
      assert.equal(a.ok, true, JSON.stringify(a));
      const b = await direct("REMOVE_PERSON", m, k5, { tagged_user_id: k5, status: "removed", actor_role: "participant" });
      assert.equal(b.ok, true, JSON.stringify(b));
      assert.deepEqual(tagsOf(m).map((t) => t.status), ["removed", "removed"]);
    });
  });
});
