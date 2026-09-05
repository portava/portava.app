/**
 * The Wall inline-autoplay CONTRACT between server and client (spec §11/§36).
 *
 * WHAT THIS EXISTS FOR
 * --------------------
 * Autoplay on the Wall is CLIENT policy — device, reduced motion, the user's
 * setting, viewport visibility (§11 "Autoplay only under product policy and
 * user/device conditions", §36 "Autoplay respects reduced motion and user
 * settings"). The server's job is to say whether the media is playable, and
 * nothing more.
 *
 * Every DisplayMedia-producing loader here stamped `autoplayEligible: false` on
 * EVERY video — the loader's own comment said "the server never forces it on" —
 * while the client read `false` as a HARD VETO. The two halves of the contract
 * disagreed, so the inline Wall autoplay that shipped in the Wall campaign could
 * never run on a single item.
 *
 * The contract now: `true` = "playable" (never a command), `false`/absent = no
 * server opinion (never a veto), and only the client decides. This file proves
 * the SERVER half:
 *
 *   • the shared decision (lib/wallProjection.serverAutoplayHint) can never
 *     produce a veto;
 *   • a real loader (loadQuickMediaItems) emits a video whose descriptor does
 *     not veto autoplay;
 *   • no loader re-introduces a hand-rolled stamp that bypasses the shared rule.
 *
 * The CLIENT half is proven in travel-buddy-standalone
 * features/wall/components/objects/__tests__/VideoWallItem.component.test.tsx.
 *
 * Run: node --import tsx/esm --test src/test/wallAutoplayContract.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serverAutoplayHint } from "../lib/wallProjection.js";
import { loadQuickMediaItems } from "../services/wall/WallCandidateLoaders.js";

const VIEWER = "viewer-1";
const NOW = Date.parse("2026-09-04T12:00:00.000Z");

// ── the shared rule ───────────────────────────────────────────────────────────

describe("serverAutoplayHint — the server never vetoes and never forces", () => {
  it("never returns false for a video (false would read as a veto downstream)", () => {
    assert.notEqual(serverAutoplayHint("video"), false);
    assert.equal(serverAutoplayHint("video"), true, "a projected video is playable");
  });

  it("omits the field for a still image — autoplay has no meaning there", () => {
    assert.equal(serverAutoplayHint("image"), undefined);
  });
});

// ── a real loader ─────────────────────────────────────────────────────────────

/** Compact fake: one followed author with one ready VIDEO asset on a public post. */
function fakeClient(assetOver: Record<string, unknown> = {}) {
  const assets = [{
    id: "asset-v1",
    owner_user_id: "aya",
    storage_bucket: "post-media",
    storage_path: "aya/2026/09/clip.mp4",
    public_url: null,
    media_type: "video",
    thumbnail_path: "aya/2026/09/clip_thumb.jpg",
    thumbnail_url: null,
    width: 1080,
    height: 1920,
    duration_ms: 8000,
    moderation_status: "pending",
    processing_status: "ready",
    visibility: "inherit",
    created_at: new Date(NOW - 2 * 60 * 60 * 1000).toISOString(),
    ...assetOver,
  }];
  const tables: Record<string, any[]> = {
    user_follows: [{ following_id: "aya" }],
    blocks: [],
    media_assets: assets,
    media_attachments: [{ media_asset_id: "asset-v1", entity_type: "post", entity_id: "post-1" }],
    post_media: [],
    posts: [{ id: "post-1", author_id: "aya", visibility: "public", status: "active", post_status: "published", trip_id: null }],
    profiles: [{ id: "aya", display_name: "Aya", username: "aya", avatar_url: null, account_status: "active" }],
    trip_members: [],
    trips: [],
  };

  function builder(table: string) {
    const eqs: Record<string, any> = {};
    const ins: Record<string, any[]> = {};
    let single = false;
    function resolve(): any {
      if (table === "feature_flags") return { data: { enabled: true }, error: null };
      if (table === "user_follows") {
        return { data: eqs.follower_id === VIEWER ? tables.user_follows : [], error: null };
      }
      let rows = tables[table] ?? [];
      for (const [col, vals] of Object.entries(ins)) rows = rows.filter((r) => vals.includes(r[col]));
      for (const [col, v] of Object.entries(eqs)) {
        if (col === "follower_id") continue;
        rows = rows.filter((r) => !(col in r) || r[col] === v);
      }
      return { data: single ? rows[0] ?? null : rows, error: null };
    }
    const b: any = {
      select: () => b,
      eq: (c: string, v: any) => { eqs[c] = v; return b; },
      in: (c: string, v: any[]) => { ins[c] = v; return b; },
      or: () => b,
      gte: () => b, lte: () => b, gt: () => b, lt: () => b, is: () => b, ilike: () => b,
      order: () => b, limit: () => b,
      maybeSingle: () => { single = true; return Promise.resolve().then(resolve); },
      then: (onF: any, onR: any) => Promise.resolve().then(resolve).then(onF, onR),
    };
    return b;
  }
  return { from: builder } as any;
}

describe("a real loader's video descriptor does not veto autoplay", () => {
  it("loadQuickMediaItems emits a video whose autoplayEligible is not false", async () => {
    const items = await loadQuickMediaItems(fakeClient(), VIEWER, { nowMs: NOW });
    assert.equal(items.length, 1, "the fixture yields one quick-media video");
    const media = items[0].media;
    assert.equal(media.kind, "video");
    assert.notEqual(
      media.autoplayEligible,
      false,
      "a blanket false is read by the client as 'forbidden' and makes inline autoplay unreachable",
    );
  });

  it("an image carries no autoplay note at all", async () => {
    const items = await loadQuickMediaItems(
      fakeClient({ media_type: "image", storage_path: "aya/2026/09/a1.jpg", duration_ms: null }),
      VIEWER,
      { nowMs: NOW },
    );
    assert.equal(items.length, 1);
    assert.equal(items[0].media.kind, "image");
    assert.equal(items[0].media.autoplayEligible, undefined);
  });
});

// ── no loader re-rolls its own stamp ──────────────────────────────────────────

describe("every loader routes autoplayEligible through the shared rule", () => {
  it("WallCandidateLoaders never hand-rolls the value", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../services/wall/WallCandidateLoaders.ts", import.meta.url)),
      "utf8",
    );
    const stamps = src.match(/autoplayEligible:\s*[^,\n]+/g) ?? [];
    assert.ok(stamps.length >= 4, `expected the DisplayMedia sites to still stamp the field (saw ${stamps.length})`);
    for (const stamp of stamps) {
      assert.match(
        stamp,
        /autoplayEligible:\s*serverAutoplayHint\(/,
        `a loader hand-rolls autoplayEligible instead of using serverAutoplayHint: ${stamp}`,
      );
    }
  });
});
