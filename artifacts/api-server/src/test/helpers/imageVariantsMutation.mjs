import { registerHooks } from "node:module";

const targets = {
  generation: { suffix: "/imageVariants/contracts.ts", pattern: /left\.sourceVersion\s*===\s*right\.sourceVersion/g, replacement: "true" },
  publication: { suffix: "/imageVariants/runtime.ts", pattern: /const latest\s*=\s*await ready\(source,\s*signal\);/g, replacement: "const latest=output;" },
};
const target = targets[process.env.IMAGE_VARIANTS_MUTATION];
if (!target) throw new Error("unknown image variants mutation");
registerHooks({ load(url, context, nextLoad) {
  const loaded = nextLoad(url, context);
  if (!url.endsWith(target.suffix)) return loaded;
  const source = typeof loaded.source === "string" ? loaded.source : Buffer.from(loaded.source).toString("utf8");
  if ([...source.matchAll(target.pattern)].length !== 1) throw new Error("image guard not uniquely located");
  return { ...loaded, source: source.replace(target.pattern, target.replacement) };
} });
