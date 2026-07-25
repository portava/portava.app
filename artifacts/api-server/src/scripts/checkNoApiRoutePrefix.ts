/**
 * checkNoApiRoutePrefix — guard against the double-prefix bug (audit API-01).
 *
 * Every router in src/routes is mounted under `app.use("/api", router)`
 * (see app.ts). A route declared as `router.get("/api/...")` therefore resolves
 * at `/api/api/...` and 404s for every client. This check fails CI if any route
 * (or router.use mount) in src/routes declares a path beginning with `/api`.
 *
 * Run: node --import tsx/esm src/scripts/checkNoApiRoutePrefix.ts
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROUTES_DIR = new URL("../routes/", import.meta.url).pathname;

// router.get|post|put|patch|delete|options|head|all|use("  /api...
const OFFENDER =
  /\brouter\s*\.\s*(get|post|put|patch|delete|options|head|all|use)\s*\(\s*(["'`])\/api\b/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const offenders: Array<{ file: string; line: number; text: string }> = [];
for (const file of walk(ROUTES_DIR)) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((text, i) => {
    if (OFFENDER.test(text)) {
      offenders.push({ file: file.replace(ROUTES_DIR, "routes/"), line: i + 1, text: text.trim() });
    }
  });
}

if (offenders.length > 0) {
  console.error(
    `✖ ${offenders.length} route(s) declare an "/api" prefix. They are mounted under app.use("/api", …) ` +
      `and will resolve at /api/api/… (404). Remove the leading "/api":`,
  );
  for (const o of offenders) console.error(`  ${o.file}:${o.line}  ${o.text}`);
  process.exit(1);
}
console.log("✔ no route declares an /api prefix — mounting is clean.");
