/**
 * seed-test-media.ts
 *
 * Attaches royalty-free video posts, memories, and hidden-gem rows to the
 * existing @traveltest.dev test accounts and demo-friend accounts so the
 * Portava Media panel (Watch, Grid, Gems) and the Passport media tab have
 * real end-to-end content.
 *
 * Usage from artifacts/api-server:
 *   pnpm seed:test-media
 *
 * Environment:
 *   SUPABASE_URL              — required
 *   SUPABASE_SERVICE_ROLE_KEY — required
 *   SEED_DRY_RUN=true         — log intended inserts without touching the DB
 *   ALLOW_TEST_MEDIA_SEED=true — required to run against a production env
 *
 * Idempotency: every row uses a deterministic UUIDv5 key. Re-running skips
 * rows that already exist.
 */

import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

// ── Production guard ──────────────────────────────────────────────────────────

const nodeEnv = process.env.NODE_ENV;
const appEnv = process.env.APP_ENV;
const allowSeed = process.env.ALLOW_TEST_MEDIA_SEED === "true";

if ((nodeEnv === "production" || appEnv === "production") && !allowSeed) {
  console.error(
    "ERROR: Refusing to seed test media in a production environment.\n" +
    "Set ALLOW_TEST_MEDIA_SEED=true to override this guard.",
  );
  process.exit(1);
}

const DRY_RUN = process.env.SEED_DRY_RUN === "true";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.");
  process.exit(1);
}

const sc = createClient(url, key, { auth: { persistSession: false } });

// ── Helpers ───────────────────────────────────────────────────────────────────

const SEED_NS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

function uuidv5(name: string, namespace: string): string {
  const hash = createHash("sha1").update(namespace + name).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const parts = [
    hash.subarray(0, 4),
    hash.subarray(4, 6),
    hash.subarray(6, 8),
    hash.subarray(8, 10),
    hash.subarray(10, 16),
  ];
  return parts.map((b) => b.toString("hex")).join("-");
}

function dateDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  d.setUTCHours(12, 0, 0, 0);
  return d.toISOString();
}

// ── Demo-friend handles (from seed-demo-social.ts) ────────────────────────────

const DEMO_FRIEND_HANDLES = [
  "mayac", "lucasr", "sofiak", "jameso", "aishap",
  "noahs", "emmat", "liamj", "oliviam", "ethanw",
  "isabellar", "williamp", "chloed", "benm", "amelias",
  "henrya", "zarak", "daniellee", "gracen", "jackt",
];

// ── Video catalogue ───────────────────────────────────────────────────────────

interface VideoEntry {
  videoUrl: string;
  thumbnailUrl: string;
  durationSeconds: number;
  caption: string;
  locationName: string;
  locationCity: string;
  locationCountry: string;
  lat: number;
  lng: number;
  tags: string[];
  category: string;
}

const GTV = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample";

const VIDEO_CATALOGUE: VideoEntry[] = [
  {
    videoUrl: `${GTV}/ForBiggerBlazes.mp4`,
    thumbnailUrl: `${GTV}/images/ForBiggerBlazes.jpg`,
    durationSeconds: 15,
    caption: "Cebu island vibes — turquoise water, island hopping, and a sunset that wouldn't quit.",
    locationName: "Cebu, Philippines",
    locationCity: "Cebu",
    locationCountry: "Philippines",
    lat: 10.3157,
    lng: 123.8854,
    tags: ["beach", "island", "sunset"],
    category: "travel",
  },
  {
    videoUrl: `${GTV}/BigBuckBunny.mp4`,
    thumbnailUrl: `${GTV}/images/BigBuckBunny.jpg`,
    durationSeconds: 60,
    caption: "Bali rice terraces at dawn — the quiet before the town wakes up.",
    locationName: "Ubud, Bali",
    locationCity: "Ubud",
    locationCountry: "Indonesia",
    lat: -8.5069,
    lng: 115.2625,
    tags: ["nature", "bali", "morning"],
    category: "travel",
  },
  {
    videoUrl: `${GTV}/ElephantsDream.mp4`,
    thumbnailUrl: `${GTV}/images/ElephantsDream.jpg`,
    durationSeconds: 50,
    caption: "Bangkok street food tour that turned into a midnight feast.",
    locationName: "Bangkok, Thailand",
    locationCity: "Bangkok",
    locationCountry: "Thailand",
    lat: 13.7563,
    lng: 100.5018,
    tags: ["food", "street-food", "nightlife"],
    category: "food",
  },
  {
    videoUrl: `${GTV}/ForBiggerEscapes.mp4`,
    thumbnailUrl: `${GTV}/images/ForBiggerEscapes.jpg`,
    durationSeconds: 15,
    caption: "Seoul Han River breeze, rooftop coffee, and neighborhoods blending old and new.",
    locationName: "Seoul, South Korea",
    locationCity: "Seoul",
    locationCountry: "South Korea",
    lat: 37.5665,
    lng: 126.978,
    tags: ["city", "cafe", "urban"],
    category: "travel",
  },
  {
    videoUrl: `${GTV}/ForBiggerFun.mp4`,
    thumbnailUrl: `${GTV}/images/ForBiggerFun.jpg`,
    durationSeconds: 15,
    caption: "Singapore gardens wrapped around steel — hawker stalls and humid evenings.",
    locationName: "Singapore",
    locationCity: "Singapore",
    locationCountry: "Singapore",
    lat: 1.3521,
    lng: 103.8198,
    tags: ["gardens", "food", "city"],
    category: "travel",
  },
  {
    videoUrl: `${GTV}/ForBiggerJoyrides.mp4`,
    thumbnailUrl: `${GTV}/images/ForBiggerJoyrides.jpg`,
    durationSeconds: 15,
    caption: "Tokyo after dark — neon alleys, late-night ramen, and the hum of a city that never sleeps.",
    locationName: "Tokyo, Japan",
    locationCity: "Tokyo",
    locationCountry: "Japan",
    lat: 35.6762,
    lng: 139.6503,
    tags: ["nightlife", "ramen", "city"],
    category: "food",
  },
  {
    videoUrl: `${GTV}/ForBiggerMeltdowns.mp4`,
    thumbnailUrl: `${GTV}/images/ForBiggerMeltdowns.jpg`,
    durationSeconds: 15,
    caption: "Taipei night markets, bubble tea, and friendly chaos around every stall.",
    locationName: "Taipei, Taiwan",
    locationCity: "Taipei",
    locationCountry: "Taiwan",
    lat: 25.033,
    lng: 121.5654,
    tags: ["nightmarket", "food", "street"],
    category: "food",
  },
  {
    videoUrl: `${GTV}/SubaruOutbackOnStreetAndDirt.mp4`,
    thumbnailUrl: `${GTV}/images/SubaruOutbackOnStreetAndDirt.jpg`,
    durationSeconds: 60,
    caption: "El Nido limestone cliffs, turquoise water, and island hopping that felt like a dream.",
    locationName: "El Nido, Philippines",
    locationCity: "El Nido",
    locationCountry: "Philippines",
    lat: 11.2097,
    lng: 119.4623,
    tags: ["island", "boat", "adventure"],
    category: "adventure",
  },
  {
    videoUrl: `${GTV}/TearsOfSteel.mp4`,
    thumbnailUrl: `${GTV}/images/TearsOfSteel.jpg`,
    durationSeconds: 60,
    caption: "Siargao palm roads, surf breaks, and sunset beers with new friends.",
    locationName: "General Luna, Philippines",
    locationCity: "General Luna",
    locationCountry: "Philippines",
    lat: 9.8482,
    lng: 126.0454,
    tags: ["surf", "beach", "friends"],
    category: "adventure",
  },
  {
    videoUrl: `${GTV}/VolkswagenGTIReview.mp4`,
    thumbnailUrl: `${GTV}/images/VolkswagenGTIReview.jpg`,
    durationSeconds: 60,
    caption: "Hanoi Old Quarter scooters, egg coffee, and a lake that slows the whole city down.",
    locationName: "Hanoi, Vietnam",
    locationCity: "Hanoi",
    locationCountry: "Vietnam",
    lat: 21.0278,
    lng: 105.8342,
    tags: ["culture", "coffee", "city"],
    category: "travel",
  },
];

// ── Hidden gems definitions ────────────────────────────────────────────────────

interface GemDefinition {
  canonicalPlaceId: string;
  name: string;
  category: string;
  city: string;
  country: string;
  lat: number;
  lng: number;
  imageSeed: string;
}

const GEM_DEFINITIONS: GemDefinition[] = [
  {
    canonicalPlaceId: "a1b2c301-0000-0000-0000-000000000010",
    name: "SM Seaside City",
    category: "shopping",
    city: "Cebu",
    country: "Philippines",
    lat: 10.2911,
    lng: 123.9009,
    imageSeed: "sm-seaside-cebu",
  },
  {
    canonicalPlaceId: "a1b2c302-0000-0000-0000-000000000005",
    name: "BGC High Street",
    category: "lifestyle",
    city: "Manila",
    country: "Philippines",
    lat: 14.5509,
    lng: 121.0494,
    imageSeed: "bgc-high-street-manila",
  },
  {
    canonicalPlaceId: "a1b2c303-0000-0000-0000-000000000002",
    name: "Ubud Art Market",
    category: "market",
    city: "Ubud",
    country: "Indonesia",
    lat: -8.5069,
    lng: 115.2625,
    imageSeed: "ubud-art-market-bali",
  },
  {
    canonicalPlaceId: "a1b2c304-0000-0000-0000-000000000002",
    name: "Chatuchak Weekend Market",
    category: "market",
    city: "Bangkok",
    country: "Thailand",
    lat: 13.7997,
    lng: 100.5501,
    imageSeed: "chatuchak-market-bangkok",
  },
  {
    canonicalPlaceId: "a1b2c304-0000-0000-0000-000000000007",
    name: "Asiatique The Riverfront",
    category: "nightlife",
    city: "Bangkok",
    country: "Thailand",
    lat: 13.7212,
    lng: 100.5044,
    imageSeed: "asiatique-riverfront-bangkok",
  },
  {
    canonicalPlaceId: "a1b2c305-0000-0000-0000-000000000005",
    name: "Haji Lane",
    category: "lifestyle",
    city: "Singapore",
    country: "Singapore",
    lat: 1.3018,
    lng: 103.859,
    imageSeed: "haji-lane-singapore",
  },
];

// ── Resolve target users ──────────────────────────────────────────────────────

async function resolveTargetUsers(): Promise<Array<{ id: string; handle: string }>> {
  const results: Array<{ id: string; handle: string }> = [];

  // 1. Find @traveltest.dev users via auth admin
  const { data: authList } = await sc.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const testEmails = (authList?.users ?? []).filter((u: any) =>
    u.email?.toLowerCase().endsWith("@traveltest.dev"),
  );

  for (const authUser of testEmails) {
    const { data: profile } = await sc
      .from("profiles")
      .select("id, handle")
      .eq("id", authUser.id)
      .maybeSingle();
    if (profile) {
      results.push({ id: profile.id, handle: profile.handle });
    }
  }

  // 2. Find demo-friend accounts by handle
  if (DEMO_FRIEND_HANDLES.length > 0) {
    const { data: friendProfiles } = await sc
      .from("profiles")
      .select("id, handle")
      .in("handle", DEMO_FRIEND_HANDLES);
    for (const p of (friendProfiles ?? []) as any[]) {
      if (!results.find((r) => r.id === p.id)) {
        results.push({ id: p.id, handle: p.handle });
      }
    }
  }

  return results;
}

// ── Tallies ───────────────────────────────────────────────────────────────────

interface Tally {
  usersFound: number;
  postsInserted: number;
  postsSkipped: number;
  postMediaInserted: number;
  postMediaSkipped: number;
  memoriesInserted: number;
  memoriesSkipped: number;
  gemsInserted: number;
  gemsSkipped: number;
}

const tally: Tally = {
  usersFound: 0,
  postsInserted: 0,
  postsSkipped: 0,
  postMediaInserted: 0,
  postMediaSkipped: 0,
  memoriesInserted: 0,
  memoriesSkipped: 0,
  gemsInserted: 0,
  gemsSkipped: 0,
};

// ── Seed video posts ──────────────────────────────────────────────────────────

async function seedVideoPostsForUser(userId: string, handle: string): Promise<void> {
  // Each user gets 5 posts using a distinct slice of the video catalogue.
  // We use a hash of the handle to pick a stable starting offset so
  // users don't all get the same 5 videos.
  const offset = (handle.charCodeAt(0) + handle.charCodeAt(handle.length - 1)) % VIDEO_CATALOGUE.length;
  const videosForUser: VideoEntry[] = [];
  for (let i = 0; i < 5; i++) {
    videosForUser.push(VIDEO_CATALOGUE[(offset + i) % VIDEO_CATALOGUE.length]!);
  }

  for (let i = 0; i < videosForUser.length; i++) {
    const video = videosForUser[i]!;
    const postId = uuidv5(`test-media-post:${userId}:${video.videoUrl}`, SEED_NS);
    const daysAgo = 10 + i * 3; // staggered: 10, 13, 16, 19, 22 days ago
    const ts = dateDaysAgo(daysAgo);

    if (DRY_RUN) {
      console.log(`[DRY-RUN] would insert post ${postId} for @${handle}: ${video.caption.slice(0, 60)}`);
      tally.postsInserted++;
      tally.postMediaInserted++;
      continue;
    }

    // Idempotency check
    const { data: existing } = await sc
      .from("posts")
      .select("id")
      .eq("id", postId)
      .maybeSingle();

    if (existing) {
      tally.postsSkipped++;
    } else {
      const post = {
        id: postId,
        author_id: userId,
        created_by: userId,
        content: video.caption,
        media_urls: [video.videoUrl],
        media_type: "video",
        has_video: true,
        primary_media_type: "video",
        media_count: 1,
        visibility: "public",
        status: "active",
        post_status: "published",
        published_at: ts,
        location_name: video.locationName,
        location_city: video.locationCity,
        location_country: video.locationCountry,
        location_lat: video.lat,
        location_lng: video.lng,
        location_source: "manual",
        location_verified: true,
        location_verified_at: ts,
        location_privacy_mode: "city_only",
        user_gps_lat: video.lat,
        user_gps_lng: video.lng,
        public_lat: video.lat,
        public_lng: video.lng,
        public_location_label: video.locationCity,
        add_to_passport: true,
        moderation_status: "approved",
        source: "seed_script",
        tags: video.tags,
        category: video.category,
        like_count: 0,
        comment_count: 0,
        save_count: 0,
        share_count: 0,
        likes_hidden: false,
        geotag_verified: true,
        geotag_credit_awarded: false,
        location_sensitivity_level: "low",
        created_at: ts,
        updated_at: ts,
      };

      const { error: postErr } = await sc.from("posts").insert(post);
      if (postErr) {
        console.warn(`  ⚠ Could not insert post ${postId} for @${handle}: ${postErr.message}`);
        continue;
      }
      tally.postsInserted++;
    }

    // post_media row
    const { data: existingMedia } = await sc
      .from("post_media")
      .select("id")
      .eq("post_id", postId)
      .maybeSingle();

    if (existingMedia) {
      tally.postMediaSkipped++;
    } else {
      const now = new Date().toISOString();
      const mediaRow = {
        post_id: postId,
        user_id: userId,
        media_type: "video",
        storage_bucket: "post-media",
        storage_path: `${userId}/${postId}/media.mp4`,
        public_url: video.videoUrl,
        thumbnail_url: video.thumbnailUrl,
        mime_type: "video/mp4",
        duration_seconds: video.durationSeconds,
        width: 1280,
        height: 720,
        processing_status: "ready",
        moderation_status: "approved",
        sort_order: 0,
        created_at: now,
        updated_at: now,
      };
      const { error: mediaErr } = await sc.from("post_media").insert(mediaRow);
      if (mediaErr) {
        console.warn(`  ⚠ Could not insert post_media for ${postId}: ${mediaErr.message}`);
      } else {
        tally.postMediaInserted++;
      }
    }
  }
}

// ── Seed video memories ───────────────────────────────────────────────────────

async function seedMemoriesForUser(userId: string, handle: string): Promise<void> {
  // Each user gets 3 memories using a distinct subset of the video catalogue.
  const offset = (handle.charCodeAt(0) + handle.length) % VIDEO_CATALOGUE.length;

  for (let i = 0; i < 3; i++) {
    const video = VIDEO_CATALOGUE[(offset + i + 5) % VIDEO_CATALOGUE.length]!;
    const title = `${video.locationCity} memory`;
    const daysAgo = 20 + i * 7;
    const ts = dateDaysAgo(daysAgo);

    if (DRY_RUN) {
      console.log(`[DRY-RUN] would insert memory "${title}" for @${handle}`);
      tally.memoriesInserted++;
      continue;
    }

    // Idempotency: check on (owner_id, title)
    const { data: existing } = await sc
      .from("memories")
      .select("id")
      .eq("owner_id", userId)
      .eq("title", title)
      .maybeSingle();

    if (existing) {
      tally.memoriesSkipped++;
      continue;
    }

    const memoryId = uuidv5(`test-media-memory:${userId}:${title}`, SEED_NS);
    const memory = {
      id: memoryId,
      owner_id: userId,
      title,
      caption: video.caption,
      visibility: "public",
      state: "published",
      starts_at: ts,
      ends_at: dateDaysAgo(daysAgo - 1),
      location_city: video.locationCity,
      location_country: video.locationCountry,
      location_lat: video.lat,
      location_lng: video.lng,
      allowed_user_ids: [],
      hidden_user_ids: [],
      created_at: ts,
      updated_at: ts,
    };

    const { error: memErr } = await sc.from("memories").insert(memory);
    if (memErr) {
      console.warn(`  ⚠ Could not insert memory "${title}" for @${handle}: ${memErr.message}`);
      continue;
    }
    tally.memoriesInserted++;

    // Insert a memory_item for the video
    const itemId = uuidv5(`test-media-memitem:${userId}:${title}`, SEED_NS);
    const item = {
      id: itemId,
      memory_id: memoryId,
      media_url: video.videoUrl,
      media_type: "video",
      caption: `${video.locationCity} — ${video.tags[0] ?? "travel"}`,
      position: 0,
      created_at: ts,
    };
    const { error: itemErr } = await sc.from("memory_items").insert(item);
    if (itemErr) {
      // non-fatal — memory itself was inserted
      console.warn(`  ⚠ Could not insert memory_item for ${memoryId}: ${itemErr.message}`);
    }
  }
}

// ── Seed hidden gems ──────────────────────────────────────────────────────────

async function seedHiddenGems(submittedBy: string): Promise<void> {
  for (let i = 0; i < GEM_DEFINITIONS.length; i++) {
    const gem = GEM_DEFINITIONS[i]!;
    const gemId = uuidv5(`test-media-gem:${gem.canonicalPlaceId}`, SEED_NS);
    const ts = dateDaysAgo(30 + i * 5);

    if (DRY_RUN) {
      console.log(`[DRY-RUN] would insert hidden gem "${gem.name}" (${gem.city})`);
      tally.gemsInserted++;
      continue;
    }

    const { data: existing } = await sc
      .from("hidden_gems")
      .select("id")
      .eq("id", gemId)
      .maybeSingle();

    if (existing) {
      tally.gemsSkipped++;
      continue;
    }

    // approx coords rounded to 2 dp
    const approxLat = Math.round(gem.lat * 100) / 100;
    const approxLng = Math.round(gem.lng * 100) / 100;

    const row = {
      id: gemId,
      name: gem.name,
      category: gem.category,
      city: gem.city,
      country: gem.country,
      latitude: gem.lat,
      longitude: gem.lng,
      approx_latitude: approxLat,
      approx_longitude: approxLng,
      sensitivity_level: "public",
      verification_level: "community",
      status: "active",
      moderation_status: "approved",
      source_type: "user_submitted",
      submitted_by: submittedBy,
      canonical_place_id: gem.canonicalPlaceId,
      image_url: `https://picsum.photos/seed/${gem.imageSeed}/800/600`,
      layover_safe: false,
      save_count: 0,
      visit_count: 0,
      report_count: 0,
      created_at: ts,
      updated_at: ts,
    };

    const { error: gemErr } = await sc.from("hidden_gems").insert(row);
    if (gemErr) {
      console.warn(`  ⚠ Could not insert hidden gem "${gem.name}": ${gemErr.message}`);
      continue;
    }
    tally.gemsInserted++;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`Seeding test media for Watch, Grid, Gems, and Passport tabs (dry-run=${DRY_RUN})…\n`);

  const users = await resolveTargetUsers();
  tally.usersFound = users.length;

  if (users.length === 0) {
    console.log("No target users found. Run seed:profiles and seed:demo-social first, then retry.");
    process.exit(0);
  }

  console.log(`Found ${users.length} target user(s): ${users.map((u) => `@${u.handle}`).join(", ")}\n`);

  // Seed posts and memories for each user
  for (const user of users) {
    process.stdout.write(`  @${user.handle} — posts…`);
    await seedVideoPostsForUser(user.id, user.handle);
    process.stdout.write(" memories…");
    await seedMemoriesForUser(user.id, user.handle);
    console.log(" done");
  }

  // Seed gems once (using first resolved user as submitter)
  const gemSubmitter = users[0]!;
  console.log(`\n  Seeding hidden gems (submitter: @${gemSubmitter.handle})…`);
  await seedHiddenGems(gemSubmitter.id);

  // Summary
  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Seed test-media summary
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Users found:          ${tally.usersFound}
  Posts inserted:       ${tally.postsInserted}  (skipped: ${tally.postsSkipped})
  Post-media inserted:  ${tally.postMediaInserted}  (skipped: ${tally.postMediaSkipped})
  Memories inserted:    ${tally.memoriesInserted}  (skipped: ${tally.memoriesSkipped})
  Gems inserted:        ${tally.gemsInserted}  (skipped: ${tally.gemsSkipped})
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);

  if (DRY_RUN) {
    console.log("[DRY-RUN] No rows were written to the database.");
  } else {
    console.log("Done. Re-running this script is safe — existing rows are skipped.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
