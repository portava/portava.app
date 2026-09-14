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

The contrast suite's AA thresholds are computed against the ratified values and
therefore need no recomputation — which was the entire cost of the other branch.

## 6. Status

DECIDED, not yet applied. Recorded on the integration branch. Nothing here is
merged, and no verdict has moved on the strength of it.
