/**
 * check-route-shadowing — no literal route may be registered behind a
 * parameterised one that would capture it.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * Express matches routes in registration order, so
 *
 *     router.get("/stories/:id",     …)   // line 367
 *     router.get("/stories/archive", …)   // line 596
 *
 * never reaches the second handler: `/stories/archive` matches `/stories/:id`
 * with `id === "archive"`, and the archive endpoint is unreachable. The symptom
 * is not a crash — it is whatever `/stories/:id` does with a non-UUID id, which
 * in this codebase is a tidy `invalid_payload`. A new endpoint that returns a
 * plausible client error on every call, forever.
 *
 * That exact pair was written during the Highlights archive work and caught by
 * reading the file, not by a test. Nothing in the suite would have failed: the
 * handler is present, typechecked and unit-testable in isolation — it is simply
 * never called. This guard is the thing that would have caught it.
 *
 * ── WHAT IT FLAGS ───────────────────────────────────────────────────────────
 * Within ONE router file and ONE HTTP method, a later route whose path has the
 * same segment count as an earlier route, where every earlier segment either
 * matches literally or is a parameter sitting over a LITERAL in the later path.
 *
 *     EARLIER  /stories/:id        LATER  /stories/archive     → shadowed
 *     EARLIER  /stories/:id/likes  LATER  /stories/x/likes     → shadowed
 *     EARLIER  /stories/archive    LATER  /stories/:id         → fine (correct order)
 *     EARLIER  /stories/:id        LATER  /stories/:other      → not flagged; two
 *                                                                params in the same
 *                                                                position is a
 *                                                                duplicate route,
 *                                                                a different defect
 *
 * ── LIMITS, STATED RATHER THAN IMPLIED ──────────────────────────────────────
 *   * One file at a time. Two routers mounted on the same prefix in
 *     routes/index.ts can shadow each other across files and this does not see
 *     it. Mount order is a second, separate question.
 *   * Text-level: it reads `router.<method>("<path>"` literals. A path built
 *     from a variable, or a router mounted with `router.use(prefix, sub)`, is
 *     invisible.
 *   * It says nothing about whether a shadowed route was INTENDED — a catch-all
 *     registered last on purpose is normal, and that is the case this direction
 *     of the check permits by construction.
 *   * Regex and wildcard segments (`*`, `(\\d+)`) are not modelled; a path
 *     containing either is skipped rather than guessed at.
 *
 * There is no baseline: the repo currently has ZERO violations, so this starts
 * clean and any hit is new. If that ever stops being true, add one rather than
 * loosening the rule.
 *
 * Run: node --import tsx/esm src/scripts/checkRouteShadowing.ts
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(__dir, "..");
const ROUTES_DIR = resolve(SRC_ROOT, "routes");

const ROUTE_RE =
  /\brouter\s*\.\s*(get|post|put|patch|delete|all)\s*\(\s*["'`]([^"'`]+)["'`]/g;

export interface RouteReg {
  method: string;
  path: string;
  line: number;
}

export interface ShadowFinding {
  file: string;
  method: string;
  earlier: RouteReg;
  later: RouteReg;
}

/** Every route registration in one file, in source order. */
export function extractRoutes(source: string): RouteReg[] {
  const out: RouteReg[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    // Skip commented-out registrations: a documented example is not a route.
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    ROUTE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ROUTE_RE.exec(lines[i])) !== null) {
      out.push({ method: m[1].toLowerCase(), path: m[2], line: i + 1 });
    }
  }
  return out;
}

const isParam = (seg: string) => seg.startsWith(":");
const isUnmodelled = (path: string) => path.includes("*") || path.includes("(");

/**
 * Does `earlier` capture every request that `later` was written for?
 *
 * True only when the two have the same shape AND at least one position where
 * `earlier` holds a parameter over a literal in `later` — that parameter is what
 * swallows the literal.
 */
export function shadows(earlier: string, later: string): boolean {
  if (isUnmodelled(earlier) || isUnmodelled(later)) return false;
  const a = earlier.replace(/^\/|\/$/g, "").split("/");
  const b = later.replace(/^\/|\/$/g, "").split("/");
  if (a.length !== b.length) return false;
  let swallowsALiteral = false;
  for (let i = 0; i < a.length; i++) {
    if (isParam(a[i])) {
      // Two params in the same position is a duplicate route, not a shadow.
      if (isParam(b[i])) return false;
      swallowsALiteral = true;
      continue;
    }
    if (a[i] !== b[i]) return false;
  }
  return swallowsALiteral;
}

export function findShadowedRoutes(files: Array<{ name: string; source: string }>): ShadowFinding[] {
  const findings: ShadowFinding[] = [];
  for (const f of files) {
    const routes = extractRoutes(f.source);
    for (let i = 0; i < routes.length; i++) {
      const later = routes[i];
      for (let j = 0; j < i; j++) {
        const earlier = routes[j];
        // `all` captures every method, so it shadows any later method.
        if (earlier.method !== later.method && earlier.method !== "all") continue;
        if (shadows(earlier.path, later.path)) {
          findings.push({ file: f.name, method: later.method.toUpperCase(), earlier, later });
          break;
        }
      }
    }
  }
  return findings;
}

function listRouteFiles(dir: string): Array<{ name: string; source: string }> {
  const out: Array<{ name: string; source: string }> = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { out.push(...listRouteFiles(full)); continue; }
    if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
    out.push({ name: relative(SRC_ROOT, full), source: readFileSync(full, "utf8") });
  }
  return out;
}

function main(): void {
  const files = listRouteFiles(ROUTES_DIR);
  // Vacuity check: a guard whose subject vanishes passes green.
  const totalRoutes = files.reduce((n, f) => n + extractRoutes(f.source).length, 0);
  if (files.length < 20 || totalRoutes < 200) {
    console.error(
      `::error::check-route-shadowing scanned only ${files.length} files / ${totalRoutes} routes. ` +
      "That is far below this repo's real surface, so the scan is broken rather than clean.",
    );
    process.exit(1);
  }

  const findings = findShadowedRoutes(files);
  if (findings.length > 0) {
    console.error("✖ check-route-shadowing FAILED\n");
    for (const f of findings) {
      console.error(`  ${f.file}`);
      console.error(`    ${f.method.padEnd(6)} ${f.earlier.path}  (line ${f.earlier.line})  captures`);
      console.error(`    ${f.method.padEnd(6)} ${f.later.path}  (line ${f.later.line})  → UNREACHABLE`);
      console.error(
        `    Express matches in registration order. Move the literal route ABOVE the ` +
        `parameterised one.\n`,
      );
    }
    console.error(`  ${findings.length} unreachable route(s).`);
    process.exit(1);
  }

  console.log(
    `✓ No shadowed routes. ${totalRoutes} registrations across ${files.length} router files, ` +
    "each literal path reachable ahead of any parameter that would capture it.",
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
