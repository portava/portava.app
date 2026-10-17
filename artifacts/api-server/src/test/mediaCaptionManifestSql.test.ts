import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { CaptionAsset } from "../services/media/AuthoredCaptionsService.js";

test("offline real Postgres caption manifest CAS, full generation snapshot, deletion and role denial", { skip: !process.env.CAPTION_PGLITE_MODULE }, async () => {
  const { PGlite } = await import(process.env.CAPTION_PGLITE_MODULE!);
  const database = new PGlite();
  const asset: CaptionAsset = {
    id: "20000000-0000-4000-a000-000000000001", owner_user_id: "10000000-0000-4000-a000-000000000001",
    storage_bucket: "post-media", storage_path: "owner/video.mp4", media_type: "video", duration_ms: 2000,
    version: 5, deleted_at: null, purge_status: "not_requested", processing_status: "ready", moderation_status: "approved",
  };
  try {
    await database.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE public.media_assets(id uuid PRIMARY KEY, owner_user_id uuid NOT NULL, storage_bucket text NOT NULL,
      storage_path text NOT NULL, media_type text NOT NULL, duration_ms integer, version integer NOT NULL,
      deleted_at timestamptz, purge_status text NOT NULL, processing_status text NOT NULL, moderation_status text NOT NULL, size_bytes bigint DEFAULT 1024);
      CREATE TABLE public.feature_flags(flag text PRIMARY KEY, enabled boolean, description text);
      GRANT SELECT ON public.feature_flags TO service_role;
      GRANT SELECT, UPDATE ON public.media_assets TO service_role;`);
    await database.query("INSERT INTO public.media_assets SELECT * FROM jsonb_populate_record(NULL::public.media_assets, $1::jsonb)", [JSON.stringify(asset)]);
    await database.exec(await readFile(process.env.CAPTION_QUEUE_MIGRATION ?? new URL("../migrations/3980_media_derivative_jobs.sql", import.meta.url), "utf8"));
    await database.exec(await readFile(new URL("../migrations/3983_media_caption_manifest.sql", import.meta.url), "utf8"));
    const revision = (letter: string) => letter.repeat(64);
    const path = (letter: string) => `manual-captions/${asset.id}/v5-${revision(letter)}.json`;
    const commit = async (before: string, after: string, objectPath: string | null, snapshot = asset, ownerId = asset.owner_user_id) => (await database.query("SELECT public.cas_media_caption_manifest($1, $2, $3::jsonb, $4, $5, $6) AS written", [asset.id, ownerId, JSON.stringify(snapshot), revision(before), revision(after), objectPath])).rows[0].written;
    await database.exec("SET ROLE service_role");
    assert.equal(await commit("0", "a", path("a")), true);
    assert.equal(await commit("0", "b", path("b")), false);
    assert.equal(await commit("a", "b", path("b"), { ...asset, storage_path: "other.mp4" }), false);
    assert.equal(await commit("a", "b", path("b"), { ...asset, duration_ms: 1000 }), false);
    assert.equal(await commit("a", "b", path("b"), { ...asset, version: 4 }), false);
    assert.equal(await commit("a", "b", path("b"), asset, "10000000-0000-4000-a000-000000000099"), false);
    assert.equal(await commit("a", "b", null), true);
    assert.equal(await commit("a", "c", path("c")), false);
    const rows = (await database.query("SELECT * FROM public.media_caption_manifests")).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].object_path, null);
    assert.equal(rows[0].revision_key, revision("b"));
    assert.equal((await database.query("SELECT version FROM public.media_assets")).rows[0].version, 5);
    await database.exec("RESET ROLE; UPDATE public.media_assets SET deleted_at = '2026-10-15T12:00:00Z'; SET ROLE service_role");
    const deleted: CaptionAsset = { ...asset, deleted_at: "2026-10-15T12:00:00Z" };
    assert.equal(await commit("b", "c", path("c"), deleted), false);
    assert.equal(await commit("b", "c", null, deleted), true);
    for (const role of ["anon", "authenticated"]) {
      await database.exec(`RESET ROLE; SET ROLE ${role}`);
      await assert.rejects(database.query("SELECT * FROM public.media_caption_manifests"), /permission denied/);
      await assert.rejects(commit("c", "d", null, deleted), /permission denied/);
    }
    await database.exec("RESET ROLE");
    assert.equal((await database.query("SELECT relrowsecurity FROM pg_class WHERE oid = 'public.media_caption_manifests'::regclass")).rows[0].relrowsecurity, true);
    assert.equal((await database.query("SELECT prosecdef FROM pg_proc WHERE oid = 'public.cas_media_caption_manifest(uuid,uuid,jsonb,text,text,text,uuid)'::regprocedure")).rows[0].prosecdef, false);
  } finally { await database.close(); }
});
