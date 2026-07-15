/**
 * StaticAirportData
 *
 * A curated static airport dataset used as a fallback when airport_profiles
 * DB table is empty or unavailable. Covers major world hubs with an emphasis
 * on Asia-Pacific layover airports.
 *
 * Fields: iataCode, name, city, country, countryCode, timezone, lat, lng
 * Safety buffer fields use AirportProfileService defaults.
 */

export interface StaticAirport {
  iataCode: string;
  name: string;
  city: string;
  country: string;
  countryCode: string;
  timezone: string;
  lat: number;
  lng: number;
}

export const STATIC_AIRPORTS: StaticAirport[] = [
  // ── Asia-Pacific ──────────────────────────────────────────────────────────
  { iataCode: "TPE", name: "Taiwan Taoyuan International Airport", city: "Taipei", country: "Taiwan", countryCode: "TW", timezone: "Asia/Taipei", lat: 25.0777, lng: 121.2327 },
  { iataCode: "TSA", name: "Taipei Songshan Airport", city: "Taipei", country: "Taiwan", countryCode: "TW", timezone: "Asia/Taipei", lat: 25.0694, lng: 121.5519 },
  { iataCode: "HND", name: "Tokyo Haneda Airport", city: "Tokyo", country: "Japan", countryCode: "JP", timezone: "Asia/Tokyo", lat: 35.5494, lng: 139.7798 },
  { iataCode: "NRT", name: "Narita International Airport", city: "Tokyo", country: "Japan", countryCode: "JP", timezone: "Asia/Tokyo", lat: 35.7720, lng: 140.3929 },
  { iataCode: "KIX", name: "Kansai International Airport", city: "Osaka", country: "Japan", countryCode: "JP", timezone: "Asia/Tokyo", lat: 34.4347, lng: 135.2440 },
  { iataCode: "ITM", name: "Osaka Itami Airport", city: "Osaka", country: "Japan", countryCode: "JP", timezone: "Asia/Tokyo", lat: 34.7854, lng: 135.4381 },
  { iataCode: "NGO", name: "Chubu Centrair International Airport", city: "Nagoya", country: "Japan", countryCode: "JP", timezone: "Asia/Tokyo", lat: 34.8583, lng: 136.8052 },
  { iataCode: "SIN", name: "Singapore Changi Airport", city: "Singapore", country: "Singapore", countryCode: "SG", timezone: "Asia/Singapore", lat: 1.3644, lng: 103.9915 },
  { iataCode: "BKK", name: "Suvarnabhumi International Airport", city: "Bangkok", country: "Thailand", countryCode: "TH", timezone: "Asia/Bangkok", lat: 13.6900, lng: 100.7501 },
  { iataCode: "DMK", name: "Don Mueang International Airport", city: "Bangkok", country: "Thailand", countryCode: "TH", timezone: "Asia/Bangkok", lat: 13.9126, lng: 100.6068 },
  { iataCode: "HKG", name: "Hong Kong International Airport", city: "Hong Kong", country: "Hong Kong", countryCode: "HK", timezone: "Asia/Hong_Kong", lat: 22.3080, lng: 113.9185 },
  { iataCode: "ICN", name: "Incheon International Airport", city: "Seoul", country: "South Korea", countryCode: "KR", timezone: "Asia/Seoul", lat: 37.4602, lng: 126.4407 },
  { iataCode: "GMP", name: "Gimpo International Airport", city: "Seoul", country: "South Korea", countryCode: "KR", timezone: "Asia/Seoul", lat: 37.5583, lng: 126.7906 },
  { iataCode: "PVG", name: "Shanghai Pudong International Airport", city: "Shanghai", country: "China", countryCode: "CN", timezone: "Asia/Shanghai", lat: 31.1443, lng: 121.8083 },
  { iataCode: "SHA", name: "Shanghai Hongqiao International Airport", city: "Shanghai", country: "China", countryCode: "CN", timezone: "Asia/Shanghai", lat: 31.1979, lng: 121.3363 },
  { iataCode: "PEK", name: "Beijing Capital International Airport", city: "Beijing", country: "China", countryCode: "CN", timezone: "Asia/Shanghai", lat: 40.0799, lng: 116.6031 },
  { iataCode: "PKX", name: "Beijing Daxing International Airport", city: "Beijing", country: "China", countryCode: "CN", timezone: "Asia/Shanghai", lat: 39.5093, lng: 116.4105 },
  { iataCode: "CAN", name: "Guangzhou Baiyun International Airport", city: "Guangzhou", country: "China", countryCode: "CN", timezone: "Asia/Shanghai", lat: 23.3924, lng: 113.2988 },
  { iataCode: "SZX", name: "Shenzhen Bao'an International Airport", city: "Shenzhen", country: "China", countryCode: "CN", timezone: "Asia/Shanghai", lat: 22.6395, lng: 113.8107 },
  { iataCode: "CTU", name: "Chengdu Tianfu International Airport", city: "Chengdu", country: "China", countryCode: "CN", timezone: "Asia/Shanghai", lat: 30.3125, lng: 104.4441 },
  { iataCode: "MNL", name: "Ninoy Aquino International Airport", city: "Manila", country: "Philippines", countryCode: "PH", timezone: "Asia/Manila", lat: 14.5086, lng: 121.0197 },
  { iataCode: "CEB", name: "Mactan-Cebu International Airport", city: "Cebu", country: "Philippines", countryCode: "PH", timezone: "Asia/Manila", lat: 10.3075, lng: 123.9791 },
  { iataCode: "CRK", name: "Clark International Airport", city: "Angeles", country: "Philippines", countryCode: "PH", timezone: "Asia/Manila", lat: 15.1859, lng: 120.5598 },
  { iataCode: "KUL", name: "Kuala Lumpur International Airport", city: "Kuala Lumpur", country: "Malaysia", countryCode: "MY", timezone: "Asia/Kuala_Lumpur", lat: 2.7456, lng: 101.7099 },
  { iataCode: "SZB", name: "Sultan Abdul Aziz Shah Airport", city: "Kuala Lumpur", country: "Malaysia", countryCode: "MY", timezone: "Asia/Kuala_Lumpur", lat: 3.1306, lng: 101.5496 },
  { iataCode: "CGK", name: "Soekarno-Hatta International Airport", city: "Jakarta", country: "Indonesia", countryCode: "ID", timezone: "Asia/Jakarta", lat: -6.1256, lng: 106.6558 },
  { iataCode: "DPS", name: "Ngurah Rai International Airport", city: "Bali", country: "Indonesia", countryCode: "ID", timezone: "Asia/Makassar", lat: -8.7482, lng: 115.1671 },
  { iataCode: "SUB", name: "Juanda International Airport", city: "Surabaya", country: "Indonesia", countryCode: "ID", timezone: "Asia/Jakarta", lat: -7.3798, lng: 112.7873 },
  { iataCode: "SGN", name: "Tan Son Nhat International Airport", city: "Ho Chi Minh City", country: "Vietnam", countryCode: "VN", timezone: "Asia/Ho_Chi_Minh", lat: 10.8188, lng: 106.6519 },
  { iataCode: "HAN", name: "Noi Bai International Airport", city: "Hanoi", country: "Vietnam", countryCode: "VN", timezone: "Asia/Ho_Chi_Minh", lat: 21.2212, lng: 105.8074 },
  { iataCode: "DAD", name: "Da Nang International Airport", city: "Da Nang", country: "Vietnam", countryCode: "VN", timezone: "Asia/Ho_Chi_Minh", lat: 16.0439, lng: 108.1993 },
  { iataCode: "REP", name: "Siem Reap International Airport", city: "Siem Reap", country: "Cambodia", countryCode: "KH", timezone: "Asia/Phnom_Penh", lat: 13.4107, lng: 103.8128 },
  { iataCode: "PNH", name: "Phnom Penh International Airport", city: "Phnom Penh", country: "Cambodia", countryCode: "KH", timezone: "Asia/Phnom_Penh", lat: 11.5466, lng: 104.8442 },
  { iataCode: "RGN", name: "Yangon International Airport", city: "Yangon", country: "Myanmar", countryCode: "MM", timezone: "Asia/Rangoon", lat: 16.9073, lng: 96.1332 },
  { iataCode: "VTE", name: "Wattay International Airport", city: "Vientiane", country: "Laos", countryCode: "LA", timezone: "Asia/Vientiane", lat: 17.9883, lng: 102.5633 },
  { iataCode: "DEL", name: "Indira Gandhi International Airport", city: "New Delhi", country: "India", countryCode: "IN", timezone: "Asia/Kolkata", lat: 28.5561, lng: 77.1000 },
  { iataCode: "BOM", name: "Chhatrapati Shivaji Maharaj International Airport", city: "Mumbai", country: "India", countryCode: "IN", timezone: "Asia/Kolkata", lat: 19.0896, lng: 72.8656 },
  { iataCode: "BLR", name: "Kempegowda International Airport", city: "Bengaluru", country: "India", countryCode: "IN", timezone: "Asia/Kolkata", lat: 13.1986, lng: 77.7066 },
  { iataCode: "MAA", name: "Chennai International Airport", city: "Chennai", country: "India", countryCode: "IN", timezone: "Asia/Kolkata", lat: 12.9900, lng: 80.1693 },
  { iataCode: "HYD", name: "Rajiv Gandhi International Airport", city: "Hyderabad", country: "India", countryCode: "IN", timezone: "Asia/Kolkata", lat: 17.2403, lng: 78.4294 },
  { iataCode: "CCU", name: "Netaji Subhash Chandra Bose International Airport", city: "Kolkata", country: "India", countryCode: "IN", timezone: "Asia/Kolkata", lat: 22.6547, lng: 88.4467 },
  { iataCode: "CMB", name: "Bandaranaike International Airport", city: "Colombo", country: "Sri Lanka", countryCode: "LK", timezone: "Asia/Colombo", lat: 7.1807, lng: 79.8841 },
  { iataCode: "DAC", name: "Hazrat Shahjalal International Airport", city: "Dhaka", country: "Bangladesh", countryCode: "BD", timezone: "Asia/Dhaka", lat: 23.8434, lng: 90.3979 },
  { iataCode: "KTM", name: "Tribhuvan International Airport", city: "Kathmandu", country: "Nepal", countryCode: "NP", timezone: "Asia/Kathmandu", lat: 27.6966, lng: 85.3591 },
  { iataCode: "MLE", name: "Velana International Airport", city: "Malé", country: "Maldives", countryCode: "MV", timezone: "Indian/Maldives", lat: 4.1918, lng: 73.5290 },
  { iataCode: "SYD", name: "Sydney Kingsford Smith Airport", city: "Sydney", country: "Australia", countryCode: "AU", timezone: "Australia/Sydney", lat: -33.9399, lng: 151.1753 },
  { iataCode: "MEL", name: "Melbourne Airport", city: "Melbourne", country: "Australia", countryCode: "AU", timezone: "Australia/Melbourne", lat: -37.6733, lng: 144.8430 },
  { iataCode: "BNE", name: "Brisbane Airport", city: "Brisbane", country: "Australia", countryCode: "AU", timezone: "Australia/Brisbane", lat: -27.3842, lng: 153.1175 },
  { iataCode: "PER", name: "Perth Airport", city: "Perth", country: "Australia", countryCode: "AU", timezone: "Australia/Perth", lat: -31.9385, lng: 115.9670 },
  { iataCode: "AKL", name: "Auckland Airport", city: "Auckland", country: "New Zealand", countryCode: "NZ", timezone: "Pacific/Auckland", lat: -37.0082, lng: 174.7850 },
  { iataCode: "CHC", name: "Christchurch Airport", city: "Christchurch", country: "New Zealand", countryCode: "NZ", timezone: "Pacific/Auckland", lat: -43.4893, lng: 172.5320 },

  // ── Middle East ───────────────────────────────────────────────────────────
  { iataCode: "DXB", name: "Dubai International Airport", city: "Dubai", country: "United Arab Emirates", countryCode: "AE", timezone: "Asia/Dubai", lat: 25.2532, lng: 55.3657 },
  { iataCode: "AUH", name: "Abu Dhabi International Airport", city: "Abu Dhabi", country: "United Arab Emirates", countryCode: "AE", timezone: "Asia/Dubai", lat: 24.4330, lng: 54.6511 },
  { iataCode: "DOH", name: "Hamad International Airport", city: "Doha", country: "Qatar", countryCode: "QA", timezone: "Asia/Qatar", lat: 25.2609, lng: 51.6138 },
  { iataCode: "BAH", name: "Bahrain International Airport", city: "Manama", country: "Bahrain", countryCode: "BH", timezone: "Asia/Bahrain", lat: 26.2708, lng: 50.6336 },
  { iataCode: "KWI", name: "Kuwait International Airport", city: "Kuwait City", country: "Kuwait", countryCode: "KW", timezone: "Asia/Kuwait", lat: 29.2267, lng: 47.9689 },
  { iataCode: "MCT", name: "Muscat International Airport", city: "Muscat", country: "Oman", countryCode: "OM", timezone: "Asia/Muscat", lat: 23.5933, lng: 58.2844 },
  { iataCode: "RUH", name: "King Khalid International Airport", city: "Riyadh", country: "Saudi Arabia", countryCode: "SA", timezone: "Asia/Riyadh", lat: 24.9576, lng: 46.6988 },
  { iataCode: "JED", name: "King Abdulaziz International Airport", city: "Jeddah", country: "Saudi Arabia", countryCode: "SA", timezone: "Asia/Riyadh", lat: 21.6796, lng: 39.1565 },
  { iataCode: "TLV", name: "Ben Gurion International Airport", city: "Tel Aviv", country: "Israel", countryCode: "IL", timezone: "Asia/Jerusalem", lat: 32.0114, lng: 34.8867 },
  { iataCode: "AMM", name: "Queen Alia International Airport", city: "Amman", country: "Jordan", countryCode: "JO", timezone: "Asia/Amman", lat: 31.7226, lng: 35.9932 },
  { iataCode: "BEY", name: "Beirut-Rafic Hariri International Airport", city: "Beirut", country: "Lebanon", countryCode: "LB", timezone: "Asia/Beirut", lat: 33.8209, lng: 35.4884 },
  { iataCode: "IKA", name: "Tehran Imam Khomeini International Airport", city: "Tehran", country: "Iran", countryCode: "IR", timezone: "Asia/Tehran", lat: 35.4161, lng: 51.1522 },

  // ── Europe ────────────────────────────────────────────────────────────────
  { iataCode: "LHR", name: "London Heathrow Airport", city: "London", country: "United Kingdom", countryCode: "GB", timezone: "Europe/London", lat: 51.4775, lng: -0.4614 },
  { iataCode: "LGW", name: "London Gatwick Airport", city: "London", country: "United Kingdom", countryCode: "GB", timezone: "Europe/London", lat: 51.1481, lng: -0.1903 },
  { iataCode: "STN", name: "London Stansted Airport", city: "London", country: "United Kingdom", countryCode: "GB", timezone: "Europe/London", lat: 51.8850, lng: 0.2350 },
  { iataCode: "LTN", name: "London Luton Airport", city: "London", country: "United Kingdom", countryCode: "GB", timezone: "Europe/London", lat: 51.8747, lng: -0.3683 },
  { iataCode: "MAN", name: "Manchester Airport", city: "Manchester", country: "United Kingdom", countryCode: "GB", timezone: "Europe/London", lat: 53.3537, lng: -2.2750 },
  { iataCode: "EDI", name: "Edinburgh Airport", city: "Edinburgh", country: "United Kingdom", countryCode: "GB", timezone: "Europe/London", lat: 55.9508, lng: -3.3615 },
  { iataCode: "CDG", name: "Charles de Gaulle Airport", city: "Paris", country: "France", countryCode: "FR", timezone: "Europe/Paris", lat: 49.0097, lng: 2.5479 },
  { iataCode: "ORY", name: "Paris Orly Airport", city: "Paris", country: "France", countryCode: "FR", timezone: "Europe/Paris", lat: 48.7233, lng: 2.3794 },
  { iataCode: "FRA", name: "Frankfurt Airport", city: "Frankfurt", country: "Germany", countryCode: "DE", timezone: "Europe/Berlin", lat: 50.0379, lng: 8.5622 },
  { iataCode: "MUC", name: "Munich Airport", city: "Munich", country: "Germany", countryCode: "DE", timezone: "Europe/Berlin", lat: 48.3537, lng: 11.7750 },
  { iataCode: "TXL", name: "Berlin Tegel Airport", city: "Berlin", country: "Germany", countryCode: "DE", timezone: "Europe/Berlin", lat: 52.5597, lng: 13.2877 },
  { iataCode: "BER", name: "Berlin Brandenburg Airport", city: "Berlin", country: "Germany", countryCode: "DE", timezone: "Europe/Berlin", lat: 52.3667, lng: 13.5033 },
  { iataCode: "AMS", name: "Amsterdam Airport Schiphol", city: "Amsterdam", country: "Netherlands", countryCode: "NL", timezone: "Europe/Amsterdam", lat: 52.3086, lng: 4.7639 },
  { iataCode: "BRU", name: "Brussels Airport", city: "Brussels", country: "Belgium", countryCode: "BE", timezone: "Europe/Brussels", lat: 50.9010, lng: 4.4844 },
  { iataCode: "ZRH", name: "Zurich Airport", city: "Zurich", country: "Switzerland", countryCode: "CH", timezone: "Europe/Zurich", lat: 47.4647, lng: 8.5492 },
  { iataCode: "GVA", name: "Geneva Airport", city: "Geneva", country: "Switzerland", countryCode: "CH", timezone: "Europe/Zurich", lat: 46.2381, lng: 6.1089 },
  { iataCode: "VIE", name: "Vienna International Airport", city: "Vienna", country: "Austria", countryCode: "AT", timezone: "Europe/Vienna", lat: 48.1103, lng: 16.5697 },
  { iataCode: "CPH", name: "Copenhagen Airport", city: "Copenhagen", country: "Denmark", countryCode: "DK", timezone: "Europe/Copenhagen", lat: 55.6180, lng: 12.6560 },
  { iataCode: "ARN", name: "Stockholm Arlanda Airport", city: "Stockholm", country: "Sweden", countryCode: "SE", timezone: "Europe/Stockholm", lat: 59.6519, lng: 17.9186 },
  { iataCode: "HEL", name: "Helsinki-Vantaa Airport", city: "Helsinki", country: "Finland", countryCode: "FI", timezone: "Europe/Helsinki", lat: 60.3172, lng: 24.9633 },
  { iataCode: "OSL", name: "Oslo Gardermoen Airport", city: "Oslo", country: "Norway", countryCode: "NO", timezone: "Europe/Oslo", lat: 60.1939, lng: 11.1004 },
  { iataCode: "MAD", name: "Adolfo Suárez Madrid-Barajas Airport", city: "Madrid", country: "Spain", countryCode: "ES", timezone: "Europe/Madrid", lat: 40.4983, lng: -3.5676 },
  { iataCode: "BCN", name: "Barcelona El Prat Airport", city: "Barcelona", country: "Spain", countryCode: "ES", timezone: "Europe/Madrid", lat: 41.2971, lng: 2.0785 },
  { iataCode: "LIS", name: "Lisbon Humberto Delgado Airport", city: "Lisbon", country: "Portugal", countryCode: "PT", timezone: "Europe/Lisbon", lat: 38.7742, lng: -9.1342 },
  { iataCode: "FCO", name: "Leonardo da Vinci International Airport", city: "Rome", country: "Italy", countryCode: "IT", timezone: "Europe/Rome", lat: 41.8002, lng: 12.2388 },
  { iataCode: "MXP", name: "Milan Malpensa Airport", city: "Milan", country: "Italy", countryCode: "IT", timezone: "Europe/Rome", lat: 45.6306, lng: 8.7281 },
  { iataCode: "ATH", name: "Athens International Airport", city: "Athens", country: "Greece", countryCode: "GR", timezone: "Europe/Athens", lat: 37.9364, lng: 23.9445 },
  { iataCode: "IST", name: "Istanbul Airport", city: "Istanbul", country: "Turkey", countryCode: "TR", timezone: "Europe/Istanbul", lat: 41.2753, lng: 28.7519 },
  { iataCode: "SAW", name: "Sabiha Gökçen International Airport", city: "Istanbul", country: "Turkey", countryCode: "TR", timezone: "Europe/Istanbul", lat: 40.8986, lng: 29.3092 },
  { iataCode: "SVO", name: "Sheremetyevo International Airport", city: "Moscow", country: "Russia", countryCode: "RU", timezone: "Europe/Moscow", lat: 55.9726, lng: 37.4146 },
  { iataCode: "DME", name: "Domodedovo International Airport", city: "Moscow", country: "Russia", countryCode: "RU", timezone: "Europe/Moscow", lat: 55.4088, lng: 37.9063 },
  { iataCode: "WAW", name: "Warsaw Chopin Airport", city: "Warsaw", country: "Poland", countryCode: "PL", timezone: "Europe/Warsaw", lat: 52.1657, lng: 20.9671 },
  { iataCode: "PRG", name: "Václav Havel Airport Prague", city: "Prague", country: "Czech Republic", countryCode: "CZ", timezone: "Europe/Prague", lat: 50.1008, lng: 14.2600 },
  { iataCode: "BUD", name: "Budapest Ferenc Liszt International Airport", city: "Budapest", country: "Hungary", countryCode: "HU", timezone: "Europe/Budapest", lat: 47.4298, lng: 19.2611 },

  // ── North America ─────────────────────────────────────────────────────────
  { iataCode: "JFK", name: "John F. Kennedy International Airport", city: "New York", country: "United States", countryCode: "US", timezone: "America/New_York", lat: 40.6413, lng: -73.7781 },
  { iataCode: "LGA", name: "LaGuardia Airport", city: "New York", country: "United States", countryCode: "US", timezone: "America/New_York", lat: 40.7772, lng: -73.8726 },
  { iataCode: "EWR", name: "Newark Liberty International Airport", city: "Newark", country: "United States", countryCode: "US", timezone: "America/New_York", lat: 40.6895, lng: -74.1745 },
  { iataCode: "LAX", name: "Los Angeles International Airport", city: "Los Angeles", country: "United States", countryCode: "US", timezone: "America/Los_Angeles", lat: 33.9425, lng: -118.4081 },
  { iataCode: "SFO", name: "San Francisco International Airport", city: "San Francisco", country: "United States", countryCode: "US", timezone: "America/Los_Angeles", lat: 37.6213, lng: -122.3790 },
  { iataCode: "ORD", name: "O'Hare International Airport", city: "Chicago", country: "United States", countryCode: "US", timezone: "America/Chicago", lat: 41.9742, lng: -87.9073 },
  { iataCode: "ATL", name: "Hartsfield-Jackson Atlanta International Airport", city: "Atlanta", country: "United States", countryCode: "US", timezone: "America/New_York", lat: 33.6367, lng: -84.4281 },
  { iataCode: "DFW", name: "Dallas/Fort Worth International Airport", city: "Dallas", country: "United States", countryCode: "US", timezone: "America/Chicago", lat: 32.8998, lng: -97.0403 },
  { iataCode: "DEN", name: "Denver International Airport", city: "Denver", country: "United States", countryCode: "US", timezone: "America/Denver", lat: 39.8561, lng: -104.6737 },
  { iataCode: "SEA", name: "Seattle-Tacoma International Airport", city: "Seattle", country: "United States", countryCode: "US", timezone: "America/Los_Angeles", lat: 47.4502, lng: -122.3088 },
  { iataCode: "MIA", name: "Miami International Airport", city: "Miami", country: "United States", countryCode: "US", timezone: "America/New_York", lat: 25.7959, lng: -80.2870 },
  { iataCode: "BOS", name: "Boston Logan International Airport", city: "Boston", country: "United States", countryCode: "US", timezone: "America/New_York", lat: 42.3656, lng: -71.0096 },
  { iataCode: "IAD", name: "Washington Dulles International Airport", city: "Washington D.C.", country: "United States", countryCode: "US", timezone: "America/New_York", lat: 38.9531, lng: -77.4565 },
  { iataCode: "DCA", name: "Ronald Reagan Washington National Airport", city: "Washington D.C.", country: "United States", countryCode: "US", timezone: "America/New_York", lat: 38.8512, lng: -77.0402 },
  { iataCode: "HNL", name: "Daniel K. Inouye International Airport", city: "Honolulu", country: "United States", countryCode: "US", timezone: "Pacific/Honolulu", lat: 21.3187, lng: -157.9225 },
  { iataCode: "GUM", name: "Antonio B. Won Pat International Airport", city: "Guam", country: "Guam", countryCode: "GU", timezone: "Pacific/Guam", lat: 13.4834, lng: 144.7961 },
  { iataCode: "YYZ", name: "Toronto Pearson International Airport", city: "Toronto", country: "Canada", countryCode: "CA", timezone: "America/Toronto", lat: 43.6777, lng: -79.6248 },
  { iataCode: "YVR", name: "Vancouver International Airport", city: "Vancouver", country: "Canada", countryCode: "CA", timezone: "America/Vancouver", lat: 49.1967, lng: -123.1815 },
  { iataCode: "YUL", name: "Montréal-Trudeau International Airport", city: "Montreal", country: "Canada", countryCode: "CA", timezone: "America/Montreal", lat: 45.4706, lng: -73.7408 },
  { iataCode: "MEX", name: "Mexico City International Airport", city: "Mexico City", country: "Mexico", countryCode: "MX", timezone: "America/Mexico_City", lat: 19.4363, lng: -99.0721 },
  { iataCode: "CUN", name: "Cancún International Airport", city: "Cancún", country: "Mexico", countryCode: "MX", timezone: "America/Cancun", lat: 21.0365, lng: -86.8771 },

  // ── Latin America ─────────────────────────────────────────────────────────
  { iataCode: "GRU", name: "São Paulo/Guarulhos International Airport", city: "São Paulo", country: "Brazil", countryCode: "BR", timezone: "America/Sao_Paulo", lat: -23.4356, lng: -46.4731 },
  { iataCode: "GIG", name: "Rio de Janeiro/Galeão International Airport", city: "Rio de Janeiro", country: "Brazil", countryCode: "BR", timezone: "America/Sao_Paulo", lat: -22.8100, lng: -43.2505 },
  { iataCode: "BOG", name: "El Dorado International Airport", city: "Bogotá", country: "Colombia", countryCode: "CO", timezone: "America/Bogota", lat: 4.7016, lng: -74.1469 },
  { iataCode: "LIM", name: "Jorge Chávez International Airport", city: "Lima", country: "Peru", countryCode: "PE", timezone: "America/Lima", lat: -12.0219, lng: -77.1143 },
  { iataCode: "SCL", name: "Santiago International Airport", city: "Santiago", country: "Chile", countryCode: "CL", timezone: "America/Santiago", lat: -33.3928, lng: -70.7858 },
  { iataCode: "EZE", name: "Ezeiza International Airport", city: "Buenos Aires", country: "Argentina", countryCode: "AR", timezone: "America/Argentina/Buenos_Aires", lat: -34.8222, lng: -58.5358 },
  { iataCode: "PTY", name: "Tocumen International Airport", city: "Panama City", country: "Panama", countryCode: "PA", timezone: "America/Panama", lat: 9.0714, lng: -79.3835 },

  // ── Africa ────────────────────────────────────────────────────────────────
  { iataCode: "JNB", name: "O.R. Tambo International Airport", city: "Johannesburg", country: "South Africa", countryCode: "ZA", timezone: "Africa/Johannesburg", lat: -26.1392, lng: 28.2460 },
  { iataCode: "CPT", name: "Cape Town International Airport", city: "Cape Town", country: "South Africa", countryCode: "ZA", timezone: "Africa/Johannesburg", lat: -33.9715, lng: 18.6021 },
  { iataCode: "CAI", name: "Cairo International Airport", city: "Cairo", country: "Egypt", countryCode: "EG", timezone: "Africa/Cairo", lat: 30.1219, lng: 31.4056 },
  { iataCode: "NBO", name: "Jomo Kenyatta International Airport", city: "Nairobi", country: "Kenya", countryCode: "KE", timezone: "Africa/Nairobi", lat: -1.3192, lng: 36.9275 },
  { iataCode: "ADD", name: "Addis Ababa Bole International Airport", city: "Addis Ababa", country: "Ethiopia", countryCode: "ET", timezone: "Africa/Addis_Ababa", lat: 8.9779, lng: 38.7993 },
  { iataCode: "CMN", name: "Mohammed V International Airport", city: "Casablanca", country: "Morocco", countryCode: "MA", timezone: "Africa/Casablanca", lat: 33.3675, lng: -7.5900 },
  { iataCode: "LOS", name: "Murtala Muhammed International Airport", city: "Lagos", country: "Nigeria", countryCode: "NG", timezone: "Africa/Lagos", lat: 6.5774, lng: 3.3212 },
  { iataCode: "ACC", name: "Kotoka International Airport", city: "Accra", country: "Ghana", countryCode: "GH", timezone: "Africa/Accra", lat: 5.6052, lng: -0.1668 },
];

/** Search static airport data by IATA code, name, city, or country. */
export function searchStaticAirports(query: string, limit = 10): StaticAirport[] {
  const q = query.trim().toUpperCase();
  if (!q) return [];

  const scored: Array<{ airport: StaticAirport; score: number }> = [];

  for (const ap of STATIC_AIRPORTS) {
    let score = 0;

    // Exact IATA match (highest priority)
    if (ap.iataCode === q) {
      score = 100;
    } else if (ap.iataCode.startsWith(q)) {
      score = 80;
    } else {
      const ql = query.trim().toLowerCase();
      if (ap.city.toLowerCase().startsWith(ql)) score = 70;
      else if (ap.name.toLowerCase().includes(ql)) score = 60;
      else if (ap.city.toLowerCase().includes(ql)) score = 50;
      else if (ap.country.toLowerCase().includes(ql)) score = 30;
      else if (ap.countryCode.toLowerCase() === ql) score = 40;
    }

    if (score > 0) scored.push({ airport: ap, score });
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.airport);
}

/** Resolve static airport by exact IATA code. Case-insensitive. */
export function resolveStaticByIata(iata: string): StaticAirport | null {
  const upper = iata.trim().toUpperCase();
  return STATIC_AIRPORTS.find((ap) => ap.iataCode === upper) ?? null;
}

/** Resolve static airport by city name (first match). */
export function resolveStaticByCity(city: string): StaticAirport | null {
  const q = city.trim().toLowerCase();
  return STATIC_AIRPORTS.find((ap) => ap.city.toLowerCase().includes(q)) ?? null;
}

/** Find nearest static airport to GPS coordinates. */
export function resolveStaticByGps(lat: number, lng: number): StaticAirport | null {
  let closest: StaticAirport | null = null;
  let closestDist = Infinity;

  for (const ap of STATIC_AIRPORTS) {
    const dLat = ap.lat - lat;
    const dLng = ap.lng - lng;
    const dist = Math.sqrt(dLat * dLat + dLng * dLng);
    if (dist < closestDist) {
      closestDist = dist;
      closest = ap;
    }
  }

  // Only return if within ~200km (roughly 1.8 degrees)
  return closestDist < 1.8 ? closest : null;
}
