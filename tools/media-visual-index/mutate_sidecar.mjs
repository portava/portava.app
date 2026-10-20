import { registerHooks } from "node:module";

const mutations = {
  owner: { suffix: "/routes/mediaVisualIndex.ts", pattern: /source\.ownerId\s*!==\s*userId/g },
  origin: { suffix: "/visualIndex/canonicalImageAcquisition.ts", pattern: /url\.origin\s*!==\s*origin/g },
};
const mutation = mutations[process.env.VISUAL_SIDECAR_MUTATION];
if (!mutation) throw new Error("unknown visual sidecar mutation");
registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (!url.endsWith(mutation.suffix)) return loaded;
    const source = typeof loaded.source === "string" ? loaded.source : Buffer.from(loaded.source).toString("utf8");
    if ([...source.matchAll(mutation.pattern)].length !== 1) throw new Error("sidecar mutation guard not uniquely located");
    return { ...loaded, source: source.replace(mutation.pattern, "false") };
  },
});
