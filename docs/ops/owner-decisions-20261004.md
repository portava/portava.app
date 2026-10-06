# Owner decisions of 2026-10-04 and 2026-10-05 — the verbatim record

**Documentation only.** Nothing was applied, flipped, deployed or merged in
producing this file. It records what the owner said, in the owner's words, with
the time each message was received (UTC). It grades nothing.

**An answer authorises work; it moves no verdict.** No census row changes on
the strength of an entry here. Each row still needs its own acceptance evidence,
measured after the change lands.

## Why this file exists

On 2026-10-04 the owner answered 46 open product questions in one message. A
check on 2026-10-05 found that only the payments answers (in
`docs/architecture/payments-reconciliation-20261004.md` section 2) and four later
Discovery answers (in `docs/architecture/discovery-decision-register.md`, section
`OWNER-1004`) had been written into the repository. The remaining answers —
Trips, Input Intelligence, Map and Sensing, and Trust, Compass, Passport and
Wall — were recorded nowhere, on `main` or on any open branch, and work that was
waiting on them still read as "blocked on an owner decision".

This file is the record of those answers. Where an answer is also recorded in a
register that owns its question, that register stays authoritative for the
analysis around it; this file is authoritative for the owner's words.

Identifiers (`OD-PAY-1` and so on) are assigned here, in the order the owner
gave the answers, so that other documents can refer to one answer.

## Part 1 — the 46 answers, received 2026-10-04 08:32 UTC

### Payments and creator economy

**OD-PAY-1 — Processor.**

> Use Stripe Connect in test mode as the first integration, behind a payment-provider interface. Don’t treat Stripe as worldwide coverage: Connect availability and payout routes vary by country. Enable real payments only in supported markets after the relevant account, tax, and legal setup is complete. [Stripe global availability](https://stripe.com/global) [Stripe Connect](https://stripe.com/connect/features)

**OD-PAY-2 — Merchant and payment losses.**

> Make the service provider the seller for their service and, where supported, use a direct-charge model. The platform remains responsible for its own marketplace, safety, and legal obligations. The payment setup can affect who Stripe charges for fees, refunds, and disputes; it does not by itself settle the legal merchant-of-record question in every country. [Stripe Connect pricing and responsibilities](https://stripe.com/en-ca/connect/pricing) [Stripe charge models](https://docs.stripe.com/connect/separate-charges-and-transfers)

**OD-PAY-3 — Fees, tips, and deposits.**

> Start with a 10% platform commission on the pre-tax service price, shown before checkout. Charge no platform commission on tips. Don’t add a deposit in the first release; revisit it only with a defined reason and refund terms. These are recommended starting prices, not a universal industry standard; keep them configurable by product and market.

**OD-PAY-4 — Payout schedule.**

> Pay creators monthly, after earnings are finalized, services are completed, and required verification is complete. Carry small balances forward to a locally appropriate minimum. A monthly cycle is a familiar creator-payment pattern; YouTube, for example, finalizes earnings early in the following month and generally issues payment later that month once its threshold is met. [YouTube payment process](https://support.google.com/youtube/answer/14728151)

**OD-PAY-5 — Refunds.**

> Refund in full when the provider cancels, the service is unavailable, or a safety issue is upheld. Give a full refund for cancellations before service begins; handle cancellations after it begins through support and applicable local rules. Don’t promise that fees or deposits are non-refundable.

**OD-PAY-6 — Currencies.**

> Use the customer’s local currency when the processor supports it. Store the original transaction currency and amount, plus any conversion details; don’t assume one currency or payout method works globally. Stripe’s supported currencies depend on the account country and payment method. [Stripe supported currencies](https://docs.stripe.com/currencies)

**OD-PAY-7 — Tax.**

> Calculate, collect, report, and remit taxes where the platform is legally required to do so; providers handle their own income taxes. Add a tax-provider interface and configure each launch country before enabling checkout. Stripe Tax supports many jurisdictions, but it is not a substitute for determining where the platform must register or file. [Stripe Tax](https://docs.stripe.com/tax/faq)

**OD-PAY-8 — Creator-ledger erasure.**

> Pseudonymize accounting entries, removing direct identifiers and the identity link when deletion is requested. Keep only the records needed for tax, accounting, disputes, or legal claims, with a defined retention period and access controls. GDPR, for example, permits exceptions to erasure where processing is needed to meet a legal obligation or establish or defend legal claims. [GDPR Article 17](https://eur-lex.europa.eu/eli/reg/2016/679/oj)

**OD-PAY-9 — Conflicting requirements.**

> Treat the latest owner-approved product or payment specification as authoritative. Censuses are implementation audits, not requirements. Reconcile the seven conflicts against the approved documents; leave any conflict without an owner-approved answer marked unresolved.

**OD-PAY-10 — Identity requirement for Rent-a-Buddy.**

> No unverified bookings. Require identity and payment-provider verification before someone can offer or book the service. Sumsub is my pick for the primary identity provider because it documents support for 220+ countries and territories, but that is not literally universal; check coverage for each market and keep the feature unavailable where valid verification cannot be provided. [Sumsub supported documents and countries](https://docs.sumsub.com/docs/supported-documents-and-countries)

**OD-PAY-11 — Launch flags.**

> Yes to intended tester features after their migrations and deployment are verified. Keep safety controls on, and keep payments in test mode until payment, identity, and tax readiness are established.

### Trips

**OD-TRIP-1 — Appeal restoration.**

> If an appeal succeeds, restore the access and permissions removed by that decision. Don’t recreate missed live activity or location sharing; if a trip has ended, restore access to its retained record only.

**OD-TRIP-2 — Routes API.**

> Yes, for a bounded rollout if routing is a core trip feature. Put calls behind a server-side provider interface, set daily quotas and a hard budget, and fall back gracefully when the limit is reached. Google bills by request or route-matrix element and provides quota limits for cost control. [Google Routes billing and quotas](https://developers.google.com/maps/documentation/routes/usage-and-billing)

**OD-TRIP-3 — Private anchors.**

> Owner-only by default. The owner can share an individual anchor with selected trip members; trip membership or organizer status alone does not grant access.

**OD-TRIP-4 — Snapshots.**

> Keep operational snapshots while a trip is active, then delete them after 30 days unless the user explicitly saves them. Keep a separate, minimized audit record only as long as necessary.

**OD-TRIP-5 — Offline maps.**

> Don’t use Google tiles for offline downloads; Google’s tile policies restrict offline use. Use MapTiler’s offline-pack capability as the initial provider choice, subject to confirming that the selected plan licenses Portava’s intended use and regions. [Google tile policies](https://developers.google.com/maps/documentation/tile/policies) [MapTiler offline packs](https://docs.maptiler.com/mobile-sdk/android/examples/offline-get-started/)

**OD-TRIP-6 — Bluetooth proximity and relay.**

> Off by default and opt-in per trip. Require each participant’s consent, show when it is active, use short-lived rotating identifiers, and don’t relay or retain precise location in the background.

**OD-TRIP-7 — Trip-less route plans.**

> Yes. Allow private route planning without creating or joining a trip. Don’t publish a route or share location unless the user explicitly does so.

**OD-TRIP-8 — Migrations 2797–2799.**

> Approved in principle, subject to the normal database-state check, rehearsal, and recoverable backup before any hosted application. This approval does not authorize skipping those safeguards.

### Discovery

**OD-DISC-1 — Trails and Trending.**

> Yes, they’re in scope as user-facing features as well as APIs. Build the screens and flows; keep any feature that depends on unresolved decisions or migrations gated.

**OD-DISC-2 — Central ranking flag.**

> Yes, with a shadow run and limited tester rollout before broad activation.

**OD-DISC-3 — Approval-request items 9, 11, 12, 15, 16, 19, 20, and 21.**

> The pasted note gives only item numbers, not their questions. I can’t make informed decisions on those without the request text. Keep only the work those items block paused; item 22’s creator-and-money decisions are addressed above.

### Input Intelligence

**OD-INPUT-1 — Downstream-outcome telemetry.**

> Explicit opt-in, off by default, purpose-limited, and separated from core assistance.

**OD-INPUT-2 — Per-user outcome counters.**

> Retain for 30 days, then delete or irreversibly aggregate.

**OD-INPUT-3 — Compass memory.**

> Don’t use it for input assistance by default. Add it only through a separate, clear opt-in with a way to inspect and revoke it.

**OD-INPUT-4 — Buddy payment eligibility.**

> Allow only adults who pass identity verification, provider onboarding, and safety checks, in supported markets. No payments for minors.

**OD-INPUT-5 — Speech recognition.**

> Use on-device operating-system speech recognition first. Send audio to a cloud provider only with separate, explicit consent; don’t retain raw audio by default.

**OD-INPUT-6 — Paid typeahead provider.**

> No for the initial release. Add a provider only if measured quality or latency needs justify its cost.

**OD-INPUT-7 — Latency ceiling.**

> Target p95 under 500 ms for suggestions. Show local suggestions immediately while slower results load.

**OD-INPUT-8 — Privacy-incident certification.**

> Require sign-off from a designated privacy lead and security lead, independent of the feature team; use a qualified local privacy officer where required.

### Map and Sensing

**OD-MAP-1 — Map telemetry.**

> No precise-location analytics by default. Offer separate opt-in for coarse, aggregated route-flow contributions, with a clear opt-out.

**OD-MAP-2 — Route-flow consent.**

> Say what route data is contributed, who can use it, how long it is kept, and how to stop contributing. Don’t call data “anonymous” if it remains linkable to a person.

**OD-MAP-3 — Protected zones.**

> Let users designate places such as home, work, or school; don’t infer sensitive places from movement history. Suppress precise location and route contributions inside those zones by default.

**OD-MAP-4 — Audit retention after account deletion.**

> Keep a pseudonymized, access-restricted audit record for up to 12 months, then delete it, unless a specific local legal obligation requires a different period.

**OD-MAP-5 — Bluetooth on the map.**

> Use the same opt-in, per-trip, short-lived, no-background-relay rule as Trips.

**OD-MAP-6 — Sensing consent v2.**

> Separate consent for on-device capture, contribution upload, and each secondary use. Make it revocable; don’t bundle it with general app consent.

**OD-MAP-7 — Contribution retention.**

> 180 days maximum for pseudonymous contributions, as the report suggests; delete or aggregate afterward. Delete raw source material sooner.

### Trust, Compass, Passport, and Wall

**OD-TRUST-1 — Migration 2870.**

> Yes, after migration-state and recovery checks.

**OD-TRUST-2 — Identity provider.**

> Sumsub, behind a provider interface and with per-country availability checks. It supports many countries, but no single provider should be represented as universal.

**OD-TRUST-3 — Verified badge.**

> Yes, for a defined, current verification state only. Make criteria visible; don’t sell the badge or present it as an endorsement.

**OD-TRUST-4 — Suspension experience.**

> Show the user what is restricted, the reason at an appropriate level of detail, duration or review timing, and a clear appeal path. Keep reports and reporter details private. Restore access promptly when an appeal overturns the decision.

**OD-TRUST-5 — Reach of Trust restrictions.**

> Enforce restrictions on the server across all relevant APIs and surfaces; hiding controls in the interface is not enough. Limit each restriction to the actions and duration needed, and preserve access to appeals and permitted data exports.

**OD-TRUST-6 — Google Routes spend.**

> Same decision as Trips: yes, with quotas, a hard budget, and a gradual rollout.

**OD-TRUST-7 — Passport stamps.**

> Treat stamps as earned, factual achievements, not identity checks or broad trust guarantees. Use clear criteria such as “Completed first trip” or “Community contributor”; show why and when each was earned.

**OD-TRUST-8 — Wall speech and audio consent.**

> On-device recognition by default. Use push-to-talk; ask separately before any audio leaves the device, and don’t retain raw audio by default.

**OD-TRUST-9 — Safety Center and policy pages.**

> Approve the product direction: clear reporting, blocking, support, restriction explanations, and appeals. Keep final jurisdiction-specific legal wording tied to the actual policies and operating markets.

## Part 2 — later answers and standing instructions

### Received 2026-10-04 08:41 UTC — Discovery questions 11(a), 12, 15, 16, and migration 3512

> Set Q11(a) raw behavioural-row retention to 30 days, then delete the identifiable raw rows; retain only irreversibly aggregated data where needed. Treat 30 days as the proposed product default pending the required legal review.
>
> Close Q12 with the threshold of at least 15 travellers and suppress contributions inside protected zones. Keep Q15 dwell-time publishing off until the privacy notice is written and approved. Answer Q16 “no” for all three people-derived-data uses.
>
> Start code-only work to promote migration 3512 to a reviewable PR and wire pseudonymisation into AccountDeletionService, with regression tests. Do not apply the migration to the hosted database, deploy it, or enable collection until legal review confirms Q11(a). Also run the read-only census-integrity check against f71cfb85f and update the README only from its verified result.

The four Discovery answers are analysed, with their conditions, in
`docs/architecture/discovery-decision-register.md` (section `OWNER-1004`). Two of
them are conditional: 11(a) is a proposed default pending legal review, and 15
is a refusal until a privacy notice is written and approved.

### Received 2026-10-04 12:05 UTC — how to measure, and what must not be activated

> Treat this re-measurement as a census-status report, not a fresh code audit. Keep Phase 6 out of scope; do not adopt the scope amendment.
> Before reporting a current completion percentage:
>
> * Re-census the merged surfaces against code, starting with the 17 merged PRs listed here.
> * Resolve the Discovery discrepancy: verify whether the 163 prose “requirements” are real requirements or a misread file-count sentence. Don’t include them in the denominator without validating them individually.
> * Reconcile payment requirements against the code inventory and approved product documents; don’t use the stale “everything is unbuilt” statement as current status.
> * Update the deployment record only from evidence of the actual running build. No flags, hosted migrations, or feature activation until the runtime and production/test separation are established.
>
> Keep migration 3512 and AccountDeletionService work reviewable in code, but don’t apply or release it before the required retention review. Report verified code, deployment, migration, and flag state separately.

### Received 2026-10-04 15:52 UTC — Buddy commission level, fee-rule version, creator-ledger retention

> Owner decisions:
>
> * Seed the `standard` Buddy level at the approved flat 10% commission so its fee routes work.
> * Change `RENT_BUDDY_FEE_RULE_VERSION` to `/v2`. Preserve `/v1` for historical records and calculations.
> * C-11 / question 22(a): retain creator-ledger entries pseudonymized for seven years after fiscal year-end. Jurisdiction-specific legal retention periods override this default. Record the owner decision as B; legal confirmation is still required before PR #592 is merged or applied.
>
> For #612 and #616, 11/11 checks is not full certification when the live-database tier is absent. Do not merge or apply migration 3520 until the required database checks run against a verified, recoverable environment. Keep deployment and real payments off.

### Received 2026-10-04 20:41 UTC — a buddy's price must not rank them

> On PR #596, implement the owner ruling: a buddy’s list price must not influence `calculateCompatibilityScore` or the default ordering in `/rent-a-buddy/match`. Keep price visible. Any existing traveller-selected price filter or sort must stay separate from the compatibility score; don’t add new price controls as part of this fix.
> 
> Remove the K3 exception and update the regression tests to prove that changing only a buddy’s list price does not change their compatibility score or default rank. Work only on #596’s branch. Preserve unrelated changes, run the relevant checks, push the updated head, and wait for CI, Unwired, and live DB results. Do not merge the PR or manually apply migrations. Report the head SHA and each workflow result.

This ruling is implemented and merged (pull request 596).

### Received 2026-10-05 18:12 UTC — decisions restated in the mission instruction

The owner's mission instruction of 2026-10-05 restated these decisions and added
conditions to some of them. Verbatim:

> * First-release Rent-a-Buddy bookings require real identity verification. No tester bypass or sandbox verification key. Keep booking paths fail-closed.
> * The first release has no deposit. Use the approved 10% commission; remove inconsistent level-based rates or hard-coded deposit behavior. Support regional rules without pretending one configuration works everywhere.
> * C-11 uses pseudonymized creator-ledger retention (answer B). The statutory retention period remains subject to legal review; do not invent legal approval or erase records early.
> * Q11(a): retain identifiable raw behavioral rows for 30 days, then delete them; retain only irreversibly aggregated data, pending legal review.
> * Q12: require at least 15 travellers and suppress contributions in protected zones. Verify the implementation in code rather than assuming an existing list enforces it.
> * Q15 remains off until its privacy notice is approved. Q16 is “no” on all three parts.
> * Phase 6 remains descoped unless its scope amendment was explicitly approved. Do not quietly reopen it.
> * Honor the recorded approval for the identity-verification badge and beta launch flags only in a properly isolated beta environment.

And, on what may not be assumed:

> Where the register contains an owner decision but implementation details are incomplete, follow that decision. For legal, tax, provider-coverage, production, or scope questions that were not actually decided, do not fabricate an answer: keep the affected path safely gated, continue independent work, and report the exact decision needed with a recommendation and impact.

## Part 3 — what these answers do NOT decide

Recorded so that nobody reads a decision into silence. Each of these is open.

- **Discovery approval-request items 9, 19, 20 and 21, and parts 11(b) and 11(c).**
  The owner's answer OD-DISC-3 says the request text was not available when the
  46 answers were written; only 11(a), 12, 15 and 16 were answered afterwards.
- **The legal review of raw behavioural-row retention.** 30 days (question 11(a))
  is a proposed default until that review happens.
- **Legal confirmation of the creator-ledger retention period.** Seven years
  after fiscal year-end, with jurisdiction-specific periods overriding, is the
  owner's default (answer B); the owner states that legal confirmation is still
  required before the change that implements it is merged or applied.
- **Whether the `standard` Buddy level also carries a traveller service fee.** The
  owner set its commission at the flat 10%; the service fee was not addressed.
- **How "suppress contributions inside protected zones" is implemented on the
  contribution side** of the trend producers (question 12). The output side is
  built; the mechanism for the input side has not been chosen.
- **The licence for offline map packs.** OD-TRIP-5 names MapTiler as the initial
  provider choice "subject to confirming that the selected plan licenses
  Portava's intended use and regions". That confirmation has not been recorded.
- **Per-country provider coverage** for payments and identity. OD-PAY-1 and
  OD-PAY-10 both say coverage is not universal and must be checked per market.
- **An isolated beta environment.** The owner approves tester features and launch
  flags only after migrations and deployment are verified, and (2026-10-05) only
  in a properly isolated beta environment. No such environment is recorded.
- **Phase 6.** Out of scope; the scope amendment was explicitly not adopted
  (2026-10-04 12:05 UTC, restated 2026-10-05).
