/**
 * Port coordinates table for arrival geofencing + AIS-ETA port matching.
 *
 * Each entry has: canonical name, common aliases (matched case-insensitively),
 * UN/LOCODE, lat/lon of the port center, and an arrival radius in km.
 *
 * This is a hand-curated top-50 ocean + top-30 air list. Add more as you ship
 * to new lanes. Aliases are lowercased substrings tested against the shipment's
 * origin/destination free-text field.
 */

export interface PortEntry {
  name: string;
  unlocode?: string; // UN/LOCODE (5 chars, e.g. CNSHA)
  iata?: string;     // IATA code for airports (3 chars, e.g. LAX)
  lat: number;
  lon: number;
  radiusKm: number;  // how close a vessel must be to count as "arrived"
  aliases: string[];
  kind: "ocean" | "air";
}

// Arrival radius tuned per port size: big container terminals 15-25 km, smaller ports ~10 km.
const OCEAN_PORTS: PortEntry[] = [
  { name: "Shanghai", unlocode: "CNSHA", lat: 31.2304, lon: 121.4737, radiusKm: 30, aliases: ["shanghai", "sha"], kind: "ocean" },
  { name: "Ningbo-Zhoushan", unlocode: "CNNGB", lat: 29.8683, lon: 121.5440, radiusKm: 25, aliases: ["ningbo", "zhoushan", "ngb"], kind: "ocean" },
  { name: "Shenzhen", unlocode: "CNSZN", lat: 22.5431, lon: 114.0579, radiusKm: 20, aliases: ["shenzhen", "szn", "yantian", "chiwan"], kind: "ocean" },
  { name: "Guangzhou", unlocode: "CNCAN", lat: 23.1291, lon: 113.2644, radiusKm: 25, aliases: ["guangzhou", "canton", "nansha"], kind: "ocean" },
  { name: "Qingdao", unlocode: "CNTAO", lat: 36.0671, lon: 120.3826, radiusKm: 20, aliases: ["qingdao", "tao"], kind: "ocean" },
  { name: "Busan", unlocode: "KRPUS", lat: 35.1796, lon: 129.0756, radiusKm: 20, aliases: ["busan", "pusan", "pus"], kind: "ocean" },
  { name: "Hong Kong", unlocode: "HKHKG", lat: 22.3193, lon: 114.1694, radiusKm: 20, aliases: ["hong kong", "hongkong", "hkg"], kind: "ocean" },
  { name: "Singapore", unlocode: "SGSIN", lat: 1.2897, lon: 103.8501, radiusKm: 25, aliases: ["singapore", "sin"], kind: "ocean" },
  { name: "Tianjin", unlocode: "CNTSN", lat: 39.0851, lon: 117.2009, radiusKm: 20, aliases: ["tianjin", "tsn", "xingang"], kind: "ocean" },
  { name: "Xiamen", unlocode: "CNXMN", lat: 24.4798, lon: 118.0819, radiusKm: 15, aliases: ["xiamen", "xmn"], kind: "ocean" },
  { name: "Dalian", unlocode: "CNDLC", lat: 38.9140, lon: 121.6147, radiusKm: 20, aliases: ["dalian", "dlc"], kind: "ocean" },
  { name: "Port Klang", unlocode: "MYPKG", lat: 3.0047, lon: 101.3929, radiusKm: 15, aliases: ["port klang", "klang", "pkg"], kind: "ocean" },
  { name: "Tanjung Pelepas", unlocode: "MYTPP", lat: 1.3650, lon: 103.5447, radiusKm: 15, aliases: ["tanjung pelepas", "tpp"], kind: "ocean" },
  { name: "Kaohsiung", unlocode: "TWKHH", lat: 22.6135, lon: 120.2978, radiusKm: 20, aliases: ["kaohsiung", "khh"], kind: "ocean" },
  { name: "Laem Chabang", unlocode: "THLCH", lat: 13.0858, lon: 100.8831, radiusKm: 15, aliases: ["laem chabang", "lch"], kind: "ocean" },

  // Middle East
  { name: "Jebel Ali", unlocode: "AEJEA", lat: 25.0167, lon: 55.0667, radiusKm: 20, aliases: ["jebel ali", "dubai", "jea", "dxb"], kind: "ocean" },
  { name: "Jeddah", unlocode: "SAJED", lat: 21.4858, lon: 39.1925, radiusKm: 15, aliases: ["jeddah", "jed"], kind: "ocean" },

  // North America - West
  { name: "Los Angeles", unlocode: "USLAX", lat: 33.7455, lon: -118.2727, radiusKm: 25, aliases: ["los angeles", "la port", "san pedro", "lax port"], kind: "ocean" },
  { name: "Long Beach", unlocode: "USLGB", lat: 33.7542, lon: -118.2164, radiusKm: 20, aliases: ["long beach", "lgb"], kind: "ocean" },
  { name: "Oakland", unlocode: "USOAK", lat: 37.8044, lon: -122.2712, radiusKm: 15, aliases: ["oakland", "oak"], kind: "ocean" },
  { name: "Seattle", unlocode: "USSEA", lat: 47.6062, lon: -122.3321, radiusKm: 15, aliases: ["seattle", "sea"], kind: "ocean" },
  { name: "Tacoma", unlocode: "USTIW", lat: 47.2529, lon: -122.4443, radiusKm: 15, aliases: ["tacoma", "tiw"], kind: "ocean" },
  { name: "Vancouver", unlocode: "CAVAN", lat: 49.2827, lon: -123.1207, radiusKm: 20, aliases: ["vancouver", "van"], kind: "ocean" },
  { name: "Prince Rupert", unlocode: "CAPRR", lat: 54.3150, lon: -130.3209, radiusKm: 15, aliases: ["prince rupert", "prr"], kind: "ocean" },

  // North America - East / Gulf
  { name: "New York / NJ", unlocode: "USNYC", lat: 40.6640, lon: -74.0494, radiusKm: 20, aliases: ["new york", "new jersey", "newark", "nyc", "ewr"], kind: "ocean" },
  { name: "Savannah", unlocode: "USSAV", lat: 32.0835, lon: -81.0998, radiusKm: 20, aliases: ["savannah", "sav"], kind: "ocean" },
  { name: "Norfolk / Hampton Roads", unlocode: "USORF", lat: 36.8508, lon: -76.2859, radiusKm: 20, aliases: ["norfolk", "hampton roads", "orf"], kind: "ocean" },
  { name: "Charleston", unlocode: "USCHS", lat: 32.7826, lon: -79.9313, radiusKm: 15, aliases: ["charleston", "chs"], kind: "ocean" },
  { name: "Houston", unlocode: "USHOU", lat: 29.7604, lon: -95.3698, radiusKm: 25, aliases: ["houston", "hou"], kind: "ocean" },
  { name: "Miami", unlocode: "USMIA", lat: 25.7617, lon: -80.1918, radiusKm: 15, aliases: ["miami", "mia"], kind: "ocean" },
  { name: "Montreal", unlocode: "CAMTR", lat: 45.5019, lon: -73.5674, radiusKm: 15, aliases: ["montreal", "mtr"], kind: "ocean" },
  { name: "Halifax", unlocode: "CAHAL", lat: 44.6488, lon: -63.5752, radiusKm: 15, aliases: ["halifax", "hal"], kind: "ocean" },

  // Europe
  { name: "Rotterdam", unlocode: "NLRTM", lat: 51.9225, lon: 4.4792, radiusKm: 25, aliases: ["rotterdam", "rtm"], kind: "ocean" },
  { name: "Antwerp", unlocode: "BEANR", lat: 51.2194, lon: 4.4025, radiusKm: 20, aliases: ["antwerp", "anr"], kind: "ocean" },
  { name: "Hamburg", unlocode: "DEHAM", lat: 53.5511, lon: 9.9937, radiusKm: 20, aliases: ["hamburg", "ham"], kind: "ocean" },
  { name: "Bremerhaven", unlocode: "DEBRV", lat: 53.5396, lon: 8.5810, radiusKm: 15, aliases: ["bremerhaven", "brv"], kind: "ocean" },
  { name: "Le Havre", unlocode: "FRLEH", lat: 49.4944, lon: 0.1079, radiusKm: 15, aliases: ["le havre", "leh"], kind: "ocean" },
  { name: "Felixstowe", unlocode: "GBFXT", lat: 51.9645, lon: 1.3515, radiusKm: 15, aliases: ["felixstowe", "fxt"], kind: "ocean" },
  { name: "Southampton", unlocode: "GBSOU", lat: 50.9097, lon: -1.4044, radiusKm: 15, aliases: ["southampton", "sou"], kind: "ocean" },
  { name: "Valencia", unlocode: "ESVLC", lat: 39.4699, lon: -0.3763, radiusKm: 15, aliases: ["valencia", "vlc"], kind: "ocean" },
  { name: "Algeciras", unlocode: "ESALG", lat: 36.1408, lon: -5.4562, radiusKm: 15, aliases: ["algeciras", "alg"], kind: "ocean" },
  { name: "Barcelona", unlocode: "ESBCN", lat: 41.3851, lon: 2.1734, radiusKm: 15, aliases: ["barcelona", "bcn"], kind: "ocean" },
  { name: "Piraeus", unlocode: "GRPIR", lat: 37.9474, lon: 23.6386, radiusKm: 15, aliases: ["piraeus", "pir"], kind: "ocean" },
  { name: "Gioia Tauro", unlocode: "ITGIT", lat: 38.4397, lon: 15.8978, radiusKm: 15, aliases: ["gioia tauro", "git"], kind: "ocean" },

  // South Asia
  { name: "Colombo", unlocode: "LKCMB", lat: 6.9271, lon: 79.8612, radiusKm: 15, aliases: ["colombo", "cmb"], kind: "ocean" },
  { name: "Mundra", unlocode: "INMUN", lat: 22.7396, lon: 69.7219, radiusKm: 15, aliases: ["mundra", "mun"], kind: "ocean" },
  { name: "Nhava Sheva / JNPT", unlocode: "INNSA", lat: 18.9403, lon: 72.9528, radiusKm: 15, aliases: ["nhava sheva", "jnpt", "nsa", "mumbai"], kind: "ocean" },

  // Latin America
  { name: "Santos", unlocode: "BRSSZ", lat: -23.9333, lon: -46.3333, radiusKm: 20, aliases: ["santos", "ssz"], kind: "ocean" },
  { name: "Manzanillo (MX)", unlocode: "MXZLO", lat: 19.0510, lon: -104.3165, radiusKm: 15, aliases: ["manzanillo", "zlo"], kind: "ocean" },
  { name: "Balboa", unlocode: "PABLB", lat: 8.9586, lon: -79.5653, radiusKm: 15, aliases: ["balboa", "blb"], kind: "ocean" },
  { name: "Cartagena (CO)", unlocode: "COCTG", lat: 10.3910, lon: -75.4794, radiusKm: 15, aliases: ["cartagena", "ctg"], kind: "ocean" },
];

const AIR_HUBS: PortEntry[] = [
  { name: "Hong Kong (HKG)", iata: "HKG", lat: 22.3080, lon: 113.9185, radiusKm: 15, aliases: ["hkg", "hong kong airport"], kind: "air" },
  { name: "Shanghai Pudong (PVG)", iata: "PVG", lat: 31.1443, lon: 121.8083, radiusKm: 15, aliases: ["pvg", "shanghai pudong"], kind: "air" },
  { name: "Dubai (DXB)", iata: "DXB", lat: 25.2532, lon: 55.3657, radiusKm: 15, aliases: ["dxb", "dubai airport"], kind: "air" },
  { name: "Anchorage (ANC)", iata: "ANC", lat: 61.1743, lon: -149.9982, radiusKm: 15, aliases: ["anc", "anchorage"], kind: "air" },
  { name: "Memphis (MEM)", iata: "MEM", lat: 35.0424, lon: -89.9767, radiusKm: 10, aliases: ["mem", "memphis"], kind: "air" },
  { name: "Louisville (SDF)", iata: "SDF", lat: 38.1744, lon: -85.7360, radiusKm: 10, aliases: ["sdf", "louisville"], kind: "air" },
  { name: "Los Angeles (LAX)", iata: "LAX", lat: 33.9416, lon: -118.4085, radiusKm: 15, aliases: ["lax", "los angeles airport"], kind: "air" },
  { name: "Chicago O'Hare (ORD)", iata: "ORD", lat: 41.9742, lon: -87.9073, radiusKm: 15, aliases: ["ord", "o'hare", "chicago"], kind: "air" },
  { name: "Miami (MIA)", iata: "MIA", lat: 25.7959, lon: -80.2870, radiusKm: 10, aliases: ["mia", "miami airport"], kind: "air" },
  { name: "New York JFK", iata: "JFK", lat: 40.6413, lon: -73.7781, radiusKm: 15, aliases: ["jfk", "new york jfk"], kind: "air" },
  { name: "Frankfurt (FRA)", iata: "FRA", lat: 50.0379, lon: 8.5622, radiusKm: 15, aliases: ["fra", "frankfurt"], kind: "air" },
  { name: "Amsterdam (AMS)", iata: "AMS", lat: 52.3105, lon: 4.7683, radiusKm: 15, aliases: ["ams", "schiphol", "amsterdam"], kind: "air" },
  { name: "Paris CDG", iata: "CDG", lat: 49.0097, lon: 2.5479, radiusKm: 15, aliases: ["cdg", "charles de gaulle", "paris"], kind: "air" },
  { name: "London Heathrow", iata: "LHR", lat: 51.4700, lon: -0.4543, radiusKm: 15, aliases: ["lhr", "heathrow"], kind: "air" },
  { name: "Seoul Incheon", iata: "ICN", lat: 37.4602, lon: 126.4407, radiusKm: 15, aliases: ["icn", "incheon"], kind: "air" },
  { name: "Tokyo Narita", iata: "NRT", lat: 35.7720, lon: 140.3929, radiusKm: 15, aliases: ["nrt", "narita"], kind: "air" },
  { name: "Singapore Changi", iata: "SIN", lat: 1.3644, lon: 103.9915, radiusKm: 15, aliases: ["sin", "changi"], kind: "air" },
  { name: "Taipei Taoyuan", iata: "TPE", lat: 25.0797, lon: 121.2342, radiusKm: 15, aliases: ["tpe", "taoyuan"], kind: "air" },
  { name: "Doha (DOH)", iata: "DOH", lat: 25.2609, lon: 51.5144, radiusKm: 15, aliases: ["doh", "doha"], kind: "air" },
  { name: "Istanbul (IST)", iata: "IST", lat: 41.2753, lon: 28.7519, radiusKm: 15, aliases: ["ist", "istanbul"], kind: "air" },
  // Asia secondary cargo hubs
  { name: "Beijing Capital (PEK)", iata: "PEK", lat: 40.0801, lon: 116.5846, radiusKm: 15, aliases: ["pek", "beijing capital"], kind: "air" },
  { name: "Guangzhou Baiyun (CAN)", iata: "CAN", lat: 23.3924, lon: 113.2988, radiusKm: 15, aliases: ["can", "baiyun", "guangzhou airport"], kind: "air" },
  { name: "Chengdu Tianfu (CTU)", iata: "CTU", lat: 30.5785, lon: 103.9471, radiusKm: 15, aliases: ["ctu", "chengdu"], kind: "air" },
  { name: "Shenzhen Bao'an (SZX)", iata: "SZX", lat: 22.6393, lon: 113.8108, radiusKm: 15, aliases: ["szx", "shenzhen airport", "bao'an"], kind: "air" },
  { name: "Bangkok Suvarnabhumi (BKK)", iata: "BKK", lat: 13.6900, lon: 100.7501, radiusKm: 15, aliases: ["bkk", "suvarnabhumi", "bangkok"], kind: "air" },
  { name: "Kuala Lumpur (KUL)", iata: "KUL", lat: 2.7456, lon: 101.7099, radiusKm: 15, aliases: ["kul", "kuala lumpur"], kind: "air" },
  { name: "Jakarta Soekarno-Hatta (CGK)", iata: "CGK", lat: -6.1256, lon: 106.6559, radiusKm: 15, aliases: ["cgk", "jakarta", "soekarno"], kind: "air" },
  { name: "Manila (MNL)", iata: "MNL", lat: 14.5086, lon: 121.0194, radiusKm: 12, aliases: ["mnl", "manila"], kind: "air" },
  { name: "Ho Chi Minh City (SGN)", iata: "SGN", lat: 10.8188, lon: 106.6519, radiusKm: 12, aliases: ["sgn", "saigon", "tan son nhat"], kind: "air" },
  { name: "Delhi (DEL)", iata: "DEL", lat: 28.5562, lon: 77.1000, radiusKm: 15, aliases: ["del", "delhi", "indira gandhi"], kind: "air" },
  { name: "Mumbai (BOM)", iata: "BOM", lat: 19.0896, lon: 72.8656, radiusKm: 12, aliases: ["bom", "mumbai", "bombay"], kind: "air" },
  { name: "Bangalore (BLR)", iata: "BLR", lat: 13.1986, lon: 77.7066, radiusKm: 12, aliases: ["blr", "bangalore", "bengaluru"], kind: "air" },
  { name: "Tokyo Haneda (HND)", iata: "HND", lat: 35.5523, lon: 139.7798, radiusKm: 12, aliases: ["hnd", "haneda"], kind: "air" },
  { name: "Osaka Kansai (KIX)", iata: "KIX", lat: 34.4348, lon: 135.2440, radiusKm: 12, aliases: ["kix", "kansai", "osaka"], kind: "air" },
  // Middle East
  { name: "Abu Dhabi (AUH)", iata: "AUH", lat: 24.4330, lon: 54.6511, radiusKm: 15, aliases: ["auh", "abu dhabi"], kind: "air" },
  { name: "Riyadh (RUH)", iata: "RUH", lat: 24.9576, lon: 46.6988, radiusKm: 15, aliases: ["ruh", "riyadh"], kind: "air" },
  // Europe (cargo-heavy secondaries)
  { name: "Liege (LGG)", iata: "LGG", lat: 50.6374, lon: 5.4434, radiusKm: 10, aliases: ["lgg", "liege"], kind: "air" },
  { name: "Luxembourg (LUX)", iata: "LUX", lat: 49.6266, lon: 6.2114, radiusKm: 10, aliases: ["lux", "luxembourg"], kind: "air" },
  { name: "Cologne Bonn (CGN)", iata: "CGN", lat: 50.8659, lon: 7.1427, radiusKm: 12, aliases: ["cgn", "cologne", "koeln"], kind: "air" },
  { name: "Leipzig (LEJ)", iata: "LEJ", lat: 51.4324, lon: 12.2416, radiusKm: 10, aliases: ["lej", "leipzig"], kind: "air" },
  { name: "Madrid (MAD)", iata: "MAD", lat: 40.4983, lon: -3.5676, radiusKm: 15, aliases: ["mad", "madrid", "barajas"], kind: "air" },
  { name: "Milan Malpensa (MXP)", iata: "MXP", lat: 45.6306, lon: 8.7281, radiusKm: 12, aliases: ["mxp", "malpensa", "milan"], kind: "air" },
  { name: "Brussels (BRU)", iata: "BRU", lat: 50.9014, lon: 4.4844, radiusKm: 12, aliases: ["bru", "brussels", "zaventem"], kind: "air" },
  { name: "Zurich (ZRH)", iata: "ZRH", lat: 47.4647, lon: 8.5492, radiusKm: 10, aliases: ["zrh", "zurich"], kind: "air" },
  { name: "Munich (MUC)", iata: "MUC", lat: 48.3538, lon: 11.7861, radiusKm: 12, aliases: ["muc", "munich", "muenchen"], kind: "air" },
  // Americas (cargo-heavy)
  { name: "Toronto Pearson (YYZ)", iata: "YYZ", lat: 43.6777, lon: -79.6248, radiusKm: 15, aliases: ["yyz", "toronto", "pearson"], kind: "air" },
  { name: "Mexico City (MEX)", iata: "MEX", lat: 19.4361, lon: -99.0719, radiusKm: 15, aliases: ["mex", "mexico city"], kind: "air" },
  { name: "Sao Paulo Guarulhos (GRU)", iata: "GRU", lat: -23.4356, lon: -46.4731, radiusKm: 15, aliases: ["gru", "guarulhos", "sao paulo"], kind: "air" },
  { name: "Bogota (BOG)", iata: "BOG", lat: 4.7016, lon: -74.1469, radiusKm: 12, aliases: ["bog", "bogota", "el dorado"], kind: "air" },
  { name: "Santiago (SCL)", iata: "SCL", lat: -33.3930, lon: -70.7858, radiusKm: 12, aliases: ["scl", "santiago"], kind: "air" },
  { name: "Atlanta (ATL)", iata: "ATL", lat: 33.6407, lon: -84.4277, radiusKm: 15, aliases: ["atl", "atlanta", "hartsfield"], kind: "air" },
  { name: "Dallas Fort Worth (DFW)", iata: "DFW", lat: 32.8998, lon: -97.0403, radiusKm: 15, aliases: ["dfw", "dallas", "fort worth"], kind: "air" },
  // Africa
  { name: "Johannesburg (JNB)", iata: "JNB", lat: -26.1392, lon: 28.2460, radiusKm: 15, aliases: ["jnb", "johannesburg", "tambo"], kind: "air" },
  { name: "Nairobi (NBO)", iata: "NBO", lat: -1.3192, lon: 36.9277, radiusKm: 12, aliases: ["nbo", "nairobi"], kind: "air" },
  { name: "Cairo (CAI)", iata: "CAI", lat: 30.1219, lon: 31.4056, radiusKm: 12, aliases: ["cai", "cairo"], kind: "air" },
  { name: "Addis Ababa (ADD)", iata: "ADD", lat: 8.9779, lon: 38.7993, radiusKm: 12, aliases: ["add", "addis ababa", "bole"], kind: "air" },
];

const ALL: PortEntry[] = [...OCEAN_PORTS, ...AIR_HUBS];

export function resolvePort(text: string | null | undefined): PortEntry | null {
  if (!text) return null;
  const lower = text.trim().toLowerCase();
  if (!lower) return null;

  // Exact UNLOCODE / IATA match first (5 or 3 chars)
  const upper = text.trim().toUpperCase();
  for (const p of ALL) {
    if (p.unlocode === upper || p.iata === upper) return p;
  }
  // Alias substring match
  for (const p of ALL) {
    for (const a of p.aliases) {
      if (lower.includes(a)) return p;
    }
  }
  return null;
}

/** Great-circle distance in km between two coordinates. */
export function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const la1 = (aLat * Math.PI) / 180;
  const la2 = (bLat * Math.PI) / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

export function listPorts(): PortEntry[] {
  return ALL;
}
