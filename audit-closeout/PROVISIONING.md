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

## Stripe Identity in TEST mode — the exact Replit Secrets (sandbox-only guard)
Payment and identity flows are testable end to end with **sandbox** keys only.
`artifacts/api-server/src/lib/paymentsMode.ts` classifies the key by prefix and
refuses every provider call made with a live or unrecognised key **before any
request is sent**. Set these in Replit Secrets (names only here; never paste a
value into the repo). In the Stripe Dashboard, turn **Test mode** on (or use a
Sandbox) before copying anything.

| Secret | Value | Where to get it (Test mode on) |
|---|---|---|
| `IDENTITY_PROVIDER` | the literal `stripe` | not from Stripe |
| `STRIPE_IDENTITY_SECRET_KEY` | `sk_test_…`, or better a restricted `rk_test_…` | Developers → API keys → **Secret key**; or **Create restricted key** with Identity *Verification Sessions and Reports* = Write. Identity must be activated first: Dashboard → Identity. |
| `IDENTITY_WEBHOOK_SECRET` | `whsec_…` | Developers → Webhooks → **Add endpoint**. URL: `https://<deployment-host>/api/verification/webhook`. Events: `identity.verification_session.created`, `identity.verification_session.processing`, `identity.verification_session.requires_input`, `identity.verification_session.verified`, `identity.verification_session.canceled`. Then reveal the endpoint's **Signing secret**. |
| `APP_RETURN_BASE_URL` | optional | not from Stripe. The default is now `travelbuddy://profile/verification` (the app scheme in `travel-buddy-standalone/app.json`). |
| `NODE_ENV` | `production` on the deployment | not from Stripe. The `start` script does not set it. |
| `PAYMENTS_ALLOW_LIVE` | **leave unset** | Only the exact string `true` lets a `sk_live_`/`rk_live_` (or `persona_production_`) key or a `livemode: true` webhook through. Unset, a live key answers `POST /api/verification/session` with 503 `server_not_configured`, reason `payments_live_key_refused` (`payments_unknown_key_refused` for an unrecognised key), and a live event gets 400 `livemode_not_allowed`. |

What the guard does, so a test run can be read correctly:
- The server logs one startup line, `startup: payments/identity provider mode`, with
  `identityProvider`, `keyPresent`, `keyMode` (`test`/`live`/`unknown`/`none`),
  `liveAllowed` and `keyRefused`. It never logs the key. For a sandbox run it must
  show `keyMode: "test"`, `liveAllowed: false`, `keyRefused: false`.
- `GET /api/verification/status` now asks Stripe for a pending session's state (at
  most once per user per 15 s), so a verification completes even if a webhook is
  missed. The webhook is still the primary path.
- Account-deletion redaction with a refused key records a **retriable** failure
  that names the `vs_…` references. It never reports success.
- The unsigned **mock** provider is refused in production, whenever
  `REPLIT_DEPLOYMENT` is set, and in any process without a local-run signal
  (`NODE_ENV=development`/`test`, or `node --test`). Its unsigned webhook also
  needs `IDENTITY_PROVIDER=mock` set explicitly. The hosted deployment therefore
  cannot accept unsigned mock webhooks, even with `NODE_ENV` unset.
- `stripe` is still not in `readiness.IMPLEMENTED_PROVIDERS`. The Rent-a-Buddy KYC
  gate stays closed until a test-mode transcript (session → hosted flow → signed
  webhook → `identity_verifications.status = verified` → `profiles.verification_level`)
  is recorded.

## Payments in TEST mode — the provider seam and its secrets (PAY-T03)
PROV-01 above predates the owner's ruling of 2026-10-04. The ruling replaces its
step 2: the first integration is **Stripe Connect in test mode**, the service
provider is the seller, and the charge is a **direct charge** on the provider's
connected account with the platform's fee as a separate amount, *where Stripe
supports it* (not destination charges). Stripe is not worldwide coverage; each
market is enabled separately.

What exists now is the seam, not the Stripe adapter:
`artifacts/api-server/src/services/payments/` holds the provider contract, a
deterministic fake for local runs, a tax-provider interface, a registry and a
readiness report. **The Stripe adapter is not written yet (PAY-T04).** Until it is
registered, `PAYMENT_PROVIDER=stripe` answers `provider_not_registered` and
payments stay off; setting the variables below early is harmless and lets the
startup line confirm the key is a test key.

| Secret | Value | Notes |
|---|---|---|
| `PAYMENT_PROVIDER` | **leave unset** today (means `none`); `stripe` once PAY-T04 is merged | `fake` works only in a local run — it is refused in production, whenever `REPLIT_DEPLOYMENT` is set, and without `NODE_ENV=development`/`test`. |
| `STRIPE_SECRET_KEY` | `sk_test_…`, or better a restricted `rk_test_…` | Developers → API keys with **Test mode on** (or a Sandbox). A different variable from `STRIPE_IDENTITY_SECRET_KEY`. A standard test secret key can serve both; a restricted key needs the payment and Connect permissions PAY-T04 will list. A `sk_live_`/`rk_live_` key is refused before any request; anything else (`pk_…`, `whsec_…`, upper case, a leading space) is refused as unrecognised and `PAYMENTS_ALLOW_LIVE` does not rescue it. |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` | The signing secret of the **payments** webhook endpoint (a separate endpoint from the identity one, so a separate secret). The route itself is PAY-T19; add the endpoint when it exists. For direct charges the endpoint must listen to **connected accounts'** events. |
| `PAYMENTS_ENABLED_MARKETS` | comma-separated ISO country codes, e.g. `US` | The markets the platform has enabled payments in. Empty (the default) enables none. A market also needs the provider to support it and tax to be configured for it. |
| `TAX_PROVIDER` | **leave unset** (means `none`) | No real tax provider exists yet. With `none`, tax is configured for no market and checkout refuses. `fake` is local-run only. |
| `PAYMENTS_ALLOW_LIVE` | **leave unset** | As above: only the exact string `true` lets a live key or a `livemode: true` event through. |

`STRIPE_CONNECT_CLIENT_ID` (named in PROV-01) is only needed for OAuth onboarding
of existing Stripe accounts; hosted onboarding through account links does not use
it. Do not create it unless PAY-T04 asks for it.

The server logs a second startup line, `startup: payment provider readiness`, with
`paymentProvider`, `operational`, `keyMode`, `keyRefused`, `liveAllowed`,
`taxProvider`, `taxConfigured`, `enabledMarkets` and the first `reason` payments
are not operational. It never logs a key. Today it reads `paymentProvider: "none"`,
`operational: false`.
