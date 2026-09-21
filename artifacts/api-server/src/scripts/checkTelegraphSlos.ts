/**
 * check:telegraph-slos — Telegraph's §28 metrics and §30A.17 SLOs are defined,
 * emitted where they claim to be, ordered by severity the way the spec demands,
 * and the unmeasured set only shrinks. Also enforces §24's projection rule.
 *
 * ── WHAT WAS THERE BEFORE ───────────────────────────────────────────────────
 * Nothing. The census: "No metric is emitted for messaging and no target
 * constant exists… Telegraph has no telemetry sink at all. Nothing in §28 or
 * §30A.17 has anywhere to land." And one level worse than absent — the realtime
 * bus ALREADY counted everything it swallowed, and nothing read those counters
 * except a test, so a realtime outage was a number nobody could reach.
 *
 * ── THE SIX RULES ───────────────────────────────────────────────────────────
 *
 * 1. COMPLETENESS. All nine §28 metrics and all eight §30A.17 SLOs are
 *    declared, with unique ids and unique metric keys. A duplicate metric key
 *    would mean two targets silently sharing one counter.
 *
 * 2. EVERY TARGET IS A NUMBER, OR SAYS WHY NOT. `unbounded` is allowed — the
 *    spec itself gives no number for "primary product outcome metric" — but it
 *    must carry the spec's own words in `intent`. An invented threshold would
 *    produce confident alerts about a line nobody drew, which is worse than no
 *    alert.
 *
 * 3. EMITTERS ARE REAL. Every module listed as an emitter must exist AND
 *    contain the metric key it claims to record. A declaration pointing at a
 *    file that records something else is the observability equivalent of a
 *    guard nobody runs.
 *
 * 4. NO ORPHAN EMISSIONS. Every `recordTelegraphMetric("…")` call in the tree
 *    must name a declared metric. A typo'd key is silently ignored at runtime by
 *    design, which is the right runtime behaviour and exactly why it has to be
 *    caught statically instead.
 *
 * 5. SAFETY AND PRIVACY ARE STRICTEST — enforced as an ORDERING over the
 *    targets, not as a label anyone can write. §30A.17's closing sentence is a
 *    constraint between rows, so it is checked between rows: no `delivery` or
 *    `product` SLO may have a latency budget tighter than the tightest
 *    safety/privacy one, or a violation budget looser.
 *
 * 6. THE UNMEASURED SET ONLY SHRINKS, pinned in
 *    TELEGRAPH_OBSERVABILITY_BASELINE.json — and separately, §24's client
 *    BYPASS count only shrinks. That second one is the rule that decays
 *    silently: one convenient PostgREST call from a new screen, and nothing
 *    notices.
 *
 * Exit codes: 0 pass, 1 violation. Static — no database, runs on every push.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { TELEGRAPH_SLOS } from "../domain/telegraph/services/telegraphObservability.js";
import {
  TELEGRAPH_PROJECTIONS,
  TELEGRAPH_PROJECTION_BYPASSES,
} from "../domain/telegraph/projections/projectionRegistry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "../..");
const REPO_ROOT = resolve(PKG_ROOT, "../..");
const BASELINE_PATH = resolve(__dirname, "TELEGRAPH_OBSERVABILITY_BASELINE.json");

const problems: string[] = [];

// ── 1. Completeness ───────────────────────────────────────────────────────────

const s28 = TELEGRAPH_SLOS.filter((s) => s.specSection === "28");
const s30a = TELEGRAPH_SLOS.filter((s) => s.specSection === "30A.17");
if (s28.length !== 9) {
  problems.push(`§28 declares ${s28.length} metrics; the spec's table has 9.`);
}
if (s30a.length !== 8) {
  problems.push(`§30A.17 declares ${s30a.length} SLOs; the clause names 8 operations.`);
}
const ids = TELEGRAPH_SLOS.map((s) => s.id);
if (new Set(ids).size !== ids.length) problems.push(`duplicate SLO ids: ${ids.join(", ")}`);
const keys = TELEGRAPH_SLOS.map((s) => s.metric);
if (new Set(keys).size !== keys.length) {
  problems.push(
    `duplicate metric keys: ${keys.join(", ")} — two targets sharing one counter is ` +
      `a dashboard that is wrong in the one way nobody checks.`,
  );
}

// ── 2. Every target is a number, or says why not ─────────────────────────────

for (const s of TELEGRAPH_SLOS) {
  if (s.target.kind === "unbounded") {
    if (!s.target.intent || s.target.intent.length < 10) {
      problems.push(
        `${s.id}: an unbounded target must carry the spec's own intent wording. ` +
          `A target with neither a number nor a reason is not a target.`,
      );
    }
  }
  if (!s.note || s.note.length < 80) {
    problems.push(`${s.id}: note is ${s.note?.length ?? 0} chars — say what is counted and what the gap is.`);
  }
}

// ── 3. Emitters are real ──────────────────────────────────────────────────────

for (const s of TELEGRAPH_SLOS) {
  if (s.status !== "unmeasurable" && s.emitters.length === 0) {
    problems.push(
      `${s.id} is declared ${s.status} but names no emitter. A metric nothing records ` +
        `is unmeasurable, whatever it is labelled.`,
    );
  }
  for (const e of s.emitters) {
    const p = resolve(PKG_ROOT, e);
    if (!existsSync(p)) {
      problems.push(`${s.id}: emitter "${e}" does not exist.`);
      continue;
    }
    const src = readFileSync(p, "utf8");
    if (!src.includes(s.metric)) {
      problems.push(
        `${s.id}: emitter "${e}" never names the metric "${s.metric}". ` +
          `A declaration pointing at a file that records something else is worse than none.`,
      );
    }
  }
}

// ── 4. No orphan emissions ────────────────────────────────────────────────────

const SCAN_DIRS = [resolve(PKG_ROOT, "src")];
const SKIP = ["node_modules", "/test/", ".test.", "__tests__"];

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const rel = p.replace(/\\/g, "/");
    if (SKIP.some((sk) => rel.includes(sk))) continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const declaredKeys = new Set(TELEGRAPH_SLOS.map((s) => s.metric));
const CALL_RE = /recordTelegraphMetric\(\s*["']([A-Za-z0-9_]+)["']/g;
let emissionSites = 0;
let filesScanned = 0;
for (const file of walk(SCAN_DIRS[0])) {
  filesScanned++;
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(CALL_RE)) {
    emissionSites++;
    if (!declaredKeys.has(m[1])) {
      problems.push(
        `ORPHAN EMISSION: ${relative(REPO_ROOT, file)} records "${m[1]}", which no SLO declares. ` +
          `The recorder ignores unknown keys at runtime by design, so this is the only place it can be caught.`,
      );
    }
  }
}

// ── 5. Safety and privacy are strictest ───────────────────────────────────────

const strict = TELEGRAPH_SLOS.filter((s) => s.severity === "safety" || s.severity === "privacy");
const relaxed = TELEGRAPH_SLOS.filter((s) => s.severity === "delivery" || s.severity === "product");

const latencyOf = (s: (typeof TELEGRAPH_SLOS)[number]): number | null =>
  s.target.kind === "latency" ? s.target.maxMs : null;
const countOf = (s: (typeof TELEGRAPH_SLOS)[number]): number | null =>
  s.target.kind === "count" ? s.target.max : null;

const strictestLatency = Math.min(
  ...strict.map(latencyOf).filter((n): n is number => n !== null),
  Number.POSITIVE_INFINITY,
);
for (const s of relaxed) {
  const l = latencyOf(s);
  if (l !== null && l < strictestLatency) {
    problems.push(
      `${s.id} (${s.severity}) has a latency budget of ${l}ms, tighter than the tightest ` +
        `safety/privacy budget (${strictestLatency}ms). §30A.17: "Safety/privacy operations ` +
        `receive the strictest requirements" — that is an ordering between rows, not a label.`,
    );
  }
}
const loosestStrictCount = Math.max(
  ...strict.map(countOf).filter((n): n is number => n !== null),
  Number.NEGATIVE_INFINITY,
);
for (const s of relaxed) {
  const c = countOf(s);
  if (c !== null && Number.isFinite(loosestStrictCount) && c < loosestStrictCount) {
    problems.push(
      `${s.id} (${s.severity}) allows ${c} violations, fewer than the most permissive ` +
        `safety/privacy budget (${loosestStrictCount}). Same ordering rule, other direction.`,
    );
  }
}

// ── 6. Ratchets ───────────────────────────────────────────────────────────────

const unmeasured = TELEGRAPH_SLOS.filter((s) => s.status !== "measured").length;
const absentProjections = TELEGRAPH_PROJECTIONS.filter((p) => p.status === "absent").length;

/** Re-derive the §24 bypasses from the client tree rather than trusting the registry. */
const MESSAGING_TABLES = [
  "message_thread_members",
  "message_threads",
  "messages",
  "message_requests",
  "message_translations",
  "saved_messages",
];
const CLIENT_DIRS = [
  resolve(REPO_ROOT, "travel-buddy-standalone/src"),
  resolve(REPO_ROOT, "travel-buddy-standalone/app"),
];
const bypassSites: string[] = [];
for (const dir of CLIENT_DIRS) {
  for (const file of walk(dir)) {
    const src = readFileSync(file, "utf8");
    for (const table of MESSAGING_TABLES) {
      const re = new RegExp(`\\.from\\(\\s*["']${table}["']`, "g");
      const hits = src.match(re);
      if (hits) {
        for (let i = 0; i < hits.length; i++) bypassSites.push(`${relative(REPO_ROOT, file)}:${table}`);
      }
    }
  }
}

let baseline: { unmeasuredSlos: number; absentProjections: number; clientBypassSites: number } | null = null;
if (!existsSync(BASELINE_PATH)) {
  problems.push(`TELEGRAPH_OBSERVABILITY_BASELINE.json is missing — the ratchets cannot be applied.`);
} else {
  baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")).counts;
  const checks: Array<[string, number, number, string]> = [
    ["unmeasured SLOs", unmeasured, baseline!.unmeasuredSlos,
      "a metric may not stop being measured"],
    ["absent §24 projections", absentProjections, baseline!.absentProjections,
      "a projection may not be removed"],
    ["§24 client bypass sites", bypassSites.length, baseline!.clientBypassSites,
      "a new client-side join of a raw messaging table is exactly what §24's closing rule forbids"],
  ];
  for (const [label, now, was, why] of checks) {
    if (now > was) {
      problems.push(`RATCHET VIOLATED — ${label}: ${now}, baseline ${was}. ${why}.`);
    } else if (now < was) {
      problems.push(
        `${label}: ${now}, baseline ${was}. Something IMPROVED — lower the baseline in the ` +
          `same commit so the gain cannot be given back silently.`,
      );
    }
  }
}

// Registry honesty: every re-derived bypass file must be named in the registry.
const registryFiles = new Set(TELEGRAPH_PROJECTION_BYPASSES.map((b) => `${b.file}:${b.table}`));
for (const site of new Set(bypassSites)) {
  if (!registryFiles.has(site)) {
    problems.push(
      `UNDECLARED §24 BYPASS: ${site}. A client read of a raw messaging table must be named in ` +
        `TELEGRAPH_PROJECTION_BYPASSES with what it is doing and which projection should carry it.`,
    );
  }
}
for (const site of registryFiles) {
  if (!bypassSites.includes(site)) {
    problems.push(`STALE §24 BYPASS declaration: ${site} no longer reads that table. Remove it.`);
  }
}

// ── Report ────────────────────────────────────────────────────────────────────

const byStatus: Record<string, number> = {};
for (const s of TELEGRAPH_SLOS) byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;

console.log("Telegraph §28 / §30A.17 observability and §24 projections");
console.log("");
console.log(
  `  ${TELEGRAPH_SLOS.length} SLOs inspected across ${filesScanned} source file(s) ` +
    `(${s28.length} from §28, ${s30a.length} from §30A.17)`,
);
console.log(`  status: ${Object.entries(byStatus).sort().map(([k, v]) => `${k}=${v}`).join(" ")}`);
console.log(`  ${emissionSites} emission site(s) in non-test code, all naming declared metrics`);
console.log(
  `  §24: ${TELEGRAPH_PROJECTIONS.length} projections (${absentProjections} absent), ` +
    `${bypassSites.length} client bypass site(s) across ${new Set(bypassSites).size} file/table pair(s)`,
);
console.log("");

if (problems.length > 0) {
  console.error(`check:telegraph-slos FAILED — ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ✘ ${p}`);
  process.exit(1);
}

console.log("check:telegraph-slos PASSED");
console.log("  DOES NOT COVER: whether a target is the RIGHT number — that is a product decision,");
console.log("  and this enforces that one exists, that something records it, and that safety and");
console.log("  privacy are strictest. The counters themselves are in-process and reset on restart;");
console.log("  no durable sink and no alerting exist, and neither is claimed.");
