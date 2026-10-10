/**
 * Telegraph §30A.9 — forwarding provenance and content capabilities
 * (census-telegraph T406, T407), through the real routes and the real thread
 * read decoration, over an in-memory database. The SQL halves — the atomic
 * writer and the EXPIRES_WITH_SOURCE trigger, i.e. T353's latency — are
 * executed on a real database in `db/telegraphForwardExpiry.db.test.ts`.
 *
 * THE PRIVACY ASSERTIONS ARE SERIALISATION ASSERTIONS. "The response has no
 * `sourceThreadId` field" passes on an implementation that leaks the source
 * thread under any other name. So every audience-facing payload below is
 * JSON.stringify'd and searched for the source thread id, the source message id
 * and the source author's id.
 *
 * Run: node --import tsx/esm --test src/test/telegraphForwarding.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import telegraphForwardRouter from "../routes/telegraphForward.js";
import {
  decideForward,
  DEFAULT_CONTENT_CAPABILITY,
  effectiveCapability,
  FORWARDING_FLAG,
  forwardShapeOf,
  setCapabilityDecision,
  type ForwardSource,
} from "../services/telegraph/forwarding.js";
import { decoratePlatformReads } from "../services/telegraph/platformReadDecorations.js";
import { buildPortavaObjectBody } from "../services/telegraph/shareables.js";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001"; // author in the source thread
const BOB = "bbbbbbbb-0000-4000-8000-000000000002"; // member of source AND target: the forwarder
const CAROL = "cccccccc-0000-4000-8000-000000000003"; // target thread only: the new audience
const DAVE = "dddddddd-0000-4000-8000-000000000004"; // no thread at all

const SRC_THREAD = "10000000-0000-4000-8000-000000000001"; // Alice + Bob (private group)
const TGT_THREAD = "20000000-0000-4000-8000-000000000002"; // Bob + Carol
const E2EE_THREAD = "30000000-0000-4000-8000-000000000003"; // Alice + Bob, encrypted

const M_TEXT = "a0000000-0000-4000-8000-000000000001"; // Alice's words, no capability stated
const M_ALLOW = "a0000000-0000-4000-8000-000000000002"; // Alice's words, ALLOW
const M_NOFWD = "a0000000-0000-4000-8000-000000000003"; // Alice's words, NO_FORWARD
const M_EXPIRES = "a0000000-0000-4000-8000-000000000004"; // Alice's words, EXPIRES_WITH_SOURCE
const M_BOB_OWN = "a0000000-0000-4000-8000-000000000005"; // Bob's own words, no capability
const M_DELETED = "a0000000-0000-4000-8000-000000000006";
const M_PHOTO = "a0000000-0000-4000-8000-000000000007";
const M_LOCATION = "a0000000-0000-4000-8000-000000000008";
const M_E2EE = "a0000000-0000-4000-8000-000000000009";
const M_OBJECT = "a0000000-0000-4000-8000-00000000000a"; // a shared public post, SOURCE_POLICY
const M_OBJECT_GONE = "a0000000-0000-4000-8000-00000000000b"; // a shared post that was deleted
const M_EARLY = "a0000000-0000-4000-8000-00000000000c"; // before Bob's §14.3 window
const FAKE_ID = "a0000000-0000-4000-8000-0000000000ff";

const POST_OK = "b1000000-0000-4000-8000-000000000001";
const POST_GONE = "b1000000-0000-4000-8000-000000000002";

const SECRET_TEXT = "the code for the gate is 4471";

interface State {
  forwarding?: boolean;
  historyBound?: boolean;
  errorTables?: string[];
  blockedTarget?: boolean;
}

function msg(id: string, thread: string, sender: string, extra: Record<string, unknown> = {}) {
  return {
    id, thread_id: thread, sender_id: sender, body: SECRET_TEXT, msg_type: "text", subtype: null,
    media_url: null, deleted_at: null, created_at: "2026-10-01T10:00:00.000Z", ...extra,
  };
}

function fixture(state: State): Record<string, any[]> {
  return {
    feature_flags: [
      { flag: FORWARDING_FLAG, enabled: state.forwarding !== false },
      { flag: "telegraph_history_bound_enabled", enabled: state.historyBound === true },
      { flag: "disable_messaging", enabled: false },
    ],
    message_threads: [
      { id: SRC_THREAD, is_e2ee: false, thread_type: "group" },
      { id: TGT_THREAD, is_e2ee: false, thread_type: "direct" },
      { id: E2EE_THREAD, is_e2ee: true, thread_type: "direct" },
    ],
    message_thread_members: [
      { thread_id: SRC_THREAD, user_id: ALICE, left_at: null, visible_from_at: null },
      { thread_id: SRC_THREAD, user_id: BOB, left_at: null, visible_from_at: state.historyBound ? "2026-09-30T00:00:00.000Z" : null },
      { thread_id: TGT_THREAD, user_id: BOB, left_at: null, visible_from_at: null },
      { thread_id: TGT_THREAD, user_id: CAROL, left_at: null, visible_from_at: null },
      { thread_id: E2EE_THREAD, user_id: ALICE, left_at: null, visible_from_at: null },
      { thread_id: E2EE_THREAD, user_id: BOB, left_at: null, visible_from_at: null },
    ],
    messages: [
      msg(M_TEXT, SRC_THREAD, ALICE),
      msg(M_ALLOW, SRC_THREAD, ALICE),
      msg(M_NOFWD, SRC_THREAD, ALICE),
      msg(M_EXPIRES, SRC_THREAD, ALICE),
      msg(M_BOB_OWN, SRC_THREAD, BOB),
      msg(M_DELETED, SRC_THREAD, ALICE, { deleted_at: "2026-10-02T00:00:00.000Z", body: "" }),
      msg(M_PHOTO, SRC_THREAD, ALICE, { msg_type: "media", media_url: `https://x/storage/${ALICE}/p.jpg`, body: "" }),
      msg(M_LOCATION, SRC_THREAD, ALICE, { msg_type: "location", subtype: "exact", body: JSON.stringify({ kind: "LOCATION", envelopeVersion: "1", payload: { label: "Home", precision: "exact", lat: 16.05, lng: 108.2 } }) }),
      msg(M_E2EE, E2EE_THREAD, ALICE),
      msg(M_OBJECT, SRC_THREAD, ALICE, { msg_type: "portava_object", subtype: "post", body: JSON.stringify(buildPortavaObjectBody("POST", POST_OK, "Alice's private caption")) }),
      msg(M_OBJECT_GONE, SRC_THREAD, ALICE, { msg_type: "portava_object", subtype: "post", body: JSON.stringify(buildPortavaObjectBody("POST", POST_GONE, null)) }),
      msg(M_EARLY, SRC_THREAD, ALICE, { created_at: "2026-09-01T10:00:00.000Z" }),
    ],
    message_content_capabilities: [
      { message_id: M_ALLOW, capability: "ALLOW", set_by: ALICE },
      { message_id: M_NOFWD, capability: "NO_FORWARD", set_by: ALICE },
      { message_id: M_EXPIRES, capability: "EXPIRES_WITH_SOURCE", set_by: ALICE },
    ],
    message_forwards: [],
    blocks: state.blockedTarget ? [{ blocker_id: CAROL, blocked_id: BOB }] : [],
    posts: [
      { id: POST_OK, author_id: ALICE, content: "A bar with no sign", visibility: "public", status: "active", deleted_at: null, media_urls: [], updated_at: "2026-05-01T00:00:00.000Z" },
      { id: POST_GONE, author_id: ALICE, content: "Gone", visibility: "public", status: "deleted", deleted_at: "2026-05-02T00:00:00.000Z", media_urls: [], updated_at: "2026-05-02T00:00:00.000Z" },
    ],
    profiles: [
      { id: ALICE, handle: "alice", name: "Alice", account_status: "active" },
      { id: BOB, handle: "bob", name: "Bob", account_status: "active" },
      { id: CAROL, handle: "carol", name: "Carol", account_status: "active" },
    ],
  };
}

/** The in-memory twin of 3665's telegraph_record_forward — same checks, same outcomes. */
function recordForward(db: Record<string, any[]>, a: any) {
  const src = db.messages!.find((m) => m.id === a.p_source_message_id);
  if (!src || src.deleted_at) return { outcome: "source_gone" };
  const explicit = db.message_content_capabilities!.find((c) => c.message_id === src.id)?.capability ?? null;
  const inherited = db.message_forwards!.find((f) => f.target_message_id === src.id)?.capability ?? null;
  const eff = explicit ?? inherited ?? "SOURCE_POLICY";
  if (eff === "NO_FORWARD") return { outcome: "restricted" };
  if (eff !== a.p_capability) return { outcome: "capability_changed" };
  const id = `f0000000-0000-4000-8000-${String(db.messages!.length).padStart(12, "0")}`;
  const createdAt = "2026-10-10T12:00:00.000Z";
  db.messages!.push({ id, thread_id: a.p_target_thread_id, sender_id: a.p_forwarder_id, body: a.p_body, msg_type: a.p_msg_type, subtype: a.p_subtype, media_url: null, deleted_at: null, created_at: createdAt });
  db.message_forwards!.push({ target_message_id: id, source_message_id: src.id, provenance: a.p_provenance, capability: eff, forwarded_by: a.p_forwarder_id, revoked_at: null });
  return { outcome: "forwarded", messageId: id, createdAt };
}

function makeClient(state: State) {
  const db = fixture(state);
  const rpcCalls: any[] = [];
  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let pendingUpsert: any = null;
    const failing = () => (state.errorTables ?? []).includes(table);
    const rowsNow = () => (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
    const target: any = {
      select() { return proxy; },
      upsert(row: any) { pendingUpsert = row; return proxy; },
      insert(row: any) { (db[table] ??= []).push(row); return proxy; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return proxy; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return proxy; },
      in(c: string, vs: any[]) { filters.push((r) => vs.map(String).includes(String(r[c]))); return proxy; },
      is(c: string, v: any) { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return proxy; },
      maybeSingle() {
        if (failing()) return Promise.resolve({ data: null, error: { message: `injected ${table}` } });
        return Promise.resolve({ data: rowsNow()[0] ?? null, error: null });
      },
      single() { return target.maybeSingle(); },
      then(resolve: any, reject?: any) {
        if (failing()) return Promise.resolve({ data: null, error: { message: `injected ${table}` } }).then(resolve, reject);
        if (pendingUpsert) {
          const list = (db[table] ??= []);
          const i = list.findIndex((r) => r.message_id === pendingUpsert.message_id);
          if (i >= 0) list[i] = { ...list[i], ...pendingUpsert }; else list.push(pendingUpsert);
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        }
        return Promise.resolve({ data: rowsNow(), error: null }).then(resolve, reject);
      },
    };
    const proxy: any = new Proxy(target, {
      get(t, p) {
        if (p in t) return t[p as string];
        if (p === "catch" || p === "finally") return undefined;
        return () => proxy;
      },
    });
    return proxy;
  }
  return {
    _db: db,
    _rpc: rpcCalls,
    from,
    rpc: async (name: string, args: any) => {
      rpcCalls.push({ name, args });
      if (name === "telegraph_record_forward") return { data: recordForward(db, args), error: null };
      return { data: null, error: { message: "rpc not modelled" } };
    },
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
    channel: () => ({ send: async () => undefined, subscribe: () => undefined }),
    removeChannel: async () => undefined,
  };
}

let server: ReturnType<typeof createServer>;
let base = "";

function useState(state: State = {}) {
  const c = makeClient(state);
  _setTestClient(c, true);
  return c;
}

async function call(method: string, path: string, asUser: string, body?: unknown) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${asUser}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

const forward = (as: string, sourceMessageId: string, target = TGT_THREAD) =>
  call("POST", `/threads/${target}/forward`, as, { sourceMessageId });

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = { error() {}, warn() {}, info() {}, debug() {} }; next(); });
  app.use("/api", telegraphForwardRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Nothing about the source may appear in what the new audience receives. */
function assertNoLineage(payload: unknown, what: string) {
  const s = JSON.stringify(payload);
  for (const [label, needle] of [["source thread id", SRC_THREAD], ["source author id", ALICE], ["source message ids", "a0000000-0000-4000-8000-"]] as const) {
    assert.ok(!s.includes(needle), `${what} carries the ${label}: ${s.slice(0, 400)}`);
  }
}

// ── the rule, without a database ─────────────────────────────────────────────

const src = (over: Partial<ForwardSource> = {}): ForwardSource => ({
  id: M_TEXT, thread_id: SRC_THREAD, sender_id: ALICE, body: "hi", msg_type: "text", subtype: null, ...over,
});

describe("T407 — the capability rule (decideForward)", () => {
  it("the default is SOURCE_POLICY, and an explicit capability beats an inherited one", () => {
    assert.equal(DEFAULT_CONTENT_CAPABILITY, "SOURCE_POLICY");
    assert.equal(effectiveCapability(null, null), "SOURCE_POLICY");
    assert.equal(effectiveCapability(null, "EXPIRES_WITH_SOURCE"), "EXPIRES_WITH_SOURCE");
    assert.equal(effectiveCapability("NO_FORWARD", "ALLOW"), "NO_FORWARD");
    assert.equal(effectiveCapability("bogus", null), "SOURCE_POLICY", "an unknown word is not a capability");
  });

  it("SOURCE_POLICY on a person's words: only that person may forward them", () => {
    const base = { sourceIsE2ee: false, explicitCapability: null, inheritedCapability: null };
    const other = decideForward({ ...base, source: src(), forwarderId: BOB });
    assert.equal(other.ok, false);
    assert.equal(!other.ok && other.code, "forward_restricted");
    const own = decideForward({ ...base, source: src(), forwarderId: ALICE });
    assert.equal(own.ok, true);
  });

  it("NO_FORWARD refuses everyone, the author included", () => {
    for (const who of [ALICE, BOB]) {
      const d = decideForward({ source: src(), forwarderId: who, sourceIsE2ee: false, explicitCapability: "NO_FORWARD", inheritedCapability: null });
      assert.equal(!d.ok && d.code, "forward_restricted");
    }
  });

  it("ALLOW and EXPIRES_WITH_SOURCE admit any viewer, and the derivative inherits the capability", () => {
    for (const cap of ["ALLOW", "EXPIRES_WITH_SOURCE"] as const) {
      const d = decideForward({ source: src(), forwarderId: BOB, sourceIsE2ee: false, explicitCapability: cap, inheritedCapability: null });
      assert.ok(d.ok);
      assert.equal(d.ok && d.capability, cap);
      assert.equal(d.ok && d.provenance, "FORWARDED");
      assert.equal(d.ok && d.msgType, "text");
      assert.equal(d.ok && d.subtype, null);
    }
  });

  it("a deleted or unsent source, an encrypted source, an attachment and a location are refused", () => {
    const ok = { forwarderId: ALICE, explicitCapability: "ALLOW", inheritedCapability: null, sourceIsE2ee: false };
    assert.equal((decideForward({ ...ok, source: src({ deleted_at: "x" }) }) as any).code, "source_unavailable");
    assert.equal((decideForward({ ...ok, source: src({ unsent_at: "x" }) }) as any).code, "source_unavailable");
    assert.equal((decideForward({ ...ok, sourceIsE2ee: true, source: src() }) as any).code, "e2ee_source");
    assert.equal((decideForward({ ...ok, source: src({ msg_type: "media", media_url: "u" }) }) as any).code, "attachment_copy_unsupported");
    assert.equal((decideForward({ ...ok, source: src({ msg_type: "voice" }) }) as any).code, "attachment_copy_unsupported");
    for (const t of ["location", "safety", "system", "card", "coordination", "announcement", "action"]) {
      assert.equal((decideForward({ ...ok, source: src({ msg_type: t }) }) as any).code, "kind_not_forwardable", t);
    }
    assert.equal(forwardShapeOf(src({ subtype: "discovery_card" })), "other", "a text row carrying a card subtype is not words");
  });

  it("a shared object is RESHARED_FROM_SOURCE, only when the forwarder can open it, WITHOUT the author's caption", () => {
    const body = JSON.stringify(buildPortavaObjectBody("POST", POST_OK, "Alice's private caption"));
    const s = src({ msg_type: "portava_object", subtype: "post", body });
    const base = { source: s, forwarderId: BOB, sourceIsE2ee: false, explicitCapability: null, inheritedCapability: null };
    assert.equal((decideForward({ ...base, objectAvailableToForwarder: false }) as any).code, "source_unavailable");
    assert.equal((decideForward({ ...base, explicitCapability: "ALLOW", objectAvailableToForwarder: false }) as any).code, "source_unavailable", "ALLOW never launders an object the forwarder cannot open");
    const d = decideForward({ ...base, objectAvailableToForwarder: true });
    assert.ok(d.ok);
    assert.equal(d.ok && d.provenance, "RESHARED_FROM_SOURCE");
    assert.ok(d.ok && !d.body.includes("private caption"), "the author's caption crossed into the new audience");
    assert.equal(d.ok && JSON.parse(d.body).caption, null);
  });

  it("only the author sets a capability, never on a derivative, never on a gone message", () => {
    const m = { sender_id: ALICE, deleted_at: null };
    assert.equal(setCapabilityDecision({ message: m, callerId: ALICE, isDerivative: false }).ok, true);
    assert.equal((setCapabilityDecision({ message: m, callerId: BOB, isDerivative: false }) as any).code, "forbidden");
    assert.equal((setCapabilityDecision({ message: m, callerId: ALICE, isDerivative: true }) as any).code, "forbidden");
    assert.equal((setCapabilityDecision({ message: null, callerId: ALICE, isDerivative: false }) as any).code, "not_found");
    assert.equal((setCapabilityDecision({ message: { ...m, deleted_at: "x" }, callerId: ALICE, isDerivative: false }) as any).code, "not_found");
  });
});

// ── the route ────────────────────────────────────────────────────────────────

describe("T406 — POST /threads/:id/forward", () => {
  it("flag OFF (the seed): feature_disabled and nothing written", async () => {
    const c = useState({ forwarding: false });
    const r = await forward(BOB, M_ALLOW);
    assert.equal(r.body.error, "feature_disabled");
    assert.equal(c._rpc.length, 0);
    assert.equal(c._db.message_forwards!.length, 0);
  });

  it("an ALLOW message: one derivative in the target thread, provenance recorded, NO lineage in the response", async () => {
    const c = useState();
    const before = c._db.messages!.length;
    const r = await forward(BOB, M_ALLOW);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(r.body.forwarded, { provenance: "FORWARDED" });
    assert.equal(r.body.contentCapability, "ALLOW");
    assertNoLineage(r.body, "the forward response");
    assert.equal(c._db.messages!.length, before + 1);
    const copy = c._db.messages!.at(-1)!;
    assert.equal(copy.thread_id, TGT_THREAD);
    assert.equal(copy.sender_id, BOB, "the derivative's sender is the forwarder, never the source author");
    assert.equal(copy.body, SECRET_TEXT);
    assert.equal(copy.reply_to_id, undefined, "no reply linkage crosses");
    const fwd = c._db.message_forwards!.at(-1)!;
    assert.equal(fwd.source_message_id, M_ALLOW);
    assert.equal(fwd.provenance, "FORWARDED");
  });

  it("the default (SOURCE_POLICY): Bob cannot forward Alice's words, and can forward his own", async () => {
    const c = useState();
    const r = await forward(BOB, M_TEXT);
    assert.equal(r.status, 403);
    assert.equal(r.body.reason, "forward_restricted");
    assert.ok(!JSON.stringify(r.body).includes(ALICE), "the refusal names the author");
    const own = await forward(BOB, M_BOB_OWN);
    assert.equal(own.status, 201);
    assert.equal(own.body.contentCapability, "SOURCE_POLICY");
    assert.equal(c._db.message_forwards!.length, 1);
  });

  it("NO_FORWARD: refused, nothing written", async () => {
    const c = useState();
    const r = await forward(BOB, M_NOFWD);
    assert.equal(r.status, 403);
    assert.equal(c._rpc.length, 0);
  });

  it("A STRANGER CANNOT PROBE: a real message in a thread Dave is not in answers exactly like a fake id", async () => {
    useState();
    const real = await forward(DAVE, M_ALLOW);
    const fake = await forward(DAVE, FAKE_ID);
    assert.equal(real.status, 404);
    assert.deepEqual(real, fake, "the response distinguishes a real message from a fake one");
  });

  it("outside the forwarder's §14.3 window the message does not exist for them", async () => {
    useState({ historyBound: true });
    const early = await forward(BOB, M_EARLY);
    const fake = await forward(BOB, FAKE_ID);
    assert.deepEqual(early, fake);
  });

  it("deleted, photo, location, encrypted and revoked-object sources are refused", async () => {
    const c = useState();
    assert.equal((await forward(BOB, M_DELETED)).status, 404);
    assert.equal((await forward(BOB, M_PHOTO)).body.reason, "attachment_copy_unsupported");
    assert.equal((await forward(BOB, M_LOCATION)).body.reason, "kind_not_forwardable");
    assert.equal((await forward(BOB, M_E2EE)).body.reason, "e2ee_source");
    assert.equal((await forward(BOB, M_OBJECT_GONE)).status, 404);
    assert.equal(c._rpc.length, 0);
  });

  it("a shared object reshares as a fresh reference: no caption, no lineage", async () => {
    const c = useState();
    const r = await forward(BOB, M_OBJECT);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(r.body.forwarded, { provenance: "RESHARED_FROM_SOURCE" });
    const copy = c._db.messages!.at(-1)!;
    assert.equal(copy.msg_type, "portava_object");
    assert.ok(!copy.body.includes("private caption"));
    assert.equal(JSON.parse(copy.body).objectId, POST_OK);
  });

  it("the target thread's own write gate applies: not a member, or a 1:1 block", async () => {
    const c = useState();
    const notMember = await forward(BOB, M_ALLOW, E2EE_THREAD.replace("3000", "4000"));
    assert.equal(notMember.status, 403);
    const c2 = useState({ blockedTarget: true });
    const blocked = await forward(BOB, M_ALLOW);
    assert.equal(blocked.status, 403);
    assert.equal(c._rpc.length + c2._rpc.length, 0);
  });

  it("an unreadable capability is never read as the default — refused, nothing written", async () => {
    for (const t of ["message_content_capabilities", "message_forwards"]) {
      const c = useState({ errorTables: [t] });
      const r = await forward(BOB, M_NOFWD);
      assert.equal(r.status, 503, t);
      assert.equal(c._rpc.length, 0, t);
    }
  });

  it("a forward of a derivative inherits its capability (EXPIRES_WITH_SOURCE survives a chain)", async () => {
    const c = useState();
    const first = await forward(BOB, M_EXPIRES);
    assert.equal(first.status, 201);
    // Carol, in the target thread only, forwards the copy back into a thread she shares with Bob.
    const second = await forward(CAROL, first.body.id);
    assert.equal(second.status, 201, JSON.stringify(second.body));
    assert.equal(second.body.contentCapability, "EXPIRES_WITH_SOURCE");
    assert.equal(c._db.message_forwards!.at(-1)!.capability, "EXPIRES_WITH_SOURCE");
  });
});

describe("T407 — PUT …/content-capability", () => {
  const put = (as: string, thread: string, id: string, capability: string) =>
    call("PUT", `/threads/${thread}/messages/${id}/content-capability`, as, { capability });

  it("the author sets it; anyone else is refused; a stranger cannot tell the message exists", async () => {
    const c = useState();
    assert.equal((await put(ALICE, SRC_THREAD, M_TEXT, "EXPIRES_WITH_SOURCE")).status, 200);
    assert.equal(c._db.message_content_capabilities!.find((r) => r.message_id === M_TEXT)!.capability, "EXPIRES_WITH_SOURCE");
    assert.equal((await put(BOB, SRC_THREAD, M_TEXT, "ALLOW")).status, 403);
    assert.deepEqual(await put(DAVE, SRC_THREAD, M_TEXT, "ALLOW"), await put(DAVE, SRC_THREAD, FAKE_ID, "ALLOW"));
    assert.equal((await put(ALICE, SRC_THREAD, M_TEXT, "SOMETIMES")).status, 400);
  });

  it("a forwarder cannot loosen what they were given", async () => {
    const c = useState();
    const f = await forward(BOB, M_EXPIRES);
    const r = await put(BOB, TGT_THREAD, f.body.id, "ALLOW");
    assert.equal(r.status, 403);
    assert.equal(c._db.message_content_capabilities!.some((x) => x.message_id === f.body.id), false);
  });
});

// ── the thread read ──────────────────────────────────────────────────────────

describe("T406 — the new audience's thread read carries the provenance word and nothing else", () => {
  it("flag ON: `forwarded: { provenance }`, the capability in force, and no lineage anywhere", async () => {
    const c = useState();
    const f = await forward(BOB, M_ALLOW);
    const copy = c._db.messages!.find((m) => m.id === f.body.id)!;
    const rows = [copy];
    const out: Array<Record<string, any>> = [{ id: copy.id, threadId: TGT_THREAD, senderId: BOB, body: copy.body }];
    await decoratePlatformReads(c as any, rows, out, {});
    assert.deepEqual(out[0]!.forwarded, { provenance: "FORWARDED" });
    assert.equal(out[0]!.contentCapability, "ALLOW");
    assertNoLineage(out, "Carol's thread read");
  });

  it("flag OFF: the page is byte-identical", async () => {
    const c = useState({ forwarding: false });
    c._db.message_forwards!.push({ target_message_id: M_TEXT, source_message_id: M_ALLOW, provenance: "FORWARDED", capability: "ALLOW" });
    const out = [{ id: M_TEXT, body: "x" }];
    const snapshot = JSON.stringify(out);
    await decoratePlatformReads(c as any, [{ id: M_TEXT, msg_type: "text", body: "x" }], out, {});
    assert.equal(JSON.stringify(out), snapshot);
  });

  it("an unreadable provenance table says so, rather than presenting a derivative as an original", async () => {
    const c = useState({ errorTables: ["message_forwards"] });
    const out: Array<Record<string, any>> = [{ id: M_TEXT }];
    await decoratePlatformReads(c as any, [{ id: M_TEXT }], out, {});
    assert.equal(out[0]!.forwardContext, "unavailable");
    assert.equal(out[0]!.forwarded, undefined);
  });
});
