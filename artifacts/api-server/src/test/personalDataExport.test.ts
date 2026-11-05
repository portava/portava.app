/**
 * "Download your data" — GET /api/me/export.
 *
 * The privacy policy promises access and portability in-app; this is that
 * export. The fake client below HONOURS `.eq` / `.in` / `.order` / `.range`
 * and the select list, so ownership and column scoping are proven by the
 * production filters, not by fixtures that only hold the right rows.
 *
 *   X1  sign-in required; nothing is read without it;
 *   X2  the export holds the caller's rows and nobody else's, and every read
 *       is scoped to the caller (an owner column, or the caller's own parent ids);
 *   X3  any section that cannot be read fails the whole export — no file;
 *   X4  the push token, staff identities and staff notes are not in the file;
 *   X5  collection items come through the caller's own collections only;
 *   X6  other people are named by handle in `people`;
 *   X7  paging reads every row past one page, and a section past the cap says
 *       `truncated` and the file says `complete: false`;
 *   X8  rate limited per person;
 *   X9  every table and column the registry names is in the production
 *       baseline, and no migration drops or renames one;
 *   X10 a restricted account may still download (OD-TRUST-5).
 *
 * Run: node --import tsx/esm --test src/test/personalDataExport.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";
import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import { RESTRICTED_ACCOUNT_ROUTES } from "../lib/restrictedAccountAccess.js";
import { BASELINE_PATH } from "../scripts/parseBaselineSchema.js";
import {
  EXPORT_SECTIONS, MAX_ROWS_PER_SECTION, PAGE_SIZE, NOT_INCLUDED, buildPersonalDataExport, ExportReadError,
} from "../lib/personalDataExport.js";

const ALICE = "a1a1a1a1-aaaa-aaaa-aaaa-00000000a11c";
const BOB = "b0b0b0b0-bbbb-bbbb-bbbb-00000000b0b0";
const CAROL = "c0c0c0c0-cccc-cccc-cccc-0000000ca401";

type Row = Record<string, unknown>;
type Read = { table: string; select: string; eq: Array<[string, unknown]>; in: Array<[string, unknown[]]> };

let reads: Read[] = [];

function makeClient(store: Record<string, Row[]>, opts: { failTable?: string } = {}) {
  return {
    auth: {
      getUser: async (token: string) => {
        const id = ({ "alice-token": ALICE, "bob-token": BOB, "carol-token": CAROL } as Record<string, string>)[token];
        return id ? { data: { user: { id } }, error: null } : { data: { user: null }, error: { message: "not authed" } };
      },
    },
    from: (table: string) => {
      const r: Read = { table, select: "*", eq: [], in: [] };
      let orders: string[] = [];
      let range: [number, number] | null = null;
      const run = () => {
        reads.push(r);
        if (opts.failTable === table) return { data: null, error: { message: "boom", code: "42P01" } };
        let rows = (store[table] ?? []).filter((row) =>
          r.eq.every(([c, v]) => row[c] === v) && r.in.every(([c, vs]) => vs.includes(row[c])));
        if (orders.length) {
          rows = [...rows].sort((a, b) => {
            for (const c of orders) { const x = String(a[c]); const y = String(b[c]); if (x !== y) return x < y ? -1 : 1; }
            return 0;
          });
        }
        if (range) rows = rows.slice(range[0], range[1] + 1);
        if (r.select !== "*") {
          const cols = r.select.split(",").map((c) => c.trim());
          rows = rows.map((row) => Object.fromEntries(cols.filter((c) => c in row).map((c) => [c, row[c]])));
        }
        return { data: rows, error: null };
      };
      const chain: any = {
        select: (cols: string) => { r.select = cols; return chain; },
        eq: (c: string, v: unknown) => { r.eq.push([c, v]); return chain; },
        in: (c: string, vs: unknown[]) => { r.in.push([c, vs]); return chain; },
        order: (c: string) => { orders.push(c); return chain; },
        range: (a: number, b: number) => { range = [a, b]; return chain; },
        // requireUser's account-state gate (lib/accountStateGate.ts).
        maybeSingle: async () => ({ data: table === "profiles" ? { account_status: "active" } : null, error: null }),
        then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, bad),
      };
      return chain;
    },
  } as any;
}

function seed(): Record<string, Row[]> {
  return {
    profiles: [
      { id: ALICE, handle: "alice", name: "Alice", expo_push_token: "ExponentPushToken[secret]", safety_flags_count: 2, bio: "hi" },
      { id: BOB, handle: "bob", name: "Bob", expo_push_token: "ExponentPushToken[bob]" },
    ],
    posts: [
      { id: "p1", author_id: ALICE, content: "Lisbon" },
      { id: "p2", author_id: BOB, content: "not alice's" },
    ],
    user_follows: [
      { follower_id: ALICE, following_id: BOB },
      { follower_id: BOB, following_id: ALICE },
      { follower_id: BOB, following_id: CAROL },
    ],
    collections: [
      { id: "c-a", owner_id: ALICE, name: "Porto" },
      { id: "c-b", owner_id: BOB, name: "Bob's" },
    ],
    collection_items: [
      { id: "ci1", collection_id: "c-a", entity_type: "post", entity_id: "p2" },
      { id: "ci2", collection_id: "c-b", entity_type: "post", entity_id: "p1" },
    ],
    reports: [
      { id: "r1", reporter_id: ALICE, target_type: "post", target_id: "p9", reason_code: "spam", status: "resolved", moderation_notes: "staff only", reviewed_by: "staff-1", severity: "low", notes: "internal" },
    ],
    appeals: [{ id: "a1", appellant_id: ALICE, reason: "mistake", state: "open", moderator_id: "staff-2", resolution_note: null }],
    passport_postcards: [{ id: "pc1", user_id: ALICE, stamp_revoked_by: "staff-3", caption: "hello" }],
    blocks: [{ id: "b1", blocker_id: ALICE, blocked_id: CAROL }],
  };
}

let app: Express;
let server: Server;
let port: number;

before(async () => {
  const { default: exportRouter } = await import("../routes/personalDataExport.js");
  app = express();
  app.use((req, _res, next) => { (req as any).log = { info() {}, error() {}, warn() {}, debug() {} }; next(); });
  app.use("/api", exportRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as any).port;
});

after(() => { server.close(); _setTestClient(null as any, false); });
beforeEach(() => { reads = []; _resetRateLimit(); });

async function get(token: string | null = "alice-token"): Promise<{ status: number; body: any; headers: Headers }> {
  const r = await fetch(`http://127.0.0.1:${port}/api/me/export`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  let body: any = null;
  try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body, headers: r.headers };
}

const exportReads = () => reads.filter((r) => !(r.table === "profiles" && r.select.includes("account_status")));

describe("GET /api/me/export", () => {
  it("X1 requires sign-in and reads nothing without it", async () => {
    _setTestClient(makeClient(seed()), true as any);
    const res = await get(null);
    assert.ok(res.status === 401 || res.status === 403, `got ${res.status}`);
    assert.deepEqual(exportReads(), []);
  });

  it("X2 holds the caller's rows only, and every read is scoped to the caller", async () => {
    _setTestClient(makeClient(seed()), true as any);
    const res = await get();
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const f = res.body;
    assert.equal(f.format, "portava.personal-data-export");
    assert.equal(f.userId, ALICE);
    assert.equal(f.complete, true);
    assert.deepEqual(f.data.posts.map((p: Row) => p.id), ["p1"]);
    assert.deepEqual(f.data.profile.map((p: Row) => p.id), [ALICE]);
    assert.deepEqual(f.data.following, [{ follower_id: ALICE, following_id: BOB }]);
    assert.deepEqual(f.data.followers, [{ follower_id: BOB, following_id: ALICE }]);
    assert.equal(JSON.stringify(f.data).includes("not alice's"), false);
    assert.deepEqual(f.sections.map((s: { key: string }) => s.key), EXPORT_SECTIONS.map((s) => s.key));
    assert.deepEqual(f.notIncluded, [...NOT_INCLUDED]);
    assert.match(res.headers.get("cache-control") ?? "", /no-store/);
    assert.match(res.headers.get("content-disposition") ?? "", /^attachment; filename="portava-data-\d{4}-\d{2}-\d{2}\.json"$/);

    const ownCollectionIds = ["c-a"];
    for (const r of exportReads()) {
      if (r.table === "profiles" && r.select === "id, handle, name") continue; // the people lookup, X6
      const byOwner = r.eq.some(([, v]) => v === ALICE);
      const byOwnParent = r.in.length > 0 && r.in.every(([, vs]) => vs.every((v) => ownCollectionIds.includes(String(v))));
      assert.ok(byOwner || byOwnParent, `unscoped read of ${r.table}: ${JSON.stringify(r)}`);
    }
  });

  it("X3 a section that cannot be read fails the whole export — no partial file", async () => {
    for (const table of new Set(EXPORT_SECTIONS.map((s) => s.table))) {
      reads = [];
      await assert.rejects(
        buildPersonalDataExport(makeClient(seed(), { failTable: table }), ALICE),
        (e: unknown) => e instanceof ExportReadError,
        `a failed ${table} read must not produce an export`,
      );
    }
    _setTestClient(makeClient(seed(), { failTable: "posts" }), true as any);
    const res = await get();
    assert.equal(res.status, 500);
    assert.equal(res.body.error, "db_error");
    assert.equal(res.body.data, undefined, "no section data leaks out with the error");
    assert.equal(res.headers.get("content-disposition"), null);
  });

  it("X3b the people lookup failing fails the export too", async () => {
    const client = makeClient(seed());
    const from = client.from;
    client.from = (t: string) => {
      const c = from(t);
      const select = c.select;
      c.select = (cols: string) => cols === "id, handle, name"
        ? { in: () => ({ then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { message: "boom" } }).then(ok) }) }
        : select(cols);
      return c;
    };
    await assert.rejects(buildPersonalDataExport(client, ALICE), (e: unknown) => e instanceof ExportReadError && e.section === "people");
  });

  it("X4 the push token, staff identities and staff notes are not in the file", async () => {
    _setTestClient(makeClient(seed()), true as any);
    const f = (await get()).body;
    assert.equal(f.data.profile[0].expo_push_token, undefined);
    assert.equal(f.data.profile[0].safety_flags_count, undefined);
    assert.equal(f.data.profile[0].bio, "hi", "the rest of the profile is there");
    assert.deepEqual(Object.keys(f.data.reportsFiled[0]).sort(), ["created_at", "id", "reason_code", "status", "target_id", "target_type"].filter((k) => k in seed().reports[0]).sort());
    for (const k of ["moderation_notes", "reviewed_by", "severity", "notes"]) assert.equal(f.data.reportsFiled[0][k], undefined, k);
    assert.equal(f.data.appeals[0].moderator_id, undefined);
    assert.equal(f.data.appeals[0].reason, "mistake");
    assert.equal(f.data.postcards[0].stamp_revoked_by, undefined);
    assert.equal(f.data.postcards[0].caption, "hello");
    const raw = JSON.stringify(f);
    for (const secret of ["ExponentPushToken", "staff only", "staff-1", "staff-2", "staff-3"]) assert.equal(raw.includes(secret), false, secret);
    assert.ok(f.sections.find((s: { key: string }) => s.key === "reportsFiled").omitted, "the file says what it left out");
  });

  it("X5 collection items come through the caller's own collections only", async () => {
    _setTestClient(makeClient(seed()), true as any);
    const f = (await get()).body;
    assert.deepEqual(f.data.collections.map((c: Row) => c.id), ["c-a"]);
    assert.deepEqual(f.data.collectionItems.map((c: Row) => c.id), ["ci1"]);
  });

  it("X6 other people are named by handle; the caller is not listed as a stranger", async () => {
    _setTestClient(makeClient(seed()), true as any);
    const f = (await get()).body;
    assert.deepEqual(f.people[BOB], { handle: "bob", name: "Bob" });
    assert.equal(CAROL in f.people, false, "Carol has no profile row in the fixture, so she is not invented");
    assert.equal(f.people[ALICE], undefined);
  });

  it("X7 reads every page, and a section past the cap is marked truncated", async () => {
    const store = seed();
    store.posts_comments = Array.from({ length: PAGE_SIZE * 2 + 5 }, (_, i) => ({ id: `cm${String(i).padStart(6, "0")}`, user_id: ALICE }));
    store.posts_likes = Array.from({ length: MAX_ROWS_PER_SECTION + 1 }, (_, i) => ({ id: `lk${String(i).padStart(6, "0")}`, user_id: ALICE }));
    const f = await buildPersonalDataExport(makeClient(store), ALICE);
    assert.equal(f.data.comments.length, PAGE_SIZE * 2 + 5);
    assert.equal(new Set(f.data.comments.map((c) => c.id)).size, PAGE_SIZE * 2 + 5, "no row read twice");
    assert.equal(f.data.likes.length, MAX_ROWS_PER_SECTION);
    assert.equal(f.sections.find((s) => s.key === "likes")?.truncated, true);
    assert.equal(f.sections.find((s) => s.key === "comments")?.truncated, false);
    assert.equal(f.complete, false);
  });

  it("X8 is rate limited per person", async () => {
    _setTestClient(makeClient(seed()), true as any);
    for (let i = 0; i < 5; i++) assert.equal((await get("carol-token")).status, 200);
    const sixth = await get("carol-token");
    assert.equal(sixth.status, 429);
    assert.ok(Number(sixth.headers.get("retry-after")) > 0);
    assert.equal((await get("alice-token")).status, 200, "another person is not limited by Carol's downloads");
  });
});

describe("X9 — the registry names only baseline or explicitly migrated tables", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const baseline = readFileSync(BASELINE_PATH, "utf8");
  const tables = new Map<string, Set<string>>();
  for (const m of baseline.matchAll(/^CREATE TABLE public\.([A-Za-z0-9_]+) \(([\s\S]*?)^\);/gm)) {
    tables.set(m[1], new Set([...m[2].matchAll(/^\s+([a-z_][a-z0-9_]*)\s+/gm)].map((c) => c[1])));
  }
  const feedbackMigration=readFileSync(join(here,"../migrations/4017_telegraph_outcome_feedback.sql"),"utf8");
  const feedbackDefinition=feedbackMigration.match(/CREATE TABLE IF NOT EXISTS public\.telegraph_outcome_feedback\(([\s\S]*?)\n\);/);
  assert.ok(feedbackDefinition,'owned migration4017 defines the optional feedback table');
  tables.set('telegraph_outcome_feedback',new Set([...feedbackDefinition[1].matchAll(/^\s+([a-z_][a-z0-9_]*)\s+/gm)].map(c=>c[1])));
  const migrationsDir = join(here, "../migrations");
  const migrations = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"))
    .map((f) => ({ f, sql: readFileSync(join(migrationsDir, f), "utf8") }));

  it("parses the baseline (the check has a subject)", () => {
    assert.ok(tables.size > 300, `parsed ${tables.size} tables`);
  });

  for (const s of EXPORT_SECTIONS) {
    it(`${s.key}: ${s.table}`, () => {
      const cols = tables.get(s.table);
      assert.ok(cols, `${s.table} is not in the production baseline`);
      const named = [...s.owners, ...s.orderBy, ...(s.columns ?? []), ...(s.omit ?? []), ...(s.people ?? []), ...(s.via ? [s.via.column] : [])];
      for (const c of named) assert.ok(cols!.has(c), `${s.table}.${c} is not in the production baseline`);
      assert.ok(s.owners.length > 0 || s.via, "a section is read by an owner column or through a parent");
      if (s.via) {
        const parent = EXPORT_SECTIONS.find((p) => p.key === s.via!.section);
        assert.ok(parent && !parent.via && parent.orderBy.includes("id"), "the parent is a direct section with ids");
      }
      for (const { f, sql } of migrations) {
        assert.doesNotMatch(sql, new RegExp(`DROP TABLE(?: IF EXISTS)?\\s+(?:public\\.)?${s.table}\\b`, "i"), `${f} drops ${s.table}`);
        for (const c of named) {
          const alter = new RegExp(`ALTER TABLE(?: IF EXISTS)?(?: ONLY)?\\s+(?:public\\.)?${s.table}\\b[^;]*(?:DROP COLUMN(?: IF EXISTS)?|RENAME COLUMN)\\s+${c}\\b`, "i");
          assert.doesNotMatch(sql, alter, `${f} drops or renames ${s.table}.${c}`);
        }
      }
    });
  }

  it("section keys are unique", () => {
    assert.equal(new Set(EXPORT_SECTIONS.map((s) => s.key)).size, EXPORT_SECTIONS.length);
  });
});

describe("X10 — a restricted account may still download its data", () => {
  it("GET /api/me/export is on the restricted-account allow-list", () => {
    const e = RESTRICTED_ACCOUNT_ROUTES.find((r) => r.method === "GET" && r.path === "/api/me/export");
    assert.ok(e && /OD-TRUST-5/.test(e.why));
  });
});
