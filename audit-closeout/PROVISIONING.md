# Provisioning — PROV-01/02/03 (needs your accounts; code side noted)

These can't be closed purely in code — they need your accounts, secrets, and one
product decision. Ordered easiest → hardest. Paths verified against your code.

## PROV-03 — LiveKit (calling) — ~30 min, NO code
Calling is fully coded (token minting + the signature-verified webhook at
`routes/callsWebhook.ts`). It's inert only because 3 secrets are unset.
1. Create a **LiveKit Cloud** account (livekit.io); free tier is fine.
2. Copy from the project dashboard: **WebSocket URL** (`wss://…`), **API Key**, **API Secret**.
3. Replit → Secrets: `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`.
4. LiveKit dashboard → Webhooks → add `https://<your-server>/api/calls/webhook`.
5. Restart. `livekitEnvStatus()` reports present/missing per key.

## PROV-02 — Identity / KYC — pick a vendor, then I write the adapter
Scaffold is done: provider selection via `IDENTITY_PROVIDER`, the signature-verified
`/api/verification/webhook` route, and the session endpoint all exist. The
`stripe`/`persona` adapters are stubs that throw "not configured".
1. **Pick a vendor:** Stripe Identity (simplest if you also use Stripe for payments)
   or Persona. Recommend Stripe Identity.
2. Create the account, enable Identity, get the API key + webhook signing secret.
3. Replit Secrets: `IDENTITY_PROVIDER=stripe` (or `persona`) + the provider's secret + webhook secret.
4. Register webhook: `https://<your-server>/api/verification/webhook`.
5. **Tell me the vendor and I'll implement the adapter** (`createSession` + `handleWebhook`
   with signature check) in `services/identityVerification/providers.ts`. ~1 day of code, mine to write.

## PROV-01 — Payments — account + one decision, then I scaffold
Least-built: `PricingService` *computes* deposits but nothing charges. No Stripe/
PaymentIntent code, no payment webhook route yet.
1. Create a **Stripe** account; enable **Stripe Connect** (buddies = payees,
   travelers = payers, you take a platform fee).
2. **Decide the money flow** (the part only you can decide): destination charges
   (platform charges traveler → transfers to buddy minus fee) is the standard
   marketplace pattern. Confirm deposit-vs-full timing + your platform fee %.
3. Get: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_CLIENT_ID`.
4. **Then I scaffold the server side:** PaymentIntent at booking, Connect onboarding
   for buddies, transfer/refund on completion/dispute, and a new `/api/payments/webhook`
   route. Multi-day integration + money-handling testing, but mine to build once the
   account + flow are set.

**Summary:** PROV-03 is pure provisioning (do now). PROV-02 and PROV-01 are
provisioning **plus** code I'll write — just tell me the KYC vendor and the payment flow.

## Also (from PROV-07, security hygiene)
Your committed MapTiler publishable key (`travel-buddy/.env*`) is an `EXPO_PUBLIC_`
key (ships in the bundle by design), but: (a) **origin-restrict it** in the MapTiler
dashboard to stop quota theft, and (b) since the literal is in committed files,
**rotate it** and supply the new value via EAS secrets. `.env`/`.env.local` are
already gitignored.
