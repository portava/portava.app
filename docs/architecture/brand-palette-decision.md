# OWNER DECISION: BRAND PALETTE — RESOLVED 2026-09-14

*The owner ruled on the question `docs/architecture/blocker-ledger.md` posed as
SPEC IS STALE vs PALETTE IS WRONG. The answer is **SPEC IS STALE**. This document
is the amendment. It changes no code and closes no row by itself — see
§4, which is the owner's own condition.*

---

## 1. The ruling, as given

> Keep Portava's existing palette.
>
> Paper: `#FFFFFF` · Ink: `#1C1C1A` · Seal red: `#D32F2F` · Vermilion: `#FF4D2E` ·
> Teal ink: `#0A3D4A`
>
> Retain the existing Passport and Wall colour identities. Use neutral surfaces
> and restrained accents in their established roles. Preserve natural colours in
> photos and videos, semantic status colours, and accessible contrast.
>
> Update conflicting purple/navy requirements and record this as an explicit
> owner decision. Verify each affected requirement before closing it; this
> decision does not automatically resolve unrelated theme, layout, or
> accessibility criteria.
>
> The mockup approves the palette only — not a new layout. Build upon existing
> components and shared tokens; do not rebuild working screens.

## 2. What those five values are in this tree, checked rather than transcribed

The ruling names five colours. They do not all live in one file, and saying so
matters, because a reader who goes looking for `paper: '#FFFFFF'` in the shared
tokens will not find it and may conclude the ruling was not applied.

| Ruling | Where it is | Exact value there |
|---|---|---|
| Vermilion `#FF4D2E` | `travel-buddy-standalone/src/theme/tokens.ts:12#signal` | `signal: '#FF4D2E'` — "primary action + live pulse only" |
| Teal ink `#0A3D4A` | `travel-buddy-standalone/src/theme/tokens.ts:14#deep` | `deep: '#0A3D4A'` — "destination accents" |
| Paper `#FFFFFF` | `travel-buddy-standalone/src/theme/tokens.ts:11#paperRaised` | `paperRaised: '#FFFFFF'` — cards on paper. The shared BASE background is `paper: '#FAF9F6'` (`:10`), a warm off-white, not pure white. |
| Ink `#1C1C1A` | Passport's own palette, not the shared tokens | the shared token is `ink: '#11110F'` (`:9`), a near-black one step darker |
| Seal red `#D32F2F` | Passport's own palette (`PP.seal`, used at e.g. `src/components/settings/SettingsUI.tsx:305`) | `#D32F2F` |

**Two palettes, both ratified.** The ruling says "retain the existing Passport
and Wall colour identities" — plural, deliberately. The shared theme tokens and
the Passport document palette are not being merged by this decision, and the two
near-identical pairs above (`#FFFFFF`/`#FAF9F6`, `#1C1C1A`/`#11110F`) are not
errors to reconcile. Anyone unifying them is making a new design decision, not
executing this one.

## 3. The requirements this amends

**Portava purple is not the interaction accent. Vermilion is.** Every spec
sentence naming purple, navy or indigo as a brand accent is superseded by §1
above. The *rule* each of those sentences states — that an accent is for
interaction and emphasis and never a background wash — **survives unchanged and
is still binding.** Only the colour named in it moves.

Known instances:

- `docs/specs/Portava_Wall_Engineering_Architecture_and_Design_Spec.txt:279` —
  *"Portava purple is an interaction/accent color, not a background wash for
  every card."* Read as: **vermilion `#FF4D2E`** is an interaction/accent colour,
  not a background wash for every card.
- The Passport §27 colour clauses, same substitution.

**The supplied spec files are NOT edited, and that is deliberate.** Their sha256
digests are committed in `docs/specs/SUPPLIED-SOURCES-2026-09-13.md` and
`docs/specs/upgrades-v2/SOURCE-MANIFEST.json`; editing the bytes would destroy
the one thing that proves what the owner actually supplied. This document is the
amendment, in the form this repository already uses for owner rulings (see
`docs/architecture/sensing-auth-posture-decision.md`). A row that cites a
superseded spec line must cite this document beside it.

**`mapChrome.ts` is not in scope.** Its "near-black navy" (`:4`, `:110`) is the
Map spec's dark-mode ground, a *surface*, not a brand accent. The ruling is about
accents. Nothing in mapChrome changes.

## 4. THE CONDITION, WHICH IS THE OWNER'S OWN WORDING

> *Verify each affected requirement before closing it; this decision does not
> automatically resolve unrelated theme, layout, or accessibility criteria.*

So this document does **not** move a verdict. A row moves only when someone opens
it, establishes that the palette clause was the whole of what it failed, and says
so. Rows that also carry a layout, hierarchy, type or contrast failure stay `W`
for that remainder, and must say which part this ruling closed and which part it
did not.

A worked example of the distinction, already in the tree: `census-passport.md`
P13 fails on a **composition** — a cream document card with a vertical spine and
a left-column avatar where §3 asks for a portrait overlapping a hero image. That
is layout. This ruling does not touch it, and *"the mockup approves the palette
only — not a new layout"* says so directly.

## 5. What is now buildable, and what still is not

`blocker-ledger.md` recorded *"What is buildable now, either way: nothing."* That
is no longer true, and only in one direction: the answer is SPEC IS STALE, so the
work is documentary — verify the affected rows, close the palette half, amend the
citations. **No token changes. No repaint. No screen rebuilt.** The ruling's last
paragraph forbids all three: *"Build upon existing components and shared tokens;
do not rebuild working screens."*

**Done 2026-09-14 — see §6.** Three rows closed, three verified and left open with
their remainders stated, one new owner decision opened by the verification
(`PASSPORT_DARK_MODE_FIRST`). No code changed.

The contrast suite's AA thresholds are computed against the ratified values and
therefore need no recomputation — which was the entire cost of the other branch.

## 6. Status

**DECIDED and APPLIED to the two censuses, 2026-09-14.** Applied means the
documentary work §5 describes was done, row by row, under §4's condition. It does
not mean merged: this is a working tree, nothing here is on `main`, and no viewer
has seen any of it.

### 6.1 What the condition in §4 actually changed

Six requirements were named as turning on this question — `census-wall.md` W166 and
`census-passport.md` P13, P128, P129, P132, P133. Opened one at a time, **three
closed**:

| row | outcome | the half the ruling closed | the half that remains |
|---|---|---|---|
| `census-wall.md` W166 | **W → C** | the colour named in §35 | none — the structural half was already enforced by `travel-buddy-standalone/src/features/wall/components/__tests__/WallDesignSystem.component.test.tsx:123#no Wall surface paints an accent background outside the named affordances`, which binds on the token NAMES rather than the hex and would therefore have held under either ruling |
| `census-passport.md` P129 | **W → C** | the identity accent — seal red `#D32F2F`, ratified, and the only accent the Passport palette has | none; the clause names a colour and asserts nothing else |
| `census-passport.md` P132 | **W → C** | the objection that teal is absent from the Passport palette — §2's "two palettes, both ratified" answers it | none. The row's own evidence was FALSE: teal-ink already carried availability and social context via the shared token set |
| `census-passport.md` P128 | **stays W** | *"deep navy/black surfaces"* — the light paper identity is ratified | *"Dark-mode first."* A THEME criterion, reserved by §4 in terms. Measured: the Passport has **no** dark mode, not a non-default one. Recorded as `PASSPORT_DARK_MODE_FIRST` on `docs/architecture/blocker-ledger.md` |
| `census-passport.md` P133 | **stays W** | **none — it was never a colour row** | portrait in a left column instead of overlapping a hero, and no glass treatment |
| `census-passport.md` P13 | **stays W** | **none** — §4's own worked counter-example, re-read and confirmed | the composition, unchanged. *"The mockup approves the palette only — not a new layout."* |

### 6.2 The number that was wrong, and why it is worth recording

`census-passport.md` §12.4 priced this decision at *"3.0 points"* and
`census-wall.md` §9.3 said the unmade call held *"six requirements wrong"*. Both
figures came from counting rows filed under one heading. **Half of them were not
palette rows at all.** The measured figure is three rows and 1.2 points of the
Passport census. §4 is the sentence that forced the difference to surface, and this
is the case for writing conditions like it: the estimate was not a little high, it
was 60 % high, and nothing short of opening each row would have shown it.

### 6.3 What was NOT done, deliberately

No token was edited. Nothing was repainted. No screen was rebuilt. No `.ts` or
`.tsx` file in this repository was changed by the pass that applied this decision —
§1's last paragraph forbids all of it, and §5 says the work is documentary.

**Neither of the two Passport rows that closed is pinned by a test**, and that is a
real weakness rather than an oversight: changing `PP.seal`'s hex or moving the
availability screen off `color.deep` would falsify both and nothing in the
repository would go red. `census-passport.md` §15.5 records it as a cross-lane
request to the Passport client lane. `census-wall.md` W166 does not have this
problem.
