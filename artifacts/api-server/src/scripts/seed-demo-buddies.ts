/**
 * Seed demo Rent a Buddy profiles + AI companion for anroletrading@gmail.com.
 *
 * Creates:
 *  • anroletrading@gmail.com as an active Buddy in Miami (if not already one)
 *  • 5 distinct demo Buddy profiles in Miami (varied categories)
 *  • 1 AI demo companion/bot user — added as a friend + Telegraph conversation
 *  • Ensures Miami is live in rent_buddy_city_rollouts (public_mvp)
 *  • Ensures rent_buddy_enabled feature flag is ON
 *
 * Usage from artifacts/api-server:
 *   node --env-file-if-exists=.env --import tsx/esm src/scripts/seed-demo-buddies.ts
 *
 * Env:
 *   SEED_EMAIL    — target account (default: anroletrading@gmail.com)
 *   SEED_DRY_RUN  — set to "true" to preview without writing
 *
 * Idempotency: every row uses a deterministic UUIDv5 derived from the target
 * profile id and a stable seed key. Re-runs skip rows that already exist.
 */

import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

const EMAIL = process.env.SEED_EMAIL ?? "anroletrading@gmail.com";
const DRY_RUN = process.env.SEED_DRY_RUN === "true";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.");
  process.exit(1);
}

const sc = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ── Deterministic UUID helper (UUIDv5-ish) ────────────────────────────────────
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

const SEED_NS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

function dateDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function daysFromNow(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function mediaUrl(seed: string, w: number, h: number): string {
  return `https://picsum.photos/seed/${seed}/${w}/${h}`;
}

// ── Miami Buddy definitions ────────────────────────────────────────────────────

interface BuddyDef {
  handle: string;
  name: string;
  displayName: string;
  tagline: string;
  bio: string;
  languages: string[];
  categories: string[];
  hourlyRateUsd: number;
  vibeTags: string[];
  maxGroupSize: number;
  lat: number;
  lng: number;
  packages: PackageDef[];
  addons: AddonDef[];
}

interface PackageDef {
  title: string;
  description: string;
  category: string;
  durationH: number;
  priceUsd: number;
  maxGroup: number;
}

interface AddonDef {
  title: string;
  description: string;
  priceUsd: number;
}

const MIAMI_LAT = 25.7617;
const MIAMI_LNG = -80.1918;

const DEMO_BUDDIES: BuddyDef[] = [
  {
    handle: "demo_carlos_miami",
    name: "Carlos Gomez",
    displayName: "Carlos G.",
    tagline: "Your Miami insider — from airport to Brickell in 30 min flat",
    bio:
      "Born and raised in Miami, I've helped hundreds of travelers skip the tourist traps and find the real city. " +
      "Whether you just landed and need a hand with bags + SIM + first meal, or you want a full city orientation, I've got you. " +
      "Fluent English & Spanish. Licensed rideshare + local logistics expert. [DEMO TEST ACCOUNT]",
    languages: ["English", "Spanish"],
    categories: ["arrival support", "city guide", "local logistics"],
    hourlyRateUsd: 40,
    vibeTags: ["chill", "punctual", "local knowledge"],
    maxGroupSize: 6,
    lat: 25.7617,
    lng: -80.1918,
    packages: [
      {
        title: "Airport Arrival Support",
        description:
          "Meet you at MIA or FLL baggage claim, help with luggage, get your SIM card sorted, and drop you at your hotel with local tips en route.",
        category: "arrival support",
        durationH: 2,
        priceUsd: 75,
        maxGroup: 4,
      },
      {
        title: "Miami City Orientation",
        description:
          "3-hour driving + walking tour of Wynwood, Design District, Little Havana, and Brickell. Best photo spots, local lunch included (food at your cost).",
        category: "city guide",
        durationH: 3,
        priceUsd: 110,
        maxGroup: 5,
      },
      {
        title: "Full-Day Miami Companion",
        description:
          "I'm yours for the day — beaches, neighborhoods, errands, meetings, or just exploring. Flexible itinerary, local car, real local knowledge.",
        category: "city guide",
        durationH: 8,
        priceUsd: 300,
        maxGroup: 4,
      },
    ],
    addons: [
      { title: "Spanish interpretation", description: "Live Spanish↔English interpretation during errands or meetings.", priceUsd: 15 },
      { title: "Grocery & pharmacy run", description: "Stock your Airbnb before or after arrival.", priceUsd: 20 },
    ],
  },
  {
    handle: "demo_priya_miami",
    name: "Priya Nair",
    displayName: "Priya N.",
    tagline: "Miami's food scene through local eyes — no tourist menus",
    bio:
      "Food writer, Miami transplant for 8 years, and serial restaurant-opener companion. " +
      "I run deep on Coconut Grove brunch spots, Doral's Little Venezuela, Wynwood street eats, and Coral Gables fine dining. " +
      "Let me be your edible GPS. Vegetarian-friendly routes available. [DEMO TEST ACCOUNT]",
    languages: ["English", "Hindi", "Malayalam"],
    categories: ["food & dining", "culture", "neighborhood tours"],
    hourlyRateUsd: 38,
    vibeTags: ["foodie", "cultural", "knowledgeable"],
    maxGroupSize: 8,
    lat: 25.7489,
    lng: -80.2326, // Coconut Grove area
    packages: [
      {
        title: "Miami Food Crawl",
        description:
          "4 stops, 4 neighborhoods. We eat our way through Miami's most underrated food scene — Little Haiti, Doral, Coconut Grove & Wynwood. Your new favorite meal guaranteed.",
        category: "food & dining",
        durationH: 4,
        priceUsd: 95,
        maxGroup: 6,
      },
      {
        title: "Brunch & Neighborhood Walk",
        description:
          "Weekend brunch at a locals-only spot followed by a 90-minute neighborhood walk with stories, history, and hidden murals.",
        category: "food & dining",
        durationH: 3,
        priceUsd: 70,
        maxGroup: 8,
      },
      {
        title: "Miami Fine Dining Curation",
        description:
          "I do the research, make the reservations, and join you for dinner. Pre-meal cocktail bar crawl optional.",
        category: "food & dining",
        durationH: 4,
        priceUsd: 120,
        maxGroup: 4,
      },
    ],
    addons: [
      { title: "Vegetarian/vegan route", description: "Full plant-based food tour variant.", priceUsd: 10 },
      { title: "Market grocery tour", description: "Visit a local farmers market and Cuban bodega.", priceUsd: 25 },
    ],
  },
  {
    handle: "demo_diego_miami",
    name: "Diego Montoya",
    displayName: "Diego M.",
    tagline: "Miami nightlife without the tourist tax — clubs, rooftops, secret bars",
    bio:
      "I've been working the door at Miami clubs for 5 years and now I use that access for good. " +
      "Guest lists, rooftop bars, Latin nights, EDM, live music — I know every scene. " +
      "No standing in lines. No overpriced tourist packages. Just the real Miami after dark. Safe, fun, memorable. [DEMO TEST ACCOUNT]",
    languages: ["English", "Spanish", "Portuguese"],
    categories: ["nightlife", "entertainment", "social experiences"],
    hourlyRateUsd: 55,
    vibeTags: ["social", "nightlife expert", "connected"],
    maxGroupSize: 10,
    lat: 25.7825,
    lng: -80.1300, // South Beach area
    packages: [
      {
        title: "Miami Rooftop Bar Hop",
        description:
          "3 rooftop venues in 4 hours. I handle logistics, access, and guide you through the best Brickell and Wynwood rooftop spots with no cover charge issues.",
        category: "nightlife",
        durationH: 4,
        priceUsd: 140,
        maxGroup: 8,
      },
      {
        title: "South Beach Club Night",
        description:
          "Guest list at 2 South Beach clubs, VIP host introductions, nightlife safety briefing, meet-up at your hotel at 10 PM.",
        category: "nightlife",
        durationH: 5,
        priceUsd: 180,
        maxGroup: 6,
      },
      {
        title: "Latin Night Experience",
        description:
          "Salsa/bachata clubs, authentic Latin bars, and live music venues. I'll even give you a quick dance lesson if you need it.",
        category: "nightlife",
        durationH: 4,
        priceUsd: 130,
        maxGroup: 10,
      },
    ],
    addons: [
      { title: "VIP table coordination", description: "I coordinate (not pay for) VIP table at partnered venues.", priceUsd: 30 },
      { title: "Late-night food stop", description: "Best Miami late-night eats after the bars.", priceUsd: 15 },
    ],
  },
  {
    handle: "demo_sarah_miami",
    name: "Sarah Kim",
    displayName: "Sarah K.",
    tagline: "Personal shopper + style guide — Bal Harbour to Wynwood vintage",
    bio:
      "Fashion industry veteran, Miami-based personal stylist, and your secret weapon for shopping in a city that ranges from ultra-luxury to vintage gold. " +
      "I know the hidden sample sales, the best consignment shops, and every designer boutique in Bal Harbour. " +
      "Let's make your Miami shopping trip count. [DEMO TEST ACCOUNT]",
    languages: ["English", "Korean", "Spanish"],
    categories: ["shopping", "personal styling", "luxury experiences"],
    hourlyRateUsd: 50,
    vibeTags: ["stylish", "detail-oriented", "luxury access"],
    maxGroupSize: 4,
    lat: 25.8906,
    lng: -80.1236, // Bal Harbour area
    packages: [
      {
        title: "Bal Harbour Luxury Shopping",
        description:
          "3-hour guided luxury shopping at Bal Harbour Shops. I know the staff, I know the back stock, and I know what's worth it. Personal styling advice included.",
        category: "shopping",
        durationH: 3,
        priceUsd: 150,
        maxGroup: 3,
      },
      {
        title: "Wynwood Vintage & Designer Resale",
        description:
          "Hidden vintage stores, designer consignment, local streetwear — the cool side of Miami fashion that Instagram doesn't show.",
        category: "shopping",
        durationH: 3,
        priceUsd: 110,
        maxGroup: 4,
      },
      {
        title: "Full Personal Shopping Day",
        description:
          "I plan your shopping route based on your style, budget, and wishlist. Full day from Lincoln Road to Miracle Mile.",
        category: "shopping",
        durationH: 6,
        priceUsd: 280,
        maxGroup: 2,
      },
    ],
    addons: [
      { title: "Wardrobe packing consult", description: "30-min video or in-person pre-trip packing advice.", priceUsd: 35 },
      { title: "Alterations coordination", description: "I take your items to my trusted same-day tailor.", priceUsd: 20 },
    ],
  },
  {
    handle: "demo_marcus_miami",
    name: "Marcus Thompson",
    displayName: "Marcus T.",
    tagline: "English, Spanish & Creole interpreter + local explorer — Overtown to Opa-locka",
    bio:
      "Third-generation Miami native from Overtown. I'm here to connect you with the Miami that local history books don't mention — " +
      "Black Miami, Haitian Miami, Jamaican Miami. Language support in English, Spanish, and Haitian Creole. " +
      "Perfect for off-the-beaten-path exploration, local community visits, or if you just need a trusted interpreter in a meeting. [DEMO TEST ACCOUNT]",
    languages: ["English", "Spanish", "Haitian Creole"],
    categories: ["language support", "local exploration", "cultural immersion"],
    hourlyRateUsd: 42,
    vibeTags: ["authentic", "community-connected", "culturally aware"],
    maxGroupSize: 6,
    lat: 25.7750,
    lng: -80.2000, // Overtown / Liberty City area
    packages: [
      {
        title: "Hidden Miami Neighborhoods Walk",
        description:
          "Walk through Overtown, Little Haiti, and Liberty City with a native guide who can tell you the real stories. Photography welcome.",
        category: "local exploration",
        durationH: 3,
        priceUsd: 90,
        maxGroup: 6,
      },
      {
        title: "Spanish / Creole Interpreter Session",
        description:
          "Full companion interpretation for meetings, medical appointments, legal offices, or vendor negotiations. Up to 3 hours.",
        category: "language support",
        durationH: 3,
        priceUsd: 120,
        maxGroup: 2,
      },
      {
        title: "Caribbean Miami Culture Day",
        description:
          "Little Haiti food, Jamaican spots in North Miami, Haitian art galleries, and a history walk. Full cultural immersion.",
        category: "cultural immersion",
        durationH: 5,
        priceUsd: 160,
        maxGroup: 5,
      },
    ],
    addons: [
      { title: "Document translation", description: "Translate 1 page document (Spanish or Creole ↔ English).", priceUsd: 25 },
      { title: "After-hours interpreter", description: "Interpreter availability after 6 PM for events or dinners.", priceUsd: 30 },
    ],
  },
];

// ── AI Companion definition ────────────────────────────────────────────────────
const AI_BOT = {
  handle: "aria_ai_bot",
  name: "Aria · AI Companion",
  displayName: "Aria · AI Companion",
  bio:
    "🤖 AI TEST COMPANION — I am an automated assistant, not a real person. " +
    "Use me to test messaging, chat UX, message sending, replies, conversation history, unread/read states, and notification flows. " +
    "All responses are pre-seeded demo messages. I do not generate live AI replies. " +
    "This account is clearly marked as automated and is isolated from production users.",
  homeCity: "Miami",
  homeCountry: "USA",
  interests: ["testing", "travel", "AI", "chat UX"],
  languages: ["English"],
};

// Seeded conversation messages (alternating target ↔ bot)
const DEMO_MESSAGES = [
  { fromBot: false, body: "Hey Aria! 👋 Just testing the chat here.", daysAgo: 7 },
  { fromBot: true,  body: "Hey there! I'm Aria, your AI test companion. This is a demo conversation so you can test out the Telegraph messaging system. Feel free to send messages and see how the chat UI behaves! 🤖", daysAgo: 7 },
  { fromBot: false, body: "Cool — can I test sending a longer message here? Like this is just some text to see how the bubble wraps and displays in the chat view.", daysAgo: 6 },
  { fromBot: true,  body: "Absolutely! Long messages display just like you'd expect — the bubble expands vertically. You can also test timestamps by scrolling up. Each message has a sent time and the thread tracks your read/unread state automatically. 📱", daysAgo: 6 },
  { fromBot: false, body: "What about the unread indicator?", daysAgo: 5 },
  { fromBot: true,  body: "The unread badge on the Messages tab reflects any threads with messages you haven't read yet. Open a thread and scroll to the bottom — the badge should clear. Try backgrounding the app and opening a new notification to test that flow too!", daysAgo: 5 },
  { fromBot: false, body: "Nice. And the Rent a Buddy feature — can I test a booking?", daysAgo: 3 },
  { fromBot: true,  body: "Yes! Check the Discover tab → Rent a Buddy section. There are several demo buddies seeded in Miami with packages you can browse. Tap a buddy profile, pick a package, and walk through the booking request flow. The booking won't charge anything in test mode. 🎉", daysAgo: 3 },
  { fromBot: false, body: "This is really helpful for testing. Thanks!", daysAgo: 1 },
  { fromBot: true,  body: "Happy to help you test! I'm always here in this conversation if you want to verify message ordering, timestamps, or any other chat UX behavior. [AUTOMATED DEMO MESSAGE — not a real person]", daysAgo: 0 },
];

// ── Generic helpers ────────────────────────────────────────────────────────────

async function upsertRows(table: string, rows: any[], idField = "id"): Promise<{ inserted: number; skipped: number }> {
  if (rows.length === 0) return { inserted: 0, skipped: 0 };
  if (DRY_RUN) {
    console.log(`[DRY-RUN] would upsert ${rows.length} row(s) into ${table}`);
    return { inserted: 0, skipped: rows.length };
  }
  const ids = rows.map((r) => r[idField]);
  const { data: existing } = await sc.from(table).select(idField).in(idField, ids);
  const existingSet = new Set((existing ?? []).map((r: any) => r[idField]));
  const toInsert = rows.filter((r) => !existingSet.has(r[idField]));
  if (toInsert.length === 0) return { inserted: 0, skipped: rows.length };
  const { error } = await sc.from(table).insert(toInsert);
  if (error) throw error;
  return { inserted: toInsert.length, skipped: rows.length - toInsert.length };
}

async function upsertCompositeRows(
  table: string,
  rows: any[],
  col1: string,
  col2: string,
): Promise<{ inserted: number; skipped: number }> {
  if (rows.length === 0) return { inserted: 0, skipped: 0 };
  if (DRY_RUN) {
    console.log(`[DRY-RUN] would upsert ${rows.length} row(s) into ${table}`);
    return { inserted: 0, skipped: rows.length };
  }
  const col1Vals = [...new Set(rows.map((r) => r[col1]))];
  const { data: existing } = await sc.from(table).select(`${col1},${col2}`).in(col1, col1Vals);
  const existingSet = new Set((existing ?? []).map((r: any) => `${r[col1]}:${r[col2]}`));
  const toInsert = rows.filter((r) => !existingSet.has(`${r[col1]}:${r[col2]}`));
  if (toInsert.length === 0) return { inserted: 0, skipped: rows.length };
  const { error } = await sc.from(table).insert(toInsert);
  if (error) throw error;
  return { inserted: toInsert.length, skipped: rows.length - toInsert.length };
}

// ── Step 0: Get target profile ────────────────────────────────────────────────

async function getTargetProfile(): Promise<{ id: string; handle: string; name: string; display_name: string }> {
  const { data: list } = await sc.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const user = (list?.users ?? []).find((u: any) => u.email?.toLowerCase() === EMAIL.toLowerCase());
  if (!user) throw new Error(`Auth user not found: ${EMAIL}`);
  const { data: profile } = await sc.from("profiles").select("id, handle, name, display_name").eq("id", user.id).maybeSingle();
  if (!profile) throw new Error(`Profile not found for: ${EMAIL}`);
  return profile as any;
}

// ── Step 1: Ensure Miami is live ──────────────────────────────────────────────

async function ensureMiamiRollout(): Promise<void> {
  if (DRY_RUN) { console.log("[DRY-RUN] would ensure Miami rollout"); return; }

  // Ensure feature flag is enabled
  const { error: flagErr } = await sc
    .from("feature_flags")
    .upsert({ flag: "rent_buddy_enabled", enabled: true, description: "Rent a Buddy marketplace" }, { onConflict: "flag" });
  if (flagErr) console.warn("  ⚠ feature_flags upsert:", flagErr.message);
  else console.log("  ✓ feature flag rent_buddy_enabled = true");

  // Ensure Miami is in city rollouts at public_mvp
  const { data: existing } = await sc.from("rent_buddy_city_rollouts").select("id, status").eq("city", "Miami").maybeSingle();
  if (existing) {
    if ((existing as any).status !== "public_mvp") {
      const { error } = await sc.from("rent_buddy_city_rollouts").update({ status: "public_mvp", notes: "Demo seed — Miami test market." }).eq("city", "Miami");
      if (error) console.warn("  ⚠ Miami rollout update:", error.message);
      else console.log("  ✓ Miami rollout upgraded to public_mvp");
    } else {
      console.log("  ✓ Miami rollout already at public_mvp");
    }
  } else {
    const { error } = await sc.from("rent_buddy_city_rollouts").insert({
      city: "Miami",
      country: "USA",
      status: "public_mvp",
      notes: "Demo seed — Miami test market. Safe to remove for production.",
    });
    if (error) console.warn("  ⚠ Miami rollout insert:", error.message);
    else console.log("  ✓ Miami rollout inserted at public_mvp");
  }
}

// ── Step 2: Ensure anroletrading has a buddy profile ─────────────────────────

async function seedTargetBuddyProfile(targetProfile: { id: string; name: string; display_name: string }): Promise<void> {
  if (DRY_RUN) { console.log("[DRY-RUN] would seed target buddy profile"); return; }

  const { data: existing } = await sc.from("rent_buddy_profiles").select("id, status").eq("user_id", targetProfile.id).maybeSingle();
  if (existing) {
    // Ensure it's active
    const s = existing as any;
    if (s.status !== "active") {
      await sc.from("rent_buddy_profiles")
        .update({ status: "active", admin_status: "active", updated_at: new Date().toISOString() })
        .eq("user_id", targetProfile.id);
      console.log("  ✓ target buddy profile activated");
    } else {
      console.log("  ✓ target buddy profile already active");
    }
    return;
  }

  const displayName = targetProfile.display_name || targetProfile.name || "Demo User";
  const now = new Date().toISOString();
  const row: Record<string, unknown> = {
    user_id: targetProfile.id,
    display_name: displayName,
    tagline: "Miami local — city guide, food, and nightlife",
    bio:
      "Miami-based travel enthusiast with insider knowledge of the city's best-kept secrets. " +
      "Whether you need a city orientation, restaurant picks, or a nightlife companion, I'm your go-to local. " +
      "Fluent in English and Spanish. [DEMO TEST ACCOUNT]",
    languages: ["English", "Spanish"],
    city: "Miami",
    country: "USA",
    categories: ["city guide", "food & dining", "nightlife"],
    hourly_rate_usd: 45,
    status: "active",
    admin_status: "active",
    verified: true,
    verified_at: dateDaysAgo(30),
    average_rating: 4.8,
    review_count: 12,
    response_time_h: 1.5,
    cover_photo_url: mediaUrl("miami-target-cover", 800, 400),
    gallery_urls: [
      mediaUrl("miami-target-g1", 600, 400),
      mediaUrl("miami-target-g2", 600, 400),
      mediaUrl("miami-target-g3", 600, 400),
    ],
    available_now: true,
    meetup_base_lat: MIAMI_LAT,
    meetup_base_lng: MIAMI_LNG,
    max_group_size: 6,
    new_buddy_public_only: false,
    created_at: dateDaysAgo(45),
    updated_at: now,
  };

  const { error } = await sc.from("rent_buddy_profiles").insert(row);
  if (error) {
    // If admin_status doesn't exist, retry without it
    if (error.message?.includes("admin_status")) {
      delete row.admin_status;
      const { error: e2 } = await sc.from("rent_buddy_profiles").insert(row);
      if (e2) throw new Error(`target buddy profile insert failed: ${e2.message}`);
    } else {
      throw new Error(`target buddy profile insert failed: ${error.message}`);
    }
  }
  console.log(`  ✓ target buddy profile created for ${displayName}`);

  // Get the new profile's id for packages
  const { data: bp } = await sc.from("rent_buddy_profiles").select("id").eq("user_id", targetProfile.id).maybeSingle();
  if (!bp) return;
  const buddyId = (bp as any).id;

  const packages = [
    {
      id: uuidv5(`pkg:target:miami-tour:${targetProfile.id}`, SEED_NS),
      buddy_id: buddyId,
      title: "Miami City Tour",
      description: "3-hour walking + driving tour of Wynwood, Little Havana, and South Beach with a local who knows the real spots.",
      category: "city guide",
      duration_h: 3,
      price_usd: 120,
      max_group: 5,
      is_active: true,
    },
    {
      id: uuidv5(`pkg:target:food-tour:${targetProfile.id}`, SEED_NS),
      buddy_id: buddyId,
      title: "Miami Food & Drinks Night",
      description: "Evening food crawl through Wynwood and Brickell. 4 stops, local picks only — no tourist traps.",
      category: "food & dining",
      duration_h: 4,
      price_usd: 110,
      max_group: 6,
      is_active: true,
    },
  ];

  for (const pkg of packages) {
    const { data: existingPkg } = await sc.from("rent_buddy_packages").select("id").eq("id", pkg.id).maybeSingle();
    if (!existingPkg) {
      const { error: pkgErr } = await sc.from("rent_buddy_packages").insert(pkg);
      if (pkgErr) console.warn(`    ⚠ package "${pkg.title}":`, pkgErr.message);
      else console.log(`    + package: ${pkg.title}`);
    } else {
      console.log(`    ~ package already exists: ${pkg.title}`);
    }
  }
}

// ── Step 3: Seed demo buddy users ─────────────────────────────────────────────

async function seedDemoBuddy(
  def: BuddyDef,
  index: number,
): Promise<void> {
  const userId = uuidv5(`demo-buddy:miami:${index}`, SEED_NS);
  const email = `demo.buddy.miami.${index}@example.com`;
  const now = new Date().toISOString();

  // Auth user
  if (!DRY_RUN) {
    const { data: existing } = await sc.auth.admin.getUserById(userId).catch(() => ({ data: null }));
    if (!existing?.user) {
      const { error: createErr } = await sc.auth.admin.createUser({
        id: userId,
        email,
        password: `DemoBuddy_Miami_${index}_Pass!`,
        email_confirm: true,
      });
      if (createErr && !createErr.message?.includes("already been registered")) {
        console.warn(`  ⚠ auth user ${email}:`, createErr.message);
        return;
      }
    }
  }

  // Profile
  const profileRow = {
    id: userId,
    handle: def.handle,
    name: def.name,
    display_name: def.displayName,
    username: def.handle,
    bio: def.bio,
    home_city: "Miami",
    home_country: "USA",
    current_city: "Miami",
    interests: def.categories,
    spoken_languages: def.languages,
    travel_styles: ["solo", "local"],
    travel_style: "culture",
    travel_pace: "moderate",
    budget_style: "mid_range",
    comfort_level: "comfortable",
    avatar_url: mediaUrl(def.handle, 200, 200),
    cover_photo_url: mediaUrl(`${def.handle}-cover`, 800, 400),
    verified: true,
    verification_status: "verified",
    verified_at: dateDaysAgo(60 + index * 5),
    is_private: false,
    open_to_meet: true,
    passport_visibility: "public",
    role: "user",
    preferred_message_language: "en",
    dob_verified: false,
    date_of_birth: null,
    created_at: dateDaysAgo(120 + index * 7),
    updated_at: now,
  };

  if (!DRY_RUN) {
    const { error: profileErr } = await sc.from("profiles").upsert(profileRow, { onConflict: "id" });
    if (profileErr) { console.warn(`  ⚠ profile ${def.handle}:`, profileErr.message); return; }

    await sc.from("profile_privacy_settings").upsert(
      {
        user_id: userId,
        allow_follow: true,
        allow_friend_requests: true,
        allow_messages_from: "everyone",
        profile_visibility: "public",
        allow_profile_discovery: true,
        allow_tagging: true,
        delayed_posting_default: false,
        precise_location_visible: false,
        show_current_city: true,
        show_followers: true,
        show_friends: true,
        show_home_country: true,
        show_past_trips: true,
        show_posts: true,
        show_real_name: true,
        show_stamps: true,
        show_upcoming_trips: true,
        show_visited_places: true,
        updated_at: now,
      },
      { onConflict: "user_id" },
    );
  }

  // Buddy profile
  const { data: existingBP } = await sc.from("rent_buddy_profiles").select("id").eq("user_id", userId).maybeSingle();
  if (!existingBP && !DRY_RUN) {
    const buddyRow: Record<string, unknown> = {
      user_id: userId,
      display_name: def.displayName,
      tagline: def.tagline,
      bio: def.bio,
      languages: def.languages,
      city: "Miami",
      country: "USA",
      categories: def.categories,
      hourly_rate_usd: def.hourlyRateUsd,
      status: "active",
      admin_status: "active",
      verified: true,
      verified_at: dateDaysAgo(60 + index * 5),
      average_rating: 4.5 + (index % 5) * 0.1,
      review_count: 5 + index * 3,
      response_time_h: 1 + index * 0.5,
      cover_photo_url: mediaUrl(`${def.handle}-cover`, 800, 400),
      gallery_urls: [
        mediaUrl(`${def.handle}-g1`, 600, 400),
        mediaUrl(`${def.handle}-g2`, 600, 400),
        mediaUrl(`${def.handle}-g3`, 600, 400),
      ],
      available_now: index % 2 === 0,
      meetup_base_lat: def.lat,
      meetup_base_lng: def.lng,
      max_group_size: def.maxGroupSize,
      new_buddy_public_only: false,
      featured: index === 0,
      created_at: dateDaysAgo(90 + index * 7),
      updated_at: now,
    };

    const { error: bpErr } = await sc.from("rent_buddy_profiles").insert(buddyRow);
    if (bpErr) {
      if (bpErr.message?.includes("admin_status") || bpErr.message?.includes("featured") || bpErr.message?.includes("max_group_size")) {
        // Retry with minimal safe set
        const minRow: Record<string, unknown> = {
          user_id: userId,
          display_name: def.displayName,
          tagline: def.tagline,
          bio: def.bio,
          languages: def.languages,
          city: "Miami",
          country: "USA",
          categories: def.categories,
          hourly_rate_usd: def.hourlyRateUsd,
          status: "active",
          verified: true,
          verified_at: dateDaysAgo(60 + index * 5),
          average_rating: 4.5 + (index % 5) * 0.1,
          review_count: 5 + index * 3,
          response_time_h: 1 + index * 0.5,
          cover_photo_url: mediaUrl(`${def.handle}-cover`, 800, 400),
          gallery_urls: [mediaUrl(`${def.handle}-g1`, 600, 400), mediaUrl(`${def.handle}-g2`, 600, 400)],
          available_now: index % 2 === 0,
          meetup_base_lat: def.lat,
          meetup_base_lng: def.lng,
          created_at: dateDaysAgo(90 + index * 7),
          updated_at: now,
        };
        const { error: e2 } = await sc.from("rent_buddy_profiles").insert(minRow);
        if (e2) { console.warn(`  ⚠ buddy profile ${def.handle} (minimal):`, e2.message); return; }
      } else {
        console.warn(`  ⚠ buddy profile ${def.handle}:`, bpErr.message); return;
      }
    }
    console.log(`  ✓ buddy profile: ${def.displayName} (${def.categories.join(", ")})`);
  } else {
    console.log(`  ~ buddy profile already exists: ${def.displayName}`);
  }

  if (DRY_RUN) return;

  // Get buddy profile id for packages/addons
  const { data: bp } = await sc.from("rent_buddy_profiles").select("id").eq("user_id", userId).maybeSingle();
  if (!bp) return;
  const buddyId = (bp as any).id;

  // Packages
  for (let pi = 0; pi < def.packages.length; pi++) {
    const pkg = def.packages[pi];
    const pkgId = uuidv5(`pkg:${def.handle}:${pi}`, SEED_NS);
    const { data: existingPkg } = await sc.from("rent_buddy_packages").select("id").eq("id", pkgId).maybeSingle();
    if (!existingPkg) {
      const { error: pkgErr } = await sc.from("rent_buddy_packages").insert({
        id: pkgId,
        buddy_id: buddyId,
        title: pkg.title,
        description: pkg.description,
        category: pkg.category,
        duration_h: pkg.durationH,
        price_usd: pkg.priceUsd,
        max_group: pkg.maxGroup,
        is_active: true,
        created_at: dateDaysAgo(80 + index * 5),
        updated_at: now,
      });
      if (pkgErr) console.warn(`    ⚠ package "${pkg.title}":`, pkgErr.message);
      else console.log(`    + package: ${pkg.title}`);
    } else {
      console.log(`    ~ package exists: ${pkg.title}`);
    }
  }

  // Addons
  for (let ai = 0; ai < def.addons.length; ai++) {
    const addon = def.addons[ai];
    const addonId = uuidv5(`addon:${def.handle}:${ai}`, SEED_NS);
    const { data: existingAddon } = await sc.from("rent_buddy_addons").select("id").eq("id", addonId).maybeSingle();
    if (!existingAddon) {
      const { error: addonErr } = await sc.from("rent_buddy_addons").insert({
        id: addonId,
        buddy_id: buddyId,
        title: addon.title,
        description: addon.description,
        price_usd: addon.priceUsd,
        is_active: true,
        created_at: dateDaysAgo(80 + index * 5),
      });
      if (addonErr) console.warn(`    ⚠ addon "${addon.title}":`, addonErr.message);
    }
  }

  // Availability: seed 14 days of availability
  const availRows: any[] = [];
  for (let d = 1; d <= 14; d++) {
    const dateStr = daysFromNow(d).substring(0, 10);
    const availId = uuidv5(`avail:${def.handle}:${dateStr}`, SEED_NS);
    availRows.push({
      id: availId,
      buddy_id: buddyId,
      date: dateStr,
      time_slots: d % 7 === 0 ? ["10:00", "14:00"] : ["09:00", "10:00", "14:00", "15:00", "19:00"],
      is_available: d % 7 !== 0,
      created_at: now,
      updated_at: now,
    });
  }
  await upsertRows("rent_buddy_availability", availRows);
}

// ── Step 4: Seed AI bot user + friend + conversation ─────────────────────────

async function seedAiBot(targetId: string): Promise<void> {
  const botId = uuidv5(`ai-bot:aria:${targetId}`, SEED_NS);
  const botEmail = `aria.ai.bot.${targetId.substring(0, 8)}@example.com`;
  const now = new Date().toISOString();

  // Auth user
  if (!DRY_RUN) {
    const { data: existing } = await sc.auth.admin.getUserById(botId).catch(() => ({ data: null }));
    if (!existing?.user) {
      const { error: createErr } = await sc.auth.admin.createUser({
        id: botId,
        email: botEmail,
        password: `AriaAiBot_${botId.substring(0, 8)}_Pass!`,
        email_confirm: true,
      });
      if (createErr && !createErr.message?.includes("already been registered")) {
        console.warn("  ⚠ AI bot auth user:", createErr.message);
        return;
      }
    }

    // Profile
    const { error: profileErr } = await sc.from("profiles").upsert({
      id: botId,
      handle: AI_BOT.handle,
      name: AI_BOT.name,
      display_name: AI_BOT.displayName,
      username: AI_BOT.handle,
      bio: AI_BOT.bio,
      home_city: AI_BOT.homeCity,
      home_country: AI_BOT.homeCountry,
      current_city: AI_BOT.homeCity,
      interests: AI_BOT.interests,
      spoken_languages: AI_BOT.languages,
      avatar_url: `https://api.dicebear.com/7.x/bottts/svg?seed=aria-ai-bot&backgroundColor=b6e3f4`,
      verified: false,
      verification_status: "unverified",
      is_private: false,
      open_to_meet: false,
      passport_visibility: "public",
      role: "user",
      preferred_message_language: "en",
      dob_verified: false,
      date_of_birth: null,
      created_at: dateDaysAgo(30),
      updated_at: now,
    }, { onConflict: "id" });
    if (profileErr) { console.warn("  ⚠ AI bot profile:", profileErr.message); return; }
    console.log("  ✓ AI bot profile:", AI_BOT.displayName);

    // Privacy settings — allow everyone to message
    await sc.from("profile_privacy_settings").upsert({
      user_id: botId,
      allow_follow: true,
      allow_friend_requests: true,
      allow_messages_from: "everyone",
      profile_visibility: "public",
      allow_profile_discovery: false, // Don't surface in discover
      allow_tagging: false,
      delayed_posting_default: false,
      precise_location_visible: false,
      show_current_city: true,
      show_followers: false,
      show_friends: false,
      show_home_country: true,
      show_past_trips: false,
      show_posts: false,
      show_real_name: true,
      show_stamps: false,
      show_upcoming_trips: false,
      show_visited_places: false,
      updated_at: now,
    }, { onConflict: "user_id" });
  }

  // Friendship: user_friendships(user_a, user_b) normalized so a < b
  const [userA, userB] = targetId < botId ? [targetId, botId] : [botId, targetId];
  const friendshipId = uuidv5(`friendship:bot:${userA}:${userB}`, SEED_NS);

  await upsertCompositeRows(
    "user_friendships",
    [{ user_a: userA, user_b: userB, created_at: dateDaysAgo(25) }],
    "user_a",
    "user_b",
  );
  console.log("  ✓ user_friendships: target ↔ AI bot");

  // user_follows: mutual follows
  await upsertCompositeRows(
    "user_follows",
    [
      { follower_id: targetId, following_id: botId, created_at: dateDaysAgo(25) },
      { follower_id: botId, following_id: targetId, created_at: dateDaysAgo(25) },
    ],
    "follower_id",
    "following_id",
  );
  console.log("  ✓ user_follows: mutual follows target ↔ AI bot");

  if (DRY_RUN) return;

  // Message thread
  const threadId = uuidv5(`thread:bot-chat:${targetId}:${botId}`, SEED_NS);
  const { data: existingThread } = await sc.from("message_threads").select("id").eq("id", threadId).maybeSingle();

  if (!existingThread) {
    const { error: threadErr } = await sc.from("message_threads").insert({
      id: threadId,
      created_at: dateDaysAgo(7),
      updated_at: dateDaysAgo(0),
      last_message_at: dateDaysAgo(0),
    });
    if (threadErr) { console.warn("  ⚠ message thread:", threadErr.message); return; }

    // Members
    const { error: membErr } = await sc.from("message_thread_members").insert([
      { thread_id: threadId, user_id: targetId, joined_at: dateDaysAgo(7), last_read_at: dateDaysAgo(1) },
      { thread_id: threadId, user_id: botId, joined_at: dateDaysAgo(7) },
    ]);
    if (membErr) console.warn("  ⚠ thread members:", membErr.message);

    console.log("  ✓ message thread created");
  } else {
    console.log("  ~ message thread already exists");
  }

  // Messages — seed conversation history
  let msgInserted = 0;
  let msgSkipped = 0;
  for (let mi = 0; mi < DEMO_MESSAGES.length; mi++) {
    const msg = DEMO_MESSAGES[mi];
    const msgId = uuidv5(`msg:bot-chat:${targetId}:${mi}`, SEED_NS);
    const { data: existingMsg } = await sc.from("messages").select("id").eq("id", msgId).maybeSingle();
    if (existingMsg) { msgSkipped++; continue; }

    const msgDate = new Date();
    msgDate.setUTCDate(msgDate.getUTCDate() - msg.daysAgo);
    msgDate.setUTCHours(10 + mi, mi * 3, 0, 0);

    const { error: msgErr } = await sc.from("messages").insert({
      id: msgId,
      thread_id: threadId,
      sender_id: msg.fromBot ? botId : targetId,
      body: msg.body,
      msg_type: "text",
      created_at: msgDate.toISOString(),
    });
    if (msgErr) console.warn(`  ⚠ message ${mi}:`, msgErr.message);
    else msgInserted++;
  }
  console.log(`  ✓ messages: ${msgInserted} inserted, ${msgSkipped} skipped`);

  // Mark all messages as read except the last one (to test unread state)
  const { error: readErr } = await sc.from("message_thread_members")
    .update({ last_read_at: dateDaysAgo(1) })
    .eq("thread_id", threadId)
    .eq("user_id", targetId);
  if (readErr) console.warn("  ⚠ last_read_at update:", readErr.message);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\nSeeding demo Buddy profiles + AI companion for ${EMAIL} (dry-run=${DRY_RUN})\n`);

  // Get target
  const target = await getTargetProfile();
  console.log(`Target: ${target.id} @${target.handle}\n`);

  // Step 0: Miami rollout
  console.log("── Step 1: Miami city rollout ──────────────────────────────────");
  await ensureMiamiRollout();

  // Step 1: Target buddy profile
  console.log("\n── Step 2: anroletrading@gmail.com Buddy profile ───────────────");
  await seedTargetBuddyProfile(target);

  // Step 2: 5 demo buddies
  console.log("\n── Step 3: Demo Buddy profiles ─────────────────────────────────");
  for (let i = 0; i < DEMO_BUDDIES.length; i++) {
    console.log(`\n  [${i + 1}/${DEMO_BUDDIES.length}] ${DEMO_BUDDIES[i].displayName}`);
    await seedDemoBuddy(DEMO_BUDDIES[i], i);
  }

  // Step 3: AI bot
  console.log("\n── Step 4: AI companion bot ────────────────────────────────────");
  await seedAiBot(target.id);

  console.log("\n✅ Done. Summary:");
  console.log("  • Miami added to rent_buddy_city_rollouts at public_mvp");
  console.log("  • anroletrading@gmail.com active as a Buddy in Miami");
  console.log("  • 5 demo Buddy profiles: Carlos G., Priya N., Diego M., Sarah K., Marcus T.");
  console.log("  • AI companion 'Aria' added as friend + Telegraph conversation seeded");
  console.log("\nAll records use deterministic UUIDs — re-running is safe (idempotent).");
  console.log("To identify demo records, look for '[DEMO TEST ACCOUNT]' in buddy bios.");
}

main().catch((err) => {
  console.error("\n❌ Fatal:", err.message ?? err);
  process.exit(1);
});
