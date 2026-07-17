#!/usr/bin/env node
/**
 * Seed a realistic demo profile for end-to-end Passport/profile review.
 *
 * Populates the account identified by EMAIL (default: anroletrading@gmail.com)
 * with 20 generic trips, 20 postcards (linked to real posts), 20 follow
 * relationships, 20 passport stamps, 20 memories, and 20 highlights.
 *
 * Usage from artifacts/api-server:
 *   node --env-file-if-exists=.env --import tsx/esm src/scripts/seed-demo-profile.ts
 *
 * Idempotency: every seeded row uses a deterministic UUIDv5 derived from the
 * target profile id and a seed key. Re-running the script skips rows that
 * already exist, so it does not create uncontrolled duplicates.
 */

import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

const EMAIL = process.env.SEED_EMAIL ?? "anroletrading@gmail.com";
const DRY_RUN = process.env.SEED_DRY_RUN === "true";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.");
  process.exit(1);
}

const sc = createClient(url, key, { auth: { persistSession: false } });

// ── Deterministic UUID helper (UUIDv5-ish) ─────────────────────────────────────
function uuidv5(name: string, namespace: string): string {
  const hash = createHash("sha1").update(namespace + name).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50; // version 5
  hash[8] = (hash[8] & 0x3f) | 0x80; // variant 10
  const parts = [
    hash.subarray(0, 4).toString("hex"),
    hash.subarray(4, 6).toString("hex"),
    hash.subarray(6, 8).toString("hex"),
    hash.subarray(8, 10).toString("hex"),
    hash.subarray(10, 16).toString("hex"),
  ];
  return parts.join("-");
}

const SEED_NS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8"; // deterministic seed namespace

// ── Generic demo events ───────────────────────────────────────────────────────
const EVENT_CITIES = [
  { city: "Cebu", country: "Philippines", lat: 10.3157, lng: 123.8854 },
  { city: "Manila", country: "Philippines", lat: 14.5995, lng: 120.9842 },
  { city: "Siargao", country: "Philippines", lat: 9.8482, lng: 126.0454 },
  { city: "Palawan", country: "Philippines", lat: 9.834, lng: 118.7365 },
  { city: "Tokyo", country: "Japan", lat: 35.6762, lng: 139.6503 },
  { city: "Bangkok", country: "Thailand", lat: 13.7563, lng: 100.5018 },
  { city: "Seoul", country: "South Korea", lat: 37.5665, lng: 126.978 },
  { city: "Miami", country: "USA", lat: 25.7617, lng: -80.1918 },
  { city: "Fort Lauderdale", country: "USA", lat: 26.1224, lng: -80.1373 },
  { city: "Singapore", country: "Singapore", lat: 1.3521, lng: 103.8198 },
  { city: "Hong Kong", country: "Hong Kong", lat: 22.3193, lng: 114.1694 },
  { city: "Taipei", country: "Taiwan", lat: 25.033, lng: 121.5654 },
  { city: "Hanoi", country: "Vietnam", lat: 21.0278, lng: 105.8342 },
];

const EVENT_TITLES = [
  { title: "Sunset rooftop drinks", category: "nightlife", duration: 3, max: 24 },
  { title: "Local food crawl", category: "food crawl", duration: 4, max: 12 },
  { title: "Beach day & island hopping", category: "beach day", duration: 6, max: 16 },
  { title: "Hidden waterfall hike", category: "hiking", duration: 5, max: 10 },
  { title: "Live indie concert night", category: "concert", duration: 4, max: 40 },
  { title: "Morning coffee meetup", category: "coffee meetup", duration: 2, max: 8 },
  { title: "Old town walking tour", category: "city walk", duration: 3, max: 15 },
  { title: "Rooftop bar hop", category: "rooftop drinks", duration: 4, max: 20 },
  { title: "Museum & culture visit", category: "museum visit", duration: 3, max: 14 },
  { title: "Language exchange dinner", category: "language exchange", duration: 3, max: 12 },
  { title: "Night market shopping run", category: "shopping", duration: 3, max: 18 },
  { title: "Golden hour photography walk", category: "photography walk", duration: 2, max: 10 },
  { title: "Beach yoga & wellness", category: "wellness", duration: 2, max: 20 },
  { title: "Island hopping boat trip", category: "island hopping", duration: 7, max: 22 },
  { title: "Hidden gem neighborhood tour", category: "local hidden-gem", duration: 3, max: 12 },
  { title: "Sunrise temple visit", category: "city walk", duration: 3, max: 16 },
  { title: "Beach bonfire & music", category: "nightlife", duration: 4, max: 30 },
  { title: "Cooking class & market tour", category: "food crawl", duration: 4, max: 10 },
  { title: "Coastal cliff hike", category: "hiking", duration: 5, max: 14 },
  { title: "Sunset sailing trip", category: "island hopping", duration: 4, max: 12 },
];

// ── Generic demo destinations ───────────────────────────────────────────────
const DESTINATIONS = [
  { city: "Tokyo", country: "Japan", lat: 35.6762, lng: 139.6503 },
  { city: "Ubud", country: "Bali", lat: -8.5069, lng: 115.2625 },
  { city: "Cebu City", country: "Philippines", lat: 10.3157, lng: 123.8854 },
  { city: "Bangkok", country: "Thailand", lat: 13.7563, lng: 100.5018 },
  { city: "Seoul", country: "South Korea", lat: 37.5665, lng: 126.978 },
  { city: "Paris", country: "France", lat: 48.8566, lng: 2.3522 },
  { city: "Rome", country: "Italy", lat: 41.9028, lng: 12.4964 },
  { city: "Oia", country: "Santorini", lat: 36.4618, lng: 25.3753 },
  { city: "Interlaken", country: "Switzerland", lat: 46.6863, lng: 7.8632 },
  { city: "New York City", country: "USA", lat: 40.7128, lng: -74.006 },
  { city: "Miami", country: "USA", lat: 25.7617, lng: -80.1918 },
  { city: "Mexico City", country: "Mexico", lat: 19.4326, lng: -99.1332 },
  { city: "Dubai", country: "UAE", lat: 25.2048, lng: 55.2708 },
  { city: "Singapore", country: "Singapore", lat: 1.3521, lng: 103.8198 },
  { city: "Hong Kong", country: "Hong Kong", lat: 22.3193, lng: 114.1694 },
  { city: "Taipei", country: "Taiwan", lat: 25.033, lng: 121.5654 },
  { city: "Hanoi", country: "Vietnam", lat: 21.0278, lng: 105.8342 },
  { city: "El Nido", country: "Philippines", lat: 11.2097, lng: 119.4623 },
  { city: "General Luna", country: "Philippines", lat: 9.8482, lng: 126.0454 },
  { city: "Sydney", country: "Australia", lat: -33.8688, lng: 151.2093 },
];

const CAPTIONS = [
  "First light over the city — unforgettable.",
  "Hidden alleyways and endless discoveries.",
  "Street food tour that turned into a feast.",
  "Took the long route and it paid off.",
  "Coffee, culture, and conversations.",
  "Sunset views that made the whole trip worth it.",
  "Woke up early for this golden hour.",
  "Lost track of time wandering here.",
  "A local recommendation I will never forget.",
  "Already planning the return trip.",
  "Best meal of the year, hands down.",
  "Markets, temples, and midnight snacks.",
  "Felt like a postcard come to life.",
  "One of those days you wish you could bottle.",
  "Explored on foot and found the good stuff.",
  "Rain or shine, this city delivers.",
  "Swapped itineraries for spontaneity.",
  "The kind of place that changes you a little.",
  "Dinner with a view I will be chasing forever.",
  "Traveled far, laughed hard, slept little.",
];

const TRIP_TITLES = [
  "Solo escape to",
  "Backpacking",
  "Weekend in",
  "Food tour of",
  "Adventure through",
  "Cultural dive in",
  "Photography trip to",
  "Relaxing retreat in",
  "City hopping",
  "Hidden gems of",
  "Summer in",
  "Winter break in",
  "Road trip to",
  "Island hopping",
  "First visit to",
  "Return trip to",
  "Quick getaway to",
  "Dream destination:",
  "Exploring",
  "Highlights of",
];

const STAMP_TYPES = [
  "verification", "destination", "event", "trip", "achievement", "host", "rent_a_buddy",
];

function mediaUrl(seed: string, width = 800, height = 600) {
  return `https://picsum.photos/seed/${seed}/${width}/${height}`;
}

function dateDaysAgo(days: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

function tripDates(index: number) {
  const startOffset = 600 - index * 28; // spread over ~2 years, newest first
  const duration = 3 + (index % 12); // 3–14 days
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - startOffset);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + duration);
  return { start: start.toISOString(), end: end.toISOString() };
}

// ── Find target profile ───────────────────────────────────────────────────────
async function getTargetProfile() {
  // Auth users are not exposed via REST without RPC; use the admin API to list users and filter by email.
  const { data: list, error: authErr } = await sc.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (authErr) {
    console.error(`Could not list auth users:`, authErr?.message);
    process.exit(1);
  }
  const user = (list?.users ?? []).find((u: any) => u.email?.toLowerCase() === EMAIL.toLowerCase());
  if (!user) {
    console.error(`Could not find auth user for ${EMAIL}`);
    process.exit(1);
  }
  const userId = user.id;
  const { data: profile, error: profileErr } = await sc
    .from("profiles")
    .select("id, handle, display_name, passport_visibility")
    .eq("id", userId)
    .maybeSingle();
  if (profileErr || !profile) {
    console.error(`Could not find profile for ${EMAIL}:`, profileErr?.message);
    process.exit(1);
  }
  return profile;
}

async function getOtherProfiles(excludeId: string, limit = 25) {
  const { data, error } = await sc
    .from("profiles")
    .select("id, handle")
    .neq("id", excludeId)
    .limit(limit);
  if (error) throw error;
  return (data ?? []).filter((p) => p.id !== excludeId);
}

async function getStampDefinitions(limit = 25) {
  const { data, error } = await sc
    .from("stamp_definitions")
    .select("id, slug, stamp_type, name, city, country")
    .eq("is_active", true)
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}

// ── Seed helpers ──────────────────────────────────────────────────────────────
async function upsertRows(table: string, rows: any[], idField = "id") {
  if (rows.length === 0) return { inserted: 0, skipped: 0 };
  if (DRY_RUN) {
    console.log(`[DRY-RUN] would insert ${rows.length} rows into ${table}`);
    return { inserted: 0, skipped: rows.length };
  }
  const ids = rows.map((r) => r[idField]);
  const { data: existing } = await sc.from(table).select(idField).in(idField, ids);
  const existingSet = new Set((existing ?? []).map((r: any) => r[idField]));
  const toInsert = rows.filter((r) => !existingSet.has(r[idField]));
  if (toInsert.length === 0) return { inserted: 0, skipped: rows.length };
  const { error } = await sc.from(table).insert(toInsert);
  if (error) {
    console.error(`Insert into ${table} failed:`, error.message);
    throw error;
  }
  return { inserted: toInsert.length, skipped: rows.length - toInsert.length };
}

async function seedTrips(profileId: string) {
  const rows = DESTINATIONS.map((dest, i) => {
    const { start, end } = tripDates(i);
    const id = uuidv5(`trip:${profileId}:${i}`, SEED_NS);
    const statusPool: any[] = ["completed", "completed", "active", "upcoming", "planning"];
    const status = statusPool[i % statusPool.length];
    const visibility: any = i % 5 === 0 ? "private" : i % 4 === 0 ? "buddies" : "public";
    return {
      id,
      owner_id: profileId,
      title: `${TRIP_TITLES[i]} ${dest.city}`,
      destination_city: dest.city,
      destination_country: dest.country,
      destination_lat: dest.lat,
      destination_lng: dest.lng,
      start_date: start,
      end_date: end,
      status,
      visibility,
      show_on_profile: true,
      show_in_discovery: visibility === "public",
      show_destination_city: true,
      show_exact_dates: true,
      allow_friend_suggestions: true,
      allow_join_requests: visibility !== "private",
      allow_trip_crew_invites: true,
      open_to_meet: visibility === "public",
      timezone: "UTC",
      cover_url: mediaUrl(`trip-cover-${i}`, 1200, 800),
      progress: status === "completed" ? 100 : status === "active" ? 45 : 0,
      created_at: dateDaysAgo(600 - i * 28 + 14),
      updated_at: dateDaysAgo(600 - i * 28 + 14),
    };
  });
  return upsertRows("trips", rows);
}

async function seedPostsAndPostcards(profileId: string) {
  // Need trip ids to associate postcards with trips.
  const { data: trips } = await sc
    .from("trips")
    .select("id, destination_city, destination_country, destination_lat, destination_lng, owner_id")
    .eq("owner_id", profileId)
    .order("created_at", { ascending: false });
  const tripRows = trips ?? [];

  const posts = DESTINATIONS.map((dest, i) => {
    const id = uuidv5(`post:${profileId}:${i}`, SEED_NS);
    const trip = tripRows[i] ?? null;
    const visibility: any = i % 6 === 0 ? "private" : i % 5 === 0 ? "trip_only" : "public";
    return {
      id,
      author_id: profileId,
      created_by: profileId,
      content: CAPTIONS[i],
      media_urls: [mediaUrl(`postcard-${i}`, 800, 600)],
      media_type: "image",
      location_name: `${dest.city}, ${dest.country}`,
      location_city: dest.city,
      location_country: dest.country,
      location_lat: dest.lat,
      location_lng: dest.lng,
      location_place_id: `seed-place-${dest.city.toLowerCase().replace(/\s+/g, "-")}`,
      location_source: "manual",
      location_verified: true,
      location_verified_at: dateDaysAgo(600 - i * 28),
      location_privacy_mode: "city_only",
      user_gps_lat: dest.lat,
      user_gps_lng: dest.lng,
      public_lat: dest.lat,
      public_lng: dest.lng,
      public_location_label: dest.city,
      visibility,
      status: "active" as any,
      post_status: "published" as any,
      published_at: dateDaysAgo(600 - i * 28),
      source: "seed_script",
      add_to_passport: true,
      trip_id: trip?.id ?? null,
      created_at: dateDaysAgo(600 - i * 28),
      updated_at: dateDaysAgo(600 - i * 28),
    };
  });
  const postResult = await upsertRows("posts", posts);

  const postcards = posts.map((post, i) => {
    const id = uuidv5(`postcard:${profileId}:${i}`, SEED_NS);
    const dest = DESTINATIONS[i];
    return {
      id,
      post_id: post.id,
      user_id: profileId,
      caption: post.content,
      media_url: post.media_urls[0],
      location_name: post.location_name,
      location_city: dest.city,
      location_country: dest.country,
      location_verified: true,
      verified_at: post.published_at,
      verification_method: "manual_only" as any,
      verified_distance_meters: 0,
      stamp_eligible: true,
      stamp_reason: "seeded demo content",
      stamp_style: "standard",
      status: "active" as any,
      visibility: post.visibility,
      created_at: post.created_at,
      updated_at: post.updated_at,
    };
  });
  const postcardResult = await upsertRows("passport_postcards", postcards);
  return { postResult, postcardResult };
}

async function seedFollows(profileId: string, others: { id: string }[]) {
  const rows = others.slice(0, 20).map((other, i) => ({
    follower_id: profileId,
    following_id: other.id,
    created_at: dateDaysAgo(400 - i * 18),
  }));
  // user_follows has no id column; deduplicate by the composite key manually.
  const { data: existing } = await sc
    .from("user_follows")
    .select("follower_id, following_id")
    .eq("follower_id", profileId);
  const existingSet = new Set((existing ?? []).map((r: any) => `${r.follower_id}:${r.following_id}`));
  const toInsert = rows.filter((r) => !existingSet.has(`${r.follower_id}:${r.following_id}`));
  if (DRY_RUN) {
    console.log(`[DRY-RUN] would insert ${toInsert.length} user_follows`);
    return { inserted: 0, skipped: rows.length };
  }
  if (toInsert.length === 0) return { inserted: 0, skipped: rows.length };
  const { error } = await sc.from("user_follows").insert(toInsert);
  if (error) throw error;
  return { inserted: toInsert.length, skipped: rows.length - toInsert.length };
}

async function seedStamps(profileId: string) {
  const rows = DESTINATIONS.map((dest, i) => {
    const id = uuidv5(`stamp:${profileId}:${i}`, SEED_NS);
    return {
      id,
      user_id: profileId,
      stamp_type: STAMP_TYPES[i % STAMP_TYPES.length],
      city: dest.city,
      country: dest.country,
      awarded_at: dateDaysAgo(600 - i * 28),
      created_at: dateDaysAgo(600 - i * 28),
    };
  });
  return upsertRows("passport_stamps", rows);
}

async function seedUserStamps(profileId: string, definitions: { id: string }[]) {
  const rows = definitions.slice(0, 20).map((def, i) => {
    const id = uuidv5(`userstamp:${profileId}:${i}`, SEED_NS);
    const dest = DESTINATIONS[i % DESTINATIONS.length];
    return {
      id,
      user_id: profileId,
      stamp_definition_id: def.id,
      earned_at: dateDaysAgo(500 - i * 22),
      created_at: dateDaysAgo(500 - i * 22),
      display_on_passport: true,
      is_revoked: false,
      city: dest.city,
      country: dest.country,
      lat: dest.lat,
      lng: dest.lng,
      source_type: "seed_script",
      source_id: null,
      visibility: "public",
    };
  });
  return upsertRows("user_stamps", rows);
}

async function seedMemories(profileId: string) {
  const { data: trips } = await sc
    .from("trips")
    .select("id")
    .eq("owner_id", profileId)
    .order("created_at", { ascending: false });
  const tripIds = (trips ?? []).map((t) => t.id);

  const memories = DESTINATIONS.map((dest, i) => {
    const id = uuidv5(`memory:${profileId}:${i}`, SEED_NS);
    const visibility = i % 5 === 0 ? "only_me" : i % 4 === 0 ? "friends_only" : "public";
    const state = "published";
    return {
      id,
      owner_id: profileId,
      trip_id: tripIds[i % tripIds.length] ?? null,
      title: `Memory from ${dest.city}`,
      caption: CAPTIONS[(i + 5) % CAPTIONS.length],
      visibility,
      state,
      starts_at: dateDaysAgo(600 - i * 28),
      ends_at: dateDaysAgo(600 - i * 28 - 1),
      allowed_user_ids: [],
      hidden_user_ids: [],
      created_at: dateDaysAgo(600 - i * 28),
      updated_at: dateDaysAgo(600 - i * 28),
    };
  });
  const memoryResult = await upsertRows("memories", memories);

  const items = memories.map((m, i) => {
    const id = uuidv5(`memoryitem:${profileId}:${i}`, SEED_NS);
    const dest = DESTINATIONS[i];
    return {
      id,
      memory_id: m.id,
      media_url: mediaUrl(`memory-${i}`, 800, 600),
      media_type: "image",
      caption: `${dest.city} moment`,
      position: 0,
      created_at: m.created_at,
    };
  });
  const itemResult = await upsertRows("memory_items", items);
  return { memoryResult, itemResult };
}

async function seedHighlights(profileId: string) {
  const rows = DESTINATIONS.map((dest, i) => {
    const id = uuidv5(`highlight:${profileId}:${i}`, SEED_NS);
    const expiresAt = new Date();
    expiresAt.setUTCDate(expiresAt.getUTCDate() + 1 + (i % 7));
    const visibility = i % 4 === 0 ? "circle_only" : i % 3 === 0 ? "trip_only" : "public";
    return {
      id,
      owner_id: profileId,
      media_url: mediaUrl(`highlight-${i}`, 800, 600),
      media_type: "image",
      caption: `Highlight: ${dest.city}`,
      location_name: dest.city,
      location_city: dest.city,
      location_country: dest.country,
      visibility,
      expires_at: expiresAt.toISOString(),
      created_at: dateDaysAgo(10 - i),
    };
  });
  return upsertRows("highlights", rows);
}

async function seedEvents(profileId: string) {
  const now = new Date();
  const events = EVENT_TITLES.map((template, i) => {
    const id = uuidv5(`event:${profileId}:${i}`, SEED_NS);
    const loc = EVENT_CITIES[i % EVENT_CITIES.length];
    const isPast = i < 7;
    const isSoon = i >= 7 && i < 13;
    const start = new Date(now);
    if (isPast) {
      start.setUTCDate(start.getUTCDate() - (14 + i * 3));
    } else if (isSoon) {
      start.setUTCDate(start.getUTCDate() + (i - 7));
      start.setUTCHours(18 + (i % 3), 0, 0, 0);
    } else {
      start.setUTCDate(start.getUTCDate() + (7 + (i - 13) * 5));
      start.setUTCHours(10 + (i % 8), 0, 0, 0);
    }
    const end = new Date(start);
    end.setUTCHours(start.getUTCHours() + template.duration);

    const state = isPast ? "completed" : isSoon ? "open" : "open";
    const visibility = i % 5 === 0 ? "friends_only" : i % 7 === 0 ? "invite_only" : "public";
    const maxAttendees = template.max;
    const goingCount = Math.min(1 + (i % 5), maxAttendees);
    const createdAt = isPast ? dateDaysAgo(20 + i * 2) : dateDaysAgo(2);

    return {
      id,
      host_id: profileId,
      title: template.title,
      description: `A ${template.category} experience in ${loc.city}. Open to travelers who want to connect, explore, and share the moment.`,
      city: loc.city,
      country: loc.country,
      location_name: `${loc.city}, ${loc.country}`,
      location_lat: loc.lat,
      location_lng: loc.lng,
      starts_at: start.toISOString(),
      ends_at: end.toISOString(),
      cover_url: mediaUrl(`event-cover-${i}`, 1200, 800),
      max_attendees: maxAttendees,
      going_count: goingCount,
      waitlist_count: 0,
      state,
      visibility,
      category: template.category,
      tags: [template.category, "demo", loc.city.toLowerCase().replace(/\s+/g, "-")],
      rsvp_options: ["going", "maybe", "interested", "cant_go"],
      rsvp_closed: false,
      price_type: i % 3 === 0 ? "free" : "external",
      price_url: i % 3 === 0 ? null : "https://example.com/tickets",
      ticket_url: i % 3 === 0 ? null : "https://example.com/tickets",
      age_min: 18,
      age_max: 65,
      trust_score_min: 0,
      verified_only: i % 4 === 0,
      waitlist_enabled: true,
      chat_enabled: true,
      attendee_comments_enabled: true,
      show_exact_location: true,
      safety_notes: i % 4 === 0 ? "Please bring ID and arrive 15 minutes early." : null,
      is_recurring: false,
      recurring_config: null,
      trip_id: null,
      circle_id: null,
      chat_thread_id: null,
      created_at: createdAt,
      updated_at: createdAt,
    };
  });
  const eventResult = await upsertRows("events", events);

  // Insert host role, RSVP, and attendee rows for each seeded event.
  const hostRoleRows = events.map((ev) => ({
    event_id: ev.id,
    user_id: profileId,
    role: "host",
    created_at: ev.created_at,
  }));
  const hostRoleResult = await upsertCompositeRows("event_roles", hostRoleRows, "event_id,user_id");

  const rsvpRows = events.map((ev) => ({
    event_id: ev.id,
    user_id: profileId,
    status: "going",
    created_at: ev.created_at,
    updated_at: ev.created_at,
  }));
  const rsvpResult = await upsertCompositeRows("event_rsvps", rsvpRows, "event_id,user_id");

  const attendeeRows = events.map((ev) => ({
    event_id: ev.id,
    user_id: profileId,
    added_at: ev.created_at,
  }));
  const attendeeResult = await upsertCompositeRows("event_attendees", attendeeRows, "event_id,user_id");

  return { eventResult, hostRoleResult, rsvpResult, attendeeResult };
}

async function upsertCompositeRows(table: string, rows: any[], conflictFields: string) {
  if (rows.length === 0) return { inserted: 0, skipped: 0 };
  if (DRY_RUN) {
    console.log(`[DRY-RUN] would insert ${rows.length} rows into ${table}`);
    return { inserted: 0, skipped: rows.length };
  }
  const eventIds = [...new Set(rows.map((r) => r.event_id))];
  const { data: existing } = await sc
    .from(table)
    .select(`event_id,user_id`)
    .in("event_id", eventIds);
  const existingSet = new Set((existing ?? []).map((r: any) => `${r.event_id}:${r.user_id}`));
  const toInsert = rows.filter((r) => !existingSet.has(`${r.event_id}:${r.user_id}`));
  if (toInsert.length === 0) return { inserted: 0, skipped: rows.length };
  const { error } = await sc.from(table).upsert(toInsert, { onConflict: conflictFields });
  if (error) {
    console.error(`Insert into ${table} failed:`, error.message);
    throw error;
  }
  return { inserted: toInsert.length, skipped: rows.length - toInsert.length };
}

// ── Main ────────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Seeding demo content for ${EMAIL} (dry-run=${DRY_RUN})…`);

  const profile = await getTargetProfile();
  console.log(`Target profile: ${profile.id} @${profile.handle} (${profile.display_name})`);

  const [others, definitions] = await Promise.all([
    getOtherProfiles(profile.id),
    getStampDefinitions(30),
  ]);
  console.log(`Found ${others.length} other profiles, ${definitions.length} stamp definitions`);

  if (others.length < 20) {
    console.warn("Warning: fewer than 20 other profiles exist; some follow rows will be skipped.");
  }
  if (definitions.length < 20) {
    console.warn("Warning: fewer than 20 stamp definitions exist; some user_stamps will be skipped.");
  }

  const tripResult = await seedTrips(profile.id);
  const { postResult, postcardResult } = await seedPostsAndPostcards(profile.id);
  const followResult = await seedFollows(profile.id, others);
  const stampResult = await seedStamps(profile.id);
  const userStampResult = await seedUserStamps(profile.id, definitions);
  const { memoryResult, itemResult } = await seedMemories(profile.id);
  const highlightResult = await seedHighlights(profile.id);
  const { eventResult, hostRoleResult, rsvpResult, attendeeResult } = await seedEvents(profile.id);

  console.log("\nSeeding summary:");
  console.log(`  Trips:          ${tripResult.inserted} inserted, ${tripResult.skipped} skipped`);
  console.log(`  Posts:          ${postResult.inserted} inserted, ${postResult.skipped} skipped`);
  console.log(`  Postcards:      ${postcardResult.inserted} inserted, ${postcardResult.skipped} skipped`);
  console.log(`  Follows:        ${followResult.inserted} inserted, ${followResult.skipped} skipped`);
  console.log(`  Passport Stamps: ${stampResult.inserted} inserted, ${stampResult.skipped} skipped`);
  console.log(`  User Stamps:    ${userStampResult.inserted} inserted, ${userStampResult.skipped} skipped`);
  console.log(`  Memories:       ${memoryResult.inserted} inserted, ${memoryResult.skipped} skipped`);
  console.log(`  Memory Items:   ${itemResult.inserted} inserted, ${itemResult.skipped} skipped`);
  console.log(`  Highlights:     ${highlightResult.inserted} inserted, ${highlightResult.skipped} skipped`);
  console.log(`  Events:         ${eventResult.inserted} inserted, ${eventResult.skipped} skipped`);
  console.log(`  Event Host Roles: ${hostRoleResult.inserted} inserted, ${hostRoleResult.skipped} skipped`);
  console.log(`  Event RSVPs:    ${rsvpResult.inserted} inserted, ${rsvpResult.skipped} skipped`);
  console.log(`  Event Attendees: ${attendeeResult.inserted} inserted, ${attendeeResult.skipped} skipped`);

  console.log("\nDone. Re-run the script anytime; it will skip rows that already exist.");
}

main().catch((err) => {
  console.error("Seed script failed:", err);
  process.exit(1);
});
