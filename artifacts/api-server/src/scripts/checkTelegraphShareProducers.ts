/**
 * check:telegraph-share-producers — every Telegraph message type is declared,
 * and a private-by-default domain cannot be declared its way out of the share
 * authorization policy.
 *
 * ── THE DEFECT CLASS ────────────────────────────────────────────────────────
 * Telegraph has no share contract (census T35/T41): four producers each build
 * their own JSON and post it as a message with a bespoke `subtype`. Nothing
 * asks whether the object behind the card may be shared at all, and nothing
 * records what the card points at. The census scored three requirements in this
 * area as UNGUARDED ABSENCES — "no Memory share path exists, so the case cannot
 * arise and nothing guards it" — which is a guarantee that lasts exactly until
 * the fifth producer.
 *
 * ── WHAT IS CHECKED ─────────────────────────────────────────────────────────
 * 1. REGISTRATION. Every string literal assigned to `msg_type` or `subtype` in
 *    either tree must be declared in TELEGRAPH_SHARE_PRODUCERS
 *    (src/domain/telegraph/policies/shareAuthorizationPolicy.ts) with an object
 *    family. A new card type turns this red until somebody classifies it — the
 *    classification is one line, and the point is that it cannot be skipped.
 *
 * 2. NO ORPHAN DECLARATIONS. A declared literal that no longer appears in
 *    either tree fails too, so the registry cannot rot into a list of things
 *    that used to exist. It shrinks when the tree shrinks.
 *
 * 3. THE PRIVATE-DOMAIN RULE — the one with teeth. A producer whose
 *    `sourceDomain` is private-by-default (memories, memory_notes, safe_return,
 *    location, safety, private_trips) may ONLY be declared PRIVATE_SOURCE.
 *    Without this, the registration rule is satisfiable by declaring a Memory
 *    card `PUBLIC` and walking straight past the policy: the checker cannot read
 *    intent, so it does not try to. What it does instead is make the only
 *    classification CI will accept for those domains the one that requires a
 *    derivative grant.
 *
 * 4. PRIVATE_SOURCE PRODUCERS ROUTE THROUGH THE POLICY. Any producer declared
 *    PRIVATE_SOURCE must name an `authorizedBy` module, that module must exist,
 *    and it must actually call `authorizeTelegraphShare`. A declaration that
 *    points at a file which does not perform the check is worse than none,
 *    because it reads as protection.
 *
 * ── WHAT IT DOES NOT CLOSE, stated plainly ─────────────────────────────────
 * A producer for a domain NOT on the private-by-default list can still be
 * misclassified by someone who means to. The remedy is to add the domain to
 * that list, and the list lives beside the policy so the two are read together.
 * This narrows the hole to "a new private domain nobody has named yet"; it does
 * not claim to have closed it.
 *
 * Exit codes: 0 pass, 1 violation. Static — no database, runs on every push.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  TELEGRAPH_SHARE_PRODUCERS,
  TELEGRAPH_DYNAMIC_SHARE_PRODUCERS,
  FAMILIES_REQUIRING_POLICY,
  PRIVATE_BY_DEFAULT_DOMAINS,
  type ShareProducerDeclaration,
} from "../domain/telegraph/policies/shareAuthorizationPolicy.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "../..");
const REPO_ROOT = resolve(PKG_ROOT, "../..");

/**
 * Where a message type literal can be written.
 *
 * Test files are excluded: a suite naming a subtype is exercising a producer,
 * not being one, and including them would make the registry a list of every
 * fixture anybody has ever written.
 */
const SCAN_DIRS = [
  resolve(PKG_ROOT, "src/routes"),
  resolve(PKG_ROOT, "src/services"),
  resolve(PKG_ROOT, "src/lib"),
  resolve(REPO_ROOT, "travel-buddy-standalone/src"),
  resolve(REPO_ROOT, "travel-buddy-standalone/app"),
];

const SKIP_SEGMENTS = ["__tests__", "node_modules", "/test/", ".test.", ".spec."];

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const rel = p.replace(/\\/g, "/");
    if (SKIP_SEGMENTS.some((s) => rel.includes(s))) continue;
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

/** `msg_type: "x"`, `subtype: 'x'`, `msg_type="x"`, `subtype='x'`. */
const LITERAL_RE = /\b(msg_type|subtype)\s*[:=]\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g;

/**
 * An assignment whose value is NOT a string literal — a template, a variable, a
 * ternary. Invisible to LITERAL_RE, and therefore the shape that would make this
 * registry read as complete while missing producers. Measured: the call history
 * writer builds `call_${session.status}`, and the send route takes `subtype`
 * from the request body.
 */
const DYNAMIC_RE = /\b(msg_type|subtype)\s*\??:\s*([^,\n}]+)/g;

interface Found {
  literal: string;
  column: "msg_type" | "subtype";
  sites: string[];
}

const found = new Map<string, Found>();
const dynamicSites = new Map<string, string[]>();
let filesScanned = 0;

for (const dir of SCAN_DIRS) {
  for (const file of walk(dir)) {
    filesScanned++;
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(DYNAMIC_RE)) {
      const value = (m[2] ?? "").trim();
      // A quoted value is a literal and LITERAL_RE already has it. The
      // distinction has to be made on the CAPTURED value rather than by a
      // lookahead: a lookahead backtracks over the whitespace and reports every
      // literal as dynamic. Measured — that is exactly what the first version
      // of this rule did, on eighteen files.
      if (/^["'`]?["']/.test(value) || /^["']/.test(value)) continue;
      // A TYPE annotation is not a producer: `subtype?: string | null` in an
      // interface declares a field and writes nothing.
      if (/^(string|boolean|number|null|any|unknown)\b/.test(value)) continue;
      const expr = `${m[1]}: ${value}`;
      const site = relative(REPO_ROOT, file);
      const list = dynamicSites.get(site) ?? [];
      if (!list.includes(expr)) list.push(expr);
      dynamicSites.set(site, list);
    }
    for (const m of src.matchAll(LITERAL_RE)) {
      const column = m[1] as "msg_type" | "subtype";
      const literal = m[2];
      const key = `${column}:${literal}`;
      const site = relative(REPO_ROOT, file);
      const existing = found.get(key);
      if (existing) {
        if (!existing.sites.includes(site)) existing.sites.push(site);
      } else {
        found.set(key, { literal, column, sites: [site] });
      }
    }
  }
}

const declared = new Map<string, ShareProducerDeclaration>();
for (const d of TELEGRAPH_SHARE_PRODUCERS) declared.set(`${d.column}:${d.literal}`, d);

const problems: string[] = [];

// 1. Registration.
for (const [key, f] of found) {
  if (!declared.has(key)) {
    problems.push(
      `UNREGISTERED message type: ${f.column} = "${f.literal}" (written at ${f.sites.join(", ")}).\n` +
        `      Declare it in TELEGRAPH_SHARE_PRODUCERS with an object family. If it points at a\n` +
        `      private canonical object, the family is PRIVATE_SOURCE and it must route through\n` +
        `      authorizeTelegraphShare.`,
    );
  }
}

// 1b. Dynamic sites must be declared.
const declaredDynamicFiles = new Set(TELEGRAPH_DYNAMIC_SHARE_PRODUCERS.map((d) => d.file));
for (const [site, exprs] of dynamicSites) {
  if (!declaredDynamicFiles.has(site)) {
    problems.push(
      `UNDECLARED DYNAMIC message type in ${site}: ${exprs.join(" | ")}\n` +
        `      A computed msg_type/subtype is invisible to a literal scan, so it must be declared\n` +
        `      in TELEGRAPH_DYNAMIC_SHARE_PRODUCERS with the values it can produce. A registry that\n` +
        `      silently misses producers is worth less than none — it reads as complete.`,
    );
  }
}
for (const d of TELEGRAPH_DYNAMIC_SHARE_PRODUCERS) {
  if (!dynamicSites.has(d.file)) {
    problems.push(
      `STALE DYNAMIC declaration: ${d.file} no longer contains a computed msg_type/subtype. ` +
        `Remove it, or it becomes a record of a hazard that is gone.`,
    );
  }
}

// Values a declared dynamic producer can emit are registered by that declaration.
const dynamicallyProduced = new Set<string>();
for (const d of TELEGRAPH_DYNAMIC_SHARE_PRODUCERS) for (const v of d.produces) dynamicallyProduced.add(v);

// 2. No orphan declarations.
for (const [key, d] of declared) {
  if (!found.has(key) && !dynamicallyProduced.has(d.literal)) {
    problems.push(
      `ORPHAN declaration: ${d.column} = "${d.literal}" is declared but appears nowhere in the ` +
        `scanned trees. Remove it, or the registry becomes a list of things that used to exist.`,
    );
  }
}

// 3. The private-domain rule.
for (const d of TELEGRAPH_SHARE_PRODUCERS) {
  if (d.sourceDomain && PRIVATE_BY_DEFAULT_DOMAINS.includes(d.sourceDomain) && d.family !== "PRIVATE_SOURCE") {
    problems.push(
      `MISCLASSIFIED: "${d.literal}" names the private-by-default domain "${d.sourceDomain}" but is ` +
        `declared ${d.family}. The only family CI accepts for that domain is PRIVATE_SOURCE, which ` +
        `requires a derivative grant from the owning domain.`,
    );
  }
}

// 4. PRIVATE_SOURCE producers route through the policy.
for (const d of TELEGRAPH_SHARE_PRODUCERS) {
  if (!FAMILIES_REQUIRING_POLICY.includes(d.family)) continue;
  if (!d.authorizedBy) {
    problems.push(
      `"${d.literal}" is ${d.family} but names no authorizedBy module. A private-source share must ` +
        `say where it is authorized.`,
    );
    continue;
  }
  const modulePath = resolve(PKG_ROOT, d.authorizedBy);
  if (!existsSync(modulePath)) {
    problems.push(`"${d.literal}" names authorizedBy "${d.authorizedBy}", which does not exist.`);
    continue;
  }
  const src = readFileSync(modulePath, "utf8");
  if (!src.includes("authorizeTelegraphShare")) {
    problems.push(
      `"${d.literal}" names authorizedBy "${d.authorizedBy}", which never calls ` +
        `authorizeTelegraphShare. A declaration that points at a file performing no check is ` +
        `worse than none — it reads as protection.`,
    );
  }
}

// ── Report ────────────────────────────────────────────────────────────────────

const byFamily: Record<string, number> = {};
for (const d of TELEGRAPH_SHARE_PRODUCERS) byFamily[d.family] = (byFamily[d.family] ?? 0) + 1;

console.log("Telegraph share producers");
console.log("");
console.log(`  ${filesScanned} file(s) scanned across ${SCAN_DIRS.length} roots`);
console.log(`  ${found.size} message type literal(s) found, ${declared.size} declared`);
console.log(
  `  ${dynamicSites.size} file(s) compute a message type; ${TELEGRAPH_DYNAMIC_SHARE_PRODUCERS.length} declared, ` +
    `covering ${dynamicallyProduced.size} further value(s)`,
);
console.log(
  `  families: ${Object.entries(byFamily).sort().map(([k, v]) => `${k}=${v}`).join(" ")}`,
);
console.log(
  `  PRIVATE_SOURCE producers: ${byFamily["PRIVATE_SOURCE"] ?? 0} — ` +
    `${(byFamily["PRIVATE_SOURCE"] ?? 0) === 0
      ? "no producer shares a private canonical object, which is the finding, not an omission"
      : "each must route through authorizeTelegraphShare"}`,
);
console.log("");

if (problems.length > 0) {
  console.error(`check:telegraph-share-producers FAILED — ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ✘ ${p}`);
  process.exit(1);
}

console.log("check:telegraph-share-producers PASSED");
console.log(
  "  Enforces registration, orphan removal, the private-by-default family rule and the policy",
);
console.log(
  "  call for private-source producers. Does NOT stop a deliberate misclassification for a",
);
console.log(
  "  domain nobody has added to PRIVATE_BY_DEFAULT_DOMAINS — adding it there is the remedy.",
);
