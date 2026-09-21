/**
 * check:telegraph-package-boundaries — §23's package layout exists, is
 * populated, is reached, and does not embed another domain's business logic.
 *
 * §23 names three package trees and then one rule, and the rule is the spec's
 * Primary Invariant restated: "Trips, Buddy, Safety, Memories, Discovery and
 * Compass remain integrations. Telegraph does not embed their canonical business
 * logic."
 *
 * ── WHY A LAYOUT IS WORTH CHECKING AT ALL ───────────────────────────────────
 * Because an empty directory is not a package, and a package nothing imports is
 * a folder. The failure this prevents is the one that makes architecture
 * documents worthless: `src/domain/telegraph/` exists, three of its eight
 * subdirectories have a file in them, nothing outside imports any of it, and a
 * reader concludes the boundary is real because the folders are there.
 *
 * ── FOUR RULES ──────────────────────────────────────────────────────────────
 *
 * 1. ALL EIGHT SUBDIRECTORIES EXIST AND ARE NON-EMPTY. §23's list is
 *    contracts, commands, events, policies, invariants, services, projections,
 *    replay. An empty one fails: it is a promise of a boundary, not a boundary.
 *
 * 2. EVERY MODULE IS REACHED FROM OUTSIDE THE PACKAGE. A domain module nobody
 *    imports is dead architecture — the same defect check:guard-reachability
 *    catches for checkers and check:projection-consumers catches for data pipes,
 *    one level further in. "Outside" means a route, a middleware, a lib, a
 *    script or a test; a module imported only by its siblings does not count.
 *
 * 3. NO IMPORT FROM ANOTHER DOMAIN'S BUSINESS LOGIC. The domain package may
 *    import from lib/ and from a small, NAMED set of shipped deciders it
 *    deliberately delegates to (the §14.3 window predicate, the block guard, the
 *    availability predicate, the crew-location resolver). Anything else under
 *    services/ — trips, rentBuddy, memory, highlights, intel — is refused. That
 *    is §23's sentence, mechanised: Telegraph may CALL an integration and may
 *    not CONTAIN one.
 *
 * 4. NO ROUTE IMPORTS. A domain module that reaches back into src/routes/ has
 *    inverted the dependency, and the layering §23 describes is gone.
 *
 * ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
 * It does not check §23's OTHER two trees. `src/features/telegraph/…` is a
 * client layout and `server/telegraph/…` describes a package split this
 * repository does not use — the routes are flat files under src/routes/. Both
 * are recorded as unmet in the census rather than enforced here, because a
 * checker that demanded a directory nobody intends to create would be a
 * permanently-red check, and a permanently-red check is one `|| true` away from
 * being no check at all.
 *
 * Exit codes: 0 pass, 1 violation. Static.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "../..");
const DOMAIN = resolve(PKG_ROOT, "src/domain/telegraph");

/** §23's eight subdirectories, in the spec's order. */
const REQUIRED_DIRS = [
  "contracts",
  "commands",
  "events",
  "policies",
  "invariants",
  "services",
  "projections",
  "replay",
];

/**
 * The shipped deciders the domain package is ALLOWED to delegate to, each with
 * the reason it is on the list. Delegation is the point — a simulator that
 * re-implemented the §14.3 window would be a second copy of an authorization
 * rule, which is worse than an import.
 */
const ALLOWED_SERVICE_IMPORTS: Record<string, string> = {
  "services/groupChatHistoryBound":
    "the §14.3 window predicate the real read path applies — re-implementing it would fork an authorization rule",
  "services/passport/OpenToPlansService":
    "the §7 availability visibility predicate, pure and shipped",
  "services/safeReturn/SafeReturnPrivacyGuard":
    "the expiry gate and coordinate strip, cited by the §26 matrix",
  // ADDED BY THE INTEGRATOR when the §12–§22 lane met this guard. The direction
  // matters: §23 forbids Telegraph EMBEDDING another domain's business logic,
  // and calling Trust's canonical decider is the opposite of embedding it —
  // census-trust A17 grades surfaces on whether they consume Trust through its
  // canonical read INSTEAD OF rebuilding it, and this is that read. The
  // capability policy needs one bit (is this viewer restricted, and was the
  // answer readable); re-deriving it from trust_profiles here would fork an
  // authorization rule across two domains, which is the failure this guard
  // exists to prevent, not the one it would be catching.
  "services/trust/TrustRestrictionService":
    "the §15 viewer-restriction decider, shipped and canonical — re-implementing it " +
    "would fork an authorization rule and put Telegraph in breach of census-trust A17",
};

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.ts$/.test(name)) out.push(p);
  }
  return out;
}

const problems: string[] = [];

// 1. All eight subdirectories exist and are non-empty.
for (const d of REQUIRED_DIRS) {
  const p = join(DOMAIN, d);
  if (!existsSync(p)) {
    problems.push(`§23 names src/domain/telegraph/${d}/ and it does not exist.`);
    continue;
  }
  const files = walk(p);
  if (files.length === 0) {
    problems.push(
      `src/domain/telegraph/${d}/ is EMPTY. An empty directory is a promise of a boundary, ` +
        `not a boundary — remove it or put the thing it is for in it.`,
    );
  }
}

const domainFiles = walk(DOMAIN);

// 2. Every module is reached from outside the package.
const outsideRoots = ["src/routes", "src/middlewares", "src/lib", "src/scripts", "src/test", "src/services"];
const outsideFiles: string[] = [];
for (const r of outsideRoots) outsideFiles.push(...walk(resolve(PKG_ROOT, r)));
const outsideSources = outsideFiles
  .filter((f) => !f.startsWith(DOMAIN))
  .map((f) => readFileSync(f, "utf8"));

for (const f of domainFiles) {
  const rel = relative(PKG_ROOT, f).replace(/\.ts$/, "");
  const moduleName = rel.split("/").pop()!;
  const reached = outsideSources.some(
    (src) => src.includes(`domain/telegraph/`) && src.includes(moduleName),
  );
  if (!reached) {
    problems.push(
      `${relative(PKG_ROOT, f)} is imported by nothing outside the domain package. ` +
        `A domain module nobody reaches is dead architecture.`,
    );
  }
}

// 3 and 4. Import discipline.
const IMPORT_RE = /from\s+["']([^"']+)["']/g;
for (const f of domainFiles) {
  const src = readFileSync(f, "utf8");
  const here = relative(PKG_ROOT, f);
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[1];
    if (!spec.startsWith(".")) continue; // node builtins and packages are fine
    const resolved = relative(PKG_ROOT, resolve(dirname(f), spec)).replace(/\.js$/, "");
    if (resolved.startsWith("src/routes/")) {
      problems.push(
        `${here} imports ${resolved}. A domain module reaching back into a route inverts the ` +
          `dependency §23 describes.`,
      );
      continue;
    }
    if (resolved.startsWith("src/services/")) {
      const key = resolved.replace(/^src\//, "");
      if (!(key in ALLOWED_SERVICE_IMPORTS)) {
        problems.push(
          `${here} imports ${resolved}, which is another domain's service. §23: "Trips, Buddy, ` +
            `Safety, Memories, Discovery and Compass remain integrations. Telegraph does not embed ` +
            `their canonical business logic." Telegraph may CALL an integration through a route; ` +
            `its domain package may not contain one. If this is a deliberate delegation to a shipped ` +
            `decider, add it to ALLOWED_SERVICE_IMPORTS with the reason.`,
        );
      }
    }
  }
}

// ── Report ────────────────────────────────────────────────────────────────────

const counts = REQUIRED_DIRS.map((d) => `${d}=${walk(join(DOMAIN, d)).length}`).join(" ");
console.log("Telegraph §23 package boundaries");
console.log("");
console.log(`  ${domainFiles.length} domain modules inspected across ${REQUIRED_DIRS.length} required subdirectories`);
console.log(`  ${counts}`);
console.log(
  `  ${Object.keys(ALLOWED_SERVICE_IMPORTS).length} named cross-service delegation(s) allowed, each with a stated reason`,
);
console.log("");

if (problems.length > 0) {
  console.error(`check:telegraph-package-boundaries FAILED — ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ✘ ${p}`);
  process.exit(1);
}

console.log("check:telegraph-package-boundaries PASSED");
console.log("  DOES NOT COVER §23's other two trees: src/features/telegraph/ is a client layout and");
console.log("  server/telegraph/ describes a package split this repository does not use — both are");
console.log("  recorded as unmet in the census rather than enforced by a permanently-red check.");
