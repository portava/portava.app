# Sensing consents, split (OD-MAP-6) — the words, v1

Status: **DRAFTED by lane L, APPROVED BY THE LEAD IN REVIEW, PENDING LEGAL REVIEW.** Legal review is a
beta-launch sign-off, not an approval the team can give (lead ruling on Q-L20, 2026-10-06;
`docs/ops/lead-rulings-20261006.md`). The server flag `sensing_consent_split_enabled` (migration 3703,
seeded FALSE) stays off until that review signs off, so no person can hold any of these consents yet.

Owner decision OD-MAP-6 (`docs/ops/owner-decisions-20261004.md`): *"Separate consent for on-device capture,
contribution upload, and each secondary use. Make it revocable; don't bundle it with general app consent."*
This replaces the bundled v2 text (`sensing-consent-disclosure-v2.md`), which OD-MAP-6 forbids.

Each consent names, in plain words, **what** is captured or used, **where** it goes, **who** sees it, and
**how to turn it off** — the four things the lead's Q-L20 ruling requires. Each is its own switch in
Settings › Live intel prompts › Area sensing, OFF until the person turns it on.

Source of the words shown in the app: `travel-buddy-standalone/src/lib/sensing/consentSplit.ts`
(this file is a copy for review; the app's file is authoritative, and a change to either must change both).
Versions the server stamps: `artifacts/api-server/src/lib/sensingConsentGrants.ts`
`SENSING_CONSENT_DISCLOSURE_VERSIONS` (pinned equal by `consentSplit.test.ts`).

## 1. On-device capture — `sensing_capture_v1`

**Sense the area around me, on this phone**

- **What.** Your phone works out rough signals from its motion sensors and location: how much you are moving, and which neighbourhood-sized area you are in. Exact positions are not kept, and no sound is recorded.
- **Where it goes.** Everything stays on this phone. Nothing is sent anywhere because of this switch.
- **Who sees it.** Only you, inside the app — for example so Compass can tell which area you are in.
- **How to turn it off.** Turn this off at any time, here. Sensing stops on this phone straight away.

## 2. Upload of contributions — `sensing_upload_v1`

**Send my area signals to improve live information**

- **What.** The rough signals from the switch above — never your exact location, never a recording, never your name or account.
- **Where it goes.** Sent to Portava under a short-lived code that does not identify you, combined with other travellers’ signals, and deleted after a day — three days at the very most.
- **Who sees it.** No one sees your signals on their own. They are only used combined with enough other people’s that no one can be picked out.
- **How to turn it off.** Turn this off at any time, here. This phone stops sending straight away; signals already sent are deleted on their normal schedule.
- **Depends on.** Has an effect only while “Sense the area around me” is on.

## 3. Showing combined results to others (the secondary use) — `sensing_surface_v1`

**Let combined results that include my signals be shown to others**

- **What.** Whether an area looks busy right now, worked out from many travellers’ signals, including yours.
- **Where it goes.** Shown in Portava to other travellers as “people are here” or “not known” — never a number and never who. Portava does not show these results to anyone yet; this records your choice for when it does.
- **Who sees it.** Other travellers using Portava, only ever as that combined result.
- **How to turn it off.** Turn this off at any time, here. Signals sent after that never count toward anything shown to others; ones already sent stop counting when they are deleted, within three days.
- **Depends on.** Has an effect only while both switches above are on.

## Facts the words rest on (checked 2026-10-06)

- Capture runs on the phone (`travel-buddy-standalone/src/services/sensing/sensingCapture.ts`); with upload
  off, every send is dropped before the transport (`installSensingCapture.ts`), and the server issues no
  sensing session without the upload consent (`routes/sensingSession.ts`).
- Uploaded contributions carry a short-lived credential that names no account; the server keeps only its
  HMAC (`lib/sensingContributionSession.ts`). Contributions expire after 24 hours by default and 72 hours at
  most (`lib/sensingAnonStore.ts` `SENSING_DEFAULT_TTL_SECONDS`, `SENSING_MAX_TTL_SECONDS`).
- The policy in force does not grant `surface` (`lib/sensingContributionPolicy.ts`), so nothing is shown
  to others yet; the third consent records the choice for when it is.
