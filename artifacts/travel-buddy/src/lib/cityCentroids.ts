/**
 * cityCentroids.ts — city name → [latitude, longitude] centroids.
 *
 * Used by EventCard (and similar surfaces) to seed the map camera with a
 * city-level starting position before entity data loads.  The values are
 * approximate city centres — enough to give the user a recognisable view
 * while useMapEntities fetches and focusId snaps to the precise pin.
 *
 * Keys are English display names as stored in the `city` field of CityEvent.
 * Common alternate spellings are included for robustness.
 */
export const CITY_CENTROIDS: Record<string, [number, number]> = {
  // ── Southeast Asia ───────────────────────────────────────────────────────────
  'Bangkok':          [13.7563,  100.5018],
  'Bali':             [-8.4095,  115.1889],
  'Cebu City':        [10.3157,  123.8854],
  'Da Nang':          [16.0544,  108.2022],
  'Hanoi':            [21.0285,  105.8542],
  'Ho Chi Minh City': [10.8231,  106.6297],
  'Jakarta':          [-6.2088,  106.8456],
  'Kuala Lumpur':     [ 3.1390,  101.6869],
  'Manila':           [14.5995,  120.9842],
  'Phuket':           [ 7.8804,   98.3923],
  'Saigon':           [10.8231,  106.6297],
  'Singapore':        [ 1.3521,  103.8198],
  'Ubud':             [-8.5069,  115.2625],
  'Yangon':           [16.8661,   96.1951],

  // ── East Asia ────────────────────────────────────────────────────────────────
  'Beijing':          [39.9042,  116.4074],
  'Busan':            [35.1796,  129.0756],
  'Chengdu':          [30.5728,  104.0668],
  'Fukuoka':          [33.5904,  130.4017],
  'Guangzhou':        [23.1291,  113.2644],
  'Hong Kong':        [22.3193,  114.1694],
  'Kyoto':            [35.0116,  135.7681],
  'Osaka':            [34.6937,  135.5023],
  'Seoul':            [37.5665,  126.9780],
  'Shanghai':         [31.2304,  121.4737],
  'Taipei':           [25.0330,  121.5654],
  'Tokyo':            [35.6762,  139.6503],

  // ── South Asia ───────────────────────────────────────────────────────────────
  'Bangalore':        [12.9716,   77.5946],
  'Bengaluru':        [12.9716,   77.5946],
  'Chennai':          [13.0827,   80.2707],
  'Colombo':          [ 6.9271,   79.8612],
  'Delhi':            [28.7041,   77.1025],
  'Dhaka':            [23.8103,   90.4125],
  'Kathmandu':        [27.7172,   85.3240],
  'Mumbai':           [19.0760,   72.8777],
  'New Delhi':        [28.6139,   77.2090],

  // ── Middle East ──────────────────────────────────────────────────────────────
  'Abu Dhabi':        [24.4539,   54.3773],
  'Amman':            [31.9454,   35.9284],
  'Beirut':           [33.8938,   35.5018],
  'Dubai':            [25.2048,   55.2708],
  'Istanbul':         [41.0082,   28.9784],
  'Riyadh':           [24.7136,   46.6753],
  'Tel Aviv':         [32.0853,   34.7818],

  // ── Europe ───────────────────────────────────────────────────────────────────
  'Amsterdam':        [52.3676,    4.9041],
  'Athens':           [37.9838,   23.7275],
  'Barcelona':        [41.3851,    2.1734],
  'Berlin':           [52.5200,   13.4050],
  'Brussels':         [50.8503,    4.3517],
  'Budapest':         [47.4979,   19.0402],
  'Copenhagen':       [55.6761,   12.5683],
  'Dublin':           [53.3498,   -6.2603],
  'Edinburgh':        [55.9533,   -3.1883],
  'Florence':         [43.7696,   11.2558],
  'Frankfurt':        [50.1109,    8.6821],
  'Geneva':           [46.2044,    6.1432],
  'Lisbon':           [38.7169,   -9.1395],
  'London':           [51.5074,   -0.1278],
  'Madrid':           [40.4168,   -3.7038],
  'Milan':            [45.4642,    9.1900],
  'Munich':           [48.1351,   11.5820],
  'Oslo':             [59.9139,   10.7522],
  'Paris':            [48.8566,    2.3522],
  'Prague':           [50.0755,   14.4378],
  'Rome':             [41.9028,   12.4964],
  'Stockholm':        [59.3293,   18.0686],
  'Vienna':           [48.2082,   16.3738],
  'Warsaw':           [52.2297,   21.0122],
  'Zurich':           [47.3769,    8.5417],

  // ── Africa ───────────────────────────────────────────────────────────────────
  'Cairo':            [30.0444,   31.2357],
  'Cape Town':        [-33.9249,  18.4241],
  'Casablanca':       [33.5731,   -7.5898],
  'Johannesburg':     [-26.2041,  28.0473],
  'Lagos':            [ 6.5244,    3.3792],
  'Marrakech':        [31.6295,   -7.9811],
  'Nairobi':          [-1.2921,   36.8219],

  // ── Americas ─────────────────────────────────────────────────────────────────
  'Austin':           [30.2672,  -97.7431],
  'Bogotá':           [ 4.7110,  -74.0721],
  'Bogota':           [ 4.7110,  -74.0721],
  'Boston':           [42.3601,  -71.0589],
  'Buenos Aires':     [-34.6037, -58.3816],
  'Chicago':          [41.8781,  -87.6298],
  'Denver':           [39.7392,  -104.9903],
  'Guadalajara':      [20.6597, -103.3496],
  'Las Vegas':        [36.1699, -115.1398],
  'Lima':             [-12.0464,  -77.0428],
  'Los Angeles':      [34.0522, -118.2437],
  'Medellín':         [ 6.2442,  -75.5812],
  'Medellin':         [ 6.2442,  -75.5812],
  'Mexico City':      [19.4326,  -99.1332],
  'Miami':            [25.7617,  -80.1918],
  'Montréal':         [45.5017,  -73.5673],
  'Montreal':         [45.5017,  -73.5673],
  'New York':         [40.7128,  -74.0060],
  'New York City':    [40.7128,  -74.0060],
  'NYC':              [40.7128,  -74.0060],
  'Rio de Janeiro':   [-22.9068,  -43.1729],
  'San Francisco':    [37.7749, -122.4194],
  'Santiago':         [-33.4489,  -70.6693],
  'São Paulo':        [-23.5505,  -46.6333],
  'Sao Paulo':        [-23.5505,  -46.6333],
  'Seattle':          [47.6062, -122.3321],
  'Toronto':          [43.6532,  -79.3832],
  'Vancouver':        [49.2827, -123.1207],

  // ── Oceania ──────────────────────────────────────────────────────────────────
  'Auckland':         [-36.8509,  174.7645],
  'Melbourne':        [-37.8136,  144.9631],
  'Sydney':           [-33.8688,  151.2093],
};
