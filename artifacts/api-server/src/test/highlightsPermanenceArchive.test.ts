/**
 * highlightsPermanenceArchive.test.ts
 *
 * Two owner rulings, 2026-09-06:
 *   1. A Highlight may be PERMANENT — the user chooses the term.
 *   2. An expired Highlight or Story is ARCHIVED, not gone: the owner can see
 *      it and re-post it.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * WHAT THESE REPLACE
 * ══════════════════════════════════════════════════════════════════════════════
 * `highlights.expires_at` was NOT NULL with 48 hours as the ceiling, and
 * `POST /stories/:id/save-to-highlight` wrote `now + 24h`. So "save" meant "keep
 * this for one more day and then lose it, silently". There was no error and no
 * notification — the row survived and the Highlight simply stopped existing.
 *
 * Worse, expiry was enforced in BOTH RLS SELECT policies, ANDed across the whole
 * policy rather than inside the viewer branch. An expired Highlight was
 * therefore invisible to its own owner: no route could see around it, because
 * the database was the thing hiding it. Migration 2313 moves that predicate and
 * gives it a NULL arm; these tests pin the behaviour that migration exists for.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * WHY THE FAKE IMPLEMENTS `or` AND `not`
 * ══════════════════════════════════════════════════════════════════════════════
 * The non-owner readers now issue `.or("expires_at.is.null,expires_at.gt.<iso>")`
 * and the archive issues `.not("expires_at","is",null)`. A double that ignored
 * either would answer "all rows" and turn every filter assertion below into a
 * vacuous pass — which is exactly how a distance-blind constant survived a green
 * suite elsewhere in this repo. An operator this fake does not implement THROWS
 * rather than passing silently.
 */
import { describe, it, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";
import { liveOrPermanent } from "../routes/highlights.js";

interface Row { [k: string]: any; }
interface FakeTable { rows: Row[]; error?: string; }

const U = {
  owner:   "aaaaaaaa-1111-4111-8111-000000000001",
  other:   "bbbbbbbb-1111-4111-8111-000000000002",
  hl1:     "cccccccc-1111-4111-8111-000000000001",
  hl2:     "cccccccc-1111-4111-8111-000000000002",
  story1:  "dddddddd-1111-4111-8111-000000000001",
};

const future = (h = 23) => new Date(Date.now() + h * 3600_000).toISOString();
const past   = () => new Date(Date.now() - 1000).toISOString();

function makeFakeClient(tables: Record<string, FakeTable> = {}) {
  const db: Record<string, FakeTable> = {
    feature_flags: { rows: [{ flag: "stories_enabled", enabled: true }] },
    highlights: { rows: [] },
    stories: { rows: [] },
    blocks: { rows: [] },
    profiles: { rows: [] },
    user_follows: { rows: [] },
    close_friends: { rows: [] },
    ...tables,
  };

  function chain(name: string, start: Row[]) {
    let rows = start;
    let limitN: number | null = null;
    let single = false;
    let op: "select" | "insert" | "update" = "select";
    let payload: any = null;
    const err = () => (db[name]?.error ? { message: db[name]!.error } : null);

    const obj: any = {
      select() { return obj; },
      insert(d: Row | Row[]) {
        op = "insert"; payload = d;
        const t = db[name] ?? (db[name] = { rows: [] });
        const list = (Array.isArray(d) ? d : [d]).map((r) => ({ id: U.hl2, created_at: new Date().toISOString(), ...r }));
        if (!err()) t.rows.push(...list);
        rows = list;
        return obj;
      },
      update(d: Row) {
        op = "update"; payload = d;
        if (!err()) for (const r of rows) Object.assign(r, d);
        return obj;
      },
      eq(c: string, v: any) { rows = rows.filter((r) => r[c] === v); return obj; },
      neq(c: string, v: any) { rows = rows.filter((r) => r[c] !== v); return obj; },
      in(c: string, v: any[]) { rows = rows.filter((r) => v.includes(r[c])); return obj; },
      gt(c: string, v: any) { rows = rows.filter((r) => r[c] != null && r[c] > v); return obj; },
      lte(c: string, v: any) { rows = rows.filter((r) => r[c] != null && r[c] <= v); return obj; },
      is(c: string, v: any) { rows = rows.filter((r) => (v === null ? r[c] == null : r[c] === v)); return obj; },
      not(c: string, o: string, v: any) {
        if (o !== "is" || v !== null) throw new Error(`fake: unsupported not(${c}, ${o})`);
        rows = rows.filter((r) => r[c] != null);
        return obj;
      },
      /** Only the `col.is.null,col.gt.<v>` shape this codebase issues. */
      or(expr: string) {
        const parts = String(expr).split(",");
        rows = rows.filter((r) =>
          parts.some((p) => {
            const m = /^([\w]+)\.(is|gt|eq)\.(.*)$/.exec(p.trim());
            if (!m) throw new Error(`fake: unparseable or() term "${p}"`);
            const [, col, o, val] = m;
            if (o === "is") return val === "null" ? r[col] == null : r[col] === val;
            if (o === "gt") return r[col] != null && r[col] > val;
            return String(r[col]) === val;
          }),
        );
        return obj;
      },
      ilike() { return obj; },
      order() { return obj; },
      limit(n: number) { limitN = n; return obj; },
      single() { single = true; return obj; },
      maybeSingle() {
        const e = err();
        if (e) return Promise.resolve({ data: null, error: e });
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
      then(res: any, rej?: any) {
        const e = err();
        if (e) return Promise.resolve({ data: null, error: e }).then(res, rej);
        let out = rows;
        if (limitN !== null) out = out.slice(0, limitN);
        if (single) {
          return Promise.resolve(
            out.length ? { data: out[0], error: null } : { data: null, error: { message: "No rows" } },
          ).then(res, rej);
        }
        if (op === "insert" || op === "update") return Promise.resolve({ data: out, error: null }).then(res, rej);
        return Promise.resolve({ data: out, error: null, count: out.length }).then(res, rej);
      },
    };
    return obj;
  }

  return {
    auth: {
      getUser: async (token: string) => {
        const u = (db._users?.rows ?? []).find((x) => x.token === token);
        return u ? { data: { user: { id: u.id, email: `${u.id}@t.test` } }, error: null }
                 : { data: { user: null }, error: { message: "Invalid token" } };
      },
    },
    from(t: string) { const tbl = db[t] ?? (db[t] = { rows: [] }); return chain(t, [...tbl.rows]); },
    storage: { from: () => ({ remove: async () => ({ data: null, error: null }) }) },
    _db: db,
  };
}

let server: Server;
let port: number;
beforeEach(async () => {
  await new Promise<void>((r) => {
    server = createServer(app);
    server.listen(0, "127.0.0.1", () => { port = (server.address() as any).port; r(); });
  });
});
afterEach(async () => {
  _setTestClient(null, false);
  await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
});

async function req(method: string, path: string, body?: any, token?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json: any; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, json };
}

const owner = { id: U.owner, token: "tok-owner" };
const other = { id: U.other, token: "tok-other" };

function baseHighlight(over: Row = {}): Row {
  return {
    id: U.hl1, owner_id: U.owner, media_url: "https://x/h.jpg", media_type: "image/jpeg",
    video_duration_seconds: null, caption: null, location_name: null, location_city: null,
    location_country: null, visibility: "public", expires_at: future(),
    created_at: new Date().toISOString(), deleted_at: null, archived_at: null, ...over,
  };
}

// ══ PERMANENCE ════════════════════════════════════════════════════════════════

describe("Highlights — a permanent term", () => {
  it("stores NULL for a permanent Highlight, and never a fabricated date", async () => {
    const c = makeFakeClient({ _users: { rows: [owner] } });
    _setTestClient(c, true);
    const r = await req("POST", "/api/highlights", {
      mediaUrl: "https://x/h.jpg", mediaType: "image/jpeg", expiresInHours: null,
    }, owner.token);
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const stored = c._db.highlights.rows.at(-1)!;
    assert.equal(stored.expires_at, null,
      "permanent must be stored as NULL. Coalescing it to a date is the silent " +
      "truncation this ruling removes.");
  });

  it("permanence is never accidental — an OMITTED term still defaults to 24h", async () => {
    // The whole defect class here is a default that quietly wins. A client that
    // forgets the field must not create something permanent by accident, and a
    // client that forgets it must not create something that vanishes either.
    const c = makeFakeClient({ _users: { rows: [owner] } });
    _setTestClient(c, true);
    const r = await req("POST", "/api/highlights", {
      mediaUrl: "https://x/h.jpg", mediaType: "image/jpeg",
    }, owner.token);
    assert.equal(r.status, 201);
    const stored = c._db.highlights.rows.at(-1)!;
    assert.notEqual(stored.expires_at, null);
    const hours = (new Date(stored.expires_at).getTime() - Date.now()) / 3600_000;
    assert.ok(hours > 23 && hours < 25, `expected ~24h, got ${hours}`);
  });

  it("refuses a term that is neither permanent nor an offered duration", async () => {
    const c = makeFakeClient({ _users: { rows: [owner] } });
    _setTestClient(c, true);
    const r = await req("POST", "/api/highlights", {
      mediaUrl: "https://x/h.jpg", mediaType: "image/jpeg", expiresInHours: 999,
    }, owner.token);
    assert.equal(r.status, 400);
    assert.match(JSON.stringify(r.json), /permanent|expiresInHours/i);
  });

  it("the non-owner filter admits NULL — a permanent Highlight is not hidden by it", () => {
    // The one-line reason this could have shipped broken: `NULL > now()` is NULL,
    // so a bare .gt() drops every permanent row. Asserted on the filter itself
    // because it is issued in three places and a regression in any one of them
    // looks exactly like "that user has no highlights".
    const f = liveOrPermanent("2026-09-06T00:00:00.000Z");
    assert.match(f, /expires_at\.is\.null/, "must admit the permanent arm");
    assert.match(f, /expires_at\.gt\./, "must still exclude expired rows");
  });
});

// ══ ARCHIVE ═══════════════════════════════════════════════════════════════════

describe("Highlights — the archive", () => {
  it("lists the owner's EXPIRED highlights, and not their live or permanent ones", async () => {
    const c = makeFakeClient({
      _users: { rows: [owner] },
      highlights: { rows: [
        baseHighlight({ id: U.hl1, expires_at: past() }),      // archived
        baseHighlight({ id: U.hl2, expires_at: future() }),    // live
        baseHighlight({ id: "cccccccc-1111-4111-8111-000000000003", expires_at: null }), // permanent
      ] },
    });
    _setTestClient(c, true);
    const r = await req("GET", "/api/highlights/archive", undefined, owner.token);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.highlights.map((h: any) => h.id), [U.hl1]);
    assert.equal(r.json.highlights[0].archived, true);
    assert.equal(r.json.ok, true,
      "stated explicitly, so a client never has to infer success from an empty list");
  });

  it("a failed archive read is an ERROR, never an empty archive", async () => {
    // Telling someone their archive is empty when we could not read it is the
    // defect this whole campaign exists to remove.
    const c = makeFakeClient({ _users: { rows: [owner] }, highlights: { rows: [], error: "boom" } });
    _setTestClient(c, true);
    const r = await req("GET", "/api/highlights/archive", undefined, owner.token);
    assert.ok(r.status >= 400, `expected an error status, got ${r.status}`);
  });

  it("is owner-scoped: it never takes a target user", async () => {
    const c = makeFakeClient({
      _users: { rows: [owner, other] },
      highlights: { rows: [baseHighlight({ owner_id: U.owner, expires_at: past() })] },
    });
    _setTestClient(c, true);
    const r = await req("GET", "/api/highlights/archive", undefined, other.token);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.highlights, [], "another user's archive is not addressable");
  });
});

// ══ REPOST ════════════════════════════════════════════════════════════════════

describe("Highlights — repost from the archive", () => {
  it("re-dates the SAME row and can make it permanent", async () => {
    const c = makeFakeClient({
      _users: { rows: [owner] },
      highlights: { rows: [baseHighlight({ expires_at: past() })] },
    });
    _setTestClient(c, true);
    const r = await req("POST", `/api/highlights/${U.hl1}/repost`, { expiresInHours: null }, owner.token);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.permanent, true);
    const row = c._db.highlights.rows.find((h) => h.id === U.hl1)!;
    assert.equal(row.expires_at, null);
    assert.equal(c._db.highlights.rows.length, 1,
      "reposting re-dates the Highlight rather than forking it into a duplicate");
  });

  it("accepts a bounded term too", async () => {
    const c = makeFakeClient({
      _users: { rows: [owner] },
      highlights: { rows: [baseHighlight({ expires_at: past() })] },
    });
    _setTestClient(c, true);
    const r = await req("POST", `/api/highlights/${U.hl1}/repost`, { expiresInHours: 12 }, owner.token);
    assert.equal(r.status, 200);
    assert.equal(r.json.permanent, false);
    const hours = (new Date(r.json.highlight.expires_at).getTime() - Date.now()) / 3600_000;
    assert.ok(hours > 11 && hours < 13, `expected ~12h, got ${hours}`);
  });

  it("only the owner may repost", async () => {
    const c = makeFakeClient({
      _users: { rows: [owner, other] },
      highlights: { rows: [baseHighlight({ expires_at: past() })] },
    });
    _setTestClient(c, true);
    const r = await req("POST", `/api/highlights/${U.hl1}/repost`, { expiresInHours: 24 }, other.token);
    assert.equal(r.status, 403);
  });

  it("a failed read is not a missing Highlight", async () => {
    const c = makeFakeClient({
      _users: { rows: [owner] },
      highlights: { rows: [baseHighlight({ expires_at: past() })], error: "boom" },
    });
    _setTestClient(c, true);
    const r = await req("POST", `/api/highlights/${U.hl1}/repost`, { expiresInHours: 24 }, owner.token);
    assert.notEqual(r.status, 404, "a read failure must not be reported as 'not found'");
    assert.ok(r.status >= 400);
  });
});

// ══ THE MIGRATION'S OWN CONTRACT ══════════════════════════════════════════════

describe("migration 2313 — the RLS shape permanence and the archive both need", () => {
  const sql = () =>
    readFileSync(new URL("../migrations/2313_highlights_permanent.sql", import.meta.url), "utf8");

  it("drops NOT NULL, so permanence can be stored at all", () => {
    assert.match(sql(), /ALTER COLUMN expires_at DROP NOT NULL/);
  });

  it("every SELECT policy admits the NULL arm", () => {
    // Both policies are PERMISSIVE, so a permanent row must satisfy at least
    // one; if either keeps a bare `expires_at > now()` the row satisfies
    // neither and permanence silently shows nothing.
    const body = sql();
    const policies = body.split("CREATE POLICY").slice(1);
    assert.equal(policies.length, 2, "expected both SELECT policies to be replaced");
    for (const p of policies) {
      assert.match(p, /expires_at IS NULL OR expires_at > now\(\)/,
        "a policy testing expiry without the NULL arm hides every permanent Highlight");
    }
  });

  it("the owner arm is UNCONDITIONAL, which is what makes the archive possible", () => {
    // The archive ruling is a database rule before it is a route: with expiry
    // ANDed across the whole policy, an expired Highlight is invisible to its
    // own owner and no endpoint can see around it.
    for (const p of sql().split("CREATE POLICY").slice(1)) {
      const ownerAt = p.indexOf("owner_id = auth.uid()");
      const expiryAt = p.indexOf("expires_at");
      assert.ok(ownerAt !== -1 && expiryAt !== -1);
      assert.ok(ownerAt < expiryAt,
        "the owner branch must come before the expiry test, i.e. expiry applies " +
        "only to the non-owner arm");
    }
  });

  it("refuses to apply if either invariant is violated", () => {
    const body = sql();
    assert.match(body, /POSTCONDITION FAILED: .*without admitting NULL/);
    assert.match(body, /POSTCONDITION FAILED: .*hidden from its own owner/);
  });
});
