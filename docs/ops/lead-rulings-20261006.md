# Lead rulings on the open decisions (2026-10-06)

**Authority.** On 2026-10-06 the owner delegated routine architecture, product and privacy decisions to the lead,
in these words: "For unresolved choices, select a documented, privacy-preserving and secure default, explain the
rationale in an ADR or decision log, and continue." Each ruling below covers a question listed as open in the
2026-10-06 decision clerk note (`D-nn`). Any of them can be reversed by an owner answer. None is a legal or tax
approval, and none should be read as one.

**How each default was chosen.** Where two readings exist, take the one that (1) never widens who can see or reach a
person, (2) never refuses someone on the strength of a rule they cannot read about, and (3) fails closed when a
needed read fails.

---

## D-24: what each Trust restriction stops
**Ruling: CONFIRM the lanes' mapping (decision note §D-24 table), with one transparency correction.** The sentence
a restricted person is shown must name every capability that restriction stops. Anything not named in that sentence
must not be refused.
- Rationale: OD-TRUST-5 requires restrictions to be enforced on the server and limited to what is needed. D-24's own
  "Wider →" rule says nobody is refused under a restriction they cannot read about.
- Sentences (wording owned by Trust, `TrustPrivacyGuard`):
  - hosting: "You cannot host group trips or start or link public Trails."
  - messaging: "You cannot start new conversations, submit public content (Trail suggestions, gems, community
    places), or have your posts boosted."
  - **Amendment (2026-10-06, lane L verifier):** the confirmed mapping also stops a hosting-restricted person
    changing a *group* trip's shared plan (adding, editing, removing or reordering items, proposals, confirming
    Compass plan or Autopilot changes), so the hosting sentence names it too: "You cannot host group trips,
    change a group trip's shared plan, or start or link public Trails. You also cannot be booked as a Buddy."
    Solo trips stay unaffected (D-24a). Every surface that refuses under a restriction shows the sentence from
    `restrictionSentence()`; no surface keeps its own copy.
  - private-plan access: unchanged, plus "You also cannot book a Buddy."; location plan: unchanged.
  - **Amendment (2026-10-06, lane B):** the hosting sentence also ends "You also cannot be booked as a
    Buddy." The mapping this ruling confirms already stops both bookings (decision note §D-24 table, lane B
    rows), and the sentences first written here left them out. Under this ruling's own rule an unnamed
    capability may not be refused, so the clauses are added rather than the refusals dropped (dropping them
    would widen who can reach a restricted person). The canonical text is `restrictionSentence()` in
    `services/trust/TrustPrivacyGuard.ts`.
  - **Amendment (2026-10-06, lane L):** the confirmed mapping refuses a trip proposal made through commands or
    re-plan under hosting *or* messaging, so the messaging sentence also names it: "You cannot start new
    conversations, propose changes to a group trip, submit public content (Trail suggestions, gems, community
    places), or have your posts boosted."
- **D-24a: a hosting restriction does NOT stop changes to a solo trip.** A solo trip affects nobody else. Every
  Compass and Trips door applies the same solo/group test. If whether a trip is solo cannot be read, treat it as a
  group trip and refuse with "try again", never with "restricted".
- **D-24b: no separate "publishing" restriction in this release.** Adding one would change the Trust model,
  appeals and the restriction summaries all at once. Starting or linking a Trail stays under hosting; community
  submissions stay under messaging. The sentences above now say so.
- **D-24c: YES.** While a messaging restriction is active, the person's posts get no boost lift. Their stored
  boost preference is kept, and the lift comes back when the restriction ends. If the restriction state cannot be
  read, apply no boost: this is fail-closed for reach amplification, and it refuses nothing the person does.
- **D-24d: YES.** Blocking another user is never stopped, including when the blocker's restriction state cannot
  be read. A block is protective.

## D-65: what "owner-only" covers for a private trip place
**Ruling: YES (the lead's recommendation stands).** Owner-only covers the place's location and also its name,
title, notes, description, place and source identifiers, and any text derived from them: event payloads, caches,
offline bundles, daily briefs, plan lists, Telegraph trip context, Today. A per-anchor share to selected members
reveals only to those members.

## D-66: is a new Trail reviewed before others can see it?
**Ruling: YES, review before it becomes visible.**
- A newly started Trail is visible only to its creator. Until an admin approves it, it is not ranked, surfaced,
  linked or shared.
- A rejected Trail stays private to its creator and shows the reason.
- The 3-per-person-per-day allowance (migration 3975) stays in force.
- Trail creation stays behind its feature flag, seeded false.

## D-67: what may be labelled "verified live"
**Ruling: only a place whose identity is confirmed.** "Open right now" and every other "verified live" label need
one of two things:
- the provider record matches the Portava place by a stored provider id; or
- the names match after normalisation AND the provider's coordinates are within **150 m** of the place's.

Anything else gets no "verified live" label. Listing hours may still be shown if labelled as listed hours. 150 m is
an engineering default chosen to allow for geocoding drift on one street frontage. It is recorded here so it can be
changed in one place.

## D-103: which way a `followers` availability window points
**Ruling: MUTUAL follow on every surface.** The viewer must follow the owner AND the owner must follow the viewer.
- Rationale: `user_follows` is one-way and has no approval state (baseline `CREATE TABLE public.user_follows`). If
  the rule were "viewer follows owner", anyone could let themselves in with one tap. Mutual is a strict subset of
  both readings in use today (header/`canMessage`/Compass on one side, Passport/Nearby on the other), so no surface
  widens and every surface follows the same rule.
- The editor labels the option "People you follow who follow you back".
- This ruling covers availability windows only. It does not change `canMessage`'s own messaging-permission rule.

## Q-L20: the words of the three sensing consents (recorded by lane L, 2026-10-06)
**Ruling (lead): plain wording for each of the three OD-MAP-6 consents — what is captured, where it goes, who
sees it, how to turn it off. Lane L drafts; the lead approves the draft in review.**
- Draft: `docs/contracts/sensing-consent-split-v1.md` (app copy: `travel-buddy-standalone/src/lib/sensing/consentSplit.ts`).
- **PENDING LEGAL REVIEW.** Legal review is a beta-launch sign-off, not an approval the team can give. Until it
  signs off, `sensing_consent_split_enabled` (migration 3703, seeded FALSE) stays off and nobody can hold these
  consents; withdrawing one is always possible.

## Q-L23 / D-38a: capture the reported text at report time
**Ruling (lead): YES.** Capture the reported text when the report is filed. Keep it for moderators only, delete it
with the report, and never show it to the reporter or the reported person. (Status of the build: lane L's wave-6
report.)
