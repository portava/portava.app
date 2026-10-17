/**
 * privateBlockReadRatchet — census-telegraph T220: "No subsystem may
 * independently rediscover a blocked relationship".
 *
 * node:test + node:assert. Static: reads .ts/.tsx files off disk, no database,
 * no network.
 *
 * ── WHAT THIS HOLDS ─────────────────────────────────────────────────────────
 * The block relationship has definitions of record — lib/exclusionSet.ts
 * (`readBlockExclusions`, `readPairExclusion`, `readGroupBlockExclusions`),
 * lib/blockGuard.ts (`isBlockedBetween`) and lib/blocks.ts (`fetchBlockedSet`).
 * Every one of them answers EVERY failure (a returned error, a thrown read, an
 * answer that is not a row list) with its unreadable value, and
 * blockReadCatchGuard.test.ts holds them to it with no ledger escape.
 *
 * A module that reads `blocks` itself carries its own copy of that rule, and
 * each copy is a place the rule can drift: a destructure that drops `error`, a
 * `?? []`, a `.maybeSingle()` over a mutual block's two rows. On 2026-10-07
 * census-telegraph §54 counted 24 such modules outside the definitions of
 * record. This ratchet counts, per file, every PRIVATE block read and holds the
 * count against ALLOWED below:
 *
 *   NEW      a file not in ALLOWED reads `blocks` itself — use the shared
 *            readers instead (a new private read is red, not a judgement call).
 *   GREW     an allowed file has more private reads than its entry.
 *   SHRANK   an allowed file has FEWER — lower its entry to the new count (and
 *            MAX_TOTAL with it). Shrink-only: a migration that is not recorded
 *            here leaves room for a later read to come back unnoticed.
 *   STALE    an entry whose file no longer reads `blocks` — delete it.
 *   UNREASONED an entry without a reason a reviewer can check.
 *
 * ── WHAT A "PRIVATE BLOCK READ" IS ──────────────────────────────────────────
 * Any `.from("blocks")` call (a read, and also the block list's own writes in
 * routes/blocks.ts — a write is still a module touching the table directly),
 * and any other call that is handed the TABLE NAME "blocks" after its first
 * argument — the client-first shape of a generic table reader,
 * `readWholeColumn(sc, "blocks", …)` in lib/mediaEligibility.ts. "blocks" as a
 * FIRST argument is a label (`failed.push("blocks")`, `degraded.add("blocks")`,
 * the client's `thrownFailure('blocks', e)`), and so is any argument to the
 * collection/logging methods in LABEL_CALLEES. A table name held in a variable,
 * or a reader that takes the table first, is not seen; stated, not implied.
 *
 * The client (travel-buddy-standalone) reads block state through the API only;
 * it is held at ZERO private reads by the same detector.
 *
 * Run: node --import tsx/esm --test src/test/privateBlockReadRatchet.test.ts
 * Print the current counts: PRIVATE_BLOCK_READS_PRINT=1 node --import tsx/esm --test src/test/privateBlockReadRatchet.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SRC = fileURLToPath(new URL("..", import.meta.url));
const CLIENT = fileURLToPath(new URL("../../../../travel-buddy-standalone", import.meta.url));

/** The definitions of record. They ARE the block read; they are never on ALLOWED. */
const DEFINITIONS = new Set(["lib/blockGuard.ts", "lib/blocks.ts", "lib/exclusionSet.ts"]);

/** Methods where a "blocks" argument is a label, not a table name. */
const LABEL_CALLEES = new Set([
  "push", "add", "note", "has", "includes", "delete", "set", "get", "indexOf",
  "log", "warn", "error", "info", "debug", "startsWith", "endsWith", "concat",
]);

/**
 * SHRINK-ONLY. One entry per module that still reads `blocks` itself, with the
 * count and the reason it has not moved onto the shared readers. Lower an entry
 * (and MAX_TOTAL) when a read moves; never raise one.
 *
 * Seeded 2026-10-17 (wave 5) at 72 reads in 25 files; the same wave moved 15
 * modules (40 reads) onto the shared readers, leaving 32 in 13. Every entry
 * left is a semantic the shared readers do not offer — a DIRECTION, a COUNT,
 * one direction only, a key-paged read, a batch coalescer's shape, or a
 * whole-list read whose per-direction cut the one-`.or` whole-list reader would
 * lower — or the block list's own CRUD.
 */
export const ALLOWED: Record<string, { reads: number; reason: string }> = {
  "routes/blocks.ts": { reads: 6, reason: "The block list's own CRUD: the upsert, the delete, GET /me/blocks and /me/blocker-ids (one direction each, by design), and /users/:id/block-status, which answers the two directions separately (iBlocked / theyBlocked)." },
  "routes/admin.ts": { reads: 1, reason: "The moderation dossier COUNTS block rows (count: exact, head: true) for blockCount; the shared readers answer membership, not a row count, and a mutual block is two rows but one counter-party." },
  "routes/follows.ts": { reads: 4, reason: "Four DIRECTIONAL head counts on the two passport handlers (GET /users/:id and its account-state twin): each answers isBlocker true or false, so it needs to know WHICH direction holds the row, and no shared reader returns the direction. A returned error refuses with a 503 (fail-closed)." },
  "routes/compass.ts": { reads: 1, reason: "GET /compass/recommendations?surface=passport reads ONE direction only (blocked_id where blocker_id = the viewer); every shared reader answers both directions, so moving it would widen the filter — a product decision, not a refactor. A returned or thrown failure serves an empty list (fail-closed)." },
  "routes/highlights.ts": { reads: 2, reason: "GET /highlights/active: two whole-list per-direction reads (cut at db-max-rows PER DIRECTION). The candidates are not known until after the read (it scopes the highlights query), and the shared whole-list reader is ONE range-less `.or` read cut at db-max-rows over BOTH directions (census-telegraph §94 found-not-fixed), so moving it would lower the cut. A returned error refuses with db_error (fail-closed)." },
  "routes/memories.ts": { reads: 3, reason: "loadBlockedIds (2): two whole-list per-direction reads, each cut at db-max-rows on its own, feeding a DB-side `.not(owner_id in …)` before any candidate is known; the shared whole-list reader is ONE `.or` read cut at db-max-rows over BOTH directions (census-telegraph §94 found-not-fixed), so moving it would lower the cut. The memory graph (1): count-verified, schema-parsed, row-scoped per-direction batches that refuse on an out-of-scope row — checks the shared reader does not make. Both fail closed (ok:false / 503)." },
  "routes/pulse.ts": { reads: 4, reason: "GET /pulse and /pulse/live: two whole-list per-direction reads each, filtering candidates that are fetched later (events, plans, buddies), so no `among` scope exists at read time; the shared whole-list reader is one `.or` read cut at db-max-rows over BOTH directions (census-telegraph §94 found-not-fixed), so moving them would lower the cut. A returned or thrown failure serves an empty feed or rail (fail-closed)." },
  "compass/CompassFallbackFeedBuilder.ts": { reads: 2, reason: "loadBlockedIds: two whole-list per-direction reads feeding seven category fetchers (no candidate list exists yet); the shared whole-list reader is one `.or` read cut at db-max-rows over BOTH directions (census-telegraph §94 found-not-fixed), so moving it would lower the cut. A returned error throws (fail-closed); a non-list answer still reads as nobody blocked (a gap the shared reader would close)." },
  "compass/CompassProfileService.ts": { reads: 2, reason: "Two DIRECTIONAL whole-list reads inside buildProfile's allSettled: the profile keeps blockedUserIds and blockerUserIds apart (and blockCount), which no shared reader returns; a failure throws (fail-closed)." },
  "compass/CompassTools.ts": { reads: 2, reason: "refreshHiddenUsers: two DIRECTIONAL whole-list reads with a per-direction fallback to the ask-time snapshot; no shared reader keeps the directions apart (fail-closed: snapshot kept, or throw)." },
  "lib/mediaEligibility.ts": { reads: 2, reason: "Two per-direction whole-list reads PAGED by key (readWholeColumn, census-media §47); the shared whole-list reader is one range-less read cut at db-max-rows (census-telegraph §94 found-not-fixed), so moving would re-open the cut." },
  "services/interactionPermissions.ts": { reads: 1, reason: "One pair read through critList that must tell the DIRECTION (iBlocked / theyBlocked / mutual_block labels and canBlock / canUnblock); no shared reader returns the direction. A failure throws (fail-closed)." },
  "services/telegraph/shareables.ts": { reads: 2, reason: "readBlockBetween: two directional `.eq().eq().limit(1)` reads that services/telegraph/coalescedReads.ts COALESCES across a batch of share cards into one `.in().in()` read per direction (census-telegraph T448, \"no N+1\"); readPairExclusion's `.or(and(…))` shape is replayed per card, so moving it would re-open the N+1. Fail-closed: a returned error is `unknown`; a thrown read escapes to the loader." },
};

/** SHRINK-ONLY: the sum of ALLOWED. Raising an entry means raising this, in review. */
export const MAX_TOTAL = 32;
const MIN_REASON = 40;

/** The private block reads in one source text, as the line of each. */
export function privateBlockReads(file: string, text: string): number[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const e = node.expression;
      const name = ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : "";
      const isBlocksLiteral = (a: ts.Expression | undefined) => !!a && ts.isStringLiteralLike(a) && a.text === "blocks";
      const hit = name === "from"
        ? isBlocksLiteral(node.arguments[0])
        : !LABEL_CALLEES.has(name) && node.arguments.some((a, i) => i >= 1 && isBlocksLiteral(a));
      if (hit) lines.push(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return lines;
}

/** Hold per-file counts against the allow-list. */
export function judge(counts: Map<string, number>, allowed: Record<string, { reads: number; reason: string }>, maxTotal: number): string[] {
  const problems: string[] = [];
  for (const [file, n] of [...counts].sort()) {
    if (DEFINITIONS.has(file) || n === 0) continue;
    const entry = allowed[file];
    if (!entry) { problems.push(`NEW      ${file} reads \`blocks\` itself (${n}) — use readBlockExclusions / readPairExclusion (lib/exclusionSet.ts) or isBlockedBetween (lib/blockGuard.ts)`); continue; }
    if (n > entry.reads) problems.push(`GREW     ${file}: ${entry.reads} → ${n} private block reads — a new one goes through the shared readers`);
    if (n < entry.reads) problems.push(`SHRANK   ${file}: ${entry.reads} → ${n} — lower its entry to ${n} and MAX_TOTAL by ${entry.reads - n} (shrink-only)`);
  }
  for (const [file, entry] of Object.entries(allowed)) {
    if (DEFINITIONS.has(file)) problems.push(`DEFINITION ${file} is a definition of record and cannot be on the allow-list`);
    if (!counts.get(file)) problems.push(`STALE    ${file} no longer reads \`blocks\` — delete its entry and lower MAX_TOTAL by ${entry.reads}`);
    if (typeof entry.reason !== "string" || entry.reason.trim().length < MIN_REASON) problems.push(`UNREASONED ${file} — say why this read has not moved onto the shared readers`);
  }
  const sum = Object.values(allowed).reduce((s, e) => s + e.reads, 0);
  if (sum !== maxTotal) problems.push(`TOTAL    the allow-list sums to ${sum} but MAX_TOTAL is ${maxTotal} — they move together, and only down`);
  return problems;
}

function walk(root: string, dir: string, out: string[], skip: (rel: string, name: string) => boolean, exts: RegExp): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const rel = relative(root, p).split(sep).join("/");
    if (skip(rel, name)) continue;
    if (statSync(p).isDirectory()) walk(root, p, out, skip, exts);
    else if (exts.test(name) && !name.endsWith(".d.ts")) out.push(rel);
  }
  return out;
}

const isTestPath = (rel: string, name: string) =>
  name === "node_modules" || rel === "test" || rel.startsWith("test/") || /\.test\.tsx?$/.test(name) || name === "__tests__" || name === "__mocks__";

function scanServer(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const f of walk(SRC, SRC, [], isTestPath, /\.ts$/)) {
    const text = readFileSync(join(SRC, f), "utf8");
    if (!text.includes("blocks")) continue;
    const n = privateBlockReads(f, text).length;
    if (n > 0) counts.set(f, n);
  }
  return counts;
}

function scanClient(): { files: number; reads: string[] } {
  const reads: string[] = [];
  let files = 0;
  for (const dir of ["src", "app", "components", "hooks", "server", "lib", "modules"]) {
    const root = join(CLIENT, dir);
    if (!existsSync(root)) continue;
    for (const f of walk(root, root, [], (rel, name) => isTestPath(rel, name) || name === "e2e", /\.tsx?$/)) {
      files += 1;
      const text = readFileSync(join(root, f), "utf8");
      if (!text.includes("blocks")) continue;
      for (const line of privateBlockReads(f, text)) reads.push(`${dir}/${f}:${line}`);
    }
  }
  return { files, reads };
}

// ── the real tree ─────────────────────────────────────────────────────────────

describe("privateBlockReadRatchet — the real tree", () => {
  const counts = scanServer();

  it("the subject has not vanished: every definition of record still reads `blocks`", () => {
    for (const f of DEFINITIONS) assert.ok((counts.get(f) ?? 0) >= 1, `${f} reads no blocks — the detector or the definition moved`);
    assert.ok(counts.size >= 3, `only ${counts.size} files read blocks`);
  });

  it("no module outside the definitions of record reads `blocks` beyond its shrink-only allowance", () => {
    if (process.env.PRIVATE_BLOCK_READS_PRINT === "1") {
      console.log(JSON.stringify(Object.fromEntries([...counts].filter(([f]) => !DEFINITIONS.has(f)).sort()), null, 2));
    }
    const problems = judge(counts, ALLOWED, MAX_TOTAL);
    assert.deepEqual(problems, [], `\n${problems.join("\n")}\n(allow-list: src/test/privateBlockReadRatchet.test.ts ALLOWED)`);
  });

  it("the client reads block state through the API only — zero private block reads", () => {
    const client = scanClient();
    assert.ok(client.files >= 200, `only ${client.files} client files scanned — the client tree moved`);
    assert.deepEqual(client.reads, []);
  });
});

// ── the detector and the judge against planted violations ─────────────────────

describe("privateBlockReadRatchet — planted violations go red", () => {
  it("counts .from(\"blocks\") in every spelling, and a table-name argument to a reader", () => {
    const src = `
      async function a(sc: any, u: string) {
        await sc.from("blocks").select("blocked_id").eq("blocker_id", u);
        await sc.from('blocks').select("blocker_id").eq("blocked_id", u);
        await sc.from(\`blocks\`).delete().eq("blocker_id", u);
        await readWholeColumn(sc, "blocks", "blocked_id", (q: any) => q.eq("blocker_id", u));
      }`;
    assert.deepEqual(privateBlockReads("x.ts", src).length, 4);
  });

  it("does not count a label, another table, or a shared reader's call", () => {
    const src = `
      async function b(sc: any, u: string, failed: string[], degraded: Set<string>) {
        failed.push("blocks"); degraded.add("blocks"); log.warn("blocks"); thrownFailure("blocks", new Error());
        gemsFailed.note("blocks", new Error()); unread?.add("blocks"); out.failedReads.push("blocks");
        await sc.from("user_mutes").select("muted_id");
        await readBlockExclusions(sc, u);
        await isBlockedBetween(sc, u, "v");
        const blocks = 1; return blocks;
      }`;
    assert.deepEqual(privateBlockReads("y.ts", src), []);
  });

  it("a NEW file, a GROWN entry and an un-lowered SHRUNK entry are each red; the exact allowance is green", () => {
    const allowed = { "routes/a.ts": { reads: 2, reason: "x".repeat(MIN_REASON) } };
    assert.deepEqual(judge(new Map([["routes/a.ts", 2]]), allowed, 2), [], "CONTROL: the exact allowance is green");
    assert.match(judge(new Map([["routes/a.ts", 2], ["routes/b.ts", 1]]), allowed, 2)[0], /^NEW +routes\/b\.ts/);
    assert.match(judge(new Map([["routes/a.ts", 3]]), allowed, 2)[0], /^GREW +routes\/a\.ts: 2 → 3/);
    assert.match(judge(new Map([["routes/a.ts", 1]]), allowed, 2)[0], /^SHRANK +routes\/a\.ts: 2 → 1/);
  });

  it("a STALE entry, an UNREASONED entry, a definition on the list and a TOTAL that does not match are red", () => {
    const why = "x".repeat(MIN_REASON);
    assert.ok(judge(new Map(), { "routes/gone.ts": { reads: 1, reason: why } }, 1).some((p) => /^STALE +routes\/gone\.ts/.test(p)));
    assert.ok(judge(new Map([["routes/a.ts", 1]]), { "routes/a.ts": { reads: 1, reason: "because" } }, 1).some((p) => /^UNREASONED/.test(p)));
    assert.ok(judge(new Map([["lib/blocks.ts", 1]]), { "lib/blocks.ts": { reads: 1, reason: why } }, 1).some((p) => /^DEFINITION/.test(p)));
    assert.ok(judge(new Map([["routes/a.ts", 1]]), { "routes/a.ts": { reads: 1, reason: why } }, 2).some((p) => /^TOTAL/.test(p)));
  });

  it("a definition of record is never NEW, however many reads it holds", () => {
    assert.deepEqual(judge(new Map([["lib/exclusionSet.ts", 7]]), {}, 0), []);
  });
});
