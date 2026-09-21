# Accessibility — verification lane V4

**Scope**: the client surfaces the four most recent build lanes added, which had
had no accessibility pass at all.

- `travel-buddy-standalone/src/features/telegraph/voice/VoiceRecorderSheet.tsx`
- `travel-buddy-standalone/src/features/telegraph/voice/VoiceMessagePlayer.tsx`
- `travel-buddy-standalone/src/features/telegraph/kinds/TypedMessageRenderer.tsx`
- `travel-buddy-standalone/src/components/discovery/PlaceCard.tsx`
- `travel-buddy-standalone/src/components/TelegraphInboxScreen.tsx`

**Evidence** (37 assertions, all red first or proven by mutation):

| File | Covers |
| --- | --- |
| `src/features/telegraph/__tests__/verifyA11yTelegraphVoice.component.test.tsx` | player, recorder, typed-kind renderer (21) |
| `src/components/discovery/__tests__/verifyA11yPlaceCard.component.test.tsx` | the Discovery card's controls (7) |
| `src/features/telegraph/components/__tests__/verifyA11yTelegraphInbox.component.test.tsx` | the inbox chips and row badges (9) |

Each header carries the red-first record verbatim: the failing test names, the
expected/actual values, and every mutation run, watched red and reverted.

---

## The four questions

1. Does every interactive element have an accessible **label** and a **role**?
2. Is **state** — recording, playing, dismissed — **announced**, or only drawn?
3. Does a control convey meaning by **colour alone**?
4. Is anything reachable **only by a gesture**, with no button equivalent?

Question 4 found the worst of it, and the reason is worth naming: the build lanes
read §11.3 carefully and it is about colour and motion. Nothing in it says *a seek
bar must be operable without pointing at a pixel*, so nothing was.

---

## `VoiceMessagePlayer.tsx`

### Fixed — the seek was reachable only by pointing at a pixel (question 4)

The waveform declared `accessibilityRole="adjustable"`, which **promises** a
swipe-up / swipe-down adjustment, and implemented none: no `accessibilityValue`,
no `accessibilityActions`, no `onAccessibilityAction`. The entire seek was
`onPress(e.nativeEvent.locationX)` — a tap at a chosen horizontal pixel.

A person using VoiceOver, TalkBack or Switch Control could play and pause a voice
message and **could not move within it at all**. The role made that failure
audible and false: the control announced itself as adjustable.

Fixed with a real `accessibilityValue` (`min`/`max`/`now`, plus a `text` that
speaks as "0:15 of 1:00" rather than a percentage), labelled `increment` /
`decrement` actions, and a handler that performs the **same** seek the tap does.
The step rule is a new pure function, `seekMillisForStep` in `voicePolicy.ts`,
next to `seekMillisForTap` and clamped at both ends for the same reason — an
unclamped decrement at the start hands the native player a value it rejects and
the playhead the person just moved silently stays put.

Five seconds, not a percentage: a percentage step moves 3 s in a one-minute note
and 15 s in a five-minute one, so the same gesture would mean two things.

### Fixed — the waveform was 48 unlabelled stops

The amplitude bars carry nothing the duration and position do not, and each of
the 48 was a focusable, unlabelled node between the play button and the duration.
They are now inside an `accessibilityElementsHidden` /
`importantForAccessibility="no-hide-descendants"` wrapper — the pattern
`PostcardEmptyState.tsx` and `ShimmerBox.tsx` already use.

W1 asserts this in the strongest available form: RNTL's **default** queries walk
the accessibility tree, so it asserts the bars cannot be found by one, *and*
that the hidden-inclusive query still finds them. Hidden, not deleted — the
waveform is the point of the control for everyone who can see it, and removing it
would trade one group's experience for another's.

### Fixed — a playback failure was drawn and never announced

Press Play, nothing happens, and the explanation is painted below the row where
nothing sends you. Indistinguishable from a missed tap. Now
`accessibilityRole="alert"` + `accessibilityLiveRegion="assertive"`, matching
`IntelObservabilityDashboard.tsx`.

### Fixed — the duration changed meaning silently

One `<Text>` is the **total** length before playback and the **remaining** time
during it. A sighted reader has the play/pause icon beside it to disambiguate;
"0:12" on its own does not. Now labelled `Length 1:00` / `0:45 remaining`.

### Already correct — proven by mutation

- **The playback-speed cycle announces the CURRENT speed.** The brief flagged
  this as one of the two likely failures on the surface. It was not one: the
  label interpolates the live `speed`, so 1x → 1.5x → 2x → 1x each announce
  themselves. Mutating it to a static "Playback speed" turned S1 red.
- **The play control's label follows its state** (`Play` ⇄ `Pause voice message`)
  and carries `accessibilityState.selected`. Mutating it to a static label turned
  P2 red.

---

## `VoiceRecorderSheet.tsx`

### Fixed — "Recording" and a denied microphone were drawn, never announced

The sheet's phase line already said the state in words — §11.3 was honoured — and
nothing ever spoke it, because the press that changes the phase leaves focus on a
button. That matters most for the two states on this surface that are not
cosmetic:

- **Recording.** A microphone is open. This is the single most consequential
  state the sheet has.
- **A denied microphone permission.** The file's own header says it "is stated,
  once, in words, with no retry loop". It is — and the one statement the flow
  makes was inaudible to the people most likely to need it.

The phase line is now `accessibilityLiveRegion="polite"`; the error line is
`accessibilityRole="alert"` + `accessibilityLiveRegion="assertive"`.

### Fixed — the SENDING spinner was an unlabelled node

The phase line beside it already says "Sending…" as a live region. A second node
announcing nothing is noise, so the `ActivityIndicator` is now hidden from the
accessibility tree. R4 asserts both halves: the spinner is unreachable by a
default query **and** the words are still there.

### Already correct — proven by mutation

Every control (`Record`, `Stop`, `Discard`, `Send`, `Close`) already had
`accessibilityRole="button"` and a descriptive label. Deleting one turned R3 red.

---

## `TypedMessageRenderer.tsx`

No defects found. Three properties were asserted and proven by mutation rather
than by reading:

- **SAFETY states its kind in words** (`NEEDS HELP` / `ALL CLEAR` / `HEADS UP` /
  `CHECK-IN`). §11.1 reserves the attention colour for safety, and a 2px red
  border is the entire visual difference between a SAFETY card and a LOCATION
  one. Replacing `safetyWord(p.kind)` with a space turned all four T1 cases red.
- **The VOICE arm dispatches to `VoiceMessagePlayer`**, so the player's fixes
  reach the thread. Rendering follows the stored envelope, not the send path, so
  a fix made in the player is only real if this dispatch uses it (T2).
- **The two inert-affordance notices are text.** A surface that cannot confirm an
  ACTION or acknowledge an ANNOUNCEMENT says so in a sentence. Had it said so
  only by omitting a button, a screen-reader user would have no way to know the
  affordance was ever meant to be there (T3).

---

## `PlaceCard.tsx`

### Fixed — six of seven pressables had no role; two had no name either

The "Not interested" control the build lane added was labelled and roled. The
controls beside it, which shipped earlier and were never swept, were not:

| Control | Before | After |
| --- | --- | --- |
| Bookmark (`place-card-save-*`) | **no role, no name**, and a toggle whose only state signal was the glyph's fill colour — saved and unsaved announced identically | role, `Save X` ⇄ `Remove X from saved`, `accessibilityState.selected` |
| Trip wishlist | **no role, no name, no testID** — not addressable by any accessibility-facing property, and it writes to a trip | role, `Add X to a trip wishlist` |
| Plan | name from its own text, no role; `Added ✓` was the only done-signal and the tick is a glyph inside a Text | role + `accessibilityState.selected / disabled` |
| Route, Directions | names from their own text, no role | role |
| Card root (opens the place) | no role — announced as a group of text, not as something to act on | role. **No label on purpose**: `accessible` already derives the name from the card's own text (name, category, distance, rating), and a hand-written label would replace all of it with just the place name. |

The unlabelled bookmark is question 3 as well as question 1: the toggle's whole
state was a fill colour.

D7 is the sweep rather than a list of the controls that happened to get a case.
It walks the rendered **host** tree for Pressables, deliberately *not*
`getAllByRole('button')` — a role-less control is invisible to a role query, so
the query would be blind to exactly the defect it exists to catch. A name is an
explicit label **or** the control's own visible text; a role is required
unconditionally.

### Fixed — a refused dismissal was drawn and never announced

The card deliberately stays put when the server refuses and explains why in one
line. Nothing sends a reader to that line: focus is on the button, the button has
not changed, and the only other signal is the thumb icon turning `color.signal`.

So the outcome a sighted user reads as "it failed, tap again" is, for a
screen-reader user, indistinguishable from a tap that did nothing — which is
*precisely* the "a card that silently stays looks like a missed tap" failure the
build lane's own header set out to forbid, surviving in the one channel it did
not check. Now `accessibilityRole="alert"` + `accessibilityLiveRegion="assertive"`.

### Fixed — the in-flight dismissal announced as idle

`disabled={dismissing}` stops the second press and tells nobody: the control
still announced as an enabled button while the request ran. Now
`accessibilityState={{ disabled, busy }}`.

### Already correct — proven by mutation

- **The dismiss label names the place** (`Not interested in Sirao Flower Garden`).
  In a list of identical cards, "Not interested" alone names nothing. Shortening
  it turned D6 red.
- **The failure is a sentence, not just a red icon.** Deleting the copy turned D2
  and D3 red.

---

## `TelegraphInboxScreen.tsx`

The inbox's whole job is to say, at a glance, *which* conversation needs you and
*how much*. Every one of those signals is a badge — a number in a bubble, a bell
with a line through it, a chip that is a different colour when it is the one
you're on. None is a sentence, and until this sweep none carried one, so the
entire "at a glance" layer was available at a glance and nowhere else.

### Fixed — the filter chips were role-less and "active" was a fill colour

Six chips (All / Direct / Trips / Circles / Unread / Requests) whose only
selected-state signal was `s.chipActive`, a background fill. The screen could
name the six filters and could not say which one you were on — the one fact you
need to interpret every row below it. Now `accessibilityRole="button"` and
`accessibilityState={{ selected }}`.

### Fixed — the requests badge was a naked number beside a word

Rendered as two nodes: "Requests", then "3". A reader says them in sequence, or
grouped as "Requests 3", which is as likely to be heard as an ordinal as a count.
The count is now folded into the chip's own label (`Requests, 3 pending requests`)
and the bubble is hidden so it is spoken once.

### Fixed — an unread count was a naked number in a bubble

The row read "mira, 3, 2h ago". The 3 is the most important thing on the row and
was the one thing that did not say what it was. The bubble is now labelled
`3 unread messages` and the digits inside it are hidden.

The label is **not** capped at "99+". The bubble caps because the digits do not
fit; that is not a reason to throw away a number we are holding, so a 250-unread
thread announces 250 (I3b). I3c asserts a read thread still renders no badge, so
the fix cannot invent one.

### Fixed — "muted" was a glyph and nothing else

A `<BellOff size={12} />` between the name and the type badge. Muting decides
whether a conversation can reach you at all, and a reader could not tell a muted
thread from an unmuted one. Now a labelled wrapper the reader can reach.

### Already correct — proven by mutation

**The §19 needs-action badge is a sentence** ("1 needs action" / "2 need action",
pluralised). It is asserted here because it is the control for every other badge
on the row: the same row had one badge that said what it counted and two that did
not. Reducing it to a bare count turned I6 red.

---

## Not fixed — reported, with the reason

### A1. `TelegraphRow` has no `accessibilityRole="button"`

`src/components/telegraph/TelegraphPrimitives.tsx#TelegraphRow` is the press
target for every inbox row, and it is a bare `<Pressable>` with no role. The row
therefore announces as a group of text rather than as something that opens a
conversation.

Not fixed here for two reasons. It is a shared primitive used by several surfaces
outside this lane's scope, and — more to the point — the established inbox test
harness (`TelegraphInboxNeedsAction.component.test.tsx`, whose mock set this
lane's inbox file inherits) **stubs `TelegraphRow` out to a plain View**, so no
test in this workspace currently renders the real one. Adding a role without a
test that can see it would be an unverified change. Wanted: a small
`TelegraphPrimitives` component test that renders the real row, then the role.
This is stated in the inbox test file's header too, so it cannot be lost.

### A2. Two pre-existing assertions were repointed, not weakened

Hiding decoration from the accessibility tree makes it unreachable by RNTL's
default queries, which broke two existing tests that were querying decoration
directly. Both were repointed at the same nodes through hidden-inclusive queries,
with a comment saying why:

- `src/features/telegraph/__tests__/voice.component.test.tsx` — "a note with NO
  waveform still renders and still plays". The claim is unchanged (the flat band
  is rendered); only the query now acknowledges that the band is decoration.
- `src/features/telegraph/components/__tests__/TelegraphInboxNeedsAction.component.test.tsx`
  — "a thread with unread traffic AND an action shows both". The claim is
  unchanged and is now **stronger**: it asserts the label a person actually
  receives (`12 unread messages`) *and* that the digits are still rendered.

Neither assertion was removed or loosened. Both files belong to earlier lanes and
the edits are flagged here for the lead.

---

## What was measured

- `pnpm run typecheck` — clean (`tsc --noEmit` + import-extension lint + Sentry lint).
- `pnpm run typecheck:tests` — 176 diagnostics across 61 files, **at** baseline.
- `pnpm run test` (node:test runner) — 6263 / 6263.
- `pnpm run test:component` (jest, both configs) — **559 suites / 3557 tests, and
  3 / 8 on the web config: all green.** This includes every pre-existing PlaceCard,
  Telegraph and inbox suite, so the source edits above break no existing caller.
- `pnpm run lint:mocks` — clean. Both exhaustive factories in the voice a11y file
  carry a `NOTE` within the guard's four-line lookbehind, because
  `jest.requireActual` genuinely cannot be used for them: `services/mediaUrl.ts`
  and `voice/voiceApi.ts` both reach `lib/supabase`, which builds a client at
  import time and throws outside an Expo runtime. Requiring the real module in
  order to spread it is the thing that cannot be done.
- `pnpm run lint:orphan-tests` — 866 test files, 29 orphaned (all known), **0
  newly introduced**. All three new files are named `*.component.test.tsx`, so
  they are executed by `test:component` and by `check:all`.

`pnpm run check:all` was **not** run end to end; its individual steps that bear on
these files are listed above.
