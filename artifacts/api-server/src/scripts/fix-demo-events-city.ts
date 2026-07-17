/**
 * One-time patch: populate city/country on demo events seeded before the
 * seed script included those columns. Safe to re-run.
 */

import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error("Missing env"); process.exit(1); }

const sc = createClient(url, key, { auth: { persistSession: false } });
const ns = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const pid = "92602b6c-0eca-433d-9ee2-a82696b3837f";
const cities = [
  { city: "Cebu", country: "Philippines" },
  { city: "Manila", country: "Philippines" },
  { city: "Siargao", country: "Philippines" },
  { city: "Palawan", country: "Philippines" },
  { city: "Tokyo", country: "Japan" },
  { city: "Bangkok", country: "Thailand" },
  { city: "Seoul", country: "South Korea" },
  { city: "Miami", country: "USA" },
  { city: "Fort Lauderdale", country: "USA" },
  { city: "Singapore", country: "Singapore" },
  { city: "Hong Kong", country: "Hong Kong" },
  { city: "Taipei", country: "Taiwan" },
  { city: "Hanoi", country: "Vietnam" },
];

function uuidv5(name: string, namespace: string): string {
  const h = createHash("sha1").update(namespace + name).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  return [h.subarray(0, 4), h.subarray(4, 6), h.subarray(6, 8), h.subarray(8, 10), h.subarray(10, 16)].map((b) => b.toString("hex")).join("-");
}

async function main() {
  let updated = 0;
  for (let i = 0; i < 20; i++) {
    const id = uuidv5(`event:${pid}:${i}`, ns);
    const loc = cities[i % cities.length];
    const { error } = await sc.from("events").update({ city: loc.city, country: loc.country }).eq("id", id);
    if (error) { console.error("update", i, error.message); } else { updated++; }
  }
  console.log(`Updated ${updated} events`);
}

main().catch((err) => { console.error(err); process.exit(1); });
