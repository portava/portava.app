# Input Intelligence §46 accessibility — handset protocol — G327, G328, G326

**Written:** 2026-09-21 · **Branch:** `claude/ii-a11y-versioning`
**Covers:** census-input-intelligence **G327** (no suggestion overlay trapped
behind the software keyboard), **G328** (dynamic type and large text support),
and the operating-system half of **G326** (VoiceOver/TalkBack focus management).

---

## 0. What this document is, and the one rule that governs it

This is the **runnable check and the ledger**. It is not a result.

Every row in every ledger below reads **NOT RUN**. No observation in this
document has been taken, because no physical handset exists in the environment
where the engineering was done. That is a failed prerequisite, not a product
pass and not a product failure.

> **The substitution rule, inherited from `docs/map/device-measurement-protocol.md`
> and from `docs/architecture/map-sensing-certification.md`:** simulator, web,
> unit and component evidence **must not be entered in these ledgers as a
> substitute for a physical-device result.**

That rule is why this file is separate from the test suite. The suite proves the
*instruments* — it is listed in §5 — and a green suite is not an observation.
A row moves off **NOT RUN** only when an operator runs §2–§4 on hardware and
attaches the evidence that row names.

**The engineering is done; the device evidence is outstanding.** Census G327 and
G328 stay `?` for exactly that reason, and they should stay `?` until an
operator fills in the ledgers below. Nothing in this document may be read as a
handset observation.

---

## 1. Prerequisites, all three checks

| # | Prerequisite | Why it is not negotiable |
|---|---|---|
| P1 | One **physical iPhone** and one **physical Android handset**. | The two keyboards differ in height, the two screen readers differ in focus semantics, and the two text-scaling systems are not the same feature. A single device answers half of each row. |
| P2 | An **EAS `preview` build**, exactly: `cd travel-buddy-standalone && npx eas build --profile preview --platform ios` (and `--platform android`). Record the build id EAS prints. | A dev client ships an unminified bundle and the Metro client; its layout timing and its font metrics are not the product's. The command is written out because "an EAS preview build" has been read as `--profile development` before. |
| P3 | A signed-in account against **`portava-ci`**, never production. | The suggest endpoint must actually return rows. Production has no `input_selection_history`, no `canonical_locations.search_key` and no `pg_trgm` (see census §3 and the integrator's 2026-09-21 re-measurement), so several fields return an empty list there and an empty overlay cannot be occluded by anything. |
| P4 | **No external keyboard paired.** | A hardware keyboard suppresses the software one, and G327 is a question about the software one. |
| P5 | Record once per session, before any observation: build id, app version, device model, OS version, text-size setting, screen-reader on/off, account, and start time. | A ledger row without the device it was taken on is not evidence. |

---

## 2. G327 — no suggestion overlay trapped behind the software keyboard

### 2.1 What is observed

With the software keyboard up and the suggestion list open, **is the last
suggestion row in the list reachable and readable without dismissing the
keyboard?**

Two things are deliberately NOT the observable:

- **Not "does a `KeyboardAvoidingView` exist".** It does not; the mechanism in
  this layer is a height cap (`travel-buddy-standalone/src/platform/input-assistance/components/overlayFit.ts`),
  and a component that exists proves nothing about what a user can see.
- **Not "does the card fit on screen".** A card that fits but whose bottom row
  sits under the keyboard's top edge is the defect. The observable is the ROW,
  not the card.

### 2.2 The fields to open

**`SuggestionOverlay` has exactly ONE live consumer today**, and saying so is
half the protocol: `SmartInput` is the only component that renders it, and
`travel-buddy-standalone/src/features/wall/components/WallHeader.tsx` is the
only screen that renders `SmartInput`. The other assisted surfaces consume the
gateway HOOK and draw their own lists — `GlobalPlacePicker` is a full-screen
modal inside a `KeyboardSafeScrollView` with its own `FlatList`, and the Compass
screen composes its own `TextInput`. Those are NOT this overlay and are not
under test here.

So an operator has one field to observe today and three to observe as the
migration lands. Listing all four is deliberate: F2–F4 are the cases where the
field is not at the top of the screen, which is the variable G327 turns on, and
an operator who ran only F1 and wrote "PASS" would have answered a narrower
question than the row asks.

| # | Screen | Field | Status today | Why this one |
|---|---|---|---|---|
| F1 | Wall | header search field (`WallHeader.tsx`) | **LIVE — run this one** | The only `SmartInput` in the app. Near the top of the screen, so the card has the most room it will ever have: a FAIL here is unambiguous. |
| F2 | Trip → new | destination | not yet on `SmartInput` (uses `GlobalPlacePicker`) | Mid-screen, inside a scroll container, so `measureInWindow` must report a *scrolled* position. Run when migrated. |
| F3 | Event → create | location | not yet on `SmartInput` | Below the fold on a small handset; the field is pushed up by the keyboard rather than sitting still. Run when migrated. |
| F4 | Compass | prompt | not yet on `SmartInput` | Bottom-anchored composer. **The worst case, and the one the height cap cannot solve** — see §2.4. Run when migrated. |

### 2.3 Procedure, per field

1. Open the screen. Do not scroll.
2. Tap the field. Wait for the software keyboard to finish animating.
3. Type the seed text for that field (F1/F2: `ban`; F3: `sky`; F4: `plan a`).
4. Wait for the list to render (the overlay's live region reads "N suggestions").
5. **Without dismissing the keyboard**, scroll the suggestion list to its last row.
6. Record, for that field:
   - `rows_visible` — how many rows are fully visible above the keyboard;
   - `last_row_reachable` — YES/NO: could you scroll to and tap the last row;
   - `card_bottom_vs_keyboard_top` — measure from a screenshot, in points;
   - a screenshot with the keyboard up and the list open.
7. Repeat with the device rotated to landscape, where the keyboard is
   proportionally taller and the window shorter. Landscape is a separate row.

**PASS** for a field: `last_row_reachable = YES` **and** `rows_visible >= 1`.
**FAIL**: either is false.

### 2.4 The residual this protocol is looking for, stated in advance

The layer caps the overlay's height to the band between the field's bottom edge
and the keyboard's top edge, and stops shrinking at `MIN_OVERLAY_HEIGHT`
(96 px). When the field sits closer than that to the keyboard — F4 is the
candidate — **part of the card is behind the keyboard by construction**, because
the overlay is an inline sibling of the input and this layer does not flip it
above the field. `overlayFit` reports that state as `occluded: true` and
`overlayFit.test.ts` asserts it rather than hiding it.

If F4 fails, the finding is not "the cap does not work". It is "F4 needs the
overlay above the field", which is a separate build.

### 2.5 Ledger — G327

Rows 1–4 are runnable today. Rows 5–8 wait on the migration named in §2.2 and
are listed so they are not forgotten; **an empty F2–F4 is not a pass.**

| # | Device | Orientation | Field | rows_visible | last_row_reachable | card_bottom_vs_keyboard_top | Verdict |
|---|---|---|---|---|---|---|---|
| 1 | iPhone (smallest supported) | portrait | F1 Wall search | — | — | — | **NOT RUN** |
| 2 | iPhone | landscape | F1 Wall search | — | — | — | **NOT RUN** |
| 3 | Android (mid-tier) | portrait | F1 Wall search | — | — | — | **NOT RUN** |
| 4 | Android | landscape | F1 Wall search | — | — | — | **NOT RUN** |
| 5 | iPhone | portrait | F2 Trip destination | — | — | — | **NOT RUN** (not migrated) |
| 6 | iPhone | portrait | F3 Event location | — | — | — | **NOT RUN** (not migrated) |
| 7 | iPhone | portrait | F4 Compass prompt | — | — | — | **NOT RUN** (not migrated) |
| 8 | Android | portrait | F4 Compass prompt | — | — | — | **NOT RUN** (not migrated) |

G327 moves off `?` only when rows 1–4 are filled on real hardware. All four
PASS ⇒ `C` **for the surface that exists**, and the row must say so rather than
claiming the whole spec bullet. Any FAIL ⇒ `W`, naming the field and the device.
The smallest supported iPhone is specified because the keyboard is a larger
fraction of a short window, and a flagship measures the easiest case.

---

## 3. G328 — dynamic type and large text support

### 3.1 What is observed

At the operating system's **largest** text size, **is the text of a suggestion
row complete** — not truncated with an ellipsis — and **is the list still a
list** (more than one row reachable)?

### 3.2 Setting the scale

- **iOS:** Settings → Accessibility → Display & Text Size → Larger Text →
  *Larger Accessibility Sizes* ON → slider to maximum. Then relaunch the app:
  iOS delivers the new scale to `PixelRatio.getFontScale()` at launch.
- **Android:** Settings → Display → Display size and text → Font size to
  maximum **and** Display size to maximum. Both, not one: they scale different
  things and the second is what breaks layouts.

Record the reported scale: add `console.log(PixelRatio.getFontScale())` is NOT
acceptable in a preview build, so read it from the Sentry device context, or
record the slider position and the OS version instead.

### 3.3 Procedure, per field (F1–F4 from §2.2)

1. Set the scale per §3.2 and relaunch.
2. Open the field, type the seed text, wait for the list.
3. Record:
   - `label_complete` — YES/NO: is the primary label of the first row shown in
     full, or does it end in `…`;
   - `subtitle_complete` — same for the second line;
   - `rows_visible`;
   - a screenshot.
4. Repeat with the screen reader ON (see §4), because VoiceOver and TalkBack
   change the row's effective height on some OS versions.

**PASS** for a field: `label_complete = YES` **and** `rows_visible >= 2`.

### 3.4 What the code now does, so a failure can be attributed

- The row's line budget grows with the scale (`rowLineLimit`: 1 line below 1.3x,
  2 below 2x, 3 at and above 2x) instead of a hard `numberOfLines={1}`.
- The overlay's height cap grows with the scale (`scaledOverlayCap`, bounded at
  3x) and is then clamped by §2's keyboard band.

So a `label_complete = NO` at maximum scale means the label needs more than
three lines, which is a content problem, not this mechanism failing. A
`rows_visible < 2` means the keyboard band is the binding constraint, which is
G327's finding, not G328's. Record which.

### 3.5 Ledger — G328

| # | Device | Scale | Screen reader | Field | label_complete | subtitle_complete | rows_visible | Verdict |
|---|---|---|---|---|---|---|---|---|
| 1 | iPhone | default (1x) | off | F1 Wall search | — | — | — | **NOT RUN** |
| 2 | iPhone | max | off | F1 Wall search | — | — | — | **NOT RUN** |
| 3 | iPhone | max | on (VoiceOver) | F1 Wall search | — | — | — | **NOT RUN** |
| 4 | Android | default (1x) | off | F1 Wall search | — | — | — | **NOT RUN** |
| 5 | Android | max | off | F1 Wall search | — | — | — | **NOT RUN** |
| 6 | Android | max | on (TalkBack) | F1 Wall search | — | — | — | **NOT RUN** |
| 7 | iPhone | max | off | F4 Compass prompt | — | — | — | **NOT RUN** (not migrated) |
| 8 | Android | max | off | F4 Compass prompt | — | — | — | **NOT RUN** (not migrated) |

Rows 1 and 4 are the CONTROL: the default scale must be unchanged from today, or
the mechanism has regressed the ordinary case in order to serve the large one.

G328 moves off `?` only when rows 1–6 are filled on real hardware.

---

## 4. G326 — the operating-system half of focus management

The *code* half of G326 is closed and tested in CI (§5): the accessibility
cursor is pulled back to the input when the overlay closes under the user, and
is deliberately **not** moved when the overlay opens. What a component test
cannot say is whether VoiceOver and TalkBack honoured either decision.

### 4.1 Procedure

1. Turn the screen reader on (iOS: VoiceOver; Android: TalkBack).
2. Open F1 (Wall → header search — the only `SmartInput` in the app today; see
   §2.2). Swipe to the field and double-tap to focus it.
3. Type `ban` with the on-screen keyboard.
4. **Observation A — no theft.** After each character, does the screen-reader
   cursor stay on the text field? Record YES/NO. A NO means the list is
   stealing focus and the field cannot be typed in.
5. **Observation B — the count is spoken.** Is "N suggestions" announced?
   Record the exact utterance.
6. Swipe right until the cursor is on a suggestion row. Record how many swipes.
7. Double-tap to accept it.
8. **Observation C — restoration.** Where is the cursor immediately after the
   accept? Record the element the screen reader names. PASS = the text field.
   FAIL = the top of the screen, the navigation bar, or silence.
9. **Observation D — the result is spoken.** Record the exact utterance after
   the accept. Expected: "Bangkok selected. Field updated."

### 4.2 Ledger — G326

| # | Device | Screen reader | A: no theft | B: count utterance | C: cursor after accept | D: result utterance | Verdict |
|---|---|---|---|---|---|---|---|
| 1 | iPhone | VoiceOver | — | — | — | — | **NOT RUN** |
| 2 | Android | TalkBack | — | — | — | — | **NOT RUN** |

This ledger does **not** gate G326's census verdict on its own — the row's
stated criterion is the code-side mechanism plus a component test, and that is
met. It is here because a passing ledger is what would let a later pass say
"observed", and an empty one is what stops anyone saying it now.

---

## 5. What the suite already proves, so the operator does not re-observe it

Green in CI, and none of it is a substitute for §2–§4:

| Assertion | File |
|---|---|
| The overlay's height is capped to the visible band between the field and the keyboard; the gutter, the bottom inset, the `MIN_OVERLAY_HEIGHT` floor and the `occluded` residual are each asserted, and five mutations turn them red | `travel-buddy-standalone/src/platform/input-assistance/components/__tests__/overlayFit.test.ts` |
| The cap grows with the OS text scale, bounded at 3x, and a scaled cap is still clamped by the keyboard band | same file |
| Row labels wrap instead of truncating at 1.3x and above | same file, and `suggestionAccessibility.component.test.tsx` |
| `SmartInput` subscribes to `keyboardDidShow` / `keyboardDidHide`, and a `no_assistance` field does not | `travel-buddy-standalone/src/platform/input-assistance/components/__tests__/suggestionAccessibility.component.test.tsx` |
| The overlay cap and the row line budget really read `PixelRatio.getFontScale()` | same file |
| The accessibility cursor is asked for on close, not on open, and not when the user left the field | same file |
| `moveAccessibilityFocusTo` reaches `AccessibilityInfo.setAccessibilityFocus` with the handle it was given, and asks for nothing when there is no handle | `travel-buddy-standalone/src/platform/input-assistance/components/__tests__/a11yFocus.component.test.tsx` |
| The selection result is announced, and never claims "Field updated" when the field was not rewritten | `suggestionAccessibility.component.test.tsx` |
| The keyboard-active row carries a non-colour marker that survives greyscale | same file |

---

## 6. If an operator runs this

Fill the ledger rows in place, in this file, with the device and build recorded
per P5, and attach the screenshots to the run. Then, and only then, update the
census rows — and say which ledger rows carried the verdict.
