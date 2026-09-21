/**
 * POST /admin/media/:id/moderate — a moderation action with no audit row must
 * not be reported as a plain success.
 *
 * Four branches of this route read the content owner and wrote the audit inside
 * `if (ownerId) { … }` with NO else and NO log, AFTER the content status change
 * had already committed. `resolveContentOwner` returns null for four different
 * reasons, one of which is "the lookup could not RUN" (supabase-js RESOLVES on
 * a database error). So a moderator could remove a post, receive `{ ok: true }`,
 * and leave behind no moderation_actions row at all, with nothing written
 * anywhere saying so.
 *
 * WHAT IS ASSERTED
 *   - the response now carries `audit`, and it distinguishes the outage
 *     (`skipped_owner_lookup_failed`) from genuinely unowned content
 *     (`skipped_no_owner`) from the normal case (`recorded`);
 *   - the ERROR log actually fires, since the operator signal IS the fix on the
 *     status-flip branches — nothing can be un-committed by then;
 *   - the `delete` branch, where the audit genuinely PRECEDES the destruction,
 *     refuses with 503 and REMOVES NOTHING. That is asserted against the
 *     storage double's call log, not against the status code alone.
 *
 * PAIRING: every failure case runs the same route on the same fixture as a
 * readable case, differing only in whether the owner read succeeds.
 *
 * Runtime: node:test. The verdict is the exit code.
 * Run: node --import tsx/esm --test src/test/adminMediaModerateAuditSkip.test.ts
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import adminMediaRouter from "../routes/adminMedia.js";

type Row = Record<string, any>;

const ADMIN_ID = "a0000000-0000-0000-0000-000000000001";
const AUTHOR_ID = "b0000000-0000-0000-0000-000000000002";
const MEDIA_OWNER = "c0000000-0000-0000-0000-000000000003";
const POST_ID = "10000000-0000-0000-0000-000000000010";
const MEDIA_ID = "20000000-0000-0000-0000-000000000020";

const DB_ERROR = { code: "XX000", message: "internal error: relation unavailable" };

interface Harness {
  url: string;
  close: () => Promise<void>;
  tables: Record<string, Row[]>;
  removed: string[][];
  logs: Array<{ level: string; msg: string }>;
}

/**
 * The owner read and the entity read hit the SAME table (`posts.author_id`,
 * `post_media.user_id`), so the error channel is keyed on the projected column:
 * failing the whole table would also break the status update this route runs
 * first, and the 503 would then come from somewhere other than the guard under
 * test. That distinction is what separates this from a false green.
 */
function makeClient(tables: Record<string, Row[]>, ownerReadErrors: Record<string, any>, removed: string[][]) {
  let idc = 0;
  const newId = () => `f0000000-0000-0000-0000-${String(++idc).padStart(12, "0")}`;

  function chain(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let insertRow: Row | null = null;
    let updateRow: Row | null = null;
    let projection = "";

    const rowsOf = () => (tables[table] ??= []);
    const filtered = () => rowsOf().filter((r) => filters.every((f) => f(r)));

    /**
     * Only the OWNER-COLUMN read fails — never the status update, and never the
     * route's own entity load.
     *
     * The match is on the EXACT projection, not a substring. lib/contentOwner.ts
     * reads `.select("user_id")` alone, while the delete branch's entity load
     * reads `.select("id, user_id, storage_path, storage_bucket, …")` — which
     * also contains `user_id`. A substring match failed that read too, so the
     * route 500'd on `readErr` and a test asserting "not 200" would have called
     * that a pass. The hand-revert is what surfaced it.
     */
    const ownerErr = () => {
      const e = ownerReadErrors[table];
      if (!e) return null;
      if (insertRow || updateRow) return null;
      const col = table === "posts" ? "author_id" : table === "post_media" ? "user_id" : "submitted_by";
      return projection.trim() === col ? e : null;
    };

    async function resolve(single: boolean): Promise<{ data: any; error: any }> {
      if (insertRow !== null) {
        const nr = { id: newId(), ...insertRow };
        rowsOf().push(nr);
        return { data: single ? nr : [nr], error: null };
      }
      if (updateRow !== null) {
        const m = filtered();
        for (const r of m) Object.assign(r, updateRow);
        return { data: single ? (m[0] ?? null) : m, error: null };
      }
      const e = ownerErr();
      if (e) return { data: null, error: e };
      const m = filtered();
      return { data: single ? (m[0] ?? null) : m, error: null };
    }

    const b: any = {
      select(cols?: string) { projection = cols ?? ""; return b; },
      insert(d: Row) { insertRow = d; return b; },
      update(d: Row) { updateRow = d; return b; },
      delete() { return b; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return b; },
      in(c: string, vs: any[]) { filters.push((r) => vs.includes(r[c])); return b; },
      order() { return b; }, limit() { return b; }, range() { return b; },
      maybeSingle() { return resolve(true); },
      single() { return resolve(true); },
      then(onF: any, onR: any) { return resolve(false).then(onF, onR); },
    };
    return b;
  }

  return {
    from: (t: string) => chain(t),
    storage: {
      from: () => ({
        async remove(paths: string[]) { removed.push(paths); return { data: paths.map((p) => ({ name: p })), error: null }; },
        async createSignedUrl() { return { data: { signedUrl: "https://example.invalid/x" }, error: null }; },
      }),
    },
    auth: {
      getUser: async (token: string) =>
        token === "admin-token"
          ? { data: { user: { id: ADMIN_ID } }, error: null }
          : { data: { user: null }, error: { message: "invalid" } },
    },
  } as any;
}

async function start(tables: Record<string, Row[]>, ownerReadErrors: Record<string, any> = {}): Promise<Harness> {
  const removed: string[][] = [];
  const logs: Array<{ level: string; msg: string }> = [];
  const client = makeClient(tables, ownerReadErrors, removed);
  _setTestClient(client, true);
  _setTestServiceClient(client);

  const app = express();
  app.use(express.json());
  // REQUIRED. The new branches log before answering; without this shim they
  // throw and a 500-from-crash would impersonate a refusal.
  app.use((r: any, _res: any, next: any) => {
    const cap = (level: string) => (_o: unknown, msg?: string) => { logs.push({ level, msg: String(msg ?? _o) }); };
    r.log = { error: cap("error"), warn: cap("warn"), info: cap("info"), debug: cap("debug") };
    next();
  });
  app.use("/", adminMediaRouter);

  return new Promise((resolve, reject) => {
    const srv = createServer(app);
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.unref();
      resolve({
        url: `http://127.0.0.1:${port}`,
        tables, removed, logs,
        close: () => new Promise<void>((res, rej) => { srv.closeAllConnections?.(); srv.close((e) => (e ? rej(e) : res())); }),
      });
    });
  });
}

async function moderate(url: string, id: string, body: unknown) {
  const res = await fetch(`${url}/admin/media/${id}/moderate`, {
    method: "POST",
    headers: { Authorization: "Bearer admin-token", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

const adminProfile = () => [{ id: ADMIN_ID, role: "admin" }];

let requests = 0;
async function call(
  tables: Record<string, Row[]>,
  errors: Record<string, any>,
  id: string,
  body: unknown,
): Promise<{ h: Harness; status: number; body: any }> {
  const h = await start(tables, errors);
  requests++;
  const r = await moderate(h.url, id, body);
  return { h, ...r };
}

let open: Harness | null = null;
afterEach(async () => { await open?.close(); open = null; });

describe("post status flip — owner lookup fails after the flip has committed", () => {
  it("reports audit: skipped_owner_lookup_failed and logs at ERROR", async () => {
    const tables = { profiles: adminProfile(), posts: [{ id: POST_ID, author_id: AUTHOR_ID, post_status: "published" }], moderation_actions: [] as Row[] };
    const { h, status, body } = await call(tables, { posts: DB_ERROR }, POST_ID, { action: "reject", target: "post" });
    open = h;
    assert.equal(status, 200, "the status flip already committed; this route cannot un-commit it");
    assert.equal(body.audit, "skipped_owner_lookup_failed",
      `the operator must be told the action left no audit row; got ${JSON.stringify(body)}`);
    assert.equal(tables.moderation_actions.length, 0);
    const hit = h.logs.find((l) => l.msg.includes("COULD NOT RUN"));
    assert.ok(hit, `expected an explicit lookup-failure log; got ${JSON.stringify(h.logs)}`);
    assert.equal(hit!.level, "error");
  });

  it("PAIR — owner readable → audit: recorded, and a row IS written", async () => {
    const tables = { profiles: adminProfile(), posts: [{ id: POST_ID, author_id: AUTHOR_ID, post_status: "published" }], moderation_actions: [] as Row[] };
    const { h, status, body } = await call(tables, {}, POST_ID, { action: "reject", target: "post" });
    open = h;
    assert.equal(status, 200);
    assert.equal(body.audit, "recorded");
    assert.equal(tables.moderation_actions.length, 1);
    assert.equal(tables.moderation_actions[0].target_user_id, AUTHOR_ID);
  });

  it("PAIR — owner readable but the post has NO author → audit: skipped_no_owner, logged at WARN", async () => {
    // The case the outage above used to be indistinguishable from.
    const tables = { profiles: adminProfile(), posts: [{ id: POST_ID, author_id: null, post_status: "published" }], moderation_actions: [] as Row[] };
    const { h, status, body } = await call(tables, {}, POST_ID, { action: "reject", target: "post" });
    open = h;
    assert.equal(status, 200);
    assert.equal(body.audit, "skipped_no_owner");
    assert.equal(tables.moderation_actions.length, 0);
    const hit = h.logs.find((l) => l.msg.includes("no accountable user"));
    assert.ok(hit, `expected a skip log; got ${JSON.stringify(h.logs)}`);
    assert.equal(hit!.level, "warn");
  });
});

describe("post_media status flip", () => {
  it("owner lookup fails → audit: skipped_owner_lookup_failed", async () => {
    const tables = { profiles: adminProfile(), post_media: [{ id: MEDIA_ID, user_id: MEDIA_OWNER, moderation_status: "approved" }], moderation_actions: [] as Row[] };
    const { h, status, body } = await call(tables, { post_media: DB_ERROR }, MEDIA_ID, { action: "reject", target: "post_media" });
    open = h;
    assert.equal(status, 200);
    assert.equal(body.audit, "skipped_owner_lookup_failed", JSON.stringify(body));
    assert.equal(tables.moderation_actions.length, 0);
  });

  it("PAIR — owner readable → audit: recorded", async () => {
    const tables = { profiles: adminProfile(), post_media: [{ id: MEDIA_ID, user_id: MEDIA_OWNER, moderation_status: "approved" }], moderation_actions: [] as Row[] };
    const { h, status, body } = await call(tables, {}, MEDIA_ID, { action: "reject", target: "post_media" });
    open = h;
    assert.equal(status, 200);
    assert.equal(body.audit, "recorded");
    assert.equal(tables.moderation_actions.length, 1);
  });
});

describe("post_media DELETE — the one branch that can still fail closed", () => {
  const mediaRow = () => [{
    id: MEDIA_ID, user_id: MEDIA_OWNER, moderation_status: "approved",
    // Bucket-qualified, which is the shape lib/storagePath.ts resolves; an
    // unresolvable path makes the route refuse for a DIFFERENT reason and the
    // 503 under test would not be the one asserted.
    storage_bucket: "post-media", storage_path: "post-media/one.jpg",
  }];

  it("owner lookup fails → 503 and NOTHING is removed from storage", async () => {
    const tables = { profiles: adminProfile(), post_media: mediaRow(), moderation_actions: [] as Row[] };
    const { h, status, body } = await call(tables, { post_media: DB_ERROR }, MEDIA_ID, { action: "delete", target: "post_media" });
    open = h;
    assert.equal(status, 503, `expected 503, got ${status}: ${JSON.stringify(body)}`);
    assert.equal(body.error, "degraded_unavailable", JSON.stringify(body));
    // The assertion that matters: the refusal happened BEFORE any destruction.
    assert.deepEqual(h.removed, [], "no storage object may be removed when the deletion cannot be audited");
    assert.equal(tables.moderation_actions.length, 0);
  });

  it("PAIR — owner readable → the delete proceeds and IS audited", async () => {
    const tables = { profiles: adminProfile(), post_media: mediaRow(), moderation_actions: [] as Row[] };
    const { h, status, body } = await call(tables, {}, MEDIA_ID, { action: "delete", target: "post_media" });
    open = h;
    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert.equal(tables.moderation_actions.length, 1,
      "the delete branch audits before destroying — that row must exist");
    assert.equal(tables.moderation_actions[0].target_user_id, MEDIA_OWNER);
  });
});

describe("vacuity", () => {
  it("every case above actually issued a moderate request", () => {
    assert.ok(requests >= 7, `expected >= 7 requests, got ${requests}`);
  });
});
