import { registerHooks } from "node:module";

registerHooks({ load(url, context, nextLoad) {
  const loaded = nextLoad(url, context);
  if (!url.endsWith("/imageVariants/artifacts.ts")) return loaded;
  const source = typeof loaded.source === "string" ? loaded.source : Buffer.from(loaded.source).toString("utf8");
  const guard = /if\(await abortable\(canErase\(candidate,signal\),signal\)!==true\)return false/g;
  if ([...source.matchAll(guard)].length !== 1) throw new Error("orphan authorization guard must be unique");
  return { ...loaded, source: source.replace(guard, "await abortable(canErase(candidate,signal),signal)") };
} });
