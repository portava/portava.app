#!/usr/bin/env node
/**
 * check:citation-targets — an UNANCHORED citation that lands on nothing.
 *
 * WHY THIS EXISTS, AND WHY check:doc-citations CANNOT DO IT.
 * ==========================================================
 * `check:doc-citations` splits the corpus in two. An ANCHORED citation
 * (`path:line#literal`) is re-read: the literal must still be on that exact
 * line, so the citation fails the moment the code moves. An UNANCHORED one
 * (`path:line`) is checked for ONE thing — that the file is long enough — and
 * its own error text says so: *"nothing here can tell you it names the right
 * code"*. There are 6,443 of those, held under a ceiling that may only fall.
 *
 * That ceiling stops the class GROWING. It does nothing about the ones already
 * there, and it cannot, because "is this line the right line?" has no general
 * answer without reading the claim.
 *
 * But one case DOES have an answer. A single-line citation whose line is BLANK,
 * or is nothing but a bracket, a semicolon or a comment delimiter, is not a
 * citation that might be wrong — it is a citation that is CERTAINLY wrong,
 * because no claim in a census is evidenced by `});`. Those are stale pointers
 * left behind when code moved, and this check counts them.
 *
 * WHAT IS DELIBERATELY NOT JUDGED, each with its reason:
 *
 *   - RANGES (`:49-53`, `:1-16`). Citing a module header block that opens on
 *     `/**`, or an import block, is normal and correct. Only a single line is
 *     judged, because only a single line makes a claim about one place.
 *   - `:1`. A citation to line 1 is how this corpus points at a FILE rather
 *     than a line, and line 1 is usually `/**`. Judging it would fail the
 *     convention, not the pointer.
 *   - ANCHORED citations. They are already checked, harder, by doc-citations.
 *   - `docs/architecture/mobile-reachability-ledger.md`. It declares itself
 *     derived from commit `22ab17151b98adcaf81b5bc976cf1502043f535f`, read via
 *     `git archive` rather than from the working tree, and it has a `.json`
 *     sibling holding the same pinned values. Its line numbers MUST NOT track
 *     HEAD. Two separate lanes have tried to repoint it and both were reverted.
 *     It is excluded by name, and that exclusion is the point rather than an
 *     oversight.
 *   - A citation whose path does not resolve, or resolves ambiguously to more
 *     than one file. doc-citations owns both of those verdicts; reporting them
 *     twice would make one fix look like two.
 *
 * THE RATCHET. `MAX_DEAD_TARGETS` is a CEILING and may only FALL. Repoint a
 * citation to the line that actually carries the claim — by reading the claim,
 * never by offset — and the count drops. Anchoring it as well is better still,
 * because then doc-citations keeps it honest afterwards.
 *
 * DOES NOT COVER: whether a citation that lands on real code lands on the RIGHT
 * real code. That is the large remaining hole and this check does not close it.
 * It closes the sub-case where the answer is knowable without reading the
 * claim, which is why the number it reports is a floor on the problem and not
 * a measure of it.
 *
 * WHERE TO SPEND THE EFFORT, learned by spending it in the wrong place first.
 * These documents are APPEND-ONLY and LAST-STATEMENT-WINS, so a body-table row
 * is frequently SUPERSEDED by a later section that re-measured it. Twelve of
 * these landed in census-trust, and the first one opened — A17, whose row still
 * reads W beside "eleven direct trust_profiles reads" that no longer exist —
 * had already been moved to C hundreds of lines further down, against
 * `check:trust-table-ownership` reporting zero violations. Repointing the dead
 * citation in the superseded row would have been archaeology: the row's LIVE
 * statement cites something else entirely, and the tallier already reads that
 * one.
 *
 * So: before repointing, find the row's LAST statement. If the dead citation is
 * in a superseded row, the honest fix is usually to leave the historical text
 * alone — it described a tree that existed — and spend the effort on citations
 * the current verdict actually rests on. This check cannot tell the two apart,
 * which is stated here rather than discovered again.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  COVERED, SKIP_DIRS, extractCitations, resolveCoveredFiles,
  resolveCitationPath, expandLineSpec,
} from './check-doc-citations.mjs';

/** Measured 2026-09-13. CEILING — may only fall.
 * LOWERED 2026-09-13 from 293 to 276. Two passes moved it: ten citations in
 * census-compass and census-discovery repointed by locating the EXACT text the
 * original line named (not the nearest plausible line), and the trust lane's
 * §12 anchoring, which repointed every citation its own ~30-line growth in
 * routes/verification.ts, routes/admin.ts and lib/trustMaintenanceScheduler.ts
 * had aged out from under. 304 -> 292 -> 276.
 *
 * Seven citations in census-compass and census-discovery are STILL dead and were
 * deliberately left that way, because each needs its claim re-read rather than its
 * pointer moved. The clearest is census-compass.md:164, whose anchor text
 * `nameVisibilitySet` has zero occurrences anywhere in routes/compass.ts. The
 * batched identity read it describes now lives in buildListIdentityProjections.
 * Pointing it there would be asserting evidence for a C row nobody re-derived.
 *
 * LOWERED AGAIN 2026-09-13, 276 -> 275, by census-wall §8. That one came out of a
 * FRESHNESS finding rather than a citation pass: check:census-freshness named a
 * counted file that had changed, revalidating the affected row meant opening it,
 * and the row turned out to cite `AccountDeletionService.ts:1068` for a step that
 * has never been on line 1068 in this repository's history -- 1102 at the census's
 * own head_commit, 1138 today. It survived because the citation was UNANCHORED, so
 * doc-citations checked only that the file was long enough and this checker only
 * that the line was not blank; `delete_user_saves` is neither blank nor punctuation.
 * It is now `:1138#delete_wall_session_intent`. The general lesson is the one at the
 * top of this file: a pointer that lands on real code can still name the wrong code,
 * and the only thing that finds THAT is a person reading the claim. */

/** LOWERED 2026-09-14, 276 -> 257, by the citation-repair lane. The branch had
 * drifted ONE over the 275 ceiling; nineteen citations were repointed to bring it
 * back and then some. Measured on this tree, AFTER the repairs, by running this
 * checker: `257 land on nothing`. That is the number below — the ceiling sits AT
 * the measurement, with no slack, as a shrink-only ratchet requires.
 *
 * HOW THE NINETEEN WERE CHOSEN, because the method is the part worth keeping.
 * Not one was moved by offset. Each was repaired by reading the sentence the
 * citation supports, naming the symbol that sentence asserts, and grepping the
 * cited file for it: `status_unchanged_flag_off` for the abort that reports it,
 * `route_legs_member_select` for the RLS policy the row says exists,
 * `INTERNAL_ONLY_REASONS` for "TRIP_AUTH_BLOCKED is internal-only". Every one of
 * the nineteen also gained an `#anchor`, so doc-citations now owns them and this
 * checker no longer judges them at all — which is why `judged` fell by 18 too.
 *
 * TWO FINDINGS FROM THE PASS THAT THE NEXT LANE SHOULD NOT HAVE TO REDISCOVER:
 *
 *   - `routes/messaging.ts:1841` was cited by TWO rows in census-telegraph for
 *     TWO UNRELATED claims — T2's `reply_to_id` and T313's history-bound
 *     application. One line number, two claims, so they needed DIFFERENT repairs
 *     (`:2928#reply_to_id` and `:1879#visibleFromOf`). A blanket "1841 -> X" would
 *     have been right for at most one of them.
 *   - census-layover §L5's ledger row cites `.delete()` at `:473` / `.insert()` at
 *     `:477` and states in the same sentence that those were the lines AT
 *     `af1864a7` and `014a25d5`, giving `:596`/`:600` for the merged head. That row
 *     is a HISTORICAL record of where the code was, not a live pointer. It is dead
 *     by this checker's rule and it was deliberately LEFT dead. Repointing it would
 *     destroy the only thing it exists to say.
 *
 * 226 of the 276 sat in this lane's files and many of the rest are still
 * repairable; they were left because a pointer repair is only honest once someone
 * has read the claim, and nineteen is what this pass actually read.
 *
 * LOWERED AGAIN 2026-09-14, 257 -> 255, by the Telegraph integration. The
 * membership-honesty and read-marker changes shifted `routes/messaging.ts` by up
 * to +150 lines and pushed five unanchored citations onto `}` or a blank line.
 * All five were repaired by reading the claim, not by the offset:
 *   T34/T164's `:615` -> `:889#router.post('/message-requests/:requestId/accept'`
 *     — both rows assert the ACCEPT_REQUEST route, so both name the route itself.
 *   T77's `:1213` -> `:1742#.update({ last_read_at: threshold })` — the row says
 *     "the competing WRITER takes no lock", so it must cite the update, not a select.
 *   §14.1's `:1213` -> `:2146#const lastReadAt` — the same old line, a DIFFERENT
 *     claim ("read by exactly one consumer — the caller's own unread count"), so
 *     the same repair would have been wrong here. Same trap as `:1841` above.
 *   CTG-03's `:3918` -> `:4068#await invalidateCompassCache(..., "message_report")`.
 * Each gained an `#anchor`, so doc-citations owns them now.
 *
 * LOWERED AGAIN 2026-09-14, 255 -> 253, by the Media lane. Six citations were
 * ALREADY dead before that pass and had been for some time — most of them
 * unanchored, and `MediaProjectionService.ts:379` was cited THREE times as
 * `readCurrentState` while that line actually read
 * `if (typeof id === "string" && label != null) out.set(id, label);`.
 * That is the failure this ceiling exists to bound: a citation that resolves to
 * a real line and supports nothing. All six were repaired by reading the claim
 * and given an `#anchor`, which is why the count fell by two net while the same
 * pass moved thirty-one others.
 *
 * LOWERED AGAIN 2026-09-14, 253 -> 251, by the Trips and Input Intelligence
 * lanes landing together. Input found FIVE pointers into
 * `useInputAssistance.ts` that were already wrong at their lane base — off by
 * 39 and 47 lines — and invisible to this checker only because they happened to
 * land on non-blank lines. Same class as the Media lane's six: a citation that
 * resolves is not a citation that is right, and this ceiling bounds only the
 * half a script can see. All were repaired by reading the claim.
 *
 * LOWERED AGAIN 2026-09-14, 251 -> 249, closing a citation that three
 * census-trips rows shared. `routes/tripReservations.ts:497` was the "stricter
 * delete rule" for TR108 and `TRIP_BOOKING_NOT_CREATOR_OR_OWNER` for TR447; the
 * line is now blank and the rule is `canManageBooking(..., "delete")` at :536,
 * with its gate at :96 rather than :95. Both were anchored while repointing, so
 * doc-citations owns them now and this checker no longer judges them.
 *
 * NOT repaired, deliberately: census-trips:2894 cites `SafeReturnService.ts:17`
 * and its own row says the symbol is at `:18`. That row is a RECORD OF THE
 * DRIFT, not a live pointer — the same class as census-layover §L5, and
 * repointing it would destroy the only thing it exists to say. */
export const MAX_DEAD_TARGETS = 249;

/** Pinned to a commit by its own declaration; its lines must not track HEAD. */
const PINNED_DOCS = new Set(['docs/architecture/mobile-reachability-ledger.md']);

/** A line that cannot evidence anything: brackets, punctuation, comment fences. */
const NOTHING_RE = /^(?:[{}()\[\];,]|\/\*\*?|\*\/|\*|\/\/|<\/?[A-Za-z][\w.-]*\s*\/?>)+$/;

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
const dead = [];
let judged = 0;

for (const doc of files) {
  if (PINNED_DOCS.has(doc)) continue;
  const raw = fs.readFileSync(path.join(root, doc), 'utf8');
  const { citations } = extractCitations(raw);
  for (const c of citations) {
    if (c.anchor !== undefined) continue;            // doc-citations owns these
    let spec;
    try { spec = expandLineSpec(c.spec); } catch { continue; }
    if (!spec?.ranges?.length) continue;
    const [lo, hi] = spec.ranges[0];
    if (spec.ranges.length !== 1 || lo !== hi) continue;  // ranges are not judged
    if (lo === 1) continue;                               // `:1` means "this file"
    let target;
    try { target = resolveCitationPath(c.file, byBasename, path.dirname(doc)); } catch { continue; }
    const rel = Array.isArray(target) ? (target.length === 1 ? target[0] : null) : target;
    if (!rel) continue;                                   // unresolved/ambiguous: not ours
    let lines;
    try { lines = fs.readFileSync(path.join(root, rel), 'utf8').split('\n'); } catch { continue; }
    if (lo > lines.length) continue;                      // past EOF: doc-citations reports it
    judged += 1;
    const txt = (lines[lo - 1] ?? '').trim();
    if (txt === '') dead.push({ doc, docLine: c.line, cite: `${c.file}:${c.spec}`, at: `${rel}:${lo}`, why: 'blank line' });
    else if (NOTHING_RE.test(txt)) dead.push({ doc, docLine: c.line, cite: `${c.file}:${c.spec}`, at: `${rel}:${lo}`, why: `only ${JSON.stringify(txt)}` });
  }
}

const byDoc = new Map();
for (const d of dead) byDoc.set(d.doc, (byDoc.get(d.doc) ?? 0) + 1);

console.log(`check:citation-targets — ${judged} single-line unanchored citation(s) judged, ${dead.length} land on nothing (ceiling ${MAX_DEAD_TARGETS})`);
for (const [doc, n] of [...byDoc].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${doc}`);
}
if (LIST) {
  console.log('');
  for (const d of dead) console.log(`  ${d.doc}:${d.docLine}  \`${d.cite}\` -> ${d.at} (${d.why})`);
}

console.log('');
console.log('  DOES NOT COVER: whether a citation that lands on real code lands on the');
console.log('  RIGHT real code. This is a FLOOR on the stale-pointer problem, not a measure');
console.log('  of it — the general case needs the claim read, and no script can do that.');

if (dead.length > MAX_DEAD_TARGETS) {
  console.error(
    `\n✗ ${dead.length} citation(s) land on nothing, ceiling is ${MAX_DEAD_TARGETS} — ` +
    `${dead.length - MAX_DEAD_TARGETS} more than when this ceiling was measured. Repoint each ` +
    `by READING the claim and finding the line that carries it — never by offset, never to a ` +
    `nearest candidate — and add an \`#anchor\` while you are there so doc-citations keeps it ` +
    `honest afterwards. Run with --list to see them.`,
  );
  process.exit(2);
}
// Falling below the ceiling is a PASS, not a failure. A ratchet that went red
// on an improvement would punish the only behaviour it exists to encourage, and
// the next lane would raise the constant to get green instead of keeping the
// gain. It prints a nudge instead, and the number is only kept once someone
// lowers the constant.
if (dead.length < MAX_DEAD_TARGETS) {
  console.log(`✓ ${dead.length} < ${MAX_DEAD_TARGETS} — LOWER THE CEILING in scripts/check-citation-targets.mjs to ${dead.length}, or this gain is not kept.`);
} else {
  console.log(`✓ at the ceiling: ${dead.length} / ${MAX_DEAD_TARGETS}.`);
}
