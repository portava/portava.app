# Lead rulings on the open Map, Media, Passport (and neighbouring) questions (2026-10-07)

**Status: PROPOSED by lane M, for the lead's review before merge.** Each entry below carries the line
"proposed by lane M, adopted by the lead 2026-10-07 under the owner's delegation". That line takes effect
only when the lead accepts this file. Until then nothing in it is a decision.

**Authority.** On 2026-10-06 the owner delegated routine architecture, product and privacy decisions to the
lead: "For unresolved choices, select a documented, privacy-preserving and secure default, explain the
rationale in an ADR or decision log, and continue." `docs/ops/lead-rulings-20261006.md` holds the first
rulings made under that delegation. This file adds the next set. The owner can reverse any of them.
None of them is a legal, tax, vendor or production approval, and none should be read as one.

**Source of the questions.** These are lane L's 45 single-answer questions (`Q-L1` … `Q-L24`, revision 2 of
2026-10-06), which the decision clerk's consolidated list numbers `D-8`, `D-10`, `D-25` to `D-28`, `D-30`,
`D-32`, `D-36`, `D-38`, `D-41`, `D-80` to `D-84` and `P-6`. Each entry gives both ids. Every question was
checked against `docs/ops/owner-decisions-20261004.md` (OD-PAY-1 … OD-TRUST-9 and its Part 2) and
`docs/ops/lead-rulings-20261006.md` first.

**How each default was chosen.** The same three tests as the 2026-10-06 rulings: (1) never widen who can
see or reach a person; (2) never refuse someone on the strength of a rule they cannot read about; (3) fail
closed when a needed read fails. Two more apply here. A ruling never turns a flag on: every flag named
below stays seeded FALSE until the owner's isolated beta environment exists. And a "yes" to a feature that
collects something new is always a narrow yes, behind its own consent and its own flag.

**What stays unanswered.** Vendor choices (`D-27`, the Media half of `D-28`), consent wording that needs
legal review (`D-30a`), owner-reserved artefacts (`D-80`), facts only the owner knows (`P-6b`, `P-6c`) and
two scope questions (`D-36b`, `D-36c`). Each is marked **NOT RULED**. Its path stays as it is today:
the refusing provider, the flag seeded FALSE, or nothing built.

---

## Already answered (no new ruling)

- **Q-L21 (TRV2-08): what a Trust restriction stops in Compass.** Answered by lead ruling D-24 and D-24a
  (2026-10-06).
- **Q-L24 (TRV2-08): the boost lift under a messaging restriction.** Answered by lead ruling D-24c
  (2026-10-06).

---

## Compass

### D-80 (Q-L1, CPH-02): will the owner supply the finalised Compass system prompt, or confirm `compass-v2`?
- **NOT RULED (owner-reserved).** `docs/compass/master-roadmap.md` reserves Phase 2, installing the finalised
  system prompt verbatim, for the owner and says "do not touch". A lane ruling would override that
  reservation. The shipped `compass-v2` prompt stays in use. CPH-02 stays N.
- Proposed by lane M, adopted by the lead 2026-10-07 under the owner's delegation: only the decision not to
  rule.

### P-6b (Q-L2, CCL-03): was the intent classifier compared with the keyword router before #402?
- **NOT RULED (fact only the owner can confirm).** This asks what happened, not what should happen. No
  comparison is recorded in the repository. Recording that absence is not the same as knowing none was
  made. CCL-03 stays as it is.
- Proposed by lane M, adopted by the lead 2026-10-07 under the owner's delegation: only the decision not to
  rule.

### P-6c (Q-L3, CCL-14): were attention budgets, a switching policy and the related rules ever approved?
- **NOT RULED (fact only the owner can confirm).** The tree's values (`AWARE_DAILY_CAP`, `ACTIVE_DAILY_CAP`,
  `SWITCHING_COST`) are documented as engineering tunables. The lead does not ratify them after the fact,
  because the requirement asks whether an approved set already existed. CCL-14 stays as it is.
- Proposed by lane M, adopted by the lead 2026-10-07 under the owner's delegation: only the decision not to
  rule.

---

## Map

### D-36a (Q-L4a, M122): is the Transport layer base-map styling or a new object kind?
- **Ruling: base-map styling.** The Transport toggle restyles the base map to show its own transit
  features. It adds no `MapObjectKind`, no producer and no data source.
- **Rationale.** Styling the base map needs no new data about anyone. It also keeps §18's closed set of
  thirteen kinds closed, which `docs/map/scope-ruling-phases-6-7.md` requires for any new kind.
- Proposed by lane M, adopted by the lead 2026-10-07 under the owner's delegation.

### D-36b (Q-L4b, M129): may building entrances become a map object kind, sourced from OpenStreetMap?
- **NOT RULED (scope).** An entrance kind would be a fourteenth kind. The scope ruling admits a kind beyond
  the thirteen only on an explicit owner amendment with a written object contract. The tree also has no
  entrance import. Nothing is built, and M129 stays W.
- Proposed by lane M, adopted by the lead 2026-10-07 under the owner's delegation: only the decision not to
  rule.

### D-36c (Q-L4c, M130): should venue interiors become map objects?
- **NOT RULED (scope).** This needs the same owner amendment as D-36b and also a venue-interior data
  source, which does not exist. Nothing is built, and M130 stays N.
- Proposed by lane M, adopted by the lead 2026-10-07 under the owner's delegation: only the decision not to
  rule.

### D-81a (Q-L5a, M65): under OD-MAP-1's opt-in, may a flow hop start from the coarse zone the device is in when navigation starts?
- **Ruling: YES, narrowly.** Each limit is required:
  - zone-granular only, and never a stored position;
  - only for a person who has opted in to coarse route-flow contributions (OD-MAP-1, OD-MAP-2);
  - suppressed inside the person's protected zones (OD-MAP-3);
  - kept 180 days at most (OD-MAP-7);
  - behind its own flag, seeded FALSE.
- **Rationale.** OD-MAP-1 already allows an opt-in coarse contribution. This is the narrowest reading
  that makes the contribution useful.
- Proposed by lane M, adopted by the lead 2026-10-07 under the owner's delegation.

### D-81b (Q-L5b, M65): may an arrival count as a hop when the same act does not name the origin?
- **Ruling: NO.** A hop needs an origin stated in the same act.
- **Rationale.** Joining an arrival to an earlier, separate act is the trajectory reconstruction the spec
  forbids.
- Proposed by lane M, adopted by the lead 2026-10-07 under the owner's delegation.

### D-81c (Q-L5c, M65): may population-level presence changes count as crowd flow?
- **Ruling: NO.** M65's criterion is amended to the signal families that can be fed honestly.
- **Rationale.** Movement derived from presence deltas is still movement inferred about people who
  contributed none.
- Proposed by lane M, adopted by the lead 2026-10-07 under the owner's delegation.

---

## Media — surfaces (F1/F2)

Each "yes" here authorises a flag that is already built and seeded FALSE (migrations 3340–3343). No flag is
turned on by this file. Each needs the isolated beta environment and a device run, so the rows they cover
stay W: their blocker is now **activation**, not an owner decision.

### D-8 (Q-L8a): should the Media tab open on the World shell instead of Watch?
- **Ruling: YES**, behind the flag in 3340.
- **Rationale.** "World-first, not creator-first" (MD2). The shell is built and tested in both flag states
  (census-media §34).
- Proposed by lane M, adopted by the lead 2026-10-07 under the owner's delegation.

### D-10a (Q-L8b): should the Watch overlay put Compass first and drop the stamp/count rail?
- **Ruling: YES**, behind the flag in 3341.
- **Rationale.** Context comes first and engagement counts come second. Showing fewer social counts is the
  less exposing choice.
- Proposed by lane M, adopted by the lead 2026-10-07 under the owner's delegation.

### D-10b (Q-L8c): should no Watch cell play until it is tapped?
- **Ruling: YES**, behind the flag in 3342.
- **Rationale.** Nothing plays without the person choosing it, and no video data is fetched that they did
  not ask for.
- Proposed by lane M, adopted by the lead 2026-10-07 under the owner's delegation.

### D-10c (Q-L8d): should Watch be ordered by the §24 stage instead of the legacy ranker?
- **Ruling: YES**, behind the flag in 3343.
- **Rationale.** The §24 stage carries no creator-identity boost. The legacy boosts are already off in
  production (census-media §41.4).
- Proposed by lane M, adopted by the lead 2026-10-07 under the owner's delegation.

### D-10d (Q-L8e): should the full-screen paging feed stop existing as a mode?
- **Ruling: NO.** It stays as a non-default mode.
- **Rationale.** Removing a working mode gains no privacy or safety. The World shell becoming the default
  (D-8) already answers "not creator-first".
- Proposed by lane M, adopted by the lead 2026-10-07 under the owner's delegation.

### D-10e (Q-L8f): may Media own the spec's §24 ranking stage (§42 against §48)?
- **Ruling: YES, for Media surfaces only.** No other surface takes its ordering from it.
- **Rationale.** This keeps the conflict between the two spec sections local to Media.
- Proposed by lane M, adopted by the lead 2026-10-07 under the owner's delegation.

---

## Media — photo evidence on place reports (MD53, MD58, MD65, MD66, MD370, MD445)

### D-25a (Q-L9a): may a person attach one of their own photos as evidence to a place report they make at that moment?
- **Ruling: YES, narrowly.**
  - Census-media §35.4 Option A.
  - The tap is the observation; the photo is evidence beside it.
  - It needs its own revocable consent, separate from Quick Signals (OD-MAP-6).
  - It sits behind its own flag, seeded FALSE.
  - It is kept at most 180 days (OD-MAP-7) and erased with the account.
  - **Not built in this release.** The disclosure text naming photos must first be drafted and approved,
    which is wording the owner keeps (see D-30a).
- **Rationale.** OD-MAP-6 anticipates consented secondary uses. b–e below are what make this one safe.
- Proposed by lane M, adopted by the lead 2026-10-07 under the owner's delegation.

### D-25b (Q-L9b): must the stored evidence copy be unlinkable to the person's account?
- **Ruling: YES.** The photo is re-encoded into an evidence store under a random key. The key has no owner
  segment and the row has no `media_asset_id` (§35.4 Question 3 (ii)). Erasure finds the copy by its
  token-keyed row.
- **Rationale.** Any link from evidence back to the asset re-identifies the contributor. It also
  re-identifies every observation that contributor made under the same weekly token.
- Proposed by lane M, adopted by the lead 2026-10-07 under the owner's delegation.

### D-25c (Q-L9c): may linked photo evidence raise a report's confidence?
- **Ruling: only after moderation clears the photo.** No classifier vendor or staffed review is chosen
  (D-27d is not ruled). So in this release, evidence never lifts confidence.
- **Rationale.** Otherwise one tap and an unmoderated photo would buy a large confidence boost.
- Proposed by lane M, adopted by the lead 2026-10-07 under the owner's delegation.

### D-25d (Q-L9d): may other people be told that a photo backs an observation?
- **Ruling: NO.**
- **Rationale.** Saying so re-identifies the contributor.
- Proposed by lane M, adopted by the lead 2026-10-07 under the owner's delegation.

### D-25e (Q-L9e): may a photo back claim types other than crowd level?
- **Ruling: crowd level (`crowd.level`) only, to start.** No media-only claim type ("visual current")
  exists.
- **Rationale.** The smallest surface that answers the spec's question.
- Proposed by lane M, adopted by the lead 2026-10-07 under the owner's delegation.

---

## Media — rules (MD37, MD71, MD77, MD79, MD162, MD175, MD197, MD255, MD385, MD446)

### D-26a (Q-L10, MD37): should an ordinary upload record camera, library or screenshot?
- **Ruling: NO.** §35.4 MD37 Option 0: §6 gains an "undeclared" member, and the stored value `'user'` is it.
  No photo changes eligibility or rank. Two values already in the tree are confirmed:
  - `community` for gem photos and event media;
  - legacy rows stay `'user'`.
- **Rationale.** A client-declared source can be a lie. Declaring it would also make every photo
  evidence-eligible, which is a protection change across all content (Option B).
- Proposed by lane M, adopted by the lead 2026-10-07 under the owner's delegation.

### D-26b (Q-L11, MD71): may a photo ever be labelled "live"?
- **Ruling: NO.** The freshness label is capped at `fresh`, and the spec is amended to match (§35.4 MD71 (a)).
- **Rationale.** "Live" would claim a present-tense fact that a photo cannot assert. It would also disclose
  an evidence link (MD71 (b)).
- Proposed by lane M, adopted by the lead 2026-10-07 under the owner's delegation.

### D-26c (Q-L12, MD197): may Media compute and show a contributor's reputation to other people?
- **Ruling: NO.** §35.4 MD197 Option 0. Contribution Value stays marginal coverage. §25 trust is shown only
  to its subject, and §14.4's reputation falsifier is conceded. Place Expertise at a named place is never
  shown to others.
- **Rationale.** Any "yes" computes, per viewer, where and how often a named person reported. That is
  re-identification as a service.
- Proposed by lane M, adopted by the lead 2026-10-07 under the owner's delegation.

### D-26d (Q-L13, MD162): may the crowd-flow payload carry each endpoint's name and the public place ids in each zone?
- **Ruling: YES, narrowly.**
  - Only public places that the place-disclosure choke point already discloses.
  - Only on flows that already clear `MIN_SIGNAL_FAMILIES` and the k floor.
  - Only behind `map_crowd_flow_enabled`.
- **Rationale.** Zone names and public place ids describe places, not people. The k floor is what keeps a
  flow from describing a person.
- **Not built by lane M.** The payload lives in `routes/mapProjection.ts`, which lane L is changing, and the
  row also needs production flows.
- Proposed by lane M, adopted by the lead 2026-10-07 under the owner's delegation.

### D-26e (Q-L14a, MD77): should media ever stop being shown socially after a time?
- **Ruling: NO** (§36.4 MD77 (c)). A post stays on social surfaces until its author deletes it or narrows
  its audience.
- **Rationale.** No one's content changes, and the author keeps full control through delete and audience.
- Proposed by lane M, adopted by the lead 2026-10-07 under the owner's delegation.

### D-26f (Q-L14b, MD79): when should a post's exact place stop being shown to others?
- **Ruling:** only for "Publish after I leave" (`location_privacy_mode = 'delayed_until_exit'`), **24 hours
  after the post is released** (`published_at`).
  - A released post whose release time cannot be read counts as already ended (fail closed).
  - The author always sees their own place.
- **Rationale.** The person chose that mode so that others would not learn where they were. The 24-hour
  figure is the spec's own example window. It is recorded here so that it can be changed in one place.
- Proposed by lane M, adopted by the lead 2026-10-07 under the owner's delegation.

### D-26g (Q-L14c, MD79): when the place stops being shown, what replaces it?
- **Ruling: the city.** This is the tier "Hide exact place" already uses.
- Any stricter tier the post already has still wins: the cap only ever narrows.
- Proposed by lane M, adopted by the lead 2026-10-07 under the owner's delegation.

### D-26h (Q-L14d, MD175): what is "Remix"?
- **Ruling:** a Compass variation ("a night like this, elsewhere"), §36.4 MD175 (b). It is a Compass ask
  carrying the chain's public place ids. Compass stays propose-only. Nothing reaches the original author.
- **Rationale.** It reuses an existing propose-only path and creates no new copy of anyone's content.
- Proposed by lane M, adopted by the lead 2026-10-07 under the owner's delegation.

### D-26i (Q-L14e, MD255): are `following` and `shared_moment` attachment-level audiences only?
- **Ruling: YES** (§36.4 MD255 (c)).
  - The six §33 audiences are the vocabulary of the §6.1 attachment override, which only narrows its
    parent.
  - The composer keeps its four post-level audiences.
  - The following feed keeps refusing any audience it does not know.
- **Rationale.** Option (b) widens a post's caption and place to everyone. Option (a) touches 47 readers for
  no privacy gain.
- Proposed by lane M, adopted by the lead 2026-10-07 under the owner's delegation.

### D-26j (Q-L14f, MD385): may a person make a Memory from a media item?
- **Ruling: from their own media only** (§36.4 MD385 (a)). The server checks that the person owns the source
  post.
- **Rationale.** Someone else's photo inside your Memory needs consent, credit and deletion rules that do not
  exist (option (b)).
- Proposed by lane M, adopted by the lead 2026-10-07 under the owner's delegation.

### D-26k (Q-L14g, MD446): what is "Show Me Now"?
- **Ruling:** the NOW lens's "FOR YOU NOW" strip (§36.4 MD446 (a)).
- **Rationale.** It asks for no new permission and sends no new request to any contributor. Option (b) would
  ask contributors for photos; option (c) would ask for location.
- Proposed by lane M, adopted by the lead 2026-10-07 under the owner's delegation.

---

## Media — vendors (NOT RULED)

None of these is ruled. Each seam stays a refusing provider and each stage flag stays seeded FALSE. Each
names a vendor, a data-processing agreement or a staffing commitment, and the owner keeps those decisions.

- **D-27a (Q-L15a, MD63, MD289):** image-understanding vendor. NOT RULED.
- **D-27b (Q-L15b, MD277):** video transcoder. NOT RULED.
- **D-28, Media half (Q-L15c, MD280):** an ASR vendor or person-authored captions only. NOT RULED.
  OD-INPUT-5 and OD-TRUST-8 (on-device first; separate consent before audio leaves the device) still bind.
- **D-27c (Q-L15d, MD293):** visual-similarity index. NOT RULED.
- **D-27d (Q-L15e, MD283, MD269):** a classifier vendor or staffed human review. NOT RULED.

Proposed by lane M, adopted by the lead 2026-10-07 under the owner's delegation: only the decision not to
rule.

## Media — moderation

### D-82 (Q-L16, MD269 (a)): when moderation holds a general post's media, what happens to the post?
- **Ruling: refuse to create the post while any of its media is held.** This is census-media §37.8.5
  option 3.
  - With the moderation stage on, `POST /posts` answers that the media is still in review and writes
    nothing.
  - If the media's moderation state cannot be read, the post is also refused, with "try again" and never
    with "rejected".
  - With the stage off, nothing changes.
- **Rationale.** This is the smallest rule that keeps held media out of every legacy reader (Pulse, Wall,
  profile grid, `GET /posts/:id`). It does not entangle the delayed-publish state machine.
- Proposed by lane M, adopted by the lead 2026-10-07 under the owner's delegation.

---

## Passport

### D-41 (Q-L17a, P59; and Layover L274): should "Visa Buddy" exist?
- **Ruling: NO.**
  - The Passport has six capabilities; the spec's seventh is withdrawn.
  - No Layover path through Rent-a-Buddy offers visa help.
- **Rationale.** Visa help is already classed as a scam signal (`travelScamSignals.ts` `VISA_HELP`). A
  capability that authorised it would need legal review that a "no" does not.
- Proposed by lane M, adopted by the lead 2026-10-07 under the owner's delegation.

### D-83 (Q-L17b, P159): what is the "deeper Experience Graph" Passport surface?
- **Ruling: dropped as a separate surface.** On the Passport, the Experience Graph is Travel DNA and the
  yearbook, as built. Nothing further is built.
- **Rationale.** No definition exists, and building an undefined graph of a person's experiences risks
  exposing more about them than any surface does today.
- Proposed by lane M, adopted by the lead 2026-10-07 under the owner's delegation.

### D-32 (Q-L18, P13, P128, P133): keep the Passport's document-card composition and light paper identity?
- **Ruling: KEEP.** The spec is amended to the shipped document card with its spine, the left-column
  portrait and the light paper theme. The spec's hero image, overlapping portrait, glass effect and
  dark-mode-first theme are withdrawn.
- **Rationale.** `brand-palette-decision.md` already retained the paper colour identity and forbids
  rebuilding working screens. This ruling extends that to layout and theme, which the palette ruling left
  open.
- Proposed by lane M, adopted by the lead 2026-10-07 under the owner's delegation.

### D-84 (Q-L19, P61): what act earns a Place stamp?
- **Ruling: a verified check-in (QR or geofence) at a canonical place.**
  - The stamp carries `place_id`. `PassportPrivacyGuard.guardStamp` keeps it from anyone but the owner, so
    others see no more than the city.
  - There is one Place stamp per person per place.
  - No Place stamp is awarded for a check-in inside the person's protected zones (OD-MAP-3).
  - It is earned, factual and shows why and when (OD-TRUST-7).
  - It is written only after migration 2880 and a place-keyed uniqueness rule are applied. Until then the
    writer stays off (2880's own ordering).
- **Rationale.** "I was here" is a presence fact. It must never reveal a venue to others or a home-like
  place at all.
- Proposed by lane M, adopted by the lead 2026-10-07 under the owner's delegation.

---

## Sensing

### D-30a (Q-L20, S18, S24, S32, S39): approve the words of the three separate Sensing consents
- **NOT RULED (consent wording; legal).** The three-way split itself is decided by OD-MAP-6. The words are not
  drafted for approval here. OD-TRUST-9 ties final wording to the actual policies and operating markets. The
  capture and upload paths stay behind their flags, seeded FALSE.
- Proposed by lane M, adopted by the lead 2026-10-07 under the owner's delegation: only the decision not to
  rule.

---

## Moderation (census-trust TV-4a)

### D-38a / D-99 (Q-L23): capture a reported post's, comment's or message's text at report time?
- **Ruling: YES.**
  - The text is captured when the report is made.
  - Only moderators can read it.
  - It is deleted with the report.
  - The capture stays behind its flag, seeded FALSE, until D-38b (how long captured evidence is kept) is
    decided. D-38b is not ruled here.
- **Rationale.** A reported person can delete the text before review, so a live read lets the evidence
  vanish. Moderator-only access means nobody else sees more than before.
- Proposed by lane M, adopted by the lead 2026-10-07 under the owner's delegation.
