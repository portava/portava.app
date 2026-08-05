# Portava Privacy Policy — Draft

Suggested repo location: `docs/compliance/privacy-policy-draft.md`
Status: DRAFT for review. Have a lawyer review before publishing —
especially the GDPR/CCPA sections and anything jurisdiction-specific.
This draft is written to match what the code actually does as of the
Verified Foundation V-0 and E2EE E-2 implementations; if features
change, change this.

---

## TODO — fields the owner must fill before publishing

| Placeholder | What goes there |
|---|---|
| `[COMPANY LEGAL NAME]` | The registered legal entity that operates Portava (e.g. "Portava Inc."), as it appears on incorporation documents. |
| `[PRIVACY EMAIL]` | A monitored email address for privacy requests (e.g. privacy@...); required for GDPR/CCPA rights requests. |
| `[ADDRESS]` | The company's registered mailing address (required in most jurisdictions for a privacy contact). |
| `[DATE]` | The "Last updated" date — set to the day this policy is published. |
| `[PROVIDER NAME]` | The identity-verification vendor (Stripe Identity vs Persona — decision pending, Phase V-6). |
| `[LINK]` | URL of that verification vendor's own privacy policy. |

Every `[BRACKETED]` placeholder below must be replaced before this
document goes live. Search the file for `[` to confirm none remain.

---

**Last updated: [DATE]**

Portava ("we", "us") is a social travel platform. This policy explains
what we collect, why, and the choices you have.

## The short version

- Messages in encrypted threads are end-to-end encrypted. **We cannot
  read them.** We store only ciphertext and delivery metadata.
- Identity verification is handled by a specialist provider. **We never
  store your ID document, document number, photos of your ID, your
  selfie, or your date of birth.** We store only the outcome: whether
  you're verified, whether you're over 18, and the country of your
  document.
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

**Identity verification.** When you choose to get verified, the
document and selfie capture happens with our verification provider
[PROVIDER NAME], under their privacy policy [LINK]. They tell us the
outcome. We store: verification level, an over-18 true/false, the
document's country, timestamps, and an opaque reference number in the
provider's system. We do not receive or store the document itself, its
number, your photo, or your birth date.

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

- **Verification provider** ([PROVIDER NAME]) — to perform the check
  you initiate.
- **Infrastructure providers** — they process data to provide the
  service to us, under contracts: Supabase (hosting, database,
  authentication, and file storage), Sentry (crash reporting), LiveKit
  (voice and video calls), Expo (push notification delivery),
  Foursquare (place data for nearby-places features), and MapTiler
  (map tiles).
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

Portava is not for users under 18 [or: under 16 with 18+ features
gated — CHOOSE ONE with counsel; the current product gates 18+
features by verified age]. We remove accounts we identify as underage;
report them via the in-app report flow.

## Changes

We'll notify you in-app of material changes and update the date above.

## Contact

[COMPANY LEGAL NAME] · [ADDRESS] · [PRIVACY EMAIL]

---

### Reviewer notes (delete before publishing)

- [PROVIDER NAME]/[LINK] blocks resolve when the Stripe-vs-Persona
  decision lands (Phase V-6).
- The "not for under 18 vs 16+" decision needs a call with counsel —
  it changes the children's-privacy exposure (COPPA/GDPR-K) and both
  stores' age answers. The current codebase gates 18+ features but
  does not block <18 registration; align the policy with whichever
  the product actually enforces.
- If Compass Live / background location ships, add a dedicated
  background-location section before release.
- If Rent-a-Buddy payments ship, add a payments/financial-data section.
