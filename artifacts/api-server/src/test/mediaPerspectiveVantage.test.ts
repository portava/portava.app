/**
 * census-media §36 (MD82–MD85, MD444) — §12 perspective groups as a
 * contributor-declared vantage, behind `media_perspective_vantage_enabled`
 * (migration 3352, seeded OFF).
 *
 * WHAT IS PROVED, AND THE LINE EACH CASE TURNS RED ON
 *   A. The four vocabularies are §12's, WORD FOR WORD: they are read out of the
 *      spec file itself and compared, so a vantage nobody wrote cannot be added.
 *      The migration's CHECK admits exactly their union.
 *   B. The write: no vantage ⇒ the insert is byte-identical (no key at all);
 *      a vantage while the flag is off ⇒ refused, nothing written; a vantage
 *      outside the category's §12 list ⇒ refused; a valid one ⇒ written.
 *   C. The read: flag off ⇒ NO query names the column and no projection carries
 *      a vantage; flag on ⇒ the place page groups by the declared vantage under
 *      the spec's own label.
 *   D. Privacy: a vantage rides the place. A post whose owner withheld the place
 *      (city_only) carries no vantage for a non-owner — they learn no more than
 *      before; the owner sees their own. The World "FOR YOU NOW" buckets stay
 *      category-only.
 *   E. Migration 3352 seeds the flag FALSE and only adds a nullable column.
 *
 * Run: node --import tsx/esm --test src/test/mediaPerspectiveVantage.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PERSPECTIVE_VANTAGES_BY_TYPE,
  PERSPECTIVE_VANTAGE_KEYS,
  PERSPECTIVE_VANTAGE_FLAG,
  VANTAGE_ENTITY_TYPE_BY_CATEGORY,
  decidePerspectiveVantageWrite,
  vantageAllowedForCategory,
} from "../lib/media/perspectiveVantage.js";
import {
  CONTRIBUTION_VANTAGES_BY_CATEGORY,
  PERSPECTIVE_VANTAGE_FLAG as CLIENT_VANTAGE_FLAG,
} from "../../../../travel-buddy-standalone/src/features/media/state/mediaContribution.ts";
import {
  resolveViewer,
  buildPlaceProjection,
  projectCandidatesProtected,
} from "../services/media/MediaProjectionService.js";
import { buildCategoryBuckets } from "../services/media/MediaPerspectiveService.js";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import postsRouter from "../routes/posts.js";
import { makeFakeClient, BEARER, type FakeState } from "./helpers.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..", "..");

// ─────────────────────────────────────────────────────────────────────────────
// A. §12, word for word
// ─────────────────────────────────────────────────────────────────────────────

describe("A. the vocabularies are §12's own words", () => {
  const spec = readFileSync(join(REPO, "docs", "specs", "Portava_Media_Engineering_Architecture_and_Design_Spec.txt"), "utf8").split("\n");
  const groupsAfter = (entity: string) => {
    const i = spec.findIndex((l) => l.trim() === entity);
    assert.ok(i > 0, `§12 names ${entity}`);
    return spec[i + 1]!.split("·").map((w) => w.trim());
  };

  for (const [type, entity] of [["nightclub", "Nightclub"], ["festival", "Festival"], ["beach", "Beach"], ["restaurant", "Restaurant"]] as const) {
    it(`${entity}: the labels are the spec's list, in its order`, () => {
      assert.deepEqual(PERSPECTIVE_VANTAGES_BY_TYPE[type].map(([, label]) => label), groupsAfter(entity));
    });
  }

  it("the migration's CHECK admits exactly the union of the four lists", () => {
    const sql = readFileSync(join(HERE, "..", "migrations", "3352_media_perspective_vantage.sql"), "utf8");
    const arr = /ARRAY\[([\s\S]*?)\]::text\[\]/.exec(sql)![1]!;
    const values = [...arr.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    assert.equal(new Set(values).size, values.length, "no value twice");
    assert.deepEqual([...values].sort(), [...PERSPECTIVE_VANTAGE_KEYS].sort());
  });

  it("the client's lists are the server's, category for category, and it reads the same flag", () => {
    assert.equal(CLIENT_VANTAGE_FLAG, PERSPECTIVE_VANTAGE_FLAG);
    for (const [category, list] of Object.entries(CONTRIBUTION_VANTAGES_BY_CATEGORY)) {
      const type = VANTAGE_ENTITY_TYPE_BY_CATEGORY[category];
      assert.ok(type, `${category} is a §12 category on the server too`);
      assert.deepEqual(list.map(([k, l]) => [k, l]), PERSPECTIVE_VANTAGES_BY_TYPE[type!].map(([k, l]) => [k, l]), category);
    }
    assert.deepEqual(Object.keys(CONTRIBUTION_VANTAGES_BY_CATEGORY).sort(), ["beach", "festival", "food", "nightlife"]);
  });

  it("a category maps to a §12 type only for the four the spec lists", () => {
    assert.equal(vantageAllowedForCategory("entrance", "nightlife"), true);
    assert.equal(vantageAllowedForCategory("sunset", "beach"), true);
    assert.equal(vantageAllowedForCategory("menu_context", "food"), true);
    assert.equal(vantageAllowedForCategory("main_gate", "festival"), true);
    assert.equal(vantageAllowedForCategory("sunset", "nightlife"), false, "not a Nightclub group");
    assert.equal(vantageAllowedForCategory("entrance", "culture"), false, "culture has no §12 vocabulary");
    assert.equal(vantageAllowedForCategory("entrance", null), false);
    assert.equal(vantageAllowedForCategory("rooftop", "nightlife"), false, "no invented vantage");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. The write
// ─────────────────────────────────────────────────────────────────────────────

function flagClient(on: boolean) {
  return {
    from() {
      const all = on ? [{ flag: PERSPECTIVE_VANTAGE_FLAG, enabled: true }] : [];
      let asked: string | null = null;
      const pick = () => all.filter((r) => asked === null || r.flag === asked);
      const b: any = {
        select() { return b; },
        eq(col: string, val: any) { if (col === "flag") asked = String(val); return b; },
        in() { return b; },
        maybeSingle() { return Promise.resolve({ data: pick()[0] ?? null, error: null }); },
        then(onF: any, onR: any) { return Promise.resolve({ data: pick(), error: null }).then(onF, onR); },
      };
      return b;
    },
  };
}

describe("B. decidePerspectiveVantageWrite", () => {
  it("no vantage ⇒ nothing to write, and no flag read", async () => {
    const d = await decidePerspectiveVantageWrite({ from() { throw new Error("must not read"); } }, null, "nightlife");
    assert.deepEqual(d, { ok: true, write: undefined });
  });
  it("flag OFF ⇒ refused", async () => {
    const d = await decidePerspectiveVantageWrite(flagClient(false), "entrance", "nightlife");
    assert.equal(d.ok, false);
    assert.equal((d as any).code, "feature_disabled");
  });
  it("flag ON ⇒ written when it is one of the category's §12 groups, refused otherwise", async () => {
    assert.deepEqual(await decidePerspectiveVantageWrite(flagClient(true), "entrance", "nightlife"), { ok: true, write: "entrance" });
    const bad = await decidePerspectiveVantageWrite(flagClient(true), "sunset", "nightlife");
    assert.equal(bad.ok, false);
    assert.equal((bad as any).code, "invalid_payload");
  });
});

function writeClient(on: boolean) {
  const state: FakeState = { users: { "author-tok": { id: "author-1" } }, trips: new Set(), members: [], posts: [] };
  const base = makeFakeClient(state);
  const from = base.from;
  base.from = (table: string) => (table === "feature_flags" ? (flagClient(on) as any).from() : from(table));
  return base;
}

async function servePosts(client: any) {
  _setTestClient(client, true);
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => { req.log = { error() {}, info() {}, warn() {} }; next(); });
  app.use("/api", postsRouter);
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return { base: `http://127.0.0.1:${port}`, close: () => { server.closeAllConnections(); server.close(); } };
}

async function create(base: string, body: Record<string, unknown>) {
  const res = await fetch(`${base}/api/posts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: BEARER("author-tok"), connection: "close" },
    body: JSON.stringify({ content: "the queue at nine", visibility: "public", category: "nightlife", ...body }),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

afterEach(() => { _clearTestClient(); });

describe("B. POST /posts", () => {
  it("no vantage, flag OFF: the insert carries no perspective_vantage key at all", async () => {
    const client = writeClient(false);
    const s = await servePosts(client);
    try {
      const r = await create(s.base, {});
      assert.equal(r.status, 201);
      const row = client.__inserted.find((i: any) => i.table === "posts").row;
      assert.equal(row.perspective_vantage, undefined);
      assert.equal(JSON.stringify(row).includes("perspective_vantage"), false, "supabase-js serialises no key for it");
    } finally { s.close(); }
  });

  it("a vantage, flag OFF: refused (feature_disabled) and nothing inserted", async () => {
    const client = writeClient(false);
    const s = await servePosts(client);
    try {
      const r = await create(s.base, { perspectiveVantage: "entrance" });
      assert.equal(r.status, 404);
      assert.equal(r.body.error, "feature_disabled");
      assert.equal(client.__inserted.filter((i: any) => i.table === "posts").length, 0);
    } finally { s.close(); }
  });

  it("flag ON: a Nightclub group on a nightlife post is written; a Beach group is refused", async () => {
    const ok = writeClient(true);
    let s = await servePosts(ok);
    try {
      const r = await create(s.base, { perspectiveVantage: "queue" });
      assert.equal(r.status, 201);
      assert.equal(ok.__inserted.find((i: any) => i.table === "posts").row.perspective_vantage, "queue");
    } finally { s.close(); }
    const bad = writeClient(true);
    s = await servePosts(bad);
    try {
      const r = await create(s.base, { perspectiveVantage: "sunset" });
      assert.equal(r.status, 400);
      assert.equal(bad.__inserted.filter((i: any) => i.table === "posts").length, 0);
    } finally { s.close(); }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C / D. The read, and the privacy of it
// ─────────────────────────────────────────────────────────────────────────────

const VIEWER = "11111111-1111-1111-1111-111111111111";
const AUTHOR = "22222222-2222-2222-2222-222222222222";
const PLACE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

type Dataset = Record<string, any[]>;
function projectionClient(data: Dataset, log: string[]) {
  const builder = (table: string): any => {
    const filters: any[] = [];
    let selected = "";
    const rows = () => {
      let r = (data[table] ?? []).map((x) => ({ ...x }));
      for (const f of filters) {
        if (f.op === "eq") r = r.filter((x) => String(x[f.col]) === String(f.val));
        else if (f.op === "in") r = r.filter((x) => (f.val as any[]).map(String).includes(String(x[f.col])));
      }
      return r;
    };
    const b: any = {
      select(s?: string) { selected = s ?? ""; log.push(`${table}:${selected}`); return b; },
      eq(col: string, val: any) { filters.push({ op: "eq", col, val }); return b; },
      in(col: string, val: any) { filters.push({ op: "in", col, val }); return b; },
      neq() { return b; }, ilike() { return b; }, gt() { return b; }, gte() { return b; }, lt() { return b; },
      not() { return b; }, or() { return b; }, order() { return b; }, limit() { return b; }, range() { return b; }, is() { return b; },
      upsert() { return Promise.resolve({ data: null, error: null }); },
      insert() { return Promise.resolve({ data: null, error: null }); },
      maybeSingle() { return Promise.resolve({ data: rows()[0] ?? null, error: null }); },
      single() { return Promise.resolve({ data: rows()[0] ?? null, error: null }); },
      then(onF: any, onR: any) { return Promise.resolve({ data: rows(), error: null }).then(onF, onR); },
    };
    return b;
  };
  return { from: (t: string) => builder(t), rpc: () => Promise.resolve({ data: null, error: null }) } as any;
}

function post(id: string, vantage: string | null, o: Record<string, any> = {}) {
  const author = o.author_id ?? AUTHOR;
  return {
    id, author_id: author, trip_id: null, content: "", visibility: "public", status: "active", post_status: "published",
    created_at: new Date(Date.now() - 5 * 60_000).toISOString(), category: "nightlife", media_urls: [],
    location_name: "An Thuong Bar", location_city: "Da Nang", location_country: "Vietnam",
    location_privacy_mode: o.location_privacy_mode ?? "none", canonical_place_id: PLACE, perspective_vantage: vantage,
    post_media: [{ id: `${id}-m`, media_type: "image", public_url: `https://cdn.example/${id}.jpg`, thumbnail_url: null, duration_seconds: null, width: 1, height: 1, sort_order: 0, processing_status: "ready", moderation_status: null }],
    profiles: { id: author, username: "u", full_name: "U", name: "U", display_name: "U", avatar_url: null, verified: false, is_official: false, account_status: "active", is_private: false },
  };
}

function dataset(posts: any[], flagOn: boolean): Dataset {
  return {
    posts,
    profiles: [{ id: VIEWER, location_country: "VN", date_of_birth: "1990-01-01", account_status: "active" }],
    places: [{ id: PLACE, name: "An Thuong Bar", city: "Da Nang", country_code: "VN", neighborhood: "An Thuong" }],
    blocks: [], user_mutes: [], user_follows: [], trip_members: [], trips: [], hidden_gems: [], post_hides: [],
    feature_flags: flagOn ? [{ flag: PERSPECTIVE_VANTAGE_FLAG, enabled: true }] : [],
    intel_state_snapshots: [], intel_live_promoted_scopes: [],
  };
}

const P1 = "10000000-0000-4000-a000-000000000001";
const P2 = "10000000-0000-4000-a000-000000000002";
const P3 = "10000000-0000-4000-a000-000000000003";

describe("C. the place page groups by the declared vantage — only with the flag", () => {
  it("flag OFF: no query names perspective_vantage, and the groups are the category buckets as before", async () => {
    const log: string[] = [];
    const sc = projectionClient(dataset([post(P1, "entrance"), post(P2, "queue"), post(P3, null)], false), log);
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: false });
    const p = await buildPlaceProjection(sc, viewer, PLACE, Date.now());
    assert.equal(log.some((l) => l.includes("perspective_vantage")), false);
    assert.deepEqual(p.perspectives.groups.map((g) => g.key), ["nightlife"]);
    assert.equal(p.perspectives.groups.flatMap((g) => g.media).some((m) => "vantage" in m), false);
  });

  it("flag ON: Entrance, Queue and Main Room are groups under §12's labels; an undeclared item stays in its category", async () => {
    const log: string[] = [];
    const P4 = "10000000-0000-4000-a000-000000000004";
    const sc = projectionClient(dataset([post(P1, "entrance"), post(P2, "queue"), post(P3, null), post(P4, "main_room")], true), log);
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: false });
    const p = await buildPlaceProjection(sc, viewer, PLACE, Date.now());
    const byKey = new Map(p.perspectives.groups.map((g) => [g.key, g.label]));
    assert.equal(byKey.get("entrance"), "Entrance");
    assert.equal(byKey.get("queue"), "Queue");
    assert.equal(byKey.get("main_room"), "Main Room", "the spec's label, not a capitalised key");
    assert.equal(byKey.get("nightlife"), "Nightlife");
    assert.equal(p.perspectives.totalPerspectives, 4);
  });
});

describe("D. a vantage rides the place", () => {
  it("the owner withheld the place (city_only): a non-owner gets no vantage; the owner gets theirs", async () => {
    const rows = [post(P1, "vip", { location_privacy_mode: "city_only" })];
    const sc = projectionClient(dataset(rows, true), []);
    const stranger = await resolveViewer(sc, VIEWER, { needFollows: false });
    const seen = await projectCandidatesProtected(sc, stranger, rows as any, Date.now());
    assert.equal(seen.length, 1, "the item is still served at its own tier");
    assert.equal(seen[0]!.placeId, null);
    assert.equal("vantage" in seen[0]!, false, "no sub-place detail about a place the viewer may not learn");
    const ownerRows = [post(P1, "vip", { location_privacy_mode: "city_only", author_id: VIEWER })];
    const osc = projectionClient(dataset(ownerRows, true), []);
    const owner = await resolveViewer(osc, VIEWER, { needFollows: false });
    const mine = await projectCandidatesProtected(osc, owner, ownerRows as any, Date.now());
    assert.equal(mine[0]!.vantage, "vip");
  });

  it("an open post's vantage is served with its place", async () => {
    const rows = [post(P1, "stage")];
    const sc = projectionClient(dataset(rows, true), []);
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: false });
    const seen = await projectCandidatesProtected(sc, viewer, rows as any, Date.now());
    assert.equal(seen[0]!.placeId, PLACE);
    assert.equal(seen[0]!.vantage, "stage");
  });

  it("the World FOR YOU NOW buckets stay category-only", () => {
    const m = (id: string, vantage?: string) => ({ id, category: "nightlife", capturedAt: new Date().toISOString(), placeId: PLACE, ...(vantage ? { vantage } : {}) }) as any;
    assert.deepEqual(buildCategoryBuckets([m("a", "entrance"), m("b", "queue"), m("c")], Date.now()).map((b) => b.category), ["nightlife"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E. Migration 3352
// ─────────────────────────────────────────────────────────────────────────────

describe("E. migration 3352 and its rollback", () => {
  const sql = readFileSync(join(HERE, "..", "migrations", "3352_media_perspective_vantage.sql"), "utf8");
  const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  it("seeds the flag FALSE and refuses a seed that finds it ON", () => {
    assert.match(code, /'media_perspective_vantage_enabled',\s*false,/);
    assert.match(code, /enabled = TRUE;\s*IF on_count <> 0 THEN\s*RAISE EXCEPTION/);
  });
  it("adds only a NULLABLE column with no default, and backfills nothing", () => {
    assert.match(code, /ADD COLUMN IF NOT EXISTS perspective_vantage text NULL;/);
    assert.ok(!/DEFAULT/i.test(code.replace(/ON CONFLICT[\s\S]*?DO NOTHING/g, "")), "no default");
    assert.ok(!/UPDATE\s+public\.posts/i.test(code), "no backfill");
  });
  it("the rollback refuses while the flag is on or any post carries a vantage", () => {
    const rb = readFileSync(join(REPO, "db", "rollback", "2026-09-27-3352-media-perspective-vantage-rollback.sql"), "utf8");
    assert.match(rb, /ROLLBACK REFUSED: media_perspective_vantage_enabled is TRUE/);
    assert.match(rb, /carry a contributor-declared perspective_vantage/);
  });
});
