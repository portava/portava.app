/**
 * checkBlockListFailOpen — the block-list read path cannot be re-opened fail-open.
 *
 * ── WHY THIS SUITE IS SHAPED LIKE THIS ──────────────────────────────────────
 * The guard exists because the path closed and re-opened twice (PR #469, then
 * PR #530 four weeks later). The SECOND re-opening is the reason the tests
 * below drive the guard's exported DECISION functions rather than a convenience
 * helper: #530's defect was a wholeness predicate that was wrong, in a repo
 * whose fake Supabase client could not express the input that would have shown
 * it. A correct helper behind a decision nobody drives is not a guard.
 *
 * So three things are proven here, and they are different claims:
 *
 *   1. THE SCANNER DECIDES CORRECTLY — `findBlockListFailOpen` on fixtures, one
 *      per rule, plus the sanctioned shapes it must stay silent about.
 *   2. THE RUN DECIDES CORRECTLY — `decide()` on synthetic scan results: the
 *      two-sided ratchet, and the VACUITY refusal, which is the one assertion
 *      that fails when the guard's subject has vanished rather than passing
 *      green. This repo has shipped that false green repeatedly.
 *   3. THE REPOSITORY IS CLEAN — the committed baseline matches the real tree
 *      exactly, in both directions, and the real checker exits 0 when spawned
 *      against the real tree with no seam set. (1) and (2) prove the logic;
 *      only (3) protects anything.
 *
 * ── WHERE THIS RUNS ─────────────────────────────────────────────────────────
 * `pnpm test` → ci.yml's `api-server-tests` job (`needs: preflight`, no
 * `environment:`, no secrets). That is deliberate and it is the whole point of
 * putting the enforcement here instead of in `check:all`: `check:all` is reached
 * only through live-db.yml, the credentialed tier that goes missing from a
 * rollup when runs are cancelled or slot-starved, and unwired-checks.yml is a
 * probation tier that `check:all` does not run either. This guard reads .ts
 * files off disk and needs no database, so it belongs in the tier that cannot
 * be starved.
 *
 * Run: node --import tsx/esm --test src/test/blockListFailOpenGuard.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findBlockListFailOpen,
  decide,
  scanTree,
  keyOf,
  isSanctionedModule,
  blockReadSites,
  bindingAt,
  BASELINE_PATH,
  BLOCKS_TABLE,
  BLOCK_READ_MODULES,
  ESCAPE_HATCH,
  MIN_FILES_SCANNED,
  MIN_READ_SITES,
  type BlockReadFinding,
  type ScanResult,
} from "../scripts/checkBlockListFailOpen.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const CHECKER = resolve(__dir, "..", "scripts", "checkBlockListFailOpen.ts");

/** A file path that is NOT one of the sanctioned block modules. */
const CALLER = "routes/someFeed.ts";

const rules = (fs: BlockReadFinding[]) => fs.map((f) => f.rule).sort();

function runChecker(env: Record<string, string> = {}) {
  return spawnSync(process.execPath, ["--import", "tsx/esm", CHECKER], {
    cwd: resolve(__dir, "..", ".."),
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. THE SCANNER DECIDES CORRECTLY
// ══════════════════════════════════════════════════════════════════════════════

describe("the table, and the modules allowed to read it", () => {
  it("is `blocks` — established from the migration, not assumed", () => {
    // src/migrations/0015_blocks.sql creates public.blocks(id, blocker_id,
    // blocked_id, created_at) with blocks_pair_unique(blocker_id, blocked_id).
    // There is no `user_blocks` table in this tree; the guard would find
    // nothing at all if it were looking for one, which is what the vacuity
    // floors below exist to make loud rather than green.
    assert.equal(BLOCKS_TABLE, "blocks");
    const sql = readFileSync(resolve(__dir, "..", "migrations", "0015_blocks.sql"), "utf8");
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${BLOCKS_TABLE}\\b`));
  });

  it("sanctions exactly the three helpers plus the owning route", () => {
    assert.deepEqual([...BLOCK_READ_MODULES].sort(), [
      "lib/blockGuard.ts",
      "lib/blocks.ts",
      "lib/exclusionSet.ts",
      "routes/blocks.ts",
    ]);
    assert.ok(isSanctionedModule("lib/blocks.ts"));
    assert.ok(isSanctionedModule("artifacts/api-server/src/lib/exclusionSet.ts"));
    assert.ok(!isSanctionedModule(CALLER));
    assert.ok(!isSanctionedModule("lib/blocksCache.ts"), "a near-miss name is not sanctioned");
  });
});

describe("R1 — a direct table read outside the helpers is caught", () => {
  const src = `
    export async function hide(sc: any, me: string) {
      const { data, error } = await sc
        .from("blocks")
        .select("blocker_id, blocked_id")
        .or(\`blocker_id.eq.\${me},blocked_id.eq.\${me}\`);
      if (error) return null;
      const out = new Set<string>();
      for (const b of (data ?? []) as any[]) out.add(b.blocked_id);
      return out;
    }`;

  it("flags the read when it is written in a caller", () => {
    const v = findBlockListFailOpen(src, CALLER);
    assert.deepEqual(rules(v), ["direct-read"]);
    assert.match(v[0].excerpt, /from\("blocks"\)/, "the excerpt names the table, not a blanked string");
  });

  it("does NOT flag the identical read inside a sanctioned helper", () => {
    assert.deepEqual(findBlockListFailOpen(src, "lib/blocks.ts"), []);
  });

  it("single quotes and backticks are the same read", () => {
    for (const q of ["'", "`"]) {
      const s = `const r = await sc.from(${q}blocks${q}).select('blocker_id').limit(1);`;
      assert.equal(blockReadSites(s).length, 1, `quoted with ${q}`);
    }
  });

  it("a WRITE to blocks is not a read", () => {
    const s = `const { error } = await sc.from("blocks").delete().eq("blocker_id", me);`;
    assert.deepEqual(findBlockListFailOpen(s, CALLER), []);
  });

  it("prose ABOUT the defect is not a read — comments cannot trip the guard", () => {
    // This tree contains a great deal of commentary quoting the broken shape,
    // including inside the sibling guards. A scanner that matched raw file text
    // would report every paragraph as a fail-open read.
    const s = `
      // const { data } = await sc.from("blocks").select("blocker_id");
      /* await sc.from("blocks").select("*") is the shape we removed. */
      export const nothing = 1;`;
    assert.deepEqual(findBlockListFailOpen(s, CALLER), []);
  });

  it(`a site carrying "${ESCAPE_HATCH}: <reason>" is waived`, () => {
    const s = `
      export async function own(sc: any, me: string) {
        // ${ESCAPE_HATCH}: the owner's own management list, not a visibility decision
        const { data, error } = await sc.from("blocks").select("blocked_id").eq("blocker_id", me);
        if (error) return null;
        return data;
      }`;
    assert.deepEqual(findBlockListFailOpen(s, CALLER), []);
  });
});

describe("R2 — the three-state distinction must survive the call site", () => {
  it("flags an answer flattened with `?? []` when no error is bound at all", () => {
    const s = `
      export async function hidden(sc: any, me: string) {
        const { data } = await sc.from("blocks").select("blocked_id").eq("blocker_id", me);
        return new Set(((data ?? []) as any[]).map((r) => r.blocked_id));
      }`;
    const v = findBlockListFailOpen(s, "lib/blocks.ts"); // sanctioned ⇒ R1 silent, R2 is the claim
    assert.deepEqual(rules(v), ["three-state"]);
    assert.match(v[0].excerpt, /never consulted/);
  });

  it("flags `Boolean(data)` — the #469 shape verbatim", () => {
    const s = `
      export async function isBlocked(sc: any, a: string, b: string) {
        const { data } = await sc.from("blocks").select("blocker_id").eq("blocker_id", a).eq("blocked_id", b).maybeSingle();
        return Boolean(data);
      }`;
    assert.deepEqual(rules(findBlockListFailOpen(s, "lib/blockGuard.ts")), ["three-state"]);
  });

  it("flags a count defaulted to zero when the error is never consulted", () => {
    const s = `
      export async function anyBlock(sc: any, a: string, b: string) {
        const { count } = await sc.from("blocks").select("id", { count: "exact", head: true }).eq("blocker_id", a).eq("blocked_id", b);
        return (count ?? 0) > 0;
      }`;
    assert.deepEqual(rules(findBlockListFailOpen(s, "lib/blockGuard.ts")), ["three-state"]);
  });

  it("does NOT flag a coercion that comes AFTER the error is consulted", () => {
    const s = `
      export async function hidden(sc: any, me: string) {
        const { data, error } = await sc.from("blocks").select("blocked_id").eq("blocker_id", me);
        if (error) return null;
        return new Set(((data ?? []) as any[]).map((r) => r.blocked_id));
      }`;
    assert.deepEqual(findBlockListFailOpen(s, "lib/blocks.ts"), []);
  });

  it("does NOT flag `blockErr || (blockCount ?? 0) > 0` — the error is tested first", () => {
    // The live shape in routes/contentStamps.ts and routes/posts.ts: one
    // expression, error on the left, so a failed count denies instead of
    // reading as zero.
    const s = `
      export async function gate(sc: any, a: string, b: string) {
        const { count: blockCount, error: blockErr } = await sc
          .from("blocks").select("id", { count: "exact", head: true })
          .or(\`and(blocker_id.eq.\${a},blocked_id.eq.\${b})\`);
        if (blockErr || (blockCount ?? 0) > 0) return "deny";
        return "allow";
      }`;
    assert.deepEqual(findBlockListFailOpen(s, "lib/blockGuard.ts"), []);
  });

  it("does NOT flag a member-form error read, cast and all", () => {
    // routes/follows.ts reads `(callerBlockedTargetRes as any).error` out of a
    // Promise.all element before touching its count.
    const s = `
      export async function passport(sc: any, a: string, b: string) {
        const [mine, theirs] = await Promise.all([
          sc.from("blocks").select("blocker_id", { count: "exact", head: true }).eq("blocker_id", a).eq("blocked_id", b),
          sc.from("blocks").select("blocker_id", { count: "exact", head: true }).eq("blocker_id", b).eq("blocked_id", a),
        ]);
        if ((mine as any).error || (theirs as any).error) return "unavailable";
        return ((mine as any).count ?? 0) > 0 ? "blocked" : "ok";
      }`;
    assert.deepEqual(findBlockListFailOpen(s, "lib/blockGuard.ts"), []);
  });

  it("an unrelated `?? []` in the same function is not attributed to the block read", () => {
    // The reason R2 keys on the read's OWN binding names rather than grepping
    // the window: a route handler holds a dozen unrelated coalesces.
    const s = `
      export async function feed(sc: any, me: string, raw: any) {
        const tags = (raw.tags ?? []) as string[];
        const { data, error } = await sc.from("blocks").select("blocked_id").eq("blocker_id", me);
        if (error) return null;
        return { tags, blocked: (data ?? []).length };
      }`;
    assert.deepEqual(findBlockListFailOpen(s, "lib/blocks.ts"), []);
  });
});

describe("R2b — ERROR-INERT: the failure is seen and answered permissively", () => {
  it("flags a failure branch whose answer is an empty list", () => {
    const s = `
      export async function refresh(sc: any, me: string, snapshot: any) {
        const [blockedRes, blockerRes] = await Promise.all([
          sc.from("blocks").select("blocked_id").eq("blocker_id", me),
          sc.from("blocks").select("blocker_id").eq("blocked_id", me),
        ]);
        const blocked = blockedRes.error ? (snapshot?.blockedUserIds ?? []) : (blockedRes.data ?? []);
        const blockers = blockerRes.error ? (snapshot?.blockerUserIds ?? []) : (blockerRes.data ?? []);
        return new Set([...blocked, ...blockers]);
      }`;
    const v = findBlockListFailOpen(s, "lib/blocks.ts");
    assert.deepEqual(rules(v), ["error-inert", "error-inert"]);
    assert.match(v[0].excerpt, /an empty block list from a read that did not answer/);
  });

  it("flags `if (error) return [];` and allows `if (error) return null;`", () => {
    const mk = (answer: string) => `
      export async function set(sc: any, me: string) {
        const { data, error } = await sc.from("blocks").select("blocked_id").eq("blocker_id", me);
        if (error) return ${answer};
        return new Set((data as any[]).map((r) => r.blocked_id));
      }`;
    assert.deepEqual(rules(findBlockListFailOpen(mk("[]"), "lib/blocks.ts")), ["error-inert"]);
    assert.deepEqual(rules(findBlockListFailOpen(mk("new Set()"), "lib/blocks.ts")), ["error-inert"]);
    assert.deepEqual(rules(findBlockListFailOpen(mk("false"), "lib/blockGuard.ts")), ["error-inert"]);
    // The fail-CLOSED answers. `null` is fetchBlockedSet's contract; `true` is
    // isBlockedBetween's; a non-empty Set is WallProjectionService's "drop
    // every author that could be blocked".
    assert.deepEqual(findBlockListFailOpen(mk("null"), "lib/blocks.ts"), []);
    assert.deepEqual(findBlockListFailOpen(mk("true"), "lib/blockGuard.ts"), []);
    assert.deepEqual(findBlockListFailOpen(mk("new Set(candidates)"), "lib/blocks.ts"), []);
  });
});

describe("R3 — emptiness only from a positive proof", () => {
  it("flags a NON-ARRAY answer scored as whole — PR #530's defect exactly", () => {
    const s = `
      export async function fetchBlockedSet(sc: any, me: string) {
        const { data, error, count } = await sc
          .from("blocks").select("blocker_id, blocked_id", { count: "exact" })
          .or(\`blocker_id.eq.\${me}\`);
        if (error) return null;
        if (!isWhole(data, count)) return null;
        return new Set((data as any[]).map((r) => r.blocked_id));
      }
      function isWhole(data: unknown, count: unknown): boolean {
        if (!Array.isArray(data)) return true;
        return typeof count === "number" ? data.length >= count : true;
      }`;
    const v = findBlockListFailOpen(s, "lib/blocks.ts");
    assert.deepEqual(rules(v), ["empty-without-proof"]);
    assert.match(v[0].excerpt, /absence of data is not proof of emptiness/);
  });

  it("ALLOWS the fixed predicate, which defers to an exact count of zero", () => {
    const s = `
      export async function fetchBlockedSet(sc: any, me: string) {
        const { data, error, count } = await sc
          .from("blocks").select("blocker_id, blocked_id", { count: "exact" })
          .or(\`blocker_id.eq.\${me}\`);
        if (error) return null;
        if (!isWhole(data, count)) return null;
        return new Set((data as any[]).map((r) => r.blocked_id));
      }
      function isWhole(data: unknown, count: unknown): boolean {
        if (!Array.isArray(data)) return count === 0;
        return typeof count === "number" ? data.length >= count : data.length < 1000;
      }`;
    assert.deepEqual(findBlockListFailOpen(s, "lib/blocks.ts"), []);
  });

  it("ALLOWS a conclusion drawn from an exact count of zero", () => {
    // The one positive proof of emptiness a count read can offer. `count === 0`
    // is a fact; `(count ?? 0) === 0` would not be, and R2 catches that above.
    const s = `
      export async function blockState(sc: any, me: string) {
        const { count, error } = await sc
          .from("blocks").select("id", { count: "exact", head: true })
          .or(\`blocker_id.eq.\${me},blocked_id.eq.\${me}\`);
        if (error) return null;
        return count === 0 ? "nobody" : "someone";
      }`;
    assert.deepEqual(findBlockListFailOpen(s, "lib/blockGuard.ts"), []);
  });

  it("flags `Array.isArray(rows) ? rows : []` on a block answer", () => {
    const s = `
      export async function hidden(sc: any, me: string) {
        const { data: rows, error } = await sc.from("blocks").select("blocked_id").eq("blocker_id", me);
        if (error) return null;
        const safe = Array.isArray(rows) ? rows : [];
        return new Set(safe.map((r: any) => r.blocked_id));
      }`;
    assert.deepEqual(rules(findBlockListFailOpen(s, "lib/blocks.ts")), ["empty-without-proof"]);
  });

  it("the non-array rule is scoped to files that read blocks", () => {
    // `Array.isArray(x) ? x : []` is a legitimate idiom on a JSON column and
    // appears dozens of times tree-wide. Ungated, R3 would be noise, and a
    // guard people learn to scroll past launders the defect class as "known".
    const s = `
      export function tags(row: any): string[] {
        if (!Array.isArray(row.vibe_tags)) return [];
        return row.vibe_tags;
      }`;
    assert.deepEqual(findBlockListFailOpen(s, CALLER), []);
  });
});

describe("bindingAt — what the answer and the failure are called at a site", () => {
  it("reads an object destructure, aliases and all", () => {
    const code = `const { data: rows, error: blockErr, count: n } = await sc.from("blocks").select("x");`;
    const b = bindingAt(code, code.indexOf(".from"));
    assert.deepEqual(b.answerNames.sort(), ["n", "rows"]);
    assert.deepEqual(b.errorNames, ["blockErr"]);
  });

  it("reads a Promise.all array destructure POSITIONALLY", () => {
    // Not "all the names": a batch over five tables destructures five results,
    // and attributing all five to the one `blocks` element made this guard
    // report `user_account_states` and `circle_presence` coercions as fail-open
    // block reads.
    const code = `const [outbound, inbound] = await Promise.all([sc.from("blocks").select("a"), sc.from("blocks").select("b")]);`;
    const first = bindingAt(code, code.indexOf(".from"));
    assert.deepEqual(first.answerNames, ["outbound"]);
    assert.deepEqual(first.memberNames, ["outbound"]);
    const second = bindingAt(code, code.lastIndexOf(".from"));
    assert.deepEqual(second.answerNames, ["inbound"]);
  });

  it("reaches the array through a wrapper call, as PR #530 writes these reads", () => {
    // `wholeListResult(() => sc.from("blocks")…)`. A walk that stopped at the
    // wrapper's own paren would attribute nothing, and the guard's silence
    // would read as a fix.
    const code = `const [a, b] = await Promise.all([wholeListResult(() => sc.from("blocks").select("x", { count: "exact" })), other()]);`;
    assert.deepEqual(bindingAt(code, code.indexOf(".from")).answerNames, ["a"]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. THE RUN DECIDES CORRECTLY — ratchet and VACUITY
// ══════════════════════════════════════════════════════════════════════════════

const healthy = (findings: BlockReadFinding[]): ScanResult => ({
  findings,
  filesScanned: MIN_FILES_SCANNED + 50,
  readSites: MIN_READ_SITES + 10,
});
const f = (file: string, rule: BlockReadFinding["rule"] = "direct-read"): BlockReadFinding =>
  ({ file, line: 1, rule, excerpt: "x" });

describe("decide — the two-sided shrink-only ratchet", () => {
  it("a file at its baselined count passes; above it, the excess is NEW", () => {
    const base = { "a.ts::direct-read": 2 };
    assert.ok(decide(healthy([f("a.ts"), f("a.ts")]), base).ok);
    const grown = decide(healthy([f("a.ts"), f("a.ts"), f("a.ts")]), base);
    assert.equal(grown.ok, false);
    assert.equal(grown.newViolations.length, 1);
  });

  it("an unbaselined finding is NEW", () => {
    const v = decide(healthy([f("b.ts")]), {});
    assert.equal(v.ok, false);
    assert.equal(v.newViolations.length, 1);
  });

  it("a fixed site makes its entry STALE — the count must be lowered", () => {
    const v = decide(healthy([f("a.ts")]), { "a.ts::direct-read": 2 });
    assert.equal(v.ok, false);
    assert.deepEqual(v.staleEntries, [{ file: "a.ts::direct-read", baselined: 2, found: 1 }]);
  });

  it("fixing one rule cannot pay for introducing another in the same file", () => {
    const v = decide(healthy([f("a.ts", "three-state")]), { "a.ts::direct-read": 1 });
    assert.equal(v.ok, false);
    assert.equal(v.newViolations.length, 1, "the three-state finding is NEW");
    assert.equal(v.staleEntries.length, 1, "and the direct-read entry is now stale");
  });
});

describe("decide — the VACUITY refusal", () => {
  // The exact defect that has bitten this repo repeatedly: a scan that stopped
  // seeing its subject prints the same clean line it prints when there is
  // nothing wrong, and `newViolations: []` passes trivially. A guard whose
  // subject vanished must FAIL.
  it("refuses a scan that opened implausibly few files, even with no findings", () => {
    const v = decide({ findings: [], filesScanned: 3, readSites: MIN_READ_SITES + 10 }, {});
    assert.equal(v.ok, false);
    assert.match(v.problems.join("\n"), /VACUOUS SCAN: 3 file\(s\) scanned/);
  });

  it("refuses a scan that found no block reads, even with no findings", () => {
    const v = decide({ findings: [], filesScanned: MIN_FILES_SCANNED + 50, readSites: 0 }, {});
    assert.equal(v.ok, false);
    assert.match(v.problems.join("\n"), /VACUOUS SCAN: 0 `blocks` read chain\(s\) found/);
  });

  it("a healthy scan with no findings and no baseline is clean", () => {
    assert.ok(decide(healthy([]), {}).ok);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. THE REPOSITORY IS CLEAN — and the guard is enforced, not merely tested
// ══════════════════════════════════════════════════════════════════════════════

describe("the guard is enforced against the real tree", () => {
  const baseline = () => JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Record<string, number>;

  it("the committed baseline matches the tree exactly, in both directions", () => {
    const scan = scanTree();
    const v = decide(scan, baseline());
    assert.deepEqual(
      v.newViolations.map((x) => `${x.file}:${x.line} [${x.rule}]`), [],
      "NEW fail-open block-list read(s). `blocks` is an EXCLUSION table: a row means DENY, " +
        "so emptiness means ALLOW and a read that failed coerces to the permissive answer. " +
        "Route the read through lib/blocks.ts / lib/blockGuard.ts / lib/exclusionSet.ts, " +
        "consult the error before flattening the answer, and conclude emptiness only from " +
        "an actual empty array or an exact count of zero.",
    );
    assert.deepEqual(
      v.staleEntries, [],
      "STALE baseline entries — a site was fixed without lowering its count. The ratchet is " +
        "shrink-only; leaving the count high re-admits the defect.",
    );
    assert.ok(v.ok);
  });

  it("the subject has not vanished — 26 baseline entries, 62 sites, 72 read chains", () => {
    // Pinned, and SHRINK-ONLY in the direction that matters: lowering these
    // because sites were genuinely fixed is expected (update them in the same
    // commit as the baseline), raising them never is. The stale check above
    // catches a fully broken walk; it does not catch a walk that quietly loses
    // SOME of the tree, which is why the totals are written down.
    const b = Object.entries(baseline()).filter(([k]) => !k.startsWith("__"));
    const scan = scanTree();
    assert.equal(b.length, 26, "baseline file::rule entries");
    assert.equal(b.reduce((a, [, n]) => a + n, 0), 62, "baselined sites");
    assert.equal(scan.findings.length, 62, "sites actually found in the tree");
    assert.equal(scan.readSites, 72, "`blocks` read chains in the tree");
    assert.ok(scan.filesScanned >= 1307, `files scanned (${scan.filesScanned})`);
  });

  it("R2, R2b and R3 are held at the counts the baseline records", () => {
    // R2 (three-state) and R3 (empty-without-proof) are at ZERO tree-wide, and
    // the ratchet is what keeps them there: the fixtures above prove the rules
    // FIRE, so a zero here is a measurement and not an absence of instrument.
    const byRule = new Map<string, number>();
    for (const x of scanTree().findings) byRule.set(x.rule, (byRule.get(x.rule) ?? 0) + 1);
    assert.equal(byRule.get("three-state") ?? 0, 0, "no block read flattens its answer before consulting the error");
    assert.equal(byRule.get("empty-without-proof") ?? 0, 0, "no block read concludes emptiness from absent data");
    assert.equal(byRule.get("error-inert") ?? 0, 2, "compass/CompassTools.ts#refreshHiddenUsers, baselined");
    assert.equal(byRule.get("direct-read") ?? 0, 60, "centralisation debt, baselined for burn-down");
  });

  it("the real checker exits 0 against the real tree", () => {
    // The control that carries the weight. The fixtures above prove the
    // scanner's LOGIC; a suite that only ever points a checker at a scratch
    // tree protects nothing, which is the shape checkGuardReachability was
    // written to refuse. No override of any kind is passed here: this spawn
    // reads the repository and the committed baseline.
    const r = runChecker();
    assert.equal(r.status, 0, `${r.stdout ?? ""}${r.stderr ?? ""}`);
    assert.match(String(r.stdout), /no NEW fail-open `blocks` read across \d+ files and \d+ read chains/);
  });

  it("the CLI refuses a vacuous scan rather than reporting success", () => {
    const dir = mkdtempSync(join(tmpdir(), "blockguard-empty-"));
    writeFileSync(join(dir, "nothing.ts"), "export const x = 1;\n");
    const r = runChecker({ BLOCK_FAIL_OPEN_SRC_ROOT: dir });
    assert.equal(r.status, 1, "an empty subject must FAIL, not pass green");
    assert.match(String(r.stderr), /VACUOUS SCAN/);
  });

  it("the CLI fails on a NEW fail-open read introduced into the scanned tree", () => {
    const dir = mkdtempSync(join(tmpdir(), "blockguard-new-"));
    writeFileSync(
      join(dir, "leak.ts"),
      `export async function hidden(sc: any, me: string) {\n` +
        `  const { data } = await sc.from("blocks").select("blocked_id").eq("blocker_id", me);\n` +
        `  return new Set(((data ?? []) as any[]).map((r) => r.blocked_id));\n}\n`,
    );
    const r = runChecker({ BLOCK_FAIL_OPEN_SRC_ROOT: dir, BLOCK_FAIL_OPEN_BASELINE: join(dir, "none.json") });
    assert.equal(r.status, 1);
    const out = `${r.stdout}${r.stderr}`;
    // Vacuity fires too (one file, one read) — both are findings, and the
    // fail-open read must be named rather than hidden behind the floor.
    assert.match(out, /NEW fail-open block-list read/);
    assert.match(out, /leak\.ts:\d+\s+\[(?:direct-read|three-state)\]/);
  });
});
