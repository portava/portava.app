#!/usr/bin/env node
//
// apply-edits.mjs — the surgical half of apply-drop2.sh.
//
// Whole-file copies are done in bash, against a sha of the exact pre-state this
// drop was built from. These eleven edits cannot work that way: the files they
// touch are ones your Claude Code is also editing (package.json's `test` script
// is a single ~400-entry line), or ones this clone is known to be behind on
// (checkMediaObjects.ts gained the feed-variant work in c56223a76 after this
// clone was taken). Replacing them wholesale would destroy that work, so each
// edit here is anchored to text, idempotent, and REFUSES when its anchor is not
// where it expects.
//
// Every edit is one of four shapes:
//   BLOCK      insert a guard front-door comment block + side-effect import as
//              the first import in the file, replacing the previous drop's
//              terser block if that is what is there
//   LINESWAP   repoint one import line at the other front door
//   INSERT_PKG add one package.json script key
//   INSERT_SH  add one run_check line + its comment to run-all-checks.sh
//
// Nothing here reads or writes a database, and nothing here runs any of the
// files it edits.

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const STAGE = path.join(ROOT, "_drop2");
const BACKUP = path.join(ROOT, ".drop2-backup");

const RED = (s) => `\x1b[31m${s}\x1b[0m`;
const GRN = (s) => `\x1b[32m${s}\x1b[0m`;
const YLW = (s) => `\x1b[33m${s}\x1b[0m`;

let failures = 0;
let changed = 0;
let skipped = 0;

const fail = (msg, ...more) => {
  console.log(RED(`  x ${msg}`));
  for (const m of more) console.log(`      ${m}`);
  failures++;
};
const ok = (msg) => {
  console.log(GRN(`  + ${msg}`));
  changed++;
};
const same = (msg) => {
  console.log(YLW(`  . ${msg}`));
  skipped++;
};

function backup(rel) {
  const dst = path.join(BACKUP, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (!fs.existsSync(dst)) fs.copyFileSync(path.join(ROOT, rel), dst);
}

function readLines(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8").split("\n");
}
function writeLines(rel, lines) {
  fs.writeFileSync(path.join(ROOT, rel), lines.join("\n"));
}

// The exact six lines the PREVIOUS drop (apply-ci.sh) inserted. If they are
// there, this drop replaces them; that is the normal path.
const PRIOR_BLOCK = [
  "// THE CHOKEPOINT. Side-effect import, deliberately FIRST: it asserts this",
  "// process is pointed at the sanctioned non-production Supabase project",
  "// before any client is constructed. Not skippable by editing workflow YAML.",
  "// See src/lib/ciSupabaseGuard.mjs and docs/ci/BOOTSTRAP.md.",
  'import "../lib/ciSupabaseGuard.mjs";',
  "",
];

const MARKER = "// ── THE ALLOWLIST ASSERTION, IN THE EXECUTION PATH";

const plan = fs
  .readFileSync(path.join(STAGE, "PLAN.tsv"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => l.split("\t"));

// ── BLOCK ────────────────────────────────────────────────────────────────────
function applyBlock(rel, extra) {
  const [blockName, door] = extra.split("|");
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return fail(`missing, cannot guard: ${rel}`);

  const block = fs.readFileSync(path.join(STAGE, "blocks", blockName), "utf8");
  const finalImport =
    door === "strict"
      ? 'import "../lib/ciSupabaseGuard.mjs";'
      : 'import "../lib/ciProdReadOnlyAuditGuard.mjs";';

  let lines = readLines(rel);

  if (lines.some((l) => l.startsWith(MARKER)) && lines.includes(finalImport)) {
    return same(`already applied: ${path.basename(rel)}`);
  }

  // Locate the previous drop's block, verbatim.
  let priorAt = -1;
  for (let i = 0; i + PRIOR_BLOCK.length <= lines.length; i++) {
    if (PRIOR_BLOCK.every((p, j) => lines[i + j] === p)) {
      priorAt = i;
      break;
    }
  }

  const hasSomeGuardImport = lines.some(
    (l) =>
      l.trim() === 'import "../lib/ciSupabaseGuard.mjs";' ||
      l.trim() === 'import "../lib/ciProdReadOnlyAuditGuard.mjs";'
  );

  if (priorAt >= 0) {
    backup(rel);
    lines.splice(priorAt, PRIOR_BLOCK.length);
  } else if (hasSomeGuardImport) {
    return fail(
      `${rel}: a guard import is present but not in the shape this drop expects`,
      "Neither this drop's block nor the previous drop's block matches verbatim.",
      `Merge by hand from _drop2/blocks/${blockName} — it must end up as the`,
      "FIRST import in the file, above @supabase/supabase-js. Nothing else changed."
    );
  } else {
    backup(rel);
  }

  // Anchor: the guard has to be the first import. If the file has no import at
  // all (checkMediaObjects.ts had none before this work), fall back to the
  // `export {};` that gives it module scope.
  let at = lines.findIndex((l) => /^import\s/.test(l));
  if (at < 0) {
    at = lines.findIndex((l) => l === "export {};");
    // `export {};` usually carries a comment explaining why it is there. The
    // guard has to go ABOVE that comment, not between it and the statement it
    // explains, so walk back over the contiguous comment lines first.
    while (at > 0 && lines[at - 1].startsWith("//")) at--;
  }
  if (at < 0) {
    return fail(
      `${rel}: no top-level import and no 'export {};' — refusing to guess a position`,
      `Insert _drop2/blocks/${blockName} by hand, as the first statement.`
    );
  }

  lines.splice(at, 0, ...block.replace(/\n$/, "").split("\n"));
  writeLines(rel, lines);
  ok(
    `${path.basename(rel)} -> ${door} front door` +
      (priorAt >= 0 ? " (replaced the previous drop's block)" : " (inserted)")
  );
}

// ── the checkMediaObjects comment swap: cosmetic, never fatal ────────────────
function mediaObjectsCommentSwap() {
  const rel = "artifacts/api-server/src/scripts/checkMediaObjects.ts";
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return;
  const oldTxt = fs.readFileSync(
    path.join(STAGE, "blocks/checkMediaObjects.comment.old"),
    "utf8"
  );
  const newTxt = fs.readFileSync(
    path.join(STAGE, "blocks/checkMediaObjects.comment.new"),
    "utf8"
  );
  const cur = fs.readFileSync(abs, "utf8");
  if (cur.includes(newTxt)) return;
  if (!cur.includes(oldTxt)) {
    console.log(
      YLW(
        "  . checkMediaObjects.ts: the comment above `export {};` is not the one this"
      )
    );
    console.log(
      "      drop rewrote, so it was left alone. Cosmetic only — the guard import"
    );
    console.log("      above it is what matters, and that was applied.");
    return;
  }
  backup(rel);
  fs.writeFileSync(abs, cur.replace(oldTxt, newTxt));
  console.log(GRN("  + checkMediaObjects.ts: refreshed the `export {};` rationale"));
}

// ── LINESWAP ─────────────────────────────────────────────────────────────────
function applyLineSwap(rel, extra) {
  const [from, to] = extra.split("|");
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) {
    return fail(
      `missing: ${rel}`,
      "It ships in the PREVIOUS drop (ci-drop.zip). Apply that first."
    );
  }
  const lines = readLines(rel);
  if (lines.includes(to)) return same(`already repointed: ${path.basename(rel)}`);
  const n = lines.filter((l) => l === from).length;
  if (n !== 1) {
    return fail(
      `${rel}: expected exactly one \`${from}\`, found ${n}`,
      `Repoint it at \`${to}\` by hand.`
    );
  }
  backup(rel);
  writeLines(rel, lines.map((l) => (l === from ? to : l)));
  ok(`${path.basename(rel)} -> read-only front door`);
}

// ── INSERT_PKG ───────────────────────────────────────────────────────────────
function applyInsertPkg(rel, blockName) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return fail(`missing: ${rel}`);
  const insert = fs
    .readFileSync(path.join(STAGE, "blocks", blockName), "utf8")
    .replace(/\n$/, "");
  const lines = readLines(rel);
  if (lines.some((l) => l.includes('"check:guard-coverage"'))) {
    return same("package.json already has check:guard-coverage");
  }
  let at = lines.findIndex((l) => l.includes('"check:test-registration":'));
  if (at < 0) at = lines.findIndex((l) => l.includes('"check:all":'));
  if (at < 0) {
    return fail(
      "package.json: no anchor script key found — refusing to guess",
      "Add this line inside the top-level \"scripts\" object, by hand:",
      insert.trim()
    );
  }
  backup(rel);
  const next = [...lines];
  next.splice(at + 1, 0, insert);
  const text = next.join("\n");
  try {
    JSON.parse(text);
  } catch (e) {
    return fail(
      "package.json: the one-key insert did not parse as JSON — NOT written",
      String(e.message),
      "Nothing was changed. Add this line by hand: " + insert.trim()
    );
  }
  fs.writeFileSync(abs, text);
  ok(`package.json: added check:guard-coverage after line ${at + 1}`);
}

// ── INSERT_SH ────────────────────────────────────────────────────────────────
function applyInsertSh(rel, blockName) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return fail(`missing: ${rel}`);
  const insert = fs
    .readFileSync(path.join(STAGE, "blocks", blockName), "utf8")
    .replace(/\n$/, "")
    .split("\n");
  const lines = readLines(rel);
  if (lines.some((l) => l.includes("check:guard-coverage"))) {
    return same("run-all-checks.sh already runs check:guard-coverage");
  }
  const at = lines.findIndex(
    (l) => l.trim() === 'run_check "check:frozen-dir" pnpm run check:frozen-dir'
  );
  if (at < 0) {
    return fail(
      "run-all-checks.sh: the check:frozen-dir anchor is gone — refusing to guess",
      "Add these lines by hand, wherever the other run_check calls are:",
      ...insert
    );
  }
  backup(rel);
  const next = [...lines];
  next.splice(at, 0, ...insert);
  writeLines(rel, next);
  ok(`run-all-checks.sh: check:guard-coverage inserted before check:frozen-dir`);
}

// ── drive ────────────────────────────────────────────────────────────────────
console.log("-- anchored, idempotent edits --");
for (const [kind, rel, extra] of plan) {
  if (kind === "BLOCK") applyBlock(rel, extra);
  else if (kind === "LINESWAP") applyLineSwap(rel, extra);
}
mediaObjectsCommentSwap();
for (const [kind, rel, extra] of plan) {
  if (kind === "INSERT_PKG") applyInsertPkg(rel, extra);
  else if (kind === "INSERT_SH") applyInsertSh(rel, extra);
}

console.log(`  ${changed} edited, ${skipped} already in place, ${failures} refused`);
process.exit(failures === 0 ? 0 : 1);
