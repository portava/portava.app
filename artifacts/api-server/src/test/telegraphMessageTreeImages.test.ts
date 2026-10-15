/**
 * census-telegraph T446 (§30A.20), B58 TM-1 — path (a): a share projection's
 * image is Portava storage or nothing (`services/telegraph/messageTreeImages.ts`,
 * applied in `services/telegraph/shareables.ts#proj`).
 *
 * Every recipient's device draws `projection.imageUrl`, and the client passes a
 * non-storage URL through to `<Image>` unchanged, so before this change an
 * avatar, cover or artwork URL on any host made each recipient's device contact
 * that host when the card rendered. I1–I3 pin the predicate; I4 drives a real
 * loader end to end through `resolveShareProjections` — the function the share
 * route calls and the card-truth readers re-resolve through.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *        node --import tsx/esm --test src/test/telegraphMessageTreeImages.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { storageImageOrNull } from "../services/telegraph/messageTreeImages.js";
import { resolveShareProjections } from "../services/telegraph/shareables.js";
import { makeFailClosedClient } from "./helpers/failClosedSupabase.js";
import { configuredStorageOrigin } from "../lib/mediaUrl.js";

const ORIGIN = "https://proj.supabase.co";

describe("T446 — a projection image is Portava storage or nothing", () => {
  it("I1 storage on the CONFIGURED origin is kept, any bucket, public or signed", () => {
    for (const ok of [
      "https://proj.supabase.co/storage/v1/object/public/stamp-artwork/s.png",
      "https://proj.supabase.co/storage/v1/object/public/post-media/a/b.jpg",
      "https://proj.supabase.co/storage/v1/object/sign/post-media/a.jpg?token=t",
      "https://proj.supabase.co/storage/v1/render/image/public/post-media/a.jpg?width=200",
      "post-media/generated-visuals/a.webp",
      "profile-media/u/avatar.jpg",
    ]) assert.equal(storageImageOrNull(ok, ORIGIN), ok, ok);
  });

  it("I2 every other host or shape is withheld (null)", () => {
    for (const bad of [
      "https://tracker.example/pixel.png?r=bob",
      "http://proj.supabase.co/storage/v1/object/public/post-media/a.jpg",
      "https://proj.supabase.co.evil.example/storage/v1/object/public/post-media/a.jpg",
      "https://proj.supabase.co/rest/v1/profiles",
      "https://user@proj.supabase.co/storage/v1/object/public/post-media/a.jpg",
      "//tracker.example/a.png",
      "data:image/png;base64,AAAA",
      "javascript:alert(1)",
      "tracker.example/a.png",
      "post-media/../profile-media/x.jpg",
      "post-media/a b.jpg",
      "lh3.googleusercontent.com/a/photo",
      "", "   ", null, undefined, 42,
    ]) assert.equal(storageImageOrNull(bad, ORIGIN), null, String(bad));
  });

  it("I3 no configured storage origin: every absolute URL is withheld, a bare reference is kept", () => {
    assert.equal(storageImageOrNull("https://proj.supabase.co/storage/v1/object/public/post-media/a.jpg", null), null);
    assert.equal(storageImageOrNull("post-media/a.jpg", null), "post-media/a.jpg");
  });

  it("I4 through the real loader: a profile card with a third-party avatar keeps its title and loses the image", async () => {
    const VIEWER = "aaaaaaaa-0000-4000-8000-000000000001";
    const OWNER = "bbbbbbbb-0000-4000-8000-000000000002";
    const THREAD = "70000000-0000-4000-8000-000000000001";
    const card = async (avatar: string | null) => {
      const client = makeFailClosedClient({
        rows: {
          profiles: [{ id: OWNER, handle: "bob", name: "Bob", avatar_url: avatar, account_status: "active", is_private: false, passport_visibility: "public", updated_at: "2026-10-01T00:00:00.000Z" }],
        },
      });
      const [r] = await resolveShareProjections(client, VIEWER, THREAD, [{ objectType: "PROFILE", objectId: OWNER }]);
      assert.ok(r && r.available, JSON.stringify(r));
      return r.projection!;
    };
    const tracked = await card("https://tracker.example/avatar.png?who=recipient");
    assert.equal(tracked.imageUrl, null);
    assert.equal(tracked.title, "@bob");
    assert.equal((await card("profile-media/bob/avatar.jpg")).imageUrl, "profile-media/bob/avatar.jpg");
    // The deployment's own storage origin (the test command pins it to a loopback port) is Portava's host.
    const origin = configuredStorageOrigin();
    assert.ok(origin, "the test command configures a storage origin");
    const own = `${origin}/storage/v1/object/public/profile-media/bob/a.jpg`;
    assert.equal((await card(own)).imageUrl, own);
  });
});
