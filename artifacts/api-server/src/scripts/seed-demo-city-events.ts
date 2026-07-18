/**
 * seed-demo-city-events.ts
 *
 * Populates every seed city with 5 realistic, currently-ongoing demo events so
 * the Pulse header "What's happening right now" carousel can be exercised in
 * every city without real user activity.
 *
 * Events are:
 *   • starts_at  = now − 10 min  (clearly "started" from the carousel's POV)
 *   • ends_at    = now + 8 h     (stays live for a comfortable testing window)
 *   • state      = 'open'        (picked up by GET /api/events?state=open)
 *   • visibility = 'public'
 *   • show_exact_location = true (coords returned to every viewer)
 *   • source     = 'demo_seed'   (easy identification / cleanup)
 *
 * The script is fully idempotent — re-running it UPDATES starts_at / ends_at
 * so events are always "live" for 8 hours after the last run.
 *
 * Usage (from artifacts/api-server):
 *   node --env-file-if-exists=.env --import tsx/esm src/scripts/seed-demo-city-events.ts
 *
 * Optional env vars:
 *   SEED_EMAIL   — target user who becomes the host (default: anroletrading@gmail.com)
 *   SEED_DRY_RUN — set to "true" to log rows without writing to the DB
 */

import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

const EMAIL   = process.env.SEED_EMAIL   ?? "anroletrading@gmail.com";
const DRY_RUN = process.env.SEED_DRY_RUN === "true";
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.");
  process.exit(1);
}
const sc = createClient(url, key, { auth: { persistSession: false } });

// ── Deterministic UUID v5 (same as seed-demo-social.ts) ──────────────────────
const SEED_NS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
function uuidv5(name: string): string {
  const hash = createHash("sha1").update(SEED_NS + name).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  return [hash.subarray(0, 4), hash.subarray(4, 6), hash.subarray(6, 8),
          hash.subarray(8, 10), hash.subarray(10, 16)]
    .map((b) => b.toString("hex")).join("-");
}

// ── Timestamps (recomputed every run → always fresh) ─────────────────────────
const now      = new Date();
const startsAt = new Date(now.getTime() - 10 * 60 * 1000).toISOString();  // now − 10 min
const endsAt   = new Date(now.getTime() + 8  * 60 * 60 * 1000).toISOString(); // now + 8 h

// ── Seed cities (matches popularCities.ts exactly) ───────────────────────────
const CITIES = [
  { city: "Cebu City",        country: "Philippines",  lat: 10.316,  lng: 123.891 },
  { city: "Manila",           country: "Philippines",  lat: 14.599,  lng: 120.984 },
  { city: "Davao City",       country: "Philippines",  lat:  7.207,  lng: 125.395 },
  { city: "Bangkok",          country: "Thailand",     lat: 13.756,  lng: 100.502 },
  { city: "Bali",             country: "Indonesia",    lat: -8.409,  lng: 115.188 },
  { city: "Tokyo",            country: "Japan",        lat: 35.689,  lng: 139.691 },
  { city: "Paris",            country: "France",       lat: 48.856,  lng:   2.351 },
  { city: "Barcelona",        country: "Spain",        lat: 41.385,  lng:   2.173 },
  { city: "New York",         country: "USA",          lat: 40.712,  lng: -74.006 },
  { city: "London",           country: "UK",           lat: 51.507,  lng:  -0.127 },
  { city: "Singapore",        country: "Singapore",    lat:  1.352,  lng: 103.819 },
  { city: "Istanbul",         country: "Turkey",       lat: 41.013,  lng:  28.979 },
  { city: "Dubai",            country: "UAE",          lat: 25.204,  lng:  55.270 },
  { city: "Ho Chi Minh City", country: "Vietnam",      lat: 10.776,  lng: 106.701 },
  { city: "Lisbon",           country: "Portugal",     lat: 38.716,  lng:  -9.139 },
  { city: "Mexico City",      country: "Mexico",       lat: 19.432,  lng: -99.133 },
] as const;

// ── Events per city (5 each, varied categories) ───────────────────────────────
type EventDef = { slug: string; title: string; description: string; category: string; going: number; capacity: number; latOff: number; lngOff: number };

const CITY_EVENTS: Record<string, EventDef[]> = {
  "Cebu City": [
    { slug: "sinulog-dance",    title: "Sinulog Night Dance Party",        description: "Live street dancing and cultural performances in Colon Street. Join hundreds of locals celebrating Cebu's iconic festival energy.",         category: "nightlife",  going: 34, capacity: 200, latOff:  0.002, lngOff:  0.003 },
    { slug: "street-food",      title: "Cebu Street Food Crawl",           description: "Guided walk through Larsian BBQ and Carbon Market. Try lechon, puso rice, and fresh mangoes from local stalls.",                           category: "food",       going: 22, capacity: 30,  latOff: -0.003, lngOff:  0.001 },
    { slug: "rooftop-sunset",   title: "Rooftop Sunset Social",            description: "Catch the golden hour from one of Cebu's rooftop bars with fellow travelers. Craft cocktails and city views.",                              category: "nightlife",  going: 18, capacity: 60,  latOff:  0.001, lngOff: -0.002 },
    { slug: "island-day",       title: "Island Beach & Snorkel Meetup",    description: "Quick boat ride to Olango Island for snorkeling in crystal-clear waters. Gear provided. Back by sunset.",                                   category: "beach",      going: 12, capacity: 25,  latOff:  0.004, lngOff:  0.005 },
    { slug: "local-market",     title: "Carbon Market Morning Wander",     description: "Early-morning wander through Cebu's largest wet market. Sample exotic fruits, meet local vendors, and grab breakfast.",                      category: "food",       going:  9, capacity: 20,  latOff: -0.001, lngOff:  0.002 },
  ],
  "Manila": [
    { slug: "bay-walk",         title: "Manila Bay Sunset Walk",           description: "Evening stroll along the famous boulevard with ice cream, balut, and the best orange sunset in Southeast Asia.",                            category: "social",     going: 41, capacity: 100, latOff:  0.002, lngOff: -0.003 },
    { slug: "intramuros-tour",  title: "Intramuros Night Lantern Tour",    description: "Explore the walled city by bamboo bike or on foot after dark. Colonial history, ghost stories, and great photo spots.",                     category: "culture",    going: 19, capacity: 40,  latOff: -0.004, lngOff:  0.001 },
    { slug: "food-strip",       title: "BGC Food Truck Festival",          description: "Over 30 trucks parked along High Street. Craft beer, international street food, and live acoustic music.",                                   category: "food",       going: 55, capacity: 300, latOff:  0.003, lngOff:  0.002 },
    { slug: "rooftop-pool",     title: "Rooftop Pool Party — Makati",      description: "Afternoon pool party with DJ, frozen drinks, and a crowd of expats and locals. Bring your own towel.",                                      category: "nightlife",  going: 30, capacity: 80,  latOff: -0.002, lngOff: -0.001 },
    { slug: "art-walk",         title: "Makati Art Gallery Hop",           description: "Self-guided walk through four commercial galleries in Makati's arts district. Free entry. Meet artists in residence.",                       category: "culture",    going: 11, capacity: 50,  latOff:  0.001, lngOff:  0.003 },
  ],
  "Davao City": [
    { slug: "eagle-tour",       title: "Philippine Eagle Sanctuary Tour",  description: "Small-group guided tour of the Philippine Eagle Center. Learn about conservation efforts and see the world's largest eagle up close.",       category: "culture",    going: 14, capacity: 20,  latOff:  0.005, lngOff:  0.003 },
    { slug: "night-market",     title: "Davao Night Market Food Run",      description: "Grilled tuna belly, durian candies, and pomelo shakes at the famous Magsaysay night market. Come hungry.",                                  category: "food",       going: 28, capacity: 60,  latOff: -0.002, lngOff:  0.001 },
    { slug: "riverside",        title: "Davao River Riverside Meetup",     description: "Casual hang by the river with kayaks available. Bring snacks and meet other travelers based in Davao.",                                     category: "social",     going:  9, capacity: 30,  latOff:  0.003, lngOff: -0.002 },
    { slug: "durian-tasting",   title: "Fresh Durian Tasting Experience",  description: "The king of fruits with a local guide explaining varieties, seasons, and how to pick a good one. No judging beginners.",                     category: "food",       going: 16, capacity: 15,  latOff: -0.001, lngOff:  0.004 },
    { slug: "bike-rally",       title: "Davao City Night Bike Rally",      description: "Group cycling through Davao's quiet streets after dark. Bikes for rent at the meetup point. Helmets included.",                             category: "social",     going: 21, capacity: 40,  latOff:  0.002, lngOff:  0.002 },
  ],
  "Bangkok": [
    { slug: "floating-market",  title: "Damnoen Saduak Sunrise Visit",     description: "Early morning boat through the famous floating market. Fresh tropical fruit, coconut pancakes, and local vendors on longboats.",            category: "food",       going: 26, capacity: 30,  latOff: -0.003, lngOff:  0.002 },
    { slug: "rooftop-crawl",    title: "Silom Rooftop Bar Crawl",          description: "Three rooftop bars, one epic Bangkok skyline. Starts at Vertigo, ends at Zoom. Sky train between stops.",                                   category: "nightlife",  going: 38, capacity: 60,  latOff:  0.001, lngOff: -0.001 },
    { slug: "muay-thai",        title: "Muay Thai Live Evening Bout",       description: "Ringside seats at Rajadamnern Stadium. Authentic bouts, not tourist shows. Pre-match dinner at a local noodle shop.",                       category: "culture",    going: 45, capacity: 100, latOff:  0.004, lngOff:  0.003 },
    { slug: "street-food-tour", title: "Yaowarat Street Food Night Tour",  description: "Guided walk through Bangkok's Chinatown. Dim sum, shark fin soup alternatives, mango sticky rice, and egg waffles.",                        category: "food",       going: 31, capacity: 20,  latOff: -0.002, lngOff: -0.003 },
    { slug: "temple-meditation",title: "Wat Pho Candlelight Meditation",   description: "Evening meditation session in the courtyard of Wat Pho with a resident monk. Beginner-friendly. Dress code applies.",                       category: "wellness",   going: 13, capacity: 25,  latOff:  0.002, lngOff:  0.001 },
  ],
  "Bali": [
    { slug: "sunset-yoga",      title: "Seminyak Beach Sunset Yoga",       description: "One-hour flow class facing the Indian Ocean at golden hour. All levels welcome. Mats provided. Post-class smoothie included.",              category: "wellness",   going: 22, capacity: 30,  latOff: -0.003, lngOff: -0.002 },
    { slug: "cooking-class",    title: "Ubud Traditional Cooking Class",   description: "Market visit followed by cooking four Balinese dishes. Nasi goreng, tempeh, satay lilit, and black rice pudding.",                          category: "food",       going: 14, capacity: 12,  latOff:  0.004, lngOff:  0.003 },
    { slug: "rice-terrace",     title: "Tegallalang Rice Terrace Walk",    description: "Guided walk through the UNESCO rice terraces at midday. Photography tips from a local guide. Coconut stop halfway.",                        category: "culture",    going: 18, capacity: 20,  latOff: -0.001, lngOff:  0.002 },
    { slug: "night-market-bali",title: "Gianyar Night Market",             description: "One of Bali's best-kept local food secrets — babi guling, sate, and fresh juices. Very few tourists. Very good food.",                      category: "food",       going: 11, capacity: 40,  latOff:  0.002, lngOff: -0.001 },
    { slug: "kecak-dance",      title: "Uluwatu Kecak Fire Dance",         description: "Traditional Kecak performance at cliff-top Uluwatu temple at sunset. One of Bali's most iconic experiences.",                               category: "culture",    going: 37, capacity: 200, latOff: -0.004, lngOff:  0.001 },
  ],
  "Tokyo": [
    { slug: "ramen-night",      title: "Shinjuku Ramen Alley Crawl",       description: "Four bowls across Memory Lane (Omoide Yokocho). Shoyu, miso, tonkotsu, and a surprise fourth stop chosen by the guide.",                   category: "food",       going: 29, capacity: 20,  latOff:  0.001, lngOff: -0.002 },
    { slug: "shibuya-walk",     title: "Shibuya Crossing Night Walk",       description: "Experience the world's busiest crossing at its peak then explore Shibuya's backstreets, hidden bars, and vintage shops.",                   category: "social",     going: 53, capacity: 80,  latOff: -0.002, lngOff:  0.003 },
    { slug: "cherry-blossom",   title: "Yoyogi Park Night Hanami",         description: "Evening cherry blossom viewing under the lanterns with picnic blankets, convenience store snacks, and good company.",                       category: "social",     going: 44, capacity: 100, latOff:  0.003, lngOff:  0.001 },
    { slug: "izakaya",          title: "Golden Gai Izakaya Meetup",        description: "The legendary alley of tiny bars. Join for a guided bar hop through five venues — each fits fewer than 10 people.",                         category: "nightlife",  going: 17, capacity: 15,  latOff: -0.001, lngOff: -0.001 },
    { slug: "harajuku",         title: "Harajuku Street Style Hunt",       description: "Photography and fashion walk through Takeshita Street and Omotesando Hills. Spot the most creative outfits and thrift shop together.",       category: "culture",    going: 20, capacity: 30,  latOff:  0.002, lngOff:  0.002 },
  ],
  "Paris": [
    { slug: "wine-social",      title: "Marais Wine & Cheese Social",      description: "Natural wines from a small cave à manger paired with three French cheeses. Guided tasting then open social hour.",                         category: "food",       going: 24, capacity: 20,  latOff: -0.002, lngOff:  0.002 },
    { slug: "seine-cruise",     title: "Seine River Evening Cruise",       description: "One-hour cruise past Notre Dame, the Louvre, and the Eiffel Tower at dusk. Champagne on board. Book your own ticket — we sit together.",    category: "social",     going: 39, capacity: 150, latOff:  0.001, lngOff: -0.003 },
    { slug: "montmartre",       title: "Montmartre Art Walk",              description: "Visit four artist studios and the Place du Tertre market. Ends with crêpes and a view of the Sacré-Cœur.",                                  category: "culture",    going: 17, capacity: 25,  latOff: -0.003, lngOff:  0.001 },
    { slug: "aperitivo",        title: "Rooftop Aperitivo — Galeries",     description: "Drinks on the rooftop terrace of Galeries Lafayette. Free to access — just buy a drink. Paris panorama at magic hour.",                     category: "nightlife",  going: 42, capacity: 200, latOff:  0.002, lngOff:  0.002 },
    { slug: "jazz-paris",       title: "Jazz Club Night — Caveau",         description: "Live traditional jazz at Caveau de la Huchette in the Latin Quarter. Dancing encouraged. Cover charge applies.",                             category: "nightlife",  going: 28, capacity: 80,  latOff: -0.001, lngOff: -0.001 },
  ],
  "Barcelona": [
    { slug: "paella-beach",     title: "Barceloneta Paella Night",         description: "Seafood paella cooked on an open grill on the beach. Local wine, communal tables, and the sound of the Mediterranean.",                    category: "food",       going: 33, capacity: 50,  latOff:  0.001, lngOff:  0.003 },
    { slug: "gothic-tour",      title: "Gothic Quarter Night Wander",      description: "Narrow medieval streets, hidden squares, and stone archways after dark. Best done slowly with a local guide.",                              category: "culture",    going: 22, capacity: 20,  latOff: -0.002, lngOff: -0.001 },
    { slug: "flamenco-tapas",   title: "Flamenco & Tapas Evening",         description: "Authentic tablao flamenco followed by tapas in El Born. Patatas bravas, jamón, and croquetas on a long communal table.",                    category: "culture",    going: 48, capacity: 60,  latOff:  0.003, lngOff:  0.001 },
    { slug: "rooftop-drinks",   title: "Eixample Rooftop Sundowner",       description: "Craft cocktails with views of the Sagrada Família catching the last light. Casual dress, good vibes, easy conversation.",                   category: "nightlife",  going: 31, capacity: 60,  latOff: -0.001, lngOff:  0.002 },
    { slug: "sunrise-run",      title: "Barceloneta Sunrise Run",          description: "Easy 6 km run along the beach starting before dawn. Coffee and croissant stop at the end. All paces welcome.",                              category: "wellness",   going: 14, capacity: 30,  latOff:  0.002, lngOff: -0.002 },
  ],
  "New York": [
    { slug: "brooklyn-market",  title: "Brooklyn Night Market",            description: "Over 80 food vendors from every cuisine imaginable. Dumbo waterfront location, Manhattan Bridge backdrop.",                                 category: "food",       going: 67, capacity: 500, latOff: -0.003, lngOff:  0.002 },
    { slug: "rooftop-nyc",      title: "Lower East Side Rooftop Happy Hour", description: "Bar 13 rooftop. Classic New York cocktails, a mixed crowd of travelers and locals, and unbeatable skyline views.",                       category: "nightlife",  going: 41, capacity: 80,  latOff:  0.002, lngOff: -0.001 },
    { slug: "central-park-run", title: "Central Park Morning Loop",        description: "5.8-mile run around the park loop. No pace pressure — just a group of people who'd rather explore than use a treadmill.",                  category: "wellness",   going: 19, capacity: 40,  latOff:  0.004, lngOff:  0.001 },
    { slug: "jazz-harlem",      title: "Harlem Jazz Club Night",           description: "Bill's Place or Minton's Playhouse for live jazz in the neighborhood that invented it. Dinner reservation advised.",                        category: "nightlife",  going: 23, capacity: 60,  latOff: -0.001, lngOff: -0.003 },
    { slug: "food-truck-rally",  title: "Smorgasburg Food Truck Rally",    description: "Smorgasburg's weekly outdoor food market at Prospect Park. 100+ vendors, incredible variety, bring cash.",                                 category: "food",       going: 55, capacity: 1000,latOff:  0.003, lngOff:  0.002 },
  ],
  "London": [
    { slug: "thames-walk",      title: "Thames South Bank Evening Walk",   description: "Walk from London Bridge to Westminster Bridge as the city lights up. Book nerd stop at Southbank Book Market.",                            category: "social",     going: 36, capacity: 100, latOff:  0.001, lngOff: -0.002 },
    { slug: "pub-crawl",        title: "Shoreditch Pub Crawl",             description: "Three classic London pubs in east London's coolest neighbourhood. Pints, crisps, and a dartboard at the last stop.",                       category: "nightlife",  going: 44, capacity: 60,  latOff: -0.003, lngOff:  0.001 },
    { slug: "museum-night",     title: "Natural History Museum Late Night", description: "The museum opens late with cocktails under the blue whale. No kids, lots of adults being nerdy about dinosaurs.",                          category: "culture",    going: 27, capacity: 200, latOff:  0.002, lngOff:  0.003 },
    { slug: "borough-market",   title: "Borough Market Food Walk",         description: "The world's most famous food market in its prime evening session. Cheese, charcuterie, hot food stalls, and craft beer.",                  category: "food",       going: 48, capacity: 500, latOff: -0.001, lngOff: -0.001 },
    { slug: "open-mic",         title: "Camden Open Mic Night",            description: "Grassroots music venue in Camden hosting touring and local acts. First drink included with the group entry.",                               category: "nightlife",  going: 20, capacity: 80,  latOff:  0.003, lngOff:  0.002 },
  ],
  "Singapore": [
    { slug: "gardens-night",    title: "Gardens by the Bay Night Walk",    description: "Supertrees illuminated after dark + the OCBC Skyway walkway. Ends with chilli crab at a hawker centre nearby.",                           category: "culture",    going: 52, capacity: 200, latOff:  0.001, lngOff:  0.003 },
    { slug: "hawker-trail",     title: "Maxwell Hawker Centre Food Trail",  description: "Five hawker dishes from five different stalls — guided by a local who grew up eating here. Chicken rice, laksa, and more.",               category: "food",       going: 29, capacity: 15,  latOff: -0.002, lngOff: -0.001 },
    { slug: "marina-bay-drinks","title": "1-Altitude Rooftop Drinks",       description: "World's highest al fresco bar. Dress code applies. Views of Marina Bay at night are worth every dollar of the cocktails.",                category: "nightlife",  going: 34, capacity: 100, latOff:  0.002, lngOff:  0.001 },
    { slug: "night-safari",     title: "Night Safari Group Trip",           description: "Singapore's nocturnal wildlife park. Meet at the entrance and explore the tram ride and walking trails together.",                        category: "culture",    going: 17, capacity: 50,  latOff: -0.003, lngOff:  0.004 },
    { slug: "clarke-quay",      title: "Clarke Quay River Social",         description: "Casual drinks along the quay as bumboats pass by. A natural place to meet other travelers — no plan, just show up.",                      category: "social",     going: 38, capacity: 150, latOff:  0.001, lngOff: -0.002 },
  ],
  "Istanbul": [
    { slug: "bosphorus-cruise", title: "Bosphorus Sunset Cruise",          description: "Private wooden gulet sailing the strait as the mosques catch the last light. Tea and Turkish delight on deck.",                           category: "culture",    going: 24, capacity: 30,  latOff:  0.002, lngOff:  0.003 },
    { slug: "grand-bazaar",     title: "Grand Bazaar Night Wander",        description: "The bazaar is quieter at dusk — a good time to haggle for spices, ceramics, and lamps without the midday crowds.",                       category: "culture",    going: 18, capacity: 100, latOff: -0.001, lngOff: -0.002 },
    { slug: "hamam-evening",    title: "Çağaloğlu Hamam Evening",          description: "Historic 18th-century bathhouse experience. Kese scrub, foam massage, and relaxing in the star-lit central room.",                        category: "wellness",   going: 11, capacity: 20,  latOff:  0.003, lngOff:  0.001 },
    { slug: "raki-rooftop",     title: "Beyoğlu Rooftop Raki Night",       description: "Raki, meze, and city views across the Golden Horn. Turkish drinking culture 101 — no rush, no last orders.",                              category: "nightlife",  going: 27, capacity: 40,  latOff: -0.002, lngOff:  0.002 },
    { slug: "sultanahmet-walk", title: "Sultanahmet After-Dark Walk",      description: "Blue Mosque and Hagia Sophia lit up at night — far more atmospheric than midday. Guided by a local historian.",                           category: "culture",    going: 32, capacity: 30,  latOff:  0.001, lngOff: -0.001 },
  ],
  "Dubai": [
    { slug: "desert-sunset",    title: "Dubai Desert Sunset Gathering",    description: "Small group 4x4 to the dunes 45 min from the city. Camel rides, falconry, and Emirati mezze as the sun drops.",                         category: "culture",    going: 19, capacity: 20,  latOff:  0.004, lngOff:  0.003 },
    { slug: "marina-walk",      title: "Dubai Marina Night Walk",          description: "Walk the entire 7-km marina promenade at night. Best skyline in the UAE. Multiple stops for drinks along the way.",                       category: "social",     going: 43, capacity: 100, latOff: -0.002, lngOff: -0.001 },
    { slug: "rooftop-brunch",   title: "JBR Rooftop Brunch Social",        description: "Friday brunch culture done right — rooftop overlooking Jumeirah Beach. Free-flow and a crowd of expats happy to talk.",                  category: "food",       going: 61, capacity: 80,  latOff:  0.002, lngOff:  0.002 },
    { slug: "old-souk",         title: "Dubai Old Souk & Creek Night",     description: "Abra (wooden boat) across the Creek to the Gold and Spice Souks at night. Dates, saffron, and zero tourist pricing.",                    category: "culture",    going: 15, capacity: 30,  latOff: -0.003, lngOff:  0.001 },
    { slug: "beach-party",      title: "Kite Beach Sunset Party",          description: "Weekly beach social at Kite Beach. Volleyball, fire dancers, and a DJ set that goes until 11 pm. Bring a towel.",                        category: "beach",      going: 74, capacity: 200, latOff:  0.001, lngOff: -0.003 },
  ],
  "Ho Chi Minh City": [
    { slug: "bike-tour",        title: "Old Quarter Night Bike Tour",      description: "Electric bikes through District 1 back streets at night. Markets, temples, French-colonial buildings, and pho stop.",                    category: "culture",    going: 21, capacity: 20,  latOff: -0.001, lngOff:  0.002 },
    { slug: "pho-coffee",       title: "Pho & Cà Phê Sữa Đá Morning",     description: "Vietnamese breakfast done properly — pho bo at 7 am, then iced coffee at a pavement café. Walk between two local spots.",               category: "food",       going: 14, capacity: 15,  latOff:  0.002, lngOff: -0.001 },
    { slug: "rooftop-crawl-hcm","title": "Bùi Viện Rooftop Crawl",        description: "The backpacker street taken vertical. Three rooftop bars, cheap fresh beer, and a crowd that's always in a good mood.",                 category: "nightlife",  going: 49, capacity: 80,  latOff: -0.003, lngOff:  0.003 },
    { slug: "ben-thanh-night",  title: "Bến Thành Night Market Social",   description: "Street food, clothing stalls, and local craft vendors around the landmark market. Go hungry and leave with bags full.",                  category: "food",       going: 36, capacity: 200, latOff:  0.001, lngOff:  0.001 },
    { slug: "street-food-hcm",  title: "Bánh Mì & Beer Street Food Walk", description: "A local's guide to the best bánh mì, bún bò Huế, and bia hơi spots in Districts 1 and 3. No tourist menus.",                            category: "food",       going: 22, capacity: 18,  latOff:  0.003, lngOff: -0.002 },
  ],
  "Lisbon": [
    { slug: "fado-night",       title: "Fado Night in Alfama",             description: "Intimate fado restaurant in Alfama's oldest neighbourhood. Soulful singing, Portuguese wine, and bacalhau for dinner.",                  category: "culture",    going: 27, capacity: 30,  latOff: -0.002, lngOff:  0.001 },
    { slug: "miradouro-sunset", title: "Portas do Sol Sunset Gathering",   description: "Lisbon's best-loved viewpoint at magic hour. BYOB, meet travelers, watch the light turn the Tagus to gold.",                            category: "social",     going: 38, capacity: 150, latOff:  0.001, lngOff: -0.002 },
    { slug: "pastel-tasting",   title: "Pastéis de Nata Tasting Tour",     description: "Three pastry shops, one tasting at each. The classic from Belém vs the challengers. Espresso included.",                                category: "food",       going: 16, capacity: 12,  latOff:  0.003, lngOff:  0.002 },
    { slug: "tuk-tuk-tour",     title: "Old Town Tuk-Tuk Night Tour",      description: "Electric tuk-tuks through Baixa, Chiado, and Bairro Alto. Stops at three miradouros and a ginjinha bar.",                               category: "culture",    going: 20, capacity: 24,  latOff: -0.001, lngOff: -0.001 },
    { slug: "rooftop-lisbon",   title: "Bairro Alto Rooftop Social",       description: "Rooftop at TOPO Chiado with Castelo de São Jorge in view. Aperol spritz crowd. Good for meeting solo travelers.",                        category: "nightlife",  going: 31, capacity: 80,  latOff:  0.002, lngOff:  0.003 },
  ],
  "Mexico City": [
    { slug: "lucha-libre",      title: "Lucha Libre Night at Arena México", description: "The real deal — Lucha Libre at Mexico's most famous arena. Masks, acrobatics, drama. A local buys the first tequila.",                 category: "culture",    going: 38, capacity: 200, latOff:  0.003, lngOff: -0.001 },
    { slug: "mezcal-crawl",     title: "Condesa Mezcal Bar Crawl",         description: "Three mezcalerías in Roma Norte and Condesa. Smoky, salty, and accompanied by crickets (the insect kind — optional).",                  category: "nightlife",  going: 24, capacity: 30,  latOff: -0.002, lngOff:  0.002 },
    { slug: "frida-tour",       title: "Frida Kahlo Museum Night Tour",    description: "Casa Azul during special evening hours — far fewer people, candlelit courtyard, and guided interpretation of the collection.",           category: "culture",    going: 14, capacity: 25,  latOff:  0.001, lngOff: -0.003 },
    { slug: "taco-walk",        title: "CDMX Street Taco Walk",            description: "Taco al pastor from El Huequito, barbacoa from a Saturday specialist, and a tlayuda to finish. All in four blocks of the Centro.",       category: "food",       going: 31, capacity: 20,  latOff: -0.001, lngOff:  0.001 },
    { slug: "rooftop-cdmx",     title: "Roma Norte Rooftop Sunset",        description: "Art Deco rooftop bar in one of CDMX's most beautiful neighbourhoods. Micheladas, tamarind margaritas, and great conversation.",          category: "nightlife",  going: 27, capacity: 60,  latOff:  0.002, lngOff:  0.002 },
  ],
};

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getTargetProfile() {
  const { data: authUsers, error: authError } = await (sc.auth.admin as any).listUsers({ perPage: 200 });
  if (authError) throw authError;
  const authUser = (authUsers?.users ?? []).find((u: any) => u.email === EMAIL);
  if (!authUser) throw new Error(`Auth user not found for ${EMAIL}`);

  const { data: profile, error: profileError } = await sc
    .from("profiles")
    .select("id, display_name, handle")
    .eq("id", authUser.id)
    .single();
  if (profileError || !profile) throw profileError ?? new Error("Profile not found");
  return { authUser, profile };
}

async function upsertRows(table: string, rows: any[]) {
  if (DRY_RUN) {
    console.log(`  [dry-run] would upsert ${rows.length} rows into ${table}`);
    return { ok: true };
  }
  const { error } = await sc.from(table).upsert(rows, { onConflict: "id" });
  if (error) { console.error(`  ✗ ${table}:`, error.message); return { ok: false }; }
  return { ok: true };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🌍 seed-demo-city-events — ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  console.log(`   Target: ${EMAIL}`);
  console.log(`   starts_at : ${startsAt}`);
  console.log(`   ends_at   : ${endsAt}\n`);

  const { profile } = await getTargetProfile();
  const hostId = profile.id;
  console.log(`✅ Host: ${profile.display_name ?? profile.handle} (${hostId})\n`);

  const rows: any[] = [];

  for (const cityDef of CITIES) {
    const events = CITY_EVENTS[cityDef.city];
    if (!events) { console.warn(`  ⚠ No events defined for "${cityDef.city}" — skipping`); continue; }

    console.log(`📍 ${cityDef.city} — ${events.length} events`);
    for (const ev of events) {
      const id = uuidv5(`demo-city-event:${cityDef.city}:${ev.slug}`);
      rows.push({
        id,
        host_id:            hostId,
        title:              ev.title,
        description:        ev.description,
        city:               cityDef.city,
        country:            cityDef.country,
        location_name:      `${ev.title} — ${cityDef.city}`,
        location_lat:       cityDef.lat + ev.latOff,
        location_lng:       cityDef.lng + ev.lngOff,
        starts_at:          startsAt,
        ends_at:            endsAt,
        state:              "open",
        visibility:         "public",
        category:           ev.category,
        going_count:        ev.going,
        max_attendees:      ev.capacity,
        waitlist_enabled:   false,
        rsvp_closed:        false,
        show_exact_location: true,
        chat_enabled:       false,
        is_recurring:       false,
        tags:               ["demo", "demo_seed", ev.category],
      });
    }
  }

  console.log(`\n⬆  Upserting ${rows.length} event rows…`);
  const result = await upsertRows("events", rows);
  if (!result.ok) { console.error("\n✗ Upsert failed — check errors above."); process.exit(1); }

  console.log(`\n✅ Done — ${rows.length} demo events seeded across ${CITIES.length} cities.`);
  console.log(`   Events are live for ~8 hours. Re-run this script to refresh them.\n`);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
