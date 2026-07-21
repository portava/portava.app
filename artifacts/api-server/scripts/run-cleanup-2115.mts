import { getServiceClient } from "../src/lib/supabase.js";
import { cleanupNonCanonicalCityRows, rebuildIntelligenceGraph } from "../src/compass/CompassGraphEngine.js";
import { canonicalCityKey } from "../src/lib/canonicalLocations.js";

const sc = getServiceClient();
if (!sc) { console.error("no service client"); process.exit(1); }

const cleanup = await cleanupNonCanonicalCityRows(sc);
console.log("CLEANUP:", JSON.stringify(cleanup, null, 2));
const rebuild = await rebuildIntelligenceGraph(sc);
console.log("REBUILD:", JSON.stringify(rebuild));

// Verify: only canonical keys remain across all four tables.
const bad = (k: unknown) => canonicalCityKey(String(k)) !== String(k);
const { data: cities } = await sc.from("compass_graph_nodes").select("node_key").eq("node_type", "city").limit(20000);
const { data: slices } = await sc.from("compass_graph_nodes").select("node_key").eq("node_type", "time_slice").limit(20000);
const { data: models } = await sc.from("compass_city_models").select("city").limit(20000);
const { data: conf } = await sc.from("compass_city_confidence").select("city").limit(20000);
const badCities = (cities ?? []).map(r => r.node_key).filter(bad);
const badSlices = (slices ?? []).map(r => r.node_key).filter(k => bad(String(k).split("|")[0]));
const badModels = (models ?? []).map(r => r.city).filter(bad);
const badConf = (conf ?? []).map(r => r.city).filter(bad);
console.log("VERIFY bad city nodes:", badCities);
console.log("VERIFY bad slice nodes:", badSlices);
console.log("VERIFY bad models:", badModels);
console.log("VERIFY bad confidence:", badConf);
process.exit(badCities.length || badSlices.length || badModels.length || badConf.length ? 2 : 0);
