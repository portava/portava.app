-- 0075_seed_discovery_places.sql
-- Seed data: 44 curated discovery_places across 5 cities (Cebu, Manila, Bali, Bangkok, Singapore).
-- Places use status='active', verified=true, source='curated'.
-- These rows ensure the DB-merge path in GET /api/discovery/community surfaces results
-- even before any user-submitted places exist, and the Pulse Wall can show place cards.
-- Safe to re-run: ON CONFLICT (id) DO NOTHING prevents duplicates.

-- ─── Cebu ────────────────────────────────────────────────────────────────────

INSERT INTO discovery_places
  (id, city, name, place_type, category, neighborhood, blurb, image_url, rating, lat, lng, tag, source, status, verified, saved_count)
VALUES
  ('a1b2c301-0000-0000-0000-000000000001', 'Cebu', 'Magellan''s Cross', 'landmark', 'attraction',      'Cebu City',      'A 16th-century cross planted by Portuguese explorer Ferdinand Magellan — one of the oldest Christian relics in the Philippines.',
   'https://images.unsplash.com/photo-1518548419970-58e3b4079ab2?w=800&auto=format', 4.6, 10.2939, 123.9027, 'historic',    'curated', 'active', true, 0),

  ('a1b2c301-0000-0000-0000-000000000002', 'Cebu', 'Temple of Leah', 'landmark', 'attraction',         'Busay',          'A grand Greco-Roman-inspired temple built as a testament of love, perched on a hilltop with sweeping views of Cebu City.',
   'https://images.unsplash.com/photo-1548013146-72479768bada?w=800&auto=format', 4.4, 10.3503, 123.9182, 'romantic',   'curated', 'active', true, 0),

  ('a1b2c301-0000-0000-0000-000000000003', 'Cebu', 'Tops Lookout', 'viewpoint', 'activities',          'Busay',          'The highest accessible viewpoint in Cebu City. Arrive at dusk for a stunning panorama of the city lights and harbour.',
   'https://images.unsplash.com/photo-1484824823219-0cd77ad86098?w=800&auto=format', 4.5, 10.3347, 123.9112, 'viewpoint',  'curated', 'active', true, 0),

  ('a1b2c301-0000-0000-0000-000000000004', 'Cebu', 'Sirao Flower Garden', 'garden', 'activities',      'Busay',          'A hillside garden bursting with celosia blooms — locals call it "Little Amsterdam". Best visited in the cool morning.',
   'https://images.unsplash.com/photo-1506744038136-46273834b3fb?w=800&auto=format', 4.3, 10.3597, 123.9167, 'garden',     'curated', 'active', true, 0),

  ('a1b2c301-0000-0000-0000-000000000005', 'Cebu', 'Cebu Taoist Temple', 'temple', 'attraction',       'Beverly Hills',  'Colourful hilltop Taoist shrine popular with both devotees and sightseers. Fortune-telling sticks and incense fill the air.',
   'https://images.unsplash.com/photo-1508193638397-1c4234db14d8?w=800&auto=format', 4.2, 10.3347, 123.9071, 'spiritual',  'curated', 'active', true, 0),

  ('a1b2c301-0000-0000-0000-000000000006', 'Cebu', 'Carbon Public Market', 'market', 'food',           'Cebu City',      'The largest and oldest public market in Cebu — the go-to spot for fresh produce, dried fish, flowers, and local street snacks.',
   'https://images.unsplash.com/photo-1578662996442-48f60103fc96?w=800&auto=format', 4.0, 10.2951, 123.9023, 'local',      'curated', 'active', true, 0),

  ('a1b2c301-0000-0000-0000-000000000007', 'Cebu', 'House of Lechon', 'restaurant', 'food',            'Kapitolyo',      'Widely regarded as Cebu''s best lechon (roast pig). Order the classic or the spicy variant — both are melt-in-your-mouth.',
   'https://images.unsplash.com/photo-1414235077428-338989a2e8c0?w=800&auto=format', 4.7, 10.3012, 123.8948, 'must-eat',   'curated', 'active', true, 0),

  ('a1b2c301-0000-0000-0000-000000000008', 'Cebu', 'Sutukil Seafood at SCM', 'restaurant', 'food',     'Lapu-Lapu City', 'Sutukil (sugba-tula-kilaw) is Cebu''s fresh-seafood cooking style. Pick your fish at the stalls and have it grilled tableside.',
   'https://images.unsplash.com/photo-1552566626-52f8b828add9?w=800&auto=format', 4.4, 10.2987, 123.9040, 'seafood',    'curated', 'active', true, 0),

  ('a1b2c301-0000-0000-0000-000000000009', 'Cebu', 'Moalboal Beach', 'beach', 'beaches',               'Moalboal',       'Famous for its sardine run — millions of fish swirl in a living tornado just metres from shore. One of the best snorkels in Asia.',
   'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=800&auto=format', 4.8, 9.9409, 123.3965,  'snorkeling',  'curated', 'active', true, 0),

  ('a1b2c301-0000-0000-0000-000000000010', 'Cebu', 'SM Seaside City Cebu', 'mall', 'places',           'South Road Properties', 'The largest mall in Visayas. The rooftop Sky Park has a glass walkway and sweeping views of Cebu Strait.',
   'https://images.unsplash.com/photo-1472851294608-ac8e29b3a8b8?w=800&auto=format', 4.1, 10.2769, 123.8867, 'shopping',   'curated', 'active', true, 0),

-- ─── Manila ───────────────────────────────────────────────────────────────────

  ('a1b2c302-0000-0000-0000-000000000001', 'Manila', 'Intramuros', 'historic district', 'attraction',  'Intramuros',     'The walled city of Manila — centuries-old Spanish fortifications, cobblestone streets, and Fort Santiago make it the heart of old Manila.',
   'https://images.unsplash.com/photo-1518548419970-58e3b4079ab2?w=800&auto=format', 4.5, 14.5890, 120.9770, 'historic',  'curated', 'active', true, 0),

  ('a1b2c302-0000-0000-0000-000000000002', 'Manila', 'Binondo Chinatown', 'neighborhood', 'food',      'Binondo',        'The world''s oldest Chinatown (est. 1594). Packed with dimsum parlors, Filipino-Chinese restaurants, and century-old bakeries.',
   'https://images.unsplash.com/photo-1578662996442-48f60103fc96?w=800&auto=format', 4.4, 14.5991, 120.9742, 'chinatown', 'curated', 'active', true, 0),

  ('a1b2c302-0000-0000-0000-000000000003', 'Manila', 'Rizal Park', 'park', 'activities',               'Ermita',         'Manila''s central park and the country''s national shrine. The monument of national hero Jose Rizal draws visitors from across the Philippines.',
   'https://images.unsplash.com/photo-1441974231531-c6227db76b6e?w=800&auto=format', 4.3, 14.5822, 120.9792, 'landmark',  'curated', 'active', true, 0),

  ('a1b2c302-0000-0000-0000-000000000004', 'Manila', 'National Museum of Fine Arts', 'museum', 'events', 'Ermita',       'Free-entry museum housed in a stunning neoclassical building. Home to Juan Luna''s monumental painting Spoliarium.',
   'https://images.unsplash.com/photo-1544967082-d9d25d867d66?w=800&auto=format', 4.7, 14.5872, 120.9808, 'art',         'curated', 'active', true, 0),

  ('a1b2c302-0000-0000-0000-000000000005', 'Manila', 'BGC High Street', 'shopping district', 'places', 'Bonifacio Global City', 'Manila''s upscale pedestrian strip lined with galleries, cafes, murals, and the best weekend night market in the metro.',
   'https://images.unsplash.com/photo-1472851294608-ac8e29b3a8b8?w=800&auto=format', 4.4, 14.5503, 121.0502, 'trendy',   'curated', 'active', true, 0),

  ('a1b2c302-0000-0000-0000-000000000006', 'Manila', 'Cafe Ysabel', 'cafe', 'food',                    'San Juan',       'A beloved heritage restaurant in a restored colonial house. The Filipino-European menu and garden setting make it ideal for a long lunch.',
   'https://images.unsplash.com/photo-1414235077428-338989a2e8c0?w=800&auto=format', 4.5, 14.5726, 121.0283, 'heritage',  'curated', 'active', true, 0),

  ('a1b2c302-0000-0000-0000-000000000007', 'Manila', 'Quiapo Church', 'church', 'attraction',          'Quiapo',         'Home of the Black Nazarene, a centuries-old dark-skinned image of Christ. The surrounding plaza bursts with faith and commerce.',
   'https://images.unsplash.com/photo-1548013146-72479768bada?w=800&auto=format', 4.3, 14.5982, 120.9840, 'spiritual',   'curated', 'active', true, 0),

  ('a1b2c302-0000-0000-0000-000000000008', 'Manila', 'La Mesa Eco Park', 'park', 'activities',         'Novaliches',     'A 2000-hectare watershed reserve with swimming lagoons, zip lines, and nature trails inside Metro Manila. A true urban escape.',
   'https://images.unsplash.com/photo-1506744038136-46273834b3fb?w=800&auto=format', 4.2, 14.7156, 121.0500, 'nature',    'curated', 'active', true, 0),

-- ─── Bali ─────────────────────────────────────────────────────────────────────

  ('a1b2c303-0000-0000-0000-000000000001', 'Bali', 'Tanah Lot Temple', 'temple', 'attraction',         'Tabanan',        'Bali''s most iconic sea temple, perched on a rock formation at sunset. Arrive early to beat the crowds and catch the golden hour.',
   'https://images.unsplash.com/photo-1508193638397-1c4234db14d8?w=800&auto=format', 4.6, -8.6215, 115.0867, 'iconic',    'curated', 'active', true, 0),

  ('a1b2c303-0000-0000-0000-000000000002', 'Bali', 'Ubud Art Market', 'market', 'places',              'Ubud',           'A lively open-air market at the heart of Ubud selling wood carvings, batik, silver jewellery, and handmade crafts.',
   'https://images.unsplash.com/photo-1578662996442-48f60103fc96?w=800&auto=format', 4.3, -8.5069, 115.2625, 'crafts',   'curated', 'active', true, 0),

  ('a1b2c303-0000-0000-0000-000000000003', 'Bali', 'Sacred Monkey Forest Sanctuary', 'nature reserve', 'activities', 'Ubud', 'A lush forest reserve housing over 700 Balinese long-tailed macaques. Three temples are tucked among the ancient trees.',
   'https://images.unsplash.com/photo-1507561285-f53a1e2abecf?w=800&auto=format', 4.5, -8.5180, 115.2590, 'wildlife',  'curated', 'active', true, 0),

  ('a1b2c303-0000-0000-0000-000000000004', 'Bali', 'Tegallalang Rice Terraces', 'natural landmark', 'activities', 'Tegallalang', 'Cascading emerald rice paddies carved into a steep valley north of Ubud. The cooperative irrigation system (subak) is UNESCO-listed.',
   'https://images.unsplash.com/photo-1537996194471-e657df975ab4?w=800&auto=format', 4.6, -8.4313, 115.2785, 'unesco',   'curated', 'active', true, 0),

  ('a1b2c303-0000-0000-0000-000000000005', 'Bali', 'Mount Batur', 'volcano', 'activities',             'Kintamani',      'A 1717m active volcano with a caldera lake. Pre-dawn hikes reward trekkers with a sunrise above the clouds that is hard to beat.',
   'https://images.unsplash.com/photo-1484824823219-0cd77ad86098?w=800&auto=format', 4.7, -8.2423, 115.3750, 'hiking',   'curated', 'active', true, 0),

  ('a1b2c303-0000-0000-0000-000000000006', 'Bali', 'Seminyak Beach', 'beach', 'beaches',               'Seminyak',       'Wide, uncrowded and backed by stylish beach clubs. Famous for spectacular sunsets and a lively surf break.',
   'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=800&auto=format', 4.5, -8.6850, 115.1545, 'sunset',   'curated', 'active', true, 0),

  ('a1b2c303-0000-0000-0000-000000000007', 'Bali', 'Canggu Beach', 'beach', 'beaches',                 'Canggu',         'A laid-back surf beach with rice-field backdrops, beloved by digital nomads and long-stay travellers.',
   'https://images.unsplash.com/photo-1506744038136-46273834b3fb?w=800&auto=format', 4.4, -8.6478, 115.1286, 'surf',     'curated', 'active', true, 0),

  ('a1b2c303-0000-0000-0000-000000000008', 'Bali', 'Warung Babi Guling Ibu Oka', 'restaurant', 'food', 'Ubud',           'The most famous babi guling (suckling pig) warung in Ubud. Queues form early — portions sell out well before noon.',
   'https://images.unsplash.com/photo-1414235077428-338989a2e8c0?w=800&auto=format', 4.6, -8.5063, 115.2624, 'must-eat', 'curated', 'active', true, 0),

  ('a1b2c303-0000-0000-0000-000000000009', 'Bali', 'Potato Head Beach Club', 'beach club', 'nightlife', 'Seminyak',      'Bali''s most architecturally striking beach club — a wall of recycled doors frames the pool and the Indian Ocean beyond.',
   'https://images.unsplash.com/photo-1541167760496-1628856ab772?w=800&auto=format', 4.4, -8.6922, 115.1572, 'beach club', 'curated', 'active', true, 0),

  ('a1b2c303-0000-0000-0000-000000000010', 'Bali', 'Ku De Ta Seminyak', 'bar', 'nightlife',            'Seminyak',       'Iconic sunset cocktail bar and restaurant on Seminyak beach. The DJ sets and ocean views make it a Bali institution.',
   'https://images.unsplash.com/photo-1541167760496-1628856ab772?w=800&auto=format', 4.3, -8.6910, 115.1580, 'cocktails', 'curated', 'active', true, 0),

-- ─── Bangkok ──────────────────────────────────────────────────────────────────

  ('a1b2c304-0000-0000-0000-000000000001', 'Bangkok', 'Wat Pho', 'temple', 'attraction',               'Phra Nakhon',    'Home to the 46m-long gilded Reclining Buddha. One of Bangkok''s oldest and largest temple complexes, also the birthplace of traditional Thai massage.',
   'https://images.unsplash.com/photo-1508193638397-1c4234db14d8?w=800&auto=format', 4.7, 13.7465, 100.4929, 'temple',   'curated', 'active', true, 0),

  ('a1b2c304-0000-0000-0000-000000000002', 'Bangkok', 'Chatuchak Weekend Market', 'market', 'places',  'Chatuchak',      'One of the world''s largest weekend markets — 15,000 stalls across 35 acres. Vintage clothes, plants, street food, ceramics, and everything in between.',
   'https://images.unsplash.com/photo-1578662996442-48f60103fc96?w=800&auto=format', 4.5, 13.8000, 100.5501, 'market',   'curated', 'active', true, 0),

  ('a1b2c304-0000-0000-0000-000000000003', 'Bangkok', 'Jay Fai Restaurant', 'restaurant', 'food',      'Phra Nakhon',    'A Michelin-starred street-food stall run by an octogenarian chef in goggles. The crab omelette and dry tom yum are worth the 2-hour wait.',
   'https://images.unsplash.com/photo-1552566626-52f8b828add9?w=800&auto=format', 4.7, 13.7575, 100.5025, 'michelin',  'curated', 'active', true, 0),

  ('a1b2c304-0000-0000-0000-000000000004', 'Bangkok', 'Khao San Road', 'street', 'nightlife',          'Phra Nakhon',    'Bangkok''s legendary backpacker strip — cheap pad thai, buckets of cocktails, street performers, and late-night revelry every night of the week.',
   'https://images.unsplash.com/photo-1541167760496-1628856ab772?w=800&auto=format', 4.0, 13.7584, 100.4975, 'nightlife', 'curated', 'active', true, 0),

  ('a1b2c304-0000-0000-0000-000000000005', 'Bangkok', 'Lumpini Park', 'park', 'activities',            'Pathum Wan',     'Bangkok''s green lung — 57 hectares of lakes and lawns where locals tai chi at dawn and rent paddle boats at the weekend.',
   'https://images.unsplash.com/photo-1441974231531-c6227db76b6e?w=800&auto=format', 4.4, 13.7313, 100.5419, 'park',     'curated', 'active', true, 0),

  ('a1b2c304-0000-0000-0000-000000000006', 'Bangkok', 'Vertigo Rooftop Bar', 'bar', 'nightlife',       'Silom',          'Open-air rooftop bar on the 61st floor of the Banyan Tree hotel. 360-degree views of the Bangkok skyline and the Chao Phraya river.',
   'https://images.unsplash.com/photo-1541167760496-1628856ab772?w=800&auto=format', 4.5, 13.7249, 100.5400, 'rooftop', 'curated', 'active', true, 0),

  ('a1b2c304-0000-0000-0000-000000000007', 'Bangkok', 'Asiatique The Riverfront', 'shopping', 'places', 'Charoen Krung', 'A sprawling riverside night bazaar in a restored 1900s dockyard. Great for souvenir shopping, street food, and evening Ferris wheel rides.',
   'https://images.unsplash.com/photo-1472851294608-ac8e29b3a8b8?w=800&auto=format', 4.3, 13.7198, 100.5097, 'riverfront', 'curated', 'active', true, 0),

  ('a1b2c304-0000-0000-0000-000000000008', 'Bangkok', 'Lumphini Muay Thai Stadium', 'stadium', 'events', 'Pathum Wan',   'One of Bangkok''s two premier Muay Thai stadiums. Matches run Tuesday, Friday, and Saturday — a raw, electric atmosphere unlike anything else.',
   'https://images.unsplash.com/photo-1544967082-d9d25d867d66?w=800&auto=format', 4.6, 13.7224, 100.5344, 'sport',    'curated', 'active', true, 0),

-- ─── Singapore ───────────────────────────────────────────────────────────────

  ('a1b2c305-0000-0000-0000-000000000001', 'Singapore', 'Gardens by the Bay', 'attraction', 'activities', 'Marina Bay', 'Futuristic nature park anchored by towering Supertrees. The Cloud Forest and Flower Dome conservatories are unmissable.',
   'https://images.unsplash.com/photo-1506744038136-46273834b3fb?w=800&auto=format', 4.8, 1.2816, 103.8636,   'iconic',  'curated', 'active', true, 0),

  ('a1b2c305-0000-0000-0000-000000000002', 'Singapore', 'Marina Bay Sands SkyPark', 'attraction', 'activities', 'Marina Bay', 'The infinity pool straddling three 55-storey towers is a bucket-list view. Non-hotel guests can access the observation deck.',
   'https://images.unsplash.com/photo-1484824823219-0cd77ad86098?w=800&auto=format', 4.7, 1.2841, 103.8607, 'views',    'curated', 'active', true, 0),

  ('a1b2c305-0000-0000-0000-000000000003', 'Singapore', 'Maxwell Food Centre', 'hawker centre', 'food', 'Tanjong Pagar', 'Singapore''s most beloved hawker centre. Tian Tian chicken rice (as seen on Anthony Bourdain) draws queues every lunchtime.',
   'https://images.unsplash.com/photo-1552566626-52f8b828add9?w=800&auto=format', 4.6, 1.2802, 103.8452,   'hawker',   'curated', 'active', true, 0),

  ('a1b2c305-0000-0000-0000-000000000004', 'Singapore', 'Lau Pa Sat', 'hawker centre', 'food',          'Raffles Place', 'A Victorian cast-iron market from 1894 now housing a hawker centre. After 7pm the surrounding streets become a satay night market.',
   'https://images.unsplash.com/photo-1414235077428-338989a2e8c0?w=800&auto=format', 4.4, 1.2805, 103.8503,  'historic', 'curated', 'active', true, 0),

  ('a1b2c305-0000-0000-0000-000000000005', 'Singapore', 'Haji Lane', 'street', 'places',               'Kampong Glam',   'The narrowest street in Singapore, packed with indie boutiques, cafes, and street art — the bohemian heart of Kampong Glam.',
   'https://images.unsplash.com/photo-1472851294608-ac8e29b3a8b8?w=800&auto=format', 4.5, 1.3019, 103.8588,  'indie',    'curated', 'active', true, 0),

  ('a1b2c305-0000-0000-0000-000000000006', 'Singapore', 'Clarke Quay', 'entertainment district', 'nightlife', 'Clarke Quay', 'Singapore''s nightlife hub on the Singapore River. Heritage shophouses pack in clubs, cocktail bars, and riverside restaurants.',
   'https://images.unsplash.com/photo-1541167760496-1628856ab772?w=800&auto=format', 4.3, 1.2886, 103.8463,  'nightlife', 'curated', 'active', true, 0),

  ('a1b2c305-0000-0000-0000-000000000007', 'Singapore', 'Sentosa Island', 'island', 'beaches',         'Sentosa',        'Singapore''s resort island — Universal Studios, Siloso Beach, an aquarium, and cable cars, all within 30 minutes of the CBD.',
   'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=800&auto=format', 4.5, 1.2494, 103.8303,  'resort',   'curated', 'active', true, 0),

  ('a1b2c305-0000-0000-0000-000000000008', 'Singapore', 'Newton Food Centre', 'hawker centre', 'food',  'Novena',         'An open-air hawker centre that has attracted tourists since the 1970s. Chilli crab, char kway teow, and satay are the standouts.',
   'https://images.unsplash.com/photo-1552566626-52f8b828add9?w=800&auto=format', 4.2, 1.3118, 103.8384,  'hawker',   'curated', 'active', true, 0),

  ('a1b2c305-0000-0000-0000-000000000009', 'Singapore', 'Chinatown Heritage Centre', 'museum', 'events', 'Chinatown',    'A living museum inside three restored shophouses that tells the story of Singapore''s Chinese immigrant pioneers through immersive recreations.',
   'https://images.unsplash.com/photo-1544967082-d9d25d867d66?w=800&auto=format', 4.4, 1.2830, 103.8448,  'museum',   'curated', 'active', true, 0),

  ('a1b2c305-0000-0000-0000-000000000010', 'Singapore', 'East Coast Park', 'park', 'activities',       'East Coast',     'A 15km seafront park popular for cycling, rollerblading, and barbecues. The long stretch of beach is rare green space in Singapore.',
   'https://images.unsplash.com/photo-1441974231531-c6227db76b6e?w=800&auto=format', 4.4, 1.3000, 103.9120,  'cycling',  'curated', 'active', true, 0)

ON CONFLICT (id) DO NOTHING;
