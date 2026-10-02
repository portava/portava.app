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
 * ── THE SECOND CHECK: ONE PATH, TWO ROUTERS ─────────────────────────────────
 * The limit above used to read "one file at a time … two routers mounted on the
 * same prefix can shadow each other across files and this does not see it", and
 * that limit cost the repository a whole endpoint.
 *
 *     routes/telegraphCommands.ts        router.post("/telegraph/commands", …)
 *     server/telegraph/commandRoute.ts   router.post("/telegraph/commands", …)
 *
 * Both were mounted by `routes/index.ts`, the assistant first. Express takes the
 * first matching handler, so the assistant answered EVERY request to that path
 * and the §13.1 command vocabulary behind the second — `UNSEND_MESSAGE`,
 * `ADD_REACTION`, `REMOVE_REACTION` — was unreachable in the running app. A
 * well-formed command came back `400 invalid_payload "Required"`: the
 * assistant's schema refusing a body with no `text`. Its own test suite passed
 * throughout, because that suite mounts the one router alone.
 *
 * So this guard now also reads the MOUNTED routers — every file
 * `routes/index.ts` passes to `router.use`, including the ones under
 * `src/server/`, which the old corpus never opened — and fails on any
 * (method, path) registered by more than one of them.
 *
 * A shared path is permitted only when it is DECLARED below, with the divider
 * that makes both reachable and in the mount order that divider depends on. A
 * declaration is an argument someone had to write, not a suppression.
 *
 * ── LIMITS, STATED RATHER THAN IMPLIED ──────────────────────────────────────
 *   * Cross-file detection is EXACT-PATH only. A parameterised path in one
 *     router capturing a literal in another is still not modelled; within one
 *     file it is, by the first check.
 *   * Mount prefixes are assumed shared. Every `router.use(x)` in
 *     `routes/index.ts` is prefix-less today, so two registrations of one path
 *     really do collide. A future `router.use("/prefix", x)` would make that
 *     assumption wrong, and the parser refuses such a mount rather than
 *     guessing.
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

/**
 * Every route registration in one file, in source order.
 *
 * Scanned over the WHOLE source, not line by line. A line-by-line scan cannot
 * see the registration this repository writes most often for a handler with a
 * wrapper:
 *
 *     router.post(
 *       "/telegraph/commands",
 *       asyncHandler(async (req, res, next) => {
 *
 * — the method and the path are on different lines, so the pattern never
 * matched and the route was invisible to this guard. That is not a small blind
 * spot: `POST /telegraph/commands` was registered by two routers in exactly that
 * shape and neither registration was ever extracted, so nothing could report the
 * collision. A guard that cannot see a route cannot vouch for it.
 */
export function extractRoutes(source: string): RouteReg[] {
  const out: RouteReg[] = [];
  const lineStarts: number[] = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") lineStarts.push(i + 1);
  const lineOf = (index: number): number => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= index) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };

  ROUTE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ROUTE_RE.exec(source)) !== null) {
    const line = lineOf(m.index);
    // Skip commented-out registrations: a documented example is not a route.
    const text = source.slice(lineStarts[line - 1], lineStarts[line] ?? source.length).trim();
    if (text.startsWith("//") || text.startsWith("*")) continue;
    out.push({ method: m[1].toLowerCase(), path: m[2], line });
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

/* ────────────────────── the mounted routers, in mount order ────────────────── */

export interface MountedRouter {
  /** Path relative to `src/`, e.g. "routes/telegraphCommands.ts". */
  name: string;
  /** Position in `routes/index.ts`'s `router.use(...)` sequence, 0-based. */
  order: number;
}

export interface DuplicateFinding {
  method: string;
  path: string;
  /** Every mounted router registering it, in mount order. */
  registrations: Array<{ name: string; order: number; line: number }>;
}

/**
 * A path two mounted routers are allowed to share, because one of them yields.
 *
 * `files` is in the order they MUST be mounted: the first is the router that
 * claims a subset of the bodies and calls `next()` on the rest. Declaring a pair
 * without that divider only moves the defect, so the reason is written out and
 * the order is enforced.
 */
export const DECLARED_SHARED_PATHS: ReadonlyArray<{
  method: string;
  path: string;
  files: readonly string[];
  reason: string;
}> = [
  {
    method: "post",
    path: "/telegraph/commands",
    files: ["server/telegraph/commandRoute.ts", "routes/telegraphCommands.ts"],
    reason:
      "Two disjoint bodies on one published path. The kernel command router is mounted " +
      "first and returns next() for any body without a `type`, so the natural-language " +
      "assistant in routes/telegraphCommands.ts still receives every `{ text }` body it " +
      "did before. Mounted the other way round, the assistant answered everything and " +
      "the §13.1 command vocabulary was unreachable.",
  },
  {
    method: "delete",
    path: "/rent-a-buddy/waitlist/:id",
    files: ["routes/rentABuddy.ts", "routes/rentABuddyMarketplace.ts"],
    reason:
      "Pre-existing, and the pattern this check was taught to recognise rather than a " +
      "defect it found. rentABuddy.ts is mounted first and calls next() when the " +
      "parameter is a uuid, so the marketplace router owns the by-id semantics (soft " +
      "cancel, ownership scoped by user_id) and the city-name form is served where it " +
      "was. Its own header says so.",
  },
];

/**
 * CONTESTED PATHS THAT ARE DEFECTS, COUNTED RATHER THAN EXCUSED.
 *
 * Each entry is a path where two mounted routers both register a handler and
 * NEITHER yields, so the second handler never runs. These are not approved: the
 * list is a ratchet in the repository's usual sense — it may only shrink, and an
 * entry that is no longer contested must be deleted in the same change that
 * fixes it, or this check fails on the stale entry.
 *
 * Nothing here is an argument that the verdict cannot change. Each one CAN be
 * fixed; each needs a decision this check is not entitled to take, because the
 * two handlers answer with different JSON and picking either one changes what a
 * live client receives.
 */
export const CONTESTED_PATH_RATCHET: ReadonlyArray<{
  method: string;
  path: string;
  dead: string;
  needs: string;
}> = [
  {
    method: "get",
    path: "/trips/:tripId/chat",
    dead: "routes/groupChat.ts — reached only if routes/messaging.ts stops registering it",
    needs:
      "A choice of response shape. messaging.ts answers " +
      "{ threadId, threadType, title, tripId, circleOwnerId }; groupChat.ts answers " +
      "{ thread: {...}, messages: [...] }. They are not interchangeable, so whichever " +
      "is retired breaks its clients. The dead handler is the one carrying the §20.7 " +
      "fix that tells a person holding a live invite `pending_invite` rather than the " +
      "`not_member` dead end, and that fix has never run.",
  },
  {
    method: "get",
    path: "/circles/:circleOwnerId/chat",
    dead: "routes/groupChat.ts — same pair, same two routers, same choice",
    needs: "The same response-shape decision as the trips path above.",
  },
  {
    method: "get",
    path: "/threads/:threadId/search",
    dead: "server/telegraph/searchRoute.ts — routes/telegraphKinds.ts is mounted 9 routers earlier",
    needs:
      "A choice of response shape, like the pair above. telegraphKinds.ts answers " +
      "{ threadId, query, tab, results, scanned }; searchRoute.ts answers whatever " +
      "searchConversations() returns, scoped by conversationId. Same defect shape as " +
      "POST /telegraph/commands had — a router under src/server/ mounted after an older " +
      "one that already owns its path — and it is on this list rather than fixed here " +
      "because unsend is what this change is for.",
  },
];

/** `import x from "./y";` → x ↦ "routes/y.ts", resolved against `src/`. */
export function parseRouterImports(indexSource: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /^\s*import\s+(\w+)\s+from\s+["']([^"']+)["']/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(indexSource)) !== null) {
    const spec = m[2].replace(/\.js$/, "");
    if (!spec.startsWith(".")) continue;
    // routes/index.ts sits in src/routes/, so "./x" is routes/x and "../a/b" is
    // a/b — which is what join() normalises the "routes/../a/b" to.
    out.set(m[1], `${join("routes", spec).replace(/\\/g, "/")}.ts`);
  }
  return out;
}

/**
 * The `router.use(x)` sequence, as mounted.
 *
 * A mount with a path prefix is not modelled, and returning it as `null` makes
 * the caller fail rather than silently compare paths that never collide.
 */
export function parseMountOrder(indexSource: string): { mounts: string[]; prefixed: string[] } {
  const mounts: string[] = [];
  const prefixed: string[] = [];
  const bare = /^\s*router\.use\(\s*(\w+)\s*\)/;
  const withPrefix = /^\s*router\.use\(\s*["'`]([^"'`]+)["'`]\s*,\s*(\w+)\s*\)/;
  for (const line of indexSource.split("\n")) {
    const p = withPrefix.exec(line);
    if (p) { prefixed.push(`${p[1]} → ${p[2]}`); continue; }
    const b = bare.exec(line);
    if (b) mounts.push(b[1]);
  }
  return { mounts, prefixed };
}

/**
 * The path as EXPRESS will match it, which is not the path as written.
 *
 * `/circles/:circleOwnerId/chat` and `/circles/:circleId/chat` are the same
 * route: a parameter's name is a local variable, not part of the pattern. Keying
 * on the written path would let two routers contest a path and go unreported
 * because someone named the id differently — which is exactly what the circles
 * pair below did. Every parameter collapses to `:` and a trailing slash goes.
 */
export function normalisePath(path: string): string {
  return path
    .replace(/\/$/, "")
    .split("/")
    .map((seg) => (seg.startsWith(":") ? ":" : seg))
    .join("/");
}

/** Every (method, path) registered by more than one mounted router. */
export function findDuplicatePaths(
  mounted: MountedRouter[],
  sourceOf: (name: string) => string | undefined,
): DuplicateFinding[] {
  const byKey = new Map<string, DuplicateFinding["registrations"]>();
  for (const r of mounted) {
    const src = sourceOf(r.name);
    if (!src) continue;
    for (const route of extractRoutes(src)) {
      const key = `${route.method} ${normalisePath(route.path)}`;
      const list = byKey.get(key) ?? [];
      list.push({ name: r.name, order: r.order, line: route.line });
      byKey.set(key, list);
    }
  }
  const findings: DuplicateFinding[] = [];
  for (const [key, registrations] of byKey) {
    // Two registrations inside ONE file are the first check's business.
    const distinct = new Set(registrations.map((x) => x.name));
    if (distinct.size < 2) continue;
    const [method, path] = key.split(" ");
    registrations.sort((a, b) => a.order - b.order);
    const declared = DECLARED_SHARED_PATHS.find(
      (d) => d.method === method && normalisePath(d.path) === path,
    );
    if (declared) {
      const actual = registrations.map((x) => x.name);
      const sameSet =
        declared.files.length === actual.length &&
        declared.files.every((f, i) => f === actual[i]);
      // A declaration that no longer matches the mount order is worse than no
      // declaration: the divider is then in the router that runs second.
      if (sameSet) continue;
    }
    findings.push({ method, path, registrations });
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

  // ── Second check: one path, two mounted routers ────────────────────────────
  const indexPath = resolve(ROUTES_DIR, "index.ts");
  const indexSource = readFileSync(indexPath, "utf8");
  const imports = parseRouterImports(indexSource);
  const { mounts, prefixed } = parseMountOrder(indexSource);

  if (prefixed.length > 0) {
    console.error(
      "::error::check-route-shadowing found a router mounted under a path prefix " +
      `(${prefixed.join(", ")}). This guard compares paths assuming every router shares ` +
      "one prefix; that assumption no longer holds, so it would pass for the wrong reason. " +
      "Teach the parser about prefixes rather than removing this refusal.",
    );
    process.exit(1);
  }

  const mounted: MountedRouter[] = [];
  const unresolved: string[] = [];
  mounts.forEach((ident, order) => {
    const name = imports.get(ident);
    if (!name) { unresolved.push(ident); return; }
    mounted.push({ name, order });
  });
  if (unresolved.length > 0) {
    console.error(
      `::error::check-route-shadowing could not resolve ${unresolved.length} mounted router(s) ` +
      `to a file (${unresolved.join(", ")}). A router it cannot open is a router it cannot check, ` +
      "so this fails rather than reporting on the remainder.",
    );
    process.exit(1);
  }
  if (mounted.length < 40) {
    console.error(
      `::error::check-route-shadowing resolved only ${mounted.length} mounted routers from ` +
      "routes/index.ts. That is far below this repo's real surface, so the parse is broken " +
      "rather than the mount list short.",
    );
    process.exit(1);
  }

  const readMounted = (name: string): string | undefined => {
    try { return readFileSync(resolve(SRC_ROOT, name), "utf8"); } catch { return undefined; }
  };
  const missing = mounted.filter((m) => readMounted(m.name) === undefined);
  if (missing.length > 0) {
    console.error(
      "::error::check-route-shadowing could not read these mounted router files: " +
      missing.map((m) => m.name).join(", "),
    );
    process.exit(1);
  }

  const contested = findDuplicatePaths(mounted, readMounted);
  const ratchetKey = (method: string, path: string) => `${method} ${normalisePath(path)}`;
  const ratcheted = new Set(CONTESTED_PATH_RATCHET.map((r) => ratchetKey(r.method, r.path)));
  const seen = new Set(contested.map((d) => ratchetKey(d.method, d.path)));

  // The ratchet may only shrink: an entry that is no longer contested has been
  // fixed, and leaving it behind would let the next one hide in the count.
  const stale = [...ratcheted].filter((k) => !seen.has(k));
  if (stale.length > 0) {
    console.error(
      "✖ check-route-shadowing FAILED — CONTESTED_PATH_RATCHET names path(s) that are no " +
      `longer contested: ${stale.join(", ")}. Delete the entr${stale.length === 1 ? "y" : "ies"} ` +
      "in the change that fixed them.",
    );
    process.exit(1);
  }

  const duplicates = contested.filter((d) => !ratcheted.has(ratchetKey(d.method, d.path)));
  if (duplicates.length > 0) {
    console.error("✖ check-route-shadowing FAILED — one path, more than one mounted router\n");
    for (const d of duplicates) {
      console.error(`  ${d.method.toUpperCase()} ${d.path}`);
      for (const r of d.registrations) {
        console.error(`    mount #${r.order}  ${r.name}  (line ${r.line})`);
      }
      console.error(
        "    Express takes the FIRST matching handler, so every registration after the " +
        "first is unreachable unless the first yields with next().\n" +
        "    Either give one of them its own path, or add a divider and declare the pair in " +
        "DECLARED_SHARED_PATHS with the reason and the required mount order.\n",
      );
    }
    console.error(`  ${duplicates.length} contested path(s).`);
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
  console.log(
    `✓ No NEW contested paths. ${mounted.length} routers mounted by routes/index.ts, ` +
    `${DECLARED_SHARED_PATHS.length} declared shared path(s) with a divider, ` +
    `${CONTESTED_PATH_RATCHET.length} on the contested-path ratchet.`,
  );
  if (CONTESTED_PATH_RATCHET.length > 0) {
    for (const r of CONTESTED_PATH_RATCHET) {
      console.log(`    ratchet: ${r.method.toUpperCase()} ${r.path} — dead: ${r.dead}`);
    }
    console.log("    The ratchet must reach zero; it may never grow.");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
