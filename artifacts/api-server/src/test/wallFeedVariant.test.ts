/**
 * The Wall carries the stored feed variant (Wall spec §33 "Images: responsive
 * variants + CDN/cache"; census-wall W151).
 *
 * /media/upload stores up to three objects per post_media image:
 *   - the original;
 *   - a ≤400 px thumbnail;
 *   - (migration 0208) a ≤FEED_DIM (1500 px) feed variant, built for exactly
 *     the Wall's full-width frames.
 * Both of the Wall's image lanes read the first two and never the third, so
 * the projection could not name it and the client drew the thumbnail at every
 * size.
 *
 * ── THE CLAIMS ───────────────────────────────────────────────────────────────
 *   1. The postcard lane's post_media read SELECTS `feed_url` as a statically
 *      resolvable literal (check:write-path-columns and check:schema-references
 *      audit only literals), and 0208 declares the column.
 *   2. The postcard lane projects a ready image row's `feed_url` as
 *      `DisplayMedia.feedUrl`, trimmed. NULL, blank or absent projects null:
 *      that is the migration's contract, where null means "none stored — use
 *      another variant", never an inference.
 *   3. A video row projects no feed variant; its still is the poster.
 *   4. The media lane carries it through Media v2's own embed:
 *      - MEDIA_PROJECTION_POST_MEDIA_COLUMNS selects `feed_url`;
 *      - toMediaProjection carries it as `feedUrl` for post_media images;
 *      - loadVideoMediaCandidates maps it to DisplayMedia;
 *      - there is no extra read.
 *   5. A Media v2 projection WITHOUT a stored feed variant is byte-identical to
 *      before: the key is absent, not null. So the embed change adds a field
 *      only where one is stored.
 *      NOT exercised here: a canonical `media_assets` original. The canonical
 *      read is flag-gated, and the canonical branch builds its ResolvedMedia
 *      without the field; see lib/media/mediaProjection.ts.
 *
 * The fake below PROJECTS rows to the columns the caller selected, the way
 * PostgREST does. That covers a flat post_media read and Media v2's
 * `post_media(...)` embed. A select that drops `feed_url` therefore loses the
 * value instead of being handed it by a permissive fake.
 *
 * WATCHED IT FAIL (census-wall §16):
 *   (a) with `feed_url` removed from the postcard lane's select literal,
 *       claims 1 and 2 go red;
 *   (f) with it removed from MEDIA_PROJECTION_POST_MEDIA_COLUMNS, claim 4 goes
 *       red.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  loadPostcardCandidates,
  loadVideoMediaCandidates,
  type LoaderViewer,
} from "../services/wall/WallCandidateLoaders.js";
import {
  MEDIA_PROJECTION_POST_MEDIA_COLUMNS,
  toMediaProjection,
  type MediaCandidateRow,
} from "../lib/media/mediaProjection.js";
import { extractSchemaReferences } from "../scripts/lib/schemaReferenceExtract.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(__dir, "../..");
const VIEWER = "viewer-1";
const FOLLOWED: LoaderViewer = { viewerId: VIEWER, followedCreatorIds: new Set(["author-1"]) };

/** Top-level items of a PostgREST select list; an embed `rel(a, b)` stays one item. */
function topLevel(sel: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of sel) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** The flat column names of a select list (embeds excluded). */
function selectedColumns(sel: string): string[] {
  return topLevel(sel).filter((c) => !c.includes("("));
}

/** The column list of the `post_media(...)` embed in a select, or null. */
function embeddedPostMediaColumns(sel: string): string[] | null {
  const item = topLevel(sel).find((c) => c.startsWith("post_media("));
  return item ? topLevel(item.slice("post_media(".length, -1)) : null;
}

const pick = (r: any, cols: string[]) => Object.fromEntries(cols.filter((c) => c in r).map((c) => [c, r[c]]));

/**
 * Table-routed fake. Records every select string per table. A flat post_media
 * read, and the post_media embed of a posts read, return exactly the columns
 * selected.
 */
function projectingClient(tables: Record<string, any[]>) {
  const selects: Record<string, string[]> = {};
  function builder(table: string) {
    let sel = "*";
    const rows = () => {
      const all = tables[table] ?? [];
      if (sel === "*") return all;
      if (table === "post_media") return all.map((r) => pick(r, selectedColumns(sel)));
      const embed = embeddedPostMediaColumns(sel);
      if (table === "posts" && embed) {
        return all.map((r) => (Array.isArray(r.post_media) ? { ...r, post_media: r.post_media.map((m: any) => pick(m, embed)) } : r));
      }
      return all;
    };
    const b: any = {
      select: (s: string) => {
        sel = s;
        (selects[table] ??= []).push(s);
        return b;
      },
      eq: () => b, in: () => b, or: () => b, order: () => b, limit: () => b,
      gte: () => b, lte: () => b, gt: () => b, is: () => b,
      maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
      then: (onF: any, onR: any) => Promise.resolve({ data: rows(), error: null }).then(onF, onR),
    };
    return b;
  }
  return { client: { from: builder }, selects };
}

const POST = {
  id: "pc-1", author_id: "author-1", trip_id: null, content: "Hoi An lanterns", visibility: "public",
  status: "active", post_status: "published", created_at: "2026-09-01T10:00:00Z", published_at: "2026-09-01T10:00:00Z",
  canonical_place_id: null, has_video: false, media_count: 4, category: "culture",
  location_city: "Hoi An", location_country: "VN", save_count: 0,
};
const PASSPORT_POSTCARDS = [
  { post_id: "pc-1", user_id: "author-1", status: "active", deleted_at: null, created_at: "2026-09-01T10:00:00Z" },
];
const PROFILES = [{ id: "author-1", display_name: "Aya", username: "aya", avatar_url: null, account_status: "active" }];
const row = (id: string, sort: number, over: Record<string, any>) => ({
  id, post_id: "pc-1", media_type: "image", public_url: `post-media/author-1/${id}.jpg`,
  thumbnail_url: `post-media/author-1/${id}.thumb.jpg`, width: 2048, height: 1365, duration_seconds: null,
  sort_order: sort, processing_status: "ready", moderation_status: "approved", ...over,
});
const POST_MEDIA = [
  row("with-feed", 0, { feed_url: "  post-media/author-1/with-feed.feed.jpg  " }),
  row("null-feed", 1, { feed_url: null }),
  row("blank-feed", 2, { feed_url: "   " }),
  row("video", 3, { media_type: "video", public_url: "post-media/author-1/clip.mp4", thumbnail_url: "post-media/author-1/clip.jpg", feed_url: "post-media/author-1/clip.feed.jpg", duration_seconds: 4 }),
];

async function loadPostcard() {
  const fake = projectingClient({
    posts: [POST], passport_postcards: PASSPORT_POSTCARDS, post_media: POST_MEDIA, profiles: PROFILES,
  });
  const loaded = await loadPostcardCandidates(fake.client, "for_you", FOLLOWED);
  return { loaded, selects: fake.selects };
}

describe("the Wall's post_media read selects feed_url (W151, claim 1)", () => {
  it("the postcard lane's post_media select names feed_url", async () => {
    const { loaded, selects } = await loadPostcard();
    assert.equal(loaded.candidates.length, 1, "the fixture postcard projects");
    const reads = selects.post_media ?? [];
    assert.equal(reads.length, 1, "exactly one post_media read");
    assert.ok(selectedColumns(reads[0]).includes("feed_url"), `feed_url selected: ${reads[0]}`);
  });

  it("the select is a static literal the offline column extractor resolves, and 0208 declares the column", () => {
    const { sites, skipped } = extractSchemaReferences(API_ROOT, [resolve(API_ROOT, "src/services/wall")]);
    const pm = sites.filter(
      (s) => s.file.endsWith("services/wall/WallCandidateLoaders.ts") && s.table === "post_media" && s.method === "select",
    );
    const withFeed = pm.filter((s) => s.columns.includes("feed_url"));
    assert.equal(withFeed.length, 1, `one post_media select names feed_url, the postcard lane's (saw ${JSON.stringify(pm)})`);
    assert.equal(withFeed[0].unresolved, false, "fully resolvable — no runtime-probed suffix");
    assert.deepEqual(
      skipped.filter((s) => s.file.endsWith("services/wall/WallCandidateLoaders.ts")),
      [],
      "no unresolvable site in the Wall loaders",
    );
    const mig = readFileSync(resolve(API_ROOT, "src/migrations/0208_post_media_feed_variant.sql"), "utf8");
    assert.match(mig, /ADD COLUMN IF NOT EXISTS feed_url\s+text/);
  });
});

describe("feed_url is projected as DisplayMedia.feedUrl (W151, claims 2 and 3)", () => {
  it("a ready image's feed variant is carried, trimmed", async () => {
    const { loaded } = await loadPostcard();
    const media = loaded.candidates[0].media ?? [];
    assert.deepEqual(media.map((m) => m.mediaId), ["with-feed", "null-feed", "blank-feed", "video"]);
    assert.equal(media[0].feedUrl, "post-media/author-1/with-feed.feed.jpg");
    assert.equal(media[0].thumbnailUrl, "post-media/author-1/with-feed.thumb.jpg", "the thumbnail is still carried");
    assert.equal(media[0].url, "post-media/author-1/with-feed.jpg", "the original is still carried");
  });

  it("NULL or blank feed_url projects null — none stored, never inferred", async () => {
    const { loaded } = await loadPostcard();
    const media = loaded.candidates[0].media ?? [];
    assert.equal(media[1].feedUrl, null);
    assert.equal(media[2].feedUrl, null);
  });

  it("a video projects no feed variant", async () => {
    const { loaded } = await loadPostcard();
    const video = (loaded.candidates[0].media ?? [])[3];
    assert.equal(video.kind, "video");
    assert.equal(video.feedUrl, null);
    assert.equal(video.thumbnailUrl, "post-media/author-1/clip.jpg");
  });
});

describe("the media lane carries the feed variant through Media v2's embed (W151, claims 4 and 5)", () => {
  const author = { id: "author-1", username: "aya", display_name: "Aya", name: "Aya", avatar_url: null, verified: false, is_official: false, account_status: "active" };
  // The embed rows as stored; the fake keeps only the columns the embed selects.
  const embedded = (id: string, over: Record<string, any> = {}) => {
    const { post_id: _pid, ...rest } = row(id, 0, over) as Record<string, any>;
    return rest;
  };
  const post = (id: string, media: any[], created: string) => ({
    id, author_id: "author-1", trip_id: null, content: id, visibility: "public", status: "active",
    post_status: "published", created_at: created, category: "food", location_name: null,
    location_city: "Da Nang", location_country: "VN", canonical_place_id: null, media_urls: [],
    post_media: media, profiles: [author],
  });
  const POSTS = [
    post("img-1", [embedded("m-i", { feed_url: "post-media/author-1/m-i.feed.jpg" })], "2026-09-01T09:00:00Z"),
    post("img-2", [embedded("m-j", { feed_url: null })], "2026-09-01T08:00:00Z"),
    post("vid-1", [embedded("m-v", { media_type: "video", public_url: "post-media/author-1/clip.mp4", thumbnail_url: "post-media/author-1/clip.jpg", feed_url: "post-media/author-1/clip.feed.jpg", duration_seconds: 4 })], "2026-09-01T07:00:00Z"),
  ];
  const tables = () => ({
    profiles: [{ id: VIEWER, location_country: "VN", date_of_birth: null, account_status: "active" }],
    user_follows: [{ following_id: "author-1" }],
    posts: POSTS,
  });

  it("Media v2's post_media embed selects feed_url", () => {
    assert.ok(
      MEDIA_PROJECTION_POST_MEDIA_COLUMNS.split(",").map((c) => c.trim()).includes("feed_url"),
      `MEDIA_PROJECTION_POST_MEDIA_COLUMNS = ${MEDIA_PROJECTION_POST_MEDIA_COLUMNS}`,
    );
  });

  it("an image whose post_media row stores a feed variant carries it; one that stores none carries null; no extra read", async () => {
    const { client, selects } = projectingClient(tables());
    const loaded = await loadVideoMediaCandidates(client, VIEWER);
    const byId = new Map(loaded.candidates.map((c) => [c.canonicalObjectId, c]));
    assert.equal(byId.get("img-1")?.media?.[0].feedUrl, "post-media/author-1/m-i.feed.jpg");
    assert.equal(byId.get("img-2")?.media?.[0].feedUrl, null);
    assert.equal(byId.get("vid-1")?.media?.[0].feedUrl, null, "a video carries no feed variant");
    assert.equal(selects.post_media, undefined, "the media lane makes no post_media read of its own");
    const embed = embeddedPostMediaColumns((selects.posts ?? [])[0] ?? "");
    assert.ok(embed?.includes("feed_url"), `the posts read embeds post_media with feed_url: ${(selects.posts ?? [])[0]}`);
  });

  it("toMediaProjection adds feedUrl only where one is stored: otherwise the key is absent, as before", () => {
    const now = Date.parse("2026-09-02T00:00:00Z");
    const base = POSTS[0] as unknown as MediaCandidateRow;
    const withFeed = toMediaProjection(base, now);
    assert.equal(withFeed?.feedUrl, "post-media/author-1/m-i.feed.jpg");
    const none = toMediaProjection(POSTS[1] as unknown as MediaCandidateRow, now);
    assert.ok(none && !("feedUrl" in none), "no stored variant: no key");
    const video = toMediaProjection(POSTS[2] as unknown as MediaCandidateRow, now);
    assert.ok(video && !("feedUrl" in video), "a video: no key");
    const external = toMediaProjection({ ...base, post_media: [], media_urls: ["https://example.com/x.jpg"] } as unknown as MediaCandidateRow, now);
    assert.ok(external && !("feedUrl" in external), "an external media_urls image: no key");
  });
});
