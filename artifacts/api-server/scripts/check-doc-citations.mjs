#!/usr/bin/env node
/**
 * check-doc-citations.mjs
 *
 * Turns "the docs cite the code accurately" from a claim into an executable.
 *
 * Run from anywhere (the repo root is derived from this file's own location):
 *
 *     node artifacts/api-server/scripts/check-doc-citations.mjs
 *
 * WHY THIS EXISTS
 * ===============
 * docs/discovery/ROADMAP.md carries its own rule — "maintain this table in the
 * same PR as the work" — and the reconciliation of 2026-09-05 exists because
 * that rule was broken for seven PRs. The reconciliation replaced prose claims
 * with `path/file.ts:NNN` citations, which is the right move and also creates a
 * new decay path: a citation is a claim about a line number, and line numbers
 * move whenever anything above them is edited. The very PR that wrote the
 * reconciliation invalidated one of its own citations by inserting three lines
 * into the file it cited, in the same diff.
 *
 * A citation nobody can execute is prose with extra precision.
 *
 * THIS IS THE check-memory-citations.mjs PATTERN, APPLIED OUTSIDE .agents/
 * =======================================================================
 * artifacts/api-server/scripts/check-memory-citations.mjs already does the
 * range half of this over .agents/memory/. It is deliberately NOT widened here:
 * it owns a corpus with its own index, frontmatter and unindexed-entry checks,
 * and its vacuity guards are phrased in terms of that corpus. This script
 * borrows its citation grammar (including the inherited `:NNN` continuation)
 * and adds the half that catches a MOVED line, which a range check cannot:
 *
 *   RANGE   — the cited file exists in the repo and has at least NNN lines.
 *             Catches deleted files, renamed files, truncations, typos.
 *
 *   ANCHOR  — the OPT-IN half, written `path/file.ts:209-216#needle`. The
 *             literal text `needle` must be on the range's FIRST line, 209.
 *             This is the half that goes red when code moves: a range check
 *             cannot notice that an entry slid from 205-213 to 208-216 inside
 *             an 1115-line file, because both ranges are in range. First-line
 *             rather than contains-anywhere for the reason spelled out at
 *             anchorHolds() — a three-line shift leaves every token of a
 *             nine-line entry still inside the stale window.
 *
 * The anchor form is opt-in per citation, and that is a deliberate limit rather
 * than an oversight: an anchor asserts something specific and true, and one
 * invented to satisfy a checker would be worse than no anchor. Anchors are
 * added where a citation is load-bearing — where a reader would act on it.
 *
 * WHAT IS COVERED
 * ===============
 * COVERED below, and only that. This is a registry, not a glob over the whole
 * tree: every entry is a file whose citations someone has actually read and
 * vouched for. A glob would sweep in hundreds of unvetted citations, go red on
 * day one, and a permanently-red check is one `|| true` away from being no
 * check at all.
 *
 * KNOWN, NOT ADOPTED — say it here rather than let it be rediscovered.
 * The whole of docs/architecture/ was the intended second corpus. It is not
 * covered because running this over it finds 17 out-of-range citations in ONE
 * file, docs/architecture/wall-certification.md — every one of them a
 * `WallObjectRenderer.tsx:216`-style number pointing past the end of a file
 * that has since shrunk (216/329/444 into a 131-line file; LiveForYouService.ts
 * :700-705, :675-686, :770-778 into a 465-line file; four *.test.ts citations
 * past their file's end). Those are real findings and they belong to the Wall
 * unit, not to this one. Adopting that file here would ship a red check that
 * this PR cannot honestly fix, so the two architecture files this unit does
 * vouch for are named individually instead, and the finding is recorded here
 * for whoever opens the Wall certification next.
 *
 * Exit codes:
 *   0  clean
 *   1  one or more citations failed (per-category counts printed)
 *   2  the checker itself could not run honestly — a covered path is missing,
 *      zero citations were extracted, the repo index is empty, or the anchored
 *      floor is breached. A checker that exits 0 because it found nothing is
 *      the failure mode this guards against.
 *
 * Zero dependencies. Reads only; never writes, never touches a database.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(import.meta.url);
// artifacts/api-server/scripts/<this file>  ->  repo root
const REPO_ROOT = path.resolve(path.dirname(SCRIPT), '..', '..', '..');

// ---------------------------------------------------------------------------
// COVERED — the registry of files whose citations are enforced.
//
// A directory entry covers every *.md directly inside it (not recursively:
// a nested directory is a different corpus and gets its own decision).
// A file entry covers exactly that file, whatever its extension — source
// comments carry file:line citations too, and they go stale the same way.
// ---------------------------------------------------------------------------
export const COVERED = [
  {
    // The unit that produced this checker. Its status table is the thing the
    // "maintain it in the same PR" rule is about, and its reconciliation is
    // built entirely out of citations.
    dir: 'docs/discovery',
  },
  {
    // The defect list, refreshed as defects close; each entry cites its fix.
    file: 'docs/architecture/00_STATUS.md',
  },
  {
    // The Discovery Engine spec the ROADMAP reconciles against.
    file: 'docs/architecture/01_Portava_Discovery_Engine.md',
  },
  {
    // Source, not documentation — and covered for exactly the reason the docs
    // are. This module's header explains WHY `served: false` must replace the
    // Supabase client rather than gate this module's own emitters, and the
    // argument rests on naming the four `writeRankAnalyticAsync` call sites in
    // DiscoveryRankingService. Those four numbers were stale by 100+ lines
    // while the same fact was being corrected in the docs, because nothing
    // could see that a source comment makes a checkable claim.
    file: 'artifacts/api-server/src/lib/discoveryPde.ts',
  },
];

// ---------------------------------------------------------------------------
// ANCHORED FLOOR — a ratchet, in the shape this repo uses elsewhere.
//
// The anchor half is opt-in, so it can be silently emptied: delete every
// `#needle` and this script still exits 0, having checked only that some large
// files are still large. That is the vacuous-green state, so it is asserted
// against rather than trusted. RAISING this number is expected. LOWERING it is
// a deliberate reduction in coverage and must be justified in the PR that does
// it — not done to make a red build green.
// ---------------------------------------------------------------------------
export const MIN_ANCHORED_CITATIONS = 40;

const SKIP_DIRS = new Set(['.git', 'node_modules']);

// Extensions a `file.ext:NNN` citation is allowed to name. Same list as
// check-memory-citations.mjs.
const CITED_EXTS = [
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'sql', 'json', 'md', 'py', 'sh', 'yaml', 'yml',
  'toml', 'css', 'html', 'txt',
];

// ---------------------------------------------------------------------------
// citation grammar
// ---------------------------------------------------------------------------
const EXT_ALT = CITED_EXTS.join('|');
const SPEC = String.raw`\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*`;
// An anchor is everything up to the closing backtick, quote or whitespace.
// It is a LITERAL substring to find, not a pattern: `#` in an anchor would be
// ambiguous, so the anchor stops at the first one.
const ANCHOR = String.raw`(?:#([^\s\x60"'#]+))?`;

// path/to/file.ts:12  |  file.ts:12-19  |  file.ts:277,375  |  file.ts:208-216#needle
export const CITATION_RE = new RegExp(
  String.raw`(^|[^\w./:@-])((?:[\w.@+-]+\/)*[\w.@+-]+\.(?:${EXT_ALT})):(${SPEC})${ANCHOR}`,
  'g',
);
// a bare `:408` in backticks continues the most recently named file ON THE SAME LINE
export const INHERITED_RE = new RegExp(String.raw`\x60:(${SPEC})${ANCHOR}\x60`, 'g');
// a bare backticked path with NO line spec — `routes/discovery.ts` — also names
// the file a following `:NNN` on that line continues. Without this, the
// extremely common shape
//     `routes/discovery.ts`: Cache A is checked at `:1786`
// resolves `:1786` against whatever file was cited last, which is a guess.
export const BARE_PATH_RE = new RegExp(
  String.raw`\x60((?:\.{1,2}\/)*(?:[\w.@+-]+\/)*[\w.@+-]+\.(?:${EXT_ALT}))\x60`,
  'g',
);

export function expandLineSpec(spec) {
  // -> { max, ranges: [[lo, hi], ...] }
  const ranges = [];
  for (const part of spec.split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    ranges.push([Math.min(a, b), Math.max(a, b)]);
  }
  const max = ranges.reduce((acc, [, hi]) => Math.max(acc, hi), 0);
  return { max, ranges };
}

/**
 * INHERITANCE IS LINE-LOCAL, AND THAT IS THE CORRECTION THAT MATTERS.
 *
 * check-memory-citations.mjs carries `lastFile` across lines, so a bare `:1222`
 * inherits whatever file was cited last anywhere above it. Running that rule
 * over docs/discovery/ proved it is a guess and the guess is wrong: in
 * phase-minus-1-repository-proof.md the line "`sortBy=nearest` bypasses Cache B
 * ... (`skipCache`, `:1222`, `:1262`)" means routes/discovery.ts (3200 lines,
 * both fine), while the nearest preceding citation is
 * lib/discoveryPersistentCache.ts:173 (268 lines) — so a cross-line rule
 * reports two failures that are not failures.
 *
 * So: a bare `:NNN` inherits only from a file named ON ITS OWN LINE, either as
 * a full citation or as a bare backticked path. An inherited spec with no file
 * on its line is UNEVALUABLE and is returned as an orphan rather than resolved
 * against a guess. Reporting a false failure and inventing a target are the
 * same mistake in opposite directions.
 */
export function extractCitations(text) {
  // -> { citations: [{ file, spec, anchor, line, inherited }], orphans: [{ line, spec }] }
  const lines = text.split('\n');
  const found = [];
  const orphans = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNo = i + 1;

    // ordered scan so an inherited `:NNN` picks up the file to its left
    const hits = [];
    let m;
    CITATION_RE.lastIndex = 0;
    while ((m = CITATION_RE.exec(raw)) !== null) {
      // guard against URLs: https://host/x.md:3
      const before = raw.slice(0, m.index + m[1].length);
      if (/:\/\/\S*$/.test(before)) continue;
      hits.push({ idx: m.index, kind: 'direct', file: m[2], spec: m[3], anchor: m[4] });
    }
    BARE_PATH_RE.lastIndex = 0;
    while ((m = BARE_PATH_RE.exec(raw)) !== null) {
      hits.push({ idx: m.index, kind: 'name', file: m[1] });
    }
    INHERITED_RE.lastIndex = 0;
    while ((m = INHERITED_RE.exec(raw)) !== null) {
      hits.push({ idx: m.index, kind: 'inherited', spec: m[1], anchor: m[2] });
    }
    hits.sort((a, b) => a.idx - b.idx);

    let lineFile = null;
    for (const h of hits) {
      if (h.kind === 'name') {
        lineFile = h.file;
      } else if (h.kind === 'direct') {
        lineFile = h.file;
        found.push({ file: h.file, spec: h.spec, anchor: h.anchor, line: lineNo, inherited: false });
      } else if (lineFile) {
        found.push({ file: lineFile, spec: h.spec, anchor: h.anchor, line: lineNo, inherited: true });
      } else {
        orphans.push({ line: lineNo, spec: h.spec });
      }
    }
  }
  return { citations: found, orphans };
}

/**
 * The anchor assertion, isolated so it is testable without a repo.
 *
 * THE ANCHOR PINS THE **FIRST** LINE OF EACH CITED RANGE, and that precision is
 * the entire point rather than a stylistic preference. "the needle is somewhere
 * inside lines 205-213" is a nine-line target, and the defect this exists to
 * catch moved a nine-line registry entry by three lines — every anchor still
 * landed inside the stale range, so a contains-anywhere rule scores the stale
 * citation as correct. Verified by mutation, not assumed: inserting three lines
 * above that entry left a contains-anywhere check green.
 *
 * Pinning the start line makes a citation's FIRST number a claim that can fail.
 * A multi-part spec (`:871,991,1004,1013#f`) is satisfied only when every part's
 * own first line carries the needle — each part is a separate claim about a
 * separate place in the file, and three surviving out of four is a stale
 * citation, not a passing one.
 *
 * The cost is real and accepted: an anchor must be chosen from the text of the
 * line the citation opens on. That is a smaller cost than a check that cannot
 * fail.
 */
export function anchorHolds(fileLines, ranges, needle) {
  if (ranges.length === 0) return false;
  return ranges.every(([lo]) => {
    if (lo > fileLines.length) return false;
    return (fileLines[lo - 1] ?? '').includes(needle);
  });
}

/**
 * `fromDir` is the directory of the doc making the citation, so a
 * doc-relative `../migrations.md:327` resolves the way a reader's editor
 * resolves it, instead of being reported as a missing file.
 */
export function resolveCitationPath(citedPath, byBasename, fromDir = '') {
  if (/^\.{1,2}\//.test(citedPath)) {
    const abs = path.posix.normalize(path.posix.join(fromDir, citedPath));
    const bucket = byBasename.get(path.posix.basename(abs));
    if (!bucket) return [];
    return bucket.filter((rel) => rel.split(path.sep).join('/') === abs);
  }
  const base = path.posix.basename(citedPath);
  const bucket = byBasename.get(base);
  if (!bucket) return [];
  if (!citedPath.includes('/')) return bucket.slice();
  const suffix = '/' + citedPath;
  return bucket.filter((rel) => {
    const norm = rel.split(path.sep).join('/');
    return norm === citedPath || norm.endsWith(suffix);
  });
}

// ---------------------------------------------------------------------------
// runner — exported so the test suite drives the real logic rather than a copy
// ---------------------------------------------------------------------------
function buildRepoIndex(root, selfErrors) {
  const byBasename = new Map();
  let fileCount = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      selfErrors.push(`could not read directory ${dir}: ${err.message}`);
      continue;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        stack.push(full);
      } else if (e.isFile()) {
        fileCount += 1;
        const rel = path.relative(root, full);
        const list = byBasename.get(e.name);
        if (list) list.push(rel);
        else byBasename.set(e.name, [rel]);
      }
    }
  }
  return { byBasename, fileCount };
}

export function resolveCoveredFiles(root, covered) {
  const files = [];
  const missing = [];
  for (const entry of covered) {
    if (entry.file) {
      const abs = path.join(root, entry.file);
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) files.push(entry.file);
      else missing.push(entry.file);
      continue;
    }
    const abs = path.join(root, entry.dir);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      missing.push(entry.dir + '/');
      continue;
    }
    const md = fs.readdirSync(abs, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => path.posix.join(entry.dir, e.name))
      .sort();
    if (md.length === 0) missing.push(entry.dir + '/ (0 markdown files)');
    files.push(...md);
  }
  return { files, missing };
}

/**
 * Evaluate every citation in `coveredFiles`.
 * `readFile(rel)` returns the file's text or null; injected so the test suite
 * can drive this over a synthetic tree.
 */
export function evaluateCitations({ coveredFiles, readFile, byBasename }) {
  const badRange = [];
  const badAnchor = [];
  const ambiguous = [];
  const orphans = [];
  let total = 0;
  let anchored = 0;

  const lineCache = new Map();
  const linesOf = (rel) => {
    if (lineCache.has(rel)) return lineCache.get(rel);
    const text = readFile(rel);
    const v = text === null ? null : text.split('\n');
    lineCache.set(rel, v);
    return v;
  };

  for (const docRel of coveredFiles) {
    const text = readFile(docRel);
    if (text === null) continue;
    const fromDir = path.posix.dirname(docRel.split(path.sep).join('/'));
    const { citations, orphans: docOrphans } = extractCitations(text);
    for (const o of docOrphans) orphans.push({ doc: docRel, ...o });
    for (const c of citations) {
      total += 1;
      const label = `${c.file}:${c.spec}${c.anchor ? '#' + c.anchor : ''}` +
        (c.inherited ? ' (inherited)' : '');
      const candidates = resolveCitationPath(c.file, byBasename, fromDir);
      if (candidates.length === 0) {
        badRange.push({ doc: docRel, line: c.line, cited: label, reason: 'file not found in repo', detail: '' });
        continue;
      }
      const { max, ranges } = expandLineSpec(c.spec);
      const scored = candidates
        .map((rel) => ({ rel, lines: linesOf(rel) }))
        .sort((a, b) => a.rel.localeCompare(b.rel));
      const inRange = scored.filter((s) => s.lines !== null && s.lines.length >= max);
      if (inRange.length === 0) {
        const best = scored.reduce(
          (a, b) => ((b.lines?.length ?? -1) > (a.lines?.length ?? -1) ? b : a), scored[0]);
        badRange.push({
          doc: docRel, line: c.line, cited: label,
          reason: 'line beyond end of file',
          detail: `needs >=${max} lines; longest candidate ${best.rel} has ${best.lines?.length ?? 'unreadable'}`,
        });
        continue;
      }
      if (scored.length > 1) {
        ambiguous.push({
          doc: docRel, line: c.line, cited: label,
          detail: scored.map((s) => `${s.rel}=${s.lines?.length ?? '?'}L`).join(', '),
        });
      }
      if (c.anchor === undefined) continue;
      anchored += 1;
      // An anchored citation must hold for at least one candidate path; an
      // ambiguous path that anchors nowhere is a failure, not a pass.
      const holding = inRange.filter((s) => anchorHolds(s.lines, ranges, c.anchor));
      if (holding.length === 0) {
        const target = inRange[0];
        const where = ranges.map(([lo, hi]) => (lo === hi ? `${lo}` : `${lo}-${hi}`)).join(',');
        badAnchor.push({
          doc: docRel, line: c.line, cited: label,
          reason: `"${c.anchor}" does not appear at ${target.rel}:${where}`,
          detail: 'the code moved, or the citation named the wrong place',
        });
      }
    }
  }
  return { badRange, badAnchor, ambiguous, orphans, total, anchored };
}

// ---------------------------------------------------------------------------
// main — skipped when this module is imported by the test suite
// ---------------------------------------------------------------------------
function main() {
  const selfErrors = [];
  const fatal = (msg) => {
    console.error(`CHECKER ERROR: ${msg}`);
    process.exit(2);
  };

  const { files: coveredFiles, missing } = resolveCoveredFiles(REPO_ROOT, COVERED);
  if (missing.length > 0) {
    fatal(`covered path(s) missing from the repo: ${missing.join(', ')} — the ` +
      `registry in this script names files that are not there, so the sweep ` +
      `would silently cover less than it claims`);
  }
  if (coveredFiles.length === 0) fatal('the covered set resolved to 0 files');

  const repoIndex = buildRepoIndex(REPO_ROOT, selfErrors);
  if (repoIndex.fileCount === 0) fatal(`repo file index is empty under ${REPO_ROOT}`);

  const readFile = (rel) => {
    try {
      return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    } catch (err) {
      selfErrors.push(`could not read ${rel}: ${err.message}`);
      return null;
    }
  };

  const res = evaluateCitations({ coveredFiles, readFile, byBasename: repoIndex.byBasename });

  console.log('check-doc-citations');
  console.log(`  repo root      ${REPO_ROOT}`);
  console.log('');
  console.log('scope actually scanned');
  console.log(`  covered files ............ ${coveredFiles.length}`);
  console.log(`  file:line citations ...... ${res.total}`);
  console.log(`  of those, anchored ....... ${res.anchored} (floor ${MIN_ANCHORED_CITATIONS})`);
  console.log(`  repo files indexed ....... ${repoIndex.fileCount}`);
  console.log('');

  if (res.total === 0) {
    fatal(`found 0 file:line citations across ${coveredFiles.length} covered ` +
      `file(s) — the range check would be vacuous; the extractor is broken or ` +
      `the corpus changed shape`);
  }

  let failed = 0;
  const section = (title, items, render) => {
    if (items.length === 0) {
      console.log(`OK   ${title}: 0`);
      return;
    }
    console.log(`FAIL ${title}: ${items.length}`);
    for (const it of items) console.log(`       ${render(it)}`);
  };

  section('citations whose file or line range does not resolve', res.badRange,
    (c) => `${c.doc}:${c.line}  ${c.cited}  -- ${c.reason}${c.detail ? `; ${c.detail}` : ''}`);
  failed += res.badRange.length;

  section('anchored citations whose anchor is NOT at the cited lines', res.badAnchor,
    (c) => `${c.doc}:${c.line}  ${c.cited}  -- ${c.reason}`);
  failed += res.badAnchor.length;

  if (res.orphans.length) {
    console.log('');
    console.log(`INFO bare \`:NNN\` specs with no file named on their line: ${res.orphans.length}`);
    console.log('       (NOT checkable — name the file on the line to bring them under the check)');
    for (const o of res.orphans) console.log(`       ${o.doc}:${o.line}  :${o.spec}`);
  }
  if (res.ambiguous.length) {
    console.log('');
    console.log(`INFO citations whose path matches multiple repo files: ${res.ambiguous.length}`);
    for (const a of res.ambiguous) {
      console.log(`       ${a.doc}:${a.line}  ${a.cited}`);
      console.log(`         candidates: ${a.detail}`);
    }
  }

  if (selfErrors.length) {
    console.log('');
    console.error(`CHECKER ERROR: ${selfErrors.length} unreadable path(s) during the sweep:`);
    for (const e of selfErrors) console.error(`       ${e}`);
    process.exit(2);
  }

  console.log('');
  if (res.anchored < MIN_ANCHORED_CITATIONS) {
    console.error(
      `CHECKER ERROR: ${res.anchored} anchored citation(s) found, floor is ` +
      `${MIN_ANCHORED_CITATIONS}. The anchor half is the half that notices code ` +
      `MOVING; a range check cannot. Below the floor this script is checking ` +
      `only that some large files are still large. Restore the anchors, or ` +
      `lower the floor in a PR that says which claims stopped being checkable ` +
      `and why.`);
    process.exit(2);
  }

  if (failed === 0) {
    console.log('RESULT clean');
    process.exit(0);
  }
  console.log('RESULT failed');
  console.log(`  unresolvable citations ... ${res.badRange.length}`);
  console.log(`  broken anchors ........... ${res.badAnchor.length}`);
  console.log(`  total findings ........... ${failed}`);
  process.exit(1);
}

// `node scripts/check-doc-citations.mjs` runs; `import(...)` from the test does not.
if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT) main();
