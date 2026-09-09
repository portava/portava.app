/**
 * checkNoApiRoutePrefix — guard against the double-prefix bug (audit API-01).
 *
 * Every router in src/routes is mounted under `app.use("/api", router)`
 * (see app.ts). A route declared as `router.get("/api/...")` therefore resolves
 * at `/api/api/...` and 404s for every client. This check fails CI if any route
 * (or router.use mount) in src/routes declares a path beginning with `/api`.
 *
 * ── IT MUST PROVE IT LOOKED ──────────────────────────────────────────────────
 * "No route declares an /api prefix" is also what this prints when it read no
 * files, and when it read every file but recognised no route declaration in any
 * of them — if the routers stopped being called `router`, or the declaration
 * shape changed, this pattern would match nothing and report a clean mounting
 * surface for a tree it could no longer see. Silence and absence are the same
 * output. So both populations are counted and printed, and a zero in either is
 * a FAILURE rather than a pass: files walked, and route declarations actually
 * recognised inside them.
 *
 * ── COMMENTS ARE NOT CODE ────────────────────────────────────────────────────
 * The scan runs over the comment-stripped text. Six guards in this tree shipped
 * the bug of matching raw file text; here it cuts both ways — a commented-out
 * `router.get("/api/…")` is not a route and must not be reported as one, and a
 * commented-out declaration must not be counted towards the proof that this
 * check had something to look at. Line numbers survive stripping, so offender
 * reporting is unaffected.
 *
 * Run: node --import tsx/esm src/scripts/checkNoApiRoutePrefix.ts
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./lib/stripComments.js";

const ROUTES_DIR = new URL("../routes/", import.meta.url).pathname;

// router.get|post|put|patch|delete|options|head|all|use("  /api...
const OFFENDER =
  /\brouter\s*\.\s*(get|post|put|patch|delete|options|head|all|use)\s*\(\s*(["'`])\/api\b/;
// The same declaration shape with ANY path — the denominator this check needs
// in order to claim it examined a routing surface at all.
const DECLARATION = /\brouter\s*\.\s*(get|post|put|patch|delete|options|head|all|use)\s*\(/;

/** A tree with no route files, or no recognised declarations, is not a clean tree. */
const MIN_ROUTE_FILES = 50;
const MIN_DECLARATIONS = 200;

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
let filesScanned = 0;
let declarations = 0;

for (const file of walk(ROUTES_DIR)) {
  filesScanned++;
  const raw = readFileSync(file, "utf8");
  const lines = stripComments(raw).split("\n");
  const rawLines = raw.split("\n");
  lines.forEach((text, i) => {
    if (DECLARATION.test(text)) declarations++;
    if (OFFENDER.test(text)) {
      // Report the ORIGINAL line: the stripped one may have had a trailing
      // comment removed, and a reader is going to open the file at this number.
      offenders.push({ file: file.replace(ROUTES_DIR, "routes/"), line: i + 1, text: (rawLines[i] ?? text).trim() });
    }
  });
}

const vacuity: string[] = [];
if (filesScanned < MIN_ROUTE_FILES) {
  vacuity.push(
    `only ${filesScanned} route file(s) were scanned under src/routes/ (floor ${MIN_ROUTE_FILES}). ` +
      "Either the tree moved or the walk stopped matching, and a clean verdict over almost nothing is " +
      "not a clean verdict.",
  );
}
if (declarations < MIN_DECLARATIONS) {
  vacuity.push(
    `only ${declarations} route declaration(s) were recognised (floor ${MIN_DECLARATIONS}). The offender ` +
      "pattern is the declaration pattern plus a leading /api, so if declarations are not being seen, " +
      "offenders cannot be either — and this check would print a clean mounting surface for a tree it " +
      "can no longer read. Re-derive the pattern against how routers are actually declared now.",
  );
}

if (vacuity.length > 0) {
  console.error("✖ check-api-prefix examined too little to have a verdict:");
  for (const v of vacuity) console.error(`  ${v}`);
  process.exit(1);
}

if (offenders.length > 0) {
  console.error(
    `✖ ${offenders.length} route(s) declare an "/api" prefix. They are mounted under app.use("/api", …) ` +
      `and will resolve at /api/api/… (404). Remove the leading "/api":`,
  );
  for (const o of offenders) console.error(`  ${o.file}:${o.line}  ${o.text}`);
  process.exit(1);
}
console.log(
  `✔ no route declares an /api prefix — mounting is clean. ${declarations} route declaration(s) inspected ` +
    `across ${filesScanned} route file(s).`,
);
