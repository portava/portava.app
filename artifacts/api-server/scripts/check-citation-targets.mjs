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
 * LOWERED AGAIN 2026-09-14, 249 -> 248, by the integration owner. Four
 * citations into `MediaProjectionService.ts` came loose when the candidate read
 * was rewritten into the destructuring shape the unchecked-reads guard can
 * read (+12 lines). THREE OF THE FOUR WERE ALREADY WRONG and this checker could
 * not see it: MD9 and MD354 cited `:344` for `projectCandidatesProtected`, which
 * was true at census-media's own `head_commit` 42aeac38 and has since moved to
 * `:575`; MD220 cited `:748` for the Postcards My-World bucket, which was 13
 * lines off even at that baseline (`:761` then, `:1271` now). The +12 only
 * pushed them onto blank lines, where the script could finally count them. All
 * three were repaired by reading the claim and anchored while repointing, so
 * doc-citations owns them now and this checker no longer judges them — which is
 * where the fourth of the gain comes from, and why the ceiling drops by one
 * rather than by four.
 *
 * The fourth was NOT a live pointer: census-input-intelligence:2531 references
 * `MediaProjectionService.ts` line 379 inside a sentence ABOUT citation rot —
 * an anecdote whose whole content is where a line used to be. Repointing it
 * would have falsified the record, so the parseable `file:NNN` was removed and
 * the prose left saying exactly what it said. Same treatment as the
 * SafeReturnService case below.
 *
 * NOT repaired, deliberately: census-trips:2894 cites `SafeReturnService.ts:17`
 * and its own row says the symbol is at `:18`. That row is a RECORD OF THE
 * DRIFT, not a live pointer — the same class as census-layover §L5, and
 * repointing it would destroy the only thing it exists to say.
 *
 * LOWERED AGAIN 2026-09-15, 248 -> 244, by the integration owner, on a gain
 * this branch can account for rather than one it merely observed. Merging
 * twelve lanes moved lines under eleven unanchored pointers and the count went
 * 247 (at the merge base 76698a377) -> 255. All eleven were repaired, and the
 * split is the same one this file keeps making:
 *
 *   SEVEN WERE LIVE POINTERS, repaired by reading the claim and anchored while
 *   repointing, so doc-citations owns them now and this checker no longer
 *   judges them:
 *     census-highlights-memories:767,821  `routes/highlights.ts` :945 -> :952,
 *       the DELETE the row actually names (:945 was `if (error) {` even at the
 *       base -- it resolved, onto the wrong thing);
 *     census-highlights-memories:812      :112 -> :148#function applyResurfacingControls;
 *     census-telegraph:2870,2926          `lib/telegraphEvents.ts` :439 ->
 *       :717#export function emitSafetyReported, the emitter T194's claim is about;
 *     census-trust:2037                   `routes/tripCrewLocation.ts` :439 -> :484,
 *       the getRestrictionState call site -- a drift the Trips lane reported and
 *       correctly declined to fix in a document it does not own;
 *     manual-production-migration-runbook:1275  `routes/rankEvents.ts` :68 -> :75.
 *
 *   FOUR WERE RECORDS OF DRIFT, given the treatment this file already
 *   prescribes: the parseable `file:NNN` removed, every digit left where it
 *   was, the prose saying exactly what it said.
 *     census-trips §37.2 is a dated measurement table -- column 1 is the stale
 *     citation, column 3 is where it was on the day it was measured. Two of its
 *     column-3 cells (`:400`, `:45`) were being PAIRED with column 1's filename
 *     and judged as live pointers. Rendering only: `| :400 |` -> `| line 400 |`.
 *     census-highlights-memories:4392,4558 quote a WRONG `"handler"` value in
 *     mobile-reachability-ledger.json (memories.ts:1407) in order to report that
 *     it is wrong. The merge also falsified the census's own sentence about that
 *     line -- it said the line "is `  }`", and it is now blank -- so the sentence
 *     was corrected to say so, which is a repair of a claim, not of a pointer.
 *     The correct handler it names, :2819#router.get, still holds and was checked.
 *
 * 255 -> 244, which is three below the base's own 247, so the ceiling moves to
 * 244 rather than back to 248.
 *
 * LOWERED AGAIN 2026-09-16, 244 -> 239, by the integrating lane at the telegraph
 * merge. The five came from repairs made while integrating that lane, not from a
 * dead-target sweep: eighteen `routes/index.ts` and eight `messageKinds.ts`
 * anchors were repointed by a diff line-map after two new lines and three
 * formatting reversals moved them, three unanchored `lib/mediaPipeline.ts`
 * references were repointed by hand, and census-trips TR436's
 * `lib/mediaPipeline.ts:44` -- which pointed at an import while its own sentence
 * described the kill-switch consumption -- was corrected to `:112`. The ceiling
 * follows the measurement down so the gain cannot be spent again.
 *
 * LOWERED AGAIN 2026-09-16, 239 -> 238, at the branch-3c ownership fix. The
 * gain is not a sweep: closing MEDIA-2 added lines to routes/messaging.ts and
 * lib/mediaAccess.ts, which moved 113 line-anchored citations and 83 BARE
 * INHERITED ones. The inherited class is the interesting half — a `:NNN` that
 * takes its file from an earlier citation on the same line binds to no file as
 * far as either checker is concerned, so it rots in silence. Repointing them by
 * attribution (scan the line left to right, track the current file, shift only
 * the refs inheriting a file that moved) also corrected one that had been dead
 * before this branch, which is where the extra 1 comes from.
 *
 * LOWERED AGAIN 2026-09-16, 239 -> 235, by the fixed-date sweep lane. The four
 * are not a dead-target sweep either: adding an injected-clock parameter to
 * `getCrewMap` and to the media candidate loader moved lines under
 * `docs/architecture/census-media.md`, and five citations that had been landing
 * on real code by accident landed on comment text instead. They were repointed
 * by READING the claim, not by offset -- four `MediaProjectionService.ts:916`
 * references whose sentences are all about the §21 map projection now point at
 * `buildMediaMapProjection` where it actually is, and MD412's
 * `MediaActionResolver.ts:413` now points at the `ask_compass` action it
 * describes. All five gained an anchor, so doc-citations keeps them honest from
 * here and this cannot silently rot back.
 *
 * MERGED 2026-09-16. Two lanes lowered this independently in the same day —
 * 239 -> 238 at the branch-3c ownership fix, and 239 -> 235 at the date sweep,
 * which repointed five already-stale unanchored citations by reading the claim.
 * Neither number describes the merged tree, so the ceiling below is RE-MEASURED
 * after the merge rather than chosen between them. Both lanes' reasoning is
 * preserved above and below this note.
 *
 * RE-MEASURED 2026-09-16 at the V2 merge: 232. Neither lane's number described
 * the merged tree, and the merge itself was not neutral — comparing the dead
 * list at 42a63bd40 against the merged tree named FIVE new entries at three
 * sites, four from the date lane's `nowMs` threading through
 * MediaActionResolver and one from a test this lane added. All three were
 * repaired by reading the claim (the gem disclosure at :274, `add_to_trip` at
 * :592, the thread-rollback case at :502) and given anchors, so doc-citations
 * now holds them. The ceiling is the measurement, not a choice between 235 and
 * 238.
 *
 * LOWERED 2026-09-22, 210 -> 209, at the four-lane Telegraph/Input integration.
 * LOWERED 2026-09-22, 209 -> 207, by the §6/§7 rich-messaging lane. Adding the
 * T80 edit-history writer shifted every line of `routes/messaging.ts` after the
 * import block, so all 172 file:line citations to it — and the 76 bare `:NNN`
 * continuations that inherit it — were repointed through the diff's exact
 * insertion map and each anchored one re-verified against the line it names.
 * Two citations that had been dangling before that pass now land on real code,
 * because the bare continuations had been stale and the remap put them right.
 * Not a sweep: the history-privacy lane threaded a visibility window through
 * `compass/TelegraphConversationTools.ts`, which moved five citations in
 * census-telegraph onto blank lines and closing braces. They were repointed by
 * reading the claim and finding the declaration it is about — the spec-name map,
 * `gateConversation`, `telegraphGetParticipantAvailability`,
 * `telegraphCreatePlanDraft` and the `requiresConfirmation: true` literal — never
 * by offset, and all five gained an `#anchor`, so doc-citations holds them from
 * here and they cannot silently rot back. The net is one BELOW the old ceiling
 * rather than level with it because the anchors also moved one previously
 * unanchored citation out of this check's population. The number below is what
 * the tool measured at that tree, not a target chosen for it. */
/* LOWERED AGAIN 2026-09-22, 209 -> 208, while making four membership reads
 * statically resolvable. The gain is one citation, and it is a REAL repair
 * rather than a side effect: census-telegraph cited
 * `routes/groupChat.ts:371` for the sentence "Deletion redacts in place —
 * `.update({ deleted_at: now, body: '' })`", and line 371 has never carried that
 * statement. It was landing on unrelated real code, which is why this check —
 * which only asks whether a line is EMPTY — had been satisfied by it. Repointed
 * to :609, where the redaction actually is, and anchored. The other two moved
 * citations in this change were ordinary shifts and were repointed to the lines
 * their claims describe, also with anchors. */
/** RE-MEASURED 2026-09-22 by the Telegraph lifecycle lane: 208. That lane's own
 * edits shifted FOUR citations onto blank lines (`routes/availability.ts` :161
 * and :706, `server/telegraph/commandRoute.ts` :70, and
 * `domain/telegraph/commands/telegraphCommands.ts` :97), and repairing them by
 * READING the claim found two more that were already dead at the same sites —
 * `commandRoute.ts:271`/:306 and `telegraphCommands.ts:121`. All six were
 * repointed and given anchors, so doc-citations holds them now and an offset
 * repair cannot bring them back. */
/** MERGED 2026-09-22. Two lanes lowered this to 208 independently, for
 * DIFFERENT repairs — the membership-read rewrite above and the lifecycle
 * lane's four shifted citations plus the two already-dead ones it found at
 * the same sites. Neither number describes the merged tree, so the value
 * below is RE-MEASURED after the merge rather than chosen between them.
 * Both rationales are kept because both repairs are in this tree.
 *
 * The merged measurement is 206, BELOW both lanes' 208, because the two sets of
 * repairs are disjoint: one repointed citations into
 * `compass/TelegraphConversationTools.ts` and the four membership reads, the
 * other into `routes/availability.ts`, `server/telegraph/commandRoute.ts` and
 * `domain/telegraph/commands/telegraphCommands.ts`. Neither lane could have
 * measured this number, which is the reason the ceiling is re-measured after a
 * merge instead of inherited from whichever branch landed last. */
/* RE-MEASURED AGAIN 2026-09-22 at the saved-messages merge. That lane
 * inserted seven import lines into `routes/messaging.ts`, which renumbered
 * EVERY line of the file and moved 248 citations across five documents; it
 * repointed them and measured 207 in its own worktree. This tree measures
 * something else again, for the same reason as the merge above: the repairs
 * are disjoint and no branch can see the union. The value below is the
 * measurement at the merged tree: 205. */
/* LOWERED 2026-09-22 by the departed-member membership fix. Adding
 * `.is('left_at', null)` to the three state-changing membership gates in
 * `routes/messaging.ts` inserted thirteen lines and renumbered everything
 * below them, which broke 41 anchored citations and 14 unanchored ones.
 * doc-citations names the exact line each anchor moved to, so those 41 were
 * repointed from the check's own reading rather than by offset. The 14
 * unanchored ones turned out to be rot that PREDATED this change by hundreds
 * of lines — `:2076` for the media endpoint when the endpoint is at 3155,
 * `:2720` for the message-report writer when it is at 4296 — so each was
 * repointed by reading the claim and given an anchor, which also removes it
 * from this check's unanchored population. That is where most of 205 -> 193
 * comes from: 12 citations left the population and the rest now land.
 *
 * Two lanes still unmerged (lane-media-voice, lane-domain) carry their own
 * ceilings, 205 and 201, each measured on a base that cannot see this repair.
 * RE-MEASURE at the merge; do not inherit any of the three. */
/* LOWERED 2026-09-22, 209 -> 201, by the Telegraph domain/commands/authorization
 * lane. Also not a sweep. That lane made three edits inside `domain/telegraph/`
 * — a `dispatchTable` import in `contracts/conversationSearch.ts` and
 * `commands/telegraphCommands.ts`, and one in `policies/attentionLadder.ts` —
 * plus a comment in `routes/telegraphCommands.ts`, and the shifts broke
 * seventeen citations across census-telegraph, census-discovery and
 * census-compass. Every one was repointed by READING the claim and finding the
 * line that carries it: `:390` was the confirm-action block's own sentence about
 * re-verifying trip membership, `:34` was the `create_meetup_draft` intent, `:80`
 * and `:158` were the safe-metadata allowlist and where it is applied, and
 * 3586's `:412` and `:398` were the authorize hook and the ownership refusal —
 * the last two had been imprecise BEFORE the shift and now point at the lines
 * that actually carry those two claims. All of them gained an `#anchor`, which
 * is why the net is eight below rather than level: the anchors moved eight
 * previously unanchored citations out of this check's population and into
 * doc-citations', where a rot is named rather than merely counted. */
/* MERGED 2026-09-22, lane-domain. Its 201 and this tree's 193 were measured on
 * bases neither could see the other from: this tree's repair repointed and
 * anchored citations into `routes/messaging.ts`, that lane's into
 * `domain/telegraph/` and `routes/telegraphCommands.ts`. Disjoint repairs, so
 * the union is below both and neither number may be inherited. The value below
 * is the measurement AT THE MERGED TREE. */
/** MERGED AGAIN 2026-09-22, by the §16/§18 MEDIA / VOICE / COMPASS lane, and
 * the rule the paragraph above set is applied to itself: the number is
 * RE-MEASURED after this merge rather than carried over from either side.
 *
 * This lane's repairs are disjoint from both of the two above. Closing the
 * silent zero in `telegraphGetConversationContext` and threading a translation
 * confidence through `services/messageTranslation.ts` shifted eight ANCHORED
 * citations and six UNANCHORED ones. All fourteen were repointed by reading
 * the claim — the six §18.3 tool entry points in census-telegraph's §11.4
 * row-move table, the `requiresConfirmation: true` and `safetyBasis` literals,
 * the four `messageTranslation` declarations, `executeTelegraphConversationTool`
 * in census-compass and the definitions array in census-highlights-memories —
 * and the six unanchored ones GAINED an `#anchor`, which is what moves them out
 * of this check's population for good.
 *
 * It overlaps the membership-read lane on ONE file, `TelegraphConversationTools.ts`,
 * and on no citation: that lane repointed `:73` (the spec-name map) and
 * `gateConversation`, this one repointed the eight accessors and the two
 * literals below them. The overlap is why the number is measured and not
 * summed.
 *
 * MEASURED AFTER THE REBASE, AT 205, and the number is the reason this
 * paragraph exists rather than a note saying "unchanged". This lane measured
 * 208 against `b7dd1c71f` and the merged tree measures 205 — a figure NEITHER
 * side could have produced, because the three sets of repairs are disjoint and
 * each one's anchors move a different citation out of this check's population.
 * Carrying 208 forward would have been a ceiling three above the truth, which
 * is a ratchet that has quietly stopped ratcheting. */
/* MERGED 2026-09-22, lane-media-voice — the fourth disjoint repair set, and the
 * rule every paragraph above states is applied once more: measured here, never
 * carried. That lane measured 205 against a tree without this branch's
 * messaging.ts repoints or lane-domain's `domain/telegraph/` ones; this branch
 * measured 189 without its fourteen. Neither number survives the union. */
/* LOWERED 2026-09-22 while clearing `check:write-path-columns` on PR 521. Three
 * writes/reads that lanes had left computed were made statically resolvable
 * (two `membershipSelect(...)` select lists, and the `message_edits` insert
 * whose whole payload came from a one-caller helper). That shifted
 * `routes/messaging.ts` again and moved 88 anchored citations, each repointed
 * to the line doc-citations names, plus 24 UNANCHORED ones that had been landing
 * on real-but-wrong code for a long time — `:2378` for an Edited marker that is
 * at `:2502`, `:1855` for a send insert at `:2804`, `:708` for an origin write
 * at `:782`. Those 24 were repointed by reading the claim and every one gained
 * an `#anchor`, which is what takes them out of this check's population for
 * good. 188 -> 186. */
/* LOWERED 2026-09-22 while correcting the §2 concession arithmetic. That edit
 * added 24 lines to census-telegraph.md and moved FIVE cross-document pointers,
 * all of which turned out to be wrong ALREADY — the shift only made one of them
 * land on a blank line instead of on unrelated prose, which is the difference
 * between a citation this check can see and one it cannot. The two census-media
 * pointers name WHERE IN census-telegraph a citation lives; grep put the two
 * MediaProjectionService.ts:1502 citations at :346 and :1164, and both pointers
 * were stale by 18 and 45 lines respectively. No `#anchor` was added to those
 * two on purpose: the target line's own text IS a citation, so an anchor would
 * nest a `#` inside an anchor and no pass could read it — the one case where
 * the standing "anchor it while you are there" instruction does not apply, and
 * it is written down here rather than left as an apparent omission. 186 -> 185. */
/* LOWERED 2026-09-22 while merging `main` (#452, #453) into PR 521, and the
 * cause is recorded because it is NOT a repair anyone made. #453 added lines to
 * `travel-buddy-standalone/src/features/passport/TrustScreen.tsx`, which moved
 * the line `passport-certification.md:92` points at: `TrustScreen.tsx:346` used
 * to land on `</View>` — punctuation, which this check calls landing on nothing
 * — and now lands on `{view.domains.map((row) => (`. The pointer got no truer;
 * it stopped being VISIBLE to this check, which is the failure mode a ratchet
 * measured on a floor has to be honest about. So the pointer was repointed by
 * reading its claim — "Client renders server flags only … TrustScreen note" is
 * the §11 footer note, not a domain map — and anchored, which is what takes it
 * out of this population for good: `TrustScreen.tsx:379#server owns
 * authorization`, verified by check:doc-citations rather than by an offset. The
 * ceiling falls to the measured number either way, because a ceiling that
 * refuses a drop it did not earn stops being a ceiling. 185 -> 184. */
/* LOWERED 2026-09-22 integrating Q6 (the own-message rejoin exception). The
 * lane repointed 167 citations across four census documents after its change
 * moved `routes/messaging.ts`, `services/groupChatHistoryBound.ts` and the
 * telegraph route tree, and the measured count came back 183.
 *
 * THE LANE DECLINED TO LOWER IT, AND THAT WAS MY FAULT. Its brief said "do not
 * lower a floor or raise a ceiling", which it read — reasonably — as "do not
 * move it at all". The ratchet's own rule is narrower and is stated at the top
 * of this file: the ceiling may only FALL, and a measured gain that is not
 * banked is a gain thrown away. So the number is taken here, by the
 * integrator, on the integrated tree rather than on the lane's base.
 *
 * 184 -> 183. */
/* LOWERED 2026-09-22 by the HIGHLIGHTS & MEMORIES lane (census §Q). ONE pointer
 * left the population, and it is worth reading which, because the first version
 * of this drop would have been the failure mode the 185 -> 184 note above
 * describes rather than a repair.
 *
 * MEASURED BOTH WAYS, not inferred: `git archive 812720cc0` was extracted and
 * this script run against that tree with --list, giving 183 and a line-by-line
 * list; the same run on the lane's tree gives 182, and `diff` of the two lists
 * is exactly ONE line —
 *   docs/architecture/census-highlights-memories.md:814
 *   `routes/highlights.ts:83` -> …/routes/highlights.ts:83 (blank line)
 *
 * THE POINTER WAS DEAD BEFORE THIS LANE AND THE LANE NEARLY HID IT. Line 83 of
 * routes/highlights.ts was BLANK at 1fe72289b and still blank at 812720cc0, so
 * H91's citation had been pointing at nothing for two head_commits. §Q's edits
 * to that file pushed a comment line onto 83, which would have removed it from
 * this count while leaving the row citing a sentence about column projection
 * for a claim about §11 control enforcement — a pointer that got no truer and
 * merely stopped being VISIBLE here.
 *
 * So it was repointed by READING THE CLAIM instead. The row says
 * "KEEP_PRIVATE_FOREVER declared and in FEED_SUPPRESSING_CONTROLS"; no such
 * constant exists any more — §O.6 replaced it with FEED_ENFORCEABLE_CONTROLS,
 * derived from CONTROL_EFFECTS — so the citation now names that constant and
 * its application site, ANCHORED, which takes it out of this population for
 * good because check:doc-citations holds it from here rather than an offset.
 * The row's verdict is untouched.
 *
 * 183 -> 182.
 *
 * ── main's history, kept verbatim ──────────────────────────────────────────
 *
 * LOWERED 2026-09-22, 210 -> 209, by the p0 moderation-and-safety-reads lane.
 * The branch arrived at 212 because its own line shifts killed three pointers,
 * and the repairs went one past putting it back. None was moved by offset:
 *
 *   - `routes/geofence.ts:872` in trust-unproduced-vocabulary.md was cited for
 *     "the trip owner adjudicates a member as no_show". That line was the
 *     ATTENDANCE-DASHBOARD banner before the shift and a closing brace after it;
 *     the range it sat in never held the override handler at all. Repaired by
 *     reading the claim: the owner-gated override route is `:1044`, its owner
 *     gate `:1077`, and the branch the sentence is about is `:1150#no_show`.
 *   - `routes/safeReturn.ts:852` in census-trust.md was not a live pointer at
 *     all -- it is a parenthetical recording what the citation USED to be. It
 *     is now spelled out in words, which is the fix for a historical number
 *     (compare census-layover's L5 note above, left dead because repointing it
 *     would destroy what it exists to say; spelling it out keeps the record AND
 *     the ratchet).
 *   - `routes/rentABuddy.ts:6251` in 08_Portava_Revenue_Model.md pointed into a
 *     claim that no longer has any carrying code. `platformFeePct = 0.15` has
 *     ZERO occurrences in that file, as do the other two literals of the same
 *     defect in theirs; one resolver reads `rent_buddy_fee_rules` with no
 *     numeric fallback arm. A faithful repoint was impossible, so the claim was
 *     corrected and dated in all three documents that carry it, and the three
 *     pointers -- which an earlier pass had moved BY OFFSET onto the
 *     traveller-eligibility endpoint's `isNightlife` line -- were removed.
 *
 * The one past came from `09_Payment_Architecture.md:529`, cited across
 * documents by census-discovery for the quote "Payments are not a discovery
 * workstream"; the correction above shifted that file, so it now carries the
 * quote as its anchor. 212 -> 209.
 *
 * ── MERGED 2026-09-22 ──────────────────────────────────────────────────────
 *
 * Both histories are kept: each records repairs that were really made, on the
 * two sides of a merge that had diverged. NEITHER number is carried over. This
 * branch stood at 181 and main at 209, and adopting either would assert a count
 * of a tree neither side had measured. The value below is the count of THIS
 * merged tree, measured after the merge: 179, which is BELOW both sides — this
 * branch had repaired more than main and main had repaired some this branch
 * had not, so the union is better than either. */
/* RATCHETED 2026-09-22 179 -> 178. The citation repair that came with the §17
 * command-boundary lane retired one more dead target than it created. Lowering
 * this is TIGHTENING: the guard itself printed "178 < 179 — LOWER THE CEILING
 * ..., or this gain is not kept", and a ceiling left above the measured count
 * silently re-admits the rot that was just removed. Measured on a quiet tree,
 * after both lanes had landed and stopped editing, so the number is not a
 * reading taken mid-edit. */
/* MERGED 2026-09-23 with PR #527. `main` carried 204 and this branch 178.
 * 178 is kept because a ceiling may only FALL: adopting 204 would re-admit
 * 26 dead targets this branch had already repaired, which is the same move
 * as raising it. Re-measured against the merged tree immediately after the
 * merge rather than assumed — see the commit message for the figure. */
/* RATCHETED 2026-09-23 178 -> 177, at the integration of PR #458. That merge
 * moved the count to 179: it repaired one target in census-passport and
 * created two in census-trust, on the `C18` and `C19` rows. census-trust §25
 * repaired both by reading the claims — `C19`'s sweep and its test had simply
 * drifted, and `C18`'s bare pointer had never resolved to the file it was
 * cited for — which left the merged tree at 177, one below the ceiling it
 * inherited. The guard printed "177 < 178 — LOWER THE CEILING ..., or this
 * gain is not kept", and that is what this does. Both repairs travel in the
 * same commit as the merge, so nothing here depends on a tree `main` has not
 * got: once this branch lands, `main`'s own count is this count. */
/* RATCHETED 2026-09-23 177 -> 176, in the same pass. PR #527 extended the
 * migration prefix band in the GUARD and left two documents asserting the old
 * rule; repairing `docs/architecture/10_Database_Architecture.md` repointed its
 * citation of `migrationPrefixRules.ts` off a line the edit had emptied and
 * onto the declaration it names, which retired one more dead target. Same rule
 * as above: the guard printed "176 < 177 — LOWER THE CEILING", and a ceiling
 * left above the measured count re-admits the rot just removed. */
export const MAX_DEAD_TARGETS = 166;

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
