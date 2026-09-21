# W159 + W167 — design review packet

| Field | Value |
| --- | --- |
| **Census rows** | `docs/architecture/census-wall.md` **W159** ("clean social-media density, generous whitespace") and **W167** ("avoid dashboard grids, event-page density, giant recommendation modules, excessive badges") |
| **Status of both** | **`?` (CANNOT-VERIFY). Nothing here is signed.** No designer has reviewed anything. |
| **What it needs** | One named designer, ~20 minutes, a browser. No device, no build, no toolchain. |
| **Origin of the questions and pass conditions** | `docs/architecture/wall-certification-packet.md` §2–§3, which fixed them before any answer existed. This file is the designer's copy. |

> **A refusal is as valid an outcome as an approval.** Neither is the preferred
> answer and neither is the "right" one. Both rows move on a **dated answer from
> a named person** — and on nothing else. What does not move them: an unsigned
> review, an undated one, a review by someone who is not the design owner, or
> any automated check. The whole content of both rows is *whose judgement it is*.
>
> **The sign-off blocks at the end of this file are EMPTY.** They stay empty
> until a person fills them in. Do not pre-fill any of them.

---

## 1. What you are reviewing

### 1.1 The rendered cards — this is what you look at

**`docs/architecture/wall-cert-render-set.html`** — open it in a browser. It is
five renderers × two densities × five widths = **50 rendered cards**. It was
built by running the real components through `react-dom` with the real
`react-native-web` stylesheet attached. It is not a mock-up and not a
description.

Re-emit it (only needed if a renderer has changed):

```bash
cd travel-buddy-standalone
WALL_CERT_EMIT=1 npx jest -c jest.web.config.js WallCertRenderSet
```

### 1.2 The reference sheet — this is what you consult while looking

```bash
cd travel-buddy-standalone
node scripts/wall-review-packet.mjs --out ~/wall-review-packet.html
```

It lists each of the five renderers, the props each can receive, the spacing and
type tokens each actually uses with their resolved dp values, and every
structural limit with the test that enforces it. Its purpose is so that no
structural question has to be asked of an engineer mid-review.

> **That script produces no screenshots and cannot.** It runs in Node with no
> simulator or device attached and cannot rasterise a React Native tree. It reads
> source. It is the sheet beside the cards, not the cards.

### 1.3 The four fidelity limits — read before signing

The render set is `react-native-web`, not React Native on Android.

1. **Layout, spacing and type scale come from the real component code**, but
   shadow rendering, font metrics and text measurement differ from a device. It
   is a sound instrument for judging **density, rhythm and whitespace** — which
   is exactly what W159 and W167 ask — and it is **not** evidence about
   pixel-exact device appearance. If you want the latter, ask for device
   screenshots; §4.1 records that as an open option and the render set then
   serves as the shot list.
2. **Media wells are empty.** Every fixture deliberately carries no media URL, so
   the image component takes its "No preview" branch at the real aspect ratio.
   **Every card is therefore lighter than it will be with a photograph in it**,
   which biases the review *toward* a pass on density. If a ceiling card already
   looks too dense with an empty well, that is a strong result.
3. **Icons are substituted** with a neutral 16 px square, because the icon
   library is stubbed under jest. Real Wall icon sizes are 14, 16, 20, 22 and 26.
4. **The page requests Roboto**, the Android platform font the app inherits. If
   Roboto did not load, wrapping will not match. The page says so at the top;
   check that line before judging any width.

---

## 2. The five object renderers

These are the five, by real path. They were read out of
`travel-buddy-standalone/src/features/wall/components/WallObjectRenderer.tsx`,
which is the dispatcher that maps a projection's `objectType` to its renderer.

| # | Renderer | Path | Action row | Chip row | Context thread |
| --- | --- | --- | --- | --- | --- |
| 1 | `SocialPostWallItem` | `travel-buddy-standalone/src/features/wall/components/objects/SocialPostWallItem.tsx` | 1 | 1 | ≤ 1 |
| 2 | `VideoWallItem` | `travel-buddy-standalone/src/features/wall/components/objects/VideoWallItem.tsx` | 1 | 1 | ≤ 1 |
| 3 | `PostcardWallItem` | `travel-buddy-standalone/src/features/wall/components/objects/PostcardWallItem.tsx` | **0** | 1 | ≤ 1 |
| 4 | `SharedMomentWallItem` | `travel-buddy-standalone/src/features/wall/components/objects/SharedMomentWallItem.tsx` | 1 | 1 | ≤ 1 |
| 5 | `DiscoveryWallItem` | `travel-buddy-standalone/src/features/wall/components/objects/DiscoveryWallItem.tsx` | 1 | 1 | ≤ 1 |

**The Postcard asymmetry is real and deliberate**, not an oversight:
`PostcardWallItem` mounts no `SocialActionRow` at all — the whole card is a tap
target into the Postcard surface. The W167 question is about the four cards that
*do* carry an action row. The counts above are re-derived from source every time
`travel-buddy-standalone/scripts/wall-review-packet.mjs` runs, so they cannot go stale silently.

`travel-buddy-standalone/src/features/wall/components/WallObjectRenderer.tsx` also contains two small inline renderers for
`social_update` and `contextual_opportunity`. They are **not** part of the five
and not part of this review — the census rows say "the five object renderers",
meaning the five files above.

Shared building blocks used by them all:
`travel-buddy-standalone/src/features/wall/components/objects/wallItemShared.tsx`
(`ActorByline`, `PlaceLine`, `ContextualActionChips`, `SocialActionRow`,
`WallImage`) and
`travel-buddy-standalone/src/features/wall/components/ContextThreadView.tsx`.

---

## 3. The widths to review

**320, 360, 390, 411, 430 dp.**

Declared at
`travel-buddy-standalone/src/features/wall/certification/wallCertFixtures.ts:97`
(`export const CERT_WIDTHS = [320, 360, 390, 411, 430] as const;`).

| Width | Why it is in the set |
| --- | --- |
| 320 | Narrowest phone width still in service. Worst case for wrapping, truncation and chip-row overflow. |
| 360 | The most common Android logical width worldwide. |
| 390 | Common current iPhone width. |
| 411 | The Pixel 6a's logical width — the example device the census names for the W149 capture. |
| 430 | Widest current phone width. Worst case for over-long measure and for whitespace reading as emptiness. |

> **This range is a proposal, not a repository fact.** Checked, not assumed:
> nothing in this repository declares a supported width range. The theme defines
> no breakpoints (the single width constant, `layout.maxWidth: 720` at
> `travel-buddy-standalone/src/theme/tokens.ts:265`, is a desktop/tablet content
> cap the Wall does not use), and **the Wall reads no viewport width at all** —
> `grep -rn 'useWindowDimensions\|Dimensions.get'` over the Wall component tree
> returns nothing. Width therefore switches no layout in the Wall; it only moves
> where text wraps, how tall a fixed-aspect media well is, and whether the chip
> row wraps to a second line.
>
> What the repository *does* state is narrower than a width range but real:
> `travel-buddy-standalone/app.json` pins `orientation: "portrait"` and
> `ios.supportsTablet: false` — phone portrait only.
>
> **The owner confirms or replaces 320–430 before the review runs** (§4.1). If it
> changes, edit `CERT_WIDTHS` and re-emit; the reviewer never touches the harness.

---

## 4. What NOT to ask the designer

Three of W167's four clauses name a structure, and all three are already
machine-checked. Asking about them wastes the review and invites an answer that
sounds like a judgement but is really a restatement of code.

| Already enforced | Where the code does it | What holds it |
| --- | --- | --- |
| At most **three** contextual chips per card | `travel-buddy-standalone/src/features/wall/components/objects/wallItemShared.tsx:430` — `{actions.slice(0, 3).map(` | `travel-buddy-standalone/src/features/wall/components/__tests__/WallDesignSystem.component.test.tsx:261` — *an object with many actions renders at most THREE chips* |
| Chips never duplicate an affordance with a home elsewhere (`open_object`, `ask_compass`, `save` are filtered out first) | `travel-buddy-standalone/src/features/wall/components/objects/wallItemShared.tsx:425` | `travel-buddy-standalone/src/features/wall/components/__tests__/WallDesignSystem.component.test.tsx:282` |
| A card with no contextual actions renders no chip row at all | `travel-buddy-standalone/src/features/wall/components/objects/wallItemShared.tsx:427` — `if (actions.length === 0) return null;` | `travel-buddy-standalone/src/features/wall/components/__tests__/WallDesignSystem.component.test.tsx:296` |
| One action row per card | `travel-buddy-standalone/src/features/wall/components/objects/wallItemShared.tsx:484` — the single `<View style={s.actionRow}>` inside `SocialActionRow` | One call site per renderer; counted from source by `travel-buddy-standalone/scripts/wall-review-packet.mjs` |
| At most **one** context thread per card | `travel-buddy-standalone/src/features/wall/types/wallProjection.ts:191` — `contextThread?: ContextThread;` is a single optional field, not an array | The type. No card can render two because no card can *hold* two. |
| No dashboard grid anywhere in the Wall | — (an absence: no `numColumns` in the tree) | `travel-buddy-standalone/src/features/wall/components/__tests__/WallDesignSystem.component.test.tsx:231` — *nothing in the Wall lays content out in a grid* |
| Exactly one horizontally-browsable recommendation surface | — | `travel-buddy-standalone/src/features/wall/components/__tests__/WallDesignSystem.component.test.tsx:244` |
| Every in-band spacing value is a token, not a literal | `travel-buddy-standalone/src/theme/tokens.ts:26` — the seven `space` steps | `travel-buddy-standalone/src/features/wall/components/__tests__/WallDesignSystem.component.test.tsx:181` — *no Wall style sets an in-scale-band spacing value that is not a token* |

**None of that answers either row.** A test can hold the cap at three; only a
person can say whether three is the right number. That is the entire question
being asked below, and it is why these limits are listed here — to get them out
of the way.

---

## 5. The questions

Two questions. **Each answer is a verdict, not an essay.** Where the answer is
the bad one, name the card id and width — both are printed under every card in
the render set, e.g. `postcard-ceiling` at 320 dp.

### W159 — spacing and whitespace

Review **all** cards, at **all five widths**.

| # | Question | YES | NO |
| --- | --- | --- | --- |
| **Q1** | Across all five renderers at all five widths, does the spacing read as **generous** rather than cramped? | ☐ | ☐ |
| **Q2** | Is there any width at which a card reads as **visually broken** — text colliding, a chip row wrapping badly, an element clipped or orphaned? *(NO is the good answer.)* | ☐ | ☐ |
| **Q3** | At **430 dp**, does the whitespace still read as **deliberate** rather than as emptiness — lines too long to scan, elements too far apart to group? | ☐ | ☐ |
| **Q4** | Are the five object types **visually distinguishable at a glance** — is a Postcard obviously not a Post with a badge? | ☐ | ☐ |

> **APPROVED** = Q1 YES, Q2 NO, Q3 YES, Q4 YES.
> **REFUSED** = any other combination, and a refusal must name at least one card
> id and width, so that it points at something changeable.

### W167 — is the ceiling density already too much?

Review **only the `-ceiling` cards**, at **320 dp** (worst case) and **390 dp**.

The ceiling cards are built to reach the maximum the code can currently emit —
one action row, the full three chips *plus a fourth eligible action that the cap
drops* (so the cap is demonstrably binding rather than merely unreached), the Ask
Compass affordance, a place line, **one** context thread, over text and a media
well. That composition is asserted per renderer at
`travel-buddy-standalone/src/features/wall/certification/__tests__/WallCertRenderSet.webrender.test.tsx:303`.

**This is the trap the row sets.** A designer shown a quiet social post will say
the density is fine and will have answered a question nobody asked. Look at the
ceiling.

| # | Question | YES | NO |
| --- | --- | --- | --- |
| **Q5** | Is **one action row + three chips + one context thread on a single card already too dense** for the Wall's intended feel? | ☐ | ☐ |

> **APPROVED** (the density is acceptable) = Q5 NO.
> **REFUSED** (it is too much) = Q5 YES **with a number or a named element**.
> A refusal that is only "too busy" changes nothing and cannot be checked later,
> so it is not a usable answer — it is not a refusal, it is a pause.

**If REFUSED, answer at least one of these:**

- The maximum number of contextual chips I would accept on one card is: **____**
- ☐ The context thread should not appear on a card that already has chips
- ☐ The Ask Compass affordance is one affordance too many
- ☐ Other: ______________________________________________

A refusal of this shape produces a new enforceable constant: if the maximum is 2,
`slice(0, 3)` becomes `slice(0, 2)` and the existing test moves with it.

---

## 6. Sign-off blocks — **EMPTY. UNFILLED. NOBODY HAS SIGNED.**

> Both blocks below are blank on purpose. Neither row has been reviewed by
> anyone. Do not pre-fill a name, a date or a verdict.

### W159 sign-off

| Field | Value |
| --- | --- |
| Designer (printed name) | |
| Date | |
| Render set reviewed (file + `RENDER-DIGEST:` from its header) | |
| Q1 generous spacing | ☐ YES ☐ NO |
| Q2 any card visually broken | ☐ YES ☐ NO |
| Q3 430 dp reads deliberate | ☐ YES ☐ NO |
| Q4 five types distinguishable | ☐ YES ☐ NO |
| **Verdict** | ☐ **APPROVED** ☐ **REFUSED** |
| If REFUSED: card id(s) and width(s) | |
| Notes | |
| Signature | |

*(unfilled — no verdict has been given)*

### W167 sign-off

| Field | Value |
| --- | --- |
| Designer (printed name) | |
| Date | |
| Render set reviewed (file + `RENDER-DIGEST:`) | |
| Q5 ceiling density already too much | ☐ YES ☐ NO |
| **Verdict** | ☐ **APPROVED** (not too much) ☐ **REFUSED** (too much) |
| If REFUSED: maximum chips I would accept | |
| If REFUSED: element(s) to remove | |
| Notes | |
| Signature | |

*(unfilled — no verdict has been given)*

---

## 7. Why the sign-off cannot silently go stale

The committed render set carries a `RENDER-DIGEST:` of the markup it was built
from, and
`travel-buddy-standalone/src/features/wall/certification/__tests__/WallCertRenderSet.webrender.test.tsx:334`
fails the build if the renderers no longer produce it.

**This is the point, not a nicety.** A design sign-off names an artifact and a
date. If the renderers move afterwards, the signature comes to cover something
that is no longer shipping — which is how a "certified" row rots into a lie.
Here it cannot happen quietly: change a renderer and the test goes red, says any
recorded sign-off is **void**, and names the command that re-emits the page.

**Record the digest on the sign-off block.** A signature that does not name what
was signed is not a signature.

---

## 8. Two decisions the owner makes before the review runs

Neither belongs to the designer and both change what is being judged.

### 8.1 What is the supported width range?

320–430 dp is proposed here (§3) and nothing in the repo establishes it.
Confirm or replace.

| Field | Value |
| --- | --- |
| Confirmed width range | |
| Owner (name) | |
| Date | |

*(unfilled)*

### 8.2 Is the `react-native-web` render set an acceptable subject, or are device screenshots required?

The four fidelity limits are in §1.3 so this can be decided with them in hand. If
device screenshots are required, the render set still serves as the shot list —
it names every card and width that must be captured.

| Field | Value |
| --- | --- |
| Decision | ☐ render set is acceptable ☐ device screenshots required |
| Owner (name) | |
| Date | |

*(unfilled)*

---

## Who does what next

| Who | What |
| --- | --- |
| **Owner** | Answer §8.1 and §8.2. Name the design owner whose judgement counts for these two rows. |
| **Named designer** | Open the render set, run the reference-sheet script, answer Q1–Q5, sign and date §6. Approve or refuse — both are answers. |
| **Integration lead** | Move W159 and W167 in `docs/architecture/census-wall.md` on the signed, dated blocks, recording the designer's name and the digest. Not on this document, which is only the packet. |
