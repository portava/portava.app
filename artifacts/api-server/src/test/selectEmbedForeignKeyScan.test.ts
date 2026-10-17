/**
 * Every PostgREST embed production code issues has a foreign key behind it —
 * checked statically, whether or not any test drives the select.
 *
 * Run: node --import tsx/esm --test src/test/selectEmbedForeignKeyScan.test.ts
 *
 * WHY (2026-10-17, wave 5). The embed guard in the test doubles
 * (helpers/migrationForeignKeys.ts) refuses an embed with no key behind it, but
 * only for a select some test drives. Four production reads embedded across a
 * pair of tables with no key and answered PGRST200 in production for months:
 *   reviews → profiles             routes/reviews.ts (fixed in 767d255df)
 *   appeals → profiles             routes/appeals.ts, the admin queue
 *   route_plan_members → profiles  routes/routePlan.ts, silently `members: []`
 *   posts → discovery_places       lib/eventPostsDiscovery.ts, Path B
 * Each now reads in two steps. This file reads EVERY `.select(` under src/
 * (helpers/selectEmbedScan.ts says what it resolves and what it cannot) and:
 *   1. fails on any embed no declared key backs, unless it is on
 *      KNOWN_UNBACKED_SELECT_EMBEDS (file + relation + finding). The list is
 *      SHRINK-ONLY: an entry the scan no longer finds fails until it is deleted;
 *   2. fails on a NEW unhinted embed across a pair of tables joined by more than
 *      one declared key (PostgREST answers PGRST201), the current ones being
 *      KNOWN_AMBIGUOUS_UNHINTED_EMBEDS, shrink-only too;
 *   3. fails when a file gains a `.select(` the scan cannot resolve (a new blind
 *      spot) beyond UNRESOLVED_SELECT_CEILING;
 *   4. proves itself on a planted tree (each resolution path finds its plant).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanSelectEmbeds, unbackedEmbedKeys, ambiguousUnhintedEmbeds, type EmbedScan } from "./helpers/selectEmbedScan.js";

/**
 * Embeds production code issues that no declared key backs. EMPTY: the four
 * found on 2026-10-17 are fixed. A new entry needs `file`, the `parent→relation`
 * the scan reports, a finding, and an owner, and must be removed with its fix.
 */
const KNOWN_UNBACKED_SELECT_EMBEDS: ReadonlyArray<{ file: string; parent: string; relation: string; finding: string }> = [];

/**
 * Unhinted embeds across a pair of tables the declared keys join more than once.
 * PostgREST refuses such an embed with PGRST201 unless all but one key are gone
 * from the live catalog: the reader is additive (a dropped key still counts), so
 * each entry is "ambiguous by the repo's schema, NOT verified on the live
 * catalog". Each fix is a hint naming the key: `profiles!author_id(...)`.
 */
const KNOWN_AMBIGUOUS_UNHINTED_EMBEDS: ReadonlyArray<{ file: string; parent: string; relation: string; finding: string }> = [
  { file: "src/routes/placeDays.ts", parent: "posts", relation: "profiles", finding: "`profiles(id, is_private)` from posts; posts has three keys to profiles (author_id, created_by, updated_by; baseline posts_*_fkey). Owner: place days (census-media / place lane)." },
  { file: "src/routes/placeRecaps.ts", parent: "posts", relation: "profiles", finding: "two reads (shared_moment_contributions → posts → `profiles(...)`, and posts → `profiles(...)`); the same three keys. Owner: place recaps." },
  { file: "src/routes/placeRecaps.ts", parent: "live_place_recaps", relation: "live_place_recap_versions", finding: "`live_place_recap_versions!inner(...)` (`!inner` is a join modifier, not a hint) across recap_id → live_place_recaps AND live_place_recaps.current_version_id → versions. Owner: place recaps." },
  { file: "src/routes/sharedMoments.ts", parent: "posts", relation: "profiles", finding: "shared_moment_contributions → posts → `profiles(id, is_private)`; the same three keys. Owner: shared moments." },
];

/**
 * `.select(` sites the scan cannot resolve, per file (counted by site, not by
 * the calls of the helper it sits in). A new one is a blind spot: resolve it
 * (a literal, a constant, a helper whose every return is static) or raise the
 * count here with a reason. Inspected 2026-10-17: every one selects plain
 * columns (schema probes, id-column helpers, seed upserts, Telegraph column
 * lists forwarded through two helper hops); none embeds.
 */
const UNRESOLVED_SELECT_CEILING: Readonly<Record<string, number>> = {
  "src/lib/capability/schemaCapability.ts": 1,
  "src/lib/contentOwner.ts": 1,
  "src/lib/feedReads.ts": 4,
  "src/lib/moderationReportSnapshots.ts": 2,
  "src/lib/schemaDriftCheck.ts": 1,
  "src/routes/rentABuddy.ts": 1,
  "src/scripts/seed-demo-buddies.ts": 1,
  "src/scripts/seed-demo-profile.ts": 1,
  "src/scripts/seed-demo-social.ts": 1,
  "src/services/highlights/highlightSchemaAvailability.ts": 1,
  "src/services/media/MyWorldMemoryService.ts": 1,
  "src/services/memory/memoryEvidenceErasure.ts": 1,
  "src/services/telegraph/conversationSnapshots.ts": 1,
  "src/services/telegraph/inboxReads.ts": 1,
};

let scan: EmbedScan;
before(() => { scan = scanSelectEmbeds(); });

describe("every embed production code issues has a declared foreign key behind it", () => {
  it("the scan reached the codebase (not vacuous)", () => {
    assert.ok(scan.selectsScanned > 4000, `only ${scan.selectsScanned} selects resolved`);
    assert.ok(scan.embedSites.length > 100, `only ${scan.embedSites.length} embedding selects found`);
    assert.ok(scan.embedSites.some((s) => s.file === "src/routes/follows.ts" && s.embeds.includes("user_follows→profiles")), "a known, backed embed is in the scan");
  });

  it("no embed lacks a key, beyond the shrink-only ledger", () => {
    const found = unbackedEmbedKeys(scan);
    const allowed = new Set(KNOWN_UNBACKED_SELECT_EMBEDS.map((k) => `${k.file} → ${k.parent}→${k.relation}`));
    const fresh = [...found].filter(([k]) => !allowed.has(k)).map(([k, sites]) => `${k} at ${sites.map((s) => `:${s.line}${s.via ? ` (via ${s.via})` : ""}`).join(", ")}: ${sites[0]!.refusals[0]!.why}`);
    assert.deepEqual(fresh, [], `PostgREST would refuse these embeds (PGRST200). Read in two steps (base rows, then one batched .in("id", ids) read), as routes/reviews.ts does:\n${fresh.join("\n")}`);
    const stale = [...allowed].filter((k) => !found.has(k));
    assert.deepEqual(stale, [], "the scan no longer finds these ledger entries: delete them");
  });

  it("the four wave-5 embeds are gone, and nothing re-embeds across those pairs", () => {
    const pairs = ["reviews→profiles", "appeals→profiles", "route_plan_members→profiles", "posts→discovery_places"];
    const back = scan.embedSites.filter((s) => s.embeds.some((e) => pairs.includes(e))).map((s) => `${s.file}:${s.line} ${s.embeds.join(", ")}`);
    assert.deepEqual(back, []);
  });

  it("no embed hangs off a view (a relationship through a view is invisible to the key reader)", () => {
    assert.deepEqual(scan.viewSites.map((s) => `${s.file}:${s.line} ${s.table}`), [], "check these by hand against the view's base tables, then give them a ledger");
  });
});

describe("unhinted embeds across a multiply-keyed pair (PGRST201) are on a shrink-only ledger", () => {
  it("no NEW ambiguous embed; every ledger entry is still found", () => {
    const found = ambiguousUnhintedEmbeds(scan);
    const keyOf = (x: { file: string; parent: string; relation: string }) => `${x.file} → ${x.parent}→${x.relation}`;
    const allowed = new Set(KNOWN_AMBIGUOUS_UNHINTED_EMBEDS.map(keyOf));
    const fresh = found.filter((a) => !allowed.has(keyOf(a))).map((a) => `${a.file}:${a.line} ${a.parent}→${a.relation} (keys: ${a.keys.join("; ")})`);
    assert.deepEqual(fresh, [], `hint the key (e.g. profiles!author_id(...)); PostgREST cannot choose between these:\n${fresh.join("\n")}`);
    const stillFound = new Set(found.map(keyOf));
    assert.deepEqual([...allowed].filter((k) => !stillFound.has(k)), [], "fixed: delete the ledger entry");
  });
});

describe("no new blind spot: every file's unresolvable selects stay at or under its ceiling", () => {
  it("per-file counts", () => {
    const per = new Map<string, Set<number>>();
    for (const u of scan.unresolved) per.set(u.file, (per.get(u.file) ?? new Set()).add(u.line));
    const over = [...per].filter(([f, lines]) => lines.size > (UNRESOLVED_SELECT_CEILING[f] ?? 0))
      .map(([f, lines]) => `${f}: ${lines.size} > ${UNRESOLVED_SELECT_CEILING[f] ?? 0} (lines ${[...lines].join(", ")}; ${scan.unresolved.filter((u) => u.file === f).map((u) => u.text).join(" | ")})`);
    assert.deepEqual(over, [], "a .select( the scan cannot read is an embed nobody checks: make it static, or raise its ceiling with a reason");
  });
});

// ── The scan, on a planted tree ──────────────────────────────────────────────

describe("the scan finds each kind of plant", () => {
  let root: string;
  let planted: EmbedScan;
  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "embed-scan-"));
    const w = (name: string, text: string) => fs.writeFileSync(path.join(root, name), text);
    w("literal.ts", `export async function a(sc: any) { return sc.from("reviews").select("id, profiles!reviewer_id(handle)"); }\n`);
    w("backed.ts", `export async function b(sc: any) { return sc.from("event_reviews").select("id, profiles!reviewer_id(handle)"); }\n`);
    w("consts.ts", `export const VENUE_COLS = "id, discovery_places(name)";\n`);
    w("imported.ts", `import { VENUE_COLS } from "./consts.js";\nexport async function c(sc: any) { return sc.from("posts").select(VENUE_COLS); }\n`);
    w("ternary.ts", `export async function d(sc: any, wide: boolean) { return sc.from("route_plan_members").select(wide ? "user_id, profiles(handle)" : "user_id"); }\n`);
    w("builder.ts", `export async function e(sc: any) { const q = sc.from("appeals"); return q.select("id, profiles!appellant_id(handle)"); }\n`);
    w("helper.ts", `export async function readCols(sc: any, cols: string) { return sc.from("appeals").select(cols); }\n`);
    w("caller.ts", `import { readCols } from "./helper.js";\nexport async function f(sc: any) { return readCols(sc, "id, profiles(handle)"); }\n`);
    w("fn.ts", `function cols(extra: string) { return "id, " + extra; }\nexport async function g(sc: any) { return sc.from("posts").select(cols("discovery_places(name)")); }\n`);
    w("ambiguous.ts", `export async function h(sc: any) { return sc.from("posts").select("id, profiles(id)"); }\n`);
    w("hinted.ts", `export async function i(sc: any) { return sc.from("posts").select("id, profiles!author_id(id)"); }\n`);
    w("dynamic.ts", `export async function j(sc: any, x: () => string) { return sc.from("posts").select(x()); }\n`);
    w("skipped.test.ts", `export async function k(sc: any) { return sc.from("reviews").select("id, profiles(handle)"); }\n`);
    planted = scanSelectEmbeds(root);
  });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  const unbacked = () => [...unbackedEmbedKeys(planted).keys()].sort();

  it("a literal, an imported constant, a ternary branch, a held builder, a helper's call site and a function's return are all found", () => {
    assert.deepEqual(unbacked(), [
      "builder.ts → appeals→profiles",
      "fn.ts → posts→discovery_places",
      "helper.ts → appeals→profiles",
      "imported.ts → posts→discovery_places",
      "literal.ts → reviews→profiles",
      "ternary.ts → route_plan_members→profiles",
    ]);
    const viaCall = unbackedEmbedKeys(planted).get("helper.ts → appeals→profiles")![0]!;
    assert.match(viaCall.via ?? "", /readCols\(\) called at caller\.ts:2/);
  });

  it("CONTROL: a backed embed and a hinted one pass; a test file is not production", () => {
    assert.ok(planted.embedSites.some((s) => s.file === "backed.ts" && s.refusals.length === 0));
    assert.ok(planted.embedSites.some((s) => s.file === "hinted.ts" && s.refusals.length === 0));
    assert.ok(!planted.embedSites.some((s) => s.file === "skipped.test.ts"));
  });

  it("an unhinted embed across a multiply-keyed pair is reported; the hinted one is not", () => {
    assert.deepEqual(ambiguousUnhintedEmbeds(planted).map((a) => `${a.file} ${a.parent}→${a.relation}`), ["ambiguous.ts posts→profiles"]);
  });

  it("an unresolvable select is reported, not guessed", () => {
    assert.deepEqual(planted.unresolved.map((u) => `${u.file}:${u.line} ${u.reason}`), ["dynamic.ts:1 select list not statically resolvable"]);
  });
});
