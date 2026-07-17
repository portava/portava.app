/**
 * One-time patch: upgrade the 20 deterministic demo user_stamps and
 * passport_stamps for anrole so they form a realistic, geotagged mix of
 * every available stamp category.
 *
 * Mirrors the logic in seed-demo-profile.ts after the stamp-selection update.
 */

import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

const EMAIL = process.env.SEED_EMAIL ?? "anroletrading@gmail.com";
const DRY_RUN = process.env.SEED_DRY_RUN === "true";
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error("Missing env"); process.exit(1); }
const sc = createClient(url, key, { auth: { persistSession: false } });

function uuidv5(name: string, namespace: string): string {
  const hash = createHash("sha1").update(namespace + name).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const parts = [
    hash.subarray(0, 4).toString("hex"),
    hash.subarray(4, 6).toString("hex"),
    hash.subarray(6, 8).toString("hex"),
    hash.subarray(8, 10).toString("hex"),
    hash.subarray(10, 16).toString("hex"),
  ];
  return parts.join("-");
}

const SEED_NS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

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

const STAMP_SELECTIONS = [
  { slug: "first_trip_created", category: "trip" },
  { slug: "first_trip_completed", category: "trip" },
  { slug: "solo_traveler", category: "trip" },
  { slug: "group_tripper", category: "trip" },
  { slug: "weekend_wanderer", category: "trip" },
  { slug: "city_explorer", category: "location" },
  { slug: "globe_trotter", category: "location" },
  { slug: "world_citizen", category: "location" },
  { slug: "first_postcard", category: "community" },
  { slug: "first_post", category: "community" },
  { slug: "trip_planner", category: "community" },
  { slug: "community_connector", category: "community" },
  { slug: "storyteller", category: "community" },
  { slug: "event_host", category: "event" },
  { slug: "event_participant", category: "event" },
  { slug: "first_event_joined", category: "event" },
  { slug: "safe_return_ready", category: "safety" },
  { slug: "verified_traveler", category: "trust" },
  { slug: "early_adopter", category: "special" },
  { slug: "first_buddy_hosted", category: "rent_buddy" },
];

const PASSPORT_STAMP_TYPE_MAP: Record<string, string> = {
  trip: "trip",
  location: "destination",
  community: "destination",
  event: "event",
  safety: "achievement",
  trust: "verification",
  special: "achievement",
  rent_buddy: "rent_a_buddy",
};

function dateDaysAgo(days: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

async function main() {
  const { data: list, error: authErr } = await sc.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (authErr) { console.error("Could not list auth users:", authErr.message); process.exit(1); }
  const user = (list?.users ?? []).find((u: any) => u.email?.toLowerCase() === EMAIL.toLowerCase());
  if (!user) { console.error(`Could not find auth user for ${EMAIL}`); process.exit(1); }
  const { data: profile, error: profileErr } = await sc.from("profiles").select("id").eq("id", user.id).maybeSingle();
  if (profileErr || !profile) { console.error("Profile not found for", EMAIL); process.exit(1); }
  const profileId = profile.id;

  // Load catalog and related demo rows.
  const { data: definitions } = await sc.from("stamp_definitions").select("id, slug, source_system, category").eq("is_active", true);
  const defBySlug = new Map((definitions ?? []).map((d: any) => [d.slug, d]));
  const [{ data: trips }, { data: events }, { data: postcards }, { data: posts }] = await Promise.all([
    sc.from("trips").select("id, destination_city").eq("owner_id", profileId),
    sc.from("events").select("id, city").eq("host_id", profileId).eq("visibility", "public").not("state", "in", '("draft","cancelled","archived")'),
    sc.from("passport_postcards").select("id, location_city").eq("user_id", profileId).eq("status", "active"),
    sc.from("posts").select("id, location_city").eq("author_id", profileId).eq("status", "active"),
  ]);
  const tripByCity = new Map((trips ?? []).map((t: any) => [t.destination_city, t.id]));
  const eventByCity = new Map((events ?? []).map((e: any) => [e.city, e.id]));
  const postcardByCity = new Map((postcards ?? []).map((p: any) => [p.location_city, p.id]));
  const postByCity = new Map((posts ?? []).map((p: any) => [p.location_city, p.id]));

  let userStampUpdated = 0;
  let passportStampUpdated = 0;
  let missingDefs = 0;

  for (let i = 0; i < 20; i++) {
    const selection = STAMP_SELECTIONS[i];
    const def = defBySlug.get(selection.slug);
    if (!def) { console.warn(`Missing stamp definition: ${selection.slug}`); missingDefs++; continue; }
    const id = uuidv5(`userstamp:${profileId}:${i}`, SEED_NS);
    const dest = DESTINATIONS[i % DESTINATIONS.length];
    const sourceSystem = def.source_system ?? selection.category;
    let sourceType = sourceSystem;
    let sourceId: string | null = null;
    if (sourceSystem === "trips" || selection.category === "trip") {
      sourceType = "trips";
      sourceId = tripByCity.get(dest.city) ?? null;
    } else if (sourceSystem === "events" || selection.category === "event") {
      sourceType = "events";
      sourceId = eventByCity.get(dest.city) ?? null;
    } else if (sourceSystem === "posts" || selection.category === "community" || selection.category === "location") {
      sourceType = "posts";
      sourceId = postcardByCity.get(dest.city) ?? null;
    } else if (sourceSystem === "rent_buddy") {
      sourceType = "rent_buddy";
    } else if (sourceSystem === "safe_return") {
      sourceType = "safe_return";
    } else if (selection.category === "trust") {
      sourceType = "verification";
    } else if (selection.category === "special") {
      sourceType = "seed_script";
    }

    const patch = {
      stamp_definition_id: def.id,
      city: dest.city,
      country: dest.country,
      lat: dest.lat,
      lng: dest.lng,
      source_type: sourceType,
      source_id: sourceId,
      visibility: "public",
      display_on_passport: true,
      is_revoked: false,
      earned_at: dateDaysAgo(500 - i * 22),
    };

    if (DRY_RUN) {
      console.log(`[DRY-RUN] user_stamp ${id}: ${selection.slug} @ ${dest.city} (source=${sourceType}/${sourceId ?? "none"})`);
    } else {
      const { error } = await sc.from("user_stamps").update(patch).eq("id", id);
      if (error) { console.error(`Update user_stamp ${id} failed:`, error.message); } else { userStampUpdated++; }
    }

    const passportId = uuidv5(`stamp:${profileId}:${i}`, SEED_NS);
    const passportPatch = {
      stamp_type: PASSPORT_STAMP_TYPE_MAP[selection.category] ?? "trip",
      city: dest.city,
      country: dest.country,
      awarded_at: dateDaysAgo(600 - i * 28),
    };
    if (DRY_RUN) {
      console.log(`[DRY-RUN] passport_stamp ${passportId}: ${selection.category} @ ${dest.city}`);
    } else {
      const { error } = await sc.from("passport_stamps").update(passportPatch).eq("id", passportId);
      if (error) { console.error(`Update passport_stamp ${passportId} failed:`, error.message); } else { passportStampUpdated++; }
    }
  }

  console.log(`Updated ${userStampUpdated} user_stamps and ${passportStampUpdated} passport_stamps for ${EMAIL}`);
  if (missingDefs > 0) console.warn(`Skipped ${missingDefs} selections because their definitions were not found`);
}

main().catch((err) => { console.error(err); process.exit(1); });
