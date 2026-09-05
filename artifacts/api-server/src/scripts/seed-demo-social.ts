/**
 * Seed demo social graph + engagement for anroletrading@gmail.com.
 *
 * Creates 20 demo users with populated profiles, connects them to the target
 * user via follows and friendships, adds realistic engagement on the target
 * user's posts/postcards/memories, and inserts one demo video postcard.
 *
 * Usage from artifacts/api-server:
 *   node --env-file-if-exists=.env --import tsx/esm src/scripts/seed-demo-social.ts
 */

import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

const EMAIL = process.env.SEED_EMAIL ?? "anroletrading@gmail.com";
const DRY_RUN = process.env.SEED_DRY_RUN === "true";
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error("ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set."); process.exit(1); }
const sc = createClient(url, key, { auth: { persistSession: false } });

function uuidv5(name: string, namespace: string): string {
  const hash = createHash("sha1").update(namespace + name).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const parts = [hash.subarray(0, 4), hash.subarray(4, 6), hash.subarray(6, 8), hash.subarray(8, 10), hash.subarray(10, 16)];
  return parts.map((b) => b.toString("hex")).join("-");
}
const SEED_NS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

const DEMO_FRIENDS = [
  { name: "Maya Chen", handle: "mayac", bio: "Coffee, cities, and street photography. Usually chasing golden hour.", home: { city: "Singapore", country: "Singapore", lat: 1.3521, lng: 103.8198 }, interests: ["photography", "food", "museums"], languages: ["English", "Mandarin"] },
  { name: "Lucas Rivera", handle: "lucasr", bio: "Backpacker turned slow traveler. Currently in SE Asia.", home: { city: "Barcelona", country: "Spain", lat: 41.3851, lng: 2.1734 }, interests: ["hiking", "beach", "history"], languages: ["English", "Spanish"] },
  { name: "Sofia Kim", handle: "sofiak", bio: "Solo female traveler. I collect sunsets and local markets.", home: { city: "Seoul", country: "South Korea", lat: 37.5665, lng: 126.978 }, interests: ["shopping", "nightlife", "wellness"], languages: ["English", "Korean"] },
  { name: "James O'Connor", handle: "jameso", bio: "Weekend explorer from Dublin. Love a good pub and a coastal walk.", home: { city: "Dublin", country: "Ireland", lat: 53.3498, lng: -6.2603 }, interests: ["pubs", "hiking", "music"], languages: ["English"] },
  { name: "Aisha Patel", handle: "aishap", bio: "Digital nomad, plant-based eater, perpetual planner.", home: { city: "Mumbai", country: "India", lat: 19.076, lng: 72.8777 }, interests: ["food", "yoga", "remote work"], languages: ["English", "Hindi"] },
  { name: "Noah Schmidt", handle: "noahs", bio: "Mountain person. Prefer boots to flip-flops.", home: { city: "Zurich", country: "Switzerland", lat: 47.3769, lng: 8.5417 }, interests: ["hiking", "skiing", "camping"], languages: ["English", "German"] },
  { name: "Emma Tanaka", handle: "emmat", bio: "Art student in Tokyo. Always sketching on trains.", home: { city: "Tokyo", country: "Japan", lat: 35.6762, lng: 139.6503 }, interests: ["art", "design", "architecture"], languages: ["English", "Japanese"] },
  { name: "Liam Johnson", handle: "liamj", bio: "Beach bum from Sydney. Sunscreen and surfboards.", home: { city: "Sydney", country: "Australia", lat: -33.8688, lng: 151.2093 }, interests: ["surfing", "beach", "fitness"], languages: ["English"] },
  { name: "Olivia Martins", handle: "oliviam", bio: "History nerd and pastry enthusiast. Lisbon home base.", home: { city: "Lisbon", country: "Portugal", lat: 38.7223, lng: -9.1393 }, interests: ["history", "food", "walking tours"], languages: ["English", "Portuguese"] },
  { name: "Ethan Williams", handle: "ethanw", bio: "Road trip fanatic. US national parks checklist in progress.", home: { city: "Denver", country: "USA", lat: 39.7392, lng: -104.9903 }, interests: ["road trips", "camping", "photography"], languages: ["English"] },
  { name: "Isabella Rossi", handle: "isabellar", bio: "Rome born, world curious. Pasta recommendations welcome.", home: { city: "Rome", country: "Italy", lat: 41.9028, lng: 12.4964 }, interests: ["food", "history", "art"], languages: ["English", "Italian"] },
  { name: "William Park", handle: "williamp", bio: "Korean-American foodie. Hunt for the best BBQ worldwide.", home: { city: "Los Angeles", country: "USA", lat: 34.0522, lng: -118.2437 }, interests: ["food", "bbq", "travel"], languages: ["English", "Korean"] },
  { name: "Chloe Dubois", handle: "chloed", bio: "Parisian designer. Love minimal hotels and maximal meals.", home: { city: "Paris", country: "France", lat: 48.8566, lng: 2.3522 }, interests: ["design", "fashion", "food"], languages: ["English", "French"] },
  { name: "Benjamin Müller", handle: "benm", bio: "Engineer with a camera. Calm traveler, early riser.", home: { city: "Berlin", country: "Germany", lat: 52.52, lng: 13.405 }, interests: ["photography", "tech", "coffee"], languages: ["English", "German"] },
  { name: "Amelia Silva", handle: "amelias", bio: "Brazilian dancer. I travel for rhythm and rhythm only.", home: { city: "Rio de Janeiro", country: "Brazil", lat: -22.9068, lng: -43.1729 }, interests: ["dance", "music", "beach"], languages: ["English", "Portuguese"] },
  { name: "Henry Andersen", handle: "henrya", bio: "Nordic minimalist. Saunas, fjords, and clean design.", home: { city: "Copenhagen", country: "Denmark", lat: 55.6761, lng: 12.5683 }, interests: ["design", "nature", "wellness"], languages: ["English", "Danish"] },
  { name: "Zara Khan", handle: "zarak", bio: "Adventure traveler. Scuba, skydiving, and street food.", home: { city: "Dubai", country: "UAE", lat: 25.2048, lng: 55.2708 }, interests: ["adventure", "scuba", "food"], languages: ["English", "Urdu"] },
  { name: "Daniel Lee", handle: "daniellee", bio: "Canadian explorer. Always looking for the northern lights.", home: { city: "Vancouver", country: "Canada", lat: 49.2827, lng: -123.1207 }, interests: ["nature", "photography", "hiking"], languages: ["English", "French"] },
  { name: "Grace Nguyen", handle: "gracen", bio: "Vietnamese-Australian. Travel for family, food, and pho.", home: { city: "Melbourne", country: "Australia", lat: -37.8136, lng: 144.9631 }, interests: ["food", "family", "culture"], languages: ["English", "Vietnamese"] },
  { name: "Jack Thompson", handle: "jackt", bio: "British expat in Bangkok. Markets, muay thai, mangoes.", home: { city: "Bangkok", country: "Thailand", lat: 13.7563, lng: 100.5018 }, interests: ["martial arts", "markets", "food"], languages: ["English"] },
];

const COMMENTS = [
  "This looks incredible!",
  "Adding this to my list now.",
  "Hope the food was as good as the view.",
  "Miss this place already.",
  "What camera did you use?",
  "Next trip together?",
  "You always find the best spots.",
  "Golden hour magic right here.",
  "I was there last year!",
  "That city has my heart.",
  "Travel envy is real.",
  "How long did you stay?",
  "Need your itinerary ASAP.",
  "Iconic shot.",
  "The colors are unreal.",
  "Safe travels always!",
  "This made my morning.",
  "Take me back with you next time.",
  "Bookmarking for my next trip.",
  "Absolutely dreamy.",
];

const VIDEO_POSTCARD_URL = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4";
const VIDEO_POSTCARD_THUMB = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/images/ForBiggerBlazes.jpg";

function dateDaysAgo(days: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function mediaUrl(seed: string, w: number, h: number) {
  return `https://picsum.photos/seed/${seed}/${w}/${h}`;
}

async function getTargetProfile() {
  const { data: list } = await sc.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const user = (list?.users ?? []).find((u: any) => u.email?.toLowerCase() === EMAIL.toLowerCase());
  if (!user) throw new Error(`User not found: ${EMAIL}`);
  const { data: profile } = await sc.from("profiles").select("id, handle, name").eq("id", user.id).maybeSingle();
  if (!profile) throw new Error(`Profile not found: ${EMAIL}`);
  return { profile, user };
}

async function upsertRows(table: string, rows: any[], idField = "id") {
  if (rows.length === 0) return { inserted: 0, skipped: 0 };
  if (DRY_RUN) { console.log(`[DRY-RUN] would insert ${rows.length} rows into ${table}`); return { inserted: 0, skipped: rows.length }; }
  const ids = rows.map((r) => r[idField]);
  const { data: existing } = await sc.from(table).select(idField).in(idField, ids);
  const existingSet = new Set((existing ?? []).map((r: any) => r[idField]));
  const toInsert = rows.filter((r) => !existingSet.has(r[idField]));
  if (toInsert.length === 0) return { inserted: 0, skipped: rows.length };
  const { error } = await sc.from(table).insert(toInsert);
  if (error) throw error;
  return { inserted: toInsert.length, skipped: rows.length - toInsert.length };
}

async function upsertCompositeRows(table: string, rows: any[], conflictFields: string) {
  if (rows.length === 0) return { inserted: 0, skipped: 0 };
  if (DRY_RUN) { console.log(`[DRY-RUN] would insert ${rows.length} rows into ${table}`); return { inserted: 0, skipped: rows.length }; }
  const keys = rows.map((r) => conflictFields.split(",").map((f) => r[f.trim()]).join(":"));
  const existing = await sc.from(table).select(conflictFields).in(conflictFields.split(",")[0], [...new Set(rows.map((r) => r[conflictFields.split(",")[0].trim()]))]);
  const existingSet = new Set((existing?.data ?? []).map((r: any) => conflictFields.split(",").map((f) => r[f.trim()]).join(":")));
  const toInsert = rows.filter((r, i) => !existingSet.has(keys[i]));
  if (toInsert.length === 0) return { inserted: 0, skipped: rows.length };
  const { error } = await sc.from(table).insert(toInsert);
  if (error) throw error;
  return { inserted: toInsert.length, skipped: rows.length - toInsert.length };
}

async function seedDemoFriends() {
  const created: { id: string; handle: string }[] = [];
  for (let i = 0; i < DEMO_FRIENDS.length; i++) {
    const f = DEMO_FRIENDS[i];
    const userId = uuidv5(`demo-friend:${EMAIL}:${i}`, SEED_NS);
    const email = `demo.friend.${i}.${EMAIL.replace(/[@.]/g, "-")}@example.com`;
    const password = `DemoFriend_${i}_Pass!`;
    if (!DRY_RUN) {
      const { data: existingAuth } = await sc.auth.admin.getUserById(userId).catch(() => ({ data: null }));
      const existingAuthUser = existingAuth?.user;
      if (!existingAuthUser) {
        const { error: createErr } = await sc.auth.admin.createUser({ id: userId, email, password, email_confirm: true });
        if (createErr && !createErr.message?.includes("already been registered")) {
          console.warn(`Could not create auth user ${email}:`, createErr.message);
          continue;
        }
      }
    }
    const profile = {
      id: userId,
      handle: f.handle,
      name: f.name,
      display_name: f.name,
      username: f.handle,
      bio: f.bio,
      home_city: f.home.city,
      home_country: f.home.country,
      current_city: f.home.city,
      interests: f.interests,
      spoken_languages: f.languages,
      travel_styles: ["solo", "budget", "culture"],
      travel_style: "culture",
      travel_pace: "moderate",
      budget_style: "mid_range",
      comfort_level: "comfortable",
      avatar_url: mediaUrl(f.handle, 200, 200),
      cover_photo_url: mediaUrl(f.handle + "-cover", 800, 400),
      verified: false,
      verification_status: "unverified",
      is_private: false,
      open_to_meet: true,
      passport_visibility: "public",
      role: "user",
      preferred_message_language: "en",
      dob_verified: false,
      date_of_birth: null,
      created_at: dateDaysAgo(100 + i),
      updated_at: dateDaysAgo(100 + i),
    };
    if (!DRY_RUN) {
      const { error: profileErr } = await sc.from("profiles").upsert(profile, { onConflict: "id" });
      if (profileErr) { console.warn(`Could not upsert profile ${f.handle}:`, profileErr.message); continue; }
      await sc.from("profile_privacy_settings").upsert({ user_id: userId, allow_follow: true, allow_friend_requests: true, allow_messages_from: "friends", profile_visibility: "public", allow_profile_discovery: true, allow_tagging: true, delayed_posting_default: false, precise_location_visible: false, show_current_city: true, show_followers: true, show_friends: true, show_home_country: true, show_past_trips: true, show_posts: true, show_real_name: true, show_stamps: true, show_upcoming_trips: true, show_visited_places: true, updated_at: dateDaysAgo(100 + i) }, { onConflict: "user_id" });
    }
    created.push({ id: userId, handle: f.handle });
  }
  return created;
}

async function seedRelationships(targetUserId: string, friends: { id: string }[]) {
  // Follows: all 20 follow the target user; target follows 10 back.
  const followRows = friends.map((f, i) => ({ follower_id: f.id, following_id: targetUserId, created_at: dateDaysAgo(90 - i) }));
  const targetFollowsBack = friends.slice(0, 10).map((f, i) => ({ follower_id: targetUserId, following_id: f.id, created_at: dateDaysAgo(85 - i) }));
  const followResult = await upsertCompositeRows("user_follows", [...followRows, ...targetFollowsBack], "follower_id,following_id");

  // Friendships: 12 accepted, 4 pending incoming, 4 pending outgoing.
  const acceptedPairs = friends.slice(0, 12).map((f, i) => {
    const [a, b] = [f.id, targetUserId].sort();
    return { user_a: a, user_b: b, created_at: dateDaysAgo(80 - i) };
  });
  const friendshipResult = await upsertCompositeRows("user_friendships", acceptedPairs, "user_a,user_b");

  const now = new Date().toISOString();
  const incomingRequests = friends.slice(12, 16).map((f, i) => ({
    id: uuidv5(`friend-req-in:${targetUserId}:${i}`, SEED_NS),
    requester_id: f.id,
    recipient_id: targetUserId,
    status: "pending",
    created_at: dateDaysAgo(10 - i),
    updated_at: now,
  }));
  const outgoingRequests = friends.slice(16, 20).map((f, i) => ({
    id: uuidv5(`friend-req-out:${targetUserId}:${i}`, SEED_NS),
    requester_id: targetUserId,
    recipient_id: f.id,
    status: "pending",
    created_at: dateDaysAgo(10 - i),
    updated_at: now,
  }));
  const requestResult = await upsertRows("friend_requests", [...incomingRequests, ...outgoingRequests]);

  return { followResult, friendshipResult, requestResult };
}

async function seedEngagement(targetUserId: string, friends: { id: string }[]) {
  const { data: posts } = await sc.from("posts").select("id, media_type").eq("author_id", targetUserId).eq("status", "active").limit(25);
  const { data: memories } = await sc.from("memories").select("id").eq("owner_id", targetUserId).eq("state", "published").eq("visibility", "public").limit(25);
  const postIds = (posts ?? []).map((p: any) => p.id);
  const memoryIds = (memories ?? []).map((m: any) => m.id);

  const likes: any[] = [];
  const comments: any[] = [];
  const saves: any[] = [];
  const memoryLikes: any[] = [];
  const memorySaves: any[] = [];

  friends.forEach((f, fi) => {
    // Each friend likes ~60% of posts and saves ~30%.
    postIds.forEach((postId, pi) => {
      const h = (fi * 7 + pi * 13) % 100;
      if (h < 60) {
        likes.push({ id: uuidv5(`post-like:${postId}:${f.id}`, SEED_NS), post_id: postId, user_id: f.id, created_at: dateDaysAgo(60 - fi - pi) });
      }
      if (h < 30) {
        saves.push({ id: uuidv5(`post-save:${postId}:${f.id}`, SEED_NS), post_id: postId, user_id: f.id, created_at: dateDaysAgo(55 - fi - pi) });
      }
      if (h < 25) {
        comments.push({ id: uuidv5(`post-comment:${postId}:${f.id}`, SEED_NS), post_id: postId, user_id: f.id, body: COMMENTS[(fi + pi) % COMMENTS.length], created_at: dateDaysAgo(50 - fi - pi) });
      }
    });
    // Each friend likes ~50% of public memories.
    memoryIds.forEach((memoryId, mi) => {
      const h = (fi * 11 + mi * 17) % 100;
      if (h < 50) {
        memoryLikes.push({ memory_id: memoryId, user_id: f.id, created_at: dateDaysAgo(45 - fi - mi) });
      }
      if (h < 20) {
        memorySaves.push({ memory_id: memoryId, user_id: f.id, created_at: dateDaysAgo(40 - fi - mi) });
      }
    });
  });

  const likeResult = await upsertRows("posts_likes", likes);
  const saveResult = await upsertRows("post_saves", saves);
  const commentResult = await upsertRows("posts_comments", comments);
  const mLikeResult = await upsertCompositeRows("memory_likes", memoryLikes, "memory_id,user_id");
  const mSaveResult = await upsertCompositeRows("memory_saves", memorySaves, "memory_id,user_id");
  return { likeResult, saveResult, commentResult, mLikeResult, mSaveResult };
}

async function seedVideoPostcard(targetUserId: string) {
  const postId = uuidv5(`video-postcard:${targetUserId}`, SEED_NS);
  const postcardId = uuidv5(`video-postcard-card:${targetUserId}`, SEED_NS);
  const { data: existingPostcard } = await sc.from("passport_postcards").select("id").eq("id", postcardId).maybeSingle();
  if (existingPostcard) return { inserted: 0, skipped: 1, postcardId };

  const { data: existingPost } = await sc.from("posts").select("id, content, location_name").eq("id", postId).maybeSingle();
  if (DRY_RUN) return { inserted: 1, skipped: 0, postcardId };

  const dest = { city: "Cebu", country: "Philippines", lat: 10.3157, lng: 123.8854 };
  const now = new Date().toISOString();
  const content = "Cebu island vibes — turquoise water, island hopping, and a sunset that wouldn't quit.";
  const locationName = `${dest.city}, ${dest.country}`;
  if (!existingPost) {
    const post = {
      id: postId,
      author_id: targetUserId,
      created_by: targetUserId,
      content,
      media_urls: [VIDEO_POSTCARD_URL],
      media_type: "video",
      location_name: locationName,
      location_city: dest.city,
      location_country: dest.country,
      location_lat: dest.lat,
      location_lng: dest.lng,
      location_place_id: `seed-place-cebu-video`,
      location_source: "manual",
      location_verified: true,
      location_verified_at: now,
      location_privacy_mode: "city_only",
      user_gps_lat: dest.lat,
      user_gps_lng: dest.lng,
      public_lat: dest.lat,
      public_lng: dest.lng,
      public_location_label: dest.city,
      visibility: "public",
      status: "active",
      post_status: "published",
      published_at: now,
      source: "seed_script",
      add_to_passport: true,
      created_at: now,
      updated_at: now,
      like_count: 0,
      comment_count: 0,
      save_count: 0,
      share_count: 0,
      likes_hidden: false,
      geotag_verified: true,
      geotag_credit_awarded: false,
      location_sensitivity_level: "low",
    };
    const { error: postErr } = await sc.from("posts").insert(post);
    if (postErr) throw postErr;
  }

  const postcard = {
    id: postcardId,
    post_id: postId,
    user_id: targetUserId,
    caption: existingPost?.content ?? content,
    media_url: VIDEO_POSTCARD_URL,
    // passport_postcards has NO `media_type`; the derived media columns are
    // (media_count, has_video, primary_media_type) — the exact trio
    // routes/postcards.ts::recomputePostcardMediaCounts writes. Naming
    // `media_type` had PostgREST reject the whole INSERT, so this seeder's
    // video postcard has never been created.
    media_count: 1,
    has_video: true,
    primary_media_type: "video",
    location_name: existingPost?.location_name ?? locationName,
    location_city: dest.city,
    location_country: dest.country,
    location_verified: true,
    verified_at: now,
    verification_method: "manual_only",
    verified_distance_meters: 0,
    stamp_eligible: true,
    stamp_reason: "seeded demo video postcard",
    stamp_style: "standard",
    status: "active",
    visibility: "public",
    created_at: now,
    updated_at: now,
  };
  const { error: cardErr } = await sc.from("passport_postcards").insert(postcard);
  if (cardErr) throw cardErr;

  await insertPostMedia(postId, targetUserId, "video", VIDEO_POSTCARD_URL, VIDEO_POSTCARD_THUMB, 15, 1280, 720);
  return { inserted: 1, skipped: 0, postcardId };
}

async function insertPostMedia(
  postId: string,
  userId: string,
  mediaType: string,
  publicUrl: string,
  thumbnailUrl: string | null,
  duration: number | null,
  width: number | null,
  height: number | null,
) {
  if (DRY_RUN) return { inserted: 0, skipped: 1 };
  const { data: existing } = await sc.from("post_media").select("id").eq("post_id", postId).maybeSingle();
  if (existing) return { inserted: 0, skipped: 1 };
  const now = new Date().toISOString();
  const row: any = {
    post_id: postId,
    user_id: userId,
    media_type: mediaType,
    storage_bucket: "post-media",
    storage_path: `${userId}/${postId}/media.${mediaType === "video" ? "mp4" : "jpg"}`,
    public_url: publicUrl,
    thumbnail_url: thumbnailUrl,
    mime_type: mediaType === "video" ? "video/mp4" : "image/jpeg",
    file_size_bytes: 1048576,
    duration_seconds: duration,
    width,
    height,
    processing_status: "ready",
    moderation_status: "approved",
    sort_order: 0,
    created_at: now,
    updated_at: now,
  };
  const { error } = await sc.from("post_media").insert(row);
  if (error) throw error;
  return { inserted: 1, skipped: 0 };
}

async function backfillPostMedia(targetUserId: string) {
  const { data: postcards } = await sc
    .from("passport_postcards")
    .select("post_id, media_url, location_city")
    .eq("user_id", targetUserId)
    .eq("status", "active")
    .eq("visibility", "public");
  const { data: mediaRows } = await sc.from("post_media").select("post_id").eq("user_id", targetUserId);
  const existingPostIds = new Set((mediaRows ?? []).map((m: any) => m.post_id));
  let inserted = 0;
  let skipped = 0;
  for (const pc of (postcards ?? []) as any[]) {
    if (existingPostIds.has(pc.post_id)) { skipped++; continue; }
    if (!pc.media_url || pc.media_url.includes("mp4")) continue; // skip video (handled separately) and empty
    const result = await insertPostMedia(pc.post_id, targetUserId, "image", pc.media_url, null, null, 800, 600);
    if (result.inserted) inserted++; else skipped++;
  }
  return { inserted, skipped };
}


async function main() {
  console.log(`Seeding demo social graph for ${EMAIL} (dry-run=${DRY_RUN})…`);
  const { profile } = await getTargetProfile();
  console.log(`Target profile: ${profile.id} @${profile.handle}`);

  const friends = await seedDemoFriends();
  console.log(`Created/updated ${friends.length} demo friend profiles`);

  const relResult = await seedRelationships(profile.id, friends);
  console.log(`Follows: ${relResult.followResult.inserted} inserted, ${relResult.followResult.skipped} skipped`);
  console.log(`Friendships: ${relResult.friendshipResult.inserted} inserted, ${relResult.friendshipResult.skipped} skipped`);
  console.log(`Friend requests: ${relResult.requestResult.inserted} inserted, ${relResult.requestResult.skipped} skipped`);

  const engResult = await seedEngagement(profile.id, friends);
  console.log(`Post likes: ${engResult.likeResult.inserted} inserted, ${engResult.likeResult.skipped} skipped`);
  console.log(`Post saves: ${engResult.saveResult.inserted} inserted, ${engResult.saveResult.skipped} skipped`);
  console.log(`Post comments: ${engResult.commentResult.inserted} inserted, ${engResult.commentResult.skipped} skipped`);
  console.log(`Memory likes: ${engResult.mLikeResult.inserted} inserted, ${engResult.mLikeResult.skipped} skipped`);
  console.log(`Memory saves: ${engResult.mSaveResult.inserted} inserted, ${engResult.mSaveResult.skipped} skipped`);

  const videoResult = await seedVideoPostcard(profile.id);
  console.log(`Video postcard: ${videoResult.inserted} inserted, ${videoResult.skipped} skipped (${videoResult.postcardId})`);

  const mediaResult = await backfillPostMedia(profile.id);
  console.log(`Post-media backfill: ${mediaResult.inserted} inserted, ${mediaResult.skipped} skipped`);

  const verifyResult = await verifyTargetProfile(profile.id);
  console.log(`Target verified: ${verifyResult.verified ? 'yes' : 'no'} (updated=${verifyResult.updated})`);

  console.log("Done.");
}

async function verifyTargetProfile(profileId: string) {
  if (DRY_RUN) return { verified: false, updated: false };
  const { data: profile } = await sc.from("profiles").select("verified, verification_status").eq("id", profileId).maybeSingle();
  const isVerified = profile?.verified === true && profile?.verification_status === "verified";
  if (isVerified) return { verified: true, updated: false };
  const now = new Date().toISOString();
  const { error } = await sc.from("profiles")
    .update({ verified: true, verification_status: "verified", verified_at: now })
    .eq("id", profileId);
  if (error) throw error;
  return { verified: true, updated: true };
}

main().catch((err) => { console.error(err); process.exit(1); });
