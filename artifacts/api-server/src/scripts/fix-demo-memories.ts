/**
 * One-time patch: bring the 20 existing demo memories for anrole up to the
 * richer seed format used by seedMemories in seed-demo-profile.ts.
 *
 * Makes every memory public, adds location fields, links matching public
 * events by city, and updates titles/captions to the destination-specific
 * content defined in the seed script.
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

const MEMORY_CONTENTS = [
  { city: "Tokyo", country: "Japan", title: "Tokyo after dark", caption: "Neon alleys, late-night ramen, and the hum of a city that never really sleeps." },
  { city: "Ubud", country: "Bali", title: "Bali sunrise", caption: "Rice terraces at dawn, the quiet before the town wakes up." },
  { city: "Cebu City", country: "Philippines", title: "Cebu energy", caption: "Island warmth, street food, and a city that feels like a welcome-home hug." },
  { city: "Bangkok", country: "Thailand", title: "Bangkok flavors", caption: "Markets, temples, and midnight snacks — every corner has a story." },
  { city: "Seoul", country: "South Korea", title: "Seoul lights", caption: "Han River breeze, rooftop coffee, and neighborhoods that blend old and new." },
  { city: "Paris", country: "France", title: "Parisian afternoon", caption: "Cobblestones, café windows, and that golden hour light over the Seine." },
  { city: "Rome", country: "Italy", title: "Rome in a day", caption: "Ancient stone, espresso stops, and getting wonderfully lost." },
  { city: "Oia", country: "Santorini", title: "Santorini blues", caption: "White walls, blue domes, and a sunset that really does live up to the hype." },
  { city: "Interlaken", country: "Switzerland", title: "Swiss Alps escape", caption: "Fresh air, mountain peaks, and a lake so clear it looks painted." },
  { city: "New York City", country: "USA", title: "New York moments", caption: "Skyline walks, deli coffee, and the city that always has another neighborhood to explore." },
  { city: "Miami", country: "USA", title: "Miami heat", caption: "Beach mornings, pastel streets, and nights that start late." },
  { city: "Mexico City", country: "Mexico", title: "Mexico City soul", caption: "Museums, tacos, and plazas full of music and color." },
  { city: "Dubai", country: "UAE", title: "Dubai contrasts", caption: "Desert dunes one hour, futuristic skyline the next." },
  { city: "Singapore", country: "Singapore", title: "Singapore gardens", caption: "Greens wrapped around steel, hawker stalls, and humid evenings." },
  { city: "Hong Kong", country: "Hong Kong", title: "Hong Kong pulse", caption: "Ferry rides, neon signs, and mountains rising right behind the towers." },
  { city: "Taipei", country: "Taiwan", title: "Taipei nights", caption: "Night markets, bubble tea, and friendly chaos around every stall." },
  { city: "Hanoi", country: "Vietnam", title: "Vietnam mornings", caption: "Old Quarter scooters, egg coffee, and a lake that slows the whole city down." },
  { city: "El Nido", country: "Philippines", title: "Palawan paradise", caption: "Limestone cliffs, turquoise water, and island hopping that felt like a dream." },
  { city: "General Luna", country: "Philippines", title: "Siargao sessions", caption: "Palm roads, surf breaks, and sunset beers with new friends." },
  { city: "Sydney", country: "Australia", title: "Australia coast", caption: "Harbor walks, coastal pools, and that laid-back energy." },
];

function dateDaysAgo(days: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

async function main() {
  // Resolve the target profile by email.
  const { data: list, error: authErr } = await sc.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (authErr) { console.error("Could not list auth users:", authErr.message); process.exit(1); }
  const user = (list?.users ?? []).find((u: any) => u.email?.toLowerCase() === EMAIL.toLowerCase());
  if (!user) { console.error(`Could not find auth user for ${EMAIL}`); process.exit(1); }
  const { data: profile, error: profileErr } = await sc
    .from("profiles")
    .select("id")
    .eq("id", user.id)
    .maybeSingle();
  if (profileErr || !profile) { console.error("Profile not found for", EMAIL); process.exit(1); }
  const profileId = profile.id;

  // Load events and trips for associations.
  const { data: events } = await sc
    .from("events")
    .select("id, city")
    .eq("host_id", profileId)
    .eq("visibility", "public")
    .not("state", "in", '("draft","cancelled","archived")');
  const { data: trips } = await sc
    .from("trips")
    .select("id, destination_city")
    .eq("owner_id", profileId)
    .order("created_at", { ascending: false });
  const tripByCity = new Map((trips ?? []).map((t: any) => [t.destination_city, t.id]));
  const eventByCity = new Map((events ?? []).map((e: any) => [e.city, e.id]));
  const tripIds = (trips ?? []).map((t) => t.id);

  let updated = 0;
  for (let i = 0; i < 20; i++) {
    const id = uuidv5(`memory:${profileId}:${i}`, SEED_NS);
    const content = MEMORY_CONTENTS[i];
    const dest = DESTINATIONS[i];
    const startAt = dateDaysAgo(600 - i * 28);
    const endAt = dateDaysAgo(600 - i * 28 - 1);
    const tripId = tripByCity.get(content.city) ?? tripIds[i % tripIds.length] ?? null;
    const eventId = eventByCity.get(content.city) ?? null;

    const patch = {
      title: content.title,
      caption: content.caption,
      visibility: "public",
      state: "published",
      trip_id: tripId,
      event_id: eventId,
      location_city: content.city,
      location_country: content.country,
      location_lat: dest.lat,
      location_lng: dest.lng,
      starts_at: startAt,
      ends_at: endAt,
      updated_at: endAt,
    };

    if (DRY_RUN) {
      console.log(`[DRY-RUN] would update ${id}:`, patch.title);
      continue;
    }

    const { error } = await sc.from("memories").update(patch).eq("id", id);
    if (error) { console.error("Update memory failed", id, error.message); } else { updated++; }

    const itemId = uuidv5(`memoryitem:${profileId}:${i}`, SEED_NS);
    const { error: itemErr } = await sc.from("memory_items").update({ caption: `${content.city} moment` }).eq("id", itemId);
    if (itemErr) { console.error("Update memory item failed", itemId, itemErr.message); }
  }
  console.log(`Updated ${updated} memories for ${EMAIL}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
