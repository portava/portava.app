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
