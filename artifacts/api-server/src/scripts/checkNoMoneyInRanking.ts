/**
 * check:no-money-in-ranking — the non-goals of
 * docs/architecture/08_Portava_Revenue_Model.md §6, held by the build.
 *
 * ── WHAT IT PINS ─────────────────────────────────────────────────────────────
 * `08` §6.1 "Ranking is never purchasable", `09` §3 refusal 3 "No revenue signal
 * enters the ranker" and `09` §10 "No money field belongs in a graph node, a
 * feed payload, or a ranking feature vector" all held on the day they were
 * written, and they held BY ABSENCE: nobody had written the line yet. An
 * absence is not an enforcement. The first payment table, the first commission
 * column, the first "sort buddies by price" ticket would each have been one
 * import away from the ranker with nothing to say no.
 *
 * So this check reads the files that rank, build a ranking feature vector,
 * build a graph node or build a feed payload, and fails when a MONEY IDENTIFIER
 * appears in one of them: a variable, a property, a column named in a
 * `.select("…")` string or a table named in a `.from("…")`. Comments are
 * stripped first, so prose quoting the rule cannot trip it.
 *
 * ── WHAT COUNTS AS A MONEY IDENTIFIER ────────────────────────────────────────
 * An identifier is split into words (`hourly_rate_usd`, `platformFeePercent`,
 * `PAYOUT_TOTAL` -> lowercase words) and matched whole-word against
 * MONEY_WORDS, or as consecutive words against MONEY_PHRASES. Whole words, not
 * substrings: `feed` is not `fee`, `learning` is not `earning`, `tooltip` is not
 * `tip`, `cache` is not `cash`. Three families:
 *
 *   1. money amounts and instruments — price, fee, earnings, payout,
 *      commission, revenue, tip, deposit, refund, payment, cash, usd, currency…
 *      and the phrases a bare word would be too noisy for (`hourly rate`,
 *      `take rate`, `amount minor`, `creator share`);
 *   2. paid placement — sponsor(ed), promoted, advertis*, bid, cpm, cpc
 *      (`08` §6.2: there is no ad surface, and none may be built into ranking);
 *   3. paid plans — purchase, subscription, entitlement (`08` §6.3: nothing a
 *      viewer is shown may be gated on what they pay).
 *
 * DELIBERATELY NOT MONEY WORDS, each because it already means something else in
 * these files and that meaning is not a payment to Portava:
 *   `rate` alone  — an engagement rate (watchCompletionRate, recent_rate).
 *   `budget`      — the exploration governor's page budget, and the viewer's
 *                   own budget STYLE, a taste the viewer stated.
 *   `boost`, `featured` — editorial and behavioural multipliers. Featured is
 *                   admin-only and its flags are seeded false (`08` §6.1); the
 *                   day `featured` is SOLD it becomes paid placement, and that
 *                   is a product decision this scan cannot see.
 *   `tier`, `premium`, `cost`, `earned`, `reward` — confidence tiers, a taste
 *                   tag, exploration costs, stamps earned, non-cash rewards.
 *
 * ── THE ALLOWLIST IS EXPLICIT, JUSTIFIED AND CANNOT ROT ──────────────────────
 * A money identifier that belongs where it is — today, only identifiers that
 * ENFORCE a non-goal — is named in ALLOWLIST by file and exact identifier,
 * with the reason. An entry that matches nothing is STALE and fails: an
 * allowlist that only grows stops describing the tree.
 *
 * ── IT CANNOT QUIETLY STOP LOOKING ───────────────────────────────────────────
 *   * every SCOPE entry must match at least one file — a renamed ranker fails
 *     here instead of silently leaving the scan;
 *   * every file under lib/, services/ or compass/ whose NAME says rank or
 *     graph must be in SCOPE or in OUT_OF_SCOPE with a reason, so a new ranker
 *     or graph builder cannot arrive unexamined;
 *   * the success line carries the number of files scanned, and
 *     check:guard-reachability reads it: zero fails.
 *
 * ── WHAT IT DOES NOT COVER ───────────────────────────────────────────────────
 * It reads NAMES, not data flow. A money value fetched in a route and handed to
 * the ranker under a neutral name (`weight`, `score`) is invisible to it; so is
 * a database view or function that folds a price into a column called
 * `quality`. Route files are out of scope: they assemble responses and many
 * legitimately carry prices (the Rent-a-Buddy routes). It does not decide
 * whether an allowlisted reader is RIGHT — that judgment is a human's and is
 * recorded next to the entry.
 *
 * No database, no network. Exit 0 = clean; 1 = a finding, a stale or
 * unjustified allowlist entry, an unclassified file or an empty scope entry;
 * 2 = the source tree could not be read.
 *
 * Usage (from artifacts/api-server):
 *   pnpm run check:no-money-in-ranking
 * Test seam: NO_MONEY_IN_RANKING_SRC points the scan at another `src` root. It
 * exists so src/test/noMoneyInRankingCheck.test.ts can prove each rule fires;
 * nothing in CI sets it.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./lib/stripComments.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const REAL_SRC = resolve(__dir, "..");

// ── vocabulary ────────────────────────────────────────────────────────────────

export const MONEY_WORDS: ReadonlySet<string> = new Set([
  // 1. amounts and instruments
  "price", "prices", "priced", "pricing",
  "fee", "fees",
  "earning", "earnings",
  "payout", "payouts",
  "commission", "commissions",
  "revenue", "revenues",
  "tip", "tips", "tipped", "tipping",
  "deposit", "deposits",
  "refund", "refunds", "refunded",
  "payment", "payments", "paid", "unpaid", "payable",
  "cash", "usd", "currency",
  "wallet", "invoice", "invoices", "billing", "billed",
  "chargeback", "chargebacks",
  "monetise", "monetize", "monetisation", "monetization",
  // 2. paid placement
  "sponsor", "sponsors", "sponsored", "sponsorship",
  "promoted",
  "advertiser", "advertisers", "advertising", "advertisement", "advertisements",
  "bid", "bids", "cpm", "cpc",
  // 3. paid plans
  "purchase", "purchases", "purchased",
  "subscription", "subscriptions",
  "entitlement", "entitlements",
]);

/** Consecutive words that are money together though neither is alone. */
export const MONEY_PHRASES: readonly (readonly string[])[] = [
  ["hourly", "rate"], ["day", "rate"], ["nightlife", "rate"], ["arrival", "rate"],
  ["take", "rate"],
  ["amount", "minor"], ["amount", "cents"],
  ["creator", "share"],
];

// ── scope ─────────────────────────────────────────────────────────────────────

export type ScopeGroup = "ranker" | "feature-vector" | "graph" | "feed-payload";

export interface ScopeEntry {
  /** Relative to src/. A file, a directory (walked), or a path PREFIX ending in `*`. */
  path: string;
  group: ScopeGroup;
  /** Why this is one of the things `08` §6 / `09` §10 are about. */
  why: string;
}

export const SCOPE: readonly ScopeEntry[] = [
  // ── the central ranker and everything that hands it a candidate or a term ──
  { path: "lib/portavaRank.ts", group: "ranker", why: "the central ranker: scoreCandidate and DEFAULT_WEIGHTS (`06`)" },
  { path: "lib/discoveryPde.ts", group: "ranker", why: "the Discovery serve path, and the impression feature vector it records (`06`)" },
  { path: "lib/discoveryModifiers.ts", group: "ranker", why: "the per-request modifier inputs handed to portavaRank (`06`)" },
  { path: "lib/discoveryRank*", group: "ranker", why: "rank designs, objectives, diversity, intent, trip terms, integrity, provenance and flags" },
  { path: "lib/discoverySurfaceObjectiveRank.ts", group: "ranker", why: "the per-surface objective ranking" },
  { path: "lib/discoveryLiveRank*", group: "ranker", why: "the live ranked read" },
  { path: "lib/discoveryLocalMomentum.ts", group: "ranker", why: "the capped local-momentum term (`03`, `06`)" },
  { path: "lib/discoveryTrailAffinity.ts", group: "ranker", why: "the trail-affinity term" },
  { path: "lib/discoveryTrend*", group: "ranker", why: "Trending: a ranked list of places (`03`)" },
  { path: "lib/discoveryCandidate.ts", group: "ranker", why: "the candidate shape the ranker scores" },
  { path: "lib/discoveryCandidates", group: "ranker", why: "candidate sources, stages, retrievals, exploration inventory and outcome learning" },
  { path: "lib/mapDiscoveryCandidates.ts", group: "ranker", why: "the map's candidate source" },
  { path: "lib/rankingFatigueSweeper.ts", group: "ranker", why: "maintains the fatigue rows the ranker reads" },
  { path: "lib/inputAssistance/rankingSignals.ts", group: "ranker", why: "orders typeahead suggestions; a paid signal here would be paid typeahead placement" },
  { path: "services/ranking", group: "ranker", why: "DiscoveryRankingService, MediaFeedRankingService, the slot allocator, eligibility, creator caps, ranking config" },
  { path: "services/wall", group: "ranker", why: "the Wall's ranker, candidate loaders, diversity and insertion" },
  { path: "services/media/MediaRankingService.ts", group: "ranker", why: "the World shell's media ranker (§24 Media Ranking stage)" },
  { path: "services/media/WatchStage24Ranking.ts", group: "ranker", why: "the Watch feed ordered by the §24 stage" },
  { path: "services/highlights/highlightRanking.ts", group: "ranker", why: "the Highlights ranking" },
  { path: "services/airport/layoverRankingFeasibility.ts", group: "ranker", why: "the feasibility state a Layover candidate carries into ranking" },
  { path: "compass/CompassRecommendationEngine.ts", group: "ranker", why: "Compass's two scores, Community Score and Compass Match (`08` §6.1)" },
  // ── feature vectors: what the ranker is fed, and what is stored as its input ──
  { path: "lib/discoverySequenceFeatures.ts", group: "feature-vector", why: "sequence features of the viewer's session" },
  { path: "lib/mediaRankingSignals.ts", group: "feature-vector", why: "the media ranking signal vector" },
  { path: "lib/rankLog.ts", group: "feature-vector", why: "writes rank_events: the stored feature vector of every impression" },
  { path: "lib/rankEventsProvenance.ts", group: "feature-vector", why: "provenance attached to each stored feature vector" },
  { path: "compass/CompassFeedbackEngine.ts", group: "feature-vector", why: "writes the viewer's category weights, which Compass Match reads" },
  // ── graph builders ────────────────────────────────────────────────────────────
  { path: "compass/CompassGraphEngine.ts", group: "graph", why: "buildGraphFromSources: every node and edge of the intelligence graph (`05`)" },
  { path: "lib/intelligenceGraphScheduler.ts", group: "graph", why: "schedules the graph rebuild" },
  { path: "lib/discoveryPlatformGraphProvenance.ts", group: "graph", why: "what Discovery reads from the graph, and its provenance" },
  { path: "services/memoryProjections/memoryGraph.ts", group: "graph", why: "the memory graph projection" },
  { path: "services/passport/PassportExperienceGraphService.ts", group: "graph", why: "the Passport experience graph" },
  // ── feed payloads ─────────────────────────────────────────────────────────────
  { path: "compass/CompassFrontLoadEngine.ts", group: "feed-payload", why: "the Compass front-load payload; PAY-074 removed a buddy's list price from its top_buddies item" },
  { path: "compass/CompassFeedBuilder.ts", group: "feed-payload", why: "the Compass feed" },
  { path: "compass/CompassFallbackFeedBuilder.ts", group: "feed-payload", why: "the Compass fallback feed" },
  { path: "lib/feedReads.ts", group: "feed-payload", why: "shared feed reads" },
  { path: "lib/mediaFeedItem.ts", group: "feed-payload", why: "the media feed item shape" },
  { path: "lib/mediaFeedReads.ts", group: "feed-payload", why: "media feed reads" },
  { path: "lib/wallProjection.ts", group: "feed-payload", why: "the Wall card projection: truth class and disclosure label" },
];

/** Files whose NAME says rank or graph and which are deliberately not scanned. */
export const OUT_OF_SCOPE: readonly { file: string; why: string }[] = [
  {
    file: "lib/deletion/graph.ts",
    why: "the account-deletion table graph: foreign-key reachability between tables, not the intelligence graph. It must be able to name money tables in order to delete from them.",
  },
];

// ── allowlist ─────────────────────────────────────────────────────────────────

export interface AllowEntry {
  /** Relative to src/. */
  file: string;
  /** The identifier exactly as written in the file. */
  identifier: string;
  why: string;
}

export const ALLOWLIST: readonly AllowEntry[] = [
  {
    file: "compass/CompassFeedbackEngine.ts",
    identifier: "paid",
    why: "the `paid` taste CATEGORY (free versus paid activities). The viewer's own `too_expensive` feedback lowers its weight: a preference the viewer stated, never a payment to Portava, and it can only move the weight down.",
  },
  {
    file: "lib/wallProjection.ts",
    identifier: "sponsored",
    why: "the disclosure source class. Reading it DOWNGRADES a claim to the `inferred` truth class and labels the card (`08` §6.1: a disclosed commercial relationship downgrades epistemic standing, it does not buy it). This is the enforcement, not a boost.",
  },
  {
    file: "lib/wallProjection.ts",
    identifier: "Sponsored",
    why: "the viewer-facing label promotionLabelFor returns for the `sponsored` source class: the disclosure itself (`08` §6.2 — the only sponsored identifier is the penalty class, and the Wall says so on the card).",
  },
];

// ── the scan ──────────────────────────────────────────────────────────────────

/** `hourly_rate_usd`, `platformFeePercent`, `PAYOUT_TOTAL`, `h3Cell` -> lowercase words. */
export function wordsOf(identifier: string): string[] {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
}

/** The money word or phrase an identifier contains, or null. */
export function moneyTermIn(identifier: string): string | null {
  const words = wordsOf(identifier);
  for (const w of words) if (MONEY_WORDS.has(w)) return w;
  for (const phrase of MONEY_PHRASES) {
    for (let i = 0; i + phrase.length <= words.length; i++) {
      if (phrase.every((p, k) => words[i + k] === p)) return phrase.join(" ");
    }
  }
  return null;
}

export interface MoneyHit { identifier: string; line: number; term: string }

/** True when the kept part of a line ends inside a string literal: its quote characters do not pair up. */
function endsInsideString(kept: string): boolean {
  for (const q of ["'", '"', "`"]) {
    let n = 0;
    for (let i = 0; i < kept.length; i++) if (kept[i] === q && kept[i - 1] !== "\\") n++;
    if (n % 2 === 1) return true;
  }
  return false;
}

/**
 * The lines to scan. stripComments does not parse strings, so a `//` inside a
 * string literal (a URL) cuts the rest of that line — which could hide an
 * identifier from this check. Where the cut falls inside an open string, the
 * RAW line is scanned instead: that can only make the check louder.
 */
export function codeLines(source: string): string[] {
  const raw = source.split("\n");
  return stripComments(source).split("\n").map((kept, i) => {
    const original = raw[i] ?? "";
    return kept.length < original.length && endsInsideString(kept) ? original : kept;
  });
}

/** Every money identifier in a source text, comments excluded. String contents ARE scanned: that is where column and table names live. */
export function moneyIdentifiersIn(source: string): MoneyHit[] {
  const hits: MoneyHit[] = [];
  codeLines(source).forEach((line, i) => {
    for (const m of line.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
      const term = moneyTermIn(m[0]);
      if (term) hits.push({ identifier: m[0], line: i + 1, term });
    }
  });
  return hits;
}

function isSource(name: string): boolean {
  return name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts");
}

function walk(dir: string, out: string[]): string[] {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__tests__" || name === "test" || name === "node_modules") continue;
      walk(p, out);
    } else if (isSource(name)) {
      out.push(p);
    }
  }
  return out;
}

const posix = (p: string) => p.split("\\").join("/");

/** The files one scope entry names, relative to `src`. */
export function filesOf(src: string, entry: ScopeEntry): string[] {
  if (entry.path.endsWith("*")) {
    const prefix = entry.path.slice(0, -1);
    const dir = join(src, dirname(prefix));
    if (!existsSync(dir)) return [];
    const stem = basename(prefix);
    return readdirSync(dir).sort()
      .filter((n) => n.startsWith(stem) && isSource(n) && statSync(join(dir, n)).isFile())
      .map((n) => posix(join(dirname(prefix), n)));
  }
  const abs = join(src, entry.path);
  if (!existsSync(abs)) return [];
  if (statSync(abs).isDirectory()) return walk(abs, []).map((f) => posix(relative(src, f)));
  return isSource(basename(abs)) ? [posix(entry.path)] : [];
}

/** Directories in which a file NAMED like a ranker or a graph builder must be classified. */
const DISCOVERY_ROOTS = ["lib", "services", "compass"] as const;
const RANKING_NAME_WORDS: ReadonlySet<string> = new Set(["rank", "ranks", "ranked", "ranker", "ranking", "graph"]);

export function isRankingShapedName(file: string): boolean {
  return wordsOf(basename(file).replace(/\.ts$/, "")).some((w) => RANKING_NAME_WORDS.has(w));
}

export interface Config {
  scope: readonly ScopeEntry[];
  allowlist: readonly AllowEntry[];
  outOfScope: readonly { file: string; why: string }[];
}

export interface Finding { file: string; line: number; identifier: string; term: string; group: ScopeGroup }

export interface Result {
  /** Files scanned, with the group that put each in scope. */
  scanned: Map<string, ScopeGroup>;
  findings: Finding[];
  /** Hits the allowlist admitted, for the report. */
  allowed: Finding[];
  /** Scope entries that matched no file. */
  emptyScope: ScopeEntry[];
  /** Allowlist entries that matched no hit. */
  staleAllow: AllowEntry[];
  /** Allowlist / out-of-scope entries with no real reason. */
  unjustified: string[];
  /** Files named like a ranker or graph builder that nothing classifies. */
  unclassified: string[];
  /** OUT_OF_SCOPE entries naming a file that does not exist or is in scope anyway. */
  staleOutOfScope: string[];
}

const MIN_REASON = 40;

export function runCheck(src: string, config: Config = { scope: SCOPE, allowlist: ALLOWLIST, outOfScope: OUT_OF_SCOPE }): Result {
  const scanned = new Map<string, ScopeGroup>();
  const emptyScope: ScopeEntry[] = [];
  for (const entry of config.scope) {
    const files = filesOf(src, entry);
    if (files.length === 0) emptyScope.push(entry);
    for (const f of files) if (!scanned.has(f)) scanned.set(f, entry.group);
  }

  const allowKey = (file: string, identifier: string) => `${file}\u0000${identifier}`;
  const allow = new Map(config.allowlist.map((a) => [allowKey(a.file, a.identifier), a]));
  const used = new Set<string>();
  const findings: Finding[] = [];
  const allowed: Finding[] = [];
  for (const [file, group] of scanned) {
    for (const hit of moneyIdentifiersIn(readFileSync(join(src, file), "utf8"))) {
      const finding: Finding = { file, group, ...hit };
      const k = allowKey(file, hit.identifier);
      if (allow.has(k)) { used.add(k); allowed.push(finding); } else findings.push(finding);
    }
  }

  const unjustified: string[] = [];
  for (const a of config.allowlist) {
    if (a.why.trim().length < MIN_REASON) unjustified.push(`ALLOWLIST ${a.file} \`${a.identifier}\``);
  }
  for (const o of config.outOfScope) {
    if (o.why.trim().length < MIN_REASON) unjustified.push(`OUT_OF_SCOPE ${o.file}`);
  }

  const out = new Set(config.outOfScope.map((o) => o.file));
  const unclassified: string[] = [];
  for (const root of DISCOVERY_ROOTS) {
    const dir = join(src, root);
    if (!existsSync(dir)) continue;
    for (const abs of walk(dir, [])) {
      const file = posix(relative(src, abs));
      if (isRankingShapedName(file) && !scanned.has(file) && !out.has(file)) unclassified.push(file);
    }
  }
  const staleOutOfScope = config.outOfScope
    .filter((o) => !existsSync(join(src, o.file)) || scanned.has(o.file))
    .map((o) => o.file);

  return {
    scanned, findings, allowed, emptyScope, unjustified, unclassified, staleOutOfScope,
    staleAllow: config.allowlist.filter((a) => !used.has(allowKey(a.file, a.identifier))),
  };
}

export function failureCount(r: Result): number {
  return r.findings.length + r.emptyScope.length + r.staleAllow.length + r.unjustified.length
    + r.unclassified.length + r.staleOutOfScope.length;
}

function main(): void {
  const src = process.env.NO_MONEY_IN_RANKING_SRC ? resolve(process.env.NO_MONEY_IN_RANKING_SRC) : REAL_SRC;
  let r: Result;
  try {
    r = runCheck(src);
  } catch (err) {
    console.error(`check:no-money-in-ranking: cannot read the source tree at ${src}: ${(err as Error).message}`);
    console.log("RESULT unreadable");
    process.exit(2);
  }

  const perGroup = (g: ScopeGroup) => [...r.scanned.values()].filter((x) => x === g).length;
  console.log(
    `check:no-money-in-ranking: ${r.scanned.size} ranking, feature-vector, graph and feed-payload files scanned ` +
      `(ranker ${perGroup("ranker")}, feature-vector ${perGroup("feature-vector")}, graph ${perGroup("graph")}, feed-payload ${perGroup("feed-payload")}); ` +
      `${r.allowed.length} allowlisted money identifier(s) in ${new Set(r.allowed.map((a) => a.file)).size} file(s).`,
  );
  for (const f of r.findings) {
    console.log(`  MONEY     ${f.file}:${f.line}  \`${f.identifier}\` (${f.term}) in a ${f.group} file — docs/architecture/08_Portava_Revenue_Model.md §6.1 and 09_Payment_Architecture.md §10: no money identifier is read by the ranker, a feature vector, a graph builder or a feed payload. Remove it, or add a justified ALLOWLIST entry if it ENFORCES a non-goal.`);
  }
  for (const e of r.emptyScope) console.log(`  EMPTY     scope entry \`${e.path}\` (${e.group}) matches no file — the file moved or was renamed, and the check would stop looking. Repoint the entry.`);
  for (const u of r.unclassified) console.log(`  UNCLASSIFIED ${u} is named like a ranker or graph builder and is neither in SCOPE nor in OUT_OF_SCOPE. Classify it.`);
  for (const a of r.staleAllow) console.log(`  STALE     ALLOWLIST ${a.file} \`${a.identifier}\` matches nothing — delete the entry.`);
  for (const o of r.staleOutOfScope) console.log(`  STALE     OUT_OF_SCOPE ${o} does not exist, or is in SCOPE — delete the entry.`);
  for (const u of r.unjustified) console.log(`  UNJUSTIFIED ${u}: the reason is under ${MIN_REASON} characters. Say why.`);

  if (failureCount(r) > 0) {
    console.log("RESULT failed");
    process.exit(1);
  }
  console.log("  DOES NOT COVER: data flow. A money value passed in under a neutral name, or folded into a column by a view, is invisible to a scan of names; route files are out of scope.");
  console.log("RESULT clean");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
