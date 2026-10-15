/**
 * blockReadCatchGuard — a THROWN block read cannot quietly become "nobody is
 * blocked" (census-telegraph §94).
 *
 * node:test + node:assert. Static: reads .ts files off disk, no database, no
 * network. Runs in api-server-tests through the package `test` script.
 *
 * ── THE DEFECT CLASS ────────────────────────────────────────────────────────
 * `blocks` is an exclusion table: a ROW means DENY, so EMPTINESS means ALLOW.
 * The repo's read guards (check:silent-supabase-reads, check:unchecked-supabase-
 * reads) are about the RETURNED failure: supabase-js resolves `{ data, error }`,
 * so a `catch` around a read is dead code for a database error, and those guards
 * say so. That thesis leaves one door open: a read can still THROW — a torn-down
 * or misconfigured client, a builder bug, a fetch that rejects, a helper that
 * lets an exception out — and then the `catch` is the ONLY thing that decides
 * whether the blocked person is shown. On 2026-10-14 a verifier replaced the
 * catch in services/telegraph/identityAcrossBlocks.ts with "nobody is blocked"
 * and every suite stayed green (V-RH, mutant V6): nothing in the tree looked at
 * what a catch around a block read answers.
 *
 * ── WHAT THIS GUARD DOES ────────────────────────────────────────────────────
 * It finds every place a thrown block read can LAND — a `try` whose block holds
 * a block read, a `.catch(…)` chained on one, a `Promise.allSettled` over one —
 * and holds each against a committed ledger (src/scripts/BLOCK_READ_CATCHES.json)
 * that records, per site, HOW it is closed and WHY, plus a fingerprint of the
 * handler's code (comments removed, reprinted):
 *
 *   NEW      a site with no entry           — someone wrote a catch around a
 *                                              block read; judge it.
 *   CHANGED  a fingerprint that moved       — the handler's code changed; judge
 *                                              it again (V6 is exactly this).
 *   STALE    an entry with no site          — remove it.
 *   UNJUDGED an entry whose `closedBy` is not one of CLOSED_BY, or whose `why`
 *            is too short to be a reason.
 *
 * It does not decide direction by itself — `catch { blocked = false }` and
 * `catch { return [] }` read alike and mean opposite things — so it forces the
 * judgement to be written down and re-made on every edit, which is what was
 * missing. ONE rule needs no judgement and has no ledger escape (THE READERS):
 * the definitions of record must answer a thrown read with their unreadable
 * value — `readBlockExclusions` / `readPairExclusion` / `readGroupBlockExclusions`
 * `exclusionsUnavailable(…)`, `isBlockedBetween` `true`, `fetchBlockedSet` `null`.
 *
 * ── WHAT A "BLOCK READ" IS ──────────────────────────────────────────────────
 * `.from("blocks")`, or a call to one of READERS (the shared helpers whose
 * answer IS block state). A read reached through some other function is judged
 * where that function reads; there is no cross-function analysis, so a `try`
 * around a caller of a caller is not seen. Stated, not implied.
 *
 * Run: node --import tsx/esm --test src/test/blockReadCatchGuard.test.ts
 * Re-seed the fingerprints after a JUDGED change:
 *      BLOCK_READ_CATCHES_PRINT=1 node --import tsx/esm --test src/test/blockReadCatchGuard.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import ts from "typescript";

const SRC = fileURLToPath(new URL("..", import.meta.url));
const LEDGER_PATH = join(SRC, "scripts", "BLOCK_READ_CATCHES.json");

/** The shared helpers whose answer IS block state. */
const READERS = new Set([
  "isBlockedBetween", "fetchBlockedSet",
  "readBlockExclusions", "readPairExclusion", "readGroupBlockExclusions",
  "identityWithheldAcrossBlocks", "readerFacesFor",
  "withheldLocationIds", "withholdLocationAcrossBlocks", "dropBlockedSenders",
  "readBlockDirection", // §98: one direction of a block list, keyset-paged; a thrown read still rejects into the caller's catch
]);

/** How a site is closed. Each value says what a thrown block read turns into there. */
const CLOSED_BY = new Set([
  "rethrows",              // the failure propagates; the caller (or a 5xx) answers
  "answers-unreadable",    // the unreadable sentinel its callers treat fail-closed (ok:false, null, a failed flag)
  "refuses",               // an error / refusal response, or a refusal object
  "withholds",             // the block-scoped part is served empty or withheld — nobody shown
  "denies",                // the gate answers blocked / not allowed
  "falls-through-to-deny", // control continues to a deny
  "keeps-snapshot",        // keeps an earlier block list; never widens it
  "open-known",            // KNOWINGLY OPEN: recorded, cites where it was reported, held by OPEN_KNOWN_MAX
]);
const MIN_WHY = 40;
/**
 * Sites recorded as knowingly OPEN. SHRINK-ONLY: lower it when one is closed,
 * never raise it. 1 on 2026-10-14 — GET /discovery/feed's event posts, whose
 * block filter is empty when the block read fails or throws: a documented
 * posture reported to the lead as a product decision
 * (docs/verification/privacy-authorization.md §5, open item 3).
 */
const OPEN_KNOWN_MAX = 1;

export interface CatchSite {
  key: string;
  kind: "catch" | "chained-catch" | "allSettled";
  reads: string[];
  fingerprint: string;
}
export interface LedgerEntry {
  key: string;
  kind: string;
  reads: string[];
  fingerprint: string;
  closedBy: string;
  why: string;
}

const PRINTER = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });

function fingerprintOf(node: ts.Node, sf: ts.SourceFile): string {
  const text = PRINTER.printNode(ts.EmitHint.Unspecified, node, sf).replace(/\s+/g, " ").trim();
  return createHash("sha1").update(text).digest("hex").slice(0, 16);
}

function calleeName(call: ts.CallExpression): string {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return "";
}

function isBlockRead(node: ts.Node): string | null {
  if (!ts.isCallExpression(node)) return null;
  const name = calleeName(node);
  if (READERS.has(name)) return name;
  const a = node.arguments[0];
  if (name === "from" && a && ts.isStringLiteralLike(a) && a.text === "blocks") return 'from("blocks")';
  return null;
}

/** The name a reviewer would look for: the nearest named function, or the route it is registered on. */
function ownerName(node: ts.Node, sf: ts.SourceFile): string {
  for (let p: ts.Node | undefined = node; p; p = p.parent) {
    if ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) && p.name) return p.name.getText(sf);
    if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p))) {
      const par = p.parent;
      if (par && ts.isVariableDeclaration(par) && ts.isIdentifier(par.name)) return par.name.text;
      if (par && ts.isPropertyAssignment(par)) return par.name.getText(sf);
      // router.get("/path", asyncHandler(async (req, res) => …)) → "get /path"
      for (let q: ts.Node | undefined = par; q && !ts.isSourceFile(q); q = q.parent) {
        if (ts.isCallExpression(q) && ts.isPropertyAccessExpression(q.expression)) {
          const verb = q.expression.name.text;
          const first = q.arguments[0];
          if (/^(get|post|put|patch|delete|use|all)$/.test(verb) && first && ts.isStringLiteralLike(first)) return `${verb} ${first.text}`;
        }
      }
    }
  }
  return "<module>";
}

function throwsAgain(clause: ts.CatchClause): boolean {
  let found = false;
  const walk = (n: ts.Node): void => {
    if (found || ts.isFunctionLike(n)) return;
    if (ts.isThrowStatement(n)) { found = true; return; }
    ts.forEachChild(n, walk);
  };
  walk(clause.block);
  return found;
}

/** Every place a thrown block read can land, in one source file. */
export function findBlockReadCatches(file: string, text: string): CatchSite[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const byNode = new Map<ts.Node, { kind: CatchSite["kind"]; reads: Set<string> }>();
  const note = (n: ts.Node, kind: CatchSite["kind"], read: string) => {
    const s = byNode.get(n) ?? { kind, reads: new Set<string>() };
    s.reads.add(read);
    byNode.set(n, s);
  };
  const visit = (node: ts.Node): void => {
    const read = isBlockRead(node);
    if (read) {
      let child: ts.Node = node;
      let wantTry = true;
      for (let p: ts.Node | undefined = node.parent; p; child = p, p = p.parent) {
        if (wantTry && ts.isTryStatement(p) && p.tryBlock === child && p.catchClause) {
          note(p.catchClause, "catch", read);
          wantTry = throwsAgain(p.catchClause); // a rethrow hands the failure to the next try out
        }
        if (ts.isCallExpression(p) && ts.isPropertyAccessExpression(p.expression) && p.expression.name.text === "catch"
            && p.expression === child && p.arguments[0]) { // the read is in the receiver, not in the handler
          note(p.arguments[0], "chained-catch", read);
        }
        if (ts.isCallExpression(p) && /(^|\.)allSettled$/.test(p.expression.getText(sf))) note(p, "allSettled", read);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  const sites = [...byNode.entries()]
    .map(([n, s]) => ({ n, s, owner: ownerName(n, sf), pos: n.getStart(sf) }))
    .sort((a, b) => a.pos - b.pos);
  const seen = new Map<string, number>();
  return sites.map(({ n, s, owner }) => {
    const base = `${file}::${owner}::${s.kind}`;
    const i = (seen.get(base) ?? 0) + 1;
    seen.set(base, i);
    return { key: `${base}#${i}`, kind: s.kind, reads: [...s.reads].sort(), fingerprint: fingerprintOf(n, sf) };
  });
}

export interface Verdict { problems: string[]; sites: CatchSite[] }

/** Hold the sites against the ledger. */
export function decide(sites: CatchSite[], ledger: LedgerEntry[]): string[] {
  const problems: string[] = [];
  const byKey = new Map(ledger.map((e) => [e.key, e]));
  const siteKeys = new Set(sites.map((s) => s.key));
  for (const s of sites) {
    const e = byKey.get(s.key);
    if (!e) { problems.push(`NEW      ${s.key} (${s.reads.join(", ")}) fingerprint ${s.fingerprint} — a thrown block read lands here; judge what it answers and add it to the ledger`); continue; }
    if (e.fingerprint !== s.fingerprint) problems.push(`CHANGED  ${s.key} — the handler's code moved (${e.fingerprint} → ${s.fingerprint}); re-judge "${e.closedBy}" and update the entry`);
  }
  for (const e of ledger) {
    if (!siteKeys.has(e.key)) problems.push(`STALE    ${e.key} — no such site any more; remove the entry`);
    if (!CLOSED_BY.has(e.closedBy)) problems.push(`UNJUDGED ${e.key} — closedBy "${e.closedBy}" is not one of ${[...CLOSED_BY].join(" | ")}`);
    if (typeof e.why !== "string" || e.why.trim().length < MIN_WHY) problems.push(`UNJUDGED ${e.key} — "why" must say what the site answers when the read throws`);
    if (e.closedBy === "open-known" && !/docs\//.test(e.why ?? "")) problems.push(`UNJUDGED ${e.key} — an open-known site must cite the docs/ page where it was reported`);
  }
  const open = ledger.filter((e) => e.closedBy === "open-known").length;
  if (open > OPEN_KNOWN_MAX) problems.push(`OPEN     ${open} sites are recorded as knowingly open; the most allowed is ${OPEN_KNOWN_MAX} (shrink-only) — close the new one instead`);
  return problems;
}

/** THE READERS: the definitions of record answer a thrown read with their unreadable value. No ledger escape. */
export const READER_RULES: Array<{ file: string; fn: string; catchMust: RegExp; says: string }> = [
  { file: "lib/exclusionSet.ts", fn: "readBlockExclusions", catchMust: /^return exclusionsUnavailable\(err\);?$/, says: "return exclusionsUnavailable(err)" },
  { file: "lib/exclusionSet.ts", fn: "readPairExclusion", catchMust: /^return exclusionsUnavailable\(err\);?$/, says: "return exclusionsUnavailable(err)" },
  { file: "lib/exclusionSet.ts", fn: "readGroupBlockExclusions", catchMust: /^return exclusionsUnavailable\(err\);?$/, says: "return exclusionsUnavailable(err)" },
  { file: "lib/blockGuard.ts", fn: "isBlockedBetween", catchMust: /^return deniedAfterThrow\(\);?$/, says: "return deniedAfterThrow() (which returns true)" },
  { file: "lib/blocks.ts", fn: "fetchBlockedSet", catchMust: /^return null;?$/, says: "return null" },
];

export function checkReaders(read: (file: string) => string): string[] {
  const problems: string[] = [];
  for (const rule of READER_RULES) {
    const sf = ts.createSourceFile(rule.file, read(rule.file), ts.ScriptTarget.Latest, true);
    let fn: ts.FunctionDeclaration | undefined;
    sf.forEachChild((n) => { if (ts.isFunctionDeclaration(n) && n.name?.text === rule.fn) fn = n; });
    if (!fn?.body) { problems.push(`READER   ${rule.file}#${rule.fn} — not found`); continue; }
    // Every block read in the function must sit in a try whose catch answers the unreadable value.
    const reads: ts.Node[] = [];
    const collect = (n: ts.Node): void => { if (isBlockRead(n) || (ts.isCallExpression(n) && /Once$/.test(calleeName(n)))) reads.push(n); ts.forEachChild(n, collect); };
    collect(fn.body);
    if (reads.length === 0) { problems.push(`READER   ${rule.file}#${rule.fn} — reads no blocks (the rule's subject vanished)`); continue; }
    for (const r of reads) {
      let ok = false;
      let child: ts.Node = r;
      for (let p: ts.Node | undefined = r.parent; p && p !== fn; child = p, p = p.parent) {
        if (ts.isTryStatement(p) && p.tryBlock === child && p.catchClause) {
          const body = p.catchClause.block.statements.map((s) => PRINTER.printNode(ts.EmitHint.Unspecified, s, sf).replace(/\s+/g, " ").trim()).join(" ");
          ok = rule.catchMust.test(body);
          break;
        }
      }
      if (!ok) problems.push(`READER   ${rule.file}#${rule.fn} — a block read at line ${sf.getLineAndCharacterOfPosition(r.getStart(sf)).line + 1} is not inside a try whose catch is exactly \`${rule.says}\``);
    }
  }
  if (!/function deniedAfterThrow\(\): true \{[^}]*return true;/.test(read("lib/blockGuard.ts"))) {
    problems.push("READER   lib/blockGuard.ts#deniedAfterThrow — must return true (deny) on a thrown read");
  }
  return problems;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const rel = relative(SRC, p).split(sep).join("/");
    if (rel === "test" || rel === "scripts" || name === "node_modules") continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(rel);
  }
  return out;
}

function scanTree(): { files: number; reads: number; sites: CatchSite[] } {
  const files = walk(SRC);
  let reads = 0;
  const sites: CatchSite[] = [];
  for (const f of files) {
    const text = readFileSync(join(SRC, f), "utf8");
    if (!/blocks|isBlockedBetween|fetchBlockedSet|Exclusion|AcrossBlocks|BlockedSenders|readerFacesFor|withheldLocationIds|readBlockDirection/.test(text)) continue;
    const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true);
    const count = (n: ts.Node): void => { if (isBlockRead(n)) reads += 1; ts.forEachChild(n, count); };
    count(sf);
    sites.push(...findBlockReadCatches(f, text));
  }
  return { files: files.length, reads, sites };
}

function loadLedger(): LedgerEntry[] {
  return (JSON.parse(readFileSync(LEDGER_PATH, "utf8")) as { sites: LedgerEntry[] }).sites;
}

// ── the real tree ─────────────────────────────────────────────────────────────

describe("blockReadCatchGuard — the real tree", () => {
  const tree = scanTree();

  it("the subject has not vanished (a scan that finds nothing is not a pass)", () => {
    assert.ok(tree.files >= 1000, `only ${tree.files} source files scanned`);
    assert.ok(tree.reads >= 100, `only ${tree.reads} block reads found`);
    assert.ok(tree.sites.length >= 30, `only ${tree.sites.length} catch sites found`);
  });

  it("every place a thrown block read can land is judged in the ledger, and no judgement is stale", () => {
    if (process.env.BLOCK_READ_CATCHES_PRINT === "1") console.log(JSON.stringify(tree.sites, null, 2));
    const problems = decide(tree.sites, loadLedger());
    assert.deepEqual(problems, [], `\n${problems.join("\n")}\n(ledger: src/scripts/BLOCK_READ_CATCHES.json)`);
  });

  it("THE READERS answer a thrown read with their unreadable value — no ledger escape", () => {
    const problems = checkReaders((f) => readFileSync(join(SRC, f), "utf8"));
    assert.deepEqual(problems, []);
  });
});

// ── the guard against planted violations ──────────────────────────────────────

describe("blockReadCatchGuard — planted violations go red", () => {
  const helper = (catchBody: string) => `
    export async function identityWithheldAcrossBlocks(sc: any, viewerId: string, ids: string[]) {
      let set: any;
      try { set = await readBlockExclusions(sc, viewerId, { among: ids }); }
      catch (err) { ${catchBody} }
      return set;
    }`;

  it("a NEW catch around a block read, defaulting open, is red until judged", () => {
    const src = `export async function canSee(sc: any, a: string, b: string) {
      let blocked = false;
      try { blocked = await isBlockedBetween(sc, a, b); } catch { blocked = false; }
      return !blocked;
    }`;
    const sites = findBlockReadCatches("routes/planted.ts", src);
    assert.equal(sites.length, 1);
    const problems = decide(sites, []);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /^NEW +routes\/planted\.ts::canSee::catch#1 \(isBlockedBetween\)/);
  });

  it("V6 exactly: the identity helper's catch turned into 'nobody is blocked' is CHANGED", () => {
    const closed = findBlockReadCatches("services/telegraph/x.ts", helper("set = { ok: false, reason: String(err) };"));
    const ledger: LedgerEntry[] = closed.map((s) => ({ ...s, closedBy: "answers-unreadable", why: "an unreadable set withholds every other identity, by isExcluded" }));
    assert.deepEqual(decide(closed, ledger), [], "CONTROL: the judged catch is green");
    const opened = findBlockReadCatches("services/telegraph/x.ts", helper("set = { ok: true, ids: new Set() };"));
    const problems = decide(opened, ledger);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /^CHANGED /);
  });

  it("a comment-only edit is NOT a change; a code edit is", () => {
    const a = findBlockReadCatches("f.ts", helper("set = { ok: false, reason: String(err) };"));
    const b = findBlockReadCatches("f.ts", helper("// a new comment\n set = { ok: false,   reason: String(err) }; /* another */"));
    assert.equal(a[0].fingerprint, b[0].fingerprint);
  });

  it("a ledger entry whose site is gone is STALE; an unjudged entry is UNJUDGED", () => {
    const stale: LedgerEntry = { key: "gone.ts::f::catch#1", kind: "catch", reads: ["isBlockedBetween"], fingerprint: "0", closedBy: "denies", why: "x".repeat(MIN_WHY) };
    assert.match(decide([], [stale])[0], /^STALE /);
    const sites = findBlockReadCatches("f.ts", helper("set = { ok: false, reason: String(err) };"));
    const lazy = sites.map((s) => ({ ...s, closedBy: "fine", why: "ok" }));
    const problems = decide(sites, lazy);
    assert.ok(problems.some((p) => /closedBy "fine"/.test(p)));
    assert.ok(problems.some((p) => /"why" must say/.test(p)));
  });

  it("a NEW knowingly-open site cannot be recorded past the shrink-only count, and must cite where it was reported", () => {
    const sites = findBlockReadCatches("f.ts", helper("set = { ok: true, ids: new Set() };"));
    const one = sites.map((s) => ({ ...s, closedBy: "open-known", why: "x".repeat(MIN_WHY) }));
    assert.ok(decide(sites, one).some((p) => /must cite the docs\/ page/.test(p)));
    const extra: LedgerEntry[] = Array.from({ length: OPEN_KNOWN_MAX + 1 }, (_, i) => ({
      key: `g${i}.ts::f::catch#1`, kind: "catch", reads: ["fetchBlockedSet"], fingerprint: "0", closedBy: "open-known",
      why: "reported in docs/verification/privacy-authorization.md as a product decision",
    }));
    assert.ok(decide([], extra).some((p) => /^OPEN +/.test(p)));
  });

  it("a rethrowing catch hands the read to the next try out, which must be judged too", () => {
    const src = `async function f(sc: any) {
      try { try { await fetchBlockedSet(sc, "u"); } catch (e) { log(e); throw e; } } catch { return []; }
    }`;
    const sites = findBlockReadCatches("f.ts", src);
    assert.equal(sites.length, 2, JSON.stringify(sites));
  });

  it("a .catch(…) chained on a block read, and an allSettled over one, are sites", () => {
    const src = `async function f(sc: any) {
      const a = await isBlockedBetween(sc, "a", "b").catch(() => false);
      const r = await Promise.allSettled([sc.from("blocks").select("blocked_id").eq("blocker_id", "u")]);
      return [a, r];
    }`;
    const kinds = findBlockReadCatches("f.ts", src).map((s) => s.kind).sort();
    assert.deepEqual(kinds, ["allSettled", "chained-catch"]);
  });

  it("THE READERS: a reader that lost its try, or whose catch answers open, is red with no ledger escape", () => {
    const real = (f: string) => readFileSync(join(SRC, f), "utf8");
    const noTry = (f: string) => f === "lib/exclusionSet.ts"
      ? real(f).replace(/return await readBlockExclusionsOnce\(sc, viewerId, opts\?\.among\);/, "return exclusions([]);")
      : real(f);
    assert.ok(checkReaders(noTry).some((p) => /readBlockExclusions — (reads no blocks|a block read)/.test(p)), "a reader with no read under its try passed");
    const open = (f: string) => f === "lib/exclusionSet.ts"
      ? real(f).replace(/\} catch \(err\) \{\n(\s*)return exclusionsUnavailable\(err\);\n(\s*)\}\n\}\n\nasync function readBlockExclusionsOnce/, "} catch (err) {\n$1return exclusions([]);\n$2}\n}\n\nasync function readBlockExclusionsOnce")
      : real(f);
    assert.notEqual(open("lib/exclusionSet.ts"), real("lib/exclusionSet.ts"), "the planted edit did not apply");
    assert.ok(checkReaders(open).some((p) => /readBlockExclusions — a block read/.test(p)), "a reader whose catch answers 'nobody is blocked' passed");
    const guardOpen = (f: string) => f === "lib/blockGuard.ts"
      ? real(f).replace("return deniedAfterThrow(); }", "return false; }")
      : real(f);
    assert.notEqual(guardOpen("lib/blockGuard.ts"), real("lib/blockGuard.ts"), "the planted edit did not apply");
    assert.ok(checkReaders(guardOpen).some((p) => /isBlockedBetween/.test(p)), "isBlockedBetween answering false on a throw passed");
    const helperOpen = (f: string) => f === "lib/blockGuard.ts"
      ? real(f).replace(/function deniedAfterThrow\(\): true \{([^}]*)return true;/, "function deniedAfterThrow(): true {$1return false as true;")
      : real(f);
    assert.ok(checkReaders(helperOpen).some((p) => /deniedAfterThrow/.test(p)));
    assert.deepEqual(checkReaders(real), [], "CONTROL: the real readers pass");
  });
});
