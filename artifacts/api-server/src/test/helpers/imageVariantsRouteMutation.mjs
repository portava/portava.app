import { registerHooks } from "node:module";

const mutations = {
  authorization: [/await authorized\(source,\s*viewerId,\s*signal\);\s*return imageVariantDescriptor/g, "return imageVariantDescriptor"],
  publication: [/const latest\s*=\s*await ready\(source,\s*signal\);/g, "const latest=output;"],
};
const mutation = mutations[process.env.IMAGE_VARIANTS_ROUTE_MUTATION];
if (!mutation) throw new Error("unknown image route mutation");
registerHooks({ load(url, context, nextLoad) {
  const loaded = nextLoad(url, context);
  if (!url.endsWith("/services/media/ImageVariantsService.ts")) return loaded;
  const source = typeof loaded.source === "string" ? loaded.source : Buffer.from(loaded.source).toString("utf8");
  if ([...source.matchAll(mutation[0])].length !== 1) throw new Error("image route mutation target must be unique");
  return { ...loaded, source: source.replace(mutation[0], mutation[1]) };
} });
