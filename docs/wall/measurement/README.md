# Wall measurement materials — W149, W159, W167, W168

These are the **operator-facing materials** for the four `docs/architecture/census-wall.md` rows
that no tool can close. Each row needs a person, a device, or both.

> **Nothing in this directory is a result.**
> Every results table, sign-off block and participant sheet in these files is
> **empty**, and says so on its face. No frame-time capture has been taken. No
> designer has signed anything. No participant has been recruited. All four rows
> are **`?` (CANNOT-VERIFY)** and stay that way until a human fills one of these
> forms in and dates it.
>
> A fabricated number or an assumed sign-off is worse than an open row, because
> an open row tells the truth about what is known. If you came here looking for
> the answer to "is the Wall 60 fps" or "did design sign off" — nobody has
> measured it and nobody has signed. **That is the finding.**

---

## Index

| File | Row | What it is |
| --- | --- | --- |
| `docs/wall/measurement/W149-frame-time-procedure.md` | **W149** — 60 fps scroll on supported devices | A capture procedure an operator with a phone can follow end to end: build command, how to get a 60-item video-bearing For You feed on screen, Perfetto and Flipper capture steps, the exact counter, the share-over-16.7 ms computation, the pass line, and an empty results table. |
| `docs/wall/measurement/W159-W167-design-review-packet.md` | **W159** — generous whitespace · **W167** — excessive badges | The two questions for the named designer, phrased so the answer is a verdict; the five renderers by path; the widths; the structural limits that are already enforced so they are *not* asked about; and an empty sign-off block per row. |
| `docs/wall/measurement/W168-comprehension-study-protocol.md` | **W168** — the user understands the Wall without knowing the architecture | Recruitment screener, the seven-question unmoderated script, the two-scorer rubric, the threshold stated as a number with a place for the owner to ratify it in advance, and an empty 5–8 participant sheet. |
| `travel-buddy-standalone/scripts/wall-review-packet.mjs` | **W159 / W167** | A runnable Node script that assembles the designer's reference sheet from the real source. No device, no network, no dependencies. |

**Related, not superseded.** `docs/architecture/wall-certification-packet.md` is
where these four rows' thresholds, fixtures and harnesses were established, and
it remains the citable source for them. These files are the copies you work
from — expanded so each can be followed at a keyboard without cross-referencing —
and they **restate no threshold as a new number**, because restating a threshold
is how a threshold gets quietly loosened.

---

## What is prepared, and what still needs a human or hardware

| Row | Prepared and in the repo | Still needs | Blocking decision first? |
| --- | --- | --- | --- |
| **W149** | The pinned 60-item video-bearing feed (`travel-buddy-standalone/src/features/wall/certification/wallFrameCaptureFixture.ts`), its stub server (`travel-buddy-standalone/scripts/serve-wall-frame-fixture.ts`), guard tests, and the full capture/analysis procedure with a two-part pass line | **A physical Android phone and an operator.** ~40 min. | **Yes — the device must be named.** See below. |
| **W159** | The rendered review set, 50 real cards (`docs/architecture/wall-cert-render-set.html`), plus a source-derived reference sheet from `travel-buddy-standalone/scripts/wall-review-packet.mjs` | **A named designer's dated verdict.** ~20 min. | **Yes — the width range must be confirmed.** See below. |
| **W167** | The same render set, built so the cards reach the *ceiling* the question is actually about, and the seven structural limits enumerated with their enforcing tests so the designer is asked only the judgement | **The same designer's dated verdict**, with a number or a named element if refused. Included in the 20 min. | Same as W159. |
| **W168** | Screener, stimulus requirements, seven-question script, two-scorer rubric, a three-part numeric threshold, and an empty participant sheet | **5–8 strangers, a researcher and a second scorer.** ~1 week elapsed. | **Yes — the threshold must be ratified before recruiting.** |

---

## Two things the repository does not state, said plainly

**1. There is no supported Android device floor in this repository.**
`travel-buddy-standalone/app.json` sets no `minSdkVersion`; `eas.json` names no
device; there is no checked-in `android/` directory. The only `minSdk` anywhere
is a vendored module's own fallback of 24. The census row itself says *"e.g. a
Pixel 6a"*, and an "e.g." is not a named device. So **Step 0 of the W149
procedure is "name the device"**, and it is the owner's decision, not the
operator's — "60 fps on supported devices" is a product commitment, and which
devices those are cannot be discovered by measuring one.

**2. There is no declared supported width range.** The theme defines no
breakpoints, and the Wall components read no viewport width at all. The 320–430
dp range the review set is built at is a **proposal**
(`travel-buddy-standalone/src/features/wall/certification/wallCertFixtures.ts:97`),
and the owner confirms or replaces it before the design review runs. What the
repo *does* state is narrower but real: `app.json` pins portrait orientation and
`supportsTablet: false` — phone portrait only.

---

## The five object renderers

Both design-review rows are about "the five object renderers". These are they,
read from the dispatcher at
`travel-buddy-standalone/src/features/wall/components/WallObjectRenderer.tsx`:

1. `travel-buddy-standalone/src/features/wall/components/objects/SocialPostWallItem.tsx`
2. `travel-buddy-standalone/src/features/wall/components/objects/VideoWallItem.tsx`
3. `travel-buddy-standalone/src/features/wall/components/objects/PostcardWallItem.tsx`
4. `travel-buddy-standalone/src/features/wall/components/objects/SharedMomentWallItem.tsx`
5. `travel-buddy-standalone/src/features/wall/components/objects/DiscoveryWallItem.tsx`

(`travel-buddy-standalone/src/features/wall/components/objects/wallItemShared.tsx` in the same directory is the shared building-block module —
the byline, the place line, the chip row, the action row — not a sixth renderer.
The dispatcher also holds two small inline renderers for `social_update` and
`contextual_opportunity`, which are not among the five.)

---

## The script

```bash
cd travel-buddy-standalone
node scripts/wall-review-packet.mjs --check                 # verify every citation still resolves
node scripts/wall-review-packet.mjs --out ~/packet.html     # build the reference sheet
node scripts/wall-review-packet.mjs --stdout > packet.html  # or to stdout
```

**What it produces:** one self-contained HTML sheet with no external assets —
each of the five renderers with its real props enumerated from the projection
types, the spacing/type/icon/aspect tokens each renderer actually uses with the
values they resolve to in dp, each renderer's stylesheet as written, the seven
structural limits with the code and the test that enforce each, the width
situation, and the two empty sign-off blocks.

**What it cannot produce, stated in the script header and on the page itself:**
**screenshots**. It runs in Node with no simulator, emulator or device attached
and cannot rasterise a React Native tree. Nothing it emits is a picture of a
card. The rendered cards are the separate, committed
`docs/architecture/wall-cert-render-set.html`, produced by actually running the
components through `react-native-web`. The script's sheet is the reference that
goes *beside* those cards so that no structural question has to be asked of an
engineer mid-review.

**And it cannot sign anything.** An automated check is never a substitute for a
named human's dated verdict. Its sign-off blocks come out empty and stay empty.

Every `path:line` citation in its output is produced by searching the file for
the anchor text at generation time, so a citation cannot silently drift. If an
anchor is gone the script **refuses to emit a packet** rather than print a
citation pointing at the wrong code; `--check` exits non-zero for CI.

---

## Who must do what next — one line each

| Who | What |
| --- | --- |
| **Owner** | Name the Android device the 60 fps promise is about (W149 Step 0); confirm or replace the 320–430 dp width range and decide whether the web render set is an acceptable review subject (W159/W167 §8); ratify the W168 threshold with a name and a date before anyone is recruited. |
| **Operator with an Android phone** | Follow `docs/wall/measurement/W149-frame-time-procedure.md` end to end, fill the results table, archive the trace file. |
| **Named designer** | Open `docs/architecture/wall-cert-render-set.html`, run the reference-sheet script, answer Q1–Q5 in `docs/wall/measurement/W159-W167-design-review-packet.md`, sign and date. Approving and refusing are equally valid answers. |
| **Researcher (plus a second scorer)** | Run `docs/wall/measurement/W168-comprehension-study-protocol.md` unmoderated with 5–8 strangers, score independently, reconcile, sign. |
| **Integration lead** | Move the rows in `docs/architecture/census-wall.md` only on a filled, signed, dated form — never on the existence of these documents. |
