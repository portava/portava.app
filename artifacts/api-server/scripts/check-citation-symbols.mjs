#!/usr/bin/env node
/**
 * check:citation-symbols — the citation that NAMES the thing it points at, and
 * points somewhere else.
 *
 * WHY THIS EXISTS, AND WHY THE OTHER TWO CANNOT DO IT.
 * ===================================================
 * `check:doc-citations` re-reads ANCHORED citations (`path:line#literal`) and
 * fails the moment the code moves. It checks an UNANCHORED one (`path:line`)
 * for one thing — that the file is long enough — and says so itself: *"nothing
 * here can tell you it names the right code"*. 6,434 of those sit under a
 * ceiling that may only fall.
 *
 * `check:citation-targets` closed the one sub-case answerable without reading
 * the claim: a single-line citation landing on a blank line or a bare bracket
 * is certainly wrong, because no claim is evidenced by `});`. Its own header
 * names what it leaves open: *"whether a citation that lands on real code lands
 * on the RIGHT real code. That is the large remaining hole and this check does
 * not close it."*
 *
 * THIS CLOSES A SECOND SUB-CASE OF THAT HOLE, and it is knowable for the same
 * reason: the census often writes the answer down next to the question. The
 * corpus convention is `` `lib/mapProjection.ts:1166` `rankObjects` `` — a
 * pointer AND the symbol it is pointing at. When the citation names a symbol,
 * "is this the right line?" stops needing a human: the symbol either is there
 * or it is not.
 *
 * WHAT IT MEASURED ON ITS FIRST RUN (2026-09-14), and each case was opened by
 * hand before this file was written:
 *
 *   `lib/mapProjection.ts:1166` `rankObjects`        :1166 is BLANK; it is at :1217
 *   `lib/mapProjection.ts:676`  `applyLiveClaims`    :676 is a comment; 584/586/696/1091
 *   `MemoryDomainService.ts:121` `auditCommand`      :121 is `*​/`; 42/189/444/452
 *   `routes/memories.ts:127` `canViewMemory`         the symbol is not in that file at all
 *   `src/components/map/ActivityZone.tsx:96` `belowLayerID`   not anywhere in the repo
 *
 * TWO CLASSES, REPORTED SEPARATELY, BECAUSE THEY ARE NOT THE SAME FINDING.
 *
 *   ABSENT     the named symbol occurs NOWHERE in the cited file. The citation
 *              names the wrong file, or the symbol was renamed or deleted and
 *              the census still asserts it. There is no reading of the code
 *              that makes such a citation correct, so this class is the GATE.
 *
 *   MISPLACED  the symbol is in the file but not within ±WINDOW of the cited
 *              line. Usually a pointer that drifted when code moved. Reported
 *              under a ceiling rather than gated, because ONE FALSE-POSITIVE
 *              CLASS IS KNOWN AND IS NOT GUESSWORK: a citation may name a
 *              COLLECTION and point at a MEMBER of it — `` `liveTruth.ts:430`
 *              `CLOSURE_STATES` `` lands on `'closure',`, an element of the
 *              array, which is a correct citation by any reading. Gating on a
 *              number that contains those would be asserting a defect this
 *              check cannot establish, which is the failure mode the ratchets
 *              in this repository exist to avoid.
 *
 * WHAT IS DELIBERATELY NOT JUDGED, each with its reason:
 *
 *   - ANCHORED citations. doc-citations already checks them, harder.
 *   - RANGES and `:1`. Same reasons check:citation-targets gives: a range cites
 *     a block, and `:1` is how this corpus points at a FILE.
 *   - A symbol that is not an identifier — a quoted phrase, a `§` reference, a
 *     path. A cell may hold any of those and none is a claim about a line.
 *   - A symbol further than GAP characters after the citation. Adjacency is
 *     what makes it a claim ABOUT that pointer rather than a word in the same
 *     sentence.
 *   - Unresolved or ambiguous paths. doc-citations owns both verdicts.
 *   - `docs/architecture/mobile-reachability-ledger.md`, pinned to a commit by
 *     its own declaration; its lines must not track HEAD.
 *
 * THE CITATION SCAN IS THE SHARED ONE. CITATION_RE / BARE_PATH_RE /
 * INHERITED_RE / expandLineSpec / resolveCitationPath are imported from
 * check-doc-citations.mjs rather than re-expressed here, so this checker and
 * that one can never disagree about what a citation IS. Only "what follows it"
 * is new, and the library has no opinion about that.
 *
 * Exit 0 → no NEW absent symbol, and both classes at or under their ceilings
 * Exit 1 → a finding
 * Exit 2 → it could not establish a result, including judging nothing at all
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  COVERED, SKIP_DIRS, CITATION_RE, BARE_PATH_RE, INHERITED_RE,
  resolveCoveredFiles, resolveCitationPath, expandLineSpec,
} from './check-doc-citations.mjs';

/** Measured 2026-09-14. CEILING — may only fall. Each is a citation naming a
 *  symbol that is not in the file it points at; every one is a row's evidence.
 *
 *  Opened at 4 and LOWERED TO 1 in the same change, by fixing three of them
 *  rather than recording them. Two of the three were the same defect and it is
 *  worth naming, because the pointer was not what had rotted: census-map's
 *  `:301` `COARSEN_UNSAFE_KINDS` and `:325` `RELATIONSHIP_GATED_KINDS` were at
 *  exactly those LINES — of `lib/protectedLocations.ts`, while the cell had
 *  named `lib/mapObjects.ts` in between, and a bare `:NNN` inherits the most
 *  recently named file. The third, `ActivityZone.tsx:96` `belowLayerID`, named
 *  a prop that is in no file in this repository; it is `beforeId`, at `:97`.
 *
 *  The one remaining is census-highlights-memories' `routes/memories.ts:127`
 *  `canViewMemory`, which belongs to that lane's paths and is raised with it. */
export const MAX_ABSENT_SYMBOLS = 1;

/** Measured 2026-09-14. CEILING — may only fall. Contains a known false-positive
 *  class (collection cited, member pointed at), which is why it is a ceiling and
 *  not a gate, and why it is not called a defect count. */
export const MAX_MISPLACED_SYMBOLS = 60;

/** How far from the cited line the symbol may be and still count as "there". */
const WINDOW = 2;

/** How many characters may sit between the citation and the symbol. */
const GAP = 3;

/** Pinned to a commit by its own declaration; its lines must not track HEAD. */
const PINNED_DOCS = new Set(['docs/architecture/mobile-reachability-ledger.md']);

/** A backticked token that is a code identifier and not a phrase or a path. */
const SYMBOL_RE = /^`([A-Za-z_$][A-Za-z0-9_$.]{2,60})`/;

const LIST = process.argv.includes('--list');
const rootArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const root = path.resolve(rootArg ?? path.join(import.meta.dirname, '..', '..', '..'));

function indexByBasename(dir, out = new Map()) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) indexByBasename(p, out);
    else {
      const rel = path.relative(root, p);
      const list = out.get(e.name) ?? [];
      list.push(rel);
      out.set(e.name, list);
    }
  }
  return out;
}

const byBasename = indexByBasename(root);
const { files } = resolveCoveredFiles(root, COVERED);
const fileCache = new Map();
function linesOf(rel) {
  if (!fileCache.has(rel)) {
    try { fileCache.set(rel, fs.readFileSync(path.join(root, rel), 'utf8').split('\n')); }
    catch { fileCache.set(rel, null); }
  }
  return fileCache.get(rel);
}

const absent = [];
const misplaced = [];
let judged = 0;

for (const doc of files) {
  if (PINNED_DOCS.has(doc)) continue;
  const lines = fs.readFileSync(path.join(root, doc), 'utf8').split('\n');

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];

    // The same ordered scan extractCitations does, kept here only because the
    // library returns no column and this check needs what comes NEXT.
    const hits = [];
    let m;
    CITATION_RE.lastIndex = 0;
    while ((m = CITATION_RE.exec(raw)) !== null) {
      const before = raw.slice(0, m.index + m[1].length);
      if (/:\/\/\S*$/.test(before)) continue;               // a URL, not a citation
      hits.push({ idx: m.index, end: m.index + m[0].length, kind: 'direct', file: m[2], spec: m[3], anchor: m[4] });
    }
    BARE_PATH_RE.lastIndex = 0;
    while ((m = BARE_PATH_RE.exec(raw)) !== null) {
      hits.push({ idx: m.index, end: m.index + m[0].length, kind: 'name', file: m[1] });
    }
    INHERITED_RE.lastIndex = 0;
    while ((m = INHERITED_RE.exec(raw)) !== null) {
      hits.push({ idx: m.index, end: m.index + m[0].length, kind: 'inherited', spec: m[1], anchor: m[2] });
    }
    hits.sort((a, b) => a.idx - b.idx);

    let lineFile = null;
    for (const h of hits) {
      if (h.kind === 'name') { lineFile = h.file; continue; }
      const file = h.kind === 'direct' ? h.file : lineFile;
      if (h.kind === 'direct') lineFile = h.file;
      if (!file) continue;                                   // orphan: doc-citations reports it
      if (h.anchor !== undefined) continue;                  // anchored: already checked, harder

      let spec;
      try { spec = expandLineSpec(h.spec); } catch { continue; }
      if (!spec?.ranges?.length || spec.ranges.length !== 1) continue;
      const [lo, hi] = spec.ranges[0];
      if (lo !== hi) continue;                               // a range cites a block
      if (lo === 1) continue;                                // `:1` means "this file"

      // Is a symbol claimed right after this pointer?
      // CITATION_RE stops at the line spec and does NOT consume the closing
      // backtick of `path.ts:1166`; INHERITED_RE does consume both of its own.
      // Dropping one leading backtick normalises the two, and getting this
      // wrong is not loud — it silently judges a third of the corpus and
      // reports a clean-looking number, which is why `judged` is printed.
      let after = raw.slice(h.end, h.end + GAP + 120);
      if (after.startsWith('`')) after = after.slice(1);
      const lead = /^[ \t]*/.exec(after)[0];
      if (lead.length > GAP) continue;
      const rest = after.slice(lead.length);
      const sm = SYMBOL_RE.exec(rest);
      if (!sm) continue;
      const symbol = sm[1];
      // THE SEPARATOR IS WHITESPACE ONLY, and the two false positives that
      // taught it are worth naming. The convention runs in BOTH directions:
      //   `lib/mapObjects.ts:301` `COARSEN_UNSAFE_KINDS`   pointer, then symbol
      //   `TRIP_BOOKING_NOT_CREATOR_OR_OWNER` at `:497`    symbol, then pointer
      // Allowing `,` or `;` in the separator made the SECOND shape parse as the
      // first: census-trips:3557 reads "…NOT_MEMBER at `:95`,
      // `TRIP_BOOKING_NOT_CREATOR_OR_OWNER` at `:497`", and this check scored
      // the second symbol against the FIRST pointer and called it absent. It was
      // not: the citation is correct and the checker was wrong. census-media:1055
      // is the same defect behind a semicolon.
      //
      // So: only a space may separate them, and a symbol that is itself followed
      // by "at `…`" / "in `…`" belongs to the NEXT pointer, not this one.
      if (/^\s*(?:at|in|via|→|->)\s*[\x60:]/i.test(rest.slice(sm[0].length))) continue;

      let target;
      try { target = resolveCitationPath(file, byBasename, path.dirname(doc)); } catch { continue; }
      const rel = Array.isArray(target) ? (target.length === 1 ? target[0] : null) : target;
      if (!rel) continue;                                    // unresolved/ambiguous: not ours
      const src = linesOf(rel);
      if (!src || lo > src.length) continue;                 // past EOF: doc-citations reports it

      judged += 1;
      const needle = symbol.split('.').pop();
      const where = { doc, docLine: i + 1, cite: `${file}:${h.spec}`, at: `${rel}:${lo}`, symbol };
      if (!src.some((s) => s.includes(needle))) {
        absent.push(where);
      } else {
        const from = Math.max(0, lo - 1 - WINDOW);
        const to = Math.min(src.length, lo + WINDOW);
        if (!src.slice(from, to).some((s) => s.includes(needle))) {
          const actual = src.map((s, n) => (s.includes(needle) ? n + 1 : 0)).filter(Boolean).slice(0, 4);
          misplaced.push({ ...where, actual });
        }
      }
    }
  }
}

console.log(
  `check:citation-symbols — ${judged} symbol-naming citation(s) judged, ` +
    `${absent.length} name a symbol the cited file does not contain (ceiling ${MAX_ABSENT_SYMBOLS}), ` +
    `${misplaced.length} point more than ${WINDOW} line(s) from it (ceiling ${MAX_MISPLACED_SYMBOLS})`,
);

// A checker that judged NOTHING looks exactly like a clean corpus. It is not a
// pass: it is a checker that did not run. Every guard in this tree that reports
// an inspection count does so for this reason.
if (judged === 0) {
  console.error(
    '::error::check:citation-symbols judged 0 citations. The corpus is not empty, so ' +
      'either COVERED resolved to nothing or the adjacency scan is broken. This is exit 2, not a pass.',
  );
  process.exit(2);
}

if (LIST || absent.length > 0 || misplaced.length > MAX_MISPLACED_SYMBOLS) {
  for (const a of absent) {
    console.error(`  ABSENT     ${a.doc}:${a.docLine}  ${a.cite} \`${a.symbol}\` — not in ${a.at.split(':')[0]} at all`);
  }
  if (LIST) {
    for (const d of misplaced) {
      console.error(`  MISPLACED  ${d.doc}:${d.docLine}  ${d.cite} \`${d.symbol}\` — cited ${d.at}, found at ${d.actual.join(', ')}`);
    }
  }
}

let failed = false;

if (absent.length > MAX_ABSENT_SYMBOLS) {
  failed = true;
  console.error(
    `\n::error::${absent.length} citation(s) name a symbol that is not in the file they point at, ` +
      `against a ceiling of ${MAX_ABSENT_SYMBOLS}. Each one is a row's evidence pointing at the wrong file. ` +
      `Repoint it by READING the claim — never by offset — and anchor it (\`path:line#needle\`) so ` +
      `check:doc-citations keeps it honest afterwards.`,
  );
} else if (absent.length < MAX_ABSENT_SYMBOLS) {
  console.log(
    `✓ ${absent.length} < ${MAX_ABSENT_SYMBOLS} — LOWER MAX_ABSENT_SYMBOLS in ` +
      `scripts/check-citation-symbols.mjs to ${absent.length}, or this gain is not kept.`,
  );
}

if (misplaced.length > MAX_MISPLACED_SYMBOLS) {
  failed = true;
  console.error(
    `\n::error::${misplaced.length} citation(s) point more than ${WINDOW} line(s) from the symbol they name, ` +
      `against a ceiling of ${MAX_MISPLACED_SYMBOLS}. Run with --list to see each one, with the lines the ` +
      `symbol is actually on. Some of this class are correct — a citation may name a COLLECTION and point at ` +
      `a MEMBER — so read each before repointing it.`,
  );
} else if (misplaced.length < MAX_MISPLACED_SYMBOLS) {
  console.log(
    `✓ ${misplaced.length} < ${MAX_MISPLACED_SYMBOLS} — LOWER MAX_MISPLACED_SYMBOLS to ${misplaced.length}.`,
  );
}

if (failed) process.exit(1);
console.log('check:citation-symbols PASSED');
