# Sensing consent disclosure v2 — text under owner review

Status: **DEFINED, NOT IN FORCE.** No person holds this consent today. The
server stamps `intel_contributions_v1` on every grant
(`artifacts/api-server/src/lib/intelConsent.ts`, `INTEL_CONSENT_DISCLOSURE_VERSION`),
and nothing in this branch changes that constant.

Version string: `sensing_contributions_v2`
Client source of the words: `travel-buddy-standalone/src/lib/sensing/consentDisclosure.ts`
Server table of what it covers: `artifacts/api-server/src/lib/sensingConsentScopes.ts`

## Why a new disclosure is needed

The words people have agreed to so far (v1, shipped in the Quick Signal
consent gate) are:

> **Help improve live place intelligence**
>
> Your Quick Signals can be combined with reports from other travelers to show
> what a place is like right now.
>
> Your identity and exact location aren't shown publicly with the signal.
> Portava uses your contribution to generate aggregated place intelligence.
>
> You can turn Intelligence Contributions off anytime in Privacy settings.

That text describes **Quick Signals**, which are explicit taps. It says nothing
about the phone noticing motion or area in the background. A person who agreed
to it has not agreed to passive sensing, and has not agreed to their passive
contributions being shown to anyone, even in aggregate.

So under v1 the anonymous sensing store's scopes are **none**:

| Recorded version | collect | retain | aggregate | surface |
|---|---|---|---|---|
| `intel_contributions_v1` | no | no | no | no |
| `sensing_contributions_v2` | yes | yes | yes | yes |
| anything else, or none | no | no | no | no |

Changing `SENSING_ANON_GRANTED_SCOPES` (the owner's POLICY for the store) does
not change this table. A session carries the **intersection** of the policy and
the person's consent, so a policy that grants `surface` surfaces nothing until
people hold a consent whose words cover it.

## The v2 text, verbatim

**Title:** Help show what places are like right now

1. With this on, your phone can notice, in the background, coarse signals about
   how you're moving — for example walking, staying a while, or arriving — and
   the rough area you're in. It turns them into a few simple categories on your
   phone before anything is sent.
2. No exact location, no recording, no contact list and no account ID is sent
   with these signals. They are only counted together with other travelers when
   enough different people are in the same area at the same time.
3. When enough people are counted, other travelers may see that people are
   around a place right now, or that it isn't known. Never how many, and never
   who.
4. Your Quick Signals are still combined with other reports to show what a
   place is like right now.

**Footnote:** Turning this off stops your phone from contributing at its next
check. Sound level sensing is a separate choice with its own switch.

**Settings summary:** In the background, coarse movement and area signals,
reduced on your phone, count toward what a place is like right now. Others may
see that people are here — never how many, never who.

## What `surface` means under these words

Paragraph 3 is the disclosure the `surface` scope rests on. It permits exactly
one thing to be shown to other people: a zone-level presence answer of
"people are here" or "not known", published only after the crowd threshold and
the differencing gate pass. It does not permit a count, a band that implies a
count, a list, or anything that names or singles out a contributor. If the
product ever wants to show more than that, it needs new words and a new version.

## How the words are enforced in code on this branch

- **Issuance.** `POST /v1/sensing/session` reads the person's recorded
  `consent_version` and issues only the scopes that version covers, intersected
  with the policy. Under v1 it refuses with
  `disclosure_does_not_cover_passive_sensing`.
- **Per contribution.** Each contribution records `surface_permitted`
  (migration 3315) from the scopes it was admitted under. The admission ladder
  refuses any requested scope outside its session's scopes, so a device cannot
  claim `surface` its session lacks. Rows from before 3315, and rows from
  sessions without `surface`, read false.
- **Publication.** The publisher counts only rows with `surface_permitted`
  true. A contributor without surface consent is never part of a published
  answer, even as one of the crowd.
- **The device.** The capture loop starts only when the recorded version's
  words cover passive sensing (`consentCoversPassiveSensing`). Under v1 it does
  not start.
- **Which words were seen.** A grant carries the version whose words the
  client displayed. The server refuses a grant whose displayed version differs
  from the one it stamps. A grant with no version comes from a client that
  hard-coded the v1 words, so it is treated as having seen v1 and is refused
  once the stamp moves past v1.

## What turning it off does, exactly

- **New sessions stop at once.** The issuer reads consent on every request and
  refuses a withdrawn consent (`withdrawn`).
- **The device stops at its next check.** The capture loop re-reads consent on
  every app foreground, stops, and drops its credential. The footnote's words
  "at its next check" describe this.
- **A session already issued can run out its life, at most 24 hours.** A
  session row holds no account identity, by design, so the server cannot find
  "this person's" live session to revoke it. A device that kept capturing in
  the background without coming to the foreground could keep contributing
  under an already-issued session until it expires. Those contributions are
  as unlinkable as every other.
- **Account deletion** erases the person's identified intel, recomputes the
  snapshots that rested on it, and removes references to withdrawn snapshots
  from other people's memories. It does not and cannot find anonymous
  contributions, which carry nothing that names the account.

## What activating v2 takes (owner decisions, not done here)

1. The owner approves the title, the four paragraphs, the footnote and the
   settings summary above, or supplies replacements. Replacements change the
   client module and this file together.
2. The owner decides whether the settings switch may grant v2 from its summary
   line, or must open the full text first. Today the settings switch grants
   from the summary, which was acceptable for v1's two sentences.
3. One release ships the server constant `INTEL_CONSENT_DISCLOSURE_VERSION =
   "sensing_contributions_v2"` together with a client build carrying these
   words. Clients older than that release will be refused a new grant, and must
   update.
4. Existing v1 holders are **not** migrated. Their consent stays v1, covers no
   passive sensing, and the settings row tells them the terms changed. Only a
   new, explicit grant records v2.
5. Only after (1) to (4) does the owner's policy decision on `surface`
   (`SENSING_ANON_GRANTED_SCOPES`) have any effect, and then only for
   contributions made under v2 sessions.
