import { registerHooks } from "node:module";

registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (!url.endsWith("/visualIndex/localVisualIndexProvider.ts")) return loaded;
    const source = typeof loaded.source === "string" ? loaded.source : Buffer.from(loaded.source).toString("utf8");
    const guard = /return await deps\.access\.visible\(viewerId,\s*postId,\s*current\);?/g;
    if ([...source.matchAll(guard)].length !== 1) throw new Error("authorization mutation guard not uniquely located");
    return { ...loaded, source: source.replace(guard, "return true;") };
  },
});
