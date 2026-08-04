# Portava Privacy Policy — Draft

Suggested repo location: `docs/compliance/privacy-policy-draft.md`
Status: DRAFT for review. Have a lawyer review before publishing —
especially the GDPR/CCPA sections and anything jurisdiction-specific.
This draft is written to match what the code actually does as of the
Verified Foundation V-0 and E2EE E-2 implementations; if features
change, change this.

---

**Last updated: 4 August 2026**
<!-- Reset this to the actual publication date when the policy goes live. -->

Portava ("we", "us") is a social travel platform. This policy explains
what we collect, why, and the choices you have.

## The short version

- Messages in encrypted threads are end-to-end encrypted. **We cannot
  read them.** We store only ciphertext and delivery metadata.
- If and when you choose to get verified, the ID check is carried out
  by a specialist verification provider, not by us. **We never store
  your ID document, document number, photos of your ID, your selfie,
  or your date of birth.** We store only the outcome: whether you're
  verified, whether you're over 18, and the country of your document.
- We use your location to power travel features you use — nearby
  places, events, travelers, and safety check-ins you start. We don't
  sell it. We don't show your precise location to other users.
- No ads. No selling your data. No tracking you across other apps.

## What we collect

**Account basics.** Name or display name, email, password (hashed) or
your Apple/Google sign-in identity, profile photo, and the travel
profile you build (interests, travel style, languages).

**Content you create.** Posts, photos, reviews, event RSVPs, trips,
Hidden Gems contributions, and messages.

**Messages.** Telegraph messages in end-to-end encrypted threads are
encrypted on your device before they reach us; we store the encrypted
form and the metadata needed to deliver it (who sent it, to which
conversation, when, and delivery/read state). We cannot decrypt the
content. Older conversations created before encryption launched, and
certain thread types noted in-app, are not end-to-end encrypted; those
are protected in transit and at rest but are readable by our systems
for delivery and safety features like translation.

**Location.** Approximate (city-level) location powers discovery
surfaces. Precise location is used only while you're using location
features (maps, check-ins, Safe Return) and is shown to other users
only as approximate proximity — never exact coordinates.

**Identity verification.** Identity verification is an optional
feature. Where it is offered, the document and selfie capture happens
with a specialist verification provider under that provider's own
privacy policy — we identify the provider in-app before you begin, and
you can decline. The provider tells us only the outcome. We store:
verification level, an over-18 true/false, the document's country,
timestamps, and an opaque reference number in the provider's system.
We do not receive or store the document itself, its number, your
photo, or your birth date.

**Device and usage data.** Device type, app version, crash reports,
and interaction events (what features are used) to keep the app
working and improve it. Push notification tokens to deliver
notifications; in encrypted threads, notification content is generated
on your device, not by our servers.

## What we use it for

Running the product (matching you with places, events, and travelers;
delivering messages; showing badges), safety (verification, report
handling, blocking, Trust Score), and improving Portava (aggregate
analytics). Legal bases where GDPR applies: contract performance for
core features, legitimate interest for safety and abuse prevention,
consent for optional features like precise location and verification.

## What we share

- **Verification provider** — where identity verification is offered,
  to perform a check you choose to initiate.
- **Infrastructure providers** — hosting, storage, push delivery
  (they process data to provide the service to us, under contracts).
- **Other users** — what you choose to make visible per your privacy
  settings (public posts, profile, approximate presence).
- **Legal** — if required by valid legal process. For end-to-end
  encrypted content we can only ever produce ciphertext and metadata,
  because that is all we possess.
- We do **not** sell personal data and do **not** share it for
  cross-app advertising.

## Retention and deletion

- Delete your account in Settings → Account → Delete. This removes
  your profile, content, verification records (and instructs the
  verification provider to redact theirs), and message ciphertext,
  subject to short backup cycles and legal holds.
- Failed or expired verification attempts are purged automatically
  after 90 days.
- Reports you file, and moderation records about enforcement actions,
  are retained for platform safety even after related content is
  removed, with personal identifiers minimized where possible.

## Your rights

Depending on where you live (GDPR, UK GDPR, CCPA and similar): access,
correction, deletion, portability, objection, and complaint to your
supervisory authority. Exercise them in-app or at [PRIVACY EMAIL].
We respond within the legally required window.

## Encryption honesty

End-to-end encryption protects message content from us and from anyone
who compromises our servers. It does not hide who you message or when
(we need that to deliver), and it cannot protect a device that is
itself compromised or a screenshot taken by someone you message. Safety
numbers in Telegraph let you verify your connection; if someone's
safety number changes, verify before sharing anything sensitive.

## Children

Portava is not for users under 16. Individual experiences on Portava —
such as meetups and trusted circles — can set their own minimum and
maximum age, which we enforce against the date of birth on your
profile. We remove accounts we identify as under 16; report them via
the in-app report flow.

## Changes

We'll notify you in-app of material changes and update the date above.

## Contact

[COMPANY LEGAL NAME] · [ADDRESS] · [PRIVACY EMAIL]

---

### Reviewer notes (delete before publishing)

- RESOLVED (owner decision): the identity-verification wording is now
  conditional and names no provider, so the policy is truthful while
  services/identityVerification/ still ships only mockProvider (the
  Stripe and Persona adapters are stubs and the factory refuses to run
  the mock in production — i.e. there is NO working KYC in production
  today). Name the provider here once Stripe-vs-Persona lands
  (Phase V-6 / audit P1 item 8).
- RESOLVED (owner decision): minimum age is 16, with age-restricted
  features gated by age. NOTE — the audit's "gates 18+ features by
  verified age" shorthand overstates what the code does. Verified
  against the tree: lib/ageEligibility.ts is consumed only by
  routes/meetups.ts, routes/requests.ts (circle requests) and
  routes/circleAgeSettings.ts, where min_age/max_age are
  HOST-CONFIGURABLE per meetup/circle. There is no platform-wide 18+
  gate, and routes/rentABuddy.ts has NO age check at all. The wording
  above was written to match that reality — do not restore any claim
  that Rent-a-Buddy is 18+ gated until it actually is.
- STILL OPEN: routes/auth.ts signup validates only email + password —
  no date of birth is collected or checked, so under-16 registration
  is not blocked and age gates fall back to "dob_missing" for users
  who never set one. Collect DOB at signup before publishing, or the
  16+ statement above is aspirational rather than enforced.
- ⚠ BLOCKING DISCREPANCY — "Retention and deletion" promises that
  deleting your account removes profile, content, verification records
  and message ciphertext. Per the production audit (P1 item 7) account
  deletion is manual-admin-only: there is no scheduled worker acting on
  user_deletion_requests.scheduled_at, deletion does not cascade to
  posts/media/message ciphertext/verification rows, and auth.admin
  .deleteUser is never called, so the email address persists
  indefinitely. Either ship the cascading deletion worker before
  publishing, or soften this section. Do not publish as-is — this is
  the claim most likely to be relied on by Play Data Safety, Apple, and
  a GDPR erasure request.
- STILL REQUIRED before publishing: [COMPANY LEGAL NAME], [ADDRESS],
  [PRIVACY EMAIL] (appears twice: "Your rights" and "Contact"). These
  are legal-entity facts and were deliberately NOT guessed.
- If Compass Live / background location ships, add a dedicated
  background-location section before release.
- If Rent-a-Buddy payments ship, add a payments/financial-data section.
