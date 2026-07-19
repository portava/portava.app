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
  'Bandung':          [-6.9175,  107.6191],
  'Cebu City':        [10.3157,  123.8854],
  'Chiang Mai':       [18.7883,   98.9853],
  'Da Nang':          [16.0544,  108.2022],
  'Davao City':       [ 7.1907,  125.4553],
  'George Town':      [ 5.4141,  100.3288],
  'Hanoi':            [21.0285,  105.8542],
  'Ho Chi Minh City': [10.8231,  106.6297],
  'Iloilo':           [10.7202,  122.5621],
  'Jakarta':          [-6.2088,  106.8456],
  'Johor Bahru':      [ 1.4927,  103.7414],
  'Kuala Lumpur':     [ 3.1390,  101.6869],
  'Manila':           [14.5995,  120.9842],
  'Medan':            [ 3.5952,   98.6722],
  'Naypyidaw':        [19.7633,   96.0785],
  'Pattaya':          [12.9236,  100.8825],
  'Penang':           [ 5.4141,  100.3288],
  'Phnom Penh':       [11.5564,  104.9282],
  'Phuket':           [ 7.8804,   98.3923],
  'Quezon City':      [14.6760,  121.0437],
  'Saigon':           [10.8231,  106.6297],
  'Siem Reap':        [13.3671,  103.8448],
  'Singapore':        [ 1.3521,  103.8198],
  'Surabaya':         [-7.2575,  112.7521],
  'Ubud':             [-8.5069,  115.2625],
  'Vientiane':        [17.9757,  102.6331],
  'Yangon':           [16.8661,   96.1951],

  // ── East Asia ────────────────────────────────────────────────────────────────
  'Beijing':          [39.9042,  116.4074],
  'Busan':            [35.1796,  129.0756],
  'Chengdu':          [30.5728,  104.0668],
  'Chongqing':        [29.5630,  106.5516],
  'Fukuoka':          [33.5904,  130.4017],
  'Guangzhou':        [23.1291,  113.2644],
  'Hangzhou':         [30.2741,  120.1551],
  'Hiroshima':        [34.3853,  132.4553],
  'Hong Kong':        [22.3193,  114.1694],
  'Incheon':          [37.4563,  126.7052],
  'Kyoto':            [35.0116,  135.7681],
  'Nagoya':           [35.1815,  136.9066],
  'Nanjing':          [32.0603,  118.7969],
  'Osaka':            [34.6937,  135.5023],
  'Sapporo':          [43.0618,  141.3545],
  'Seoul':            [37.5665,  126.9780],
  'Shanghai':         [31.2304,  121.4737],
  'Shenzhen':         [22.5431,  114.0579],
  'Taipei':           [25.0330,  121.5654],
  'Tianjin':          [39.3434,  117.3616],
  'Tokyo':            [35.6762,  139.6503],
  'Wuhan':            [30.5928,  114.3055],
  "Xi'an":            [34.3416,  108.9398],
  'Xian':             [34.3416,  108.9398],

  // ── South Asia ───────────────────────────────────────────────────────────────
  'Ahmedabad':        [23.0225,   72.5714],
  'Bangalore':        [12.9716,   77.5946],
  'Bengaluru':        [12.9716,   77.5946],
  'Calcutta':         [22.5726,   88.3639],
  'Chennai':          [13.0827,   80.2707],
  'Colombo':          [ 6.9271,   79.8612],
  'Delhi':            [28.7041,   77.1025],
  'Dhaka':            [23.8103,   90.4125],
  'Hyderabad':        [17.3850,   78.4867],
  'Islamabad':        [33.6844,   73.0479],
  'Karachi':          [24.8607,   67.0011],
  'Kathmandu':        [27.7172,   85.3240],
  'Kolkata':          [22.5726,   88.3639],
  'Lahore':           [31.5204,   74.3587],
  'Mumbai':           [19.0760,   72.8777],
  'New Delhi':        [28.6139,   77.2090],
  'Pune':             [18.5204,   73.8567],

  // ── Middle East ──────────────────────────────────────────────────────────────
  'Abu Dhabi':        [24.4539,   54.3773],
  'Amman':            [31.9454,   35.9284],
  'Baghdad':          [33.3152,   44.3661],
  'Beirut':           [33.8938,   35.5018],
  'Doha':             [25.2854,   51.5310],
  'Dubai':            [25.2048,   55.2708],
  'Istanbul':         [41.0082,   28.9784],
  'Jeddah':           [21.4858,   39.1925],
  'Kuwait City':      [29.3759,   47.9774],
  'Muscat':           [23.5880,   58.3829],
  'Riyadh':           [24.7136,   46.6753],
  'Tel Aviv':         [32.0853,   34.7818],
  'Tehran':           [35.6892,   51.3890],

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
  'Abidjan':          [ 5.3600,   -4.0083],
  'Accra':            [ 5.6037,   -0.1870],
  'Addis Ababa':      [ 9.0320,   38.7423],
  'Algiers':          [36.7372,    3.0865],
  'Cairo':            [30.0444,   31.2357],
  'Cape Town':        [-33.9249,  18.4241],
  'Casablanca':       [33.5731,   -7.5898],
  'Dakar':            [14.7167,  -17.4677],
  'Dar es Salaam':    [-6.7924,   39.2083],
  'Douala':           [ 4.0511,    9.7679],
  'Harare':           [-17.8252,  31.0335],
  'Johannesburg':     [-26.2041,  28.0473],
  'Kampala':          [ 0.3476,   32.5825],
  'Khartoum':         [15.5007,   32.5599],
  'Kigali':           [-1.9706,   30.1044],
  'Kumasi':           [ 6.6885,   -1.6244],
  'Lagos':            [ 6.5244,    3.3792],
  'Luanda':           [-8.8383,   13.2344],
  'Lusaka':           [-15.4166,  28.2833],
  'Maputo':           [-25.9692,  32.5732],
  'Marrakech':        [31.6295,   -7.9811],
  'Nairobi':          [-1.2921,   36.8219],
  'Tunis':            [36.8065,   10.1815],

  // ── Americas ─────────────────────────────────────────────────────────────────
  'Austin':           [30.2672,  -97.7431],
  'Bogotá':           [ 4.7110,  -74.0721],
  'Bogota':           [ 4.7110,  -74.0721],
  'Boston':           [42.3601,  -71.0589],
  'Buenos Aires':     [-34.6037, -58.3816],
  'Chicago':          [41.8781,  -87.6298],
  'Denver':           [39.7392, -104.9903],
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

  // ── Latin America (additional) ────────────────────────────────────────────────
  'Quito':            [-0.2295,  -78.5243],
  'Caracas':          [10.4806,  -66.9036],
  'Montevideo':       [-34.9011,  -56.1645],
  'Asunción':         [-25.2867,  -57.6470],
  'Asuncion':         [-25.2867,  -57.6470],
  'La Paz':           [-16.5000,  -68.1193],
  'Cochabamba':       [-17.3895,  -66.1568],
  'Guayaquil':        [-2.1962,   -79.8862],
  'Cali':             [ 3.4516,  -76.5320],
  'Barranquilla':     [10.9639,  -74.7964],
  'Cartagena':        [10.3910,  -75.4794],
  'Recife':           [-8.0476,  -34.8770],
  'Salvador':         [-12.9777,  -38.5016],
  'Fortaleza':        [-3.7172,   -38.5433],
  'Belo Horizonte':   [-19.9167,  -43.9345],
  'Curitiba':         [-25.4284,  -49.2733],
  'Porto Alegre':     [-30.0346,  -51.2177],
  'Managua':          [12.1364,  -86.2919],
  'San José':         [ 9.9281,  -84.0907],
  'San Jose':         [ 9.9281,  -84.0907],
  'Guatemala City':   [14.6349,  -90.5069],
  'Panama City':      [ 8.9936,  -79.5197],
  'Havana':           [23.1136,  -82.3666],
  'Santo Domingo':    [18.4861,  -69.9312],
  'San Juan':         [18.4655,  -66.1057],

  // ── Central Asia & South Caucasus ────────────────────────────────────────────
  'Tashkent':         [41.2995,   69.2401],
  'Almaty':           [43.2220,   76.8512],
  'Astana':           [51.1801,   71.4460],
  'Nur-Sultan':       [51.1801,   71.4460],
  'Baku':             [40.4093,   49.8671],
  'Tbilisi':          [41.6938,   44.8015],
  'Yerevan':          [40.1872,   44.5152],
  'Bishkek':          [42.8746,   74.5698],
  'Dushanbe':         [38.5598,   68.7733],
  'Ashgabat':         [37.9601,   58.3261],

  // ── Eastern Europe & Balkans ─────────────────────────────────────────────────
  'Kyiv':             [50.4501,   30.5234],
  'Kiev':             [50.4501,   30.5234],
  'Minsk':            [53.9045,   27.5615],
  'Chisinau':         [47.0105,   28.8638],
  'Chișinău':         [47.0105,   28.8638],
  'Belgrade':         [44.8176,   20.4569],
  'Skopje':           [41.9981,   21.4254],
  'Tirana':           [41.3275,   19.8187],
  'Sarajevo':         [43.8563,   18.4131],
  'Riga':             [56.9460,   24.1059],
  'Tallinn':          [59.4370,   24.7536],
  'Vilnius':          [54.6872,   25.2797],
  'Bucharest':        [44.4268,   26.1025],
  'Sofia':            [42.6977,   23.3219],
  'Zagreb':           [45.8150,   15.9819],
  'Ljubljana':        [46.0569,   14.5058],
  'Podgorica':        [42.4304,   19.2594],
  'Pristina':         [42.6629,   21.1655],
  'Bratislava':       [48.1486,   17.1077],
  'Krakow':           [50.0647,   19.9450],
  'Kraków':           [50.0647,   19.9450],
  'Lviv':             [49.8397,   24.0297],
  'Łódź':            [51.7592,   19.4560],
  'Odesa':            [46.4825,   30.7233],
  'Odessa':           [46.4825,   30.7233],

  // ── Scandinavia & Baltic (secondary cities) ──────────────────────────────────
  'Aarhus':           [56.1629,   10.2039],
  'Gdańsk':           [54.3520,   18.6466],
  'Gdansk':           [54.3520,   18.6466],
  'Gothenburg':       [57.7089,   11.9746],
  'Göteborg':         [57.7089,   11.9746],
  'Kaunas':           [54.8985,   23.9036],
  'Malmö':            [55.6050,   13.0038],
  'Malmo':            [55.6050,   13.0038],
  'Reykjavik':        [64.1355,  -21.8954],
  'Reykjavík':        [64.1355,  -21.8954],
  'Tampere':          [61.4978,   23.7610],
  'Tartu':            [58.3780,   26.7290],
  'Turku':            [60.4518,   22.2666],

  // ── Oceania ──────────────────────────────────────────────────────────────────
  'Auckland':         [-36.8509,  174.7645],
  'Brisbane':         [-27.4698,  153.0251],
  'Melbourne':        [-37.8136,  144.9631],
  'Perth':            [-31.9505,  115.8605],
  'Sydney':           [-33.8688,  151.2093],

  // ── North America (additional) ───────────────────────────────────────────────
  'Washington DC':    [38.9072,   -77.0369],
  'Washington D.C.':  [38.9072,   -77.0369],
  'Atlanta':          [33.7490,   -84.3880],
  'Dallas':           [32.7767,   -96.7970],
  'Houston':          [29.7604,   -95.3698],
  'Minneapolis':      [44.9778,   -93.2650],
  'Phoenix':          [33.4484,  -112.0740],
  'Portland':         [45.5051,  -122.6750],

  // ── Additional European cities (accented canonical form; no stripped alias) ─
  // These rely on the NFD diacritic-strip fallback in getCityCentroid rather
  // than a hand-maintained accent-stripped alias key.
  'Köln':             [50.9333,    6.9500],
  'Düsseldorf':       [51.2217,    6.7762],
};

/**
 * Country-level centroids — a last-resort fallback for event records that
 * store a country name (e.g. "Thailand", "United States") in the city field
 * instead of an actual city.  These values are approximate geographic centres
 * of the country, sufficient to give the map a non-blank starting position.
 *
 * Keys are common English country names (and a few ISO-3166 short forms).
 * The lookup is case-insensitive via the same normalisation applied to cities.
 */
export const COUNTRY_CENTROIDS: Record<string, [number, number]> = {
  // ── Asia ─────────────────────────────────────────────────────────────────────
  'Afghanistan':            [33.9391,   67.7100],
  'Bangladesh':             [23.6850,   90.3563],
  'Cambodia':               [12.5657,  104.9910],
  'China':                  [35.8617,  104.1954],
  'India':                  [20.5937,   78.9629],
  'Indonesia':              [-0.7893,  113.9213],
  'Japan':                  [36.2048,  138.2529],
  'Kazakhstan':             [48.0196,   66.9237],
  'Laos':                   [19.8563,  102.4955],
  'Malaysia':               [ 4.2105,  101.9758],
  'Mongolia':               [46.8625,  103.8467],
  'Myanmar':                [21.9162,   95.9560],
  'Nepal':                  [28.3949,   84.1240],
  'North Korea':            [40.3399,  127.5101],
  'Pakistan':               [30.3753,   69.3451],
  'Philippines':            [12.8797,  121.7740],
  'Singapore':              [ 1.3521,  103.8198],
  'South Korea':            [35.9078,  127.7669],
  'Sri Lanka':              [ 7.8731,   80.7718],
  'Taiwan':                 [23.6978,  120.9605],
  'Thailand':               [15.8700,  100.9925],
  'Vietnam':                [14.0583,  108.2772],
  // ── Middle East ──────────────────────────────────────────────────────────────
  'Bahrain':                [26.0275,   50.5500],
  'Iran':                   [32.4279,   53.6880],
  'Iraq':                   [33.2232,   43.6793],
  'Israel':                 [31.0461,   34.8516],
  'Jordan':                 [30.5852,   36.2384],
  'Kuwait':                 [29.3117,   47.4818],
  'Lebanon':                [33.8547,   35.8623],
  'Oman':                   [21.4735,   55.9754],
  'Qatar':                  [25.3548,   51.1839],
  'Saudi Arabia':           [23.8859,   45.0792],
  'Syria':                  [34.8021,   38.9968],
  'Turkey':                 [38.9637,   35.2433],
  'UAE':                    [23.4241,   53.8478],
  'United Arab Emirates':   [23.4241,   53.8478],
  'Yemen':                  [15.5527,   48.5164],
  // ── Europe ───────────────────────────────────────────────────────────────────
  'Albania':                [41.1533,   20.1683],
  'Austria':                [47.5162,   14.5501],
  'Belgium':                [50.5039,    4.4699],
  'Bosnia and Herzegovina': [43.9159,   17.6791],
  'Bulgaria':               [42.7339,   25.4858],
  'Croatia':                [45.1000,   15.2000],
  'Cyprus':                 [35.1264,   33.4299],
  'Czech Republic':         [49.8175,   15.4730],
  'Czechia':                [49.8175,   15.4730],
  'Denmark':                [56.2639,    9.5018],
  'Estonia':                [58.5953,   25.0136],
  'Finland':                [61.9241,   25.7482],
  'France':                 [46.2276,    2.2137],
  'Germany':                [51.1657,   10.4515],
  'Greece':                 [39.0742,   21.8243],
  'Hungary':                [47.1625,   19.5033],
  'Iceland':                [64.9631,  -19.0208],
  'Ireland':                [53.1424,   -7.6921],
  'Italy':                  [41.8719,   12.5674],
  'Kosovo':                 [42.6026,   20.9030],
  'Latvia':                 [56.8796,   24.6032],
  'Lithuania':              [55.1694,   23.8813],
  'Luxembourg':             [49.8153,    6.1296],
  'Malta':                  [35.9375,   14.3754],
  'Moldova':                [47.4116,   28.3699],
  'Montenegro':             [42.7087,   19.3744],
  'Netherlands':            [52.1326,    5.2913],
  'North Macedonia':        [41.6086,   21.7453],
  'Norway':                 [60.4720,    8.4689],
  'Poland':                 [51.9194,   19.1451],
  'Portugal':               [39.3999,   -8.2245],
  'Romania':                [45.9432,   24.9668],
  'Russia':                 [61.5240,  105.3188],
  'Serbia':                 [44.0165,   21.0059],
  'Slovakia':               [48.6690,   19.6990],
  'Slovenia':               [46.1512,   14.9955],
  'Spain':                  [40.4637,   -3.7492],
  'Sweden':                 [60.1282,   18.6435],
  'Switzerland':            [46.8182,    8.2275],
  'Ukraine':                [48.3794,   31.1656],
  'United Kingdom':         [55.3781,   -3.4360],
  'UK':                     [55.3781,   -3.4360],
  // ── Africa ───────────────────────────────────────────────────────────────────
  'Algeria':                [28.0339,    1.6596],
  'Angola':                 [-11.2027,  17.8739],
  'Cameroon':               [ 7.3697,   12.3547],
  'Democratic Republic of the Congo': [-4.0383, 21.7587],
  'DR Congo':               [-4.0383,   21.7587],
  'DRC':                    [-4.0383,   21.7587],
  'Egypt':                  [26.8206,   30.8025],
  'Ethiopia':               [ 9.1450,   40.4897],
  'Ghana':                  [ 7.9465,   -1.0232],
  'Ivory Coast':            [ 7.5400,   -5.5471],
  "Côte d'Ivoire":          [ 7.5400,   -5.5471],
  'Kenya':                  [-0.0236,   37.9062],
  'Morocco':                [31.7917,   -7.0926],
  'Mozambique':             [-18.6657,  35.5296],
  'Nigeria':                [ 9.0820,    8.6753],
  'Rwanda':                 [-1.9403,   29.8739],
  'Senegal':                [14.4974,  -14.4524],
  'South Africa':           [-30.5595,  22.9375],
  'Sudan':                  [12.8628,   30.2176],
  'Tanzania':               [-6.3690,   34.8888],
  'Tunisia':                [33.8869,    9.5375],
  'Uganda':                 [ 1.3733,   32.2903],
  'Zambia':                 [-13.1339,  27.8493],
  'Zimbabwe':               [-19.0154,  29.1549],
  // ── Americas ─────────────────────────────────────────────────────────────────
  'Argentina':              [-38.4161,  -63.6167],
  'Bolivia':                [-16.2902,  -63.5887],
  'Brazil':                 [-14.2350,  -51.9253],
  'Canada':                 [56.1304,   -106.3468],
  'Chile':                  [-35.6751,  -71.5430],
  'Colombia':               [ 4.5709,   -74.2973],
  'Costa Rica':             [ 9.7489,   -83.7534],
  'Cuba':                   [21.5218,   -77.7812],
  'Dominican Republic':     [18.7357,   -70.1627],
  'Ecuador':                [-1.8312,   -78.1834],
  'El Salvador':            [13.7942,   -88.8965],
  'Guatemala':              [15.7835,   -90.2308],
  'Honduras':               [15.2000,   -86.2419],
  'Jamaica':                [18.1096,   -77.2975],
  'Mexico':                 [23.6345,   -102.5528],
  'Nicaragua':              [12.8654,   -85.2072],
  'Panama':                 [ 8.5380,   -80.7821],
  'Paraguay':               [-23.4425,  -58.4438],
  'Peru':                   [-9.1900,   -75.0152],
  'Puerto Rico':            [18.2208,   -66.5901],
  'Trinidad and Tobago':    [10.6918,   -61.2225],
  'United States':          [37.0902,   -95.7129],
  'United States of America': [37.0902, -95.7129],
  'USA':                    [37.0902,   -95.7129],
  'Uruguay':                [-32.5228,  -55.7658],
  'Venezuela':              [ 6.4238,   -66.5897],
  // ── Oceania ──────────────────────────────────────────────────────────────────
  'Australia':              [-25.2744,  133.7751],
  'Fiji':                   [-17.7134,  178.0650],
  'New Zealand':            [-40.9006,  174.8860],
  'Papua New Guinea':       [-6.3150,   143.9555],
};

/**
 * Continent and sub-region centroids — a last-resort fallback (step 5) for
 * event records that store a broad geographic label such as "Southeast Asia",
 * "Europe", or "East Africa" in the city field instead of an actual city or
 * country.  These values are approximate geographic centres of the named
 * region, sufficient to give the map a non-blank starting position.
 *
 * Keys are common English region / continent names.  Lookup is
 * case-insensitive via the same normalisation applied to cities and countries.
 */
export const REGION_CENTROIDS: Record<string, [number, number]> = {
  // ── Continents ───────────────────────────────────────────────────────────
  'Africa':               [  8.7832,   34.5085],
  'Antarctica':           [-82.8628,   135.0000],
  'Asia':                 [ 34.0479,  100.6197],
  'Europe':               [ 54.5260,   15.2551],
  'North America':        [ 54.5260,  -105.2551],
  'South America':        [-14.2350,  -51.9253],
  'Oceania':              [-22.7359,  140.0188],
  'Australia':            [-25.2744,  133.7751],  // doubles as continent label

  // ── Asia sub-regions ─────────────────────────────────────────────────────
  'Southeast Asia':       [ 12.0000,  105.0000],
  'East Asia':            [ 35.0000,  115.0000],
  'South Asia':           [ 20.5937,   78.9629],
  'Central Asia':         [ 45.0000,   63.0000],
  'Middle East':          [ 29.0000,   41.0000],
  'West Asia':            [ 29.0000,   41.0000],   // synonym for Middle East
  'Eastern Asia':         [ 35.0000,  115.0000],
  'Southern Asia':        [ 20.5937,   78.9629],
  'Western Asia':         [ 29.0000,   41.0000],

  // ── Africa sub-regions ───────────────────────────────────────────────────
  'East Africa':          [ -1.0000,   38.0000],
  'West Africa':          [  9.0000,    2.0000],
  'North Africa':         [ 25.0000,   17.0000],
  'Central Africa':       [ -3.0000,   23.0000],
  'Southern Africa':      [-28.0000,   25.0000],
  'Sub-Saharan Africa':   [  5.0000,   20.0000],
  'Eastern Africa':       [ -1.0000,   38.0000],
  'Western Africa':       [  9.0000,    2.0000],
  'Northern Africa':      [ 25.0000,   17.0000],

  // ── Europe sub-regions ───────────────────────────────────────────────────
  'Western Europe':       [ 49.0000,    4.0000],
  'Eastern Europe':       [ 52.0000,   28.0000],
  'Northern Europe':      [ 60.0000,   15.0000],
  'Southern Europe':      [ 41.0000,   16.0000],
  'Central Europe':       [ 49.0000,   16.0000],
  'Scandinavia':          [ 62.0000,   15.0000],
  'Nordic Countries':     [ 62.0000,   15.0000],
  'Balkans':              [ 43.0000,   20.0000],
  'Baltic States':        [ 57.0000,   24.0000],

  // ── Americas sub-regions ─────────────────────────────────────────────────
  'Latin America':        [ -5.0000,  -60.0000],
  'Central America':      [ 12.8654,  -85.2072],
  'Caribbean':            [ 19.0000,  -69.0000],
  'North Caribbean':      [ 19.0000,  -69.0000],

  // ── Oceania sub-regions ──────────────────────────────────────────────────
  'Pacific':              [  5.0000,  170.0000],
  'South Pacific':        [-20.0000, -140.0000],
  'Southeast Pacific':    [-15.0000, -145.0000],
  'Melanesia':            [-10.0000,  155.0000],
  'Micronesia':           [  7.0000,  158.0000],
  'Polynesia':            [-15.0000, -140.0000],
};

/**
 * Alternate-spelling aliases that are NOT already direct entries in
 * CITY_CENTROIDS.  Each key is the lowercased alias; the value is the
 * corresponding canonical CITY_CENTROIDS key.
 *
 * Use this map for short forms, colloquial names, and common partner-API
 * variants that arrive without the "City" suffix or with a different
 * romanisation.  Aliases are tried after the full normalised lookup fails,
 * so there is no risk of shadowing an explicit entry.
 *
 * Keys must be pre-lowercased (to match the normalised lookup step).
 */
export const CITY_ALIASES: Record<string, string> = {
  // Philippines — "City" suffix frequently dropped by partner APIs
  'cebu':            'Cebu City',
  'davao':           'Davao City',
  'quezon':          'Quezon City',

  // Vietnam — short colloquial forms
  'ho chi minh':     'Ho Chi Minh City',
  'hcmc':            'Ho Chi Minh City',
  'saigon':          'Ho Chi Minh City',   // also a direct entry, belt-and-suspenders

  // Philippines / Malaysia — alternative romanisations
  'george town':     'George Town',         // already canonical; kept as example

  // Kazakhstan — renamed capital
  'nur-sultan':      'Nur-Sultan',          // already canonical; kept for clarity
  'nursultan':       'Nur-Sultan',

  // Ukraine — legacy romanisation still common in partner data
  'kiev':            'Kyiv',               // also a direct entry, belt-and-suspenders

  // Indonesia — "Kota" prefix variant
  'kota bandung':    'Bandung',
  'kota surabaya':   'Surabaya',

  // India — common abbreviations / alternate romanisations
  'bengaluru':       'Bangalore',           // also a direct entry; belt-and-suspenders
  'bombay':          'Mumbai',
  'madras':          'Chennai',
  'calcutta':        'Kolkata',             // also a direct entry; belt-and-suspenders
  'new delhi':       'New Delhi',           // already canonical; kept for clarity

  // Mexico / Central America — full-name variants
  'cdmx':            'Mexico City',
  'ciudad de mexico': 'Mexico City',

  // Colombia — diacritic-free variants (partner APIs often strip accents)
  'medellin':        'Medellín',            // also a direct entry; belt-and-suspenders
  'bogota':          'Bogotá',              // also a direct entry; belt-and-suspenders

  // Brazil
  'sao paulo':       'São Paulo',           // also a direct entry; belt-and-suspenders

  // Canada
  'montreal':        'Montréal',            // also a direct entry; belt-and-suspenders

  // USA — informal short forms
  'new york city':   'New York',            // already canonical via NYC entry
  'nyc':             'New York',            // also a direct entry; belt-and-suspenders
  'la':              'Los Angeles',
  'sf':              'San Francisco',
  'chi':             'Chicago',
  'dc':              'Washington DC',

  // Oceania
  'brisbane':        'Brisbane',

  // Middle East
  'jeddah':          'Jeddah',              // already canonical; kept for completeness

  // Poland — diacritic-free variant
  'krakow':          'Kraków',              // also a direct entry; belt-and-suspenders

  // Moldova — diacritic-free variant
  'chisinau':        'Chișinău',            // also a direct entry; belt-and-suspenders
};

/**
 * Stroked / slashed letters that NFD decomposition does NOT remove — these are
 * base-letter modifications, not combining marks.  Map both the uppercase and
 * lowercase forms so the replacement is safe regardless of input case.
 *
 * Ł / ł  (Polish, Croatian …)  → L / l
 * Ø / ø  (Danish, Norwegian …) → O / o
 * Đ / đ  (Vietnamese, Serbian) → D / d
 */
const STROKED_TRANSLIT: Record<string, string> = {
  'Ł': 'L', 'ł': 'l',
  'Ø': 'O', 'ø': 'o',
  'Đ': 'D', 'đ': 'd',
};

/**
 * Normalise a raw city string to the form used as the index key:
 *   1. Trim leading/trailing whitespace
 *   2. Collapse internal runs of whitespace to a single space
 *   3. NFD-decompose and strip combining diacritical marks so that
 *      "Bogotá" → "bogota", "Côte" → "cote", "São Paulo" → "sao paulo".
 *   4. Replace stroked/slashed letters that NFD does not decompose
 *      (Ł→l, Ø→o, Đ→d and their lowercase equivalents).
 *   5. Lowercase (Unicode-safe — avoids apostrophe/diacritic corruption)
 */
function normaliseCityKey(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, ' ')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[ŁłØøĐđ]/g, (c) => STROKED_TRANSLIT[c] ?? c)
    .toLowerCase();
}

/**
 * Case- and accent-insensitive lookup index built once at module load.
 *
 * Keys are the canonical CITY_CENTROIDS keys run through normaliseCityKey
 * (trim + whitespace-collapse + NFD diacritic strip + lowercase).
 */
const _lowerIndex = new Map<string, [number, number]>(
  Object.entries(CITY_CENTROIDS).map(([k, v]) => [normaliseCityKey(k), v]),
);

/**
 * Case- and accent-insensitive lookup index for COUNTRY_CENTROIDS, built once
 * at module load.  Used as a fallback when no city match is found.
 */
const _countryLowerIndex = new Map<string, [number, number]>(
  Object.entries(COUNTRY_CENTROIDS).map(([k, v]) => [normaliseCityKey(k), v]),
);

/**
 * Case- and accent-insensitive lookup index for REGION_CENTROIDS, built once
 * at module load.  Used as the final fallback (step 5) when no city or country
 * match is found — covers continent and sub-region labels stored in the city
 * field (e.g. "Southeast Asia", "Europe", "East Africa").
 */
const _regionLowerIndex = new Map<string, [number, number]>(
  Object.entries(REGION_CENTROIDS).map(([k, v]) => [normaliseCityKey(k), v]),
);

/**
 * Split a compound city string into candidate tokens to try against the index.
 *
 * Some event records store compound strings like "Kyiv/Kiev", "Bangkok (Thailand)",
 * or "New York, NY".  We extract the primary city token(s) by splitting on the
 * common separators '/', ',', and '(' (opening parenthesis).  Each resulting
 * fragment is trimmed before lookup; the first fragment is tried first so that
 * "Kyiv/Kiev" resolves to Kyiv rather than Kiev.
 *
 * Returns an array of one or more non-empty trimmed tokens.  If splitting
 * produces only empty fragments (unlikely with real data) we fall back to the
 * original string so the caller always has something to look up.
 */
function splitCityTokens(raw: string): string[] {
  const tokens = raw
    .split(/[/,(]/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  return tokens.length > 0 ? tokens : [raw];
}

/**
 * Strip Unicode combining characters (diacritics) from a string that has
 * already been NFD-decomposed.  Used as a fourth lookup tier so that
 * accent-stripped user input (e.g. "Koln") resolves to a city whose
 * canonical key uses diacritics (e.g. "Köln") without needing a hand-
 * maintained alias entry.
 *
 * The regex covers the full Unicode "Combining Diacritical Marks" block
 * (U+0300–U+036F).
 */
function stripDiacritics(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Diacritic-strip index: keys are the accent-stripped, lowercased, whitespace-
 * normalised forms of every canonical CITY_CENTROIDS key.  Populated once at
 * module load and used as the fourth (and final) lookup tier.
 *
 * When multiple canonical keys reduce to the same stripped form (e.g.
 * "Göteborg" and "Gothenburg" both strip to "goteborg" / "gothenburg") the
 * last one wins — in practice this is fine because all aliases for a city
 * share identical coordinates.
 */
const _nfdIndex = new Map<string, [number, number]>(
  Object.entries(CITY_CENTROIDS).map(([k, v]) => [
    stripDiacritics(k.trim().replace(/\s+/g, ' ').toLowerCase()),
    v,
  ]),
);

/**
 * Look up the [latitude, longitude] centroid for a city name.
 *
 * Resolution order — applied to each token produced by splitting compound
 * strings (e.g. "Kyiv/Kiev", "Bangkok (Thailand)", "New York, NY"):
 *   1. Exact key match against CITY_CENTROIDS (fast path).
 *   2. Case- and whitespace-insensitive lookup via the pre-built lower index
 *      (handles "tashkent", "  Bangkok  ", "SÃO PAULO", etc.).
 *   3. Alias lookup via CITY_ALIASES — catches common alternate spellings
 *      that partner APIs or user input may supply (e.g. "Cebu" → "Cebu City",
 *      "HCMC" → "Ho Chi Minh City").
 *   4. NFD diacritic-strip fallback via _nfdIndex — resolves accent-stripped
 *      input (e.g. "Koln") to a city whose canonical key has diacritics
 *      (e.g. "Köln") without requiring a hand-maintained alias.
 *
 * If no city match is found after all tokens are exhausted, country- and
 * region-level fallbacks are attempted:
 *   Step 4 (country): covers event records storing a country name (e.g.
 *     "Thailand", "United States") in the city field.
 *   Step 5 (region): covers event records storing a continent or sub-region
 *     label (e.g. "Southeast Asia", "Europe", "East Africa") in the city
 *     field — the final line of defence before returning undefined.
 *
 * Returns `undefined` when the input is genuinely unknown after all steps.
 */
export function getCityCentroid(city: string): [number, number] | undefined {
  // Fast path: exact match on the full string.
  if (CITY_CENTROIDS[city] !== undefined) return CITY_CENTROIDS[city];

  // Split compound strings and try each token with all four resolution steps.
  const tokens = splitCityTokens(city);
  for (const token of tokens) {
    // Step 1: exact match on token.
    if (CITY_CENTROIDS[token] !== undefined) return CITY_CENTROIDS[token];

    // Step 2: case- and whitespace-insensitive lookup via the lower index.
    const normKey = normaliseCityKey(token);
    const direct = _lowerIndex.get(normKey);
    if (direct !== undefined) return direct;

    // Step 3: alias fallback — map alternate spellings to canonical names.
    const canonicalName = CITY_ALIASES[normKey];
    if (canonicalName !== undefined) {
      const aliased = _lowerIndex.get(normaliseCityKey(canonicalName));
      if (aliased !== undefined) return aliased;
    }

    // Step 4: NFD diacritic-strip fallback — handles accent-stripped inputs
    // whose stripped form is not an explicit alias key.
    const nfd = _nfdIndex.get(stripDiacritics(normKey));
    if (nfd !== undefined) return nfd;
  }

  // Step 4: country-level fallback — try each token against COUNTRY_CENTROIDS.
  // This handles event records where the city field holds a country name
  // (e.g. "Thailand", "United States") rather than an actual city.
  for (const token of tokens) {
    const normKey = normaliseCityKey(token);
    const country = _countryLowerIndex.get(normKey);
    if (country !== undefined) return country;
  }

  // Step 5: region-level fallback — try each token against REGION_CENTROIDS.
  // This handles event records where the city field holds a continent or
  // sub-region label (e.g. "Southeast Asia", "Europe", "East Africa").
  for (const token of tokens) {
    const normKey = normaliseCityKey(token);
    const region = _regionLowerIndex.get(normKey);
    if (region !== undefined) return region;
  }

  return undefined;
}
