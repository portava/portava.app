/**
 * The Wall carries the stored feed variant (Wall spec §33 "Images: responsive
 * variants + CDN/cache"; census-wall W151).
 *
 * /media/upload stores up to three objects per post_media image: the original,
 * a ≤400 px thumbnail, and (migration 0208) a ≤FEED_DIM (1500 px) feed variant
 * built for exactly the Wall's full-width frames. The Wall's post_media read
 * selected the first two and never the third, so the projection could not name
 * it and the client drew the thumbnail at every size.
 *
 * ── THE CLAIMS ───────────────────────────────────────────────────────────────
 *   1. The Wall's post_media read SELECTS `feed_url`, as a statically resolvable
 *      literal (check:write-path-columns and check:schema-references audit only
 *      literals), and the column is declared by 0208.
 *   2. A ready image row's `feed_url` is projected as `DisplayMedia.feedUrl`,
 *      trimmed; NULL, blank or absent projects null (the migration's contract:
 *      null means "none stored — use another variant", never an inference).
 *   3. A video row projects no feed variant; its still is the poster.
 *   4. The media lane (Media v2's projection) projects `feedUrl: null`: its
 *      post_media embed does not select `feed_url` and `media_assets` has none.
 *
 * The fake below PROJECTS each post_media row to the columns the loader
 * selected, the way PostgREST does, so a select that drops `feed_url` loses the
 * value instead of being handed it by a permissive fake.
 *
 * WATCHED IT FAIL: (a) with `feed_url` removed from the select literal in
 * services/wall/WallCandidateLoaders.ts, claims 1 and 2 go red.
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
import { extractSchemaReferences } from "../scripts/lib/schemaReferenceExtract.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(__dir, "../..");
const VIEWER = "viewer-1";
const FOLLOWED: LoaderViewer = { viewerId: VIEWER, followedCreatorIds: new Set(["author-1"]) };

/** Column names of a flat PostgREST select list (this read has no embeds). */
function selectedColumns(sel: string): string[] {
  return sel.split(",").map((c) => c.trim()).filter(Boolean);
}

/**
 * Table-routed fake. Records every select string per table; post_media rows are
 * projected to exactly the selected columns.
 */
function projectingClient(tables: Record<string, any[]>) {
  const selects: Record<string, string[]> = {};
  function builder(table: string) {
    let sel = "*";
    const rows = () => {
      const all = tables[table] ?? [];
      if (table !== "post_media" || sel === "*") return all;
      const cols = selectedColumns(sel);
      return all.map((r) => Object.fromEntries(cols.filter((c) => c in r).map((c) => [c, r[c]])));
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
    assert.equal(withFeed.length, 1, `one post_media select names feed_url (saw ${JSON.stringify(pm)})`);
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

describe("the media lane has no feed variant to carry (W151, claim 4)", () => {
  it("loadVideoMediaCandidates projects feedUrl: null", async () => {
    const author = { id: "author-1", username: "aya", display_name: "Aya", name: "Aya", avatar_url: null, verified: false, is_official: false, account_status: "active" };
    const { client } = projectingClient({
      profiles: [{ id: VIEWER, location_country: "VN", date_of_birth: null, account_status: "active" }],
      user_follows: [{ following_id: "author-1" }],
      posts: [{
        id: "img-1", author_id: "author-1", trip_id: null, content: "coffee", visibility: "public", status: "active",
        post_status: "published", created_at: "2026-09-01T09:00:00Z", category: "food", location_name: null,
        location_city: "Da Nang", location_country: "VN", canonical_place_id: null, media_urls: [],
        post_media: [row("m-i", 0, { post_id: "img-1", feed_url: "post-media/author-1/m-i.feed.jpg" })],
        profiles: [author],
      }],
    });
    const loaded = await loadVideoMediaCandidates(client, VIEWER);
    const img = loaded.candidates.find((c) => c.canonicalObjectId === "img-1");
    assert.ok(img, "the media lane projects the image post");
    assert.equal(img.media?.[0].kind, "image");
    assert.equal(img.media?.[0].feedUrl, null);
  });
});
