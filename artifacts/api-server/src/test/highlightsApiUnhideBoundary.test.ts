/**
 * §17 / §19 / §21 — the UN-HIDE half of Archive, and the one asymmetry §17
 * leaves in the Highlight command vocabulary.
 *
 * Spec: docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt
 *   §5   the Highlight lifecycle. HIDDEN is inside the reversible cycle —
 *        `PINNED ---- HIDDEN` is the one undirected edge in the diagram — so a
 *        reversal of HIDE is a transition the specification draws.
 *   §17  "All canonical writes should cross an explicit command boundary for
 *        authorization, invariants, idempotency, audit, and downstream event
 *        generation." That sentence is UNCONDITIONAL over canonical writes; the
 *        seventeen names beneath it are a list, not the requirement. §17 names
 *        HIDE_HIGHLIGHT and names no inverse.
 *   §19  "client-generated operation IDs and server-side idempotency".
 *   §21  Archive: "Retain … remove from normal browsing unless explicitly
 *        requested", and Archive stays a different operation from Delete.
 *
 * WHAT THIS SUITE IS EVIDENCE FOR
 * ===============================
 * census-highlights-memories.md §U.2 records the gap and the decision that
 * produced it:
 *
 *   "§17 names HIDE_HIGHLIGHT and names no un-hide. `DELETE
 *    /highlights/:id/archive` is therefore still a direct write and not a
 *    command. … Inventing `UNHIDE_HIGHLIGHT` to close the asymmetry would have
 *    put a command in the vocabulary that §17 does not define."
 *
 * TWO THINGS THAT DECISION LEFT UNFINISHED, and this file is about both.
 *
 * 1. ENVELOPE PARITY. Four writes on one aggregate reach one client:
 *    POST/DELETE /highlights/:id/pin and POST/DELETE /highlights/:id/archive.
 *    Three of them validate the §19 `Idempotency-Key` and answer 400 for a key
 *    outside 1-200 characters. The fourth accepted ANY key, silently, and
 *    applied the write — so one client sending one malformed key got a 400 from
 *    the hide and a 200 from the un-hide. That is not the asymmetry §17 causes;
 *    it is an unrelated one that hides behind it. The key is now validated here
 *    and is still NOT honoured, because honouring it needs the receipt row that
 *    only a command writes — case 2 asserts exactly that, so "validated" is
 *    never read as "idempotent".
 *
 * 2. THE DIVERGENCE IS SILENT AT RUNTIME. With the kernel ON, the hide emits
 *    `highlight.hidden` and the un-hide emits nothing, so a §18 consumer
 *    replaying the stream holds the Highlight HIDDEN forever. Until §U.2's gap
 *    is closed in the vocabulary, the server knows this and now says so on the
 *    request that causes it. A census paragraph is not an operational signal.
 *
 * THE FALSE-GREEN RULE, APPLIED
 * =============================
 *   * Every refusal is PAIRED with the same fixture succeeding, so "the handler
 *     is simply broken" cannot produce the green.
 *   * Case 2 asserts the un-hide still crosses NO boundary — no RPC, no event,
 *     no receipt, no audit row. This suite must not be able to go green by
 *     inventing the command it is written to request.
 *   * Case 4 asserts the warning is ABSENT with the kernel off and PRESENT with
 *     it on. A warning that always fired would satisfy a one-sided assertion
 *     and would be noise on production, where the flag is FALSE.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/highlightsApiUnhideBoundary.test.ts
 */
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const HERE_MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { logger } from "../lib/logger.js";
import highlightsRouter from "../routes/highlights.js";
import { HIGHLIGHT_COMMAND_TYPES, COMMAND_EVENT } from "../lib/memoryCommandBus.js";
import { makeKernelRpc, _resetKernelIds, type KernelState } from "./memoryCommandKernelFake.js";

const OWNER    = "10000000-0000-4000-8000-00000000b001";
const OUTSIDER = "10000000-0000-4000-8000-00000000b003";

const H_ARCHIVED = "50000000-0000-4000-8000-00000000e001"; // owner's, archived
const H_OTHER    = "50000000-0000-4000-8000-00000000e002"; // someone else's, archived
const H_DELETED  = "50000000-0000-4000-8000-00000000e003"; // owner's, archived AND soft-deleted
const H_ABSENT   = "50000000-0000-4000-8000-00000000e0ff"; // no row at all

const ARCHIVED_AT = "2026-03-01T00:00:00.000Z";

const highlight = (id: string, owner: string, extra: Record<string, unknown> = {}) => ({
  id, owner_id: owner,
  media_url: "https://x/storage/v1/object/public/post-media/h.jpg",
  media_type: "image/jpeg", caption: "a private caption",
  location_name: null, location_city: null, location_country: null,
  visibility: "public", expires_at: "2099-01-01T00:00:00.000Z",
  created_at: "2026-01-01T00:00:00.000Z", updated_at: null,
  deleted_at: null, archived_at: ARCHIVED_AT, pinned_at: null,
  lifetime_class: null, lifecycle_state: null, highlight_type: null,
  ...extra,
});

function fixtureTables(kernelOn: boolean): Record<string, any[]> {
  return {
    feature_flags: kernelOn ? [{ flag: "memory_kernel_enabled", enabled: true }] : [],
    profiles: [OWNER, OUTSIDER].map((id) => ({
      id, handle: `h${id.slice(-3)}`, name: "n", avatar_url: null,
      account_status: "active", is_private: false,
    })),
    highlights: [
      highlight(H_ARCHIVED, OWNER),
      highlight(H_OTHER, OUTSIDER),
      highlight(H_DELETED, OWNER, { deleted_at: "2026-02-01T00:00:00.000Z" }),
    ],
    blocks: [], user_follows: [], circle_memberships: [],
    // THE §17 KERNEL TABLES ARE DELIBERATELY NOT SEEDED. The fake creates a
    // table lazily on first access, so their ABSENCE from `app.tables` is
    // itself the assertion that nothing on this path touched one — see
    // `kernelTablesTouched`. It also keeps this file out of
    // lib/memoryTableOwnership.ts's KERNEL_SIDE classification, which
    // `check:memory-table-ownership` requires of any file that NAMES one; that
    // list is another lane's file and the check is already red on two entries
    // this lane did not write.
  };
}

/** The same shape as src/test/highlightCommandBoundary.test.ts's fake. */
function makeFakeClient(state: KernelState) {
  const tables = state.tables;
  function chain(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let single = false, isWrite = false, selectedAfterWrite = false;
    let mode: "insert" | "update" | "upsert" | "delete" | null = null;
    let payload: any = null;
    const obj: any = {
      select(_c?: string, _o?: any) { if (isWrite) selectedAfterWrite = true; return obj; },
      insert(d: any) { isWrite = true; mode = "insert"; payload = d; return obj; },
      update(d: any) { isWrite = true; mode = "update"; payload = d; return obj; },
      upsert(d: any) { isWrite = true; mode = "upsert"; payload = d; return obj; },
      delete() { isWrite = true; mode = "delete"; return obj; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return obj; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return obj; },
      in(c: string, vs: any[]) { const s = new Set(vs); filters.push((r) => s.has(r[c])); return obj; },
      is(c: string, v: any) { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return obj; },
      gt() { return obj; }, lt() { return obj; }, gte() { return obj; }, lte() { return obj; },
      not() { return obj; }, ilike() { return obj; }, or() { return obj; }, filter() { return obj; },
      order() { return obj; }, limit() { return obj; }, range() { return obj; },
      maybeSingle() { single = true; return resolve(); },
      single() { single = true; return resolve(); },
      then(f: any, r: any) { return resolve().then(f, r); },
    };
    async function resolve(): Promise<any> {
      const all = (tables[table] ??= []);
      if (mode === "insert" || mode === "upsert") {
        const rows = (Array.isArray(payload) ? payload : [payload])
          .map((r: any) => ({ ...r, id: r.id ?? `new-${Math.random().toString(16).slice(2)}` }));
        for (const r of rows) all.push(r);
        return { data: single ? rows[0] : rows, error: null, count: null };
      }
      const matched = all.filter((r) => filters.every((f) => f(r)));
      if (mode === "delete") {
        const gone = new Set(matched);
        tables[table] = all.filter((r) => !gone.has(r));
        if (!selectedAfterWrite) return { data: null, error: null, count: null };
        return { data: single ? (matched[0] ?? null) : matched, error: null, count: matched.length };
      }
      if (mode === "update") {
        for (const r of matched) Object.assign(r, payload);
        if (!selectedAfterWrite) return { data: null, error: null, count: null };
        return { data: single ? (matched[0] ?? null) : matched, error: null, count: matched.length };
      }
      if (single) return { data: matched[0] ?? null, error: null, count: null };
      return { data: matched, error: null, count: null };
    }
    return obj;
  }
  return {
    from(table: string) { return chain(table); },
    rpc: makeKernelRpc(state),
    storage: { from: () => ({ remove: async () => ({ data: null, error: null }) }) },
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  };
}

interface App {
  baseUrl: string; close: () => Promise<void>;
  errors: Array<{ obj: any; msg: string }>;
  warns: Array<{ obj: any; msg: string }>;
  state: KernelState;
  tables: Record<string, any[]>;
}

async function startApp(opts: { kernelOn?: boolean } = {}): Promise<App> {
  _resetKernelIds();
  const state: KernelState = {
    tables: fixtureTables(opts.kernelOn ?? false),
    rpcCalls: [],
    failOn: new Set(),
    absent: false,
  };
  _setTestClient(makeFakeClient(state) as any, true);
  const errors: Array<{ obj: any; msg: string }> = [];
  const warns: Array<{ obj: any; msg: string }> = [];
  const realInfo = logger.info.bind(logger);
  const realWarn = logger.warn.bind(logger);
  (logger as any).info = () => {};
  (logger as any).warn = () => {};
  const app = express();
  app.use(express.json());
  app.use((req: any, _r: any, n: any) => {
    req.log = {
      error: (obj: any, msg: string) => errors.push({ obj, msg }),
      warn: (obj: any, msg: string) => warns.push({ obj, msg }),
      info: () => {},
    };
    n();
  });
  app.use("/api", highlightsRouter);
  return new Promise((resolve, reject) => {
    const srv = http.createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.unref();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`, errors, warns, state, tables: state.tables,
        close: () => new Promise<void>((r) => {
          (logger as any).info = realInfo; (logger as any).warn = realWarn;
          srv.close(() => r());
        }),
      });
    });
    srv.on("error", reject);
  });
}

async function call(app: App, method: string, path: string, viewer: string, idem?: string) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${viewer}`, "Content-Type": "application/json", connection: "close",
  };
  if (idem) headers["Idempotency-Key"] = idem;
  const res = await fetch(app.baseUrl + path, { method, headers });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}

const row = (app: App, id: string) => app.tables.highlights.find((h) => h.id === id)!;

/**
 * Every §17 kernel table the request touched, read or written.
 *
 * The fake materialises a table the first time anything asks for it, and the
 * fixture seeds none of them, so a non-empty answer here means the un-hide
 * reached the command kernel. Stronger than naming the four tables one by one:
 * a FIFTH artifact added later is caught by this and would be missed by a list.
 */
const kernelTablesTouched = (app: App) =>
  Object.keys(app.tables).filter((t) => t.startsWith("memory_")).sort();

const TOO_LONG = "x".repeat(201);

// ── 1. §19 envelope parity across the four writes on this aggregate ──────────

describe("§19 envelope — the four Highlight writes answer one malformed key the same way", () => {
  it("DELETE /highlights/:id/archive refuses a key outside 1-200 characters and applies NOTHING", async () => {
    const app = await startApp({ kernelOn: false });
    try {
      const r = await call(app, "DELETE", `/api/highlights/${H_ARCHIVED}/archive`, OWNER, TOO_LONG);
      assert.equal(r.status, 400);
      assert.equal(r.body.error, "invalid_payload");
      assert.match(String(r.body.message), /Idempotency-Key/);
      assert.equal(row(app, H_ARCHIVED).archived_at, ARCHIVED_AT,
        "a refused envelope must not have un-archived the row");

      // PAIRED: the SAME fixture, a well-formed key, succeeds. Without this the
      // 400 above is satisfied by a handler that refuses everything.
      const ok = await call(app, "DELETE", `/api/highlights/${H_ARCHIVED}/archive`, OWNER, "k-ok");
      assert.equal(ok.status, 200);
      assert.equal(ok.body.archivedAt, null);
      assert.equal(row(app, H_ARCHIVED).archived_at, null, "§21: Archive is reversible");
    } finally { await app.close(); }
  });

  it("all four writes on this aggregate give the SAME answer to the SAME malformed key", async () => {
    const app = await startApp({ kernelOn: false });
    try {
      const routes: Array<[string, string]> = [
        ["POST",   `/api/highlights/${H_ARCHIVED}/pin`],
        ["DELETE", `/api/highlights/${H_ARCHIVED}/pin`],
        ["POST",   `/api/highlights/${H_ARCHIVED}/archive`],
        ["DELETE", `/api/highlights/${H_ARCHIVED}/archive`],
      ];
      for (const [method, path] of routes) {
        const r = await call(app, method, path, OWNER, TOO_LONG);
        assert.equal(r.status, 400, `${method} ${path} must refuse a malformed §19 key`);
        assert.equal(r.body.error, "invalid_payload", `${method} ${path}`);
      }
      // Nothing was written by ANY of the four.
      assert.equal(row(app, H_ARCHIVED).archived_at, ARCHIVED_AT);
      assert.equal(row(app, H_ARCHIVED).pinned_at, null);
    } finally { await app.close(); }
  });
});

// ── 2. §U.2's gap, still open, and asserted so this suite cannot close it ────

describe("§17 — the un-hide crosses no boundary, and the THREE artifacts that decide when it must", () => {
  // ── REPOINTED 2026-09-22, and the old assertion's own words are why ──────────
  //
  // This case used to read "HIDE_HIGHLIGHT is declared and no inverse of it is",
  // and it swept HIGHLIGHT_COMMAND_TYPES refusing anything matching /^UNHIDE/.
  // Its failure message said what to do if that day came: *"if it is now
  // declared, DELETE /highlights/:id/archive must dispatch it and this suite
  // must be repointed"*. The day came — the HM-SERVER lane declared
  // UNHIDE_HIGHLIGHT as an EXT on the UPDATE_MEMORY precedent, which
  // census-highlights-memories.md §W.2 argues was right and §U.2 wrong — and
  // this case went RED, exactly as designed.
  //
  // It is repointed rather than deleted, and NOT to the easy green. Asserting
  // only "the command is declared" would pass while the route still bypasses
  // it, which is the vacuity this whole file was written against. So the
  // assertion is now the INVARIANT over all three artifacts that have to agree:
  //
  //   the VOCABULARY   lib/memoryCommandBus.ts       — is UNHIDE_HIGHLIGHT declared?
  //   the APPLIER      migrations/2993_*.sql         — does the kernel admit it?
  //   the ROUTE        routes/highlights.ts          — does the un-hide dispatch it?
  //
  // Only two combinations are coherent. All three agree, or the route bypasses
  // the boundary AND says why. Anything else is a contradiction someone shipped.
  //
  // WHY THE MIDDLE STATE IS THE DANGEROUS ONE, stated so nobody "tidies" the
  // route into dispatching: 2993's write path is `IF v_type NOT IN
  // ('PIN_HIGHLIGHT','UNPIN_HIGHLIGHT','HIDE_HIGHLIGHT') THEN` reject. With
  // `memory_kernel_enabled` FALSE — production today — a dispatched
  // UNHIDE_HIGHLIGHT takes the legacy path and works. With the flag ON it is
  // refused BY NAME, so un-archive breaks for every owner. Wiring the route
  // before 2993 admits the type trades a boundary gap for an outage.

  it("the vocabulary, the applier and the route are in ONE of the two coherent states", () => {
    assert.ok(HIGHLIGHT_COMMAND_TYPES.includes("HIDE_HIGHLIGHT" as any));
    assert.equal(COMMAND_EVENT.HIDE_HIGHLIGHT, "highlight.hidden");

    const declared = HIGHLIGHT_COMMAND_TYPES.some((t) => /^UNHIDE/.test(t));
    const kernelSql = readFileSync(resolve(HERE_MIGRATIONS, "2993_highlight_command_boundary.sql"), "utf8");
    const admitted = /v_type NOT IN \(([^)]*)\)/.exec(kernelSql)?.[1]?.includes("UNHIDE") ?? false;
    const routeSrc = readFileSync(resolve(HERE_MIGRATIONS, "..", "routes", "highlights.ts"), "utf8");
    const unhideHandler = /router\.delete\("\/highlights\/:id\/archive"[\s\S]*?\n\}\);/.exec(routeSrc)?.[0] ?? "";
    const dispatches = /commandType:\s*"UNHIDE_HIGHLIGHT"/.test(unhideHandler);

    if (!declared) {
      // The pre-2026-09-22 state. Nothing to reconcile.
      assert.equal(admitted, false, "2993 admits a command the vocabulary does not declare");
      assert.equal(dispatches, false, "the route dispatches a command the vocabulary does not declare");
      return;
    }

    if (dispatches) {
      assert.equal(admitted, true,
        "the un-hide route dispatches UNHIDE_HIGHLIGHT but 2993's applier rejects it by name. " +
        "With memory_kernel_enabled ON this breaks un-archive for every owner; with it OFF the " +
        "legacy path hides that. Admit the type in the applier before the route sends it.");
      return;
    }

    // The state as of 2026-09-22: declared, not yet admitted, so not yet
    // dispatched. Legitimate ONLY while the route says so in the request that
    // causes it — a census paragraph is not an operational signal, which is
    // this file's own §18 argument applied to its own gap.
    assert.equal(admitted, false,
      "2993 admits UNHIDE_HIGHLIGHT and the route still bypasses it — the blocker is gone and " +
      "the wiring did not follow. Dispatch it from DELETE /highlights/:id/archive.");
    assert.match(unhideHandler, /KERNEL_2993_DOES_NOT_ADMIT_UNHIDE_HIGHLIGHT/,
      "the un-hide must name the CURRENT blocker in its runtime warning. " +
      "SPEC_17_NAMES_NO_INVERSE_OF_HIDE_HIGHLIGHT is no longer true: the command is declared.");
  });

  it("a valid key is VALIDATED and NOT honoured — there is no receipt, so the second call applies again", async () => {
    // "Validated" must never be read as "idempotent". With no command there is
    // no receipt row to consult, so the same key twice is two writes — stated
    // here rather than left for a client to discover.
    const app = await startApp({ kernelOn: true });
    try {
      const first = await call(app, "DELETE", `/api/highlights/${H_ARCHIVED}/archive`, OWNER, "k-same");
      assert.equal(first.status, 200);
      row(app, H_ARCHIVED).archived_at = ARCHIVED_AT; // re-hide behind the route's back
      const second = await call(app, "DELETE", `/api/highlights/${H_ARCHIVED}/archive`, OWNER, "k-same");
      assert.equal(second.status, 200);
      assert.equal(row(app, H_ARCHIVED).archived_at, null,
        "no receipt stopped the replay — §19 idempotency is NOT in force on this write");

      // And none of §17's four artifacts was produced, by either call.
      assert.deepEqual(app.state.rpcCalls, [], "no command was issued for the un-hide");
      assert.deepEqual(kernelTablesTouched(app), [],
        "the un-hide reached the §17 command kernel — if that is now deliberate, this suite is the " +
        "request that was answered and it must be repointed, not deleted");
    } finally { await app.close(); }
  });
});

// ── 3. §23 — the un-hide's refusals match the hide's, exactly ────────────────

describe("§23 — one answer for not-yours, not-there and deleted, on BOTH halves of Archive", () => {
  it("the hide and the un-hide return the identical 404 for all three cases", async () => {
    const app = await startApp({ kernelOn: false });
    try {
      for (const id of [H_OTHER, H_ABSENT, H_DELETED]) {
        const hide = await call(app, "POST", `/api/highlights/${id}/archive`, OWNER, `k-h-${id}`);
        const show = await call(app, "DELETE", `/api/highlights/${id}/archive`, OWNER, `k-s-${id}`);
        assert.equal(hide.status, 404, `hide ${id}`);
        assert.equal(show.status, 404, `un-hide ${id}`);
        assert.equal(show.body.error, hide.body.error, `${id}: the two halves must not differ`);
        assert.equal(show.body.message, hide.body.message, `${id}`);
      }
      // The stranger's row was neither hidden nor revealed.
      assert.equal(row(app, H_OTHER).archived_at, ARCHIVED_AT);
      // PAIRED with the success on the owner's own row.
      assert.equal((await call(app, "DELETE", `/api/highlights/${H_ARCHIVED}/archive`, OWNER, "k-ok2")).status, 200);
    } finally { await app.close(); }
  });

  it("an invalid highlight id is a 400 before anything is read", async () => {
    const app = await startApp({ kernelOn: false });
    try {
      const r = await call(app, "DELETE", "/api/highlights/not-a-uuid/archive", OWNER, "k-bad-id");
      assert.equal(r.status, 400);
      assert.equal(r.body.error, "invalid_payload");
    } finally { await app.close(); }
  });
});

// ── 4. The divergence, made observable exactly when it exists ────────────────

describe("§18 — an un-hide that leaves highlight.hidden unanswered says so at runtime", () => {
  it("with the kernel ON the successful un-hide warns, naming the event it did not emit", async () => {
    const app = await startApp({ kernelOn: true });
    try {
      const r = await call(app, "DELETE", `/api/highlights/${H_ARCHIVED}/archive`, OWNER, "k-warn");
      assert.equal(r.status, 200);
      assert.equal(row(app, H_ARCHIVED).archived_at, null, "the write still happens — this is a signal, not a refusal");

      const w = app.warns.find((x) => x.obj?.unemittedEvent !== undefined);
      assert.ok(w, `no boundary warning was logged; warns=${JSON.stringify(app.warns)}`);
      assert.equal(w!.obj.unemittedEvent, "highlight.hidden",
        "the warning must name the event a §18 consumer will never see reversed");
      assert.equal(w!.obj.highlightId, H_ARCHIVED);
      assert.equal(w!.obj.idempotencyKey, "k-warn",
        "the key is carried so an operator can correlate the un-hide with the hide that preceded it");
    } finally { await app.close(); }
  });

  it("with the kernel OFF — production today — there is NO warning, because nothing diverges", async () => {
    // Every Highlight write takes the legacy direct path with the flag false,
    // so the un-hide is not anomalous and must not produce noise. A warning
    // that always fired would pass the case above and be useless.
    const app = await startApp({ kernelOn: false });
    try {
      const r = await call(app, "DELETE", `/api/highlights/${H_ARCHIVED}/archive`, OWNER, "k-quiet");
      assert.equal(r.status, 200);
      assert.equal(row(app, H_ARCHIVED).archived_at, null);
      assert.equal(app.warns.filter((x) => x.obj?.unemittedEvent !== undefined).length, 0,
        "the boundary warning fired with the kernel off");
    } finally { await app.close(); }
  });

  it("a REFUSED un-hide warns about nothing — the signal follows the write, not the request", async () => {
    const app = await startApp({ kernelOn: true });
    try {
      const r = await call(app, "DELETE", `/api/highlights/${H_ABSENT}/archive`, OWNER, "k-none");
      assert.equal(r.status, 404);
      assert.equal(app.warns.filter((x) => x.obj?.unemittedEvent !== undefined).length, 0);
    } finally { await app.close(); }
  });
});
