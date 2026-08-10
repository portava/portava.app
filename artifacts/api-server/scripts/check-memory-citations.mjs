#!/usr/bin/env node
/**
 * check-memory-citations.mjs
 *
 * Turns "I swept the memory entries" from a claim into an executable.
 *
 * Run from the repo root (cwd-independent — the repo root is derived from this
 * file's own location):
 *
 *     node artifacts/api-server/scripts/check-memory-citations.mjs
 *
 * Checks, over .agents/memory/:
 *   1. INDEX-LINK      every markdown link in MEMORY.md resolves to a file that
 *                      exists in .agents/memory/            (reported with line no.)
 *   2. UNINDEXED       every entry file is linked by >= 1 MEMORY.md line
 *      DUPLICATE       entries linked from more than one line (INFO, not a failure)
 *   3. CITATION        every `path/to/file.ts:NNN` citation inside every
 *                      .agents/memory/*.md resolves: the file exists in the repo
 *                      AND has at least NNN lines
 *   4. FRONTMATTER     every entry has the required frontmatter keys and a
 *                      non-empty description
 *
 * Exit codes:
 *   0  clean
 *   1  one or more checks failed (per-category counts printed)
 *   2  the checker itself could not run a check honestly (missing dirs, zero
 *      entries found, zero citations found, empty repo index). A checker that
 *      exits 0 because it found nothing is the failure mode this guards against.
 *
 * Zero dependencies. Reads only; never writes, never touches a database.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(import.meta.url);
// artifacts/api-server/scripts/<this file>  ->  repo root
const REPO_ROOT = path.resolve(path.dirname(SCRIPT), '..', '..', '..');
const MEMORY_DIR = path.join(REPO_ROOT, '.agents', 'memory');
const INDEX_FILE = path.join(MEMORY_DIR, 'MEMORY.md');

const REQUIRED_FRONTMATTER_KEYS = ['name', 'description'];

const SKIP_DIRS = new Set(['.git', 'node_modules']);

// Extensions a `file.ext:NNN` citation is allowed to name.
const CITED_EXTS = [
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'sql', 'json', 'md', 'py', 'sh', 'yaml', 'yml',
  'toml', 'css', 'html', 'txt',
];

// ---------------------------------------------------------------------------
// hard failure of the checker itself
// ---------------------------------------------------------------------------
const selfErrors = [];
function fatal(msg) {
  console.error(`CHECKER ERROR: ${msg}`);
  process.exit(2);
}
function assertOrDie(cond, msg) {
  if (!cond) fatal(msg);
}

// ---------------------------------------------------------------------------
// repo file index (basename -> [repo-relative paths])
// ---------------------------------------------------------------------------
function buildRepoIndex(root) {
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

// ---------------------------------------------------------------------------
// line counting (cached)
// ---------------------------------------------------------------------------
const lineCountCache = new Map();
function lineCount(relPath) {
  if (lineCountCache.has(relPath)) return lineCountCache.get(relPath);
  let n = null;
  try {
    const buf = fs.readFileSync(path.join(REPO_ROOT, relPath));
    let newlines = 0;
    for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) newlines++;
    // addressable lines: a trailing newline does not create a further line
    n = buf.length === 0 ? 0
      : (buf[buf.length - 1] === 0x0a ? newlines : newlines + 1);
  } catch (err) {
    selfErrors.push(`could not read ${relPath}: ${err.message}`);
    n = null;
  }
  lineCountCache.set(relPath, n);
  return n;
}

// ---------------------------------------------------------------------------
// citation extraction
// ---------------------------------------------------------------------------
const EXT_ALT = CITED_EXTS.join('|');
// path/to/file.ts:12  |  file.ts:12-19  |  file.ts:277,375  |  file.ts:53,68
const CITATION_RE = new RegExp(
  String.raw`(^|[^\w./:@-])((?:[\w.@+-]+\/)*[\w.@+-]+\.(?:${EXT_ALT})):(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)`,
  'g',
);
// a bare `:408` in backticks continues the most recently cited file in the entry
const INHERITED_RE = /`:(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)`/g;

function expandLineSpec(spec) {
  // returns the set of distinct line numbers a citation asserts must exist
  const out = [];
  for (const part of spec.split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    out.push(Math.max(a, b)); // the highest line the citation requires to exist
  }
  return out;
}

function extractCitations(text) {
  // -> [{ file, spec, line }]  (line = 1-based line number inside the entry)
  const lines = text.split('\n');
  const found = [];
  let lastFile = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNo = i + 1;

    // ordered scan so an inherited `:NNN` picks up the file to its left
    const hits = [];
    CITATION_RE.lastIndex = 0;
    let m;
    while ((m = CITATION_RE.exec(raw)) !== null) {
      // guard against URLs: https://host/x.md:3
      const before = raw.slice(0, m.index + m[1].length);
      if (/:\/\/\S*$/.test(before)) continue;
      hits.push({ idx: m.index, kind: 'direct', file: m[2], spec: m[3] });
    }
    INHERITED_RE.lastIndex = 0;
    while ((m = INHERITED_RE.exec(raw)) !== null) {
      hits.push({ idx: m.index, kind: 'inherited', spec: m[1] });
    }
    hits.sort((a, b) => a.idx - b.idx);

    for (const h of hits) {
      if (h.kind === 'direct') {
        lastFile = h.file;
        found.push({ file: h.file, spec: h.spec, line: lineNo, inherited: false });
      } else if (lastFile) {
        found.push({ file: lastFile, spec: h.spec, line: lineNo, inherited: true });
      }
      // an inherited spec with no preceding file is silently skipped: it is not
      // a citation we can evaluate, and inventing a target would be worse
    }
  }
  return found;
}

function resolveCitationPath(citedPath, index) {
  const base = path.posix.basename(citedPath);
  const bucket = index.byBasename.get(base);
  if (!bucket) return [];
  if (!citedPath.includes('/')) return bucket.slice();
  const suffix = '/' + citedPath.replace(/^\.\//, '');
  return bucket.filter((rel) => {
    const norm = rel.split(path.sep).join('/');
    return norm === citedPath || norm.endsWith(suffix);
  });
}

// ---------------------------------------------------------------------------
// frontmatter
// ---------------------------------------------------------------------------
function parseFrontmatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { ok: false, reason: 'no opening --- on line 1', keys: {} };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { end = i; break; }
  }
  if (end === -1) return { ok: false, reason: 'no closing --- delimiter', keys: {} };
  const keys = {};
  let lastKey = null;
  for (let i = 1; i < end; i++) {
    const m = /^([A-Za-z0-9_-]+):\s?(.*)$/.exec(lines[i]);
    if (m) {
      lastKey = m[1];
      keys[lastKey] = m[2].trim();
    } else if (lastKey && lines[i].trim()) {
      keys[lastKey] = (keys[lastKey] + ' ' + lines[i].trim()).trim();
    }
  }
  return { ok: true, keys };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
assertOrDie(fs.existsSync(MEMORY_DIR) && fs.statSync(MEMORY_DIR).isDirectory(),
  `memory directory not found at ${MEMORY_DIR}`);
assertOrDie(fs.existsSync(INDEX_FILE), `index file not found at ${INDEX_FILE}`);

const indexText = fs.readFileSync(INDEX_FILE, 'utf8');
assertOrDie(indexText.trim().length > 0, `${INDEX_FILE} is empty`);

const entryFiles = fs.readdirSync(MEMORY_DIR)
  .filter((f) => f.endsWith('.md') && f !== 'MEMORY.md')
  .sort();
assertOrDie(entryFiles.length > 0,
  `found 0 entry files in ${MEMORY_DIR} — refusing to report a clean sweep of nothing`);

const repoIndex = buildRepoIndex(REPO_ROOT);
assertOrDie(repoIndex.fileCount > 0, `repo file index is empty under ${REPO_ROOT}`);

// --- check 1 + 2: MEMORY.md links -----------------------------------------
const indexLines = indexText.split('\n');
const LINK_RE = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

const brokenLinks = [];          // { line, target }
const linkTargets = new Map();   // target -> [line numbers]
let totalLinks = 0;

for (let i = 0; i < indexLines.length; i++) {
  LINK_RE.lastIndex = 0;
  let m;
  while ((m = LINK_RE.exec(indexLines[i])) !== null) {
    const target = m[1];
    if (/^[a-z]+:\/\//i.test(target) || target.startsWith('#')) continue; // external / anchor
    totalLinks += 1;
    const lineNo = i + 1;
    const clean = target.split('#')[0];
    const arr = linkTargets.get(clean);
    if (arr) arr.push(lineNo); else linkTargets.set(clean, [lineNo]);
    const abs = path.join(MEMORY_DIR, clean);
    const inside = path.resolve(abs).startsWith(path.resolve(MEMORY_DIR) + path.sep);
    if (!inside || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      brokenLinks.push({ line: lineNo, target });
    }
  }
}
assertOrDie(totalLinks > 0,
  `found 0 markdown links in MEMORY.md — the link check would be vacuous`);

const linkedSet = new Set([...linkTargets.keys()]);
const unindexed = entryFiles.filter((f) => !linkedSet.has(f));
const duplicates = [...linkTargets.entries()]
  .filter(([, ls]) => ls.length > 1)
  .map(([target, ls]) => ({ target, lines: ls }));

// --- check 3: citations ----------------------------------------------------
const badCitations = [];   // { entry, line, cited, spec, reason, detail }
const ambiguous = [];      // { entry, line, cited, chosen, candidates }
let totalCitations = 0;

for (const f of entryFiles.concat(['MEMORY.md'])) {
  const text = fs.readFileSync(path.join(MEMORY_DIR, f), 'utf8');
  for (const c of extractCitations(text)) {
    totalCitations += 1;
    const candidates = resolveCitationPath(c.file, repoIndex);
    const label = c.inherited ? `${c.file}:${c.spec} (inherited)` : `${c.file}:${c.spec}`;
    if (candidates.length === 0) {
      badCitations.push({
        entry: f, line: c.line, cited: label,
        reason: 'file not found in repo', detail: '',
      });
      continue;
    }
    const required = expandLineSpec(c.spec);
    const maxRequired = Math.max(...required);
    const scored = candidates
      .map((rel) => ({ rel, lines: lineCount(rel) }))
      .sort((a, b) => a.rel.localeCompare(b.rel));
    const satisfying = scored.filter((s) => s.lines !== null && s.lines >= maxRequired);
    if (satisfying.length === 0) {
      const best = scored.reduce((a, b) => ((b.lines ?? -1) > (a.lines ?? -1) ? b : a), scored[0]);
      badCitations.push({
        entry: f, line: c.line, cited: label,
        reason: 'line beyond end of file',
        detail: `needs >=${maxRequired} lines; longest candidate ${best.rel} has ${best.lines}`,
      });
    } else if (scored.length > 1) {
      ambiguous.push({
        entry: f, line: c.line, cited: label, need: maxRequired,
        satisfying: satisfying.length, total: scored.length,
        detail: scored.map((s) => `${s.rel}=${s.lines}L`).join(', '),
      });
    }
  }
}
assertOrDie(totalCitations > 0,
  `found 0 file:line citations across ${entryFiles.length} entries — the citation ` +
  `check would be vacuous; the extractor is broken or the corpus changed shape`);

// --- check 4: frontmatter --------------------------------------------------
const frontmatterProblems = []; // { entry, problem }
for (const f of entryFiles) {
  const text = fs.readFileSync(path.join(MEMORY_DIR, f), 'utf8');
  const fm = parseFrontmatter(text);
  if (!fm.ok) {
    frontmatterProblems.push({ entry: f, problem: `malformed frontmatter (${fm.reason})` });
    continue;
  }
  for (const key of REQUIRED_FRONTMATTER_KEYS) {
    if (!(key in fm.keys)) {
      frontmatterProblems.push({ entry: f, problem: `missing frontmatter key: ${key}` });
    } else if (fm.keys[key].trim() === '') {
      frontmatterProblems.push({ entry: f, problem: `empty frontmatter value: ${key}` });
    }
  }
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------
const pad = (s) => String(s);
console.log('check-memory-citations');
console.log(`  repo root      ${REPO_ROOT}`);
console.log(`  memory dir     ${path.relative(REPO_ROOT, MEMORY_DIR)}`);
console.log('');
console.log('scope actually scanned');
console.log(`  MEMORY.md lines .......... ${indexLines.length - (indexText.endsWith('\n') ? 1 : 0)}`);
console.log(`  markdown links ........... ${totalLinks} (${linkTargets.size} distinct targets)`);
console.log(`  entry files .............. ${entryFiles.length}`);
console.log(`  file:line citations ...... ${totalCitations} (across entries + MEMORY.md)`);
console.log(`  repo files indexed ....... ${repoIndex.fileCount}`);
console.log('');

let failed = 0;

function section(title, items, render) {
  if (items.length === 0) {
    console.log(`OK   ${title}: 0`);
    return;
  }
  console.log(`FAIL ${title}: ${items.length}`);
  for (const it of items) console.log(`       ${render(it)}`);
}

section('broken MEMORY.md links', brokenLinks,
  (b) => `MEMORY.md:${pad(b.line)}  -> ${b.target}  (no such file in .agents/memory/)`);
failed += brokenLinks.length;

section('entry files not indexed by MEMORY.md', unindexed, (f) => f);
failed += unindexed.length;

section('unresolvable file:line citations', badCitations,
  (c) => `${c.entry}:${pad(c.line)}  ${c.cited}  -- ${c.reason}${c.detail ? `; ${c.detail}` : ''}`);
failed += badCitations.length;

section('frontmatter problems', frontmatterProblems,
  (p) => `${p.entry}  -- ${p.problem}`);
failed += frontmatterProblems.length;

console.log('');
if (duplicates.length) {
  console.log(`INFO entries indexed more than once: ${duplicates.length} (legitimate, but visible)`);
  for (const d of duplicates) {
    console.log(`       ${d.target}  at MEMORY.md lines ${d.lines.join(', ')}`);
  }
}
if (ambiguous.length) {
  console.log(`INFO citations whose path matches multiple repo files: ${ambiguous.length}`);
  console.log('       (resolved = at least one candidate is long enough; disambiguate by hand)');
  for (const a of ambiguous) {
    console.log(`       ${a.entry}:${pad(a.line)}  ${a.cited}  needs >=${a.need}L, ` +
      `${a.satisfying}/${a.total} candidates qualify`);
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
if (failed === 0) {
  console.log('RESULT clean');
  process.exit(0);
}
console.log('RESULT failed');
console.log(`  broken index links ....... ${brokenLinks.length}`);
console.log(`  unindexed entries ........ ${unindexed.length}`);
console.log(`  unresolvable citations ... ${badCitations.length}`);
console.log(`  frontmatter problems ..... ${frontmatterProblems.length}`);
console.log(`  total findings ........... ${failed}`);
process.exit(1);
