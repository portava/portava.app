/**
 * memoryMediaRenditions.db.test.ts — the EXECUTING witness for 3808
 * (`media_asset_renditions`, §20's original / viewer / card / tiny ladder) on the
 * full chain scripts/local-db/up.sh replays: production's 2026-08-19 baseline
 * structure plus every migration, with every media_assets constraint and trigger
 * the chain installs in place. Census-highlights-memories H182; B58 cluster
 * MEM-RENDITIONS.
 *
 * The route suite (src/test/memoryMediaRenditions.test.ts) drives the API over a
 * fake; this file proves the SQL does what that fake assumes, as the API's
 * service role writes it, with the service code itself issuing the queries.
 *
 *   D1  the CHECKs: a sound ladder is accepted; a tiny over 64 px, a card over
 *       400, an image viewer over 1500, an unknown rung or mime, half a size, a
 *       client-writable prefix, a traversal and an absolute path are refused
 *   D2  RLS and the revokes: no client role reads or writes; service_role
 *       reads, registers and purges, and cannot rewrite a registered rung
 *   D3  the service code registers four distinct rungs over the real SQL, as
 *       service_role; a second registration writes nothing (ON CONFLICT DO
 *       NOTHING, for real); the read path finds them through the confirmed asset
 *   D4  erasure: deleting the asset (AccountDeletionService delete_media_assets)
 *       and deleting the account both take every row
 *   D5  §21: after the Memory's soft delete the service purge leaves ZERO rows
 *       and removes the tiny; while a live Memory item still shows the object,
 *       nothing is purged
 *   D6  the rollback refuses while the table is the only record of objects the
 *       Memory service wrote, drops everything when told to, and 3808 re-applied
 *       is today's catalog (inside BEGIN … ROLLBACK)
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { HAVE_DB, deleteUser, exec, psql, rows, scalar, seedUser } from "./localDb.js";
import { lit, makeSqlClient, wrapForJson } from "./sqlPostgrestAdapter.js";
import {
  purgeRenditionsForMediaUrls,
  readRenditionsForItems,
  registerMemoryItemRenditions,
} from "../../services/memory/memoryMediaRenditions.js";
import { makeFeedVariant, makeThumbnail } from "../../lib/mediaProcessing.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = resolve(__dir, "../../migrations/3808_media_asset_renditions.sql");
const ROLLBACK = resolve(__dir, "../../../../../db/rollback/2026-10-14-3808-media-asset-renditions-rollback.sql");
const BUCKET = "post-media";
const TAG = `mar${randomUUID().slice(0, 8)}`;
let owner = "";

const asService = (sql: string) => exec(`SET LOCAL ROLE service_role;\n${sql}`, { single: true });
const asRole = (role: string, sql: string) => psql(`SET LOCAL ROLE ${role};\n${sql}`, { single: true });

/** The supabase surface the service code uses, over SQL AS service_role (the API's role). */
const runAsService = async (sql: string) => {
  const r = psql(`\\set VERBOSITY verbose\nSET LOCAL ROLE service_role;\n${wrapForJson(sql)};`, { single: true });
  if (r.status !== 0) {
    const m = /ERROR:\s+([0-9A-Z]{5}):\s*(.*)/.exec(r.stderr);
    throw { code: m?.[1], message: m?.[2] ?? r.stderr.trim() };
  }
  return JSON.parse(r.stdout.trim() || "[]");
};
const base = makeSqlClient(runAsService);

/**
 * The adapter models no `upsert`; the registration's one write is
 * `upsert(rows, { onConflict, ignoreDuplicates: true })`, which PostgREST sends
 * as INSERT … ON CONFLICT (…) DO NOTHING. That statement, verbatim, for real.
 */
function serviceClient(storage: FakeStorage) {
  return {
    ...base,
    storage,
    from(table: string) {
      const b = base.from(table);
      return new Proxy({}, {
        get(_t, p) {
          if (p !== "upsert") return (b as any)[p];
          return (payload: any, o: { onConflict?: string; ignoreDuplicates?: boolean }) => {
            assert.equal(o?.ignoreDuplicates, true, "the only upsert the service sends is DO NOTHING");
            const rowsIn = Array.isArray(payload) ? payload : [payload];
            const keys = [...new Set(rowsIn.flatMap((r: any) => Object.keys(r)))];
            const sql = `INSERT INTO public."${table}" (${keys.map((k) => `"${k}"`).join(", ")}) VALUES ${rowsIn.map((r: any) => `(${keys.map((k) => lit(r[k])).join(", ")})`).join(", ")} ON CONFLICT (${String(o.onConflict).split(",").map((c) => `"${c.trim()}"`).join(", ")}) DO NOTHING RETURNING *`;
            const done = runAsService(sql).then((data) => ({ data, error: null }), (e) => ({ data: null, error: e }));
            return { then: (ok: any, bad: any) => done.then(ok, bad) };
          };
        },
      });
    },
  };
}

class FakeStorage {
  objects = new Map<string, Buffer>();
  from(bucket: string) {
    const k = (p: string) => `${bucket}/${p}`;
    return {
      list: async (folder: string, o?: { search?: string }) => ({
        data: [...this.objects.keys()].filter((x) => x.startsWith(`${bucket}/${folder}/`)).map((x) => x.slice(`${bucket}/${folder}/`.length)).filter((n) => !n.includes("/") && (!o?.search || n.includes(o.search))).map((name) => ({ name })),
        error: null,
      }),
      download: async (p: string) => (this.objects.has(k(p)) ? { data: new Blob([this.objects.get(k(p))!]), error: null } : { data: null, error: { message: "Object not found", statusCode: "404" } }),
      upload: async (p: string, body: Buffer, o: { upsert: boolean }) => {
        if (!o.upsert && this.objects.has(k(p))) return { error: { message: "The resource already exists", statusCode: "409" } };
        this.objects.set(k(p), Buffer.from(body));
        return { error: null };
      },
      remove: async (ps: string[]) => ({ data: ps.filter((p) => this.objects.delete(k(p))).map((name) => ({ name })), error: null }),
    };
  }
}

/** An asset as /media/upload leaves it: the canonical row, the original and its two variants. */
async function uploadedImage(storage: FakeStorage): Promise<{ assetId: string; path: string; stem: string; url: string }> {
  const ts = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const stem = `${owner}/${ts}`;
  const path = `${stem}.jpg`;
  const original = await sharp({ create: { width: 1800, height: 1200, channels: 3, background: "#468" } }).jpeg({ quality: 82 }).toBuffer();
  storage.objects.set(`${BUCKET}/${path}`, original);
  storage.objects.set(`${BUCKET}/${stem}.feed.jpg`, (await makeFeedVariant(original)).buffer);
  storage.objects.set(`${BUCKET}/${stem}.thumb.jpg`, (await makeThumbnail(original)).buffer);
  const assetId = randomUUID();
  asService(`INSERT INTO public.media_assets (id, owner_user_id, uploader_user_id, storage_bucket, storage_path, media_type, mime_type, size_bytes, width, height, processing_status)
             VALUES ('${assetId}', '${owner}', '${owner}', '${BUCKET}', '${path}', 'image', 'image/jpeg', ${original.length}, 1800, 1200, 'ready');`);
  return { assetId, path, stem, url: `${BUCKET}/${path}` };
}
const rungs = (assetId: string) => scalar(`SELECT coalesce(string_agg(rendition || '=' || storage_path, ',' ORDER BY rendition), '') FROM public.media_asset_renditions WHERE asset_id = '${assetId}'`) ?? "";
const count = (assetId: string) => Number(scalar(`SELECT count(*) FROM public.media_asset_renditions WHERE asset_id = '${assetId}'`));

describe("3808 on the full chain: media_asset_renditions", { skip: !HAVE_DB }, () => {
  before(() => { owner = seedUser(TAG); });
  after(() => { if (owner) deleteUser(owner); });

  test("D1 the CHECKs hold every rung to its size, mime and path", async () => {
    const storage = new FakeStorage();
    const a = await uploadedImage(storage);
    const ins = (rendition: string, path: string, w: number | null, h: number | null, mime = "image/jpeg") =>
      psql(`INSERT INTO public.media_asset_renditions (asset_id, rendition, storage_path, width, height, mime) VALUES ('${a.assetId}', '${rendition}', '${path}', ${w ?? "NULL"}, ${h ?? "NULL"}, '${mime}');`, { single: true });
    const refused = (r: ReturnType<typeof psql>, constraint: string, why: string) => {
      assert.notEqual(r.status, 0, why);
      assert.match(r.stderr, new RegExp(constraint), `${why}: ${r.stderr}`);
    };
    refused(ins("tiny", `${a.stem}.tiny.jpg`, 65, 40), "media_asset_renditions_ladder_check", "a 65 px tiny");
    refused(ins("tiny", `${a.stem}.tiny.jpg`, null, null), "media_asset_renditions_ladder_check", "a tiny with no size");
    refused(ins("tiny", `${a.stem}.tiny.png`, 64, 40, "image/png"), "media_asset_renditions_ladder_check", "a PNG tiny");
    refused(ins("card", `${a.stem}.thumb.jpg`, 401, 300), "media_asset_renditions_ladder_check", "a 401 px card");
    refused(ins("viewer", `${a.stem}.feed.jpg`, 1501, 1000), "media_asset_renditions_ladder_check", "a 1501 px image viewer");
    refused(ins("original", a.path, null, null), "media_asset_renditions_ladder_check", "an image original with no size");
    refused(ins("thumbnail", `${a.stem}.thumb.jpg`, 400, 267), "media_asset_renditions_(rendition|ladder)_check", "an unknown rung (the ladder's ELSE refuses it too; Postgres reports the first by name)");
    assert.equal(scalar(`SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'media_asset_renditions_rendition_check'`), "CHECK ((rendition = ANY (ARRAY['original'::text, 'viewer'::text, 'card'::text, 'tiny'::text])))");
    refused(ins("original", a.path, 10, 10, "image/gif"), "media_asset_renditions_mime_check", "an unknown mime");
    refused(ins("original", a.path, 10, null), "media_asset_renditions_dims_check", "half a size");
    refused(ins("original", `memories/${owner}/x.jpg`, 10, 10), "media_asset_renditions_path_check", "a client-writable prefix");
    refused(ins("original", `stories/${owner}/x.jpg`, 10, 10), "media_asset_renditions_path_check", "a client-writable prefix");
    refused(ins("original", `${owner}/../x.jpg`, 10, 10), "media_asset_renditions_path_check", "a traversal");
    refused(ins("original", `/${owner}/x.jpg`, 10, 10), "media_asset_renditions_path_check", "an absolute path");
    assert.equal(count(a.assetId), 0);
    exec(`INSERT INTO public.media_asset_renditions (asset_id, rendition, storage_path, width, height, mime) VALUES
            ('${a.assetId}', 'original', '${a.path}', 1800, 1200, 'image/jpeg'),
            ('${a.assetId}', 'viewer', '${a.stem}.feed.jpg', 1500, 1000, 'image/jpeg'),
            ('${a.assetId}', 'card', '${a.stem}.thumb.jpg', 400, 267, 'image/jpeg'),
            ('${a.assetId}', 'tiny', '${a.stem}.tiny.jpg', 64, 43, 'image/jpeg');`);
    assert.equal(count(a.assetId), 4, "a sound ladder is accepted");
    const vid = randomUUID();
    asService(`INSERT INTO public.media_assets (id, owner_user_id, uploader_user_id, storage_bucket, storage_path, media_type, mime_type, processing_status) VALUES ('${vid}', '${owner}', '${owner}', '${BUCKET}', '${owner}/v${Date.now()}.mp4', 'video', 'video/mp4', 'processing');`);
    exec(`INSERT INTO public.media_asset_renditions (asset_id, rendition, storage_path, width, height, mime) VALUES ('${vid}', 'original', '${owner}/v.mp4', NULL, NULL, 'video/mp4'), ('${vid}', 'viewer', '${owner}/v.mp4', NULL, NULL, 'video/mp4');`);
    assert.equal(count(vid), 2, "a video's viewer may be its original, with no measured size");
  });

  test("D2 no client role reads or writes; service_role registers, reads and purges, and never rewrites", async () => {
    const storage = new FakeStorage();
    const a = await uploadedImage(storage);
    for (const role of ["anon", "authenticated"]) {
      for (const sql of [
        `SELECT count(*) FROM public.media_asset_renditions;`,
        `INSERT INTO public.media_asset_renditions (asset_id, rendition, storage_path, width, height, mime) VALUES ('${a.assetId}', 'original', '${a.path}', 1800, 1200, 'image/jpeg');`,
        `DELETE FROM public.media_asset_renditions;`,
      ]) {
        const r = asRole(role, sql);
        assert.notEqual(r.status, 0, `${role}: ${sql}`);
        assert.match(r.stderr, /permission denied/, `${role}: ${r.stderr}`);
      }
    }
    asService(`INSERT INTO public.media_asset_renditions (asset_id, rendition, storage_path, width, height, mime) VALUES ('${a.assetId}', 'original', '${a.path}', 1800, 1200, 'image/jpeg');`);
    assert.equal(scalar(`SET LOCAL ROLE service_role; SELECT count(*) FROM public.media_asset_renditions WHERE asset_id = '${a.assetId}';`), "1");
    const upd = asRole("service_role", `UPDATE public.media_asset_renditions SET storage_path = '${a.stem}.other.jpg' WHERE asset_id = '${a.assetId}';`);
    assert.notEqual(upd.status, 0);
    assert.match(upd.stderr, /permission denied/);
    asService(`DELETE FROM public.media_asset_renditions WHERE asset_id = '${a.assetId}';`);
    assert.equal(count(a.assetId), 0);
    assert.equal(scalar(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.media_asset_renditions'::regclass`), "t");
    assert.equal(scalar(`SELECT count(*) FROM pg_policy WHERE polrelid = 'public.media_asset_renditions'::regclass`), "0");
  });

  test("D3 the service code registers four distinct rungs over the real SQL, idempotently, and reads them back", async () => {
    const storage = new FakeStorage();
    const a = await uploadedImage(storage);
    const sc = serviceClient(storage);
    const r = await registerMemoryItemRenditions(sc, { ownerId: owner, mediaUrl: a.url });
    assert.equal(r.state, "registered", JSON.stringify(r));
    assert.equal(rungs(a.assetId), `card=${a.stem}.thumb.jpg,original=${a.path},tiny=${a.stem}.tiny.jpg,viewer=${a.stem}.feed.jpg`);
    assert.equal(Number(scalar(`SELECT count(DISTINCT storage_path) FROM public.media_asset_renditions WHERE asset_id = '${a.assetId}'`)), 4);
    assert.equal(scalar(`SELECT greatest(width, height) <= 64 FROM public.media_asset_renditions WHERE asset_id = '${a.assetId}' AND rendition = 'tiny'`), "t");
    const before = scalar(`SELECT string_agg(created_at::text, ',' ORDER BY rendition) FROM public.media_asset_renditions WHERE asset_id = '${a.assetId}'`);
    const again = await registerMemoryItemRenditions(sc, { ownerId: owner, mediaUrl: a.url });
    assert.equal(again.state, "registered");
    assert.equal(scalar(`SELECT string_agg(created_at::text, ',' ORDER BY rendition) FROM public.media_asset_renditions WHERE asset_id = '${a.assetId}'`), before, "nothing rewritten");
    const look = await readRenditionsForItems(sc, [{ mediaUrl: a.url, ownerId: owner }]);
    assert.equal(look.state, "ok");
    assert.equal((look as any).byObject.get(a.url).rows.size, 4);
  });

  test("D4 deleting the asset, or the account, takes every row", async () => {
    const storage = new FakeStorage();
    const a = await uploadedImage(storage);
    await registerMemoryItemRenditions(serviceClient(storage), { ownerId: owner, mediaUrl: a.url });
    assert.equal(count(a.assetId), 4);
    asService(`DELETE FROM public.media_assets WHERE id = '${a.assetId}';`);
    assert.equal(count(a.assetId), 0, "delete_media_assets cascades the ladder");
    const departing = seedUser(`${TAG}d`);
    const saved = owner;
    try {
      owner = departing;
      const b = await uploadedImage(storage);
      await registerMemoryItemRenditions(serviceClient(storage), { ownerId: departing, mediaUrl: b.url });
      assert.equal(count(b.assetId), 4);
      deleteUser(departing);
      assert.equal(count(b.assetId), 0, "the account's final delete cascades media_assets and the ladder");
    } finally { owner = saved; }
  });

  test("D5 §21: the purge after the Memory's soft delete leaves zero rows; a live item keeps the ladder", async () => {
    const storage = new FakeStorage();
    const a = await uploadedImage(storage);
    const sc = serviceClient(storage);
    await registerMemoryItemRenditions(sc, { ownerId: owner, mediaUrl: a.url });
    const m1 = randomUUID(); const m2 = randomUUID();
    asService(`INSERT INTO public.memories (id, owner_id, title) VALUES ('${m1}', '${owner}', '${TAG}'), ('${m2}', '${owner}', '${TAG}');
               INSERT INTO public.memory_items (memory_id, media_url, media_type, position) VALUES ('${m1}', '${a.url}', 'image/jpeg', 0), ('${m2}', '${a.url}', 'image/jpeg', 0);`);
    asService(`UPDATE public.memories SET state = 'deleted' WHERE id = '${m1}';`);
    const kept = await purgeRenditionsForMediaUrls(sc, { ownerId: owner, mediaUrls: [a.url] });
    assert.deepEqual(kept, { state: "done", purgedAssets: 0, rowsDeleted: 0, objectsRemoved: 0, keptInUse: 1 });
    assert.equal(count(a.assetId), 4, "a live Memory item still shows the object");
    asService(`UPDATE public.memories SET state = 'deleted' WHERE id = '${m2}';`);
    const gone = await purgeRenditionsForMediaUrls(sc, { ownerId: owner, mediaUrls: [a.url] });
    assert.deepEqual(gone, { state: "done", purgedAssets: 1, rowsDeleted: 4, objectsRemoved: 1, keptInUse: 0 });
    assert.equal(count(a.assetId), 0);
    assert.equal(storage.objects.has(`${BUCKET}/${a.stem}.tiny.jpg`), false);
    assert.ok(storage.objects.has(`${BUCKET}/${a.path}`) && storage.objects.has(`${BUCKET}/${a.stem}.feed.jpg`));
  });

  test("D6 the rollback refuses while it is the only record of service-written objects, drops all of 3808 when told to, and 3808 re-applied is today's catalog", async () => {
    const unwrap = (path: string) => {
      const sql = readFileSync(path, "utf8");
      const begin = sql.search(/^BEGIN;\s*$/m);
      const commit = sql.lastIndexOf("\nCOMMIT;");
      return sql.slice(sql.indexOf("\n", begin) + 1, commit) + "\n" + sql.slice(commit + "\nCOMMIT;".length);
    };
    const storage = new FakeStorage();
    const a = await uploadedImage(storage);
    await registerMemoryItemRenditions(serviceClient(storage), { ownerId: owner, mediaUrl: a.url }); // a tiny is recorded only here
    const refused = psql(`BEGIN;\n${unwrap(ROLLBACK)}\nROLLBACK;`);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /ROLLBACK REFUSED \(3808\)/);
    const CATALOG = `SELECT json_build_object(
      'table', to_regclass('public.media_asset_renditions') IS NOT NULL,
      'index', to_regclass('public.media_asset_renditions_original_path_idx') IS NOT NULL,
      'checks', (SELECT array_agg(conname ORDER BY conname) FROM pg_constraint WHERE conrelid = to_regclass('public.media_asset_renditions')),
      'acl', (SELECT array_agg(x ORDER BY x) FROM (SELECT grantee::regrole::text || ':' || privilege_type AS x FROM pg_class c, LATERAL aclexplode(c.relacl) WHERE c.oid = to_regclass('public.media_asset_renditions') AND grantee <> c.relowner) q))::text;`;
    const out = exec(`BEGIN;\n${CATALOG}\nSET LOCAL portava.rollback_3808_orphan_objects = 'accept';\n${unwrap(ROLLBACK)}\n${CATALOG}\n${unwrap(MIGRATION)}\n${CATALOG}\nROLLBACK;`)
      .filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
    const [now, rolled, reapplied] = out;
    assert.deepEqual(now.acl, ["service_role:DELETE", "service_role:INSERT", "service_role:SELECT"]);
    assert.deepEqual(rolled, { table: false, index: false, checks: null, acl: null });
    assert.deepEqual(reapplied, now, "3808 after its rollback is the state 3808 left");
    assert.equal(count(a.assetId), 4, "the test left the table as it found it");
  });
});
