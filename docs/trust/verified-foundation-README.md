# Portava Verified Foundation — Drop-in Files

Provider-agnostic identity verification foundation. Built to run fully on a
mock provider today; Stripe Identity or Persona becomes a config swap later.

## Drop map

| File | Drop at |
|---|---|
| `verified-foundation-plan.md` | `docs/trust/verified-foundation-plan.md` |
| `0161_identity_verification.sql` | `travel-buddy-standalone/db/0161_identity_verification.sql` (renumber to match your next migration number) |
| `identityVerification.types.ts` | `travel-buddy-standalone/server/services/identityVerification/types.ts` |
| `identityVerification.mockProvider.ts` | `travel-buddy-standalone/server/services/identityVerification/mockProvider.ts` |
| `identityVerification.providers.ts` | `travel-buddy-standalone/server/services/identityVerification/providers.ts` |
| `VerifiedBadge.tsx` | `travel-buddy-standalone/src/components/VerifiedBadge.tsx` |

Create the `server/services/identityVerification/` folder first.

## What runs today vs later

**Runs today (no provider account needed):**
- Full DB schema for verifications, moderation reports, moderation actions
- The provider adapter interface + normalized status model
- A working `MockVerificationProvider` — auto-approves after a delay in dev,
  supports forced-failure via test hints, so the entire client flow, webhook
  path, badge rendering, and gating logic can be built and tested end to end
- `VerifiedBadge` component

**Later (needs your provider dashboard setup):**
- Stripe Identity or Persona account, API keys into Replit Secrets
- Fill in the corresponding adapter stub in `providers.ts` (marked TODO)
- Flip `IDENTITY_PROVIDER` env var from `mock` to the real one

## Env vars introduced

- `IDENTITY_PROVIDER` — `mock` | `stripe` | `persona` (default `mock`)
- `STRIPE_IDENTITY_SECRET_KEY` — later
- `PERSONA_API_KEY` / `PERSONA_TEMPLATE_ID` — later
- `IDENTITY_WEBHOOK_SECRET` — later, provider webhook signature verification

## Wiring left for Agent (deliberately not included here to avoid collisions)

- Server routes (`POST /api/verification/session`, `POST /api/verification/webhook`,
  `GET /api/verification/status`) calling the service — trivial once dropped
- Client verification flow screens (start → provider hand-off → pending → result)
- Report/Block entry points in Telegraph/profile menus — **wait until the E2EE
  migration finishes** since those screens are being touched right now
- Rent-a-Buddy verified-only gating
- Moderation queue admin UI

The plan doc sequences all of that.
