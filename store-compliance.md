# Portava — Store Compliance Pack

Suggested repo location: `docs/compliance/store-compliance.md`

Covers the three disclosure surfaces Portava's feature set triggers:
Google Play **Data Safety**, Apple **Privacy Nutrition Labels**, and
**encryption export compliance**. Drafted against the current feature
set: E2EE messaging (MLS), government-ID verification via third-party
provider (provider-agnostic; no raw ID data stored), live location
features, social graph, push notifications.

Update this doc whenever a feature changes what data is collected —
store answers must match reality or the app gets pulled.

---

## 1. Encryption export compliance (both stores, blocks submission)

Portava uses **non-exempt cryptography**: MLS (RFC 9420) with
X25519/AES-128-GCM/Ed25519 for user messaging. This is more than the
"standard HTTPS only" exemption.

**Apple App Store:**
- `ITSAppUsesNonExemptEncryption` = **true** in Info.plist / app.json
  (`ios.config.usesNonExemptEncryption: true`).
- App Store Connect will ask the export compliance questions each
  submission. Answers: uses encryption → YES; qualifies for exemption →
  NO (proprietary-to-app E2EE is not the (b)(1) exemption); French
  declaration → required if distributing in France.
- **US BIS self-classification:** mass-market software using standard
  crypto (which OpenMLS is) self-classifies as **5D992.c** under
  License Exception ENC §740.17(b)(1). File the annual
  **self-classification report** to BIS + NSA (email submission,
  template on bis.gov). Do this once before first App Store release,
  then annually each February.
- Keep a copy of the self-classification email in this folder.

**Google Play:** no separate export form, but the same US export rules
apply to distribution. The BIS self-classification above covers both.

---

## 2. Google Play — Data Safety form answers

Section: **Data collection and security**
- Does your app collect or share user data? **Yes**
- Is all user data encrypted in transit? **Yes**
- Do you provide a way for users to request data deletion? **Yes**
  (account deletion flow; verification data deleted via provider
  redaction + row deletion)

**Data types collected** (mark Collected; none are Shared with third
parties for advertising — Portava has no ads):

| Play category | What it maps to | Purpose | Optional? |
|---|---|---|---|
| Personal info → Name | Display name | App functionality | Required |
| Personal info → Email | Account email | App functionality, account mgmt | Required |
| Personal info → User IDs | Account/user id | App functionality | Required |
| Personal info → Other | Verification level (boolean tier only) | Fraud prevention, safety | Optional |
| Location → Approximate location | City-level presence, Pulse/Discovery | App functionality | Optional |
| Location → Precise location | Map features, Safe Return check-ins (only while using) | App functionality, safety | Optional |
| Photos and videos → Photos | Profile photo, posts, message media | App functionality | Optional |
| Messages → Other in-app messages | Telegraph messages. **State in the free-text: message content in E2EE threads is end-to-end encrypted; the server stores ciphertext it cannot read.** | App functionality | Optional |
| App activity → App interactions | Posts, saves, attendance, trust events | App functionality, analytics | Optional |
| Contacts | **NOT collected** (do not enable contact sync without updating this) | — | — |
| Financial info | Only if/when Rent-a-Buddy payments launch via a processor; revisit then | — | — |

**Government ID / verification — the tricky one:**
- Play category: Personal info → "Other info". Declare: the app
  initiates identity verification through a third-party provider;
  **the ID document images, document numbers, and date of birth are
  collected and processed by the provider, not by Portava**; Portava
  stores only the verification outcome (verified level, over-18
  boolean, document country) and an opaque provider reference.
- When a real provider is chosen (Stripe Identity / Persona), list it
  as a data-sharing recipient for identity data in the provider's own
  capacity, and link their privacy policy in ours.

**Data deletion:** account deletion removes profile, messages
(ciphertext), verification rows, and triggers provider-side redaction.
Retention: failed/expired verification rows purged at 90 days.

---

## 3. Apple — Privacy Nutrition Labels

**Data Linked to You:**
- Contact Info: Name, Email Address
- User Content: Photos or Videos, Messages (annotate in review notes:
  E2EE — Apple's label still requires declaring Messages as collected
  because ciphertext + metadata transit our servers), Other User Content
  (posts, reviews)
- Identifiers: User ID
- Location: Precise Location, Coarse Location
- Usage Data: Product Interaction
- Sensitive Info: **only if** the chosen verification provider's SDK
  runs in-app (Persona SDK captures ID/selfie in-app → declare; a fully
  hosted web flow like Stripe Identity's redirect → the capture happens
  in the provider's context, still safest to declare Sensitive Info
  with the review-notes explanation that Portava never receives the
  raw data)

**Data Not Collected:** Browsing History, Search History (outside app),
Financial Info (until payments), Health & Fitness, Contacts.

**Tracking (ATT):** Portava does **not** track users across other
companies' apps/websites and shows no ads → "Data Not Used to Track
You"; no App Tracking Transparency prompt needed. Keep it that way —
adding any ad SDK flips this entire section.

**Review notes to attach on submission:** one paragraph explaining
(a) E2EE: message content unreadable by Portava, (b) identity
verification handled by [provider], Portava stores outcome booleans
only, (c) location used for travel features and user-initiated safety
check-ins, never sold.

---

## 4. Permission strings (iOS Info.plist — must match reality)

- NSLocationWhenInUseUsageDescription: "Portava uses your location to
  show nearby places, events, and travelers, and for Safe Return
  check-ins you start."
- NSCameraUsageDescription: "Take photos for your posts, profile, and
  identity verification."
- NSPhotoLibraryUsageDescription: "Choose photos for your posts and
  profile."
- NSMicrophoneUsageDescription: "Record voice messages and make calls."
- NSFaceIDUsageDescription (if biometric unlock added later): "Unlock
  Portava and protect your encrypted messages."

Android equivalents: fine-grained location, camera, record audio, media
read — declare in the Play console's permissions declaration if any
sensitive permission (background location especially) is ever added.
**Background location** (Compass Live / Safe Return continuous
tracking, future phases) requires a Play policy declaration + video
demo — plan for review friction before shipping that phase.

---

## 5. Age rating & policy landmines

- Content rating questionnaires: social features with user-generated
  content + user communication → expect Teen (Play) / 12+ or 17+
  (Apple) depending on answers about alcohol references (nightlife
  features) and unrestricted web/user content. Answer honestly;
  nightlife discovery likely pushes 17+/Mature-adjacent on Apple.
- 18+ features (Rent a Buddy, nightlife gating) are gated by verified
  over-18 status — say so in review notes; it materially helps.
- UGC policy (both stores): requires report + block + moderation.
  Phases V-3/V-4 are the compliance implementation; both stores ask
  for these mechanisms explicitly for social apps.

---

## 6. Pre-submission checklist

- [ ] `usesNonExemptEncryption: true` set in app config
- [ ] BIS self-classification report filed; copy saved to docs/compliance/
- [ ] Play Data Safety form filled per §2
- [ ] Apple privacy labels per §3 + review notes attached
- [ ] Permission strings in place per §4
- [ ] Privacy policy URL live and matching all of the above
- [ ] Report/Block (V-3) and moderation (V-4) shipped — UGC policy
      requirement, not optional
- [ ] Account deletion flow works end-to-end (both stores require
      in-app account deletion for apps with account creation)
