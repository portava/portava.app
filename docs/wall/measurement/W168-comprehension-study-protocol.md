# W168 — unmoderated comprehension study protocol

| Field | Value |
| --- | --- |
| **Census row** | `docs/architecture/census-wall.md` **W168** — "the user should understand the Wall without knowing Portava's architecture" |
| **Status** | **`?` (CANNOT-VERIFY). No participant has been recruited and no session has been run.** Nothing here is a result. |
| **What it needs** | 5–8 people who have never seen the Wall, a researcher to recruit and score, a second scorer, ~1 week elapsed / ~3 hours of work |
| **Origin of the threshold and rubric** | `docs/architecture/wall-certification-packet.md` §4, which fixed them before any participant existed. This file is the researcher's copy. |

> **The participant sheet at the end is EMPTY.** There are no participants, no
> quotes, no scores and no verdict. Every row is blank on purpose. Do not enter
> a hypothetical participant, a colleague's reaction, or a number you expect the
> study to produce. An empty sheet is the truth about this row.

---

## 1. The threshold, which must be agreed BEFORE anyone is recruited

**State it as a number first, so it cannot be moved afterwards.**

> **PASS requires all three:**
>
> - **P1 — ≥ 75 %** of participants pass **C1** (what the screen is). That is
>   **6 of 8**, or **4 of 5**.
> - **P2 — ≥ 60 %** of participants pass **C2** (what the Live strip says). That
>   is **5 of 8**, or **3 of 5**.
> - **P3 — no single word or phrase** is named as not understood by **more than
>   one** participant.
>
> **FAIL** = any of P1, P2 or P3 not met. A fail must list the failing item and,
> for P3, the exact words.
>
> **NOT A RESULT** (neither pass nor fail — the study did not happen) = fewer
> than 5 participants, a moderated session, a screener that was not recorded, or
> scoring by one person.

**Why P2's bar is lower than P1's.** "What is this screen" is the row's core — a
person who cannot answer it has not understood the Wall at all. The Live strip is
a secondary surface; some people will not look at it in a static stimulus, and
holding it to the same bar would fail the row for a reason about the *test*
rather than about the product.

**Why P3 is absolute and not a proportion.** C1 and C2 can absorb one confused
participant. Vocabulary cannot: if two strangers independently trip on the same
word, that word is a defect. This is also the only part of the row a tool
already guards — the machinery-vocabulary scanner at
`travel-buddy-standalone/src/features/wall/components/__tests__/WallDesignSystem.component.test.tsx:372`
(*no viewer-facing string names a piece of the Wall machinery*) refuses twenty
internal terms in viewer-facing copy. P3 is what catches a *product* word that is
plain English and still meaningless, which no scanner can find.

### The owner confirms the threshold here, before recruiting

| Field | Value |
| --- | --- |
| Threshold above agreed as written | ☐ yes ☐ amended (write the amendment below) |
| Amendment, if any | |
| Ratified by (owner name) | |
| Date ratified | |

*(unfilled — the threshold has not been ratified by anyone)*

> **Do not recruit before this block has a name and a date in it.** A threshold
> agreed after the answers are in is not a threshold.

---

## 2. Recruitment

Recruit **5–8** participants. Eight preferred; **below five the study does not
satisfy the row** and must not be recorded as a result.

### Screen OUT anyone who

- has used Portava, or has **seen the Wall in any form** — including in a design
  review, a demo, a screenshot in a deck, or over someone's shoulder;
- works on Portava, or is related to or lives with someone who does;
- was a participant in a previous round of this study.

### Screen FOR a spread

- at least **2** who describe themselves as infrequent social-media users;
- at least **2** who travel less than once a year.

Both groups are the ones most likely to read a travel-social feed as something
else, which is the failure this study is looking for.

**Record every screener answer.** A study whose participants turn out to have
seen the Wall is not a study, and that can only be established afterwards if the
screener was written down.

---

## 3. Stimulus

One **static screenshot**, or a short **silent screen recording**, of the **For
You** Wall on a phone, showing:

- the header,
- the Live For You strip,
- the first two to three feed cards, **including at least one card that is not a
  plain post** (a Postcard, a video or a shared moment — see
  `travel-buddy-standalone/src/features/wall/components/objects/`).

> **The stimulus must come from a real device build.** Not from
> `docs/architecture/wall-cert-render-set.html` and not from
> `travel-buddy-standalone/scripts/wall-review-packet.mjs`. Those are
> design-review instruments with stated fidelity limits, and two of those limits
> — **empty media wells** and **substituted icons** — would materially change
> what a stranger thinks they are looking at. A feed with no photographs in it is
> not the thing whose comprehensibility is being tested.

Record the build sha, the device and the file path of the stimulus on the result
sheet. Different participants must see the **same** stimulus.

---

## 4. Running it unmoderated

**No researcher in the room. No prompting. No clarifying. No follow-ups.**

This matters because the failure mode being tested is *a person not
understanding on their own*. A moderator who asks "and what do you think that
bar at the top does?" has already supplied the comprehension being measured.

**How to run it:**

1. Put the stimulus and the seven questions in a form (any unmoderated research
   platform, or a plain form link plus a hosted image).
2. Participants answer **in free text**. **Do not offer multiple choice** — a
   recognition task measures something much easier than comprehension, and will
   pass a screen nobody understands.
3. No time limit, but ask them to answer in order and not to go back.
4. No contact with the participant during the session. If someone emails to ask
   what something means, **do not answer** — record the question verbatim; it is
   data, and it is very likely a P3 finding.

---

## 5. The script — exactly these seven, in this order, with nothing added

1. Look at this screen for as long as you like, then answer in your own words.
   **What is this screen for? What would you use it to do?**
2. **Whose content are you looking at?** How do you think it got here?
3. Look at the strip across the top. **What is it telling you?**
4. **Is anything on this screen live or happening right now?** How can you tell?
5. Point to anything you **did not understand** or that felt like jargon.
   **Quote the exact words.**
6. If you tapped the item at the top of the feed, **what would you expect to
   happen?**
7. On a scale of **1–5**, how confident are you that you understood this screen?
   (1 = not at all, 5 = completely.)

Q7 is recorded but is **not** part of the threshold. Self-reported confidence and
actual comprehension come apart, often in the direction that matters least; it is
collected because a confident wrong answer is a more interesting finding than an
unconfident one, not because it decides anything.

---

## 6. Scoring rubric — fixed before recruiting

**Two scorers grade independently, then reconcile.** Scoring by one person is
listed in §1 as NOT A RESULT: a single scorer resolves their own ambiguity
invisibly, and every disagreement that would have surfaced is absorbed.

Each participant gets three binary items.

| Item | Passes when the participant… |
| --- | --- |
| **C1 — what the screen is** | (Q1) describes it as a **feed or stream of travel posts from people**, without being told. **Accept:** "a social feed for travel", "posts from people I follow about trips". **Reject:** "a search results page", "a booking site", "a list of places", "I don't know". |
| **C2 — what the Live strip says** | (Q3 or Q4) conveys that it shows things happening **now or recently, at places**. **Reject:** "adverts", "stories", "my photos", "I don't know", and any answer that only repeats a word off the screen without meaning. |
| **C3 — no jargon wall** | (Q5) names **zero** viewer-facing words they did not understand. A named word is recorded **verbatim**. One uncomprehended word fails this item for that participant. |

C3 is recorded per participant; **P3 is computed across participants** — it fails
if any single word is named by more than one person.

---

## 7. Result sheet — **EMPTY. UNFILLED. NO STUDY HAS BEEN RUN.**

### 7.1 Study record

| Field | Value |
| --- | --- |
| Dates run | |
| Researcher / who recruited | |
| Scorer 1 (name) | |
| Scorer 2 (name) | |
| Threshold ratified in advance by (name, date — from §1) | |
| Stimulus: build sha | |
| Stimulus: device | |
| Stimulus: file archived at | |
| Participants recruited / completed | ___ / ___ |
| Screener records archived at | |
| Raw responses archived at | |

*(unfilled — no study record exists)*

### 7.2 Per participant

> Rows P1–P8 are blank. There are no participants. Do not fill a row with anyone
> who has not actually taken the study unmoderated.

| # | Screened in (date) | C1 | C2 | C3 | Words named as not understood (verbatim) | Q7 confidence (1–5) |
| --- | --- | --- | --- | --- | --- | --- |
| P1 | | ☐ pass ☐ fail | ☐ pass ☐ fail | ☐ pass ☐ fail | | |
| P2 | | ☐ pass ☐ fail | ☐ pass ☐ fail | ☐ pass ☐ fail | | |
| P3 | | ☐ pass ☐ fail | ☐ pass ☐ fail | ☐ pass ☐ fail | | |
| P4 | | ☐ pass ☐ fail | ☐ pass ☐ fail | ☐ pass ☐ fail | | |
| P5 | | ☐ pass ☐ fail | ☐ pass ☐ fail | ☐ pass ☐ fail | | |
| P6 *(if recruited)* | | ☐ pass ☐ fail | ☐ pass ☐ fail | ☐ pass ☐ fail | | |
| P7 *(if recruited)* | | ☐ pass ☐ fail | ☐ pass ☐ fail | ☐ pass ☐ fail | | |
| P8 *(if recruited)* | | ☐ pass ☐ fail | ☐ pass ☐ fail | ☐ pass ☐ fail | | |

*(unfilled — every row is blank)*

### 7.3 Scorer disagreements

Record every item the two scorers graded differently, before reconciling. A
study with zero recorded disagreements over eight participants is more likely to
mean the scorers talked than that the rubric was unambiguous.

| Participant | Item | Scorer 1 | Scorer 2 | Reconciled to | Why |
| --- | --- | --- | --- | --- | --- |
| | | | | | |

*(unfilled)*

### 7.4 Verdict

| Field | Value |
| --- | --- |
| **C1 passes** | ___ / ___  (P1 needs ≥ 75 %) ☐ PASS ☐ FAIL |
| **C2 passes** | ___ / ___  (P2 needs ≥ 60 %) ☐ PASS ☐ FAIL |
| **Words named by more than one participant** | *(P3 fails if this is non-empty)* |
| **P3** | ☐ PASS ☐ FAIL |
| **Verdict** | ☐ PASS → propose W168 `? → C` ☐ FAIL → propose W168 `? → W` |
| Researcher signature / date | |
| Scorer 1 signature / date | |
| Scorer 2 signature / date | |

*(unfilled — no verdict has been reached)*

---

## 8. What a FAIL would mean

A fail does not mean the Wall is incomprehensible; it means a specific thing
failed and names it.

- **P1 fails** → people do not recognise the screen as a travel feed. That is a
  framing problem in the header and the first card, not a copy problem.
- **P2 fails** → the Live For You strip does not communicate liveness. The strip
  is `travel-buddy-standalone/src/features/wall/components/LiveForYouStrip.tsx`.
- **P3 fails** → a specific word is a defect and the study has named it in the
  participants' own words. That is the most directly actionable outcome this
  study can produce.

A fail moves W168 to **`W` (BUILT-BUT-WRONG)**, not to `C` and not to `X`.

---

## Who does what next

| Who | What |
| --- | --- |
| **Owner** | Ratify the threshold in §1 — name and date — **before** anyone is recruited. |
| **Researcher** | Recruit against §2, capture the stimulus from a real device build (§3), run it unmoderated (§4–§5), archive the raw responses. |
| **Two scorers** | Grade §6 independently, record disagreements in §7.3, reconcile, sign §7.4. |
| **Integration lead** | Move W168 in `docs/architecture/census-wall.md` on the filled, signed §7 — `C` on a PASS, `W` on a FAIL. Not on this document, which is only the protocol. |
