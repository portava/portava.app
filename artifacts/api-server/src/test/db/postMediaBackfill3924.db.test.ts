/**
 * postMediaBackfill3924.db.test.ts — migration 3924 on real PostgreSQL (video
 * playback, owner-reported 2026-10-24), and its rollback.
 *
 *   B1  e4bbf335's shape: a post whose only media is a .mov key in media_urls gets
 *       one post_media row — video, the object's recorded mime and size, its
 *       poster, ready, pending, the author's — and media_urls keeps only external
 *       references, in order; its summary columns follow its rows
 *   B2  an entry that already has a row is not duplicated, and a post with only
 *       external references is untouched
 *   B3  check:media-urls-external-only's predicate finds nothing afterwards
 *   B4  re-applied: nothing changes (idempotent)
 *   B5  P2: a key that is not the author's refuses the whole file, and nothing moves
 *   B6  P3: a key in post_media_moderation_ledger refuses the whole file
 *   B7  the rollback puts the uploads back and removes 3924's rows; a row a
 *       moderator decided, and every post with a rejected row, are left alone
 *
 * Run: bash scripts/local-db/up.sh && bash scripts/local-db/run-tests.sh
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HAVE_DB, exec, rows, scalar, seedUser, deleteUser, psql } from "./localDb.js";

const MIGRATION = readFileSync(new URL("../../migrations/3924_post_media_backfill_create_path_uploads.sql", import.meta.url), "utf8");
const ROLLBACK = readFileSync(new URL("../../../../../db/rollback/2026-10-24-3924-post-media-backfill-create-path-uploads-rollback.sql", import.meta.url), "utf8");

/** check:media-urls-external-only's VIOLATION predicate, verbatim. */
const VIOLATIONS = `SELECT count(*) FROM posts p, LATERAL unnest(COALESCE(p.media_urls, '{}')) u
   WHERE u ~ '^(post-media|profile-media)/' OR u ~ '/storage/v1/object/public/(post-media|profile-media)/'`;

const P = (n: number) => `e4bbf335-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("3924 — create-path uploads move from media_urls into post_media", { skip: !HAVE_DB }, () => {
  let a = "", b = "";
  const keys: string[] = [];

  function seedPost(id: string, author: string, urls: string[], mediaType: string | null, createdAgo = "1 day"): void {
    exec(`INSERT INTO public.posts (id, author_id, content, media_urls, media_type, visibility, status, created_at)
          VALUES ('${id}', '${author}', 'fixture', ARRAY[${urls.map((u) => `'${u}'`).join(",")}]::text[], ${mediaType ? `'${mediaType}'` : "NULL"}, 'public', 'active', now() - interval '${createdAgo}');`);
  }
  function object(name: string, mime: string, size: number): void {
    keys.push(name);
    exec(`INSERT INTO storage.objects (bucket_id, name, metadata) VALUES ('post-media', '${name}', '{"mimetype":"${mime}","size":${size}}'::jsonb);`);
  }
  function cleanup(): void {
    exec(`DELETE FROM public.post_media WHERE post_id IN ('${P(1)}','${P(2)}','${P(3)}','${P(4)}','${P(5)}');
          DELETE FROM public.posts WHERE id IN ('${P(1)}','${P(2)}','${P(3)}','${P(4)}','${P(5)}');`);
  }

  before(() => {
    a = seedUser("m3924a"); b = seedUser("m3924b");
    exec(`INSERT INTO storage.buckets (id, name) VALUES ('post-media', 'post-media') ON CONFLICT (id) DO NOTHING;`);
    // Leave no unrelated fixture in the way of P1-P3: the file reads every post.
    const before = Number(scalar(VIOLATIONS));
    assert.equal(before, 0, "the harness starts with no storage-backed media_urls entry");
    object(`${a}/1792727980484.mov`, "video/quicktime", 15815529);
    object(`${a}/1792727980484.mov.poster.jpg`, "image/jpeg", 40000);
    object(`${a}/2.jpg`, "image/jpeg", 119032);
  });

  after(() => {
    cleanup();
    exec(`SET storage.allow_delete_query = 'true'; DELETE FROM storage.objects WHERE bucket_id = 'post-media' AND name IN (${keys.map((k) => `'${k}'`).join(",")});
          DELETE FROM public.post_media_moderation_ledger WHERE storage_path LIKE '${a}/%' OR storage_path LIKE '${b}/%';`);
    deleteUser(a); deleteUser(b);
  });

  test("B1-B4 the move, the untouched cases, the check, and idempotence", () => {
    seedPost(P(1), a, [`post-media/${a}/1792727980484.mov`], "video/quicktime");                    // e4bbf335
    seedPost(P(2), a, ["https://images.example.com/x.jpg", `post-media/${a}/2.jpg`, "https://images.example.com/y.jpg", `post-media/${a}/5.mp4`], "image/jpeg");
    seedPost(P(3), a, ["https://images.example.com/only.jpg"], null);
    seedPost(P(4), a, [`post-media/${a}/both.jpg`], "image/jpeg");
    exec(`INSERT INTO public.post_media (post_id, user_id, media_type, storage_bucket, storage_path, public_url, mime_type, processing_status, moderation_status, sort_order)
          VALUES ('${P(4)}', '${a}', 'image', 'post-media', '${a}/both.jpg', 'post-media/${a}/both.jpg', 'image/jpeg', 'ready', 'approved', 0);`);
    assert.equal(Number(scalar(VIOLATIONS)), 4, "precondition: four storage-backed entries");

    exec(MIGRATION);

    const v = rows<Record<string, any>>(`SELECT * FROM public.post_media WHERE post_id = '${P(1)}'`);
    assert.equal(v.length, 1);
    assert.deepEqual(
      { t: v[0]!.media_type, b: v[0]!.storage_bucket, k: v[0]!.storage_path, u: v[0]!.public_url, m: v[0]!.mime_type, s: String(v[0]!.file_size_bytes), th: v[0]!.thumbnail_storage_path, tu: v[0]!.thumbnail_url, ps: v[0]!.processing_status, ms: v[0]!.moderation_status, o: Number(v[0]!.sort_order), who: v[0]!.user_id },
      { t: "video", b: "post-media", k: `${a}/1792727980484.mov`, u: `post-media/${a}/1792727980484.mov`, m: "video/quicktime", s: "15815529", th: `${a}/1792727980484.mov.poster.jpg`, tu: `post-media/${a}/1792727980484.mov.poster.jpg`, ps: "ready", ms: "pending", o: 0, who: a },
    );
    const p1 = rows<Record<string, any>>(`SELECT media_urls::text AS u, media_count, has_video, primary_media_type FROM public.posts WHERE id = '${P(1)}'`)[0]!;
    assert.deepEqual([p1.u, Number(p1.media_count), String(p1.has_video), p1.primary_media_type], ["{}", 1, "true", "video"]);

    const p2 = rows<Record<string, any>>(`SELECT media_urls::text AS u FROM public.posts WHERE id = '${P(2)}'`)[0]!;
    assert.equal(p2.u, "{https://images.example.com/x.jpg,https://images.example.com/y.jpg}", "external references keep their order");
    const img = rows<Record<string, any>>(`SELECT media_type, mime_type, thumbnail_storage_path, sort_order FROM public.post_media WHERE post_id = '${P(2)}' ORDER BY sort_order`);
    assert.deepEqual(img.map((r) => [r.media_type, r.mime_type, r.thumbnail_storage_path, Number(r.sort_order)]), [["image", "image/jpeg", null, 0], ["video", "video/mp4", null, 1]], "an image gets no poster, and neither does a video whose poster does not exist; the extension decides the kind over the post's image/jpeg");

    assert.equal(rows(`SELECT 1 FROM public.post_media WHERE post_id = '${P(4)}'`).length, 1, "B2: an entry that already had a row is not duplicated");
    assert.equal(scalar(`SELECT media_urls::text FROM public.posts WHERE id = '${P(3)}'`), "{https://images.example.com/only.jpg}", "B2: external-only is untouched");
    assert.equal(Number(scalar(VIOLATIONS)), 0, "B3: check:media-urls-external-only is green");

    const snapshot = scalar(`SELECT md5(string_agg(pm.id::text || pm.storage_path || pm.sort_order, ',' ORDER BY pm.id)) FROM public.post_media pm WHERE post_id IN ('${P(1)}','${P(2)}','${P(4)}')`);
    exec(MIGRATION);
    assert.equal(scalar(`SELECT md5(string_agg(pm.id::text || pm.storage_path || pm.sort_order, ',' ORDER BY pm.id)) FROM public.post_media pm WHERE post_id IN ('${P(1)}','${P(2)}','${P(4)}')`), snapshot, "B4: re-applied, nothing changes");
  });

  test("B7 the rollback restores the uploads and removes only 3924's rows", () => {
    // P(5): a decided row on a moved-shaped key must survive the rollback.
    seedPost(P(5), a, [], "image/jpeg");
    exec(`INSERT INTO public.post_media (post_id, user_id, media_type, storage_bucket, storage_path, public_url, mime_type, processing_status, moderation_status, sort_order)
          VALUES ('${P(5)}', '${a}', 'image', 'post-media', '${a}/decided.jpg', 'post-media/${a}/decided.jpg', 'image/jpeg', 'ready', 'approved', 0);`);
    // P(3): a 3924-shaped pending row on a post that ALSO carries a rejected row — the rollback must not move it back.
    exec(`INSERT INTO public.post_media (post_id, user_id, media_type, storage_bucket, storage_path, public_url, mime_type, processing_status, moderation_status, sort_order)
          VALUES ('${P(3)}', '${a}', 'image', 'post-media', '${a}/3.jpg', 'post-media/${a}/3.jpg', 'image/jpeg', 'ready', 'pending', 0),
                 ('${P(3)}', '${a}', 'image', 'post-media', '${a}/4.jpg', 'post-media/${a}/4.jpg', 'image/jpeg', 'ready', 'rejected', 1);`);
    exec(ROLLBACK);
    assert.equal(rows(`SELECT 1 FROM public.post_media WHERE post_id = '${P(3)}'`).length, 2, "a post with a rejected row is left alone");
    assert.equal(scalar(`SELECT media_urls::text FROM public.posts WHERE id = '${P(3)}'`), "{https://images.example.com/only.jpg}", "nothing moderated goes back into the array");
    assert.equal(scalar(`SELECT media_urls::text FROM public.posts WHERE id = '${P(1)}'`), `{post-media/${a}/1792727980484.mov}`);
    assert.equal(rows(`SELECT 1 FROM public.post_media WHERE post_id = '${P(1)}'`).length, 0);
    const p1 = rows<Record<string, any>>(`SELECT media_count, has_video, primary_media_type FROM public.posts WHERE id = '${P(1)}'`)[0]!;
    assert.deepEqual([Number(p1.media_count), String(p1.has_video), p1.primary_media_type], [0, "false", null]);
    assert.equal(scalar(`SELECT media_urls::text FROM public.posts WHERE id = '${P(2)}'`), `{post-media/${a}/2.jpg,post-media/${a}/5.mp4,https://images.example.com/x.jpg,https://images.example.com/y.jpg}`);
    assert.equal(rows(`SELECT 1 FROM public.post_media WHERE post_id = '${P(4)}'`).length, 1, "the pre-existing approved row stays");
    assert.equal(rows(`SELECT 1 FROM public.post_media WHERE post_id = '${P(5)}'`).length, 1, "a decided row stays");
    // and forward again, for the precondition cases below
    exec(MIGRATION);
    assert.equal(Number(scalar(VIOLATIONS)), 0);
    cleanup();
  });

  test("B5 P2: a key that is not the author's refuses the whole file", () => {
    seedPost(P(1), a, [`post-media/${a}/1792727980484.mov`], "video/quicktime");
    seedPost(P(2), b, [`post-media/${a}/2.jpg`], "image/jpeg");   // b's post naming a's object
    const r = psql(MIGRATION);
    assert.notEqual(r.status, 0, "the file refuses");
    assert.match(r.stderr, /PRECONDITION P2 FAILED: 1 post-media key/);
    assert.equal(rows(`SELECT 1 FROM public.post_media WHERE post_id IN ('${P(1)}','${P(2)}')`).length, 0, "nothing moved, not even the owned entry");
    assert.equal(Number(scalar(VIOLATIONS)), 2);
    cleanup();
  });

  test("B6 P3: a moderated key refuses the whole file", () => {
    seedPost(P(1), a, [`post-media/${a}/1792727980484.mov`], "video/quicktime");
    exec(`INSERT INTO public.post_media_moderation_ledger (storage_path, storage_bucket, key_role, verdict, subject_user_id)
          VALUES ('${a}/1792727980484.mov', 'post-media', 'original', 'rejected', '${a}') ON CONFLICT (storage_path) DO NOTHING;`);
    const r = psql(MIGRATION);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /PRECONDITION P3 FAILED: 1 key/);
    assert.equal(rows(`SELECT 1 FROM public.post_media WHERE post_id = '${P(1)}'`).length, 0);
    exec(`DELETE FROM public.post_media_moderation_ledger WHERE storage_path = '${a}/1792727980484.mov';`);
    cleanup();
  });
});
